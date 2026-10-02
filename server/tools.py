"""规划链路可用工具：本地赛事库、wttr.in 天气、可选联网搜索。"""
from __future__ import annotations

import json

import httpx

from . import config

RACE_DB = config.DATA_DIR / "race_db.json"


def race_lookup(query: str) -> str:
    """在本地赛事知识库里做模糊匹配，返回格式化文本。"""
    try:
        events = json.loads(RACE_DB.read_text(encoding="utf-8")).get("events", [])
    except (OSError, json.JSONDecodeError):
        return "赛事库暂不可用"
    q = query.lower()
    hits = [
        e for e in events
        if q in e.get("name", "").lower()
        or any(q in a.lower() or a.lower() in q for a in e.get("aliases", []))
        or any(w in e.get("name", "") for w in q.split() if w)
    ]
    if not hits:
        # 兜底：查询词里的任意连续 2+ 中文字符片段与别名互相包含
        hits = [
            e for e in events
            if any(a in query or query in a for a in e.get("aliases", []) + [e.get("name", "")] if len(a) >= 2)
        ]
    if not hits:
        known = "、".join(e.get("name", "") for e in events)
        return f"赛事库未查到「{query}」。已收录：{known}"
    lines = []
    for e in hits[:2]:
        lines.append(
            f"赛事：{e['name']}｜时间：{e['date']}"
            f"｜城市：{e['city']}｜会场：{e.get('venue', '待定')}\n"
            f"签到：{e.get('checkin', '待定')}｜赛道：{'、'.join(e.get('tracks', []))}\n"
            f"要求：{e.get('requirements', '无')}｜贴士：{e.get('tips', '无')}"
        )
    return "\n\n".join(lines)


async def weather(city: str) -> str:
    """wttr.in 免费天气服务，无需 Key。"""
    url = f"https://wttr.in/{city}?format=j1&lang=zh"
    async with httpx.AsyncClient(timeout=config.TOOL_TIMEOUT) as client:
        resp = await client.get(url, headers={"User-Agent": "curl/8"})
        resp.raise_for_status()
        data = resp.json()
    out = []
    for day in data.get("weather", [])[:3]:
        date = day.get("date", "")
        desc = ""
        hourly = day.get("hourly") or []
        if hourly:
            desc = hourly[min(4, len(hourly) - 1)].get("lang_zh", [{}])
            desc = desc[0].get("value", "") if isinstance(desc, list) and desc else ""
        out.append(
            f"{date}：{desc or '—'}，{day.get('mintempC', '?')}~{day.get('maxtempC', '?')}°C"
        )
    if not out:
        return f"{city} 天气查询无结果"
    return f"{city} 天气：\n" + "\n".join(out)


async def web_search(query: str) -> str | None:
    """可选联网搜索（Tavily 兼容 POST）。未配置 Key 时返回 None，由调用方降级。"""
    if not config.SEARCH_API_KEY or not config.SEARCH_BASE_URL:
        return None
    async with httpx.AsyncClient(timeout=config.TOOL_TIMEOUT) as client:
        resp = await client.post(
            f"{config.SEARCH_BASE_URL}/search",
            json={"api_key": config.SEARCH_API_KEY, "query": query, "max_results": 3},
        )
        resp.raise_for_status()
        data = resp.json()
    results = data.get("results") or []
    if not results:
        return f"搜索「{query}」没有结果"
    return "\n".join(
        f"- {r.get('title', '')}：{r.get('content', '')[:150]}" for r in results[:3]
    )
