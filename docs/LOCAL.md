# Running bot-hq fully locally (spec)

Status: SPEC ONLY. Nothing here is implemented. Every change below is a proposal against the current tree.

## 1. Goal and scope

Run the whole stack on one Linux machine (CachyOS, Hyprland/Wayland host, Docker available) with no dependency on Orgo, Composio or xAI. Bots run on Hermes using Codex (`openai-codex`) and Claude OAuth subscriptions. No API keys.

Bots get a shell, so the entire stack (server, Hermes, desktops, Chrome) runs INSIDE one Docker container, never on the host. The host publishes one port: `127.0.0.1:8787`.

In scope: a Dockerfile, a compose file, a local computer backend, and gating of Composio/xAI/Orgo features. Out of scope: rewriting stale docs (see section 7), per-bot isolation, non-Linux hosts.

"No Orgo" means a LOCAL desktop behind the same `/computer` and `/api/bots/:id/screen` API. The ComputerViewer, Library tab and Engine settings sign-in stay. Only cloud wording and wake/sleep go.

Legend: **Verified** = read in this repo, with `file:line`. **UNVERIFIED** = not provable from this repo; needs a test or a decision.

| Claim | Status |
|---|---|
| `XAI_API_KEY` and `COMPOSIO_API_KEY` are mandatory via `req()`; `ORGO_API_KEY` via `secret()` | Verified `server/src/env.ts:27,29,30` |
| `composio.ts` and `voice.ts` build clients at import | Verified `server/src/composio.ts:7`, `server/src/voice.ts:360` |
| Box commands already run locally when `HQ_LOCAL=1` | Verified `server/src/env.ts:56`, `server/src/box.ts:42` |
| Owner sign-in link works without `DEV_LOGIN` | Verified `server/src/routes.ts:116`, `server/src/lib/auth.ts:52`, `scripts/sign-in-link.sh` |
| Server binds all interfaces today | Verified `server/src/index.ts:46` (no `hostname`) |
| Health route is `/api/health`, not `/health` | Verified `server/src/index.ts:31` |
| Session cookie is `secure` only for an https `APP_URL` | Verified `server/src/lib/auth.ts:17` |
| Screens cap at 4 regardless of `MAX_BOTS` | Verified `server/src/computer.ts:17,48` |
| How Hermes is installed (package, version) | Resolved in Phase 1: NousResearch/hermes-agent v0.22.2 at commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`, installed by the project's own `scripts/install.sh` pinned to that commit (`Dockerfile`). It provisions its own uv, Python 3.14 and a hash-verified venv. Built and `hermes` 0.22.2 answers `/health` in the container. |
| Whether `hermes auth add openai-codex` / `anthropic --type oauth` use a localhost callback or device code | Resolved by reading the pinned Hermes source in the image: Codex uses a device-code flow (`agent/credential_pool.py`, `_codex_device_code_login` in `hermes_cli/auth.py`); Anthropic redirects to Anthropic's hosted callback (`https://console.anthropic.com/oauth/code/callback`, `agent/anthropic_credentials.py`) and the code is pasted back. Neither needs a localhost callback port. The flows themselves were not run (they need a real account). |
| Box scripts work as non-root | Not pursued: the container runs as root. As root, `hq-screen.py base`, `base-check` and `terminal` were run by hand on `:99` in the container and succeeded (policy files, extension CRX, terminal window). Runtime `apt-get` is disabled by `HQ_NO_APT=1`. |
| `hqlib` tolerates a missing dbus session | Verified in `server/box/hqlib.py` (`session_bus` falls back to `private_bus`; `screen_env` only sets the address `if bus`). The container also runs a system bus and `dbus-launch` for XFCE. |
| Web UI line refs in section 3 | From a repo search, spot-checked per file; re-check when implementing |

## 2. Architecture

One container, `hq`. PID 1 is supervisord (or s6; supervisord assumed below).

