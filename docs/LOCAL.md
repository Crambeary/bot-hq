# Running bot-hq fully locally (spec)

Status: Phases 1 and 2 are implemented and merged (`Dockerfile`, `docker-compose.yml`, `docker/`). Phase 2 was verified on a real container except the per-bot message round trip, which needs a provider sign-in on each bot. Phase 3 is partly built: the code for items 2 and 3 and most of 4 is in the tree, and what is left is listed per sub-item in section 4. Phase 4 is still a proposal. Section 3 is now a status list of what was changed, with current `file:line` references.

## 1. Goal and scope

Run the whole stack on one Linux machine (CachyOS, Hyprland/Wayland host, Docker available) with no dependency on Orgo, Composio or xAI. Bots run on Hermes using Codex (`openai-codex`) and Claude OAuth subscriptions. No API keys.

Bots get a shell, so the entire stack (server, Hermes, desktops, Chrome) runs INSIDE one Docker container, never on the host. The host publishes one port: `127.0.0.1:8787`.

In scope: a Dockerfile, a compose file, a local computer backend, and gating of Composio/xAI/Orgo features. Out of scope: rewriting stale docs (see section 7), per-bot isolation, non-Linux hosts.

"No Orgo" means a LOCAL desktop behind the same `/computer` and `/api/bots/:id/screen` API. The ComputerViewer, Library tab and Engine settings sign-in stay. Only cloud wording and wake/sleep go.

Legend: **Verified** = read in this repo, with `file:line`. **UNVERIFIED** = not provable from this repo; needs a test or a decision.

| Claim | Status |
|---|---|
| `XAI_API_KEY` and `COMPOSIO_API_KEY` were mandatory; `ORGO_API_KEY` via `secret()` | Resolved in Phase 1: all three are optional now (`server/src/env.ts:29,31,32`), and `features` derives from them (`env.ts:74`) |
| `composio.ts` and `voice.ts` built clients at import | Resolved in Phase 1: both are lazy (`server/src/composio.ts:13`, `server/src/voice.ts:366`) |
| Box commands already run locally when `HQ_LOCAL=1` | Verified `server/src/env.ts:58` (`localBox`); `box.ts` is local-only now |
| Owner sign-in link works without `DEV_LOGIN` | Verified `server/src/routes.ts:131`, `server/src/lib/auth.ts:51-52`, `scripts/sign-in-link.sh` (reads `SESSION_SECRET` or `SESSION_SECRET_FILE`) |
| Server binds all interfaces by default | Resolved in Phase 1: `serve()` gets `hostname: env.host` (`server/src/index.ts:46`, `env.ts:25`, default `127.0.0.1`; compose sets `0.0.0.0`) |
| Health route is `/api/health`, not `/health` | Verified `server/src/index.ts:31` |
| Session cookie is `secure` only for an https `APP_URL` | Verified `server/src/lib/auth.ts:17` |
| Screens cap at 4 regardless of `MAX_BOTS` | Verified `MAX_SCREENS`/`screenLimit` in `server/src/computer.ts:21,24`; `docker/entrypoint.sh` generates the same `min(MAX_BOTS, 4)` displays. Bot creation is refused past `screenLimit()` (`server/src/routes.ts:41`); run with `MAX_BOTS=3`, a 4th bot got 409 "The team is full". |
| A managed Hermes home can run from a fresh folder | Resolved in Phase 2: no. Hermes keeps its dependency venv in `<HERMES_HOME>/installs` with absolute paths baked in. A fresh home fails ("no dependency environment is committed for this install") and a copied `installs` fails ("dependency environment is missing or outside this install"). A symlink to the primary's `installs` works, so `writeHome` makes one (`shareInstalls`, `server/src/engine.ts:151`). |
| Managed gateways reuse the image's Hermes toolchain | Resolved in Phase 2: only if `HERMES_RUNTIME_DIR` reaches them. The gateway env is an allow-list; without that variable each gateway downloaded its own Python/Node/ffmpeg (~1.2 GB) into `<home>/tools`. `hermesInstallEnv` (`server/src/box.ts:33`) now passes `HERMES_INSTALL_DIR`/`HERMES_RUNTIME_DIR` to managed gateways and to desktop commands (the on-screen sign-in terminal). Checked: no `tools` folder in any managed home after a restart, and the gateways' environment has `HERMES_RUNTIME_DIR=/opt/hermes-runtime`. |
| A gateway picks up `hermes config set model.provider` without a restart | Verified in Phase 2 on a managed bot: before, a turn answered "not connected to any AI provider"; after `config set model.provider anthropic` (no restart) the next turn answered "No Anthropic credentials found". So the sign-in route needs no restart step. |
| How Hermes is installed (package, version) | Resolved in Phase 1: NousResearch/hermes-agent v0.22.2 at commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`, installed by the project's own `scripts/install.sh` pinned to that commit (`Dockerfile`). It provisions its own uv, Python 3.14 and a hash-verified venv. Built and `hermes` 0.22.2 answers `/health` in the container. |
| Whether `hermes auth add openai-codex` / `anthropic --type oauth` use a localhost callback or device code | Resolved by reading the pinned Hermes source in the image: Codex uses a device-code flow (`agent/credential_pool.py`, `_codex_device_code_login` in `hermes_cli/auth.py`); Anthropic redirects to Anthropic's hosted callback (`https://console.anthropic.com/oauth/code/callback`, `agent/anthropic_credentials.py`) and the code is pasted back. Neither needs a localhost callback port. Claude OAuth was run for real in Phase 1: `hermes auth add` stores the credential but does not select it, and with `model.provider` unset Hermes 0.22 answers every turn with `no_provider_configured`; the gateway also ignores a per-turn `provider`. The sign-in route therefore runs `hermes config set model.provider <provider>` after `auth add` (`server/src/routes-config.ts:141-165`). The screen viewer has no clipboard bridge (`web/src/components/ComputerViewer.tsx` creates `new RFB(...)` at line 102 and never sets clipboard handlers), so a code cannot be pasted into the on-screen terminal yet (Phase 3 item 1); meanwhile run the same two commands the route runs (`routes-config.ts:150-157`) via `docker compose exec` in a host terminal. A managed bot's home is `$ENGINES_DIR/<botId>` (`/data/engines/<botId>` in compose), so set `HERMES_HOME` or the credential lands in the primary's home: `docker compose exec -e HERMES_HOME=/data/engines/<botId> hq hermes auth add <provider>` (anthropic needs `--type oauth`), then `docker compose exec -e HERMES_HOME=/data/engines/<botId> hq hermes config set model.provider <provider>`. For the primary bot omit the `-e` (its home is `/root/.hermes`). Without the `config set`, the bot still cannot reply. The first `hermes` CLI call after seeding finishes installing its Python dependencies once. |
| Box scripts work as non-root | Resolved: not pursued, the container runs as root (see section 7, item 5). As root, `hq-screen.py base`, `base-check` and `terminal` were run by hand on `:99` in the container and succeeded (policy files, extension CRX, terminal window). Runtime `apt-get` is disabled by `HQ_NO_APT=1`. |
| `hqlib` tolerates a missing dbus session | Resolved: verified in `server/box/hqlib.py` (`session_bus` falls back to `private_bus`; `screen_env` only sets the address `if bus`), no change needed. The container also runs a system bus and `dbus-launch` for XFCE. |
| Web UI line refs in section 3 | Replaced in this revision: the web changes are built, and section 3 now lists what each file does today |

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

