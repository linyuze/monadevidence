# AgentLedger 端到端实测报告

- 被测代码：`/home/pkulzz/monad/agentledger`（commit `27e2a6e`，工作区干净、未改动源码）
- 运行环境：WSL Ubuntu 22.04 / Node v24.21.0 / Python 3.10.12 / Foundry 1.8.5 / solc 0.8.27
- 实测时间：2026-10-17
- 结论：**代码质量与安全自律程度高于一般黑客松项目，全部自动化测试 140/140 通过，本地端到端链路（部署→建任务→付款→执行→锚定→读回）可跑通。但它不是"支付-执行-证明"的自动化系统，而是一套"五段人工接力 + 大量只读核对工具"；链上 `Paid` 本质是单点可信证词；Phase 0 文档里的 `Created` 状态在公开只读路径上实际不可达（已实测复现）。**

---

## 一、端到端跑通结果

### 1.1 自动化测试矩阵（全绿）

| 套件 | 命令 | 结果 |
|---|---|---|
| Solidity 合约 | `forge test -vvv` | **8 / 8 pass** |
| 根目录 Node（evidence / settlement / phase0） | `node --test test/*.test.mjs` | **21 / 21 pass** |
| Python 预扣与准入日志 | `python3 -m unittest discover -s test -p 'test_*journal.py'` | **12 / 12 pass** |
| 只读验证服务 examples/verifier | `node --test test/*.test.mjs` | **64 / 64 pass** |
| SDK `@agentledger/verify` | `node --test test/*.test.mjs` | **14 / 14 pass** |
| SDK 打包契约 | `npm run build && npm run packcheck` | **PASS**（导出仅 `.`，无写链能力） |
| x402 支付闸门 | `node --test test/*.test.mjs` | **6 / 6 pass** |
| 移动端 apps/pocket（纯逻辑） | esbuild 打包后 `node --test` | **15 / 15 pass** |
| **合计** | | **140 / 140** |

> 说明：`apps/pocket` 正常需要完整 Expo 工具链（离线不可安装），我把它 4 个只依赖 `@noble/hashes` 的单测用 esbuild 打包成 mjs 后跑通；`App.tsx` / `local-files.ts` 这类依赖 react-native 的 UI 代码未做运行时验证。

### 1.2 真正的端到端链路（本地 Anvil，chainId 10143）

`node examples/verifier/tools/anvil-acceptance.mjs` → **`PASS_LOCAL_EVM_ONLY`**

实测产生的完整链路（真实交易哈希、真实字节码、真实事件）：

```
deploy(AgentLedger, recorder)            0xdb4e3c44…
  → createTask(taskId, descHash, 1000)   0xe26236a9…   status = Created
  → [未付款时] runDemoTask 被拒绝（"not Paid"）        ← 负向断言通过
  → recordPayment(...) 【模拟证词，无 USDC】 0x02deabe6…   status = Paid
  → runDemoTask → 确定性工具 → Evidence JSON           status = EXECUTED_OFFCHAIN_NOT_ANCHORED
  → submitEvidence(taskId, evidenceHash)  0xd90f1735…   status = Proven
  → 浏览器同源 HTTP /api/task 独立读回     status = Proven，evidenceHash 一致
  → Phase0 投影：state = PaymentUnknown（因为付款未经独立验证）
```

同时 `tools/demo-journey.mjs`（含 Lost-ACK 与跨 Ledger/错 payer 拒绝路径）输出 **SIMULATED JOURNEY PASS**。

### 1.3 其他实测通过项

