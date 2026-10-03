"""配置加载：优先环境变量，其次仓库根目录 .env 文件。"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"


def _load_dotenv() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

# 数据目录可被环境变量覆盖（测试/沙箱跑在副本上，不污染演示档案）
DATA_DIR = Path(os.getenv("PANDA_DATA_DIR") or ROOT / "data")

LLM_PROTOCOL = os.getenv("LLM_PROTOCOL", "openai").lower()  # openai | anthropic
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_KEY2 = os.getenv("LLM_API_KEY2", "")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-chat")
# 推理型模型（deepseek-flash/v4-pro 等）可用的推理档位：low|high|max；留空则不传参
LLM_REASONING_EFFORT = os.getenv("LLM_REASONING_EFFORT", "")

# 异构兜底端点：配上 LLM_API_KEY3 才启用。备用 Key（LLM_API_KEY2）和主 Key
# 共享同一个服务商——防得住限流、防不住服务商整体抖动；兜底端点允许指向
# 另一家服务商/另一个模型，主端点连不上时自动切换。URL/模型/协议留空时
# 分别回落到主端点的值（只换 Key 也是合法兜底）。
LLM_API_KEY3 = os.getenv("LLM_API_KEY3", "")
LLM_BASE_URL2 = os.getenv("LLM_BASE_URL2", "").rstrip("/")
LLM_MODEL2 = os.getenv("LLM_MODEL2", "")
LLM_PROTOCOL2 = os.getenv("LLM_PROTOCOL2", "").strip().lower()

# 视觉能力开关：auto（默认）表示"先当能看图，被 provider 拒绝后自动降级并如实告诉孩子"；
# off 表示明确知道当前模型看不了图（如 deepseek-chat），一开始就不带图、直接说清楚，
# 省掉一次必然失败的请求；on 表示强制按视觉模型处理。
LLM_VISION = os.getenv("LLM_VISION", "auto").strip().lower()


def vision_enabled() -> bool:
    """当前模型是否应该尝试带图。默认 auto=尝试（配置错误由 llm 层降级兜住）。"""
    return LLM_VISION not in ("0", "off", "false", "no", "never", "none")


SEARCH_API_KEY = os.getenv("SEARCH_API_KEY", "")
SEARCH_BASE_URL = os.getenv("SEARCH_BASE_URL", "").rstrip("/")

# 语音合成 TTS。四个基础键在后台「API 配置」里可改（见 SETTINGS_KEYS），
# 留空时回落到下面的 MiMo 默认值——也就是说"不填也能跑"，填了则以填的为准。
TTS_API_KEY = os.getenv("TTS_API_KEY", "")
TTS_BASE_URL = os.getenv("TTS_BASE_URL", "").rstrip("/")
TTS_MODEL = os.getenv("TTS_MODEL", "")
TTS_VOICE = os.getenv("TTS_VOICE", "")
# 下面这些是本项目的调音台，默认值都写在代码里，一般不用动；
# 需要在后台改的已加进 SETTINGS_KEYS。
TTS_ENABLED = os.getenv("TTS_ENABLED", "1") not in ("0", "false", "False", "")
# design = voicedesign（用文字描述生成音色，voice.json 里的 style 就是提示词）；
# builtin = 内置音色 + 风格指令（只有它支持真流式）。留空按 design。
TTS_DEFAULT_MODE = os.getenv("TTS_DEFAULT_MODE", "design").lower()
# 两个模式各对应一个模型：TTS_MODEL 管内置音色，TTS_MODEL_DESIGN 管音色设计。
# 分开是因为官方就是两个模型，且只有前者有真流式；填错模式会静默降级成默认音色。
TTS_MODEL_DESIGN = os.getenv("TTS_MODEL_DESIGN", "")
# 音色描述：voicedesign 模式下这就是喂给音色设计模型的提示词
TTS_DEFAULT_STYLE = os.getenv("TTS_DEFAULT_STYLE", "") or (
    "一个清纯甜美的少女声。年龄感二十岁上下，声线清亮干净、不沙不哑，"
    "像刚下课后跟熟悉的小朋友说话。语速稍快一点，语气轻快、亲切、有一点雀跃，"
    "但不撒娇也不做作。咬字清晰，句尾自然收住，不要拖长音。")
TTS_DEFAULT_TAGS = os.getenv("TTS_DEFAULT_TAGS", "")
# 语音识别模型（麦克风走服务端兜底时用）：与合成同一端点同一把 Key。
# 留空回落 stt.DEF_MODEL_ASR（mimo-v2.5-asr）。
TTS_MODEL_ASR = os.getenv("TTS_MODEL_ASR", "")
# 输出容器：mp3 体积约为 wav 的 1/10（24kHz 单声道 wav 每秒 48KB），本地场景够用；
# 真遇到某个浏览器解不了，填 wav 即可（官方 API 的默认值）。
TTS_FORMAT = os.getenv("TTS_FORMAT", "mp3").lower()
# 让 TTS 自己润色口播稿（仅 voicedesign 支持）。默认关：我们要念的就是孩子
# 刚看到的那段字，润色会让"看到的"和"听到的"对不上。
TTS_OPTIMIZE_TEXT = os.getenv("TTS_OPTIMIZE_TEXT", "0") not in ("0", "false", "False", "")
# 单次口播的字数上限。归一化后仍超长就在最近的句号处收尾——
# 超过这个量级读下去孩子早就不听了，截断比整段念完更体面。
TTS_MAX_CHARS = int(os.getenv("TTS_MAX_CHARS", "400"))
# 卡片类回复（规划/拆解）只念一句引导稿，不念整张方案卡
TTS_CARD_MAX_CHARS = int(os.getenv("TTS_CARD_MAX_CHARS", "120"))
# 各场景口播开关
TTS_SPEAK_CARD = os.getenv("TTS_SPEAK_CARD", "1") not in ("0", "false", "False", "")
TTS_SPEAK_GREETING = os.getenv("TTS_SPEAK_GREETING", "1") not in ("0", "false", "False", "")
TTS_SPEAK_BRIEFING = os.getenv("TTS_SPEAK_BRIEFING", "1") not in ("0", "false", "False", "")
# 语音缓存：每个档案目录下 voice_cache/，超过上限按最旧淘汰（磁盘有硬顶）
TTS_CACHE_MAX = int(os.getenv("TTS_CACHE_MAX", "60"))
# 试音文案：点开朗读开关时立刻念这一句，让用户当场听见效果
TTS_PREVIEW_TEXT = os.getenv("TTS_PREVIEW_TEXT", "好，我在。点一下这个喇叭，我就会说话了。")
TTS_PREVIEW_MAX_CHARS = int(os.getenv("TTS_PREVIEW_MAX_CHARS", "40"))
# 单次语音合成超时（秒）。比 LLM 短得多：TTS 正常 1-8 秒出结果，
# 超时基本等于网关抽风，早失败好过把 SSE 吊在那儿。
TTS_TIMEOUT = float(os.getenv("TTS_TIMEOUT", "30"))

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# 单次 LLM 调用的超时（秒）。历史留痕里 synth 的最慢一次是 52.6s、extract_graph
# 已经撞过一次 60s——原来 60 的上限几乎等于"正常调用随时可能被杀"。调到 90 是
# 给正常波动留余量；真正挂死的调用由 main 的降级链兜底，不会拖成无底洞。
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "90"))
TOOL_TIMEOUT = float(os.getenv("TOOL_TIMEOUT", "10"))
HISTORY_TAIL = int(os.getenv("HISTORY_TAIL", "8"))
# 会话闲置回收：超过这么久没来消息的会话释放内存（历史已落盘，再登录照常恢复）
SESSION_IDLE_S = float(os.getenv("PANDA_SESSION_IDLE", "1800"))

# ---------------------------------------------------------------- 后台运行时配置
# data/settings.json：管理员在后台改的 Key/端点，优先级高于 .env 与环境变量；
# 写入后调 apply_settings() 立即生效，不用重启。密钥只落这个文件（已在 .gitignore）。

SETTINGS_PATH = DATA_DIR / "settings.json"

def _as_bool(v) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() not in ("0", "false", "off", "no", "")


def _as_int(v, default: int) -> int:
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


def _one_of(*allowed: str):
    """枚举值归一化：只认白名单里的（大小写不敏感），其余抛错。

    抛错是故意的——apply_settings 会跳过非法值并保留基线，比悄悄存一个
    "MP4" 进去、然后 TTS 那边拿着它去请求、最后报一个看不懂的错要好。
    主要兜 settings.json 被手改的场景（API 写入在 admin 层还有一道校验）。
    """
    def norm(v):
        s = str(v).strip().lower()
        if s not in allowed:
            raise ValueError(f"只能是 {'/'.join(allowed)}，收到 {v!r}")
        return s
    return norm


# 可在后台编辑的键 → （本模块属性名, 归一化函数, 是否密钥）。不在表里的键一律不收。
SETTINGS_KEYS: dict[str, tuple[str, object, bool]] = {
    "LLM_PROTOCOL": ("LLM_PROTOCOL", lambda v: str(v).strip().lower(), False),
    "LLM_BASE_URL": ("LLM_BASE_URL", lambda v: str(v).strip().rstrip("/"), False),
    "LLM_API_KEY": ("LLM_API_KEY", lambda v: str(v).strip(), True),
    "LLM_API_KEY2": ("LLM_API_KEY2", lambda v: str(v).strip(), True),
    # 异构兜底：LLM_API_KEY3 配上才启用；URL/模型/协议留空回落主端点的值
    "LLM_API_KEY3": ("LLM_API_KEY3", lambda v: str(v).strip(), True),
    "LLM_BASE_URL2": ("LLM_BASE_URL2", lambda v: str(v).strip().rstrip("/"), False),
    "LLM_MODEL2": ("LLM_MODEL2", lambda v: str(v).strip(), False),
    "LLM_PROTOCOL2": ("LLM_PROTOCOL2", lambda v: str(v).strip().lower(), False),
    "LLM_MODEL": ("LLM_MODEL", lambda v: str(v).strip(), False),
    "LLM_REASONING_EFFORT": ("LLM_REASONING_EFFORT", lambda v: str(v).strip().lower(), False),
    # 视觉能力：auto/on/off，后台可以直接切（用非视觉模型时提前关掉，省一次注定失败的请求）
    "LLM_VISION": ("LLM_VISION", lambda v: str(v).strip().lower(), False),
    "SEARCH_API_KEY": ("SEARCH_API_KEY", lambda v: str(v).strip(), True),
    "SEARCH_BASE_URL": ("SEARCH_BASE_URL", lambda v: str(v).strip().rstrip("/"), False),
    "TTS_API_KEY": ("TTS_API_KEY", lambda v: str(v).strip(), True),
    "TTS_BASE_URL": ("TTS_BASE_URL", lambda v: str(v).strip().rstrip("/"), False),
    "TTS_MODEL": ("TTS_MODEL", lambda v: str(v).strip(), False),
    "TTS_MODEL_DESIGN": ("TTS_MODEL_DESIGN", lambda v: str(v).strip(), False),
    "TTS_MODEL_ASR": ("TTS_MODEL_ASR", lambda v: str(v).strip(), False),
    "TTS_VOICE": ("TTS_VOICE", lambda v: str(v).strip(), False),
    # 开关必须归一成 bool：存成字符串 "0" 时 `if config.TTS_ENABLED` 永远为真，后台关不掉
    "TTS_ENABLED": ("TTS_ENABLED", lambda v: _as_bool(v), False),
    "TTS_DEFAULT_MODE": ("TTS_DEFAULT_MODE", _one_of("design", "builtin"), False),
    "TTS_DEFAULT_STYLE": ("TTS_DEFAULT_STYLE", lambda v: str(v).strip(), False),
    "TTS_FORMAT": ("TTS_FORMAT", _one_of("mp3", "wav"), False),
    "TTS_MAX_CHARS": ("TTS_MAX_CHARS", lambda v: _as_int(v, 400), False),
    "TTS_CARD_MAX_CHARS": ("TTS_CARD_MAX_CHARS", lambda v: _as_int(v, 120), False),
    # 三个口播开关：后台最常想拨的就是这几项（缓存上限/试音文案仍留在 .env）
    "TTS_SPEAK_GREETING": ("TTS_SPEAK_GREETING", lambda v: _as_bool(v), False),
    "TTS_SPEAK_BRIEFING": ("TTS_SPEAK_BRIEFING", lambda v: _as_bool(v), False),
    "TTS_SPEAK_CARD": ("TTS_SPEAK_CARD", lambda v: _as_bool(v), False),
}


def _read_overrides() -> dict:
    try:
        import json
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# 环境变量/.env 决定的基线值：取消覆盖时要能回落到这里，而不是留在旧覆盖值上
_BASELINE = {attr: globals()[attr] for attr, *_ in SETTINGS_KEYS.values()}


def apply_settings() -> dict:
    """把 settings.json 覆盖到本模块属性上（module 属性是运行时读取的，改了就生效）。

    先复位到 env 基线再叠覆盖，删掉某条覆盖后值自动回落。返回实际应用的覆盖键集合；
    settings.json 里的非法键名直接忽略。
    """
    for attr, value in _BASELINE.items():
        globals()[attr] = value
    overrides = _read_overrides()
    applied = {}
    for key, (attr, norm, _secret) in SETTINGS_KEYS.items():
        if key not in overrides:
            continue
        try:
            value = norm(overrides[key])
        except (TypeError, ValueError):
            continue
        globals()[attr] = value
        applied[key] = value
    return applied


apply_settings()


# ---------------- 多模态上传（图片 / 文档） ----------------
# 上传是公网可达的写入口：体积、数量、类型三道闸都要有，否则一个脚本就能把磁盘写满。
UPLOAD_MAX_BYTES = int(os.getenv("PANDA_UPLOAD_MAX_MB", "10")) * 1024 * 1024
UPLOAD_MAX_FILES_PER_REQUEST = 5     # 一问最多带几个附件
UPLOAD_MAX_FILES_PER_CHILD = 60      # 单个孩子档案保留的文件数
UPLOAD_MAX_TOTAL_BYTES = int(os.getenv("PANDA_UPLOAD_QUOTA_MB", "60")) * 1024 * 1024
# 抽取出来的正文注入 prompt 时的预算（超了按字符截断并标注）
FILE_TEXT_MAX_CHARS = 6000           # 单个文件注入上限
FILE_TEXT_TOTAL_CHARS = 14000        # 一轮里所有文件合计上限
# 正文进 index.json 前的落盘上限：抽取结果要复用不能丢，但一份 10MB 文档的全文
# 塞索引里会让每次 list/get 都解析一大坨；注入本来也只吃 FILE_TEXT_MAX_CHARS。
FILE_TEXT_STORE_CHARS = FILE_TEXT_MAX_CHARS * 2
# 图片进模型前统一压到这个长边（视觉 token 与请求体大小都随分辨率涨）。
# 1568 是主流视觉模型"再大也不涨精度"的甜点（Anthropic 长边上限 1568，OpenAI 按 512 切块），
# 作业照里的小字在这个尺寸下才读得清；1280 时小字常糊。
IMAGE_MAX_EDGE = int(os.getenv("PANDA_IMAGE_MAX_EDGE", "1568"))
IMAGE_JPEG_QUALITY = 85
IMAGE_MAX_BYTES = 4 * 1024 * 1024    # 压缩后仍超限就不带图，只留元信息
# 截图（PNG）留 PNG 更清晰；但 PNG 照片压完常常几 MB，超过这个体积且没有透明通道就转 JPEG
IMAGE_PNG_MAX_BYTES = 1200 * 1024

# 单轮图片总量：张数与总字节都要封顶。5 张 × 4MB 的 base64 请求体能到 27MB，
# 会被 provider 直接拒掉（Anthropic 32MB / 多数网关 20MB 以下），
# 也会让这一轮的视觉 token 成本失控。
UPLOAD_MAX_IMAGES_PER_REQUEST = int(os.getenv("PANDA_MAX_IMAGES_PER_TURN", "4"))
IMAGE_TOTAL_BYTES_PER_REQUEST = int(os.getenv("PANDA_IMAGE_TURN_MB", "8")) * 1024 * 1024

# 扫描件 PDF（没有文字层）转成图片走视觉：最多渲染前几页
PDF_VISION_PAGES = int(os.getenv("PANDA_PDF_VISION_PAGES", "3"))
PDF_VISION_DPI = int(os.getenv("PANDA_PDF_VISION_DPI", "150"))

# 历史附件跨轮可用：最近几轮带过附件的用户消息，在新一轮里重新带上（模型不是只看得到当轮）
HISTORY_IMAGE_TURNS = int(os.getenv("PANDA_HISTORY_IMAGE_TURNS", "2"))
HISTORY_IMAGE_MAX = int(os.getenv("PANDA_HISTORY_IMAGE_MAX", "3"))
HISTORY_FILE_TEXT_CHARS = int(os.getenv("PANDA_HISTORY_FILE_TEXT_CHARS", "6000"))

# 上传节流（按账号）：10 分钟最多传这么多份，挡"用上传接口刷 CPU"（每份都要解析 PDF/Office）
UPLOAD_MAX_PER_WINDOW = int(os.getenv("PANDA_UPLOAD_MAX_PER_WINDOW", "40"))
UPLOAD_WINDOW_S = 600

# 允许的扩展名 → 处理方式（kind）。音频/视频不做：本期不引入转写链路，
# 与其"看起来支持"却答不出内容，不如明确拒绝并提示。
FILE_KINDS = {
    "image": {"png", "jpg", "jpeg", "webp", "gif", "bmp"},
    "pdf": {"pdf"},
    "docx": {"docx"},
    "xlsx": {"xlsx", "xlsm"},
    "pptx": {"pptx"},
    "text": {"txt", "md", "markdown", "csv", "tsv", "json", "log", "py", "js", "ts",
             "html", "css", "xml", "yml", "yaml", "ini", "conf", "sql", "java", "c",
             "cpp", "h", "go", "rs", "rb", "php", "sh", "bat", "ps1"},
    "legacy_office": {"doc", "xls", "ppt"},   # 老二进制格式：只提示转换，不做解析
}
# 扩展名 → 前端图标/人类可读名（后端也用来生成文案）
FILE_KIND_CN = {
    "image": "图片", "pdf": "PDF", "docx": "Word 文档", "xlsx": "Excel 表格",
    "pptx": "PPT", "text": "文本", "legacy_office": "旧版 Office 文件",
}