Why these exist (Verified): box scripts assume a running XFCE session per display plus `wmctrl`/`xdotool` (`server/box/hqlib.py`, `hq-screen.py`), and no code starts a window manager. `do_dress` fails if the X display is not running. Primary bot maps to screen `default` -> `:99`, others to `screen-100` -> `:100` (`displayFor` in `server/src/box.ts`; CDP port in `server/src/desk.ts:36`). Managed engines run on `ENGINE_PORT_BASE` (default 8650) with host `127.0.0.1` (`freePort` and `startGateway` in `server/src/engine.ts`). Chrome launches with `--no-sandbox --disable-dev-shm-usage --remote-debugging-port=9200+N --user-data-dir=/root/grokbot/profiles/<bot>` (`server/box/hqlib.py` ~870-890), which suits a container.

Display bring-up (Phase 2, implemented): each screen is three supervisord programs (`xvfbN`, `desktopN`, `x11vncN`) running `docker/hq-display.sh xvfb|desktop|vnc N`. `docker/entrypoint.sh` writes them to `/etc/supervisor/conf.d/hq-displays.conf` at container start, one set per screen for `min(MAX_BOTS, 4)` screens (`:99` .. `:102` at most). Only `:99` has `autostart=true`. The allocator in `server/src/computer.ts` (`startDisplay`) runs `supervisorctl start` for a bot's display the first time the bot needs its screen, or again after a container restart, and waits until `xdpyinfo` and the VNC port both answer. A bot keeps its screen id across restarts (same display, same CDP port). Deleting a bot stops its display (`releaseScreen` -> `supervisorctl stop`). VNC port is `5900 + N - 99` (`vncPortFor` in `server/src/vnc.ts`).

### Volumes

| Mount | Path in container | Holds | Required |
|---|---|---|---|
| `hq-data` | `/data` (`DB_PATH=/data/hq.db`) | SQLite DB | yes |
| `hermes-primary` | `/root/.hermes` (`HERMES_HOME_PRIMARY`) | primary `auth.json`, `config.yaml`, `.env` | yes |
| `hq-engines` | `/data/engines` (`ENGINES_DIR`) | per-bot Hermes homes, each with its own `auth.json` | yes |
| `hq-grokbot` | `/root/grokbot` | Chrome profiles (`profiles/`), bot Library files (`files/`) | yes |
| `hq-logs` | `/var/log/hq` | box script and supervisord logs | optional |
| (none) | `/opt/hq` | box scripts, Chrome extension; baked into the image | baked |

