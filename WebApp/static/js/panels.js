/* ============================================================
   panels.js — HUD panel renderers
   Activity stream · logs · tool runs · metrics · charts ·
   sessions · telemetry streams · current operation
   ============================================================ */

import {
    onActivity, onLog, onToolRun, getActivity, getLogs, clearLogs,
    fmtTime, fmtDuration, fmtNum, fmtUptime, clearActivity,
} from "./state.js";
import { TOOL_REGISTRY } from "./services.js";
import { store } from "./state.js";

const MAX_ACTIVITY_DOM = 140;
const MAX_LOG_DOM = 400;
const MAX_TOOL_DOM = 24;

function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
}

function atBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 42;
}
function scrollToBottom(node) {
    node.scrollTop = node.scrollHeight;
}

/* hex → rgba string (chart area fills) */
function hexA(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
}

/* ============================================================
   ACTIVITY STREAM
   ============================================================ */
function activityNode(item) {
    const n = el("div", `act-item s-${item.status.toLowerCase()}`);
    n.dataset.id = item.id;
    const time = el("span", "act-time", fmtTime(item.ts));
    const type = el("span", "act-type", escapeHtml(item.type));
    const meta = el("div", "act-meta");
    meta.appendChild(el("span", `act-status ${item.status}`, item.status));
    if (item.duration != null) meta.appendChild(el("span", "", fmtDuration(item.duration)));
    n.appendChild(time);
    n.appendChild(type);
    if (item.desc) {
        const d = el("span", "act-desc", escapeHtml(item.desc));
        d.title = `${item.type}: ${item.desc}`;   /* truncated rows keep full text on hover */
        n.appendChild(d);
    }
    n.appendChild(meta);
    return n;
}

/** Mount a live activity list into a container. */
export function mountActivity(container) {
    if (!container) return () => {};
    const paint = (items, reset) => {
        if (reset) container.innerHTML = "";
        const stick = atBottom(container);
        items.slice(-MAX_ACTIVITY_DOM).forEach((it) => container.appendChild(activityNode(it)));
        while (container.children.length > MAX_ACTIVITY_DOM) container.removeChild(container.firstChild);
        if (stick) scrollToBottom(container);
    };
    paint(getActivity(), true);
    const off = onActivity((item, all) => {
        if (!item) { container.innerHTML = ""; paint(all, false); return; }
        const empty = container.querySelector(".empty");
        if (empty) empty.remove();
        const stick = atBottom(container);
        container.appendChild(activityNode(item));
        while (container.children.length > MAX_ACTIVITY_DOM) container.removeChild(container.firstChild);
        if (stick) scrollToBottom(container);
        const counter = container.closest(".panel")?.querySelector("#hud-act-count");
        if (counter) counter.textContent = String(all.length);
    });
    return off;
}

export function mountActivityClear(button) {
    button?.addEventListener("click", () => {
        clearActivity();
        const empty = el("p", "empty", "Activity events will appear here.");
        ["hud-activity", "task-activity"].forEach((id) => {
            const c = document.getElementById(id);
            if (c) { c.innerHTML = ""; c.appendChild(empty.cloneNode(true)); }
        });
    });
}

/* ============================================================
   LOG VIEWER
   ============================================================ */
export const logFilter = {
    levels: new Set(["INFO", "DEBUG", "WARNING", "ERROR"]),
    query: "",
    autoScroll: true,
};

function logNode(e) {
    const n = el("div", `log-line lvl-${e.level}`);
    n.dataset.id = e.id;
    n.appendChild(el("span", "lg-time", fmtTime(e.ts, true)));
    n.appendChild(el("span", "lg-level", e.level));
    n.appendChild(el("span", "lg-src", escapeHtml(e.source)));
    n.appendChild(el("span", "lg-msg", escapeHtml(e.message)));
    return n;
}

function logMatches(e) {
    if (!logFilter.levels.has(e.level)) return false;
    if (!logFilter.query) return true;
    const q = logFilter.query.toLowerCase();
    return e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q) || e.level.toLowerCase().includes(q);
}

