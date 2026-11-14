import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { db } from './db.js';
import { userFromCookieHeader } from './lib/auth.js';
import net from 'node:net';
import { env } from './env.js';
import { displayFor } from './box.js';
import { readyScreen, screenFor } from './computer.js';
import { viewerClosed, viewerOpened } from './idle.js';

/**
 * VNC relay: browser <-> our server <-> x11vnc on 127.0.0.1:<5900+N> (security None, container-internal).
 * The browser's noVNC speaks RFB over the websocket; we bridge its binary frames to a raw TCP socket
 * and back, untouched. In "watch" mode, client input messages (KeyEvent, PointerEvent,
 * ClientCutText) are dropped server-side. Since x11vnc has no password, this relay is the only
 * door: the websocket upgrade needs a session and a same-origin Origin.
 */

/** VNC port of a screen's display: :99 -> 5900, :100 -> 5901, ... */
export const vncPortFor = (screenId?: string | null) => 5900 + (Number(displayFor(screenId).slice(1)) - 99);

/** Does this websocket upgrade come from our own page? A missing Origin (non-browser client) is refused too. */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  try { if (o.origin === new URL(env.appUrl).origin) return true; } catch { /* bad APP_URL */ }
  return !!host && o.host === host;
}

/**
 * Filters a client->server RFB stream, dropping input events. Returns bytes to forward.
 * The relay is a raw pass-through, so the stream starts with the client's half of the handshake,
 * which is forwarded untouched: ProtocolVersion (12 bytes), then for RFB 3.7+ the chosen security
 * type (1 byte; x11vnc here offers only None, so no auth bytes follow), then ClientInit (1 byte).
 */
export class WatchFilter {
  private pending = Buffer.alloc(0);
  private handshake = -1; // client handshake bytes still to pass through; -1 = version not read yet
  feed(chunk: Buffer): Buffer {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    if (this.handshake === -1) {
      if (this.pending.length < 12) return Buffer.alloc(0);
      const minor = Number(this.pending.subarray(8, 11).toString('latin1'));
      this.handshake = 12 + (minor >= 7 ? 1 : 0) + 1;
    }
    if (this.handshake > 0) {
      const n = Math.min(this.handshake, this.pending.length);
      out.push(Buffer.from(this.pending.subarray(0, n)));
      this.pending = this.pending.subarray(n);
      this.handshake -= n;
      if (this.handshake > 0) return Buffer.concat(out);
    }
    for (;;) {
      const b = this.pending;
      if (!b.length) break;
      const len = msgLength(b);
      if (len === -1) { this.pending = Buffer.alloc(0); break; } // unknown: fail closed
      if (len === 0 || b.length < len) break; // need more bytes
      const msg = b.subarray(0, len);
      const t = b[0];
      if (t !== 4 && t !== 5 && t !== 6) out.push(Buffer.from(msg));
      this.pending = b.subarray(len);
    }
    return Buffer.concat(out);
  }
}

/** Length of the client message at the head of `b`, 0 if more bytes are needed to know, -1 if unknown. */
function msgLength(b: Buffer): number {
  const t = b[0];
  switch (t) {
    case 0: return 20; // SetPixelFormat
    case 2: return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2); // SetEncodings
    case 3: return 10; // FramebufferUpdateRequest
    case 4: return 8; // KeyEvent
    case 5: return 6; // PointerEvent
    case 6: return b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4)); // ClientCutText (+extended)
    case 150: return 10; // EnableContinuousUpdates
    case 248: return b.length < 9 ? 0 : 9 + b[8]; // ClientFence
    case 251: return b.length < 8 ? 0 : 8 + 16 * b[6]; // SetDesktopSize
    default: return -1;
  }
}

export function attachVncRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    if (!m) return; // not ours
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = userFromCookieHeader(req.headers.cookie);
    const bot = user ? (db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) as any) : null;
    if (!user || !bot) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
    wss.handleUpgrade(req, socket, head, (client) => relay(client, user.id, bot.id, mode));
  });
}

/** Bridge a websocket client and a TCP upstream, byte for byte. Client input is filtered in watch mode. */
export function bridge(client: WebSocket, upstream: net.Socket, mode: 'watch' | 'control') {
  const filter = new WatchFilter();
  const closeAll = (code = 1000, reason = '') => {
    try { client.close(code, reason.slice(0, 120)); } catch { /* */ }
    upstream.destroy();
  };
  client.on('message', (data: Buffer) => {
    const fwd = mode === 'watch' ? filter.feed(Buffer.from(data)) : Buffer.from(data);
    if (fwd.length && !upstream.destroyed) upstream.write(fwd);
  });
  upstream.on('data', (d) => { if (client.readyState === WebSocket.OPEN) client.send(d); });
  upstream.on('close', () => closeAll(1000, 'upstream closed'));
  upstream.on('error', (e) => closeAll(1011, String(e)));
  client.on('close', () => upstream.destroy());
  client.on('error', () => upstream.destroy());
}

async function relay(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control') {
  // Both listeners go on before the first await: a viewer can close, or send a bad frame, during setup.
  let closed = false;
  client.on('close', () => { closed = true; viewerClosed(userId); });
  client.on('error', () => { closed = true; });
  viewerOpened(userId); // counts watchers for the UI (see idle.ts)
  try {
    const { screenId } = await screenFor(userId, botId);
    if (closed) return;
    // A screen nobody has used yet is bare; set it up while the person is already watching.
    readyScreen(userId, botId).catch(() => {});
    const upstream = net.connect({ host: '127.0.0.1', port: vncPortFor(screenId) });
    await new Promise<void>((res, rej) => { upstream.once('connect', () => res()); upstream.once('error', rej); });
    if (closed) { upstream.destroy(); return; }
    bridge(client, upstream, mode);
  } catch (e: any) {
    console.warn('[vnc] relay failed', e?.message ?? e);
    try { client.close(1011, String(e?.message ?? e).slice(0, 120)); } catch { /* */ }
  }
}
