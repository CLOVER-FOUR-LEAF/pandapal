"""LLM 客户端：同时支持 OpenAI 兼容协议与 Anthropic Messages 协议。

通过环境变量切换：
  LLM_PROTOCOL=openai     -> POST {LLM_BASE_URL}/chat/completions
  LLM_PROTOCOL=anthropic  -> POST {LLM_BASE_URL}/v1/messages

可靠性三层（参考 OpenPanda internal/entry 与 internal/defense 的设计）：
  1) 候选端点：LLM_API_KEY2 是同端点备用 Key；LLM_API_KEY3 是异构兜底——
     配上 LLM_BASE_URL2/LLM_MODEL2/LLM_PROTOCOL2 就能在主端点整体不可用时
     切到另一家服务商。备用 Key 防限流，兜底端点防停服。
  2) 退避重试：瞬时错误（断网/超时/连接重置）与 5xx 在同一候选内指数退避
     重试；429 限流按 Key 计，优先换下一个候选，无路可换才原地等窗口。
  3) 熔断器：Key 级故障（401/403/429）记到候选身上，端点级故障（5xx/网络）
     记到 (protocol, base_url, model) 上——连续失败就开路冷却，
     不再让每一次对话都白等一个注定失败的超时。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlparse

import httpx

from . import config


class LLMError(RuntimeError):
    pass


class LLMVisionUnsupported(LLMError):
    """provider 明确拒了带图的请求（多半是当前模型没有视觉能力）。

    单独一个类型，是为了让上层能"去掉图片重试一次并如实告诉孩子"，
    而不是把 400 原样抛成"管家的大脑连不上"。
    """


# ---------------------------------------------------------------- 共享连接池
# 每轮对话有分类→生成→沉淀多次调用；每回新建 AsyncClient 就要重做一次 TCP+TLS
# 握手。按事件循环复用一个带连接池的客户端（与 store.lock_for 同一套循环绑定法），
# tools.py 的外部调用也走这里（per-request timeout 覆盖默认值即可）。
_CLIENTS: dict[asyncio.AbstractEventLoop, httpx.AsyncClient] = {}


def shared_client() -> httpx.AsyncClient:
    """当前事件循环共享的 httpx 客户端（进程内复用连接池）。"""
    loop = asyncio.get_running_loop()
    c = _CLIENTS.get(loop)
    if c is None or c.is_closed:
        c = httpx.AsyncClient(
            timeout=config.LLM_TIMEOUT,
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )
        _CLIENTS[loop] = c
    return c


async def close_shared_clients() -> None:
    """服务关闭时收池（main.py 的 lifespan 里调用）。"""
    for c in _CLIENTS.values():
        try:
            await c.aclose()
        except Exception:  # noqa: BLE001 关池失败不挡退出
            pass
    _CLIENTS.clear()


LOG_DIR = config.DATA_DIR / "logs"


def _err_text(e: BaseException | None) -> str:
    """异常 → 留痕文案。httpx 的超时/断连异常 str() 是空串，
    之前 logs 页里一大片失败记录看不出原因，这里补上类名。"""
    if e is None:
        return ""
    msg = str(e).strip()
    name = type(e).__name__
    return f"{name}: {msg}" if msg else name


def log_call(caller: str, ok: bool, ms: float, err: str = "", tokens: int | None = None,
             *, cand: "_Cand | None" = None, usage: dict | None = None,
             truncated: bool = False) -> None:
    """每次 LLM 调用留痕（评委可查 API 调用记录，证明真生成）。

    cand 是本次实际命中的候选端点：兜底端点接管时，日志里看到的就是真实
    服务商/模型，而不是配置里的主端点——failover 在留痕里必须可见才算数。
    usage 是 provider 回报的真实 token 计数（缺省不记）；truncated 标记
    输出撞到长度上限，评委一眼能看出"这条回复本来可能更长"。
    """
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        rec = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "caller": caller,
            "protocol": cand.protocol if cand else config.LLM_PROTOCOL,
            "model": cand.model if cand else config.LLM_MODEL,
            "ms": round(ms),
            "ok": ok,
        }
        if cand is not None:
            host = urlparse(cand.base_url).hostname or ""
            if host:
                rec["endpoint"] = host
        if tokens is not None:
            rec["tokens"] = tokens
        if usage:
            rec["usage"] = usage
        if truncated:
            rec["truncated"] = True
        if err:
            rec["err"] = err[:200]
        with open(LOG_DIR / "llm_calls.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def read_logs(limit: int = 50, offset: int = 0) -> dict:
    """按页读调用留痕（新→旧）：offset=0 取最新 limit 条，offset 往历史翻。

    返回 {"calls","total","limit","offset"}。limit 夹在 1..200，offset 夹在 >=0，
    挡住 `?limit=999999` 这类把整份日志拉爆内存的请求。
    """
    try:
        limit = max(1, min(int(limit), 200))
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        offset = 0
    try:
        lines = (LOG_DIR / "llm_calls.jsonl").read_text(encoding="utf-8").splitlines()
    except OSError:
        return {"calls": [], "total": 0, "limit": limit, "offset": offset}
    total = len(lines)
    end = total - offset
    start = max(0, end - limit)
    out = []
    for line in lines[start:end] if end > 0 else []:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return {"calls": out, "total": total, "limit": limit, "offset": offset}


# ---------------------------------------------------------------- 候选端点
class _Cand(NamedTuple):
    """一次 LLM 调用的候选端点：协议 + 地址 + 模型 + Key 四元组。"""
    protocol: str
    base_url: str
    model: str
    key: str


def _candidates() -> list[_Cand]:
    """按优先级列出候选端点。config 会被后台运行时改写，所以每次调用现取。

    主端点的两把 Key 是同端点候选（共享限流与故障域）；LLM_API_KEY3 配上
    才追加异构兜底——URL/模型/协议没单独配时回落到主端点的值，只换 Key。
    """
    out = [
        _Cand(config.LLM_PROTOCOL, config.LLM_BASE_URL, config.LLM_MODEL, k)
        for k in (config.LLM_API_KEY, config.LLM_API_KEY2) if k
    ]
    if config.LLM_API_KEY3:
        out.append(_Cand(
            config.LLM_PROTOCOL2 or config.LLM_PROTOCOL,
            config.LLM_BASE_URL2 or config.LLM_BASE_URL,
            config.LLM_MODEL2 or config.LLM_MODEL,
            config.LLM_API_KEY3))
    if not out:
        raise LLMError("未配置 LLM_API_KEY，请填写 .env 或设置环境变量")
    return out


def _kid(cand: _Cand) -> str:
    """熔断器里的 Key 标识：不持原文，哈希一段就够区分。"""
    return hashlib.sha256(cand.key.encode()).hexdigest()[:16]


def _eid(cand: _Cand) -> str:
    """熔断器里的端点标识：同地址同模型是一个故障域。"""
    return f"{cand.protocol}|{cand.base_url}|{cand.model}"


# ---------------------------------------------------------------- 熔断器
# 移植自 OpenPanda internal/defense/circuit.go 的状态机：
# closed（默认放行）→ 连续失败到阈值 open（冷却期内一律拒绝）→ 冷却过后
# half-open 放一条探测，探测成功回 closed、失败回 open；探测在飞期间其他
# 调用不得进入，被遗弃的探测（超过冷却还没回报）按再次断开处理。
class _Breaker:
    def __init__(self, threshold: int, cooldown_s: float):
        self.threshold = max(threshold, 1)
        self.cooldown = max(cooldown_s, 0.0)
        # key -> [连续失败次数, 断开时刻, half-open 探测开始时刻]
        self._states: dict[str, list] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        """本调用方是否可以试这个 key。half-open 只放一条探测：第一个到来者
        领走探测名额，其余在探测出结果前都被拒。"""
        now = time.monotonic()
        with self._lock:
            st = self._states.get(key)
            if st is None or st[1] is None:
                return True
            if st[2] is None:
                # open：冷却期到点放一条探测
                if now - st[1] >= self.cooldown:
                    st[2] = now
                    return True
                return False
            # half-open：已有探测在飞；被遗弃的探测（超冷却未回报）按再次断开处理
            if now - st[2] >= self.cooldown:
                st[1], st[2] = now, None
            return False

    def still_blocked(self, key: str) -> bool:
        """只读观察"现在还用不用试它"：不消耗 half-open 的探测名额。
        用于给候选列表排序筛选——只是看看，并不真要用它。"""
        now = time.monotonic()
        with self._lock:
            st = self._states.get(key)
            if st is None or st[1] is None:
                return False
            if st[2] is not None:
                return True
            return now - st[1] < self.cooldown

    def record_success(self, key: str) -> None:
        with self._lock:
            self._states.pop(key, None)

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            st = self._states.setdefault(key, [0, None, None])
            st[0] += 1
            # half-open 探测失败立即再断；否则累计到阈值才断
            if st[2] is not None or st[0] >= self.threshold:
                st[1], st[2] = now, None


# Key 级故障（401/403/429：凭证无效/被限流）与端点级故障（5xx/网络不可达）
# 分开记账：一把 Key 被吊销不该连累同端点的另一把 Key；反过来一个端点真
# 挂了，两把 Key 也不该各白试一轮才轮到兜底。
_KEY_BREAKER = _Breaker(threshold=3, cooldown_s=30.0)
_ENDPOINT_BREAKER = _Breaker(threshold=4, cooldown_s=30.0)


def _blocked(cand: _Cand) -> bool:
    """只读判断：候选现在是否被熔断拦住（不领探测名额）。"""
    return (_ENDPOINT_BREAKER.still_blocked(_eid(cand))
            or _KEY_BREAKER.still_blocked(_kid(cand)))


def _allowed(cand: _Cand) -> bool:
    """正式申请名额：端点在前，端点被拒就不浪费 Key 的探测名额。"""
    return _ENDPOINT_BREAKER.allow(_eid(cand)) and _KEY_BREAKER.allow(_kid(cand))


def _record_ok(cand: _Cand) -> None:
    _KEY_BREAKER.record_success(_kid(cand))
    _ENDPOINT_BREAKER.record_success(_eid(cand))


def _failure_kind(e: BaseException) -> str | None:
    """把异常归到熔断口径："key"（凭证/限流）/"endpoint"（服务端/网络）/None（不计）。

    4xx（除 401/403/429）是请求本身的问题，不是端点病了，不喂熔断器；
    200 却返回坏 JSON（解析失败/字段缺失）按端点故障计——能通但返回
    畸形内容同样是端点异常。
    """
    if isinstance(e, httpx.HTTPStatusError):
        st = getattr(e.response, "status_code", 0) or 0
        if st in (401, 403, 429):
            return "key"
        return "endpoint" if st >= 500 else None
    if isinstance(e, httpx.TransportError):
        return "endpoint"
    if isinstance(e, (json.JSONDecodeError, KeyError)):
        return "endpoint"
    return None


def _record_fail(cand: _Cand, e: BaseException) -> None:
    kind = _failure_kind(e)
    if kind == "key":
        _KEY_BREAKER.record_failure(_kid(cand))
    elif kind == "endpoint":
        _ENDPOINT_BREAKER.record_failure(_eid(cand))


# ---------------------------------------------------------------- 退避重试
_TRANSIENT_RETRIES = 2   # 同一候选内，瞬时/5xx 的退避重试次数
_RETRY_BACKOFF_S = 0.6   # 退避基数：0.6s → 1.2s
_RATE_LIMIT_WAIT_S = 1.5  # 429 且没有下一个候选可换时，原地等一个窗口


def _retry_wait(e: BaseException, attempt: int, is_last: bool) -> float | None:
    """这个错误值不值得在本候选内退避重试：返回等待秒数；None = 换下一个候选。

    429 单独处理：限流一般按 Key/分钟计，换一把 Key 比原地等划算；只有
    已经是最后一个候选（没有可换的）才原地等一个窗口。其余 4xx 重试无意义。
    """
    if isinstance(e, httpx.HTTPStatusError):
        st = getattr(e.response, "status_code", 0) or 0
        if st == 429:
            return _RATE_LIMIT_WAIT_S if is_last and attempt < 1 else None
        if st >= 500:
            return _RETRY_BACKOFF_S * (2 ** attempt) if attempt < _TRANSIENT_RETRIES else None
        return None
    # httpx.TransportError 覆盖连接失败/读超时/断流等"没拿到结论"的错误
    if isinstance(e, httpx.TransportError):
        return _RETRY_BACKOFF_S * (2 ** attempt) if attempt < _TRANSIENT_RETRIES else None
    return None


def _split_system(messages: list[dict]) -> tuple[list[str], list[dict]]:
    """拆出 system 文本与其余消息。system 只收文本块（图片不进 system）。"""
    system: list[str] = []
    rest: list[dict] = []
    for m in messages:
        content = m.get("content")
        if m.get("role") == "system":
            if isinstance(content, str):
                system.append(content)
            elif isinstance(content, list):
                system.append("\n\n".join(
                    str(c.get("text") or "") for c in content
                    if isinstance(c, dict) and c.get("type") == "text"))
        else:
            rest.append(m)
    return system, rest


# ---------------------------------------------------------------- 多模态（图片）
# 两家协议对"带图的用户消息"结构不同，差异全部收敛在这里：调用方只传
# {"type": "text", ...} 与 {"type": "image", "data": <base64>, "mime": ...}，
# 由 llm 决定拼成 OpenAI 的 content 数组还是 Anthropic 的 messages 结构。
_ANTHROPIC_IMAGE_MIME = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def _anthropic_messages(rest: list[dict]) -> list[dict]:
    """把统一结构翻译成 Anthropic 的 messages（content 必须是块数组）。"""
    out = []
    for msg in rest:
        content = msg.get("content")
        if not isinstance(content, list):
            out.append({"role": msg.get("role", "user"), "content": content or ""})
            continue
        blocks = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                blocks.append({"type": "text", "text": str(part.get("text") or "")})
            elif part.get("type") == "image":
                mime = str(part.get("mime") or "image/png")
                if mime not in _ANTHROPIC_IMAGE_MIME:
                    # 冷门类型如实说明，不静默丢图（否则模型会答"图里什么都没有"）
                    blocks.append({"type": "text", "text": f"（不支持的图片类型 {mime}，已跳过）"})
                    continue
                blocks.append({"type": "image", "source": {
                    "type": "base64", "media_type": mime, "data": str(part.get("data") or "")}})
        out.append({"role": msg.get("role", "user"),
                    "content": blocks or [{"type": "text", "text": "（这条消息没有可读内容）"}]})
    return out


def count_images(messages: list[dict]) -> int:
    n = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            n += sum(1 for c in content if isinstance(c, dict) and c.get("type") == "image")
    return n


# ---------------------------------------------------------------- OpenAI 协议（图片）
_OPENAI_IMAGE_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif"}


def _openai_messages(messages: list[dict]) -> list[dict]:
    """把统一结构翻译成 OpenAI 的 content 数组：text + image_url(data URL)。

    这一步以前是漏的：内部块 {"type":"image","data":…,"mime":…} 被原样塞进请求体，
    而 OpenAI 兼容端点只认 {"type":"image_url","image_url":{"url":"data:…"}}——
    于是"图片走视觉"在默认 openai 协议下从来没成立过（只有 anthropic 分支做了翻译）。
    """
    out: list[dict] = []
    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list) or msg.get("role") == "system":
            # 纯文本消息原样透传：不碰它的字段，避免影响非多模态链路
            out.append({**msg, "content": content if content is not None else ""})
            continue
        blocks: list[dict] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                blocks.append({"type": "text", "text": str(part.get("text") or "")})
            elif part.get("type") == "image":
                mime = str(part.get("mime") or "image/png")
                data = str(part.get("data") or "")
                if mime not in _OPENAI_IMAGE_MIME or not data:
                    # 冷门类型如实说明，不静默丢图（否则模型会答"图里什么都没有"）
                    blocks.append({"type": "text", "text": f"（不支持的图片类型 {mime}，已跳过）"})
                    continue
                blocks.append({"type": "image_url",
                               "image_url": {"url": f"data:{mime};base64,{data}"}})
        out.append({**msg, "content": blocks or [{"type": "text", "text": "（这条消息没有可读内容）"}]})
    return out


# 这些状态码 + 请求里带图 = 几乎一定是"模型不支持视觉"，而不是网络/额度问题
_VISION_REJECT_CODES = {400, 404, 415, 422}


def _vision_rejected(err: Exception, messages: list[dict]) -> bool:
    if not count_images(messages):
        return False
    resp = getattr(err, "response", None)
    return resp is not None and getattr(resp, "status_code", None) in _VISION_REJECT_CODES


def estimate_tokens(messages: list[dict]) -> int:
    """粗估 token：中文约 1 字 1 token、英文约 4 字符 1 token，图片按张折算。

    只用于日志展示（评委看得出"这轮花了多少"），不参与计费，宁可粗糙也别漏字段。
    """
    chars = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            chars += len(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    chars += len(str(part.get("text") or ""))
    return int(chars / 1.6) + count_images(messages) * 800 + 8


def _cache_key(messages: list[dict]) -> str:
    """可缓存前缀的指纹，供 OpenAI 系端点的 prompt_cache_key 用。

    人设 + 活跃记忆块整段待在 system 消息里，同一档案的相邻调用前缀高度
    重复——给个稳定指纹，支持前缀缓存的端点（DeepSeek 等）能省首 token
    延迟与费用。不支持的端点忽略该字段，无副作用。
    """
    h = hashlib.sha256()
    for m in messages:
        if m.get("role") != "system":
            break  # 只有开头的连续 system 段是所有调用共享的前缀
        c = m.get("content")
        if isinstance(c, str):
            h.update(c.encode("utf-8", "ignore"))
    return h.hexdigest()[:24]


def _usage_of(payload: dict, protocol: str) -> dict | None:
    """从响应体里取出 provider 回报的真实 token 计数；没报就返回 None（日志里不记）。"""
    u = payload.get("usage")
    if not isinstance(u, dict):
        return None
    if protocol == "anthropic":
        i, o = u.get("input_tokens"), u.get("output_tokens")
    else:
        i, o = u.get("prompt_tokens"), u.get("completion_tokens")
    if not isinstance(i, int) and not isinstance(o, int):
        return None
    return {"in": i if isinstance(i, int) else 0,
            "out": o if isinstance(o, int) else 0}


async def _openai_request(client: httpx.AsyncClient, cand: _Cand, body: dict) -> httpx.Response:
    return await client.post(
        f"{cand.base_url}/chat/completions",
        headers={"Authorization": f"Bearer {cand.key}"},
        json=body,
    )


def _anthropic_url(base: str) -> str:
    """BASE_URL 以 /v1 结尾时不再重复拼（B1：流式与非流式共用同一规则）。"""
    return f"{base}/messages" if base.endswith("/v1") else f"{base}/v1/messages"


async def _anthropic_request(client: httpx.AsyncClient, cand: _Cand, body: dict) -> httpx.Response:
    return await client.post(
        _anthropic_url(cand.base_url),
        headers={
            "x-api-key": cand.key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json=body,
    )


async def complete(
    messages: list[dict],
    *,
    max_tokens: int = 1200,
    temperature: float = 0.7,
    caller: str = "unknown",
) -> str:
    """非流式补全，返回文本。

    遍历候选端点（主 Key → 备 Key → 异构兜底）；熔断中的候选直接跳过——
    已知死掉的端点不配让这次对话白等一个超时。每个候选内部对瞬时错误
    （断网/超时/5xx）指数退避重试，429 优先换候选、无路可换才等窗口。
    每次尝试单独留痕：失败重试和 failover 在 logs 里逐条可见。
    """
    try:
        candidates = _candidates()
    except LLMError as e:
        log_call(caller, False, 0, _err_text(e))  # 没配 Key 的失败也留痕，logs 页能看到原因
        raise
    # 只走没被熔断拦住的候选；全熔断时强制照旧尝试——可能已恢复的服务好过
    # 确定失败（forced 下不走 allow() 门禁，探测成功同样会还清熔断账）
    live = [c for c in candidates if not _blocked(c)]
    todo, forced = (live, False) if live else (candidates, True)
    client = shared_client()
    toks = estimate_tokens(messages)  # 附图/长文本时日志里能看出这轮有多重
    last_err: Exception | None = None
    vision_dead = False  # 有候选明确拒收图片：结束时交给上层走"去图重试"的如实降级
    for i, cand in enumerate(todo):
        if not forced and not _allowed(cand):
            continue  # 并发下重新确认：half-open 只放一条探测
        is_last = i == len(todo) - 1
        retries = 0
        while True:
            at0 = time.monotonic()
            try:
                if cand.protocol == "anthropic":
                    system, rest = _split_system(messages)
                    resp = await _anthropic_request(client, cand, {
                        "model": cand.model,
                        "max_tokens": max_tokens,
                        "temperature": temperature,
                        "system": "\n\n".join(system),
                        "messages": _anthropic_messages(rest),
                    })
                    resp.raise_for_status()
                    data = resp.json()
                    out = "".join(b.get("text", "") for b in data.get("content", []))
                    log_call(caller, True, (time.monotonic() - at0) * 1000, tokens=toks,
                             cand=cand, usage=_usage_of(data, "anthropic"),
                             truncated=data.get("stop_reason") == "max_tokens")
                    _record_ok(cand)
                    return out
                body = {
                    "model": cand.model,
                    "messages": _openai_messages(messages),
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "stream": False,
                    "prompt_cache_key": _cache_key(messages),
                }
                if config.LLM_REASONING_EFFORT:
                    body["reasoning_effort"] = config.LLM_REASONING_EFFORT
                out, truncated, usage = "", False, None
                for budget in (max_tokens, min(max_tokens * 3, 8192)):
                    # 推理模型可能把预算全花在 reasoning_content 上（finish_reason=length
                    # 且 content 为空）——放大预算补一次
                    body["max_tokens"] = budget
                    resp = await _openai_request(client, cand, body)
                    resp.raise_for_status()
                    data = resp.json()
                    choice = data["choices"][0]
                    out = choice["message"]["content"] or ""
                    truncated = choice.get("finish_reason") == "length"
                    usage = _usage_of(data, "openai") or usage
                    if out.strip() or not truncated:
                        break
                log_call(caller, True, (time.monotonic() - at0) * 1000, tokens=toks,
                         cand=cand, usage=usage, truncated=truncated)
                _record_ok(cand)
                return out
            except Exception as e:  # noqa: BLE001 重试与候选切换需要捕获一切
                if _vision_rejected(e, messages):
                    # 本候选的模型没长眼睛：换下一个候选试试（异构兜底也许就是视觉模型），
                    # 全都不行才上报，让上层去掉图片重试并如实说明
                    log_call(caller, False, (time.monotonic() - at0) * 1000,
                             f"视觉被拒: {_err_text(e)}", cand=cand)
                    last_err, vision_dead = e, True
                    break
                last_err = e
                wait = _retry_wait(e, retries, is_last)
                if wait is not None:
                    retries += 1
                    log_call(caller, False, (time.monotonic() - at0) * 1000,
                             f"{_err_text(e)}（{wait:.1f}s 后重试）", cand=cand)
                    await asyncio.sleep(wait)
                    continue
                log_call(caller, False, (time.monotonic() - at0) * 1000,
                         _err_text(e), cand=cand)
                _record_fail(cand, e)
                break
    if vision_dead:
        raise LLMVisionUnsupported(str(last_err or "模型不支持视觉输入"))
    raise LLMError(f"LLM 调用失败: {_err_text(last_err) or '所有候选端点均被熔断'}")


async def stream(
    messages: list[dict],
    *,
    max_tokens: int = 1200,
    temperature: float = 0.7,
    caller: str = "unknown",
) -> AsyncIterator[str]:
    """流式补全，逐段产出文本。协议细节对外屏蔽。

    候选遍历、熔断与退避规则同 complete()。额外硬约束：只要已经吐出
    过任何 token，失败就直接抛错——重发会把已显示的内容再流一遍，
    孩子面前回复重复比报错更难看。
    """
    try:
        candidates = _candidates()
    except LLMError as e:
        log_call(caller, False, 0, _err_text(e))
        raise
    live = [c for c in candidates if not _blocked(c)]
    todo, forced = (live, False) if live else (candidates, True)
    client = shared_client()
    toks = estimate_tokens(messages)
    last_err: Exception | None = None
    vision_dead = False
    for i, cand in enumerate(todo):
        if not forced and not _allowed(cand):
            continue
        is_last = i == len(todo) - 1
        retries = 0
        budget = max_tokens
        while True:
            at0 = time.monotonic()
            got = False   # 本候选本尝试已产出过可见 token
            finish = None
            usage = None
            try:
                if cand.protocol == "anthropic":
                    system, rest = _split_system(messages)
                    req = client.stream(
                        "POST",
                        _anthropic_url(cand.base_url),
                        headers={
                            "x-api-key": cand.key,
                            "anthropic-version": "2023-06-01",
                            "content-type": "application/json",
                        },
                        json={
                            "model": cand.model,
                            "max_tokens": budget,
                            "temperature": temperature,
                            "system": "\n\n".join(system),
                            "messages": _anthropic_messages(rest),
                            "stream": True,
                        },
                    )
                else:
                    body = {
                        "model": cand.model,
                        "messages": _openai_messages(messages),
                        "max_tokens": budget,
                        "temperature": temperature,
                        "stream": True,
                        "prompt_cache_key": _cache_key(messages),
                    }
                    if config.LLM_REASONING_EFFORT:
                        body["reasoning_effort"] = config.LLM_REASONING_EFFORT
                    req = client.stream(
                        "POST",
                        f"{cand.base_url}/chat/completions",
                        headers={"Authorization": f"Bearer {cand.key}"},
                        json=body,
                    )
                async with req as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload or payload == "[DONE]":
                            continue
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        if cand.protocol == "anthropic":
                            if chunk.get("type") == "content_block_delta":
                                text = chunk.get("delta", {}).get("text", "")
                                if text:
                                    got = True
                                    yield text
                            elif chunk.get("type") == "message_start":
                                u = chunk.get("message", {}).get("usage") or {}
                                if isinstance(u.get("input_tokens"), int):
                                    usage = {"in": u["input_tokens"], "out": 0}
                            elif chunk.get("type") == "message_delta":
                                if chunk.get("delta", {}).get("stop_reason") == "max_tokens":
                                    finish = "length"
                                u = chunk.get("usage") or {}
                                if usage is not None and isinstance(u.get("output_tokens"), int):
                                    usage["out"] = u["output_tokens"]
                        else:
                            u = chunk.get("usage")
                            if isinstance(u, dict):
                                # 结尾 chunk：choices 为空、usage 给总数（端点自愿回报才记）
                                usage = {"in": u.get("prompt_tokens") or 0,
                                         "out": u.get("completion_tokens") or 0}
                            for choice in chunk.get("choices", []):
                                if choice.get("finish_reason"):
                                    finish = choice["finish_reason"]
                                text = choice.get("delta", {}).get("content") or ""
                                if text:
                                    got = True
                                    yield text
                log_call(caller, got, (time.monotonic() - at0) * 1000,
                         "" if got else "流式响应为空", tokens=toks,
                         cand=cand, usage=usage, truncated=(finish == "length"))
                if got:
                    if finish == "length":
                        # 非空截断：留一句可见的尾巴，别让孩子以为话本来就说完了
                        yield " …（到这里被截断了，说「继续」我接着讲）"
                    _record_ok(cand)
                    return
                last_err = LLMError("流式响应为空")
                if finish == "length" and budget < 8192:
                    # 推理模型把预算全花在 reasoning_content 上了——没吐任何 token，可安全重试
                    budget = min(budget * 3, 8192)
                    continue
                # 空流不进熔断账：连上了、流完了、只是没内容，属暧昧事件而非端点死亡
                break
            except Exception as e:  # noqa: BLE001 重试与候选切换需要捕获一切
                if got:
                    _record_ok(cand)  # 已吐过内容的断流不算端点死亡
                    raise  # 换候选重发会让回复重复
                if _vision_rejected(e, messages):
                    log_call(caller, False, (time.monotonic() - at0) * 1000,
                             f"视觉被拒: {_err_text(e)}", cand=cand)
                    last_err, vision_dead = e, True
                    break
                last_err = e
                wait = _retry_wait(e, retries, is_last)
                if wait is not None:
                    retries += 1
                    log_call(caller, False, (time.monotonic() - at0) * 1000,
                             f"{_err_text(e)}（{wait:.1f}s 后重试）", cand=cand)
                    await asyncio.sleep(wait)
                    continue
                log_call(caller, False, (time.monotonic() - at0) * 1000,
                         _err_text(e), cand=cand)
                _record_fail(cand, e)
                break
    if vision_dead:
        raise LLMVisionUnsupported(str(last_err or "模型不支持视觉输入"))
    raise LLMError(f"LLM 流式调用失败: {_err_text(last_err) or '所有候选端点均被熔断'}")


def extract_json(text: str) -> dict:
    """从模型输出中提取第一个完整 JSON 对象（容忍前后多余文本）。"""
    start = text.find("{")
    if start == -1:
        raise ValueError("输出中没有 JSON 对象")
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : i + 1])
    raise ValueError("JSON 对象不完整")


async def complete_json(messages: list[dict], *, max_tokens: int = 1200, caller: str = "unknown") -> dict:
    """要求模型输出 JSON，自动修复重试一次。"""
    raw = await complete(messages, max_tokens=max_tokens, temperature=0.3, caller=caller)
    try:
        return extract_json(raw)
    except (ValueError, json.JSONDecodeError):
        retry = messages + [
            {"role": "assistant", "content": raw},
            {"role": "user", "content": "格式有误。请只输出一个完整 JSON 对象，不要输出其他任何文字。"},
        ]
        raw2 = await complete(retry, max_tokens=max_tokens, temperature=0.1, caller=caller)
        return extract_json(raw2)
