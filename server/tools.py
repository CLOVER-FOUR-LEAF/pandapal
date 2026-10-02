"""工具脚手架：一张声明式注册表，规划链路和闲聊通道共用。

加新工具只要一个装饰器：

    @tool("name", label="前端显示名", desc="给规划器看的一句话",
          args='{"city": "城市名"}')
    async def fn(args: dict, ctx: ToolCtx) -> str | None:
        ...

约定：
- 返回 str  = 工具结果文本（直接进模型上下文 / 节点结果）
- 返回 None = 工具不可用（调用方自行降级：executor 会转模型知识补位）
- 抛异常    = 本次调用失败（executor 把节点标 error；闲聊通道如实告诉孩子）
- chat=False 的工具只给 DAG 规划用，闲聊直答通道不挑它

注册之后自动获得：planner 的可用工具校验、planner/选工具提示词里的文档行、
executor 的派发、闲聊通道的候选清单——不用再改第三处。
"""
from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import quote, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import config
from .llm import shared_client

RACE_DB = config.DATA_DIR / "race_db.json"
TRANSPORT_DB = config.DATA_DIR / "transport_db.json"
_TYPE_CN = {"train": "高铁/火车", "flight": "飞机", "bus": "大巴", "car": "自驾", "ship": "船"}

_CN_WEEKDAY = "一二三四五六日"
_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                     "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
# 单次联网工具的最大响应体量：网页正文解析前先截断，防止巨型页面撑爆内存/上下文
_MAX_HTML_BYTES = 800_000
_BROWSE_CHARS = 2400   # web_browse 回给模型的正文字符数
_SEARCH_HITS = 5       # web_search 回给模型的结果条数


# ------------------------------------------------------------------ 注册表

@dataclass
class ToolCtx:
    """工具执行上下文：store 供需要读孩子档案的工具用，event 是用户原话。"""
    store: object | None = None
    event: str = ""
    results: dict = field(default_factory=dict)


@dataclass
class Tool:
    name: str
    label: str          # 前端工具条上的中文显示名
    desc: str           # 给规划器/调度器看的一句话
    args_doc: str       # args 示例文本（进提示词）
    run: Callable[[dict, ToolCtx], Awaitable[str | None]]
    chat: bool = True   # 闲聊直答通道是否可调用


TOOLS: dict[str, Tool] = {}


def tool(name: str, *, label: str, desc: str, args: str = "{}", chat: bool = True):
    """注册一个工具。fn 必须是 async (args, ctx) -> str | None。"""
    def deco(fn):
        TOOLS[name] = Tool(name=name, label=label, desc=desc,
                           args_doc=args, run=fn, chat=chat)
        return fn
    return deco


def names() -> set[str]:
    return set(TOOLS)


def get(name: str) -> Tool | None:
    return TOOLS.get(name)


async def dispatch(name: str, args: dict, ctx: ToolCtx) -> str | None:
    """按名执行；未知工具抛 KeyError（planner 校验在前，走到这属防御）。"""
    t = TOOLS.get(name)
    if t is None:
        raise KeyError(f"未注册工具：{name}")
    return await t.run(args if isinstance(args, dict) else {}, ctx)


def planner_docs() -> str:
    """写进 PLANNER 提示词的「可用工具」列表。"""
    lines = [
        f"- {t.name}：{t.desc}。args 示例：{t.args_doc}"
        for t in TOOLS.values()
    ]
    lines.append('- llm：不需要外部数据、靠思考完成的环节（行程建议、清单整理、心理鼓励等）。'
                 'args：{"task": "要完成的事"}')
    return "\n".join(lines)


def chat_docs() -> str:
    """写进闲聊选工具提示词的候选清单（只列 chat=True 的）。"""
    return "\n".join(
        f"- {t.name}：{t.desc}。args 示例：{t.args_doc}"
        for t in TOOLS.values() if t.chat
    )


def describe(name: str, args: dict) -> str:
    """前端工具条文案：「联网搜索「西客松」」这种。"""
    t = TOOLS.get(name)
    label = t.label if t else name
    args = args if isinstance(args, dict) else {}
    hint = str(args.get("query") or args.get("city") or args.get("url")
               or args.get("tz") or "").strip()
    if name == "transport_lookup":
        hint = f"{args.get('from_city', '')}→{args.get('to_city', '')}".strip("→")
    return f"{label}「{hint[:24]}」" if hint else label


# 闲聊通道的启发式门槛：不像在要实时资料的消息不触发选工具调用（省一次 LLM RTT）
_HINT = re.compile(
    r"https?://|www\.|"
    r"搜一下|搜一搜|帮我搜|百度|谷歌|bing|查一下|帮我查|网上|搜搜|"
    r"最新|新闻|热搜|官网|报名.{0,4}(时间|截止)|什么时候.{0,6}(开始|截止|报名)|"
    r"几点|现在.{0,4}(时间|几点)|什么时间|今天.{0,4}(几号|星期|日期)|星期几|明天.{0,4}几号|"
    r"天气|温度|下[雨雪]|刮风|台风|穿什么|带伞|气温"
)


