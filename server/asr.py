"""ASR：把孩子的一句话录音转成文字（小米 MiMo Speech Recognition / mimo-v2.5-asr）。

为什么不继续用浏览器自带的 Web Speech API（web/app.js 原来的做法）：
  1. Chrome/Edge 的 webkitSpeechRecognition 是把音频送到 Google 的语音服务，
     国内直连不通，实测一律 network / service-not-allowed —— 也就是"点了没反应"；
  2. Firefox / Safari 根本没实现这个接口，原来的代码会把麦克风按钮整个删掉；
  3. 它要求安全上下文（https 或 localhost），走局域网 IP 演示时连麦克风都拿不到。
改走服务端后只有两个前提：页面是 https（或 localhost），以及配了 Key——都与浏览器无关。

和小米 MiMo 的 TTS 同一个平台、同一把 Key（config.ASR_API_KEY 留空即复用 TTS_API_KEY），
但**不**复用 tts.py：请求体形状完全不同（TTS 用 audio 参数，ASR 用 input_audio 内容块），
认证失败/超时的处理也不同（识别失败要如实告诉孩子"没听清"，不能像语音那样静默跳过）。

官方约定（改这个文件前先回文档核对：/docs/zh-CN/api/audio/Speech-Recognition）：
  请求  POST {base}/chat/completions
        {"model": "mimo-v2.5-asr",
         "messages": [{"role": "user", "content": [
             {"type": "input_audio",
              "input_audio": {"data": "data:audio/wav;base64,...", "format": "wav"}}]}],
         "asr_options": {"language": "zh"}}
  响应  文本在 choices[0].message.content；usage.seconds 是音频时长
  限制  只收 mp3 / wav，base64 后不超过 10MB

降级原则：识别是输入方式的一种，失败要说人话（"没听清，再说一遍"），
绝不猜内容、绝不把空串当成功——否则孩子的输入框里会出现一段凭空捏造的话。
"""
from __future__ import annotations

import asyncio
import base64
import json
import time

import httpx

from . import config
from .llm import LOG_DIR

DEF_BASE_URL = "https://api.xiaomimimo.com/v1"
DEF_MODEL = "mimo-v2.5-asr"
DEF_LANGUAGE = "auto"
LANGUAGES = ("auto", "zh", "en")
# 上游只收这两种容器；认别的等于白跑一趟，所以在入口就按魔数判掉
FORMATS = ("wav", "mp3")
_MIME = {"wav": "audio/wav", "mp3": "audio/mpeg"}


class ASRError(RuntimeError):
    """识别失败。status 是上游 HTTP 码（网络层失败时为 None）。

    调用方靠它区分两种完全不同的失败：**账号/额度问题**（401 Key 不对、402 没余额、
    403 没权限）和**这一段没听清**（400/413/422 音频问题、5xx 上游抽风）。前者跟孩子
    的发音毫无关系，回一句"没听清，再说一遍"等于把平台的账算到孩子头上。
    """

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


# 这些码表示"这个账号现在用不了识别"，不是"这句话没听清"
ACCOUNT_STATUSES = (401, 402, 403)


def account_blocked(e: BaseException) -> bool:
    """这个失败是不是账号/额度层面的（而非音频层面的）。"""
    return isinstance(e, ASRError) and e.status in ACCOUNT_STATUSES


# ---------------------------------------------------------------- 配置
def api_key() -> str:
    """ASR 专用 Key 优先；没配就复用 TTS 的（同一个小米 MiMo 平台、同一把 Key）。"""
    return (config.ASR_API_KEY or config.TTS_API_KEY or "").strip()


def base_url() -> str:
    """后台配了就用配的，没配先跟 TTS 走同一个网关，再回落官方端点。"""
    return ((config.ASR_BASE_URL or config.TTS_BASE_URL or "").strip().rstrip("/")
            or DEF_BASE_URL)


def model() -> str:
    return (config.ASR_MODEL or "").strip() or DEF_MODEL


def language() -> str:
    """语种指令：不认的值一律回落 auto，绝不把乱写的字符串发给上游。"""
    lang = (config.ASR_LANGUAGE or DEF_LANGUAGE).strip().lower()
    return lang if lang in LANGUAGES else DEF_LANGUAGE


def available() -> bool:
    """开关打开且有 Key（ASR 自己的或 TTS 的）才算可用。"""
    return bool(config.ASR_ENABLED and api_key())


