"""意图分类：闲聊直答 vs 事件规划。"""
from __future__ import annotations

from . import llm, prompts

_PLAN_HINTS = ("准备", "规划", "安排", "要带", "带什么", "怎么去", "攻略", "行程", "报名了", "比赛要", "帮我查")


_VALID_MOODS = {"happy", "sad", "nervous", "normal"}


async def classify(message: str) -> tuple[str, str]:
    """返回 (intent, mood)：intent ∈ {plan, chat}；LLM 分类失败时用关键词保底。"""
    try:
        data = await llm.complete_json(
            [{"role": "user", "content": prompts.ROUTER.format(message=message)}],
            max_tokens=80,
            caller="router",
        )
        kind = str(data.get("type", "")).lower()
        mood = str(data.get("mood", "normal")).lower()
        if kind in ("plan", "chat"):
            return kind, mood if mood in _VALID_MOODS else "normal"
    except Exception:
        pass
    kind = "plan" if any(h in message for h in _PLAN_HINTS) else "chat"
    return kind, "normal"
