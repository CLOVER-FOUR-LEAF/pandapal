"""家庭侧服务离线自检：家长周报 / 通知落地（含批量）/ 童年备忘录导出。

用法：.venv/bin/python tests/test_family.py
monkeypatch server.llm，数据目录指向一次性沙箱，真实 data/ 一个字节都不碰。
重点断言隐私边界：悄悄话节点既不进周报/通知的 prompt，也不进统计；导出家长拿不到。
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_family_")
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

import httpx  # noqa: E402

from server import llm  # noqa: E402
from server.main import app  # noqa: E402

SANDBOX = Path(os.environ["PANDA_DATA_DIR"])
CHILD, PARENT, OTHER = "家测小孩", "家测妈妈", "家测别家"
SECRET = "偷偷喜欢同桌"
TODAY = date.today().isoformat()

RESULTS: list[tuple[str, bool, str]] = []
PROMPTS: dict[str, list[str]] = {}


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


async def fake_complete_json(messages, *, max_tokens=1200, caller="unknown"):
    content = str(messages[-1].get("content", ""))
    PROMPTS.setdefault(caller, []).append(content)
    if caller == "weekly":
        return {"headline": "这周把秋游准备好了", "highlights": ["秋游清单备齐"],
                "watch": ["感冒还没好"], "suggestion": "周末陪孩子早睡", "praise": "你自己记得收拾书包"}
    if caller == "notice":
        return {"title": "周五秋游", "kind": "event", "due": TODAY, "summary": "周五去植物园秋游",
                "parent_text": "周五秋游，请准备午餐。", "child_text": "周五去植物园玩啦！",
                "personal": ["感冒还没好，带上药"], "checklist": ["午餐", "水壶", "外套"],
                "reminders": [{"text": "前一天收拾背包", "at": TODAY}]}
    return {}


def _seed(child_dir: Path) -> None:
    """一个公开节点（感冒，本周有事实）+ 一个悄悄话节点。"""
    child_dir.mkdir(parents=True, exist_ok=True)
    node = lambda nid, label, private, fact: {  # noqa: E731
        "id": nid, "label": label, "domain": "health", "type": "health", "status": "active",
        "first_seen": TODAY, "last_seen": TODAY, "weight": 3, "private": private,
        "facts": [{"date": TODAY, "text": fact}]}
    (child_dir / "graph.json").write_text(json.dumps({"nodes": [
        node("cold", "感冒", False, "这周咳嗽，还在吃药"),
        node("secret1", SECRET, True, SECRET),
    ], "edges": []}, ensure_ascii=False), encoding="utf-8")


async def _login(client, user, pw) -> str:
    r = await client.post("/api/auth/login", json={"username": user, "password": pw})
    return r.json().get("token", "")


async def _run(client: httpx.AsyncClient) -> None:
    # 账号：孩子（未注册名登录即自动建孩子档）+ 绑定它的家长 + 别家孩子
    ctoken = await _login(client, CHILD, "pw123456")
    await _login(client, OTHER, "pw123456")
    r = await client.post("/api/auth/register", json={
        "username": PARENT, "password": "pw123456", "role": "parent", "child": CHILD,
        "question": "q", "answer": "a"})
    ptoken = r.json().get("token", "")
    record("setup", bool(ctoken and ptoken), f"register={r.status_code}")
    child_dir = next(p for p in SANDBOX.iterdir() if p.name.startswith("child_") and CHILD in p.name)
    _seed(child_dir)
    P = {"Authorization": f"Bearer {ptoken}"}
    C = {"Authorization": f"Bearer {ctoken}"}

    # 1. 周报：家长可读，统计不含悄悄话，prompt 里没有悄悄话原文
    r = await client.get("/api/parent/weekly", headers=P)
    w = r.json()
    rep = w.get("report", {})
    record("weekly_ok", r.status_code == 200 and rep.get("headline") and rep.get("llm") is True,
           str(rep)[:60])
    record("weekly_stats", w.get("stats", {}).get("new_memories") == 1
           and w.get("stats", {}).get("secret_count") == 1, str(w.get("stats")))
    record("weekly_no_secret_in_prompt", all(SECRET not in p for p in PROMPTS.get("weekly", [])))
    r = await client.get("/api/parent/weekly", headers=C)
    record("weekly_child_403", r.status_code == 403, f"status={r.status_code}")

    # 2. 周报降级：LLM 挂了也给统计说实话
    async def boom(*a, **k):
        raise llm.LLMError("offline")
    saved = llm.complete_json
    llm.complete_json = boom
    r = await client.get("/api/parent/weekly", headers=P)
    llm.complete_json = saved
    rep = r.json().get("report", {})
    record("weekly_fallback", r.status_code == 200 and rep.get("llm") is False and rep.get("headline"),
           rep.get("headline", "")[:40])

    # 3. 通知落地：家长粘通知 → 事务 + 清单回挂 + 提醒；prompt 不含悄悄话
    r = await client.post("/api/notice", headers=P, json={"text": "本周五全班去植物园秋游，请自带午餐和水。"})
    res = (r.json().get("results") or [{}])[0]
    aff = res.get("affair") or {}
    kinds = [a["kind"] for a in res.get("actions", []) if a.get("ok")]
    record("notice_affair", r.status_code == 200 and res.get("created") and aff.get("source") == "notice"
           and bool(aff.get("checklist_id")), f"aff={aff.get('id')} cid={aff.get('checklist_id')}")
    record("notice_actions", "checklist" in kinds and "reminder" in kinds, str(kinds))
    record("notice_personal", res.get("personal") == ["感冒还没好，带上药"] and res.get("parent_text"))
    record("notice_no_secret_in_prompt", all(SECRET not in p for p in PROMPTS.get("notice", [])))
    cl = await client.get(f"/api/checklist/{aff.get('checklist_id')}", headers=C)
    record("notice_checklist_readable", cl.status_code == 200
           and len(cl.json().get("checklist", {}).get("items", [])) == 3, f"status={cl.status_code}")

    # 4. 同一份通知再粘一次：认领旧事务，不重复建单
    r = await client.post("/api/notice", headers=P, json={"text": "提醒：周五秋游别忘了带午餐。"})
    res2 = (r.json().get("results") or [{}])[0]
    record("notice_dedup", res2.get("created") is False
           and (res2.get("affair") or {}).get("id") == aff.get("id"), str(res2.get("affair", {}).get("id")))

    # 5. 越权：家长不能给别家孩子发、不能批量；孩子没有 notice 能力
    r = await client.post("/api/notice", headers=P, json={"name": OTHER, "text": "别家的通知内容"})
    record("notice_other_403", r.status_code == 403, f"status={r.status_code}")
    r = await client.post("/api/notice", headers=P, json={"names": [CHILD, OTHER], "text": "批量通知内容"})
    record("notice_batch_parent_403", r.status_code == 403, f"status={r.status_code}")
    r = await client.post("/api/notice", headers=C, json={"text": "孩子不该能发这个"})
    record("notice_child_403", r.status_code == 403, f"status={r.status_code}")

    # 6. 机构批量：admin 一份通知覆盖两家，各自落各自档案
    atoken = await _login(client, "admin", "admin123")
    r = await client.post("/api/notice", headers={"Authorization": f"Bearer {atoken}"},
                          json={"names": [CHILD, OTHER], "text": "下周一升旗仪式，统一穿校服。", "source": "学校"})
    names = [x.get("name") for x in r.json().get("results", []) if x.get("affair")]
    record("notice_batch_admin", r.status_code == 200 and sorted(names) == sorted([CHILD, OTHER]), str(names))
    r = await client.post("/api/notice", headers={"Authorization": f"Bearer {atoken}"},
                          json={"names": [CHILD, "打错的名字"], "text": "下周一升旗仪式，统一穿校服。"})
    record("notice_batch_unknown_400", r.status_code == 400
           and not any("打错" in p.name for p in SANDBOX.iterdir()), f"status={r.status_code}")

    # 7. 导出：孩子拿到 zip（含 README 与图谱），家长 403
    r = await client.get("/api/export", headers=C)
    ok = r.status_code == 200 and r.headers.get("content-type") == "application/zip"
    files = zipfile.ZipFile(io.BytesIO(r.content)).namelist() if ok else []
    record("export_child", ok and "README.txt" in files and "graph.json" in files, str(files)[:80])
    r = await client.get("/api/export", headers=P)
    record("export_parent_403", r.status_code == 403, f"status={r.status_code}")


async def main() -> int:
    saved = {k: getattr(llm, k) for k in ("complete_json", "log_call")}
    llm.complete_json = fake_complete_json
    llm.log_call = lambda *a, **k: None
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t", timeout=30) as client:
            await _run(client)
    finally:
        for k, v in saved.items():
            setattr(llm, k, v)
        shutil.rmtree(SANDBOX, ignore_errors=True)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    return 0 if passed == len(RESULTS) else 1


def test_family():
    assert asyncio.run(main()) == 0, [r for r in RESULTS if not r[1]]


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
