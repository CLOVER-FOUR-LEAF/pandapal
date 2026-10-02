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
