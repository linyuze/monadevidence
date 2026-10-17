// SPDX-License-Identifier: Apache-2.0
// Browser port of the project's canonical Evidence rules and settlement formula.
// Byte-for-byte parity with agentledger/tools/evidence.mjs and
// agentledger/examples/verifier/tools/run-demo-task.mjs is asserted by
// test/evidence-parity.test.mjs.
import { sha256Hex, utf8, toHex } from "./sha256.js";

const FIELDS = [
  "completedAt", "executor", "inputSha256", "modelOrTool",
  "outputSha256", "schemaVersion", "taskId",
];
const BYTES32 = /^0x[0-9a-f]{64}$/;
const MAX_INPUT_BYTES = 1024 * 1024;

const fail = reason => { throw new Error(reason); };

export function canonicalEvidence(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Evidence must be a JSON object");
  const keys = Object.keys(value).sort();
  if (keys.length !== FIELDS.length || keys.some((key, i) => key !== FIELDS[i])) {
    fail("Unexpected or missing Evidence fields");
  }
  if (value.schemaVersion !== "agentledger.evidence.v1") fail("Unsupported Evidence version");
  for (const field of ["taskId", "inputSha256", "outputSha256"]) {
    if (typeof value[field] !== "string" || !BYTES32.test(value[field])) fail("Invalid " + field);
  }
  for (const field of ["executor", "modelOrTool"]) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 128) {
      fail("Invalid " + field);
    }
  }
  const time = value.completedAt;
  if (typeof time !== "string" || Number.isNaN(Date.parse(time)) ||
      new Date(time).toISOString() !== time) fail("Invalid completedAt timestamp");
  const ordered = {};
  for (const key of FIELDS) ordered[key] = value[key];
  return JSON.stringify(ordered);
}

export async function evidenceHash(evidence) {
  return sha256Hex(utf8(canonicalEvidence(evidence)));
}

/** Same deterministic tool as run-demo-task.mjs, operating on in-memory bytes. */
export async function calculateTextStats(buffer) {
  if (!(buffer instanceof Uint8Array) || !buffer.length || buffer.length > MAX_INPUT_BYTES) {
    fail("nonempty input <= 1 MiB required");
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail("input is not valid UTF-8");
  }
  if (!source.trim()) fail("empty text is not a valid task");
  const normalized = source.replace(/\r\n/g, "\n");
  return {
    schemaVersion: "agentledger.demo-tool-result.v1",
    tool: "deterministic-text-stats",
    inputSha256: await sha256Hex(buffer),
    byteCount: buffer.length,
    characterCount: [...source].length,
    wordCount: (normalized.match(/\S+/gu) || []).length,
    lineCount: normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0),
  };
}

/** Output bytes are exactly what the CLI writes: JSON.stringify(result, null, 2) + "\n". */
export function serializeToolOutput(result) {
  return utf8(JSON.stringify(result, null, 2) + "\n");
}

export async function buildEvidenceFromBytes({ taskId, inputBytes, outputBytes, executor, modelOrTool, completedAt }) {
  const doc = {
    completedAt: completedAt || new Date().toISOString(),
    executor,
    inputSha256: await sha256Hex(inputBytes),
    modelOrTool,
    outputSha256: await sha256Hex(outputBytes),
    schemaVersion: "agentledger.evidence.v1",
    taskId,
  };
  return { document: doc, canonical: canonicalEvidence(doc), hash: await evidenceHash(doc) };
}

export const NETWORK = "eip155:10143";
export const USDC_CONTRACT = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

/** settlementRef = sha256(JSON.stringify([schema, network, token, txHash, logIndex])). */
export async function settlementRefOf({ network = NETWORK, token, transaction, logIndex }) {
  const material = JSON.stringify([
    "agentledger.settlement.v1",
    network,
    token.toLowerCase(),
    transaction.toLowerCase(),
    Number(logIndex),
  ]);
  return sha256Hex(utf8(material));
}