Why `auth.json` persistence depends on the Hermes-home volumes: Codex/Claude OAuth tokens are written by `hermes auth add` into `HERMES_HOME/auth.json` (`server/src/routes-config.ts:141-165`). The primary's lives in the primary home; each managed bot gets its own home under `ENGINES_DIR`, and `writeHome` copies the primary's `auth.json` once, only if the bot has none, and the shared `config.yaml` keys (`SHARED_CONFIG`: model and providers) (`writeHome`, `server/src/engine.ts:165-212`; the `auth.json` copy is at `:209-212`). Without volumes on both locations, every container recreate forces a fresh OAuth sign-in for every bot. `ENGINES_DIR` must stay outside `~/.hermes` so each bot is a separate tenant (`server/src/env.ts:45`).

## 3. Per-file change list

Status as of the merged Phase 2 tree. **Done** = in the code today (reference is current). **Open** = still to do. Every Open item is also assigned to a Phase 3 sub-item in section 4.

### Server

| File | Change | Status |
|---|---|---|
| `server/src/env.ts` | `xaiKey`, `composioKey`, `orgoKey` optional (`:29,31,32`); `host` (`:25`); `libRoot` (`:71`); `features` (`:74`); `SESSION_SECRET` via `secret()` so `SESSION_SECRET_FILE` works (`:33`). `localBox` still reads `HQ_LOCAL=1` (`:58`), which compose and supervisord set; the flag was not removed. | Done |
| `server/src/index.ts` | `desSelfTest()` only with Orgo (`:24`); `hostname: env.host` (`:46`); `initTriggers` only when `features.composio` (`:51`). | Done |
| `server/src/orgo.ts` | Deleted. `server/src/db.ts:33` keeps the `orgo_id` column of `computers` (harmless; `computer.ts:37,45` writes NULL). | Done |
| `server/src/box.ts` | Local only; `hermesInstallEnv` (`:33`). | Done |
| `server/src/computer.ts` | Local display allocator: `startDisplay` (`:118`), `readyScreen` (`:259`), `screenForWork` (`:287`), `releaseScreen` (`:306`); `ensureComputer`/`suspendComputer` (`:162`, `:338`) are no-ops; `MAX_SCREENS`/`screenLimit` (`:21,24`). `orgoId` is gone from `ComputerState` (`server/src/types.ts:178`). | Done |
| `server/src/vnc.ts` | Raw TCP to `127.0.0.1:5900+N` (`vncPortFor`, `:20`); `WatchFilter` kept; `originAllowed` (`:23`) is checked on the websocket upgrade (`:94`): a missing or foreign `Origin` gets 403 (Phase 2 run recorded it). | Done |
| `server/src/routes.ts` | `GET /auth/me` returns `{user, devLogin, features}` (`:75-78`); `/api/apps*` and `/api/voice*` answer 503 `{error:'disabled'}` when off (`:68-73`); Google sign-in guarded (`:81,91`); `DEV_LOGIN` hardening (`:66-67,110-114`, see Phase 3 item 2); screenshot via `box.screenshot` (`:403-410`). | Done |
| `server/src/routes-config.ts` | Orgo `exportFile` branch removed; library uses `env.libRoot` (`:204`). Engine sign-in route `POST /bots/:id/engine/login` (`:141`) runs `hermes auth add <provider>` (plus `--type oauth` for `anthropic`) then `hermes config set model.provider <provider>` in a terminal on the bot's screen. | Done |
| `server/src/composio.ts`, `triggers.ts`, `voice.ts` | Lazy clients and feature guards (`composio.ts:13,30,61,108`; `triggers.ts:25,34,68,80,95,115`; `voice.ts:19,366`). | Done |
| `server/src/engine.ts` | `XAI_API_KEY` is not in `SHARED_ENV` (`:105-110`). Phase 2 additions: `shareInstalls` (`:151`), gateways get `hermesInstallEnv()` (`:336`). | Done |
| `server/src/mcp.ts`, `agent/tools.ts`, `agent/prompt.ts`, `agent/loop.ts` | `enabledTools()` (`tools.ts:330`) used by `mcp.ts:45,59`; prompt drops the Composio and `x_search` lines when off (`prompt.ts:28,41,44,58`); loop guards (`loop.ts:160,439`). | Done |
| `server/src/desk.ts` | Planned: skip the runtime "install desktop scripts" step because box scripts are baked at `/opt/hq`. Not done: `bundle()` (`:47`) and the `go` call (`:312`) still ship the scripts on first use. It works in the container and was exercised in Phase 2, so this is optional. | Open (optional) |