def might_need(message: str) -> bool:
    """消息疑似需要联网/实时数据 → True，让调度器再判断用哪个工具。"""
    return bool(_HINT.search(str(message or "")))


def now_text() -> str:
    """提示词里统一用的时间串：「2026-10-03 22:31 星期五」。"""
    now = datetime.now()
    return now.strftime("%Y-%m-%d %H:%M 星期") + _CN_WEEKDAY[now.weekday()]


# ------------------------------------------------------------------ 工具实现

@tool("now", label="看时间", chat=True,
      desc="查当前日期和时间（精确到分钟、星期几），可指定时区",
      args='{"tz": "可选，IANA 时区名如 Asia/Shanghai，或 +8"}')
async def _now(args: dict, ctx: ToolCtx) -> str:
    tzname = str(args.get("tz") or "").strip()
    tz = None
    if tzname:
        tz = _parse_tz(tzname)
        if tz is None:
            return f"时区「{tzname}」不认得——可以写 Asia/Shanghai 或 +8 这种"
    now = datetime.now(tz)
    wd = _CN_WEEKDAY[now.weekday()]
    where = tzname if tzname else "本地"
    return (f"现在是 {now:%Y-%m-%d %H:%M}，星期{wd}（{where}时间）"
            + (f"，时区偏移 {now.strftime('%z')}" if tzname else ""))


def _parse_tz(text: str):
    """IANA 名优先；否则认 +8 / UTC+8 / GMT-5 / +08:30 这类偏移写法。"""
    try:
        return ZoneInfo(text)
    except (ZoneInfoNotFoundError, ValueError):
        pass
    m = re.fullmatch(r"(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?", text, re.I)
    if not m:
        return None
    sign = 1 if m.group(1) == "+" else -1
    try:
        return timezone(sign * timedelta(hours=int(m.group(2)),
                                       minutes=int(m.group(3) or 0)))
    except ValueError:
        return None


@tool("weather", label="查天气",
      desc="查城市天气（今明后三天，wttr.in 免费服务无需 Key）",
      args='{"city": "城市名"}')
async def _weather(args: dict, ctx: ToolCtx) -> str:
    city = str(args.get("city") or "").strip() or "本地"
    url = f"https://wttr.in/{quote(city[:40], safe='')}?format=j1&lang=zh"
    resp = await shared_client().get(
        url, headers={"User-Agent": "curl/8"}, timeout=config.TOOL_TIMEOUT)
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


@tool("race_lookup", label="查赛事库",
      desc="查赛事/活动知识库（名称、日期、城市、会场、要求）",
      args='{"query": "赛事关键词"}')
async def _race(args: dict, ctx: ToolCtx) -> str:
    return await asyncio.to_thread(
        race_lookup, str(args.get("query") or ctx.event or ""))


@tool("transport_lookup", label="查交通",
      desc="查城际交通参考方案（本地参考库，含反向线路兜底）",
      args='{"from_city": "出发城市", "to_city": "目的城市"}')
async def _transport(args: dict, ctx: ToolCtx) -> str:
    return await asyncio.to_thread(
        transport_lookup,
        str(args.get("from_city") or ""),
        str(args.get("to_city") or ""),
    )


@tool("web_search", label="联网搜索",
      desc="联网搜索最新信息（新闻、报名时间、官网通知、百科词条）",
      args='{"query": "搜索词"}')
async def _web_search(args: dict, ctx: ToolCtx) -> str | None:
    query = str(args.get("query") or ctx.event or "").strip()[:120]
    if not query:
        return "想搜什么呀？告诉我关键词"
    hits = await _search_tavily(query)
    if hits is None:
        hits = await _search_bing(query)
    if not hits:
        return f"搜索「{query}」没有结果"
    lines = [f"搜索「{query}」的结果："]
    for i, h in enumerate(hits, 1):
        line = f"{i}. {h['title']}"
        if h.get("snippet"):
            line += f"——{h['snippet']}"
        if h.get("url"):
            line += f"（{h['url']}）"
        lines.append(line)
    return "\n".join(lines)