export function mountLogs(container) {
    if (!container) return () => {};
    const paintAll = () => {
        container.innerHTML = "";
        const visible = getLogs().filter(logMatches);
        if (visible.length === 0) {
            container.appendChild(el("p", "empty", getLogs().length === 0
                ? "Log stream initialized. Awaiting events…"
                : "No entries match the current filter."));
        } else {
            visible.slice(-MAX_LOG_DOM).forEach((e) => container.appendChild(logNode(e)));
        }
        if (logFilter.autoScroll) scrollToBottom(container);
        updateLogFoot(visible.length);
    };
    paintAll();
    logRepaint = paintAll;

    const off = onLog((entry, all) => {
        if (!entry) { paintAll(); return; }
        const empty = container.querySelector(".empty");
        if (empty) empty.remove();
        if (!logMatches(entry)) { updateLogFoot(container.children.length, all.length); return; }
        const stick = logFilter.autoScroll && atBottom(container);
        container.appendChild(logNode(entry));
        while (container.children.length > MAX_LOG_DOM) container.removeChild(container.firstChild);
        if (stick) scrollToBottom(container);
        updateLogFoot(container.children.length, all.length);
    });
    return off;
}

function updateLogFoot(shown, total) {
    const c = document.getElementById("log-count");
    const s = document.getElementById("log-shown");
    if (c) c.textContent = `${(total != null ? total : getLogs().length)} ENTRIES`;
    if (s) s.textContent = `${shown != null ? shown : 0} SHOWN`;
}

let logRepaint = null;

export function bindLogToolbar() {
    document.querySelectorAll("[data-level]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const lvl = btn.dataset.level;
            if (logFilter.levels.has(lvl)) logFilter.levels.delete(lvl);
            else logFilter.levels.add(lvl);
            const on = logFilter.levels.has(lvl);
            btn.classList.toggle("is-on", on);
            btn.setAttribute("aria-pressed", String(on));
            logRepaint?.();
        });
    });
    const search = document.getElementById("log-search");
    search?.addEventListener("input", () => {
        logFilter.query = search.value.trim();
        logRepaint?.();
    });
    const auto = document.getElementById("log-autoscroll");
    auto?.addEventListener("click", () => {
        logFilter.autoScroll = !logFilter.autoScroll;
        auto.classList.toggle("is-on", logFilter.autoScroll);
        auto.setAttribute("aria-pressed", String(logFilter.autoScroll));
    });
    document.querySelector("[data-action='clear-logs']")?.addEventListener("click", clearLogs);
}

/* ============================================================
   METRIC BARS (right HUD + top bar)
   ============================================================ */
export function updateMetricBars(m) {
    const map = {
        cpu: m.cpu, mem: m.mem, gpu: m.gpu,
        disk: m.disk, net: m.netMbps != null ? m.netMbps : m.net,
    };
    Object.entries(map).forEach(([key, val]) => {
        const row = document.querySelector(`.metric[data-metric="${key}"]`);
        if (!row) return;
        const bar = row.querySelector(".bar");
        const fill = row.querySelector(".bar i");
        const out = row.querySelector(".m-val");
        const pct = key === "net" ? Math.min(100, (val / 8) * 100) : val;
        fill.style.width = `${pct.toFixed(1)}%`;
        bar.classList.toggle("warn", pct > 75);
        bar.classList.toggle("err", pct > 92);
        out.textContent = key === "net" ? `${(val || 0).toFixed(1)}M` : `${Math.round(val)}%`;
    });

    const setTb = (id, text) => {
        const n = document.getElementById(id);
        if (n && n.textContent !== text) {
            n.textContent = text;
            n.classList.remove("tick");
            void n.offsetWidth;
            n.classList.add("tick");
        }
    };
    setTb("tb-cpu", `${Math.round(m.cpu)}%`);
    setTb("tb-mem", `${Math.round(m.mem)}%`);
    setTb("tb-net", `${(m.netMbps != null ? m.netMbps : m.net).toFixed(1)} MB/s`);

    const pr = document.getElementById("mt-proc");
    if (pr) pr.textContent = m.proc != null ? String(m.proc) : "--";
    const tp = document.getElementById("mt-temp");
    if (tp) tp.textContent = m.temp != null ? String(m.temp) : "--";
}

/* ============================================================
   LINE CHART (system monitor)
   ============================================================ */
