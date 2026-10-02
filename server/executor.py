"""执行器：按依赖并行调度 DAG 节点，实时推送节点状态；单点失败不拖垮整链。"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from . import llm, prompts, tools
from .memory import MemoryStore

Emit = Callable[[dict], Awaitable[None]]


async def _run_llm_node(store: MemoryStore, event: str, node: dict, results: dict) -> str:
    context = "\n\n".join(f"【{nid}】{text}" for nid, text in results.items())
    name, mem = await asyncio.to_thread(lambda: (store.child_name, store.active_block()))
    return await llm.complete(
        [{"role": "user", "content": prompts.NODE_LLM.format(
            name=name,
            event=event,
            title=node["title"],
            task=node["args"].get("task", node["title"]),
            context=context or "（无前置结果）",
            memory_block=mem or "（暂无记忆）",
        )}],
        max_tokens=800,
        caller="node",
    )


async def _run_node(store: MemoryStore, event: str, node: dict, results: dict) -> str:
    tool, args = node["tool"], node.get("args", {})
    if tool == "race_lookup":
        return await asyncio.to_thread(tools.race_lookup, str(args.get("query", event)))
    if tool == "transport_lookup":
        return await asyncio.to_thread(
            tools.transport_lookup,
            str(args.get("from_city", "")),
            str(args.get("to_city", "")),
        )
    if tool == "weather":
        return await tools.weather(str(args.get("city", "")))
    if tool == "web_search":
        out = await tools.web_search(str(args.get("query", event)))
        if out is not None:
            return out
        # 未配置搜索 Key：降级为模型知识，仍真生成
        return await _run_llm_node(store, event, node, results)
    return await _run_llm_node(store, event, node, results)


async def run_plan(
    plan: dict,
    store: MemoryStore,
    event: str,
    emit: Emit,
) -> tuple[dict[str, str], dict[str, str]]:
    """按 depends_on 并行执行，emit 推送状态；返回 ({node_id: 结果文本}, {node_id: done|error})。"""
    nodes = plan["nodes"]
    done_events = {n["id"]: asyncio.Event() for n in nodes}
    results: dict[str, str] = {}
    statuses: dict[str, str] = {}
    by_id = {n["id"]: n for n in nodes}

    def _ancestors(node: dict) -> set[str]:
        """节点的全部上游依赖（传递闭包）——LLM 上下文只该看到祖先结果，
        并行分支的产物不掺进来，不然比赛交通的结论会被隔壁乐器分支串味。"""
        seen, stack = set(), list(node["depends_on"])
        while stack:
            d = stack.pop()
            if d not in seen:
                seen.add(d)
                stack.extend((by_id.get(d) or {}).get("depends_on", []))
        return seen

    async def worker(node: dict):
        for dep in node["depends_on"]:
            ev = done_events.get(dep)
            if ev:
                await ev.wait()
        await emit({"type": "node", "id": node["id"], "title": node["title"], "status": "running"})
        try:
            anc = _ancestors(node)
            text = await _run_node(store, event, node,
                                   {k: v for k, v in results.items() if k in anc})
            results[node["id"]] = text
            statuses[node["id"]] = "done"
            await emit({
                "type": "node", "id": node["id"], "title": node["title"],
                "status": "done", "detail": text[:400],
            })
        except Exception as e:  # noqa: BLE001 单节点失败不拖垮整链
            results[node["id"]] = f"（本环节查询失败：{e}，按常识处理）"
            statuses[node["id"]] = "error"
            await emit({"type": "node", "id": node["id"], "title": node["title"], "status": "error"})
        finally:
            done_events[node["id"]].set()

    await asyncio.gather(*(worker(n) for n in nodes))
    return results, statuses
