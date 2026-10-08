# Use qwen3.8:27b Thinking Model or above for stable and reliable results.

import os
import sys
import json
import re
import subprocess
import threading
import time
import shutil
import io
import contextlib
from datetime import datetime

try:
    import ollama
except ImportError:
    print('Installing Ollama Python Package...')
    os.system('pip install ollama')
    print('Ollama Python Package Installed Successfully.\n')
    import ollama

try:
    import keyboard
except ImportError:
    print('Installing Keyboard Python Package for ESC interruption...')
    os.system('pip install keyboard')
    print('Keyboard Python Package Installed Successfully.\n')
    import keyboard

# --- ANSI COLOR CODES ---
COLOR_RESET = "\033[0m"
COLOR_YELLOW = "\033[93m"  # Thinking text
COLOR_WHITE = "\033[97m"   # Response text
COLOR_BLUE = "\033[94m"    # Python code & Command output
COLOR_GREEN = "\033[92m"   # Config text, /FUNC, model outputs, saves

# Enable ANSI colors natively on Windows Command Prompt if needed
if os.name == 'nt':
    os.system('')

os_name = "Windows" if os.name == 'nt' else "Linux/Mac"

sot_prefix = "\n[Start-Of-Thinking]\n"
eot_prefix = "\n[End-Of-Thinking]\n"

# Directory to store saved conversations
SAVES_DIR = "saved_conversations"

# Global state tracker for auto-saving and active mode
active_save_file = None
current_mode = "BUILD"  # Default mode: 'BUILD' or 'PLAN'

# Flag to signal execution cancellation via ESC key
cancel_requested = False

# # Old Count Tokens Function (commented out)
# def count_tokens(text: str) -> int:
#     """Estimates token count using ~1 word ≈ 1.3333 tokens (0.75 words per token)."""
#     if not text:
#         return 0
#     words = len(text.split())
#     return round(words * 1.3333)

def count_tokens(text: str) -> int:
    """
    Approximates token count for code without external dependencies.
    Splits on words, camelCase boundaries, numbers, individual symbols, and indentation.
    """
    if not text:
        return 0

    # Pattern matches:
    # 1. Words and snake_case parts: [A-Za-z]+
    # 2. Numbers: \d+
    # 3. Individual non-whitespace punctuation/symbols: [^\w\s]
    # 4. Leading indentation spaces (every 2-4 spaces)
    pattern = r'[A-Za-z]+|\d+|[^\w\s]'
    
    tokens = re.findall(pattern, text)
    
    # Account for camelCase splitting (e.g., "countTokens" -> "count", "Tokens")
    camel_case_extra = sum(
        len(re.findall(r'[A-Z][a-z]*', token)) - 1
        for token in tokens if token.isalpha() and any(c.isupper() for c in token[1:])
    )
    
    total_estimated_tokens = len(tokens) + max(0, camel_case_extra)
    
    # Apply a smaller standard expansion factor for sub-word splits
    return round(total_estimated_tokens * 1.3333)

def ensure_saves_dir():
    """Ensures the directory for saving conversations exists."""
    if not os.path.exists(SAVES_DIR):
        os.makedirs(SAVES_DIR)

def check_esc_listener():
    """Background thread function to detect ESC key without blocking execution."""
    global cancel_requested

    if os.name == 'nt':
        import msvcrt
        while not cancel_requested:
            if msvcrt.kbhit():
                key = msvcrt.getch()
                if key == b'\x1b':
                    cancel_requested = True
                    print(f"\n\n{COLOR_GREEN}[!] ESC key pressed! Cancelling task...{COLOR_RESET}\n")
                    break
            time.sleep(0.05)
    else:
        import select
        import tty
        import termios

        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        try:
            tty.setcbreak(fd)
            while not cancel_requested:
                rlist, _, _ = select.select([sys.stdin], [], [], 0.05)
                if rlist:
                    key = sys.stdin.read(1)
                    if key == '\x1b':
                        cancel_requested = True
                        print(f"\n\n{COLOR_GREEN}[!] ESC key pressed! Cancelling task...{COLOR_RESET}\n")
                        break
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

