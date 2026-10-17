// SPDX-License-Identifier: Apache-2.0
// Zero-dependency ABI codec for the AgentLedger contract.
// Every function used here has only static types (bytes32 / address / uint256),
// so encoding is a plain concatenation of 32-byte words — no dynamic offsets.
// Selectors were produced with `cast sig` and are asserted in test/abi-anvil.test.mjs.

export const SELECTORS = Object.freeze({
  "createTask(bytes32,bytes32)": "0xd3f32cae",
  "createTask(bytes32,bytes32,uint256)": "0xb1ecb3d8",
  "recordPayment(bytes32,address,uint256,bytes32)": "0x8f7b9359",
  "submitEvidence(bytes32,bytes32)": "0x17dfa44c",
  "getTask(bytes32)": "0x15a29035",
  "paymentRecorder()": "0x0ce52801",
  "usedSettlementRefs(bytes32)": "0xd26472dc",
});

export const STATUS = Object.freeze(["None", "Created", "Paid", "Proven"]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT_DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_UINT256 = 2n ** 256n - 1n;

function fail(message) { throw new Error(message); }

export function assertAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value)) fail(label + " must be a 20-byte hex address");
  return value.toLowerCase();
}

export function assertBytes32(value, label) {
  if (typeof value !== "string" || !BYTES32.test(value)) fail(label + " must be a 32-byte hex value");
  return value.toLowerCase();
}

export function assertUint(value, label) {
  let n;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && UINT_DECIMAL.test(value)) n = BigInt(value);
  else fail(label + " must be a non-negative integer");
  if (n < 0n || n > MAX_UINT256) fail(label + " out of uint256 range");
  return n;
}

// 32-byte word helpers (hex without 0x prefix)
const wordFromBigInt = n => n.toString(16).padStart(64, "0");
const wordFromAddress = a => a.slice(2).toLowerCase().padStart(64, "0");
const wordFromBytes32 = h => h.slice(2).toLowerCase();

function join(selector, words) {
  return selector + words.join("");
}

export function createTaskData(taskId, descriptionHash, maxBudget = null) {
  const id = wordFromBytes32(assertBytes32(taskId, "taskId"));
  const desc = wordFromBytes32(assertBytes32(descriptionHash, "descriptionHash"));
  if (maxBudget === null || maxBudget === undefined) {
    return join(SELECTORS["createTask(bytes32,bytes32)"], [id, desc]);
  }
  const budget = wordFromBigInt(assertUint(maxBudget, "maxBudget"));
  return join(SELECTORS["createTask(bytes32,bytes32,uint256)"], [id, desc, budget]);
}

export function recordPaymentData(taskId, payer, amount, settlementRef) {
  return join(SELECTORS["recordPayment(bytes32,address,uint256,bytes32)"], [
    wordFromBytes32(assertBytes32(taskId, "taskId")),
    wordFromAddress(assertAddress(payer, "payer")),
    wordFromBigInt(assertUint(amount, "amount")),
    wordFromBytes32(assertBytes32(settlementRef, "settlementRef")),
  ]);
}

export function submitEvidenceData(taskId, evidenceHash) {
  return join(SELECTORS["submitEvidence(bytes32,bytes32)"], [
    wordFromBytes32(assertBytes32(taskId, "taskId")),
    wordFromBytes32(assertBytes32(evidenceHash, "evidenceHash")),
  ]);
}

export function getTaskData(taskId) {
  return join(SELECTORS["getTask(bytes32)"], [wordFromBytes32(assertBytes32(taskId, "taskId"))]);
}

/** Deployment payload: creation bytecode followed by the encoded constructor(address). */
export function deployData(bytecode, recorder) {
  if (typeof bytecode !== "string" || !/^0x[0-9a-fA-F]+$/.test(bytecode)) fail("invalid creation bytecode");
  return bytecode.toLowerCase() + wordFromAddress(assertAddress(recorder, "recorder"));
}

/**
 * Decode the AgentLedger.Task struct returned by getTask(bytes32).
 * All eleven members are static, so they arrive as eleven consecutive words.
 */
export function decodeTask(result) {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) fail("invalid eth_call result");
  const raw = result.slice(2);
  if (raw.length < 11 * 64) fail("unexpected getTask return length");
  const word = i => raw.slice(i * 64, i * 64 + 64);
  const statusValue = Number(BigInt("0x" + word(7)));
  if (!Number.isInteger(statusValue) || statusValue < 1 || statusValue > 3) {
    fail("invalid task state (task does not exist)");
  }
  return {
    creator: "0x" + word(0).slice(24),
    payer: "0x" + word(1).slice(24),
    amountAtomic: BigInt("0x" + word(2)).toString(),
    maxBudgetAtomic: BigInt("0x" + word(3)).toString(),
    descriptionHash: "0x" + word(4),
    evidenceHash: "0x" + word(5),
    settlementRef: "0x" + word(6),
    statusValue,
    status: STATUS[statusValue],
    createdAt: BigInt("0x" + word(8)).toString(),
    paidAt: BigInt("0x" + word(9)).toString(),
    provenAt: BigInt("0x" + word(10)).toString(),
  };
}

export const ZERO_ADDRESS = "0x" + "0".repeat(40);
export const ZERO_BYTES32 = "0x" + "0".repeat(64);

export function paymentRecorderData() {
  return SELECTORS["paymentRecorder()"];
}

/** Decode a single address return value (e.g. paymentRecorder()). */
export function decodeAddress(result) {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) fail("invalid address return value");
  return "0x" + result.slice(2 + 24).toLowerCase();
}

/** Decode a single bool return value (e.g. usedSettlementRefs(bytes32)). */
export function decodeBool(result) {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) fail("invalid bool return value");
  return BigInt(result) !== 0n;
}
