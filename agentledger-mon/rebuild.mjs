// SPDX-License-Identifier: Apache-2.0
// Rebuild a complete evidence bundle for an existing on-chain task.
//
// Why this exists: the browser can only write the bundle while the run is in
// memory. If the page is refreshed — or the final upload fails — the file on disk
// stays at the "partial" version. Everything needed to finish it is on chain, so
// this reconstructs it, re-verifies the digest against the contract, and writes
// the complete bundle. It also doubles as an offline verifier.
//
//   node rebuild.mjs --task-id 0x... --contract 0x...
//   node rebuild.mjs --task-id 0x... --contract 0x... --tx 0x<transfer hash>
//
// Event topics are keccak of the ABI signatures (verified with `cast keccak`):
//   TaskCreated(bytes32,address,bytes32,uint256)
//   PaymentAttested(bytes32,address,uint256,bytes32)
//   EvidenceAnchored(bytes32,bytes32,address)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpTransport } from "./transport.mjs";
import { getTaskData, decodeTask } from "./abi.js";
import { buildMonPaymentEvidence, formatMon, NETWORK } from "./mon-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TOPIC = {
  taskCreated: "0x12ab633eac1892d7f97575279a39bf72113e00503446560e420ed4730f25506d",
  paymentAttested: "0x528d24df0f88f51f690e0ae29e029b39a398d0c7cdbd442b56379679fba1bf79",
  evidenceAnchored: "0x0452dbfc1921f94fd9e8275f67926322880663befdb4ab2a55f104e4655a815c",
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

const TASK_ID = (arg("task-id") || "").toLowerCase();
const CONTRACT = (arg("contract") || "").toLowerCase();
const RPC = arg("rpc", "https://testnet-rpc.monad.xyz");
const OUT_DIR = arg("out", join(here, "evidence"));
const LOOKBACK = BigInt(arg("lookback", "30000"));

if (!/^0x[0-9a-f]{64}$/.test(TASK_ID)) { console.error("--task-id must be 0x + 64 hex"); process.exit(2); }
if (!/^0x[0-9a-f]{40}$/.test(CONTRACT)) { console.error("--contract must be 0x + 40 hex"); process.exit(2); }

const transport = createHttpTransport(RPC, { retries: 4, timeoutMs: 25_000 });

// 1. on-chain task state
let task;
try {
  task = decodeTask(await transport.request("eth_call", [{ to: CONTRACT, data: getTaskData(TASK_ID) }, "latest"]));
} catch (error) {
  console.error(`读不到这个任务（${error.message}）。taskId 或合约地址不对，或者任务不存在。`);
  process.exit(1);
}
console.log("链上任务：", task.status, "·", formatMon(task.amountAtomic), "MON · payer", task.payer);

// 2. locate the transfer transaction
let transferHash = arg("tx");
if (!transferHash) {
  const file = join(OUT_DIR, `${TASK_ID}.json`);
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8"));
    transferHash = existing?.transfer?.transactionHash || existing?.evidence?.transactionHash || null;
  }
  if (!transferHash) {
    for (const name of readdirSync(OUT_DIR).filter(n => n.endsWith(".json"))) {
      try {
        const b = JSON.parse(readFileSync(join(OUT_DIR, name), "utf8"));
        if (b?.taskId === TASK_ID && b?.evidence?.transactionHash) { transferHash = b.evidence.transactionHash; break; }
      } catch { /* skip */ }
    }
  }
}
if (!transferHash) {
  console.error("找不到这笔付款的转账哈希。用 --tx 指定。");
  process.exit(1);
}
console.log("转账交易：", transferHash);

// 3. rebuild the evidence from chain and compare with the anchored digest
const receipt = await transport.request("eth_getTransactionReceipt", [transferHash]);
const tx = await transport.request("eth_getTransactionByHash", [transferHash]);
const block = await transport.request("eth_getBlockByNumber", [receipt.blockNumber, false]);
const built = await buildMonPaymentEvidence({ taskId: TASK_ID, transactionHash: transferHash, receipt, tx, block });

