"""语音输入的真浏览器自检：无头 Chrome + 假麦克风，把整条前端链路跑一遍。

为什么需要它：离线套件（test_asr.py）只到 HTTP 边界为止，`web/app.js` 里
MediaRecorder → 解码重采样 → 编 16k wav → multipart 上传 这段没有任何覆盖，
而这正是"语音识别到底能不能用"最要紧的地方。

做法（沿用 test_pause_layout.py 的本机 Chrome 思路，但不用 --dump-dom）：
  1. 沙箱数据目录 + 假 LLM + 假 ASR 上游（transcribe 直接返回固定句子），
     用 uvicorn 在后台线程起真服务，并挂一个 /__probe 收页面回传的结果；
  2. 把 index.html 注入一段探针脚本后放进临时目录，并把 config.WEB_DIR 指过去
     （`GET /` 是请求时读 config.WEB_DIR 的，所以页面来自临时副本，而
     /static/app.js 仍是仓库里那份真实前端代码——我们测的就是它）；
  3. Chrome 无头 + --use-fake-device-for-media-stream（假麦克风，自动授权）打开页面，
     探针自动登录 → 点语音键录音 → 再点一下停 → 等输入框被识别结果填上，
     最后 fetch('/__probe') 把结果回传（不靠 stdout，也就绕开了管道限制）；
  4. Python 侧等这个回传，断言"输入框里是假上游那句识别文本"。

用法：python tests/test_asr_web.py（本机没有 Chrome/Edge 时自动跳过，不算失败）

注意：浏览器自己的 IPC 走命名管道，某些受限沙箱会拦（表现为 chromium 日志里
`mojo platform_channel Check failed: 拒绝访问`）。这时该用例会打印日志尾部后失败，
不是语音链路的锅——换一个有进程/管道权限的环境跑即可。
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ["PANDA_DATA_DIR"] = tempfile.mkdtemp(prefix="panda_asr_web_")
os.environ["PANDA_CHILD_PASSWORD"] = ""     # 用种子口令 panda123
os.environ["TTS_ENABLED"] = "0"
os.environ["TTS_API_KEY"] = ""
os.environ["ASR_ENABLED"] = "1"
os.environ["ASR_API_KEY"] = "sk-fake"
for _m in [m for m in sys.modules if m == "server" or m.startswith("server.")]:
    del sys.modules[_m]

from server import asr, config, llm  # noqa: E402
from server.main import app  # noqa: E402
from fastapi.responses import PlainTextResponse  # noqa: E402

SANDBOX = Path(os.environ["PANDA_DATA_DIR"])
SPOKEN = "我明天想去遛熊猫"
CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
]

PROBE = """
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = (ok, note) => fetch("/__probe?ok=" + encodeURIComponent(ok)
                                     + "&text=" + encodeURIComponent(note)).catch(() => {});
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (fn()) return true; } catch (e) { /* 元素还没出来 */ }
      await sleep(120);
    }
    return false;
  };
  // 先报一次"探针活着"：如果连这条都收不到，说明问题在页面/服务，不在语音链路
  report("boot", "probe-script-loaded");
  window.addEventListener("load", () => {
    (async () => {
      const name = document.querySelector("#login-name");
      const pass = document.querySelector("#login-pass");
      const loginBtn = document.querySelector("#login-btn");
      if (!name || !pass || !loginBtn) return report("fail", "没有登录表单");
      name.value = "小豆";
      pass.value = "panda123";
      loginBtn.click();
      const mainView = document.querySelector("#main-view");
      if (!await waitFor(() => mainView && !mainView.classList.contains("hidden"), 20000)) {
        return report("fail", "登录后没进主界面："
                      + (document.querySelector("#login-hint") || {}).textContent);
      }
      const btn = document.querySelector("#mic-btn");
      // setupMic 跑过之后按钮才可见（家长/未登录时它应当是隐藏的）
      if (!await waitFor(() => btn && !btn.classList.contains("hidden"), 10000)) {
        return report("fail", "语音键没出现，title=" + (btn && btn.title));
      }
      if (!/开始说/.test(btn.title || "")) return report("fail", "语音键提示不对：" + btn.title);
      // 假麦克风只认"真按一下"：先开始录，隔 1.2 秒再点一下停
      btn.click();
      if (!await waitFor(() => btn.classList.contains("recording"), 6000)) {
        return report("fail", "点了没进入录音态，title=" + btn.title);
      }
      await sleep(1200);
      btn.click();
      const input = document.querySelector("#msg-input");
      const got = await waitFor(() => input && input.value.trim().length > 0, 20000);
      return report(got ? "ok" : "fail",
                    got ? input.value.trim() : "输入框一直是空的（录音没上传成功？）");
    })().catch((e) => report("fail", "探针异常：" + (e && e.message)));
  });
})();
"""

BOX: dict = {}
DONE = threading.Event()


def _find_browser() -> str | None:
    return next((p for p in CHROME_CANDIDATES if Path(p).exists()), None)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _patch_llm() -> None:
    """假 LLM：省掉真实调用与等待，页面只关心输入栏那条链路。"""
    async def fake_complete(messages, **kw):
        return "离线回复"

    async def fake_stream(messages, **kw):
        yield "离线"

    async def fake_json(messages, **kw):
        return {"intent": "chat", "mood": "normal", "affair_id": None, "reason": "离线"}

    llm.complete, llm.stream, llm.complete_json = fake_complete, fake_stream, fake_json
    llm.log_call = lambda *a, **k: None


def _serve(web_dir: Path) -> tuple[str, object]:
    """后台线程起 uvicorn，返回 (base_url, server)。"""
    import uvicorn

    config.WEB_DIR = web_dir          # GET / 是请求时读它，页面取自注入探针的副本
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    t0 = time.time()
    while not server.started and time.time() - t0 < 20:
        time.sleep(0.1)
    return f"http://127.0.0.1:{port}", server


@app.get("/__probe")
async def _probe(ok: str = "", text: str = ""):
    """页面把自检结果回传到这里（比抓 Chrome stdout 可靠，也避开管道限制）。"""
    BOX["ok"], BOX["text"] = ok, text
    if ok != "boot":
        DONE.set()
    return {"ok": True}


@app.get("/__probe.js")
async def _probe_js():
    """探针必须走**外部同源脚本**：站点的 CSP 是 script-src 'self'，
    内联 <script> 会被直接拦掉（这正是仓库"前端零内联脚本"那条纪律）。"""
    return PlainTextResponse(PROBE, media_type="text/javascript")


def main() -> int:
    browser = _find_browser()
    if not browser:
        print("未找到本机 Chrome/Edge，跳过真浏览器自检（不影响其它测试）")
        return 0

    _patch_llm()
    # 假 ASR 上游：只要前端真的把一段 wav 传上来了，这里就"识别"出 SPOKEN
    seen: dict = {}

    async def fake_transcribe(data: bytes, *, caller: str = "voice_input") -> str:
        seen["bytes"] = len(data)
        seen["fmt"] = asr.sniff_format(data)
        return SPOKEN

    asr.transcribe = fake_transcribe

    tmp = Path(tempfile.mkdtemp(prefix="panda_asr_page_"))
    proc = None
    try:
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        (tmp / "index.html").write_text(
            html.replace("</body>", '<script src="/__probe.js"></script></body>'),
            encoding="utf-8")
        # 根路径下发的文件都从 config.WEB_DIR 读（GET / 与 GET /sw.js），
        # 临时目录里也得有一份 sw.js，否则页面请求它会让服务端抛 FileNotFoundError
        shutil.copy(ROOT / "web" / "sw.js", tmp / "sw.js")
        base, server = _serve(tmp)
        # Chrome 的日志写到文件而不是管道：沙箱下拿管道抓子进程输出会被拒
        log = (tmp / "chrome.log").open("wb")
        proc = subprocess.Popen(
            [browser, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
             "--autoplay-policy=no-user-gesture-required", "--mute-audio",
             "--enable-logging=stderr", "--v=0",
             f"--user-data-dir={tmp / 'chrome-profile'}", f"{base}/"],
            stdout=log, stderr=log)
        # 浏览器起不来（沙箱拦 IPC、缺依赖）时立刻失败，别干等满 90 秒
        deadline = time.time() + 90
        while time.time() < deadline and not DONE.is_set() and proc.poll() is None:
            time.sleep(0.3)
        ok = DONE.is_set()
        server.should_exit = True
        log.close()

        results: list[tuple[str, bool, str]] = []
        if not ok:
            tail = ""
            try:
                tail = (tmp / "chrome.log").read_text(encoding="utf-8", errors="replace")[-500:]
            except OSError:
                pass
            why = ("浏览器进程已退出" if proc.poll() is not None else "90 秒超时")
            results.append(("web_probe_reported", False,
                            f"页面没回传结果（{why}；最后一次回传：{BOX or '一次都没有'}）"
                            f"\n--- chrome log 尾部 ---\n{tail}"))
        else:
            results.append(("web_probe_reported", True, f"ok={BOX.get('ok')}"))
            results.append(("web_mic_records_and_fills_input",
                            BOX.get("ok") == "ok" and BOX.get("text") == SPOKEN,
                            f"输入框={BOX.get('text')!r}"))
            results.append(("web_upload_is_16k_wav",
                            seen.get("fmt") == "wav" and seen.get("bytes", 0) > 2000,
                            f"容器={seen.get('fmt')} 字节={seen.get('bytes')}"))
        for name, good, note in results:
            print(f"{'PASS' if good else 'FAIL'}  {name}  {note}")
        passed = sum(1 for _, good, _ in results if good)
        print(f"\n{passed}/{len(results)} 通过")
        return 0 if passed == len(results) else 1
    finally:
        if proc:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(SANDBOX, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
