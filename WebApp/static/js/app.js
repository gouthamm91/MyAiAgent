/* ============================================================
   app.js — J.A.R.V.I.S. console entry point
   ------------------------------------------------------------
   Wires: navigation · AI cores · socket events · transcript ·
   command bar · activity/logs · tool execution · voice ·
   modals · alerts · telemetry · settings · keyboard
   ============================================================ */

import {
    store, setAgentState, pushActivity, writeLog, clearActivity, clearLogs,
    toolStart, toolStatus, setToolOutput, getToolRuns,
    fmtTime, fmtDuration, fmtNum, STATE_LABELS, STATE_SUBTEXT,
} from "./state.js";
import { AgentService, metricsService } from "./services.js";
import { voiceService } from "./voice.js";
import { AICore } from "./core.js";
import {
    mountActivity, mountActivityClear, mountLogs, bindLogToolbar, logFilter,
    updateMetricBars, LineChart, mountToolRuns, renderCurrentOperation,
    renderToolRegistry, setToolBusy, renderSessions, updateStreams, escapeHtml,
} from "./panels.js";

/* ============================================================
   DOM refs
   ============================================================ */
const $ = (id) => document.getElementById(id);
const appEl = $("app");
const chatMessages = $("chat-messages");
const userInput = $("user-input");
const sendBtn = $("send-btn");
const stopBtn = $("stop-btn");
const announcer = $("state-announcer");

/* transcript placement */
const dashShell = document.querySelector("#view-dashboard .transcript-shell");
const convSlot = $("slot-conversations");

/* ============================================================
   settings (persisted locally)
   ============================================================ */
const DEFAULTS = { motion: true, scanlines: true, autoscroll: true, rate: 1000, voice: "auto" };
let settings = { ...DEFAULTS };
try {
    settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("jarvis.settings") || "{}") };
} catch (e) { /* corrupted storage → defaults */ }

function saveSettings() {
    try { localStorage.setItem("jarvis.settings", JSON.stringify(settings)); } catch (e) { /* ignore */ }
}

const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)");

function applySettings() {
    document.body.classList.toggle("motion-off", !settings.motion);
    document.body.classList.toggle("fx-off", !settings.scanlines);
    const setChk = (id, v) => { const n = $(id); if (n) n.checked = v; };
    setChk("set-motion", settings.motion);
    setChk("set-scanlines", settings.scanlines);
    setChk("set-autoscroll", settings.autoscroll);
    const dens = $("set-density"); if (dens) dens.value = String(settings.rate);
    const vsel = $("set-voice"); if (vsel) vsel.value = settings.voice;
    metricsService.setIntervalMs(settings.rate);
    voiceService.setPreference(settings.voice);
    const reduced = !settings.motion || prefersReduced.matches;
    coreDash?.setReduced(reduced);
    coreDash?.start();
    coreStage?.setReduced(reduced);
    if (activeView === "aicore") coreStage?.start();
    if (reduced) { coreDash?.stop(); coreStage?.stop(); coreDash?.drawOnce(); coreStage?.drawOnce(); }
}

/* ============================================================
   AI cores
   ============================================================ */
const coreDash = $("core-canvas") ? new AICore($("core-canvas")) : null;
const coreStage = $("core-canvas-2") ? new AICore($("core-canvas-2"), { radiusScale: 1 }) : null;

voiceService.on("amplitude", (a) => {
    coreDash?.setAmplitude(a);
    coreStage?.setAmplitude(a);
    const r = Math.round(a * 100);
    document.querySelectorAll(".wave-bars .wb").forEach((b) => {
        const seed = Number(b.dataset.seed || 0);
        const h = a > 0.02 ? Math.max(6, Math.min(100, r * (0.5 + seed * 0.6) + seed * 14)) : 6;
        b.style.height = `${h}%`;
    });
    const amp = $("aic-amp");
    if (amp) amp.textContent = a.toFixed(2);
});

/* ============================================================
   views / navigation
   ============================================================ */
let activeView = "dashboard";
const VIEW_NAMES = {
    dashboard: "Dashboard", aicore: "AI Core", conversations: "Conversations",
    tasks: "Tasks", tools: "Tools", memory: "Memory", knowledge: "Knowledge",
    monitor: "System Monitor", logs: "Logs", config: "Configuration",
    settings: "Settings", about: "About",
};

function switchView(name) {
    if (!VIEW_NAMES[name]) return;
    const prev = activeView;
    activeView = name;

    document.querySelectorAll(".nav-item[data-view]").forEach((b) => {
        const on = b.dataset.view === name;
        b.classList.toggle("is-active", on);
        if (on) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
    });
    document.querySelectorAll(".view").forEach((v) => {
        const on = v.id === `view-${name}`;
        v.classList.toggle("is-active", on);
        v.hidden = !on;
    });

    /* move the live transcript between dashboard and conversations */
    if (name === "conversations" && chatMessages.parentElement !== convSlot) {
        const st = chatMessages.scrollTop;
        convSlot.appendChild(chatMessages);
        chatMessages.scrollTop = st;
    } else if ((name === "dashboard" || prev === "conversations") && chatMessages.parentElement === convSlot) {
        const st = chatMessages.scrollTop;
        dashShell.appendChild(chatMessages);
        chatMessages.scrollTop = st;
    }

    /* run only the visible core */
    const reduced = !settings.motion || prefersReduced.matches;
    if (reduced) {
        coreDash?.drawOnce();
        coreStage?.drawOnce();
    } else {
        if (name === "dashboard") { coreDash?.start(); coreStage?.stop(); }
        else if (name === "aicore") { coreStage?.start(); coreDash?.stop(); }
        else { coreDash?.stop(); coreStage?.stop(); }
    }

    if (name === "monitor") setTimeout(() => charts.forEach((c) => c.resize()), 30);
    closeDrawers();
    writeLog("DEBUG", `View → ${VIEW_NAMES[name]}`, "ui");
}

function closeDrawers() {
    $("left-nav").classList.remove("is-open");
    $("right-hud").classList.remove("is-open");
    $("nav-scrim").classList.add("hidden");
    $("hud-scrim").classList.add("hidden");
    $("nav-toggle").setAttribute("aria-expanded", "false");
    $("hud-toggle").setAttribute("aria-expanded", "false");
}

/* ============================================================
   top bar clock / uptime
   ============================================================ */
let stateCycle = 0;
setInterval(() => {
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    $("clock").textContent = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const s = store.get();
    const since = $("state-since");
    if (since) since.textContent = `T+${((Date.now() - s.stateSince) / 1000).toFixed(1)}s`;
    if (voiceService.active) {
        const e = Math.floor(voiceService.elapsed / 1000);
        const t = `${p(Math.floor(e / 60))}:${p(e % 60)}`;
        const vt = $("voice-timer"); if (vt) vt.textContent = t;
        const vt2 = $("voice-timer-2"); if (vt2) vt2.textContent = t;
    }
    const op = s.currentOperation;
    if (op) renderCurrentOperation({ ...op, status: op.status });
}, 1000);

/* ============================================================
   store → DOM rendering (single subscriber)
   ============================================================ */
