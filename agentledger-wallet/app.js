// SPDX-License-Identifier: Apache-2.0
// AgentLedger MetaMask panel — every chain write is signed by the user's own
// browser wallet. This page holds no keys, no RPC proxy and no server state.
import {
  SELECTORS, deployData, createTaskData, recordPaymentData, submitEvidenceData,
  getTaskData, decodeTask, paymentRecorderData, decodeAddress,
  assertAddress, assertBytes32, ZERO_ADDRESS, ZERO_BYTES32,
} from "./abi.js";
import { sha256Hex, sha256Backend, utf8, fromHex, toHex } from "./sha256.js";
import {
  calculateTextStats, serializeToolOutput, buildEvidenceFromBytes, evidenceHash,
  verifyUsdcReceipt, settlementRefOf, USDC_CONTRACT, NETWORK,
} from "./evidence.js";

const MONAD = {
  chainId: "0x279f", // 10143
  chainName: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: ["https://testnet-rpc.monad.xyz"],
  blockExplorerUrls: ["https://testnet.monadscan.com"],
};

const $ = id => document.getElementById(id);
const state = {
  provider: null, account: null, chainId: null,
  contract: null, recorder: null,
  taskId: null, inputBytes: null, toolResult: null,
  evidence: null, evidenceHash: null,
  usdc: null,
};

function log(message, kind = "info") {
  const line = document.createElement("div");
  line.className = "log-line log-" + kind;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  line.textContent = `[${time}] ${message}`;
  $("log").prepend(line);
}

function setStatus(id, text, kind = "") {
  const node = $(id);
  if (!node) return;
  node.textContent = text;
  node.className = "status" + (kind ? " status-" + kind : "");
}

function requireProvider() {
  if (!state.provider) throw new Error("未检测到 MetaMask（window.ethereum 不存在）");
  return state.provider;
}

function pickProvider() {
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.find(p => p.isMetaMask && !p.isBraveWallet) || eth.providers[0];
  }
  return eth;
}

function friendlyError(error) {
  if (!error) return "未知错误";
  if (error.code === 4001 || /User rejected|User denied/i.test(error.message || "")) return "你在 MetaMask 中拒绝了这笔操作";
  if (error.code === 4100) return "钱包未授权，请重新连接";
  if (error.code === 4902 || /Unrecognized chain/i.test(error.message || "")) return "MetaMask 里还没有 Monad 测试网，请点「添加 / 切换网络」";
  if (error.code === -32000) return "链上拒绝：" + (error.message || "");
  return error.message || String(error);
}

async function rpc(method, params = []) {
  return requireProvider().request({ method, params });
}

async function call(to, data) {
  return rpc("eth_call", [{ to, data }, "latest"]);
}

function waitForReceipt(hash, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const receipt = await rpc("eth_getTransactionReceipt", [hash]);
        if (receipt && receipt.blockNumber) return resolve(receipt);
        if (Date.now() - started > 240000) return reject(new Error(label + " 等待收据超时（4 分钟）"));
        setTimeout(tick, 1500);
      } catch (error) { reject(error); }
    };
    tick();
  });
}

async function sendTx({ to, data, value }, label) {
  if (state.chainId !== MONAD.chainId) {
    throw new Error("当前不是 Monad 测试网，请先点「添加 / 切换 Monad 测试网」");
  }
  const tx = { from: state.account, data };
  if (to) tx.to = to;
  if (value) tx.value = value;
  log("等待 MetaMask 确认：" + label + " …");
  const hash = await rpc("eth_sendTransaction", [tx]);
  log("已广播 " + label + " → " + hash, "ok");
  const receipt = await waitForReceipt(hash, label);
  if (receipt.status !== "0x1") throw new Error(label + " 交易失败（status != 0x1）：" + hash);
  log(label + " 已确认，区块 " + Number(BigInt(receipt.blockNumber)) + " · gas " + Number(BigInt(receipt.gasUsed)), "ok");
  return receipt;
}

// ───────────────────────── wallet / network ─────────────────────────

