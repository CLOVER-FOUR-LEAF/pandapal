"""意图分类：闲聊直答 / 新事务 / 事务进展 / 转达 / 讲懂知识点，并识别情绪。"""
from __future__ import annotations

from . import llm, prompts

_VALID_INTENTS = {"chat", "new_affair", "affair_update", "relay", "explain"}
_VALID_MOODS = {"happy", "sad", "nervous", "normal"}

# LLM 不可用时的关键词保底
_NEW_HINTS = ("准备", "规划", "安排", "要带", "带什么", "怎么去", "攻略", "行程", "报名了", "比赛要", "帮我查", "帮我做", "想学", "要不要")
_UPDATE_HINTS = ("买好了", "订好了", "搞定了", "做完了", "不去了", "取消了", "已经准备", "考完了", "好了吗")
_RELAY_HINTS = ("转达", "告诉老师", "跟妈妈说", "跟爸爸说", "帮我告诉", "帮我转", "帮我跟", "传达", "和老师说")
_EXPLAIN_HINTS = ("什么是", "什么意思", "为什么", "没听懂", "听不懂", "是什么", "怎么理解", "给我讲讲", "讲一下", "教我")


def _fallback(message: str) -> dict:
    if any(h in message for h in _RELAY_HINTS):
        intent = "relay"
    elif any(h in message for h in _UPDATE_HINTS):
        intent = "affair_update"
    elif any(h in message for h in _NEW_HINTS):
        intent = "new_affair"
    elif any(h in message for h in _EXPLAIN_HINTS):
        intent = "explain"
    else:
        intent = "chat"
    return {"intent": intent, "mood": "normal", "affair_id": None, "reason": "关键词保底"}


async def classify(message: str, affairs_brief: str = "") -> dict:
    """返回 {intent, mood, affair_id, reason}。LLM 分类失败时用关键词保底。"""
    try:
        data = await llm.complete_json(
            [{"role": "user", "content": prompts.ROUTER.format(
                message=message,
                affairs_brief=affairs_brief or "（目前没有正在跟进的事）",
            )}],
            max_tokens=500,
            caller="router",
        )
        intent = str(data.get("intent", "")).lower()
        mood = str(data.get("mood", "normal")).lower()
        if intent in _VALID_INTENTS:
            aid = data.get("affair_id")
            return {
                "intent": intent,
                "mood": mood if mood in _VALID_MOODS else "normal",
                "affair_id": str(aid) if aid else None,
                "reason": str(data.get("reason", ""))[:80],
            }
    except Exception:  # noqa: BLE001 分类失败不能拖垮对话
        pass
    return _fallback(message)
