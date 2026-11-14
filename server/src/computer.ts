import { db, now } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { cdpPortFor, dressScreen, resetScreen, undressScreen, type DeskBot } from './desk.js';
import { box, displayFor } from './box.js';
import type { ComputerState } from './types.js';

/**
 * The local computer: Xvfb displays inside this container, one screen per bot. The primary bot's
 * engine lives on the default display (:99, started by supervisord); every other bot gets a display
 * of its own (screen-100 -> :100 ...), dressed in its colour (see desk.ts). Nothing here creates,
 * suspends or deletes a display: they are brought up by the container.
 */

/** Screens on the computer, the default one included. */
export const MAX_SCREENS = 4;

export interface BotScreen { computerId: string; screenId: string; width?: number; height?: number }

/** There is only ever this one computer. */
const LOCAL_ID = 'local';

function rowFor(userId: string) {
  let r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId) as any;
  if (!r) {
    db.prepare("INSERT INTO computers(user_id,orgo_id,status,updated_at) VALUES (?, NULL, 'running', ?)").run(userId, now());
    r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId);
  }
  return r;
}

function setStatus(userId: string, status: ComputerState['status'], error: string | null = null) {
  rowFor(userId);
  db.prepare('UPDATE computers SET status=?, orgo_id=NULL, error=?, updated_at=? WHERE user_id=?').run(status, error, now(), userId);
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
}

export function computerState(userId: string): ComputerState {
  const r = rowFor(userId);
  const screens = (db.prepare('SELECT bot_id, screen_id, width, height FROM screens WHERE user_id=?').all(userId) as any[]).map((s) => ({
    botId: s.bot_id as string,
    screenId: s.screen_id as string,
    ...(s.width && s.height ? { width: s.width as number, height: s.height as number } : {}),
  }));
  return { status: r.status, error: r.error, screens, maxScreens: Math.min(env.maxBots, MAX_SCREENS) };
}

/** Is the X display for this screen answering? Returns its size when it is. */
async function probeDisplay(screenId: string): Promise<{ width: number; height: number } | null> {
  const r = await box.bash('xdpyinfo 2>&1', 15, screenId);
  if (r.exit_code !== 0) return null;
  const m = /dimensions:\s+(\d+)x(\d+) pixels/.exec(r.output);
  return { width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0 };
}

/** The computer is always on; this only records that for the UI. Returns the computer's id. */
export async function ensureComputer(userId: string): Promise<string> {
  const r = rowFor(userId);
  if (r.status !== 'running' || r.error) setStatus(userId, 'running');
  return LOCAL_ID;
}

function deskBot(botId: string): DeskBot | null {
  const b = db.prepare('SELECT id, name, label, avatar_shape, avatar_color FROM bots WHERE id=?').get(botId) as any;
  return b ? { id: b.id, name: b.name, label: b.label ?? '', avatarShape: b.avatar_shape, avatarColor: b.avatar_color } : null;
}

const isPrimaryEngine = (botId: string) => (db.prepare('SELECT engine FROM bots WHERE id=?').get(botId) as any)?.engine === 'primary';

/** The primary bot's own Chrome (when PRIMARY_CDP_URL names one) is never started or stopped by us. */
const managesChrome = (botId: string) => !(isPrimaryEngine(botId) && env.primaryCdpUrl);

const verified = new Map<string, number>();
const leasing = new Map<string, Promise<BotScreen>>();
const dressing = new Map<string, Promise<void>>();

function saveSize(botId: string, s: { width?: number; height?: number } | null | undefined) {
  if (s?.width && s?.height) db.prepare('UPDATE screens SET width=?, height=? WHERE bot_id=?').run(s.width, s.height, botId);
}

/** This bot's screen on the shared computer; leases one the first time. */
export function screenFor(userId: string, botId: string): Promise<BotScreen> {
  const running = leasing.get(botId);
  if (running) return running;
  const p = lease(userId, botId).finally(() => leasing.delete(botId));
  leasing.set(botId, p);
  return p;
}