async function connect({ silent = false } = {}) {
  state.provider = pickProvider();
  if (!state.provider) {
    setStatus("mm-state", "未检测到 MetaMask", "bad");
    log("window.ethereum 不存在。请确认：(1) 用的是装了 MetaMask 的 Chrome；(2) 页面是 http://localhost 或 http://127.0.0.1，而不是 file://", "bad");
    return;
  }
  try {
    const accounts = await rpc(silent ? "eth_accounts" : "eth_requestAccounts");
    if (!accounts.length) {
      setStatus("mm-state", "已注入，未授权", "warn");
      return;
    }
    state.account = accounts[0];
    state.chainId = await rpc("eth_chainId");
    setStatus("mm-state", "已连接", "ok");
    $("mm-account").textContent = state.account;
    if (!$("payer").value.trim()) $("payer").value = state.account;
    if (!$("usdc-payer").value.trim()) $("usdc-payer").value = state.account;
    renderChain();
    state.provider.on?.("accountsChanged", onAccountsChanged);
    state.provider.on?.("chainChanged", onChainChanged);
    log("已连接 " + state.account + " · chainId " + state.chainId, "ok");
    await refreshRecorder().catch(() => {});
  } catch (error) {
    setStatus("mm-state", friendlyError(error), "bad");
  }
}

function onAccountsChanged(accounts) {
  state.account = accounts[0] || null;
  $("mm-account").textContent = state.account || "（已断开）";
  log("账户切换：" + (state.account || "无"), "warn");
  refreshRecorder().catch(() => {});
}

function onChainChanged(chainId) {
  state.chainId = chainId;
  renderChain();
  log("网络切换：chainId " + chainId, "warn");
}

function renderChain() {
  const isMonad = state.chainId === MONAD.chainId;
  $("mm-chain").textContent = state.chainId
    ? `${Number(BigInt(state.chainId))}${isMonad ? "（Monad 测试网 ✓）" : "（不是 Monad 测试网）"}`
    : "—";
  $("mm-chain").className = isMonad ? "mono ok" : "mono bad";
}

async function switchChain() {
  try {
    await rpc("wallet_switchEthereumChain", [{ chainId: MONAD.chainId }]);
  } catch (error) {
    if (error.code === 4902 || /Unrecognized chain/i.test(error.message || "")) {
      await rpc("wallet_addEthereumChain", [MONAD]);
    } else throw error;
  }
  state.chainId = await rpc("eth_chainId");
  renderChain();
  log("已切到 Monad 测试网（10143）", "ok");
}

// ───────────────────────── contract / task ─────────────────────────

async function loadArtifact() {
  const response = await fetch("./artifact.json");
  if (!response.ok) throw new Error("无法加载 artifact.json");
  return response.json();
}

async function deploy() {
  const artifact = await loadArtifact();
  setStatus("deploy-status", "部署中…");
  const receipt = await sendTx({
    data: deployData(artifact.bytecode, state.account),
  }, "部署 AgentLedger（recorder = 当前账户）");
  const address = receipt.contractAddress;
  state.contract = address;
  $("contract").value = address;
  setStatus("deploy-status", "已部署：" + address, "ok");
  log("合约地址 " + address + "（paymentRecorder = 你当前账户）", "ok");
  await refreshRecorder();
}

function useContract() {
  const value = $("contract").value.trim();
  assertAddress(value, "合约地址");
  state.contract = value.toLowerCase();
  log("使用合约 " + state.contract);
  refreshRecorder().catch(error => log(friendlyError(error), "bad"));
}

async function refreshRecorder() {
  if (!state.contract) return;
  const raw = await call(state.contract, paymentRecorderData());
  state.recorder = decodeAddress(raw);
  $("recorder").textContent = state.recorder;
  const mine = state.account && state.account.toLowerCase() === state.recorder;
  $("recorder-match").textContent = state.account
    ? (mine ? "✓ 当前账户就是 recorder，可以记录付款" : "✗ 当前账户不是 recorder，recordPayment 会被合约拒绝")
    : "（未连接钱包）";
  $("recorder-match").className = mine ? "ok" : "warn";
  $("btn-record").disabled = !mine;
}

function newTaskId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  $("task-id").value = toHex(bytes);
  state.taskId = $("task-id").value;
}

async function hashInput() {
  const text = $("input-text").value;
  state.inputBytes = utf8(text);
  const hash = await sha256Hex(state.inputBytes);
  $("desc-hash").textContent = hash;
  return hash;
}

async function createTask() {
  if (!state.contract) throw new Error("先部署合约或填入合约地址");
  const descriptionHash = await hashInput();
  const taskId = assertBytes32($("task-id").value.trim(), "taskId");
  const budgetRaw = $("budget").value.trim();
  const maxBudget = budgetRaw === "" ? null : budgetRaw;
  await sendTx({
    to: state.contract,
    data: createTaskData(taskId, descriptionHash, maxBudget),
  }, "createTask");
  state.taskId = taskId;
  log("任务已创建：" + taskId, "ok");
  await refreshTask();
}

