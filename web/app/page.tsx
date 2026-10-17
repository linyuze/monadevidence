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