def get_system_prompt(mode: str) -> str:
    """Generates dynamic System Prompt depending on active mode."""
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

#    - Store final output or responses in a local variable named `res` or print to standard output (`print(...)`).


def extract_python(text: str) -> str | None:
    text = text.strip().split(eot_prefix)[-1].strip()  # Get the last segment after the last EOT
    match = re.findall(r"```(python|py|Python|Py)\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if len(match) > 0:
        return "\n\n".join([m[1].strip() for m in match])
    else:
        return None

def run_python(code: str) -> str:
    global cancel_requested

    code = code.replace('__name__ == "__main__"', 'True')
    code = code.replace('"__main__" == __name__', 'True')
    code = code.replace("__name__ == '__main__'", 'True')
    code = code.replace("'__main__' == __name__", 'True')

    printed_output = ""

    # Spawn the process using sys.executable to run the code string
    cmd = [sys.executable, "-c", code]
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1  # Line-buffered
        )

        # Stream output line by line as it is produced
        for line in process.stdout:
            print(line, end="")
            printed_output += line
            

        process.wait()
        
        if process.returncode != 0:
            print(f"\n[Process exited with error code {process.returncode}]")
        else:
            print("\n[Process completed successfully]")
            return printed_output
    except Exception as e:
        return f"\n[Code exited with error code {e}]"


    # stdout_capture = io.StringIO()
    # context = {}

    # try:
    #     with contextlib.redirect_stdout(stdout_capture):
    #         exec(code, {}, context)

    #     printed_output = stdout_capture.getvalue().strip()
    #     response = context.get("res")

    #     if response is not None:
    #         res_str = str(response)
    #         return f"{printed_output}\nResult: {res_str}".strip() if printed_output else res_str
    #     elif printed_output:
    #         return printed_output
    #     else:
    #         return "Executed with no output."
    # except Exception as err:
    #     return f"Execution error: {str(err)}"

def save_conversation(filename: str, messages: list, token_count: int, model_name: str, silent: bool = False) -> bool:
    ensure_saves_dir()
    if not filename.endswith(".json"):
        filename += ".json"
    
    filepath = os.path.join(SAVES_DIR, filename)
    data = {
        "timestamp": datetime.now().isoformat(),
        "model_name": model_name,
        "token_count": token_count,
        "mode": current_mode,
        "messages": messages
    }
    
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        if not silent:
            print(f"{COLOR_GREEN}[+] Conversation successfully saved to '{filepath}'{COLOR_RESET}")
        else:
            print(f"{COLOR_GREEN}[Auto-Saved to '{filename}']{COLOR_RESET}")
        return True
    except Exception as e:
        print(f"{COLOR_GREEN}[-] Error saving conversation: {e}{COLOR_RESET}")
        return False

def load_conversation(filename: str) -> tuple[list | None, int, str | None, str | None]:
    global current_mode
    ensure_saves_dir()
    if not filename.endswith(".json"):
        filename += ".json"

    filepath = os.path.join(SAVES_DIR, filename)
    if not os.path.exists(filepath):
        print(f"{COLOR_GREEN}[-] Saved session '{filename}' not found.{COLOR_RESET}")
        return None, 0, None, None

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        current_mode = data.get("mode", "BUILD")
        print(f"{COLOR_GREEN}[+] Loaded session '{filename}' (Tokens: {data.get('token_count', 0)} | Mode: {current_mode}){COLOR_RESET}")
        return data.get("messages", []), data.get("token_count", 0), data.get("model_name", None), filename
    except Exception as e:
        print(f"{COLOR_GREEN}[-] Error loading conversation: {e}{COLOR_RESET}")
        return None, 0, None, None