export class LineChart {
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.maxPoints = opts.maxPoints || 60;
        this.maxVal = opts.maxVal || 100;
        this.unit = opts.unit || "%";
        this.color = opts.color || "#00D9FF";
        this.data = [];
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this._resize = this.resize.bind(this);
        window.addEventListener("resize", this._resize);
        if ("ResizeObserver" in window) {
            this.ro = new ResizeObserver(this._resize);
            this.ro.observe(canvas);
        }
        this.resize();
    }
    push(v) {
        this.data.push(v);
        while (this.data.length > this.maxPoints) this.data.shift();
        this.draw();
    }
    reset() { this.data = []; this.draw(); }
    resize() {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width < 4) return;
        this.canvas.width = Math.round(rect.width * this.dpr);
        this.canvas.height = Math.round(rect.height * this.dpr);
        this.w = rect.width;
        this.h = rect.height;
        this.draw();
    }
    draw() {
        const W = this.canvas.width, H = this.canvas.height;
        if (!W || !H || !this.w) return;
        const ctx = this.ctx;
        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.scale(this.dpr, this.dpr);
        const w = this.w, h = this.h;
        const padL = 34, padB = 16, padT = 6, padR = 6;
        const plotW = w - padL - padR;
        const plotH = h - padT - padB;

        /* grid + y labels */
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
            const y = padT + plotH * (1 - f);
            ctx.strokeStyle = f === 0 ? "rgba(0,217,255,0.22)" : "rgba(0,217,255,0.08)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(w - padR, y);
            ctx.stroke();
            ctx.fillStyle = "rgba(111,137,149,0.8)";
            ctx.fillText(`${Math.round(this.maxVal * f)}${this.unit}`, padL - 6, y);
        });

        /* x time labels */
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(111,137,149,0.7)";
        const n = this.data.length;
        if (n > 1) {
            const step = plotW / (this.maxPoints - 1);
            for (let i = 0; i < n; i += Math.ceil(this.maxPoints / 6)) {
                const x = padL + i * step;
                ctx.fillText(`${(n - 1 - i) * -1}s`, x, h - padB + 4);
            }
        }

        if (n === 0) {
            ctx.restore();
            return;
        }

        const step = plotW / (this.maxPoints - 1);
        const pts = this.data.map((v, i) => [
            padL + i * step,
            padT + plotH * (1 - Math.max(0, Math.min(1, v / this.maxVal))),
        ]);

        /* area fill */
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, hexA(this.color, 0.28));
        grad.addColorStop(1, hexA(this.color, 0.02));
        ctx.beginPath();
        ctx.moveTo(pts[0][0], padT + plotH);
        pts.forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.lineTo(pts[pts.length - 1][0], padT + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        /* line */
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.shadowBlur = 0;

        /* head dot */
        const [hx, hy] = pts[pts.length - 1];
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }
    destroy() {
        window.removeEventListener("resize", this._resize);
        if (this.ro) this.ro.disconnect();
    }
}

/* ============================================================
   TOOL RUNS
   ============================================================ */
function toolRunNode(run, seq) {
    const card = el("div", `tool-card ${run.status.toLowerCase()}`);
    const head = el("div", "tool-card-head");
    head.innerHTML = `<span aria-hidden="true">◉</span><span class="t-name">${escapeHtml(run.tool)}</span><span class="t-seq">RUN #${String(seq).padStart(3, "0")}</span>`;

    const body = el("div", "tool-card-body");
    const dl = el("dl", "tool-meta");
    const st = el("dd", `st-${run.status.toLowerCase()}`, run.status);
    dl.appendChild(el("dt", "", "STATUS"));
    dl.appendChild(st);
    dl.appendChild(el("dt", "", "START"));
    dl.appendChild(el("dd", "", fmtTime(run.startedAt)));
    dl.appendChild(el("dt", "", "DURATION"));
    dl.appendChild(el("dd", "", run.status === "QUEUED" ? "—" : fmtDuration(run.duration != null ? run.duration : Date.now() - run.startedAt)));
    body.appendChild(dl);

    /* stepper */
    const order = ["QUEUED", "EXECUTING", run.status === "FAILED" ? "FAILED" : "COMPLETED"];
    const idx = order.indexOf(run.status);
    const step = el("div", "tool-stepper mono");
    order.forEach((s, i) => {
        if (i > 0) step.appendChild(el("span", "arw", "↓"));
        const on = i <= idx;
        step.appendChild(el("span", `st ${on ? (i < idx || i === 0 ? "on" : "on") : ""} ${i < idx ? "done" : ""}`.trim(), s));
    });
    body.appendChild(step);

    if (run.input && Object.keys(run.input).length) {
        const sec = el("div", "tool-section");
        sec.appendChild(el("div", "ts-label", `<span>INPUT</span><span>${Object.keys(run.input).join(", ")}</span>`));
        sec.appendChild(el("pre", "tool-pre", escapeHtml(formatIO(run.input))));
        body.appendChild(sec);
    }
    const outSec = el("div", "tool-section");
    outSec.appendChild(el("div", "ts-label", "<span>OUTPUT</span>"));
    outSec.appendChild(run.output != null
        ? el("pre", "tool-pre out", escapeHtml(truncateOut(run.output)))
        : el("pre", "tool-pre empty", run.status === "EXECUTING" ? "awaiting execution…" : "no output"));
    body.appendChild(outSec);

    card.appendChild(head);
    card.appendChild(body);
    return card;
}