async def _search_tavily(query: str) -> list[dict] | None:
    """配了 SEARCH_API_KEY + SEARCH_BASE_URL 时走 Tavily 兼容端点；返回 None 表示没配。"""
    if not config.SEARCH_API_KEY or not config.SEARCH_BASE_URL:
        return None
    resp = await shared_client().post(
        f"{config.SEARCH_BASE_URL}/search",
        json={"api_key": config.SEARCH_API_KEY, "query": query, "max_results": _SEARCH_HITS},
        timeout=config.TOOL_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    return [
        {"title": str(r.get("title") or ""), "url": str(r.get("url") or ""),
         "snippet": str(r.get("content") or "")[:150]}
        for r in (data.get("results") or [])[:_SEARCH_HITS]
        if r.get("title")
    ]


async def _search_bing(query: str) -> list[dict]:
    """零配置兜底：必应 RSS 优先，HTML 解析兜底（DuckDuckGo 在国内网络常超时，不用它）。

    bing 网页版 HTML 结构说改就改（2026-10 起 cn.bing.com 会跳到无结果标记的
    JS 壳页）；`&format=rss` 是稳定的 XML 输出，优先走它。
    """
    try:
        url = f"https://www.bing.com/search?q={quote(query)}&format=rss"
        resp = await shared_client().get(url, headers=_UA, timeout=config.TOOL_TIMEOUT,
                                         follow_redirects=True)
        resp.raise_for_status()
        hits = _parse_bing_rss(resp.text)
        if hits:
            return hits
    except Exception:  # noqa: BLE001 RSS 挂了再试网页版，不行就空结果
        pass
    url = f"https://cn.bing.com/search?q={quote(query)}&setlang=zh-Hans"
    resp = await shared_client().get(url, headers=_UA, timeout=config.TOOL_TIMEOUT,
                                     follow_redirects=True)
    resp.raise_for_status()
    return _parse_bing(resp.text[:_MAX_HTML_BYTES])


def _parse_bing_rss(xml_text: str) -> list[dict]:
    """从必应 RSS（format=rss）抓 <item>；XML 解析失败安静返回空列表。"""
    try:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(xml_text)
    except ET.ParseError:  # noqa: BLE001 解析失败当没结果
        return []
    hits = []
    for item in root.findall(".//item"):
        title = _plain_text(item.findtext("title") or "")
        url = str(item.findtext("link") or "").strip()
        snippet = _plain_text(item.findtext("description") or "")
        if url.startswith("http") and title:
            hits.append({"title": title, "url": url, "snippet": snippet[:150]})
    return hits[:_SEARCH_HITS]


def _parse_bing(html: str) -> list[dict]:
    """从必应结果页抓 <li class="b_algo"> 条目；页面改版时安静返回空列表。"""
    hits = []
    for chunk in re.findall(r'<li class="b_algo"[^>]*>.*?</li>', html, re.S):
        m = re.search(r'<h2[^>]*>.*?<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', chunk, re.S)
        if not m:
            continue
        url, title = m.group(1), _plain_text(m.group(2))
        p = re.search(r'<p[^>]*>(.*?)</p>', chunk, re.S)
        snippet = _plain_text(p.group(1)) if p else ""
        if url.startswith("http") and title:
            hits.append({"title": title, "url": url, "snippet": snippet[:150]})
    return hits[:_SEARCH_HITS]


@tool("web_browse", label="打开网页",
      desc="打开一个网址，读取网页标题和正文内容（消息里带链接时用）",
      args='{"url": "https://..."}')
async def _web_browse(args: dict, ctx: ToolCtx) -> str:
    url = str(args.get("url") or "").strip()
    if url and not url.startswith(("http://", "https://")):
        url = "https://" + url.lstrip("/")
    host = urlparse(url).hostname or ""
    if not url.startswith(("http://", "https://")) or not host:
        return f"「{url}」不是能打开的网址"
    if _blocked_host(host):
        return "这个地址指向内网/本机，我不能打开"
    resp = await shared_client().get(url, headers=_UA, timeout=config.TOOL_TIMEOUT,
                                     follow_redirects=True)
    resp.raise_for_status()
    ctype = resp.headers.get("content-type", "")
    if "html" not in ctype and "text" not in ctype:
        return f"打开的是 {ctype.split(';')[0] or '非网页'} 内容，读不了正文"
    title, text = _html_to_text(resp.text[:_MAX_HTML_BYTES])
    if not text.strip():
        return f"打开了 {host}，但页面里没读到文字（可能是纯脚本页面）"
    head = f"网页「{title or host}」" + (f"（{url}）" if url else "")
    return head + " 的内容：\n" + text[:_BROWSE_CHARS]


def _blocked_host(host: str) -> bool:
    """轻量 SSRF 护栏：挡住本机/内网常见段，不做 DNS 反查（够用且零依赖）。"""
    h = host.lower().strip("[]")
    if h in ("localhost", "0.0.0.0", "::1"):
        return True
    return bool(re.match(
        r"^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)", h))


def _plain_text(html_frag: str) -> str:
    """去标签 + 实体反转 + 空白归一，用于解析搜索结果片段。"""
    text = re.sub(r"<[^>]+>", "", html_frag)
    text = (text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " "))
    return re.sub(r"\s+", " ", text).strip()


class _TextExtract(HTMLParser):
    """网页正文提取：跳过脚本样式，块级标签折行；拿 title 和流式文本。"""

    SKIP = {"script", "style", "noscript", "svg", "template", "iframe",
            "form", "select", "button", "nav", "aside"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "tr",
             "section", "article", "header", "footer", "blockquote", "td"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def _html_to_text(html: str) -> tuple[str, str]:
    """HTML → (标题, 正文文本)。解析失败返回 ("", "")，绝不抛给调用方。"""
    try:
        p = _TextExtract()
        p.feed(html)
        text = re.sub(r"[ \t]+", " ", "".join(p.parts))
        text = re.sub(r"\n\s*\n+", "\n", text).strip()
        return p.title.strip(), text
    except Exception:  # noqa: BLE001 HTML 千奇百怪，解析失败当空文本
        return "", ""


# ------------------------------------------------------------------ 本地库工具（同步实现，注册表用线程包装）

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