const topicAddress = address => "0x" + "0".repeat(24) + address.toLowerCase().slice(2);
const hexToBigInt = value => BigInt(value);

/**
 * Read-only USDC receipt check, mirroring tools/settlement.mjs.
 * Returns a classification; never treats a missing receipt as "unpaid".
 */
export async function verifyUsdcReceipt(receipt, expected, currentBlockHex, opts = {}) {
  if (!receipt || typeof receipt !== "object") {
    return { ok: false, classification: "RECEIPT_UNAVAILABLE", detail: "receipt missing; PaymentUnknown, do not recharge" };
  }
  if (receipt.status !== "0x1") {
    return { ok: false, classification: "TRANSACTION_REVERTED", detail: "transaction status is not success" };
  }
  const tx = expected.transaction.toLowerCase();
  if (String(receipt.transactionHash).toLowerCase() !== tx) {
    return { ok: false, classification: "TRANSACTION_MISMATCH", detail: "receipt belongs to a different transaction" };
  }
  const block = hexToBigInt(receipt.blockNumber);
  const head = hexToBigInt(currentBlockHex);
  const minConfirmations = BigInt(opts.minConfirmations ?? 2);
  const confirmations = head - block + 1n;
  if (confirmations < minConfirmations) {
    return { ok: false, classification: "NOT_ENOUGH_CONFIRMATIONS", detail: `only ${confirmations} confirmation(s)` };
  }
  const token = (expected.token || USDC_CONTRACT).toLowerCase();
  const payer = expected.payer.toLowerCase();
  const payTo = expected.payTo.toLowerCase();
  const amount = hexToBigInt(expected.amountAtomic);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];

  const transfers = logs.filter(log => log && log.removed !== true &&
    String(log.address).toLowerCase() === token &&
    Array.isArray(log.topics) && log.topics.length === 3 &&
    log.topics[0].toLowerCase() === TRANSFER_TOPIC &&
    log.topics[1].toLowerCase() === topicAddress(payer) &&
    log.topics[2].toLowerCase() === topicAddress(payTo) &&
    typeof log.data === "string" && /^0x[0-9a-fA-F]{64}$/.test(log.data) &&
    hexToBigInt(log.data) === amount);
  if (transfers.length !== 1) {
    return { ok: false, classification: "TRANSFER_NOT_FOUND", detail: `expected exactly one matching USDC Transfer, got ${transfers.length}` };
  }
  const log = transfers[0];

  let paymentNonce = null;
  if (expected.paymentNonce) {
    paymentNonce = expected.paymentNonce.toLowerCase();
    const auths = logs.filter(entry => entry && entry.removed !== true &&
      String(entry.address).toLowerCase() === token &&
      Array.isArray(entry.topics) && entry.topics.length === 3 &&
      entry.topics[0].toLowerCase() === AUTHORIZATION_USED_TOPIC &&
      entry.topics[1].toLowerCase() === topicAddress(payer) &&
      entry.topics[2].toLowerCase() === paymentNonce &&
      String(entry.transactionHash).toLowerCase() === tx);
    if (auths.length !== 1) {
      return { ok: false, classification: "AUTHORIZATION_NONCE_NOT_FOUND", detail: "EIP-3009 nonce was not consumed in this receipt" };
    }
  }

  const settlementRef = await settlementRefOf({
    network: expected.network || NETWORK, token, transaction: tx, logIndex: log.logIndex,
  });
  return {
    ok: true,
    classification: "TRANSFER_AND_NONCE_OBSERVED",
    settlementRef,
    logIndex: Number(hexToBigInt(log.logIndex)),
    blockNumber: block.toString(),
    confirmations: confirmations.toString(),
    blockHash: String(receipt.blockHash).toLowerCase(),
    paymentNonce,
    detail: "Transfer" + (paymentNonce ? " + AuthorizationUsed" : "") + " matched; this is not finality.",
  };
}

/** Human-readable hex of raw bytes, for display only. */
export const displayHex = bytes => toHex(bytes);
