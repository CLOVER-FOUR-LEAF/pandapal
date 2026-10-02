"""会话：登录名 → data/{child}/ 档案目录绑定 + 会话内短期历史。

profiles.json 维护"登录名 → 档案目录"映射（运行时文件，已被 .gitignore 排除）；
profiles.seed.json 是入库的演示别名种子，读取时两者合并、运行时的条目优先。
未匹配的名字自动新建空白档案，保证评委各玩各的、互不污染演示档。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from collections import deque
from pathlib import Path

from . import config, store
from .memory import MemoryStore

PROFILES_PATH = config.DATA_DIR / "profiles.json"
SEED_PATH = config.DATA_DIR / "profiles.seed.json"
_PROFILES_LOCK = threading.Lock()


def _read_profiles() -> dict:
    """种子别名 + 运行时注册合并；运行时条目优先。"""
    try:
        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        if not isinstance(seed, dict):
            seed = {}
    except (OSError, json.JSONDecodeError):
        seed = {}
    try:
        runtime = json.loads(PROFILES_PATH.read_text(encoding="utf-8"))
        if not isinstance(runtime, dict):
            runtime = {}
    except (OSError, json.JSONDecodeError):
        runtime = {}
    return {**seed, **runtime}


def _write_profiles(profiles: dict) -> None:
    tmp = PROFILES_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, PROFILES_PATH)


def _safe_dirname(name: str) -> str:
    slug = re.sub(r"[^\w\u4e00-\u9fff-]", "_", name)[:40].strip("_")
    return f"child_{slug or 'guest'}"


def _dir_owner(child_dir: Path) -> str | None:
    """档案目录的归属名（index.json 里的 name）。

    空目录视为无主（返回 ""）；index 读不出来视为"别人在住"（返回 None，
    宁错杀不可撞——文件系统大小写不敏感时，名字不同也可能命中同一目录）。
    """
    idx = child_dir / "index.json"
    if not idx.exists():
        try:
            return "" if not any(child_dir.iterdir()) else None
        except OSError:
            return None
    try:
        owner = json.loads(idx.read_text(encoding="utf-8")).get("name")
        return str(owner) if owner else None
    except (OSError, json.JSONDecodeError):
        return None


def _claim_dir(name: str) -> tuple[Path, bool]:
    """认领档案目录：撞了别人的目录（大小写、清洗后同名都算）顺延 _2、_3，绝不共享。"""
    base = _safe_dirname(name)
    for i in range(1, 50):
        child_dir = config.DATA_DIR / (base if i == 1 else f"{base}_{i}")
        if not child_dir.exists():
            return child_dir, True
        owner = _dir_owner(child_dir)
        if owner == name or owner == "":
            return child_dir, not idx_exists(child_dir)
    return config.DATA_DIR / f"{base}_{os.urandom(3).hex()}", True


def idx_exists(child_dir: Path) -> bool:
    return (child_dir / "index.json").exists()


def _scaffold(child_dir: Path, name: str) -> None:
    """为新孩子建空白档案骨架。"""
    (child_dir / "topics").mkdir(parents=True, exist_ok=True)
    (child_dir / "daily").mkdir(parents=True, exist_ok=True)
    mem = child_dir / "MEMORY.md"
    if not mem.exists():
        mem.write_text(f"# {name} 的长期记忆\n\n- （今天刚认识 {name}，慢慢了解中）\n", encoding="utf-8")
    idx = child_dir / "index.json"
    if not idx.exists():
        idx.write_text(
            json.dumps({"name": name, "topics": {}}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


class Session:
    def __init__(self, name: str, child_dir: Path, is_new: bool):
        self.name = name
        self.dir = child_dir
        self.is_new = is_new
        self.store = MemoryStore(child_dir)
        self.history: deque[dict] = deque(maxlen=config.HISTORY_TAIL * 2)
        self.lock = asyncio.Lock()
        self.last_active = time.monotonic()


def _read_history(path: Path) -> list[dict]:
    """重开档案时恢复会话历史：{role, content} + secret 标记 + 附件元数据。

    files 必须一起恢复：前端靠它重画文件卡，服务端靠它在新一轮里重新附上图片
    （丢了就等于"重启之后图片全部消失"）。
    """
    data = store.read_json(path, {"history": []})
    items = data.get("history") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    out = []
    for m in items:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        entry = {"role": m["role"], "content": str(m.get("content") or "")}
        if m.get("secret"):
            entry["secret"] = True
        files = m.get("files")
        if isinstance(files, list):
            clean = [f for f in files if isinstance(f, dict) and f.get("id")]
            if clean:
                entry["files"] = clean[: config.UPLOAD_MAX_FILES_PER_REQUEST]
        out.append(entry)
    return out


def persist_history(sess: Session) -> None:
    """会话历史落盘（同步小文件，调用方负责 to_thread）。重启后刷新恢复仍可用。"""
    store.atomic_write(
        sess.dir / "history.json",
        json.dumps({"history": list(sess.history)}, ensure_ascii=False, indent=1),
    )


_sessions: dict[str, Session] = {}
_SESSIONS_LOCK = asyncio.Lock()


def resolve(name: str) -> tuple[Path, bool]:
    """登录名 → 档案目录。命中显式映射用映射；否则认领/新建无主目录。

    profiles 里的条目只可能是服务端写的（种子映射 + 本函数回写），
    账号侧永远只能传"自己绑定的名字"——所以这里信映射、认归属，
    名字撞上别人已占用的目录一律顺延，两个账号不会落到同一档案。
    """
    with _PROFILES_LOCK:
        profiles = _read_profiles()
        if name in profiles:
            child_dir = config.DATA_DIR / profiles[name]
            child_dir.mkdir(parents=True, exist_ok=True)
            return child_dir, False
        child_dir, is_new = _claim_dir(name)
        _scaffold(child_dir, name)
        profiles[name] = child_dir.name
        _write_profiles(profiles)
        return child_dir, is_new


def _sweep_idle(now: float) -> None:
    """回收闲置会话：内存里的 Session 只增不减，长跑会渗漏。
    正在聊的（持锁）不动；历史已落盘，回收后重新登录照样恢复。"""
    for k, s in list(_sessions.items()):
        if s.lock.locked() or now - s.last_active < config.SESSION_IDLE_S:
            continue
        _sessions.pop(k, None)


async def login(name: str) -> Session:
    """获取或创建会话。评委输入任意名字都能得到独立档案。"""
    name = name.strip()[:24]
    if not name:
        raise ValueError("名字不能为空")
    now = time.monotonic()
    if name in _sessions:
        sess = _sessions[name]
        sess.last_active = now
        return sess
    # 同一名字的并发首登要拿到同一个 Session——否则后写覆盖 _sessions，
    # 先建者成孤儿（锁/历史不同步）
    async with _SESSIONS_LOCK:
        _sweep_idle(now)
        if name in _sessions:
            sess = _sessions[name]
            sess.last_active = now
            return sess
        child_dir, is_new = await asyncio.to_thread(resolve, name)
        sess = Session(name, child_dir, is_new)
        sess.history.extend(
            await asyncio.to_thread(_read_history, child_dir / "history.json"))
        _sessions[name] = sess
        return sess
