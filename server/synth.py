"""合成器：节点结果 → 结构化卡片 JSON；含"单 LLM 直出卡片"与"纯本地摊结果"两条保底路径。"""
from __future__ import annotations

import asyncio
import re

from . import llm, prompts, tools
from .memory import MemoryStore


def _normalize_card(data: dict) -> dict:
    sections = []
    for s in data.get("sections") or []:
        if not isinstance(s, dict):
            continue
        items = [str(i) for i in s.get("items") or [] if str(i).strip()]
        if items:
            sections.append({"heading": str(s.get("heading") or ""), "items": items[:6]})
    if not sections:
        raise ValueError("卡片没有有效板块")
    return {
        "title": str(data.get("title") or "给你的方案"),
        "emoji": str(data.get("emoji") or "🐼")[:4],
        "sections": sections[:8],
        "closing": str(data.get("closing") or ""),
    }


async def synthesize(store: MemoryStore, event: str, results: dict[str, str],
                     attach_ctx: str = "", extra_rule: str = "") -> dict:
    """正常路径：汇总节点结果出卡片。

    attach_ctx 是本轮附件摘要（文件名 + 抽取正文）：卡片只吃文本，
    孩子用图片/文档补需求时（"按这张课程表安排"），不带上卡片就会漏掉关键信息。
    extra_rule 是调用方按本轮意图追加的卡片规则（如写作类"只放素材提纲"）。
    """
    results_text = "\n\n".join(f"【{nid}】{text}" for nid, text in results.items())
    name, mem = await asyncio.to_thread(lambda: (store.child_name, store.active_block(event)))
    data = await llm.complete_json(
        [
            {"role": "system", "content": "你是方案整理模块，只输出 JSON。"},
            {"role": "user", "content": prompts.SYNTH.format(
                name=name,
                event=event + attach_ctx,
                now=tools.now_text(),
                memory_block=mem or "（暂无记忆）",
                results=results_text,
                action_rules=prompts.CARD_ACTION_RULES + extra_rule,
            )},
        ],
        max_tokens=1800,  # 卡片 4-6 板块 × 2-4 条，1800 有 3 倍余量。
                         # 调小 max_tokens 同样不省时间（瓶颈是推理不是输出长度）
        caller="synth",
    )
    return _normalize_card(data)


async def direct_card(store: MemoryStore, event: str, attach_ctx: str = "",
                      extra_rule: str = "") -> dict:
    """保底路径：跳过 DAG，单次调用直出卡片（仍是真实 LLM 生成）。"""
    name, mem = await asyncio.to_thread(lambda: (store.child_name, store.active_block(event)))
    data = await llm.complete_json(
        [
            {"role": "system", "content": "你是方案整理模块，只输出 JSON。"},
            {"role": "user", "content": prompts.CARD_DIRECT.format(
                name=name,
                event=event + attach_ctx,
                now=tools.now_text(),
                memory_block=mem or "（暂无记忆）",
                action_rules=prompts.CARD_ACTION_RULES + extra_rule,
            )},
        ],
        max_tokens=3000,
        caller="synth_fallback",
    )
    return _normalize_card(data)


def assemble_from_results(title: str, pairs: list[tuple[str, str]]) -> dict:
    """纯本地的最后一档：把各环节查到的结论原样摊成一张卡片。

    两次 LLM 调用都没按时返回时用这一档（见 main._card_with_fallback）。
    **不编任何新内容**——每一条都来自上游节点的真实执行结果，这里只做
    "去掉换行、拼成一句话"的排版；结尾也如实说明这是"来不及重新整理"的版本，
    不假装是管家综合过的方案（降级不降真）。
    """
    sections: list[dict] = []
    for head, text in pairs or []:
        clean = "；".join(ln.strip() for ln in str(text or "").splitlines() if ln.strip())
        clean = re.sub(r"\s*\n\s*", " ", clean).strip()
        if clean:
            sections.append({"heading": str(head or "查到的情况"), "items": [clean]})
    if not sections:
        sections = [{"heading": "还在查", "items": ["管家这边刚没接上，查到东西马上告诉你。"]}]
    return {
        "title": str(title or "先给你查到的东西"),
        "emoji": "🧭",
        "sections": sections[:8],
        "closing": "（管家刚才来不及重新整理，先把查到的原样给你看。）",
    }


def card_to_text(card: dict) -> str:
    """卡片转 markdown 文本，供记忆沉淀和历史回放使用。

    历史回放走前端 markdown 渲染：用小标题 + 列表排版，重开页面时仍像一张卡片，
    不再是"。；"连成一整段的长文（tts.to_speech_text 会洗掉这些 markdown 记号）。
    """
    parts = [f"**{card['title']}**"]
    for s in card["sections"]:
        items = [str(i).strip() for i in s.get("items") or [] if str(i).strip()]
        parts.append(f"\n**{s['heading']}**")
        parts.extend(f"- {i}" for i in items)
    if card.get("closing"):
        parts.append(f"\n{card['closing']}")
    return "\n".join(parts)
