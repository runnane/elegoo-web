#!/bin/bash
#
# Elegoo Web — Installation Script
# Installs elegoo-web as a systemd service
#

set -e

INSTALL_DIR="/opt/elegooweb"
SERVICE_NAME="elegooweb"
SERVICE_USER="elegooweb"
SERVICE_PORT="${1:-8088}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root (or via sudo)"
    exit 1
fi

# Check for Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ $NODE_VERSION -lt 18 ]]; then
    log_error "Node.js version 18+ required. Found: $(node -v)"
    exit 1
fi
log_info "Node.js version: $(node -v)"

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
    log_error "pnpm is not installed. Install with: npm install -g pnpm"
    exit 1
fi
log_info "pnpm version: $(pnpm -v)"

# Check for rsync — the deploy is delete-consistent and there is no safe fallback.
# Falling back to `cp -r` here would silently reintroduce the exact bug this guards
# against (a file deleted from git stays live in $INSTALL_DIR forever) while reporting
# a successful install, so this exits rather than degrading.
if ! command -v rsync &> /dev/null; then
    log_error "rsync is not installed, and the deploy requires it."
    log_error "  Install it (apt install rsync / dnf install rsync / pacman -S rsync) and re-run."
    log_error "  Do not substitute 'cp -r': it never deletes, so files removed from the"
    log_error "  repository would remain live in $INSTALL_DIR."
    exit 1
fi

# Resolve source directory (repo root = parent of contrib/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Create service user if not exists
if ! id "$SERVICE_USER" &>/dev/null; then
    log_info "Creating service user: $SERVICE_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# Create installation directory
log_info "Creating installation directory: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"

# Copy source files — delete-consistent, so a file removed from the repository is also
# removed from the deploy.
#
# --delete is scoped to ONE DIRECTORY AT A TIME and is never run over $INSTALL_DIR
# itself. That is the whole safety argument: src/, dist/ and public/ are wholly owned by
# the repository, while the state that must survive an upgrade lives at the install root
# beside them —
#
#   $INSTALL_DIR/.env           the only copy of PRINTER_PASSWORD, TELEGRAM_BOT_TOKEN,
#                               AI_VLM_API_KEY. No backup anywhere.
#   $INSTALL_DIR/data/          persisted runtime state (DATA_DIR), created above
#   $INSTALL_DIR/node_modules/  installed deps, not present in the source tree
#
# — so none of them is inside the deletion scope at all. The --exclude list is a second
# line of defence for the case where one of those ever moves inside a synced directory;
# it is deliberately not the only one. Do not "simplify" this into a single
# `rsync -a --delete "$SCRIPT_DIR/" "$INSTALL_DIR/"`, which would put all three back
# under the excludes and one typo away from destroying production.
#
# Note the existing `if [[ ! -f "$INSTALL_DIR/.env" ]]` guard below protects against
# *overwrite* only. It is not cover for --delete.
#
# Trailing slashes are load-bearing: `rsync -a src/ dest/src/` copies the contents,
# `rsync -a src dest/src/` would nest the tree as dest/src/src.
RSYNC_OPTS=(-a --delete --exclude=.env --exclude=data/ --exclude=node_modules/)

log_info "Copying files (delete-consistent)..."
rsync "${RSYNC_OPTS[@]}" "$SCRIPT_DIR/src/" "$INSTALL_DIR/src/"
# dist/ and public/ may be absent from the source; skip rather than sync, because an
# absent source with --delete would empty the deployed copy.
if [[ -d "$SCRIPT_DIR/dist" ]]; then
    rsync "${RSYNC_OPTS[@]}" "$SCRIPT_DIR/dist/" "$INSTALL_DIR/dist/"
else
    log_warn "  No dist/ in source — leaving the deployed frontend untouched"
fi
if [[ -d "$SCRIPT_DIR/public" ]]; then
    rsync "${RSYNC_OPTS[@]}" "$SCRIPT_DIR/public/" "$INSTALL_DIR/public/"
fi
# Single files: no delete semantics to get right.
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/pnpm-lock.yaml" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/tsconfig.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/tsconfig.server.json" "$INSTALL_DIR/" 2>/dev/null || true

