import * as vscode from 'vscode';
import * as os from 'os';
import * as QRCode from 'qrcode';
import { SessionFinder } from './bridge/session-finder';
import { JsonlWatcher } from './bridge/jsonl-watcher';
import { InputBridge } from './bridge/input-bridge';
import { CommandExecutor } from './bridge/command-executor';
import { MobileBridgeServer } from './server/http-server';
import { CloudflareTunnel } from './tunnel/cloudflare';
import { SessionInfo, ChatMessage } from './types';
import { WebSocket } from 'ws';

// ─── State ──────────────────────────────────────────────────────────────────

let statusBarItem: vscode.StatusBarItem;
let sessionFinder: SessionFinder | null = null;
let jsonlWatcher: JsonlWatcher | null = null;
let inputBridge: InputBridge | null = null;
let commandExecutor: CommandExecutor | null = null;
let server: MobileBridgeServer | null = null;
let tunnel: CloudflareTunnel | null = null;
let activeUrl: string | null = null;
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wire up message and error listeners on a JsonlWatcher,
 * forwarding to the server and output channel.
 */
function wireWatcher(watcher: JsonlWatcher): void {
  watcher.on('message', (message: ChatMessage) => {
    server?.broadcastMessage(message);
  });

  watcher.on('error', (err: Error) => {
    outputChannel.appendLine(`[Watcher Error] ${err.message}`);
  });
}

/**
 * Find the first non-internal IPv4 address on this machine.
 * Falls back to 127.0.0.1 if nothing else is found.
 */
function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Build a webview HTML page that displays a QR code image centered on screen.
 */
