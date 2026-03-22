# Claude Code Mobile Bridge

## Project Structure

VS Code extension that bridges Claude Code sessions to a mobile PWA client via WebSocket.

### Architecture
- `src/bridge/` — Session discovery, JSONL parsing, terminal bridge
- `src/server/` — HTTP + WebSocket server with token auth
- `src/tunnel/` — Optional Cloudflare Tunnel for remote access
- `webview/` — PWA client (vanilla JS, no frameworks)

### Key Commands
- `npm run compile` — Build TypeScript
- `npm run watch` — Watch mode
- `npm run lint` — ESLint

### Development
1. Open this folder in VS Code
2. Press F5 to launch Extension Development Host
3. Run "Claude Mobile: Start Mobile Bridge" from command palette
4. Scan QR code with your phone

### Code Conventions
- TypeScript strict mode
- No `any` — use `unknown` + type guards
- Async I/O only (no sync fs calls)
- DOM-based rendering in webview (no innerHTML) for XSS safety
