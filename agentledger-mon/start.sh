#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Start the MON payment panel from WSL. Windows Chrome (where MetaMask lives)
# opens the printed URL.
#
# If the port is already taken by a running instance of this panel, say so and
# exit 0 — that is not an error, it means you can just open the page.
set -uo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8788}"
HOST="${HOST:-0.0.0.0}"

port_in_use() {
  (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ":${PORT}[[:space:]]"
}

if port_in_use; then
  HEALTH=$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)
  echo "端口 ${PORT} 已被占用。"
  if [ -n "$HEALTH" ]; then
    echo "占用者就是本面板，它已经在运行了："
    echo "  $HEALTH"
    echo
    echo "直接用浏览器打开： http://localhost:${PORT}/"
    echo "要重启： ./serve.sh stop   然后   ./serve.sh start"
    exit 0
  fi
  echo "但 healthz 没有响应，占用者不是本面板。"
  echo "换一个端口： PORT=8789 bash start.sh"
  exit 1
fi

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
if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "服务没能启动，请看上面的错误。" >&2
  exit 1
fi

echo "── 自检 ──"
curl -sS --max-time 3 "http://127.0.0.1:$PORT/healthz" || echo "（自检失败）"
echo
echo "── Windows 侧请打开 ──"
echo "  http://localhost:$PORT/"
echo
echo "这个窗口保持打开，服务就一直在。Ctrl+C 结束。"
echo "想让它脱离终端常驻： ./serve.sh start"
wait $SERVER_PID
