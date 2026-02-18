<!-- Source: https://github.com/openclaw/openclaw README, https://deepwiki.com/moltbook/openclaw/10.2-ios-and-android-apps -->

# OpenClaw Nodes & Media

Guide to mobile/desktop companion nodes and media capabilities.

## Overview

Nodes are companion devices (macOS/iOS/Android/headless) that connect to the Gateway WebSocket (same port as operators) with `role: "node"` and expose a command surface via `node.invoke`. They extend OpenClaw with device-specific capabilities.

- **iOS Node**: iPhone/iPad app with camera, Canvas, Voice Wake, Talk Mode, location
- **Android Node**: Android app with camera, Canvas, Talk Mode, screen recording
- **macOS Node**: Native Mac menu bar app with voice overlay

All apps are optional; the Gateway alone provides a complete experience.

---

## Node Bridge Protocol

### Discovery

- iOS: Bonjour service discovery
- Android: mDNS discovery
- Service advertised as `_openclaw._tcp`
- TCP connection established to port 18790 (Gateway port + 1)

### Connection Flow

1. Node discovers Gateway via Bonjour/mDNS
2. Node connects to port 18790
3. Node sends capability manifest:

```json
{"type":"bridge.hello","nodeId":"iphone-xyz","capabilities":["camera","location","audio"]}
```

4. Gateway registers node and its capabilities
5. Gateway sends `node.invoke` requests as needed
6. Keep-alive heartbeats maintain connection

### Registry

The system maintains a registry of connected nodes and their advertised capabilities, tracking connection state through discovery, connection, and active phases.

---

## Camera

Device camera access via node.invoke:

| Command | Description | Platform |
|---------|-------------|----------|
| `camera.snap` | Take a photo (returns base64 JPEG) | iOS, Android |
| `camera.clip` | Record video clip | iOS, Android |
| `camera.stream` | Start live stream | iOS |

Parameters:
- `quality`: Image/video quality setting
- `duration`: Video recording duration (for clip)

```json
{
  "tools": {
    "camera": { "enabled": true, "quality": "high", "format": "jpeg" }
  }
}
```

---

## Images

Image processing and analysis:

| Command | Description |
|---------|-------------|
| `image.analyze` | Analyze image content (vision) |
| `image.resize` | Resize image |
| `image.ocr` | Extract text from image |

```json
{
  "tools": {
    "images": { "enabled": true, "maxSize": "10MB", "formats": ["jpeg", "png", "webp"] }
  }
}
```

---

## Audio

Voice message transcription and text-to-speech:

| Command | Description |
|---------|-------------|
| `audio.record` | Record audio |
| `audio.play` | Play audio |
| `audio.transcribe` | Speech-to-text (Whisper, 100+ languages) |
| `audio.synthesize` | Text-to-speech (ElevenLabs or Edge TTS) |

```json
{
  "tools": {
    "audio": { "enabled": true, "format": "mp3", "sampleRate": 44100, "maxDuration": 300 }
  }
}
```

Whisper handles background noise well and can distinguish homophones from context. Voice notes are supported via WhatsApp and Telegram.

---

## Location

GPS and geocoding services (iOS only for now; Android planned):

| Command | Description |
|---------|-------------|
| `location.get` | Get current GPS coordinates |
| `location.watch` | Track location changes |
| `location.geocode` | Address to coordinates |
| `location.reverse` | Coordinates to address |

```json
{
  "tools": {
    "location": { "enabled": true, "accuracy": "high", "timeout": 10000 }
  }
}
```

---

## Voice Wake

Always-on wake word detection for hands-free activation. Available on macOS and iOS (not Android).

```json
{
  "nodes": {
    "voiceWake": {
      "enabled": true,
      "wakeWord": "hey openclaw",
      "sensitivity": 0.5,
      "wakeWords": ["hey openclaw", "ok openclaw", "openclaw"]
    }
  }
}
```

When detected, activates Talk Mode for continuous conversation.

---

## Talk Mode

Continuous voice conversation mode with text-to-speech. Available on macOS, iOS, and Android (with ElevenLabs).

```json
{
  "nodes": {
    "talkMode": {
      "enabled": true,
      "voiceInput": true,
      "voiceOutput": true,
      "voice": "nova",
      "autoListen": true
    }
  }
}
```

