import os
import shutil
import subprocess
import sys
import threading
from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO, emit
import ollama

from agent import AgentSession

app = Flask(__name__)
app.config["SECRET_KEY"] = os.urandom(24)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

sessions: dict[str, AgentSession] = {}


def get_session(sid: str) -> AgentSession:
    if sid not in sessions:
        sessions[sid] = AgentSession(sid)
    return sessions[sid]


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/browse_directory")
def browse_directory():
    try:
        path = pick_directory()
        if not path:
            return jsonify({"path": "", "error": "No directory selected."})
        return jsonify({"path": path})
    except Exception as e:
        return jsonify({"path": "", "error": str(e)})


def pick_directory() -> str:
    if sys.platform == "darwin":
        return pick_directory_macos()
    elif sys.platform.startswith("win"):
        return pick_directory_windows()
    else:
        return pick_directory_linux()


def pick_directory_macos() -> str:
    script = 'POSIX path of (choose folder with prompt "Select the project directory for the agent")'
    try:
        proc = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=300,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
        return ""
    except Exception as e:
        return f"Could not open folder picker: {e}"


def pick_directory_windows() -> str:
    executable = "pwsh" if shutil.which("pwsh") else "powershell"
    if not shutil.which(executable):
        return "PowerShell not found. Install PowerShell to use the folder picker."
    script = r"""
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select the project directory for the agent"
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $dialog.SelectedPath
}
"""
    try:
        proc = subprocess.run(
            [executable, "-NoProfile", "-NonInteractive", "-Sta", "-Command", script],
            capture_output=True, text=True, timeout=300,
        )
        return proc.stdout.strip()
    except Exception as e:
        return f"Could not open folder picker: {e}"


def pick_directory_linux() -> str:
    for tool in ("zenity", "kdialog"):
        if shutil.which(tool):
            cmd = [tool, "--title", "Select the project directory for the agent", "--directory"]
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
                if proc.returncode == 0 and proc.stdout.strip():
                    return proc.stdout.strip()
                return ""
            except Exception as e:
                return f"Could not open folder picker: {e}"
    return "No supported folder picker found (install zenity or kdialog)."


@socketio.on("connect")
def handle_connect():
    session = get_session(__import__("flask").request.sid)
    emit("state_update", session.get_state())


@socketio.on("disconnect")
def handle_disconnect():
    sid = __import__("flask").request.sid
    if sid in sessions:
        sessions[sid].cancel_requested = True
        del sessions[sid]


@socketio.on("get_models")
def handle_get_models():
    try:
        res = ollama.list()
        models = [model.model for model in res.models]
        emit("models_list", {"models": models})
    except Exception as e:
        emit("error", {"message": f"Failed to fetch models: {e}"})


@socketio.on("set_model")
def handle_set_model(data):
    sid = __import__("flask").request.sid
    session = get_session(sid)
    model_name = data.get("model_name", "")
    num_ctx = data.get("num_ctx", 12000)
    project_dir = data.get("project_dir", "").strip()

    if project_dir and not os.path.isdir(project_dir):
        emit("error", {"message": f"Project directory does not exist: {project_dir}"})
        return

    if not model_name:
        emit("error", {"message": "No model name provided."})
        return

    try:
        response = ollama.show(model_name)
        max_context = 128000
        for k, v in response.get("model_info", {}).items():
            if "context" in k:
                max_context = v
                break
        num_ctx = min(max_context, num_ctx)
    except Exception:
        pass

    session.model_name = model_name
    session.num_ctx = num_ctx
    session.project_dir = project_dir or None
    emit("state_update", session.get_state())
    msg = f"Model set to '{model_name}' with context window {num_ctx}."
    if session.project_dir:
        msg += f" Working directory: {session.project_dir}"
    emit("system_msg", {"content": msg})


@socketio.on("send_message")
def handle_send_message(data):
    sid = __import__("flask").request.sid
    session = get_session(sid)
    user_request = data.get("message", "").strip()

    if not user_request:
        emit("error", {"message": "Empty message."})
        return

    if not session.model_name:
        emit("error", {"message": "No model selected. Use the Model button to select one."})
        return

    def emit_fn(event):
        socketio.emit("agent_event", event, room=sid)

    def run_in_thread():
        session.run_agent(user_request, emit_fn=emit_fn)
        socketio.emit("state_update", session.get_state(), room=sid)

    threading.Thread(target=run_in_thread, daemon=True).start()


