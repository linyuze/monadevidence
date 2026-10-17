# 四处断点的代码证据

- 仓库：`/home/pkulzz/monad/agentledger`（commit `27e2a6e`）
- 方法：**反向搜索三类"连接物"**——(1) 谁能写链 `createWalletClient/writeContract`；(2) 谁监听链上状态变化 `watchContractEvent/createEventFilter/轮询`；(3) 谁调用下一段的入口函数。
- 统计口径：排除 `node_modules/`、`out/`、`sdk/dist/`（构建产物）。

---

## 0. 一句话结论

**整个仓库只有一个文件能写链：`examples/verifier/tools/anvil-acceptance.mjs`——它是本地 Anvil 测试脚手架，第 30-31 行强制要求 loopback HTTP 并拒绝公网 RPC，第 53-55 行用一次性随机私钥。** 除它之外，没有任何生产代码持有 wallet client、没有监听任何链上事件、没有调用下一段的入口函数。

也就是说：四段链路之所以"看起来"跑通，是因为**这一个测试文件把四段手动串起来了**；把测试拿掉，链路就散成四个互不调用的独立工具。

| 搜索项 | 命中（排除 `node_modules`/`dist`/`out`/测试） | 说明 |
|---|---|---|
| `createWalletClient` / `writeContract` / `deployContract` / `sendTransaction` | **文件数 = 1**：`anvil-acceptance.mjs` 共 6 处（18 import、41 `createWalletClient`、70 `deployContract`、88/104/133 `writeContract`） | 唯一能写链的文件 |
| `watchContractEvent` / `watchEvent` / `createEventFilter` | **0 处** | 无人监听链上事件 |
| `setTimeout(` | **3 处，全部与链无关**（2× `revokeObjectURL`、1× fetch abort） | 无轮询 |
| x402 闸门可用的 viem 符号 | `createPublicClient, hashTypedData, http, verifyTypedData` | **全是只读**，连 wallet 都没 import |
| 非测试的真实写入点（`functionName:"recordPayment"` / `"submitEvidence"`） | **1 个文件**：`anvil-acceptance.mjs:105,134` | 生产代码零写入 |

---

## 0.5 运行时证据（不只是静态搜索）

让 x402 闸门在真实链上完成一次**完全合法的付款授权**（真 EIP-712 报价签名 + 真 EIP-3009 转账签名 + 真 python 预扣库），然后立刻回读链上状态：

```
── 基线 ──
链上状态（刚创建）                              Created

── 让 x402 闸门完成一次合法付款授权 ──
闸门返回                                       ONE_PAYMENT_ATTEMPT_RESERVED
预扣结果                                       RESERVED_FIRST_ATTEMPT

── 关键：链上有没有自己动？ ──
链上状态（闸门成功后）                            Created
payer / amount / settlementRef                 0x00000000… / 0 / 0x00000000…

── 执行器能不能自动接手？ ──
runDemoTask                                    拒绝：task is not Paid on chain
```

**闸门"付款成功"了，链上仍然一个字都没变**（`payer` 还是零地址、`amount` 还是 0、`settlementRef` 还是 0）。执行器也因此拒绝运行。

这就是断点 1 和断点 2 的运行时铁证：**结算成功 ≠ 链上 Paid ≠ 执行开始**，三件事之间没有任何代码连接。

---

## 断点 1：结算成功 → 链上 `recordPayment`

**应该存在什么**：x402 结算成功后，由 recorder 自动调用 `recordPayment`。

**实际代码**：结算后的唯一动作是**写一个本地 JSON 文件**。

`examples/x402-gate/server.mjs:63-92`
```js
server.onAfterSettle(async ({ result, paymentPayload }) => {
  if (result?.success !== true || ...) {
    console.error("UNRECORDED settlement: unexpected result; manual reconciliation required");
    return;
  }
  const pending = { schemaVersion: "agentledger.pending-x402.v1", ..., verified: false,
    note: "Untrusted until RPC verification and independent task/quote authorization check. ..." };
  try {
    writeFileSync(`${receiptsDir}/${transaction}.json`, JSON.stringify(pending, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });          // ← 只有文件写入，没有链上调用
  } catch (error) { ... }
});
```

闸门模块本身**没有能力**发交易——它 import 的 viem 符号全是只读的：

`examples/x402-gate/lib/challenge-guard.mjs:8-10`
```js
import {
  createPublicClient, hashTypedData, http, verifyTypedData,
} from "viem";
```

**全仓 `recordPayment` 共 21 处出现，逐条归类**：

| 位置 | 性质 |
|---|---|
| `src/AgentLedger.sol:74` | 合约定义 |
| `examples/verifier/tools/anvil-acceptance.mjs:105, 108` | **唯一的真实写入**（本地测试，注释 `SIMULATED`） |
| `examples/verifier/lib/live-acceptance.mjs:21, 22, 227` | `parseAbiItem` + **校验历史交易的 input**，只读 |
| `examples/verifier/lib/payment-approval.mjs:41, 51` | 生成候选方法名字符串，只打印 |
| `examples/verifier/lib/reconcile-task.mjs:51` | 一句提示人类"manually calling recordPayment" |
| `tools/settlement.mjs:185` | `console.error('... do not call recordPayment ...')` |
| `test/AgentLedger.t.sol`（7 处）、`examples/verifier/test/live-acceptance.test.mjs`（3 处）、`sdk/test/consumer.ts:34` | 测试 |
| `examples/verifier/tools/prepare-record.mjs:94` | 输出 `status: "PREPARED_FOR_RECORDER_REVIEW_NOT_SUBMITTED"` |

