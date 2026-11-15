#!/usr/bin/env bash
# Container entrypoint: prepare directories and the primary Hermes .env, then exec the CMD (supervisord).
# Never prints or echoes a secret value; key presence is checked by NAME only.
set -euo pipefail

HERMES_HOME="${HERMES_HOME_PRIMARY:-/root/.hermes}"
export HERMES_HOME

mkdir -p "$HERMES_HOME" "${HQ_LOGS:-/var/log/hq}" "${ENGINES_DIR:-/data/engines}" \
         "${HQ_PROFILES:-/root/grokbot/profiles}" "${HQ_FILES:-/root/grokbot/files}" \
         "${HQ_ROOT:-/opt/hq}/screens" "${HQ_ROOT:-/opt/hq}/jobs" \
         /data /run/dbus /run/user/0 /tmp/.X11-unix
chmod 700 /run/user/0
chmod 1777 /tmp/.X11-unix
rm -f /run/dbus/pid /run/dbus/system_bus_socket

# Stale supervisor socket from a previous run of this same container (hq-display.sh clears X locks).
rm -f /var/run/supervisor.sock

# One screen per bot: display :99 for the primary bot, :100.. for the others, MAX_BOTS of them but at
# most 4 (MAX_SCREENS in server/src/computer.ts). Each screen is three supervisord programs. :99 starts
# with the container; the others are started by the server when a bot first needs its screen, and
# stopped again when that bot is deleted.
# Same rule as env.maxBots in server/src/env.ts: decimal digits only, anything else means 4. Leading
# zeros are dropped so bash does not read "08" as octal; more than three digits is past the cap anyway.
max_bots="${MAX_BOTS:-4}"
if [[ "$max_bots" =~ ^0*([0-9]+)$ ]]; then
  max_bots="${BASH_REMATCH[1]}"
  (( ${#max_bots} <= 3 )) || max_bots=4
else
  max_bots=4
fi
screens=$(( max_bots < 1 ? 1 : (max_bots > 4 ? 4 : max_bots) ))
displays_conf=/etc/supervisor/conf.d/hq-displays.conf
{
  echo "; Written by docker/entrypoint.sh at container start (MAX_BOTS=$max_bots -> $screens screens). Do not edit."
  for (( i = 0; i < screens; i++ )); do
    n=$(( 99 + i ))
    auto=$([ "$n" = 99 ] && echo true || echo false)
    for part in xvfb desktop vnc; do
      case "$part" in
        xvfb) name="xvfb$n"; prio=20; secs=2 ;;
        desktop) name="desktop$n"; prio=30; secs=5 ;;
        vnc) name="x11vnc$n"; prio=40; secs=3 ;;
      esac
      cat <<CONF

[program:$name]
priority=$prio
command=/usr/local/bin/hq-display.sh $part $n
autostart=$auto
autorestart=true
startsecs=$secs
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/hq/sv-$name.log
stderr_logfile=/var/log/hq/sv-$name.log
CONF
    done
  done
} >"$displays_conf"

# Hermes' dependency venv lives in HERMES_HOME/installs, which the volume hides. Seed it from the image
# (/opt/hermes-seed, see Dockerfile) on first start and whenever the pinned Hermes commit changes.
# Files already in the volume (auth.json, config.yaml, .env, skills...) are never overwritten.
if [ "$(cat "$HERMES_HOME/.seed-commit" 2>/dev/null || true)" != "$(cat /opt/hermes-seed/.seed-commit)" ]; then
  rm -rf "$HERMES_HOME/installs"
  cp -a /opt/hermes-seed/installs "$HERMES_HOME/installs"
  cp -an /opt/hermes-seed/. "$HERMES_HOME/"
  cp /opt/hermes-seed/.seed-commit "$HERMES_HOME/.seed-commit"
fi

# Primary gateway's .env. Set the API server options if missing, and generate API_SERVER_KEY once.
env_file="$HERMES_HOME/.env"
touch "$env_file"
chmod 600 "$env_file"
has_key() { grep -q -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$env_file"; }
set_default() { has_key "$1" || printf '%s=%s\n' "$1" "$2" >>"$env_file"; }
set_default API_SERVER_ENABLED true
set_default API_SERVER_HOST 127.0.0.1
set_default API_SERVER_PORT 8642
if ! has_key API_SERVER_KEY; then
  printf 'API_SERVER_KEY=%s\n' "$(openssl rand -hex 24)" >>"$env_file"
fi

# Give the primary gateway the app's tools: mcp_servers.hq in its config.yaml. The bearer is
# HMAC-SHA256(SESSION_SECRET, "mcp:primary") (server/src/engine.ts mcpToken), computed from the secret
# file without printing it. Editing config.yaml needs no running server; the entry is written
# to a 0600 file under /run and add-hq-to-hermes.py is a no-op when nothing changed.
if [ -n "${SESSION_SECRET:-}" ] || { [ -n "${SESSION_SECRET_FILE:-}" ] && [ -r "$SESSION_SECRET_FILE" ]; }; then
  touch "$HERMES_HOME/config.yaml"
  entry=/run/hq/hermes-mcp-hq.yaml
  mkdir -p /run/hq
  (umask 077; HQ_MCP_URL="${MCP_BASE_URL:-http://127.0.0.1:${PORT:-8787}}/mcp/primary" python3 - >"$entry" <<'PY'
import hashlib, hmac, os
# Same precedence as secret() in server/src/env.ts: SESSION_SECRET, then SESSION_SECRET_FILE.
secret = os.environ.get("SESSION_SECRET") or open(os.environ["SESSION_SECRET_FILE"], encoding="utf-8").read().strip()
token = hmac.new(secret.encode(), b"mcp:primary", hashlib.sha256).hexdigest()
print("  hq:")
print("    url: " + os.environ["HQ_MCP_URL"])
print("    headers:")
print("      Authorization: Bearer " + token)
print("    timeout: 1800")
print("    connect_timeout: 30")
PY
  )
  python3 /opt/hq/app/scripts/add-hq-to-hermes.py --config "$HERMES_HOME/config.yaml" --entry "$entry" \
    || echo "entrypoint: could not add the hq MCP server to $HERMES_HOME/config.yaml (see docs/LOCAL.md)" >&2
fi

exec "$@"