# ---------------------------------------------------------------- 音频与请求体
def sniff_format(data: bytes) -> str:
    """按魔数认容器，认不出返回空串。

    文件名和前端报上来的 MIME 都是不可信输入：客户端说 "voice.wav" 而内容是
    webm/opus 的话，上游会直接 400——那种失败在报错里看不出所以然，不如在入口拦。
    """
    if len(data) < 12:
        return ""
    if data[0:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[0:3] == b"ID3":              # 带 ID3 标签的 mp3
        return "mp3"
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:  # MPEG 帧同步头
        return "mp3"
    return ""


def build_body(data: bytes, fmt: str, lang: str | None = None) -> dict:
    """按官方约定拼请求体：音频走 data URL（format 与 MIME 一致）。"""
    mime = _MIME.get(fmt) or _MIME["wav"]
    return {
        "model": model(),
        "messages": [{"role": "user", "content": [
            {"type": "input_audio",
             "input_audio": {
                 "data": f"data:{mime};base64,{base64.b64encode(data).decode()}",
                 "format": fmt if fmt in _MIME else "wav",
             }},
        ]}],
        "asr_options": {"language": lang or language()},
        "stream": False,
    }


# ---------------------------------------------------------------- 客户端
# 与 tts.py / llm.py 同一套"按事件循环复用一个带连接池的 httpx 客户端"的做法
_CLIENTS: dict[asyncio.AbstractEventLoop, httpx.AsyncClient] = {}


def _client() -> httpx.AsyncClient:
    loop = asyncio.get_running_loop()
    c = _CLIENTS.get(loop)
    if c is None or c.is_closed:
        c = httpx.AsyncClient(
            timeout=config.ASR_TIMEOUT,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        )
        _CLIENTS[loop] = c
    return c


async def close_clients() -> None:
    """服务关闭时收池（main.py 的 lifespan 里调用）。"""
    for c in _CLIENTS.values():
        try:
            await c.aclose()
        except Exception:  # noqa: BLE001 关池失败不挡退出
            pass
    _CLIENTS.clear()


def _err_text(e: BaseException) -> str:
    """异常 → 留痕文案。httpx 的超时/断连异常 str() 是空串，得补上类名。"""
    msg = str(e).strip()
    return f"{type(e).__name__}: {msg}" if msg else type(e).__name__


def _log(caller: str, ok: bool, ms: float, err: str = "", *, model_name: str = "",
         seconds: float | None = None, chars: int | None = None) -> None:
    """识别也留痕到 llm_calls.jsonl（protocol=mimo-asr）：评委在 /api/logs 能看到真调用。

    只记时长和字数，不记识别出的原文——那段话该待的地方是聊天记录，不是日志文件。
    """
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        rec = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "caller": caller,
            "kind": "asr",
            "protocol": "mimo-asr",
            "model": model_name,
            "ms": round(ms),
            "ok": ok,
        }
        if seconds:
            rec["audio_s"] = round(float(seconds), 1)
        if chars is not None:
            rec["chars"] = chars
        if err:
            rec["err"] = err[:200]
        with open(LOG_DIR / "llm_calls.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------- 识别
async def transcribe(data: bytes, *, caller: str = "voice_input") -> str:
    """一段录音 → 文本；失败抛 ASRError（带上游原因，并已留痕）。

    调用方要先自己 sniff_format 并给出 415（格式不对是调用方的问题，
    不该混进"上游失败"里）；这里再兜一道，防止别的调用方漏判。
    """
    fmt = sniff_format(data)
    if not fmt:
        raise ASRError("只听 wav / mp3 的录音")
    body = build_body(data, fmt)
    name = model()
    t0 = time.monotonic()
    seconds: float | None = None
    text = ""
    try:
        resp = await _client().post(
            f"{base_url()}/chat/completions",
            # 官方给了 api-key 与 Bearer 两种认证；同一个 Key 两种都带上，
            # 换网关实现时不会因为只认一种而 401
            headers={
                "api-key": api_key(),
                "Authorization": f"Bearer {api_key()}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            # 上游报错原文（Key 无效/没余额/音频超限）留给 /api/logs 与后台自检排查用
            raise ASRError(f"HTTP {e.response.status_code}：{e.response.text[:200]}",
                           status=e.response.status_code) from e
        payload = resp.json()
        choices = payload.get("choices") or []
        message = (choices[0].get("message") or {}) if choices else {}
        text = str(message.get("content") or "").strip()
        usage = payload.get("usage") or {}
        if usage.get("seconds"):
            seconds = float(usage["seconds"])
        if not text:
            raise ASRError("上游没识别出内容（可能是静音或纯噪声）")
    except Exception as e:  # noqa: BLE001
        _log(caller, False, (time.monotonic() - t0) * 1000, _err_text(e),
             model_name=name, seconds=seconds)
        raise e if isinstance(e, ASRError) else ASRError(_err_text(e)) from e
    _log(caller, True, (time.monotonic() - t0) * 1000, model_name=name,
         seconds=seconds, chars=len(text))
    return text