def rename_conversation(old_filename: str, new_filename: str) -> bool:
    global active_save_file
    ensure_saves_dir()
    
    if not old_filename.endswith(".json"):
        old_filename += ".json"
    if not new_filename.endswith(".json"):
        new_filename += ".json"

    old_path = os.path.join(SAVES_DIR, old_filename)
    new_path = os.path.join(SAVES_DIR, new_filename)

    if not os.path.exists(old_path):
        print(f"{COLOR_GREEN}[-] Target file '{old_filename}' does not exist.{COLOR_RESET}")
        return False

    if os.path.exists(new_path):
        print(f"{COLOR_GREEN}[-] Destination file '{new_filename}' already exists.{COLOR_RESET}")
        return False

    try:
        os.rename(old_path, new_path)
        print(f"{COLOR_GREEN}[+] Conversation successfully renamed from '{old_filename}' to '{new_filename}'{COLOR_RESET}")
        
        if active_save_file == old_filename:
            active_save_file = new_filename
        return True
    except Exception as e:
        print(f"{COLOR_GREEN}[-] Error renaming conversation: {e}{COLOR_RESET}")
        return False

def list_conversations():
    ensure_saves_dir()
    files = [f for f in os.listdir(SAVES_DIR) if f.endswith(".json")]
    
    if not files:
        print(f"\n{COLOR_GREEN}No saved conversations found.{COLOR_RESET}")
        return

    print(f"\n{COLOR_GREEN}" + "="*50)
    print(f"{'SAVED CONVERSATIONS':^50}")
    print("="*50 + f"{COLOR_RESET}")
    for f in sorted(files):
        name = f[:-5]
        filepath = os.path.join(SAVES_DIR, f)
        is_active = " [ACTIVE AUTO-SAVE]" if active_save_file == f else ""
        try:
            with open(filepath, "r", encoding="utf-8") as fp:
                data = json.load(fp)
                tokens = data.get("token_count", 0)
                model = data.get("model_name", "Unknown")
                mode = data.get("mode", "BUILD")
                print(f"{COLOR_GREEN}  • {name:<18} | Model: {model:<12} | Mode: {mode:<5} | Tokens: {tokens}{is_active}{COLOR_RESET}")
        except Exception:
            print(f"{COLOR_GREEN}  • {name:<18} | [Corrupted file]{is_active}{COLOR_RESET}")
    print(f"{COLOR_GREEN}" + "="*50 + f"\n{COLOR_RESET}")

