---
name: ask-agent
description: Send a message to another Hermes profile agent and get a response. Use when you need to delegate work to a specialized agent, ask for a second opinion, or coordinate tasks across profiles.
trigger: ask agent, message agent, delegate to, send to coder, send to research, ask coder, ask research, talk to agent, inter-agent, cross-profile
---

# Ask Agent — Inter-Profile Communication

Send messages to other Hermes profile agents running on this Umbrel node. Each profile is an isolated agent with its own model, memory, skills, and personality.

## How it works

Each profile runs its own gateway with an OpenAI-compatible API on a unique port. The default profile uses port 8642, and each additional profile increments by 10 (8652, 8662, etc.).

## Usage

### Discover available profiles

First, check which profiles exist and their ports:

```bash
cat ~/.hermes/profiles/*/gateway_state.json 2>/dev/null | python3 -c "
import json, sys, os
profiles_dir = os.path.join(os.getenv('HERMES_HOME', os.path.expanduser('~/.hermes')).rsplit('/profiles/', 1)[0], 'profiles')
if os.path.isdir(profiles_dir):
    for name in sorted(os.listdir(profiles_dir)):
        state_file = os.path.join(profiles_dir, name, 'gateway_state.json')
        env_file = os.path.join(profiles_dir, name, '.env')
        port = '8642'
        if os.path.isfile(env_file):
            for line in open(env_file):
                if line.startswith('API_SERVER_PORT='): port = line.split('=',1)[1].strip()
        state = 'stopped'
        if os.path.isfile(state_file):
            try: state = json.load(open(state_file)).get('gateway_state', 'stopped')
            except: pass
        print(f'{name}: port={port} state={state}')
else:
    print('No profiles found')
"
```

Also check the default profile:
```bash
curl -s http://localhost:8642/health 2>/dev/null && echo "default: port=8642 state=running" || echo "default: port=8642 state=stopped"
```

### Send a message to another agent

```bash
curl -s -X POST http://localhost:PORT/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"input": "YOUR MESSAGE HERE"}' | python3 -c "
import json, sys
data = json.load(sys.stdin)
if 'output' in data:
    for item in (data['output'] if isinstance(data['output'], list) else [data['output']]):
        if isinstance(item, dict) and 'content' in item:
            for c in item['content']:
                if isinstance(c, dict) and 'text' in c:
                    print(c['text'])
        elif isinstance(item, str):
            print(item)
"
```

Replace `PORT` with the target agent's API port.

### Examples

**Ask the coder agent to review code:**
```bash
curl -s -X POST http://localhost:8652/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"input": "Review this function for security issues: def login(user, pw): return db.query(f\"SELECT * FROM users WHERE name={user} AND pass={pw}\")"}' | python3 -c "import json,sys; d=json.load(sys.stdin); [print(c.get('text','')) for i in (d.get('output',[]) if isinstance(d.get('output'),list) else [d.get('output','')]) for c in (i.get('content',[]) if isinstance(i,dict) else []) if isinstance(c,dict)]"
```

**Ask the research agent to find information:**
```bash
curl -s -X POST http://localhost:8662/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"input": "Find the latest papers on transformer architecture improvements from 2026"}' | python3 -c "import json,sys; d=json.load(sys.stdin); [print(c.get('text','')) for i in (d.get('output',[]) if isinstance(d.get('output'),list) else [d.get('output','')]) for c in (i.get('content',[]) if isinstance(i,dict) else []) if isinstance(c,dict)]"
```

## Port mapping

| Profile | API Port | Webhook Port |
|---------|----------|-------------|
| default | 8642 | 8644 |
| 1st profile | 8652 | 8654 |
| 2nd profile | 8662 | 8664 |
| Nth profile | 8642 + N*10 | 8644 + N*10 |

## Tips

- Always check if the target agent is running before sending (use the health endpoint)
- Keep messages concise — the target agent has its own context window
- For long tasks, check back later rather than waiting (the API call blocks until the agent responds)
- The target agent uses its own model, API keys, and personality — results may differ from yours
- Messages are logged to `~/.hermes/agent-comms.json` on the Umbrel dashboard for visibility
