# AgentLedger · MetaMask 面板（Windows Chrome 钱包 × WSL 代码）

用你 **Windows Chrome 里的 MetaMask** 直接签名，在 Monad 测试网上手动走完：

```
部署合约 → createTask → recordPayment(recorder 证词) → 确定性执行 → submitEvidence → 读回
```

**本目录是纯新增**：`../agentledger/` 里一行代码都没改，只读取了它的合约编译产物与哈希规范来做交叉验证。

---

## 为什么需要这个东西

原项目把四段链路全部留给人做（详见 `../agentledger-review/EVIDENCE-4-GAPS.md`）：
结算后不自动 `recordPayment`、`Paid` 后不自动执行、执行后不自动 `submitEvidence`、`Proven` 后不通知界面。
它只有 CLI + Anvil 脚本，**缺一个「人可以用钱包点着走」的入口**。本目录就是那个入口。

---

## 前置条件

| 项 | 要求 |
|---|---|
| 浏览器 | Windows 上的 Chrome，已装 MetaMask 扩展 |
| MetaMask | 有一个账户（部署时会把 `paymentRecorder` 设成它，这样一个钱包能走完全流程） |
| 测试币 | 部署和交易需要 Monad 测试网 MON：<https://faucet.monad.xyz> |
| WSL | Node 22+（本机已有 v24.21.0） |

> 本面板**不需要** npm install，也**没有构建步骤**。零依赖。

---

## 启动（在 WSL 里）

```bash
cd ~/monad/agentledger-wallet
bash start.sh
```

它会监听 `0.0.0.0:8787` 并打印可用地址。然后在 **Windows 的 Chrome** 里打开：

```
http://localhost:8787/
```

### 网络（Windows ↔ WSL）—— 本机已实测

本机 `.wslconfig` 开了 `networkingMode=mirrored`。实测结果：

| 从 Windows 访问 | 结果 |
|---|---|
| `http://localhost:8787/` | **200 ✓**（推荐用这个） |
| `http://127.0.0.1:8787/` | **200 ✓** |
| `http://192.168.110.120:8787/`（局域网 IP） | 000 ✗（不通，别用） |

所以正常情况下**什么都不用配**，直接 `bash start.sh` 然后 Chrome 打开 `http://localhost:8787/`。

若哪天不通（例如换了网络或 Windows 防火墙拦了），按顺序试：

1. **自检**（Windows PowerShell）：
   ```powershell
   curl.exe -sS -o NUL -w "%{http_code}" http://localhost:8787/healthz
   ```

2. **保底方案：静态服务跑在 Windows 上，文件仍从 WSL 读**（代码只有一份，还在 WSL，已实测可用）：
   ```powershell
   & "C:\Program Files\nodejs\node.exe" "\\wsl.localhost\Ubuntu-22.04\home\pkulzz\monad\agentledger-wallet\server.mjs" --root "\\wsl.localhost\Ubuntu-22.04\home\pkulzz\monad\agentledger-wallet" --host 127.0.0.1 --port 8787
   ```
   监听的是 Windows 自己的回环地址，Chrome 一定能开。

> 顺带说明：局域网 IP 那条不通，正好说明**别用非 localhost 的 http 地址** —— 那种页面不是安全上下文，`crypto.subtle` 会不可用。本面板内置纯 JS SHA-256 兜底，页面上会显示当前用的后端，但正常路径不会走到它。

### 页面打不开 / 检测不到 MetaMask

- **不要用 `file://` 打开**。Chrome 在 `file://` 下默认不注入扩展（除非手动开「允许访问文件网址」）。
- 地址必须是 `http://localhost:…` 或 `http://127.0.0.1:…`（这类地址算安全上下文，MetaMask 会注入，`crypto.subtle` 也可用）。
- 页面顶部「环境自检」会明确显示 `MetaMask / 当前账户 / 网络 / 哈希后端 / 页面来源`，先看那里。

---

## 操作顺序

1. **连接 MetaMask** → 点「添加 / 切换 Monad 测试网」（chainId `10143`，RPC `https://testnet-rpc.monad.xyz`）。
2. **部署新合约**：`paymentRecorder` 会自动设成你当前账户。部署完地址会填进输入框，并显示权限检查 `✓ 当前账户就是 recorder`。
   - 也可以填入已部署的地址，点「使用这个地址」。
