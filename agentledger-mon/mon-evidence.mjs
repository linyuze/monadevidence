// SPDX-License-Identifier: Apache-2.0
// MON (native) payment evidence for Monad testnet.
//
// Why a separate schema from agentledger.evidence.v1:
//   agentledger.evidence.v1 describes the *tool run* (input/output hashes).
//   This module describes the *payment* — a native MON transfer, which produces
//   no ERC-20 Transfer log. So there is no logIndex; settlementRef uses the zero
//   address as the asset slot and a fixed index of 0, keeping the same formula:
//     sha256(JSON.stringify(["agentledger.settlement.v1", network, asset, tx, index]))
//
// Every field below is derived from chain data only (receipt / tx / block), never
// from the local clock. That makes the evidence hash independently reproducible:
// anyone with the tx hash can rebuild the document and get the same digest.

import { sha256Hex, utf8 } from "./sha256.js";

export const NETWORK = "eip155:10143";
export const CHAIN_ID = 10143;
export const CHAIN_ID_HEX = "0x279f";
export const NATIVE_ASSET = "MON";
export const NATIVE_ADDRESS = "0x" + "0".repeat(40);
export const MON_DECIMALS = 18;
export const PAYMENT_SCHEMA = "agentledger.mon-payment.v1";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const fail = reason => { throw new Error(reason); };

/** "100" | "0.5" | "1.000000000000000001" -> wei (bigint). Strict, no rounding. */
export function parseMon(text) {
  const s = String(text ?? "").trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(s)) {
    fail("MON amount must be a non-negative decimal with at most 18 decimals, got: " + JSON.stringify(text));
  }
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(MON_DECIMALS)).slice(0, MON_DECIMALS);
  return BigInt(whole) * 10n ** 18n + BigInt(padded || "0");
}

/** wei -> shortest exact decimal string. */
export function formatMon(wei) {
  const v = BigInt(wei);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(MON_DECIMALS, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

export const toHexQuantity = value => "0x" + BigInt(value).toString(16);

/**
 * settlementRef for a native transfer. Same formula and same domain separator as
 * tools/settlement.mjs; the asset slot carries the zero address because MON is
 * not a token contract, and the log index is fixed at 0 because a plain value
 * transfer emits no logs.
 */
export async function monSettlementRef({ network = NETWORK, transaction }) {
  if (typeof transaction !== "string" || !BYTES32.test(transaction.toLowerCase())) {
    fail("transaction hash must be 32-byte hex");
  }
  const material = JSON.stringify([
    "agentledger.settlement.v1",
    network,
    NATIVE_ADDRESS,
    transaction.toLowerCase(),
    0,
  ]);
  return sha256Hex(utf8(material));
}

// Fixed field order — the canonical form is JSON.stringify over exactly these keys.
export const PAYMENT_FIELDS = Object.freeze([
  "asset",
  "blockHash",
  "blockNumber",
  "effectiveGasPriceWei",
  "feeWei",
  "from",
  "gasUsed",
  "network",
  "nonce",
  "observedAt",
  "schemaVersion",
  "settlementRef",
  "status",
  "taskId",
  "to",
  "transactionHash",
  "valueAtomic",
  "valueMon",
]);

export function canonicalMonPayment(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("payment evidence must be a JSON object");
  }
  const keys = Object.keys(value).sort();
  const expected = [...PAYMENT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    fail("unexpected or missing payment evidence fields");
  }
  if (value.schemaVersion !== PAYMENT_SCHEMA) fail("unsupported payment evidence version");
  if (value.asset !== NATIVE_ASSET) fail("asset must be " + NATIVE_ASSET);
  if (value.network !== NETWORK) fail("network must be " + NETWORK);
  if (value.status !== "success" && value.status !== "reverted") fail("invalid status");
  for (const field of ["from", "to"]) {
    if (typeof value[field] !== "string" || !ADDRESS.test(value[field])) fail("invalid " + field);
  }
  for (const field of ["blockHash", "transactionHash", "taskId", "settlementRef"]) {
    if (typeof value[field] !== "string" || !BYTES32.test(value[field])) fail("invalid " + field);
  }
  for (const field of ["blockNumber", "effectiveGasPriceWei", "feeWei", "gasUsed", "nonce", "valueAtomic"]) {
    if (typeof value[field] !== "string" || !DECIMAL.test(value[field])) fail("invalid " + field);
  }
  if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt)) ||
      new Date(value.observedAt).toISOString() !== value.observedAt) {
    fail("invalid observedAt timestamp");
  }
  if (formatMon(value.valueAtomic) !== value.valueMon) fail("valueMon does not match valueAtomic");

  const ordered = {};
  for (const key of PAYMENT_FIELDS) ordered[key] = value[key];
  return JSON.stringify(ordered);
}