const dotClassFor = {
    idle: "dot-cyan", listening: "dot-ok", thinking: "dot-cyan",
    executing: "dot-warn", responding: "dot-cyan", error: "dot-err",
};
const cmdStateFor = {
    idle: "STANDBY", listening: "LISTENING", thinking: "PROCESSING",
    executing: "EXECUTING", responding: "STREAMING", error: "FAULT",
};

store.subscribe((s) => {
    appEl.dataset.agentState = s.agentState;

    /* AI core states + labels */
    coreDash?.setState(s.agentState);
    coreStage?.setState(s.agentState);
    const label = STATE_LABELS[s.agentState] || "READY";
    const sub = STATE_SUBTEXT[s.agentState] || "";
    ["core-state-text", "core-state-text-2"].forEach((id) => { const n = $(id); if (n) n.textContent = label; });
    ["core-sub-text", "core-sub-text-2"].forEach((id) => { const n = $(id); if (n) n.textContent = sub; });

    /* top bar state pill */
    const tst = $("top-state-text");
    if (tst) tst.textContent = s.agentState === "idle" ? "READY" : label.replace(/\.\.\./, "");
    const sd = $("state-dot");
    if (sd) sd.className = `dot pulse ${dotClassFor[s.agentState] || "dot-cyan"}`;

    /* announcer for screen readers */
    if (announcer && announcer.dataset.last !== s.agentState) {
        announcer.dataset.last = s.agentState;
        announcer.textContent = `Agent state: ${s.agentState}`;
    }

    /* command state */
    const cs = $("cmd-state");
    if (cs) {
        cs.textContent = cmdStateFor[s.agentState] || "STANDBY";
        cs.classList.toggle("busy", ["thinking", "executing", "responding", "listening"].includes(s.agentState));
        cs.classList.toggle("err", s.agentState === "error");
    }

    /* state flow diagram */
    document.querySelectorAll("#state-flow li").forEach((li, i, all) => {
        li.classList.toggle("is-current", li.dataset.s === s.agentState);
        const curIdx = Array.from(all).findIndex((x) => x.dataset.s === s.agentState);
        li.classList.toggle("is-done", curIdx >= 0 && i < curIdx && s.agentState !== "error");
    });
    const aicState = $("aic-state"); if (aicState) aicState.textContent = s.agentState;
    const aicLoad = $("aic-load");
    if (aicLoad) aicLoad.textContent = `${({ idle: 4, listening: 22, thinking: 62, executing: 88, responding: 74, error: 97 })[s.agentState] || 4}%`;
    const aicCycle = $("aic-cycle"); if (aicCycle) aicCycle.textContent = String(stateCycle);

    /* connection */
    const cd = $("conn-dot");
    if (cd) {
        cd.className = `dot conn-dot ${s.connection === "online" ? "is-online" : s.connection === "offline" ? "is-offline" : ""}`;
    }
    const ct = $("conn-text");
    if (ct) ct.textContent = s.connection === "online" ? "LINKED" : s.connection === "offline" ? "OFFLINE" : "CONNECTING";
    const nc = $("nav-conn");
    if (nc) {
        nc.textContent = s.connection === "online" ? "LINK OK" : s.connection.toUpperCase();
        nc.className = s.connection === "online" ? "ok" : "err";
    }
    const cfgConn = $("cfg-conn"); if (cfgConn) cfgConn.textContent = s.connection.toUpperCase();
    const aboutLink = $("about-link"); if (aboutLink) aboutLink.textContent = s.connection.toUpperCase();
    const stText = $("sys-status-text");
    if (stText) stText.textContent = s.connection === "online" ? "SYSTEM ONLINE" : s.connection === "offline" ? "LINK DEGRADED" : "SYSTEM BOOT";

    /* session mirror */
    const mb = $("mode-badge");
    if (mb) { mb.textContent = s.mode; mb.classList.toggle("plan", s.mode === "PLAN"); }
    document.querySelectorAll(".mode-opt").forEach((b, i) => b.classList.toggle("is-active", (i === 0) === (s.mode === "PLAN")));
    const mnt = $("model-name-text"); if (mnt) mnt.textContent = s.modelName ? s.modelName.toUpperCase().slice(0, 26) : "NONE";

    const pct = s.numCtx > 0 ? Math.min(100, (s.tokenCount / s.numCtx) * 100) : 0;
    const ctxBar = $("hud-ctx-bar");
    if (ctxBar) {
        ctxBar.style.width = `${pct}%`;
        ctxBar.parentElement.classList.toggle("warn", pct > 75);
        ctxBar.parentElement.classList.toggle("err", pct > 92);
    }
    const ctxTxt = $("hud-ctx");
    if (ctxTxt) ctxTxt.textContent = `${fmtNum(s.tokenCount)} / ${(s.numCtx / 1000).toFixed(1)}K`;

    setText("hud-state", `● ${s.agentState.toUpperCase()}`, s.agentState === "error" ? "err" : s.agentState === "idle" ? "ok" : "");
    setText("hud-model", s.modelName || "—");
    setText("hud-mode", s.mode);
    setText("hud-agent-tag", s.connection === "online" ? "ONLINE" : "OFFLINE");
    setText("hud-latency", s.agentLatency != null ? `${s.agentLatency} ms` : "—");
    setText("hud-tps", s.tokenSpeed > 0 ? `${s.tokenSpeed.toFixed(1)}` : "—");
    setText("mt-latency", s.agentLatency != null ? String(s.agentLatency) : "--");
    setText("mt-tps", s.tokenSpeed > 0 ? s.tokenSpeed.toFixed(1) : "--");

    setText("cc-tokens", fmtNum(s.tokenCount));
    setText("cc-context", `${fmtNum(s.tokenCount)} / ${fmtNum(s.numCtx)}`);
    setText("cc-usage", `${pct.toFixed(1)}%`);
    setText("cc-mode", s.mode);
    setText("cc-save", s.activeSaveFile || "none");
    setText("cc-dir", s.projectDir || "—");
    setText("mem-tokens", fmtNum(s.tokenCount));
    setText("mem-save", s.activeSaveFile || "none");
    setText("mem-dir", s.projectDir || "—");
    setText("mem-model", s.modelName || "—");
    setText("mem-retries", String(s.maxRetries));
    setText("kn-model", s.modelName || "—");
    setText("kn-mode", s.mode);
    setText("kn-ctx", fmtNum(s.numCtx));
    setText("kn-tokens", fmtNum(s.tokenCount));
    setText("kn-dir", s.projectDir || "—");
    setText("kn-retries", String(s.maxRetries));
    setText("cfg-save", s.activeSaveFile || "none");
    setText("cfg-session", AgentService.socket ? AgentService.socket.id || "—" : "—");
    setText("cfg-transport", AgentService.socket && AgentService.socket.io && AgentService.socket.io.engine
        ? AgentService.socket.io.engine.transport.name : "—");
    setText("kn-mode-desc", s.mode === "PLAN"
        ? "PLAN mode: analysis and strategy only — no code is generated or executed."
        : "BUILD mode: the agent generates and executes Python to accomplish tasks on the local machine.");
    setText("kn-instructions", s.mode === "PLAN"
        ? "PLAN MODE — architecture & strategy assistant.\n· Concise step-by-step plans, no code execution\n· Breaks work into small tasks and prerequisites\n· Prepares the operator for BUILD mode\n· Full local filesystem awareness"
        : "BUILD MODE — automated Python execution assistant.\n· Emits exactly one Python code block per step\n· Executes locally, waits for output, then continues\n· try/except on all code, no __main__ guard\n· Finishes with a concise summary, no more code");

    renderCurrentOperation(s.currentOperation);
    updateStreams();
});

