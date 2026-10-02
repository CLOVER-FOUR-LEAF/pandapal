"""快捷话题（chips）动态生成：按孩子此刻的真实处境出提示，不再全员一套死文案。

两个入口，都是确定性规则（不额外调 LLM，零延迟、零成本、可复现）：
  opening(...)    打开页面时：临近截止 > 正在办的事 > 反复提起的兴趣/目标 > 健康 > 时段兜底
  followups(...)  每轮对话后：顺着这一轮走的链路（拆解/规划/讲解/闲聊）给下一步

每条 chip 是 {"text": 发出去的话, "kind": 来源}，kind 供前端做轻量区分、也便于调试。
悄悄话（private）节点绝不进 chips——chips 是会被别人瞟到的界面元素。
"""
from __future__ import annotations

from datetime import datetime

from .affairs import AffairStore
from .graph import GraphStore

MAX_CHIPS = 6


def _chip(text: str, kind: str) -> dict:
    return {"text": text, "kind": kind}


def _short(title: str, n: int = 10) -> str:
    title = str(title or "").strip()
    return title if len(title) <= n else title[:n] + "…"


def _dedupe(chips: list[dict], limit: int = MAX_CHIPS) -> list[dict]:
    seen, out = set(), []
    for c in chips:
        t = c["text"].strip()
        if t and t not in seen:
            seen.add(t)
            out.append(c)
        if len(out) >= limit:
            break
    return out


def _time_chips(now: datetime) -> list[dict]:
    h = now.hour
    if h < 9:
        return [_chip("帮我排一下今天要做的事", "time")]
    if h < 14:
        return [_chip("下午我该先做哪件事？", "time")]
    if h < 20:
        return [_chip("今晚的时间怎么安排比较好？", "time")]
    return [_chip("我还有事没做完，要不要熬夜？", "time")]


def _due_chips(due: list[dict]) -> list[dict]:
    out = []
    for d in due:
        title, days = _short(d["title"]), int(d.get("days") or 0)
        if d.get("kind") == "health":
            out.append(_chip(f"{title}：我今天感觉好点了", "due"))
        elif days < 0:
            out.append(_chip(f"「{title}」已经过期了，怎么补救？", "due"))
        elif days <= 1:
            out.append(_chip(f"「{title}」{'今天' if days == 0 else '明天'}就截止，先做哪步？", "due"))
        elif d.get("owner_next") == "parent":
            out.append(_chip(f"{title}还在等家长确认吗？", "due"))
        else:
            out.append(_chip(f"离「{title}」还有 {days} 天，进度怎么样了？", "due"))
    return out


_KIND_ASK = {
    "travel": "出发前还要准备什么？",
    "event": "还差哪一步？",
    "study": "下一步先做什么？",
    "goal": "最近有进展吗？",
    "health": "我今天感觉好点了",
    "interest": "我想再聊聊这个",
}


def _affair_chips(affairs: list[dict], skip: set[str]) -> list[dict]:
    out = []
    items = sorted(affairs, key=lambda x: str(x.get("updated") or ""), reverse=True)
    for it in items:
        if it.get("id") in skip:
            continue
        title = _short(it.get("title"))
        if it.get("kind") == "health":
            out.append(_chip(f"{title}：{_KIND_ASK['health']}", "affair"))
        elif it.get("stage") == "discovered":
            out.append(_chip(f"{title}，你觉得我该怎么选？", "affair"))
        else:
            out.append(_chip(f"{title}{_KIND_ASK.get(str(it.get('kind')), '还差哪一步？')}", "affair"))
    return out


def _graph_chips(all_nodes: list[dict], linked: set[str]) -> list[dict]:
    """反复提起、但还没挂到事务上的兴趣/目标 → 邀请聊或接成计划。"""
    nodes = [n for n in all_nodes if not n.get("private") and n.get("status") == "active"]
    nodes.sort(key=lambda n: -int(n.get("weight") or 1))
    out = []
    for n in nodes:
        if n["id"] in linked or n.get("type") not in ("interest", "goal"):
            continue
        label = _short(n.get("label"), 8)
        if n.get("type") == "goal":
            out.append(_chip(f"帮我把「{label}」做成计划", "graph"))
        else:
            out.append(_chip(f"我最近又在想{label}的事", "graph"))
        if len(out) >= 2:
            break
    return out


def opening(a: AffairStore, g: GraphStore, history_len: int = 0, now: datetime | None = None) -> list[dict]:
    """开场 chips：先说最要紧的，再说正在办的，再顺着兴趣，最后按时段兜底。"""
    now = now or datetime.now()
    items = a.list()                      # affairs.json 只读一次，下面各步共用
    due_items = a.due_soon(days=14, items=items)
    due_ids = {d["id"] for d in due_items}
    linked = {nid for it in items for nid in it.get("linked_nodes") or []}
    chips = (_due_chips(due_items)[:2] + _affair_chips(items, due_ids)[:2]
             + _graph_chips(g.load()["nodes"], linked))
    if not items and not history_len:
        # 全新档案：先认识，再帮忙
        chips += [_chip("我先介绍一下我自己", "intro"), _chip("我最近在忙好几件事", "intro"),
                  _chip("你能帮我做什么？", "intro")]
    chips += _time_chips(now)
    chips.append(_chip("跟你说说我今天的心情", "mood"))
    return _dedupe(chips)


def followups(intent: str, a: AffairStore, g: GraphStore) -> list[dict]:
    """每轮之后的下一步：沿着这轮实际发生的事给 3-4 条，后面再补开场里最要紧的。"""
    chips: list[dict] = []
    if intent == "todo":
        mine = [x for x in a.list() if x.get("source") == "triage"]
        urgent = sorted(mine, key=lambda x: (not x.get("due"), str(x.get("due") or ""), str(x.get("created") or "")))
        if urgent:
            first = _short(urgent[0]["title"], 14)
            chips.append(_chip(f"「{first}」现在就开始，第一步怎么做？", "next"))
        chips += [_chip("我今晚只有两小时，怎么排？", "next"),
                  _chip("其中一件能不能往后推？", "next"),
                  _chip("做完一件了，帮我划掉", "next")]
    elif intent == "new_affair":
        chips += [_chip("方案里哪一步最要紧？", "next"), _chip("帮我把这件事告诉家长", "next"),
                  _chip("我有点紧张，怎么办", "next")]
    elif intent == "explain":
        chips += [_chip("再举一个例子吧", "next"), _chip("出一道小题考考我", "next"),
                  _chip("这个和我学的东西有什么关系？", "next")]
    elif intent == "affair_update":
        chips += [_chip("那接下来该做什么？", "next"), _chip("帮我看看还有什么没做", "next")]
    elif intent == "relay":
        chips += [_chip("语气再软一点", "next"), _chip("帮我加一句谢谢老师", "next")]
    else:
        chips += [_chip("帮我把刚才说的记下来", "next")]
    chips += opening(a, g)
    return _dedupe(chips, limit=5)
