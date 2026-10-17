// SPDX-License-Identifier: Apache-2.0
// Read-only watcher / importer for native MON transfers on Monad testnet.
//
// This is the answer to "can the WSL side see a transfer?". It can see
// everything that reaches the chain — but only if something is running to look.
// There is no daemon: you start it, it watches, you stop it.
//
// Two modes:
//   import  one transaction hash  -> evidence for that transfer
//   watch   an address            -> detects incoming transfers, builds evidence
//
// It never signs anything, never needs a private key, and never asks MetaMask
// for permission. Pure eth_getBlockByNumber / eth_getTransactionByHash /
// eth_getTransactionReceipt.
//
// Usage:
//   node watch.mjs --tx 0x...                       # one transfer
//   node watch.mjs --watch --to 0xD723...           # follow from the head
//   node watch.mjs --watch --to 0xD723... --from-block 71770000 --max-blocks 200
//   node watch.mjs --watch --to 0xD723... --follow  # keep running

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpTransport } from "./transport.mjs";
import { sha256Hex, utf8 } from "./sha256.js";
import { buildMonPaymentEvidence, formatMon, NETWORK } from "./mon-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const bigintReplacer = (_key, value) => (typeof value === "bigint" ? value.toString() : value);

function arg(name, fallback = null) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : fallback;
}
const flag = name => process.argv.includes("--" + name);

const RPC = arg("rpc", "https://testnet-rpc.monad.xyz");
const OUT_DIR = arg("out", join(here, "evidence"));
const transport = createHttpTransport(RPC, { retries: 4, timeoutMs: 25_000 });

const hexBig = value => BigInt(value ?? "0x0");
const lower = value => String(value ?? "").toLowerCase();
const short = (value, head = 10, tail = 8) =>
  typeof value === "string" && value.length > head + tail + 3 ? `${value.slice(0, head)}…${value.slice(-tail)}` : String(value);

/**
 * Import mode has no task context, so the task id is derived from the transfer
 * itself. Deterministic: the same transaction always yields the same evidence.
 * It is a local label, NOT a task that exists on chain.
 */
async function derivedTaskId(transactionHash) {
  return sha256Hex(utf8("agentledger.mon-watch.v1|" + lower(transactionHash)));
}

