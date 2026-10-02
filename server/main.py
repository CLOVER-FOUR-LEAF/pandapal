"""PandaButler Server：FastAPI 应用与 API 端点。

端点：
  POST /api/auth/login    用户名+密码登录 → Bearer token（未知名自动注册孩子档）
  POST /api/auth/register 显式注册（孩子/家长 + 密保问题）→ 注册即登录
  GET  /api/auth/question 取账号密保问题（找回密码第一步）
  POST /api/auth/reset    密保答案核对 → 重置密码并吊销旧 token
  POST /api/auth/logout   注销 token
  GET  /api/auth/me       当前登录信息（刷新恢复会话用）
  POST /api/session    登录选档：名字 → 绑定 data/{child}/ 档案目录
  GET  /api/greeting   开场主动问候（记忆驱动生成）
  GET  /api/briefing   管家晨间巡检（事务 + 临近截止 + 主动建议）
  POST /api/chat       对话主入口（SSE 流：闲聊 token / 事务规划链 / 动作执行）
  GET  /api/graph      成长图谱（view=child|parent）
  GET  /api/affairs    事务看板
  POST /api/affairs    新建/更新事务
  POST /api/checklist/{cid}  清单勾选
  GET  /api/parent/inbox     家长待确认收件箱
  POST /api/parent/inbox/{iid}  家长确认/驳回
  POST /api/relay      传话筒（老师→家长 / 孩子→老师）
  GET  /api/ics/{aid}  日历导出
  GET  /api/memory     记忆本
  GET  /api/history    本会话历史（刷新恢复）
  GET  /api/logs       LLM 调用留痕（评委验真，仅 admin）
  GET  /api/health     健康检查

鉴权：除 /api/health、/api/auth/* 与静态资源外，一律要求 Bearer token；
每个端点标注能力（cap），由 auth.CAPS 按角色裁决；非 admin 的 name 参数
必须与账号绑定的孩子档案一致，家长视角的私密过滤在服务端强制执行。
"""
from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import mimetypes
import re
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field

from . import (actions, affairs, auth, config, executor, files, graph, llm, memory, planner,
               prompts, router, sessions, store, suggest, synth, tools, tts, voice)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    yield
    await llm.close_shared_clients()
    await tts.close_clients()


mimetypes.add_type("application/manifest+json", ".webmanifest")  # PWA 清单，默认会被当成 octet-stream

app = FastAPI(title="PandaButler", docs_url=None, redoc_url=None, lifespan=_lifespan)
# 静态资源压缩：首屏 JS/CSS ~500KB → ~130KB；Starlette 默认排除 text/event-stream，SSE 不受影响
app.add_middleware(GZipMiddleware, minimum_size=1000)


# 前端无内联脚本/事件处理器（启动层也是独立的 static/splash.js），CSP 收口到 'self'；
# style 留 'unsafe-inline'（app.js 大量 el.style 赋值、启动层内联样式），img 放 data:（favicon 是内嵌 SVG）。
_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
)


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    # 基础体积防护：字段级 max_length 之外再兜一道，挡住把超大 JSON 灌进来的请求。
    # 例外是附件上传：multipart 的体积就是文件本身，10MB 上限由 config.UPLOAD_MAX_BYTES 说了算——
    # 套 256KB 的 JSON 闸门会让真实照片/PDF 一律 413（这正是"图传不上去"的根因）。
    length = request.headers.get("content-length")
    if length and length.isdigit():
        size = int(length)
        if request.url.path == "/api/files":
            cap = config.UPLOAD_MAX_BYTES + 64 * 1024  # 留 multipart 边界与字段开销
        else:
            cap = 256_000
        if size > cap:
            return JSONResponse({"detail": "请求体太大啦"}, status_code=413)
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Content-Security-Policy"] = _CSP
    # vendored 依赖版本固定，长缓存安全；其余静态文件不带版本号，交给 ETag/304——
    # 给它们 max-age 会让部署后一小时内的旧 app.js 去调新接口
    if request.url.path.startswith("/static/vendor/"):
        resp.headers["Cache-Control"] = "public, max-age=86400, immutable"
    return resp


_background: set[asyncio.Task] = set()
SECRET_PREFIX = "[[secret]]"

# 确定性意图锚点：只要孩子明确说"我要/帮我 准备·办·参加·报名·写…"，就一定是
# 要管家接手的一件事（new_affair），不靠分类模型的手感。"查/问/看"不在锚点里——
# 那类消息交给 ROUTER 的规则去 chat + 工具轮，正是上一条规则要保住的。
_ACTION_ANCHOR = re.compile(
    r"(?:我要|我想|帮我|打算|计划|准备)(?:准备|办|参加|报名|写|安排|收拾|整理|买|订|做)"
    r"|(?:帮我|我要)把.{0,8}(?:定下来|安排好|理清楚)")


def _bg(task: asyncio.Task) -> None:
    _background.add(task)
    task.add_done_callback(_background.discard)


class AuthReq(BaseModel):
    username: str = Field(min_length=1, max_length=24)
    password: str = Field(min_length=1, max_length=64)


class RegisterReq(BaseModel):
    username: str = Field(min_length=1, max_length=24)
    password: str = Field(min_length=1, max_length=64)
    role: str = Field(default="child", pattern="^(child|parent)$")
    child: str = Field(default="", max_length=24)  # 家长账号要绑定的孩子登录名
    child_password: str = Field(default="", max_length=64)  # 绑定凭证：孩子账号的密码
    question: str = Field(default="", max_length=60)
    answer: str = Field(default="", max_length=60)


class ResetReq(BaseModel):
    username: str = Field(min_length=1, max_length=24)
    answer: str = Field(default="", max_length=60)
    password: str = Field(min_length=1, max_length=64)


class SessionReq(BaseModel):
    name: str = Field(default="", max_length=24)


class ResumeReq(BaseModel):
    """暂停后「继续」：客户端带回被打断那一轮的原问题和已经显示出来的半截回答。

    被打断的那一轮没进会话历史（生成器在 yield 处被关掉），续写必须靠这两段上下文，
    否则模型只看到一句"接着说"，只能凭空编。
    """
    question: str = Field(min_length=1, max_length=2000)
    partial: str = Field(min_length=1, max_length=8000)


class ChatReq(BaseModel):
    name: str = Field(default="", max_length=24)
    message: str = Field(min_length=1, max_length=2000)
    resume: ResumeReq | None = None
    # 本轮带上的附件 id（先 POST /api/files 拿到 id 再随消息发来）
    files: list[str] = Field(default_factory=list, max_length=config.UPLOAD_MAX_FILES_PER_REQUEST)


class AffairReq(BaseModel):
    name: str = Field(default="", max_length=24)
    id: str | None = None
    patch: dict | None = None  # 契约 §4 字段名
    data: dict | None = None   # 兼容旧调用方


class AffairPatchReq(BaseModel):
    """PATCH /api/affairs/{aid}：顶层字段与 `patch` 二选一，契约 §2.6 的语义。"""

    name: str = Field(default="", max_length=24)
    note: str = Field(default="", max_length=200)
    patch: dict | None = None
    title: str | None = Field(default=None, max_length=60)
    kind: str | None = Field(default=None, max_length=20)
    stage: str | None = Field(default=None, max_length=20)
    due: str | None = Field(default=None, max_length=20)
    owner_next: str | None = Field(default=None, max_length=20)
    summary: str | None = Field(default=None, max_length=400)
    progress: dict | None = None
    checklist_id: str | None = Field(default=None, max_length=60)
    linked_nodes: list[str] | None = None
    actions: list[dict] | None = None


class ChecklistReq(BaseModel):
    name: str = Field(default="", max_length=24)
    index: int
    done: bool


class InboxReq(BaseModel):
    name: str = Field(default="", max_length=24)
    action: str = Field(pattern="^(approve|reject)$")
    reply: str = Field(default="", max_length=1000)


class RelayReq(BaseModel):
    name: str = Field(default="", max_length=24)
    direction: str = Field(pattern="^(teacher2parent|child2teacher)$")
    text: str = Field(min_length=1, max_length=2000)


class DreamReq(BaseModel):
    name: str = Field(default="", max_length=24)
    text: str = Field(default="", max_length=1000)


class VoiceReq(BaseModel):
    """手动改音色：朗读总开关、内置音色名，或直接写一段音色描述。"""
    name: str = Field(default="", max_length=24)
    enabled: bool | None = None
    mode: str | None = Field(default=None, pattern="^(design|builtin)$")
    style: str | None = Field(default=None, max_length=600)
    voice: str | None = Field(default=None, max_length=24)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _rules(*parts: str) -> str:
    """把若干条追加规则拼成 system 追加段（跳过空串）。"""
    return "\n\n".join(p for p in parts if p)


def _card_spoken(card: dict) -> str:
    """卡片的口播稿：标题 + 第一条要点 + 收尾。

    整张方案卡念出来是一分多钟的流水账，孩子听两秒就划走了——只留一句
    "我给你理好了什么、接下来先做什么"的引导语。
    """
    parts = [str(card.get("title") or "").strip()]
    for sec in card.get("sections") or []:
        items = [str(i).strip() for i in (sec.get("items") or []) if str(i).strip()]
        if items:
            parts.append(items[0])
            break
    closing = str(card.get("closing") or "").strip()
    if closing:
        parts.append(closing)
    return "。".join(p for p in parts if p)


# 对话音优先级（高于问候/晨报这类环境音）
P_CHAT = 2
P_AMBIENT = 1

# 语音轮次序号：进程内单调递增。作用有两个——
#   1. 前端认出"迟到的旧一轮"并丢掉（问候 30 秒才合成完，期间可能已聊了两轮）
#   2. 同优先级里更新的一轮覆盖上一条
_voice_turn = 0


def _next_turn() -> int:
    global _voice_turn
    _voice_turn += 1
    return _voice_turn


async def _speak_event(sess, text: str, *, caller: str, turn: int = 0,
                       priority: int = P_AMBIENT,
                       max_chars: int | None = None) -> dict | None:
    """合成一段语音并返回 voice 事件载荷；不可用/失败返回 None。

    turn 与 priority 一起决定"这条该不该播"：
      priority —— 对话音（聊天/试音）= 2，环境音（问候/晨报）= 1。
                  孩子主动发消息时，正在放的环境音要让路，别拿十秒前的晨报
                  压着他刚问的问题。
      turn     —— 轮次序号，在轮次开始时就分配好（见 _next_turn），不是合成完再发：
                  问候要等 30 秒 LLM + 4 秒 TTS，聊天可能 5 秒就结束——按合成
                  完成时间排的话，先开始的问候反而拿到更大的号，会把已经播完
                  的聊天语音顶掉。
    前端按 (priority, turn) 字典序比较，先比优先级再比轮次。

    失败静默是刻意的：语音是锦上添花，没配 Key、额度用完、网关抽风都不该
    让一次正常对话变成报错。
    """
    try:
        prof = await asyncio.to_thread(voice.load, sess.dir)
        if not prof.get("enabled", True):
            return None
        ev = await tts.speak(sess.dir, text, prof, caller=caller, max_chars=max_chars)
        if ev is not None:
            ev["turn"] = turn
            ev["priority"] = priority
        return ev
    except Exception as e:  # noqa: BLE001
        print(f"[tts] {caller} 合成失败：{e}")
        return None


async def _stream_text(messages: list[dict], *, max_tokens: int, caller: str,
                       done: dict | None = None, fallback: str = "",
                       sess=None, speak: bool = False, turn: int = 0,
                       priority: int = P_AMBIENT):
    """把一次 LLM 补全转成 SSE：逐 token 下发，末尾补一个 done 事件（可夹带本地数据）。

    晨报/问候的首屏等待全压在 LLM 上，逐字下发配合前端扫描动画能把等待盖住。
    LLM 失败或一个 token 都没吐时，用 fallback（基于本地数据的实话）收尾，
    绝不回 500——此时响应头早已发出，抛错只会让前端拿到半截流。

    兜底文本**不走 token 事件**、不做逐字动画，只放在 done 里并标 `degraded: true`：
    前端据此打上"大模型暂不可用"标记，绝不让本地兜底看起来像 AI 在实时生成。
    """
    got: list[str] = []
    err = ""
    try:
        if messages:  # 传 None：额度用完，直接走本地兜底，不碰 LLM
            async for tok in llm.stream(messages, max_tokens=max_tokens, caller=caller):
                got.append(tok)
                yield _sse({"type": "token", "text": tok})
    except Exception as e:  # noqa: BLE001 流已开始，只能用兜底文本收尾
        err = str(e)[:120]
        print(f"[{caller}] 流式失败，已降级：{e}")
    degraded = not got
    text = "".join(got) if got else fallback
    extra = {"degraded": True, "degraded_reason": err or "大模型没有返回内容"} if degraded else {}
    yield _sse({"type": "done", "text": text, **extra, **(done or {})})
    # 语音放在 done 之后：正文早就上屏了，合成慢一点也不影响孩子看字。
    # 客户端读完 done 只是解锁输入，后面的事件照收（和 memory 事件同理）。
    # 降级稿不念——那是"大模型没接上"的本地兜底，念出来只会让孩子以为
    # 管家真的在说话，而界面明明标着"已降级"。
    if speak and sess is not None and text and not degraded:
        ev = await _speak_event(sess, text, caller=f"{caller}_voice", turn=turn,
                                priority=priority)
        if ev:
            yield _sse({"type": "voice", **ev})


async def _get_session(name: str):
    try:
        return await sessions.login(name)
    except ValueError:
        raise HTTPException(400, "名字不能为空")


# ---------------------------------------------------------------- 鉴权

def _token(request: Request) -> str:
    """Bearer 头优先；?token= 只放行 ics 下载（window.open 带不了头）。

    其它端点不收 query token——URL 会进浏览器历史、反代 access log、
    Referer，token 漏出去等于账号送出去。
    """
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    if request.url.path.startswith("/api/ics/"):
        return request.query_params.get("token", "")
    return ""