```bash
openclaw talk
```

### Voice Options

`alloy` (neutral), `echo` (male), `fable` (female British), `onyx` (deep male), `nova` (female), `shimmer` (female expressive)

### TTS Control Commands

| Command | Effect |
|---------|--------|
| `/tts on` | Enable TTS for all responses |
| `/tts off` | Disable TTS |
| `/tts inbound` | TTS only for voice messages |
| `/tts tagged` | TTS for explicitly tagged content |

### Features

- Continuous conversation interface without manual triggers
- Text-to-speech integration (ElevenLabs or Edge TTS)
- Background operation during other app use
- Speech-to-text for hands-free input
- Works with AirPods/earbuds

### Configuration

```bash
# Set API key for text-to-speech
openclaw config set talk.apiKey "your-elevenlabs-key"
```

---

## Canvas Tools (A2UI)

Live Canvas interface with Agent-to-UI (A2UI) support for agent-driven visual workspaces. Available on iOS and Android.

Canvas content is sent from the Gateway to mobile nodes via `node.invoke` with HTML/JavaScript payload. The mobile app renders content in a WebView and executes A2UI scripts.

```json
{
  "nodes": {
    "canvas": { "enabled": true, "defaultColor": "#000000", "defaultStroke": 2 }
  }
}
```

### Commands

| Command | Description |
|---------|-------------|
| `canvas.draw` | Draw on canvas |
| `canvas.annotate` | Add annotations |
| `canvas.clear` | Clear canvas |
| `canvas.export` | Export canvas content |

Canvas files served on port 18793 (HTTP).

---

## Screen Recording

Capture device screen. Available on macOS and Android (not iOS).

macOS requires Screen Recording permission in System Preferences > Privacy & Security.

```json
{
  "nodes": {
    "screen": { "enabled": true, "format": "mp4", "quality": "high" }
  }
}
```

| Command | Description | Platform |
|---------|-------------|----------|
| `screen.record` | Record screen | macOS, Android |
| `screen.screenshot` | Take screenshot | macOS |

---

## Platform Feature Matrix

| Feature | iOS | Android | macOS |
|---------|-----|---------|-------|
| Camera (snap/clip) | Yes | Yes | -- |
| Canvas / A2UI | Yes | Yes | -- |
| Voice Wake | Yes | No | Yes |
| Talk Mode | Yes | Yes | Yes |
| Location | Yes | No (planned) | -- |
| Screen Recording | No | Yes | Yes |
| Notifications | Yes | Yes | Yes |
| Push-to-talk | Yes | Yes | Yes |

---

## Node Connection & Management

```bash
openclaw nodes list              # List connected nodes
openclaw nodes info <node-id>    # Get node details
```

```json
{
  "nodes": {
    "allowedNodes": ["iphone-xyz", "macbook-abc"],
    "requirePairing": true
  }
}
```

### Remote Gateway Support

Mobile nodes can connect over Tailscale or SSH tunnels, enabling agents running on cloud servers or remote machines to access mobile device capabilities.

```json
{
  "gateway": {
    "remote": {
      "enabled": true,
      "transport": "tailscale"
    }
  }
}
```

---

## Build & Development

### iOS

- Uses XcodeGen for project generation
- Bundle ID: `ai.openclaw.ios` (legacy: `bot.molt.*`)
- Minimum iOS: 15.0+
- Default build: `platform=iOS Simulator,name=iPhone 17`
- Permissions: Camera, microphone, location (requested on first use)

### Android

- Uses Gradle build system
- Package name: `ai.openclaw.android`
- Requires Android Studio or local Gradle
- USB debugging must be enabled
- Permissions: Camera, microphone, screen capture

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| App not discovering Gateway | Verify same network, check mDNS/Bonjour config |
| Connection timeout | Confirm Gateway port (18789) and Node Bridge (18790) |
| Camera permission denied | Grant permissions in iOS/Android settings |
| Canvas not rendering | Update mobile OS to latest version |
| Talk mode not working | Verify ElevenLabs API key is set |

---

## Upstream Sources

- https://github.com/openclaw/openclaw (README)
- https://deepwiki.com/moltbook/openclaw/10.2-ios-and-android-apps
- https://getopenclaw.ai/features/voice
- https://getopenclaw.ai/docs/configuration