3. **创建任务**：文本框内容决定 `descriptionHash`（= 输入的 SHA-256）。`taskId` 可随机生成；`maxBudget` 留空表示**不限制**（原合约语义，页面上有提示）。
4. **记录付款**：这一步写的是「recorder 说付过了」。必须勾选确认才能点。
5. **执行 + Evidence**：在浏览器内跑确定性文本统计（不联网、不调模型），生成 7 字段 Evidence 并算 SHA-256。
6. **提交证据**：`submitEvidence`，任务变 `Proven`。
7. **读回与状态**：显示链上状态与**对外状态**两套值。
8. **可选：独立核对 USDC 收款**：填入真实 USDC 交易哈希，只读核对 `Transfer` + EIP-3009 `AuthorizationUsed`，算出 `settlementRef` 并与链上比对。核对通过后会自动填进第 4 步的表单。

### 关于「对外状态」

面板严格沿用原项目的语义：

| 情况 | 对外状态 |
|---|---|
| 没做 USDC 独立核对 | `PaymentUnknown`（**即使链上已是 Paid/Proven**） |
| 核对通过 + 链上已 Paid + settlementRef 一致 | `PaymentRecorded` |
| 上面再加本地 Evidence 与链上哈希一致 | `EvidenceAnchored` |
| 观察到收款但链上还没记录 | `PaymentObserved` |
| settlementRef 对不上 | `Conflict`（人工排查，**不要重付**） |

`chargeAgain` 恒为 `false`。

---

## 测试

```bash
cd ~/monad/agentledger-wallet

# 1) 浏览器模块 vs 原项目：逐字节一致性（不需要链）
node --test test/evidence-parity.test.mjs

# 2) 手写 ABI 编码 vs 真实 EVM（需要 anvil，chainId 10143）
anvil --port 18545 --chain-id 10143 --host 127.0.0.1 --silent &
node --test test/abi-anvil.test.mjs
kill %1
```

> 测试 2 需要 `viem`。本目录不含 `node_modules`（面板本身零依赖），
> 测试时从隔壁项目借用即可（**必须用绝对路径**，相对路径会以 `node_modules/` 为基准解析而失效）：
> ```bash
> mkdir -p node_modules && for p in viem abitype ox isows ws @adraffy @noble @scure; do
>   ln -sfn "$PWD/../agentledger/examples/verifier/node_modules/$p" "$PWD/node_modules/$p"
> done
> ```

### 自测结果（2026-10-17 实测）

| 检查 | 结果 |
|---|---|
| `evidence-parity.test.mjs`（浏览器模块 vs 原项目，逐字节） | **8 / 8 pass** |
| `abi-anvil.test.mjs`（手写编码 vs 真实 EVM + viem 复核） | **5 / 5 pass** |
| DOM 接线检查（app.js 引用的 42 个 id 是否都存在） | 无缺失、无未用 |
| 静态服务白名单（README/server.mjs/路径穿越） | 全部 404 |
| CSP / 安全响应头 | 已下发 |
| Windows → `http://localhost:8787/` | 200 |
| Windows → `http://127.0.0.1:8787/` | 200 |
| Windows → 局域网 IP | 000（不可用，正常路径不需要） |

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` / `style.css` | 界面 |
| `app.js` | MetaMask 连接、切链、发交易、读回、状态投影 |
| `abi.js` | 零依赖 ABI 编解码（选择器由 `cast sig` 生成，测试里用 viem 复核） |
| `sha256.js` | WebCrypto 优先，纯 JS 兜底（LAN IP 场景） |
| `evidence.js` | 规范 Evidence、确定性工具、settlementRef、USDC 收据核对 |
| `server.mjs` | 零依赖静态服务，白名单 + 严格 CSP；WSL 与 Windows 通用 |
| `start.sh` | WSL 启动脚本 |
| `artifact.json` | 从 `../agentledger/out/` 复制的 ABI + creation bytecode |
| `test/` | 一致性测试与链上编码测试 |

---

## 安全边界（请务必读完）

- **页面不接触私钥**：所有签名在 MetaMask 里完成，代码里没有任何 key、mnemonic、签名库。
- **没有 RPC 代理**：`server.mjs` 只发静态文件，`connect-src 'self'`；链上读走 MetaMask 的 provider。
- **没有自动付款**：`recordPayment` 必须人手点，且必须勾选确认。
- **`Paid` 不是「已验证付款」**：它只是 recorder 证词。只有第 8 步的独立核对通过，对外状态才会升级。
- **不要用有真实资产的账户**。只连测试网，只领测试币。
- 本面板**不会**自动调用任何后端，也不上传你的输入文本与 Evidence 内容。

---

## 已知限制

- 只支持 Monad 测试网（chainId 固定 10143）与官方测试网 USDC 地址。
- 不做 finality/reorg 追踪，只做观测时点的检查。
- 单机单钱包流程；没有多签、没有 recorder 轮换（原合约本身也没有）。
- `settlementRef` 由页面随机生成时只是唯一占位；要让它有意义，请用第 8 步从真实 USDC 交易算出来。
