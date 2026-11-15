# syntax=docker/dockerfile:1
# bot-hq, fully local: server + Hermes Agent + Xvfb/XFCE desktops + x11vnc + Chromium in ONE container.
# See docs/LOCAL.md. Nothing secret is baked in; OAuth tokens and the session secret arrive at run time.
FROM debian:trixie-slim AS base
ENV DEBIAN_FRONTEND=noninteractive HOME=/root LANG=C.UTF-8 PYTHONUNBUFFERED=1

# System, desktop and browser packages. The box scripts (server/box) no longer apt-get at run time
# (HQ_NO_APT, see hq-screen.py), so everything they probe for must be installed here.
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor ca-certificates curl xz-utils git openssl procps \
    python3 python3-yaml python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common \
    xvfb x11vnc x11-utils x11-xserver-utils xdotool wmctrl scrot imagemagick \
    xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf xfce4-terminal thunar xterm \
    dbus dbus-x11 fonts-inter fonts-dejavu-core \
    libatomic1 chromium \
 && rm -rf /var/lib/apt/lists/*

# Node 22 (README requires >= 22), from the official tarball, checked against nodejs.org's SHASUMS.
ARG NODE_VERSION=22.23.5
ARG NODE_SHA256_X64=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
ARG NODE_SHA256_ARM64=2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64;   sha="$NODE_SHA256_X64" ;; \
      arm64) arch=arm64; sha="$NODE_SHA256_ARM64" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    echo "${sha}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; node --version

# ---- Hermes Agent, pinned to a commit (v0.22.2). Install method: the project's own scripts/install.sh
# at that commit (it provisions a hash-verified uv + Python 3.14 and installs deps from uv.lock).
# Code lives OUTSIDE the Hermes home so the /root/.hermes volume never shadows it.
ARG HERMES_COMMIT=d923a5eb487a17c0a68801bba9ef0f56c81040a8
ENV HERMES_INSTALL_DIR=/opt/hermes-agent HERMES_RUNTIME_DIR=/opt/hermes-runtime PATH=/root/.local/bin:${PATH}
RUN set -eu; \
    curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts/install.sh" -o /tmp/hermes-install.sh; \
    HERMES_HOME=/root/.hermes bash /tmp/hermes-install.sh --commit "${HERMES_COMMIT}" --dir "${HERMES_INSTALL_DIR}" \
        --hermes-home /root/.hermes --non-interactive --skip-browser --skip-computer-use; \
    rm -f /tmp/hermes-install.sh; \
    # The installer's per-home state (dependency venv under installs/, seeded config) must end up inside
    # the /root/.hermes volume, which hides whatever the image has there. Park it as a seed; the
    # entrypoint copies it in whenever the pinned commit changes. The venv keeps its /root/.hermes path.
    rm -rf /root/.hermes/cache /root/.hermes/logs /root/.hermes/backups /root/.hermes/.hermes-update-in-progress.lock; \
    mv /root/.hermes /opt/hermes-seed; mkdir /root/.hermes; \
    printf '%s\n' "${HERMES_COMMIT}" > /opt/hermes-seed/.seed-commit

# ---- the app
FROM base AS app
WORKDIR /opt/hq/app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# better-sqlite3 has no prebuilt binary for this Node, so it compiles; the toolchain is removed again.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
 && npm ci \
 && apt-get purge -y --auto-remove build-essential && rm -rf /var/lib/apt/lists/*
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN npm run build

# Box scripts and the Chrome extension source live at /opt/hq, laid out as desk.ts BOX_FILES says:
# server/box/ext/* goes to /opt/hq/ext/src/* (hq-screen.py packs the CRX from there).
COPY --exclude=ext server/box /opt/hq
COPY server/box/ext /opt/hq/ext/src
COPY docker/supervisord.conf /etc/supervisor/conf.d/hq.conf
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/hq-display.sh /usr/local/bin/hq-display.sh
RUN chmod 755 /entrypoint.sh /usr/local/bin/hq-display.sh /opt/hq/*.py /opt/hq/app/scripts/*.sh

ENV HQ_ROOT=/opt/hq HQ_LOGS=/var/log/hq HQ_PROFILES=/root/grokbot/profiles HQ_FILES=/root/grokbot/files \
    HQ_NO_APT=1
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
