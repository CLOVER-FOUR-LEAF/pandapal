"""合成器：节点结果 → 结构化卡片 JSON；含"单 LLM 直出卡片"保底路径。"""
from __future__ import annotations

from datetime import date

from . import llm, prompts
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


async def synthesize(store: MemoryStore, event: str, results: dict[str, str]) -> dict:
    """正常路径：汇总节点结果出卡片。"""
    results_text = "\n\n".join(f"【{nid}】{text}" for nid, text in results.items())
    data = await llm.complete_json(
        [
            {"role": "system", "content": "你是方案整理模块，只输出 JSON。"},
            {"role": "user", "content": prompts.SYNTH.format(
                name=store.child_name,
                event=event,
                memory_block=store.active_block() or "（暂无记忆）",
                results=results_text,
            )},
        ],
        max_tokens=3000,
        caller="synth",
    )
    return _normalize_card(data)


async def direct_card(store: MemoryStore, event: str) -> dict:
    """保底路径：跳过 DAG，单次调用直出卡片（仍是真实 LLM 生成）。"""
    data = await llm.complete_json(
        [
            {"role": "system", "content": "你是方案整理模块，只输出 JSON。"},
            {"role": "user", "content": prompts.CARD_DIRECT.format(
                name=store.child_name,
                event=event,
                today=date.today().isoformat(),
                memory_block=store.active_block() or "（暂无记忆）",
            )},
        ],
        max_tokens=3000,
        caller="synth_fallback",
    )
    return _normalize_card(data)


def card_to_text(card: dict) -> str:
    """卡片转纯文本，供记忆沉淀和历史使用。"""
    parts = [card["title"]]
    for s in card["sections"]:
        parts.append(f"{s['heading']}：" + "；".join(s["items"]))
    if card.get("closing"):
        parts.append(card["closing"])
    return "\n".join(parts)
