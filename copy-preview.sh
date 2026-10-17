#!/usr/bin/env bash
SRC=/home/pkulzz/monad
DST="/mnt/c/Users/19635/WorkBuddy AI/2026-10-17-11-04-49/monad-deliverables"
rm -rf "$DST"
mkdir -p "$DST/contracts" "$DST/web/app"
cp "$SRC/README.md" "$SRC/.monskills" "$SRC/monad-networks.json" "$SRC/foundry.lock" "$SRC/setup-monad-env.sh" "$SRC/build-monad-app.sh" "$SRC/scaffold-web.sh" "$DST"/
cp "$SRC/contracts/src/MonadNFT.sol" "$SRC/contracts/script/Deploy.s.sol" "$SRC/contracts/foundry.toml" "$SRC/contracts/.env.example" "$DST/contracts"/
cp "$SRC/web/package.json" "$SRC/web/tsconfig.json" "$SRC/web/next.config.mjs" "$SRC/web/wagmi.ts" "$SRC/web/globals.css" "$SRC/web/.env.example" "$SRC/web/README.md" "$DST/web"/
cp "$SRC/web/app/layout.tsx" "$SRC/web/app/page.tsx" "$DST/web/app"/
echo "=== presentation copy ==="
find "$DST" -type f | sort
