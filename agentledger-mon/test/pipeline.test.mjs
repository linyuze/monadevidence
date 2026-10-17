// SPDX-License-Identifier: Apache-2.0
// Integration tests for the MON payment pipeline.
//
// The interesting ones run against a real EVM: a real native transfer of 1 MON
// between two accounts, then the evidence is rebuilt from chain data alone and
// must produce the same digest. Requires anvil on 127.0.0.1:18545 with
// --chain-id 10143 (see test/run-anvil.sh). Read-only tests still run without it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { createHttpTransport } from "../transport.mjs";
import { runMonPayment } from "../pipeline.mjs";
import { deployData, recordPaymentData, createTaskData, getTaskData, decodeTask } from "../abi.js";
import {
  parseMon, formatMon, monSettlementRef, buildMonPaymentEvidence,
  canonicalMonPayment, monPaymentHash, verifyMonPaymentEvidence, PAYMENT_SCHEMA,
} from "../mon-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.AGENTLEDGER_ANVIL_RPC || "http://127.0.0.1:18545";
const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ONE = 10n ** 18n;

const transport = createHttpTransport(RPC, { retries: 1, timeoutMs: 8000 });
const artifact = JSON.parse(readFileSync(join(here, "..", "artifact.json"), "utf8"));

const newTaskId = () => "0x" + randomBytes(32).toString("hex");
const hexBig = value => BigInt(value ?? "0x0");

async function chainAvailable() {
  try {
    const id = await transport.request("eth_chainId", []);
    return BigInt(id) === 10143n;
  } catch {
    return false;
  }
}

