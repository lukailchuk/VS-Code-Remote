import * as crypto from 'crypto';

export class AuthManager {
  private token: string;

  constructor() {
    this.token = crypto.randomUUID();
  }

  getToken(): string {
    return this.token;
  }

  validateToken(token: string | null): boolean {
    if (token === null) {
      return false;
    }
    // Constant-time comparison to prevent timing attacks
    const tokenBuffer = Buffer.from(this.token);
    const inputBuffer = Buffer.from(token);
    if (tokenBuffer.length !== inputBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(tokenBuffer, inputBuffer);
  }

  extractTokenFromUrl(url: string): string | null {
    try {
      const params = new URL(url, 'http://localhost').searchParams;
      return params.get('token');
    } catch {
      return null;
    }
  }
}
