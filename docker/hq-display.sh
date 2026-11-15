#!/usr/bin/env bash
# One piece of one screen's desktop, run by supervisord (see docker/entrypoint.sh, which writes a
# program per display into /etc/supervisor/conf.d/hq-displays.conf).
#   hq-display.sh xvfb N      the X server for display :N
#   hq-display.sh desktop N   its XFCE session (own dbus session bus)
#   hq-display.sh vnc N       x11vnc for it on 127.0.0.1:(5900 + N - 99), no password
# Display :99 is the default screen (primary bot); :100, :101, ... are the extra bots' screens.
# The VNC port rule matches vncPortFor in server/src/vnc.ts.
set -euo pipefail

what="${1:?usage: hq-display.sh xvfb|desktop|vnc N}"
n="${2:?display number}"
[[ "$n" =~ ^[0-9]+$ ]] || { echo "bad display number: $n" >&2; exit 2; }

wait_for_x() {
  for _ in $(seq 1 60); do
    xdpyinfo -display ":$n" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "display :$n did not come up" >&2
  return 1
}

case "$what" in
  xvfb)
    # A stale lock from an earlier run of this container (the filesystem survives a restart).
    rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
    exec Xvfb ":$n" -screen 0 1440x900x24 -nolisten tcp
    ;;
  desktop)
    wait_for_x
    export DISPLAY=":$n" XDG_RUNTIME_DIR=/run/user/0 XDG_CURRENT_DESKTOP=XFCE NO_AT_BRIDGE=1
    exec dbus-launch --exit-with-session xfce4-session
    ;;
  vnc)
    wait_for_x
    # Loopback only: the server's VNC relay is the only door (docs/LOCAL.md section 5).
    exec x11vnc -display ":$n" -rfbport "$((5900 + n - 99))" -localhost -nopw -forever -shared
    ;;
  *)
    echo "unknown part: $what" >&2
    exit 2
    ;;
esac
