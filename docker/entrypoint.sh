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

# Stale X locks and supervisor socket from a previous run of this same container.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /var/run/supervisor.sock

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
