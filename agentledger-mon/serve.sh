#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run the panel as a detached background service inside WSL.
#
# Why not just `bash start.sh`: start.sh is tied to the terminal you launch it
# from, so closing that terminal (or ending an agent session) kills the server.
# This script detaches it from the controlling terminal with setsid, so it keeps
# serving while you click through MetaMask.
#
#   ./serve.sh start     start (no-op if already listening)
#   ./serve.sh stop      stop
#   ./serve.sh status    show pid / port / health
#   ./serve.sh logs      tail the server log
set -uo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8788}"
HOST="${HOST:-0.0.0.0}"
PIDFILE=".server.pid"
LOGFILE="logs/server.out"

mkdir -p logs

listening() {
  (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${PORT} "
}

case "${1:-status}" in
  start)
    if listening; then
      echo "已在运行：http://localhost:${PORT}/"
      exit 0
    fi
    if ! command -v node >/dev/null 2>&1; then
      echo "找不到 node，请先安装 Node 22+" >&2
      exit 1
    fi
    setsid node server.mjs --port "$PORT" --host "$HOST" >"$LOGFILE" 2>&1 < /dev/null &
    sleep 1
    pgrep -f "node server.mjs --port ${PORT}" | head -1 > "$PIDFILE"
    if listening; then
      echo "已启动：http://localhost:${PORT}/   (pid $(cat "$PIDFILE"))"
      echo "证据目录：$(pwd)/evidence"
      echo "日志：$(pwd)/$LOGFILE"
    else
      echo "启动失败，日志：$(pwd)/$LOGFILE" >&2
      tail -20 "$LOGFILE" >&2
      exit 1
    fi
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      PID=$(cat "$PIDFILE")
      kill "$PID" 2>/dev/null && echo "已停止 pid $PID" || echo "pid $PID 已不存在"
      rm -f "$PIDFILE"
    else
      pkill -f "node server.mjs --port ${PORT}" 2>/dev/null && echo "已停止" || echo "没有在运行"
    fi
    ;;
  status)
    if listening; then
      echo "监听中：${HOST}:${PORT}"
      [ -f "$PIDFILE" ] && echo "pid：$(cat "$PIDFILE")"
      echo "健康检查：$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/healthz" || echo '无响应')"
    else
      echo "未运行"
    fi
    ;;
  logs)
    tail -40 "$LOGFILE" 2>/dev/null || echo "还没有日志"
    ;;
  *)
    echo "用法：$0 {start|stop|status|logs}" >&2
    exit 2
    ;;
esac
