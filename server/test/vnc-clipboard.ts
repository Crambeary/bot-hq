import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { WatchFilter, bridge } from '../src/vnc.js';

// Client->server stream: RFB 3.8 handshake (version, security type, ClientInit), then a KeyEvent,
// a ClientCutText carrying the pasted sign-in code, and a FramebufferUpdateRequest.
const handshake = Buffer.concat([Buffer.from('RFB 003.008\n', 'latin1'), Buffer.from([1]), Buffer.from([1])]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const text = Buffer.from('abc-123', 'latin1');
const cut = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, text.length]), text]);
const update = Buffer.from([3, 1, 0, 0, 0, 0, 0, 10, 0, 10]);
const stream = Buffer.concat([handshake, key, cut, update]);

function run(mode: 'watch' | 'control'): Buffer {
  const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, send() {}, close() {} });
  const sent: Buffer[] = [];
  const upstream = Object.assign(new EventEmitter(), { destroyed: false, write: (b: Buffer) => { sent.push(b); return true; }, destroy() {} });
  bridge(client as unknown as WebSocket, upstream as any, mode);
  // Split mid-message to prove the filter reassembles.
  client.emit('message', stream.subarray(0, 30));
  client.emit('message', stream.subarray(30));
  return Buffer.concat(sent);
}

assert.ok(run('control').equals(stream), 'control mode forwards ClientCutText (and everything else) untouched');
assert.ok(run('watch').equals(Buffer.concat([handshake, update])), 'watch mode drops KeyEvent and ClientCutText, keeps the rest');
assert.ok(new WatchFilter().feed(handshake).equals(handshake));
console.log('vnc clipboard ok');