async function evidenceFor(transactionHash, { taskId = null, expectTo = null } = {}) {
  const tx = await transport.request("eth_getTransactionByHash", [transactionHash]);
  if (!tx) throw new Error("transaction not found: " + transactionHash);
  if (!tx.to) throw new Error("this transaction is a contract creation, not a transfer");
  if (hexBig(tx.value) === 0n) throw new Error("this transaction carries no value (value = 0)");
  if (tx.input && tx.input !== "0x") {
    throw new Error("this transaction calls a contract (input is not empty); only plain MON transfers are supported");
  }
  if (expectTo && lower(tx.to) !== lower(expectTo)) {
    throw new Error(`transaction goes to ${tx.to}, not the watched address ${expectTo}`);
  }

  const receipt = await transport.request("eth_getTransactionReceipt", [transactionHash]);
  if (!receipt) throw new Error("no receipt yet — the transaction is still pending");
  const block = await transport.request("eth_getBlockByNumber", [receipt.blockNumber, false]);

  const id = taskId || await derivedTaskId(transactionHash);
  const built = await buildMonPaymentEvidence({ taskId: id, transactionHash, receipt, tx, block });

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${id}.json`);
  writeFileSync(file, JSON.stringify({
    schemaVersion: "agentledger.mon-payment-bundle.v1",
    source: "watch",
    complete: false,
    anchored: false,
    note: "read-only import: evidence built from chain data, not anchored on chain",
    network: NETWORK,
    taskId: id,
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
  }, bigintReplacer, 2) + "\n");

  return { ...built, file, taskId: id, blockNumber: built.document.blockNumber };
}

function report(built) {
  const doc = built.document;
  console.log(
    `  ${c.green}✔${c.reset} ${c.bold}${formatMon(doc.valueAtomic)} MON${c.reset}  ` +
    `${short(doc.from)} → ${short(doc.to)}  ${c.dim}block ${doc.blockNumber}${c.reset}`,
  );
  console.log(`    tx          ${doc.transactionHash}`);
  console.log(`    evidence    ${doc.settlementRef === built.settlementRef ? "" : ""}${built.hash}`);
  console.log(`    settlement  ${built.settlementRef}`);
  console.log(`    saved       ${built.file}`);
}

// ------------------------------------------------------------------ import
async function runImport() {
  const hash = arg("tx");
  if (!hash) throw new Error("--tx <hash> is required in import mode");
  console.log(`\n${c.bold}导入单笔交易${c.reset} ${c.dim}${RPC}${c.reset}`);
  const built = await evidenceFor(hash, {
    taskId: arg("task-id"),
    expectTo: arg("expect-to"),
  });
  report(built);
  console.log(`\n${c.green}PASS${c.reset} — 证据已生成并落盘（只读，未上链锚定）\n`);
}

// ------------------------------------------------------------------- watch
async function runWatch() {
  const target = arg("to");
  if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error("--watch needs --to <address>");

  const follow = flag("follow");
  const maxBlocks = Number(arg("max-blocks", follow ? 0 : 60));
  const headHex = await transport.request("eth_blockNumber", []);
  const head = hexBig(headHex);

  let cursor;
  const fromArg = arg("from-block");
  if (fromArg && fromArg !== "latest") cursor = BigInt(fromArg) - 1n;
  else cursor = head - 1n;

  console.log(`\n${c.bold}监听原生 MON 转入${c.reset}`);
  console.log(`  ${c.dim}rpc${c.reset}        ${RPC}`);
  console.log(`  ${c.dim}address${c.reset}    ${target}`);
  console.log(`  ${c.dim}head${c.reset}       ${head}`);
  console.log(`  ${c.dim}from block${c.reset} ${cursor + 1n}`);
  console.log(`  ${c.dim}mode${c.reset}       ${follow ? "follow（Ctrl+C 结束）" : `扫 ${maxBlocks} 个块`}`);
  console.log("");

  let scanned = 0;
  let found = 0;

  for (;;) {
    const latestHex = await transport.request("eth_blockNumber", []);
    const latest = hexBig(latestHex);

    while (cursor < latest && (follow || scanned < maxBlocks)) {
      const blockNumber = cursor + 1n;
      const block = await transport.request("eth_getBlockByNumber", ["0x" + blockNumber.toString(16), true]);
      cursor = blockNumber;
      scanned += 1;
      if (!block || !Array.isArray(block.transactions)) continue;

      for (const tx of block.transactions) {
        if (typeof tx !== "object" || !tx) continue;
        if (!tx.to || lower(tx.to) !== lower(target)) continue;
        if (hexBig(tx.value) === 0n) continue;
        try {
          const built = await evidenceFor(tx.hash, { expectTo: target });
          found += 1;
          report(built);
        } catch (error) {
          console.log(`  ${c.yellow}!${c.reset} ${tx.hash} 跳过：${error.message}`);
        }
      }
    }

    if (!follow) break;
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  console.log(`\n扫了 ${scanned} 个块，发现 ${found} 笔转入 ${target} 的 MON 转账`);
  console.log(found > 0
    ? `${c.green}PASS${c.reset} — 证据已落盘到 ${OUT_DIR}\n`
    : `${c.yellow}没有发现新转入${c.reset}。先让程序跑起来，再去 MetaMask 转账，或者用 --from-block 指定更早的起点。\n`);
}

// -------------------------------------------------------------------- main
const mode = flag("watch") ? "watch" : "import";
(mode === "watch" ? runWatch() : runImport()).catch(error => {
  console.error(`\n${c.red}FAILED${c.reset} ${error.message}\n`);
  process.exit(1);
});
