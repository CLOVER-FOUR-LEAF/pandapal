"""会话：登录名 → data/{child}/ 档案目录绑定 + 会话内短期历史。

profiles.json 维护"登录名 → 档案目录"映射；未匹配的名字自动新建空白档案，
保证评委各玩各的、互不污染演示档。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from collections import deque
from pathlib import Path

from . import config
from .memory import MemoryStore

PROFILES_PATH = config.DATA_DIR / "profiles.json"


def _read_profiles() -> dict:
    try:
        return json.loads(PROFILES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_profiles(profiles: dict) -> None:
    tmp = PROFILES_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, PROFILES_PATH)


def _safe_dirname(name: str) -> str:
    slug = re.sub(r"[^\w\u4e00-\u9fff-]", "_", name)[:40].strip("_")
    return f"child_{slug or 'guest'}"


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


_sessions: dict[str, Session] = {}


def resolve(name: str) -> tuple[Path, bool]:
    """登录名 → 档案目录。命中映射用映射；否则新建空白档。"""
    profiles = _read_profiles()
    if name in profiles:
        child_dir = config.DATA_DIR / profiles[name]
        child_dir.mkdir(parents=True, exist_ok=True)
        return child_dir, False
    child_dir = config.DATA_DIR / _safe_dirname(name)
    is_new = not child_dir.exists()
    _scaffold(child_dir, name)
    profiles[name] = child_dir.name
    _write_profiles(profiles)
    return child_dir, is_new


async def login(name: str) -> Session:
    """获取或创建会话。评委输入任意名字都能得到独立档案。"""
    name = name.strip()[:24]
    if not name:
        raise ValueError("名字不能为空")
    if name in _sessions:
        return _sessions[name]
    child_dir, is_new = await asyncio.to_thread(resolve, name)
    sess = Session(name, child_dir, is_new)
    _sessions[name] = sess
    return sess
