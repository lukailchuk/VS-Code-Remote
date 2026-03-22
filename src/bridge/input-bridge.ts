import * as vscode from 'vscode';

/**
 * InputBridge v3 — Terminal-based with --resume.
 *
 * Creates a VS Code terminal running `claude --resume <session-id>`
 * to continue the exact same session as the panel. Uses terminal.sendText()
 * for reliable message delivery.
 */
export class InputBridge {
  private terminal: vscode.Terminal | null = null;
  private terminalReady = false;
  private sessionId: string | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    const closeListener = vscode.window.onDidCloseTerminal((t) => {
      if (t === this.terminal) {
        this.terminal = null;
        this.terminalReady = false;
      }
    });
    this.disposables.push(closeListener);
  }

  /**
   * Initialize the bridge with a session ID and start the terminal immediately.
   * Called once when the bridge starts — no lazy init, so Claude CLI has time to boot.
   */
  async init(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    await this.createTerminal();
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.terminal || !this.terminalReady) {
      if (this.sessionId) {
        await this.createTerminal();
      } else {
        throw new Error('InputBridge not initialized — call init(sessionId) first');
      }
    }

    if (!this.terminal) {
      throw new Error('Failed to create Claude Code terminal');
    }

    this.terminal.sendText(text);
  }

  private async createTerminal(): Promise<void> {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }

    this.terminal = vscode.window.createTerminal({
      name: 'Claude Mobile Bridge',
      hideFromUser: false,
      iconPath: new vscode.ThemeIcon('broadcast'),
    });

    // Show terminal but don't steal focus from current editor
    this.terminal.show(true);

    // Wait for shell to fully initialize
    await this.delay(2000);

    // Resume the specific session from the panel
    this.terminal.sendText(`claude --resume ${this.sessionId}`);

    // Wait for Claude CLI to start up
    await this.delay(4000);

    this.terminalReady = true;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  dispose(): void {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
    this.terminalReady = false;
    this.sessionId = null;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
