// SPDX-License-Identifier: Apache-2.0
// The automated MON payment pipeline.
//
// Transport-agnostic on purpose: the only thing it needs is an object with
//   request(method, params) -> Promise<result>      (EIP-1193 / JSON-RPC shape)
// That means the *same* code runs
//   - in the browser  -> transport = window.ethereum (MetaMask asks for approval)
//   - headless on anvil -> transport = plain HTTP JSON-RPC (anvil signs for its
//     unlocked dev accounts, so zero clicks: this is what proves the flow really
//     is automated and not just "a sequence of buttons").
//
// The pipeline performs a REAL native MON transfer between two distinct
// accounts and then anchors the resulting evidence on chain:
//
//   preflight -> createTask -> transfer(A -> B) -> receipt -> balanceDelta
//             -> evidence -> recordPayment -> submitEvidence -> readback -> verify
//
// Every step reports the exact RPC call it made, so the logic is inspectable
// rather than hidden behind a spinner.

import {
  createTaskData, recordPaymentData, submitEvidenceData, getTaskData,
  decodeTask, paymentRecorderData, decodeAddress, ZERO_BYTES32,
} from "./abi.js";
import { sha256Hex, utf8 } from "./sha256.js";
import {
  CHAIN_ID, CHAIN_ID_HEX, NETWORK, NATIVE_ADDRESS,
  buildMonPaymentEvidence, monSettlementRef, formatMon, parseMon, toHexQuantity,
} from "./mon-evidence.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lower = value => String(value).toLowerCase();
const hexBig = value => BigInt(value ?? "0x0");

export const STEP_LABELS = Object.freeze({
  preflight: "环境与余额自检",
  createTask: "创建任务（写入预算上限）",
  transfer: "真实转账 A → B",
  receipt: "等待交易上链",
  balanceDelta: "核对 B 的余额增量",
  evidence: "生成支付证据（规范 JSON + SHA-256）",
  recordPayment: "记录付款（recorder 证词）",
  submitEvidence: "锚定证据哈希",
  readback: "读回链上任务",
  verify: "三方一致性核对",
});

export class PipelineError extends Error {
  constructor(step, message, cause) {
    super(`[${step}] ${message}`);
    this.name = "PipelineError";
    this.step = step;
    this.cause = cause;
  }
}

async function waitForReceipt(transport, hash, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    const receipt = await transport.request("eth_getTransactionReceipt", [hash]);
    polls += 1;
    if (receipt) return { receipt, polls };
    await sleep(intervalMs);
  }
  throw new Error(`no receipt after ${timeoutMs} ms (${polls} polls) for ${hash}`);
}

/**
 * @param {object} options
 * @param {{request:Function}} options.transport  EIP-1193-like transport
 * @param {string} options.contract               AgentLedger address
 * @param {string} options.taskId                 bytes32
 * @param {string} options.description            human text, hashed into descriptionHash
 * @param {string} options.from                   payer account A
 * @param {string} options.to                     payee account B
 * @param {bigint|string} options.valueAtomic     amount in wei
 * @param {bigint|string|null} options.maxBudgetAtomic  on-chain cap (null = no cap)
 */