| 项 | 结果 |
|---|---|
| Evidence CLI `create / hash / verify` | 哈希一致，篡改后 `ERROR: hash mismatch` |
| 只读服务 HTTP 行为 | `/api/healthz` 200；非法参数 400；POST 405；路径穿越 404；链上查不到 502 |
| **真实 Monad 测试网只读** | `eth_chainId` = `0x279f`(10143)，`eth_blockNumber` = 71,742,466；`/api/task` 返回 502 `no contract bytecode at address`（证明确实读到了真链，只是地址没合约） |
| `live-acceptance` 默认拒绝 | `PUBLIC_TESTNET_ACCEPTANCE_BLOCKED_NO_REVIEWED_DEPLOYMENT`（registry 为空即拒绝） |
| `facilitator-preflight` | 网络可达时 `PASS: Monad Testnet x402 exact advertised`；不可达时 fail-closed |
| **x402 闸门真实集成**（Anvil + 真实 EIP-712/EIP-3009 签名 + 真实 python 预扣库） | 见下表 8 个场景 |

x402 闸门集成实测（这是唯一没被单测覆盖的"真实链路"，我补做了）：

| # | 场景 | 实测结果 |
|---|---|---|
| 0 | 从真实链读 Created 任务 | `status=Created`，descriptionHash 匹配，maxBudget=1000 |
| 1 | 无付款头 | `CHALLENGE_ALLOWED`（允许发 402） |
| 2 | 篡改报价金额 | 拒绝：`quote amount mismatch` |
| 3 | 用别人的私钥签名 | 拒绝：`payer task signature invalid` |
| 4 | 合法 EIP-3009 付款重试 | `ONE_PAYMENT_ATTEMPT_RESERVED` |
| 5 | 相同请求重放（模拟丢 ACK） | 拒绝：`precharge reservation blocked…` |
| 6 | 换新 nonce 再买同一任务 | 拒绝（任务级唯一，不是 nonce 级） |
| 7 | 伪造 EIP-3009 签名 | 拒绝：`Invalid yParityOrV value` |

### 1.4 明确跑不通的部分（不是我偷懒，是设计/环境边界）

| 项 | 原因 |
|---|---|
| 真实测试网 x402 付费结算 | 需要真实测试网 USDC + 已审核部署；`phase0/reviewed-testnet-deployments.json` 的 `deployments` 是空数组 → 系统**故意**拒绝。这是设计，不是 bug |
| 真实测试网部署 AgentLedger | 需要 faucet 的测试 MON 与私钥；我没有、也不应该替你生成私钥 |
| x402 server 完整启动 | 启动时顶层 `await fetch(facilitator/supported)`，facilitator 域名间歇性不可解析（实测 DNS 失败）→ 进程直接崩（见问题 B3） |
| apps/pocket 的 UI 运行时 | 需要 Expo/React Native 全套依赖，离线缓存里没有 |

---

## 二、项目整体架构

### 2.1 一句话定位

一个**结算/存证适配器**（settlement & attestation adapter），不是第二个任务控制平面。它给已有 ACP（Agent Control Plane）补三件事：把"付了钱"记到链上、把"跑完了"的摘要锚到链上、把这两件事的核对过程做成可复现的只读工具。

### 2.2 分层

```
┌─────────────────────── 用户/运维入口 ───────────────────────┐
│ apps/pocket (Expo 手机端)   examples/verifier (浏览器 Studio) │
│  只读观察 · 本地 SHA-256    只读查询 · 本地 SHA-256 · 导出摘要 │
└───────────────────────────┬────────────────────────────────┘
                            │ GET-only /api/task（本机回环）
┌───────────────────────────▼────────────────────────────────┐
│ 读取层  examples/verifier/lib/  (viem)                       │
│  task-reader（chainId+bytecode+getTask）                      │
│  live-acceptance / reconcile-task / phase0-inspect            │
└───────────────────────────┬────────────────────────────────┘
                            │ JSON-RPC (HTTPS)
┌───────────────────────────▼────────────────────────────────┐
│ 链上  src/AgentLedger.sol                                    │
│  Created → Paid → Proven，仅存摘要，不持资金                  │
│  recordPayment 仅 paymentRecorder（immutable 单地址）可调      │
└───────────────────────────▲────────────────────────────────┘
                            │ 手工/授权写入（无自动化）
┌───────────────────────────┴────────────────────────────────┐
│ 结算层  examples/x402-gate/                                  │
│  EIP-712 任务报价 + EIP-3009 转账双签名校验 → python 预扣库    │
│  → @x402/express → 真实 facilitator → 落 pending receipt      │
└───────────────────────────┬────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────┐
│ 执行层  examples/verifier/tools/run-demo-task.mjs            │
│  确定性文本统计（非 LLM），要求链上已 Paid 且输入哈希匹配       │
└─────────────────────────────────────────────────────────────┘

横切：phase0/status.mjs（6 态只读投影）· sdk/（只读三方法）·
      tools/*.py（SQLite 预扣/准入日志）· tools/evidence.mjs（规范哈希）
```

