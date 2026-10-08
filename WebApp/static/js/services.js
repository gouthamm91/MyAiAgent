/* ============================================================
   services.js — service abstraction layer
   ------------------------------------------------------------
   AgentService   : wraps the Socket.IO control channel. This is
                    the single seam between UI and backend; when a
                    real REST/WebSocket backend changes, only this
                    class changes.
   MetricsService : telemetry provider interface.
                    MockMetricsService is the default stand-in
                    (clearly marked SIM in the HUD); swap in
                    HttpMetricsService once the backend exposes
                    /api/system_metrics.
   ============================================================ */

import { store, writeLog, pushActivity } from "./state.js";

/* ============================================================
   AgentService
   ============================================================ */
export const AgentService = {
    socket: null,
    _handlers: new Map(),          // event -> Set<fn>

    connect() {
        if (this.socket) return this.socket;
        this.socket = io({ autoConnect: true, reconnection: true, reconnectionDelay: 1500 });

        const forward = (event) => {
            this.socket.on(event, (payload) => {
                if (event === "connect") {
                    store.set({ connection: "online", error: null });
                    writeLog("INFO", `Socket connected (id=${this.socket.id})`, "link");
                } else if (event === "disconnect") {
                    store.set({ connection: "offline" });
                    writeLog("WARNING", `Socket disconnected: ${payload || "transport closed"}`, "link");
                } else if (event === "connect_error") {
                    store.set({ connection: "offline" });
                    writeLog("ERROR", `Connection error: ${payload && payload.message ? payload.message : payload}`, "link");
                }
                this._emitLocal(event, payload);
            });
        };
        ["connect", "disconnect", "connect_error", "state_update", "agent_event",
         "system_msg", "error", "models_list", "conversation_list",
         "prompt_input", "prompt_rename"].forEach(forward);

        return this.socket;
    },

    /* subscribe to a forwarded socket event; returns unsubscribe fn */
    on(event, fn) {
        if (!this._handlers.has(event)) this._handlers.set(event, new Set());
        this._handlers.get(event).add(fn);
        return () => this._handlers.get(event).delete(fn);
    },

    _emitLocal(event, payload) {
        const set = this._handlers.get(event);
        if (set) set.forEach((fn) => { try { fn(payload); } catch (e) { console.error(`[AgentService:${event}]`, e); } });
    },

    /* ---- command API (identical for mock/real backends) ---- */
    sendMessage(text) {
        pushActivity("USER_REQUEST_RECEIVED", truncate(text, 70), "INFO");
        this.socket.emit("send_message", { message: text });
    },
    stop() {
        pushActivity("ABORT_SIGNAL", "Stop requested by operator", "WARNING");
        this.socket.emit("stop");
    },
    getModels() { this.socket.emit("get_models"); },
    setModel(modelName, numCtx, projectDir) {
        this.socket.emit("set_model", { model_name: modelName, num_ctx: numCtx, project_dir: projectDir });
    },
    slash(command, args = "") { this.socket.emit("slash", { command, args }); },

    async getTools() {
        /* Local registry of capabilities the backend exposes over the
           control channel. Mirrors the future /api/tools endpoint. */
        return TOOL_REGISTRY.slice();
    },

    async getSystemMetrics() {
        /* Placeholder for the future backend telemetry endpoint. */
        return metricsService.current();
    },
};

export const TOOL_REGISTRY = [
    { name: "python_executor",  desc: "Executes generated Python against the local machine", glyph: ">" },
    { name: "conversation_store", desc: "Save / load / rename conversation sessions on disk", glyph: "▤" },
    { name: "context_compactor", desc: "Summarizes history to reclaim context window", glyph: "◈" },
    { name: "model_control",    desc: "Selects model, context window and operating mode", glyph: "◉" },
    { name: "directory_picker", desc: "Native OS folder picker for the project workspace", glyph: "▣" },
    { name: "system_telemetry", desc: "Client-side metrics feed for the HUD", glyph: "◱" },
];

function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ============================================================
   MetricsService
   ============================================================ */