### Box scripts (`server/box/`)

| File | Change | Status |
|---|---|---|
| `hqlib.py` | `HQ_ROOT` (`:19`), `HQ_LOGS`, `HQ_PROFILES`, `HQ_FILES` from env; `HQ_NO_APT=1`; dbus needed no change. | Done |
| `hq-screen.py` | Env-driven paths; `install_packages()` (`:190`) refuses to run `apt-get` when `HQ_NO_APT=1` (`:194`). | Done |
| `hq-shell.py`, `hq-home.py` | Env-driven paths; `hq-home` stays on `127.0.0.1:7391`. | Done |

### Scripts, docs, tests

| File | Change | Status |
|---|---|---|
| `scripts/install-on-computer.sh` | Orgo-only (requires `ORGO_COMPUTER_ID`); superseded by the Dockerfile. Kept until Orgo is removed. | Kept on purpose |
| `scripts/sign-in-link.sh` | Reads `SESSION_SECRET` or `SESSION_SECRET_FILE`, else `ENV_FILE`. | Done |
| `scripts/add-hq-to-hermes.py` | Run by `docker/entrypoint.sh` (`:86-107`) to add `mcp_servers.hq` to the primary `config.yaml`. | Done |
| `.env.example` | `HQ_LOCAL=1`, `HOST`, `LIB_ROOT`, `DEV_LOGIN=0`; Composio/xAI/Orgo keys marked optional. | Done |
| `README.md` | Link to `docs/LOCAL.md`. README does not mention it yet. | Open (small) |
| `server/test/prompt-snapshot.ts`, `prompt-snapshot.txt` | Snapshot of the prompt with all features ON. See Phase 3 item 4 for what is missing. | Partly done |

### Web (`web/src`)

Plumbing is done: `Features` in `server/src/types.ts:232`, `lib/api.ts:28`, `store.ts:11-12,54-55,74-75`, `App.tsx:23`. Everything below is gated on `features` and is Done; the line numbers are where the gate is today.

| File:line | Behaviour today |
|---|---|
| `components/Sidebar.tsx:56,139,148` | Connect-apps menu item and footer icon only with `composio`. |
| `components/Composer.tsx:20-21,97,116,142-147` | "+" apps item only with `composio`; dictation mic only with `voice`; send arrow always when `!voice`. |
| `components/config/AppSettings.tsx:28,40,52` | `apps` section only with `composio`. |
| `components/config/AppSettings.tsx:110,126,133-137,162` | ComputerSection: wording follows `features.orgo`; the idle-sleep text and Sleep/Wake buttons render only with `orgo`. Screens list and Reset stay. |
| `components/DetailsPanel.tsx:54-56,126,147` | Add to Slack/Suggested only with `composio`; VoiceSettings only with `voice`. |
| `components/ChatView.tsx:18,37` | `VoiceCallBar` only with `voice`. |
| `components/cards/Cards.tsx:30,38,200-206` | ConnectCard only with `composio`; no `logos.composio.dev` fetch without it. |
| `App.tsx:23,38,66` | ConnectAppsModal and the popup listener only with `composio`. |
| `components/modals/CreateBotModal.tsx:82` | Reworded ("Works for you, handling the tasks you assign"). |
| `components/SignIn.tsx:9-10,33,34,42,44` | Google button only with `composio`; dev form only with `devLogin`; otherwise "Ask the owner for a sign-in link (scripts/sign-in-link.sh)"; xAI footer only with `xai`. |
| `lib/computer.ts:3-4`; `ComputerViewer.tsx:37,66-78,151,216,240`; `LibraryTab.tsx:66-71` | Local wording ("On"/"Starting") and no wake prompt unless `orgo`. The Orgo wake/sleep code (`configApi.ts:61-62`) is gated, not deleted. |
| `dev/fixtures.ts:35` | Connect-card fixture follows `features.composio`. |

`features.xai` is server-only except the sign-in footer: nothing else in `web/src` depends solely on xAI.

## 4. Phased plan

### Phase 1: one bot on Codex with a visible screen

Implemented and merged. Smallest slice; one display `:99`, no multi-bot.

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

Implemented and merged (items 1-5 below, results under "Result"). Item 1 chose on-demand start through supervisord, not pre-start.

1. Display allocator for `:100+` in `computer.ts` (Xvfb + desktop + x11vnc started on demand, or pre-started to `MAX_BOTS`).
2. Managed engines on 8650+ per extra bot; confirm `writeHome` copy on first start.
3. Watch/control modes through the VNC relay.
4. Library export through the local filesystem path.
5. Optionally run `server/scripts/desk-test.ts` as a desk check (it dresses extra screens and exercises dress/undress/terminal; currently needs `ORGO_COMPUTER_ID`, so adapt it to the local backend first).

