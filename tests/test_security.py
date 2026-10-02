"""安全回归：token 只存哈希、XFF 只信本机反代、天气 URL 转义、限频表有硬上限。"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_sec_")
# pytest 单进程里别的测试文件可能已经导入过 server 包（沙箱不同）：先清掉再导入，
# 否则 auth/config 停在先导入者的目录上，token 落盘断言会看错沙箱。
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

from server import auth, main, tools  # noqa: E402


class _Req:
    def __init__(self, host, xff=""):
        self.client = type("C", (), {"host": host})()
        self.headers = {"x-forwarded-for": xff} if xff else {}


def test_token_stored_hashed():
    res = auth.login("小豆", "panda123")
    raw = res["token"]
    assert raw not in auth.TOKENS_PATH.read_text(encoding="utf-8")
    assert auth.user_for_token(raw)["username"] == "小豆"
    assert auth.user_for_token(auth._tkey(raw)) is None  # 哈希本身不能当凭证
    auth.logout(raw)
    assert auth.user_for_token(raw) is None


def test_legacy_plaintext_tokens_migrated():
    auth.TOKENS_PATH.write_text(json.dumps(
        {"a" * 48: {"username": "小豆", "role": "child", "child": "小豆", "ts": 9e12}}))
    auth._load_tokens()
    assert auth.user_for_token("a" * 48)["username"] == "小豆"


def test_xff_only_trusted_from_loopback():
    assert main._client_ip(_Req("203.0.113.9", "1.2.3.4")) == "203.0.113.9"
    assert main._client_ip(_Req("127.0.0.1", "1.2.3.4, 10.0.0.1")) == "1.2.3.4"
    assert main._client_ip(_Req("127.0.0.1")) == "127.0.0.1"


def test_hit_tables_hard_capped():
    table = {f"ip{i}": [float(i)] for i in range(50)}
    main._cap_table(table, 10)
    assert len(table) == 10 and "ip49" in table and "ip0" not in table


def test_weather_city_quoted(monkeypatch):
    import asyncio
    seen = {}

    class _Resp:
        def raise_for_status(self): pass
        def json(self): return {"weather": []}

    class _Client:
        async def get(self, url, **kw):
            seen["url"] = url
            return _Resp()

    monkeypatch.setattr(tools, "shared_client", lambda: _Client())
    asyncio.run(tools.dispatch("weather", {"city": "a/b?x=1"}, tools.ToolCtx()))
    assert seen["url"].startswith("https://wttr.in/a%2Fb%3Fx%3D1?")


def test_admin_cannot_be_reset_with_public_seed_answer():
    """README 公开了演示密保「竹子」：它绝不能拿来重置 admin（否则能接管全部档案）。"""
    auth.ensure_seed()
    users = auth._read_users()
    assert not users["admin"].get("ahash"), "admin 不该挂公开演示密保"
    import pytest
    with pytest.raises(ValueError):
        auth.reset_password("admin", auth.SEED_QA[1], "hacked123")
    # 孩子演示号仍可开箱演示找回流程
    assert users["小豆"].get("ahash")


def test_backfill_strips_seed_answer_from_existing_admin():
    """老部署的 users.json 里 admin 已经挂上了公开密保：启动时要摘掉。"""
    auth.ensure_seed()
    users = auth._read_users()
    auth._with_question(users["admin"], auth.SEED_QA[0], auth.SEED_QA[1])
    auth._write_users(users)
    auth._backfill_seed_qa()
    assert not auth._read_users()["admin"].get("ahash")


def test_seed_with_custom_password_gets_no_public_answer(monkeypatch):
    monkeypatch.setenv("PANDA_CHILD_PASSWORD", "s3cret-pw")
    assert not auth._seed_gets_qa("小豆", "child")
    monkeypatch.delenv("PANDA_CHILD_PASSWORD")
    assert auth._seed_gets_qa("小豆", "child")