| Process | Count | Listens (container) | Published to host |
|---|---|---|---|
| Xvfb | `:99` (primary bot, screen `default`), `:100`.. per extra bot, up to `MAX_BOTS` | X unix sockets | no |
| XFCE session + WM (`xfwm4`, `xfce4-panel`, `xfdesktop`, `xfsettingsd`) | one per display | none | no |
| x11vnc, security None | one per display | `127.0.0.1:5900+N` | no |
| hq-home (`server/box/hq-home.py`) | 1 | `127.0.0.1:7391` | no |
| Chrome (managed by `hqlib.py`) | one per bot | CDP `127.0.0.1:9200+N` (primary 9299) | no |
| Node server (`server/src/index.ts`) | 1 | `8787` (bind `0.0.0.0` inside, see below) | `127.0.0.1:8787:8787` |
| Hermes primary gateway | 1 | `127.0.0.1:8642` | no |
| Managed engines (`hermes gateway run --no-supervise`) | one per extra bot | `127.0.0.1:8650+` | no |

Why these exist (Verified): box scripts assume a running XFCE session per display plus `wmctrl`/`xdotool` (`server/box/hqlib.py`, `hq-screen.py`), and no code starts a window manager. `do_dress` fails if the X display is not running. Primary bot maps to screen `default` -> `:99`, others to `screen-100` -> `:100` (`displayFor` in `server/src/box.ts`; CDP port in `server/src/desk.ts:36`). Managed engines run on `ENGINE_PORT_BASE` (default 8650) with host `127.0.0.1` (`server/src/engine.ts:189-206,300-308`). Chrome launches with `--no-sandbox --disable-dev-shm-usage --remote-debugging-port=9200+N --user-data-dir=/root/grokbot/profiles/<bot>` (`server/box/hqlib.py` ~870-890), which suits a container.

Display bring-up: Phase 1 pre-starts `:99` only. Phase 2 adds an on-demand allocator in `computer.ts` for `:100+`.

### Volumes

| Mount | Path in container | Holds | Required |
|---|---|---|---|
| `hq-data` | `/data` (`DB_PATH=/data/hq.db`) | SQLite DB | yes |
| `hermes-primary` | `/root/.hermes` (`HERMES_HOME_PRIMARY`) | primary `auth.json`, `config.yaml`, `.env` | yes |
| `hq-engines` | `/data/engines` (`ENGINES_DIR`) | per-bot Hermes homes, each with its own `auth.json` | yes |
| `hq-grokbot` | `/root/grokbot` | Chrome profiles (`profiles/`), bot Library files (`files/`) | yes |
| `hq-logs` | `/var/log/hq` | box script and supervisord logs | optional |
| (none) | `/opt/hq` | box scripts, Chrome extension; baked into the image | baked |

Why `auth.json` persistence depends on the Hermes-home volumes: Codex/Claude OAuth tokens are written by `hermes auth add` into `HERMES_HOME/auth.json` (`server/src/routes-config.ts:137-159`). The primary's lives in the primary home; each managed bot gets its own home under `ENGINES_DIR`, and `writeHome` copies the primary's `auth.json` and `config.yaml` once, only if the bot has none (`server/src/engine.ts:189-193`). Without volumes on both locations, every container recreate forces a fresh OAuth sign-in for every bot. `ENGINES_DIR` must stay outside `~/.hermes` so each bot is a separate tenant (`server/src/env.ts:42`).

## 3. Per-file change list

### Server