const hashMatches = built.hash === task.evidenceHash;
const refMatches = built.settlementRef === task.settlementRef;
console.log("重建 evidenceHash：", built.hash, hashMatches ? "= 链上 ✔" : `≠ 链上 ✘（链上 ${task.evidenceHash}）`);
console.log("重建 settlementRef：", built.settlementRef, refMatches ? "= 链上 ✔" : "✘");

// 4. recover the other two transaction hashes from events (best effort)
let recordTx = null;
let anchorTx = null;
try {
  const head = BigInt(await transport.request("eth_blockNumber", []));
  const floor = head > LOOKBACK ? head - LOOKBACK : 0n;
  // The public RPC rejects eth_getLogs ranges wider than 100 blocks, so walk
  // backwards from the head in chunks and stop as soon as both events are found.
  const CHUNK = 100n;
  const MAX_CHUNKS = 80;
  let chunks = 0;
  for (let top = head; top >= floor && chunks < MAX_CHUNKS && !(recordTx && anchorTx); top -= CHUNK) {
    const bottom = top - CHUNK + 1n < floor ? floor : top - CHUNK + 1n;
    chunks += 1;
    const logs = await transport.request("eth_getLogs", [{
      address: CONTRACT,
      fromBlock: "0x" + bottom.toString(16),
      toBlock: "0x" + top.toString(16),
      topics: [[TOPIC.paymentAttested, TOPIC.evidenceAnchored], TASK_ID],
    }]);
    for (const log of logs || []) {
      const topic0 = String(log.topics?.[0]).toLowerCase();
      if (topic0 === TOPIC.paymentAttested) recordTx = log.transactionHash;
      if (topic0 === TOPIC.evidenceAnchored) anchorTx = log.transactionHash;
    }
  }
  console.log(`事件回查（扫 ${chunks} 个 100 块窗口）：PaymentAttested ${recordTx ? "✔ " + recordTx : "未找到"} · EvidenceAnchored ${anchorTx ? "✔ " + anchorTx : "未找到"}`);
} catch (error) {
  console.log("事件回查跳过：", error.message);
}

// 5. checks
const checks = [
  { name: "任务已进入 Proven", ok: task.status === "Proven", actual: task.status, expected: "Proven" },
  { name: "链上 payer = 转账发起方", ok: task.payer === built.document.from, actual: task.payer, expected: built.document.from },
  { name: "链上金额 = 转账金额", ok: task.amountAtomic === built.document.valueAtomic, actual: task.amountAtomic, expected: built.document.valueAtomic },
  { name: "链上 settlementRef = 重建值", ok: refMatches, actual: task.settlementRef, expected: built.settlementRef },
  { name: "链上 evidenceHash = 重建值", ok: hashMatches, actual: task.evidenceHash, expected: built.hash },
];

// 6. write the complete bundle
const bundle = {
  schemaVersion: "agentledger.mon-payment-bundle.v1",
  source: "rebuild",
  complete: true,
  anchored: true,
  note: "rebuilt from chain data; digest re-verified against the contract",
  network: NETWORK,
  contract: CONTRACT,
  taskId: TASK_ID,
  transfer: {
    from: built.document.from,
    to: built.document.to,
    valueAtomic: built.document.valueAtomic,
    valueMon: built.document.valueMon,
    transactionHash: built.document.transactionHash,
    blockNumber: built.document.blockNumber,
  },
  evidence: built.document,
  evidenceCanonical: built.canonical,
  evidenceHash: built.hash,
  settlementRef: built.settlementRef,
  transactions: { transfer: transferHash, recordPayment: recordTx, submitEvidence: anchorTx },
  onchain: task,
  checks,
};

mkdirSync(OUT_DIR, { recursive: true });
const target = join(OUT_DIR, `${TASK_ID}.json`);
writeFileSync(target, JSON.stringify(bundle, null, 2) + "\n");

console.log("\n=== 核对 ===");
for (const check of checks) {
  console.log(`  ${check.ok ? "✔" : "✘"} ${check.name}${check.ok ? "" : `  期望 ${check.expected} 实际 ${check.actual}`}`);
}
console.log("\n已写入：", target);
process.exit(checks.every(c => c.ok) ? 0 : 1);