def run_agent(user_request: str, max_iterations: int = 50, messages: list = None, token_count: int = 0, context_count: int = 1024) -> tuple[list, int]:
    global cancel_requested, active_save_file, current_mode, eot_prefix, sot_prefix
    cancel_requested = False
    
    esc_thread = threading.Thread(target=check_esc_listener, daemon=True)
    esc_thread.start()

    sys_prompt = get_system_prompt(current_mode)
    user_tokens = count_tokens(user_request)

    if messages is None:
        sys_tokens = count_tokens(sys_prompt)
        token_count += sys_tokens + user_tokens
        
        messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_request}
        ]
    else:
        # Update system prompt if mode was changed dynamically
        messages[0] = {"role": "system", "content": sys_prompt}
        token_count += user_tokens
        messages.append({"role": "user", "content": user_request})

    # In PLAN mode, force max_iterations to 1 since code execution loop isn't active
    effective_iterations = 1 if current_mode == "PLAN" else max_iterations

    for iteration in range(effective_iterations):
        if cancel_requested:
            print(f"\n{COLOR_GREEN}Returned to input prompt.{COLOR_RESET}")
            break

        print(f"\n{COLOR_GREEN}[Turn {iteration + 1} - {current_mode} MODE] Assistant:{COLOR_RESET} ", end="", flush=True)

        try:
            stream = ollama.chat(model=MODEL_NAME, messages=messages, stream=True, options={"num_ctx": context_count, "num_gpu": 99}, think=False)
            assistant_text = ""
            think = True
            
            for chunk in stream:
                prefix = ""
                if cancel_requested:
                    print(f"\n{COLOR_GREEN}[Interrupted streaming]{COLOR_RESET}")
                    break

                message_obj = chunk.get("message", {})
                token = message_obj.get("content", "")
                thinking_token = message_obj.get("thinking", None)

                if thinking_token:
                    if think:
                        print(f'{COLOR_YELLOW}{sot_prefix}', end="", flush=True)
                        think = False
                        
                    assistant_text += prefix + thinking_token
                    token_count += 1
                    print(f"{COLOR_YELLOW}{thinking_token}", end='', flush=True)

                if token != "":
                    if not think:
                        prefix = eot_prefix 
                        print(f'{prefix}{COLOR_RESET}', end="", flush=True)
                        think = True

                    assistant_text += prefix + token
                    token_count += 1
                    print(f"{COLOR_WHITE}{token}", end="", flush=True)

        except Exception as e:
            print(f"\n{COLOR_GREEN}Ollama connection error: {e}{COLOR_RESET}")
            break

        print(COLOR_RESET)
        messages.append({"role": "assistant", "content": assistant_text})

        # Skip execution logic completely if in PLAN mode
        if current_mode == "PLAN":
            break

        # BUILD Mode Execution logic
        cmd = extract_python(assistant_text)
        if not cmd:
            print("[Command Not Found]")
            print(f"\n{COLOR_GREEN}Task completed.{COLOR_RESET}")
            break
                
        if cancel_requested:
            print(f"\n{COLOR_GREEN}Returned to input prompt.{COLOR_RESET}")
            break

        print(f"\n{COLOR_BLUE}Executing Python:\n{cmd}\n{COLOR_RESET}")
        output = run_python(cmd)
        
        if cancel_requested:
            print(f"\n{COLOR_YELLOW}[TokenCount = {token_count}]{COLOR_RESET}")
            print(f"\n{COLOR_GREEN}Returned to input prompt.{COLOR_RESET}")
            break

        print(f"{COLOR_BLUE}[Execution Output]:\n{output}\n{COLOR_RESET}")

        cmd_feedback = f"Execution Output:\n{output}\n\nContinue or provide final answer."
        cmd_tokens = count_tokens(cmd_feedback)
        token_count += cmd_tokens

        messages.append({
            "role": "user",
            "content": cmd_feedback
        })

        print(f"{COLOR_YELLOW}[TokenCount = {token_count}]{COLOR_RESET}")

    if active_save_file and messages:
        save_conversation(active_save_file, messages, token_count, MODEL_NAME, silent=True)

    return messages, token_count

def compact_conversation(messages: list, context_count: int) -> tuple[list, int]:
    """Summarizes conversation history to compress token usage into a single prompt state."""
    global active_save_file, MODEL_NAME, current_mode
    
    if not messages or len(messages) <= 1:
        print(f"{COLOR_GREEN}[-] No conversation history to compact.{COLOR_RESET}")
        return messages, count_tokens(messages[0]["content"]) if messages else 0

    print(f"{COLOR_GREEN}[+] Compacting conversation context... Please wait.{COLOR_RESET}")
    
    # Isolate system prompt
    sys_prompt = get_system_prompt(current_mode)

    # Format historical chat data for summarization
    chat_history_str = ""
    for msg in messages[1:]:
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
        {"role": "user", "content": compaction_prompt}
    ]

    try:
        response = ollama.chat(
            model=MODEL_NAME, 
            messages=summary_request_messages, 
            options={"num_ctx": context_count}
        )
        summary_text = response.get("message", {}).get("content", "").strip()
    except Exception as e:
        print(f"{COLOR_GREEN}[-] Compaction failed during Ollama call: {e}{COLOR_RESET}")
        return messages, count_tokens(json.dumps(messages))

    # Reconstruct fresh minimal message list
    compacted_messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": f"Summary of previous context:\n{summary_text}"},
        {"role": "assistant", "content": "Understood. I have full context of our progress. How should we proceed?"}
    ]

    # Recalculate full token footprint
    new_token_count = sum(count_tokens(m["content"]) for m in compacted_messages)

    print(f"{COLOR_GREEN}[+] Compaction successful!{COLOR_RESET}")
    print(f"{COLOR_GREEN}[+] Context reduced to {new_token_count} tokens.{COLOR_RESET}")

    if active_save_file:
        save_conversation(active_save_file, compacted_messages, new_token_count, MODEL_NAME, silent=True)

    return compacted_messages, new_token_count