async function waitReceipt(hash, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await transport.request("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("receipt timeout " + hash);
}

async function deploy(recorder, from = A) {
  const hash = await transport.request("eth_sendTransaction", [{
    from, data: deployData(artifact.bytecode, recorder), gas: "0x5b8d80",
  }]);
  const receipt = await waitReceipt(hash);
  assert.equal(receipt.status, "0x1", "deployment must succeed");
  return receipt.contractAddress;
}

/** Simulate a call and expect it to revert; returns the revert message. */
async function expectRevert({ from, to, data }) {
  try {
    await transport.request("eth_call", [{ from, to, data }, "latest"]);
  } catch (error) {
    return String(error.message || error);
  }
  throw new Error("expected the call to revert, but it succeeded");
}

// ---------------------------------------------------------------- pure tests

test("parseMon / formatMon are exact and reject sloppy input", () => {
  assert.equal(parseMon("1"), ONE);
  assert.equal(parseMon("100"), 100n * ONE);
  assert.equal(parseMon("0.5"), 5n * 10n ** 17n);
  assert.equal(parseMon("0.000000000000000001"), 1n);
  assert.equal(formatMon(ONE), "1");
  assert.equal(formatMon(5n * 10n ** 17n), "0.5");
  assert.equal(formatMon(1n), "0.000000000000000001");

  // Surrounding whitespace is trimmed on purpose (it comes from an input field).
  for (const bad of ["", "-1", "1.1234567890123456789", "1e18", "01", "1,5", null, undefined]) {
    assert.throws(() => parseMon(bad), /MON amount/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(parseMon(" 1 "), ONE);
  // round-trip
  for (const text of ["1", "2.5", "0.0000001", "123456789.123456789"]) {
    assert.equal(formatMon(parseMon(text)), text.replace(/\.?0+$/, "") || "0");
  }
});

test("settlementRef is deterministic and transaction-specific", async () => {
  const tx = "0x" + "ab".repeat(32);
  const other = "0x" + "cd".repeat(32);
  const first = await monSettlementRef({ transaction: tx });
  const again = await monSettlementRef({ transaction: tx.toUpperCase().replace("0X", "0x") });
  const second = await monSettlementRef({ transaction: other });
  assert.equal(first, again, "case must not matter");
  assert.notEqual(first, second);
  assert.match(first, /^0x[0-9a-f]{64}$/);
});

test("canonical payment evidence rejects tampering", async () => {
  const base = {
    asset: "MON",
    blockHash: "0x" + "11".repeat(32),
    blockNumber: "7",
    effectiveGasPriceWei: "1000",
    feeWei: "21000000",
    from: A.toLowerCase(),
    gasUsed: "21000",
    network: "eip155:10143",
    nonce: "3",
    observedAt: "2026-10-17T00:00:00.000Z",
    schemaVersion: PAYMENT_SCHEMA,
    settlementRef: "0x" + "22".repeat(32),
    status: "success",
    taskId: "0x" + "33".repeat(32),
    to: B.toLowerCase(),
    transactionHash: "0x" + "44".repeat(32),
    valueAtomic: ONE.toString(),
    valueMon: "1",
  };
  const canonical = canonicalMonPayment(base);
  assert.equal(canonical, canonicalMonPayment({ ...base }));
  assert.equal(await monPaymentHash(base), await monPaymentHash({ ...base }));

  assert.throws(() => canonicalMonPayment({ ...base, extra: 1 }), /unexpected or missing/);
  assert.throws(() => canonicalMonPayment({ ...base, schemaVersion: "v2" }), /unsupported/);
  assert.throws(() => canonicalMonPayment({ ...base, asset: "USDC" }), /asset/);
  assert.throws(() => canonicalMonPayment({ ...base, observedAt: "2026-10-17 00:00:00" }), /observedAt/);
  assert.throws(() => canonicalMonPayment({ ...base, from: "0x1234" }), /invalid from/);
  assert.throws(() => canonicalMonPayment({ ...base, valueMon: "2" }), /valueMon/);
  // a changed amount must change the digest
  const bumped = { ...base, valueAtomic: (2n * ONE).toString(), valueMon: "2" };
  assert.notEqual(await monPaymentHash(base), await monPaymentHash(bumped));
});

// ------------------------------------------------------- on-chain integration

test("real 1 MON transfer A -> B, evidence anchored on chain", async t => {
  if (!(await chainAvailable())) {
    t.skip(`no anvil with chainId 10143 at ${RPC}`);
    return;
  }

  const contract = await deploy(A);
  const taskId = newTaskId();
  const before = hexBig(await transport.request("eth_getBalance", [B, "latest"]));

  const result = await runMonPayment({
    transport,
    contract,
    taskId,
    description: "MON 支付测试：1 MON",
    from: A,
    to: B,
    valueAtomic: ONE,
    maxBudgetAtomic: ONE,
    timeoutMs: 30_000,
    intervalMs: 250,
  });

  // 1. the transfer really happened
  const after = hexBig(await transport.request("eth_getBalance", [B, "latest"]));
  assert.equal(after - before, ONE, "B must gain exactly 1 MON");
  assert.equal(result.amountAtomic, ONE.toString());
  assert.equal(result.amountMon, "1");

  // 2. the evidence describes that exact transfer
  assert.equal(result.evidence.from, A.toLowerCase());
  assert.equal(result.evidence.to, B.toLowerCase());
  assert.equal(result.evidence.valueAtomic, ONE.toString());
  assert.equal(result.evidence.transactionHash, result.transferHash.toLowerCase());
  assert.equal(result.evidence.gasUsed, "21000", "a plain value transfer costs 21000 gas");
  assert.equal(result.evidence.status, "success");
  assert.equal(result.evidence.schemaVersion, PAYMENT_SCHEMA);

  // 3. chain state agrees with the local evidence
  assert.equal(result.task.status, "Proven");
  assert.equal(result.task.payer, A.toLowerCase());
  assert.equal(result.task.amountAtomic, ONE.toString());
  assert.equal(result.task.settlementRef, result.settlementRef);
  assert.equal(result.task.evidenceHash, result.evidenceHash);
  assert.equal(result.checks.every(check => check.ok), true, "all consistency checks pass");

  // 4. every step reported ok
  assert.equal(result.steps.filter(step => step.status === "fail").length, 0);
  assert.equal(result.steps.filter(step => step.status === "ok").length, 10);
});

test("evidence is reproducible from chain data alone", async t => {
  if (!(await chainAvailable())) {
    t.skip(`no anvil with chainId 10143 at ${RPC}`);
    return;
  }

  const contract = await deploy(A);
  const taskId = newTaskId();
  const result = await runMonPayment({
    transport, contract, taskId, description: "reproduce", from: A, to: B,
    valueAtomic: ONE, maxBudgetAtomic: ONE, timeoutMs: 30_000, intervalMs: 250,
  });

  // Rebuild from nothing but the tx hash — no local state involved.
  const receipt = await transport.request("eth_getTransactionReceipt", [result.transferHash]);
  const tx = await transport.request("eth_getTransactionByHash", [result.transferHash]);
  const block = await transport.request("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const rebuilt = await buildMonPaymentEvidence({
    taskId, transactionHash: result.transferHash, receipt, tx, block,
  });

  assert.equal(rebuilt.canonical, result.evidenceCanonical);
  assert.equal(rebuilt.hash, result.evidenceHash);
  assert.equal(rebuilt.settlementRef, result.settlementRef);

  // The verifier accepts a faithful copy and rejects a doctored one.
  const good = await verifyMonPaymentEvidence(
    { ...result.evidence, __hash: result.evidenceHash },
    { receipt, tx, block, taskId },
  );
  assert.equal(good.ok, true);
  assert.equal(good.classification, "EVIDENCE_REPRODUCIBLE");
  assert.equal(good.hash, result.evidenceHash);

  const bad = await verifyMonPaymentEvidence(
    { ...result.evidence, valueAtomic: (2n * ONE).toString(), valueMon: "2", __hash: result.evidenceHash },
    { receipt, tx, block, taskId },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.classification, "EVIDENCE_MUTATED");
  assert.deepEqual(bad.fields, ["valueAtomic", "valueMon"]);

  // A taskId swap is caught too, as long as the caller pins the authoritative one.
  const wrongTask = await verifyMonPaymentEvidence(
    { ...result.evidence, taskId: newTaskId() },
    { receipt, tx, block, taskId },
  );
  assert.equal(wrongTask.ok, false);
  assert.equal(wrongTask.classification, "EVIDENCE_MUTATED");
});

test("evidence survives a failed anchor step", async t => {
  if (!(await chainAvailable())) {
    t.skip(`no anvil with chainId 10143 at ${RPC}`);
    return;
  }

  // recorder = B, so A can create the task and move the money, but the
  // recordPayment step reverts. The transfer is already on chain at that point,
  // so the evidence for it must already be on disk.
  const contract = await deploy(B);
  const taskId = newTaskId();
  let captured = null;

  await assert.rejects(
    runMonPayment({
      transport, contract, taskId, description: "partial", from: A, to: B,
      valueAtomic: ONE, maxBudgetAtomic: ONE, timeoutMs: 30_000, intervalMs: 250,
    }, {
      onEvidence: built => { captured = built; },
    }),
    /recordPayment/,
  );

  assert.ok(captured, "onEvidence must fire before recordPayment");
  assert.equal(captured.taskId, taskId);
  assert.match(captured.hash, /^0x[0-9a-f]{64}$/);
  assert.match(captured.settlementRef, /^0x[0-9a-f]{64}$/);
  assert.equal(captured.evidence.valueAtomic, ONE.toString());
  assert.equal(captured.evidence.to, B.toLowerCase());

  // And it is still reproducible from chain data alone.
  const receipt = await transport.request("eth_getTransactionReceipt", [captured.transferHash]);
  const tx = await transport.request("eth_getTransactionByHash", [captured.transferHash]);
  const block = await transport.request("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const rebuilt = await buildMonPaymentEvidence({
    taskId, transactionHash: captured.transferHash, receipt, tx, block,
  });
  assert.equal(rebuilt.hash, captured.hash);
});

test("settlementRef replay is refused by the contract", async t => {
  if (!(await chainAvailable())) {
    t.skip(`no anvil with chainId 10143 at ${RPC}`);
    return;
  }

  const contract = await deploy(A);
  const first = newTaskId();
  const result = await runMonPayment({
    transport, contract, taskId: first, description: "replay-1", from: A, to: B,
    valueAtomic: ONE, maxBudgetAtomic: ONE, timeoutMs: 30_000, intervalMs: 250,
  });

  // A second task, reusing the already-consumed settlementRef.
  const second = newTaskId();
  const create = await transport.request("eth_sendTransaction", [{
    from: A, to: contract, data: createTaskData(second, "0x" + "5a".repeat(32), ONE),
  }]);
  assert.equal((await waitReceipt(create)).status, "0x1");

  const message = await expectRevert({
    from: A,
    to: contract,
    data: recordPaymentData(second, A, ONE, result.settlementRef),
  });
  assert.match(message, /revert/i, "reusing a settlementRef must revert");
});

test("maxBudget is enforced on chain", async t => {
  if (!(await chainAvailable())) {
    t.skip(`no anvil with chainId 10143 at ${RPC}`);
    return;
  }

  const contract = await deploy(A);
  const taskId = newTaskId();
  const create = await transport.request("eth_sendTransaction", [{
    from: A, to: contract, data: createTaskData(taskId, "0x" + "6b".repeat(32), ONE),
  }]);
  assert.equal((await waitReceipt(create)).status, "0x1");

  const sref = await monSettlementRef({ transaction: "0x" + "7c".repeat(32) });
  const message = await expectRevert({
    from: A, to: contract, data: recordPaymentData(taskId, A, 2n * ONE, sref),
  });
  assert.match(message, /revert/i, "2 MON against a 1 MON budget must revert");

  // and the boundary value is accepted
  const ok = await transport.request("eth_sendTransaction", [{
    from: A, to: contract, data: recordPaymentData(taskId, A, ONE, sref),
  }]);
  assert.equal((await waitReceipt(ok)).status, "0x1");

  const task = decodeTask(await transport.request("eth_call", [{ to: contract, data: getTaskData(taskId) }, "latest"]));
  assert.equal(task.status, "Paid");
  assert.equal(task.amountAtomic, ONE.toString());
});

test("recordPayment requires the configured recorder", async t => {
  if (!(await chainAvailable())) {
    t.skip(`no anvil with chainId 10143 at ${RPC}`);
    return;
  }

  // Deployed with B as recorder; A tries to write the payment.
  const contract = await deploy(B);
  const taskId = newTaskId();
  const create = await transport.request("eth_sendTransaction", [{
    from: A, to: contract, data: createTaskData(taskId, "0x" + "8d".repeat(32), ONE),
  }]);
  assert.equal((await waitReceipt(create)).status, "0x1");

  const sref = await monSettlementRef({ transaction: "0x" + "9e".repeat(32) });
  const message = await expectRevert({
    from: A, to: contract, data: recordPaymentData(taskId, A, ONE, sref),
  });
  assert.match(message, /revert/i, "a non-recorder caller must be rejected");
});

test("pipeline refuses a payer that equals the payee", async t => {
  if (!(await chainAvailable())) {
    t.skip(`no anvil with chainId 10143 at ${RPC}`);
    return;
  }
  const contract = await deploy(A);
  await assert.rejects(
    runMonPayment({
      transport, contract, taskId: newTaskId(), description: "self", from: A, to: A,
      valueAtomic: ONE, timeoutMs: 5000, intervalMs: 250,
    }),
    /two different accounts/,
  );
});
