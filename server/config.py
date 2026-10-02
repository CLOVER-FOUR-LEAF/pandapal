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

SEARCH_API_KEY = os.getenv("SEARCH_API_KEY", "")
SEARCH_BASE_URL = os.getenv("SEARCH_BASE_URL", "").rstrip("/")

# 语音合成 TTS：先在后台配好 Key，调用链路后续接入（服务端持有，前端拿不到明文）
TTS_API_KEY = os.getenv("TTS_API_KEY", "")
TTS_BASE_URL = os.getenv("TTS_BASE_URL", "").rstrip("/")
TTS_MODEL = os.getenv("TTS_MODEL", "")
TTS_VOICE = os.getenv("TTS_VOICE", "")

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

# 可在后台编辑的键 → （本模块属性名, 归一化函数, 是否密钥）。不在表里的键一律不收。
SETTINGS_KEYS: dict[str, tuple[str, object, bool]] = {
    "LLM_PROTOCOL": ("LLM_PROTOCOL", lambda v: str(v).strip().lower(), False),
    "LLM_BASE_URL": ("LLM_BASE_URL", lambda v: str(v).strip().rstrip("/"), False),
    "LLM_API_KEY": ("LLM_API_KEY", lambda v: str(v).strip(), True),
    "LLM_API_KEY2": ("LLM_API_KEY2", lambda v: str(v).strip(), True),
    "LLM_MODEL": ("LLM_MODEL", lambda v: str(v).strip(), False),
    "LLM_REASONING_EFFORT": ("LLM_REASONING_EFFORT", lambda v: str(v).strip().lower(), False),
    "SEARCH_API_KEY": ("SEARCH_API_KEY", lambda v: str(v).strip(), True),
    "SEARCH_BASE_URL": ("SEARCH_BASE_URL", lambda v: str(v).strip().rstrip("/"), False),
    "TTS_API_KEY": ("TTS_API_KEY", lambda v: str(v).strip(), True),
    "TTS_BASE_URL": ("TTS_BASE_URL", lambda v: str(v).strip().rstrip("/"), False),
    "TTS_MODEL": ("TTS_MODEL", lambda v: str(v).strip(), False),
    "TTS_VOICE": ("TTS_VOICE", lambda v: str(v).strip(), False),
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
