#!/usr/bin/env bash
# Build helper for the Monad NFT dApp: installs OpenZeppelin, seeds the solc
# compiler into Foundry's cache (network is flaky, so retries), then compiles.
set -uo pipefail
cd /home/pkulzz/monad/contracts
export PATH="$HOME/.foundry/bin:$PATH"

echo "=== OpenZeppelin (retry up to 3) ==="
OZOK=0
for i in 1 2 3; do
  rm -rf lib/openzeppelin-contracts
  if git clone --depth 1 --no-recurse-submodules https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts 2>/dev/null; then
    echo "OZ clone succeeded (try $i)"; OZOK=1; break
  fi
  echo "OZ clone failed try $i, retrying"; sleep 3
done
if [ "$OZOK" -ne 1 ]; then echo "OZ install FAILED after retries"; exit 1; fi

echo "=== solc binary (retry up to 3) ==="
SOK=0
for i in 1 2 3; do
  if curl -sSL --max-time 100 -o /tmp/solc-static-linux https://github.com/ethereum/solidity/releases/download/v0.8.27/solc-static-linux 2>/dev/null && [ -s /tmp/solc-static-linux ]; then
    echo "solc download succeeded (try $i)"; SOK=1; break
  fi
  echo "solc download failed try $i, retrying"; sleep 3
done
if [ "$SOK" -ne 1 ]; then echo "solc download FAILED after retries"; exit 1; fi

mkdir -p "$HOME/.svm/0.8.27"
cp /tmp/solc-static-linux "$HOME/.svm/0.8.27/solc-0.8.27"
chmod +x "$HOME/.svm/0.8.27/solc-0.8.27"
echo "seeded solc -> $HOME/.svm/0.8.27/solc-0.8.27"

echo "=== forge build ==="
forge build 2>&1 | tail -30
