"""意图分类：闲聊直答 / 新事务 / 多任务拆解 / 事务进展 / 转达 / 讲懂知识点，并识别情绪。"""
from __future__ import annotations

import asyncio
import re

from . import llm, prompts

_VALID_INTENTS = {"chat", "new_affair", "todo", "affair_update", "relay", "explain"}
_VALID_MOODS = {"happy", "sad", "nervous", "normal"}

# 分类是每条消息的第一跳，孩子在它返回前什么都看不到。留痕里 router 的 p90 是 6.8s、
# 最慢 17s——超过这个预算就用关键词保底先往下走，别让整轮卡在"判断要不要办事"上。
ROUTER_BUDGET_S = 8.0

# LLM 不可用时的关键词保底
_NEW_HINTS = ("准备", "规划", "安排", "要带", "带什么", "怎么去", "攻略", "行程", "报名了", "比赛要", "帮我查", "帮我做", "想学", "要不要",
              "帮我写", "帮我拟", "帮我起草", "起草", "写一封", "写一份", "写一篇", "写一个",
              "发言稿", "演讲稿", "申请书", "推荐信", "自我介绍", "请假条", "主持稿", "竞选稿")
_UPDATE_HINTS = ("买好了", "订好了", "搞定了", "做完了", "不去了", "取消了", "已经准备", "考完了", "好了吗")
_RELAY_HINTS = ("转达", "告诉老师", "跟妈妈说", "跟爸爸说", "帮我告诉", "帮我转", "帮我跟", "传达", "和老师说")
_EXPLAIN_HINTS = ("什么是", "什么意思", "为什么", "没听懂", "听不懂", "是什么", "怎么理解", "给我讲讲", "讲一下", "教我")
# 多任务：一句话里出现 ≥2 个"待办片段"
_TODO_HINTS = ("要交", "要写", "要做", "要去", "要准备", "要复习", "还要", "还得", "需要写", "需要做", "截止",
               "ddl", "作业", "论文", "ppt", "复习", "文章", "报告", "作品")
_TODO_SPLIT = re.compile(r"[，,；;。、！!？?\n]|然后|以及|另外|还有")

# 「接着刚才没说完的往下说」：用户暂停后点「继续」，客户端会带 resume 字段走专门的续写链路，
# 不经过这里。这里只兜住孩子自己手打的一句纯续写指令——必须整句就是指令本身，
# 「我想接着说说下周的比赛」这种带了新内容的话照常分类，不能被短路成闲聊。
_CONTINUE_RE = re.compile(
    r"^(?:请|你)?(?:接着|继续)(?:上面|刚才)?的?(?:继续|接着)?(?:说|讲)?(?:完|下去)?"
    r"(?:吧|呀|啊|嘛|呗)?[。.!！~～]*$"
    r"|^(?:往下说|然后呢|后面呢|还有呢|把刚才的说完)(?:吧|呀|啊)?[。.!！?？~～]*$")


def looks_like_continuation(message: str) -> bool:
    """整句就是「接着说 / 继续 / 往下说」这类续写指令（不含任何新内容）。"""
    text = re.sub(r"\s+", "", message or "")
    return bool(text) and len(text) <= 12 and bool(_CONTINUE_RE.match(text))


def looks_like_todos(message: str) -> bool:
    """确定性兜底：拆成片段后，含待办词的片段 ≥2 个就视为多任务。LLM 漏判时用它纠偏。"""
    parts = [p for p in _TODO_SPLIT.split(message.lower()) if p.strip()]
    return sum(1 for p in parts if any(h in p for h in _TODO_HINTS)) >= 2


def _fallback(message: str) -> dict:
    if any(h in message for h in _RELAY_HINTS):
        intent = "relay"
    elif looks_like_todos(message):
        intent = "todo"
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
    if looks_like_continuation(message):
        # 续写指令不需要分类：直接闲聊直答，省一次 LLM 调用，也不会误建事务
        return {"intent": "chat", "mood": "normal", "affair_id": None, "reason": "续写指令"}
    try:
        data = await asyncio.wait_for(llm.complete_json(
            [{"role": "user", "content": prompts.ROUTER.format(
                message=message,
                affairs_brief=affairs_brief or "（目前没有正在跟进的事）",
            )}],
            max_tokens=500,
            caller="router",
        ), ROUTER_BUDGET_S)
        intent = str(data.get("intent", "")).lower()
        mood = str(data.get("mood", "normal")).lower()
        if intent in ("chat", "new_affair") and looks_like_todos(message):
            intent = "todo"  # 一句话好几件待办却被判成闲聊/单事务：纠偏成拆解
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
