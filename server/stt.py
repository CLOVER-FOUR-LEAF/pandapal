"""语音识别（ASR）：浏览器 SpeechRecognition 不可用时的服务端兜底。

为什么需要这条链：前端优先用浏览器原生 SpeechRecognition（免上传、逐字
上屏），但它在两个常见场景里是坏的——Chrome 的识别走 Google 服务器
（国内网络必报 network），Firefox 干脆没实现这个 API。这条链把录音直接
传给 MiMo ASR，任何支持 getUserMedia 的浏览器都能用。

复用 TTS 的 MiMo 配置（TTS_API_KEY / TTS_BASE_URL / 连接池 / 留痕），
配过 TTS 的部署零成本获得识别能力——所以这里只看 Key 在不在，
TTS_ENABLED 是"朗读"开关，不该连带把"听"也关掉。

官方约定（改动前先回文档核对）：
  - 音频走 messages[].content[] 里的 {"type":"input_audio","input_audio":{...}}
  - data 是 data URL："data:{mime};base64,{...}"；format 与 MIME 取值要一致
  - ASR 只收 mp3/wav（前端统一录成 wav 上传，见 web/app.js 的 PCM→WAV 编码）
  - 识别文本在 choices[0].message.content
"""
from __future__ import annotations

import base64
import time

import httpx

from . import config, tts

DEF_MODEL_ASR = "mimo-v2.5-asr"
# 单次录音上限：16kHz 单声道 WAV ≈ 32KB/s，12MB 约等于 6 分钟，远超实际用例；
# 主要防的是有人拿这条公开端点刷上传流量
MAX_BYTES = 12 * 1024 * 1024

_ASR_MIMES = {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"}


class STTError(RuntimeError):
    pass


def available() -> bool:
    """与 TTS 同一把 Key：配了 TTS_API_KEY 就有识别能力。"""
    return bool(config.TTS_API_KEY.strip())


def model_name() -> str:
    return (config.TTS_MODEL_ASR or "").strip() or DEF_MODEL_ASR


async def transcribe(audio: bytes, mime: str = "audio/wav", *,
                     language: str = "zh", caller: str = "asr_mic") -> str:
    """一段音频 → 识别文本。失败抛 STTError（带上游原因，并已留痕）。"""
    if not available():
        raise STTError("服务端没配语音 Key（TTS_API_KEY）")
    # 非白名单 MIME 统一按 wav 处理（前端编码产物就是 wav）
    if mime not in _ASR_MIMES:
        mime = "audio/wav"
    fmt = "mp3" if mime in ("audio/mpeg", "audio/mp3") else "wav"
    b64 = base64.b64encode(audio).decode()
    model = model_name()
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [{
            "type": "input_audio",
            "input_audio": {"data": f"data:{mime};base64,{b64}", "format": fmt},
        }]}],
        "asr_options": {"language": language},
    }
    t0 = time.monotonic()
    try:
        resp = await tts._client().post(
            f"{tts.base_url()}/chat/completions",
            # 与 tts.synthesize 同一套认证头：api-key + Bearer 都带上
            headers={
                "api-key": config.TTS_API_KEY,
                "Authorization": f"Bearer {config.TTS_API_KEY}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise STTError(f"HTTP {e.response.status_code}：{e.response.text[:200]}") from e
        text = str(resp.json()["choices"][0]["message"].get("content") or "").strip()
    except Exception as e:  # noqa: BLE001
        tts._log(caller, False, (time.monotonic() - t0) * 1000, str(e), model, kind="asr")
        raise e if isinstance(e, STTError) else STTError(str(e) or type(e).__name__) from e
    tts._log(caller, True, (time.monotonic() - t0) * 1000, model=model, kind="asr")
    return text