export async function runMonPayment(options, hooks = {}) {
  const {
    transport,
    contract,
    taskId,
    description,
    from,
    to,
    valueAtomic,
    maxBudgetAtomic = null,
    timeoutMs = 180_000,
    intervalMs = 600,
    minConfirmations = 1,
  } = options;

  const steps = [];
  const emit = (id, status, detail, extra = {}) => {
    const record = { id, label: STEP_LABELS[id] || id, status, detail, at: new Date().toISOString(), ...extra };
    steps.push(record);
    if (typeof hooks.onStep === "function") {
      try { hooks.onStep(record); } catch { /* UI errors must not break the flow */ }
    }
    return record;
  };

  const guard = async (id, rpc, fn) => {
    emit(id, "running", "", { rpc });
    try {
      const result = await fn();
      emit(id, "ok", result?.detail || "ok", { rpc, data: result });
      return result;
    } catch (error) {
      emit(id, "fail", String(error.message || error), { rpc });
      throw new PipelineError(id, String(error.message || error), error);
    }
  };

  // Always send an explicit gas limit and legacy gas price.
  //
  // Why: MetaMask can carry a stale EIP-1559 maxFeePerGas (e.g. 13 gwei saved
  // from an Ethereum mainnet session). Monad's base fee is 100 gwei, so the node
  // rejects the transaction with -32000 "max fee per gas less than block base
  // fee", and MetaMask shows that as "Internal JSON-RPC error." with no detail.
  // Specifying gasPrice forces a legacy transaction, which has no maxFeePerGas.
  //
  // Monad charges gas_limit rather than gas_used, so the estimate is used as-is
  // instead of being padded by 20%.
  const sendTx = async ({ from, to, data, value }) => {
    const call = { from, to, data };
    if (value !== undefined) call.value = toHexQuantity(value);
    const [gasHex, priceHex] = await Promise.all([
      transport.request("eth_estimateGas", [call]),
      transport.request("eth_gasPrice", []),
    ]);
    return transport.request("eth_sendTransaction", [{ ...call, gas: gasHex, gasPrice: priceHex }]);
  };

  const amount = typeof valueAtomic === "bigint" ? valueAtomic : BigInt(valueAtomic);
  const payer = lower(from);
  const payee = lower(to);

  // ---------------------------------------------------------------- preflight
  const pre = await guard("preflight", "eth_chainId / eth_getCode / eth_getBalance / eth_call", async () => {
    const chainIdHex = await transport.request("eth_chainId", []);
    if (lower(chainIdHex) !== CHAIN_ID_HEX) {
      throw new Error(`wrong chain: expected ${CHAIN_ID_HEX} (${CHAIN_ID}), got ${chainIdHex}`);
    }
    if (payer === payee) throw new Error("payer and payee must be two different accounts");
    if (amount <= 0n) throw new Error("amount must be greater than zero");

    const code = await transport.request("eth_getCode", [contract, "latest"]);
    if (!code || code === "0x") throw new Error(`no contract bytecode at ${contract}`);

    const recorderRaw = await transport.request("eth_call", [{ to: contract, data: paymentRecorderData() }, "latest"]);
    const recorder = decodeAddress(recorderRaw);

    const [payerBalanceHex, payeeBalanceHex, gasPriceHex] = await Promise.all([
      transport.request("eth_getBalance", [payer, "latest"]),
      transport.request("eth_getBalance", [payee, "latest"]),
      transport.request("eth_gasPrice", []),
    ]);

    const payerBalance = hexBig(payerBalanceHex);
    const payeeBalance = hexBig(payeeBalanceHex);
    const gasPrice = hexBig(gasPriceHex);
    const gasReserve = gasPrice * 60_000n; // transfer + 3 contract calls, generous
    if (payerBalance < amount + gasReserve) {
      throw new Error(
        `payer ${payer} has ${formatMon(payerBalance)} MON, needs about ` +
        `${formatMon(amount + gasReserve)} MON (${formatMon(amount)} to send + gas reserve)`,
      );
    }
    return {
      detail: `chainId ${chainIdHex} · A=${formatMon(payerBalance)} MON · B=${formatMon(payeeBalance)} MON · gas ${gasPrice} wei`,
      recorder,
      payerBalance,
      payeeBalanceBefore: payeeBalance,
      gasPrice,
    };
  });

  if (pre.recorder !== payer) {
    emit("preflight", "warn",
      `paymentRecorder() is ${pre.recorder}, but the payer is ${payer}. recordPayment will revert unless ` +
      `the payer IS the recorder — deploy with recorder = account A.`);
  }

  // --------------------------------------------------------------- createTask
  // sha256Hex already returns a 0x-prefixed digest.
  const descriptionHash = await sha256Hex(utf8(String(description)));

  const created = await guard("createTask", "eth_call getTask → eth_sendTransaction createTask", async () => {
    // getTask() reverts for a task that does not exist yet — that is the
    // contract's own "absent" signal, not a failure of this pipeline.
    let existing = null;
    try {
      const raw = await transport.request("eth_call", [{ to: contract, data: getTaskData(taskId) }, "latest"]);
      existing = decodeTask(raw);
    } catch (error) {
      const message = String(error?.message || error);
      if (!/revert/i.test(message)) throw error;
      existing = null;
    }
    if (existing) {
      return { detail: `task already exists in state ${existing.status}; not recreated`, skipped: true, existing };
    }
    const data = createTaskData(taskId, descriptionHash, maxBudgetAtomic ?? null);
    const hash = await sendTx({ from: payer, to: contract, data });
    const { receipt } = await waitForReceipt(transport, hash, { timeoutMs, intervalMs });
    if (receipt.status !== "0x1") throw new Error(`createTask reverted in ${hash}`);
    return { detail: `created in ${hash}`, hash, descriptionHash };
  });

  // ----------------------------------------------------------------- transfer
  const transfer = await guard("transfer", "eth_sendTransaction { from: A, to: B, value }", async () => {
    const hash = await sendTx({ from: payer, to: payee, value: amount });
    return { detail: `${formatMon(amount)} MON → ${payee} (${hash})`, hash };
  });

  // ------------------------------------------------------------------ receipt
  const mined = await guard("receipt", "eth_getTransactionReceipt (polled)", async () => {
    const { receipt, polls } = await waitForReceipt(transport, transfer.hash, { timeoutMs, intervalMs });
    if (receipt.status !== "0x1") throw new Error(`transfer reverted in block ${hexBig(receipt.blockNumber)}`);
    const head = await transport.request("eth_blockNumber", []);
    const confirmations = hexBig(head) - hexBig(receipt.blockNumber) + 1n;
    if (confirmations < BigInt(minConfirmations)) {
      throw new Error(`only ${confirmations} confirmation(s), need ${minConfirmations}`);
    }
    return {
      detail: `mined in block ${hexBig(receipt.blockNumber)} · ${confirmations} confirmation(s) · ${polls} poll(s)`,
      receipt,
      confirmations: confirmations.toString(),
    };
  });

  // ------------------------------------------------------------ balanceDelta
  const delta = await guard("balanceDelta", "eth_getBalance (B, after)", async () => {
    const after = hexBig(await transport.request("eth_getBalance", [payee, "latest"]));
    const gained = after - pre.payeeBalanceBefore;
    if (gained !== amount) {
      throw new Error(
        `B gained ${formatMon(gained)} MON, expected exactly ${formatMon(amount)} MON ` +
        `(before ${formatMon(pre.payeeBalanceBefore)}, after ${formatMon(after)})`,
      );
    }
    return {
      detail: `B: ${formatMon(pre.payeeBalanceBefore)} → ${formatMon(after)} MON (+${formatMon(gained)}, exact)`,
      payeeBalanceBefore: pre.payeeBalanceBefore.toString(),
      payeeBalanceAfter: after.toString(),
      gained: gained.toString(),
    };
  });

  // ----------------------------------------------------------------- evidence
  const evidence = await guard("evidence", "eth_getTransactionByHash + eth_getBlockByNumber → sha256", async () => {
    const [tx, block] = await Promise.all([
      transport.request("eth_getTransactionByHash", [transfer.hash]),
      transport.request("eth_getBlockByNumber", [mined.receipt.blockNumber, false]),
    ]);
    if (!tx) throw new Error("transaction not found");
    if (lower(tx.from) !== payer) throw new Error(`tx.from ${tx.from} is not the payer`);
    if (lower(tx.to) !== payee) throw new Error(`tx.to ${tx.to} is not the payee`);
    if (hexBig(tx.value) !== amount) throw new Error(`tx.value ${tx.value} != ${toHexQuantity(amount)}`);
    const built = await buildMonPaymentEvidence({
      taskId, transactionHash: transfer.hash, receipt: mined.receipt, tx, block,
    });
    return {
      detail: `evidence ${built.hash.slice(0, 18)}… · settlementRef ${built.settlementRef.slice(0, 18)}…`,
      ...built,
    };
  });

  // Hand the evidence to the caller before the remaining chain writes. A
  // failure in recordPayment/submitEvidence must not lose the proof that the
  // money actually moved.
  if (typeof hooks.onEvidence === "function") {
    try {
      await hooks.onEvidence({
        taskId,
        contract,
        network: NETWORK,
        transferHash: transfer.hash,
        evidence: evidence.document,
        canonical: evidence.canonical,
        hash: evidence.hash,
        settlementRef: evidence.settlementRef,
      });
    } catch { /* persistence must never abort the payment flow */ }
  }

  // ----------------------------------------------------------- recordPayment
  const recorded = await guard("recordPayment", "eth_sendTransaction recordPayment", async () => {
    const data = recordPaymentData(taskId, payer, amount, evidence.settlementRef);
    const hash = await sendTx({ from: payer, to: contract, data });
    const { receipt } = await waitForReceipt(transport, hash, { timeoutMs, intervalMs });
    if (receipt.status !== "0x1") throw new Error(`recordPayment reverted in ${hash}`);
    return { detail: `payment recorded in ${hash}`, hash };
  });

  // ---------------------------------------------------------- submitEvidence
  const anchored = await guard("submitEvidence", "eth_sendTransaction submitEvidence", async () => {
    const data = submitEvidenceData(taskId, evidence.hash);
    const hash = await sendTx({ from: payer, to: contract, data });
    const { receipt } = await waitForReceipt(transport, hash, { timeoutMs, intervalMs });
    if (receipt.status !== "0x1") throw new Error(`submitEvidence reverted in ${hash}`);
    return { detail: `evidence anchored in ${hash}`, hash };
  });

  // ---------------------------------------------------------------- readback
  const readback = await guard("readback", "eth_call getTask", async () => {
    const raw = await transport.request("eth_call", [{ to: contract, data: getTaskData(taskId) }, "latest"]);
    const task = decodeTask(raw);
    return { detail: `status ${task.status} · payer ${task.payer} · amount ${formatMon(task.amountAtomic)} MON`, task };
  });

  // ------------------------------------------------------------------ verify
  const verification = await guard("verify", "compare chain state vs local evidence", async () => {
    const task = readback.task;
    const checks = [
      { name: "任务已进入 Proven", ok: task.status === "Proven", actual: task.status, expected: "Proven" },
      { name: "链上 payer = 账户 A", ok: task.payer === payer, actual: task.payer, expected: payer },
      { name: "链上金额 = 转账金额", ok: task.amountAtomic === amount.toString(), actual: task.amountAtomic, expected: amount.toString() },
      { name: "链上 settlementRef = 本地推导", ok: task.settlementRef === evidence.settlementRef, actual: task.settlementRef, expected: evidence.settlementRef },
      { name: "链上 evidenceHash = 本地证据哈希", ok: task.evidenceHash === evidence.hash, actual: task.evidenceHash, expected: evidence.hash },
      { name: "B 余额增量 = 转账金额", ok: delta.gained === amount.toString(), actual: delta.gained, expected: amount.toString() },
      { name: "证据里的 from/to 与本次一致", ok: evidence.document.from === payer && evidence.document.to === payee, actual: `${evidence.document.from}→${evidence.document.to}`, expected: `${payer}→${payee}` },
    ];
    const failed = checks.filter(check => !check.ok);
    if (failed.length) throw new Error(`${failed.length} check(s) failed: ` + failed.map(f => f.name).join("; "));
    return { detail: `${checks.length}/${checks.length} checks passed`, checks };
  });

  return {
    taskId,
    contract,
    network: NETWORK,
    payer,
    payee,
    amountAtomic: amount.toString(),
    amountMon: formatMon(amount),
    descriptionHash,
    transferHash: transfer.hash,
    recordHash: recorded.hash,
    anchorHash: anchored.hash,
    receipt: mined.receipt,
    evidence: evidence.document,
    evidenceCanonical: evidence.canonical,
    evidenceHash: evidence.hash,
    settlementRef: evidence.settlementRef,
    task: readback.task,
    checks: verification.checks,
    steps,
    createdAtStepSkipped: Boolean(created.skipped),
  };
}

export { parseMon, formatMon, NETWORK, NATIVE_ADDRESS };
