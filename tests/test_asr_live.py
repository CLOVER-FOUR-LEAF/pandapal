"""语音识别真链路自检（会花钱、会联网）：用项目自己的 TTS 念一句话，
再把这段音频喂给 ASR 转写，比对转写结果。

为什么要有这个文件：离线回归（test_asr.py）用的是假客户端，只能证明"我们按官方
文档拼了请求体"，证明不了"这把 Key + 这个网关真的认这套请求体"。上线/演示前跑一次
这个，三十秒就能确认：TTS 能出声 → 同一把 Key 的 ASR 也能听回来。

用法：
    .venv/bin/python tests/test_asr_live.py          # 没配 Key 会直接跳过，不算失败
    ASR_API_KEY=xxx .venv/bin/python tests/test_asr_live.py

Key 取法与线上完全一致（config.ASR_API_KEY 留空即复用 TTS_API_KEY），
所以这里不需要额外配置——TTS 能出声，这个自检就能跑。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import asr, config, tts  # noqa: E402

SENTENCE = "明天我想去上机器人课"


def _overlap(a: str, b: str) -> float:
    """两句话的汉字重合度：ASR 不会 100% 逐字一致（可能加标点或漏虚词），
    用集合重合率判断"听回来的确实是这句话"就够了。"""
    sa = {c for c in a if "\u4e00" <= c <= "\u9fff"}
    sb = {c for c in b if "\u4e00" <= c <= "\u9fff"}
    if not sa:
        return 0.0
    return len(sa & sb) / len(sa)


async def main() -> int:
    if not asr.available():
        print("跳过：没配 TTS_API_KEY / ASR_API_KEY（或 ASR_ENABLED=0），真链路自检需要真 Key")
        return 0
    print(f"ASR 网关：{asr.base_url()}  模型：{asr.model()}  语种：{asr.language()}")
    print(f"TTS 网关：{tts.base_url()}  模型：{tts.model_for(config.TTS_DEFAULT_MODE)}")

    if not tts.available():
        print("失败：ASR 可用但 TTS 不可用——本自检用 TTS 造音频，两个都配上才能跑")
        return 1

    model, body = tts.build_body(SENTENCE, {"mode": config.TTS_DEFAULT_MODE})
    body["model"] = model
    try:
        audio = await tts.synthesize(body, caller="asr_live_tts")
    except Exception as e:  # noqa: BLE001
        print(f"失败：TTS 没合成出音频：{e}")
        return 1
    print(f"TTS 合成成功：{len(audio)} 字节，容器识别为 {asr.sniff_format(audio) or '（认不出）'}")

    fmt = asr.sniff_format(audio)
    if not fmt:
        print("失败：TTS 产出的容器不是 wav/mp3，ASR 上游不会收——检查 TTS_FORMAT 配置")
        return 1

    try:
        text = await asr.transcribe(audio, caller="asr_live_check")
    except Exception as e:  # noqa: BLE001
        print(f"失败：ASR 没识别出内容：{e}")
        print("排查顺序：")
        print("  1) 402 Insufficient account balance → 账号没有识别额度。")
        print("     注意 TTS 能出声 ≠ ASR 有额度：实测同一把 Key 下 TTS 返回 200、ASR 返回 402，")
        print("     需要在 platform.xiaomimimo.com 充值/开通后才能识别。")
        print("  2) 401 / 403 → Key 无效或没权限；换 Key 或检查 ASR_API_KEY。")
        print("  3) 404 / 400 → ASR_MODEL 或 ASR_BASE_URL 写错了（默认应是 mimo-v2.5-asr）。")
        print("  4) 连接层报错（ConnectError/Timeout）→ 网关被拦或网络不通。")
        return 1

    rate = _overlap(SENTENCE, text)
    print(f"原句：{SENTENCE}")
    print(f"转写：{text}")
    print(f"汉字重合度：{rate:.0%}")
    if rate < 0.5:
        print("失败：转写和原句对不上（Key 可能是别家网关的，或语种/模型配错了）")
        return 1
    print("\n真链路通过：TTS 出的音频，ASR 听回来了。")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
