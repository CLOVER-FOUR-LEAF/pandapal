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


def main() -> int:
    try:
        test_looks_like_continuation()
        test_classify_continuation_is_chat()
        test_fallback_still_works()
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