**最硬的一条**：SDK 用 TypeScript 编译期断言"我没有这个方法"——

`sdk/test/consumer.ts:32-34`
```ts
// @ts-expect-error no private wallet/chain-write method
sdk.recordPayment("0x","0x");
```
`@ts-expect-error` 的含义是：**如果这个方法存在，类型检查就会失败**。即 SDK 主动把自己设计成"不可能写链"。

---

## 断点 2：链上 `Paid` → 执行器

**应该存在什么**：监听 `PaymentAttested` 事件（或轮询 `getTask`），发现 `status == Paid` 就触发执行。

**实际代码**：**零监听**。

```bash
$ grep -rn "watchContractEvent\|watchEvent\|createEventFilter" --include="*.mjs" --include="*.ts" .
（无输出）
```

仅有的 3 个 `setTimeout` 全部与链无关：
- `apps/pocket/src/export-summary.ts:17` → `URL.revokeObjectURL`
- `apps/pocket/src/observe.ts:49` → fetch 超时 abort
- `examples/verifier/public/app.mjs:220` → `URL.revokeObjectURL`

`runDemoTask` 全仓共 11 处出现，**没有一处是"被链上事件触发"**：

| 位置 | 数量 | 性质 |
|---|---|---|
| `examples/verifier/tools/run-demo-task.mjs:38` | 1 | 函数定义 |
| `examples/verifier/tools/run-demo-task.mjs:84` | 1 | **自身 CLI 入口**（人工敲命令） |
| `examples/verifier/tools/anvil-acceptance.mjs:21, 99, 124, 129` | 4 | 1 处 import + 3 处测试脚手架调用 |
| `examples/verifier/test/run-demo-task.test.mjs:8, 38, 50, 55, 61` | 5 | 1 处 import + 4 处单测 |

执行器自己也只是"检查链上是否已 Paid"，而不是"被链上事件叫醒"：

`examples/verifier/tools/run-demo-task.mjs:56-58`
```js
const task = await lookup(chain, contract, taskId);
if (task.status !== "Paid") throw Error("task is not Paid on chain");
```
这是一个**被动检查**，需要有人先来调用它。

---

## 断点 3：执行完成 → `submitEvidence`

**应该存在什么**：`runDemoTask` 产出 Evidence 后，把 `evidenceHash` 提交上链。

**实际代码**：函数返回，并在返回值里写明"这一步要人来做"。

`examples/verifier/tools/run-demo-task.mjs:73-77`
```js
return {
  status: "EXECUTED_OFFCHAIN_NOT_ANCHORED",
  taskId: evidence.taskId, outputPath, evidencePath,
  evidenceHash: evidenceHash(evidence),
  note: "Manual authorized submitEvidence is required; hash match does not prove execution correctness.",
};
```

`submitEvidence` 全仓共 16 处出现，**真实写入同样只有一处**：

| 位置 | 性质 |
|---|---|
| `src/AgentLedger.sol:97` | 合约定义 |
| `examples/verifier/tools/anvil-acceptance.mjs:134, 137, 184` | **唯一的真实写入**（本地测试；137/184 是收据与清单） |
| `examples/verifier/lib/live-acceptance.mjs:24, 25, 244` | ABI + 校验历史交易 input，只读 |
| `examples/verifier/tools/run-demo-task.mjs:76` | 一句提示字符串 |
| `test/AgentLedger.t.sol`（5 处）、`examples/verifier/test/live-acceptance.test.mjs`（3 处） | 测试 |

---

## 断点 4：`Proven` → 只读验证层

**应该存在什么**：链上出现 `EvidenceAnchored` 后，验证 UI 自动刷新（事件推送或轮询）。

**实际代码**：验证服务是纯请求驱动的两个 GET 路由，**没有任何推送通道**。

`examples/verifier/server.mjs:37-42`
```js
if (req.method !== "GET") return send(res, 405, JSON.stringify({ error: "read-only endpoint" }));
...
if (url.pathname === "/api/healthz") { ... }
if (url.pathname === "/api/task") { ... }
```
无 SSE、无 WebSocket、无长轮询；静态资源是 6 条白名单（`server.mjs:8-15`）。

手机端同样没有连接能力：

`apps/pocket/src/observe.ts:2-3`
```ts
// Narrow, task-only HTTP adapter. No JSON-RPC client, wallet, custom transport,
// arbitrary URL parameter or write method is exposed by the app.
```
`apps/pocket/src/export-summary.ts:3`
```ts
// JSON file and opens OS share sheet. No uploads, signers or RPC requests.
```