function setText(id, text, extraCls) {
    const n = $(id);
    if (!n) return;
    if (n.textContent !== text) n.textContent = text;
    if (extraCls !== undefined) {
        n.classList.remove("ok", "err");
        if (extraCls) n.classList.add(extraCls);
    }
}

/* ============================================================
   transcript rendering
   ============================================================ */
let isProcessing = false;
let currentThinking = null;
let currentResponse = null;
let currentCompacting = null;
let currentToolCard = null;
let welcomeRemoved = false;
let streamBuffer = "";
let streamTimer = null;
let maxContextLimit = 0;
let sendAt = 0;
let tokenTimes = [];
let tokenEma = 0;
let lastSpeedPush = 0;

marked.setOptions({ breaks: true, gfm: true });

function nearBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 90;
}
function scrollToBottom() {
    if (!settings.autoscroll) return;
    requestAnimationFrame(() => {
        if (nearBottom(chatMessages)) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    });
}
function forceScroll() {
    // Scroll unconditionally on the next frame (after layout), regardless of
    // the autoscroll preference.
    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}
function removeWelcome() {
    if (!welcomeRemoved) {
        const w = chatMessages.querySelector(".welcome-msg");
        if (w) w.remove();
        welcomeRemoved = true;
    }
}
function setUserInputEnabled(enabled) {
    isProcessing = !enabled;
    sendBtn.disabled = !enabled;
    userInput.disabled = !enabled;
    sendBtn.classList.toggle("is-loading", !enabled);
    stopBtn.classList.toggle("hidden", enabled);
    store.set({ processing: !enabled });
    if (enabled) {
        const cs = $("cmd-state");
        if (cs && store.get().agentState !== "error") cs.textContent = "STANDBY";
    }
}

function roleHeader(role, extra = "") {
    const head = document.createElement("div");
    head.className = "msg-role";
    head.innerHTML = `<span>${role}</span>${extra}`;
    return head;
}
function rule() { const d = document.createElement("div"); d.className = "msg-rule"; return d; }
function timeSpan() {
    const s = document.createElement("span");
    s.className = "msg-time";
    s.textContent = fmtTime(Date.now());
    return s;
}

function appendUserMessage(text) {
    const div = document.createElement("div");
    div.className = "msg msg-user";
    const h = roleHeader("OPERATOR");
    h.appendChild(timeSpan());
    div.appendChild(h);
    div.appendChild(rule());
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = text;
    div.appendChild(body);
    chatMessages.appendChild(div);
    scrollToBottom();
}

function appendAIMessageShell() {
    const div = document.createElement("div");
    div.className = "msg msg-response";
    const h = roleHeader("J.A.R.V.I.S.");
    h.appendChild(timeSpan());
    div.appendChild(h);
    div.appendChild(rule());
    const body = document.createElement("div");
    body.className = "msg-body markdown-body";
    div.appendChild(body);
    chatMessages.appendChild(div);
    return { container: div, body };
}

function appendSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "msg msg-system";
    div.appendChild(rule());
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = `[SYSTEM] ${text}`;
    div.appendChild(body);
    chatMessages.appendChild(div);
    scrollToBottom();
}

function appendErrorMessage(text) {
    const div = document.createElement("div");
    div.className = "msg msg-error";
    const h = roleHeader("FAULT");
    h.appendChild(timeSpan());
    div.appendChild(h);
    div.appendChild(rule());
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = text;
    div.appendChild(body);
    chatMessages.appendChild(div);
    scrollToBottom();
}

function appendTurnHeader(text) {
    const div = document.createElement("div");
    div.className = "msg-turn";
    div.appendChild(timeSpan());
    div.appendChild(document.createTextNode(`▶ ${text}`));
    chatMessages.appendChild(div);
    scrollToBottom();
}

function appendTokenInfo(text) {
    const div = document.createElement("div");
    div.className = "msg-token-info";
    div.appendChild(timeSpan());
    div.appendChild(document.createTextNode(`◆ ${text}`));
    chatMessages.appendChild(div);
    scrollToBottom();
}

function createThinkingBlock() {
    const container = document.createElement("div");
    container.className = "msg msg-thinking";
    const head = roleHeader("▸ REASONING STREAM");
    head.classList.add("msg-role-toggle");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const body = document.createElement("div");
    body.className = "msg-body";
    const toggle = () => {
        const collapsed = head.classList.toggle("collapsed");
        body.classList.toggle("collapsed", collapsed);
        head.setAttribute("aria-expanded", String(!collapsed));
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    head.setAttribute("aria-expanded", "true");
    container.appendChild(head);
    container.appendChild(body);
    chatMessages.appendChild(container);
    return { container, body, head };
}

/* --- streaming with throttled re-render --- */
function flushStreamBuffer(force = false) {
    if (!streamBuffer || !currentResponse) return;
    if (streamTimer && !force) return;
    if (force) {
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
        renderStream();
        return;
    }
    streamTimer = setTimeout(() => {
        streamTimer = null;
        renderStream();
    }, 70);
}
function renderStream() {
    if (!currentResponse) return;
    currentResponse.body.innerHTML = renderMarkdown(streamBuffer) + '<span class="stream-caret" aria-hidden="true"></span>';
    highlightCodeBlocks(currentResponse.body);
    scrollToBottom();
}
function finalizeCurrentResponse() {
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    if (currentResponse && streamBuffer) {
        currentResponse.body.innerHTML = renderMarkdown(streamBuffer);
        highlightCodeBlocks(currentResponse.body);
    }
    streamBuffer = "";
    currentResponse = null;
}
function clearStreamBuffer() { streamBuffer = ""; if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; } }
function closeOpenBlocks() {
    if (currentResponse) { flushStreamBuffer(true); finalizeCurrentResponse(); }
    currentThinking = null;
    currentToolCard = null;
}