async function lease(userId: string, botId: string): Promise<BotScreen> {
  const id = await ensureComputer(userId);
  const mine = db.prepare('SELECT screen_id, width, height FROM screens WHERE bot_id=?').get(botId) as any;
  if (mine) {
    const fresh = Date.now() - (verified.get(botId) ?? 0) < 120_000;
    if (fresh || mine.screen_id === 'default') {
      db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
      return { computerId: id, screenId: mine.screen_id, width: mine.width ?? undefined, height: mine.height ?? undefined };
    }
    const s = await probeDisplay(mine.screen_id);
    if (s) {
      verified.set(botId, Date.now());
      saveSize(botId, s);
      db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
      return { computerId: id, screenId: mine.screen_id, width: s.width || mine.width || undefined, height: s.height || mine.height || undefined };
    }
    // The display is gone (the container restarted): lease again below.
    db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
    dressing.delete(botId);
  }

  const taken = new Set((db.prepare('SELECT screen_id FROM screens').all() as any[]).map((r) => r.screen_id as string));
  let screenId = 'default';
  if (!isPrimaryEngine(botId)) {
    // Extra screens are :100, :101, ... (screen-100, screen-101, ...); the default one is the primary's.
    const free = Array.from({ length: MAX_SCREENS - 1 }, (_, i) => `screen-${100 + i}`).find((sid) => !taken.has(sid));
    if (!free) throw new Error(`Every screen on the computer is in use (${MAX_SCREENS} at most). Remove a bot to free one.`);
    screenId = free;
  }
  // Reserve the screen before the first await so a concurrent lease sees it as taken.
  db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at) VALUES (?,?,?,?)').run(botId, userId, screenId, now());
  let size: Awaited<ReturnType<typeof probeDisplay>>;
  try { size = await probeDisplay(screenId); } catch (e) { db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId); throw e; }
  if (!size) {
    db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
    const msg = `The desktop for ${screenId} (display ${displayFor(screenId)}) is not running. It is started with the container; check the supervisord logs.`;
    setStatus(userId, 'error', msg);
    throw new Error(msg);
  }
  if (rowFor(userId).status !== 'running') setStatus(userId, 'running');
  db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at,width,height) VALUES (?,?,?,?,?,?)').run(botId, userId, screenId, now(), size.width || null, size.height || null);
  verified.set(botId, Date.now());
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
  return { computerId: id, screenId, width: size.width || undefined, height: size.height || undefined };
}

/**
 * The bot's screen, dressed as its own computer (wallpaper, dock, its Chrome on its home screen).
 * Dressing happens once per server run per bot, and again when `redress` is set (rename, new colour).
 */
export async function readyScreen(userId: string, botId: string, opts: { redress?: boolean } = {}): Promise<BotScreen> {
  const s = await screenFor(userId, botId);
  if (opts.redress) dressing.delete(botId);
  let d = dressing.get(botId);
  if (!d) {
    const bot = deskBot(botId);
    d = bot
      ? dressScreen(bot, s.screenId, { manageChrome: managesChrome(botId) }).catch((e) => {
          console.warn(`[computer] could not dress ${s.screenId} for ${botId}: ${e?.message ?? e}`);
          dressing.delete(botId);
        })
      : Promise.resolve();
    dressing.set(botId, d);
  }
  await d;
  return s;
}

/** DevTools address of the Chrome on this bot's screen (for Hermes' browser tools). */
export function cdpUrlFor(botId: string, screenId: string): string {
  if (isPrimaryEngine(botId) && env.primaryCdpUrl) return env.primaryCdpUrl;
  return `http://127.0.0.1:${cdpPortFor(screenId)}`;
}

/**
 * Called before a bot starts working: its screen is leased and dressed, and the browser we run for it
 * answers. Without this a bot's first turn finds no browser and goes off to start one of its own.
 */
export async function screenForWork(userId: string, botId: string): Promise<void> {
  if (!managesChrome(botId)) {
    // It brings its own browser, so nothing it needs depends on the dressing: don't make it wait.
    void readyScreen(userId, botId).catch((e) => console.warn(`[computer] screen not ready for ${botId}: ${e?.message ?? e}`));
    return;
  }
  const s = await readyScreen(userId, botId);
  const alive = await fetch(`${cdpUrlFor(botId, s.screenId)}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (!alive) await readyScreen(userId, botId, { redress: true });
}

/** Close everything on the bot's screen and bring its browser back to the home screen. Logins stay. */
export async function resetBotScreen(userId: string, botId: string): Promise<void> {
  const s = await screenFor(userId, botId);
  const bot = deskBot(botId);
  if (bot) await resetScreen(bot, s.screenId, { manageChrome: managesChrome(botId) });
}

/** The bot is gone: stop what we ran on its screen and free the screen for the next bot. */
export async function releaseScreen(botId: string): Promise<void> {
  const mine = db.prepare('SELECT screen_id, user_id FROM screens WHERE bot_id=?').get(botId) as any;
  if (!mine) return;
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
  dressing.delete(botId);
  verified.delete(botId);
  if (mine.screen_id !== 'default') {
    try { await undressScreen(botId, mine.screen_id); } catch (e: any) { console.warn(`[computer] undress failed: ${e?.message ?? e}`); }
  }
  hub.emit(mine.user_id, { type: 'computer', state: computerState(mine.user_id) });
}

/** A deleted bot leaves nothing behind on the computer: its browser profile and its Library folder go. */
export async function forgetBotFiles(botId: string): Promise<void> {
  if (!/^bot_[\w-]+$/.test(botId)) return;
  await box.bash(`rm -rf -- /root/grokbot/profiles/${botId} /root/grokbot/files/${botId}`, 60);
}

/** The local computer is never suspended. */
export async function suspendComputer(_userId: string, _reason = 'manual'): Promise<void> {}

/** Refresh status and screen sizes (cheap; used when the UI opens). */
export async function refreshComputer(userId: string): Promise<ComputerState> {
  await ensureComputer(userId);
  for (const row of db.prepare('SELECT bot_id, screen_id FROM screens WHERE user_id=?').all(userId) as any[]) saveSize(row.bot_id, await probeDisplay(row.screen_id));
  return computerState(userId);
}
