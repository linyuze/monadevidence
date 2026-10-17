// SPDX-License-Identifier: Apache-2.0
// Plain HTTP JSON-RPC transport with the same shape as EIP-1193
// (request(method, params) -> result), so pipeline.mjs cannot tell whether it is
// talking to MetaMask or to a node. Retries only idempotent reads.

const RETRYABLE = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode", "eth_call",
  "eth_gasPrice", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_getBlockByNumber", "eth_getTransactionCount", "eth_estimateGas",
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createHttpTransport(url, { retries = 3, timeoutMs = 20_000 } = {}) {
  let id = 0;

  async function once(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error(`non-JSON response (HTTP ${response.status}): ${text.slice(0, 160)}`); }
      if (payload.error) {
        const error = new Error(payload.error.message || "rpc error");
        error.code = payload.error.code;
        error.data = payload.error.data;
        throw error;
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    url,
    async request(method, params) {
      const attempts = RETRYABLE.has(method) ? retries : 1;
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try { return await once(method, params); }
        catch (error) {
          lastError = error;
          // A revert carries a code and must not be retried.
          if (typeof error.code === "number") throw error;
          if (attempt < attempts) await sleep(250 * attempt);
        }
      }
      throw lastError;
    },
  };
}
