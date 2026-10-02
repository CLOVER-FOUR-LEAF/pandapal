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


def test_blocked_host_covers_alternate_ip_spellings():
    for h in ("2130706433", "0x7f.0.0.1", "0177.0.0.1", "0", "[::ffff:127.0.0.1]",
              "fc00::1", "fe80::1", "169.254.169.254", "100.64.0.1", "a.localhost"):
        assert tools._blocked_host(h), h
    assert not tools._blocked_host("8.8.8.8")


def test_web_browse_rechecks_every_redirect_hop(monkeypatch):
    """公网地址 302 到云元数据地址：每一跳都要重新检查，不能被带进内网。"""
    import asyncio
    import httpx

    hits = []

    def handler(req: httpx.Request) -> httpx.Response:
        hits.append(str(req.url))
        if req.url.host == "public.example":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})
        return httpx.Response(200, headers={"content-type": "text/html"}, text="<title>secret</title>")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(tools, "shared_client", lambda: client)

    async def fake_resolve(host):  # 不联网：只有字面量内网地址被拦
        return tools._blocked_host(host)
    monkeypatch.setattr(tools, "_resolves_blocked", fake_resolve)

    out = asyncio.run(tools._safe_fetch("http://public.example/"))
    assert out == tools._BLOCKED_MSG
    assert hits == ["http://public.example/"]  # 元数据地址一次都没被请求


def test_web_browse_caps_body_size(monkeypatch):
    import asyncio
    import httpx

    big = b"<p>" + b"a" * (tools._MAX_HTML_BYTES * 3) + b"</p>"
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda req: httpx.Response(200, headers={"content-type": "text/html"}, content=big)))
    monkeypatch.setattr(tools, "shared_client", lambda: client)

    async def fake_resolve(host):
        return False
    monkeypatch.setattr(tools, "_resolves_blocked", fake_resolve)
    _url, _ct, html = asyncio.run(tools._safe_fetch("http://public.example/"))
    assert len(html) <= tools._MAX_HTML_BYTES


def test_parent_binding_requires_child_password():
    """只知道孩子名字（演示号"小豆"是公开的）不能注册成他的家长。"""
    import pytest
    auth.ensure_seed()
    auth.register("绑定测试娃", "kidpw1", "child", question="q", answer="a")
    with pytest.raises(ValueError):
        auth.register("冒充家长", "mama11", "parent", child="绑定测试娃",
                      question="q", answer="a", child_password="wrong")
    with pytest.raises(ValueError) as e2:
        auth.register("冒充家长2", "mama11", "parent", child="不存在的娃",
                      question="q", answer="a", child_password="x")
    # 不存在与密码错同一句话，接口不泄露孩子用户名是否存在
    assert "登录名或密码不对" in str(e2.value)
    res = auth.register("真家长", "mama11", "parent", child="绑定测试娃",
                        question="q", answer="a", child_password="kidpw1")
    assert res["user"]["child"] == "绑定测试娃"


def test_autoregister_enforces_min_password():
    import pytest
    with pytest.raises(ValueError):
        auth.login("短密码新号", "1")


def test_ics_chinese_affair_id_does_not_500():
    from fastapi.testclient import TestClient
    c = TestClient(main.app)
    tok = c.post("/api/auth/login", json={"username": "日历娃", "password": "cal123"}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    r = c.post("/api/affairs", headers=h, json={"name": "日历娃", "id": "机器人比赛",
               "patch": {"title": "机器人比赛", "due": "2026-12-01"}})
    assert r.status_code == 200, r.text
    r = c.get("/api/ics/机器人比赛", headers=h, params={"name": "日历娃"})
    assert r.status_code == 200
    disp = r.headers["content-disposition"]
    assert "filename*=UTF-8''" in disp and disp.isascii()


def test_llm_quota_shared_across_users_by_ip():
    """换名字绕不过额度：同一 IP 的总量也有上限。"""
    from types import SimpleNamespace
    main._LLM_HITS.clear()
    req = SimpleNamespace(client=SimpleNamespace(host="203.0.113.9"), headers={})
    ok = sum(main._llm_quota(req, f"u{i}") for i in range(main._LLM_IP_MAX + 20))
    assert ok == main._LLM_IP_MAX
    main._LLM_HITS.clear()
