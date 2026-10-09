# MyAgent
## An Open Source Agentic Harness:
### Features:
* Runs any of the Ollama Open source Models *irrespective of whether the Model has tool calling capabilities or not*. 
* UI is meant to mirror J.A.R.V.I.S. a fictional A.I.
* CLI is clean and basic.

### Features Comming Up Next:
* AGENTS.md file mechanism.
* Skills mechanism.
* Agent Naming.
* Agent Personality Molding.
* Prompt Engineering.

## Steps For Running The WebApp:
*Preprequisites*: 
* Make sure you have the Ollama up and running.
* Download the model you wanna use with **MyAgent** harness.
*Steps*:
1. Install The Dependencies Inside The `./WebApp/requirements.txt` file using the command `pip3 install -r requirements.txt`.
2. cd into `./WebApp/` Run the App Using `py app.py` or `python3 app.py`.
3. Open the Browser and goto `http://localhost:5000`.
4. Choose the Ollama Model, Working Project Directory and the Context Window Size right at the start.
5. Start talking with the Agent.

## Steps For Running The CLI:
*Preprequisites*: 
* Make sure you have the Ollama up and running.
* Download the model you wanna use with **MyAgent** harness.
*Steps*:
1. Install The Dependencies Inside The `./CLI/requirements.txt` file using the command `pip3 install -r requirements.txt`.
2. cd into `./CLI/` Run the App Using `py MyAgentV2.0.1.py` or `python3 MyAgentV2.0.1.py`.
3. Choose the Ollama Model, and the Context Window Size right at the start.
4. Start talking with the Agent.
5. Use /help to get all available functions that you can use.
