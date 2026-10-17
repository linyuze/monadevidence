#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Zero-dependency static server for the AgentLedger MetaMask panel.
// Runs unchanged on Linux (WSL) and on Windows — the same file, no build step.
//
//   node server.mjs --port 8787 --host 0.0.0.0
//
// No RPC proxy, no wallet, no key material: the page talks to MetaMask only,
// and this process only serves local files from --root.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const root = resolve(arg("root", fileURLToPath(new URL(".", import.meta.url))));
const port = Number(arg("port", process.env.PORT || 8787));
const host = arg("host", process.env.HOST || "0.0.0.0");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");

const MIME = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
}));

// Explicit allowlist: nothing else in the folder is reachable over HTTP.
const ALLOWED = new Set([
  "/", "/index.html", "/style.css",
  "/app.js", "/abi.js", "/evidence.js", "/sha256.js",
  "/artifact.json",
]);

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

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": CSP,
  });
  res.end(body);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) out.push(item.address);
    }
  }
  return out;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, JSON.stringify({ error: "read-only static server" }));
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      return send(res, 200, JSON.stringify({ ok: true, root, chainId: 10143, mode: "static" }));
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!ALLOWED.has(url.pathname) && !ALLOWED.has(path)) {
      return send(res, 404, JSON.stringify({ error: "not found" }));
    }
    const file = join(root, path);
    if (!resolve(file).startsWith(root + sep)) {
      return send(res, 403, JSON.stringify({ error: "forbidden" }));
    }
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, JSON.stringify({ error: "not found" }));
    const body = await readFile(file);
    return send(res, 200, body, MIME.get(extname(file)) || "application/octet-stream");
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, JSON.stringify({ error: "not found" }));
    console.error("serve error:", error.message);
    return send(res, 500, JSON.stringify({ error: "internal error" }));
  }
});

server.listen(port, host, () => {
  console.log("AgentLedger MetaMask panel");
  console.log("  root : " + root);
  console.log("  bind : " + host + ":" + port);
  console.log("");
  console.log("Open ONE of these in Chrome (Windows) where MetaMask is installed:");
  console.log("  http://localhost:" + port + "/");
  console.log("  http://127.0.0.1:" + port + "/");
  if (host === "0.0.0.0") {
    for (const address of lanAddresses()) console.log("  http://" + address + ":" + port + "/");
  }
  console.log("");
  console.log("If Windows cannot open the page, see README.md → 网络（Windows ↔ WSL）.");
});
