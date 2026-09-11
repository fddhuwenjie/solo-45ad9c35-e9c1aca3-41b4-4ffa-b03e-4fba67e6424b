#!/usr/bin/env bash
# 启动藏品转运回温编排网页（Flask 内置服务器，供现场局域网访问）
set -e
cd "$(dirname "$0")"
export PYTHONUSERBASE="$(pwd)/.pylibs"
export PYTHONPATH="$(pwd)${PYTHONPATH:+:$PYTHONPATH}"
export FLASK_APP="app:create_app"
exec python3 -m flask run --host 0.0.0.0 --port "${PORT:-5000}"
