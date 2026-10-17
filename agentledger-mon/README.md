# AgentLedger · MON 真实支付（两账户互转 1 MON）

在 Monad 测试网上用**两个账户**做一笔真实的 1 MON 转账，然后把这笔转账变成一份可复核的证据，并把证据哈希锚定到链上。

这个目录解决的是之前那两个具体问题：

| 之前的问题 | 现在怎么解决 |
|---|---|
| **没有真正到交易**：全项目只有 `anvil-acceptance.mjs` 能写链，面板只会"记录一笔声称发生过的付款" | 流水线里真的调用 `eth_sendTransaction { from: A, to: B, value: 1e18 }`，并用 B 的余额增量 `+1 MON` 反过来证明它确实发生了 |
| **程序过程中不能自动化**：付款、记录、锚定、读回全靠手工交接 | 一条流水线串完 10 步，中间不需要复制任何东西；同一份代码还能 headless 零点击跑完（`headless.mjs`），证明逻辑本身没有手工环节 |

---

## 账户模型

| 角色 | 说明 |
|---|---|
| **账户 A** | 付款方。在 MetaMask 里当前选中的账户。它同时是合约的 `paymentRecorder`，所以由它签名 `recordPayment` |
| **账户 B** | 收款方，默认 `0xD7237D15B7abdf44d091350665e6a87f853cf4D6`。只收钱，不需要做任何操作 |

A 和 B 必须是**两个不同的地址**（流水线会直接拒绝相同地址，因为那样证明不了"转账"这件事）。在 MetaMask 里点右上角头像 →「添加账户」就能拿到第二个账户。

---

## 前置条件

| 项 | 要求 |
|---|---|
| 浏览器 | Windows 上的 Chrome，已装 MetaMask |
| 网络 | Monad Testnet，chainId `10143`（`0x279f`） |
| 测试币 | 账户 A 需要有 **1 MON + gas**。gas 约 0.002 MON/笔，全流程 4 笔。领取：<https://faucet.monad.xyz> |
| WSL | Node 22+（本机 v24.21.0） |

---

## 启动

```bash
cd ~/monad/agentledger-mon && bash start.sh     # 默认 8788
```

然后**在 Windows 的 Chrome 里**打开 `http://localhost:8788/`。

如果希望它一直挂着（关掉终端也不停），用常驻方式：

```bash
./serve.sh start     # 脱离会话启动，写 .server.pid
./serve.sh status    # 看 pid / 端口 / 健康检查
./serve.sh logs      # 看服务日志
./serve.sh stop      # 停止
```

`start.sh` 适合临时跑一下；`serve.sh` 用 `setsid` 脱离控制终端，关掉终端或结束对话都不会把它带走。

> 端口用 8788，是为了不和之前那个面板（8787）冲突，两个可以同时开着。

---

## 操作顺序

1. **连接 MetaMask（账户 A）** → 显示地址、余额、当前链
2. 如果链不对，点「添加 / 切换 Monad 测试网」
3. **部署新合约** → `paymentRecorder` 自动设成账户 A，合约地址记进 localStorage
4. 确认账户 B 的地址（默认已填好）、金额 `1`、说明、taskId
5. **一键执行**

之后会依次跑完：

```
preflight      eth_chainId / eth_getCode / eth_getBalance / eth_call
createTask     eth_call getTask → eth_sendTransaction createTask
transfer       eth_sendTransaction { from: A, to: B, value }
receipt        eth_getTransactionReceipt（轮询）
balanceDelta   eth_getBalance(B) 前后差必须精确等于 1 MON
evidence       eth_getTransactionByHash + eth_getBlockByNumber → SHA-256
recordPayment  eth_sendTransaction recordPayment
submitEvidence eth_sendTransaction submitEvidence
readback       eth_call getTask
verify         链上状态 vs 本地证据，7 项逐一比对
```

**需要你动手的只有 MetaMask 的确认弹窗**（部署 + 4 笔交易）。这不是偷懒，是钱包的硬约束：私钥在 Windows 的 MetaMask 里，任何签名都必须由你批准。除此之外的排序、等待、取值、比对、落盘全部自动。

---

## 自动化到什么程度

同一份 `pipeline.mjs`，换一个 transport 就能零点击跑完：

