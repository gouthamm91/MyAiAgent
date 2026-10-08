import os
import json
import re
import io
import contextlib
from datetime import datetime
import subprocess
import sys

import ollama

SAVES_DIR = "saved_conversations"


def ensure_saves_dir():
    if not os.path.exists(SAVES_DIR):
        os.makedirs(SAVES_DIR)


def count_tokens(text: str) -> int:
    if not text:
        return 0

    pattern = r'[A-Za-z]+|\d+|[^\w\s]'
    tokens = re.findall(pattern, text)

    camel_case_extra = sum(
        len(re.findall(r'[A-Z][a-z]*', token)) - 1
        for token in tokens if token.isalpha() and any(c.isupper() for c in token[1:])
    )

    total_estimated_tokens = len(tokens) + max(0, camel_case_extra)
    return round(total_estimated_tokens * 1.1)


def get_system_prompt(mode: str) -> str:
    os_name = "Windows" if os.name == 'nt' else "Linux/Mac"
    if mode.upper() == "PLAN":
        return """You are a System Architecture and Strategy Assistant (Agent Running On User's Local Machine) operating in PLAN MODE.

### CURRENT MODE: PLAN MODE
- When ever you think or plan use the language similar to a cave man or Hulk. Instead of saying `User has asked me to create a HTML file.` just say `User asked create HTML`, `Is it going to be single file? I think not.` instead say `single file? no.`.
- Please do not write full code while thinking or planning. Just write the steps and logic in simple words.
  This will save a lot of token counts since we have limited local memory. But this is applicable ONLY FOR THINKING OR PLAN-MODE NOT FOR THE ACTUAL RESPONSE.
- Please keep the thinking and planning concise and to the point. Avoid unnecessary verbosity. Planning should have a total of (thinking+plan) 750 tokens or less.
- Do NOT generate or execute ANY Python code blocks (no ```python ... ``` blocks).
- Focus purely on analysis, step-by-step strategy, prerequisite checks, and logical design.
- Outline clear, structured implementation plans for the user. Ask clarifying questions if needed.
- Breakdown the process into small Tasks and List them on display.
- Prepare the user for what will happen once they switch to BUILD MODE.
- NEVER SAY NO or OUT OF SCOPE to the user unless it is an unethical, illegal, dangerous or harmfull activity.
- You have access to the user's local file system.
""" + f"""

### OPERATING SYSTEM: {os_name}
"""
    else:
        return """You are an automated Python Execution Assistant operating in BUILD MODE.

### CURRENT MODE: BUILD MODE
1. When asked to perform an action, generate executable Python code.
2. Follow strict operational rules below.

### CORE OPERATIONAL RULES:
1. COMMAND EXECUTION:
   - When ever you think or plan use the language similar to a cave man or Hulk. Instead of saying `User has asked me to create a HTML file.` just say `User asked create HTML`, `Is it going to be single file? I think not.` instead say `single file? no.`.
   - Please do not write full code while thinking or planning. Just write the steps and logic in simple words. This will save a lot of token counts since we have limited local memory. But this is applicable ONLY FOR THINKING OR IN PLAN-MODE NOT FOR THE ACTUAL RESPONSE.
   - Please keep the thinking and planning concise and to the point. Avoid unnecessary verbosity. Planning should have a total of (thinking+plan) 750 tokens or less.
   - Output Python code inside exactly ONE ```python ``` code block per turn. While thinking write code inside ```thinking-python-code ``` block.
   - Output ONLY executable Python code inside the block. NEVER output MULTIPLE CODE BLOCKS in a single TASK/STEP.
   - Print data to standard output (`print(...)`).
   - If user asks to read a file, simply PRINT the FILE CONTENT by writing a python code block.
   - Always use try catch block to handle errors.
   - Please use subprocess to install the modules/dependencies and then use the import statement.
   - When you are asked to read a file make sure the file exist else print list of all the files and find the apt one/ones among them.
   - If you read a file as a part of a process, wait for the script execution results, then proceed accordingly.
   - If there are MULTIPLE STEPS/TASKS to execute. generate the CODE ONE STEP AT A TIME AND WAIT for the output, one OUTPUT RECEIVED then proceed to next step.
   - NEVER SAY NO or OUT OF SCOPE to the user unless it is an unethical, illegal, dangerous or harmfull activity.
   - You have access to the user's local file system.
   - NEVER USE `if __name__ == "__main__":` as a part of code generation.

2. STOP CONDITION & FINAL ANSWER:
   - When the task is completely finished and verified, provide a concise summary of your work WITHOUT using any code blocks.
   - Do NOT issue further code blocks once the task is finished.
""" + f"""

### OPERATING SYSTEM: {os_name}
"""

