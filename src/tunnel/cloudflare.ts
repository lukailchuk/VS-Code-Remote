import { execFile, ChildProcess, spawn } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execFileAsync = promisify(execFile);

/** Regex to extract the quick tunnel URL from cloudflared stderr output */
const TUNNEL_URL_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

/** How long to wait for the tunnel URL before giving up */
const TUNNEL_STARTUP_TIMEOUT_MS = 30_000;

export class CloudflareTunnel extends EventEmitter {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;

  /**
   * Check if `cloudflared` binary is available on the system.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['cloudflared']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get install instructions for cloudflared.
   */
  getInstallInstructions(): string {
    return [
      'cloudflared is not installed. Install it with one of:',
      '',
      '  macOS:   brew install cloudflared',
      '  Linux:   sudo apt install cloudflared',
      '  Manual:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
      '',
      'After installing, restart VS Code and try again.',
    ].join('\n');
  }

  /**
   * Start a quick Cloudflare Tunnel pointing at localhost:<port>.
   * Returns the public tunnel URL, or null if it fails to start.
   *
   * Emits 'url' event with the tunnel URL when ready.
   * Emits 'error' event on failures.
   * Emits 'close' event when the process exits.
   */
  async start(port: number): Promise<string | null> {
    if (this.process) {
      return this.tunnelUrl;
    }

    return new Promise<string | null>((resolve) => {
      let resolved = false;
      let stderrBuffer = '';

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const err = new Error(
            `Cloudflare Tunnel did not provide a URL within ${TUNNEL_STARTUP_TIMEOUT_MS / 1000}s`
          );
          this.emit('error', err);
          this.killProcess();
          resolve(null);
        }
      }, TUNNEL_STARTUP_TIMEOUT_MS);

      try {
        this.process = spawn('cloudflared', [
          'tunnel',
          '--url',
          `http://localhost:${port}`,
        ], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (spawnErr) {
        clearTimeout(timeout);
        resolved = true;
        this.emit('error', spawnErr);
        resolve(null);
        return;
      }

      // cloudflared outputs the tunnel URL to stderr
      this.process.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stderrBuffer += text;

        if (!resolved) {
          const match = stderrBuffer.match(TUNNEL_URL_REGEX);
          if (match) {
            clearTimeout(timeout);
            resolved = true;
            this.tunnelUrl = match[0];
            this.emit('url', this.tunnelUrl);
            resolve(this.tunnelUrl);
          }
        }
      });

      // Also consume stdout to prevent pipe backpressure
      this.process.stdout?.on('data', () => {
        // intentionally ignored — cloudflared uses stderr for info
      });

      this.process.on('error', (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          this.emit('error', err);
          resolve(null);
        } else {
          this.emit('error', err);
        }
        this.process = null;
        this.tunnelUrl = null;
      });

      this.process.on('close', (code, signal) => {
        clearTimeout(timeout);
        this.process = null;
        this.tunnelUrl = null;

        if (!resolved) {
          resolved = true;
          const err = new Error(
            `cloudflared exited unexpectedly (code=${code}, signal=${signal})`
          );
          this.emit('error', err);
          resolve(null);
        }

        this.emit('close', code, signal);
      });
    });
  }

  /**
   * Get the current tunnel URL, or null if not running.
   */
  getTunnelUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * Kill the cloudflared process and clean up.
   */
  dispose(): void {
    this.killProcess();
    this.removeAllListeners();
  }

  private killProcess(): void {
    if (this.process) {
      // Try SIGTERM first, then SIGKILL after a short delay
      const proc = this.process;
      this.process = null;
      this.tunnelUrl = null;

      try {
        proc.kill('SIGTERM');
      } catch {
        // Process might already be dead — that's fine
      }

      // Force kill if it doesn't exit gracefully within 3 seconds
      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already dead — don't care
        }
      }, 3000);

      proc.once('close', () => {
        clearTimeout(forceKillTimer);
      });
    }
  }
}
