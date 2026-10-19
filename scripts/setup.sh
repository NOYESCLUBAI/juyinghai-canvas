#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
SETUP_PYTHON="${MJH_PYTHON:-}"
if [[ -z "$SETUP_PYTHON" ]]; then
  for candidate in python3 python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
      SETUP_PYTHON="$candidate"; break
    fi
  done
fi
if [[ -z "$SETUP_PYTHON" ]]; then echo '请安装 Python 3.10+，或用 MJH_PYTHON 指定解释器。'; exit 1; fi
"$SETUP_PYTHON" -c 'import sys; assert sys.version_info >= (3,10), "需要 Python 3.10+"'
node -e 'const [major]=process.versions.node.split(".").map(Number); if(!(major>=22)) throw Error("需要 Node.js 22+")'
[[ -d .venv ]] || "$SETUP_PYTHON" -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
[[ -f .env ]] || cp .env.example .env
echo '准备完成。运行 npm run dev；模型可在界面中配置。已有环境配置不会被覆盖。'
