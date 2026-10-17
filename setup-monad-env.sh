#!/usr/bin/env bash
# ============================================================
#  Monad Development Environment Installer  (WSL Ubuntu 22.04)
#  Run this AFTER internet egress is restored inside WSL.
#  Writes only to:  ~/.foundry , ~/.local , and $PROJECT_DIR
# ============================================================
set -euo pipefail

PROJECT_DIR="${MONAD_PROJECT_DIR:-$HOME/monad}"

echo ">>> Monad dev-env installer"
echo ">>> Project dir : $PROJECT_DIR"
echo

# --- 0. Preflight: make sure git/curl/build tools exist ------------
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo ">>> Installing base packages (git, curl, build tools)..."
  sudo apt-get update
  sudo apt-get install -y git curl build-essential pkg-config libssl-dev
else
  echo ">>> base packages present (git/curl)"
fi

# --- 1. Node.js ----------------------------------------------------
# Windows Node is already visible from WSL; if you want a native WSL Node,
# uncomment the fnm block below.
if command -v node >/dev/null 2>&1; then
  echo ">>> node available: $(node --version)"
else
  echo ">>> Installing Node 20 via fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$HOME/.local/fnm"
  export PATH="$HOME/.local/fnm:$PATH"
  fnm install 20
  fnm default 20
fi

# --- 2. Foundry (forge / cast / anvil) -----------------------------
if command -v forge >/dev/null 2>&1; then
  echo ">>> Foundry already installed: $(forge --version | head -1)"
else
  echo ">>> Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
fi

# --- 3. Project libraries ------------------------------------------
cd "$PROJECT_DIR"
echo ">>> Installing forge-std lib..."
forge install foundry-rs/forge-std || echo "(forge-std may already exist)"

# --- 4. Done ------------------------------------------------------
echo
echo ">>> ==================================================="
echo ">>> Monad dev environment ready."
echo ">>> Verify:   forge --version ; node --version"
echo ">>> 1. Get testnet MON:  https://testnet.monad.xyz/"
echo ">>> 2. cp .env.example .env  and set PRIVATE_KEY + MONAD_RPC_URL"
echo ">>> 3. Deploy:  forge script script/Deploy.s.sol:Deploy --rpc-url \$MONAD_RPC_URL --broadcast"
echo ">>> ==================================================="
