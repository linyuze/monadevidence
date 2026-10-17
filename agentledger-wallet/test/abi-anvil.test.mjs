// SPDX-License-Identifier: Apache-2.0
// Validates the hand-written ABI codec against a real EVM: the same payloads
// are sent as raw calldata and the results are cross-checked with viem's own
// ABI encoder/decoder. Requires a local Anvil on 127.0.0.1:18545 (chainId 10143).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  SELECTORS, deployData, createTaskData, recordPaymentData, submitEvidenceData,
  getTaskData, decodeTask, paymentRecorderData, decodeAddress, ZERO_ADDRESS,
} from "../abi.js";

const rpcUrl = process.env.AGENTLEDGER_ANVIL_RPC || "http://127.0.0.1:18545";
const artifact = JSON.parse(readFileSync(new URL("../artifact.json", import.meta.url), "utf8"));
const chain = {
  id: 10143, name: "anvil",
  nativeCurrency: { name: "E", symbol: "E", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) });
const creator = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const recorder = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const wallet = account => createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 0 }) });

const hex = byte => "0x" + byte.repeat(32).slice(0, 64);
const mined = async hash => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 20_000 });
  assert.equal(receipt.status, "success", "transaction reverted");
  return receipt;
};

test("hard-coded selectors equal viem's keccak-derived selectors", () => {
  for (const [signature, selector] of Object.entries(SELECTORS)) {
    assert.equal(selector, toFunctionSelector(signature), signature);
  }
});

test("full lifecycle through the hand-written codec", async () => {
  assert.equal(await publicClient.getChainId(), 10143, "anvil must run with chainId 10143");

  const deployment = await wallet(creator).sendTransaction({
    data: deployData(artifact.bytecode, recorder.address),
    gas: 6_000_000n,
  });
  const deployed = await mined(deployment);
  const contract = deployed.contractAddress;
  assert.match(contract, /^0x[0-9a-fA-F]{40}$/);

  // paymentRecorder(): my decoder vs viem
  const recorderRaw = await publicClient.call({ to: contract, data: paymentRecorderData() });
  assert.equal(decodeAddress(recorderRaw.data), recorder.address.toLowerCase());
  const recorderViaViem = await publicClient.readContract({
    address: contract, abi: artifact.abi, functionName: "paymentRecorder",
  });
  assert.equal(decodeAddress(recorderRaw.data), recorderViaViem.toLowerCase());

  // createTask with the 3-argument overload
  const taskId = hex("11");
  const descriptionHash = hex("22");
  const created = await mined(await wallet(creator).sendTransaction({
    to: contract, data: createTaskData(taskId, descriptionHash, 1000), gas: 400_000n,
  }));
  assert.equal(created.status, "success");

  const viaViem = await publicClient.readContract({
    address: contract, abi: artifact.abi, functionName: "getTask", args: [taskId],
  });
  const mine = decodeTask((await publicClient.call({ to: contract, data: getTaskData(taskId) })).data);
  assert.equal(mine.status, "Created");
  assert.equal(mine.creator, viaViem.creator.toLowerCase());
  assert.equal(mine.descriptionHash, viaViem.descriptionHash.toLowerCase());
  assert.equal(mine.maxBudgetAtomic, viaViem.maxBudget.toString());
  assert.equal(mine.amountAtomic, "0");
  assert.equal(mine.payer, ZERO_ADDRESS);
  assert.equal(mine.createdAt, viaViem.createdAt.toString());

  // recordPayment
  const settlementRef = hex("33");
  const payer = "0x" + "44".repeat(20);
  await mined(await wallet(recorder).sendTransaction({
    to: contract, data: recordPaymentData(taskId, payer, 1000, settlementRef), gas: 400_000n,
  }));
  const paid = decodeTask((await publicClient.call({ to: contract, data: getTaskData(taskId) })).data);
  assert.equal(paid.status, "Paid");
  assert.equal(paid.payer, payer);
  assert.equal(paid.amountAtomic, "1000");
  assert.equal(paid.settlementRef, settlementRef);

  // submitEvidence
  const evidenceHash = hex("55");
  await mined(await wallet(creator).sendTransaction({
    to: contract, data: submitEvidenceData(taskId, evidenceHash), gas: 400_000n,
  }));
  const proven = decodeTask((await publicClient.call({ to: contract, data: getTaskData(taskId) })).data);
  assert.equal(proven.status, "Proven");
  assert.equal(proven.evidenceHash, evidenceHash);
  assert.notEqual(proven.provenAt, "0");
});

test("two-argument createTask leaves maxBudget at zero (no cap)", async () => {
  const deployment = await wallet(creator).sendTransaction({
    data: deployData(artifact.bytecode, recorder.address), gas: 6_000_000n,
  });
  const contract = (await mined(deployment)).contractAddress;
  const taskId = hex("66");
  await mined(await wallet(creator).sendTransaction({
    to: contract, data: createTaskData(taskId, hex("77")), gas: 400_000n,
  }));
  const task = decodeTask((await publicClient.call({ to: contract, data: getTaskData(taskId) })).data);
  assert.equal(task.maxBudgetAtomic, "0");
});

test("decodeTask rejects a task that does not exist", async () => {
  const deployment = await wallet(creator).sendTransaction({
    data: deployData(artifact.bytecode, recorder.address), gas: 6_000_000n,
  });
  const contract = (await mined(deployment)).contractAddress;
  await assert.rejects(
    async () => decodeTask((await publicClient.call({ to: contract, data: getTaskData(hex("99")) })).data),
    /invalid task state|return length|reverted/i,
  );
});

test("input validation fails closed before any RPC", () => {
  assert.throws(() => createTaskData("0x1234", hex("22")), /taskId/);
  assert.throws(() => createTaskData(hex("11"), "0xzz"), /descriptionHash/);
  assert.throws(() => recordPaymentData(hex("11"), "0x1234", 1, hex("33")), /payer/);
  assert.throws(() => recordPaymentData(hex("11"), ZERO_ADDRESS, -1, hex("33")), /amount/);
  assert.throws(() => submitEvidenceData(hex("11"), "0x00"), /evidenceHash/);
  assert.throws(() => deployData("0xzz", ZERO_ADDRESS), /bytecode/);
});