async function recordPayment() {
  if (!$("attest-check").checked) throw new Error("请先勾选确认：这是 recorder 证词，不是已验证付款");
  const taskId = assertBytes32($("task-id").value.trim(), "taskId");
  const payer = assertAddress($("payer").value.trim(), "payer");
  const amount = $("amount").value.trim();
  const settlementRef = assertBytes32($("settlement-ref").value.trim(), "settlementRef");
  await sendTx({
    to: state.contract,
    data: recordPaymentData(taskId, payer, amount, settlementRef),
  }, "recordPayment（recorder 证词）");
  log("付款证词已上链。注意：这不是 USDC 独立核对结果。", "warn");
  await refreshTask();
}

async function runTool() {
  const bytes = state.inputBytes || utf8($("input-text").value);
  const result = await calculateTextStats(bytes);
  state.toolResult = result;
  const outputBytes = serializeToolOutput(result);
  $("tool-output").textContent = JSON.stringify(result, null, 2);

  const built = await buildEvidenceFromBytes({
    taskId: $("task-id").value.trim(),
    inputBytes: bytes,
    outputBytes,
    executor: $("executor").value.trim() || "agentledger-wallet-panel",
    modelOrTool: result.tool,
  });
  state.evidence = built.document;
  state.evidenceHash = built.hash;
  $("evidence-json").textContent = JSON.stringify(built.document, null, 2);
  $("evidence-hash").textContent = built.hash;
  log("确定性工具执行完成，Evidence 哈希 " + built.hash, "ok");
}

async function anchor() {
  if (!state.evidenceHash) throw new Error("先运行确定性工具生成 Evidence");
  const taskId = assertBytes32($("task-id").value.trim(), "taskId");
  await sendTx({
    to: state.contract,
    data: submitEvidenceData(taskId, state.evidenceHash),
  }, "submitEvidence");
  await refreshTask();
}

// ───────────────────────── read-back / projection ─────────────────────────

async function refreshTask() {
  if (!state.contract) throw new Error("先指定合约地址");
  const taskId = assertBytes32($("task-id").value.trim(), "taskId");
  let task;
  try {
    task = decodeTask(await call(state.contract, getTaskData(taskId)));
  } catch {
    $("task-view").textContent = "读不到该任务（taskId 不存在，或合约地址不是 AgentLedger）";
    $("phase0-view").textContent = "—";
    return;
  }
  state.taskId = taskId;
  $("task-view").textContent = [
    "creator      " + task.creator,
    "payer        " + (task.payer === ZERO_ADDRESS ? "（尚未付款）" : task.payer),
    "amount       " + task.amountAtomic,
    "maxBudget    " + (task.maxBudgetAtomic === "0" ? "0（无上限）" : task.maxBudgetAtomic),
    "description  " + task.descriptionHash,
    "evidenceHash " + (task.evidenceHash === ZERO_BYTES32 ? "（尚未锚定）" : task.evidenceHash),
    "settlementRef " + (task.settlementRef === ZERO_BYTES32 ? "（尚未记录）" : task.settlementRef),
    "status       " + task.status,
    "createdAt    " + task.createdAt + (task.createdAt === "0" ? "" : " · " + new Date(Number(task.createdAt) * 1000).toLocaleString("zh-CN")),
  ].join("\n");
  renderProjection(task);
}