function formatIO(input) {
    return Object.entries(input).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
}
function truncateOut(o) {
    const s = typeof o === "string" ? o : JSON.stringify(o, null, 2);
    return s.length > 4000 ? s.slice(0, 4000) + "\n… [truncated]" : s;
}

export function mountToolRuns(...containers) {
    const lists = containers.filter(Boolean);
    const render = (runs) => {
        lists.forEach((c) => {
            c.innerHTML = "";
            if (runs.length === 0) {
                c.appendChild(el("p", "empty", "No tool executions recorded this session."));
                return;
            }
            runs.slice(-MAX_TOOL_DOM).reverse().forEach((r, i) => c.appendChild(toolRunNode(r, r.id)));
        });
        const count = document.getElementById("tool-run-count");
        if (count) count.textContent = `${runs.length} RUNS`;
        const memLast = document.getElementById("mem-tool");
        if (memLast && runs.length) memLast.textContent = runs[runs.length - 1].tool;
    };
    render([]);
    return onToolRun((action, run, all) => render(all));
}

/* current operation displays */
export function renderCurrentOperation(op) {
    const targets = [document.getElementById("hud-op"), document.getElementById("task-current")].filter(Boolean);
    targets.forEach((t) => {
        if (!op) {
            t.innerHTML = '<p class="empty">IDLE — no operation.</p>';
            return;
        }
        t.innerHTML = `
            <div class="op-name"><i class="dot ${op.status === "FAILED" ? "dot-err" : "dot-warn"}"></i>${escapeHtml(op.tool)}</div>
            <dl class="tool-meta" style="margin-top:8px;">
                <dt>STATUS</dt><dd class="st-${op.status.toLowerCase()}">${op.status}</dd>
                <dt>SINCE</dt><dd>${fmtTime(op.since)}</dd>
                <dt>ELAPSED</dt><dd>${fmtDuration(Date.now() - op.since)}</dd>
            </dl>`;
    });
    const tag = document.getElementById("op-tag");
    if (tag) tag.textContent = op ? op.status : "IDLE";
}

/* ============================================================
   TOOL REGISTRY / HUD TOOL LIST
   ============================================================ */
export function renderToolRegistry() {
    const reg = document.getElementById("tool-registry");
    const hud = document.getElementById("hud-tools");
    if (reg) {
        reg.innerHTML = "";
        TOOL_REGISTRY.forEach((t) => {
            const li = el("li");
            li.dataset.tool = t.name;
            li.innerHTML = `
                <span class="tr-glyph mono" aria-hidden="true">${escapeHtml(t.glyph)}</span>
                <span><span class="tr-name">${escapeHtml(t.name)}</span><br><span class="tr-desc">${escapeHtml(t.desc)}</span></span>
                <span class="tr-state">ONLINE</span>`;
            reg.appendChild(li);
        });
        const c = document.getElementById("tool-count");
        if (c) c.textContent = `${TOOL_REGISTRY.length} ONLINE`;
    }
    if (hud) {
        hud.innerHTML = "";
        TOOL_REGISTRY.forEach((t) => {
            const li = el("li");
            li.dataset.tool = t.name;
            li.innerHTML = `<i class="t-dot"></i><span>${escapeHtml(t.name)}</span><span class="t-state">READY</span>`;
            hud.appendChild(li);
        });
        const c = document.getElementById("hud-tool-count");
        if (c) c.textContent = String(TOOL_REGISTRY.length);
    }
}

