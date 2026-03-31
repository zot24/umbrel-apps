# Hermes Umbrel App — Development Guide

## Design System: Retro Terminal / Phosphor CRT

The UI follows a **retro-futuristic CRT terminal aesthetic** — think sci-fi control room from an 80s movie, green phosphor monitors, classified government systems.

### Colors
- `--phosphor: #50ffa8` — primary green (success, active, healthy)
- `--phosphor-dim: #28b870` — muted green (borders, secondary)
- `--amber: #ffc04d` — warning, active operations, mysterious/classified
- `--amber-dim: #b8862e` — muted amber
- `--red: #ff6060` — errors, danger, destructive
- `--bg: #060a0d` — near-black background
- `--surface: #0b1016` — card/panel background
- `--text: #d4e0d8` — primary text
- `--text-muted: #7a8e82` — secondary text

### Typography
- **Display**: `Oxanium` — headers, titles, panel labels
- **Body/Mono**: `Fira Code` — everything else (inputs, buttons, data, code)
- All caps + letter-spacing for labels and indicators

### Components
- **Panels**: Sharp rectangular borders (NO border-radius), `panel-header` with title + indicator badge
- **Buttons**: Monospace, uppercase, `>` prefix, sharp edges
- **Status dots**: Sharp squares, not circles (except toggles)
- **Progress bars**: Thin 6px track with glowing leading edge
- **Modals**: Dark backdrop, sharp box with top gradient line, shake on error
- **Errors**: Full-screen red flash + screen shake + pulsing ⚠ icon
- **Warnings**: Amber overlay with scanline animation during critical ops
- **Corner icons**: 32x32 sharp buttons at bottom-right (backup floppy, help ?, dashboard radar)

### Visual Effects
- **Layered backgrounds**: Circuit grid, glowing nodes, ambient glow orbs, film grain, scanlines, vignette
- **Animations**: Blink for active states, shake for errors, morph/dissolve for transitions
- **Dashboard toggle**: Radar icon (slow spin) → morphs to control panel icon with blur/scale/rotate
- **No emojis** — use ASCII/text labels or SVG icons

### UX Principles
- No false success messages — verify user actually completed the action
- Critical operations (import, delete) need dramatic feedback (shaking, amber overlay, progress bars)
- Progress bars must be visible long enough to notice (min 2.5-3s even if instant)
- Errors close the happy path and show red shaking overlay with error block
- Modals close by clicking outside, not with close buttons
- Copy must work over HTTP (use execCommand fallback for Umbrel)
- The dashboard lives at `/dashboard` — separate page behind the "Classified" radar icon

### Architecture
- `setup` container: Node.js server serving wizard.html + dashboard.html + REST API
- `web` container: Hermes agent gateway (Python), multiple profiles as background processes
- Communication: setup → web via Docker socket exec, profiles via OpenAI-compatible API on unique ports

## File Structure
```
zot24-hermes/
├── setup/
│   ├── Dockerfile          # Alpine + Node 20
│   ├── server.js           # API server (setup, status, profiles, insights, backup)
│   ├── wizard.html         # First-run setup wizard
│   └── dashboard.html      # Status page + dashboard (profiles, metrics, sessions, agents)
├── web/
│   ├── Dockerfile          # Python + hermes-agent
│   ├── entrypoint.sh       # Init, permissions, auto-start profile gateways
│   └── skills/             # Bundled skills (ask-agent for inter-profile comms)
├── hermes-export.sh        # Migration script (curl | bash)
├── docker-compose.yml      # Umbrel production compose
├── docker-compose.local.yml # Local dev compose
└── umbrel-app.yml          # Umbrel manifest
```
