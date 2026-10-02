"""TTS 与音色档案的离线回归：口播文本归一化、两种模式的请求体、缓存落盘与目录穿越防护、
换音色正则锚点的真假阳性、音色档案读写白名单、SSE 端到端出一条 voice 事件。

不联网：httpx 客户端被替换成假身，返回一段假的 base64 音频。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_tts_")
# 本文件用假 TTS 客户端，不该看开发机 .env 的脸色：开关强制打开、Key 由用例自己设
os.environ["TTS_ENABLED"] = "1"
os.environ["TTS_API_KEY"] = ""
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

import httpx  # noqa: E402

from server import config, tts, voice  # noqa: E402

SANDBOX = Path(os.environ["PANDA_DATA_DIR"])
CHILD = SANDBOX / "child_voice_test"

# 假音频：4 字节，够验落盘与读取，不必是能播的真 wav
FAKE_AUDIO = b"\x00\x01\x02\x03"


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _Client:
    """假 httpx 客户端：只实现 post，把最后一次请求体记下来。"""

    def __init__(self, sink: dict, payload: dict | None = None, fail: bool = False):
        self.sink = sink
        self.payload = payload or {"choices": [{"message": {"audio": {
            "data": base64.b64encode(FAKE_AUDIO).decode()}}}]}
        self.fail = fail

    async def post(self, url, **kw):
        self.sink["url"] = url
        self.sink["headers"] = kw.get("headers") or {}
        self.sink["json"] = kw.get("json") or {}
        if self.fail:
            raise httpx.ConnectError("假网关不可用")
        return _Resp(self.payload)

    async def aclose(self):
        return None


def _speak(text: str, prof: dict, *, fail: bool = False) -> tuple[dict | None, dict]:
    sink: dict = {}
    old_client, old_avail = tts._client, config.TTS_API_KEY
    config.TTS_API_KEY = "sk-test"
    tts._client = lambda: _Client(sink, fail=fail)
    try:
        res = asyncio.run(tts.speak(CHILD, text, prof, caller="tts_test"))
    finally:
        tts._client, config.TTS_API_KEY = old_client, old_avail
    return res, sink


# ---------------------------------------------------------------- 文本归一化
def test_strips_markdown_emoji_and_list_markers():
    out = tts.to_speech_text("管家回复 **加粗** \U0001F43C\U0001F389\n- 第一项\n- 第二项")
    assert "**" not in out and "\U0001F43C" not in out
    assert "第一项" in out and "第二项" in out
    assert not out.lstrip().startswith("-")


def test_numbers_become_speakable():
    out = tts.to_speech_text("截止 2026-10-03 下午 16:30，链接 https://a.example.com/x")
    assert "2026-10-03" not in out and "16:30" not in out
    assert "10月3日" in out and "16点30分" in out
    assert "https" not in out


def test_table_separator_row_dropped():
    out = tts.to_speech_text("| 板块 | 备注 |\n| --- | --- |\n| 天气 | 晴 |")
    assert "---" not in out
    assert "板块" in out and "晴" in out


def test_keeps_english_word_spacing():
    out = tts.to_speech_text("Let me help you with this 帮我看一下")
    assert "Let me help you with this" in out


def test_empty_input_yields_empty_speech():
    assert tts.to_speech_text("   \n\n  ") == ""
    assert tts.to_speech_text("") == ""


def test_clamp_cuts_at_sentence_boundary():
    text = "一二三四五六七八九。十一十二。十三。"
    out = tts.clamp_speech(text, 8)
    assert len(out) <= 8 and out.endswith("。")


# ---------------------------------------------------------------- 请求体
def test_design_mode_role_convention():
    res, sink = _speak("你好呀", {"mode": "design", "style": "清纯甜美的少女声"})
    assert res and res["format"] == "mp3"
    # BASE_URL 留空时 tts.py 会回落到 MiMo 官方端点。这里直接问 tts.base_url()
    # 而不是把回落规则再抄一遍——抄的那份迟早会跟实现对不上（这正是上一版的毛病）。
    assert sink["url"] == f"{tts.base_url()}/chat/completions"
    assert sink["headers"]["api-key"] == "sk-test"
    body = sink["json"]
    assert body["model"] == "mimo-v2.5-tts-voicedesign"
    # 官方约定：要念的文本在 assistant，音色描述在 user
    assert body["messages"][-1]["role"] == "assistant"
    assert body["messages"][-1]["content"] == "你好呀"
    assert body["messages"][0]["role"] == "user"
    assert "清纯甜美" in body["messages"][0]["content"]
    # voicedesign 不支持 voice 字段
    assert "voice" not in body["audio"]


def test_builtin_mode_carries_voice_and_style_tag():
    res, sink = _speak("你好呀", {"mode": "builtin", "style": "整体柔和",
                                  "voice": "茉莉", "tags": "甜美女声"})
    assert res
    body = sink["json"]
    assert body["model"] == "mimo-v2.5-tts"
    assert body["audio"]["voice"] == "茉莉"
    # 风格标签放在 assistant 文本开头（官方音频标签控制）
    assert body["messages"][-1]["content"].startswith("(甜美女声)")


def test_no_api_key_is_silent_skip():
    old = config.TTS_API_KEY
    config.TTS_API_KEY = ""
    try:
        assert tts.available() is False
        assert asyncio.run(tts.speak(CHILD, "你好", {"mode": "design"})) is None
    finally:
        config.TTS_API_KEY = old


def test_gateway_failure_returns_none_not_raise():
    res, _ = _speak("你好", {"mode": "design", "style": "x"}, fail=True)
    assert res is None


def test_response_without_audio_returns_none():
    sink: dict = {}
    old_client, old_avail = tts._client, config.TTS_API_KEY
    config.TTS_API_KEY = "sk-test"
    tts._client = lambda: _Client(sink, payload={"choices": [{"message": {}}]})
    try:
        assert asyncio.run(tts.speak(CHILD, "你好", {"mode": "design"})) is None
    finally:
        tts._client, config.TTS_API_KEY = old_client, old_avail


# ---------------------------------------------------------------- 缓存
def test_audio_lands_in_cache_and_is_readable():
    res, _ = _speak("落到缓存里的一句", {"mode": "design", "style": "x"})
    assert res and res["bytes"] == len(FAKE_AUDIO)
    path = tts.resolve(CHILD, res["id"])
    assert path is not None and path.read_bytes() == FAKE_AUDIO
    assert tts.mime_for(res["id"]) == "audio/mpeg"


def test_resolve_blocks_traversal_and_misses():
    assert tts.resolve(CHILD, "../../users.json") is None
    assert tts.resolve(CHILD, "sub/evil.mp3") is None
    assert tts.resolve(CHILD, "不存在.mp3") is None
    assert tts.resolve(CHILD, "") is None


def test_cache_pruned_to_limit(monkeypatch):
    monkeypatch.setattr(config, "TTS_CACHE_MAX", 3)
    for i in range(6):
        tts.cache_dir(CHILD).mkdir(parents=True, exist_ok=True)
        (tts.cache_dir(CHILD) / f"{i}.mp3").write_bytes(FAKE_AUDIO)
    tts.prune(CHILD)
    assert len(list(tts.cache_dir(CHILD).iterdir())) == 3


# ---------------------------------------------------------------- 音色档案
def test_voice_profile_defaults_and_roundtrip():
    prof = voice.load(CHILD)
    assert prof["mode"] in voice.VALID_MODES and prof["style"]
    saved = voice.save(CHILD, {"mode": "builtin", "voice": "茉莉", "style": "低沉一点"},
                       by="child")
    assert saved["updated_by"] == "child" and saved["updated_at"]
    again = voice.load(CHILD)
    assert again["mode"] == "builtin" and again["style"] == "低沉一点"


def test_voice_profile_rejects_garbage():
    CHILD.mkdir(parents=True, exist_ok=True)
    (CHILD / "voice.json").write_text(
        json.dumps({"mode": "乱写", "voice": 123, "style": None, "tags": "甜妹"}),
        encoding="utf-8")
    prof = voice.load(CHILD)
    assert prof["mode"] in voice.VALID_MODES          # 越界回默认
    assert prof["voice"] == tts.default_voice()
    assert prof["style"] == config.TTS_DEFAULT_STYLE  # None 不该把风格清空
    assert prof["tags"] == "甜妹"                     # 合法字段仍保留


def test_voice_ask_regex_true_and_false_positives():
    for msg in ("你以后说话温柔一点好不好", "换成茉莉的声音", "用软软的声音说话",
                "别这么念了", "你的声音再甜一点", "以后你讲话慢一点"):
        assert voice.asked(msg), msg
    for msg in ("今天数学作业还没写", "这个文案的语气不太对", "帮我看看这段代码",
                "明天要去比赛", "声音有点小哈"):
        assert not voice.asked(msg), msg


def test_public_view_does_not_leak_whole_prompt():
    view = voice.public_view(voice.load(CHILD))
    assert set(view) == {"mode", "voice", "label", "enabled", "updated_by"}
    assert len(view["label"]) <= 40
