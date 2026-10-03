"""续写指令的路由回归：用户暂停回答后点「继续」时发来的话，必须走闲聊直答。

用法：python tests/test_router.py

为什么单测这条：续写指令一旦被判成 new_affair/todo，管家会去建事务、出计划卡，
而用户只是想接着听完那段话。这里用确定性规则拦住，不依赖模型判对。
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("PANDA_DATA_DIR", tempfile.mkdtemp(prefix="panda_router_"))

from server import llm, prompts, router  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


def test_looks_like_continuation() -> None:
    for text in ("接着说", "继续说完", "接着上面继续说", "往下说", "继续", "接着说吧！", "然后呢？"):
        record(f"continuation:{text[:8]}", router.looks_like_continuation(text))
    for text in ("帮我准备下周的比赛", "什么是利息", "我今天有点难过", "",
                 # 带了新内容的话不能被短路成闲聊（会跳过建事务/情绪识别）
                 "我想接着说说下周要准备的比赛", "接着上面的，明天要交作文和PPT", "继续练钢琴好累"):
        record(f"not_continuation:{text[:8]}", not router.looks_like_continuation(text))
    # 很长的话里恰好含"接着说"不算续写指令（避免误伤正常提问）
    long_text = "我想说的是" + "很多很多内容" * 12 + "接着说我自己的计划"
    record("long_text_not_continuation", not router.looks_like_continuation(long_text),
           f"len={len(long_text)}")


def test_classify_continuation_is_chat() -> None:
    calls = {"n": 0}
    saved = llm.complete_json

    async def fake(messages, **kw):
        calls["n"] += 1
        # 故意让模型把这句判成新事务：服务端必须压回 chat
        return {"intent": "new_affair", "mood": "normal", "affair_id": None, "reason": "模型误判"}

    llm.complete_json = fake
    try:
        data = asyncio.run(router.classify("接着说"))
    finally:
        llm.complete_json = saved
    record("continuation_intent_chat", data["intent"] == "chat", str(data))
    record("continuation_skips_llm", calls["n"] == 0, f"llm 调用={calls['n']}")


def test_fallback_still_works() -> None:
    # 续写规则只拦续写指令，其它消息的关键词保底不受影响
    record("fallback_new_affair", router._fallback("帮我准备一下比赛")["intent"] == "new_affair")
    record("fallback_chat", router._fallback("今天好累")["intent"] == "chat")
    record("router_prompt_has_rule", "续写指令" in prompts.ROUTER)


def test_fast_triage() -> None:
    """零信号词的短闲聊走免 LLM 快速路；带任何办事/待办信号的一律 veto 回 LLM。"""
    calls = {"n": 0}
    saved = llm.complete_json

    async def fake(messages, **kw):
        calls["n"] += 1
        return {"intent": "new_affair", "mood": "normal", "affair_id": None, "reason": "模型"}

    llm.complete_json = fake
    try:
        d = asyncio.run(router.classify("我今天踢球可开心了"))
        record("fast_chat", d["intent"] == "chat" and d["reason"] == "快速通道", str(d))
        record("fast_skips_llm", calls["n"] == 0, f"llm 调用={calls['n']}")
        # 快速路也认情绪：陪伴产品不能把好难过标成 normal
        d = asyncio.run(router.classify("今天好难过，不想说话"))
        record("fast_mood_sad", d["intent"] == "chat" and d["mood"] == "sad", str(d))
        # veto：办事信号回 LLM
        calls["n"] = 0
        asyncio.run(router.classify("帮我写个请假条"))
        record("veto_action_goes_llm", calls["n"] == 1)
        # veto：待办词回 LLM（作业写完可能是在汇报事务进展）
        calls["n"] = 0
        asyncio.run(router.classify("我的作业写完了"))
        record("veto_todo_goes_llm", calls["n"] == 1)
        # veto：长消息回 LLM
        calls["n"] = 0
        asyncio.run(router.classify("啦啦啦" * 50))
        record("veto_long_goes_llm", calls["n"] == 1)
    finally:
        llm.complete_json = saved


def test_classify_cache() -> None:
    """同一句+同一份简报 → 第二次走缓存不花 LLM；简报变了算新消息；
    LLM 失败的保底结果不缓存。"""
    router._classify_cache.clear()
    calls = {"n": 0}
    saved = llm.complete_json

    async def fake(messages, **kw):
        calls["n"] += 1
        return {"intent": "new_affair", "mood": "normal", "affair_id": None,
                "reason": "模型"}

    async def boom(messages, **kw):
        calls["n"] += 1
        raise RuntimeError("429")

    llm.complete_json = fake
    try:
        m = "帮我准备一下机器人比赛要带什么"  # 带办事信号，必过 fast veto
        d1 = asyncio.run(router.classify(m, "事务A"))
        record("cache_first_llm", calls["n"] == 1 and d1["intent"] == "new_affair")
        d2 = asyncio.run(router.classify(m, "事务A"))
        record("cache_hit_skips_llm",
               calls["n"] == 1 and d2["intent"] == "new_affair"
               and "缓存" in d2["reason"], str(d2))
        asyncio.run(router.classify(m, "事务B新加的"))
        record("cache_brief_keyed", calls["n"] == 2, f"calls={calls['n']}")
        # 失败不缓存：LLM 抛错走关键词保底，修好后同一句重新问模型
        llm.complete_json = boom
        m2 = "帮我准备明天的读书分享"
        d3 = asyncio.run(router.classify(m2, ""))
        record("cache_miss_on_error",
               d3["intent"] == "new_affair" and d3["reason"] == "关键词保底"
               and calls["n"] == 3, str(d3))
        llm.complete_json = fake
        asyncio.run(router.classify(m2, ""))
        record("cache_retry_after_error", calls["n"] == 4, f"calls={calls['n']}")
    finally:
        llm.complete_json = saved
        router._classify_cache.clear()


def main() -> int:
    try:
        test_looks_like_continuation()
        test_classify_continuation_is_chat()
        test_fallback_still_works()
        test_fast_triage()
        test_classify_cache()
    except Exception as e:  # noqa: BLE001
        record("测试脚本自身", False, repr(e))
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    for name, ok, note in RESULTS:
        if not ok:
            print(f"  失败：{name}  {note}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