```bash
# 另一个终端先起一条本地链
anvil --port 18545 --chain-id 10143

node headless.mjs --rpc http://127.0.0.1:18545 --amount 1
```

Anvil 会替它自己的解锁账户签名，所以整条流水线没有任何人工环节，最后打印 `PASS — 真实 1 MON 转账已完成`，并把证据写到 `evidence/<taskId>.json`。

这说明：**逻辑层已经没有手工交接了**，浏览器版唯一多出来的就是"人点确认"。

---

## 证据长什么样

证据只由链上数据推导（receipt / tx / block），**不含本地时钟、不含随机数**。所以任何人拿到 tx hash 都能重建出同样的字节和同样的哈希。

```json
{
  "asset": "MON",
  "blockHash": "0x…",
  "blockNumber": "3",
  "effectiveGasPriceWei": "1770637627",
  "feeWei": "37183390167000",
  "from": "0x…A",
  "gasUsed": "21000",
  "network": "eip155:10143",
  "nonce": "2",
  "observedAt": "2026-10-17T08:25:06.000Z",
  "schemaVersion": "agentledger.mon-payment.v1",
  "settlementRef": "0x…",
  "status": "success",
  "taskId": "0x…",
  "to": "0x…B",
  "transactionHash": "0x…",
  "valueAtomic": "1000000000000000000",
  "valueMon": "1"
}
```

- `evidenceHash` = `sha256(canonical JSON)`，这个值被写进合约的 `evidenceHash`
- `settlementRef` = `sha256(JSON.stringify(["agentledger.settlement.v1", network, 0x0, txHash, 0]))`，沿用原项目的公式；MON 是原生币没有 Transfer 日志，所以资产位放零地址、logIndex 固定 0
- 合约用 `usedSettlementRefs` 做重放保护，同一个 `settlementRef` 第二次会被拒

证据有两个留存位置：**链上**（`evidenceHash`，永久）和 **本机**（`evidence/<taskId>.json`，浏览器点「保存到本机」时由本地服务写入）。

### 怎么复核

`verifyMonPaymentEvidence()` 不是只比摘要——它会把**存下来的文档**和**从链上重建的文档**各自规范化后逐字节比较。只比摘要是不够的：摘要本来就是从链上重建的，篡改过的字段照样能"通过"。

```js
const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
const tx      = await rpc('eth_getTransactionByHash', [txHash]);
const block   = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
await verifyMonPaymentEvidence(stored, { receipt, tx, block, taskId });
// -> { ok: true, classification: 'EVIDENCE_REPRODUCIBLE' }
// -> 被改过: { ok: false, classification: 'EVIDENCE_MUTATED', fields: ['valueAtomic'] }
```

---

## 测试

```bash
# 需要一条 chainId 10143 的 anvil 在 127.0.0.1:18545
anvil --port 18545 --chain-id 10143 &
node --test test/*.test.mjs
```

实测结果（2026-10-17）：

| 测试 | 断言内容 | 结果 |
|---|---|---|
| `parseMon / formatMon` | 18 位精度精确换算、拒绝 `1e18`/`01`/负数/超精度 | **pass** |
| `settlementRef` | 确定性、大小写无关、不同 tx 不同值 | **pass** |
| 规范证据防篡改 | 多字段/错 schema/错时间戳/错地址/金额与字符串不一致都拒绝 | **pass** |
| **真实 1 MON 转账** | B 余额精确 +1 MON；`gasUsed == 21000`；证据字段与 tx 一致；链上 `payer/amount/settlementRef/evidenceHash` 全部对上；10 步全 ok | **pass** |
| 证据可复现 | 只用 tx hash + receipt + block 重建，canonical 与哈希完全一致；篡改后被判 `EVIDENCE_MUTATED` | **pass** |
| 重放保护 | 复用已消费的 `settlementRef` 被合约拒绝 | **pass** |
| 预算上限 | 1 MON 上限下记 2 MON 被拒，记 1 MON 通过 | **pass** |
| recorder 权限 | 非 recorder 调用 `recordPayment` 被拒 | **pass** |
| 同地址拒绝 | A == B 时流水线直接报错 | **pass** |

