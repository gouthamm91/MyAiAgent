/* ============================================================
   core.js — animated AI Core visualization (canvas 2D)
   ------------------------------------------------------------
   Rotating tick rings, orbiting particles, circular scan sweep,
   state-driven waveform, radial pulse. One instance per canvas;
   off-screen instances are paused by the owner.

   States: idle | listening | thinking | executing | responding | error
   ============================================================ */

import { AGENT_STATES } from "./state.js";

const PALETTE = {
    idle:       { main: "#00D9FF", dim: "rgba(0,217,255,0.35)", glow: "rgba(0,217,255,0.14)" },
    listening:  { main: "#00FF9C", dim: "rgba(0,255,156,0.35)", glow: "rgba(0,255,156,0.13)" },
    thinking:   { main: "#4BE8FF", dim: "rgba(75,232,255,0.4)",  glow: "rgba(75,232,255,0.18)" },
    executing:  { main: "#FFC857", dim: "rgba(255,200,87,0.4)",  glow: "rgba(255,200,87,0.15)" },
    responding: { main: "#00D9FF", dim: "rgba(0,217,255,0.45)", glow: "rgba(0,217,255,0.2)" },
    error:      { main: "#FF4D6D", dim: "rgba(255,77,109,0.45)", glow: "rgba(255,77,109,0.18)" },
};

/* per-state motion character */
const MOOD = {
    idle:       { speed: 1.0,  pulse: 0.35, wave: 0.10, particles: 18 },
    listening:  { speed: 1.5,  pulse: 0.75, wave: 0.85, particles: 24 },
    thinking:   { speed: 2.6,  pulse: 0.9,  wave: 0.45, particles: 34 },
    executing:  { speed: 3.4,  pulse: 1.0,  wave: 0.35, particles: 30 },
    responding: { speed: 2.0,  pulse: 0.7,  wave: 0.55, particles: 26 },
    error:      { speed: 0.8,  pulse: 1.4,  wave: 0.2,  particles: 14 },
};