function buildQrWebviewHtml(dataUrl: string, url: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Claude Mobile QR</title>
  <style>
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
    h2 {
      margin-bottom: 16px;
      font-weight: 400;
    }
    img {
      max-width: 360px;
      width: 100%;
      image-rendering: pixelated;
      border-radius: 8px;
    }
    .url {
      margin-top: 20px;
      padding: 8px 16px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      word-break: break-all;
      max-width: 400px;
      text-align: center;
      user-select: all;
    }
    .hint {
      margin-top: 12px;
      font-size: 11px;
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <h2>Scan with your phone</h2>
  <img src="${dataUrl}" alt="QR Code" />
  <div class="url">${url}</div>
  <div class="hint">Open your camera app and point at the QR code</div>
</body>
</html>`;
}

// ─── Activation ─────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  outputChannel = vscode.window.createOutputChannel('Claude Mobile Bridge');

  // Status bar item — left side, priority 100
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.text = '$(broadcast) Mobile';
  statusBarItem.tooltip = 'Claude Code Mobile Bridge';
  statusBarItem.command = 'claude-mobile.start';
  statusBarItem.show();

  // Register commands
  const startCmd = vscode.commands.registerCommand(
    'claude-mobile.start',
    startBridge
  );
  const stopCmd = vscode.commands.registerCommand(
    'claude-mobile.stop',
    stopBridge
  );
  const showQrCmd = vscode.commands.registerCommand(
    'claude-mobile.showQR',
    showQRCode
  );

  context.subscriptions.push(statusBarItem, startCmd, stopCmd, showQrCmd, outputChannel);
}

// ─── Start Bridge ───────────────────────────────────────────────────────────

async function startBridge(): Promise<void> {
  // If already running, offer to restart
  if (server) {
    const choice = await vscode.window.showWarningMessage(
      'Mobile Bridge is already running.',
      'Restart',
      'Stop',
      'Show QR'
    );
    if (choice === 'Restart') {
      await stopBridge();
      // Fall through to start
    } else if (choice === 'Stop') {
      await stopBridge();
      return;
    } else if (choice === 'Show QR') {
      await showQRCode();
      return;
    } else {
      return;
    }
  }

  // 1. Check workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage(
      'Claude Mobile Bridge: Open a workspace first.'
    );
    return;
  }
  const workspacePath = workspaceFolders[0].uri.fsPath;

  // 2. Get config
  const config = vscode.workspace.getConfiguration('claudeMobile');
  const port = config.get<number>('port', 7777);
  const autoTunnel = config.get<boolean>('autoTunnel', false);

  outputChannel.appendLine(`[Bridge] Starting on port ${port}...`);
  outputChannel.appendLine(`[Bridge] Workspace: ${workspacePath}`);

  // 3. Find current Claude Code session
  sessionFinder = new SessionFinder();
  let session: SessionInfo | null;

  try {
    session = await sessionFinder.findCurrentSession(workspacePath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Claude Mobile Bridge: Failed to find session — ${String(err)}`
    );
    return;
  }

  if (!session) {
    vscode.window.showErrorMessage(
      'Claude Mobile Bridge: No active Claude Code session found. Start Claude Code in this workspace first.'
    );
    return;
  }

  outputChannel.appendLine(
    `[Bridge] Found session: ${session.sessionId} (${session.filePath})`
  );

  // 4. Create components
  jsonlWatcher = new JsonlWatcher(session.filePath);
  inputBridge = new InputBridge();
  commandExecutor = new CommandExecutor();

  // 4a. Start terminal with Claude CLI resuming this session
  try {
    await inputBridge.init(session.sessionId);
    outputChannel.appendLine(`[Bridge] Terminal started with --resume ${session.sessionId}`);
  } catch (err) {
    outputChannel.appendLine(`[Bridge] Terminal init warning: ${String(err)}`);
    // Non-fatal — terminal can be created lazily on first message
  }

  try {
    server = new MobileBridgeServer(port, extensionContext.extensionPath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Claude Mobile Bridge: Failed to create server — ${String(err)}`
    );
    disposeAll();
    return;
  }

  // 5. Wire events
  wireWatcher(jsonlWatcher);

  server.on('send-message', async (text: string) => {
    outputChannel.appendLine(`[Mobile → Claude] ${text.slice(0, 80)}...`);
    try {
      await inputBridge?.sendMessage(text);
      outputChannel.appendLine('[Mobile → Claude] Message sent successfully');
    } catch (err) {
      const errorMsg = String(err);
      outputChannel.appendLine(`[InputBridge Error] ${errorMsg}`);
      server?.broadcastMessage({
        type: 'status',
        content: `Error: ${errorMsg}`,
        timestamp: new Date().toISOString(),
      } as ChatMessage);
    }
  });

  server.on('accept', () => {
    outputChannel.appendLine('[Mobile] Accept changes');
    commandExecutor?.acceptChanges().catch((err) => {
      outputChannel.appendLine(`[CommandExecutor Error] ${String(err)}`);
    });
  });

  server.on('reject', () => {
    outputChannel.appendLine('[Mobile] Reject changes');
    commandExecutor?.rejectChanges().catch((err) => {
      outputChannel.appendLine(`[CommandExecutor Error] ${String(err)}`);
    });
  });

  server.on('request-history', (ws: WebSocket) => {
    const history = jsonlWatcher?.getHistory() ?? [];
    server?.sendHistory(ws, history);
  });

  // Watch for new sessions in this workspace
  sessionFinder.on('new-session', (newSession: SessionInfo) => {
    outputChannel.appendLine(
      `[Bridge] New session detected: ${newSession.sessionId}`
    );

    // Dispose old watcher, create a new one for the new session
    jsonlWatcher?.dispose();

    jsonlWatcher = new JsonlWatcher(newSession.filePath);
    wireWatcher(jsonlWatcher);

    jsonlWatcher.start().catch((err) => {
      outputChannel.appendLine(
        `[Bridge] Failed to start watcher for new session: ${String(err)}`
      );
    });
  });

  sessionFinder.watchForNewSessions(workspacePath);

  // 6. Start watcher and server
  try {
    await jsonlWatcher.start();
    outputChannel.appendLine('[Bridge] JSONL watcher started');
  } catch (err) {
    vscode.window.showErrorMessage(
      `Claude Mobile Bridge: Failed to start watcher — ${String(err)}`
    );
    disposeAll();
    return;
  }

  try {
    await server.start();
    outputChannel.appendLine(`[Bridge] HTTP server listening on port ${port}`);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Claude Mobile Bridge: Failed to start server on port ${port} — ${String(err)}`
    );
    disposeAll();
    return;
  }

  // 7. Build the access URL
  const token = server.getAuth().getToken();
  const localIp = getLocalIp();
  let accessUrl = `http://${localIp}:${port}/?token=${token}`;

  outputChannel.appendLine(`[Bridge] Local URL: ${accessUrl}`);

  // 8. Optionally start Cloudflare Tunnel
  if (autoTunnel) {
    outputChannel.appendLine('[Bridge] Starting Cloudflare Tunnel...');

    tunnel = new CloudflareTunnel();

    const tunnelAvailable = await tunnel.isAvailable();
    if (!tunnelAvailable) {
      const instructions = tunnel.getInstallInstructions();
      vscode.window.showWarningMessage(
        `Claude Mobile Bridge: ${instructions.split('\n')[0]}`
      );
      outputChannel.appendLine(`[Tunnel] ${instructions}`);
      // Continue without tunnel — local URL still works
    } else {
      tunnel.on('error', (err: Error) => {
        outputChannel.appendLine(`[Tunnel Error] ${err.message}`);
      });

      tunnel.on('close', (code: number | null) => {
        outputChannel.appendLine(
          `[Tunnel] Process exited with code ${code}`
        );
      });

      const tunnelUrl = await tunnel.start(port);
      if (tunnelUrl) {
        accessUrl = `${tunnelUrl}/?token=${token}`;
        outputChannel.appendLine(`[Bridge] Tunnel URL: ${accessUrl}`);
      } else {
        outputChannel.appendLine(
          '[Bridge] Tunnel failed — falling back to local URL'
        );
        vscode.window.showWarningMessage(
          'Claude Mobile Bridge: Cloudflare Tunnel failed to start. Using local network URL.'
        );
      }
    }
  }

  activeUrl = accessUrl;

  // 9. Update status bar
  statusBarItem.text = '$(broadcast) Mobile: Active';
  statusBarItem.color = new vscode.ThemeColor('testing.iconPassed');
  statusBarItem.tooltip = `Claude Mobile Bridge — ${activeUrl}`;
  statusBarItem.command = 'claude-mobile.showQR';

  // 10. Show notification
  const notification = await vscode.window.showInformationMessage(
    `Mobile Bridge Active — ${tunnel?.getTunnelUrl() ? 'via Tunnel' : 'Local Network'}`,
    'Copy URL',
    'Show QR'
  );

  if (notification === 'Copy URL') {
    await vscode.env.clipboard.writeText(activeUrl);
    vscode.window.showInformationMessage('URL copied to clipboard!');
  } else if (notification === 'Show QR') {
    await showQRCode();
  }
}