| File | Change |
|---|---|
| `server/src/env.ts:27,29,30` | `xaiKey`, `composioKey`, `orgoKey` become optional (`opt()`). `localBox` is always true in the container (set `HQ_LOCAL=1` in compose; later remove the flag). Add `features = {composio, voice, xai, orgo}` derived from key presence (`orgo` false locally). Add `HOST` (default `127.0.0.1`; compose sets `0.0.0.0`). Add configurable `LIB_ROOT` (default `/root/grokbot/files`). `SESSION_SECRET` supports `SESSION_SECRET_FILE`, mirroring `secret()`. |
| `server/src/index.ts:18,24` | Run `desSelfTest()` only when Orgo is configured (DES is used only for Orgo VNC auth). |
| `server/src/index.ts:46` | Pass explicit `hostname: env.host` to `serve()`. |
| `server/src/index.ts:51` | `initTriggers` becomes a no-op when `features.composio` is false. |
| `server/src/orgo.ts` | Delete (after `computer.ts`, `box.ts`, `vnc.ts`, `routes*.ts` stop importing it). |
| `server/src/box.ts:5,47-49` | Drop the Orgo branch; local only. |
| `server/src/computer.ts:4,22-29,65-105,152-174,216,259-269` | Replace Orgo ensure/resume/start/listScreens/createScreen with a local display allocator: verify or start Xvfb + desktop + x11vnc for `:99` and `:100+`. `ensureComputer`/`suspendComputer` become no-ops. Keep `readyScreen`, dressing, `cdpUrlFor`, and `MAX_SCREENS`. Fix `screenForWork` so no Orgo id is needed. Drop `orgoId` from `ComputerState` (`server/src/types.ts:178-180`). |
| `server/src/vnc.ts:6,159-164` | Replace the Orgo `wss://` upstream and `orgo.vncPassword` with a raw TCP connection to `127.0.0.1:5900+N` (x11vnc, security None). Keep the `WatchFilter` and mode handling (`vnc.ts:126,135`). Add an `Origin` check on the websocket upgrade (reject unless it matches `APP_URL`/`Host`); there is none today. |
| `server/src/routes.ts:65-67` | `GET /auth/me` returns `{user, devLogin, features}`. |
| `server/src/routes.ts:388-395` | Screenshot: run `scrot` or ImageMagick `import -display :N -window root png:-` through `box.bash`, return PNG. |
| `server/src/routes.ts:99` | Keep the `DEV_LOGIN` gate; refuse to enable it with an empty `ALLOWED_EMAILS`, and check `Origin`/`Host` against `APP_URL` (section 5). Do NOT use a loopback-source check: it is backwards in a container. |
| `server/src/routes.ts:15,409,438,466` | Guard `startGoogleLogin`, `/apps/*` (`connectedToolkits`, `catalog`), and `/voice` mount behind `features`; answer 503 `{error:'disabled'}` when off. Google sign-in follows `composio`. |
| `server/src/routes-config.ts:13,199-202,253-254` | Remove the Orgo `exportFile` branch (non-local only) and the `orgo` import; use `env.libRoot` instead of the `LIB_ROOT` constant at line 201. |
| `server/src/composio.ts:7` | Lazy client via `getComposio()`; throws `FeatureDisabled` when no key. `connectedToolkits`, `catalog`, `toolkitInfo` return empty when disabled. |
| `server/src/triggers.ts:2,35,65` | Use the lazy client; no-ops when disabled; `createEventRoutine` throws a clear error. |
| `server/src/voice.ts:360` | Lazy `getXai()`; every route returns 503 when `features.voice` is false. |
| `server/src/engine.ts:107` | Drop `XAI_API_KEY` from `SHARED_ENV` so no xAI key reaches bot homes. Keep provider list as is (`:441-476`). |
| `server/src/mcp.ts:4,47-48,114-115` | `listTools` skips Composio tools and filters `x_search`, `request_app_connection`, `list_event_triggers`, `create_event_routine` when disabled; `tools/call` rejects them too. |
| `server/src/agent/tools.ts:50,107,141,149,314` | Tool definitions stay; a `enabledTools()` filter hides disabled ones. `activityFor` special-case for `x_search` (`:394,403`) can stay. |
| `server/src/agent/prompt.ts:27,38,40,58` | Remove the "Connected apps" line (38), the `x_search` line (40), the `connectedToolkits` call (27) and context line (58) when disabled. Edits must be byte-stable: with features ON, output is identical to today; add a snapshot test comparing prompts before and after. |
| `server/src/agent/loop.ts:6,159,438-444` | Guard the `COMPOSIO_` branch and `toolkitInfo` import with `features.composio`. |
| `server/src/desk.ts:128-132` | Box scripts are baked into the image at `/opt/hq`; skip the runtime "install desktop scripts" step. |
| `server/src/db.ts:135` | Leave `composio_sessions` (harmless). |

### Box scripts (`server/box/`)

| File | Change |
|---|---|
| `hqlib.py` | Read `HQ_ROOT`, `HQ_LOGS`, `HQ_PROFILES`, `HQ_FILES` from env (defaults `/opt/hq`, `/var/log/hq`, `/root/grokbot/profiles`, `/root/grokbot/files`). `HQ_NO_APT=1` disables runtime apt; dbus handling needed no change. |
| `hq-screen.py` | Same env-driven paths. In `do_base` (`hq-screen.py:327`), remove or no-op `install_packages()`, which runs `apt-get` at runtime; the Dockerfile owns packages. |
| `hq-shell.py` | Same env-driven paths. |
| `hq-home.py` | Same paths; stays on `127.0.0.1:7391`. |

### Scripts, docs, tests