export function setToolBusy(toolName, busy, label) {
    document.querySelectorAll(`[data-tool="${toolName}"]`).forEach((n) => {
        n.classList.toggle("is-running", busy);
        n.classList.toggle("is-busy", busy);
        const s = n.querySelector(".t-state, .tr-state");
        if (s) s.textContent = label || (busy ? "RUNNING" : "READY");
    });
}

/* ============================================================
   SESSIONS
   ============================================================ */
export function renderSessions(sessions) {
    const box = document.getElementById("session-list");
    if (!box) return;
    box.innerHTML = "";
    if (!sessions || sessions.length === 0) {
        box.appendChild(el("p", "empty", "No session data. Request <span class=\"mono\">/list</span> to enumerate saved conversations."));
        return;
    }
    sessions.forEach((s) => {
        const row = el("div", "session-row");
        const meta = [s.mode, fmtNum(s.tokens) + " TOK", s.model].filter(Boolean).join(" · ");
        row.innerHTML = `
            <span class="s-name">${s.active ? "▸ " : ""}${escapeHtml(s.name)}</span>
            ${s.active ? '<span class="active-badge">ACTIVE</span>' : ""}
            <span class="s-meta">${escapeHtml(meta)}</span>
            <span class="s-actions">
                <button class="mini-btn" data-session-load="${escapeHtml(s.name)}">LOAD</button>
                <button class="mini-btn" data-session-rename="${escapeHtml(s.name)}">RENAME</button>
            </span>`;
        box.appendChild(row);
    });
}

/* ============================================================
   TELEMETRY STREAM COLUMNS (flanking the core)
   ============================================================ */
function streamRows() {
    const s = store.get();
    const m = s.metrics;
    return {
        left: [
            ["STATE", s.agentState.toUpperCase()],
            ["MODE", s.mode],
            ["MODEL", (s.modelName || "NONE").split(":")[0].slice(0, 14)],
            ["CTX", `${s.numCtx ? Math.min(100, (s.tokenCount / s.numCtx) * 100).toFixed(1) : "0.0"}%`],
            ["TOKENS", fmtNum(s.tokenCount)],
            ["LATENCY", s.agentLatency != null ? `${s.agentLatency}MS` : "—"],
            ["OPS", s.processing ? "ACTIVE" : "STANDBY"],
        ],
        right: [
            ["CPU", `${Math.round(m.cpu || 0)}%`],
            ["MEM", `${Math.round(m.mem || 0)}%`],
            ["GPU", `${Math.round(m.gpu || 0)}%`],
            ["NET", `${(m.netMbps || 0).toFixed(1)}MB/S`],
            ["LINK", s.connection.toUpperCase()],
            ["SAVES", s.activeSaveFile ? "ON" : "OFF"],
            ["UP", fmtUptime(Date.now() - s.startedAt)],
        ],
    };
}

export function updateStreams() {
    const { left, right } = streamRows();
    const paint = (id, rows, alt) => {
        const c = document.getElementById(id);
        if (!c) return;
        c.innerHTML = rows
            .map(([k, v], i) => `<span class="s-row ${alt && i % 2 ? "alt" : ""}">${k} <b>${escapeHtml(String(v))}</b></span>`)
            .join("");
    };
    paint("stream-left", left, false);
    paint("stream-right", right, true);
    paint("stream-left2", left, false);
    paint("stream-right2", right, true);

    const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
    set("ro-state", s_state().toUpperCase());
    set("ro-ctx", s_ctx());
    set("ro-link", store.get().connection === "online" ? "SYNC" : "DOWN");
    const up = fmtUptime(Date.now() - store.get().startedAt);
    set("ro-uptime", up);
    const au = document.getElementById("about-uptime");
    if (au) au.textContent = up;
}
function s_state() { return store.get().agentState; }
function s_ctx() {
    const s = store.get();
    return s.numCtx ? `${Math.min(100, (s.tokenCount / s.numCtx) * 100).toFixed(1)}%` : "0%";
}

/* ============================================================
   helpers
   ============================================================ */
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(text) {
    return String(text == null ? "" : text).replace(ESC_RE, (c) => ESC_MAP[c]);
}
