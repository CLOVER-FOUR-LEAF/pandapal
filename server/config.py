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

# 视觉能力开关：auto（默认）表示"先当能看图，被 provider 拒绝后自动降级并如实告诉孩子"；
# off 表示明确知道当前模型看不了图（如 deepseek-chat），一开始就不带图、直接说清楚，
# 省掉一次必然失败的请求；on 表示强制按视觉模型处理。
LLM_VISION = os.getenv("LLM_VISION", "auto").strip().lower()


def vision_enabled() -> bool:
    """当前模型是否应该尝试带图。默认 auto=尝试（配置错误由 llm 层降级兜住）。"""
    return LLM_VISION not in ("0", "off", "false", "no", "never", "none")


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
