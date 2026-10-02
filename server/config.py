"""配置加载：优先环境变量，其次仓库根目录 .env 文件。"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
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

LLM_PROTOCOL = os.getenv("LLM_PROTOCOL", "openai").lower()  # openai | anthropic
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_KEY2 = os.getenv("LLM_API_KEY2", "")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-chat")

SEARCH_API_KEY = os.getenv("SEARCH_API_KEY", "")
SEARCH_BASE_URL = os.getenv("SEARCH_BASE_URL", "").rstrip("/")

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "60"))
TOOL_TIMEOUT = float(os.getenv("TOOL_TIMEOUT", "10"))
HISTORY_TAIL = int(os.getenv("HISTORY_TAIL", "8"))
