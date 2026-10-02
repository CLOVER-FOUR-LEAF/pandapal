"""规划链路可用工具：本地赛事库、本地交通参考库、wttr.in 天气、可选联网搜索。"""
from __future__ import annotations

import json
import re

import httpx

from . import config

RACE_DB = config.DATA_DIR / "race_db.json"
TRANSPORT_DB = config.DATA_DIR / "transport_db.json"
_TYPE_CN = {"train": "高铁/火车", "flight": "飞机", "bus": "大巴", "car": "自驾", "ship": "船"}


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


def _norm_city(text: str) -> str:
    """城市名归一化：去掉"市/省/站/机场"等后缀，便于"威海"匹配"威海市"。"""
    return re.sub(r"(市|省|县|区|站|机场|火车站|高铁站)$", "", str(text or "").strip())


def _route_hit(route: dict, f: str, t: str) -> bool:
    """双向模糊匹配：任一方向能对上就算这条线路。"""
    a, b = _norm_city(route.get("from", "")), _norm_city(route.get("to", ""))
    if not f or not t or not a or not b:
        return False
    return (f in a or a in f) and (t in b or b in t)


def _format_route(route: dict, note: str) -> str:
    """把一条线路格式化成好读的文本，末尾必须带数据库里的免责声明。"""
    lines = [f"{route.get('from', '')} → {route.get('to', '')}（参考方案 {len(route.get('options') or [])} 个）"]
    for i, o in enumerate(route.get("options") or [], 1):
        type_cn = _TYPE_CN.get(str(o.get("type", "")), str(o.get("type") or "交通"))
        code = str(o.get("code") or "").strip()
        dep, arr = str(o.get("depart") or ""), str(o.get("arrive") or "")
        when = f"{dep}-{arr}" if dep and arr else (dep or "时间待定")
        lines.append(
            f"{i}. {type_cn} {code}｜{when}｜{o.get('duration', '—')}｜{o.get('price', '—')}".strip()
        )
        if o.get("tip"):
            lines.append(f"   贴士：{o['tip']}")
    if note:
        lines.append(f"※ {note}")
    return "\n".join(lines)


def transport_lookup(from_city: str, to_city: str) -> str:
    """查本地交通参考库，返回格式化文本；查不到时回"参考库未收录"+已收录城市。

    先按出发→目的正向匹配；查不到再试反向线路（同一走廊的方案反过来读仍有参考价值，
    输出里会标明是反向参考）。
    """
    f, t = _norm_city(from_city), _norm_city(to_city)
    if not f or not t:
        return "请告诉我出发城市和目的城市，例如：威海 → 西安"
    try:
        db = json.loads(TRANSPORT_DB.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "交通参考库暂不可用"
    note = str(db.get("note", "") or "")
    routes = [r for r in db.get("routes", []) if isinstance(r, dict)]
    hits = [r for r in routes if _route_hit(r, f, t)]
    reverse = False
    if not hits:
        hits = [r for r in routes if _route_hit(r, t, f)]
        reverse = bool(hits)
    if not hits:
        cities = sorted(
            {c for r in routes for c in (_norm_city(r.get("from", "")), _norm_city(r.get("to", ""))) if c}
        )
        known = "、".join(cities) if cities else "（空）"
        return f"参考库未收录：{from_city}→{to_city}。已收录：{known}"
    if reverse:
        return "\n\n".join(
            "（查到的是反向线路，出行时请反序参考）\n" + _format_route(r, note)
            for r in hits[:2]
        )
    return "\n\n".join(_format_route(r, note) for r in hits[:2])