def get_model_context_limit(model_name: str) -> int:
    try:
        response = ollama.show(model_name)
        max_context_length = [(k, v) for k, v in response['model_info'].items() if "context" in k][0][1]
    except Exception as e:
        print(f"Error fetching metadata: {e}")
    return float('inf')

def get_model_name():
    res = ollama.list()
    MODELS_LIST = [model.model for model in res.models]
    DEFAULT_MODEL_NAME = MODELS_LIST[0] if MODELS_LIST else "ollama/llama2:13b"
    
    print(f"\n{COLOR_GREEN}" + "*"*25 + "\nAVAILABLE MODELS:\n" + "*"*25 + f"{COLOR_RESET}")
    print(f"{COLOR_GREEN}" + '\n'.join(MODELS_LIST) + f"{COLOR_RESET}")
    print(f"{COLOR_GREEN}" + "*"*25 + f"\n{COLOR_RESET}")
    
    MODEL_NAME = input(f"{COLOR_GREEN}Enter the model name: {COLOR_RESET}").strip()
    if not MODEL_NAME:
        MODEL_NAME = DEFAULT_MODEL_NAME
        print(f"{COLOR_GREEN}" + "-"*25)
        print(f"Using default model: {MODEL_NAME}")
        print("-"*25 + f"{COLOR_RESET}")
    
    max_context = get_model_context_limit(MODEL_NAME)
    
    num_context = 12000
    try:
        num_context = int(input("Please Enter Context Window Size For " + MODEL_NAME + f"\n--> "))
    except:
        pass
        
    num_context = min(max_context, num_context)
    print(f"Effective Window Size Taken: {num_context}")
    return MODEL_NAME, num_context

def retries():
    try:
        number_of_retries = int(input(f"{COLOR_GREEN}Enter the number of retries for command execution (default 5): {COLOR_RESET}").strip())
    except ValueError:
        print(f"{COLOR_GREEN}Invalid input. Using default value of 5 retries.{COLOR_RESET}")
        number_of_retries = 5
    return number_of_retries