def _user(request: Request) -> dict:
    u = auth.user_for_token(_token(request))
    if not u:
        raise HTTPException(401, "请先登录")
    return u


def _need(user: dict, cap: str) -> None:
    if not auth.can(user, cap):
        role_name = auth.ROLE_NAMES.get(user["role"], user["role"])
        raise HTTPException(403, f"{role_name}账号没有「{auth.cap_label(cap)}」权限")


async def _auth_session(request: Request, cap: str, name: str | None = None):
    """认证 + 能力校验 + 档案名归一，返回 (user, session)。"""
    user = _user(request)
    _need(user, cap)
    try:
        eff = auth.resolve_child(user, name)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return user, await _get_session(eff)


_LOGIN_HITS: dict[str, list[float]] = {}


def _cap_table(table: dict, limit: int) -> None:
    """清完过期项仍超限（被刷）时，按最近一次访问时间淘汰最旧的，保证内存有硬上限。"""
    if len(table) <= limit:
        return
    for k in sorted(table, key=lambda k: table[k][-1] if table[k] else 0)[:len(table) - limit]:
        table.pop(k, None)


def _login_throttle(ip: str) -> bool:
    """每 IP 每分钟最多 30 次登录尝试，挡住脚本撞密码。"""
    now = time.monotonic()
    hits = [t for t in _LOGIN_HITS.get(ip, []) if now - t < 60]
    ok = len(hits) < 30
    if ok:
        hits.append(now)
    _LOGIN_HITS[ip] = hits
    if len(_LOGIN_HITS) > 200:
        # 表只增不减会渗漏内存：超过阈值时惰性清掉一分钟内没来过的 IP
        for k in [k for k, v in _LOGIN_HITS.items() if not v or now - v[-1] >= 60]:
            _LOGIN_HITS.pop(k, None)
        _cap_table(_LOGIN_HITS, 2000)
    return ok


async def _auth_response(res: dict) -> dict:
    """登录/注册共用的响应载荷：token + 账号信息 + 绑定档案名（顺带预热会话）。"""
    user = res["user"]
    sess = await _get_session(user["child"])
    return {
        "token": res["token"],
        "username": user["username"],
        "role": user["role"],
        "role_name": auth.ROLE_NAMES.get(user["role"], user["role"]),
        "name": sess.name,
        "is_new": res["is_new"],
    }