Acceptance: create 2-3 bots, each shows its own screen and Chrome (CDP 9200+N reachable only inside the container: `docker compose exec hq curl -s 127.0.0.1:9201/json/version`). Each completes a message round trip. A Library file download returns 200. `docker compose restart hq`, then reload: still signed in, bots still answer without re-running engine sign-in. Repeat with `docker compose down && up`.

Result (run with `MAX_BOTS=3` beside another instance, so `HQ_PORT=8788 HQ_APP_URL=http://localhost:8788` and a separate compose project; `HQ_PORT` is new in `docker-compose.yml`):

- Displays: at boot only `:99` runs; `:100`/`:101` start when their bot is created (`[computer] started display :100 for screen-100`). Three bots got `:99`, `:100`, `:101`, each 1440x900, each dressed with its own name and colour. Screenshots returned 200 PNGs for all three. CDP `9299`, `9300` and `9301` answered inside the container, each Chrome on its own `--user-data-dir`.
- Relay: an RFB handshake through `/api/bots/<id>/screen` reached each bot's own display. A foreign `Origin` got 403, a missing `Origin` got 403, and a missing session got 401. In watch mode a pointer event did not move the cursor; in control mode it did.
- Engines: each extra bot got its own gateway (`8650`, `8651`; hermes-agent 0.22.2 on `/health`). Its home has `installs -> /root/.hermes/installs`, a 0600 `.env`, `config.yaml` and `SOUL.md`. `auth.json` was not copied because the primary had not signed in yet; `writeHome` copies it only when the primary has one.
- `MAX_BOTS`: a 4th bot was refused with 409.
- Export: a file under `/root/grokbot/files/<extra bot>/` was listed, `POST .../files/download` returned its URL, and the raw GET returned 200 with the same sha256. `..` paths got 400. A symlink pointing outside the library got 404, as did another bot's path and (without a session) 401.
- Delete: deleting a bot stopped its three display programs and its gateway, and removed its Hermes home and Chrome profile. The next new bot reused the freed screen and port.
- Persistence: after `docker compose restart hq` and after `down && up` (volumes kept), the session was still valid, every bot came back on the same display (restarted on demand and dressed again) and all gateways answered `/health`.
- Logs: no Orgo/Composio/xAI lines in `/var/log/hq/*.log` or `docker logs`. `XAI_API_KEY` appears by name only in Hermes' own plugin manifests and bundled skill docs, in no `.env`.
- `server/scripts/desk-test.ts` now uses the local backend (`box.screenshot`, `startDisplay`); it type-checks in the image. It was not run against this instance, because it dresses the extra screens for made-up bots and real bots were using them.
- Round trip: NOT yet verified. Each bot's turn reaches its own gateway (it answered with its "no provider" and then "no Anthropic credentials" errors), but a real reply, and a reply after restart, need a provider sign-in per bot (section 4, Phase 3 item 1). The gateway reads `model.provider` per turn (claims table), so signing in needs no engine restart.

### Phase 3: Claude OAuth, hardening, UI polish

Status per sub-item, against the merged tree. Items 2 and 3 are in the code; what is open there is verification and small leftovers.

1. **Claude OAuth sign-in on a bot screen.**
   - Done: Engine settings sign-in route runs `hermes auth add anthropic --type oauth && hermes config set model.provider anthropic` in a terminal on the bot's screen (`server/src/routes-config.ts:141-165`); Hermes home and toolchain env reach that terminal (`box.ts:28,33`).
   - Open: the Anthropic flow prints a URL and waits for a pasted code, and the viewer cannot paste. `ComputerViewer.tsx:102` builds the noVNC client with no clipboard handling, and `WatchFilter` drops `ClientCutText` in watch mode (`vnc.ts:79,119`; control mode passes it through). Needs a clipboard bridge (browser paste field or button that calls noVNC `clipboardPasteFrom`) in `web/src/components/ComputerViewer.tsx`, and a check that `x11vnc` forwards it to the terminal.
   - Open: real sign-in not yet run (needs an account), and so the per-bot message round trip (Phase 2 "Round trip") is still unverified for Codex and Claude.
2. **`DEV_LOGIN` hardening.**
   - Done: `ALLOWED_EMAILS` required. With `DEV_LOGIN=1` and an empty list the server does not exit; it logs `[auth] DEV_LOGIN disabled: ALLOWED_EMAILS is empty` and `/api/auth/dev` answers 403 (`server/src/routes.ts:66-67,111`), `/auth/me` reports `devLogin:false` (`:77`). That satisfies the "or 403" acceptance wording.
   - Done: `/api/auth/dev` checks `Origin` against `APP_URL`, and with no `Origin` header requires `Host` to equal the `APP_URL` host (`routes.ts:112-114`; foreign gets 403).
   - Done: websocket upgrade `Origin` check (`vnc.ts:23-30,94`), recorded in Phase 2 results. Note it accepts an Origin that matches `APP_URL` or the request `Host`; the `/api/auth/dev` check accepts only `APP_URL` (or, with no Origin, the `Host`).
   - Done: `.env.example` and compose default `DEV_LOGIN=0`.
   - Done: the `/api/auth/dev` 403s (empty `ALLOWED_EMAILS`, foreign `Origin`) are recorded in the acceptance results below, run against the real server process. Still open: no automated test, and not yet run against a container with `DEV_LOGIN=1`. `tests/e2e.mjs:29` posts to `/api/auth/dev` without an `Origin`, so it passes only when its `Host` matches `APP_URL`.
