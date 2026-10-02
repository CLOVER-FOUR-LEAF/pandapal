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

LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "60"))
TOOL_TIMEOUT = float(os.getenv("TOOL_TIMEOUT", "10"))
HISTORY_TAIL = int(os.getenv("HISTORY_TAIL", "8"))
# 会话闲置回收：超过这么久没来消息的会话释放内存（历史已落盘，再登录照常恢复）
SESSION_IDLE_S = float(os.getenv("PANDA_SESSION_IDLE", "1800"))

# ---------------- 多模态上传（图片 / 文档） ----------------
# 上传是公网可达的写入口：体积、数量、类型三道闸都要有，否则一个脚本就能把磁盘写满。
UPLOAD_MAX_BYTES = int(os.getenv("PANDA_UPLOAD_MAX_MB", "10")) * 1024 * 1024
UPLOAD_MAX_FILES_PER_REQUEST = 5     # 一问最多带几个附件
UPLOAD_MAX_FILES_PER_CHILD = 60      # 单个孩子档案保留的文件数
UPLOAD_MAX_TOTAL_BYTES = int(os.getenv("PANDA_UPLOAD_QUOTA_MB", "60")) * 1024 * 1024
# 抽取出来的正文注入 prompt 时的预算（超了按字符截断并标注）
FILE_TEXT_MAX_CHARS = 6000           # 单个文件注入上限
FILE_TEXT_TOTAL_CHARS = 14000        # 一轮里所有文件合计上限
# 图片进模型前统一压到这个长边（视觉 token 与请求体大小都随分辨率涨）
IMAGE_MAX_EDGE = 1280
IMAGE_JPEG_QUALITY = 85
IMAGE_MAX_BYTES = 4 * 1024 * 1024    # 压缩后仍超限就不带图，只留元信息

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