所以"锚定完成"这件事**不会自动传到任何界面**——必须有人手动刷新页面、重新输入 contract + taskId 才会看到 `Proven`。

---

## 反证：为什么它"看起来"是端到端的

因为 `anvil-acceptance.mjs` 一个文件里把四段全串了，但它自己声明了不能用于真实场景：

`examples/verifier/tools/anvil-acceptance.mjs:30-31`
```js
assert.equal(url.protocol, "http:", "Anvil acceptance requires loopback HTTP, not public HTTPS");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Anvil only; nonlocal RPC refused");
```
`examples/verifier/tools/anvil-acceptance.mjs:53-55`
```js
const creator = privateKeyToAccount(generatePrivateKey());
const recorder = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey());
```
一次性随机私钥 + 强制 loopback = 它**在设计上就不可能**成为生产编排器。

而且它产出的验收清单也如实标注了这一点（实测输出）：

```json
"network": "ANVIL_LOCAL_SIMULATION_NOT_MONAD_TESTNET",
"paymentMode": "SIMULATED_RECORDER_ATTESTATION_NO_USDC_TRANSFER",
"result": "PASS_LOCAL_EVM_ONLY"
```

---

## 复现命令（已实测，附真实输出）

```bash
cd /home/pkulzz/monad/agentledger
EX='--include=*.mjs --include=*.ts --include=*.tsx'
SKIP='grep -v node_modules | grep -v /dist/ | grep -v /test/ | grep -v \.test\.'
```

**证据 1：谁能写链（期望文件数 = 1）**
```bash
grep -rn "createWalletClient\|writeContract\|deployContract\|sendTransaction" $EX . \
  | grep -v node_modules | grep -v "/dist/" | grep -v "/test/" | grep -v "\.test\." \
  | cut -d: -f1 | sort -u
```
实测输出：
```
./examples/verifier/tools/anvil-acceptance.mjs
```

**证据 2：有没有人监听链（期望 0）**
```bash
grep -rn "watchContractEvent\|watchEvent\|createEventFilter" --include="*.mjs" --include="*.ts" . \
  | grep -v node_modules | wc -l
```
实测输出：`0`

**证据 3：真实写入点（排除测试，期望只有 anvil-acceptance）**
```bash
grep -rn 'functionName:"recordPayment"\|functionName:"submitEvidence"' --include="*.mjs" . \
  | grep -v node_modules | grep -v "/test/" | grep -v "\.test\."
```
实测输出：
```
./examples/verifier/tools/anvil-acceptance.mjs:105:  ... functionName:"recordPayment",
./examples/verifier/tools/anvil-acceptance.mjs:134:  ... functionName:"submitEvidence",
```

**证据 4：验证服务有没有推送通道（期望只有两个 GET 路由）**
```bash
grep -n "text/event-stream\|WebSocket\|EventSource\|/api/" examples/verifier/server.mjs
```
实测输出：
```
39:      if (url.pathname === "/api/healthz") {
42:      if (url.pathname === "/api/task") {
```
（另有第 37 行 `if (req.method !== "GET") return send(res, 405, ...)` 强制只读）

**证据 5：SDK 主动声明自己没有写链方法**
```bash
grep -n -B1 "sdk.recordPayment" sdk/test/consumer.ts
```
实测输出：
```
33-// @ts-expect-error no private wallet/chain-write method
34:sdk.recordPayment("0x","0x");
```

**计数核对（实测值）**
```bash
for kw in recordPayment submitEvidence runDemoTask; do
  echo "$kw: $(grep -rn $kw --include='*.mjs' --include='*.ts' --include='*.sol' . \
    | grep -v node_modules | grep -v '/dist/' | grep -v '^./out/' | wc -l)"
done
```
实测输出：`recordPayment: 21` / `submitEvidence: 16` / `runDemoTask: 11`

---

## 补充：这四处断点是"设计选择"，不是"忘记写"

判断依据：仓库里有大量**明确阻止自动化**的代码和文案，而不是缺代码。

| 证据 | 位置 |
|---|---|
| `status: "PREPARED_FOR_RECORDER_REVIEW_NOT_SUBMITTED"` | `tools/prepare-record.mjs:94` |
| `"Reconfirm Monad finality and recorder authority before manually calling recordPayment; NEVER pay again."` | `lib/reconcile-task.mjs:51` |
| `'VERIFIED TRANSFER ONLY; do not call recordPayment without independently proving task-bound payment authorization.'` | `tools/settlement.mjs:185` |
| `note: "Manual authorized submitEvidence is required..."` | `tools/run-demo-task.mjs:76` |
| `acceptPayment:false, charge:false, sign:false, mutateLedger:false` | `sdk/src/index.mjs:17-21` |
| `// @ts-expect-error no private wallet/chain-write method` | `sdk/test/consumer.ts:32-34` |

**所以准确的说法是**：项目**刻意**把"钱→链→执行→存证"之间的每一步都留给人工确认，以换取"绝不误扣款、绝不伪造付款"。代价是它无法作为一个自动化系统运行——要闭环，缺的不是几行胶水，而是一整套**带授权、可审计、失败可重试的编排器 + 密钥托管（多签/HSM）**。
