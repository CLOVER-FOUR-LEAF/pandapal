"""管家音色档案：data/{child}/voice.json。

这是"音色后期能改"的落点。孩子直接跟管家说"你以后说话温柔点""换个甜妹音"，
由管家自己把这句话扩写成一段完整的音色描述存进档案，之后每次合成都拿它当
音色指令——不需要用户去懂 TTS 参数。

两种模式（voice.json 的 mode 字段）：
  design  —— mimo-v2.5-tts-voicedesign，style 字段就是音色描述提示词本身。
             音色由文字生成，最贴合"清纯甜美女音"这种描述性需求。
  builtin —— mimo-v2.5-tts，voice 选内置音色（茉莉/冰糖/苏打/白桦…），
             style 当整体风格指令，tags 当 (风格标签) 前缀。只有它有真流式。

为什么用确定性正则而不是新增一个 router intent：音色偏好不是"任务类别"，
而是对话里的一句插入语。加进 ROUTER 分类体系会让所有闲聊的分类都多一分
误判风险；正则锚点和项目里既有的 _ACTION_ANCHOR / _DRAFT_ASK 是同一套路。
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from . import config, llm, prompts, store, tts

VOICE_FILENAME = "voice.json"
VALID_MODES = ("design", "builtin")
# 内置音色全集（官方音色表）：中文 冰糖/茉莉（女）、苏打/白桦（男）
BUILTIN_VOICES = ("冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean",
                  "mimo_default")

# 孩子表达"想换音色/改说话方式"的句式。动词必须挨着音色词，避免把
# "这个文案的语气不对"这类内容讨论误判成音色请求。
_VOICE_ASK = re.compile(
    # 换/改/变 + 音色词：换声音、改音色、变个语调
    r"(?:换|改|变)(?:个|种|一下|一换)?(?:声音|音色|嗓音|嗓子|语调|语气|腔调|口音)"
    # 以后…说话…（后接性格/快慢类形容词）
    r"|以后(?:你)?(?:说话|讲话|念|读|讲).{0,14}(?:温柔|甜|轻|软|慢|快|奶|低|沙|哑|活泼|可爱|腻|凶|嗲)"
    # 形容词 + 一点/一些
    r"|(?:温柔|甜|软|奶|可爱|活泼|磁性|沙哑|低沉|清亮|甜美女声|淑女|御姐|少年音)"
    r"(?:的)?(?:声音|嗓音)?(?:再|更|太|有点|一些|一点|点儿)"
    # 用…的声音说话
    r"|用.{0,12}(?:声音|嗓音|音色)说话"
    # 直接评价音色。"有点"后面必须跟性格词，否则"声音有点小"（说的是音量）会被误判
    r"|(?:你的)?(?:声音|音色|嗓音)(?:太|再|好难听|不好听|甜|温柔|可爱|奶|沙|低"
    r"|有点(?:太|很|挺)?(?:甜|温柔|软|奶|可爱|沙|低|凶|嗲|腻|清亮|磁性))"
    # 别这么说话
    r"|别(?:这么|再)(?:说话|念|读)"
    # 换/改 + 声音
    r"|(?:换|改)(?:成|成)个?.{0,4}(?:音|声)"
)


def defaults() -> dict:
    """未配置时的默认音色：清纯甜美女声。"""
    return {
        "mode": config.TTS_DEFAULT_MODE if config.TTS_DEFAULT_MODE in VALID_MODES else "design",
        "voice": tts.default_voice(),
        "style": config.TTS_DEFAULT_STYLE,
        "tags": config.TTS_DEFAULT_TAGS,
        "enabled": True,
        "updated_at": "",
        "updated_by": "env",
    }


def _normalize(raw: dict) -> dict:
    """档案读出来先过一遍白名单：只认认识的键，mode/voice 越界回默认。"""
    prof = defaults()
    if not isinstance(raw, dict):
        return prof
    mode = str(raw.get("mode") or "").lower()
    if mode in VALID_MODES:
        prof["mode"] = mode
    # voice 必须是官方内置音色之一（或部署方自己指定的那个），
    # 别的值（数字、乱写的字符串）一律丢弃——它是原样发给 TTS 的，不能放行
    voice_id = str(raw.get("voice") or "").strip()
    if voice_id in BUILTIN_VOICES or voice_id == tts.default_voice():
        prof["voice"] = voice_id
    style = str(raw.get("style") or "").strip()
    if style:
        prof["style"] = style
    prof["tags"] = str(raw.get("tags") or "").strip()
    prof["enabled"] = bool(raw.get("enabled", True))
    prof["updated_at"] = str(raw.get("updated_at") or "")
    prof["updated_by"] = str(raw.get("updated_by") or "env")
    return prof


def load(child_dir: Path) -> dict:
    """读档案；没有就给默认（首次对话前不写盘，等真的改过才落文件）。"""
    return _normalize(store.read_json(Path(child_dir) / VOICE_FILENAME, {}))


def save(child_dir: Path, patch: dict, *, by: str = "child") -> dict:
    """合并写入并落盘（原子写 + 目录写锁，与事务档案同一套）。"""
    cur = load(child_dir)
    cur.update({k: v for k, v in (patch or {}).items() if v is not None})
    cur = _normalize(cur)
    cur["updated_at"] = datetime.now().isoformat(timespec="seconds")
    cur["updated_by"] = by
    store.write_json(Path(child_dir) / VOICE_FILENAME, cur)
    return cur


def public_view(prof: dict) -> dict:
    """给前端的精简视图：只回"现在是什么声音"，不把整段提示词倒给客户端。"""
    mode = prof.get("mode") or "design"
    if mode == "builtin":
        label = f"内置音色 {prof.get('voice')}"
    else:
        label = (str(prof.get("style") or "").strip() or config.TTS_DEFAULT_STYLE)[:40]
    return {
        "mode": mode,
        "voice": prof.get("voice"),
        "label": label,
        "enabled": bool(prof.get("enabled", True)),
        "updated_by": prof.get("updated_by", "env"),
    }


def asked(message: str) -> bool:
    """这句话是不是在要求换音色。"""
    return bool(_VOICE_ASK.search(message or ""))


def _pick_mode(data: dict, message: str) -> tuple[str, str]:
    """定 mode 与内置音色。

    用户直接点名了某个内置音色（"换成茉莉"）就照办走 builtin——这时候
    再让 voicedesign 自己设计音色等于没听见。
    """
    named = next((v for v in BUILTIN_VOICES if v in (message or "")), "")
    model_mode = str(data.get("mode") or "design").lower()
    if named:
        return "builtin", named
    if model_mode in VALID_MODES:
        return model_mode, ""
    return "design", ""


async def reconfigure(sess, message: str) -> tuple[dict, str] | None:
    """把孩子的口语音色需求扩写成完整提示词并落档。

    返回 (新档案, 注入聊天人设的规则)；扩写失败或没给出可用描述时返回 None
    ——调用方据此让对话照常走，不把一次失败变成一次报错。
    """
    cur = load(sess.dir)
    try:
        data = await llm.complete_json(
            [{"role": "system", "content": "你是音色设计模块，只输出 JSON。"},
             {"role": "user", "content": prompts.VOICE_DESIGN.format(
                 current_mode=cur.get("mode", "design"),
                 current_voice=cur.get("voice", tts.default_voice()),
                 current_style=cur.get("style") or "（无）",
                 message=message)}],
            max_tokens=800, caller="voice_design")
    except Exception as e:  # noqa: BLE001 扩写失败不挡对话
        print(f"[voice] 音色扩写失败：{e}")
        return None

    style = str(data.get("style") or "").strip()
    if len(style) < 4:
        return None
    mode, named = _pick_mode(data, message)
    voice = named or str(data.get("voice") or tts.default_voice()).strip()
    if voice not in BUILTIN_VOICES:
        voice = tts.default_voice()
    # tags 是 builtin 模式专属的 (风格标签) 前缀，design 模式下留着只会误导
    tags = str(data.get("tags") or "").strip() if mode == "builtin" else ""
    prof = save(sess.dir, {"mode": mode, "style": style, "voice": voice, "tags": tags},
                by="child")
    confirm = str(data.get("confirm") or "").strip() or "好呀，我换过来啦。"
    return prof, prompts.VOICE_CHANGED_RULE.format(confirm=confirm)