# 可信反代网段：回环（本机 uvicorn/nginx）、链路本地、RFC1918 私网与 ULA（内网 nginx）。
# 不用 is_private——它把 TEST-NET/CGNAT/基准网段等一切不可公网路由的地址都算进去，
# 那些地址不可能是我们的反代，放进来等于白送伪造 XFF 绕限流的口子。
_TRUSTED_NETS = tuple(
    ipaddress.ip_network(n)
    for n in ("127.0.0.0/8", "::1/128", "169.254.0.0/16", "fe80::/10",
              "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
)


def _trusted_proxy(host: str) -> bool:
    """直连对端在回环/链路本地/私网网段内才视为可信反代（本机 uvicorn 或内网 nginx）。"""
    try:
        ip = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    return any(ip in net for net in _TRUSTED_NETS)


def _client_ip(request: Request) -> str:
    """真实客户端 IP：仅在直连对端可信时采信 X-Forwarded-For 首跳。

    公网直连部署（无反代）时 client.host 就是真实地址——无条件信 XFF 会让
    撞库脚本伪造 IP 绕过登录限流。"""
    peer = request.client.host if request.client else "-"
    if _trusted_proxy(peer):
        fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if fwd:
            return fwd
    return peer


def _throttled(request: Request) -> None:
    if not _login_throttle(_client_ip(request)):
        raise HTTPException(429, "尝试太频繁，歇一分钟再来")


_CHAT_HITS: dict[str, list[float]] = {}
_CHAT_MAX, _CHAT_WIN = 30, 300  # 每账号 5 分钟 30 条


def _chat_throttle(key: str) -> bool:
    """聊天按账号限频——自动注册零门槛，没有它公网上 API Key 会被刷爆。"""
    now = time.monotonic()
    hits = [t for t in _CHAT_HITS.get(key, []) if now - t < _CHAT_WIN]
    ok = len(hits) < _CHAT_MAX
    if ok:
        hits.append(now)
    _CHAT_HITS[key] = hits
    if len(_CHAT_HITS) > 500:
        for k in [k for k, v in _CHAT_HITS.items() if not v or now - v[-1] >= _CHAT_WIN]:
            _CHAT_HITS.pop(k, None)
        _cap_table(_CHAT_HITS, 5000)
    return ok


_UPLOAD_HITS: dict[str, list[float]] = {}


def _upload_throttle(key: str) -> bool:
    """上传按账号限频：每份附件都要跑 PDF/Office 解析，没有闸门就是一个廉价的 CPU 打点。

    窗口与额度走 config（PANDA_UPLOAD_MAX_PER_WINDOW），和其它限流一致按账号计。
    """
    now = time.monotonic()
    hits = [t for t in _UPLOAD_HITS.get(key, []) if now - t < config.UPLOAD_WINDOW_S]
    ok = len(hits) < config.UPLOAD_MAX_PER_WINDOW
    if ok:
        hits.append(now)
    _UPLOAD_HITS[key] = hits
    if len(_UPLOAD_HITS) > 500:
        for k in [k for k, v in _UPLOAD_HITS.items()
                  if not v or now - v[-1] >= config.UPLOAD_WINDOW_S]:
            _UPLOAD_HITS.pop(k, None)
    return ok


# 所有会调 LLM 的接口共用一份额度：按账号 + 按 IP 双桶。
# 只限 /api/chat 不够——问候/晨报/梦想/传话筒同样每次都烧 API Key，
# 而登录对未知名字零门槛自动注册，单靠"按账号"换个名字就绕过去了，所以再按 IP 兜一层。
_LLM_HITS: dict[str, list[float]] = {}
_LLM_WIN = 300
_LLM_USER_MAX, _LLM_IP_MAX = 60, 150  # 5 分钟内：每账号 60 次、每 IP 150 次（家庭/教室共用出口留余量）


def _hit(table: dict, key: str, limit: int, win: float, now: float) -> bool:
    hits = [t for t in table.get(key, []) if now - t < win]
    ok = len(hits) < limit
    if ok:
        hits.append(now)
    table[key] = hits
    return ok


def _llm_quota(request: Request, username: str) -> bool:
    """还有没有 LLM 额度；两个桶都要有余量才放行（先查不扣，免得一个桶白扣）。"""
    now = time.monotonic()
    ukey, ikey = f"u:{username}", f"ip:{_client_ip(request)}"
    for key, limit in ((ukey, _LLM_USER_MAX), (ikey, _LLM_IP_MAX)):
        if sum(1 for t in _LLM_HITS.get(key, []) if now - t < _LLM_WIN) >= limit:
            return False
    _hit(_LLM_HITS, ukey, _LLM_USER_MAX, _LLM_WIN, now)
    _hit(_LLM_HITS, ikey, _LLM_IP_MAX, _LLM_WIN, now)
    if len(_LLM_HITS) > 1000:
        for k in [k for k, v in _LLM_HITS.items() if not v or now - v[-1] >= _LLM_WIN]:
            _LLM_HITS.pop(k, None)
        _cap_table(_LLM_HITS, 10000)
    return True


def _need_llm_quota(request: Request, username: str) -> None:
    if not _llm_quota(request, username):
        raise HTTPException(429, "管家今天被问得有点累啦，歇几分钟再来")


_SIGNUP_HITS: dict[str, list[float]] = {}
_SIGNUP_MAX, _SIGNUP_WIN = 10, 3600  # 每 IP 每小时最多自动建 10 个新号


@app.post("/api/auth/login")
async def api_auth_login(request: Request, req: AuthReq):
    _throttled(request)
    if await asyncio.to_thread(auth.would_create, req.username):
        # 未知名字会被自动注册成新孩子号：按 IP 限量，挡住"每次换个名字"刷额度
        if not _hit(_SIGNUP_HITS, _client_ip(request), _SIGNUP_MAX, _SIGNUP_WIN, time.monotonic()):
            raise HTTPException(429, "这台设备新建的账号太多啦，用已有账号登录吧")
        _cap_table(_SIGNUP_HITS, 2000)
    try:
        # PBKDF2 十多万次迭代要跑几十上百毫秒，挪出事件循环免得卡住别人的 SSE 流
        res = await asyncio.to_thread(auth.login, req.username, req.password)
    except ValueError as e:
        raise HTTPException(401, str(e))
    return await _auth_response(res)


@app.post("/api/auth/register")
async def api_auth_register(request: Request, req: RegisterReq):
    _throttled(request)
    try:
        res = await asyncio.to_thread(
            auth.register, req.username, req.password, req.role,
            req.child, req.question, req.answer, req.child_password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return await _auth_response(res)


@app.get("/api/auth/question")
async def api_auth_question(request: Request, username: str = ""):
    """找回密码第一步：按用户名取密保问题；recoverable=false 表示没设过密保。"""
    _throttled(request)
    try:
        return await asyncio.to_thread(auth.security_question, username)
    except KeyError:
        raise HTTPException(404, "没有这个账号，先去注册吧")


@app.post("/api/auth/reset")
async def api_auth_reset(request: Request, req: ResetReq):
    """找回密码第二步：密保答案核对通过即重置，旧 token 全部作废。"""
    _throttled(request)
    try:
        await asyncio.to_thread(
            auth.reset_password, req.username, req.answer, req.password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/auth/logout")
async def api_auth_logout(request: Request):
    auth.logout(_token(request))
    return {"ok": True}


@app.get("/api/auth/me")
async def api_auth_me(request: Request):
    user = _user(request)
    return {"username": user["username"], "role": user["role"],
            "role_name": auth.ROLE_NAMES.get(user["role"], user["role"]),
            "name": user["child"]}


def _stores(sess):
    """一个会话关联的三套存储视图。"""
    return (
        graph.GraphStore(sess.dir),
        affairs.AffairStore(sess.dir),
        memory.MemoryStore(sess.dir),
    )


def _file_store(sess) -> files.FileStore:
    return files.FileStore(sess.dir)


def _resolve_files(sess, ids: list[str]) -> tuple[list[dict], list[str]]:
    """把前端传来的附件 id 解析成附件元数据（保持顺序，过滤失效 id）。

    悄悄话轮不解析附件：私密原话不上传文件是对的，附件内容也不该进公共链路。
    """
    if not ids:
        return [], []
    return _file_store(sess).resolve(ids[: config.UPLOAD_MAX_FILES_PER_REQUEST])


def _file_public(sess, item: dict) -> dict:
    """附件的公开视图（不含抽取正文）。"""
    return _file_store(sess).public(item)


def _file_system_note(items: list[dict]) -> str:
    """附件清单（只写文件名/类型/大小/抽取情况，不写正文）——让模型知道手里有什么。"""
    if not items:
        return ""
    lines = [f"- {files.prompt_note(i)}" for i in items]
    note = "孩子这一轮发来的文件：\n" + "\n".join(lines)
    if any(i.get("kind") in ("image", "pdf") and not i.get("_vision")
           and not str(i.get("text") or "").strip() for i in items):
        # 有图没带成：把话说死，否则模型会当作"图在手里"凭尺寸瞎编
        note += "\n（其中标记了没能带进来的图片，你这次看不到内容，必须如实告诉孩子）"
    return note


def _attach_digest(store, items: list[dict] | None) -> str:
    """给"只吃文本"的链路（规划/拆解）用的附件摘要：文件名 + 抽取正文。

    这几条链路拿不到多模态块，孩子用图片/文档补需求时（"按这张课表安排"）
    不带上附件就等于什么都没说。
    """
    if not items:
        return ""
    _prepare_attachments(store, items)
    lines = [f"- {files.prompt_note(i)}" for i in items]
    out = "\n\n【TA 这一轮还发来了这些文件】\n" + "\n".join(lines)
    body = files.file_context(items)
    if body:
        out += "\n" + body
    if any(i.get("_vision") for i in items):
        out += ("\n（图片的画面没有转成文字给你；涉及图片细节时不要凭猜，"
                "拿不准就问 TA 一句）")
    return out


def _attach_memory_note(store, items: list[dict] | None) -> str:
    """给记忆抽取器的一小段附件说明（带头文件名 + 严格限量的正文围栏）。

    没有它，纯图/纯文件的一轮几乎沉淀不出东西：那句话只有"（看看这个附件）"，
    过后孩子问"上次那份讲义"时图谱里没有任何线索。限量 400/800 字，
    免得一份长 PDF 把抽取器的 prompt 撑爆（沉淀本来是轻量调用）。
    """
    if not items:
        return ""
    _prepare_attachments(store, items)
    lines = [f"- {files.prompt_note(i)}" for i in items]
    out = "\n\n【TA 这一轮发来的附件】\n" + "\n".join(lines)
    body = files.file_context(items, max_chars=400, total_chars=800, tag="attach_digest")
    if body:
        out += "\n" + body
    return out


def _add_note(item: dict, text: str) -> None:
    """把说明追加到附件 note 上（去重，同一句话不会攒三遍）。"""
    old = str(item.get("note") or "").strip()
    if text in old:
        return
    item["note"] = f"{old}；{text}" if old else text


def _prepare_attachments(store, items: list[dict]) -> None:
    """把图片/扫描件预先压好、缓存进 item["_vision"]，失败原因写进 item["note"]。

    必须在这一轮的 files 事件和 system 提示之前跑完：否则"图片太大/读不了"这种说明
    既传不到前端文件卡，也进不了 prompt，孩子和模型都以为图已经进来了（静默失败）。
    幂等：同一轮里被调用多次不会重复解码压缩。
    """
    if not items:
        return
    if not _vision_usable():
        for item in items:
            if item.get("kind") in ("image", "pdf"):
                _add_note(item, "当前模型看不了图片，我没有收到这张图")
        return
    for item in items:
        if "_vision" in item:
            continue
        if item.get("kind") == "image":
            if item.get("vision_ok") is False:
                continue  # 上传时就判定读不了，note 已经写好
            prepared = _prepare_image(store, item)
            item["_vision"] = prepared
        elif item.get("kind") == "pdf" and not str(item.get("text") or "").strip():
            item["_vision"] = _prepare_pdf_pages(store, item)


def _prepare_image(store, item: dict) -> list[tuple[bytes, str]]:
    """单张图 → [(payload, mime)]；失败返回 [] 并把原因写进 note。"""
    data = store.content(item)
    if not data:
        _add_note(item, "原图已不在服务器上，请重新上传")
        return []
    payload, out_mime = files.vision_payload(data, str(item.get("mime") or ""))
    if not payload or len(payload) > config.IMAGE_MAX_BYTES or out_mime not in files.VISION_MIME:
        _add_note(item, "图片过大或格式不支持，这一轮没能带上原图")
        return []
    return [(payload, out_mime)]


def _prepare_pdf_pages(store, item: dict) -> list[tuple[bytes, str]]:
    """没有文字层的 PDF（扫描件/拍照件）→ 前几页渲染成图片走视觉。

    旧逻辑对这种文件只会回一句"请把关键页截图发给我"，等于把最需要多模态的场景挡在门外。
    """
    data = store.content(item)
    if not data:
        _add_note(item, "原文件已不在服务器上，请重新上传")
        return []
    pages = files.pdf_page_images(data, config.PDF_VISION_PAGES)
    if not pages:
        _add_note(item, "这份 PDF 没有文字层，也没能转成图片，请把关键页截图发给我")
        return []
    out: list[tuple[bytes, str]] = []
    for raw in pages:
        payload, mime = files.vision_payload(raw, "image/png")
        if payload and len(payload) <= config.IMAGE_MAX_BYTES and mime in files.VISION_MIME:
            out.append((payload, mime))
    if not out:
        _add_note(item, "这份 PDF 没有文字层，页面图片又太大没能带上")
        return []
    _add_note(item, f"这份 PDF 没有文字层，已把前 {len(out)} 页当图片一起发给你读")
    return out


def _vision_usable() -> bool:
    """本轮要不要尝试带图（LLM_VISION=off 时直接不带，省掉一次注定 400 的请求）。"""
    return bool(config.vision_enabled())


def _attachment_parts(store, items: list[dict]) -> list[dict]:
    """附件转成多模态 content 块：图片（含扫描件渲染页）走视觉，压缩后 base64。"""
    parts: list[dict] = []
    for item in items:
        for payload, mime in item.get("_vision") or []:
            parts.append({
                "type": "image",
                "data": base64.b64encode(payload).decode("ascii"),
                "mime": mime,
                "name": item.get("name") or "图片",
            })
    return parts


def _cap_images(parts: list[dict], budget: int) -> list[dict]:
    """单轮图片总量封顶：张数与总字节都要管，否则 base64 请求体会被 provider 拒掉。"""
    keep, total = [], 0
    for part in parts:
        if len(keep) >= config.UPLOAD_MAX_IMAGES_PER_REQUEST:
            break
        size = len(part.get("data") or "")
        if keep and total + size > budget:
            break
        keep.append(part)
        total += size
    return keep


def _history_attachments(sess, store, hist: list[dict]) -> tuple[list[dict], list[dict]]:
    """最近几轮历史里带过的附件 → (图片块, 文本类附件)。

    没有这一步，图片只活一轮：孩子接着问"这题第二步呢"，模型手里已经没有图了。
    只在"这一轮没有新附件"时回放，避免同一张图重复占位与重复计费。
    """
    if not config.HISTORY_IMAGE_TURNS:
        return [], []
    turns, seen = [], set()
    for msg in reversed(list(hist)):
        if msg.get("role") != "user" or not msg.get("files"):
            continue
        turns.append(msg)
        if len(turns) >= config.HISTORY_IMAGE_TURNS:
            break
    images: list[dict] = []
    docs: list[dict] = []
    for msg in turns:
        for ref in msg.get("files") or []:
            fid = str((ref or {}).get("id") or "")
            if not fid or fid in seen:
                continue
            seen.add(fid)
            item = store.get(fid)
            if not item:
                continue  # 已被配额清理：静默跳过，不当成"图还在"
            if item.get("kind") == "image":
                _prepare_attachments(store, [item])
                images.extend(_attachment_parts(store, [item]))
            elif item.get("text"):
                docs.append(item)
    return _cap_images(images, config.IMAGE_TOTAL_BYTES_PER_REQUEST), docs



# ---------------------------------------------------------------- 会话

@app.post("/api/session")
async def api_session(request: Request, req: SessionReq):
    _, sess = await _auth_session(request, "session", req.name)
    g, a, _ = _stores(sess)
    graph_n, affair_n = await asyncio.to_thread(
        lambda: (len(g.export()["nodes"]), len(a.list())))
    return {
        "name": sess.name,
        "is_new": sess.is_new,
        "child": sess.store.child_name,
        "graph_nodes": graph_n,
        "affairs": affair_n,
    }


@app.get("/api/greeting")
async def api_greeting(request: Request, name: str = "", stream: bool = False):
    user, sess = await _auth_session(request, "greeting", name)
    _, a, _ = _stores(sess)
    # 轮次序号在请求开始时就定下来：问候这条链路要 30 秒才合成完语音，
    # 期间孩子很可能已经聊了好几轮，不能让它事后反过来盖掉更新的语音
    turn = _next_turn()
    block, brief, reminders = await asyncio.to_thread(
        lambda: (sess.store.active_block(), _affairs_brief(a), sess.store.due_reminders()))
    messages = [{"role": "user", "content": prompts.GREETING.format(
        name=sess.name,
        now=_now_text(),
        affairs_brief=brief,
        memory_block=block or "（还没有记忆，这是第一次见面）",
    )}]
    # 兜底只说实话：AI 不可用就明说，不冒充一句生成的问候
    fallback = f"{sess.name}，管家暂时连不上大模型，问候稍后再补上～"
    # 额度用完不报错：直接给上面那句实话兜底
    quota = _llm_quota(request, user["username"])
    if stream:
        # opt-in 流式：`?stream=1` 走 SSE 逐字下发，默认仍返回 JSON（契约 §4 不变）
        return StreamingResponse(
            _stream_text(messages if quota else None, max_tokens=600, caller="greeting",
                         done={"reminders": reminders, "name": sess.name},
                         fallback=fallback, sess=sess, speak=config.TTS_SPEAK_GREETING,
                         turn=turn),
            media_type="text/event-stream", headers=_SSE_HEADERS)
    if not quota:
        return {"text": fallback, "reminders": reminders, "name": sess.name}
    try:
        text = await llm.complete(messages, max_tokens=600, caller="greeting")
    except llm.LLMError as e:
        raise HTTPException(502, f"LLM 暂不可用：{e}")
    return {"text": text.strip(), "reminders": reminders, "name": sess.name}


@app.get("/api/suggest")
async def api_suggest(request: Request, name: str = ""):
    """开场快捷话题：按这个孩子当下的事务/截止/兴趣/时段动态生成。"""
    _, sess = await _auth_session(request, "chat", name)
    g, a, _ = _stores(sess)
    chips = await asyncio.to_thread(suggest.opening, a, g, history_len=len(sess.history))
    return {"chips": chips}


# ---------------------------------------------------------------- 晨间巡检

def _left(d: dict) -> str:
    """due_soon 条目的剩余天数文案（过期则说逾期）。"""
    days = int(d.get("days") or 0)
    return f"已过期 {-days} 天" if days < 0 else f"还有 {days} 天"


def _affairs_brief(a_store, limit: int = 6, items: list | None = None) -> str:
    """事务简报；items 传已加载的列表时不再读盘（含 done 的列表需调用方先滤）。"""
    if items is None:
        items = a_store.list()
    else:
        items = [i for i in items if i.get("stage") != "done"]
    items = items[:limit]
    if not items:
        return "（目前没有正在跟进的事）"
    lines = []
    for it in items:
        due = f"，截止 {it['due']}" if it.get("due") else ""
        lines.append(f"- [{it['id']}] {it['title']}（阶段：{it.get('stage')}，待办方：{it.get('owner_next')}{due}）：{it.get('summary', '')}")
    return "\n".join(lines)


def _briefing_collect(a: affairs.AffairStore, g: graph.GraphStore, m: memory.MemoryStore) -> dict:
    """晨报要用的本地数据一次采齐（随 to_thread 整体离事件循环）。

    主动建议："近期反复提起"检测——同一节点被提及 >=3 次、事实跨 >=2 个不同的天、
    最近 10 天内还在提，且还没挂在任何事务上。确定性规则，不靠 LLM 猜。
    注意：private（悄悄话）节点绝不能出现在建议里——那是孩子没打算让人知道的事
    """
    # affairs.json / graph.json 各读一次、全程复用：同一文件以前要 load 三遍
    snapshot = a.snapshot()
    gdata = g.load()
    due = a.due_soon(days=30, items=snapshot["affairs"])  # 演示档案主事件在 16 天后，窗口放宽到 30 天
    mem_block = m.active_block()
    graph_block = g.brief_block(limit=30, g=gdata)
    if graph_block:
        mem_block = f"{mem_block}\n\n{graph_block}"
    linked = {nid for it in snapshot["affairs"] for nid in it.get("linked_nodes") or []}
    cutoff = date.today() - timedelta(days=10)
    candidates = []
    for n in gdata.get("nodes", []):
        if n.get("private") or n.get("id") in linked:
            continue
        if n.get("type") not in ("goal", "interest") or n.get("status") == "done":
            continue
        days = {str(f.get("date"))[:10] for f in n.get("facts") or [] if isinstance(f, dict)}
        try:
            recent = date.fromisoformat(str(n.get("last_seen"))[:10]) >= cutoff
        except ValueError:
            recent = False
        if int(n.get("weight") or 1) >= 3 and len(days) >= 2 and recent:
            candidates.append(n)
    candidates.sort(key=lambda x: -int(x.get("weight") or 1))
    suggestions = [{
        "text": f"要不要我帮你把「{n['label']}」的事接过来，做成一个计划？",
        "affair_id": None,  # 契约 §4：建议尚未落成事务，id 为 null；node_id 附带图谱来源
        "node_id": n["id"],
    } for n in candidates[:2]]
    return {
        "snapshot": snapshot,
        "due": due,
        "due_brief": "\n".join(
            f"- {d['title']}：{d['due']}（{_left(d)}）" for d in due
        ) or "（最近没有临近截止的事）",
        "affairs_brief": _affairs_brief(a, items=snapshot["affairs"]),
        "mem_block": mem_block,
        "suggestions": suggestions,
    }


def _briefing_fallback(name: str, snapshot: dict, due: list[dict]) -> str:
    """晨报 LLM 不可用时的兜底：只用本地数据说实话，不伪造生成。"""
    text = f"早，{name}！我替你盯着 {len(snapshot['affairs'])} 件事。" + (
        f"最近要紧的是：{due[0]['title']}。" if due else "")
    if not due and not snapshot["affairs"]:
        text = f"早，{name}！今天还没有要盯的事，有事随时叫我。"
    return text


@app.get("/api/briefing")
async def api_briefing(request: Request, name: str = "", stream: bool = False):
    user, sess = await _auth_session(request, "briefing", name)
    turn = _next_turn()  # 同 greeting：序号在请求开始时定，不按合成完成时间排
    g, a, m = _stores(sess)
    data = await asyncio.to_thread(_briefing_collect, a, g, m)
    snapshot, due = data["snapshot"], data["due"]
    messages = [{"role": "user", "content": prompts.BRIEFING.format(
        name=sess.name,
        now=_now_text(),
        affairs_brief=data["affairs_brief"],
        due_brief=data["due_brief"],
        memory_block=data["mem_block"] or "（暂无记忆）",
    )}]
    payload = {
        "affairs": snapshot["board"],
        "due_soon": due,
        "suggestions": data["suggestions"],
    }
    quota = _llm_quota(request, user["username"])  # 用完就走本地兜底，晨报照常出
    if stream:
        # opt-in 流式：先逐字出正文，done 事件再带看板/截止/建议，首屏从"整段等"变"边出边看"
        return StreamingResponse(
            _stream_text(messages if quota else None, max_tokens=800, caller="briefing",
                         done=payload,
                         fallback=_briefing_fallback(sess.name, snapshot, due),
                         sess=sess, speak=config.TTS_SPEAK_BRIEFING, turn=turn),
            media_type="text/event-stream", headers=_SSE_HEADERS)

    degraded = False
    try:
        if not quota:
            raise llm.LLMError("额度用完")
        text = await llm.complete(messages, max_tokens=800, caller="briefing")
    except llm.LLMError as e:
        # 晨报失败不影响界面：给一句基于本地数据的兜底，并显式标记降级
        text = _briefing_fallback(sess.name, snapshot, due)
        degraded = True
        print(f"[briefing] LLM 不可用，已降级：{e}")

    return {"text": text.strip(), "degraded": degraded, **payload}


# ---------------------------------------------------------------- 对话主流程

def _chat_messages(sess, message: str, recall_block: str = "", extra_rule: str = "",
                   tool_ctx: str = "", attachments: list[dict] | None = None) -> list[dict]:
    """人设 + 当前时间 + 活跃关注点块 + 图谱检索 + 历史尾部。

    extra_rule 用于 explain 等分支追加讲解规则；tool_ctx 是工具轮刚查到的
    实时资料块（联网搜索/天气/看时间），有就直接摆给模型用。
    attachments 是本轮附件：文本类正文进 system（围栏保护），图片进首条 user 的多模态块。
    最近几轮带过的附件也会回放（图片重新附上、正文回放一小段），否则图片只活一轮。
    """
    store = _file_store(sess)
    # 先把附件压好/转好：note 里的失败原因要能进 system 提示（顺序错了就成了静默丢图）
    _prepare_attachments(store, attachments or [])
    system = prompts.PERSONA.format(name=sess.name)
    system += f"\n\n现在是 {_now_text()}（服务器本地时间），回答时间相关问题直接用，别说自己看不到时间。"
    if extra_rule:
        system += "\n\n" + extra_rule
    active = sess.store.active_block(message)
    related = sess.store.retrieve(message)
    mem_parts = []
    if active:
        mem_parts.append(f"你一直记得的关于 {sess.name} 的事：\n{active}")
    if recall_block:
        mem_parts.append(f"和这次聊天可能相关的记忆：\n{recall_block}")
    if related:
        mem_parts.append(f"（补充）{related}")
    if tool_ctx:
        mem_parts.append(
            f"你刚刚为这句话查到的实时资料（工具真实返回，可直接引用；查得不准就如实说）：\n{tool_ctx}")
    if attachments:
        note = _file_system_note(attachments)
        if note:
            mem_parts.append(note)
        body = files.file_context(attachments)
        if body:
            mem_parts.append(body)
    if mem_parts:
        system += "\n\n" + "\n\n".join(mem_parts)
    msgs = [{"role": "system", "content": system}]

    # 历史尾部：只透传 role/content（secret 等内部字段不能进 LLM 请求体）。
    # 带过附件的轮次按需重建多模态块；本轮已有新附件时不回放，避免同一张图重复占用与重复计费。
    hist = list(sess.history)
    past_images: list[dict] = []
    past_docs: list[dict] = []
    if not attachments:
        past_images, past_docs = _history_attachments(sess, store, hist)
    image_by_index = _index_history_images(hist, past_images)
    for i, m in enumerate(hist):
        parts = image_by_index.get(i)
        if parts:
            msgs.append({"role": m["role"],
                         "content": [{"type": "text", "text": str(m.get("content") or "")}, *parts]})
        else:
            msgs.append({"role": m["role"], "content": m["content"]})
    user_parts = _cap_images(_attachment_parts(store, attachments or []),
                             config.IMAGE_TOTAL_BYTES_PER_REQUEST)
    if past_docs:
        # 历史文件的正文回放：单独一段、单独预算，不跟这一轮新传的文件抢额度
        body = files.file_context(past_docs, max_chars=config.HISTORY_FILE_TEXT_CHARS,
                                  total_chars=config.HISTORY_FILE_TEXT_CHARS,
                                  tag="history_file_data")
        if body:
            system += "\n\n孩子之前发过的文件（供这次追问参考）：\n" + body
    if user_parts or past_images:
        system += "\n\n" + (_vision_rule() if _vision_usable() else prompts.NO_VISION_RULE)
    msgs[0]["content"] = system  # system 是一次性拼完再回写，别在中间追加（会被这里覆盖）
    if user_parts:
        # 有图：首条 user 用多模态块（文本在前、图片在后，两家 provider 都认这个顺序）
        msgs.append({"role": "user", "content": [{"type": "text", "text": message}, *user_parts]})
    else:
        msgs.append({"role": "user", "content": message})
    return msgs


def _vision_rule() -> str:
    """带图时追加的看图规矩（单独一个函数方便测试直接断言）。"""
    return prompts.VISION_RULE


def _index_history_images(hist: list[dict], past_images: list[dict]) -> dict[int, list[dict]]:
    """把回放出来的历史图片按"属于哪一条历史消息"分好，供逐条重建 content 数组。

    顺序与 _history_attachments 一致（同一条消息内按 files 顺序分配）。
    """
    if not past_images:
        return {}
    out: dict[int, list[dict]] = {}
    pool = list(past_images)
    for i in range(len(hist) - 1, -1, -1):
        m = hist[i]
        if m.get("role") != "user" or not m.get("files") or not pool:
            continue
        parts: list[dict] = []
        for _ in (m.get("files") or []):
            if pool:
                parts.append(pool.pop(0))
        if parts:
            out[i] = parts
    return out


_TOOL_MAX_CALLS = 2


async def _tool_round(sess, message: str, emit) -> str:
    """闲聊直答通道的工具轮：启发式命中 → 调度器挑工具 → 执行 → 结果块进 system。

    返回 "" 表示本轮不需要工具（普通闲聊不白跑一次 LLM 判断）。
    悄悄话不走这里——私密内容不能送进联网工具。
    """
    if not tools.might_need(message):
        return ""
    try:
        pick = await llm.complete_json(
            [{"role": "user", "content": prompts.TOOL_PICK.format(
                name=sess.name, now=_now_text(),
                tools_doc=tools.chat_docs(), max_calls=_TOOL_MAX_CALLS,
                message=message)}],
            max_tokens=400, caller="tool_pick")
    except Exception as e:  # noqa: BLE001 选工具失败不挡聊天主路
        print(f"[tools] 调度器判断失败，直接聊：{e}")
        return ""
    calls = [c for c in pick.get("calls") or [] if isinstance(c, dict)]
    if not calls:
        return ""
    ctx = tools.ToolCtx(store=sess.store, event=message)
    blocks = []
    for c in calls[:_TOOL_MAX_CALLS]:
        name = str(c.get("tool") or "")
        args = c.get("args") if isinstance(c.get("args"), dict) else {}
        t = tools.get(name)
        if t is None or not t.chat:
            continue
        label = tools.describe(name, args)
        await emit({"type": "tool", "tool": name, "label": label, "status": "running"})
        try:
            out = await tools.dispatch(name, args, ctx)
            if out is None:
                raise RuntimeError("工具不可用")
            await emit({"type": "tool", "tool": name, "label": label, "status": "done"})
            blocks.append(f"【{label}】\n{out}")
        except Exception as e:  # noqa: BLE001 单个工具失败要让孩子看得见，但别中断回复
            print(f"[tools] {name} 调用失败：{e}")
            await emit({"type": "tool", "tool": name, "label": label, "status": "error"})
            blocks.append(f"【{label}】查询没成功：{e}——回答时如实告诉孩子没查到")
    return "\n\n".join(blocks)


async def _chat_reply(sess, message: str, hit: dict, emit, *,
                      extra_rule: str = "", caller: str = "chat",
                      use_tools: bool = True, attachments: list[dict] | None = None) -> str:
    """闲聊类分支共用：工具轮 → 拼消息 → 流式回复。返回回复全文。

    use_tools=False 关掉工具轮（悄悄话：私密原话不能送进联网工具）。
    attachments 是本轮附件（图片走视觉、文本走围栏正文），悄悄话轮不传。
    """
    tool_ctx = await _tool_round(sess, message, emit) if use_tools else ""
    msgs = await asyncio.to_thread(
        _chat_messages, sess, message, hit["block"], extra_rule, tool_ctx, attachments)
    chunks: list[str] = []
    try:
        async for tok in llm.stream(msgs, max_tokens=600, caller=caller):
            chunks.append(tok)
            await emit({"type": "token", "text": tok})
        return "".join(chunks)
    except llm.LLMVisionUnsupported as e:
        # 模型没有视觉能力：去掉图片重试一次，并先给孩子一句人话，别让它看起来像"管家挂了"
        print(f"[vision] provider 拒绝带图请求，去掉图片重试：{e}")
        await emit({"type": "token", "text": prompts.VISION_FALLBACK})
        chunks = [prompts.VISION_FALLBACK]
        async for tok in llm.stream(_strip_images(msgs), max_tokens=600, caller=caller):
            chunks.append(tok)
            await emit({"type": "token", "text": tok})
        return "".join(chunks)


def _strip_images(msgs: list[dict]) -> list[dict]:
    """把请求里的图片块摘掉（保留文字），并补一条"看不到图"的规则。

    用于 provider 明确拒绝图片时降级重试：回复可以没有图，但不能让孩子以为图被看到了。
    """
    out: list[dict] = []
    for i, m in enumerate(msgs):
        content = m.get("content")
        if not isinstance(content, list):
            out.append(dict(m))
            continue
        texts = [str(p.get("text") or "") for p in content
                 if isinstance(p, dict) and p.get("type") == "text"]
        out.append({"role": m.get("role", "user"), "content": "\n".join(t for t in texts if t)})
    if out and out[0].get("role") == "system":
        out[0]["content"] = str(out[0].get("content") or "") + "\n\n" + prompts.NO_VISION_RULE
    return out


def _make_checklist_from_card(card: dict) -> list[str]:
    """从卡片里挑出可以勾选的条目（清单类板块）。"""
    items = []
    for sec in card.get("sections", []):
        head = str(sec.get("heading", ""))
        if any(k in head for k in ("携带", "清单", "要带", "准备什么", "物品")):
            items.extend(str(i) for i in sec.get("items", []))
    return items[:12]


async def _settle_memory(sess, user_msg: str, reply: str, is_secret: bool = False,
                         attach_note: str = "") -> dict | None:
    """回复发完之后再做：抽取图谱节点/边 + 事务沉淀，并返回 memory 事件载荷。

    返回的载荷里可能带 "affair_event"（事务阶段推进后的看板更新），由调用方
    单独作为 affair 事件下发，不进 memory 事件本体。is_secret 时绝不碰事务档案：
    私密原话一旦写进 affairs.json 的 log 就泄露了。
    attach_note 是本轮附件摘要（悄悄话轮必为空）：让"孩子发来过什么"也进记忆。
    """
    g, a, _ = _stores(sess)
    try:
        # 悄悄话轮的 affair 字段被服务端强制清空，事务简报进了 prompt 也没用——不读
        brief = "" if is_secret else await asyncio.to_thread(_affairs_brief, a)
        gdata = await memory.extract_and_store(sess.store, user_msg + ("" if is_secret else attach_note),
                                               reply,
                                               graph_store=g, is_secret=is_secret,
                                               affairs_brief=brief)
    except Exception as e:  # noqa: BLE001 沉淀失败不能影响对话
        print(f"[memory] 图谱沉淀失败：{e}")
        return None
    if not gdata:
        return None
    # 事务侧的轻量沉淀：孩子汇报了进展 → 推进阶段（只对已存在的事务生效，防幻觉造单）
    aff = gdata.pop("affair", None)
    if aff and not is_secret and await asyncio.to_thread(a.get, aff["id"]):
        try:
            updated = await asyncio.to_thread(a.advance, aff["id"], aff["stage"],
                                              actor="child", note=aff["note"] or user_msg[:40])
            gdata["affair_event"] = {"type": "affair", "action": "update", "affair": updated}
        except (KeyError, ValueError):
            pass
    return gdata


async def _chat_stream(sess, raw_message: str, ctx: dict, resume: ResumeReq | None = None,
                       attachments: list[dict] | None = None):
    """对话主链路的 SSE 流：跑到 done 为止，整个过程持有会话锁。

    ctx 带出本轮的 reply_text / is_secret / message / intent，由调用方在锁释放后
    接力跑 _chat_settle——沉淀与话题建议带 LLM 调用，占着锁会让下一条消息白吃 429。
    resume 是暂停后的续写（带原问题与半截回答）；attachments 是本轮附件
    （图片走视觉、文本走围栏正文，悄悄话轮一律不进）。
    """
    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    is_secret = raw_message.startswith(SECRET_PREFIX)
    message = raw_message[len(SECRET_PREFIX):].strip() if is_secret else raw_message
    if not message:
        message = "（发来一条没写内容的悄悄话）"  # [[secret]] 空消息兜底，不进意图分类
    attachments = [] if is_secret else (attachments or [])

    async def emit(event: dict) -> None:
        # 卡片类回复不念全卡：出卡片时顺手把"口播稿"记下来给语音合成用
        if event.get("type") == "card" and event.get("card"):
            state["spoken"] = _card_spoken(event["card"])
        await queue.put(event)

    reply_text = ""
    last_turn: dict = {"intent": "chat"}  # 本轮实际走了哪条链路，供⑤生成后续话题
    g_store, a_store, m_store = _stores(sess)
    state: dict = {"spoken": ""}  # 本轮口播稿（卡片分支才有，普通闲聊用回复全文）
    # 轮次序号在这条流的最开头就定下来（比任何一次 LLM 调用都早），
    # 后面的语音事件靠它判断自己是"当前这轮"还是"迟到的旧轮次"
    state["turn"] = _next_turn()

    if resume:
        # 续写：本轮记账用被打断那一轮的原问题（含悄悄话标记），而不是"继续"这句指令
        q = resume.question
        q_secret = q.startswith(SECRET_PREFIX)
        is_secret = is_secret or q_secret
        message = (q[len(SECRET_PREFIX):].strip() if q_secret else q) or message
        raw_message = SECRET_PREFIX + message if is_secret else message

    async def work():
        nonlocal reply_text
        # 附件先回执：前端不必等 mode 就能把文件卡画出来（大图上传后尤其明显）
        if attachments:
            await emit({"type": "files", "files": [_file_public(sess, a) for a in attachments]})
        if resume:
            # 续写不分类、不建事务：带着原问题和半截回答直接接着往下说
            last_turn["intent"] = "chat"
            await emit({"type": "mode", "mode": "chat", "mood": "normal"})
            hit = await asyncio.to_thread(g_store.recall, message, limit=4)
            cont = (f"（我刚才问的是：{message}\n你回答到这里被我暂停了：\n{resume.partial}\n"
                    "请从断点处直接接着往下说：不要重复已经说过的内容，不要加开场白，"
                    "如果断在半句话里就把这句接完。）")
            tail = await _chat_reply(sess, cont, hit, emit, use_tools=False,
                                     attachments=attachments)
            # 历史里存完整的一问一答：原问题 + 半截 + 续写
            reply_text = resume.partial + tail if tail else ""
            return
        # 意图分类（LLM RTT，最慢的一段）与图谱检索并行：recall 不依赖分类结果，
        # 契约 §5 的事件顺序由后面的 emit 顺序保证（mode 仍最先下发）。
        brief = await asyncio.to_thread(_affairs_brief, a_store, limit=4)
        cls, hit = await asyncio.gather(
            router.classify(message, brief),
            asyncio.to_thread(g_store.recall, message, limit=4),
        )
        intent, mood = cls["intent"], cls["mood"]
        if intent == "affair_update" and not cls.get("affair_id"):
            intent = "chat"  # 没指到具体事务的"汇报"按闲聊走，不再静默落入 chat 分支
        if intent in ("chat", "explain") and _ACTION_ANCHOR.search(message):
            # 确定性意图锚点：模型偶尔把"我要准备/帮我办"这种明显要接手的事
            # 晃到闲聊——意图边界不能靠模型手感，补一刀拉回 new_affair
            intent = "new_affair"
        last_turn["intent"] = intent
        # 契约 §5：mode 是第一个事件，mood 随 mode 一起下发
        mode = {"new_affair": "plan", "todo": "todo", "affair_update": "affair",
                "relay": "relay", "explain": "explain"}.get(intent, "chat")
        await emit({"type": "mode", "mode": mode, "mood": mood})

        # 换音色：确定性正则锚点，命中就让管家自己把需求扩写成音色提示词并落档，
        # 再把确认规则注进人设——本轮对话照常往下走，不新增意图、不改 ROUTER。
        voice_rule = ""
        if voice.asked(message):
            try:
                changed = await voice.reconfigure(sess, message)
            except Exception as e:  # noqa: BLE001 改音色失败不该打断聊天
                print(f"[voice] 改音色失败：{e}")
                changed = None
            if changed:
                prof, voice_rule = changed
                await emit({"type": "voice_profile", "profile": voice.public_view(prof)})

        # ① 想起来了：图谱检索 → recall 事件（同时注入 prompt）
        if hit["nodes"]:
            await emit({"type": "recall", "nodes": hit["nodes"], "edges": hit["edges"]})

        if intent == "relay":
            out = await _do_relay(sess, "child2teacher", message)
            reply_text = out.get("message", "")
            await emit({"type": "relay_result", **out})
            return

        if intent == "todo":
            # 一句话好几件事：拆解 → 排先后 → 每件落成事务 → 卡片 + 截止提醒
            try:
                reply_text = await _triage(sess, a_store, message, hit, emit,
                                           attach_ctx=_attach_digest(_file_store(sess), attachments))
                return
            except Exception as e:  # noqa: BLE001 拆解失败不能哑火：退回闲聊通道照常回应
                print(f"[triage] 拆解失败，退回闲聊：{e}")
                last_turn["intent"] = "chat"

        if intent == "new_affair":
            # ② 接下这件事：建事务（或认领已存在的同题事务，不重复开单）。
            # 规划（LLM RTT）不依赖事务落盘，与建单并行，省掉一段串行等待。
            attach_ctx = _attach_digest(_file_store(sess), attachments)

            async def _plan_job():
                snapshot = await asyncio.to_thread(a_store.snapshot)
                return await planner.make_plan(sess.store, message, snapshot, attach_ctx=attach_ctx)

            plan_task = asyncio.create_task(_plan_job())
            try:
                affair, created = await _open_affair(sess, a_store, message, hit)
                if affair:
                    await emit({"type": "affair", "action": "create" if created else "update",
                                "affair": await asyncio.to_thread(a_store.get, affair["id"])})
                await emit({"type": "phase", "phase": "planning"})
            except BaseException:
                plan_task.cancel()
                raise
            try:
                plan = await plan_task
            except planner.PlanError:
                plan = None
            if plan:
                ptitle = (plan.get("title") or "").strip()[:18]
                if created and affair and ptitle and ptitle not in _GENERIC_TITLES:
                    # 事务名用规整后的计划名，不拿用户原句切片当标题；
                    # 存量事务的标题不动——那是用户/管家已经叫顺了的名字。
                    # 模型没给标题时 planner 兜底成"筹备计划"，这种泛化名不覆盖占位标题
                    affair = await asyncio.to_thread(
                        a_store.update, affair["id"], {"title": ptitle},
                        actor="butler", note="定下事务名")
                    await emit({"type": "affair", "action": "update", "affair": affair})
                await emit({
                    "type": "plan", "title": plan["title"],
                    "nodes": [{"id": n["id"], "title": n["title"], "tool": n["tool"],
                               "depends_on": n["depends_on"]} for n in plan["nodes"]],
                })
                results, statuses = await executor.run_plan(plan, sess.store, message, emit)
                if affair:
                    # 执行链连同节点终态存进事务，详情抽屉的"DAG 回放"展示真链而非伪造
                    patch = {"plan": {
                        "title": plan["title"],
                        "nodes": [{"id": n["id"], "title": n["title"], "tool": n["tool"],
                                   "depends_on": n["depends_on"],
                                   "status": statuses.get(n["id"], "done")} for n in plan["nodes"]],
                    }}
                    await asyncio.to_thread(a_store.update, affair["id"], patch,
                                            actor="butler", note="执行链已存档")
                await emit({"type": "phase", "phase": "synthesizing"})
                card = await _card_with_fallback(
                    sess.store, message, results=results, title=plan["title"],
                    pairs=[(n["title"], results.get(n["id"], "")) for n in plan["nodes"]
                           if statuses.get(n["id"]) != "error"],
                    attach_ctx=_attach_digest(_file_store(sess), attachments))
            else:
                await emit({"type": "phase", "phase": "synthesizing"})
                card = await _card_with_fallback(
                    sess.store, message, use_synth=False,
                    attach_ctx=_attach_digest(_file_store(sess), attachments))
            reply_text = synth.card_to_text(card)

            # ③ 实际去执行：加提醒 / 生成清单 / 请家长确认。
            # 契约 §5：action* 在 card 之前——动作回执先落看板，卡片再压轴出场
            if affair:
                await _execute_actions(sess, a_store, affair, card, message, emit)
            await emit({"type": "card", "card": card})

        elif intent == "affair_update":
            patch = {"summary": message[:60]}
            try:
                updated = await asyncio.to_thread(
                    a_store.update, cls["affair_id"], patch, actor="child", note=message[:40])
                await emit({"type": "affair", "action": "update", "affair": updated})
            except Exception:  # noqa: BLE001 事务 id 失效时照常聊天
                pass
            reply_text = await _chat_reply(sess, message, hit, emit,
                                           extra_rule=voice_rule,
                                           use_tools=not is_secret, attachments=attachments)

        elif intent == "explain":
            # 讲懂知识点：复用闲聊通道，但在人设后追加"用自己的经历打比方"的讲解规则
            reply_text = await _chat_reply(
                sess, message, hit, emit,
                extra_rule=_rules(prompts.EXPLAIN_RULE, voice_rule), caller="explain",
                use_tools=not is_secret, attachments=attachments)

        else:
            # 悄悄话不走工具轮：私密原话不能送进联网工具（时间注入仍在）
            reply_text = await _chat_reply(
                sess, message, hit, emit, extra_rule=voice_rule,
                use_tools=not is_secret, attachments=attachments)

    async def runner():
        try:
            await work()
            await emit({"type": "done"})
        except llm.LLMError as e:
            await emit({"type": "error", "message": f"管家的大脑暂时连不上啦：{e}"})
        except Exception as e:  # noqa: BLE001
            await emit({"type": "error", "message": f"出了点小问题：{e}"})
        finally:
            await queue.put(None)

    task = asyncio.create_task(runner())
    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            yield _sse(event)
    finally:
        if not task.done():
            task.cancel()

    # ④ 本轮先写进会话历史并落盘（仍在锁内，保住先后顺序）；
    #    耗时沉淀与话题建议交给 _chat_settle，在锁外接力。
    if reply_text:
        u_entry = {"role": "user", "content": raw_message if is_secret else message}
        a_entry = {"role": "assistant", "content": reply_text}
        if attachments:
            # 只存续写所需的元数据：历史回放要能重新画出文件卡，但不把字节搬进 history.json
            u_entry["files"] = [_file_public(sess, a) for a in attachments]
        if is_secret:
            u_entry["secret"] = a_entry["secret"] = True
        sess.history.extend([u_entry, a_entry])
        # 落盘失败不拖垮对话：内存里的历史本轮仍然有效
        try:
            await asyncio.to_thread(sessions.persist_history, sess)
        except Exception as e:  # noqa: BLE001
            print(f"[history] 落盘失败：{e}")
    ctx.update({"reply_text": reply_text, "is_secret": is_secret,
                "message": message, "raw_message": raw_message,
                "spoken": state["spoken"], "turn": state.get("turn", 0),
                "intent": last_turn.get("intent", "chat"),
                # 附件摘要随 ctx 带出锁外：记忆沉淀也在锁外跑，别在这里再读一次磁盘
                "attach_note": "" if is_secret else _attach_memory_note(_file_store(sess), attachments)})


async def _chat_settle(sess, ctx: dict):
    """会话锁外的收尾：记忆沉淀（LLM 抽取 + 落盘）→ memory/affair 事件 → 语音合成 → 话题建议。

    悄悄话：把带 [[secret]] 标记的原文交给抽取器，它才知道要标成 private；
    is_secret 同时让文件层落盘走占位行——私密内容绝不写进 topics/daily/MEMORY.md。
    落盘安全由 store/目录写锁保证，不依赖会话锁。

    记忆沉淀与语音合成是两条互不相干的链路，并发跑：串行的话孩子得先等抽取
    完（好几秒）才听见声音，白等一段。两边都只往同一个队列丢结果，谁先好谁
    先发；消费方数着两个结束标记收口——所以任何一边抛异常都必须在 finally
    里投标记，否则另一边的结果会把响应吊在半路不关。
    """
    reply_text = ctx.get("reply_text") or ""
    is_secret = ctx.get("is_secret", False)
    message = ctx.get("message") or ""
    raw_message = ctx.get("raw_message") or message
    g_store, a_store, _ = _stores(sess)

    out: asyncio.Queue[str | None] = asyncio.Queue()

    async def _speak_into_queue():
        try:
            # 卡片分支只念口播稿（且可整体关掉）；普通闲聊念回复全文
            if is_secret:  # 悄悄话不外送：和"私密原话不进联网工具"同一条红线
                return
            spoken = ctx.get("spoken") or ""
            if spoken and not config.TTS_SPEAK_CARD:
                return
            text = spoken or reply_text
            if not text:
                return
            ev = await _speak_event(
                sess, text, caller="tts_chat", turn=ctx.get("turn", 0),
                priority=P_CHAT,
                max_chars=config.TTS_CARD_MAX_CHARS if spoken else None)
            if ev:
                await out.put(_sse({"type": "voice", **ev}))
        except Exception as e:  # noqa: BLE001
            print(f"[tts] 收尾合成失败：{e}")
        finally:
            await out.put(None)

    # _bg 持有任务引用直到跑完：没有外部引用的 task 可能在执行中被 GC 掉
    _bg(asyncio.create_task(_speak_into_queue()))
    try:
        if reply_text:
            gdata = await _settle_memory(sess, raw_message if is_secret else message,
                                         reply_text, is_secret,
                                         attach_note=ctx.get("attach_note") or "")
            if gdata:
                aff_ev = gdata.pop("affair_event", None)  # 事务阶段推进 → 看板实时刷新
                if aff_ev:
                    await out.put(_sse(aff_ev))
                if is_secret:
                    gdata["secret"] = True
                if gdata.get("added_nodes") or gdata.get("added_edges") or gdata.get("updated"):
                    await out.put(_sse({"type": "memory", **gdata}))

        # 按这一轮的实际情况换一批快捷话题（确定性规则，不额外调 LLM）
        if not is_secret:
            try:
                chips = await asyncio.to_thread(
                    suggest.followups, ctx.get("intent") or "chat", a_store, g_store)
                if chips:
                    await out.put(_sse({"type": "suggest", "chips": chips}))
            except Exception as e:  # noqa: BLE001 话题建议是锦上添花
                print(f"[suggest] 生成失败：{e}")
    finally:
        # 记忆链路的结束标记；异常照旧往上抛给 guarded 的 _settle 兜底
        await out.put(None)
    for _ in range(2):
        chunk = await out.get()
        if chunk is None:
            continue
        yield chunk


def _now_text() -> str:
    return tools.now_text()


async def _triage(sess, a_store, message: str, hit: dict, emit,
                  attach_ctx: str = "") -> str:
    """多任务拆解：一次 LLM 调用拆出每件事 → 先流式回应 → 事务逐件落看板 → 截止提醒 → 卡片。

    返回本轮回复的纯文本（进历史和记忆沉淀）。事务按 existing_id / 标题去重，不重复建单。
    """
    mem, brief = await asyncio.to_thread(
        lambda: (sess.store.active_block(), _affairs_brief(a_store, limit=8)))
    mem = mem or "（暂无记忆）"
    if hit.get("block"):
        mem = f"{mem}\n\n和这次相关的记忆：\n{hit['block']}"
    await emit({"type": "phase", "phase": "planning"})
    data = await llm.complete_json(
        [{"role": "system", "content": "你是任务拆解模块，只输出 JSON。"},
         {"role": "user", "content": prompts.TRIAGE.format(
             name=sess.name, now=_now_text(), memory_block=mem,
             affairs_brief=brief, message=message + attach_ctx)}],
        max_tokens=1600, caller="triage")
    tasks = [t for t in data.get("tasks") or [] if isinstance(t, dict) and str(t.get("title") or "").strip()]
    if not tasks:
        raise ValueError("没拆出任何事项")
    tasks.sort(key=lambda t: int(t.get("priority") or 99) if str(t.get("priority") or "").isdigit() else 99)

    # ① 先说人话（和闲聊一样逐段推，右栏立刻有回应）
    reply = str(data.get("reply") or "").strip() or f"收到！一共 {len(tasks)} 件事，我帮你排好先后了。"
    for i in range(0, len(reply), 12):
        await emit({"type": "token", "text": reply[i:i + 12]})

    # ② 拆解树：每件事一个节点，前端复用 DAG 树渲染
    await emit({"type": "plan", "title": f"拆成 {len(tasks)} 件事",
                "nodes": [{"id": f"t{i + 1}", "title": str(t["title"])[:16], "tool": "triage",
                           "depends_on": []} for i, t in enumerate(tasks)]})

    # ③ 逐件落成事务（已在看板上的就更新，不重复建）
    linked = [n["id"] for n in hit.get("nodes", [])[:2]]
    existing = {a["id"]: a for a in await asyncio.to_thread(a_store.list)}
    sections = []
    for i, t in enumerate(tasks):
        title = str(t["title"]).strip()[:16]
        due = str(t.get("due") or "").strip() or None
        steps = [str(s).strip() for s in t.get("steps") or [] if str(s).strip()][:4]
        summary = "；".join(steps[:2]) or "管家帮你拆好了步骤"
        aid = str(t.get("existing_id") or "").strip()
        if aid not in existing:  # LLM 没指认已有事务时，只按完全相同的标题去重（模糊匹配会张冠李戴）
            aid = next((a["id"] for a in existing.values() if a["title"] == title), "")
        await emit({"type": "node", "id": f"t{i + 1}", "title": title, "status": "running"})
        try:
            if aid:
                patch = {"summary": summary}
                if due:
                    patch["due"] = due
                # 拆解已经完成，接下来是孩子照着做——别把事务永远挂在"规划中"
                if existing.get(aid, {}).get("stage") in ("discovered", "planning"):
                    patch["stage"] = "executing"
                affair = await asyncio.to_thread(
                    a_store.update, aid, patch, actor="child", note=f"又提起：{title}")
                await emit({"type": "affair", "action": "update", "affair": affair})
            else:
                affair = await asyncio.to_thread(a_store.create, {
                    "title": title, "kind": str(t.get("kind") or "goal"), "stage": "executing",
                    "owner_next": "child", "summary": summary, "due": due,
                    "linked_nodes": linked, "progress": {"mode": "none", "value": 0},
                    "actor": "butler", "source": "triage",
                })
                existing[affair["id"]] = affair
                await emit({"type": "affair", "action": "create", "affair": affair})
            if affair.get("due"):
                res = await actions.run_action(sess.dir, affair, {
                    "kind": "reminder", "text": f"截止：{title}", "at": affair["due"]})
                await emit({"type": "action", **res})
            detail = (f"截止 {affair['due']}" if affair.get("due") else "未定截止") + \
                     (f" · {steps[0]}" if steps else "")
            await emit({"type": "node", "id": f"t{i + 1}", "title": title, "status": "done", "detail": detail})
        except Exception as e:  # noqa: BLE001 一件落单失败不影响其它几件
            print(f"[triage] 事务落盘失败：{e}")
            await emit({"type": "node", "id": f"t{i + 1}", "title": title, "status": "error"})
        head = f"{i + 1}. {title}" + (f"（{due}）" if due else "")
        sections.append({"heading": head, "items": steps or ["先花 10 分钟想清楚第一步"]})

    schedule = [str(x) for x in data.get("schedule") or [] if str(x).strip()][:5]
    if schedule:
        sections.append({"heading": "今明两天这样排", "items": schedule})
    card = {"title": "帮你理了理手上的事", "emoji": "🗂", "sections": sections[:8],
            "closing": str(data.get("tip") or "").strip()}
    await emit({"type": "card", "card": card})
    return reply + "\n" + synth.card_to_text(card)


def _flat(text: str) -> str:
    """标题归一化：去标点空白，只留文字，用来比"是不是同一件事"。"""
    return re.sub(r"[^\w一-鿿]+", "", text or "")


# 孩子口语里的收尾语气词，留在标题上很扎眼（"…帮我" / "…好不好"）
_TITLE_TAIL = ("帮我", "好不好", "行不行", "可以吗", "吧", "呀", "啊", "呢", "一下", "怎么样")

# 规划器没给出有效标题时的兜底名，拿它去覆盖看板标题只会把好标题冲掉
_GENERIC_TITLES = {"筹备计划", "计划", "新的事", "执行计划", "任务", "待办"}


def _clean_affair_title(message: str) -> str:
    """从孩子原话里取一个能上看板的短标题：去标点、限长、去收尾语气词。

    顺序很关键：必须「先截断再剥语气词」。反过来做的话，截断点会重新
    切出一个悬在末尾的「帮我」（实测 18 字处正好切在「…绘本帮我」）。
    """
    t = re.sub(r"[，。！？!?~～、\s]+", "", message or "")
    for _ in range(4):  # 截断与剥词互相影响，迭代到稳定即可
        before = t
        t = t[:18]
        for w in _TITLE_TAIL:
            if t.endswith(w) and len(t) > len(w) + 2:
                t = t[: -len(w)]
                break
        if t == before:
            break
    # 全是语气词（"啊" / "吧"）时剥不干净，退回默认名，别让看板挂一个字
    return t if len(t) >= 2 else "新的事"


_SYNTH_BUDGET = 75.0   # 汇总：实测最慢 52.6s，留余量
_DIRECT_BUDGET = 25.0  # 直出：实测 ~5s


async def _card_with_fallback(store, message: str, *, results: dict | None = None,
                              title: str = "", pairs=(), use_synth: bool = True,
                              attach_ctx: str = "") -> dict:
    """出卡片的三档降级：汇总 → 单次直出 → 纯本地摊结果。

    为什么要有第三档：synth 实测平均 35s、最慢 52.6s，已经贴着单次调用超时
    上限跑。原来它一抛异常，整条已经跑完的规划链就白费了，孩子最后只看到
    一句"大脑暂时连不上"——最贵的部分白干，最该给的结果反而没给。

    实测 direct_card 只需 ~5s（比 synth 快 7 倍），所以拿它当中间档很划算；
    连它也没赶上，就用本地那档把节点真实结果如实摊开，末尾说明是"来不及
    整理"的版本，不假装成综合过的方案。
    """
    # 每档给总时限：LLM_TIMEOUT 只是 httpx 单次读超时，流一直滴答或 JSON 重试一次
    # 都能把一档拖过几分钟。孩子端等不了那么久，超时即降级。
    if use_synth:
        try:
            return await asyncio.wait_for(
                synth.synthesize(store, message, results or {}, attach_ctx), _SYNTH_BUDGET)
        except Exception as e:  # noqa: BLE001 含 TimeoutError；CancelledError 不在此列，照常上抛
            print(f"[card] 汇总失败，降级：{e!r}")
        if results:
            # 已经有真实查询结果时不走直出：直出看不到这些结果，可能编出和
            # 刚查到的车次/时间对不上的内容。直接摊真结果，降级不降真。
            return synth.assemble_from_results(title, list(pairs))
    try:
        return await asyncio.wait_for(synth.direct_card(store, message, attach_ctx), _DIRECT_BUDGET)
    except Exception as e:  # noqa: BLE001
        print(f"[card] 直出也失败，用本地兜底：{e!r}")
    return synth.assemble_from_results(title, list(pairs))


async def _open_affair(sess, a_store, message: str, hit: dict) -> tuple[dict | None, bool]:
    """把一句需求变成一个事务；返回 (事务, 是否新建)。

    同一批记忆支撑的事不重复建单：recall 命中的节点若已挂在某个事务上，
    就直接认领它——"西客松要准备啥"和"西客松行李清单"不该是两个事务。
    """
    try:
        nodes = hit.get("nodes") or []
        linked = [n["id"] for n in nodes[:3]]
        hit_ids = {n["id"] for n in nodes}
        # 先落个短标题占位，规划成功后由调用方换成 plan["title"]
        title = _clean_affair_title(message)
        snapshot = await asyncio.to_thread(a_store.list)
        msg_grams = store.bigrams(_flat(message))
        best, best_score = None, 0
        for it in snapshot:
            if it.get("stage") == "done":
                continue
            score = 2 * len(hit_ids & set(it.get("linked_nodes") or []))
            t = _flat(it.get("title"))
            if len(t) >= 4:
                # 标题二元组覆盖度 ≥1/2 才算同一件事——"前 6 字"前缀法对换序/插字太脆
                t_grams = store.bigrams(t)
                if t_grams and len(t_grams & msg_grams) / len(t_grams) >= 0.5:
                    score += 3
            if score > best_score:
                best, best_score = it, score
        if best is not None:
            return best, False
        affair = await asyncio.to_thread(a_store.create, {
            "title": title,
            "kind": "event",
            "stage": "planning",
            "owner_next": "butler",
            "summary": "管家正在筹备",
            "linked_nodes": linked,
            "progress": {"mode": "none", "value": 0},
            "log": [{"ts": datetime.now().isoformat(timespec="seconds"), "actor": "butler",
                     "text": f"接下这件事：{message[:40]}"}],
        })
        return affair, True
    except Exception as e:  # noqa: BLE001 建事务失败不影响出方案
        print(f"[affair] 创建失败：{e}")
        return None, False


# 孩子明确要一份文稿（"帮我写一份自我介绍/给老师的一封信"）→ 触发 draft 动作
_DRAFT_ASK = re.compile(
    r"帮我写|帮我拟|帮我起草|给我写|起草|写一[封份篇个段则]|写份|写篇|写个|拟一[封份篇个]"
    r"|发言稿|演讲稿|申请书|推荐信|自我介绍|自荐信|请假条|主持稿|竞选稿|致辞|感言|承诺书")


async def _execute_actions(sess, a_store, affair: dict, card: dict, message: str, emit) -> None:
    """规划完了真去执行：加提醒、生成清单、必要时请家长确认、代写文稿。"""
    to_run = []
    # 提醒：从卡片里挑"提醒/注意"类的条目
    reminders = []
    for sec in card.get("sections", []):
        if any(k in str(sec.get("heading", "")) for k in ("提醒", "注意", "健康", "准备")):
            reminders.extend(str(i) for i in sec.get("items", []))
    for text in reminders[:3]:
        to_run.append({"kind": "reminder", "text": text[:40]})
    # 清单
    checklist_items = _make_checklist_from_card(card)
    if checklist_items:
        to_run.append({"kind": "checklist", "title": "携带清单", "items": checklist_items})
    # 需要家长出手的（出行/付费类）：只用明确的出行/参赛词，"我想去学钢琴"这类不算
    if any(k in message for k in ("比赛", "出行", "参加", "报名", "行程", "车票", "机票", "酒店", "出发")) \
            and affair.get("kind") in ("travel", "event"):
        to_run.append({
            "kind": "parent_confirm",
            "title": f"{affair['title']}：需要家长帮忙确认的事",
            "detail": "管家已把行程与清单准备好，请家长确认交通与报名相关事项。",
        })
    # 代办文书：孩子要一份能直接拿去用的文稿——卡片与规划素材是它的事实底料
    if _DRAFT_ASK.search(message):
        to_run.append({"kind": "draft", "request": message,
                       "context": synth.card_to_text(card)})

    affair_dirty = False
    done_kinds: list[str] = []
    for act in to_run:
        try:
            result = await actions.run_action(sess.dir, affair, act)
            await emit({"type": "action", **result})
            if result.get("ok"):
                affair["actions"] = (affair.get("actions") or []) + [act]
                patch = {"actions": affair["actions"]}
                payload = result.get("payload") or {}
                cid = payload.get("checklist_id")
                if act.get("kind") == "checklist" and cid:
                    # 清单回挂到事务上——否则清单建了却永远够不着（详情抽屉按 checklist_id 取）
                    patch["checklist_id"] = cid
                did = payload.get("draft_id")
                if act.get("kind") == "draft" and did:
                    # 文稿同样回挂：详情抽屉"交付文稿"按 draft_ids 找得到
                    patch["draft_ids"] = list(affair.get("draft_ids") or []) + [did]
                    affair["draft_ids"] = patch["draft_ids"]
                affair = await asyncio.to_thread(
                    a_store.update, affair["id"], patch, actor="butler",
                    note=f"执行了 {act['kind']}")
                affair_dirty = True
                done_kinds.append(act.get("kind", ""))
        except Exception as e:  # noqa: BLE001 单个动作失败不拖垮整链
            await emit({"type": "action", "kind": act.get("kind", "?"), "ok": False, "detail": str(e), "payload": {}})
    # 规划链跑完就把事务推出去：否则看板上永远挂着"规划中 / 管家正在筹备"，
    # 卡片明明已经给到孩子了，看板却像卡住不动。
    if affair.get("stage") == "planning":
        if done_kinds:
            need_parent = "parent_confirm" in done_kinds
            stage = "waiting" if need_parent else "executing"
            owner = "parent" if need_parent else "child"
            summary = "等家长确认" if need_parent else "管家已备好，照着做就行"
        else:
            # 没有可落地的动作（纯目标型，如"我想学钢琴"）不等于办完了：
            # 推到执行中、球在孩子手里，别让刚开始的事从活跃看板上消失
            stage, owner, summary = "executing", "child", "方案已给到，照着做就行"
        affair = await asyncio.to_thread(
            a_store.update, affair["id"],
            {"stage": stage, "owner_next": owner, "summary": summary},
            actor="butler", note=f"规划完成，转{stage}")
        affair_dirty = True
    if affair_dirty:
        await emit({"type": "affair", "action": "update", "affair": affair})


@app.post("/api/chat")
async def api_chat(request: Request, req: ChatReq):
    user, sess = await _auth_session(request, "chat", req.name)
    if not _chat_throttle(user["username"]):
        raise HTTPException(429, "说得太快啦，喝口水歇五分钟再聊")
    _need_llm_quota(request, user["username"])
    # 附件先解析成元数据；悄悄话轮不带附件（私密话不该顺手把文件塞进公共链路）
    is_secret = req.message.startswith(SECRET_PREFIX)
    attachments = [] if is_secret else _resolve_files(sess, req.files)[0]
    try:
        await asyncio.wait_for(sess.lock.acquire(), timeout=0.3)
    except asyncio.TimeoutError:
        raise HTTPException(429, "管家还在回复上一条，稍等一下哦")

    async def guarded():
        ctx: dict = {}
        try:
            async for chunk in _chat_stream(sess, req.message, ctx, req.resume, attachments):
                yield chunk
        finally:
            sess.lock.release()
        # 锁外收尾：记忆沉淀与话题建议不再把下一条消息挡在 429 外面。
        # 沉淀经后台任务中转——客户端断开时本生成器被关闭，但 _settle 里的
        # LLM 抽取和落盘必须跑完，否则这一轮的记忆就丢了。
        q: asyncio.Queue[str | None] = asyncio.Queue()

        async def _settle() -> None:
            try:
                async for chunk in _chat_settle(sess, ctx):
                    await q.put(chunk)
            except Exception as e:  # noqa: BLE001 收尾失败只记日志，不回写错误事件（回复已发完）
                print(f"[settle] 后台收尾失败：{e}")
            finally:
                await q.put(None)

        _bg(asyncio.create_task(_settle()))
        while True:
            chunk = await q.get()
            if chunk is None:
                break
            yield chunk

    return StreamingResponse(
        guarded(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------- 音色 / 语音

@app.get("/api/voice")
async def api_voice(request: Request, name: str = ""):
    """当前音色档案：前端用它显示"现在是什么声音"，并按 available 决定要不要露开关。"""
    _, sess = await _auth_session(request, "voice", name)
    prof = await asyncio.to_thread(voice.load, sess.dir)
    return {"profile": voice.public_view(prof), "available": tts.available()}


@app.post("/api/voice")
async def api_voice_write(request: Request, req: VoiceReq):
    """手动改音色：朗读总开关、切内置音色、或直接粘一段音色描述。

    与"跟管家说想换什么音色"写的是同一个 voice.json，两条路互不冲突。
    """
    _, sess = await _auth_session(request, "voice", req.name)
    patch = {k: v for k, v in (("enabled", req.enabled), ("mode", req.mode),
                               ("style", req.style), ("voice", req.voice))
             if v is not None}
    if not patch:
        raise HTTPException(400, "没有要更新的字段")
    prof = await asyncio.to_thread(voice.save, sess.dir, patch, by="ui")
    return {"profile": voice.public_view(prof)}


@app.post("/api/voice/preview")
async def api_voice_preview(request: Request, req: SessionReq):
    """试音：点开朗读开关时立刻合成一句短的，让用户当场听见。

    没有这一步的话，用户打开开关后只能等下一条消息才能确认声音能不能放出来；
    浏览器要是拦了自动播放或没有音频设备，干等也等不到，只会以为功能坏了。
    """
    _, sess = await _auth_session(request, "voice", req.name)
    ev = await _speak_event(
        sess, config.TTS_PREVIEW_TEXT, caller="tts_preview", turn=_next_turn(),
        priority=P_CHAT, max_chars=config.TTS_PREVIEW_MAX_CHARS)
    if not ev:
        raise HTTPException(503, "试音没成功：检查 Key、配额，或浏览器有没有拦播放")
    return {"voice": ev}


@app.get("/api/voice/{vid}")
async def api_voice_audio(request: Request, vid: str, name: str = ""):
    """播放已合成的语音片段。

    走 Bearer 鉴权，前端必须用 fetch + blob 取再用 <audio>/Web Audio 播——裸
    <audio src> 带不了 Authorization 头，套 ?token= 又会把 token 漏进浏览器历史
    和反代日志（和 /api/ics 一个道理）。文件名只允许缓存目录下的单段文件名。
    """
    _, sess = await _auth_session(request, "tts", name)
    path = await asyncio.to_thread(tts.resolve, sess.dir, vid)
    if path is None:
        raise HTTPException(404, "这段语音已经不在了")
    return FileResponse(path, media_type=tts.mime_for(vid),
                        headers={"Cache-Control": "private, max-age=300"})


# ---------------------------------------------------------------- 附件（多模态上传）

@app.post("/api/files")
async def api_files_upload(request: Request, name: str = "", file: UploadFile = None):
    """上传一个附件（图片 / PDF / Word / Excel / 文本），返回可随消息引用的 id。

    公开可达的写入口，三道闸都在：单文件体积、单档案配额、扩展名白名单。
    超限一律 4xx + 人话原因，前端直接把这句话显示给用户。
    """
    user, sess = await _auth_session(request, "chat", name)
    if not _upload_throttle(user["username"]):
        raise HTTPException(429, "附件传得太密啦，歇一会儿再传")
    if file is None or not file.filename:
        raise HTTPException(400, "没有收到文件")
    kind = files.kind_of(file.filename, file.content_type or "")
    if not kind:
        raise HTTPException(415, f"这个格式我读不了（{files.safe_name(file.filename)}）；"
                                "支持图片、PDF、Word、Excel 和常见文本/代码文件")
    data = await _read_upload_limited(file, config.UPLOAD_MAX_BYTES)
    if data is None:
        raise HTTPException(413, f"文件太大了，一个最多 {config.UPLOAD_MAX_BYTES // (1024 * 1024)}MB")
    if not data:
        raise HTTPException(400, "文件是空的")
    store = _file_store(sess)
    existing = await asyncio.to_thread(store.list)
    if len(existing) >= config.UPLOAD_MAX_FILES_PER_CHILD:
        raise HTTPException(409, "附件放满了，先删掉几个旧文件再传")
    item = await asyncio.to_thread(
        store.save, data, file.filename, file.content_type or "", kind)
    return {"file": store.public(item), "count": len(existing) + 1}


@app.get("/api/files")
async def api_files_list(request: Request, name: str = ""):
    """当前档案的附件清单（不含正文），给前端做"最近上传"与管理入口。"""
    _, sess = await _auth_session(request, "memory", name)
    store = _file_store(sess)
    items = await asyncio.to_thread(store.list)
    return {"files": [store.public(i) for i in items]}


@app.delete("/api/files/{fid}")
async def api_files_delete(request: Request, fid: str, name: str = ""):
    """删除一个附件（索引 + 原始字节）。"""
    _, sess = await _auth_session(request, "chat", name)
    store = _file_store(sess)
    ok = await asyncio.to_thread(store.delete, fid)
    if not ok:
        raise HTTPException(404, "文件不存在或已删除")
    return {"ok": True}


@app.get("/api/files/{fid}/content")
async def api_files_content(request: Request, fid: str, name: str = ""):
    """原文件（图片预览 / 下载）。家长视角看不到悄悄话轮附带的文件。"""
    user, sess = await _auth_session(request, "memory", name)
    store = _file_store(sess)
    item = store.get(fid)
    if not item:
        raise HTTPException(404, "文件不存在")
    path = store.path_of(item)
    if not path.is_file():
        raise HTTPException(404, "文件已被清理")
    download = request.query_params.get("download") in ("1", "true")
    # nosniff + 非图片强制下载：html/svg 这类可被传成可执行 MIME 的文本文件，
    # 不能在站点源内被当页面渲染（存储型 XSS 面）。图片预览前端走 fetch+blob，不受影响。
    headers = {"Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff"}
    if item.get("kind") != "image":
        download = True
    if download:
        # 展示名消毒后再进响应头（防引号/换行注入）
        safe = re.sub(r'[^\w一-鿿.（）()\- ]', "_", str(item.get("name") or "file"))[:80]
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(safe)}"
    return FileResponse(path, media_type=files.serve_mime(item),
                        headers=headers)


async def _read_upload_limited(file: UploadFile, limit: int) -> bytes | None:
    """分块读上传内容，超过 limit 立刻放弃（不把超大文件整个读进内存）。"""
    chunks, total = [], 0
    while True:
        chunk = await file.read(256 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


# ---------------------------------------------------------------- 图谱 / 事务 / 清单

def _graph_view(user: dict, view: str) -> str:
    """显式归一图谱视角：家长强制 parent；其余只认 child，未知值一律按 parent 过滤。

    契约 §4 要求 `view` 只认 child|parent，其余按 parent；把判定从 GraphStore.export
    内部的隐式分支提到入口，行为可读、可测，也不怕前端漏传/传错。
    """
    if user["role"] == "parent":
        return "parent"  # 家长视角的私密过滤在服务端强制，不信客户端参数
    return "child" if view == "child" else "parent"


@app.get("/api/graph")
async def api_graph(request: Request, name: str = "", view: str = "child"):
    user, sess = await _auth_session(request, "graph", name)
    g, _, _ = _stores(sess)
    return await asyncio.to_thread(g.export, view=_graph_view(user, view))


@app.get("/api/graph/snapshot")
async def api_graph_snapshot(request: Request, name: str = "", view: str = "child", until: str = ""):
    """旧契约 §2.6 的时间轴切片：until=YYYY-MM 只返回该时间点前已出现的节点/边。"""
    user, sess = await _auth_session(request, "graph", name)
    g, _, _ = _stores(sess)
    return await asyncio.to_thread(g.snapshot, until, _graph_view(user, view))


@app.get("/api/affairs")
async def api_affairs(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "affairs", name)
    _, a, _ = _stores(sess)
    return await asyncio.to_thread(a.snapshot)


@app.post("/api/affairs")
async def api_affairs_write(request: Request, req: AffairReq):
    _, sess = await _auth_session(request, "affairs_write", req.name)
    _, a, _ = _stores(sess)
    patch = req.patch or req.data or {}
    try:
        if req.id:
            if await asyncio.to_thread(a.get, req.id):
                return {"affair": await asyncio.to_thread(
                    a.update, req.id, patch, actor="user", note="看板更新")}
            patch = {**patch, "id": req.id}  # 指定 id 建事务时保留请求方给的 id
        return {"affair": await asyncio.to_thread(a.create, patch or {"title": "新的事"})}
    except ValueError as e:  # 非法 stage 等校验错误 → 400，而不是 500
        raise HTTPException(400, str(e))


@app.get("/api/affairs/{aid}")
async def api_affair_detail(request: Request, aid: str, name: str = ""):
    _, sess = await _auth_session(request, "affairs", name)
    _, a, _ = _stores(sess)
    affair = await asyncio.to_thread(a.get, aid)
    if affair is None:
        raise HTTPException(404, "事务不存在")
    # 交付文稿随详情一起给：抽屉里的"交付文稿"区不用再发一轮请求
    affair["drafts"] = await asyncio.to_thread(a.drafts, aid)
    return {"affair": affair}


@app.get("/api/drafts")
async def api_drafts(request: Request, name: str = "", affair: str = ""):
    """文稿列表（代办文书的产出物）；给 affair=<id> 时只取挂在该事务上的。"""
    _, sess = await _auth_session(request, "drafts", name)
    _, a, _ = _stores(sess)
    return {"drafts": await asyncio.to_thread(a.drafts, affair or None)}


@app.get("/api/drafts/{did}")
async def api_draft_detail(request: Request, did: str, name: str = ""):
    _, sess = await _auth_session(request, "drafts", name)
    _, a, _ = _stores(sess)
    try:
        return {"draft": await asyncio.to_thread(a.draft, did)}
    except KeyError:
        raise HTTPException(404, "文稿不存在")


@app.patch("/api/affairs/{aid}")
async def api_affair_patch(request: Request, aid: str, req: AffairPatchReq):
    """旧契约 §2.6 的 PATCH：局部更新事务（stage/note/progress/owner_next/…）。

    顶层字段与 `patch` 字典都收，显式字段优先；空 patch 直接 400，避免静默 no-op。
    """
    _, sess = await _auth_session(request, "affairs_write", req.name)
    _, a, _ = _stores(sess)
    patch = dict(req.patch or {})
    for key in ("title", "kind", "stage", "due", "owner_next", "summary",
                "progress", "checklist_id", "linked_nodes", "actions"):
        value = getattr(req, key)
        if value is not None:
            patch[key] = value
    if not patch:
        raise HTTPException(400, "没有要更新的字段")
    try:
        return {"affair": await asyncio.to_thread(
            a.update, aid, patch, actor="user", note=req.note or "看板更新")}
    except ValueError as e:  # 非法 stage 等 → 400
        raise HTTPException(400, str(e))


@app.get("/api/checklist/{cid}")
async def api_checklist_get(request: Request, cid: str, name: str = ""):
    _, sess = await _auth_session(request, "checklist", name)
    _, a, _ = _stores(sess)
    try:
        return {"checklist": await asyncio.to_thread(a.checklist, cid)}
    except KeyError:
        raise HTTPException(404, "清单不存在")


@app.post("/api/checklist/{cid}")
async def api_checklist(request: Request, cid: str, req: ChecklistReq):
    _, sess = await _auth_session(request, "checklist_write", req.name)
    _, a, _ = _stores(sess)
    try:
        return {"checklist": await asyncio.to_thread(a.toggle_item, cid, req.index, req.done)}
    except (KeyError, IndexError):
        raise HTTPException(404, "清单项不存在")


@app.get("/api/ics/{aid}")
async def api_ics(request: Request, aid: str, name: str = ""):
    _, sess = await _auth_session(request, "ics", name)
    _, a, _ = _stores(sess)
    try:
        ics = await asyncio.to_thread(a.ics, aid)
    except KeyError:
        raise HTTPException(404, "事务不存在")
    # 事务 id 进 Content-Disposition 文件名前消毒，防引号/换行注入响应头。
    # 响应头只能是 latin-1：中文 id 直接塞进 filename="" 会 UnicodeEncodeError 成 500，
    # 所以 filename 给 ASCII 兜底名，真名按 RFC 6266 走 filename*（UTF-8 百分号编码）
    safe = re.sub(r"[^\w一-鿿.-]", "_", aid)[:40] or "affair"
    ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", safe).strip("_") or "affair"
    disp = f"attachment; filename=\"{ascii_name}.ics\"; filename*=UTF-8''{quote(safe + '.ics')}"
    return PlainTextResponse(
        ics,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": disp},
    )


# ---------------------------------------------------------------- 家长侧

@app.get("/api/parent/inbox")
async def api_inbox(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "inbox", name)
    g, a, _ = _stores(sess)
    items, secrets = await asyncio.to_thread(
        lambda: (a.inbox(), [n for n in g.load().get("nodes", []) if n.get("private")]))
    return {"items": items, "secret_count": len(secrets)}


@app.post("/api/parent/inbox/{iid}")
async def api_inbox_decide(request: Request, iid: str, req: InboxReq):
    _, sess = await _auth_session(request, "inbox", req.name)
    _, a, _ = _stores(sess)
    try:
        item = await asyncio.to_thread(a.decide_inbox, iid, req.action, req.reply)
    except KeyError:
        raise HTTPException(404, "该事项不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if item.get("affair_id"):
        note = "家长已确认" if req.action == "approve" else "家长驳回，需另想办法"
        try:
            await asyncio.to_thread(
                a.advance, item["affair_id"],
                "followup" if req.action == "approve" else "executing",
                actor="parent", note=note)
        except KeyError:
            pass
    return {"item": item}


async def _do_relay(sess, direction: str, text: str) -> dict:
    g, _, _ = _stores(sess)
    # 结构性隔离（参考 OpenPanda isolation.go）：传话筒的产出是给家长/老师看的，
    # 记忆只能来自图谱层——brief_block/recall 在构造上就剔除了 private 节点，
    # 文件层记忆（可能混入心事）没有任何代码路径会进入这条 prompt。
    mem = await asyncio.to_thread(g.brief_block, limit=24)
    rec = (await asyncio.to_thread(g.recall, text, limit=3))["block"]
    if rec:
        mem = f"{mem}\n\n和这段话相关的记忆：\n{rec}" if mem else rec
    tpl = prompts.RELAY_T2P if direction == "teacher2parent" else prompts.RELAY_C2T
    prompt = tpl.format(
        name=sess.name, text=text,
        memory_block=mem or "（暂无记忆）",
    )
    try:
        data = await llm.complete_json(
            [{"role": "user", "content": prompt}],
            max_tokens=700,
            caller="relay",
        )
    except Exception:  # noqa: BLE001
        # 模型两次都没吐出 JSON 时降级：直接要一段纯文本译文，别让按钮整个报错
        try:
            raw = await llm.complete(
                [{"role": "user", "content":
                  prompt + "\n\n（注意：不要输出 JSON，直接把整理好的那段话写出来，两三句话即可。）"}],
                max_tokens=500, temperature=0.4, caller="relay")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"翻译失败：{e}")
        raw = raw.strip()
        if not raw:
            raise HTTPException(502, "翻译失败：模型没有给出内容")
        if direction == "teacher2parent":
            return {"direction": direction, "parent_text": raw,
                    "advice": "", "child_text": ""}
        return {"direction": direction, "message": raw, "advice": ""}
    if direction == "teacher2parent":
        return {
            "direction": direction,
            "parent_text": str(data.get("parent_text", "")),
            "advice": str(data.get("advice", "")),
            "child_text": str(data.get("child_text", "")),
        }
    return {"direction": direction, "message": str(data.get("message", "")),
            "advice": str(data.get("advice", ""))}


@app.post("/api/relay")
async def api_relay(request: Request, req: RelayReq):
    user, sess = await _auth_session(request, "relay", req.name)
    _need_llm_quota(request, user["username"])
    return await _do_relay(sess, req.direction, req.text)


# ---------------------------------------------------------------- 成长雷达 / 梦想

_DOMAIN_CN = {"ethics": "德", "intellect": "智", "health": "体", "aesthetics": "美", "labor": "劳"}
_STATUS_FACTOR = {"done": 1.15, "active": 1.0, "dropped": 0.35}


def _growth_stats(g: graph.GraphStore, view: str) -> dict:
    """五育雷达：从记忆图谱确定性统计（提及权重 × 新近度 × 状态加成），不靠 LLM 猜。"""
    gdata = g.load()
    nodes = gdata["nodes"]
    if view == "parent":
        nodes = [n for n in nodes if not n.get("private")]
    today = date.today()
    dims = []
    for dom in graph.DOMAINS:
        members = [n for n in nodes if n.get("domain") == dom]
        engagement = 0.0
        evidence = []
        for n in members:
            try:
                age = max(0, (today - date.fromisoformat(str(n.get("last_seen"))[:10])).days)
            except ValueError:
                age = 540
            recency = 0.45 + 0.55 * max(0.0, 1 - age / 540)
            factor = _STATUS_FACTOR.get(n.get("status"), 1.0)
            engagement += int(n.get("weight") or 1) * recency * factor
            for f in n.get("facts") or []:
                if isinstance(f, dict) and f.get("text"):
                    evidence.append({"date": str(f.get("date") or ""), "text": str(f["text"]),
                                     "node_id": n["id"], "node": str(n.get("label") or n["id"])})
        score = round(100 * (1 - pow(2.718281828, -engagement / 55)))
        if members:
            score = max(10, min(96, score))
        evidence.sort(key=lambda x: x["date"], reverse=True)
        dims.append({
            "domain": dom, "name": _DOMAIN_CN[dom], "score": score,
            "nodes": len(members), "evidence": evidence[:3],
        })
    return {
        "dimensions": dims,
        "totals": {"nodes": len(nodes), "edges": len(gdata["edges"]),
                   "done": sum(1 for n in nodes if n.get("status") == "done")},
        "source": "graph",
    }


@app.get("/api/growth")
async def api_growth(request: Request, name: str = "", view: str = "child"):
    user, sess = await _auth_session(request, "growth", name)
    if user["role"] == "parent":
        view = "parent"  # 服务端强制：家长看不到悄悄话节点
    g, _, m = _stores(sess)
    data = await asyncio.to_thread(_growth_stats, g, "parent" if view == "parent" else "child")
    # 一句点评：LLM 可用就生成，失败就省略（数据本身已经够看）
    try:
        dims_txt = "，".join(f"{d['name']} {d['score']}" for d in data["dimensions"])
        ev_txt = "；".join(
            f"{e['node']}：{e['text']}" for d in data["dimensions"] for e in d["evidence"][:1]
        ) or "（暂无）"
        data["comment"] = (await llm.complete(
            [{"role": "user", "content": prompts.GROWTH_NOTE.format(
                name=sess.name, dims=dims_txt, evidence=ev_txt)}],
            max_tokens=500, caller="growth")).strip()
    except Exception:  # noqa: BLE001 点评是锦上添花，绝不挡数据
        data["comment"] = ""
    return data


@app.post("/api/dream")
async def api_dream(request: Request, req: DreamReq):
    """「说说我的梦想」：孩子说梦想 → 接住并落成记忆；没说 → 主动邀请。"""
    user, sess = await _auth_session(request, "dream", req.name)
    _need_llm_quota(request, user["username"])
    g, a, _ = _stores(sess)
    mem_block = await asyncio.to_thread(sess.store.active_block) or "（还没有记忆，慢慢了解中）"
    graph_brief = await asyncio.to_thread(g.brief_block, limit=20)
    if graph_brief:
        mem_block = f"{mem_block}\n\n{graph_brief}"
    text = req.text.strip()
    try:
        tpl = prompts.DREAM if text else prompts.DREAM_INVITE
        reply = (await llm.complete(
            [{"role": "user", "content": tpl.format(name=sess.name, text=text or "（还没说）",
                                                    memory_block=mem_block)}],
            max_tokens=700, caller="dream")).strip()
    except llm.LLMError as e:
        if text:
            raise HTTPException(502, f"管家的大脑暂时连不上啦：{e}")
        # 邀请语降级：用本地数据说实话
        tops = sorted((await asyncio.to_thread(g.load))["nodes"],
                      key=lambda n: -int(n.get("weight") or 1))
        hot = tops[0]["label"] if tops else ""
        reply = (f"我注意到你最近一直在惦记「{hot}」，这里面藏着你的梦想吗？跟我说说～"
                 if hot else "今天第一次见，来说说你的梦想吧，我帮你记着。")
        return {"text": reply, "llm": False}
    out = {"text": reply, "llm": True}
    if text:
        gdata = await _settle_memory(sess, f"我的梦想：{text}", reply)
        if gdata and (gdata.get("added_nodes") or gdata.get("added_edges") or gdata.get("updated")):
            out["memory"] = gdata
    return out


# ---------------------------------------------------------------- 记忆 / 历史 / 日志

@app.get("/api/memory")
async def api_memory(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "memory", name)
    return await asyncio.to_thread(sess.store.export)


@app.get("/api/history")
async def api_history(request: Request, name: str = ""):
    user, sess = await _auth_session(request, "history", name)
    hist = list(sess.history)
    if user["role"] == "parent":
        # 服务端强制过滤悄悄话轮（secret 标记 + 兼容旧的 [[secret]] 前缀记录）
        hist = [m for m in hist if not m.get("secret")
                and not str(m.get("content", "")).startswith(SECRET_PREFIX)]
    return {"history": hist}


def _archive_history(sess) -> str | None:
    """把当前对话存成一个"项目"归档（同步，调用方 to_thread）；空对话不归档。"""
    hist = list(sess.history)
    if not hist:
        return None
    first = next((m for m in hist if m["role"] == "user"), hist[0])
    title = re.sub(r"\s+", " ", str(first.get("content", "")).replace(SECRET_PREFIX, "")).strip()[:20] or "对话"
    if any(m.get("secret") for m in hist):
        hist = [m for m in hist if not m.get("secret")]
    aid = datetime.now().strftime("%Y%m%d-%H%M%S")
    if hist:
        store.atomic_write(sess.dir / "chats" / f"{aid}.json", json.dumps(
            {"id": aid, "title": title, "ts": datetime.now().isoformat(timespec="seconds"),
             "history": hist}, ensure_ascii=False, indent=1))
    return aid


@app.post("/api/history/new")
async def api_history_new(request: Request, name: str = ""):
    """新建项目：当前对话归档，开一个空白对话（记忆与事务不动）。"""
    _, sess = await _auth_session(request, "history_write", name)
    if sess.lock.locked():
        raise HTTPException(429, "管家还在回复，等说完再新建吧")
    aid = await asyncio.to_thread(_archive_history, sess)
    sess.history.clear()
    await asyncio.to_thread(sessions.persist_history, sess)
    return {"ok": True, "archived": aid}


@app.get("/api/history/archives")
async def api_history_archives(request: Request, name: str = ""):
    _, sess = await _auth_session(request, "history_write", name)

    def _list():
        out = []
        for f in sorted((sess.dir / "chats").glob("*.json"), reverse=True)[:50]:
            d = store.read_json(f, {})
            if isinstance(d, dict) and d.get("id"):
                out.append({"id": d["id"], "title": d.get("title", ""), "ts": d.get("ts", ""),
                            "count": len(d.get("history") or [])})
        return out
    return {"archives": await asyncio.to_thread(_list)}


@app.post("/api/history/archives/{aid}/restore")
async def api_history_restore(request: Request, aid: str, name: str = ""):
    """切回某个归档项目：当前对话先归档，再载入目标。"""
    _, sess = await _auth_session(request, "history_write", name)
    if not re.fullmatch(r"[\d-]{15}", aid):
        raise HTTPException(400, "非法的项目 id")
    if sess.lock.locked():
        raise HTTPException(429, "管家还在回复，等说完再切换吧")
    path = sess.dir / "chats" / f"{aid}.json"
    data = await asyncio.to_thread(store.read_json, path, None)
    if not isinstance(data, dict):
        raise HTTPException(404, "没有这个项目")
    await asyncio.to_thread(_archive_history, sess)
    sess.history.clear()
    sess.history.extend(data.get("history") or [])
    await asyncio.to_thread(sessions.persist_history, sess)
    await asyncio.to_thread(path.unlink, True)
    return {"ok": True, "history": list(sess.history)}


@app.delete("/api/history/archives/{aid}")
async def api_history_archive_delete(request: Request, aid: str, name: str = ""):
    _, sess = await _auth_session(request, "history_write", name)
    if not re.fullmatch(r"[\d-]{15}", aid):
        raise HTTPException(400, "非法的项目 id")
    await asyncio.to_thread((sess.dir / "chats" / f"{aid}.json").unlink, True)
    return {"ok": True}


@app.delete("/api/history")
async def api_history_clear(request: Request, name: str = "", index: int | None = None):
    """删除历史：带 index 删单轮（该条及其配对回复），不带则清空当前对话。
    只动对话记录，不碰已沉淀的记忆与事务。"""
    _, sess = await _auth_session(request, "history_write", name)
    if sess.lock.locked():
        raise HTTPException(429, "管家还在回复，等说完再删吧")
    if index is None:
        sess.history.clear()
    else:
        items = list(sess.history)
        if not 0 <= index < len(items):
            raise HTTPException(404, "没有这条记录")
        lo = index if items[index]["role"] == "user" else index - 1
        hi = lo + 2 if lo + 1 < len(items) and items[lo + 1]["role"] == "assistant" else lo + 1
        del items[max(lo, 0):hi]
        sess.history.clear()
        sess.history.extend(items)
    await asyncio.to_thread(sessions.persist_history, sess)
    return {"ok": True, "history": list(sess.history)}


@app.get("/api/logs")
async def api_logs(request: Request, limit: int = 50, offset: int = 0):
    """LLM 调用日志：评委可据此核验全部输出为真实生成。仅 admin。

    limit/offset 做分页（上限 200/页），日志再长也不会一次全拉。
    """
    _need(_user(request), "logs")
    return await asyncio.to_thread(llm.read_logs, limit, offset)


@app.get("/api/health")
async def api_health():
    return {"ok": True, "llm_configured": bool(config.LLM_API_KEY), "protocol": config.LLM_PROTOCOL}


@app.get("/")
async def index():
    return FileResponse(config.WEB_DIR / "index.html")


@app.get("/sw.js")
async def service_worker():
    """PWA service worker 必须从根路径下发，作用域才能覆盖整个应用；no-cache 保证升级及时生效。"""
    return FileResponse(config.WEB_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache"})


# 家庭侧服务（周报 / 通知落地 / 导出）与后台管理都在独立模块里，复用本文件的鉴权辅助，
# 故放在末尾挂载。两个模块都按需（请求时）取本文件的辅助函数，不用顶层 import——
# 否则 `python -m server.main` 会把 server.main 二次导入，触发循环导入启动失败。
from .family import router as _family_router  # noqa: E402

app.include_router(_family_router)

from .admin import router as _admin_router  # noqa: E402

app.include_router(_admin_router)

app.mount("/static", StaticFiles(directory=config.WEB_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.main:app", host=config.HOST, port=config.PORT, reload=False)