export class MetricsService {
    constructor(intervalMs = 1000) {
        this.intervalMs = intervalMs;
        this.timer = null;
        this.listeners = new Set();
        this._last = null;
    }
    current() { return this._last; }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    _emit(sample) {
        this._last = sample;
        this.listeners.forEach((fn) => { try { fn(sample); } catch (e) { console.error(e); } });
    }
    start() { this.stop(); this.timer = setInterval(() => this._tick(), this.intervalMs); this._tick(); }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
    setIntervalMs(ms) { this.intervalMs = ms; if (this.timer) this.start(); }
    _tick() { /* subclass */ }
}

/**
 * MockMetricsService — default telemetry source.
 * Produces smoothly evolving, plausible values. Where the browser
 * exposes genuine signals (JS heap, downlink, cores) they seed the
 * simulation. Clearly surfaced as "SIM" in the HUD.
 */
export class MockMetricsService extends MetricsService {
    constructor(intervalMs = 1000) {
        super(intervalMs);
        const cores = navigator.hardwareConcurrency || 4;
        this.base = {
            cpu: 14 + (cores % 8) * 3,
            mem: 34 + (cores % 5) * 4,
            gpu: 22 + (cores % 6) * 5,
            disk: 47 + (cores % 7) * 3,
            net: 5,
            proc: 120 + cores * 14,
            temp: 41 + (cores % 4) * 3,
        };
        this.t = 0;
    }
    _tick() {
        this.t += 1;
        const b = this.base;
        const wander = (v, lo, hi, amp) => {
            const n = v + (Math.random() - 0.5) * amp;
            return Math.max(lo, Math.min(hi, n));
        };
        /* slow sinusoidal load + noise, bounded */
        const wave = Math.sin(this.t / 11) * 6 + Math.sin(this.t / 29) * 5;
        const load = store.get().processing ? 16 : 0;

        this.base.cpu = wander(b.cpu + load * 0.4, 3, 96, 9) + wave * 0.15;
        this.base.mem = wander(b.mem + load * 0.2, 18, 92, 3.5);
        this.base.gpu = wander(b.gpu + load * 0.5, 5, 99, 11);
        this.base.disk = wander(b.disk, 30, 88, 1.2);
        this.base.net = wander(store.get().processing ? 34 : 4, 0.2, 96, 16);

        /* genuine browser signals where available */
        let heapPct = null;
        if (performance.memory && performance.memory.totalJSHeapSize) {
            heapPct = (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100;
        }
        const conn = navigator.connection;
        if (conn && conn.downlink) {
            this.base.net = Math.min(98, (conn.downlink / 10) * 100 + (Math.random() * 4 - 2));
        }

        this._emit({
            cpu: clamp(this.base.cpu, 0, 100),
            mem: heapPct != null ? clamp(heapPct, 0, 100) : clamp(this.base.mem, 0, 100),
            gpu: clamp(this.base.gpu, 0, 100),
            disk: clamp(this.base.disk, 0, 100),
            net: clamp(this.base.net, 0, 100),
            netMbps: +(this.base.net / 100 * 8).toFixed(1),
            proc: Math.round(this.base.proc),
            temp: Math.round(this.base.temp + Math.sin(this.t / 17) * 3),
            heapMB: heapPct != null ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null,
            source: "sim",
        });
    }
}

/**
 * HttpMetricsService — drop-in replacement once the backend exposes
 * GET /api/system_metrics returning the same shape as MockMetricsService.
 */
export class HttpMetricsService extends MetricsService {
    constructor(url = "/api/system_metrics", intervalMs = 2000) {
        super(intervalMs);
        this.url = url;
    }
    async _tick() {
        try {
            const res = await fetch(this.url, { headers: { accept: "application/json" } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this._emit({ ...(await res.json()), source: "backend" });
        } catch (e) {
            writeLog("WARNING", `Metrics endpoint unavailable: ${e.message}`, "telemetry");
        }
    }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* default telemetry provider — swap class here to change source */
export const metricsService = new MockMetricsService(1000);