@socketio.on("stop")
def handle_stop():
    sid = __import__("flask").request.sid
    session = get_session(sid)
    session.cancel_requested = True
    emit("system_msg", {"content": "Stop signal sent. Cancelling..."})


@socketio.on("slash")
def handle_slash(data):
    sid = __import__("flask").request.sid
    session = get_session(sid)
    command = data.get("command", "").lower().strip()
    args = data.get("args", "")

    if command in ["/mode", "/plan", "/build"]:
        if command == "/plan":
            session.current_mode = "PLAN"
        elif command == "/build":
            session.current_mode = "BUILD"
        else:
            session.current_mode = "BUILD" if session.current_mode == "PLAN" else "PLAN"
        emit("system_msg", {"content": f"Switched to {session.current_mode} MODE."})
        emit("state_update", session.get_state())

    elif command == "/compact":
        result = session.compact_conversation()
        emit("system_msg", {"content": result["message"]})
        emit("state_update", session.get_state())

    elif command == "/clear":
        session.reset()
        emit("system_msg", {"content": "Conversation cleared. Auto-save target reset."})
        emit("state_update", session.get_state())

    elif command == "/tokens":
        msg = f"Total tokens used: {session.token_count}\n"
        if session.active_save_file:
            msg += f"Active auto-save file: {session.active_save_file}\n"
        msg += f"Active Mode: {session.current_mode}"
        emit("system_msg", {"content": msg})

    elif command == "/model":
        handle_get_models()

    elif command == "/list":
        result = session.list_conversations()
        emit("conversation_list", result)

    elif command == "/save":
        filename = args.strip()
        if not filename:
            emit("prompt_input", {"title": "Save Conversation", "prompt": "Enter session name to save:", "command": "/save"})
            return
        if session.messages is None:
            emit("system_msg", {"content": "No active conversation context to save."})
            return
        result = session.save_conversation(filename)
        if result["success"]:
            session.active_save_file = result["filename"]
        emit("system_msg", {"content": result["message"]})
        emit("state_update", session.get_state())

    elif command == "/load":
        filename = args.strip()
        if not filename:
            handle_get_models()
            result = session.list_conversations()
            emit("conversation_list", result)
            emit("prompt_input", {"title": "Load Conversation", "prompt": "Enter session name to load:", "command": "/load"})
            return
        result = session.load_conversation(filename)
        emit("system_msg", {"content": result["message"]})
        emit("state_update", session.get_state())

    elif command == "/rename":
        parts = args.strip().split(maxsplit=1)
        if len(parts) < 2:
            result = session.list_conversations()
            emit("conversation_list", result)
            emit("prompt_rename", {"title": "Rename Conversation"})
            return
        result = session.rename_conversation(parts[0], parts[1])
        emit("system_msg", {"content": result["message"]})

    elif command == "/retries":
        if args.strip():
            try:
                session.max_retries = int(args.strip())
                emit("system_msg", {"content": f"Max retries set to {session.max_retries}."})
                emit("state_update", session.get_state())
            except ValueError:
                emit("system_msg", {"content": "Invalid number. Using default of 5."})
        else:
            emit("prompt_input", {"title": "Set Retries", "prompt": "Enter max retries:", "command": "/retries"})

    elif command == "/help":
        help_text = """Available commands:
  /mode       - Toggle between PLAN and BUILD mode
  /plan       - Set mode to PLAN MODE
  /build      - Set mode to BUILD MODE
  /compact    - Summarize and shrink current conversation tokens
  /save       - Save conversation (enables auto-save)
  /load       - Load a saved conversation (enables auto-save)
  /rename     - Rename a saved conversation session
  /list       - List all saved sessions
  /clear      - Clear active conversation context
  /tokens     - Show total tokens, mode, and active save file
  /model      - Change active model
  /retries    - Set maximum iteration retries
  /help       - Show this help message"""
        emit("system_msg", {"content": help_text})

    else:
        emit("error", {"content": f"Unknown command: {command}"})


if __name__ == "__main__":
    socketio.run(app, debug=True, host="0.0.0.0", port=5000)
