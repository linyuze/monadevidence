#!/usr/bin/env bash
# Scaffold the frontend (web/) + .monskills metadata + root README for the
# Monad NFT dApp, following the monskills scaffold skill (Next.js + wagmi +
# Monad testnet, useSendTransactionSync, ES2020 tsconfig gotcha).
set -uo pipefail
cd /home/pkulzz/monad

# ---------------- .monskills metadata ----------------
cat > .monskills <<'EOF'
built-with=monskills
chain=monad-testnet
EOF

# ---------------- web/ structure ----------------
mkdir -p web/app web/components web/abi

cat > web/package.json <<'EOF'
{
  "name": "monad-nft-app",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "wagmi": "^2.12.17",
    "viem": "^2.21.19",
    "@tanstack/react-query": "^5.51.23"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "@types/node": "^20.14.15",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0"
  }
}
EOF

# tsconfig: bump target to ES2020 (viem/wagmi use BigInt literals) — scaffold gotcha
cat > web/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
EOF

cat > web/next.config.mjs <<'EOF'
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
EOF

cat > web/globals.css <<'EOF'
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; background: #0b0e14; color: #e6e6e6; }
button { cursor: pointer; padding: 0.6rem 1.1rem; border-radius: 8px; border: 0; background: #6d5efc; color: #fff; font-size: 1rem; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.card { max-width: 560px; margin: 0 auto; background: #151a23; padding: 1.5rem; border-radius: 14px; }
code { background: #222; padding: 0.1rem 0.3rem; border-radius: 4px; }
EOF

# wagmi config: Monad testnet defined inline (no external chain dep)
cat > web/wagmi.ts <<'EOF'
import { http, createConfig } from "wagmi";
import { defineChain } from "viem";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: {
    default: { name: "MonadExplorer", url: "https://testnet.monadexplorer.com" },
  },
});

export const config = createConfig({
  chains: [monadTestnet],
  transports: { [monadTestnet.id]: http() },
});
EOF

cat > web/app/layout.tsx <<'EOF'
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "../wagmi";
import "./globals.css";

const queryClient = new QueryClient();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WagmiProvider config={config}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </WagmiProvider>
      </body>
    </html>
  );
}
EOF

cat > web/app/page.tsx <<'EOF'
"use client";
import { useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { injected } from "wagmi/connectors";

// TODO: set this to your deployed MonadNFT address after `forge script` deploy.
const NFT_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

const NFT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContract, data: hash, isPending: minting } = useWriteContract();
  const { isLoading: txLoading } = useWaitForTransactionReceipt({ hash });

  const [minted, setMinted] = useState<string>("");

  function mint() {
    if (!address) return;
    writeContract(
      {
        address: NFT_ADDRESS,
        abi: NFT_ABI,
        functionName: "mint",
        args: [address],
      },
      {
        onSuccess: (txHash) => {
          // Monad: prefer useSendTransactionSync in production for instant receipt.
          console.log("tx:", txHash);
        },
      }
    );
  }

  return (
    <div className="card">
      <h1>Monad NFT Mint</h1>
      <p>Network: Monad Testnet (chainId 10143). Get testnet MON from the faucet first.</p>

      {!isConnected ? (
        <button onClick={() => connect({ connector: injected() })} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect Wallet"}
        </button>
      ) : (
        <>
          <p>
            Connected: <code>{address}</code>
          </p>
          <button onClick={mint} disabled={minting || txLoading || NFT_ADDRESS.startsWith("0x0000")}>
            {minting || txLoading ? "Minting…" : "Mint NFT"}
          </button>
          <button onClick={() => disconnect()} style={{ background: "#333", marginLeft: 8 }}>
            Disconnect
          </button>
          {hash && <p>Tx: <code>{hash}</code></p>}
        </>
      )}
    </div>
  );
}
EOF

cat > web/.env.example <<'EOF'
# Optional: override the Monad testnet RPC used by the frontend
NEXT_PUBLIC_MONAD_RPC=https://testnet-rpc.monad.xyz
EOF

cat > web/README.md <<'EOF'
# web/ — Monad NFT frontend

Next.js + wagmi + viem, configured for **Monad Testnet (chainId 10143)**.

## Run
```bash
npm install
# set NFT_ADDRESS in app/page.tsx to your deployed contract
npm run dev
```

## Wallet auth (upgrade)
The scaffold uses the injected connector (MetaMask). For embedded MPC wallets
(email / passkey / social login) + external-wallet connect, follow the
`wallet-integration/` monskill and the Para workflow:
```bash
npm install -g @getpara/cli && para login
para init && para doctor   # against this already-scaffolded frontend
```
Apply the Monad-specific wagmi patch (`references/para-monad-wiring.md`) so
`monadTestnet` is registered in the Para/viem config.
EOF

# ---------------- root README ----------------
cat > README.md <<'EOF'
# Monad NFT dApp — built with MONSKILLS

A from-scratch Monad app scaffold following the `monskills` `scaffold` skill:
an OpenZeppelin ERC-721 NFT minting contract + a Next.js/wagmi frontend,
targeting **Monad Testnet (chainId 10143)**.

## Layout
```
monad/                      (project root, git repo)
  monskills/                local MONSKILLS (router + topic skills)
  contracts/                Foundry project
    src/MonadNFT.sol        OZ ERC-721 minting contract
    script/Deploy.s.sol     deploy to Monad testnet
    lib/                    forge-std + openzeppelin-contracts
    foundry.toml            Monad testnet RPC, chainId 10143
  web/                      Next.js + wagmi frontend (Monad testnet)
  .monskills                built-with=monskills, chain=monad-testnet
```

## End-to-end (端到端)
Dev machine (WSL) → Solidity (forge build) → sign tx → JSON-RPC HTTPS to
`testnet-rpc.monad.xyz` → Monad parallel-EVM chain → explorer (gmonads.com /
monadexplorer) → MetaMask + wagmi frontend read/write the same chain.

## 1. Contracts
```bash
cd contracts
forge build                       # ✅ compiles (Solc 0.8.27)
cp .env.example .env              # set PRIVATE_KEY + MONAD_RPC_URL
forge script script/Deploy.s.sol:Deploy --rpc-url $MONAD_RPC_URL --broadcast
```
Get testnet MON from the faucet: https://testnet.monad.xyz/

## 2. Verify (all 3 explorers, one call)
Use the verification API (preferred over `forge verify-contract`):
```bash
forge verify-contract <ADDR> src/MonadNFT.sol:MonadNFT --chain 10143 --show-standard-json-input > /tmp/in.json
curl -X POST https://agents.devnads.com/v1/verify -H "Content-Type: application/json" -d @/tmp/in.json
```

## 3. Frontend
```bash
cd web
npm install
# edit app/page.tsx: set NFT_ADDRESS to your deployed contract
npm run dev
```

## 4. Wallet auth (optional, needs your credentials)
Alchemy Agent Wallet for deploys: see `monskills/skills/wallet/`.
Para embedded wallets for the frontend: see `monskills/skills/wallet-integration/`.
These require `alchemy auth` / `para login` — run those yourself; the agent will
not do it on your behalf.

## Environment notes
- Foundry installed at `~/.foundry/bin` (forge/cast/anvil v1.8.5).
- MONSKILLS cloned to `monskills/` and also registered in WorkBuddy
  (`~/.workbuddy-ai/skills/`) — start from the `monskill` router.
- solc 0.8.27 seeded into `~/.svm/0.8.27` (network was flaky; re-run
  `bash build-monad-app.sh` if you change the contract and need a rebuild).
EOF

echo "scaffold files written"
find web -type f | sort
echo "---"; cat .monskills
