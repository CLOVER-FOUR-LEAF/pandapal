"""规划器：事件 → LLM 输出 JSON DAG，校验（环/未知依赖/未知工具）后返回。"""
from __future__ import annotations

import asyncio

from . import llm, prompts, tools
from .memory import MemoryStore
from .store import bigrams

# 可用工具集合 = 注册表全部工具 + llm 兜底环节，注册即生效不用改这里
VALID_TOOLS = tools.names() | {"llm"}


class PlanError(RuntimeError):
    pass


def _validate(plan: dict) -> dict:
    nodes = plan.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise PlanError("plan.nodes 为空")
    # 第一遍：规范化节点并收集全部 id（依赖可以指向任意节点，不限于先声明的）
    ids: set[str] = set()
    for i, n in enumerate(nodes):
        if not isinstance(n, dict):
            raise PlanError(f"节点 {i} 不是对象")
        n.setdefault("id", f"n{i + 1}")
        if n["id"] in ids:
            raise PlanError(f"节点 id 重复: {n['id']}")
        ids.add(n["id"])
        n.setdefault("title", f"环节 {i + 1}")
        tool = n.get("tool") or "llm"
        if tool not in VALID_TOOLS:
            raise PlanError(f"未知工具: {tool}")
        n["tool"] = tool
        if not isinstance(n.get("args"), dict):
            n["args"] = {}
        if not isinstance(n.get("depends_on"), list):
            n["depends_on"] = []
    # 第二遍：剔除未知依赖与自依赖
    for n in nodes:
        n["depends_on"] = [d for d in n["depends_on"] if d in ids and d != n["id"]]
    # 拓扑排序检测环 + 剔除未知依赖
    pending = {n["id"]: set(d for d in n["depends_on"] if d in ids) for n in nodes}
    ordered = []
    while pending:
        ready = [nid for nid, deps in pending.items() if not deps]
        if not ready:
            raise PlanError("依赖存在环")
        for nid in ready:
            ordered.append(nid)
            del pending[nid]
        for deps in pending.values():
            deps.difference_update(ready)
    plan["title"] = str(plan.get("title") or "筹备计划")
    return plan


async def make_plan(store: MemoryStore, message: str, affairs_snapshot: dict | None = None) -> dict:
    """生成 DAG 计划；失败抛 PlanError 由调用方走保底。"""
    brief = "（暂无）"
    if affairs_snapshot:
        rows = affairs_snapshot.get("board") or []
        if rows:
            q = bigrams(message)
            rel = [r for r in rows if q & bigrams(str(r.get("title", "")))]
            if rel:
                brief = "\n".join(f"- {r['title']}（{r.get('stage')}）" for r in rel[:5])
    name, mem = await asyncio.to_thread(lambda: (store.child_name, store.active_block(message)))
    try:
        plan = await llm.complete_json(
            [
                {"role": "system", "content": "你是任务规划模块，只输出 JSON。"},
                {"role": "user", "content": prompts.PLANNER.format(
                    name=name,
                    now=tools.now_text(),
                    tools_doc=tools.planner_docs(),
                    memory_block=mem or "（暂无记忆）",
                    affairs_brief=brief,
                    message=message,
                )},
            ],
            max_tokens=3000,
            caller="planner",
        )
        return _validate(plan)
    except Exception as e:
        raise PlanError(str(e)) from e