### 2.3 两个状态机（这是理解全局的关键）

**链上（4 态，强约束）**
```
None → Created → Paid → Proven
       ↑仅创建者   ↑仅 recorder 证词   ↑创建者或 recorder，仅一次
```

**Phase 0 对外投影（6 态，只读、可矛盾）**
```
Created / PaymentUnknown / PaymentObserved / PaymentRecorded / EvidenceAnchored / Conflict
```
关键设计：**链上 `Paid` 只是"recorder 说付了"，投影层永远不会把它升级成"已验证付款"**。要变成 `PaymentRecorded`，必须有独立核对的 USDC `Transfer` + EIP-3009 `AuthorizationUsed` nonce + 预扣记录 + 任务绑定四件事同时成立。这是整个项目最核心、也最值得肯定的设计。

### 2.4 信任边界（谁信谁）

| 环节 | 信任假设 | 破了会怎样 |
|---|---|---|
| `recordPayment` | 完全信任 recorder 的链下核对 | 可给任意任务写任意金额（≤maxBudget）的"已付" |
| `settlementRef` | 只是不透明 bytes32，合约无法验证 | 无法自证与真实 USDC 转账的关联 |
| Evidence 哈希 | 只证明字节相等 | 不证明执行者真实、输出正确 |
| x402 预扣库 | 单机单 SQLite | 多机/多实例不成立 |
| facilitator | 外部服务 | 不可用则服务起不来（B3） |
| ACP | 执行权、租约、重试归 ACP | 本项目不承担 |

---

## 三、实测发现的问题

按严重程度排序。每条都给证据（文件位置或实测输出）。

### P0 — 影响产品成立与否

**P0-1　"Pay→Execute→Prove" 没有自动化，是五段人工接力**

没有任何一行代码在结算成功后调用 `recordPayment`，也没有任何代码在产出 Evidence 后调用 `submitEvidence`。x402 网关只写本地 pending receipt（`server.mjs:63-92`），执行器只产出本地 JSON。README 自己也写了 "still does NOT auto-call recordPayment or submitEvidence"。

> 实测印证：闸门成功预扣后，链上任务仍是 `Created`；必须人工再发两笔交易才到 `Proven`。
> 影响：这是一套**核对工具集**，不是可运行的支付闭环。作为黑客松 demo 可以，作为产品必须先补编排器（谁在什么条件下自动发 recordPayment，失败怎么重试，密钥怎么托管）。

**P0-2　链上 `Paid` 是单点可信证词，且 recorder 是不可更换的单 EOA**

`paymentRecorder` 是 `immutable`，无多签、无轮换、无暂停开关（`AgentLedger.sol:34,42-45`）。`recordPayment` 只校验 `msg.sender == paymentRecorder`，`settlementRef` 是调用方随便给的 bytes32。

> 影响：① recorder 私钥泄漏 = 可伪造任意付款；② recorder 私钥丢失 = 所有任务永久卡在 `Created`，无任何补救路径（合约无 admin、无迁移）。这是"去中心化记账"外观下的中心化单点。

**P0-3　Phase 0 的 `Created` 状态在公开只读路径上不可达（已实测复现）**

