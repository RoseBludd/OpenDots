# Developer-ready layer over the pinned OpenBot agent-computer image: the tools a
# Dot needs to do real project work (git, search, build chains, python), and a
# file listing that skips dependency/VCS internals so source files stay visible.
ARG BASE=opendots-computer:b6932d3
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep jq make build-essential python3 python3-pip python3-venv \
      zip file less patch openssh-client sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm typescript tsx \
    # Bind-mounted host folders have foreign owners and report every file as
    # executable; without these git refuses the repo or shows the whole tree modified.
    && git config --system --add safe.directory '*' \
    && git config --system core.filemode false \
    && git config --system core.autocrlf false
COPY deployment/computers/patch-computer-workspace.mjs /tmp/patch-computer-workspace.mjs
RUN bun /tmp/patch-computer-workspace.mjs /app/src/workspace.ts && rm /tmp/patch-computer-workspace.mjs