| File | Change |
|---|---|
| `scripts/install-on-computer.sh` | Superseded by the Dockerfile (Orgo-only: requires `ORGO_COMPUTER_ID`). Keep until Orgo is removed. |
| `scripts/sign-in-link.sh` | Works as is when run in the container: set `ENV_FILE` to a file containing `SESSION_SECRET` and `PORT`, or add `SESSION_SECRET_FILE` support. |
| `scripts/add-hq-to-hermes.py` | Run once at image build or entrypoint to add `mcp_servers.hq` to the primary `config.yaml` (needs PyYAML). |
| `.env.example` | Add `HQ_LOCAL=1`, `HOST`, `LIB_ROOT`; set `DEV_LOGIN=0`; mark Composio/xAI/Orgo keys optional. |
| `README.md` | Link to `docs/LOCAL.md`. |

### Web (`web/src`)

Plumbing: add `Features` to `server/src/types.ts` (imported as `@shared/types`); `lib/api.ts:28` and `store.ts:11,53,72-73` store it from `/auth/me`; `App.tsx:28` loads it.

| File:line | Change |
|---|---|
| `components/Sidebar.tsx:138,147-149` | Hide the connect-apps menu item and footer icon unless `features.composio`. |
| `components/Composer.tsx:95` | Hide the "+" apps item unless `composio`. |
| `components/Composer.tsx:114-127,137-146` | Hide dictation mic unless `voice`; always render the send arrow when `!voice` (idle CTA starts a call). |
| `components/config/AppSettings.tsx:19,51,225-256`; `configStore.ts:9,48` | Drop the `apps` section and `configApi.connectedApps` fetch unless `composio`. |
| `components/config/AppSettings.tsx:17,49,104-183` | ComputerSection: change "one cloud computer" (`:130`), hide sleep-after-idle (`:138`) and Sleep/Wake buttons (`:141-145`); keep screens list and Reset. |
| `components/DetailsPanel.tsx:60-63,123-137` | Hide Add to Slack/Suggested unless `composio`. |
| `components/DetailsPanel.tsx:10,144-147` | Hide VoiceSettings (it fetches `/api/voice/options` on mount) unless `voice`. |
| `components/ChatView.tsx:11,36` | Mount `VoiceCallBar` only if `voice`. |
| `components/cards/Cards.tsx:37,105-148` | Hide ConnectCard unless `composio`; pass no logo URL for approvals (`:37` fetches from `logos.composio.dev`, an external call). |
| `components/modals/ConnectAppsModal.tsx`, `ToolkitLogo.tsx`; `App.tsx:31-37,65` | Do not mount modal or popup listener unless `composio`. |
| `components/modals/CreateBotModal.tsx:82` | Reword "with your apps". |
| `components/SignIn.tsx:31-41,43` | Google button only if `composio`; dev form only if `devLogin`; otherwise show "Ask the owner for a sign-in link (`scripts/sign-in-link.sh`)". Drop or soften the xAI footer. |
| `lib/computer.ts:3-13`; `ComputerViewer.tsx:65-77,201-243`; `LibraryTab.tsx:65-73`; `configApi.ts:60-62` | Remove asleep/wake wording and `wake`/`sleep` calls; local computer is always on. `ComputerViewer.tsx:99-101` needs no change (it already targets `/api/bots/:id/screen`). |
| `dev/fixtures.ts:35` | Update the connect-card fixture. |

`features.xai` is server-only: nothing in `web/src` depends solely on xAI.

## 4. Phased plan

### Phase 1: one bot on Codex with a visible screen

Smallest slice; one display `:99`, no multi-bot.

1. `env.ts`: optional keys, `features`, `HOST`, `SESSION_SECRET_FILE`; `index.ts`: explicit hostname, skip DES; `composio.ts`/`voice.ts` lazy; `engine.ts` drop `XAI_API_KEY`; `mcp.ts`/`tools.ts`/`prompt.ts`/`loop.ts`/`triggers.ts` gating; `routes.ts` guards and `features` on `/auth/me`.
2. `box.ts` local only; `vnc.ts` local x11vnc upstream plus Origin check; `computer.ts` minimal local path (assume `:99` already running, no allocator yet); screenshot via scrot/import; remove `exportFile` branch.
3. Box scripts: env-driven paths, no runtime apt.
4. Dockerfile + compose + supervisord config (section 6). Fill in the Hermes install placeholder.
5. Web: `features` plumbing; hide Composio/voice/wake-sleep; SignIn fallback text.

Acceptance:

```
docker compose build && docker compose up -d
docker compose ps                      # hq healthy
curl -fsS http://127.0.0.1:8787/api/health        # {"ok":true,"engine":"hermes"}
docker compose exec hq bash /opt/hq/app/scripts/sign-in-link.sh you@example.com   # prints one-time URL
```

Then in the browser: open the link and confirm signed in; confirm no Composio/voice/xAI UI shows. Create the primary bot. Engine settings -> Sign in to Codex: a terminal opens on the bot's screen, and the flow completes in the VNC viewer. Send a message and get a reply. The screen viewer shows the desktop with Chrome. `GET /api/bots/<id>/screenshot` returns 200 with a PNG. `docker compose logs hq` shows no Orgo/Composio/xAI errors and no `XAI_API_KEY` in bot homes (check by name only: `rg -l XAI_API_KEY /root/.hermes /data/engines` returns nothing). Do not open `auth.json`; verify sign-in by the reply working.

### Phase 2: persistence, multi-bot, export

1. Display allocator for `:100+` in `computer.ts` (Xvfb + desktop + x11vnc started on demand, or pre-started to `MAX_BOTS`).
2. Managed engines on 8650+ per extra bot; confirm `writeHome` copy on first start.
3. Watch/control modes through the VNC relay.
4. Library export through the local filesystem path.
5. Optionally run `server/scripts/desk-test.ts` as a desk check (it dresses extra screens and exercises dress/undress/terminal; currently needs `ORGO_COMPUTER_ID`, so adapt it to the local backend first).

Acceptance: create 2-3 bots, each shows its own screen and Chrome (CDP 9200+N reachable only inside the container: `docker compose exec hq curl -s 127.0.0.1:9201/json/version`). Each completes a message round trip. A Library file download returns 200. `docker compose restart hq`, then reload: still signed in, bots still answer without re-running engine sign-in. Repeat with `docker compose down && up`.

### Phase 3: Claude OAuth, hardening, UI polish

1. Engine settings -> Anthropic sign-in (`hermes auth add anthropic --type oauth`) completes on a bot screen.
2. `DEV_LOGIN` hardening: `ALLOWED_EMAILS` required, Origin/Host check (section 5).
3. Remaining web hiding and wording from section 3.
4. Prompt snapshot test (byte-stable with features on).

Acceptance: a Claude-backed bot replies; the server refuses to start (or `/api/auth/dev` returns 403) with `DEV_LOGIN=1` and empty `ALLOWED_EMAILS`, and `/api/auth/dev` with a foreign `Origin` returns 403; a websocket upgrade with a foreign `Origin` is refused; `/api/voice/*` and `/api/apps/*` return 503.

### Phase 4: optional

Tailnet exposure (publish on the tailnet IP and set an https `APP_URL`), a local-profile `tests/e2e.mjs`. Today `tests/e2e.mjs` targets real Orgo, `/usr/bin/google-chrome`, Gmail and xAI voice, so it is NOT a valid local acceptance test until it has a local profile that skips Gmail/voice steps. Likewise `tests/voice-call.mjs` is voice-only and not applicable.

## 5. Security model

Be explicit: this is one container with one root user. There is no isolation between bots.

What bots can reach:

| Resource | Reachable by a bot |
|---|---|
| Container root shell | yes (bots have shell as root) |
| All container processes, including every other bot's Chrome (CDP 9200+N) and its logged-in sessions | yes |
| Every Hermes home and `auth.json` (primary and all managed bots) | yes |
| Node server on `127.0.0.1:8787`, Hermes gateways, x11vnc ports | yes (loopback inside the container) |
| Outbound internet | yes (optional egress allowlist is a later hardening) |
| Host filesystem, host home, `docker.sock`, host network | no, by construction (not mounted) |

Container exposure: only `127.0.0.1:8787:8787` on the host. Everything else (VNC 5900+, CDP 9200+, Hermes 8642/8650+, hq-home 7391) is container-internal. x11vnc runs with no password because it is only reachable on container loopback, which makes the server's VNC relay the only door; hence the Origin check and session auth on it. If exposing over a tailnet, bind the tailnet IP instead of loopback and set an https `APP_URL`.

Auth:

- Default sign-in is the owner link: `POST /api/auth/owner` with bearer = HMAC-SHA256(`SESSION_SECRET`, `owner-login`) returns a one-time 15-minute link redeemed at `/api/auth/link/:token` (`server/src/routes.ts:116`, `server/src/lib/auth.ts:49-52`). It works with `DEV_LOGIN` off, checks `ALLOWED_EMAILS` or an existing account, and must be run through `docker compose exec` because it posts to `127.0.0.1:$PORT`.
- `DEV_LOGIN` is a fallback only. `.env.example` currently sets it to `1`; the local default must be `0`. A loopback-source check does not work here, because the browser's requests arrive through Docker's port forward (a bridge address, not loopback) while the bots call the server from container loopback. Such a check would lock the user out and let bots in. When on: require non-empty `ALLOWED_EMAILS` and check `Origin`/`Host` against `APP_URL`. Even then, any bot can call `/api/auth/dev` with an allowed email and get a session. That is another reason to keep it off.
- Session cookie is httpOnly, SameSite Lax, and `secure` only when `APP_URL` starts with `https:` (`server/src/lib/auth.ts:17`). A plain `http://localhost` setup therefore has a non-secure cookie; acceptable for loopback, not for a tailnet over http.
- MCP: each bot's bearer is HMAC(`SESSION_SECRET`, `mcp:<botId>`) (`server/src/engine.ts:59`), so any bot with shell can read its own, and any process that can read `SESSION_SECRET` can mint every bot's. Keep `SESSION_SECRET` out of the bot-readable environment where possible (see below; this is limited since bots are root).
- `SESSION_SECRET` is supplied through a file or docker secret and checked only by the server starting and `sign-in-link.sh` working. Never print or read it. Honest caveat: a bot with root in the container can read a secret mounted in the container.
- Secrets in the image or compose env: none. OAuth tokens live only in the Hermes-home volumes.

## 6. Dockerfile and docker-compose sketches

Sketches; package names are for Debian bookworm / Ubuntu 24.04 and need a build to confirm.

```dockerfile
# syntax=docker/dockerfile:1
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive HOME=/root LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor ca-certificates curl gnupg git openssl python3 python3-pip python3-yaml \
    xvfb x11vnc x11-utils x11-xserver-utils xdotool wmctrl scrot imagemagick \
    xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf xfce4-terminal xterm \
    dbus dbus-x11 python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common fonts-inter \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (README requires >= 22)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# Browser. Chromium is the simple default; box scripts also find google-chrome-stable.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/*

# Hermes Agent: installed with its own scripts/install.sh pinned to a commit (see the real Dockerfile).
# The venv lives under HERMES_HOME, which a volume hides, so the image keeps a seed copy at
# /opt/hermes-seed that the entrypoint copies into the volume. No auth is baked into the image.

WORKDIR /opt/hq/app
COPY package.json package-lock.json ./
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN npm ci && npm run build        # confirm script names against package.json
COPY server/box /opt/hq              # box scripts baked at /opt/hq
COPY docker/supervisord.conf /etc/supervisor/conf.d/hq.conf
COPY docker/entrypoint.sh /entrypoint.sh

EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord","-n","-c","/etc/supervisor/supervisord.conf"]
```

Supervisord programs (priority order): `dbus` (system/session bus), `xvfb99` (`Xvfb :99 -screen 0 1440x900x24`), `desktop99` (`DISPLAY=:99 dbus-launch xfce4-session`), `x11vnc99` (`x11vnc -display :99 -rfbport 5900 -localhost -nopw -forever -shared`), `hq-home` (`python3 /opt/hq/hq-home.py`), `hermes` (primary gateway on 127.0.0.1:8642, `hermes gateway run --no-supervise`), `server` (`node /opt/hq/app/server/dist/index.js`, env `HQ_LOCAL=1 HOST=0.0.0.0 PORT=8787`). Phase 2 adds per-display `xvfb/desktop/x11vnc` programs for `:100..` (or the allocator starts them). Server starts after Hermes is healthy.