`projectPhase0` 只在 `status==="Created" && attempt==="NotStarted"` 时返回 `Created`（`phase0/status.mjs:110-114`）；而 `phase0-inspect.mjs:36-38` 拒绝调用方传入 `NotStarted`，除非 `deps.acpAuthoritativeNotStarted===true`——本项目没有任何 ACP 集成，所以这个条件永远为假。

实测（真实链上刚创建、未付款的任务）：
```
on-chain status      : Created
attempt=undefined      -> state=PaymentUnknown
attempt=NotEstablished -> state=PaymentUnknown
attempt=Reserved       -> state=PaymentUnknown
attempt=NotStarted     -> REFUSED: NotStarted requires authenticated ACP-owned context
```
> 影响：**文档承诺 6 个状态，实际只能产出 5 个**；最常见的"刚建好、还没付"被报成最吓人的 `PaymentUnknown`，且 CLI 退出码 3。运维看板上每个新任务都像异常。这是"安全默认"过度收紧导致的可观测性缺陷，建议增加显式 `CreatedUnpaid`（由链上 `Created` + 本地预扣库无记录 + 未提供付款证据三者共同支撑），或把 ACP 断言换成签名域分离的 ACP 令牌。

### P1 — 真实缺陷，会导致误判或不可用

**P1-1　`authorizeHttpRequest` 不转发 `deps.dbPath`，预扣库路径不可注入**

`challenge-guard.mjs:187` 调用 `reservePaymentAttempt(candidate)`，**没有传 `opts`**；因此函数内部 `opts.dbPath` 永远 undefined，只能靠环境变量 `AGENTLEDGER_CHARGE_DB` 或写死默认路径。

> 实测：我给 deps 传 `dbPath=/tmp/al-guard-charge.db`，结果那行记录落在 `receipts/charge-attempts.db`，`inspect` 查 /tmp 库返回 `PRECHARGE REFUSED: no precharge reservation exists`。
> 影响：单测靠注入 `deps.reserve` 绕过了这条路径，所以测试全绿但真实调用无法重定向数据库；多环境部署会互相污染同一个库。

**P1-2　x402 server 启动即崩：顶层 `await fetch(/supported)` 无重试**

`server.mjs:36-43` 在模块顶层 fetch facilitator，10 秒 `AbortSignal.timeout`，非 2xx 或超时直接 `throw`。

> 实测：facilitator 域名 DNS 抖动时，进程输出 `[DOMException [TimeoutError]: The operation was aborted due to timeout]` 直接退出，连 `/healthz` 都起不来。
> 影响：支付闸门是"要么全好要么全死"。应改为：启动成功、健康检查暴露 `facilitator: unavailable`、请求时返回 503 并保持 fail-closed。

**P1-3　`descriptionHash` 语义被重载**

- x402 路径：`descriptionHash` = 任务描述哈希（`challenge-guard.mjs:98` 与链上比对）
- 执行器：`run-demo-task.mjs` 里 `task.descriptionHash !== result.inputSha256` 就拒绝，即把同一个字段当**输入字节哈希**用

> 影响：两条链路对同一链上字段赋予不同含义。任何人按 x402 语义建任务，执行器就永远拒绝执行；反之亦然。建议拆成 `descriptionHash` + `inputHash` 两个字段（合约加一个 bytes32 很便宜）。

**P1-4　`maxBudget = 0` 等于"无上限"，而重载默认就是 0**

`AgentLedger.sol:51-56`：`createTask(taskId, descriptionHash)` 内部传 `maxBudget=0`，而 `recordPayment` 里 `if (task.maxBudget != 0 && amount > task.maxBudget)`——0 表示不限制。

> 影响：最省事的那个重载恰好是"没有预算上限"。建议改成 0 视为非法，或强制显式传 `type(uint256).max`。

**P1-5　任务没有过期时间**

合约无 `deadline`/`expiresAt`。一个 `Created` 任务可以在一年后被 `recordPayment` 变成 `Paid`。

> 影响：与 x402 报价的 `expiresAt`（≤24h）语义不一致——链下报价过期了，链上任务还永久有效，形成"过期报价 + 长期有效任务"的错配窗口。

