#!/bin/bash
# Install canarinho — from local checkout or from GitHub.
#
# Usage:
#   curl ... | bash                                  # remote install (GitHub)
#   ./scripts/install.sh                             # run from repo root
#   ./scripts/install.sh --local /path/to/canarinho   # explicit local path
set -euo pipefail

echo "Installing canarinho..."

LOCAL_SOURCE=""
if [ "${1:-}" = "--local" ]; then
  LOCAL_SOURCE="${2:-$(pwd)}"
fi

REPO="igorhvr/canarinho"
BRANCH="main"

if [ -n "$LOCAL_SOURCE" ]; then
  # --- Local install from source checkout ---
  if [ ! -f "$LOCAL_SOURCE/package.json" ]; then
    echo "Error: $LOCAL_SOURCE doesn't look like a canarinho checkout (no package.json)"
    exit 1
  fi
  REPO_DIR="$LOCAL_SOURCE"
  echo "Using local source: $REPO_DIR"
else
  # --- Remote install (clone from GitHub) ---
  INSTALL_DIR="${HOME}/.canarinho/repo"

  if [ -d "$INSTALL_DIR" ]; then
    echo "Updating existing installation..."
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard "origin/$BRANCH"
  else
    echo "Cloning repository..."
    git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
  REPO_DIR="$INSTALL_DIR"
fi

cd "$REPO_DIR"

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
  echo "Error: Node.js >= 22 required. Current: $(node -v 2>/dev/null || echo 'not found')"
  exit 1
fi

# Install and build
echo "Installing dependencies..."
npm install
echo "Building..."
npm run build

# Create symlink
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/bin/canarinho" "$HOME/.local/bin/canarinho"
chmod +x "$HOME/.local/bin/canarinho"

# Install bundled workflows
set +e
"$HOME/.local/bin/canarinho" workflow install --all 2>&1
WF_INSTALL_EXIT=$?
set -e

echo ""
echo "canarinho installed successfully!"
if [ $WF_INSTALL_EXIT -ne 0 ]; then
  echo "Warning: workflow installation failed (exit $WF_INSTALL_EXIT)"
fi
echo ""
echo "Make sure ~/.local/bin is in your PATH if not already."