/* --- tool execution card (transcript) --- */
function createToolCard(tool, input) {
    closeOpenBlocks();
    const wrap = document.createElement("div");
    wrap.className = "msg msg-tool";
    const h = roleHeader("TOOL EXECUTION");
    h.appendChild(timeSpan());
    wrap.appendChild(h);
    wrap.appendChild(rule());

    const card = document.createElement("div");
    card.className = "tool-card executing";
    card.innerHTML = `
        <div class="tool-card-head"><span aria-hidden="true">◉</span><span class="t-name">${escapeHtml(tool)}</span><span class="t-seq">LIVE</span></div>
        <div class="tool-card-body">
            <dl class="tool-meta">
                <dt>STATUS</dt><dd class="st-executing">EXECUTING</dd>
                <dt>START</dt><dd>${fmtTime(Date.now())}</dd>
                <dt>DURATION</dt><dd>—</dd>
            </dl>
            <div class="tool-stepper mono">
                <span class="st done">QUEUED</span><span class="arw">↓</span>
                <span class="st on">EXECUTING</span><span class="arw">↓</span>
                <span class="st">COMPLETED</span>
            </div>
            <div class="tool-section">
                <div class="ts-label"><span>INPUT</span></div>
                <pre class="tool-pre">${escapeHtml(typeof input === "string" ? input : JSON.stringify(input, null, 2))}</pre>
            </div>
            <div class="tool-section">
                <div class="ts-label"><span>OUTPUT</span></div>
                <pre class="tool-pre empty">awaiting execution…</pre>
            </div>
        </div>`;
    wrap.appendChild(card);
    chatMessages.appendChild(wrap);
    scrollToBottom();
    return { wrap, card, startedAt: Date.now() };
}

function completeToolCard(tc, output) {
    if (!tc) return null;
    const dur = Date.now() - tc.startedAt;
    tc.card.classList.remove("executing");
    tc.card.classList.add("completed");
    const dds = tc.card.querySelectorAll(".tool-meta dd");
    dds[0].textContent = "COMPLETED";
    dds[0].className = "st-completed";
    dds[2].textContent = fmtDuration(dur);
    const steps = tc.card.querySelectorAll(".tool-stepper .st");
    steps[1].classList.add("done");
    steps[2].classList.add("on");
    const out = tc.card.querySelector(".tool-pre.out") || tc.card.querySelectorAll(".tool-section")[1].querySelector(".tool-pre");
    out.classList.remove("empty");
    out.classList.add("out");
    const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    out.textContent = text.length > 8000 ? text.slice(0, 8000) + "\n… [truncated]" : text;
    scrollToBottom();
    return dur;
}

/* --- compacting block (ported) --- */
function createCompactingBlock() {
    const div = document.createElement("div");
    div.className = "msg msg-tool";
    div.id = "compacting-block";
    const h = roleHeader("◈ CONTEXT COMPACTION");
    div.appendChild(h);
    div.appendChild(rule());
    const body = document.createElement("div");
    body.className = "msg-body";
    body.style.fontFamily = "var(--font-mono)";
    body.style.fontSize = "12px";
    body.style.color = "var(--warn)";
    body.textContent = "";
    div.appendChild(body);
    chatMessages.appendChild(div);
    return { container: div, body };
}
function finalizeCompactingBlock() {
    const b = $("compacting-block");
    if (b) {
        const head = b.querySelector(".msg-role span");
        if (head) head.textContent = "◈ CONTEXT COMPACTION — COMPLETE";
        b.classList.add("completed");
    }
}

function appendConversationList(conversations) {
    removeWelcome();
    if (!conversations || conversations.length === 0) {
        appendSystemMessage("No saved conversations found.");
        return;
    }
    const wrap = document.createElement("div");
    wrap.className = "msg msg-session-list";
    const h = roleHeader("SESSION INDEX");
    h.appendChild(timeSpan());
    wrap.appendChild(h);
    wrap.appendChild(rule());
    let html = '<table><thead><tr><th>NAME</th><th>MODE</th><th>TOKENS</th><th>STATUS</th></tr></thead><tbody>';
    conversations.forEach((c) => {
        const status = c.active
            ? '<span class="active-badge">ACTIVE</span>'
            : (c.corrupted ? '<span class="err">CORRUPTED</span>' : "—");
        html += `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.mode)}</td><td>${fmtNum(c.tokens)}</td><td>${status}</td></tr>`;
    });
    html += "</tbody></table>";
    wrap.innerHTML += html;
    chatMessages.appendChild(wrap);
    scrollToBottom();
}

function renderMarkdown(text) {
    try { return marked.parse(text); } catch (e) { return `<p>${escapeHtml(text)}</p>`; }
}
function highlightCodeBlocks(container) {
    container.querySelectorAll("pre code").forEach((b) => {
        try { hljs.highlightElement(b); } catch (e) { /* noop */ }
    });
}

/* ============================================================
   activity / logging helpers
   ============================================================ */
function act(type, desc, status = "INFO", extra) {
    pushActivity(type, desc, status, extra);
    writeLog(status === "ERROR" ? "ERROR" : status === "WARNING" ? "WARNING" : "INFO", `${type}${desc ? " — " + desc : ""}`, "agent");
}

/* ============================================================
   socket handlers
   ============================================================ */
AgentService.on("connect", () => {
    AgentService.getModels();
    act("CONNECTION_ESTABLISHED", "Control channel linked", "SUCCESS");
    if (store.get().error) dismissAlert();
});

AgentService.on("disconnect", () => {
    act("CONNECTION_LOST", "Control channel dropped", "ERROR");
    showAlert({
        status: "CONNECTION_FAILED",
        message: "Link to the AI backend was interrupted.",
        details: "Socket.IO transport closed. The console will keep retrying automatically.",
        retry: true,
    });
});

AgentService.on("connect_error", (err) => {
    act("CONNECTION_ERROR", String(err && err.message ? err.message : err), "ERROR");
    showAlert({
        status: "CONNECTION_FAILED",
        message: "Unable to connect to AI backend.",
        details: String(err && err.message ? err.message : err),
        retry: true,
    });
});

AgentService.on("models_list", (data) => {
    const models = (data && data.models) || [];
    store.set({ models });
    const opts = models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    const setupSel = $("setup-model-select");
    const cfgSel = $("cfg-model");
    if (setupSel) setupSel.innerHTML = opts || '<option value="">— none —</option>';
    if (cfgSel) cfgSel.innerHTML = '<option value="">— select model —</option>' + opts;
    if (models.length && !store.get().modelName && !setupDismissed) showSetupModal();
    writeLog("INFO", `Models available: ${models.length}`, "model");
    const fb = document.querySelector("[data-action='fetch-models']");
    if (fb) { fb.classList.remove("is-loading"); fb.disabled = false; }
});

AgentService.on("state_update", (d) => {
    const patch = {};
    if (d.mode) patch.mode = d.mode;
    if (d.model_name !== undefined) {
        patch.modelName = d.model_name;
        maxContextLimit = d.num_ctx || 0;
        if (d.model_name) patch.numCtx = d.num_ctx || 12000;
    }
    if (d.token_count !== undefined) patch.tokenCount = d.token_count;
    if (d.active_save_file !== undefined) patch.activeSaveFile = d.active_save_file;
    if (d.project_dir !== undefined) patch.projectDir = d.project_dir;
    if (d.has_conversation !== undefined) patch.hasConversation = d.has_conversation;
    if (d.num_ctx) patch.numCtx = d.num_ctx;
    store.set(patch);
    const ccSave = $("cfg-save"); if (ccSave) ccSave.textContent = d.active_save_file || "none";
});