3. **Remaining web hiding and wording.** Done: every web item in section 3 (including `CreateBotModal.tsx:82` and the SignIn text). Open: confirm in a browser against a container with no Composio/xAI keys that nothing visible is left; the Orgo wake/sleep UI is gated by `features.orgo`, not removed (`AppSettings.tsx:133-137`, `ComputerViewer.tsx:66-78`, `LibraryTab.tsx:66`, `configApi.ts:61-62`), which is acceptable as long as Orgo is out of scope for the local build.
4. **Prompt snapshot test.**
   - Done: `server/test/prompt-snapshot.ts` runs `instructionsFor` from `agent/prompt.ts` with `features` all ON and compares to `server/test/prompt-snapshot.txt`.
   - Open: no npm script or CI runs it (`server/package.json` has no `test`); add one. It is TypeScript and imports `typescript`, so it needs `tsx` (already used by `server`'s `dev`) or a build step.
   - Open: no features-OFF case; a second snapshot or assertion that the Composio and `x_search` lines are absent when `composio`/`xai` are false (`prompt.ts:28,41,44,58`).
   - Open: the snapshot text should be confirmed byte-identical to the pre-change prompt (git history before `e8c3e12`); it was not recorded that this was checked.

Acceptance: a Claude-backed bot replies; `/api/auth/dev` returns 403 with `DEV_LOGIN=1` and empty `ALLOWED_EMAILS`; `/api/auth/dev` with a foreign `Origin` returns 403; a websocket upgrade with a foreign `Origin` is refused (done in Phase 2); `/api/voice/*` and `/api/apps/*` return 503 with no keys.

**Acceptance results (run against the real server, not the container).** Built with `npm run build -w server` and started with `node dist/index.js` on Node 26 (the image's Node was not used; `tsx` could not run in the sandbox). Env: `DEV_LOGIN=1`, `APP_URL=http://localhost:<port>` (matching `PORT`), throwaway `DB_PATH`, a freshly generated throwaway `SESSION_SECRET`, no Composio/xAI/Orgo keys. `docker compose` was not used, so the compose-level wiring (`DEV_LOGIN: "0"`, `ALLOWED_EMAILS` required) is not covered by this run. Status code is what each request returned.

| Check | Setup | Result |
|---|---|---|
| `/api/auth/dev` with empty `ALLOWED_EMAILS` | `ALLOWED_EMAILS=` | **PASS**: 403 for every request (matching Origin, no Origin, foreign Origin, wrong Host); log `[auth] DEV_LOGIN disabled: ALLOWED_EMAILS is empty`; `/auth/me` shows `devLogin:false`. |
| `/api/auth/dev` with a foreign `Origin` | `ALLOWED_EMAILS=a@example.com`, `Origin: http://evil.example` | **PASS**: 403. |
| `/api/auth/dev` with an allowed email and matching `Origin` | `Origin` = `APP_URL`, `a@example.com` | **PASS**: 200 and a `grokbot_session` cookie is set. |
| `/api/auth/dev` with a matching `Origin` but a non-listed email | `b@example.com` | **PASS**: 403. |
| `/api/auth/dev` with no `Origin` | `Host` equals the `APP_URL` host | 200 (as designed, and why `tests/e2e.mjs:29`, which sends no `Origin`, works against a local server). |
| `/api/auth/dev` with no `Origin`, wrong `Host` | `Host: evil.example` | **PASS**: 403. |
| Websocket upgrade to `/api/bots/:id/screen` with a foreign `Origin` | valid session cookie | **PASS**: refused, HTTP 403. |
| Same upgrade with no `Origin` | valid session cookie | **PASS** (refused, HTTP 403; a non-browser client is refused by design). |
| Same upgrade with `Origin` = `APP_URL` | valid session cookie | Accepted (upgrade completed). The relay's upstream (a VNC server) does not exist outside the container, so nothing was relayed. |
| `/api/voice/*`, `/api/apps`, `/api/apps/*` with no keys | no Composio/xAI | **PASS**: 503 `{"error":"disabled"}` (checked in both server runs, without a session cookie; `/auth/me` reports all `features` false). |
| `npm run typecheck -w server` | | **PASS**. |
| Claude-backed bot replies (live Codex/Claude sign-in and message round trip) | needs a real account | **NOT RUN, pending**. |
| Clipboard bridge for pasting the Anthropic code (item 1) | | **NOT RUN**: not built. |

Not covered: the checks ran against a local process, not the container (the websocket foreign-`Origin` refusal was also verified inside the container in Phase 2). The 503 check was made without a session cookie only.

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

Container exposure: only `127.0.0.1:8787:8787` on the host. Everything else (VNC 5900+, CDP 9200+, Hermes 8642/8650+, hq-home 7391) is container-internal. x11vnc runs with no password because it is only reachable on container loopback, which makes the server's VNC relay the only door; hence the Origin check and session auth on it (`server/src/vnc.ts:23,94`). If exposing over a tailnet, bind the tailnet IP instead of loopback and set an https `APP_URL`.

Auth:

- Default sign-in is the owner link: `POST /api/auth/owner` with bearer = HMAC-SHA256(`SESSION_SECRET`, `owner-login`) returns a one-time 15-minute link redeemed at `/api/auth/link/:token` (`server/src/routes.ts:131`, `server/src/lib/auth.ts:51-52`). It works with `DEV_LOGIN` off, checks `ALLOWED_EMAILS` or an existing account, and must be run through `docker compose exec` because it posts to `127.0.0.1:$PORT`.
- `DEV_LOGIN` is a fallback only. `.env.example` and compose set it to `0`. A loopback-source check does not work here, because the browser's requests arrive through Docker's port forward (a bridge address, not loopback) while the bots call the server from container loopback. Such a check would lock the user out and let bots in. When on: non-empty `ALLOWED_EMAILS` is required and `Origin`/`Host` is checked against `APP_URL` (both built, `server/src/routes.ts:66-67,110-114`). Even then, any bot can call `/api/auth/dev` with an allowed email and get a session. That is another reason to keep it off.
- Session cookie is httpOnly, SameSite Lax, and `secure` only when `APP_URL` starts with `https:` (`server/src/lib/auth.ts:17`). A plain `http://localhost` setup therefore has a non-secure cookie; acceptable for loopback, not for a tailnet over http.
- MCP: each bot's bearer is HMAC(`SESSION_SECRET`, `mcp:<botId>`) (`server/src/engine.ts:59`), so any bot with shell can read its own, and any process that can read `SESSION_SECRET` can mint every bot's. Keep `SESSION_SECRET` out of the bot-readable environment where possible (see below; this is limited since bots are root).
- `SESSION_SECRET` is supplied through a file or docker secret and checked only by the server starting and `sign-in-link.sh` working. Never print or read it. Honest caveat: a bot with root in the container can read a secret mounted in the container.
- Secrets in the image or compose env: none. OAuth tokens live only in the Hermes-home volumes.

## 6. Dockerfile and docker-compose (as built)

The real files are `Dockerfile`, `docker-compose.yml`, `docker/entrypoint.sh`, `docker/hq-display.sh` and `docker/supervisord.conf`. The earlier sketches in this section were replaced by what is built; read those files for the details. How they differ from the original sketch:

- **Base image** `debian:trixie-slim` (not bookworm), two stages (`base`, `app`). Chromium is the browser (Debian package); `libatomic1`, `procps`, `xz-utils`, `thunar` and `fonts-dejavu-core` were added, `gnupg`/`pip` dropped.
- **Node** 22.23.5 from the official tarball, checked against pinned SHA-256 for amd64 and arm64, not the NodeSource script. `build-essential` is installed only to compile `better-sqlite3` and purged again.
- **Hermes** is installed by its own `scripts/install.sh` pinned to commit `d923a5e` into `/opt/hermes-agent` with runtime at `/opt/hermes-runtime` (`HERMES_INSTALL_DIR`, `HERMES_RUNTIME_DIR`). The installer's per-home state is parked at `/opt/hermes-seed` and the entrypoint copies it into the `hermes-primary` volume when the pinned commit changes.
- **Box scripts**: `COPY --exclude=ext server/box /opt/hq` plus `server/box/ext` to `/opt/hq/ext/src`; `HQ_ROOT`, `HQ_LOGS`, `HQ_PROFILES`, `HQ_FILES`, `HQ_NO_APT=1` set as image `ENV`. `docker/hq-display.sh` is installed to `/usr/local/bin`. The healthcheck has `--start-period=60s`.
- **Supervisord** (`docker/supervisord.conf`): static programs are `dbus` (10), `hq-home` (50), `hermes` (60, primary gateway `hermes gateway run --no-supervise`, home `/root/.hermes`) and `server` (70, waits up to 120 s for `127.0.0.1:8642/health`, then `node /opt/hq/app/server/dist/index.js`). The per-display `xvfbN`, `desktopN`, `x11vncN` programs are generated by the entrypoint into `/etc/supervisor/conf.d/hq-displays.conf` (see section 2), not listed in the static file.
- **Compose**: host port is `127.0.0.1:${HQ_PORT:-8787}:8787`; `APP_URL`/`SERVER_URL` come from `HQ_APP_URL` (default `http://localhost:8787`), not `APP_URL`, because `./.env` sets `APP_URL` to the Vite dev URL; `ALLOWED_EMAILS` is required (`${ALLOWED_EMAILS:?...}`); `MAX_BOTS` defaults to 2 and is read from the environment; `DEV_LOGIN` is `"0"`. The volumes, `shm_size: 2gb`, `init: true`, secret and no-privilege rules are as sketched. The healthcheck also has `timeout: 3s` and `start_period: 60s`. There are no bind mounts, so no SELinux relabel suffix is needed (and `:z` would break the target host, which has no SELinux).

Without Swarm, compose file secrets are bind mounts, and `secrets:` has no `:z` option. The target host has no SELinux, so no relabel is needed there; the file was read by container root at `/run/secrets/session_secret` (the entrypoint used it to derive the MCP bearer). On an SELinux-enforcing host the file would still need relabelling. `SESSION_SECRET_FILE` is read by the entrypoint and `scripts/sign-in-link.sh`; the server reads it too (`secret()` in `server/src/env.ts:8`).

## 7. Risks and open questions for Marc

1. **Hermes install method and version.** Resolved: pinned `install.sh` at commit `d923a5e` (v0.22.2). `hermes gateway run --no-supervise` runs under supervisord and its API server answers `/health`. `hermes auth add` was not exercised (needs a real account).
2. **OAuth callback vs device code.** Resolved from source: Codex is device-code, Anthropic uses a hosted callback with a pasted code. No localhost callback port is involved.
3. **Chrome vs Chromium.** Resolved: the image installs Debian Chromium (`Dockerfile`). Box scripts find both and set Chrome policy under `/etc/opt/chrome/policies/managed` (and `/etc/chromium/...` if present) plus a CRX packed with openssl. Chromium from Debian is simpler; Google Chrome needs its apt repo and is amd64 only. The Phase 2 run dressed screens with the extension policy on Chromium.
4. **XFCE weight.** The scripts need `xfce4-panel`/`xfdesktop`/`xfsettingsd`/`xfconf-query` (panel hiding needs xfconf). A lighter shell (openbox + xsetroot) would degrade some dressing. Accept XFCE per display (roughly a few hundred MB RAM each) or invest in a lighter path?
5. **Root vs non-root.** Scripts assume `HOME=/root`, `/opt/hq`, `/var/log/hq`, `/root/grokbot`, and runtime `apt-get`. Root in the container is simplest and bots get root anyway; non-root would need path rework. Resolved: root (no path rework), as built.
6. **Bots are not isolated from each other.** One container, one uid: any bot can drive another's Chrome over CDP, read its profile, and read all `auth.json`. If that is unacceptable, the only real fix is one container per bot (large redesign).
7. **MAX_BOTS vs RAM.** Each bot costs Xvfb + XFCE + x11vnc + Chrome + a Hermes gateway. Screens hard-cap at 4 (`server/src/computer.ts:21`) regardless of `MAX_BOTS`. Measured in Phase 2 with three idle bots: the container used about 0.96 GiB (`docker stats`), of which each Hermes gateway is about 210 MB RSS and each Chrome a few small processes. Volumes held about 0.7 GB (`/root/.hermes` 390 MB, mostly the shared venv; `/root/grokbot` 311 MB of Chrome profiles; `/data` 13 MB). Keep `MAX_BOTS=2` as the default; 3 fits on a 16 GB host with other services running.
8. **dbus session.** XFCE and xfconf need a session bus per display; `hqlib` tolerates one missing (falls back to a private bus). The desktop program runs `dbus-launch`.
9. **`/dev/shm` and GPU.** Chrome gets `--disable-dev-shm-usage`, but `shm_size` is set anyway. No GPU; software rendering only.
10. **Health path.** The route is `/api/health`; the `/health` the task hinted at does not exist (`server/src/index.ts:31`). The Dockerfile and compose use `/api/health`. The Hermes gateway has its own `/health` (`server/src/engine.ts:236`).
11. **Stale docs to update later (not in this change).** `README.md:7-8,103-131,181-190` (Orgo install, Composio/xAI claims), `docs/ARCHITECTURE.md` (Orgo/Composio surfaces; `/root/grokbot` paths around 71-79), `docs/orgo-builder-guide.md`, `docs/xai-and-composio.md`. README does not link to this file yet (small open item, see section 3).
12. **Unread inputs.** `tests/e2e.mjs` and `tests/voice-call.mjs` were characterized, not fully traced; `server/box/*.py` were read for assumptions, not exhaustively.