### P2 — 代码质量与可维护性

**P2-1　合约测试无法断言"因为哪个 error 失败"**

`libs = []`，测试手写 `interface Vm { function prank(address) }`（`test/AgentLedger.t.sol:5-8`），没有 forge-std，因此不能用 `vm.expectRevert(AgentLedger.BudgetExceeded.selector)`，只能 `(bool ok,) = call(...); require(!ok)`。

> 影响：`testBudgetCap` 只证明"失败了"，不证明"因为超预算失败"——如果哪天因为别的原因 revert，测试照样绿。8 个测试的强度被这一限制整体拉低。建议装 forge-std（`forge install foundry-rs/forge-std`，本项目已在别的目录验证可安装）。

**P2-2　SDK 错误码靠正则匹配上游文案**

`sdk/src/index.mjs:54-73` 的 `classifyFailure` 用 `/wrong chain|RPC is not Monad Testnet/` 这类正则匹配 message 来映射 `SDK_CHAIN_MISMATCH` 等稳定码。

> 影响：viem 或本地模块改一句文案，错误码就静默变化（对"稳定 v1 错误契约"是硬伤）。建议上游抛带 `code` 的类型化错误，SDK 只做映射。

**P2-3　预扣失败原因被压成一句话**

`challenge-guard.mjs:160`：`if(job.status !== 0) throw Error("precharge reservation blocked or unavailable; reconcile before retry")`。

> 影响：python 没装、DB 锁冲突、超时、业务拒绝（`sys.exit(3)`）四种情况完全无法区分。实测里我只能靠单独查库才知道是"重复预留"。建议把 stderr/退出码透传成结构化错误。

**P2-4　金额双源，改价漏改即全线 403**

`server.mjs:26` 硬编码 `amountAtomic = "1000"` 与 `price: "$0.001"`，`challenge-guard.mjs:16` 另有 `AMOUNT_ATOMIC = "1000"`。

> 影响：fail-closed（安全），但改价只改一处会导致所有请求 `quote amount mismatch`，且错误信息不指向根因。应让 guard 从同一常量/配置读取。

**P2-5　畸形签名抛 viem 原生错误**

实测场景 7 返回 `Invalid yParityOrV value`，是 viem 内部错误直接冒泡。fail-closed 正确，但对外暴露实现细节，且不稳定。建议在 guard 层包一层域内错误。

**P2-6　`getTask` revert 导致"没有任务"和"RPC 故障"无法区分**

合约对 `Status.None` revert（`AgentLedger.sol:111`），只读服务统一捕获后返回同一句 502 `Chain lookup failed: confirm network, contract and task ID`（`server.mjs:59-63`）。

> 影响：运维无法判断是"地址/ID 写错"、"合约没部署"还是"节点挂了"。建议合约加 `tryGetTask` 返回 `(bool exists, Task)`，或服务层按 viem 错误类型细分 404/502/503。

### P3 — 工程与文档

| # | 问题 | 证据 |
|---|---|---|
| P3-1 | 常量无单一事实源 | `10143` 出现在 **38** 个源文件；USDC 地址 **7** 个文件；RPC URL **10** 个文件 |
| P3-2 | README 有字面 `\n\n` | 第 49 行 `See [SDK stability contract](sdk/README.md).\n\n**Implementation:**` |
| P3-3 | README 段落重复 | "Visual demo" 出现两次（65-74 行、76-97 行） |
| P3-4 | SDK 版本自相矛盾 | 同一段先写 `v0.2.0-alpha.3`，后写 `@agentledger/verify@0.2.0-alpha.2` |
| P3-5 | 路径与仓库结构不符 | README 通篇 `cd experiments/agentledger`，但仓库根就是 `agentledger` |
| P3-6 | `phase0/status.mjs` 是纯库无 CLI | README 让人"运行"它；实测 `node phase0/status.mjs` 无输出、退出 0 |
| P3-7 | pocket 的 `local-files.ts` 顶层 import expo/react-native | 导致 Node 下不可测，测试只能绕开；我只能用 esbuild 打包纯逻辑部分验证 |
| P3-8 | 依赖未锁定可离线复现 | `sdk` 需 viem、`pocket` 需 expo/tsx；缓存缺失即装不上（我实测靠 npm cache + 软链接才跑起来） |