if __name__ == "__main__":
    MODEL_NAME, num_ctx = get_model_name()
    conv = None
    tok_num = 0
    number_of_retries = retries()

    while True:
        user_request, q = "", ""
        q = input(f"\n{COLOR_WHITE}[{current_mode} MODE] Enter your request (or press Enter twice to exit)\n>>>{COLOR_RESET}").strip()
        n = 0
        while True:
            user_request += "\n" + q
            raw_cmd = user_request.strip()
            user_request = raw_cmd
            if user_request.lower() in "/bye /mode /plan /build /compact /clear /tokens /model /list /save /load /rename /retries /help".split(" ") : break
            q = input(f"{COLOR_WHITE}...{COLOR_RESET}")
            if q == "/submit": break


        if user_request.lower() == "/bye":
            print(f"{COLOR_GREEN}Exiting the agent. Goodbye!{COLOR_RESET}")
            break

        elif user_request.lower() in ["/mode", "/plan", "/build"]:
            if user_request == "/plan":
                current_mode = "PLAN"
            elif user_request == "/build":
                current_mode = "BUILD"
            else:
                current_mode = "BUILD" if current_mode == "PLAN" else "PLAN"
            print(f"{COLOR_GREEN}[+] Switched to {current_mode} MODE.{COLOR_RESET}")
            continue

        elif user_request.lower() == "/compact":
            if conv:
                conv, tok_num = compact_conversation(conv, num_ctx)
            else:
                print(f"{COLOR_GREEN}[-] No conversation active to compact.{COLOR_RESET}")
            continue

        elif user_request.lower() == "/clear":
            conv = None
            tok_num = 0
            active_save_file = None
            print(f"{COLOR_GREEN}Conversation cleared. Auto-save target reset.{COLOR_RESET}")
            continue

        elif user_request.lower() == "/tokens":
            print(f"{COLOR_GREEN}Total tokens used so far: {tok_num}{COLOR_RESET}")
            if active_save_file:
                print(f"{COLOR_GREEN}Active auto-save file: {active_save_file}{COLOR_RESET}")
            print(f"{COLOR_GREEN}Active Mode: {current_mode}{COLOR_RESET}")
            continue

        elif user_request.lower() == "/model":
            MODEL_NAME, num_ctx = get_model_name()
            continue

        elif user_request.lower() == "/list":
            list_conversations()
            continue

        elif user_request.lower().startswith("/save"):
            parts = raw_cmd.split(maxsplit=1)
            filename = parts[1].strip() if len(parts) >= 2 else input(f"{COLOR_GREEN}Enter session name to save: {COLOR_RESET}").strip()
            if filename:
                if conv is None:
                    print(f"{COLOR_GREEN}[-] No active conversation context to save.{COLOR_RESET}")
                else:
                    if save_conversation(filename, conv, tok_num, MODEL_NAME):
                        active_save_file = filename if filename.endswith(".json") else filename + ".json"
                        print(f"{COLOR_GREEN}[+] Auto-save activated for '{active_save_file}'{COLOR_RESET}")
            continue

        elif user_request.lower().startswith("/load"):
            parts = raw_cmd.split(maxsplit=1)
            filename = parts[1].strip() if len(parts) >= 2 else input(f"{COLOR_GREEN}Enter session name to load: {COLOR_RESET}").strip()
            if filename:
                loaded_conv, loaded_tokens, loaded_model, active_file = load_conversation(filename)
                if loaded_conv is not None:
                    conv = loaded_conv
                    tok_num = loaded_tokens
                    active_save_file = active_file
                    if loaded_model:
                        MODEL_NAME = loaded_model
                    print(f"{COLOR_GREEN}[+] Auto-save activated for '{active_save_file}'{COLOR_RESET}")
            continue

        elif user_request.lower().startswith("/rename"):
            parts = raw_cmd.split(maxsplit=2)
            if len(parts) < 3:
                list_conversations()
                old_name = input(f"{COLOR_GREEN}Enter existing session name: {COLOR_RESET}").strip()
                new_name = input(f"{COLOR_GREEN}Enter new session name: {COLOR_RESET}").strip()
            else:
                old_name, new_name = parts[1].strip(), parts[2].strip()
            
            if old_name and new_name:
                rename_conversation(old_name, new_name)
            continue

        elif user_request.lower() == "/retries":
            number_of_retries = retries()
            continue

        elif user_request.lower() == "/help":
            print(f"{COLOR_GREEN}Available commands:\n" +
                  "  /mode                  - Toggle between PLAN and BUILD mode\n" +
                  "  /plan                  - Set mode to PLAN MODE\n" +
                  "  /build                 - Set mode to BUILD MODE\n" +
                  "  /compact               - Summarize and shrink current conversation tokens\n" +
                  "  /save <name>           - Save conversation (enables auto-save)\n" +
                  "  /load <name>           - Load a saved conversation (enables auto-save)\n" +
                  "  /rename <old> <new>    - Rename a saved conversation session\n" +
                  "  /list                  - List all saved sessions\n" +
                  "  /clear                 - Clear active conversation context\n" +
                  "  /tokens                - Show total tokens, mode, and active save file\n" +
                  "  /model                 - Change active model\n" +
                  "  /retries               - Set maximum iteration retries\n" +
                  "  /bye                   - Exit the agent\n" +
                  "  /help                  - Show this help message{COLOR_RESET}")
            continue

        elif user_request:
            conv, tok_num = run_agent(user_request, messages=conv, max_iterations=number_of_retries, token_count=tok_num, context_count=num_ctx)
            continue