```yaml
# docker-compose.yml
services:
  hq:
    build: .
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    shm_size: "2gb"               # Chrome with --disable-dev-shm-usage still benefits
    environment:
      HQ_LOCAL: "1"
      HOST: "0.0.0.0"
      PORT: "8787"
      APP_URL: "http://localhost:8787"
      SERVER_URL: "http://localhost:8787"
      DEV_LOGIN: "0"
      ALLOWED_EMAILS: "you@example.com"
      DB_PATH: "/data/hq.db"
      HERMES_HOME_PRIMARY: "/root/.hermes"
      ENGINES_DIR: "/data/engines"
      MAX_BOTS: "2"
      SESSION_SECRET_FILE: "/run/secrets/session_secret"
    secrets: [session_secret]
    volumes:
      - hq-data:/data
      - hermes-primary:/root/.hermes
      - hq-engines:/data/engines
      - hq-grokbot:/root/grokbot
      - hq-logs:/var/log/hq
      # Bind mounts (avoid; if ever needed, SELinux requires a suffix):
      #   ./something:/path:Z      private, read-write
      #   ./something:/path:ro,z   shared or read-only
    healthcheck:
      test: ["CMD","curl","-fsS","http://127.0.0.1:8787/api/health"]
      interval: 15s
      retries: 5
    # No docker.sock, no host home mounts, no privileged, no host network.
secrets:
  session_secret:
    file: ./secrets/session_secret   # created by you; never printed or committed
volumes: {hq-data: {}, hermes-primary: {}, hq-engines: {}, hq-grokbot: {}, hq-logs: {}}
```

Without Swarm, compose file secrets are bind mounts, and `secrets:` has no `:z` option. The target host has no SELinux, so no relabel is needed there; the file was read by container root at `/run/secrets/session_secret` (the entrypoint used it to derive the MCP bearer). On an SELinux-enforcing host the file would still need relabelling. `SESSION_SECRET_FILE` is read by the entrypoint and `scripts/sign-in-link.sh`; whether the server itself honours it depends on the server slice.

## 7. Risks and open questions for Marc

1. **Hermes install method and version.** Resolved: pinned `install.sh` at commit `d923a5e` (v0.22.2). `hermes gateway run --no-supervise` runs under supervisord and its API server answers `/health`. `hermes auth add` was not exercised (needs a real account).
2. **OAuth callback vs device code.** Resolved from source: Codex is device-code, Anthropic uses a hosted callback with a pasted code. No localhost callback port is involved.
3. **Chrome vs Chromium.** Box scripts find both and set Chrome policy under `/etc/opt/chrome/policies/managed` (and `/etc/chromium/...` if present) plus a CRX packed with openssl. Chromium from Debian is simpler; Google Chrome needs its apt repo and is amd64 only. Pick one and test the extension policy.
4. **XFCE weight.** The scripts need `xfce4-panel`/`xfdesktop`/`xfsettingsd`/`xfconf-query` (panel hiding needs xfconf). A lighter shell (openbox + xsetroot) would degrade some dressing. Accept XFCE per display (roughly a few hundred MB RAM each) or invest in a lighter path?
5. **Root vs non-root.** Scripts assume `HOME=/root`, `/opt/hq`, `/var/log/hq`, `/root/grokbot`, and runtime `apt-get`. Root in the container is simplest and bots get root anyway; non-root would need path rework. Default: root.
6. **Bots are not isolated from each other.** One container, one uid: any bot can drive another's Chrome over CDP, read its profile, and read all `auth.json`. If that is unacceptable, the only real fix is one container per bot (large redesign).
7. **MAX_BOTS vs RAM.** Each bot costs Xvfb + XFCE + x11vnc + Chrome + a Hermes gateway. Screens hard-cap at 4 (`server/src/computer.ts:17`) regardless of `MAX_BOTS`. Suggest `MAX_BOTS=2` to start; measure.
8. **dbus session.** XFCE and xfconf need a session bus per display; `hqlib` tolerates one missing (falls back to a private bus). The desktop program runs `dbus-launch`.
9. **`/dev/shm` and GPU.** Chrome gets `--disable-dev-shm-usage`, but `shm_size` is set anyway. No GPU; software rendering only.
10. **Health path.** The route is `/api/health`; the `/health` the task hinted at does not exist (`server/src/index.ts:31`). Sketches use `/api/health`. The Hermes gateway has its own `/health` (`server/src/engine.ts:216`).
11. **Stale docs to update later (not in this change).** `README.md:7-8,103-131,181-190` (Orgo install, Composio/xAI claims), `docs/ARCHITECTURE.md` (Orgo/Composio surfaces; `/root/grokbot` paths around 71-79), `docs/orgo-builder-guide.md`, `docs/xai-and-composio.md`. Add a pointer to this file from README.
12. **Unread inputs.** `tests/e2e.mjs` and `tests/voice-call.mjs` were characterized, not fully traced; `server/box/*.py` were read for assumptions, not exhaustively.