---

## 四、值得肯定的地方（不是客套，是实测感受）

1. **负向断言写得极密**。64 个 verifier 测试里大量是"必须拒绝"：跨 Ledger 复用 taskId、错 payer、错 amount、丢失 nonce、reorg、HTML 响应、超大 JSON、路径穿越。这种"证明它不会做错事"的测试比"证明它能跑"更有价值。
2. **状态语义不被乐观升级**。链上 `Paid` 永远不等于"已验证付款"；`PaymentUnknown` 被明确定义为"既不是失败也不能重试"。这个反直觉的约束贯穿代码、测试和文档，执行得很彻底。
3. **预扣幂等做得实**。`charge-attempts.db` 用 SQLite 事务 + 唯一约束，实测"相同重放"和"换 nonce 再来"都被拦住，并发测试（`test_concurrent_processes_only_one_can_enter_payment_middleware`）也真的起了多进程。
4. **默认拒绝**。`reviewed-testnet-deployments.json` 空数组 → 真实测试网验收直接拒绝；SDK 禁 transport 注入；verifier 静态文件白名单 + 严格 CSP。安全默认贯彻到位。
5. **诚实标注**。到处是 `SIMULATED`、`NOT_MONAD_TESTNET`、`PaymentUnknown`、`BLOCKED_UNLESS_SEPARATELY_REVIEWED`，没有一处把模拟说成真实。

---

## 五、如果要继续推进，建议的顺序

| 优先级 | 动作 | 理由 |
|---|---|---|
| 1 | 修 P0-3（补 `CreatedUnpaid` 状态） | 一行投影逻辑，直接决定这套工具能不能被运维用 |
| 2 | 修 P1-1 / P1-2（dbPath 透传、启动不崩） | 都是小改动，但直接影响能否真实部署 |
| 3 | 拆 `descriptionHash` / `inputHash`（P1-3） | 否则两条链路永远对接不上 |
| 4 | 装 forge-std 重写合约测试（P2-1） | 让 8 个测试真正验证"因为什么失败" |
| 5 | recorder 换多签 + 加轮换/暂停（P0-2） | 从"黑客松 demo"到"敢托管"的必经之路 |
| 6 | 写编排器：结算成功 → 自动 recordPayment → 执行 → 自动 submitEvidence | 这才是 P0-1 的正解；但必须先有 1-5 的安全底座 |
| 7 | 收敛常量、修 README（P3） | 低成本，避免后来者踩坑 |

---

## 附：复现命令

```bash
cd /home/pkulzz/monad/agentledger

# 1. 全部单测
forge test -vvv
node --test test/*.test.mjs
python3 -m unittest discover -s test -p 'test_*journal.py' -v
(cd examples/verifier && node --test test/*.test.mjs)
(cd sdk && npm run build && node --test test/*.test.mjs && npm run packcheck)
(cd examples/x402-gate && node --test test/*.test.mjs)

# 2. 本地端到端（需 anvil）
anvil --port 18545 --chain-id 10143 --host 127.0.0.1 &
node examples/verifier/tools/anvil-acceptance.mjs     # 期望 PASS_LOCAL_EVM_ONLY
node examples/verifier/tools/demo-journey.mjs         # 期望 SIMULATED JOURNEY PASS

# 3. Evidence CLI
node tools/evidence.mjs create 0x<taskId> in.txt out.txt evidence.json
node tools/evidence.mjs hash evidence.json
node tools/evidence.mjs verify evidence.json 0x<onchainHash> in.txt out.txt

# 4. 真实测试网只读（需外网）
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  https://testnet-rpc.monad.xyz        # 期望 0x279f = 10143
```