export class AICore {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{radiusScale?:number}} [opts]
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.state = "idle";
        this.amp = 0;               // voice amplitude 0..1 (external)
        this.running = false;
        this.reduced = false;
        this.t0 = performance.now();
        this.raf = null;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.radiusScale = opts.radiusScale || 1;
        this.w = 0;                 // measured CSS size; 0 until first _resize
        this.h = 0;

        /* deterministic particle seeds */
        this.particles = Array.from({ length: 40 }, (_, i) => ({
            orbit: 0.55 + (i % 5) * 0.11,
            angle: (i / 40) * Math.PI * 2 + (i % 3),
            speed: 0.25 + ((i * 37) % 17) / 22,
            size: 0.8 + ((i * 13) % 10) / 9,
            wobble: ((i * 29) % 20) / 20,
            dir: i % 2 === 0 ? 1 : -1,
        }));

        this._resize = this._resize.bind(this);
        this._frame = this._frame.bind(this);

        if ("ResizeObserver" in window) {
            this.ro = new ResizeObserver(this._resize);
            this.ro.observe(canvas);
        } else {
            window.addEventListener("resize", this._resize);
        }
        this._resize();
    }

    setState(state) {
        if (AGENT_STATES.includes(state)) this.state = state;
    }
    setAmplitude(a) { this.amp = a || 0; }
    setReduced(on) {
        this.reduced = on;
        if (on) this.drawOnce();
    }

    start() {
        if (this.running || this.reduced) return;
        this.running = true;
        this.raf = requestAnimationFrame(this._frame);
    }
    stop() {
        this.running = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = null;
    }

    _resize() {
        const rect = this.canvas.getBoundingClientRect();
        // Hidden tabs report a 0x0 rect — never fall back to the device-pixel
        // backing store here or the canvas grows on every observer callback.
        if (rect.width < 4 || rect.height < 4) return;
        const w = rect.width;
        const h = rect.height;
        this.canvas.width = Math.round(w * this.dpr);
        this.canvas.height = Math.round(h * this.dpr);
        this.w = w;
        this.h = h;
        if (this.reduced) this.drawOnce();
    }

    _frame(now) {
        if (!this.running) return;
        this.draw(now);
        this.raf = requestAnimationFrame(this._frame);
    }

    drawOnce() { this.draw(performance.now()); }

    draw(now) {
        const ctx = this.ctx;
        const W = this.canvas.width;
        const H = this.canvas.height;
        if (!W || !H) return;
        /* hidden canvases have no measured box yet — resize (or bail) first */
        if (!(this.w > 4) || !(this.h > 4)) this._resize();
        if (!(this.w > 4) || !(this.h > 4)) return;
        const t = (now - this.t0) / 1000;
        const mood = MOOD[this.state] || MOOD.idle;
        const col = PALETTE[this.state] || PALETTE.idle;
        const speed = mood.speed;

        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.scale(this.dpr, this.dpr);

        const cx = this.w / 2;
        const cy = this.h / 2;
        const R = Math.min(this.w, this.h) / 2 - 6;
        const k = this.radiusScale;

        /* ---------- ambient radial glow (breathing) ---------- */
        const breathe = 0.5 + 0.5 * Math.sin(t * (0.8 + mood.pulse));
        const g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * k);
        g.addColorStop(0, hexA(col.main, 0.20 + 0.10 * breathe * mood.pulse));
        g.addColorStop(0.45, col.glow);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, R * k, 0, Math.PI * 2);
        ctx.fill();

        /* ---------- outer tick ring (rotates) ---------- */
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * 0.10 * speed);
        const r1 = R * 0.94 * k;
        const ticks = 72;
        for (let i = 0; i < ticks; i++) {
            const a = (i / ticks) * Math.PI * 2;
            const major = i % 6 === 0;
            const len = major ? 9 : 4;
            ctx.strokeStyle = major ? hexA(col.main, 0.6) : hexA(col.main, 0.22);
            ctx.lineWidth = major ? 1.4 : 1;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
            ctx.lineTo(Math.cos(a) * (r1 - len), Math.sin(a) * (r1 - len));
            ctx.stroke();
        }
        /* thin guide circle */
        ctx.strokeStyle = hexA(col.main, 0.16);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, r1 + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        /* ---------- segmented ring (counter-rotates) ---------- */
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-t * 0.22 * speed);
        const r2 = R * 0.80 * k;
        ctx.strokeStyle = hexA(col.main, 0.55);
        ctx.lineWidth = 1.6;
        const segs = 3;
        for (let i = 0; i < segs; i++) {
            const a0 = (i / segs) * Math.PI * 2;
            ctx.beginPath();
            ctx.arc(0, 0, r2, a0, a0 + Math.PI * 0.52);
            ctx.stroke();
        }
        /* dashed fine ring */
        ctx.strokeStyle = hexA(col.main, 0.2);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 7]);
        ctx.beginPath();
        ctx.arc(0, 0, r2 - 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        /* ---------- scan sweep (conic arc) ---------- */
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * 0.9 * speed);
        const rS = R * 0.88 * k;
        const sweep = ctx.createRadialGradient(0, 0, rS * 0.6, 0, 0, rS);
        sweep.addColorStop(0, "rgba(0,0,0,0)");
        sweep.addColorStop(1, hexA(col.main, 0.28));
        ctx.fillStyle = sweep;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, rS, -0.5, 0.14);
        ctx.closePath();
        ctx.fill();
        /* sweep leading edge */
        ctx.strokeStyle = hexA(col.main, 0.5);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(0.14) * rS * 0.3, Math.sin(0.14) * rS * 0.3);
        ctx.lineTo(Math.cos(0.14) * rS, Math.sin(0.14) * rS);
        ctx.stroke();
        ctx.restore();

        /* ---------- rotating markers on mid ring ---------- */
        ctx.save();
        ctx.translate(cx, cy);
        const r3 = R * 0.62 * k;
        ctx.strokeStyle = hexA(col.main, 0.25);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, r3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.rotate(t * 0.5 * speed);
        for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2;
            const x = Math.cos(a) * r3;
            const y = Math.sin(a) * r3;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(a + Math.PI / 2);
            ctx.fillStyle = col.main;
            ctx.shadowColor = col.main;
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.moveTo(0, -4.5);
            ctx.lineTo(4, 3.5);
            ctx.lineTo(-4, 3.5);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
        ctx.restore();

        /* ---------- waveform ring ---------- */
        const waveMood = mood.wave;
        const activeAmp = this.amp > 0.02 ? this.amp : null;
        const wAmp = R * 0.09 * (activeAmp != null ? Math.max(0.3, activeAmp) : waveMood);
        const rW = R * 0.46 * k;
        ctx.beginPath();
        const steps = 140;
        for (let i = 0; i <= steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            let n;
            if (activeAmp != null) {
                /* live audio-driven ripple */
                n = Math.sin(a * 9 + t * 9) * activeAmp + Math.sin(a * 17 - t * 13) * activeAmp * 0.5;
            } else {
                n = Math.sin(a * 5 + t * (2.2 * speed)) * 0.6 + Math.sin(a * 11 - t * 1.6 * speed) * 0.4;
            }
            const rr = rW + n * wAmp * 0.5;
            const x = cx + Math.cos(a) * rr;
            const y = cy + Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = hexA(col.main, 0.8);
        ctx.lineWidth = 1.5;
        ctx.shadowColor = col.main;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        /* ---------- orbiting particles ---------- */
        const count = Math.min(this.particles.length, mood.particles);
        for (let i = 0; i < count; i++) {
            const p = this.particles[i];
            const a = p.angle + t * p.speed * p.dir * (0.6 + speed * 0.25);
            const rr = R * p.orbit * k + Math.sin(t * 1.4 + p.wobble * 9) * R * 0.03;
            const x = cx + Math.cos(a) * rr;
            const y = cy + Math.sin(a) * rr;
            ctx.fillStyle = hexA(col.main, 0.35 + p.wobble * 0.5);
            ctx.beginPath();
            ctx.arc(x, y, p.size * this.dpr * 0.7, 0, Math.PI * 2);
            ctx.fill();
        }

        /* ---------- inner core disc ---------- */
        const pulse = 0.5 + 0.5 * Math.sin(t * (1.6 + mood.pulse));
        const coreR = R * 0.16 * k * (1 + pulse * 0.05 * mood.pulse);
        const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.4);
        cg.addColorStop(0, hexA(col.main, 0.85));
        cg.addColorStop(0.4, hexA(col.main, 0.28));
        cg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR * 2.4, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = hexA(col.main, 0.9);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
        ctx.stroke();

        /* error state: alarming inner cross */
        if (this.state === "error") {
            const blink = Math.sin(t * 7) > 0;
            if (blink) {
                ctx.strokeStyle = "#FF4D6D";
                ctx.lineWidth = 2;
                const s = coreR * 0.5;
                ctx.beginPath();
                ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
                ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    destroy() {
        this.stop();
        if (this.ro) this.ro.disconnect();
        window.removeEventListener("resize", this._resize);
    }
}

/* hex → rgba string */
function hexA(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
}
