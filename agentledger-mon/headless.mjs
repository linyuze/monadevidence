// SPDX-License-Identifier: Apache-2.0
// Headless runner — the automation proof.
//
// Same pipeline.mjs that the browser uses, but the transport is a plain node
// instead of MetaMask. Anvil signs for its own unlocked dev accounts, so the
// whole chain of steps runs with ZERO clicks:
//
//   deploy -> createTask -> transfer 1 MON (A -> B) -> receipt -> balance delta
//          -> evidence -> recordPayment -> submitEvidence -> readback -> verify
//
// Then it writes the evidence JSON to disk. If this passes, the only thing the
// browser adds is the human approval on each eth_sendTransaction — the logic
// itself has no manual handoff left.
//
// Usage:
//   node headless.mjs                       # anvil on 127.0.0.1:18545
//   node headless.mjs --rpc <url> --amount 1 --out evidence

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { createHttpTransport } from "./transport.mjs";
import { runMonPayment } from "./pipeline.mjs";
import { deployData } from "./abi.js";
import { parseMon, formatMon } from "./mon-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const RPC = arg("rpc", "http://127.0.0.1:18545");
const AMOUNT = arg("amount", "1");
const OUT_DIR = arg("out", join(here, "evidence"));
const CONTRACT = arg("contract", null);
// anvil's first two default accounts
const ACCOUNT_A = arg("from", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const ACCOUNT_B = arg("to", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" };
// Step payloads carry bigint balances; JSON has no bigint, so stringify them.
const bigintReplacer = (_key, value) => (typeof value === "bigint" ? value.toString() : value);
const line = (label, value) => console.log(`  ${c.dim}${label.padEnd(14)}${c.reset}${value}`);

const transport = createHttpTransport(RPC);

async function waitReceipt(hash, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await transport.request("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error("receipt timeout for " + hash);
}

async function deploy(artifact, recorder, from) {
  const hash = await transport.request("eth_sendTransaction", [{
    from, data: deployData(artifact.bytecode, recorder), gas: "0x5b8d80",
  }]);
  const receipt = await waitReceipt(hash);
  if (receipt.status !== "0x1") throw new Error("deployment reverted");
  return { address: receipt.contractAddress, hash };
}

async function main() {
  console.log(`\n${c.bold}AgentLedger · MON 支付流水线（headless）${c.reset}`);
  line("rpc", RPC);
  line("amount", AMOUNT + " MON");
  line("A (payer)", ACCOUNT_A);
  line("B (payee)", ACCOUNT_B);

  const chainId = await transport.request("eth_chainId", []);
  if (BigInt(chainId) !== 10143n) {
    throw new Error(`node must report chainId 10143 (0x279f), got ${chainId}. Start anvil with --chain-id 10143.`);
  }

  let contract = CONTRACT;
  if (!contract) {
    const artifact = JSON.parse(readFileSync(join(here, "artifact.json"), "utf8"));
    console.log(`\n${c.cyan}部署合约${c.reset} ${c.dim}(recorder = A，这样 A 才能写 recordPayment)${c.reset}`);
    const deployed = await deploy(artifact, ACCOUNT_A, ACCOUNT_A);
    contract = deployed.address;
    line("contract", contract);
    line("tx", deployed.hash);
  } else {
    line("contract", contract);
  }

  const amountAtomic = parseMon(AMOUNT);
  const taskId = "0x" + randomBytes(32).toString("hex");

  console.log(`\n${c.bold}流水线${c.reset}`);
  const result = await runMonPayment({
    transport,
    contract,
    taskId,
    description: `MON 支付测试：${AMOUNT} MON`,
    from: ACCOUNT_A,
    to: ACCOUNT_B,
    valueAtomic: amountAtomic,
    maxBudgetAtomic: amountAtomic,
    timeoutMs: 60_000,
    intervalMs: 400,
  }, {
    onEvidence: built => {
      try {
        mkdirSync(OUT_DIR, { recursive: true });
        const file = join(OUT_DIR, `${built.taskId}.json`);
        writeFileSync(file, JSON.stringify({
          schemaVersion: "agentledger.mon-payment-bundle.v1",
          complete: false,
          network: built.network,
          contract: built.contract,
          taskId: built.taskId,
          transfer: { transactionHash: built.transferHash },
          evidence: built.evidence,
          evidenceCanonical: built.canonical,
          evidenceHash: built.hash,
          settlementRef: built.settlementRef,
        }, bigintReplacer, 2) + "\n");
        console.log(`      ${c.dim}partial evidence written: ${file}${c.reset}`);
      } catch (error) {
        console.error("partial evidence write failed: " + error.message);
      }
    },
    onStep: step => {
      const badge = step.status === "ok" ? `${c.green}✔${c.reset}`
        : step.status === "fail" ? `${c.red}✘${c.reset}`
        : step.status === "warn" ? `${c.yellow}!${c.reset}`
        : `${c.dim}…${c.reset}`;
      console.log(`  ${badge} ${step.id.padEnd(15)} ${c.dim}${step.rpc || ""}${c.reset}`);
      if (step.detail) console.log(`      ${step.detail}`);
    },
  });

  // ---- persist evidence -------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${taskId}.json`);
  const bundle = {
    schemaVersion: "agentledger.mon-payment-bundle.v1",
    complete: true,
    network: result.network,
    contract: result.contract,
    taskId: result.taskId,
    transfer: {
      from: result.payer, to: result.payee,
      valueAtomic: result.amountAtomic, valueMon: result.amountMon,
      transactionHash: result.transferHash,
      blockNumber: result.evidence.blockNumber,
    },
    evidence: result.evidence,
    evidenceCanonical: result.evidenceCanonical,
    evidenceHash: result.evidenceHash,
    settlementRef: result.settlementRef,
    transactions: {
      transfer: result.transferHash,
      recordPayment: result.recordHash,
      submitEvidence: result.anchorHash,
    },
    onchain: result.task,
    checks: result.checks,
    steps: result.steps,
  };
  writeFileSync(file, JSON.stringify(bundle, bigintReplacer, 2) + "\n");

  console.log(`\n${c.bold}结果${c.reset}`);
  line("taskId", result.taskId);
  line("transfer", result.transferHash);
  line("evidenceHash", result.evidenceHash);
  line("settlementRef", result.settlementRef);
  line("onchain", `${result.task.status} · ${formatMon(result.task.amountAtomic)} MON · payer ${result.task.payer}`);
  line("evidence file", file);

  const failed = result.checks.filter(check => !check.ok);
  console.log(`\n${c.bold}一致性核对${c.reset} ${result.checks.length - failed.length}/${result.checks.length}`);
  for (const check of result.checks) {
    console.log(`  ${check.ok ? c.green + "✔" + c.reset : c.red + "✘" + c.reset} ${check.name}`);
    if (!check.ok) console.log(`      expected ${check.expected}, got ${check.actual}`);
  }

  if (failed.length) {
    console.log(`\n${c.red}FAILED${c.reset}\n`);
    process.exit(1);
  }
  console.log(`\n${c.green}${c.bold}PASS${c.reset} — 真实 1 MON 转账已完成，证据已生成并锚定上链。\n`);
}

main().catch(error => {
  console.error(`\n${c.red}FAILED${c.reset} ${error.message}`);
  if (error.cause?.message && error.cause.message !== error.message) {
    console.error(`${c.dim}${error.cause.message}${c.reset}`);
  }
  process.exit(1);
});
