"""LLM 客户端：同时支持 OpenAI 兼容协议与 Anthropic Messages 协议。

通过环境变量切换：
  LLM_PROTOCOL=openai     -> POST {LLM_BASE_URL}/chat/completions
  LLM_PROTOCOL=anthropic  -> POST {LLM_BASE_URL}/v1/messages
备用 Key：LLM_API_KEY2 在主 Key 失败时自动顶替。
"""
from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx

from . import config


class LLMError(RuntimeError):
    pass


LOG_DIR = config.DATA_DIR / "logs"


def log_call(caller: str, ok: bool, ms: float, err: str = "") -> None:
    """每次 LLM 调用留痕（评委可查 API 调用记录，证明真生成）。"""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        rec = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "caller": caller,
            "protocol": config.LLM_PROTOCOL,
            "model": config.LLM_MODEL,
            "ms": round(ms),
            "ok": ok,
        }
        if err:
            rec["err"] = err[:200]
        with open(LOG_DIR / "llm_calls.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def read_logs(limit: int = 50) -> list[dict]:
    try:
        lines = (LOG_DIR / "llm_calls.jsonl").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _keys() -> list[str]:
    keys = [k for k in (config.LLM_API_KEY, config.LLM_API_KEY2) if k]
    if not keys:
        raise LLMError("未配置 LLM_API_KEY，请填写 .env 或设置环境变量")
    return keys


def _split_system(messages: list[dict]) -> tuple[str, list[dict]]:
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    rest = [m for m in messages if m["role"] != "system"]
    return system, rest


async def _openai_request(client: httpx.AsyncClient, key: str, body: dict) -> httpx.Response:
    return await client.post(
        f"{config.LLM_BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json=body,
    )


async def _anthropic_request(client: httpx.AsyncClient, key: str, body: dict) -> httpx.Response:
    base = config.LLM_BASE_URL
    url = f"{base}/v1/messages" if not base.endswith("/v1") else f"{base}/messages"
    return await client.post(
        url,
        headers={
            "x-api-key": key,
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
    """非流式补全，返回文本。主备 Key 各尝试一次。"""
    t0 = time.monotonic()
    last_err: Exception | None = None
    for key in _keys():
        try:
            async with httpx.AsyncClient(timeout=config.LLM_TIMEOUT) as client:
                if config.LLM_PROTOCOL == "anthropic":
                    system, rest = _split_system(messages)
                    resp = await _anthropic_request(client, key, {
                        "model": config.LLM_MODEL,
                        "max_tokens": max_tokens,
                        "temperature": temperature,
                        "system": system,
                        "messages": rest,
                    })
                    resp.raise_for_status()
                    data = resp.json()
                    out = "".join(b.get("text", "") for b in data.get("content", []))
                    log_call(caller, True, (time.monotonic() - t0) * 1000)
                    return out
                resp = await _openai_request(client, key, {
                    "model": config.LLM_MODEL,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "stream": False,
                })
                resp.raise_for_status()
                out = resp.json()["choices"][0]["message"]["content"] or ""
                log_call(caller, True, (time.monotonic() - t0) * 1000)
                return out
        except Exception as e:  # noqa: BLE001 主备切换需要捕获一切
            last_err = e
    log_call(caller, False, (time.monotonic() - t0) * 1000, str(last_err))
    raise LLMError(f"LLM 调用失败: {last_err}")


async def stream(
    messages: list[dict],
    *,
    max_tokens: int = 1200,
    temperature: float = 0.7,
    caller: str = "unknown",
) -> AsyncIterator[str]:
    """流式补全，逐段产出文本。协议细节对外屏蔽。"""
    t0 = time.monotonic()
    key = _keys()[0]
    async with httpx.AsyncClient(timeout=config.LLM_TIMEOUT) as client:
        if config.LLM_PROTOCOL == "anthropic":
            system, rest = _split_system(messages)
            req = client.stream(
                "POST",
                f"{config.LLM_BASE_URL}/v1/messages",
                headers={
                    "x-api-key": key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": config.LLM_MODEL,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "system": system,
                    "messages": rest,
                    "stream": True,
                },
            )
        else:
            req = client.stream(
                "POST",
                f"{config.LLM_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": config.LLM_MODEL,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "stream": True,
                },
            )
        async with req as resp:
            resp.raise_for_status()
            got = False
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
                if config.LLM_PROTOCOL == "anthropic":
                    if chunk.get("type") == "content_block_delta":
                        text = chunk.get("delta", {}).get("text", "")
                        if text:
                            got = True
                            yield text
                else:
                    for choice in chunk.get("choices", []):
                        text = choice.get("delta", {}).get("content") or ""
                        if text:
                            got = True
                            yield text
            log_call(caller, got, (time.monotonic() - t0) * 1000,
                     "" if got else "流式响应为空")


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
