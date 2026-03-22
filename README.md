# Claude Code Mobile Bridge

A VS Code extension that lets you monitor and control [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions from your phone. It serves a lightweight PWA over your local network (or via Cloudflare Tunnel) and connects to active Claude Code sessions through WebSocket.

## Features

- **Live session streaming** — watch Claude Code's output in real-time on your phone
- **Send messages** — type prompts from your mobile device
- **Accept / Reject** — approve or reject proposed code changes remotely
- **QR code connect** — scan a QR code in VS Code to open the mobile UI instantly
- **PWA support** — add to home screen for a native app-like experience
- **Cloudflare Tunnel** — optional tunneling for access outside your local network
- **Auto session detection** — automatically picks up the latest Claude Code session in your workspace

## Quick Start

1. Install the extension in VS Code
2. Open a workspace where Claude Code is running
3. Run **Claude Mobile: Start Mobile Bridge** from the Command Palette (`Cmd+Shift+M`)
4. Scan the QR code with your phone

## Installation

### From Source

```bash
git clone https://github.com/your-username/claude-code-mobile-bridge.git
cd claude-code-mobile-bridge
npm install
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Package as VSIX

```bash
npx @vscode/vsce package
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeMobile.port` | `7777` | Port for the mobile bridge server |
| `claudeMobile.autoTunnel` | `false` | Auto-start Cloudflare Tunnel on bridge start |

## Architecture

```
Phone (PWA)  <--WebSocket-->  VS Code Extension  <--JSONL Watch-->  Claude Code Session
                                    |
                              Terminal Bridge (--resume)
```

- **Bridge** (`src/bridge/`) — discovers Claude Code sessions, watches JSONL files, manages terminal input
- **Server** (`src/server/`) — HTTP server for the PWA + WebSocket for real-time messaging
- **Tunnel** (`src/tunnel/`) — optional Cloudflare Tunnel integration
- **Webview** (`webview/`) — mobile-first PWA client (vanilla JS, dark theme)

## Security

- Token-based authentication (generated per session via `crypto.randomUUID()`)
- Constant-time token comparison to prevent timing attacks
- Directory traversal protection on static file serving
- DOM-based rendering (no `innerHTML`) to prevent XSS
- URL sanitization for rendered links

## Requirements

- VS Code 1.85+
- Node.js (bundled with VS Code)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) running in the same workspace
- (Optional) `cloudflared` for tunnel support

## License

MIT
