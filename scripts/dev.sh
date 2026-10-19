#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$PROJECT_DIR/.venv/bin/python"
API_PORT="${MJH_API_PORT:-3012}"
WEB_PORT="${MJH_WEB_PORT:-5173}"
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "缺少 Python 环境，请先运行 python3 -m venv .venv，再运行 .venv/bin/pip install -r requirements.txt"
  exit 1
fi
cd "$PROJECT_DIR"
API_PID=""
WEB_PID=""
cleanup() {
  trap - EXIT INT TERM
  [[ -z "$WEB_PID" ]] || kill "$WEB_PID" 2>/dev/null || true
  [[ -z "$API_PID" ]] || kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap 'exit_status=$?; cleanup; exit "$exit_status"' EXIT
trap 'exit 130' INT TERM
# Refuse to accidentally attach to an unrelated backend already using the port.
"$PYTHON_BIN" - "$API_PORT" <<'PY'
import socket, sys
with socket.socket() as sock:
    try:
        sock.bind(('127.0.0.1', int(sys.argv[1])))
    except OSError:
        sys.exit('后端端口已被占用，请先停止原启动终端，或设置 MJH_API_PORT。')
PY
"$PYTHON_BIN" -m uvicorn backend.app:app --host 127.0.0.1 --port "$API_PORT" --ws none &
API_PID=$!
READY=0
for attempt in {1..30}; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "本机后端启动失败，请查看上方错误；前端未启动。"
    exit 1
  fi
  if "$PYTHON_BIN" - "$API_PORT" <<'PY' 2>/dev/null
import json, sys, urllib.request
with urllib.request.urlopen('http://127.0.0.1:' + sys.argv[1] + '/api/health', timeout=1) as response:
    assert json.load(response).get('project') == '剧影海'
PY
  then READY=1; break; fi
  sleep 1
done
if [[ "$READY" != 1 ]]; then echo "本机后端未能就绪，请检查配置后重试。"; exit 1; fi
export MJH_CANVAS_API_TARGET="http://127.0.0.1:$API_PORT"
./node_modules/.bin/vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort &
WEB_PID=$!
echo "后端已就绪。画布：http://127.0.0.1:${WEB_PORT}；按 Control + C 停止。"
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do sleep 1; done
if ! kill -0 "$API_PID" 2>/dev/null; then
  echo "本机后端已退出，前端将一并停止。请查看错误后重新运行 npm run dev。"
else
  echo "前端已退出，后端将一并停止。"
fi
exit 1
