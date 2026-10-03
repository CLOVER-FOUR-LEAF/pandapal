"""后台管理离线自检（不联网、不碰真实 data/）：admin 全套端点 + 权限闸门。

用法：.venv/bin/python tests/test_admin.py

覆盖：
  权限闸门（无 token 401 / 孩子账号 403）→ 总览 → 配置读写（TTS key 写入
  settings.json 并热生效、unset 回落、非法键 400）→ 用户管理（建号/改角色/改密码/
  踢下线/删号，删自己与删最后一个管理员的护栏）→ 档案文件（清单/读写删、JSON 校验、
  路径越界与 index.json 保护）→ 共享数据文件（白名单外 404、JSON 校验）。
数据目录用 PANDA_DATA_DIR 指向一次性沙箱。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_admin_")
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

import httpx  # noqa: E402

from server import config, llm  # noqa: E402
from server.main import app  # noqa: E402

SANDBOX = Path(os.environ["PANDA_DATA_DIR"])
RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


async def main() -> int:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://test") as c:
        # ---- 权限闸门 ----
        r = await c.get("/api/admin/overview")
        record("admin_no_token_401", r.status_code == 401, f"{r.status_code}")
        r = await c.post("/api/auth/login", json={"username": "小豆", "password": "panda123"})
        child_tok = r.json()["token"]
        r = await c.get("/api/admin/overview",
                        headers={"Authorization": f"Bearer {child_tok}"})
        record("admin_child_403", r.status_code == 403, f"{r.status_code}")

        r = await c.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
        tok = r.json()["token"]
        h = {"Authorization": f"Bearer {tok}"}

        # ---- 总览 ----
        r = await c.get("/api/admin/overview", headers=h)
        ov = r.json()
        record("overview", r.status_code == 200 and ov["users"]["admin"] >= 1
               and "tts" in ov and "llm" in ov, f"{r.status_code}")

        # ---- 配置 ----
        r = await c.get("/api/admin/settings", headers=h)
        groups = {g["key"]: g for g in r.json()["groups"]}
        tts_fields = {f["key"]: f for f in groups["tts"]["fields"]}
        asr_fields = {f["key"]: f for f in groups["asr"]["fields"]}
        record("settings_groups", set(groups) == {"llm", "search", "tts", "asr"}, str(set(groups)))
        record("settings_tts_fields", "TTS_API_KEY" in tts_fields and tts_fields["TTS_API_KEY"]["secret"])
        record("settings_asr_fields",
               "ASR_API_KEY" in asr_fields and asr_fields["ASR_API_KEY"]["secret"]
               and asr_fields["ASR_API_KEY"].get("help")
               and asr_fields["ASR_LANGUAGE"].get("choices"), str(sorted(asr_fields)))
        # 密钥字段一律不回明文（这一条与环境无关：没配时也不该有 value 字段）
        llm_key = {f["key"]: f for f in groups["llm"]["fields"]}["LLM_API_KEY"]
        record("settings_secret_never_plaintext",
               llm_key["secret"] and "value" not in llm_key)

        # 写入 TTS key → settings.json 落盘 + config 热生效
        r = await c.put("/api/admin/settings", headers=h,
                        json={"set": {"TTS_API_KEY": "sk-tts-abc123", "TTS_MODEL": "tts-1",
                                      "LLM_BASE_URL": "https://llm.example.com/v1"}})
        record("settings_put", r.status_code == 200, f"{r.status_code}")
        record("settings_applied",
               config.TTS_API_KEY == "sk-tts-abc123" and config.TTS_MODEL == "tts-1"
               and config.LLM_BASE_URL == "https://llm.example.com/v1")
        on_disk = json.loads((SANDBOX / "settings.json").read_text(encoding="utf-8"))
        record("settings_on_disk", on_disk.get("TTS_API_KEY") == "sk-tts-abc123")
        record("settings_no_clobber_env_key", config.LLM_API_KEY == config._BASELINE["LLM_API_KEY"])
        # 刚写进去的密钥：回读必须是掩码预览，不能吐明文（依赖上面的写入，故与 .env 无关）
        r = await c.get("/api/admin/settings", headers=h)
        tts_key = {f["key"]: f for f in
                   {g["key"]: g for g in r.json()["groups"]}["tts"]["fields"]}["TTS_API_KEY"]
        record("settings_secret_masked",
               "value" not in tts_key and "…" in tts_key.get("preview", "")
               and "abc123" not in json.dumps(tts_key),
               tts_key.get("preview", ""))

        # unset → 回落基线
        await c.put("/api/admin/settings", headers=h, json={"unset": ["LLM_BASE_URL"]})
        record("settings_unset_fallback",
               config.LLM_BASE_URL == config._BASELINE["LLM_BASE_URL"], config.LLM_BASE_URL)
        r = await c.put("/api/admin/settings", headers=h, json={"set": {"EVIL_KEY": "x"}})
        record("settings_bad_key_400", r.status_code == 400, f"{r.status_code}")
        r = await c.put("/api/admin/settings", headers=h, json={"set": {"LLM_PROTOCOL": "grpc"}})
        record("settings_bad_protocol_400", r.status_code == 400, f"{r.status_code}")

        # ---- 用户管理 ----
        r = await c.get("/api/admin/users", headers=h)
        record("users_list", r.status_code == 200
               and any(u["username"] == "小豆" for u in r.json()["users"]))
        rec = {u["username"]: u for u in r.json()["users"]}["admin"]
        record("users_no_hash", "hash" not in rec and "salt" not in rec)

        r = await c.post("/api/admin/users", headers=h,
                         json={"username": "小测试", "password": "pw1234", "role": "child"})
        record("user_create_child", r.status_code == 200 and r.json()["user"]["child"] == "小测试",
               f"{r.status_code}")
        r = await c.post("/api/admin/users", headers=h,
                         json={"username": "测试妈", "password": "pw1234", "role": "parent",
                               "child": "小测试"})
        record("user_create_parent", r.status_code == 200 and r.json()["user"]["child"] == "小测试")
        r = await c.post("/api/admin/users", headers=h,
                         json={"username": "测试妈2", "password": "pw1234", "role": "parent",
                               "child": "不存在的孩子"})
        record("user_create_parent_bad_child_400", r.status_code == 400, f"{r.status_code}")
        r = await c.post("/api/admin/users", headers=h,
                         json={"username": "小测试", "password": "pw1234", "role": "child"})
        record("user_create_dup_400", r.status_code == 400, f"{r.status_code}")

        # 登录新号 → 改密码踢下线 → 新密码可登、旧 token 失效
        r = await c.post("/api/auth/login", json={"username": "小测试", "password": "pw1234"})
        tk2 = r.json()["token"]
        r = await c.patch("/api/admin/users/小测试", headers=h, json={"password": "newpw999"})
        record("user_patch_password", r.status_code == 200, f"{r.status_code}")
        r = await c.get("/api/auth/me", headers={"Authorization": f"Bearer {tk2}"})
        record("user_patch_kicks_tokens", r.status_code == 401, f"{r.status_code}")
        r = await c.post("/api/auth/login", json={"username": "小测试", "password": "newpw999"})
        record("user_new_password_login", r.status_code == 200)

        # 改角色 + 吊销 + 删除
        r = await c.patch("/api/admin/users/测试妈", headers=h, json={"role": "child"})
        record("user_patch_role", r.status_code == 200 and r.json()["user"]["role"] == "child"
               and r.json()["user"]["child"] == "测试妈", f"{r.json() if r.status_code==200 else r.text}")
        r = await c.post("/api/admin/users/小测试/revoke", headers=h, json={})
        record("user_revoke", r.status_code == 200, f"{r.status_code}")
        r = await c.delete("/api/admin/users/admin", headers=h)
        record("user_delete_self_400", r.status_code == 400, f"{r.status_code}")
        r = await c.delete("/api/admin/users/测试妈", headers=h)
        record("user_delete_ok", r.status_code == 200, f"{r.status_code}")
        # 最后一个管理员护栏：新建 admin2 后能删，只剩一个时不行
        await c.post("/api/admin/users", headers=h,
                     json={"username": "admin2", "password": "pw1234", "role": "admin"})
        r = await c.delete("/api/admin/users/admin2", headers=h)
        record("user_delete_second_admin", r.status_code == 200)
        r = await c.patch("/api/admin/users/admin", headers=h, json={"role": "child"})
        record("last_admin_demote_400", r.status_code == 400, f"{r.status_code}")

        # ---- 档案文件 ----
        r = await c.get("/api/admin/children", headers=h)
        kids = r.json()["children"]
        record("children_list", any(x["name"] == "小豆" for x in kids), f"{len(kids)}")
        r = await c.get("/api/admin/children/小豆/files", headers=h)
        paths = [f["path"] for f in r.json()["files"]]
        record("child_files", "index.json" in paths and "MEMORY.md" in paths, str(paths[:5]))

        r = await c.get("/api/admin/children/小豆/file", headers=h, params={"path": "MEMORY.md"})
        record("child_file_get", r.status_code == 200 and "长期记忆" in r.json()["text"])
        r = await c.put("/api/admin/children/小豆/file", headers=h,
                        json={"path": "topics/测试主题.md", "content": "# 测试\n- 后台写入\n"})
        record("child_file_put", r.status_code == 200, f"{r.status_code}")
        r = await c.get("/api/admin/children/小豆/file", headers=h,
                        params={"path": "topics/测试主题.md"})
        record("child_file_readback", "后台写入" in r.json()["text"])
        r = await c.put("/api/admin/children/小豆/file", headers=h,
                        json={"path": "graph.json", "content": "{not json"})
        record("child_file_bad_json_400", r.status_code == 400, f"{r.status_code}")
        r = await c.get("/api/admin/children/小豆/file", headers=h,
                        params={"path": "../../users.json"})
        record("child_file_traversal_400", r.status_code == 400, f"{r.status_code}")
        r = await c.delete("/api/admin/children/小豆/file", headers=h,
                           params={"path": "index.json"})
        record("child_file_index_protected", r.status_code == 400, f"{r.status_code}")
        r = await c.delete("/api/admin/children/小豆/file", headers=h,
                           params={"path": "topics/测试主题.md"})
        record("child_file_delete", r.status_code == 200)
        r = await c.get("/api/admin/children/小豆/file", headers=h,
                        params={"path": "topics/测试主题.md"})
        record("child_file_gone_404", r.status_code == 404, f"{r.status_code}")
        r = await c.get("/api/admin/children/不存在档案/files", headers=h)
        record("child_unknown_404", r.status_code == 404, f"{r.status_code}")

        # ---- 共享数据文件 ----
        # 沙箱里没有 race_db.json，先通过接口写一个，再读回
        r = await c.get("/api/admin/data", headers=h)
        names = {f["file"] for f in r.json()["files"]}
        record("data_list", "race_db.json" in names and "users.json" not in names, str(names))
        r = await c.put("/api/admin/data/race_db.json", headers=h,
                        json={"text": json.dumps({"events": [{"id": "t1", "name": "测试赛"}]})})
        record("data_put", r.status_code == 200, f"{r.status_code}")
        r = await c.get("/api/admin/data/race_db.json", headers=h)
        record("data_get", "测试赛" in r.json()["text"])
        r = await c.get("/api/admin/data/tokens.json", headers=h)
        record("data_whitelist_404", r.status_code == 404, f"{r.status_code}")
        r = await c.put("/api/admin/data/race_db.json", headers=h, json={"text": "{bad"})
        record("data_bad_json_400", r.status_code == 400, f"{r.status_code}")

    import shutil
    shutil.rmtree(SANDBOX, ignore_errors=True)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    for name, ok, note in RESULTS:
        if not ok:
            print(f"  失败：{name}  {note}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
