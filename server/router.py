"""意图分类：闲聊直答 vs 事件规划。"""
from __future__ import annotations

from . import llm, prompts

_PLAN_HINTS = ("准备", "规划", "安排", "要带", "带什么", "怎么去", "攻略", "行程", "报名了", "比赛要", "帮我查")


async def classify(message: str) -> str:
    """返回 'plan' 或 'chat'。LLM 分类失败时用关键词保底。"""
    try:
        data = await llm.complete_json(
            [{"role": "user", "content": prompts.ROUTER.format(message=message)}],
            max_tokens=80,
        )
        kind = str(data.get("type", "")).lower()
        if kind in ("plan", "chat"):
            return kind
    except Exception:
        pass
    return "plan" if any(h in message for h in _PLAN_HINTS) else "chat"
