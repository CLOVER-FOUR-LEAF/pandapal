"""认证与权限隔离：用户名+密码登录，Bearer token 会话，角色能力表。

data/users.json 结构：
    { "<username>": {"salt": "<hex>", "hash": "<hex>", "role": "child|parent|admin",
                     "child": "<绑定的孩子登录名>"} }

角色划分：
  child  —— 孩子本人：聊天/梦想/悄悄话 + 自己档案的全部查看能力
  parent —— 家长：收件箱确认、传话筒 + 孩子档案的只读视图（服务端强制过滤私密内容）
  admin  —— 评委/管理员：全部能力 + /api/logs + 可用 name 参数查看任意档案

密码用 PBKDF2-HMAC-SHA256 加盐哈希；token 持久化到 data/tokens.json，
默认 7 天有效，重启服务不会掉登录。
未知用户名首次登录自动注册为 child 角色并绑定同名新档案——评委各自起名互不干扰。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time

from . import config

USERS_PATH = config.DATA_DIR / "users.json"
TOKENS_PATH = config.DATA_DIR / "tokens.json"
_LOCK = threading.Lock()
_ITERATIONS = 120_000
TOKEN_TTL = 7 * 24 * 3600  # token 有效期 7 天；过期项在访问时懒惰清除

# 角色 → 能力集合；admin 为 "*" 通配。
# 读/写分离：事务与清单的查看归 affairs/checklist，改动归 *_write——
# 家长是"只读视图 + 收件箱确认 + 传话筒"，绝不能替孩子改看板、勾清单。
CAPS: dict[str, set[str]] = {
    "child": {"session", "greeting", "briefing", "chat", "graph", "affairs",
              "affairs_write", "checklist", "checklist_write",
              "ics", "growth", "dream", "memory", "history"},
    "parent": {"session", "greeting", "briefing", "graph", "affairs", "checklist",
               "ics", "inbox", "relay", "growth", "memory", "history"},
    "admin": {"*"},
}
ROLE_NAMES = {"child": "孩子", "parent": "家长", "admin": "管理员"}
CAP_NAMES = {
    "chat": "和管家聊天", "dream": "说梦想", "inbox": "家长收件箱",
    "relay": "传话筒", "logs": "调用记录", "session": "登录",
    "greeting": "问候", "briefing": "晨报", "graph": "记忆星球",
    "affairs": "事务看板", "affairs_write": "修改事务",
    "checklist": "清单", "checklist_write": "勾选清单", "ics": "日历导出",
    "growth": "成长雷达", "memory": "记忆本", "history": "对话历史",
}

# 演示种子账号：仅在 users.json 不存在时写入
SEED_ACCOUNTS = [
    ("小豆", "panda123", "child", "小豆"),
    ("豆豆妈", "mama123", "parent", "小豆"),
    ("admin", "admin123", "admin", "小豆"),
]

# token -> {"username", "role", "child", "ts"}；落盘 data/tokens.json，重启不掉线
_tokens: dict[str, dict] = {}


def _read_tokens() -> dict:
    try:
        data = json.loads(TOKENS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_tokens() -> None:
    TOKENS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = TOKENS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(_tokens, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, TOKENS_PATH)


def _save_tokens() -> None:
    """持久化失败降级为纯内存会话，不阻塞登录/登出。"""
    try:
        _write_tokens()
    except OSError:
        pass


def _expired(u: dict, now: float) -> bool:
    return now - float(u.get("ts", 0) or 0) >= TOKEN_TTL


def _load_tokens() -> None:
    """启动时读回未过期 token，清掉已失效的。"""
    now = time.time()
    with _LOCK:
        _tokens.clear()
        for token, u in _read_tokens().items():
            if isinstance(u, dict) and not _expired(u, now):
                _tokens[token] = u


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), _ITERATIONS
    ).hex()


def _read_users() -> dict:
    try:
        return json.loads(USERS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_users(users: dict) -> None:
    USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = USERS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, USERS_PATH)


def ensure_seed() -> None:
    """users.json 不存在时写入演示账号。"""
    with _LOCK:
        if USERS_PATH.exists():
            return
        users = {}
        for username, password, role, child in SEED_ACCOUNTS:
            salt = secrets.token_hex(16)
            users[username] = {
                "salt": salt, "hash": _hash(password, salt),
                "role": role, "child": child,
            }
        _write_users(users)


def _new_user(password: str, role: str, child: str) -> dict:
    salt = secrets.token_hex(16)
    return {"salt": salt, "hash": _hash(password, salt), "role": role, "child": child}


def login(username: str, password: str) -> dict:
    """校验用户名密码，返回 {token, user, is_new}；失败抛 ValueError。

    未知用户名自动注册为 child（绑同名档案）。已存在则必须密码匹配。
    """
    username = username.strip()[:24]
    if not username or not password:
        raise ValueError("用户名和密码都要填")
    with _LOCK:
        users = _read_users()
        rec = users.get(username)
        is_new = False
        if rec is None:
            rec = _new_user(password, "child", username)
            users[username] = rec
            _write_users(users)
            is_new = True
        elif not hmac.compare_digest(rec["hash"], _hash(password, rec["salt"])):
            raise ValueError("密码不对，再想想～")
    token = secrets.token_hex(24)
    now = time.time()
    with _LOCK:
        # 顺手清掉已失效 token，避免 tokens.json 只增不减
        for t in [t for t, u in _tokens.items() if _expired(u, now)]:
            _tokens.pop(t, None)
        _tokens[token] = {
            "username": username, "role": rec["role"],
            "child": rec["child"], "ts": now,
        }
        _save_tokens()
    return {"token": token, "user": dict(_tokens[token]), "is_new": is_new}


def logout(token: str) -> None:
    with _LOCK:
        if _tokens.pop(token, None) is not None:
            _save_tokens()


def user_for_token(token: str) -> dict | None:
    u = _tokens.get(token or "")
    if not u:
        return None
    if _expired(u, time.time()):
        with _LOCK:
            _tokens.pop(token, None)
            _save_tokens()
        return None
    return u


def can(user: dict, cap: str) -> bool:
    caps = CAPS.get(user.get("role"), set())
    return "*" in caps or cap in caps


def cap_label(cap: str) -> str:
    return CAP_NAMES.get(cap, cap)


def resolve_child(user: dict, requested: str | None) -> str:
    """把请求里的 name 归一到该账号绑定的档案；admin 可指定任意档案。"""
    requested = (requested or "").strip()
    if user["role"] == "admin":
        return requested or user["child"]
    if requested and requested != user["child"]:
        raise PermissionError(
            f"账号「{user['username']}」只能访问孩子「{user['child']}」的档案")
    return user["child"]


ensure_seed()
_load_tokens()