export async function monPaymentHash(value) {
  return sha256Hex(utf8(canonicalMonPayment(value)));
}

/**
 * Build the payment evidence from chain objects. No clock, no randomness:
 *   receipt -> status, gasUsed, effectiveGasPrice, blockHash, blockNumber
 *   tx      -> from, to, value, nonce
 *   block   -> timestamp (so observedAt is the chain's own time)
 */
export async function buildMonPaymentEvidence({
  taskId, transactionHash, receipt, tx, block, network = NETWORK,
}) {
  if (!receipt) fail("receipt is required");
  if (!tx) fail("transaction is required");
  if (!block) fail("block is required");

  const gasUsed = BigInt(receipt.gasUsed);
  const gasPrice = BigInt(receipt.effectiveGasPrice ?? tx.gasPrice ?? "0x0");
  const from = String(tx.from).toLowerCase();
  const to = String(tx.to).toLowerCase();
  const valueAtomic = BigInt(tx.value ?? "0x0");

  const settlementRef = await monSettlementRef({ network, transaction: transactionHash });

  const document = {
    asset: NATIVE_ASSET,
    blockHash: String(receipt.blockHash).toLowerCase(),
    blockNumber: BigInt(receipt.blockNumber).toString(),
    effectiveGasPriceWei: gasPrice.toString(),
    feeWei: (gasUsed * gasPrice).toString(),
    from,
    gasUsed: gasUsed.toString(),
    network,
    nonce: BigInt(tx.nonce).toString(),
    observedAt: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
    schemaVersion: PAYMENT_SCHEMA,
    settlementRef,
    status: receipt.status === "0x1" ? "success" : "reverted",
    taskId: String(taskId).toLowerCase(),
    to,
    transactionHash: String(transactionHash).toLowerCase(),
    valueAtomic: valueAtomic.toString(),
    valueMon: formatMon(valueAtomic),
  };

  const canonical = canonicalMonPayment(document);
  const hash = await sha256Hex(utf8(canonical));
  return { document, canonical, hash, settlementRef };
}

/**
 * Independent re-check. Rebuilds the document from chain objects and compares it
 * with the stored one, byte for byte.
 *
 * Comparing digests alone is not enough: a doctored field would still hash to the
 * stored digest because the digest is rebuilt from the chain, not from the stored
 * document. So the stored document is canonicalised too and the two canonical
 * forms must be identical.
 *
 * Pass chainObjects.taskId to pin the task identity to an authoritative source;
 * otherwise the stored taskId is used (which only proves internal consistency).
 */
export async function verifyMonPaymentEvidence(stored, chainObjects = {}) {
  if (!stored || typeof stored !== "object") {
    return { ok: false, classification: "EVIDENCE_INVALID", detail: "no stored evidence" };
  }

  const document = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith("__")) document[key] = value;
  }

  let rebuilt;
  try {
    rebuilt = await buildMonPaymentEvidence({
      taskId: chainObjects.taskId || document.taskId,
      transactionHash: document.transactionHash,
      receipt: chainObjects.receipt,
      tx: chainObjects.tx,
      block: chainObjects.block,
      network: chainObjects.network || NETWORK,
    });
  } catch (error) {
    return { ok: false, classification: "EVIDENCE_INVALID", detail: String(error.message || error) };
  }

  let storedCanonical;
  try {
    storedCanonical = canonicalMonPayment(document);
  } catch (error) {
    return { ok: false, classification: "EVIDENCE_INVALID", detail: String(error.message || error) };
  }

  if (storedCanonical !== rebuilt.canonical) {
    const differing = PAYMENT_FIELDS.filter(
      field => String(document[field]) !== String(rebuilt.document[field]),
    );
    return {
      ok: false,
      classification: "EVIDENCE_MUTATED",
      detail: "stored document differs from the chain-derived document",
      fields: differing,
      expected: rebuilt.canonical,
      actual: storedCanonical,
    };
  }

  if (stored.__hash && String(stored.__hash).toLowerCase() !== rebuilt.hash) {
    return {
      ok: false,
      classification: "EVIDENCE_HASH_MISMATCH",
      detail: "stored digest does not match the chain-derived digest",
      expected: rebuilt.hash,
      actual: stored.__hash,
    };
  }

  return {
    ok: true,
    classification: "EVIDENCE_REPRODUCIBLE",
    hash: rebuilt.hash,
    settlementRef: rebuilt.settlementRef,
    detail: "rebuilt from chain data alone; stored bytes are identical",
  };
}
