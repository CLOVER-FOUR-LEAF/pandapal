"""成长图谱（graph.json）：视角导出、prompt 简报、bigram 检索、增量合并。

数据格式见契约 §2.1：节点 id 为 ascii slug（[a-z0-9_]）、label 中文唯一；
边只在两端节点都存在时落盘，关系词限定 为了/联想到/导致/一起/属于/来自。
private=true 的节点是悄悄话，parent 视角整体隐藏（含相连的边）。
所有写操作走 store.write_json（原子写 + 按目录写锁），文件缺失时优雅返回空结构。
"""
from __future__ import annotations

import copy
import hashlib
import re
import threading
import time
from datetime import date
from pathlib import Path

from . import store

DOMAINS = ("ethics", "intellect", "health", "aesthetics", "labor")
TYPES = ("interest", "event", "goal", "health", "person", "trait", "affair")
STATUSES = ("active", "dropped", "done")
RELS = ("为了", "联想到", "导致", "一起", "属于", "来自")

_DOMAIN_CN = {"ethics": "德", "intellect": "智", "health": "体", "aesthetics": "美", "labor": "劳"}
_STATUS_CN = {"active": "进行中", "dropped": "已放弃", "done": "已完成"}
_EMPTY = {"version": 1, "nodes": [], "edges": []}
_FACT_MAX = 72  # 注入 prompt 的单条事实截断长度