def extract_python(text: str) -> str | None:
    match = re.findall(r"```(python|py|Python|Py)\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if len(match) > 0:
        return "\n\n".join([m[1].strip() for m in match])
    else:
        return None


def run_python(code: str) -> str:
    
    code = code.replace('__name__ == "__main__"', 'True')
    code = code.replace('"__main__" == __name__', 'True')
    code = code.replace("__name__ == '__main__'", 'True')
    code = code.replace("'__main__' == __name__", 'True')

    printed_output = ""
    try:
        cmd = [sys.executable, "-c", code]
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        for line in process.stdout:
            printed_output += line
        process.wait()
        
        if process.returncode != 0:
            printed_output += f"\n[Process exited with error code {process.returncode}]"
        else:
            printed_output += f"\n[Process completed successfully]"
        return printed_output
    except Exception as e:
        return f"\n[Code execution error: {e}]"


class AgentSession:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.messages = None
        self.token_count = 0
        self.current_mode = "BUILD"
        self.active_save_file = None
        self.cancel_requested = False
        self.model_name = ""
        self.num_ctx = 12000
        self.max_retries = 5
        self.project_dir = None

    def reset(self):
        self.messages = None
        self.token_count = 0
        self.active_save_file = None
        self.cancel_requested = False

    def get_state(self):
        return {
            "mode": self.current_mode,
            "token_count": self.token_count,
            "model_name": self.model_name,
            "num_ctx": self.num_ctx,
            "max_retries": self.max_retries,
            "active_save_file": self.active_save_file,
            "project_dir": self.project_dir,
            "has_conversation": self.messages is not None and len(self.messages) > 0,
        }

    def run_python(self, code: str) -> str:
        original_cwd = os.getcwd()
        target_dir = self.project_dir or original_cwd
        try:
            if target_dir and os.path.isdir(target_dir):
                os.chdir(target_dir)
            return run_python(code)
        finally:
            if original_cwd and os.path.isdir(original_cwd):
                os.chdir(original_cwd)

    def save_conversation(self, filename: str, silent: bool = False) -> dict:
        ensure_saves_dir()
        if not filename.endswith(".json"):
            filename += ".json"
        filepath = os.path.join(SAVES_DIR, filename)
        data = {
            "timestamp": datetime.now().isoformat(),
            "model_name": self.model_name,
            "token_count": self.token_count,
            "mode": self.current_mode,
            "messages": self.messages,
        }
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            return {"success": True, "message": f"Conversation saved to '{filename}'", "filename": filename}
        except Exception as e:
            return {"success": False, "message": f"Error saving conversation: {e}"}

    def load_conversation(self, filename: str) -> dict:
        ensure_saves_dir()
        if not filename.endswith(".json"):
            filename += ".json"
        filepath = os.path.join(SAVES_DIR, filename)
        if not os.path.exists(filepath):
            return {"success": False, "message": f"Saved session '{filename}' not found."}
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.current_mode = data.get("mode", "BUILD")
            self.messages = data.get("messages", [])
            self.token_count = data.get("token_count", 0)
            self.active_save_file = filename
            if data.get("model_name"):
                self.model_name = data["model_name"]
            return {
                "success": True,
                "message": f"Loaded session '{filename}' (Tokens: {self.token_count} | Mode: {self.current_mode})",
            }
        except Exception as e:
            return {"success": False, "message": f"Error loading conversation: {e}"}

    def rename_conversation(self, old_filename: str, new_filename: str) -> dict:
        ensure_saves_dir()
        if not old_filename.endswith(".json"):
            old_filename += ".json"
        if not new_filename.endswith(".json"):
            new_filename += ".json"
        old_path = os.path.join(SAVES_DIR, old_filename)
        new_path = os.path.join(SAVES_DIR, new_filename)
        if not os.path.exists(old_path):
            return {"success": False, "message": f"Target file '{old_filename}' does not exist."}
        if os.path.exists(new_path):
            return {"success": False, "message": f"Destination file '{new_filename}' already exists."}
        try:
            os.rename(old_path, new_path)
            if self.active_save_file == old_filename:
                self.active_save_file = new_filename
            return {"success": True, "message": f"Renamed '{old_filename}' to '{new_filename}'"}
        except Exception as e:
            return {"success": False, "message": f"Error renaming conversation: {e}"}

    def list_conversations(self) -> dict:
        ensure_saves_dir()
        files = [f for f in os.listdir(SAVES_DIR) if f.endswith(".json")]
        conversations = []
        for f in sorted(files):
            name = f[:-5]
            filepath = os.path.join(SAVES_DIR, f)
            is_active = self.active_save_file == f
            try:
                with open(filepath, "r", encoding="utf-8") as fp:
                    data = json.load(fp)
                    conversations.append({
                        "name": name,
                        "model": data.get("model_name", "Unknown"),
                        "mode": data.get("mode", "BUILD"),
                        "tokens": data.get("token_count", 0),
                        "active": is_active,
                    })
            except Exception:
                conversations.append({
                    "name": name,
                    "model": "Unknown",
                    "mode": "N/A",
                    "tokens": 0,
                    "active": is_active,
                    "corrupted": True,
                })
        return {"conversations": conversations}

    def token_rate(self) -> float:
        if self.num_ctx <= 0:
            return 0.0
        return (self.token_count / self.num_ctx) * 100.0

    def compact_conversation(self, emit_fn=None) -> dict:
        if not self.messages or len(self.messages) <= 1:
            return {"success": False, "message": "No conversation history to compact."}

        sys_prompt = get_system_prompt(self.current_mode)
        chat_history_str = ""
        for msg in self.messages[1:]:
            role = msg["role"].upper()
            content = msg["content"]
            chat_history_str += f"[{role}]: {content}\n\n"

        compaction_prompt = (
            "Summarize the following conversation concisely. "
            "Preserve key facts, operational instructions, code block context, file modifications, "
            "and progress completed so far. Do NOT produce Python blocks.\n\n"
            f"CONVERSATION HISTORY:\n{chat_history_str}"
        )

        summary_request_messages = [
            {"role": "system", "content": "You are a concise technical summarization assistant."},
            {"role": "user", "content": compaction_prompt},
        ]

        if emit_fn:
            emit_fn({"type": "compacting_start", "content": "Compacting conversation... Generating summary."})

        summary_text = ""
        try:
            stream = ollama.chat(
                model=self.model_name,
                messages=summary_request_messages,
                stream=True,
                options={"num_ctx": self.num_ctx},
            )
            for chunk in stream:
                if self.cancel_requested:
                    if emit_fn:
                        emit_fn({"type": "compacting_done", "content": "Cancelled by user."})
                    return {"success": False, "message": "Compaction cancelled by user."}
                token = chunk.get("message", {}).get("content", "")
                if token:
                    summary_text += token
                    if emit_fn:
                        emit_fn({"type": "compacting_update", "content": token})
        except Exception as e:
            return {"success": False, "message": f"Compaction failed: {e}"}

        summary_text = summary_text.strip()
        if not summary_text:
            return {"success": False, "message": "Compaction produced no summary."}

        self.messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": f"Summary of previous context:\n{summary_text}"},
            {"role": "assistant", "content": "Understood. I have full context of our progress. How should we proceed?"},
        ]
        self.token_count = sum(count_tokens(m["content"]) for m in self.messages)

        if self.active_save_file:
            self.save_conversation(self.active_save_file, silent=True)

        if emit_fn:
            emit_fn({"type": "compacting_done", "content": ""})

        return {
            "success": True,
            "message": f"Compaction successful! Context reduced to {self.token_count} tokens.",
            "token_count": self.token_count,
        }

    def run_agent(self, user_request: str, emit_fn=None):
        self.cancel_requested = False
        sys_prompt = get_system_prompt(self.current_mode)
        user_tokens = count_tokens(user_request)

        if self.messages is None:
            sys_tokens = count_tokens(sys_prompt)
            self.token_count += sys_tokens + user_tokens
            self.messages = [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_request},
            ]
        else:
            self.messages[0] = {"role": "system", "content": sys_prompt}
            self.token_count += user_tokens
            self.messages.append({"role": "user", "content": user_request})

        effective_iterations = 1 if self.current_mode == "PLAN" else self.max_retries

        for iteration in range(effective_iterations):
            if self.cancel_requested:
                if emit_fn:
                    emit_fn({"type": "system_msg", "content": "Cancelled by user."})
                break

            if self.token_rate() >= 90.0 and self.messages and len(self.messages) > 1:
                if emit_fn:
                    emit_fn({"type": "system_msg", "content": f"Token rate at {self.token_rate():.1f}% — auto-compacting context."})
                result = self.compact_conversation(emit_fn=emit_fn)
                if emit_fn:
                    emit_fn({"type": "token_info", "content": f"TokenCount = {self.token_count}"})
                if not result.get("success"):
                    if emit_fn:
                        emit_fn({"type": "system_msg", "content": result.get("message", "Auto-compaction failed.")})

            if self.cancel_requested:
                if emit_fn:
                    emit_fn({"type": "system_msg", "content": "Cancelled by user."})
                break

            if emit_fn:
                emit_fn({"type": "turn_header", "content": f"Turn {iteration + 1} - {self.current_mode} MODE"})

            assistant_text = ""
            try:
                stream = ollama.chat(
                    model=self.model_name,
                    messages=self.messages,
                    stream=True,
                    options={"num_ctx": self.num_ctx},
                    think=False
                )
                think = True
                for chunk in stream:
                    if self.cancel_requested:
                        if emit_fn:
                            emit_fn({"type": "system_msg", "content": "[Interrupted streaming]"})
                        break

                    message_obj = chunk.get("message", {})
                    token = message_obj.get("content", "")
                    thinking_token = message_obj.get("thinking", None)

                    if thinking_token:
                        if think:
                            if emit_fn:
                                emit_fn({"type": "thinking_start", "content": ""})
                            think = False
                        if emit_fn:
                            emit_fn({"type": "thinking", "content": thinking_token})

                    if token != "":
                        if not think:
                            if emit_fn:
                                emit_fn({"type": "thinking_end", "content": ""})
                            think = True
                        assistant_text += token
                        self.token_count += 1
                        if emit_fn:
                            emit_fn({"type": "response", "content": token})

            except Exception as e:
                if emit_fn:
                    emit_fn({"type": "error", "content": f"Ollama connection error: {e}"})
                break

            if emit_fn:
                emit_fn({"type": "response_end", "content": ""})

            self.messages.append({"role": "assistant", "content": assistant_text})

            if self.current_mode == "PLAN":
                break

            cmd = extract_python(assistant_text)
            if not cmd:
                if emit_fn:
                    emit_fn({"type": "system_msg", "content": "Task completed."})
                break

            if self.cancel_requested:
                if emit_fn:
                    emit_fn({"type": "system_msg", "content": "Cancelled by user."})
                break

            if emit_fn:
                emit_fn({"type": "code_block", "content": cmd})

            output = self.run_python(cmd)

            if self.cancel_requested:
                if emit_fn:
                    emit_fn({"type": "token_info", "content": f"TokenCount = {self.token_count}"})
                    emit_fn({"type": "system_msg", "content": "Cancelled by user."})
                break

            if emit_fn:
                emit_fn({"type": "command_output", "content": output})

            cmd_feedback = f"Command Outputs:\n{output}\n\nContinue or provide final answer."
            cmd_tokens = count_tokens(cmd_feedback)
            self.token_count += cmd_tokens
            self.messages.append({"role": "user", "content": cmd_feedback})

            if emit_fn:
                emit_fn({"type": "token_info", "content": f"TokenCount = {self.token_count}"})

        if self.active_save_file and self.messages:
            self.save_conversation(self.active_save_file, silent=True)

        if emit_fn:
            emit_fn({"type": "agent_done", "content": ""})
