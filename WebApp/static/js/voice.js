/* ============================================================
   voice.js — voice interaction abstraction
   ------------------------------------------------------------
   VoiceService owns the microphone + optional speech
   recognition. Providers are pluggable:

     - BrowserSpeechProvider : webkitSpeechRecognition if present
     - NullProvider          : waveform only (backend voice
                               service can be attached later by
                               registering a new provider)

   Events: start | amplitude | transcript | end | error | status
   ============================================================ */

import { pushActivity, writeLog } from "./state.js";

/* minimal event emitter (browser-compatible, no dependencies) */
class EventEmitterLite {
    constructor() { this._m = new Map(); }
    on(ev, fn) {
        if (!this._m.has(ev)) this._m.set(ev, new Set());
        this._m.get(ev).add(fn);
        return () => this._m.get(ev).delete(fn);
    }
    emit(ev, payload) {
        const s = this._m.get(ev);
        if (s) s.forEach((fn) => { try { fn(payload); } catch (e) { console.error(`[voice:${ev}]`, e); } });
    }
}

const REC = window.SpeechRecognition || window.webkitSpeechRecognition;

class BrowserSpeechProvider {
    constructor() {
        this.name = "BROWSER SPEECH API";
        this.available = true;
    }
    create() {
        const rec = new REC();
        rec.lang = navigator.language || "en-US";
        rec.interimResults = true;
        rec.continuous = true;
        rec.maxAlternatives = 1;
        return rec;
    }
}

class NullProvider {
    constructor(reason) {
        this.name = "WAVEFORM ONLY";
        this.available = false;
        this.reason = reason || "No speech recognition API — backend voice service can be attached";
    }
    create() { return null; }
}

export class VoiceService extends EventEmitterLite {
    constructor(prefer = "auto") {
        super();
        this.prefer = prefer;             // auto | browser | none
        this.active = false;
        this.stream = null;
        this.audioCtx = null;
        this.analyser = null;
        this.recognition = null;
        this.provider = null;
        this.transcript = "";
        this.interim = "";
        this.startedAt = 0;
        this.ampTimer = null;
        this.amplitude = 0;
        this._selectProvider();
    }

    _selectProvider() {
        if (this.prefer === "none") {
            this.provider = new NullProvider("Disabled by operator setting");
        } else if (REC && this.prefer !== "none") {
            this.provider = new BrowserSpeechProvider();
        } else {
            this.provider = new NullProvider();
        }
        this.emit("provider", this.provider);
        return this.provider;
    }

    setPreference(pref) {
        this.prefer = pref;
        if (!this.active) this._selectProvider();
    }

    async start() {
        if (this.active) return;
        this._selectProvider();
        this.transcript = "";
        this.interim = "";
        this.startedAt = Date.now();

        /* --- microphone + analyser (Web Audio API) --- */
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const src = this.audioCtx.createMediaStreamSource(this.stream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.75;
            src.connect(this.analyser);
        } catch (e) {
            writeLog("ERROR", `Microphone unavailable: ${e.message}`, "voice");
            this.emit("error", `MICROPHONE ACCESS DENIED: ${e.message}`);
            pushActivity("VOICE_INPUT", "Microphone access denied", "ERROR");
            this._cleanup();
            return;
        }

        this.active = true;

        /* --- amplitude sampling --- */
        const buf = new Uint8Array(this.analyser.frequencyBinCount);
        let smooth = 0;
        this.ampTimer = setInterval(() => {
            if (!this.analyser) return;
            this.analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length);
            smooth = smooth * 0.6 + Math.min(1, rms * 4.5) * 0.4;
            this.amplitude = smooth;
            this.emit("amplitude", smooth);
        }, 55);

        /* --- transcription provider --- */
        if (this.provider.available) {
            try {
                this._bindRecognition();
                this.emit("status", "LISTENING...");
                pushActivity("VOICE_INPUT", "Microphone + speech recognition active", "PROCESSING");
            } catch (e) {
                writeLog("WARNING", `Speech recognition failed to start: ${e.message}`, "voice");
                this.provider = new NullProvider(e.message);
                this.emit("provider", this.provider);
                this.emit("status", "LISTENING (WAVEFORM ONLY)...");
            }
        } else {
            this.emit("status", "LISTENING (WAVEFORM ONLY)...");
            pushActivity("VOICE_INPUT", "Waveform capture active — no transcription provider", "WARNING");
        }

        writeLog("INFO", `Voice channel opened (provider: ${this.provider.name})`, "voice");
        this.emit("start");
    }

    _bindRecognition() {
        this.recognition = this.provider.create();
        if (!this.recognition) return;
        this.recognition.onresult = (ev) => {
            let interim = "";
            let final = "";
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const r = ev.results[i];
                if (r.isFinal) final += r[0].transcript;
                else interim += r[0].transcript;
            }
            if (final) this.transcript += (this.transcript ? " " : "") + final.trim();
            this.interim = interim;
            this.emit("transcript", (this.transcript + (interim ? " " + interim : "")).trim());
        };
        this.recognition.onerror = (ev) => {
            if (ev.error === "no-speech" || ev.error === "aborted") return;
            writeLog("WARNING", `Speech recognition error: ${ev.error}`, "voice");
            this.emit("status", `RECOGNITION ISSUE: ${ev.error.toUpperCase()}`);
        };
        this.recognition.onend = () => {
            /* keep listening while the channel is open */
            if (this.active && this.provider.available) {
                try { this.recognition.start(); } catch (e) { /* already restarting */ }
            }
        };
        this.recognition.start();
    }

    stop() {
        if (!this.active) return;
        const duration = Date.now() - this.startedAt;
        this.active = false;

        if (this.recognition) {
            try { this.recognition.onend = null; this.recognition.stop(); } catch (e) { /* noop */ }
            this.recognition = null;
        }
        if (this.ampTimer) clearInterval(this.ampTimer);
        this.ampTimer = null;
        this._cleanup();
        this.amplitude = 0;
        this.emit("amplitude", 0);
        writeLog("INFO", `Voice channel closed (${(duration / 1000).toFixed(1)}s)`, "voice");
        pushActivity("VOICE_INPUT", `Capture ended — ${(duration / 1000).toFixed(1)}s, ${this.transcript ? "transcript ready" : "no transcript"}`,
            this.transcript ? "SUCCESS" : "WARNING", { duration });
        this.emit("end", { duration, transcript: this.transcript });
    }

    cancel() {
        const had = this.active;
        const t = this.transcript;
        this.stop();
        this.transcript = "";
        this.interim = "";
        if (had) this.emit("cancelled", t);
    }

    _cleanup() {
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        if (this.audioCtx && this.audioCtx.state !== "closed") this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
        this.analyser = null;
    }

    get elapsed() { return this.active ? Date.now() - this.startedAt : 0; }
    get text() { return (this.transcript + (this.interim ? " " + this.interim : "")).trim(); }
}

export const voiceService = new VoiceService("auto");
