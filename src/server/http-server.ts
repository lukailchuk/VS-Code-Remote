import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { AuthManager } from './auth';
import { ChatMessage, WsIncomingMessage, WsOutgoingMessage } from '../types';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export class MobileBridgeServer extends EventEmitter {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private auth: AuthManager;
  private port: number;
  private extensionPath: string;
  private clients: Set<WebSocket> = new Set();

  constructor(port: number = 7777, extensionPath: string) {
    super();
    this.port = port;
    this.extensionPath = extensionPath;
    this.auth = new AuthManager();

    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer.removeListener('error', onError);
        reject(err);
      };

      this.httpServer.on('error', onError);

      this.httpServer.listen(this.port, '0.0.0.0', () => {
        this.httpServer.removeListener('error', onError);
        resolve();
      });
    });
  }

  broadcastMessage(message: ChatMessage): void {
    const outgoing: WsOutgoingMessage = {
      type: 'chat_message',
      data: message,
    };
    const payload = JSON.stringify(outgoing);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  sendHistory(ws: WebSocket, history: ChatMessage[]): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const outgoing: WsOutgoingMessage = {
      type: 'history',
      data: history,
    };
    ws.send(JSON.stringify(outgoing));
  }

  getAuth(): AuthManager {
    return this.auth;
  }

  getPort(): number {
    return this.port;
  }

  dispose(): void {
    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    this.wss.close();
    this.httpServer.close();
    this.removeAllListeners();
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';

    // CORS headers on every response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Parse pathname (strip query string)
    let pathname: string;
    try {
      pathname = new URL(url, 'http://localhost').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }

    // Public files that don't require auth (static assets, PWA manifest, SW, icons)
    const publicPaths = new Set(['/manifest.json', '/sw.js', '/styles.css', '/app.js']);
    const isPublic = publicPaths.has(pathname) || pathname.startsWith('/icons/');

    // Validate token for non-public files
    if (!isPublic) {
      const token = this.auth.extractTokenFromUrl(url);
      if (!this.auth.validateToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Serve index.html for root
    if (pathname === '/') {
      pathname = '/index.html';
    }

    // Resolve file path within webview directory
    const webviewRoot = path.join(this.extensionPath, 'webview');
    const filePath = path.resolve(path.join(webviewRoot, pathname));

    // Directory traversal protection
    if (!filePath.startsWith(webviewRoot)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    // Determine MIME type
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    // Read and serve the file
    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    });
  }

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = req.url ?? '';
    const token = this.auth.extractTokenFromUrl(url);

    if (!this.auth.validateToken(token)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    this.clients.add(ws);

    // Send connection status to the newly connected client
    const statusMessage: WsOutgoingMessage = {
      type: 'connection_status',
      data: { status: 'connected' },
    };
    ws.send(JSON.stringify(statusMessage));

    ws.on('message', (raw) => {
      let message: WsIncomingMessage;
      try {
        message = JSON.parse(raw.toString()) as WsIncomingMessage;
      } catch {
        // Ignore malformed messages
        return;
      }

      switch (message.type) {
        case 'send_message':
          if (message.text && message.text.trim().length > 0) {
            this.emit('send-message', message.text);
          }
          break;
        case 'accept':
          this.emit('accept');
          break;
        case 'reject':
          this.emit('reject');
          break;
        case 'request_history':
          this.emit('request-history', ws);
          break;
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }
}
