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
