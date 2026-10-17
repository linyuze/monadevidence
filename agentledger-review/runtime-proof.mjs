#!/usr/bin/env node
// 运行时证据：x402 闸门完成一次合法付款预留后，链上任务状态是否自动推进？
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { authorizeHttpRequest, guardConfig } from "./lib/challenge-guard.mjs";
import { buildApprovalData } from "../../lib/approval-format.mjs";
import { readTask } from "../verifier/lib/task-reader.mjs";
import { runDemoTask } from "../verifier/tools/run-demo-task.mjs";

const rpc = "http://127.0.0.1:18545";
const chain = { id: 10143, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const w = a => createWalletClient({ account: a, chain, transport: http(rpc) });
const hex = b => "0x" + createHash("sha256").update(b).digest("hex");
const say = (k, v) => console.log(`${k.padEnd(46)} ${v}`);

const creator = privateKeyToAccount(generatePrivateKey());
const recorder = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey());
for (const a of [creator, recorder, payer]) {
  await pub.request({ method: "anvil_setBalance", params: [a.address, "0x" + (10n ** 19n).toString(16)] });
}
const art = JSON.parse(readFileSync(new URL("../../out/AgentLedger.sol/AgentLedger.json", import.meta.url), "utf8"));
const dep = await w(creator).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [recorder.address], gas: 6_000_000n });
const ledger = (await pub.waitForTransactionReceipt({ hash: dep })).contractAddress;
const taskId = hex(randomBytes(32));
const descriptionHash = hex(Buffer.from("runtime proof: settlement does not advance the ledger"));
await pub.waitForTransactionReceipt({ hash: await w(creator).writeContract({
  address: ledger, abi: art.abi, functionName: "createTask", args: [taskId, descriptionHash, 1000n], gas: 400_000n }) });

const payTo = "0x2222222222222222222222222222222222222222";
const config = guardConfig({ ledger, payTo, taskId, publicOrigin: "http://127.0.0.1:4021" });
const db = "/tmp/al-runtime-proof.db";
if (existsSync(db)) rmSync(db);

const q = {
  schemaVersion: "agentledger.task-payment.v1", chainId: 10143, ledger, taskId,
  descriptionHash, token: "0x534b2f3A21130d7a60830c2Df862319e593943A3", payTo,
  payer: payer.address, amountAtomic: "1000",
  expiresAt: String(Math.floor(Date.now() / 1000) + 3600), nonce: hex(randomBytes(32)),
};
const t = buildApprovalData(q);
const approvalSig = await payer.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
const now = Math.floor(Date.now() / 1000);
const paymentNonce = hex(randomBytes(32));
const authMsg = { from: payer.address, to: payTo, value: "1000", validAfter: "0", validBefore: String(now + 900), nonce: paymentNonce };
const paySig = await payer.signTypedData({
  domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: "0x534b2f3A21130d7a60830c2Df862319e593943A3" },
  types: { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization", message: authMsg,
});
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64");

console.log("── 基线 ──");
say("链上状态（刚创建）", (await readTask(pub, ledger, taskId)).status);

console.log("\n── 让 x402 闸门完成一次合法付款授权 ──");
const result = await authorizeHttpRequest({
  "x-agentledger-approval": b64({ ...q, signature: approvalSig }),
  "payment-signature": b64({
    x402Version: 2, resource: { url: config.resourceURL },
    accepted: { scheme: "exact", network: "eip155:10143",
      asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3", payTo, amount: "1000",
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" } },
    payload: { authorization: authMsg, signature: paySig },
  }),
}, config, { rpcUrl: rpc, nowSeconds: BigInt(now) });
say("闸门返回", result.phase);
say("预扣结果", result.reservation.result);

console.log("\n── 关键：链上有没有自己动？ ──");
const after = await readTask(pub, ledger, taskId);
say("链上状态（闸门成功后）", after.status);
say("payer / amount / settlementRef", `${after.payer.slice(0,10)}… / ${after.amountAtomic} / ${after.settlementRef.slice(0,10)}…`);

console.log("\n── 执行器能不能自动接手？ ──");
try {
  await runDemoTask({ contract: ledger, taskId, inputPath: "/tmp/rp-in.txt", outputPath: "/tmp/rp-out.json", evidencePath: "/tmp/rp-ev.json" }, { chain: pub });
  say("runDemoTask", "居然执行了（不应该）");
} catch (e) { say("runDemoTask", "拒绝：" + e.message); }

console.log("\n结论：闸门成功预留付款后，链上仍是 " + after.status + "；执行器拒绝运行。");
console.log("      要让任务变成 Paid/Proven，必须有人额外发两笔交易（recordPayment / submitEvidence）。");
