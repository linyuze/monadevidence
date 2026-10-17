// SPDX-License-Identifier: Apache-2.0
// Zero-dependency server for the MON payment panel.
//
// Two jobs:
//   1. serve the page + the ES modules it imports (explicit allowlist, strict CSP)
//   2. persist payment evidence to disk  (POST /api/evidence)
//
// Job 2 is what turns "the browser showed me a hash" into "the evidence is kept
// somewhere I can point at later". The panel uploads the canonical document plus
// its digest; this process writes evidence/<taskId>.json and never trusts the
// client's claim about what the chain said — the file records what was submitted
// and the panel's independent re-check is what validates it.
//
// Runs identically on Linux and Windows: node server.mjs --port 8788

import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir, stat, appendFile } from "node:fs/promises";
import { join, resolve, sep, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const ROOT = resolve(arg("root", here));
const EVIDENCE_DIR = resolve(arg("evidence", join(ROOT, "evidence")));
const LOG_DIR = resolve(arg("logs", join(ROOT, "logs")));
const PORT = Number(arg("port", process.env.PORT || 8788));
const HOST = arg("host", process.env.HOST || "0.0.0.0");
const MAX_BODY = 256 * 1024;

// Everything the browser is allowed to fetch. Note transport.mjs and headless.mjs
// are deliberately absent: they are node-only and must not be reachable.
const ALLOWED = new Set([
  "/", "/index.html", "/style.css",
  "/app.js", "/abi.js", "/sha256.js", "/mon-evidence.mjs", "/pipeline.mjs",
  "/artifact.json",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");

const TASK_ID = /^0x[0-9a-f]{64}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const sendJson = (res, status, value) =>
  send(res, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8" });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error("body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleEvidencePost(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message || "invalid JSON body" });
  }

  const taskId = String(payload?.taskId || "").toLowerCase();
  if (!TASK_ID.test(taskId)) return sendJson(res, 400, { error: "taskId must be 0x + 64 hex" });
  if (!payload.evidence || typeof payload.evidence !== "object") {
    return sendJson(res, 400, { error: "evidence object required" });
  }
  if (typeof payload.evidenceHash !== "string" || !BYTES32.test(payload.evidenceHash.toLowerCase())) {
    return sendJson(res, 400, { error: "evidenceHash must be 0x + 64 hex" });
  }
  if (typeof payload.evidenceCanonical !== "string" || !payload.evidenceCanonical.trim()) {
    return sendJson(res, 400, { error: "evidenceCanonical required" });
  }

  await mkdir(EVIDENCE_DIR, { recursive: true });
  const name = basename(`${taskId}.json`);
  const target = join(EVIDENCE_DIR, name);
  if (!resolve(target).startsWith(EVIDENCE_DIR + sep)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  const bundle = {
    receivedAt: new Date().toISOString(),
    source: String(payload.source || "browser").slice(0, 64),
    complete: payload.complete !== false,
    network: payload.network ?? null,
    contract: payload.contract ?? null,
    taskId,
    evidenceHash: payload.evidenceHash.toLowerCase(),
    settlementRef: payload.settlementRef ?? null,
    evidenceCanonical: payload.evidenceCanonical,
    evidence: payload.evidence,
    transactions: payload.transactions ?? null,
    onchain: payload.onchain ?? null,
    checks: payload.checks ?? null,
  };
  await writeFile(target, JSON.stringify(bundle, null, 2) + "\n");
  return sendJson(res, 201, { ok: true, path: target, name, bytes: Buffer.byteLength(JSON.stringify(bundle, null, 2)) });
}

async function handleLogPost(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message || "invalid JSON body" });
  }
  await mkdir(LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = join(LOG_DIR, `run-${day}.jsonl`);
  if (!resolve(file).startsWith(LOG_DIR + sep)) return sendJson(res, 403, { error: "forbidden" });
  const record = { at: new Date().toISOString(), ...payload };
  await appendFile(file, JSON.stringify(record) + "\n");
  return sendJson(res, 202, { ok: true, file });
}

async function handleEvidenceList(res) {
  let names = [];
  try { names = await readdir(EVIDENCE_DIR); } catch { return sendJson(res, 200, { files: [] }); }
  const files = [];
  for (const name of names.filter(entry => entry.endsWith(".json")).sort().reverse().slice(0, 50)) {
    try {
      const info = await stat(join(EVIDENCE_DIR, name));
      files.push({ name, bytes: info.size, modifiedAt: info.mtime.toISOString() });
    } catch { /* raced with a delete; skip */ }
  }
  return sendJson(res, 200, { dir: EVIDENCE_DIR, files });
}

async function handleStatic(req, res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path === "/") path = "/index.html";
  if (!ALLOWED.has(path) && !ALLOWED.has(url.pathname)) {
    return sendJson(res, 404, { error: "not found" });
  }
  const file = join(ROOT, path);
  if (!resolve(file).startsWith(ROOT + sep)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const body = await readFile(file);
    return send(res, 200, body, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, root: ROOT, evidenceDir: EVIDENCE_DIR, logDir: LOG_DIR, chainId: 10143, mode: "mon-payment" });
    }
    if (url.pathname === "/api/log") {
      if (req.method === "POST") return await handleLogPost(req, res);
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (url.pathname === "/api/evidence") {
      if (req.method === "POST") return await handleEvidencePost(req, res);
      if (req.method === "GET") return await handleEvidenceList(res);
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method not allowed" });
    }
    return await handleStatic(req, res, url);
  } catch (error) {
    return sendJson(res, 500, { error: String(error.message || error) });
  }
});

server.on("error", error => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用。`);
    console.error(`如果面板已经在运行，直接打开 http://localhost:${PORT}/ 即可。`);
    console.error("要换端口： PORT=8789 node server.mjs");
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log("AgentLedger · MON payment panel");
  console.log("  root : " + ROOT);
  console.log("  evid : " + EVIDENCE_DIR);
  console.log("  bind : " + HOST + ":" + PORT);
  console.log("");
  console.log("Open in Chrome (Windows, where MetaMask lives):");
  console.log("  http://localhost:" + PORT + "/");
  console.log("  http://127.0.0.1:" + PORT + "/");
  console.log("");
});
