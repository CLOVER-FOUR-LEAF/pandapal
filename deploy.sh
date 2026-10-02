#!/usr/bin/env bash
# PandaButler 部署脚本：同步代码到 xustalis-server:~/pandapal 并重启服务
# 用法：./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="xustalis-server"
APP_DIR="pandapal"          # ~/pandapal
PORT=8017                   # 后端监听 127.0.0.1:PORT，nginx 反代到 /pandapal/

echo "==> 同步代码到 ${REMOTE}:~/${APP_DIR}"
rsync -avz --delete \
  --exclude='.git/' --exclude='.venv/' --exclude='__pycache__/' \
  --exclude='.DS_Store' --exclude='*.log' \
  --exclude='data/logs/' --exclude='data/users.json' \
  --exclude='data/tokens.json' --exclude='data/profiles.json' \
  --include='data/child_xiaodou/***' --exclude='data/child_*' \
  ./ "${REMOTE}:${APP_DIR}/"

echo "==> 服务端：venv + 依赖 + .env 端口收敛 + 重启"
ssh "${REMOTE}" "bash -s" <<EOS
set -euo pipefail
cd ~/${APP_DIR}

[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

# 服务端 .env：只绑回环 + 部署端口（本地的 HOST/PORT 行被覆盖）
touch .env
sed -i '/^HOST=/d;/^PORT=/d' .env
printf 'HOST=127.0.0.1\nPORT=${PORT}\n' >> .env

sudo -n systemctl restart pandapal 2>/dev/null || systemctl --user restart pandapal
sleep 1
curl -sf http://127.0.0.1:${PORT}/api/health && echo " <- health OK"
EOS

echo "==> 完成：https://xustalis.site/pandapal/"
