// SPDX-License-Identifier: Apache-2.0
// Parity test: the browser modules must reproduce the project's existing
// outputs byte-for-byte. Nothing here writes to a chain.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  canonicalEvidence, evidenceHash, calculateTextStats, serializeToolOutput,
  settlementRefOf, verifyUsdcReceipt, USDC_CONTRACT, TRANSFER_TOPIC,
} from "../evidence.js";
import { sha256Bytes, sha256Hex, toHex, utf8 } from "../sha256.js";

import {
  canonicalEvidence as refCanonical, evidenceHash as refHash,
} from "../../agentledger/tools/evidence.mjs";
import { calculateTextStats as refStats } from "../../agentledger/examples/verifier/tools/run-demo-task.mjs";
import { verifyReceipt } from "../../agentledger/tools/settlement.mjs";

const nodeSha = data => "0x" + createHash("sha256").update(data).digest("hex");
const SAMPLE = {
  completedAt: "2026-10-17T06:00:00.000Z",
  executor: "agentledger-wallet-panel",
  inputSha256: "0x" + "11".repeat(32),
  modelOrTool: "deterministic-text-stats",
  outputSha256: "0x" + "22".repeat(32),
  schemaVersion: "agentledger.evidence.v1",
  taskId: "0x" + "33".repeat(32),
};

test("pure-JS SHA-256 matches node:crypto for many lengths", () => {
  for (const size of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
    assert.equal(toHex(sha256Bytes(data)), nodeSha(data), "length " + size);
  }
});

test("canonicalEvidence output is identical to tools/evidence.mjs", () => {
  assert.equal(canonicalEvidence(SAMPLE), refCanonical(SAMPLE));
});

test("evidenceHash is identical to tools/evidence.mjs", async () => {
  assert.equal(await evidenceHash(SAMPLE), refHash(SAMPLE));
  assert.equal(await evidenceHash(SAMPLE), nodeSha(Buffer.from(refCanonical(SAMPLE), "utf8")));
});

test("canonicalEvidence rejects the same malformed inputs", () => {
  const cases = [
    { ...SAMPLE, schemaVersion: "agentledger.evidence.v2" },
    { ...SAMPLE, extra: 1 },
    { ...SAMPLE, taskId: "0x" + "AA".repeat(32) },
    { ...SAMPLE, completedAt: "2026-10-17T06:00:00Z" },
    { ...SAMPLE, executor: "   " },
  ];
  for (const value of cases) {
    assert.throws(() => canonicalEvidence(value));
    assert.throws(() => refCanonical(value));
  }
});

test("deterministic text stats match run-demo-task.mjs", async () => {
  const inputs = [
    "hello world\n",
    "a\nb\nc",
    "中文 测试\r\n第二行\n",
    "one",
    "  spaced   out  ",
  ];
  for (const text of inputs) {
    const bytes = utf8(text);
    const mine = await calculateTextStats(bytes);
    const reference = refStats(Buffer.from(bytes));
    assert.deepEqual(mine, reference, "input: " + JSON.stringify(text));
  }
});

test("tool output bytes are identical to what the CLI writes", async () => {
  const bytes = utf8("hello world\n");
  const result = await calculateTextStats(bytes);
  const mine = serializeToolOutput(result);
  const cli = Buffer.from(JSON.stringify(refStats(Buffer.from(bytes)), null, 2) + "\n", "utf8");
  assert.equal(toHex(mine), "0x" + cli.toString("hex"));
  assert.equal(await sha256Hex(mine), nodeSha(cli));
});

test("settlementRef matches tools/settlement.mjs for the same receipt", async () => {
  const payer = "0x" + "11".repeat(20);
  const payTo = "0x" + "22".repeat(20);
  const txHash = "0x" + "ab".repeat(32);
  const blockHash = "0x" + "cd".repeat(32);
  const amount = 1000n;
  const topicAddress = a => "0x" + "0".repeat(24) + a.slice(2);
  const receipt = {
    status: "0x1",
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x1",
    logs: [{
      address: USDC_CONTRACT.toLowerCase(),
      topics: [TRANSFER_TOPIC, topicAddress(payer), topicAddress(payTo)],
      data: "0x" + amount.toString(16).padStart(64, "0"),
      transactionHash: txHash,
      blockHash,
      logIndex: "0x3",
      removed: false,
    }],
  };
  const expected = {
    network: "eip155:10143", taskId: "0x" + "33".repeat(32),
    transaction: txHash, payer, payTo, token: USDC_CONTRACT, amountAtomic: "1000",
  };
  const reference = verifyReceipt(receipt, expected, "0x70", { minConfirmations: 1 });
  const mine = await settlementRefOf({
    network: "eip155:10143", token: USDC_CONTRACT, transaction: txHash, logIndex: 3,
  });
  assert.equal(mine, reference.settlementRef);

  const browserCheck = await verifyUsdcReceipt(receipt, expected, "0x70", { minConfirmations: 1 });
  assert.equal(browserCheck.ok, true);
  assert.equal(browserCheck.settlementRef, reference.settlementRef);
  assert.equal(browserCheck.logIndex, reference.logIndex);
  assert.equal(browserCheck.confirmations, reference.confirmations);
});

test("browser receipt check fails closed on the same cases as the reference", async () => {
  const payer = "0x" + "11".repeat(20);
  const payTo = "0x" + "22".repeat(20);
  const txHash = "0x" + "ab".repeat(32);
  const blockHash = "0x" + "cd".repeat(32);
  const topicAddress = a => "0x" + "0".repeat(24) + a.slice(2);
  const expected = {
    network: "eip155:10143", taskId: "0x" + "33".repeat(32),
    transaction: txHash, payer, payTo, token: USDC_CONTRACT, amountAtomic: "1000",
  };
  const makeReceipt = (amount = 1000n, status = "0x1") => ({
    status, transactionHash: txHash, blockHash, blockNumber: "0x64", transactionIndex: "0x1",
    logs: [{
      address: USDC_CONTRACT.toLowerCase(),
      topics: [TRANSFER_TOPIC, topicAddress(payer), topicAddress(payTo)],
      data: "0x" + amount.toString(16).padStart(64, "0"),
      transactionHash: txHash, blockHash, logIndex: "0x0", removed: false,
    }],
  });

  assert.equal((await verifyUsdcReceipt(null, expected, "0x70")).ok, false);
  assert.equal((await verifyUsdcReceipt(makeReceipt(1000n, "0x0"), expected, "0x70")).classification, "TRANSACTION_REVERTED");
  assert.equal((await verifyUsdcReceipt(makeReceipt(999n), expected, "0x70")).classification, "TRANSFER_NOT_FOUND");
  assert.equal((await verifyUsdcReceipt(makeReceipt(), expected, "0x70", { minConfirmations: 50 })).classification, "NOT_ENOUGH_CONFIRMATIONS");
  assert.equal((await verifyUsdcReceipt(makeReceipt(), { ...expected, payTo: "0x" + "99".repeat(20) }, "0x70")).classification, "TRANSFER_NOT_FOUND");
});