合计 **9 / 9**。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `pipeline.mjs` | 流水线本体。只依赖一个 `request(method, params)`，浏览器和 headless 共用 |
| `mon-evidence.mjs` | MON 支付证据：规范 JSON、settlementRef、可复现校验 |
| `transport.mjs` | 纯 HTTP JSON-RPC（只读方法带重试，revert 不重试） |
| `headless.mjs` | 零点击跑完整条流水线，证据写盘 |
| `app.js` | 浏览器入口：MetaMask transport + 渲染 |
| `abi.js` / `sha256.js` | 零依赖 ABI 编解码 / SHA-256（WebCrypto + 纯 JS 兜底） |
| `server.mjs` | 静态服务 + `POST /api/evidence` 落盘 |
| `artifact.json` | 合约 ABI 与创建字节码（取自 `agentledger/out/`） |
| `test/pipeline.test.mjs` | 9 项测试 |

---

## 边界与已知限制

- **A 必须是 recorder**。合约里 `recordPayment` 只认 `paymentRecorder()`，所以部署时 recorder 就是账户 A。用别的地址部署会直接 revert（有测试覆盖）。
- **金额同时是 `maxBudget`**。合约用 `maxBudget != 0 && amount > maxBudget` 判断，所以 1 MON 上限下记 2 MON 会被拒。
- **`gasUsed` 固定 21000** 只对纯转账成立；一旦收款地址是合约或有 data，这个断言会失败——这是有意为之，它顺便证明了"这确实是一笔纯转账"。
- **证据不等于终局性**。`confirmations` 只表示观察到了多少块，Monad 的最终性语义请参考官方文档。
- **WSL 的 DNS 有时解析不了 `testnet-rpc.monad.xyz`**（mirrored 模式下 `10.255.255.254` 解析器会超时）。这不影响使用：页面里的 RPC 全部走 Windows 的 MetaMask，不经过 WSL。

---

## 监控：能看见什么，看不见什么

**没有常驻守护进程。** 程序不跑，链上发生什么它都不知道。三种用法：

| 场景 | 命令 | 需要签名吗 |
|---|---|---|
| 让程序发起并全程跟踪 | 面板「一键执行」 | 需要（部署 + 4 笔） |
| 先开监听，再去 MetaMask 手动转 | `node watch.mjs --watch --to 0xD723…f4D6 --follow` | 不需要 |
| 已经转完了，事后补证据 | `node watch.mjs --tx <hash>` | 不需要 |

### 能看见

上链之后的一切，因为全都在链上：交易哈希、from/to/value、receipt 状态、区块号与区块哈希、gasUsed、effectiveGasPrice、区块时间戳、余额变化。

### 看不见

上链之前的一切：你在 MetaMask 里点了哪个按钮、gas 有没有改过、签名前的待确认状态。这些发生在钱包进程内部，从不广播到链上，任何 RPC 都读不到。

### 是轮询，不是订阅

`watch.mjs --follow` 每 1.2 秒拉一次最新块号，再逐块取交易。Monad 的公共 RPC 没有给我 websocket 订阅，所以这是主动轮询而不是推送——延迟大约 1–2 秒，够用但不实时。

### 监听模式产出的证据和面板的不完全一样

`watch.mjs` 是纯只读的，不签名，所以它产出的证据：

- `source: "watch"`、`anchored: false`、`complete: false`
- `taskId` 由交易哈希确定性派生（`sha256("agentledger.mon-watch.v1|" + txHash)`），**不是链上真实存在的任务**，只是一个本地标识
- 证据本身和面板产出的完全同构、可复现，但**没有锚定到合约**

要把它变成链上锚定的正式证据，还是得走面板（需要签名）。

### 实测（真实测试网数据，2026-10-17）

用一笔真实的 Monad 测试网转账验证了只读路径：

- 交易 `0x6319c2cd…e94b4`，block 71777531，`gasUsed 21000`，`value 10 wei`
- 生成证据 `0x241146b2…f062`，settlementRef `0xf0ce81dd…7f45`
- 用 `--watch --from-block 71777525 --max-blocks 12` 扫 12 个块，正确命中这笔转入
- 负例：拿一笔合约调用交易去导入，被拒绝（`this transaction calls a contract`）

样例留在 `evidence/_samples/`，你自己的证据会落在 `evidence/<taskId>.json`。