// ─── Stop Bridge ────────────────────────────────────────────────────────────

async function stopBridge(): Promise<void> {
  outputChannel.appendLine('[Bridge] Stopping...');

  disposeAll();

  // Reset status bar
  statusBarItem.text = '$(broadcast) Mobile';
  statusBarItem.color = undefined;
  statusBarItem.tooltip = 'Claude Code Mobile Bridge';
  statusBarItem.command = 'claude-mobile.start';

  activeUrl = null;

  vscode.window.showInformationMessage('Claude Mobile Bridge stopped.');
  outputChannel.appendLine('[Bridge] Stopped');
}

// ─── Show QR Code ───────────────────────────────────────────────────────────

async function showQRCode(): Promise<void> {
  if (!activeUrl) {
    vscode.window.showWarningMessage(
      'Claude Mobile Bridge is not running. Start it first.'
    );
    return;
  }

  try {
    const dataUrl = await QRCode.toDataURL(activeUrl, {
      width: 360,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });

    const panel = vscode.window.createWebviewPanel(
      'claudeMobileQR',
      'Claude Mobile — QR Code',
      vscode.ViewColumn.One,
      {
        enableScripts: false,
        retainContextWhenHidden: false,
      }
    );

    panel.webview.html = buildQrWebviewHtml(dataUrl, activeUrl);
  } catch (err) {
    outputChannel.appendLine(`[QR Error] ${String(err)}`);
    // Fallback: show URL in a notification so the user can still copy it
    const action = await vscode.window.showInformationMessage(
      `Mobile Bridge URL: ${activeUrl}`,
      'Copy URL'
    );
    if (action === 'Copy URL') {
      await vscode.env.clipboard.writeText(activeUrl);
    }
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

function disposeAll(): void {
  if (tunnel) {
    tunnel.dispose();
    tunnel = null;
  }
  if (server) {
    server.dispose();
    server = null;
  }
  if (jsonlWatcher) {
    jsonlWatcher.dispose();
    jsonlWatcher = null;
  }
  if (sessionFinder) {
    sessionFinder.dispose();
    sessionFinder = null;
  }
  if (inputBridge) {
    inputBridge.dispose();
    inputBridge = null;
  }
  commandExecutor = null;
}

// ─── Deactivation ───────────────────────────────────────────────────────────

export function deactivate(): void {
  disposeAll();
}