# 读缓存：mode="读多写少"，动画/并发打开页面时同一份 graph.json 会被反复 load。
# 以「文件 mtime_ns + TTL」为失效条件，merge 落盘后主动失效。缓存值按路径全局共享，
# 返回前深拷贝，调用方改不动缓存本体（merge 也照常能安全地读改写）。
_CACHE: dict[str, tuple[int | None, float, dict]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 5.0  # 秒；mtime 不变时也不长期持有陈旧视图（外部工具手改文件也能被感知）


def _cache_key(path: Path) -> str:
    try:
        return str(path.resolve())
    except OSError:  # 极端情况下 resolve 失败，退回绝对路径字符串
        return str(path.absolute())


def _cache_get(path: Path) -> dict | None:
    key = _cache_key(path)
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        mtime = None
    with _CACHE_LOCK:
        ent = _CACHE.get(key)
    if ent is None:
        return None
    if ent[0] != mtime:
        return None  # 文件被换过（含被外部写入）
    if mtime is not None and time.monotonic() - ent[1] >= _CACHE_TTL:
        return None  # TTL 过期，重读一次确认
    return ent[2]


def _cache_put(path: Path, data: dict) -> None:
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        mtime = None
    key = _cache_key(path)
    with _CACHE_LOCK:
        _CACHE[key] = (mtime, time.monotonic(), data)
        # 缓存表只随不同档案增长，档案数有限；超过阈值时清掉最旧的若干条防渗漏
        if len(_CACHE) > 256:
            for k in sorted(_CACHE, key=lambda x: _CACHE[x][1])[:128]:
                _CACHE.pop(k, None)


def invalidate_cache(path: Path) -> None:
    """写盘后主动失效，让下一个 load 一定拿到新数据（不依赖 mtime 分辨率）。"""
    with _CACHE_LOCK:
        _CACHE.pop(_cache_key(path), None)


_LABEL_PREFIX = re.compile(r"^\s*[德智体美劳]\s*[·・.:：]\s*")


def clean_label(text) -> str:
    """规整节点名：剥掉 brief 里的"智·"领域前缀（LLM 常照抄回来，导致"智·西客松大赛"这种重复节点）。"""
    label = " ".join(str(text or "").split())
    return _LABEL_PREFIX.sub("", label).strip()


def _clip(text: str, n: int = _FACT_MAX) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


class GraphStore:
    """一个孩子的成长图谱（对应 data/child_*/graph.json）。"""

    def __init__(self, child_dir: Path):
        self.dir = Path(child_dir)

    @property
    def path(self) -> Path:
        return self.dir / "graph.json"

    # ---------- 读 ----------

    def load(self) -> dict:
        """读图谱；缺文件 / 损坏 / 脏数据都归一化成合法结构，不抛错。

        命中进程内 mtime 缓存时直接返回深拷贝：同一请求里 brief_block/recall/export
        反复调用只解析一次文件。写操作（merge）落盘后主动 invalidate，读到的永远是
        最新图谱；返回深拷贝保证调用方改动不会污染缓存。
        """
        cached = _cache_get(self.path)
        if cached is not None:
            return copy.deepcopy(cached)
        raw = store.read_json(self.path, _EMPTY)
        if not isinstance(raw, dict):
            raw = {}
        nodes = [self._node(n) for n in raw.get("nodes") or [] if isinstance(n, dict) and n.get("id")]
        ids = {n["id"] for n in nodes}
        edges = []
        for e in raw.get("edges") or []:
            if not isinstance(e, dict):
                continue
            s, t = str(e.get("source") or ""), str(e.get("target") or "")
            if s in ids and t in ids:
                edges.append(self._edge(e, s, t))
        g = {"version": int(raw.get("version") or 1), "nodes": nodes, "edges": edges}
        _cache_put(self.path, g)
        return copy.deepcopy(g)

    def export(self, view: str = "child") -> dict:
        """给前端图谱页；仅 view="child" 返回完整图，其余一律按家长视角剔除 private 节点及相连边。"""
        g = self.load()
        nodes = [n for n in g["nodes"] if view == "child" or not n.get("private")]
        ids = {n["id"] for n in nodes}
        edges = [e for e in g["edges"] if e["source"] in ids and e["target"] in ids]
        return {"nodes": nodes, "edges": edges}

    def snapshot(self, until: str = "", view: str = "child") -> dict:
        """时间轴切片：只保留 first_seen <= until 的节点及其相连边。

        旧契约 §2.6 的 `/api/graph/snapshot?until=`：服务端切片，前端不再只靠本地
        过滤。until 为空 / 非法时退化为等价于 export() 的全量视图。
        """
        g = self.export(view=view)
        limit = str(until or "").strip()[:10]
        if not limit:
            return g
        nodes = [n for n in g["nodes"] if str(n.get("first_seen") or "")[:10] <= limit]
        ids = {n["id"] for n in nodes}
        edges = [e for e in g["edges"] if e["source"] in ids and e["target"] in ids]
        return {"nodes": nodes, "edges": edges, "until": limit}

    def brief_block(self, limit: int = 40) -> str:
        """供 prompt 注入的紧凑摘要（<=900 字）：节点一行一个 + 若干条关联。"""
        g = self.load()
        nodes = [n for n in g["nodes"] if not n.get("private")]
        hidden = len(g["nodes"]) - len(nodes)
        head = f"成长图谱：{len(g['nodes'])} 个节点 / {len(g['edges'])} 条关联"
        if hidden:
            head += f"（另有 {hidden} 个悄悄话节点，家长视角不可见）"
        nodes.sort(key=lambda n: (-int(n.get("weight") or 1), str(n.get("last_seen") or "")))
        lines = [head] + [self._brief_node(n) for n in nodes[:limit]]
        rels = self._brief_edges(g, {n["id"] for n in nodes})
        lines += ["关联：" + "；".join(rels[i : i + 3]) for i in range(0, len(rels), 3)]
        return store.fence_memory(self._cap(lines, 900))

    def recall(self, query: str, limit: int = 4) -> dict:
        """按 bigram 命中 label / facts / related 打分，再沿边扩一跳（权重减半）；不含 private。"""
        g = self.load()
        visible = [n for n in g["nodes"] if not n.get("private")]
        by_id = {n["id"]: n for n in visible}
        q_grams = store.bigrams(query)
        scores: dict[str, float] = {}
        for n in visible:
            score = self._score(n, query, q_grams)
            if score > 0:
                scores[n["id"]] = score
        direct = set(scores)
        for e in g["edges"]:  # 一跳扩散
            for a, b in ((e["source"], e["target"]), (e["target"], e["source"])):
                if a in direct and b in by_id:
                    scores[b] = max(scores.get(b, 0.0), scores[a] / 2)
        order = sorted(scores, key=lambda i: -scores[i])[: max(int(limit), 1)]
        picked = {i: by_id[i] for i in order}
        edges = [
            {"source": e["source"], "target": e["target"], "rel": e["rel"]}
            for e in g["edges"]
            if e["source"] in picked and e["target"] in picked
        ]
        nodes = [
            {
                "id": i,
                "label": picked[i].get("label", i),
                "domain": picked[i].get("domain", ""),
                "status": picked[i].get("status", "active"),
                "score": round(scores[i], 2),
            }
            for i in order
        ]
        return {"nodes": nodes, "edges": edges,
                "block": store.fence_memory(self._recall_block(nodes, picked))}

    # ---------- 写 ----------

    def merge(self, data: dict) -> dict:
        """合并 LLM 抽取结果：同 label 视为同一节点（追加事实、更新 last_seen/weight/status）。"""
        data = data if isinstance(data, dict) else {}
        with store.write_lock(self.dir):
            g = self.load()
            self._dedupe(g)
            result = {"added_nodes": [], "added_edges": [], "updated": []}
            by_label = {str(n.get("label")): n for n in g["nodes"] if n.get("label")}
            used = {n["id"] for n in g["nodes"]}
            for raw in data.get("nodes") or []:
                if isinstance(raw, dict):
                    self._merge_node(g, raw, by_label, used, result)
            for raw in data.get("edges") or []:
                if isinstance(raw, dict):
                    self._merge_edge(g, raw, by_label, result)
            store.write_json(self.path, g)
        invalidate_cache(self.path)
        return result

    # ---------- 内部 ----------

    def _dedupe(self, g: dict) -> None:
        """自愈：把"智·西客松大赛"这类带前缀的重复节点并回规范节点，边改指向后去重。"""
        canon: dict[str, dict] = {}
        remap: dict[str, str] = {}
        for n in sorted(g["nodes"], key=lambda x: clean_label(x.get("label")) != str(x.get("label"))):
            key = clean_label(n.get("label"))
            if not key:
                continue
            keep = canon.get(key)
            if keep is None:
                n["label"] = key
                canon[key] = n
                continue
            texts = {str(f.get("text")) for f in keep.get("facts") or []}
            keep["facts"] = (keep.get("facts") or []) + [
                f for f in n.get("facts") or [] if str(f.get("text")) not in texts]
            keep["weight"] = int(keep.get("weight") or 1) + int(n.get("weight") or 1)
            keep["last_seen"] = max(str(keep.get("last_seen") or ""), str(n.get("last_seen") or ""))
            keep["private"] = bool(keep.get("private")) or bool(n.get("private"))
            remap[n["id"]] = keep["id"]
        if not remap:
            return
        g["nodes"] = [n for n in g["nodes"] if n["id"] not in remap]
        seen, edges = set(), []
        for e in g["edges"]:
            e["source"] = remap.get(e["source"], e["source"])
            e["target"] = remap.get(e["target"], e["target"])
            k = (e["source"], e["target"], e["rel"])
            if e["source"] != e["target"] and k not in seen:
                seen.add(k)
                edges.append(e)
        g["edges"] = edges

    def _merge_node(self, g: dict, raw: dict, by_label: dict, used: set, result: dict) -> None:
        label = clean_label(raw.get("label"))
        if not label:
            return
        today = self._day(raw)
        facts = self._facts(raw, today)
        node = by_label.get(label)
        if node is None:
            nid = self._new_id(raw.get("id") or label, used)
            node = {
                "id": nid, "label": label,
                "domain": raw.get("domain") if raw.get("domain") in DOMAINS else "intellect",
                "type": raw.get("type") if raw.get("type") in TYPES else "interest",
                "status": raw.get("status") if raw.get("status") in STATUSES else "active",
                "first_seen": today, "last_seen": today, "weight": 1,
                "private": bool(raw.get("private")), "facts": facts,
            }
            g["nodes"].append(node)
            by_label[label] = node
            added = {"id": nid, "label": label, "domain": node["domain"]}
            if node["private"]:
                added["private"] = True  # 前端 3D/迷你图按此立即隐藏，等不到下次整图刷新
            result["added_nodes"].append(added)
            return
        # 同 label：追加事实 + 更新 last_seen/weight/status
        old_texts = {str(f.get("text")) for f in node.get("facts") or []}
        for f in facts:
            if f["text"] not in old_texts:
                node["facts"].append(f)
        node["last_seen"] = max(str(node.get("last_seen") or today), today)
        node["weight"] = int(node.get("weight") or 1) + 1
        if raw.get("status") in STATUSES:
            node["status"] = raw["status"]
        if raw.get("domain") in DOMAINS:
            node["domain"] = raw["domain"]
        if raw.get("private"):
            node["private"] = True
        upd = {"id": node["id"], "label": label}
        if node["private"]:
            upd["private"] = True  # 已有节点被标成悄悄话也要立刻通知前端隐藏
        result["updated"].append(upd)

    def _merge_edge(self, g: dict, raw: dict, by_label: dict, result: dict) -> None:
        s = self._resolve(raw.get("source"), by_label, g)
        t = self._resolve(raw.get("target"), by_label, g)
        rel = str(raw.get("rel") or "").strip() or "联想到"
        if not s or not t or s == t:
            return
        for e in g["edges"]:
            if e["source"] == s and e["target"] == t and e["rel"] == rel:
                return  # 重复边不重复添加
        edge = {"source": s, "target": t, "rel": rel, "since": self._day(raw), "weight": 1}
        g["edges"].append(edge)
        result["added_edges"].append({"source": s, "target": t, "rel": rel})

    def _resolve(self, name, by_label: dict, g: dict) -> str:
        """边的端点允许传 label 名或 node id。"""
        key = clean_label(name)
        if not key:
            return ""
        if key in by_label:
            return by_label[key]["id"]
        return key if any(n["id"] == key for n in g["nodes"]) else ""

    def _new_id(self, text: str, used: set) -> str:
        """生成 [a-z0-9_] 的唯一 id：ASCII 名 → 取其 ascii 部分 → 兜底 n_<hash8>。"""
        base = store.slug(text)
        base = "".join(ch for ch in base if ch.isascii() and (ch.isalnum() or ch == "_")).strip("_")
        base = base or "n_" + hashlib.sha1(str(text).encode("utf-8")).hexdigest()[:8]
        nid, i = base, 1
        while nid in used:
            i += 1
            nid = f"{base}_{i}"
        used.add(nid)
        return nid

    def _score(self, node: dict, query: str, q_grams: set) -> float:
        """命中 node 的 label / related / facts 文本；label 直接出现在提问里额外加权。"""
        texts = [str(node.get("label") or "")]
        texts += [str(w) for w in node.get("related") or []]
        texts += [str(f.get("text") or "") for f in node.get("facts") or [] if isinstance(f, dict)]
        hay = " ".join(texts)
        score = float(len(q_grams & store.bigrams(hay)))
        if texts[0] and texts[0] in query:
            score += 3
        # 提及越多越容易被想起，仅作同分时的次要权重
        return score * (1 + 0.1 * min(int(node.get("weight") or 1), 9)) if score else 0.0

    def _recall_block(self, nodes: list[dict], picked: dict) -> str:
        lines = []
        for item in nodes:
            node = picked[item["id"]]
            facts = [self._fact_text(f) for f in node.get("facts") or [] if isinstance(f, dict)]
            facts = [t for t in facts if t][-2:]
            tail = "；".join(facts) or _STATUS_CN.get(node.get("status", ""), "")
            lines.append(f"【{item['label']}】{tail}" if tail else f"【{item['label']}】")
        return "\n".join(lines)

    @staticmethod
    def _fact_text(fact: dict) -> str:
        text = _clip(fact.get("text"), _FACT_MAX)
        stamp = str(fact.get("date") or "")
        return f"{stamp[5:]} {text}" if len(stamp) >= 10 else text

    def _facts(self, raw: dict, today: str) -> list[dict]:
        """兼容 data 里的 fact（单条）与 facts（列表，元素可为 str 或 dict）。"""
        out: list[dict] = []
        items = raw.get("facts")
        if isinstance(items, list):
            for f in items:
                if isinstance(f, dict):
                    text = str(f.get("text") or "").strip()
                    day = str(f.get("date") or today)
                else:
                    text, day = str(f or "").strip(), today
                if text:
                    out.append({"date": day, "text": text})
        fact = str(raw.get("fact") or raw.get("text") or "").strip()
        if fact and fact not in {f["text"] for f in out}:
            out.append({"date": today, "text": fact})
        return out

    @staticmethod
    def _day(raw: dict) -> str:
        """优先用 data 给的合法日期，否则今天。"""
        value = str(raw.get("date") or raw.get("last_seen") or "").strip()
        try:
            return date.fromisoformat(value[:10]).isoformat()
        except ValueError:
            return date.today().isoformat()

    def _brief_node(self, node: dict) -> str:
        domain = _DOMAIN_CN.get(str(node.get("domain")), str(node.get("domain") or "?"))
        seen = str(node.get("last_seen") or "")
        meta = [domain, _STATUS_CN.get(str(node.get("status")), "进行中"),
                f"{int(node.get('weight') or 1)}次", "最近" + (seen[5:] if len(seen) >= 10 else "?")]
        return f"{node.get('label')}（{' '.join(meta)}）"

    def _brief_edges(self, g: dict, visible: set) -> list[str]:
        edges = [e for e in g["edges"] if e["source"] in visible and e["target"] in visible]
        edges.sort(key=lambda e: -int(e.get("weight") or 1))
        labels = {n["id"]: str(n.get("label") or n["id"]) for n in g["nodes"] if n["id"] in visible}
        return [f"{labels[e['source']]} —{e['rel']}→ {labels[e['target']]}" for e in edges[:12]]

    @staticmethod
    def _cap(lines: list[str], maxlen: int) -> str:
        out, total = [], 0
        for line in lines:
            if total + len(line) + 1 > maxlen:
                break
            out.append(line)
            total += len(line) + 1
        return "\n".join(out)

    @staticmethod
    def _node(raw: dict) -> dict:
        """归一化一个节点，字段与契约 §2.1 对齐。"""
        facts = [f for f in raw.get("facts") or [] if isinstance(f, dict)]
        weight = raw.get("weight")
        return {
            "id": str(raw.get("id")),
            "label": str(raw.get("label") or raw.get("id")),
            "domain": raw.get("domain") if raw.get("domain") in DOMAINS else "intellect",
            "type": raw.get("type") if raw.get("type") in TYPES else "interest",
            "status": raw.get("status") if raw.get("status") in STATUSES else "active",
            "first_seen": str(raw.get("first_seen") or ""),
            "last_seen": str(raw.get("last_seen") or raw.get("first_seen") or ""),
            "weight": int(weight) if isinstance(weight, (int, float)) and weight >= 1 else 1,
            "private": bool(raw.get("private")),
            "facts": facts,
        }

    @staticmethod
    def _edge(raw: dict, source: str, target: str) -> dict:
        weight = raw.get("weight")
        return {
            "source": source,
            "target": target,
            "rel": str(raw.get("rel") or "联想到"),
            "since": str(raw.get("since") or ""),
            "weight": int(weight) if isinstance(weight, (int, float)) and weight >= 1 else 1,
        }
