"""语音识别（ASR）离线回归：容器魔数识别、请求体契约、上游失败分类、留痕、
以及 /api/asr 端点的鉴权 / 体积 / 限频 / 中间件例外。

不联网：asr._client 被替换成假身，假响应里放一句识别文本。
数据目录指向一次性沙箱，真实 data/ 一个字节都不碰。

用法：python tests/test_asr.py（pytest 直接跑也可以）
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import struct
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 必须先于 server 包导入：config 在 import 时读 PANDA_DATA_DIR / .env
os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_asr_")
# 开发机 .env 里通常配着真 Key：显式掐掉 TTS，ASR 的 Key 由用例自己设
os.environ["TTS_ENABLED"] = "0"
os.environ["TTS_API_KEY"] = ""
os.environ["ASR_ENABLED"] = "1"
os.environ["ASR_API_KEY"] = ""
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

import httpx  # noqa: E402

from server import asr, config  # noqa: E402
from server.main import app  # noqa: E402

SANDBOX = Path(os.environ["PANDA_DATA_DIR"])
CHILD = "小豆"
PARENT = "豆豆妈"
LOG_FILE = SANDBOX / "logs" / "llm_calls.jsonl"


# ------------------------------------------------------------------ 音频与假身
def _wav(seconds: float = 1.0, rate: int = 16000) -> bytes:
    """一段真 wav：44 字节头 + 静音 PCM。够让 sniff_format 认出来，也不至于太大。"""
    n = max(1, int(rate * seconds))
    head = (b"RIFF" + struct.pack("<I", 36 + n * 2) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
            + b"data" + struct.pack("<I", n * 2))
    return head + b"\x00" * (n * 2)


def _mp3() -> bytes:
    return b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 64


class _Resp:
    def __init__(self, payload: dict | None = None, status: int = 200, text: str = ""):
        self._payload = payload or {}
        self.status_code = status
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("POST", "http://t/chat/completions"),
                response=self)

    def json(self):
        return self._payload


def _ok_payload(text: str = "明天有机器人课", seconds: int = 2) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": text}}],
            "usage": {"seconds": seconds}}


class _Client:
    """假 httpx 客户端：只实现 post，把最后一次请求记下来。"""

    def __init__(self, payload: dict | None = None, status: int = 200,
                 text: str = "", boom: bool = False):
        self.payload = payload if payload is not None else _ok_payload()
        self.status = status
        self.text = text
        self.boom = boom
        self.calls: list[dict] = []

    async def post(self, url, **kw):
        self.calls.append({"url": url, "headers": kw.get("headers") or {},
                           "json": kw.get("json") or {}})
        if self.boom:
            raise httpx.ConnectError("假网关不可用")
        return _Resp(self.payload, self.status, self.text)

    async def aclose(self):
        return None


class _fake_client:
    """上下文管理器：临时把 asr 的上行客户端换成假身。"""

    def __init__(self, client: _Client):
        self.client = client

    def __enter__(self) -> _Client:
        self._old = asr._client
        asr._client = lambda: self.client
        return self.client

    def __exit__(self, *exc):
        asr._client = self._old
        return False


# ------------------------------------------------------------------ 纯函数层
def test_sniff_format_accepts_only_wav_mp3():
    assert asr.sniff_format(_wav(0.1)) == "wav"
    assert asr.sniff_format(_mp3()) == "mp3"
    assert asr.sniff_format(b"\xff\xfb\x90\x00" + b"\x00" * 16) == "mp3"  # MPEG 帧同步
    # 认不出的一律空串：文件名/MIME 都是客户端说了算的，不能信
    assert asr.sniff_format(b"OggS" + b"\x00" * 32) == ""
    assert asr.sniff_format(b"RIFF____AVI ") == ""
    assert asr.sniff_format(b"\x01\x02") == ""


def test_build_body_matches_official_contract():
    body = asr.build_body(_wav(0.1), "wav")
    assert body["model"] == asr.DEF_MODEL == "mimo-v2.5-asr"
    assert body["stream"] is False
    part = body["messages"][0]["content"][0]
    assert part["type"] == "input_audio"
    assert part["input_audio"]["format"] == "wav"
    assert part["input_audio"]["data"].startswith("data:audio/wav;base64,")
    assert body["asr_options"]["language"] == "zh"
    # mp3 走对应的 MIME
    assert asr.build_body(_mp3(), "mp3")["messages"][0]["content"][0][
        "input_audio"]["data"].startswith("data:audio/mpeg;base64,")


def test_language_and_gateway_fall_back_safely():
    old_lang, old_base, old_model = config.ASR_LANGUAGE, config.ASR_BASE_URL, config.ASR_MODEL
    try:
        config.ASR_LANGUAGE = "乱写"
        assert asr.language() == "auto"          # 不认的语种一律回落
        config.ASR_BASE_URL = ""
        config.ASR_MODEL = ""
        assert asr.base_url() == asr.DEF_BASE_URL
        assert asr.model() == asr.DEF_MODEL
    finally:
        config.ASR_LANGUAGE, config.ASR_BASE_URL, config.ASR_MODEL = old_lang, old_base, old_model


def test_available_uses_asr_key_then_tts_key():
    old_asr_key, old_tts_key, old_on = config.ASR_API_KEY, config.TTS_API_KEY, config.ASR_ENABLED
    try:
        config.ASR_API_KEY, config.TTS_API_KEY, config.ASR_ENABLED = "", "", True
        assert not asr.available()                    # 两把 Key 都没有 = 不可用
        config.TTS_API_KEY = "sk-tts"                 # 复用 TTS 的 Key
        assert asr.available() and asr.api_key() == "sk-tts"
        config.ASR_API_KEY = "sk-asr"                 # ASR 专用 Key 优先
        assert asr.api_key() == "sk-asr"
        config.ASR_ENABLED = False
        assert not asr.available()                    # 总开关关掉就彻底不可用
    finally:
        config.ASR_API_KEY, config.TTS_API_KEY, config.ASR_ENABLED = old_asr_key, old_tts_key, old_on


def test_transcribe_sends_audio_and_returns_text():
    wav = _wav(0.5)
    with _fake_client(_Client(payload=_ok_payload("  明天有机器人课  "))) as fake:
        text = asyncio.run(asr.transcribe(wav, caller="asr_test"))
    assert text == "明天有机器人课"                   # 首尾空白要收掉
    call = fake.calls[0]
    assert call["url"].endswith("/chat/completions")
    assert call["headers"]["api-key"] == asr.api_key()
    assert call["json"]["model"] == "mimo-v2.5-asr"


def test_transcribe_rejects_non_audio_before_calling_upstream():
    with _fake_client(_Client()) as fake:
        try:
            asyncio.run(asr.transcribe(b"not-audio" * 20))
            raise AssertionError("非音频应当抛 ASRError")
        except asr.ASRError:
            pass
    assert not fake.calls, "格式不对不该白跑一次上游"


def test_asr_error_keeps_upstream_status_for_classification():
    """状态码要留着：401/402/403 是账号层面，400/5xx 是这一段的音频/上游问题。"""
    for code, blocked in ((401, True), (402, True), (403, True),
                          (400, False), (413, False), (429, False), (500, False)):
        with _fake_client(_Client(status=code, text=f"code {code}")):
            try:
                asyncio.run(asr.transcribe(_wav(0.2)))
                raise AssertionError(f"{code} 应当抛 ASRError")
            except asr.ASRError as e:
                assert e.status == code, f"{code} -> {e.status}"
                assert asr.account_blocked(e) is blocked, f"{code} 分类错了"
    # 网络层失败没有状态码，归到"没听清"那一类（不是账号问题）
    with _fake_client(_Client(boom=True)):
        try:
            asyncio.run(asr.transcribe(_wav(0.2)))
        except asr.ASRError as e:
            assert e.status is None and not asr.account_blocked(e)


def test_transcribe_surfaces_upstream_status_and_never_fabricates():
    with _fake_client(_Client(status=401, text="invalid api key")):
        try:
            asyncio.run(asr.transcribe(_wav(0.2)))
            raise AssertionError("上游 401 应当抛 ASRError")
        except asr.ASRError as e:
            assert "401" in str(e)
    # 上游给了 200 但内容是空的（静音/纯噪声）：也必须算失败，不能当成"识别成功但没说话"
    with _fake_client(_Client(payload=_ok_payload(""))):
        try:
            asyncio.run(asr.transcribe(_wav(0.2)))
            raise AssertionError("空识别结果应当抛 ASRError")
        except asr.ASRError as e:
            assert "没识别出内容" in str(e)
    # 网关不可达
    with _fake_client(_Client(boom=True)):
        try:
            asyncio.run(asr.transcribe(_wav(0.2)))
            raise AssertionError("连不上应当抛 ASRError")
        except asr.ASRError as e:
            assert "ConnectError" in str(e)


def test_log_records_call_without_storing_transcript():
    LOG_FILE.unlink(missing_ok=True)
    with _fake_client(_Client(payload=_ok_payload("这是孩子的原话", seconds=3))):
        asyncio.run(asr.transcribe(_wav(0.2), caller="asr_test"))
    lines = [json.loads(x) for x in LOG_FILE.read_text(encoding="utf-8").splitlines() if x.strip()]
    rec = lines[-1]
    assert rec["protocol"] == "mimo-asr" and rec["kind"] == "asr" and rec["ok"] is True
    assert rec["model"] == "mimo-v2.5-asr" and rec["chars"] == len("这是孩子的原话")
    assert rec["audio_s"] == 3
    # 识别原文属于聊天记录，不该落进调用日志
    assert "这是孩子的原话" not in LOG_FILE.read_text(encoding="utf-8")


# ------------------------------------------------------------------ 端点层
async def _endpoint_scenario() -> None:
    transport = httpx.ASGITransport(app=app)
    old_key, old_bytes = config.ASR_API_KEY, config.ASR_MAX_BYTES
    fake = _Client(payload=_ok_payload("我明天想去遛熊猫"))
    config.ASR_API_KEY = "sk-test"
    async with httpx.AsyncClient(transport=transport, base_url="http://t", timeout=30) as client:
        r = await client.post("/api/auth/login", json={"username": CHILD, "password": "panda123"})
        assert r.status_code == 200, r.text
        child_h = {"Authorization": f"Bearer {r.json()['token']}"}
        r = await client.post("/api/auth/login", json={"username": PARENT, "password": "mama123"})
        assert r.status_code == 200, r.text
        parent_h = {"Authorization": f"Bearer {r.json()['token']}"}
        q = f"?name={CHILD}"

        with _fake_client(fake):
            # ① 状态端点：可用 + 上限秒数（前端据此写按钮提示与自动停止时间）
            r = await client.get(f"/api/asr{q}", headers=child_h)
            assert r.status_code == 200, r.text
            st = r.json()
            assert st["available"] is True and st["max_seconds"] == config.ASR_MAX_SECONDS
            assert st["language"] in asr.LANGUAGES

            # ② 正常一段录音 → 文本
            r = await client.post(f"/api/asr{q}", headers=child_h,
                                  files={"file": ("voice.wav", _wav(0.5), "audio/wav")})
            assert r.status_code == 200, r.text
            assert r.json()["text"] == "我明天想去遛熊猫"
            assert fake.calls and fake.calls[-1]["json"]["model"] == "mimo-v2.5-asr"

            # ③ 中间件不能拿 256KB 的 JSON 闸门卡录音：300KB 的 wav 要能进来
            big = _wav(10)          # 16000Hz*10s*2B ≈ 320KB > 256KB
            assert len(big) > 256_000
            r = await client.post(f"/api/asr{q}", headers=child_h,
                                  files={"file": ("voice.wav", big, "audio/wav")})
            assert r.status_code == 200, f"{r.status_code} {r.text[:120]}"

            # ④ 认不出的容器 → 415（在调上游之前拦掉）
            r = await client.post(f"/api/asr{q}", headers=child_h,
                                  files={"file": ("voice.webm", b"OggS" + b"\x00" * 400,
                                                  "audio/webm")})
            assert r.status_code == 415, f"{r.status_code} {r.text[:120]}"

            # ⑤ 空录音 → 400
            r = await client.post(f"/api/asr{q}", headers=child_h,
                                  files={"file": ("voice.wav", b"", "audio/wav")})
            assert r.status_code == 400, f"{r.status_code} {r.text[:120]}"

            # ⑥ 超过体积上限 → 413（不把超大音频读进内存）
            config.ASR_MAX_BYTES = 1000
            r = await client.post(f"/api/asr{q}", headers=child_h,
                                  files={"file": ("voice.wav", _wav(0.5), "audio/wav")})
            assert r.status_code == 413, f"{r.status_code} {r.text[:120]}"
            config.ASR_MAX_BYTES = old_bytes

            # ⑦ 上游失败要分两类：500 是"这次没听清"，401/402/403 是"账号用不了识别"
            with _fake_client(_Client(status=500, text="upstream blew up")):
                r = await client.post(f"/api/asr{q}", headers=child_h,
                                      files={"file": ("voice.wav", _wav(0.3), "audio/wav")})
            assert r.status_code == 502, r.text
            detail = r.json().get("detail", "")
            assert "没听清" in detail and "500" not in detail and "upstream" not in detail

            # 402 没余额：绝不能回"没听清"让孩子一遍遍重说（那不是他的问题）
            with _fake_client(_Client(status=402, text="Insufficient account balance")):
                r = await client.post(f"/api/asr{q}", headers=child_h,
                                      files={"file": ("voice.wav", _wav(0.3), "audio/wav")})
            assert r.status_code == 503, r.text
            d402 = r.json().get("detail", "")
            assert "还没开通" in d402 and "没听清" not in d402 and "402" not in d402

            # ⑧ 家长没有 chat 能力 → 403（语音输入也是发消息的一种）
            r = await client.post(f"/api/asr{q}", headers=parent_h,
                                  files={"file": ("voice.wav", _wav(0.3), "audio/wav")})
            assert r.status_code == 403, f"{r.status_code} {r.text[:120]}"

            # ⑨ 没带 token → 401
            r = await client.post(f"/api/asr{q}",
                                  files={"file": ("voice.wav", _wav(0.3), "audio/wav")})
            assert r.status_code == 401, f"{r.status_code} {r.text[:120]}"

            # ⑩ 服务端没配 Key → 503（如实说"还没开通"，而不是假装识别了一遍）
            saved = asr.available
            asr.available = lambda: False
            try:
                r = await client.post(f"/api/asr{q}", headers=child_h,
                                      files={"file": ("voice.wav", _wav(0.3), "audio/wav")})
                assert r.status_code == 503, f"{r.status_code} {r.text[:120]}"
                assert "还没开通" in r.json().get("detail", "")
            finally:
                asr.available = saved
    config.ASR_API_KEY = old_key


def test_api_asr_endpoint():
    asyncio.run(_endpoint_scenario())


def test_api_asr_rate_limited():
    """"按账号限频"要真的会限：把额度打到 1，第二次必须是 429。"""
    from server import main as _main

    old_max = config.ASR_MAX_PER_WINDOW
    old_hits = dict(_main._ASR_HITS)
    config.ASR_MAX_PER_WINDOW = 1
    _main._ASR_HITS.clear()
    try:
        assert _main._asr_throttle("someone") is True
        assert _main._asr_throttle("someone") is False
        assert _main._asr_throttle("another") is True   # 按账号分桶，互不影响
    finally:
        config.ASR_MAX_PER_WINDOW = old_max
        _main._ASR_HITS.clear()
        _main._ASR_HITS.update(old_hits)


async def _admin_selfcheck_scenario() -> None:
    """后台「测试识别」：成功时回报"念了什么/听回什么"，失败时把上游原文带回来。

    这是排查"孩子的语音输入怎么不工作"的入口：孩子端只会听到"没听清"，
    真正的原因（Key/额度/模型名）必须在这里看得见。
    """
    from server import tts

    transport = httpx.ASGITransport(app=app)
    old_key = config.ASR_API_KEY
    old_synth, old_tts_key = tts.synthesize, config.TTS_API_KEY
    old_tts_on = config.TTS_ENABLED      # 本文件为了离线把 TTS 关着，自检要用它造音频
    config.ASR_API_KEY, config.TTS_API_KEY, config.TTS_ENABLED = "sk-test", "sk-test", True

    async def fake_synthesize(body, **kw):
        return _mp3()          # 假 TTS：不联网也能造出"一段 mp3"

    tts.synthesize = fake_synthesize
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://t", timeout=30) as client:
            r = await client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
            admin_h = {"Authorization": f"Bearer {r.json()['token']}"}
            child = await client.post("/api/auth/login", json={"username": CHILD, "password": "panda123"})
            child_h = {"Authorization": f"Bearer {child.json()['token']}"}

            # ① 正常：TTS 造音频 → ASR 听回来
            with _fake_client(_Client(payload=_ok_payload("明天我想去上机器人课"))):
                r = await client.post("/api/admin/test/asr", headers=admin_h, json={})
            assert r.status_code == 200, r.text
            d = r.json()
            assert d.get("ok") is True, f"自检应当成功：{d}"
            assert d.get("text") == "明天我想去上机器人课", f"听回来的不对：{d}"
            assert d.get("spoken") and d.get("model") == "mimo-v2.5-asr", f"{d}"

            # ② 上游 402：后台必须看到原文（孩子端看到的只是"没听清"）
            with _fake_client(_Client(status=402, text="Insufficient account balance")):
                r = await client.post("/api/admin/test/asr", headers=admin_h, json={})
            d = r.json()
            assert d.get("ok") is False, f"{d}"
            assert "402" in d.get("error", "") and "balance" in d.get("error", ""), f"{d}"

            # ③ 只认 admin：孩子账号打这个端点要 403
            r = await client.post("/api/admin/test/asr", headers=child_h, json={})
            assert r.status_code == 403, f"{r.status_code} {r.text[:120]}"
    finally:
        tts.synthesize = old_synth
        config.ASR_API_KEY, config.TTS_API_KEY, config.TTS_ENABLED = old_key, old_tts_key, old_tts_on


def test_admin_asr_selfcheck():
    asyncio.run(_admin_selfcheck_scenario())


# ------------------------------------------------------------------ 直跑入口
def main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    passed, failed = 0, []
    for name, fn in tests:
        try:
            fn()
            passed += 1
            print(f"PASS  {name}")
        except Exception as e:  # noqa: BLE001
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"FAIL  {name}  {type(e).__name__}: {e}")
    print(f"\n{passed}/{len(tests)} 通过")
    shutil.rmtree(SANDBOX, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
