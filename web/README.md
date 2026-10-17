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