AgentService.on("system_msg", (d) => {
    removeWelcome();
    finalizePreceding();
    appendSystemMessage(d.content);
    const m = /Max retries set to (\d+)/.exec(d.content || "");
    if (m) store.set({ maxRetries: parseInt(m[1], 10) });
    writeLog("INFO", d.content || "", "agent");
    scrollToBottom();
});

AgentService.on("error", (d) => {
    const msg = (d && (d.message || d.content)) || "Unknown error";
    removeWelcome();
    finalizePreceding();
    writeLog("ERROR", msg, "agent");
    pushActivity("ERROR_OCCURRED", msg, "ERROR");
    /* an error can arrive mid-run (backend rejects the request) — always
       hand control back to the operator instead of leaving the console locked */
    if (store.get().processing) setUserInputEnabled(true);
    sendAt = 0;
    store.set({ currentOperation: null, tokenSpeed: 0 });
    if (/connect|econn|ollama|fetch|network/i.test(msg)) {
        showAlert({
            status: "CONNECTION_FAILED",
            message: "Unable to reach the AI backend.",
            details: msg,
            retry: true,
        });
        setAgentState("error", "backend", true);
    } else {
        appendErrorMessage(msg);
        setAgentState("error", msg.slice(0, 60), true);
        /* the backend rejects the run before it starts — route the operator
           straight to model setup instead of leaving a dead console */
        if (/no model selected/i.test(msg) && !setupDismissed) showSetupModal();
    }
});

