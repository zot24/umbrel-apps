---
name: ask-agent
description: Send a message to another Hermes profile agent and get a response. Use your terminal/bash tool to run curl commands. Each profile has its own API on a unique port.
trigger: ask agent, message agent, delegate to, send to coder, send to research, ask coder, ask research, talk to agent, inter-agent, cross-profile, other agent, another agent
---

# Ask Agent — Inter-Profile Communication

**IMPORTANT: You MUST use your terminal/bash/shell tool to execute the curl commands below. These are real HTTP endpoints running locally.**

## Step 1: Discover available agents

Run this command in your terminal to find other running agents and their ports:

```bash
python3 -c "
import os, json
home = os.environ.get('HERMES_HOME', os.path.expanduser('~/.hermes'))
base = home.rsplit('/profiles/', 1)[0] if '/profiles/' in home else home
# Check default profile
try:
    import urllib.request
    r = urllib.request.urlopen('http://localhost:8642/health', timeout=2)
    print('default: port=8642 RUNNING')
except: print('default: port=8642 STOPPED')
# Check named profiles
profiles_dir = os.path.join(base, 'profiles')
if os.path.isdir(profiles_dir):
    for name in sorted(os.listdir(profiles_dir)):
        env_file = os.path.join(profiles_dir, name, '.env')
        port = '8642'
        if os.path.isfile(env_file):
            for line in open(env_file):
                if line.startswith('API_SERVER_PORT='): port = line.split('=',1)[1].strip()
        try:
            r = urllib.request.urlopen(f'http://localhost:{port}/health', timeout=2)
            print(f'{name}: port={port} RUNNING')
        except: print(f'{name}: port={port} STOPPED')
"
```

## Step 2: Send a message to another agent

Replace `PORT` with the target agent's port from Step 1:

```bash
curl -s -X POST http://localhost:PORT/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"input": "YOUR MESSAGE HERE"}' | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in (data.get('output', []) if isinstance(data.get('output'), list) else []):
    if isinstance(item, dict) and item.get('type') == 'message':
        for c in item.get('content', []):
            if isinstance(c, dict) and c.get('text'):
                print(c['text'])
"
```

## Example

To ask the agent on port 8652 a question:

```bash
curl -s -X POST http://localhost:8652/v1/responses -H "Content-Type: application/json" -d '{"input": "What skills do you have?"}' | python3 -c "import json,sys;[print(c.get('text','')) for i in json.load(sys.stdin).get('output',[]) if isinstance(i,dict) and i.get('type')=='message' for c in i.get('content',[]) if isinstance(c,dict)]"
```

## Rules

- Always discover agents first (Step 1) before trying to message them
- Only message agents that show RUNNING status
- Each agent is independent — it has its own model, memory, and personality
- Messages are one-shot — the target agent won't remember previous messages unless you pass previous_response_id
- Keep messages concise — the target agent has its own context window
