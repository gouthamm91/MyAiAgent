/* ============================================================
   state.js — central client state store
   Agent state machine, activity stream, logs, tool runs.
   Pure module: no DOM, no socket.
   ============================================================ */

export const AGENT_STATES = ["idle", "listening", "thinking", "executing", "responding", "error"];

export const STATE_LABELS = {
    idle: "READY",
    listening: "LISTENING...",
    thinking: "PROCESSING...",
    executing: "EXECUTING TOOL",
    responding: "RESPONDING...",
    error: "SYSTEM ERROR",
};

export const STATE_SUBTEXT = {
    idle: "ALL SYSTEMS NOMINAL",
    listening: "AUDIO CHANNEL OPEN",
    thinking: "NEURAL LINK ACTIVE",
    executing: "TOOL EXECUTION IN PROGRESS",
    responding: "STREAMING OUTPUT",
    error: "FAULT DETECTED — SEE ALERTS",
};

/* Legal transitions (terminal ones are forced) */
const TRANSITIONS = {
    idle: ["listening", "thinking", "error"],
    listening: ["idle", "thinking", "error"],
    thinking: ["executing", "responding", "idle", "error"],
    executing: ["thinking", "responding", "idle", "error"],
    responding: ["idle", "thinking", "executing", "error"],
    error: ["idle", "thinking", "listening"],
};

/* ---------- tiny store ---------- */
function createStore(initial) {
    let state = initial;
    const listeners = new Set();
    return {
        get: () => state,
        set(patch) {
            state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
            listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}

export const store = createStore({
    /* connection / agent */
    connection: "connecting",          // connecting | online | offline
    agentState: "idle",
    stateSince: Date.now(),
    stateReason: "",
    error: null,                       // { status, message, details }

    /* session (mirrors backend state_update) */
    mode: "BUILD",
    modelName: "",
    numCtx: 12000,
    tokenCount: 0,
    activeSaveFile: null,
    projectDir: null,
    hasConversation: false,
    maxRetries: 5,

    /* runtime */
    processing: false,
    currentOperation: null,            // { tool, status, since, input }
    agentLatency: null,                // ms, measured send→first event
    tokenSpeed: 0,                     // tokens/sec, measured while streaming
    sessions: [],                      // saved conversation sessions
    models: [],
    startedAt: Date.now(),

    /* telemetry (updated by MetricsService) */
    metrics: { cpu: 0, mem: 0, gpu: 0, disk: 0, net: 0, proc: 0, temp: 0 },
});

/* ---------- agent state machine ---------- */
export function setAgentState(next, reason = "", force = false) {
    const s = store.get();
    if (next === s.agentState) return false;
    const allowed = (TRANSITIONS[s.agentState] || []).includes(next);
    if (!allowed && !force) return false;
    store.set({ agentState: next, stateSince: Date.now(), stateReason: reason });
    return true;
}

/* ---------- activity stream ---------- */
const activityListeners = new Set();
const activity = [];
const ACTIVITY_MAX = 250;
let actSeq = 0;

/**
 * Push an agent activity event.
 * @param {string} type    e.g. USER_REQUEST_RECEIVED
 * @param {string} desc    human readable detail
 * @param {string} status  INFO | PROCESSING | SUCCESS | WARNING | ERROR
 * @param {object} [extra] { duration, detail }
 */
export function pushActivity(type, desc, status = "INFO", extra = {}) {
    const item = {
        id: ++actSeq,
        ts: Date.now(),
        type,
        desc: desc || "",
        status,
        duration: extra.duration != null ? extra.duration : null,
        detail: extra.detail || "",
    };
    activity.push(item);
    if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
    activityListeners.forEach((fn) => fn(item, activity));
    return item;
}

export function getActivity() { return activity; }
export function clearActivity() {
    activity.length = 0;
    activityListeners.forEach((fn) => fn(null, activity));
}
export function onActivity(fn) {
    activityListeners.add(fn);
    return () => activityListeners.delete(fn);
}

/* ---------- log ring buffer ---------- */
const logListeners = new Set();
const logs = [];
const LOG_MAX = 1000;
let logSeq = 0;

export function writeLog(level, message, source = "agent") {
    const entry = {
        id: ++logSeq,
        ts: Date.now(),
        level: (level || "INFO").toUpperCase(),
        source,
        message: String(message || ""),
    };
    logs.push(entry);
    if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
    logListeners.forEach((fn) => fn(entry, logs));
    return entry;
}

export function getLogs() { return logs; }
export function clearLogs() {
    logs.length = 0;
    logListeners.forEach((fn) => fn(null, logs));
}
export function onLog(fn) {
    logListeners.add(fn);
    return () => logListeners.delete(fn);
}

/* ---------- tool executions ---------- */
const toolListeners = new Set();
const toolRuns = [];
const TOOL_MAX = 60;
let toolSeq = 0;

export function toolStart(tool, input = {}) {
    const run = {
        id: ++toolSeq,
        tool,
        status: "QUEUED",           // QUEUED | EXECUTING | COMPLETED | FAILED
        startedAt: Date.now(),
        endedAt: null,
        duration: null,
        input,
        output: null,
    };
    toolRuns.push(run);
    if (toolRuns.length > TOOL_MAX) toolRuns.splice(0, toolRuns.length - TOOL_MAX);
    notifyTools("start", run);
    return run;
}

export function toolStatus(id, status) {
    const run = toolRuns.find((r) => r.id === id);
    if (!run) return null;
    run.status = status;
    if (status === "COMPLETED" || status === "FAILED") {
        run.endedAt = Date.now();
        run.duration = run.endedAt - run.startedAt;
    }
    notifyTools("update", run);
    return run;
}

export function toolFinish(id, output, ok = true) {
    return toolStatus(id, ok ? "COMPLETED" : "FAILED") && setToolOutput(id, output);
}

export function setToolOutput(id, output) {
    const run = toolRuns.find((r) => r.id === id);
    if (!run) return null;
    run.output = output;
    notifyTools("update", run);
    return run;
}

export function getToolRuns() { return toolRuns; }
export function clearToolRuns() {
    toolRuns.length = 0;
    notifyTools("clear", null);
}
export function onToolRun(fn) {
    toolListeners.add(fn);
    return () => toolListeners.delete(fn);
}
function notifyTools(action, run) {
    toolListeners.forEach((fn) => fn(action, run, toolRuns));
}

/* ---------- formatting utils ---------- */
export function fmtTime(ts, withMs = false) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    let s = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    if (withMs) s += "." + String(d.getMilliseconds()).padStart(3, "0");
    return s;
}

export function fmtDuration(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtNum(n) {
    return (n || 0).toLocaleString("en-US");
}

export function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