AgentService.on("conversation_list", (d) => {
    const list = (d && d.conversations) || [];
    store.set({ sessions: list });
    renderSessions(list);
    renderArtifacts(list);
    setText("mem-sessions", String(list.length));
    setText("kn-count", String(list.length));
    /* rename modal select */
    const sel = $("rename-old-select");
    if (sel && list.length) {
        sel.innerHTML = list.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.active ? " (active)" : ""}</option>`).join("");
    }
    if (activeView !== "conversations") appendConversationList(list);
    writeLog("DEBUG", `Session index: ${list.length} entries`, "store");
});

AgentService.on("prompt_input", (d) => {
    showPromptModal(d.title, d.prompt, (value) => {
        if (value) AgentService.slash(d.command, value);
    });
});

AgentService.on("prompt_rename", () => {
    AgentService.slash("/list");
    setTimeout(showRenameModal, 350);
});

function finalizePreceding() {
    if (currentResponse) { flushStreamBuffer(true); finalizeCurrentResponse(); }
    currentThinking = null;
    currentCompacting = null;
    currentToolCard = null;
    removeTypingIndicator();
}

/* ---------- the agent event stream ---------- */
AgentService.on("agent_event", (data) => {
    removeWelcome();

    /* first-event latency */
    if (sendAt && !store.get().agentLatency) {
        const lat = Date.now() - sendAt;
        store.set({ agentLatency: lat });
    }

    switch (data.type) {
        case "turn_header": {
            finalizePreceding();
            appendTurnHeader(data.content);
            setAgentState("thinking", "turn");
            act("TURN_INITIATED", data.content, "PROCESSING");
            break;
        }

        case "thinking_start": {
            finalizePreceding();
            currentThinking = createThinkingBlock();
            setAgentState("thinking", "reasoning");
            act("ANALYZING_REQUEST", "Reasoning stream open", "PROCESSING");
            break;
        }
        case "thinking": {
            if (currentThinking) currentThinking.body.textContent += data.content;
            break;
        }
        case "thinking_end": {
            currentThinking = null;
            break;
        }

        case "response": {
            if (!currentResponse) {
                currentResponse = appendAIMessageShell();
                setAgentState("responding", "stream");
                pushActivity("RESPONSE_STREAM", "First token received", "PROCESSING");
            }
            /* token speed measurement */
            const now = performance.now();
            if (tokenTimes.length) {
                const dt = now - tokenTimes[tokenTimes.length - 1];
                const inst = 1000 / Math.max(1, dt);
                tokenEma = tokenEma ? tokenEma * 0.8 + inst * 0.2 : inst;
            }
            tokenTimes.push(now);
            if (now - lastSpeedPush > 500) {
                lastSpeedPush = now;
                store.set({ tokenSpeed: tokenEma });
            }
            streamBuffer += data.content;
            flushStreamBuffer();
            scrollToBottom();
            break;
        }

        case "response_end": {
            const dur = tokenTimes.length > 1 ? tokenTimes[tokenTimes.length - 1] - tokenTimes[0] : null;
            flushStreamBuffer(true);
            finalizeCurrentResponse();
            tokenTimes = [];
            tokenEma = 0;
            store.set({ tokenSpeed: 0 });
            if (!store.get().currentOperation) setAgentState("thinking", "response complete");
            pushActivity("RESPONSE_GENERATED", "Response stream finalized", "SUCCESS", dur != null ? { duration: dur } : {});
            break;
        }

        case "code_block": {
            finalizePreceding();
            setAgentState("executing", "tool");
            act("TOOL_SELECTED", "python_executor", "INFO");
            act("TOOL_EXECUTION_STARTED", "python_executor", "PROCESSING");
            const run = toolStart("python_executor", { code: data.content });
            setToolBusy("python_executor", true, "RUNNING");
            currentToolCard = createToolCard("python_executor", data.content);
            currentToolCard.runId = run.id;
            store.set({ currentOperation: { tool: "python_executor", status: "EXECUTING", since: Date.now() } });
            break;
        }

        case "command_output": {
            const dur = currentToolCard ? completeToolCard(currentToolCard, data.content) : null;
            if (currentToolCard && currentToolCard.runId) {
                setToolOutput(currentToolCard.runId, data.content);
                toolStatus(currentToolCard.runId, "COMPLETED");
            }
            setToolBusy("python_executor", false, "READY");
            act("TOOL_EXECUTION_COMPLETE", "python_executor", "SUCCESS", dur != null ? { duration: dur } : {});
            store.set({ currentOperation: null });
            currentToolCard = null;
            setAgentState("thinking", "tool output received");
            break;
        }

        /* generic tool events (spec §25) */
        case "tool_start": {
            finalizePreceding();
            setAgentState("executing", data.tool);
            const run = toolStart(data.tool || "unknown_tool", data.input || {});
            setToolBusy(data.tool, true, "RUNNING");
            currentToolCard = createToolCard(data.tool || "unknown_tool", data.input || {});
            currentToolCard.runId = run.id;
            store.set({ currentOperation: { tool: data.tool, status: "EXECUTING", since: Date.now() } });
            act("TOOL_EXECUTION_STARTED", data.tool, "PROCESSING");
            break;
        }
        case "tool_complete": {
            const dur = data.duration != null ? data.duration : (currentToolCard ? completeToolCard(currentToolCard, data.output) : null);
            if (currentToolCard) completeToolCard(currentToolCard, data.output);
            if (currentToolCard && currentToolCard.runId) {
                setToolOutput(currentToolCard.runId, data.output);
                toolStatus(currentToolCard.runId, "COMPLETED");
            }
            setToolBusy(data.tool, false, "READY");
            act("TOOL_EXECUTION_COMPLETE", data.tool, "SUCCESS", { duration: dur || null });
            store.set({ currentOperation: null });
            currentToolCard = null;
            setAgentState("thinking", "tool complete");
            break;
        }

        case "system_msg": {
            finalizePreceding();
            appendSystemMessage(data.content);
            writeLog("INFO", data.content || "", "agent");
            break;
        }

        case "error": {
            finalizePreceding();
            appendErrorMessage(data.content);
            writeLog("ERROR", data.content || "", "agent");
            pushActivity("ERROR_OCCURRED", String(data.content).slice(0, 70), "ERROR");
            setAgentState("error", "agent fault", true);
            break;
        }

        case "token_info": {
            const m = (data.content || "").match(/TokenCount\s*=\s*([\d,]+)/i);
            if (m) store.set({ tokenCount: parseInt(m[1].replace(/,/g, ""), 10) });
            finalizePreceding();
            appendTokenInfo(m ? `TOKENS ${fmtNum(store.get().tokenCount)} / ${fmtNum(store.get().numCtx)} (${((store.get().tokenCount / store.get().numCtx) * 100).toFixed(1)}%)` : data.content);
            break;
        }

        case "compacting_start": {
            finalizePreceding();
            currentCompacting = createCompactingBlock();
            setAgentState("thinking", "compaction");
            act("CONTEXT_COMPACTION", "Summarizing history", "PROCESSING");
            break;
        }
        case "compacting_update": {
            if (currentCompacting) currentCompacting.body.textContent += data.content;
            break;
        }
        case "compacting_done": {
            finalizeCompactingBlock();
            currentCompacting = null;
            act("CONTEXT_COMPACTION", "Compaction complete", "SUCCESS");
            break;
        }

        case "agent_done": {
            finalizePreceding();
            const runMs = sendAt ? Date.now() - sendAt : null;
            sendAt = 0;
            act("AGENT_RUN_COMPLETE", "Returning control to operator", "SUCCESS", runMs != null ? { duration: runMs } : {});
            store.set({ currentOperation: null, tokenSpeed: 0 });
            setAgentState("idle", "run complete", true);
            setUserInputEnabled(true);
            userInput.focus();
            break;
        }
    }
    scrollToBottom();
});

/* ============================================================
   send / stop / slash
   ============================================================ */
/* commands the backend understands — typed input starting with one of
   these is routed over the control channel instead of the agent loop */
const SLASH_COMMANDS = new Set([
    "/mode", "/plan", "/build", "/compact", "/clear", "/tokens",
    "/model", "/list", "/save", "/load", "/rename", "/retries", "/help",
]);

function sendMessage() {
    const msg = userInput.value.trim();
    if (!msg || isProcessing) return;

    /* typed slash command → control channel (same path as hint buttons) */
    if (msg.startsWith("/")) {
        const sp = msg.indexOf(" ");
        const cmd = (sp === -1 ? msg : msg.slice(0, sp)).toLowerCase();
        if (SLASH_COMMANDS.has(cmd)) {
            const args = sp === -1 ? "" : msg.slice(sp + 1).trim();
            userInput.value = "";
            autoGrow();
            sendSlash(cmd, args);
            return;
        }
    }

    removeWelcome();
    appendUserMessage(msg);
    forceScroll();
    setAgentState("thinking", "request");
    sendAt = Date.now();
    AgentService.sendMessage(msg);
    userInput.value = "";
    autoGrow();
    setUserInputEnabled(false);
    writeLog("INFO", `Transmit: ${msg.slice(0, 90)}${msg.length > 90 ? "…" : ""}`, "ui");
    const typing = document.createElement("div");
    typing.className = "typing-indicator";
    typing.id = "typing-indicator";
    typing.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    chatMessages.appendChild(typing);
    scrollToBottom();
}
function removeTypingIndicator() { const t = $("typing-indicator"); if (t) t.remove(); }

function stopAgent() {
    AgentService.stop();
    appendSystemMessage("Stop signal sent. Cancelling…");
}

function sendSlash(command, args = "") {
    if (isProcessing) return;
    removeWelcome();
    act("COMMAND", `${command} ${args}`.trim(), "INFO");
    AgentService.slash(command, args);
}

/* ============================================================
   alerts
   ============================================================ */
function showAlert({ status, message, details, retry }) {
    const zone = $("alert-zone");
    store.set({ error: { status, message } });
    zone.innerHTML = `
        <div class="alert-card">
            <div class="alert-title"><span aria-hidden="true">⚠</span>SYSTEM ALERT</div>
            <p class="alert-msg">${escapeHtml(message)}</p>
            <p class="alert-status">STATUS: <b>${escapeHtml(status)}</b></p>
            <div class="alert-actions">
                ${retry ? '<button class="btn btn-danger btn-sm" data-action="retry-connection">RETRY CONNECTION</button>' : ""}
                <button class="btn btn-sm" data-action="dismiss-alert">DISMISS</button>
                <details class="alert-details">
                    <summary>TECHNICAL DETAILS</summary>
                    <pre>${escapeHtml(details || "—")}</pre>
                </details>
            </div>
        </div>`;
}
function dismissAlert() {
    $("alert-zone").innerHTML = "";
    store.set({ error: null });
    if (store.get().agentState === "error") setAgentState("idle", "alert dismissed", true);
}

/* ============================================================
   voice
   ============================================================ */
function buildBars() {
    document.querySelectorAll(".wave-bars").forEach((w) => {
        if (w.children.length) return;
        w.classList.add("idle");
        for (let i = 0; i < 40; i++) {
            const b = document.createElement("span");
            b.className = "wb";
            b.dataset.seed = String(((i * 37) % 17) / 17);
            w.appendChild(b);
        }
    });
}
function setWaveActive(on) {
    document.querySelectorAll(".wave-bars").forEach((w) => w.classList.toggle("idle", !on));
}
function updateVoiceStatus(text, live) {
    const v1 = $("voice-status");
    const v2 = $("voice-status-2");
    if (v1) v1.textContent = text;
    if (v2) v2.textContent = text;
    $("voice-mic")?.classList.toggle("live", !!live);
    $("voice-btn")?.classList.toggle("is-live", !!live);
}

async function voiceStart() {
    const ov = $("voice-overlay");
    ov.classList.remove("hidden");
    updateVoiceStatus("INITIALIZING…", false);
    setWaveActive(true);
    await voiceService.start();
    $("voice-confirm-btn")?.focus();
}
function voiceClose() {
    $("voice-overlay").classList.add("hidden");
    setWaveActive(false);
    document.querySelectorAll(".wave-bars .wb").forEach((b) => (b.style.height = "6%"));
    updateVoiceStatus("STANDBY", false);
    const vt = $("voice-timer"); if (vt) vt.textContent = "00:00";
    const vt2 = $("voice-timer-2"); if (vt2) vt2.textContent = "00:00";
}

voiceService.on("start", () => {
    updateVoiceStatus("LISTENING...", true);
    setAgentState("listening", "voice", true);
    pushActivity("VOICE_INPUT", "Listening…", "PROCESSING");
});
voiceService.on("transcript", (t) => {
    const n = $("voice-transcript");
    if (n) n.textContent = t;
    updateVoiceStatus("LISTENING...", true);
});
voiceService.on("status", (s) => updateVoiceStatus(s, voiceService.active));
voiceService.on("provider", (p) => {
    setText("voice-provider-tag", p.available ? "BROWSER" : "WAVEFORM");
    setText("voice-provider-name", p.name.toLowerCase());
});
voiceService.on("error", (msg) => {
    updateVoiceStatus(msg, false);
    const n = $("voice-transcript");
    if (n) n.textContent = msg;
});
voiceService.on("end", ({ transcript, duration }) => {
    updateVoiceStatus(transcript ? "TRANSCRIPT READY" : "NO SPEECH DETECTED", false);
    // Return to the correct state: if a request is streaming while voice
    // closes, the agent is still thinking — otherwise fall back to idle.
    if (store.get().agentState === "listening") {
        setAgentState(store.get().processing ? "thinking" : "idle", "voice ended", true);
    }
    if (transcript) {
        const n = $("voice-transcript");
        if (n) n.textContent = transcript;
    }
});

function voiceConfirm() {
    const text = voiceService.text;
    if (voiceService.active) voiceService.stop();
    if (text) {
        userInput.value = (userInput.value ? userInput.value + " " : "") + text;
        autoGrow();
        voiceClose();
        userInput.focus();
        appendSystemMessage(`Voice input transcribed: "${text}"`);
    } else {
        voiceClose();
    }
}
function voiceCancel() {
    voiceService.cancel();
    if (store.get().agentState === "listening") setAgentState("idle", "voice cancelled", true);
    voiceClose();
}

/* ============================================================
   modals (ported from legacy UI)
   ============================================================ */
let setupDismissed = false;
let promptCallback = null;

function openOverlay(id) {
    const o = $(id);
    o.classList.remove("hidden");
    const focusable = o.querySelector("input, select, button:not([aria-label='Close dialog']), .btn-primary");
    if (focusable) setTimeout(() => focusable.focus(), 60);
}
function closeOverlay(id) { $(id).classList.add("hidden"); }

function showSetupModal() {
    openOverlay("setup-overlay");
}
function confirmSetup() {
    const modelName = $("setup-model-select").value;
    const numCtx = parseInt($("setup-ctx-input").value, 10) || 12000;
    const projectDir = $("setup-dir-input").value.trim();
    if (!modelName) { appendSystemMessage("No model selected."); return; }
    AgentService.setModel(modelName, numCtx, projectDir);
    closeOverlay("setup-overlay");
    act("MODEL_SELECTED", modelName, "SUCCESS");
    userInput.focus();
}

function showPromptModal(title, prompt, callback) {
    promptCallback = callback;
    $("modal-title").textContent = title || "PROMPT";
    $("modal-body").innerHTML = `<label class="field-label" for="modal-input">${escapeHtml(prompt || "")}</label>
        <input type="text" class="field-input mono" id="modal-input" autocomplete="off">`;
    $("modal-footer").innerHTML = `
        <button class="btn" data-action="close-modal">CANCEL</button>
        <button class="btn btn-primary" data-action="confirm-modal">CONFIRM</button>`;
    openOverlay("modal-overlay");
    const input = $("modal-input");
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); confirmPromptModal(); }
    });
}
function confirmPromptModal() {
    const v = ($("modal-input") ? $("modal-input").value : "").trim();
    closeOverlay("modal-overlay");
    const cb = promptCallback;
    promptCallback = null;
    if (cb && v) cb(v);
}
function closeModal() { closeOverlay("modal-overlay"); promptCallback = null; }

function showRenameModal() {
    const sel = $("rename-old-select");
    if (!sel.options.length) AgentService.slash("/list");
    $("rename-new-input").value = "";
    openOverlay("rename-overlay");
}
function confirmRename() {
    const oldName = $("rename-old-select").value;
    const newName = $("rename-new-input").value.trim();
    if (oldName && newName) AgentService.slash("/rename", `${oldName} ${newName}`);
    closeOverlay("rename-overlay");
}

function browseDirectory(targetId) {
    fetch("/browse_directory")
        .then((r) => r.json())
        .then((d) => {
            const input = $(targetId);
            if (input && d.path) { input.value = d.path; input.title = d.path; }
            writeLog("DEBUG", `Directory picker: ${d.path || d.error || "empty"}`, "ui");
        })
        .catch((e) => writeLog("ERROR", `Directory picker failed: ${e.message}`, "ui"));
}

/* ============================================================
   system monitor charts
   ============================================================ */
const charts = [];
function initCharts() {
    const defs = [
        ["chart-cpu", "#00D9FF", 100, "%", "cl-cpu"],
        ["chart-mem", "#00FF9C", 100, "%", "cl-mem"],
        ["chart-gpu", "#FFC857", 100, "%", "cl-gpu"],
        ["chart-net", "#4BE8FF", 8, "M", "cl-net"],
        ["chart-disk", "#6F8995", 100, "%", "cl-disk"],
    ];
    defs.forEach(([id, color, max, unit, labelId]) => {
        const c = $(id);
        if (!c) return;
        charts.push(new LineChart(c, { color, maxVal: max, unit, maxPoints: 60 }));
        c._labelId = labelId;
    });
}

/* ============================================================
   knowledge artifacts
   ============================================================ */
function renderArtifacts(sessions) {
    const box = $("kn-artifacts");
    if (!box) return;
    box.innerHTML = "";
    if (!sessions || sessions.length === 0) {
        box.innerHTML = '<p class="empty">Saved sessions become retrievable knowledge artifacts.</p>';
        return;
    }
    sessions.forEach((s) => {
        const li = document.createElement("li");
        li.innerHTML = `<span aria-hidden="true">◈</span><b>${escapeHtml(s.name)}</b>
            <span class="a-meta">${escapeHtml(s.mode)} · ${fmtNum(s.tokens)} TOK</span>`;
        box.appendChild(li);
    });
}

/* ============================================================
   telemetry subscription
   ============================================================ */
metricsService.subscribe((m) => {
    const s = store.get();
    store.set({ metrics: m });
    updateMetricBars(m);
    if (activeView === "monitor") {
        const vals = { "chart-cpu": m.cpu, "chart-mem": m.mem, "chart-gpu": m.gpu, "chart-net": m.netMbps || 0, "chart-disk": m.disk };
        charts.forEach((c) => {
            const key = Object.keys(vals).find((k) => $(k) === c.canvas);
            if (key != null) c.push(vals[key]);
            const lbl = $(c.canvas._labelId);
            if (lbl) lbl.textContent = `${vals[key].toFixed(key === "chart-net" ? 1 : 0)}${c.unit}`;
        });
    }
});

/* ============================================================
   keyboard
   ============================================================ */
function autoGrow() {
    userInput.style.height = "auto";
    userInput.style.height = Math.min(150, userInput.scrollHeight) + "px";
}
userInput.addEventListener("input", autoGrow);
userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (!$("voice-overlay").classList.contains("hidden")) { voiceCancel(); return; }
        if (!$("modal-overlay").classList.contains("hidden")) { closeModal(); return; }
        if (!$("setup-overlay").classList.contains("hidden")) { closeOverlay("setup-overlay"); setupDismissed = true; return; }
        if (!$("rename-overlay").classList.contains("hidden")) { closeOverlay("rename-overlay"); return; }
        closeDrawers();
    }
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); sendMessage(); }
});

/* ============================================================
   delegated actions
   ============================================================ */
document.addEventListener("click", (e) => {
    const navBtn = e.target.closest(".nav-item[data-view]");
    if (navBtn) { switchView(navBtn.dataset.view); return; }

    const slashBtn = e.target.closest("[data-slash]");
    if (slashBtn) { sendSlash(slashBtn.dataset.slash); return; }

    const loadBtn = e.target.closest("[data-session-load]");
    if (loadBtn) { sendSlash("/load", loadBtn.dataset.sessionLoad); return; }

    const renBtn = e.target.closest("[data-session-rename]");
    if (renBtn) {
        showRenameModal();
        setTimeout(() => { $("rename-old-select").value = renBtn.dataset.sessionRename; }, 80);
        return;
    }

    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    switch (btn.dataset.action) {
        case "toggle-nav": {
            const nav = $("left-nav");
            const open = !nav.classList.contains("is-open");
            nav.classList.toggle("is-open", open);
            $("nav-scrim").classList.toggle("hidden", !open);
            $("nav-toggle").setAttribute("aria-expanded", String(open));
            break;
        }
        case "toggle-hud": {
            const hud = $("right-hud");
            const open = !hud.classList.contains("is-open");
            hud.classList.toggle("is-open", open);
            $("hud-scrim").classList.toggle("hidden", !open);
            $("hud-toggle").setAttribute("aria-expanded", String(open));
            break;
        }
        case "send": sendMessage(); break;
        case "stop": stopAgent(); break;
        case "voice-start": voiceStart(); break;
        case "voice-toggle":
            if (voiceService.active) voiceService.stop(); else voiceService.start();
            break;
        case "voice-cancel": voiceCancel(); break;
        case "voice-confirm": voiceConfirm(); break;
        case "close-modal": closeModal(); break;
        case "confirm-modal": confirmPromptModal(); break;
        case "close-setup": closeOverlay("setup-overlay"); setupDismissed = true; break;
        case "confirm-setup": confirmSetup(); break;
        case "close-rename": closeOverlay("rename-overlay"); break;
        case "confirm-rename": confirmRename(); break;
        case "browse-dir": browseDirectory("cfg-dir"); break;
        case "browse-dir-setup": browseDirectory("setup-dir-input"); break;
        case "prompt-save": sendSlashPrompt("/save", "Save Conversation", "Enter session name to save:"); break;
        case "prompt-load": sendSlashPrompt("/load", "Load Conversation", "Enter session name to load:"); break;
        case "prompt-rename": showRenameModal(); break;
        case "prompt-retries": sendSlashPrompt("/retries", "Set Retries", "Enter max retries:"); break;
        case "fetch-models":
            btn.classList.add("is-loading");
            btn.disabled = true;
            AgentService.getModels();
            break;
        case "apply-config": {
            const model = $("cfg-model").value;
            if (!model) { appendSystemMessage("Select a model before transmitting configuration."); break; }
            AgentService.setModel(model, parseInt($("cfg-ctx").value, 10) || 12000, $("cfg-dir").value.trim());
            act("CONFIG_TRANSMITTED", model, "SUCCESS");
            break;
        }
        case "apply-retries": {
            const v = $("cfg-retries").value.trim();
            if (v) sendSlash("/retries", v);
            break;
        }
        case "settings-reset":
            settings = { ...DEFAULTS };
            saveSettings();
            applySettings();
            writeLog("INFO", "Interface settings reset to defaults", "ui");
            break;
        case "retry-connection":
            dismissAlert();
            writeLog("INFO", "Operator requested connection retry", "ui");
            if (AgentService.socket && !AgentService.socket.connected) AgentService.socket.connect();
            AgentService.getModels();
            break;
        case "dismiss-alert": dismissAlert(); break;
    }
});

function sendSlashPrompt(command, title, prompt) {
    if (isProcessing) return;
    showPromptModal(title, prompt, (value) => {
        if (value) AgentService.slash(command, value);
    });
}

/* settings controls */
$("set-motion")?.addEventListener("change", (e) => { settings.motion = e.target.checked; saveSettings(); applySettings(); });
$("set-scanlines")?.addEventListener("change", (e) => { settings.scanlines = e.target.checked; saveSettings(); applySettings(); });
$("set-autoscroll")?.addEventListener("change", (e) => { settings.autoscroll = e.target.checked; saveSettings(); });
$("set-density")?.addEventListener("change", (e) => { settings.rate = parseInt(e.target.value, 10) || 1000; saveSettings(); applySettings(); });
$("set-voice")?.addEventListener("change", (e) => { settings.voice = e.target.value; saveSettings(); applySettings(); });

/* overlay click-outside close */
["voice-overlay", "modal-overlay", "rename-overlay"].forEach((id) => {
    $(id)?.addEventListener("mousedown", (e) => {
        if (e.target.id === id) {
            if (id === "voice-overlay") voiceCancel();
            else closeOverlay(id);
        }
    });
});

/* ============================================================
   boot
   ============================================================ */
function boot() {
    buildBars();
    applySettings();
    renderToolRegistry();

    /* panels */
    mountActivity($("hud-activity"));
    mountActivity($("task-activity"));
    mountActivityClear(document.querySelector("[data-action='activity-clear']"));
    mountLogs($("log-viewer"));
    bindLogToolbar();
    mountToolRuns($("task-tools"), $("tool-history"));

    initCharts();

    /* socket */
    try {
        AgentService.connect();
    } catch (err) {
        showAlert({
            status: "CLIENT_LOAD_FAILED",
            message: "Socket.IO client failed to load.",
            details: String(err),
            retry: false,
        });
    }

    /* metrics */
    metricsService.start();

    /* voice provider label */
    const prov = voiceService.provider;
    if (prov) {
        setText("voice-provider-tag", prov.available ? "BROWSER" : "WAVEFORM");
        setText("voice-provider-name", prov.name.toLowerCase());
    }

    /* cores */
    applySettings();
    coreDash?.setState("idle");
    coreStage?.setState("idle");
    if (!settings.motion || prefersReduced.matches) {
        coreDash?.setReduced(true);
        coreStage?.setReduced(true);
    } else {
        coreDash?.start();
    }
    prefersReduced.addEventListener?.("change", applySettings);

    /* initial paint */
    store.set({ metrics: metricsService.current() || store.get().metrics });
    updateStreams();
    updateMetricBars(store.get().metrics);
    writeLog("INFO", "J.A.R.V.I.S. console initialized", "ui");
    pushActivity("SYSTEM_INITIALIZED", "HUD console online", "SUCCESS");

    /* conversation commands from the transcript header already bound via data-slash */
    document.querySelectorAll("[data-slash]").forEach((b) => {
        b.setAttribute("title", b.getAttribute("title") || b.textContent.trim());
    });
}

boot();