# Stamp the deploy — $INSTALL_DIR is not a git checkout, so this file is the only way
# to ask what is actually running. Read back by src/server/build-info.ts and reported
# from /api/health.
#
# Everything here degrades to null rather than failing the install: $SCRIPT_DIR may be
# an unpacked tarball rather than a checkout, and git may be absent from the PATH under
# sudo. `set -e` is active, so every capture is guarded.
#
# It lands at the install root, deliberately outside src/, dist/ and public/ — those are
# wholly owned by the repo and are the directories a delete-consistent copy sweeps.
log_info "Stamping deploy..."
GIT_COMMIT=""
GIT_SHORT=""
GIT_DESCRIBE=""
# -c safe.directory: the installer runs as root over a checkout owned by someone else,
# which git otherwise refuses as "dubious ownership" — that would silently produce an
# unstamped install in the one case this feature exists for.
GIT_CMD=(git -c "safe.directory=$SCRIPT_DIR" -C "$SCRIPT_DIR")
if command -v git &> /dev/null && "${GIT_CMD[@]}" rev-parse --git-dir &> /dev/null; then
    GIT_COMMIT="$("${GIT_CMD[@]}" rev-parse HEAD 2>/dev/null || true)"
    GIT_SHORT="$("${GIT_CMD[@]}" rev-parse --short HEAD 2>/dev/null || true)"
    GIT_DESCRIBE="$("${GIT_CMD[@]}" describe --tags --always --dirty 2>/dev/null || true)"
else
    log_warn "  Source is not a git checkout — /api/health will report an unknown build"
fi
PKG_VERSION="$(node -p "require('$SCRIPT_DIR/package.json').version" 2>/dev/null || true)"

# Serialised by node rather than by hand: it is already a hard dependency (checked
# above) and it cannot mis-escape a value the way a printf template can.
if BUILD_COMMIT="$GIT_COMMIT" BUILD_SHORT="$GIT_SHORT" BUILD_DESCRIBE="$GIT_DESCRIBE" \
   BUILD_VERSION="$PKG_VERSION" BUILD_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   node -e 'const f = (v) => (v ? v : null);
process.stdout.write(JSON.stringify({
  commit: f(process.env.BUILD_COMMIT),
  shortCommit: f(process.env.BUILD_SHORT),
  describe: f(process.env.BUILD_DESCRIBE),
  version: f(process.env.BUILD_VERSION),
  installedAt: f(process.env.BUILD_AT),
}, null, 2) + "\n");' > "$INSTALL_DIR/build-info.json"; then
    log_info "  Deployed build: ${GIT_DESCRIBE:-unknown} (${GIT_COMMIT:-no commit})"
else
    log_warn "  Could not write $INSTALL_DIR/build-info.json — build will report unknown"
fi

# Create .env if it doesn't already exist (preserve existing config on upgrades)
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    log_info "Creating default .env configuration..."
    cat > "$INSTALL_DIR/.env" << EOF
# Elegoo Web — Service Configuration
# See README.md for all available options

# Printer connection
PRINTER_IP=172.20.100.236
PRINTER_PASSWORD=123456

# Service port (web UI + API)
SERVICE_PORT=${SERVICE_PORT}

# Camera (auto-detected from printer IP if not set)
# CAMERA_ENABLED=true
# CAMERA_URL=http://172.20.100.236:8080

# Telegram notifications (optional)
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
# PROGRESS_INTERVAL=25

# Data persistence directory
DATA_DIR=/opt/elegooweb/data

# AI monitoring (optional)
# AI_ENABLED=false
# AI_VLM_ENABLED=true
# AI_VLM_API_KEY=
# AI_VLM_PROVIDER=ollama
# AI_VLM_BASE_URL=http://localhost:11434
# AI_VLM_MODEL=llava
# AI_LOCAL_ENABLED=true
# AI_LOCAL_MODEL=Xenova/siglip-base-patch16-224
# AI_INTERVAL=60
EOF
    log_info "  Edit $INSTALL_DIR/.env to configure your printer IP and options"
else
    log_info "Keeping existing .env configuration"
fi

# Build frontend if dist/ doesn't exist
if [[ ! -d "$INSTALL_DIR/dist" ]]; then
    log_info "Building frontend..."
    cd "$INSTALL_DIR"
    pnpm install
    pnpm build
else
    # Production install for server deps only
    log_info "Installing dependencies..."
    cd "$INSTALL_DIR"
    pnpm install --prod
fi

# Set ownership
log_info "Setting permissions..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# Install systemd service
log_info "Installing systemd service..."
cp "$SCRIPT_DIR/contrib/${SERVICE_NAME}.service" /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload

# Enable and (re)start service
log_info "Enabling and restarting service..."
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Check status
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_info "✓ ${SERVICE_NAME} service is running!"
    log_info "  Web UI:  http://localhost:${SERVICE_PORT}"
    log_info "  Config:  $INSTALL_DIR/.env"
    log_info "  Logs:    journalctl -u $SERVICE_NAME -f"
else
    log_warn "Service may not have started correctly"
    log_info "Check logs with: journalctl -u $SERVICE_NAME -e"
fi

log_info "Installation complete!"
