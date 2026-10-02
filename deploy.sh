#!/usr/bin/env bash
# PandaButler 部署脚本：同步代码到 xustalis-server:~/pandapal 并重启服务
# 线上形态：systemd 单元 pandapal.service，uvicorn 绑 127.0.0.1:8017，
# nginx xustalis.site 443 把 /pandapal/ 反代过去（前缀剥离）。
# 用法：./deploy.sh
# 注意：.env 只存在于服务端（LLM 密钥、演示口令），rsync 必须排除它——
# 否则 --delete 会在本地没有 .env 时把服务端的删掉，有时则用本地值覆盖。
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="xustalis-server"
APP_DIR="pandapal"
PORT=8017

echo "==> 同步代码到 ${REMOTE}:~/${APP_DIR}"
rsync -avz --delete \
  --exclude='.git/' --exclude='.venv/' --exclude='__pycache__/' \
  --exclude='.DS_Store' --exclude='*.log' \
  --exclude='.env' --exclude='.env.*' \
  --exclude='data/logs/' --exclude='data/users.json' \
  --exclude='data/tokens.json' --exclude='data/profiles.json' \
  --exclude='history.json' \
  --include='data/child_xiaodou/***' --exclude='data/child_*' \
  ./ "${REMOTE}:${APP_DIR}/"

echo "==> 服务端：依赖 + 重启"
ssh "${REMOTE}" "bash -s" <<EOS
set -euo pipefail
cd ~/${APP_DIR}

# 首次部署（还没有 users.json）必须在服务端 .env 里设好三个演示口令，禁止落到公开的默认值
if [ ! -f data/users.json ]; then
  for k in PANDA_CHILD_PASSWORD PANDA_PARENT_PASSWORD PANDA_ADMIN_PASSWORD; do
    grep -Eq "^\${k}=.+" .env || { echo "!! 服务端 .env 缺少 \${k}，拒绝使用默认口令" >&2; exit 1; }
  done
fi

[ -d .venv ] || python3 -m venv .venv
# 腾讯云内网 PyPI 镜像，外网源会卡
.venv/bin/pip install -q -i https://mirrors.cloud.tencent.com/pypi/simple -r requirements.txt

# .env 里 HOST/PORT 以服务端为准：回环 + 部署端口（本地值不回传覆盖）
sed -i '/^HOST=/d;/^PORT=/d' .env
printf 'HOST=127.0.0.1\nPORT=${PORT}\n' >> .env

sudo -n systemctl restart pandapal
sleep 1
curl -sf http://127.0.0.1:${PORT}/api/health && echo " <- health OK"
EOS

echo "==> 完成：https://xustalis.site/pandapal/"
