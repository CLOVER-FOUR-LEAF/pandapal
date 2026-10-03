"""Dreaming 引擎离线回归：跨天反复出现的事晋升进 MEMORY.md，当天梦过一次就跳。

用法：python tests/test_dream.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_dream_")
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

from server import dream  # noqa: E402
from server.memory import MemoryStore  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


def _mk_store() -> MemoryStore:
    child = Path(os.environ["PANDA_DATA_DIR"]) / "child_梦梦"
    (child / "daily").mkdir(parents=True, exist_ok=True)
    (child / "MEMORY.md").write_text("# 梦梦的长期记忆\n- 梦梦家在海边小城\n", encoding="utf-8")
    return MemoryStore(child)


def _daily(store: MemoryStore, day: str, lines: list[str]) -> None:
    (store.dir / "daily" / f"{day}.md").write_text(
        f"# {day}\n\n" + "\n".join(lines) + "\n", encoding="utf-8")


def _mem_lines(store: MemoryStore) -> list[str]:
    return (store.dir / "MEMORY.md").read_text(encoding="utf-8").splitlines()


async def main() -> int:
    store = _mk_store()
    # 同一件事跨 3 天说了 3 次 → 该晋升；单日重复和悄悄话占位不该升
    _daily(store, "2026-09-28", [
        "- 小豆的巡线小车终于转过弯了，很有成就感（话题：机器人课）",
        "- 体育课跑步比赛拿了小组第二",
    ])
    _daily(store, "2026-09-30", [
        "- 小豆的巡线小车转过弯了，他很有成就感（话题：机器人课）",
        "- 今天有点困，早早睡了",
    ])
    _daily(store, "2026-10-02", [
        "- 小豆的巡线小车转过弯了，小豆很有成就感（话题：机器人课）",
        "- 美术课画了一只恐龙",
        "- （悄悄话一条，内容保密，只记进孩子自己的图谱）",
    ])

    summary = await dream.maybe_dream(store)
    mem = "\n".join(_mem_lines(store))
    record("dream_summary", summary is not None and summary["candidates"] >= 4,
           str(summary))
    record("promote_multiday",
           "[梦]" in mem and "巡线小车" in mem,
           f"MEMORY:\n{mem}")
    record("promote_marker_once", mem.count("[梦]") == 1,
           f"[梦]x{mem.count('[梦]')}")
    # 单日事/占位行都不该进长期记忆
    record("no_promotion_of_singles",
           "恐龙" not in mem and "小组第二" not in mem and "有点困" not in mem
           and "悄悄话" not in mem)

    # 梦日记落盘：主题分组可视化
    diary = store.dir / "dream" / f"{date.today().isoformat()}.md"
    diary_txt = diary.read_text(encoding="utf-8") if diary.exists() else ""
    record("dream_diary", "的梦" in diary_txt and "记住的事" in diary_txt,
           f"exists={diary.exists()} len={len(diary_txt)}")

    # 幂等：同一天再梦直接跳过，不重复晋升
    again = await dream.maybe_dream(store)
    mem2 = "\n".join(_mem_lines(store))
    record("dream_once_per_day", again is None and mem2.count("[梦]") == 1,
           f"again={again}")

    # 记忆本出口：梦日记随 export 给记忆本页（新梦在前、带日期）
    exp = store.export()
    record("dream_export",
           bool(exp.get("dreams")) and "的梦" in exp["dreams"][0]["content"]
           and exp["dreams"][0]["date"] == date.today().isoformat(),
           f"dreams={len(exp.get('dreams') or [])}")

    # 全新空档案：没有 daily 的梦照跑不误，0 晋升不炸
    empty_dir = Path(os.environ["PANDA_DATA_DIR"]) / "child_空空"
    (empty_dir / "daily").mkdir(parents=True, exist_ok=True)
    s2 = await dream.maybe_dream(MemoryStore(empty_dir))
    record("dream_empty_ok", s2 is not None and s2["promoted"] == 0
           and s2["candidates"] == 0, str(s2))

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} 通过")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
