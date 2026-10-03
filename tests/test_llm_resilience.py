"""LLM 可靠性自检：错误分级、退避重试、熔断器、异构兜底、usage 记账。

用法：python tests/test_llm_resilience.py

为什么要钉这些：重试/熔断是"看不见"的可靠性层，回归没人会立刻发现——
孩子只会觉得"管家又卡了"。下面保证：
  - 4xx（非 401/403/429）不重试、不喂熔断器
  - 5xx/断网指数退避；429 优先换 Key，末位候选才原地等窗口
  - 熔断开路冷却、half-open 只放一条探测、探测遗弃算再次断开
  - 全熔断时照旧尝试（可能已恢复的服务好过确定失败）
  - 流式已吐 token 后绝不重发（防回复重复）
  - 视觉被拒跨候选降级，最终如实抛 LLMVisionUnsupported
  - provider 回报的 usage 写进调用留痕
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_llm_")
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

import httpx  # noqa: E402

from server import config, llm  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


# ------------------------------------------------------------------ 测试替身
def http_err(status: int) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "https://x.test/v1/chat/completions")
    return httpx.HTTPStatusError(f"HTTP {status}", request=req,
                                 response=httpx.Response(status, request=req))


def conn_err() -> httpx.ConnectError:
    return httpx.ConnectError("connection refused",
                              request=httpx.Request("POST", "https://x.test/"))


class _Resp:
    """最小可用响应替身：raise_for_status + json。"""

    def __init__(self, payload: dict, status: int = 200):
        self._p, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            req = httpx.Request("POST", "https://x.test/")
            raise httpx.HTTPStatusError(f"HTTP {self.status_code}", request=req,
                                        response=httpx.Response(self.status_code, request=req))

    def json(self):
        return self._p


def ok_payload(text: str = "你好", usage: dict | None = None) -> dict:
    p = {"choices": [{"message": {"content": text}, "finish_reason": "stop"}]}
    if usage:
        p["usage"] = usage
    return p


class _StreamReq:
    """client.stream() 返回的异步上下文管理器替身。"""

    def __init__(self, events):
        self._events = events  # 元素是 SSE 行字符串或待抛出的异常

    async def __aenter__(self):
        for e in self._events:
            if isinstance(e, BaseException):
                raise e
            break
        return _StreamResp(self._events)

    async def __aexit__(self, *a):
        return False


class _StreamResp:
    status_code = 200

    def __init__(self, events):
        self._events = events

    def raise_for_status(self):
        pass

    async def aiter_lines(self):
        for e in self._events:
            if isinstance(e, BaseException):
                raise e
            yield e


class _Client:
    """共享客户端替身：stream() 按脚本回放，调用都记账。"""

    def __init__(self):
        self.scripts: list[list] = []  # 每次 stream() 取一段 events
        self.calls: list[dict] = []

    def stream(self, method, url, headers=None, json=None):
        self.calls.append({"url": url, "headers": headers or {}, "json": json or {}})
        events = self.scripts.pop(0) if self.scripts else []
        return _StreamReq(events)


def sse(obj) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False)


def openai_delta(text: str, finish: str | None = None) -> str:
    c = {"choices": [{"delta": {"content": text}}]}
    if finish:
        c["choices"][0]["finish_reason"] = finish
    return sse(c)


# ------------------------------------------------------------------ 环境装置
class Env:
    """保存/恢复 config 与 llm 的全局状态：config 会被后台运行时改写，
    llm 每次调用现取，所以测试直接改模块属性即可，但必须记得复原。"""

    ATTRS = ("LLM_API_KEY", "LLM_API_KEY2", "LLM_API_KEY3", "LLM_BASE_URL",
             "LLM_BASE_URL2", "LLM_MODEL", "LLM_MODEL2", "LLM_PROTOCOL",
             "LLM_PROTOCOL2", "LLM_REASONING_EFFORT")

    def __enter__(self):
        self.saved = {a: getattr(config, a) for a in self.ATTRS}
        self.real_req = llm._openai_request
        self.real_client = llm.shared_client
        self.real_log = llm.log_call
        self.logs: list[dict] = []
        llm.log_call = lambda *a, **k: self.logs.append({"args": a, "kw": k})
        self.reset()
        return self

    def reset(self):
        """每个用例开始前：清熔断账、设单候选默认配置。"""
        llm._KEY_BREAKER = llm._Breaker(3, 30.0)
        llm._ENDPOINT_BREAKER = llm._Breaker(4, 30.0)
        config.LLM_PROTOCOL, config.LLM_PROTOCOL2 = "openai", ""
        config.LLM_BASE_URL, config.LLM_BASE_URL2 = "https://p.test/v1", ""
        config.LLM_MODEL, config.LLM_MODEL2 = "m1", ""
        config.LLM_API_KEY, config.LLM_API_KEY2, config.LLM_API_KEY3 = "k1", "", ""
        config.LLM_REASONING_EFFORT = ""
        self.logs.clear()

    def __exit__(self, *a):
        for k_, v in self.saved.items():
            setattr(config, k_, v)
        llm._openai_request = self.real_req
        llm.shared_client = self.real_client
        llm.log_call = self.real_log
        llm._KEY_BREAKER = llm._Breaker(3, 30.0)
        llm._ENDPOINT_BREAKER = llm._Breaker(4, 30.0)
        return False


# ------------------------------------------------------------------ 用例
async def main() -> None:
    with Env() as env:
        # ---- _candidates：按优先级展开，KEY3 配了才追加异构兜底 ----
        env.reset()
        cands = llm._candidates()
        record("candidates_single_key", len(cands) == 1
               and cands[0].key == "k1" and cands[0].base_url == "https://p.test/v1")

        env.reset()
        config.LLM_API_KEY2, config.LLM_API_KEY3 = "k2", "k3"
        config.LLM_BASE_URL2, config.LLM_MODEL2, config.LLM_PROTOCOL2 = (
            "https://q.test/v1", "m2", "anthropic")
        cands = llm._candidates()
        record("candidates_fallback",
               [c.key for c in cands] == ["k1", "k2", "k3"]
               and cands[2].protocol == "anthropic" and cands[2].model == "m2")

        env.reset()
        config.LLM_API_KEY3 = "k3"  # 只配 Key，URL/模型/协议应回落主端点的值
        cands = llm._candidates()
        record("candidates_fallback_defaults",
               len(cands) == 2 and cands[1].base_url == "https://p.test/v1"
               and cands[1].model == "m1" and cands[1].protocol == "openai")

        env.reset()
        config.LLM_API_KEY = ""
        try:
            llm._candidates()
            record("candidates_requires_key", False, "未配 Key 未报错")
        except llm.LLMError:
            record("candidates_requires_key", True)

        # ---- _retry_wait：错误分级决定"原地退避"还是"换候选" ----
        env.reset()
        e500, e429, e400 = http_err(500), http_err(429), http_err(400)
        record("retry_5xx_backoff",
               llm._retry_wait(e500, 0, False) == 0.6
               and llm._retry_wait(e500, 1, False) == 1.2
               and llm._retry_wait(e500, 2, False) is None)
        record("retry_429_prefers_next_key",
               llm._retry_wait(e429, 0, False) is None
               and llm._retry_wait(e429, 0, True) == 1.5
               and llm._retry_wait(e429, 1, True) is None)
        record("retry_4xx_no_retry", llm._retry_wait(e400, 0, False) is None)
        record("retry_transport_backoff",
               llm._retry_wait(conn_err(), 0, False) == 0.6)

        # ---- _failure_kind：熔断口径 ----
        record("failure_kind",
               llm._failure_kind(http_err(401)) == "key"
               and llm._failure_kind(http_err(403)) == "key"
               and llm._failure_kind(http_err(429)) == "key"
               and llm._failure_kind(http_err(500)) == "endpoint"
               and llm._failure_kind(http_err(400)) is None
               and llm._failure_kind(conn_err()) == "endpoint"
               and llm._failure_kind(json.JSONDecodeError("x", "x", 0)) == "endpoint")

        # ---- _Breaker 状态机（小冷却便于测 half-open）----
        b = llm._Breaker(threshold=3, cooldown_s=0.05)
        record("breaker_closed_allows", b.allow("k") and not b.still_blocked("k"))
        for _ in range(3):
            b.record_failure("k")
        record("breaker_opens_at_threshold", not b.allow("k") and b.still_blocked("k"))
        time.sleep(0.06)
        record("breaker_half_open_single_probe",
               b.allow("k") and not b.allow("k") and b.still_blocked("k"))
        b.record_failure("k")  # 探测失败立即再断
        record("breaker_probe_fail_reopens", not b.allow("k"))
        time.sleep(0.06)
        b.allow("k")
        b.record_success("k")
        record("breaker_probe_ok_closes", b.allow("k") and not b.still_blocked("k"))
        # 探测被遗弃（领到名额后没人回来报告）按再次断开处理
        for _ in range(3):
            b.record_failure("k")
        time.sleep(0.06)
        b.allow("k")
        time.sleep(0.06)
        record("breaker_abandoned_probe_reopens", not b.allow("k"))

        # ---- complete()：5xx 退避后在同一候选上成功 ----
        env.reset()
        calls = []

        async def flaky(client, cand, body):
            calls.append(cand.key)
            if len(calls) < 3:
                raise http_err(500)
            return _Resp(ok_payload("回了", usage={"prompt_tokens": 10, "completion_tokens": 3}))

        llm._openai_request = flaky
        llm.shared_client = lambda: None
        llm._RETRY_BACKOFF_S = 0.01
        try:
            out = await llm.complete([{"role": "user", "content": "hi"}], caller="t")
        finally:
            llm._RETRY_BACKOFF_S = 0.6
        retry_log = [r for r in env.logs if "重试" in str(r["args"])]
        usage_log = [r for r in env.logs if r["kw"].get("usage")]
        record("complete_retries_then_ok",
               out == "回了" and calls == ["k1", "k1", "k1"] and len(retry_log) == 2,
               f"calls={calls}")
        record("complete_logs_real_usage",
               bool(usage_log) and usage_log[0]["kw"]["usage"] == {"in": 10, "out": 3})

        # ---- complete()：主 Key 401 → 换备 Key；熔断记住死 Key ----
        env.reset()
        config.LLM_API_KEY2 = "k2"
        calls = []

        async def key_switch(client, cand, body):
            calls.append(cand.key)
            if cand.key == "k1":
                raise http_err(401)
            return _Resp(ok_payload("备Key回了"))

        llm._openai_request = key_switch
        out = await llm.complete([{"role": "user", "content": "hi"}], caller="t")
        record("complete_failover_key", out == "备Key回了" and calls == ["k1", "k2"])
        record("breaker_counts_dead_key", llm._KEY_BREAKER._states.get(llm._kid(
            llm._Cand("openai", "https://p.test/v1", "m1", "k1")), [0])[0] == 1)

        # ---- complete()：熔断阈值到点后死 Key 被整段跳过 ----
        cand1 = llm._Cand("openai", "https://p.test/v1", "m1", "k1")
        for _ in range(3):
            llm._KEY_BREAKER.record_failure(llm._kid(cand1))
        calls.clear()

        async def only_k2(client, cand, body):
            calls.append(cand.key)
            return _Resp(ok_payload("直接走备Key"))

        llm._openai_request = only_k2
        out = await llm.complete([{"role": "user", "content": "hi"}], caller="t")
        record("breaker_skips_dead_key", out == "直接走备Key" and calls == ["k2"],
               f"calls={calls}")

        # ---- complete()：全熔断照旧尝试（可能已恢复的服务好过确定失败）----
        env.reset()
        for _ in range(3):
            llm._KEY_BREAKER.record_failure(llm._kid(cand1))
        calls.clear()
        llm._openai_request = only_k2
        out = await llm.complete([{"role": "user", "content": "hi"}], caller="t")
        record("all_blocked_still_tries", out == "直接走备Key" and calls == ["k1"])

        # ---- complete()：400 不重试不换 Key 白等，直接往下走 ----
        env.reset()
        config.LLM_API_KEY2 = "k2"
        calls = []

        async def bad_request(client, cand, body):
            calls.append(cand.key)
            raise http_err(400)

        llm._openai_request = bad_request
        try:
            await llm.complete([{"role": "user", "content": "hi"}], caller="t")
            record("complete_400_fails_fast", False, "400 未抛错")
        except llm.LLMError:
            record("complete_400_fails_fast", calls == ["k1", "k2"],
                   f"calls={calls}（400 无意义重试，各试一次即换）")

        # ---- complete()：视觉被拒 → 全候选都不行 → LLMVisionUnsupported ----
        env.reset()
        msgs = [{"role": "user", "content": [
            {"type": "text", "text": "看图"},
            {"type": "image", "mime": "image/png", "data": "AA=="}]}]
        llm._openai_request = bad_request  # 400 + 带图 = 视觉被拒
        try:
            await llm.complete(msgs, caller="t")
            record("complete_vision_unsupported", False)
        except llm.LLMVisionUnsupported:
            record("complete_vision_unsupported", True)
        except llm.LLMError as e:
            record("complete_vision_unsupported", False, f"抛了普通 LLMError: {e}")

        # ---- stream()：首个 token 前失败可退避重试 ----
        env.reset()
        client = _Client()
        client.scripts = [[conn_err()], [openai_delta("流"), openai_delta("式回")]]
        llm.shared_client = lambda: client
        llm._RETRY_BACKOFF_S = 0.01
        try:
            toks = [t async for t in llm.stream(
                [{"role": "user", "content": "hi"}], caller="t")]
        finally:
            llm._RETRY_BACKOFF_S = 0.6
        record("stream_retries_before_first_token",
               toks == ["流", "式回"] and len(client.calls) == 2)

        # ---- stream()：已吐 token 后断流绝不重发 ----
        env.reset()
        client = _Client()
        client.scripts = [[openai_delta("已吐"), conn_err()],
                          [openai_delta("绝不该出现")]]
        llm.shared_client = lambda: client
        toks, err = [], None
        try:
            async for t in llm.stream([{"role": "user", "content": "hi"}], caller="t"):
                toks.append(t)
        except Exception as e:  # noqa: BLE001
            err = e
        record("stream_no_replay_after_tokens",
               toks == ["已吐"] and err is not None and len(client.calls) == 1,
               f"toks={toks} calls={len(client.calls)}")

        # ---- stream()：usage 结尾 chunk 记账 ----
        env.reset()
        client = _Client()
        client.scripts = [[openai_delta("hi"),
                           sse({"choices": [], "usage": {"prompt_tokens": 7,
                                                         "completion_tokens": 2}})]]
        llm.shared_client = lambda: client
        async for _ in llm.stream([{"role": "user", "content": "hi"}], caller="t"):
            pass
        u = [r["kw"].get("usage") for r in env.logs if r["kw"].get("usage")]
        record("stream_logs_usage", u == [{"in": 7, "out": 2}], f"logs={env.logs}")

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{'=' * 60}\n{len(RESULTS) - len(fails)}/{len(RESULTS)} 通过")
    if fails:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
