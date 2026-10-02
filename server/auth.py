"""认证与权限隔离：用户名+密码登录/注册，密保问题找回密码，Bearer token 会话，角色能力表。

data/users.json 结构：
    { "<username>": {"salt": "<hex>", "hash": "<hex>", "role": "child|parent|admin",
                     "child": "<绑定的孩子登录名>",
                     "q": "<密保问题>", "asalt": "<hex>", "ahash": "<hex>"} }
    q/asalt/ahash 为可选——注册时填了密保才有的字段，没有则无法自助找回密码。

角色划分：
  child  —— 孩子本人：聊天/梦想/悄悄话 + 自己档案的全部查看能力
  parent —— 家长：收件箱确认、传话筒 + 孩子档案的只读视图（服务端强制过滤私密内容）
  admin  —— 评委/管理员：全部能力 + /api/logs + 可用 name 参数查看任意档案

密码与密保答案都用 PBKDF2-HMAC-SHA256 加盐哈希；token 持久化到 data/tokens.json，
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
ALIAS_SEED_PATH = config.DATA_DIR / "aliases.seed.json"
_LOCK = threading.Lock()
_ITERATIONS = 120_000
TOKEN_TTL = 7 * 24 * 3600  # token 有效期 7 天；过期项在访问时懒惰清除

# 角色 → 能力集合；admin 为 "*" 通配。
# 读/写分离：事务与清单的查看归 affairs/checklist，改动归 *_write——
# 家长是"只读视图 + 收件箱确认 + 传话筒"，绝不能替孩子改看板、勾清单。
CAPS: dict[str, set[str]] = {
    "child": {"session", "greeting", "briefing", "chat", "graph", "affairs",
              "affairs_write", "checklist", "checklist_write",
              "ics", "growth", "dream", "memory", "history", "drafts", "export"},
    "parent": {"session", "greeting", "briefing", "graph", "affairs", "checklist",
               "ics", "inbox", "relay", "growth", "memory", "history", "drafts",
               "weekly", "notice"},
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
    "drafts": "交付文稿", "weekly": "家长周报", "notice": "通知落地",
    "export": "导出童年备忘录", "admin": "后台管理",
}

# 演示种子账号：仅在 users.json 不存在时写入
# (用户名, 密码, 角色, 绑定档案)；种子账号统一带演示密保，忘密码流程开箱可演
# 口令可用环境变量覆盖——README 是公开的，线上部署务必改掉 PANDA_ADMIN_PASSWORD
SEED_QA = ("熊猫最爱吃什么？", "竹子")
SEED_ACCOUNTS = [
    ("小豆", os.getenv("PANDA_CHILD_PASSWORD") or "panda123", "child", "小豆"),
    ("豆豆妈", os.getenv("PANDA_PARENT_PASSWORD") or "mama123", "parent", "小豆"),
    ("admin", os.getenv("PANDA_ADMIN_PASSWORD") or "admin123", "admin", "小豆"),
]

# sha256(token) -> {"username", "role", "child", "ts"}；落盘 data/tokens.json，重启不掉线。
# 只存哈希：tokens.json 即使泄露也拿不到可用的 Bearer 凭证。
_tokens: dict[str, dict] = {}


def _tkey(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


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
        for key, u in _read_tokens().items():
            if isinstance(u, dict) and not _expired(u, now):
                # 旧版本存的是 48 位明文 token：读回时就地换成哈希，下次落盘即脱敏
                _tokens[key if len(key) == 64 else _tkey(key)] = u


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), _ITERATIONS
    ).hex()


def _hash_answer(answer: str, salt: str) -> str:
    """密保答案归一化（去首尾空白、大小写不敏感）后加盐哈希。"""
    return _hash(answer.strip().casefold(), salt)


def _read_users() -> dict:
    try:
        return json.loads(USERS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _read_aliases() -> dict:
    """登录名别名 → 已注册用户名（aliases.seed.json，如 "xiaodou"→"小豆"）。

    别名只在"目标账号已存在"时生效，登录后身份归一到规范用户名；
    它绝不是档案映射——不会把新账号绑到别人的孩子档案上。
    """
    try:
        data = json.loads(ALIAS_SEED_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(v, str)}


def _write_users(users: dict) -> None:
    USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = USERS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, USERS_PATH)


def _with_question(rec: dict, question: str, answer: str) -> dict:
    """给用户记录挂上密保（问题明文展示用，答案只存哈希）。"""
    rec["q"] = question
    rec["asalt"] = secrets.token_hex(16)
    rec["ahash"] = _hash_answer(answer, rec["asalt"])
    return rec


def ensure_seed() -> None:
    """users.json 不存在时写入演示账号。"""
    with _LOCK:
        if USERS_PATH.exists():
            return
        users = {}
        for username, password, role, child in SEED_ACCOUNTS:
            rec = _new_user(password, role, child)
            _with_question(rec, SEED_QA[0], SEED_QA[1])
            users[username] = rec
        _write_users(users)


def _backfill_seed_qa() -> None:
    """老 users.json 里已存在的种子账号补上演示密保，忘密码流程开箱可演。"""
    seeds = {name for name, *_ in SEED_ACCOUNTS}
    with _LOCK:
        users = _read_users()
        dirty = False
        for name in seeds:
            rec = users.get(name)
            if rec and not rec.get("q"):
                _with_question(rec, SEED_QA[0], SEED_QA[1])
                dirty = True
        if dirty:
            try:
                _write_users(users)
            except OSError:
                pass  # 补不上不阻塞启动


def _new_user(password: str, role: str, child: str) -> dict:
    salt = secrets.token_hex(16)
    return {"salt": salt, "hash": _hash(password, salt), "role": role, "child": child}


def _issue_token(username: str, rec: dict) -> dict:
    """签发 token 并落盘；顺手清掉已失效 token，避免 tokens.json 只增不减。"""
    token = secrets.token_hex(24)
    now = time.time()
    with _LOCK:
        for t in [t for t, u in _tokens.items() if _expired(u, now)]:
            _tokens.pop(t, None)
        _tokens[_tkey(token)] = {
            "username": username, "role": rec["role"],
            "child": rec["child"], "ts": now,
        }
        _save_tokens()
        user = dict(_tokens[_tkey(token)])
    return {"token": token, "user": user}


def login(username: str, password: str) -> dict:
    """校验用户名密码，返回 {token, user, is_new}；失败抛 ValueError。

    未知用户名自动注册为 child（绑同名档案）。已存在则必须密码匹配。
    """
    username = username.strip()[:24]
    if not username or not password:
        raise ValueError("用户名和密码都要填")
    with _LOCK:
        users = _read_users()
        # 别名登录（xiaodou → 小豆）：只解析到已存在的账号，密码照常校验。
        # 关键防越权点：别名命中的情况下绝不走"未知名自动注册"分支——
        # 否则任何人都能用一个别名绕过原账号密码，读写别人的档案。
        canonical = _read_aliases().get(username, username)
        rec = users.get(canonical)
        if rec is None and canonical != username:
            # 别名指向的账号不存在（被删/没种子）——别名失效，按输入的本名找，
            # 否则每次登录都会把别名当新名重建一遍、顶掉同名真账号
            rec = users.get(username)
            if rec is not None:
                canonical = username
        is_new = False
        if rec is None:
            rec = _new_user(password, "child", username)
            users[username] = rec
            _write_users(users)
            is_new = True
            canonical = username
        elif not hmac.compare_digest(rec["hash"], _hash(password, rec["salt"])):
            raise ValueError("密码不对，再想想～")
        username = canonical
    res = _issue_token(username, rec)
    res["is_new"] = is_new
    return res


def register(username: str, password: str, role: str = "child", child: str = "",
             question: str = "", answer: str = "") -> dict:
    """显式注册：返回 {token, user, is_new}（注册即登录）；失败抛 ValueError。

    role 只允许 child|parent（admin 不开放自助注册）；parent 必须绑定一个
    已存在的孩子账号。密保问题+答案必填——忘密码时唯一的自助找回凭证。
    """
    username = username.strip()[:24]
    question = question.strip()[:60]
    answer = answer.strip()[:60]
    child = child.strip()[:24]
    if not username:
        raise ValueError("先起个用户名吧")
    if len(password) < 4:
        raise ValueError("密码太短啦，至少 4 位")
    if role not in ("child", "parent"):
        raise ValueError("身份只能选孩子或家长")
    if not question or not answer:
        raise ValueError("密保问题和答案都要填，忘密码时全靠它")
    with _LOCK:
        users = _read_users()
        if username in users:
            raise ValueError("这个名字已经有人用了，换一个吧")
        # 别名是"通往已有账号的入口"，不能注册成独立账号——
        # 否则别名永远先命中旧账号，新号登不进去（也防蹭名撞档）
        if username in _read_aliases():
            raise ValueError("这个名字是别名，已经指向别人的账号啦，换一个吧")
        if role == "parent":
            bound = users.get(child)
            if not bound or bound.get("role") != "child":
                raise ValueError("找不到这个孩子的账号，先让孩子注册一个")
            child_name = bound["child"]
        else:
            child_name = username
        rec = _with_question(_new_user(password, role, child_name), question, answer)
        users[username] = rec
        _write_users(users)
    res = _issue_token(username, rec)
    res["is_new"] = True
    return res


def security_question(username: str) -> dict:
    """取账号的密保问题（找回密码第一步）；账号不存在抛 KeyError。"""
    username = username.strip()[:24]
    rec = _read_users().get(_read_aliases().get(username, username))
    if rec is None:
        raise KeyError(username)
    return {
        "question": rec.get("q") or "",
        "recoverable": bool(rec.get("q") and rec.get("ahash")),
    }


def reset_password(username: str, answer: str, new_password: str) -> None:
    """密保答案核对通过就重置密码，并吊销该账号全部已签发 token。"""
    username = username.strip()[:24]
    if len(new_password) < 4:
        raise ValueError("新密码太短啦，至少 4 位")
    with _LOCK:
        users = _read_users()
        username = _read_aliases().get(username, username)
        rec = users.get(username)
        if rec is None:
            raise ValueError("没有这个账号，先去注册吧")
        if not rec.get("ahash"):
            raise ValueError("这个账号注册时没设密保，找管理员帮忙改吧")
        if not hmac.compare_digest(rec["ahash"], _hash_answer(answer, rec["asalt"])):
            raise ValueError("密保答案不对哦")
        salt = secrets.token_hex(16)
        rec["salt"], rec["hash"] = salt, _hash(new_password, salt)
        users[username] = rec
        _write_users(users)
        # 旧 token 全部作废，重置后必须用新密码重新登录
        for t in [t for t, u in _tokens.items() if u.get("username") == username]:
            _tokens.pop(t, None)
        _save_tokens()


def logout(token: str) -> None:
    with _LOCK:
        if _tokens.pop(_tkey(token), None) is not None:
            _save_tokens()


def user_for_token(token: str) -> dict | None:
    key = _tkey(token)
    u = _tokens.get(key)
    if not u:
        return None
    if _expired(u, time.time()):
        with _LOCK:
            _tokens.pop(key, None)
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


# ---------------------------------------------------------------- 后台用户管理

def list_users() -> list[dict]:
    """账号清单（后台用）：不含哈希/盐，附有效 token 数。"""
    now = time.time()
    with _LOCK:
        counts: dict[str, int] = {}
        for u in _tokens.values():
            if not _expired(u, now):
                counts[u.get("username", "")] = counts.get(u.get("username", ""), 0) + 1
        seeds = {name for name, *_ in SEED_ACCOUNTS}
        out = []
        for username, rec in _read_users().items():
            out.append({
                "username": username,
                "role": rec.get("role", "child"),
                "role_name": ROLE_NAMES.get(rec.get("role", "child"), rec.get("role", "child")),
                "child": rec.get("child", ""),
                "has_question": bool(rec.get("q") and rec.get("ahash")),
                "seed": username in seeds,
                "tokens": counts.get(username, 0),
            })
    out.sort(key=lambda u: ({"admin": 0, "child": 1, "parent": 2}.get(u["role"], 3), u["username"]))
    return out


def revoke_user_tokens(username: str) -> int:
    """吊销某账号的全部 token（踢下线 / 凭证变更后强制重登），返回吊销数量。"""
    with _LOCK:
        keys = [t for t, u in _tokens.items() if u.get("username") == username]
        for t in keys:
            _tokens.pop(t, None)
        if keys:
            _save_tokens()
    return len(keys)


def admin_create_user(username: str, password: str, role: str, child: str = "",
                      question: str = "", answer: str = "") -> dict:
    """后台建号：与 register 同规则，但允许 admin 角色，密保可留空。"""
    username = username.strip()[:24]
    child = child.strip()[:24]
    if not username:
        raise ValueError("用户名不能为空")
    if len(password) < 4:
        raise ValueError("密码太短啦，至少 4 位")
    if role not in ("child", "parent", "admin"):
        raise ValueError("身份只能是孩子/家长/管理员")
    with _LOCK:
        users = _read_users()
        if username in users:
            raise ValueError("这个名字已经有人用了")
        if username in _read_aliases():
            raise ValueError("这个名字是别名，已经指向别人的账号")
        if role == "parent":
            bound = users.get(child)
            if not bound or bound.get("role") != "child":
                raise ValueError("家长账号要绑定一个已存在的孩子账号")
            child_name = bound["child"]
        else:
            # 孩子账号绑同名档案；admin 未指定时绑到第一个孩子档案（演示用）
            child_name = child or (username if role == "child" else
                                   next((r.get("child") for r in users.values()
                                         if r.get("role") == "child"), username))
        rec = _new_user(password, role, child_name)
        if question.strip() and answer.strip():
            _with_question(rec, question.strip()[:60], answer.strip()[:60])
        users[username] = rec
        _write_users(users)
    return {"username": username, "role": role, "child": child_name}


def _admin_count(users: dict) -> int:
    return sum(1 for r in users.values() if r.get("role") == "admin")


def admin_update_user(username: str, *, role: str | None = None, child: str | None = None,
                      password: str | None = None, question: str | None = None,
                      answer: str | None = None, drop_question: bool = False) -> dict:
    """后台改号：换角色/换绑定档案/重置密码/重设密保；凭证类变更吊销全部 token。"""
    with _LOCK:
        users = _read_users()
        rec = users.get(username)
        if rec is None:
            raise KeyError(username)
        kick = False
        if role is not None and role != rec.get("role"):
            if role not in ("child", "parent", "admin"):
                raise ValueError("身份只能是孩子/家长/管理员")
            if rec.get("role") == "admin" and _admin_count(users) <= 1:
                raise ValueError("这是最后一个管理员账号，不能降级")
            rec["role"] = role
            if role == "child" and child is None:
                rec["child"] = username  # 孩子账号默认绑同名档案
            kick = True  # 角色变了能力集就变了，旧 token 继续用等于越权
        if child is not None and child.strip() and child.strip() != rec.get("child"):
            rec["child"] = child.strip()[:24]
        if rec.get("role") == "parent":
            bound = users.get(rec.get("child") or "")
            if not bound or bound.get("role") != "child":
                raise ValueError("家长账号必须绑定一个已存在的孩子账号")
        if password:
            if len(password) < 4:
                raise ValueError("新密码太短啦，至少 4 位")
            salt = secrets.token_hex(16)
            rec["salt"], rec["hash"] = salt, _hash(password, salt)
            kick = True
        if drop_question:
            rec.pop("q", None)
            rec.pop("asalt", None)
            rec.pop("ahash", None)
        elif question is not None and answer is not None and question.strip() and answer.strip():
            _with_question(rec, question.strip()[:60], answer.strip()[:60])
        users[username] = rec
        _write_users(users)
    if kick:
        revoke_user_tokens(username)
    return {"username": username, "role": rec["role"], "child": rec.get("child", ""),
            "has_question": bool(rec.get("q") and rec.get("ahash"))}


def admin_delete_user(username: str, requester: str) -> None:
    """后台删号：不能删自己、不能删最后一个管理员；档案目录保留不删（数据即文件）。"""
    if username == requester:
        raise ValueError("不能删除正在登录的自己")
    with _LOCK:
        users = _read_users()
        rec = users.get(username)
        if rec is None:
            raise KeyError(username)
        if rec.get("role") == "admin" and _admin_count(users) <= 1:
            raise ValueError("这是最后一个管理员账号，删了后台就进不来了")
        users.pop(username)
        _write_users(users)
    revoke_user_tokens(username)


ensure_seed()
_backfill_seed_qa()
_load_tokens()
