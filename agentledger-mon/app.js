// SPDX-License-Identifier: Apache-2.0
// Browser entry point. The only thing this file adds to pipeline.mjs is a
// transport that goes through MetaMask and a bit of rendering — the payment
// logic itself is shared with the headless runner (see headless.mjs).

import { runMonPayment, STEP_LABELS } from "./pipeline.mjs";
import { parseMon, formatMon, NETWORK, CHAIN_ID_HEX } from "./mon-evidence.mjs";
import {
  deployData, getTaskData, decodeTask, paymentRecorderData, decodeAddress,
} from "./abi.js";

const $ = id => document.getElementById(id);
const STEP_ORDER = Object.keys(STEP_LABELS);

const state = {
  account: null,
  chainId: null,
  artifact: null,
  last: null,
};

// ---------------------------------------------------------------- utilities
// Fire-and-forget diagnostics: every line the panel shows also lands in
// logs/run-<date>.jsonl on the WSL side, so a failure in the user's browser is
// still readable from here.
function postLog(payload) {
  try {
    fetch("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "panel",
        account: state.account,
        chainId: state.chainId,
        ...payload,
      }),
    }).catch(() => {});
  } catch { /* diagnostics must never break the flow */ }
}

function log(message, kind = "info") {
  postLog({ kind: "log", level: kind, message });
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
  const prefix = kind === "error" ? "✘ " : kind === "ok" ? "✔ " : "· ";
  $("log").textContent = prefix + line + "\n" + $("log").textContent;
}

const short = (value, head = 10, tail = 8) =>
  typeof value === "string" && value.length > head + tail + 3
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : String(value);

function setText(id, value) { const node = $(id); if (node) node.textContent = value; }

function bigintReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }

// ------------------------------------------------------------- transport
const MONAD = {
  chainId: CHAIN_ID_HEX,
  chainName: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: ["https://testnet-rpc.monad.xyz"],
  blockExplorerUrls: ["https://testnet.monadscan.com"],
};

function pickProvider() {
  const injected = window.ethereum;
  if (!injected) throw new Error("没有检测到 window.ethereum，请确认 MetaMask 已安装并在本页启用");
  if (Array.isArray(injected.providers) && injected.providers.length) {
    return injected.providers.find(provider => provider.isMetaMask) || injected.providers[0];
  }
  return injected;
}

const transport = {
  async request(method, params) {
    const provider = pickProvider();
    try {
      return await provider.request({ method, params });
    } catch (error) {
      // EIP-1193: 4001 = user rejected, -32000..-32099 = node-level failure
      const message = error?.message || String(error);
      const wrapped = new Error(message);
      wrapped.code = error?.code;
      wrapped.data = error?.data;
      throw wrapped;
    }
  },
};

const hexToBig = value => BigInt(value ?? "0x0");

async function readBalance(address) {
  const hex = await transport.request("eth_getBalance", [address, "latest"]);
  return hexToBig(hex);
}

// ------------------------------------------------------------------ wallet
async function connect() {
  try {
    const accounts = await transport.request("eth_requestAccounts", []);
    if (!accounts?.length) throw new Error("钱包没有返回账户");
    state.account = accounts[0];
    state.chainId = await transport.request("eth_chainId", []);
    setText("mm-state", state.account);
    setText("acct-a", state.account);
    setText("net-state", state.chainId === MONAD.chainId
      ? `Monad Testnet（${state.chainId}）`
      : `链 ${state.chainId}，需要切换到 ${MONAD.chainId}`);
    $("btn-run").disabled = false;
    await refreshBalances();
    log(`已连接 ${short(state.account)}，链 ${state.chainId}`, "ok");
  } catch (error) {
    log(`连接失败：${error.message}`, "error");
  }
}

async function refreshBalances() {
  if (!state.account) return;
  try {
    const [a, b] = await Promise.all([
      readBalance(state.account),
      $("payee").value.trim() ? readBalance($("payee").value.trim()) : Promise.resolve(null),
    ]);
    setText("bal-a", `${formatMon(a)} MON`);
    if (b !== null) setText("bal-b", `${formatMon(b)} MON`);
  } catch (error) {
    log(`读余额失败：${error.message}`, "error");
  }
}

