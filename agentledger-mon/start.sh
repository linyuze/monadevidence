#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Start the MON payment panel from WSL. Windows Chrome (where MetaMask lives)
# opens the printed URL.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8788}"
HOST="${HOST:-0.0.0.0}"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。请先在 WSL 里安装 Node 22+。" >&2
  exit 1
fi

echo "Node: $(node --version)"
echo "监听: $HOST:$PORT"
echo "证据目录: $(pwd)/evidence"
echo

node server.mjs --port "$PORT" --host "$HOST" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

sleep 1
echo "── 自检 ──"
curl -sS --max-time 3 "http://127.0.0.1:$PORT/healthz" || echo "（自检失败）"
echo
echo "── Windows 侧请打开 ──"
echo "  http://localhost:$PORT/"
echo
echo "打不开时在 PowerShell 里判断连通性："
echo "  curl.exe --noproxy '*' -sS -o NUL -w \"%{http_code}\" http://localhost:$PORT/healthz"
echo
echo "Ctrl+C 结束。"
wait $SERVER_PID
