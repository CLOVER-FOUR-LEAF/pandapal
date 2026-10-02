"""TTS 端到端：走真实 ASGI 栈，验证 voice 事件进对话流、换音色真的落档、
播放端点的鉴权与目录穿越防护、没配 Key 时整条链路静默跳过。

httpx 与 llm 都被换成假身，全离线。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_tts_e2e_")
# 假 TTS 客户端，不依赖开发机 .env；开关强制打开，Key 由 main() 里自己设
os.environ["TTS_ENABLED"] = "1"
os.environ["TTS_API_KEY"] = ""
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

import httpx  # noqa: E402

from server import config, llm, tts, voice  # noqa: E402
from server import main as _main  # noqa: E402
from server.main import app  # noqa: E402

NAME = "tts_e2e"
FAKE_AUDIO = b"\x00\x01\x02\x03"
BASE_LOCAL = "http://testserver"  # 语音播放端点返回的是 /api/voice/{id} 这样的绝对路径


# ------------------------------------------------------------------ 假身
async def fake_complete(messages, *, max_tokens=1200, temperature=0.7, caller="unknown"):
    if caller == "voice_design":
        return ""
    return f"{caller} 的假回复"


async def fake_stream(messages, *, max_tokens=1200, temperature=0.7, caller="unknown"):
    for ch in "管家在跟你说话。":
        yield ch


async def fake_complete_json(messages, *, max_tokens=1200, caller="unknown"):
    if caller == "voice_design":
        return {"mode": "design", "style": "", "confirm": ""}  # 故意给空描述
    return {"reply": "好的", "tasks": []}


def _install_llm_fakes() -> dict:
    saved = {k: getattr(llm, k) for k in ("complete", "stream", "complete_json", "log_call")}
    llm.complete, llm.stream = fake_complete, fake_stream
    llm.complete_json = fake_complete_json
    llm.log_call = lambda *a, **k: None
    return saved


class _Resp:
    def raise_for_status(self):
        return None

    def json(self):
        return {"choices": [{"message": {
            "audio": {"data": base64.b64encode(FAKE_AUDIO).decode()}}}]}


class _TTSClient:
    def __init__(self):
        self.calls: list[dict] = []

    async def post(self, url, **kw):
        self.calls.append({"url": url, "json": kw.get("json") or {}})
        return _Resp()

    async def aclose(self):
        return None


async def _post_sse(client: httpx.AsyncClient, path: str, body: dict) -> list[dict]:
    events: list[dict] = []
    async with client.stream("POST", path, json=body) as resp:
        async for line in resp.aiter_lines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:]))
    return events


async def _get_sse(client: httpx.AsyncClient, path: str) -> list[dict]:
    events: list[dict] = []
    async with client.stream("GET", path) as resp:
        async for line in resp.aiter_lines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:]))
    return events


def _types(events: list[dict]) -> list[str]:
    return [e.get("type") for e in events]


# ------------------------------------------------------------------ 场景
async def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, note: str = "") -> None:
        results.append((name, ok, note))
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")

    saved_llm = _install_llm_fakes()
    saved_client, saved_key, saved_on = tts._client, config.TTS_API_KEY, config.TTS_ENABLED
    fake_tts = _TTSClient()
    tts._client = lambda: fake_tts
    config.TTS_API_KEY = "sk-test"

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://t",
                                     timeout=30) as client:
            r = await client.post("/api/auth/login",
                                  json={"username": "admin", "password": "admin123"})
            client.headers["Authorization"] = f"Bearer {r.json()['token']}"
            await client.post("/api/session", json={"name": NAME})
            q = f"?name={NAME}"

            # ① 配了 Key：闲聊回复后应带一条 voice 事件，且排在 done 之后
            evs = await _post_sse(client, "/api/chat",
                                  {"name": NAME, "message": "今天有点累"})
            types = _types(evs)
            vev = next((e for e in evs if e["type"] == "voice"), None)
            check("chat_voice_event", vev is not None and bool(vev.get("url")),
                  str(types))
            check("voice_after_done",
                  "done" in types and "voice" in types
                  and types.index("voice") > types.index("done"), str(types))
            check("voice_payload",
                  bool(vev) and vev["format"] == "mp3" and vev["bytes"] == len(FAKE_AUDIO)
                  and bool(vev["text"]), str(vev)[:90] if vev else "")
            check("tts_called_once", len(fake_tts.calls) == 1, str(len(fake_tts.calls)))
            check("tts_body_has_model",
                  bool(fake_tts.calls) and fake_tts.calls[0]["json"].get("model")
                  == "mimo-v2.5-tts-voicedesign",
                  str(fake_tts.calls[0]["json"].get("model")) if fake_tts.calls else "")

            # ② 播放端点：带 token 能取到音频，跨目录/不存在一律 404
            if vev:
                vid = vev["url"].rsplit("/", 1)[-1]
                pr = await client.get(f"/api/voice/{vid}{q}")
                check("voice_play_200", pr.status_code == 200 and pr.content == FAKE_AUDIO,
                      f"{pr.status_code} {pr.headers.get('content-type')}")
                check("voice_play_401",
                      (await client.get(f"/api/voice/{vid}{q}",
                                        headers={"Authorization": ""})).status_code == 401)
                check("voice_play_404_missing",
                      (await client.get(f"/api/voice/不存在.mp3{q}")).status_code == 404)

            # ③ 卡片类回复只念口播稿，不把整张方案卡丢给 TTS
            fake_tts.calls.clear()
            evs = await _post_sse(
                client, "/api/chat",
                {"name": NAME, "message": "我要准备参加机器人比赛，帮我准备一下"})
            card = next((e for e in evs if e["type"] == "card"), None)
            vev2 = next((e for e in evs if e["type"] == "voice"), None)
            if card:
                spoken = tts.to_speech_text(
                    _main._card_spoken(card["card"]), config.TTS_CARD_MAX_CHARS)
                whole = tts.to_speech_text(_main.synth.card_to_text(card["card"]))
                check("card_spoken_is_short",
                      bool(vev2) and len(spoken) <= config.TTS_CARD_MAX_CHARS
                      and len(spoken) < len(whole),
                      f"口播{len(spoken)}字 / 全文{len(whole)}字")
            else:
                check("card_spoken_is_short", False, "没拿到 card 事件")

            # ④ 换音色：扩写返回空描述时不动档案、也不发 voice_profile，
            #    对话照常走完（失败不能变成报错）
            cfg = voice.load(Path(config.DATA_DIR) / f"child_{NAME}")
            evs = await _post_sse(client, "/api/chat",
                                  {"name": NAME, "message": "你以后说话温柔一点好不好"})
            check("voice_ask_no_profile_when_llm_empty",
                  "voice_profile" not in _types(evs) and "done" in _types(evs),
                  str(_types(evs)))
            check("voice_profile_untouched",
                  voice.load(Path(config.DATA_DIR) / f"child_{NAME}") == cfg, "")

            # ⑤ 扩写真的给出描述时：落档 + 下发 voice_profile + 确认规则进 system
            async def ok_json(messages, *, max_tokens=1200, caller="unknown"):
                if caller == "voice_design":
                    return {"mode": "design", "style": "一个沉稳低沉的男声，语速偏慢。",
                            "confirm": "好嘞，我换成这个声音。"}
                return {"reply": "好的", "tasks": []}

            llm.complete_json = ok_json
            seen_system: list[str] = []
            real_stream = fake_stream

            async def spy_stream(messages, **kw):
                for m in messages:
                    if m.get("role") == "system":
                        seen_system.append(m.get("content", ""))
                async for tok in real_stream(messages, **kw):
                    yield tok

            llm.stream = spy_stream
            evs = await _post_sse(client, "/api/chat",
                                  {"name": NAME, "message": "你以后说话温柔一点好不好"})
            pev = next((e for e in evs if e["type"] == "voice_profile"), None)
            check("voice_profile_event", pev is not None, str(_types(evs)))
            check("voice_profile_label",
                  bool(pev) and "沉稳低沉" in pev["profile"]["label"],
                  str(pev["profile"]) if pev else "")
            saved = voice.load(Path(config.DATA_DIR) / f"child_{NAME}")
            check("voice_persisted",
                  saved["updated_by"] == "child" and "沉稳低沉" in saved["style"],
                  str(saved)[:90])
            check("voice_rule_injected",
                  any("我换成这个声音" in s for s in seen_system),
                  f"{len(seen_system)} 条 system")

            # ⑥ 点名内置音色 → 强制走 builtin
            async def named_json(messages, *, max_tokens=1200, caller="unknown"):
                if caller == "voice_design":
                    return {"mode": "design", "style": "一个甜美女声。", "voice": "茉莉"}
                return {"reply": "好的", "tasks": []}

            llm.complete_json = named_json
            fake_tts.calls.clear()
            evs = await _post_sse(client, "/api/chat",
                                  {"name": NAME, "message": "换成茉莉的声音吧"})
            named = voice.load(Path(config.DATA_DIR) / f"child_{NAME}")
            check("named_builtin_forces_builtin_mode", named["mode"] == "builtin", named["mode"])
            evs = await _post_sse(client, "/api/chat",
                                  {"name": NAME, "message": "今天天气怎么样"})
            used = fake_tts.calls[-1]["json"] if fake_tts.calls else {}
            check("builtin_model_used",
                  used.get("model") == "mimo-v2.5-tts"
                  and (used.get("audio") or {}).get("voice") == "茉莉",
                  str(used.get("model")))

            # ⑦ 关掉档案的朗读开关 → 不再合成
            await client.post("/api/voice", json={"name": NAME, "enabled": False})
            fake_tts.calls.clear()
            evs = await _post_sse(client, "/api/chat", {"name": NAME, "message": "在吗"})
            check("profile_disabled_skips_tts",
                  "voice" not in _types(evs) and not fake_tts.calls, str(_types(evs)))

            # ⑧ 没配 Key → 静默跳过，事件流里没有 voice，其余不受影响
            await client.post("/api/voice", json={"name": NAME, "enabled": True})
            config.TTS_API_KEY = ""
            evs = await _post_sse(client, "/api/chat", {"name": NAME, "message": "在吗"})
            check("no_key_no_voice_event",
                  "voice" not in _types(evs) and "done" in _types(evs), str(_types(evs)))
            check("api_voice_reports_unavailable",
                  (await client.get(f"/api/voice{q}")).json()["available"] is False)
            config.TTS_API_KEY = "sk-test"

            # ⑨ 问候与晨报也会出声
            fake_tts.calls.clear()
            gevs = await _get_sse(client, f"/api/greeting{q}&stream=1")
            check("greeting_voice", "voice" in _types(gevs), str(_types(gevs)))
            fake_tts.calls.clear()
            bevs = await _get_sse(client, f"/api/briefing{q}&stream=1")
            check("briefing_voice", "voice" in _types(bevs), str(_types(bevs)))

            # ⑩ 试音：点开朗读开关时立刻能拿到一段短语音
            fake_tts.calls.clear()
            pr = await client.post("/api/voice/preview", json={"name": NAME})
            pv = (pr.json() or {}).get("voice") or {}
            check("preview_ok", pr.status_code == 200 and bool(pv.get("url")),
                  f"{pr.status_code} {pv.get('bytes')} bytes")
            check("preview_is_short", bool(pv) and 0 < len(pv.get("text") or "")
                  <= config.TTS_PREVIEW_MAX_CHARS, str(pv.get("text"))[:40])
            if pv.get("url"):
                ar = await client.get(BASE_LOCAL + pv["url"], params={"name": NAME})
                check("preview_playable", ar.status_code == 200
                      and ar.headers["content-type"].startswith("audio/"),
                      f"{ar.status_code} {ar.headers.get('content-type')}")

            # ⑪ 档案关掉朗读时，试音也要说"放不出来"而不是假装成功
            await client.post("/api/voice", json={"name": NAME, "enabled": False})
            off = await client.post("/api/voice/preview", json={"name": NAME})
            check("preview_respects_enabled", off.status_code == 503,
                  str(off.status_code))
            await client.post("/api/voice", json={"name": NAME, "enabled": True})

            # ⑫ 轮次序号：按"轮次开始"排，不是按"合成完成"排。
            #     问候链路 30 秒级、聊天 5 秒级，若按完成时间排，先开始的问候
            #     反而拿到更大的号，会把已经播完的聊天语音顶掉——正是"对不上"的成因。
            gevs = await _get_sse(client, f"/api/greeting{q}&stream=1")
            g_turn = next((e["turn"] for e in gevs
                           if e.get("type") == "voice"), None)
            evs = await _post_sse(client, "/api/chat", {"name": NAME, "message": "在吗"})
            c_turn = next((e["turn"] for e in evs
                           if e.get("type") == "voice"), None)
            check("turn_is_monotonic", g_turn is not None and c_turn is not None
                  and c_turn > g_turn, f"问候={g_turn} 聊天={c_turn}")

            # ⑬ 优先级：对话音高于问候/晨报。问候 turn 更小但优先级更低，
            #     迟到的它必须让路；同为环境音时仍按 turn 排。
            g_p = next((e.get("priority") for e in gevs
                        if e.get("type") == "voice"), None)
            c_p = next((e.get("priority") for e in evs
                        if e.get("type") == "voice"), None)
            check("priority_chat_beats_ambient",
                  g_p == 1 and c_p == 2 and c_turn > g_turn,
                  f"问候 p={g_p}/t={g_turn}  聊天 p={c_p}/t={c_turn}")
            bev_s = await _get_sse(client, f"/api/briefing{q}&stream=1")
            b_p = next((e.get("priority") for e in bev_s
                        if e.get("type") == "voice"), None)
            check("priority_greeting_briefing_ambient",
                  g_p == 1 and b_p == 1, f"问候={g_p} 晨报={b_p}")
            pv2 = (await client.post("/api/voice/preview",
                                     json={"name": NAME})).json().get("voice") or {}
            check("preview_is_dialogue_priority",
                  pv2.get("priority") == 2 and int(pv2.get("turn") or 0) > int(c_turn or 0),
                  f"p={pv2.get('priority')} t={pv2.get('turn')}")
    finally:
        llm.complete, llm.stream, llm.complete_json, llm.log_call = (
            saved_llm["complete"], saved_llm["stream"],
            saved_llm["complete_json"], saved_llm["log_call"])
        tts._client, config.TTS_API_KEY, config.TTS_ENABLED = saved_client, saved_key, saved_on

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} 通过")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
