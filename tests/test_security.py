"""安全回归：token 只存哈希、XFF 只信本机反代、天气 URL 转义、限频表有硬上限。"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_sec_")

from server import auth, main  # noqa: E402


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
    from server import tools
    seen = {}

    class _Resp:
        def raise_for_status(self): pass
        def json(self): return {"weather": []}

    class _Client:
        async def get(self, url, **kw):
            seen["url"] = url
            return _Resp()

    monkeypatch.setattr(tools, "shared_client", lambda: _Client())
    asyncio.run(tools.weather("a/b?x=1"))
    assert seen["url"].startswith("https://wttr.in/a%2Fb%3Fx%3D1?")
