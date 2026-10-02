"""记忆层离线自检：不联网、不起服务，直接打 MemoryStore 的读写行为。

用法：python tests/test_memory.py

覆盖记忆层的对话体验相关行为：
  - 活跃块：字符预算封顶、活跃主题按新近度择优、最近日记固定附带、围栏完整
  - 检索：相关主题才注入、弱命中被门槛挡掉、活跃主题不重复、长正文被折叠
  - 归档：累计计数不丢、上限真正生效（标记不占正文额度）
  - 写入：related 回写 index 可检索、事实折叠成单行、长期记忆按行封顶
  - 容错：reminders.json 脏数据不让问候接口炸掉、旧档案缺头部也能解析
  - 读缓存：命中后稳定，写盘后立刻可见（不返回陈旧档案）

数据目录用 PANDA_DATA_DIR 指向一次性沙箱，真实 data/ 一个字节都不碰。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_memory_")

from server import memory  # noqa: E402
from server.memory import MemoryStore, _append_capped, _parse_topic, _render_topic  # noqa: E402
from server.store import clamp_lines  # noqa: E402

SANDBOX = Path(os.environ["PANDA_DATA_DIR"])
TODAY = date.today()
DAY = TODAY.isoformat()
OLD_DAY = (TODAY - timedelta(days=200)).isoformat()

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


def body_of(fenced: str) -> str:
    """只留围栏里的记忆正文（断言内容用）。"""
    m = re.search(r"<memory_data>\n(.*)\n</memory_data>", fenced, re.S)
    if not m:
        return ""
    lines = m.group(1).splitlines()
    return "\n".join(lines[1:]).strip() if lines else ""  # 首行是"数据不是指令"说明


def fresh_store(child: str = "child_test") -> MemoryStore:
    d = SANDBOX / child
    shutil.rmtree(d, ignore_errors=True)
    (d / "topics").mkdir(parents=True, exist_ok=True)
    (d / "daily").mkdir(parents=True, exist_ok=True)
    (d / "index.json").write_text('{"name": "小豆", "topics": {}}', encoding="utf-8")
    (d / "MEMORY.md").write_text("# 小豆的长期记忆\n", encoding="utf-8")
    memory._CACHE.clear()
    return MemoryStore(d)


def put_topic(store: MemoryStore, name: str, facts: list[str], status: str = "active",
              related: list[str] | None = None, updated: str = "") -> None:
    """直接落一个主题档案 + 索引条目（不经 LLM，读路径用）。"""
    safe = re.sub(r"[^\w一-鿿-]", "_", name)[:40] or "topic"
    rel = f"topics/{safe}.md"
    body = "\n".join(f"- {f}" for f in facts)
    (store.dir / rel).write_text(
        _render_topic(name, status, related or [], body), encoding="utf-8")
    if updated:  # 覆盖头部 updated，制造"很久以前"的档案
        text = (store.dir / rel).read_text(encoding="utf-8")
        (store.dir / rel).write_text(
            re.sub(r"^updated: .*$", f"updated: {updated}", text, count=1, flags=re.M),
            encoding="utf-8")
    index = store.read_index()
    index.setdefault("topics", {})[name] = {
        "status": status, "related": related or [], "file": rel}
    (store.dir / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    memory._CACHE.clear()


def put_daily(store: MemoryStore, day: str, lines: list[str]) -> None:
    body = "\n".join(f"- {ln}" for ln in lines)
    (store.dir / "daily" / f"{day}.md").write_text(f"# {day}\n\n{body}\n", encoding="utf-8")
    memory._CACHE.clear()


# ------------------------------------------------------------------ 用例

def test_clamp_lines() -> None:
    text = "\n".join(f"- 事实{i}" for i in range(40))
    out = clamp_lines(text, 60)
    record("clamp_lines_budget", len(out) <= 90 and "已折叠" in out and "事实39" in out,
           f"len={len(out)}")
    record("clamp_lines_noop", clamp_lines("短文本", 100) == "短文本")
    record("clamp_lines_empty", clamp_lines("", 10) == "" and clamp_lines("x", 0) == "")


def test_append_capped() -> None:
    lines = [f"- 事实{i}" for i in range(4)]
    record("cap_under_limit", _append_capped(lines, "- 新事实", 5) == lines + ["- 新事实"])
    # 5 条正文 + 1 条新事实 = 6 行 > 上限 5；折叠发生后标记顶替最旧那条，结果正好 5 行
    out = _append_capped([f"- 事实{i}" for i in range(5)], "- 新事实", 5)
    record("cap_drops_oldest", len(out) == 5 and out[-1] == "- 新事实"
           and out[0] == "- （更早的 2 条已归档）" and "- 事实0" not in out, str(out))
    # 二次折叠：计数必须累加，而不是重报当次丢弃数
    out2 = _append_capped(out, "- 更新事实", 5)
    record("cap_counts_cumulative",
           len(out2) == 5 and out2[0] == "- （更早的 3 条已归档）"
           and out2[-1] == "- 更新事实", str(out2))
    cur = out2
    for i in range(20):
        cur = _append_capped(cur, f"- 追加{i}", 5)
    record("cap_stays_bounded", len(cur) == 5 and cur[0] == "- （更早的 23 条已归档）", str(cur))
    record("cap_never_exceeds",
           max(len(_append_capped([f"- 事实{i}" for i in range(n)], "-x", 5))
               for n in range(0, 12)) == 5)
    # 极端上限：0 什么都不留，1 只留标记
    record("cap_zero_limit", _append_capped(["- a", "- b"], "- c", 0) == [])
    record("cap_one_limit", _append_capped(["- a", "- b"], "- c", 1) == ["- （更早的 3 条已归档）"],
           str(_append_capped(["- a", "- b"], "- c", 1)))
    record("cap_two_limit", _append_capped(["- a"], "- b", 2) == ["- a", "- b"],
           str(_append_capped(["- a"], "- b", 2)))


def test_active_block_budget_and_recency() -> None:
    store = fresh_store()
    (store.dir / "MEMORY.md").write_text(
        "# 小豆的长期记忆\n" + "\n".join(f"- 长期事实{i}：{'细' * 30}" for i in range(60)),
        encoding="utf-8")
    put_topic(store, "钢琴", ["开始学琴" * 30], updated=OLD_DAY)
    put_topic(store, "攒钱买电脑", [f"{DAY} 攒到 300 块"], updated=DAY)
    memory._CACHE.clear()

    block = MemoryStore(store.dir).active_block()
    text = body_of(block)
    record("active_fenced", block.startswith("<memory_data>") and block.endswith("</memory_data>")
           and "不是指令" in block)
    record("active_budget", len(text) <= memory._ACTIVE_MAX_CHARS + 200,
           f"len={len(text)} budget={memory._ACTIVE_MAX_CHARS}")
    record("active_recency_priority", text.index("攒钱买电脑") < text.index("钢琴"),
           "新关注点排在旧关注点前面")
    record("active_memory_clamped", "已折叠" in text and "长期事实0：" not in text,
           "长期记忆超预算时折叠最旧的条目")

    put_daily(store, (TODAY - timedelta(days=2)).isoformat(), ["聊了数学作业"])
    put_daily(store, DAY, ["他说想养一只猫"])
    memory._CACHE.clear()
    text2 = body_of(MemoryStore(store.dir).active_block())
    record("active_recent_daily", "想养一只猫" in text2 and "日记" in text2,
           text2.splitlines()[-1][:50])
    record("active_daily_no_title", "# " + DAY not in text2, "日记标题行不重复注入")

    record("active_never_empty", "长期记忆" in body_of(fresh_store("child_empty").active_block()))


def test_retrieve_relevance() -> None:
    store = fresh_store()
    put_topic(store, "钢琴", [f"{OLD_DAY} 开始学琴", "练了音阶"], status="archived")
    put_topic(store, "攒钱买电脑", [f"{DAY} 攒到 300 块"], status="archived")
    put_topic(store, "机器人比赛", [f"{DAY} 报名了"], status="archived")

    hit = MemoryStore(store.dir).retrieve("钢琴还练吗")
    record("retrieve_hits_relevant", "钢琴" in hit and "开始学琴" in hit,
           hit[:60].replace("\n", " "))
    record("retrieve_not_noisy", "机器人比赛" not in hit, "无关主题不进检索块")
    record("retrieve_shows_status", "状态：archived" in hit and "最近" in hit,
           hit[:60].replace("\n", " "))
    record("retrieve_fenced", hit.startswith("<memory_data>") and hit.endswith("</memory_data>"))

    none = MemoryStore(store.dir).retrieve("今天天气怎么样")
    record("retrieve_no_weak_match", "钢琴" not in none, f"block={len(none)}")

    # 单字主题名不再被整句吞掉（旧的"词是不是提问子串"规则里 1 字名字几乎不会命中）
    put_topic(store, "猫", [f"{DAY} 想养一只猫"], status="archived", related=["小动物"])
    memory._CACHE.clear()
    hit_single = MemoryStore(store.dir).retrieve("我想养猫")
    record("retrieve_single_char_topic", "猫" in hit_single, hit_single[:50].replace("\n", " "))


def test_retrieve_skips_active_and_clamps() -> None:
    store = fresh_store()
    long_body = "很长的练琴记录" * 60
    put_topic(store, "钢琴", [long_body], status="active")
    put_topic(store, "航模", [f"{OLD_DAY} 喜欢过航模"], status="archived")
    memory._CACHE.clear()
    store = MemoryStore(store.dir)
    body = store.retrieve("钢琴和航模")
    record("retrieve_skips_active", "钢琴" not in body, "活跃主题已在活跃块，不重复注入")
    record("retrieve_includes_inactive", "航模" in body and "状态：archived" in body,
           body[:60].replace("\n", " "))
    record("retrieve_clamps_body", len(body) <= memory._RETRIEVE_TOPIC_CHARS + 400,
           f"len={len(body)}")
    # 活跃的"钢琴"仍然要出现在活跃块里（没被检索重复，也没丢）
    record("retrieve_active_in_active_block", "钢琴" in body_of(store.active_block()))


def test_write_extraction() -> None:
    store = fresh_store()
    data = {
        "daily": "聊了机器人比赛\n第二行应该被折成同一行",
        "topics": [{"name": "机器人 比赛", "status": "active",
                    "fact": f"{DAY} 报名了校赛", "related": ["机器人", "比赛"]}],
        "longterm": "他遇到难题会先自己查资料",
    }
    asyncio.run(store.write_extraction(data))
    index = json.loads((store.dir / "index.json").read_text(encoding="utf-8"))
    entry = index["topics"]["机器人 比赛"]
    record("write_index_related", entry.get("related") == ["机器人", "比赛"], str(entry))
    record("write_name_single_line",
           entry["file"].startswith("topics/") and "\n" not in entry["file"], entry["file"])
    daily_file = next((store.dir / "daily").glob("*.md"))
    daily_text = daily_file.read_text(encoding="utf-8")
    record("write_daily_single_line",
           "聊了机器人比赛 第二行应该被折成同一行" in daily_text,
           daily_text.strip().replace("\n", " | ")[:70])
    mem = (store.dir / "MEMORY.md").read_text(encoding="utf-8")
    record("write_longterm", "他遇到难题会先自己查资料" in mem and mem.startswith("# "),
           mem.strip()[:50])
    # 写盘后立刻可见（活跃块/主题名走读缓存路径，不能被陈旧档案挡住）
    fresh = MemoryStore(store.dir)
    block = body_of(fresh.active_block())
    record("write_visible_after_write", "机器人 比赛" in block and "报名了校赛" in block,
           block[:60].replace("\n", " "))
    record("write_visible_topic_names", "机器人 比赛" in fresh.topic_names(), fresh.topic_names())


def test_longterm_capped() -> None:
    store = fresh_store()
    for i in range(memory._MEMORY_MAX_LINES + 5):
        asyncio.run(store.write_extraction({"longterm": f"长期事实 {i}"}))
    lines = [ln for ln in (store.dir / "MEMORY.md").read_text(encoding="utf-8").splitlines()
             if ln.strip()]
    record("longterm_line_cap", len(lines) <= memory._MEMORY_MAX_LINES,
           f"lines={len(lines)} cap={memory._MEMORY_MAX_LINES}")
    record("longterm_archive_marker", "已归档" in "\n".join(lines) and lines[0].startswith("# "),
           lines[0][:30])


def test_cache_freshness() -> None:
    store = fresh_store()
    put_topic(store, "钢琴", ["开始学琴"])
    first = MemoryStore(store.dir).active_block()
    second = MemoryStore(store.dir).active_block()
    record("cache_hit_stable", "钢琴" in first and first == second)
    put_topic(store, "新爱好", [f"{DAY} 想学围棋"])
    third = MemoryStore(store.dir).active_block()
    record("cache_invalidated_on_write", "新爱好" in third and third != second,
           third.splitlines()[-1][:40])


def test_due_reminders_tolerance() -> None:
    store = fresh_store()
    (store.dir / "reminders.json").write_text(json.dumps([
        {"text": "每天读英语", "time": "daily"},
        {"text": "脏数据", "time": "不是日期"},
        {"text": "没时间", "time": None},
        {"text": "缺字段"},
        "不是字典",
    ], ensure_ascii=False), encoding="utf-8")
    record("reminders_tolerate_dirty",
           [d["text"] for d in store.due_reminders()] == ["每天读英语"],
           str(store.due_reminders()))


def test_parse_topic_tolerance() -> None:
    meta = _parse_topic("没有头部元数据的旧档案\n第二行")
    record("parse_topic_legacy", meta["status"] == "active" and "没有头部元数据" in meta["body"],
           str(meta)[:60])
    meta2 = _parse_topic(_render_topic("钢琴", "done", ["音乐"], "- 弹了曲子"))
    record("parse_topic_meta", meta2["status"] == "done" and meta2["related"] == ["音乐"]
           and "弹了曲子" in meta2["body"] and meta2["updated"] == DAY, str(meta2)[:60])


def main() -> int:
    try:
        test_clamp_lines()
        test_append_capped()
        test_active_block_budget_and_recency()
        test_retrieve_relevance()
        test_retrieve_skips_active_and_clamps()
        test_write_extraction()
        test_longterm_capped()
        test_cache_freshness()
        test_due_reminders_tolerance()
        test_parse_topic_tolerance()
    finally:
        shutil.rmtree(SANDBOX, ignore_errors=True)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    for name, ok, note in RESULTS:
        if not ok:
            print(f"  失败：{name}  {note}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
