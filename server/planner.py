"""规划器：事件 → LLM 输出 JSON DAG，校验（环/未知依赖/未知工具）后返回。"""
from __future__ import annotations

import asyncio

from . import llm, prompts, tools
from .memory import MemoryStore
from .store import bigrams

# 可用工具集合 = 注册表全部工具 + llm 兜底环节，注册即生效不用改这里
VALID_TOOLS = tools.names() | {"llm"}


MAX_NODES = 6
# 规划整体时限：planner 实测 p90 8.3s、最慢 11.8s。超时就交给调用方走"单次直出卡片"，
# 不让孩子对着"正在规划"干等到 LLM_TIMEOUT（90s）
PLAN_BUDGET_S = 25.0


class PlanError(RuntimeError):
    pass


def _validate(plan: dict) -> dict:
    nodes = plan.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise PlanError("plan.nodes 为空")
    # 提示词要求 3-5 个节点；超出的截掉（执行器按节点并发，失控的计划会把额度一次烧光）
    if len(nodes) > MAX_NODES:
        del nodes[MAX_NODES:]
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
            # 模型偶尔编出不存在的工具名（"search""map"）。整份计划作废太浪费：
            # 这一环降级成 llm 推导，其余真工具环节照跑
            n.setdefault("args", {})
            if isinstance(n["args"], dict):
                n["args"].setdefault("task", str(n.get("title") or ""))
            tool = "llm"
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
    _drop_summary_tail(plan)
    return plan


# 汇总类节点：卡片由 synth 统一生成，规划里再放一个只会多花一次 LLM 调用
_SUMMARY_WORDS = ("汇总", "总结", "整理成", "整理一下", "给孩子的方案", "输出方案", "给一份完整")


def _drop_summary_tail(plan: dict) -> None:
    """剔除末尾那个纯汇总 llm 节点。

    提示词已经要求不要生成，但模型并不总是听话（实测同一句话，有时出 4 个
    纯干活节点、有时会自己加一个"汇总成给孩子的方案"），所以这里做确定性兜底。

    判定同时看标题和 args.task：只认"汇总/总结/整理成"这类**聚合**措辞，
    并要求它确实依赖了别的环节（>=2 个且过半），避免误删"错开课程并列出要
    带的东西"这种虽然收尾、但标题里没有聚合词的真活节点。
    """
    nodes = plan.get("nodes") or []
    if len(nodes) < 3:  # 只有两个节点时没什么可汇总的，宁可不动
        return
    last = nodes[-1]
    if last.get("tool") != "llm":
        return
    blob = str(last.get("title") or "") + " " + str((last.get("args") or {}).get("task") or "")
    if not any(w in blob for w in _SUMMARY_WORDS):
        return
    deps = set(last.get("depends_on") or [])
    others = {n["id"] for n in nodes[:-1]}
    if len(deps & others) >= 2 and len(deps & others) * 2 >= len(others):
        gone = nodes.pop()["id"]
        # 别留悬空依赖：DAG 视图会画出一条指向不存在节点的边
        for n in nodes:
            if gone in (n.get("depends_on") or []):
                n["depends_on"] = [d for d in n["depends_on"] if d != gone]


async def make_plan(store: MemoryStore, message: str, affairs_snapshot: dict | None = None,
                    attach_ctx: str = "") -> dict:
    """生成 DAG 计划；失败抛 PlanError 由调用方走保底。

    attach_ctx 是本轮附件摘要（文件名 + 抽取正文）：规划链路只吃文本，
    孩子用图片/文档补充需求时（"按这张课程表安排"）不带上就等于什么都没说。
    """
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
        plan = await asyncio.wait_for(llm.complete_json(
            [
                {"role": "system", "content": "你是任务规划模块，只输出 JSON。"},
                {"role": "user", "content": prompts.PLANNER.format(
                    name=name,
                    now=tools.now_text(),
                    tools_doc=tools.planner_docs(),
                    memory_block=mem or "（暂无记忆）",
                    affairs_brief=brief,
                    message=message + attach_ctx,
                )},
            ],
            max_tokens=1200,  # 3-5 个节点的 JSON 足够。实测调小并不省时间：
                               # 瓶颈是模型推理本身，不是输出长度，保留上限只是兜底防跑飞
            caller="planner",
        ), PLAN_BUDGET_S)
        return _validate(plan)
    except asyncio.TimeoutError as e:
        raise PlanError(f"规划超过 {PLAN_BUDGET_S:.0f}s") from e
    except Exception as e:
        raise PlanError(str(e) or type(e).__name__) from e