function renderProjection(task) {
  const lines = [];
  const paid = task.status === "Paid" || task.status === "Proven";
  const proven = task.status === "Proven";
  const localMatch = Boolean(state.evidenceHash && state.evidenceHash === task.evidenceHash);
  const usdc = state.usdc;

  let state_ = "PaymentUnknown";
  let why = "链上 Paid 只是 recorder 证词；没有独立的 USDC 收款核对，对外只能报 PaymentUnknown。";

  if (usdc && usdc.ok) {
    const refMatch = task.settlementRef.toLowerCase() === usdc.settlementRef.toLowerCase();
    if (paid && refMatch) {
      state_ = proven && localMatch ? "EvidenceAnchored" : "PaymentRecorded";
      why = "独立核对到 Transfer" + (usdc.paymentNonce ? " + AuthorizationUsed" : "") + "，且 settlementRef 与链上一致。";
    } else if (!paid) {
      state_ = "PaymentObserved";
      why = "观察到真实 USDC 收款，但链上任务还没被 recorder 记录。";
    } else if (!refMatch) {
      state_ = "Conflict";
      why = "链上 settlementRef 与独立观察到的交易不一致 —— 必须人工排查，不要重新付款。";
    }
  } else if (usdc && !usdc.ok) {
    state_ = "PaymentUnknown";
    why = "USDC 核对未通过（" + usdc.classification + "）：" + usdc.detail;
  }

  lines.push("链上状态      " + task.status);
  lines.push("对外状态      " + state_);
  lines.push("本地证据匹配  " + (state.evidenceHash ? (localMatch ? "✓ 与链上一致" : "✗ 与链上不一致") : "（本页尚未生成 Evidence）"));
  lines.push("USDC 独立核对 " + (usdc ? (usdc.ok ? "✓ 通过" : "✗ " + usdc.classification) : "（未做）"));
  lines.push("");
  lines.push(why);
  lines.push("");
  lines.push("retryPolicy   chargeAgain=false · 永不自动重付");
  $("phase0-view").textContent = lines.join("\n");
}

async function verifyUsdc() {
  const txHash = $("usdc-tx").value.trim();
  const expected = {
    network: NETWORK,
    transaction: txHash,
    payer: $("usdc-payer").value.trim() || state.account,
    payTo: $("usdc-payto").value.trim(),
    token: USDC_CONTRACT,
    amountAtomic: $("usdc-amount").value.trim(),
    paymentNonce: $("usdc-nonce").value.trim() || undefined,
  };
  const [receipt, head] = await Promise.all([
    rpc("eth_getTransactionReceipt", [txHash]),
    rpc("eth_blockNumber"),
  ]);
  const result = await verifyUsdcReceipt(receipt, expected, head, { minConfirmations: 1 });
  state.usdc = result;
  $("usdc-result").textContent = JSON.stringify(result, null, 2);
  log(result.ok ? "USDC 收款独立核对通过" : "USDC 核对未通过：" + result.classification, result.ok ? "ok" : "bad");
  if (result.ok) {
    $("settlement-ref").value = result.settlementRef;
    log("已把核对得到的 settlementRef 填入 recordPayment 表单", "ok");
  }
  await refreshTask().catch(() => {});
}

// ───────────────────────── wiring ─────────────────────────

function boot() {
  $("sha-backend").textContent = sha256Backend();
  $("origin").textContent = location.origin;

  $("btn-connect").addEventListener("click", () => connect());
  $("btn-switch").addEventListener("click", () => switchChain().catch(error => log(friendlyError(error), "bad")));
  $("btn-deploy").addEventListener("click", () => deploy().catch(error => { setStatus("deploy-status", friendlyError(error), "bad"); log(friendlyError(error), "bad"); }));
  $("btn-use-contract").addEventListener("click", useContract);
  $("btn-new-task").addEventListener("click", newTaskId);
  $("btn-create").addEventListener("click", () => createTask().catch(error => log(friendlyError(error), "bad")));
  $("btn-record").addEventListener("click", () => recordPayment().catch(error => log(friendlyError(error), "bad")));
  $("btn-run").addEventListener("click", () => runTool().catch(error => log(friendlyError(error), "bad")));
  $("btn-anchor").addEventListener("click", () => anchor().catch(error => log(friendlyError(error), "bad")));
  $("btn-refresh").addEventListener("click", () => refreshTask().catch(error => log(friendlyError(error), "bad")));
  $("btn-usdc").addEventListener("click", () => verifyUsdc().catch(error => log(friendlyError(error), "bad")));
  $("btn-random-ref").addEventListener("click", () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    $("settlement-ref").value = toHex(bytes);
  });

  $("input-text").addEventListener("input", () => {
    // Only refresh the displayed digest; logging on every keystroke is noise.
    hashInput().catch(() => {});
  });

  if (!window.ethereum) {
    setStatus("mm-state", "未检测到 MetaMask", "bad");
    log("提示：本页必须从 http://localhost / http://127.0.0.1 打开。file:// 打开时 Chrome 不会注入 MetaMask。", "warn");
  } else {
    connect({ silent: true });
  }
  newTaskId();
  hashInput().catch(() => {});
}

document.addEventListener("DOMContentLoaded", boot);