async function switchChain() {
  try {
    await transport.request("wallet_switchEthereumChain", [{ chainId: MONAD.chainId }]);
  } catch (error) {
    if (error.code === 4902 || /unrecognized chain/i.test(error.message || "")) {
      await transport.request("wallet_addEthereumChain", [MONAD]);
    } else {
      throw error;
    }
  }
  state.chainId = await transport.request("eth_chainId", []);
  setText("net-state", state.chainId === MONAD.chainId
    ? `Monad Testnet（${state.chainId}）`
    : `链 ${state.chainId}，需要切换到 ${MONAD.chainId}`);
  log(`网络已就绪：${state.chainId}`, "ok");
}

// ------------------------------------------------------------------ deploy
async function waitReceipt(hash, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await transport.request("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw new Error(`等不到回执：${hash}`);
}

async function loadArtifact() {
  if (!state.artifact) {
    const response = await fetch("/artifact.json", { cache: "no-store" });
    if (!response.ok) throw new Error("读不到 artifact.json");
    state.artifact = await response.json();
  }
  return state.artifact;
}

async function deploy() {
  try {
    if (!state.account) throw new Error("先连接 MetaMask");
    const artifact = await loadArtifact();
    const data = deployData(artifact.bytecode, state.account);
    log("请在 MetaMask 中确认部署交易…");
    const hash = await transport.request("eth_sendTransaction", [{ from: state.account, data }]);
    log(`部署已提交：${hash}`);
    const receipt = await waitReceipt(hash);
    if (receipt.status !== "0x1") throw new Error("部署交易 revert");
    $("contract").value = receipt.contractAddress;
    localStorage.setItem("agentledger.mon.contract", receipt.contractAddress);
    log(`合约已部署：${receipt.contractAddress}（recorder = 账户 A）`, "ok");
    await refreshBalances();
  } catch (error) {
    log(`部署失败：${error.message}`, "error");
  }
}

// ------------------------------------------------------------------- steps
function renderStepShell() {
  const list = $("steps");
  list.textContent = "";
  for (const id of STEP_ORDER) {
    const li = document.createElement("li");
    li.dataset.step = id;
    li.className = "step pending";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "待";
    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "step-title";
    title.textContent = STEP_LABELS[id];
    const rpc = document.createElement("code");
    rpc.className = "step-rpc";
    rpc.textContent = "";
    const detail = document.createElement("div");
    detail.className = "step-detail";
    body.append(title, rpc, detail);
    li.append(badge, body);
    list.append(li);
  }
}

function updateStep(record) {
  const li = $("steps").querySelector(`li[data-step="${record.id}"]`);
  if (!li) return;
  li.className = `step ${record.status}`;
  const badge = li.querySelector(".badge");
  badge.textContent = record.status === "ok" ? "✔"
    : record.status === "fail" ? "✘"
    : record.status === "warn" ? "!"
    : record.status === "running" ? "…" : "待";
  if (record.rpc) li.querySelector(".step-rpc").textContent = record.rpc;
  if (record.detail) li.querySelector(".step-detail").textContent = record.detail;
}

// --------------------------------------------------------------------- run
function collectOptions() {
  const contract = $("contract").value.trim();
  const payee = $("payee").value.trim();
  const amountText = $("amount").value.trim();
  const taskId = $("task-id").value.trim();
  const description = $("description").value.trim();

  if (!state.account) throw new Error("先连接 MetaMask");
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error("合约地址格式不对");
  if (!/^0x[0-9a-fA-F]{40}$/.test(payee)) throw new Error("账户 B 地址格式不对");
  if (!/^0x[0-9a-fA-F]{64}$/.test(taskId)) throw new Error("taskId 必须是 32 字节十六进制");
  if (!description) throw new Error("任务说明不能为空");

  const amountAtomic = parseMon(amountText);
  if (amountAtomic <= 0n) throw new Error("金额必须大于 0");
  if (payee.toLowerCase() === state.account.toLowerCase()) {
    throw new Error("账户 B 与账户 A 相同。请在 MetaMask 里再加一个账户，填它的地址");
  }
  return { contract, payee, amountAtomic, taskId, description };
}

async function run() {
  const button = $("btn-run");
  button.disabled = true;
  $("save-state").textContent = "";
  try {
    const options = collectOptions();
    if (state.chainId !== MONAD.chainId) await switchChain();

    renderStepShell();
    log(`开始：${formatMon(options.amountAtomic)} MON  ${short(state.account)} → ${short(options.payee)}`);

    const result = await runMonPayment({
      transport,
      contract: options.contract,
      taskId: options.taskId,
      description: options.description,
      from: state.account,
      to: options.payee,
      valueAtomic: options.amountAtomic,
      maxBudgetAtomic: options.amountAtomic,
    }, {
      onStep: record => {
        updateStep(record);
        postLog({ kind: "step", step: record.id, status: record.status, detail: record.detail, rpc: record.rpc });
        if (record.status === "fail") log(`${STEP_LABELS[record.id] || record.id} 失败：${record.detail}`, "error");
      },
      onEvidence: async built => {
        // Write the evidence the moment it exists. Steps 7-8 may still fail, but
        // the transfer is already on chain, so the proof must already be on disk.
        try {
          const response = await fetch("/api/evidence", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              schemaVersion: "agentledger.mon-payment-bundle.v1",
              source: "browser",
              complete: false,
              network: built.network,
              contract: built.contract,
              taskId: built.taskId,
              transfer: { transactionHash: built.transferHash },
              evidence: built.evidence,
              evidenceCanonical: built.canonical,
              evidenceHash: built.hash,
              settlementRef: built.settlementRef,
            }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
          $("save-state").textContent = `付款证据已先落盘：${payload.path}`;
          postLog({ kind: "evidence", level: "ok", message: `partial saved: ${payload.path}` });
        } catch (error) {
          postLog({ kind: "evidence", level: "error", message: `partial save failed: ${error.message}` });
          log(`证据先落盘失败（不影响链上结果）：${error.message}`, "error");
        }
      },
    });

    state.last = result;
    renderResult(result);
    await saveEvidence(result);
    log(`完成：7 项核对全部通过，证据 ${short(result.evidenceHash)}`, "ok");
    await refreshBalances();
  } catch (error) {
    log(`执行中断：${error.message}`, "error");
    if (error.step) updateStep({ id: error.step, status: "fail", detail: error.message });
  } finally {
    button.disabled = false;
  }
}

function renderResult(result) {
  setText("evidence-hash", result.evidenceHash);
  $("evidence-canonical").textContent = result.evidenceCanonical;
  setText("task-state", result.task.status);
  setText("task-payer", result.task.payer);
  setText("task-amount", `${formatMon(result.task.amountAtomic)} MON`);
  setText("task-sref", result.task.settlementRef);
  setText("task-ehash", result.task.evidenceHash);

  const table = $("checks");
  table.textContent = "";
  const head = table.insertRow();
  for (const label of ["核对项", "期望", "实际", "结果"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  for (const check of result.checks) {
    const row = table.insertRow();
    row.className = check.ok ? "ok" : "bad";
    for (const value of [check.name, check.expected ?? "", check.actual ?? "", check.ok ? "✔" : "✘"]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      if (typeof value === "string" && value.startsWith("0x")) cell.className = "mono";
      row.append(cell);
    }
  }
  $("btn-download").disabled = false;
}

function bundleOf(result) {
  return {
    schemaVersion: "agentledger.mon-payment-bundle.v1",
    source: "browser",
    network: result.network,
    contract: result.contract,
    taskId: result.taskId,
    transfer: {
      from: result.payer,
      to: result.payee,
      valueAtomic: result.amountAtomic,
      valueMon: result.amountMon,
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
}

async function saveEvidence(result) {
  try {
    const response = await fetch("/api/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundleOf(result)),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    $("save-state").textContent = `已保存：${payload.path}`;
    log(`证据已落盘：${payload.path}`, "ok");
  } catch (error) {
    $("save-state").textContent = `保存失败：${error.message}`;
    log(`证据保存失败（链上哈希仍然有效）：${error.message}`, "error");
  }
}

function download() {
  if (!state.last) return;
  const blob = new Blob([JSON.stringify(bundleOf(state.last), bigintReplacer, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.last.taskId}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- readback
async function readback() {
  try {
    const contract = $("contract").value.trim();
    const taskId = $("task-id").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error("先填合约地址");
    const raw = await transport.request("eth_call", [{ to: contract, data: getTaskData(taskId) }, "latest"]);
    const task = decodeTask(raw);
    setText("task-state", task.status);
    setText("task-payer", task.payer);
    setText("task-amount", `${formatMon(task.amountAtomic)} MON`);
    setText("task-sref", task.settlementRef);
    setText("task-ehash", task.evidenceHash);
    log(`读回：${task.status} · ${formatMon(task.amountAtomic)} MON`, "ok");
  } catch (error) {
    log(`读回失败：${error.message}`, "error");
  }
}

// --------------------------------------------------------------- precheck
// Read-only: reads chain id, accounts, both balances and the contract's recorder
// without asking MetaMask to sign anything. Run this first to prove the page is
// talking to Monad testnet with the accounts you think it is.
async function precheck() {
  try {
    const chainId = await transport.request("eth_chainId", []);
    const accounts = await transport.request("eth_accounts", []);
    const payer = state.account || accounts[0] || null;
    const payee = $("payee").value.trim();
    const contract = $("contract").value.trim();

    log(`链 ID：${chainId}${chainId === MONAD.chainId ? "（Monad Testnet ✓）" : "（不是 Monad Testnet ✗）"}`, chainId === MONAD.chainId ? "ok" : "error");
    if (!payer) {
      log("MetaMask 还没有把账户交给本页：先点「连接 MetaMask（账户 A）」", "error");
      return;
    }
    state.account = payer;
    state.chainId = chainId;
    setText("mm-state", payer);
    setText("acct-a", payer);
    setText("net-state", chainId === MONAD.chainId ? `Monad Testnet（${chainId}）` : `链 ${chainId}`);
    $("btn-run").disabled = chainId !== MONAD.chainId;

    const payerBalance = await readBalance(payer);
    log(`账户 A ${payer}：${formatMon(payerBalance)} MON`, "ok");
    if (/^0x[0-9a-fA-F]{40}$/.test(payee)) {
      const payeeBalance = await readBalance(payee);
      log(`账户 B ${payee}：${formatMon(payeeBalance)} MON`, "ok");
      setText("bal-b", `${formatMon(payeeBalance)} MON`);
      if (payee.toLowerCase() === payer.toLowerCase()) log("账户 B 和账户 A 是同一个地址，不能用来证明转账", "error");
    } else {
      log("账户 B 地址格式不对", "error");
    }
    setText("bal-a", `${formatMon(payerBalance)} MON`);

    if (/^0x[0-9a-fA-F]{40}$/.test(contract)) {
      const code = await transport.request("eth_getCode", [contract, "latest"]);
      if (!code || code === "0x") {
        log(`合约 ${contract} 上没有代码：这个地址在当前链不存在，需要先部署`, "error");
      } else {
        const raw = await transport.request("eth_call", [{ to: contract, data: paymentRecorderData() }, "latest"]);
        const recorder = decodeAddress(raw);
        const matches = recorder.toLowerCase() === payer.toLowerCase();
        log(`合约 recorder = ${recorder}${matches ? "（就是账户 A ✓）" : "（不是账户 A，recordPayment 会 revert ✗）"}`, matches ? "ok" : "error");
      }
    } else {
      log("还没填合约地址：第一次跑需要先点「部署新合约」", "info");
    }
    const need = 10n ** 18n;
    log(payerBalance >= need ? "余额够跑一次 1 MON 转账" : "余额不足 1 MON，先去 faucet.monad.xyz 领取", payerBalance >= need ? "ok" : "error");
  } catch (error) {
    log(`自检失败：${error.message}`, "error");
  }
}

// -------------------------------------------------------------------- boot
function randomTaskId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function init() {
  $("btn-connect").addEventListener("click", connect);
  $("btn-precheck").addEventListener("click", precheck);
  $("btn-switch").addEventListener("click", () => switchChain().catch(error => log(`切链失败：${error.message}`, "error")));
  $("btn-deploy").addEventListener("click", deploy);
  $("btn-use-contract").addEventListener("click", () => {
    localStorage.setItem("agentledger.mon.contract", $("contract").value.trim());
    log("已记住合约地址");
  });
  $("btn-new-task").addEventListener("click", () => { $("task-id").value = randomTaskId(); });
  $("btn-run").addEventListener("click", run);
  $("btn-download").addEventListener("click", download);
  $("btn-save").addEventListener("click", () => state.last ? saveEvidence(state.last) : log("还没有可保存的证据", "error"));
  $("btn-readback").addEventListener("click", readback);
  $("payee").addEventListener("change", refreshBalances);

  $("task-id").value = randomTaskId();
  const saved = localStorage.getItem("agentledger.mon.contract");
  if (saved) $("contract").value = saved;
  $("btn-run").disabled = true;
  $("btn-download").disabled = true;

  window.addEventListener("error", event => postLog({ kind: "uncaught", message: String(event.message) }));
  window.addEventListener("unhandledrejection", event =>
    postLog({ kind: "unhandledrejection", message: String(event.reason?.message || event.reason) }));

  if (!window.ethereum) {
    setText("mm-state", "未检测到 MetaMask");
    log("没有 window.ethereum：请在装了 MetaMask 的 Chrome 里打开本页");
  } else {
    log("页面就绪。先点「连接 MetaMask（账户 A）」");
  }
}

init();
