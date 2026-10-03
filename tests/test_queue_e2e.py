"""用本机 Chrome 无头模式验证「打断两档 + 消息队列」的实际行为（不依赖 playwright）。

做法：
  1. 复制 web/ 到临时目录，注入一个假的后端（拦截 fetch，模拟 SSE 慢流）；
  2. 直接 import app.js 的模块级函数不方便（它会立刻跑 init），所以改为
     用真实页面 + 打桩 fetch：页面走自己的启动流程，我们喂它一条慢速 SSE；
  3. 在页内驱动：登录 → 发一条 → 在流未结束时再发两条 → 断言排队而不是被吞；
     再验证暂停冻结队列、停止放行队列。

用法：python tests/test_queue_e2e.py
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


def find_browser() -> str | None:
    for p in CHROME_CANDIDATES:
        if Path(p).exists():
            return p
    return None


# 页面里的探针：打桩 fetch，然后驱动真实的 app.js 逻辑。
PROBE = r"""
<script type="module">
// ---- 假后端：SSE 慢流，由测试通过 window.__push / __end 控制 ----
const enc = new TextEncoder();
let sseCtl = null;
const calls = [];
window.__calls = calls;

function sseStream() {
  let ctl;
  const stream = new ReadableStream({
    start(c) { ctl = c; },
  });
  sseCtl = ctl;
  return stream;
}

const realFetch = window.fetch;
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (u.includes("/api/chat")) {
    calls.push(body.message);
    const stream = sseStream();
    // 立刻回一个 mode 事件，模拟"开始回答"
    queueMicrotask(() => {
      try { sseCtl.enqueue(enc.encode('data: {"type":"mode","mode":"chat"}\n\n')); } catch {}
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  // 其余接口一律给个空壳，别让启动流程炸掉
  if (/\/api\/(briefing|affairs|graph|history|greeting)/.test(u)) {
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
};

// 测试用：往当前 SSE 里推一个真事件
window.__push = (obj) => {
  try {
    sseCtl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
    return true;
  } catch { return false; }
};
window.__end = () => { try { sseCtl.close(); } catch {} };

// ---- 结果收集 ----
const out = [];
window.__rec = (name, ok, note = "") => out.push({ name, ok, note });

window.addEventListener("load", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const mod = await import("./app.js");

  // 绕过登录，直接落进主视图（测试只关心对话控制逻辑）
  const S = mod.__state ? mod.__state() : null;
  if (!S) {
    window.__rec("test_hook", false, "app.js 没导出 __state 测试钩子");
    const pre = document.createElement("pre");
    pre.id = "probe";
    pre.textContent = "PROBE:" + JSON.stringify(out);
    document.body.appendChild(pre);
    return;
  }
  mod.__login("测试小朋友", "child");

  // ① 发第一条：流保持打开（模拟"管家还在回"）
  $("#msg-input").value = "第一条";
  mod.send();
  await sleep(60);
  window.__rec("first_sent", window.__calls.length === 1, "calls=" + window.__calls.join("|"));
  window.__rec("busy_after_first", S.busy === true, "busy=" + S.busy);
  window.__rec("pause_visible", !$("#pause-btn").classList.contains("hidden"));

  // ② 流还没结束，再发两条：应当排队，不当场发出去
  $("#msg-input").value = "第二条";
  mod.send();
  await sleep(30);
  $("#msg-input").value = "第三条";
  mod.send();
  await sleep(60);
  window.__rec("queued_not_sent", window.__calls.length === 1, "calls=" + window.__calls.join("|"));
  window.__rec("queue_len_2", S.msgQueue.length === 2, "len=" + S.msgQueue.length);
  window.__rec("queue_visible", !$("#msg-queue").classList.contains("hidden"));
  window.__rec("queue_items_rendered", $("#msg-queue").querySelectorAll(".mq-item").length === 2);
  window.__rec("queue_input_cleared", $("#msg-input").value === "", "val=" + JSON.stringify($("#msg-input").value));

  // ③ 撤下一条：队列变 1，且撤下的那条不再发
  $("#msg-queue").querySelector(".mq-item").click();
  await sleep(40);
  window.__rec("dequeue_works", S.msgQueue.length === 1, "len=" + S.msgQueue.length);
  window.__rec("dequeue_kept_second", S.msgQueue[0] && S.msgQueue[0].text === "第三条",
               "head=" + (S.msgQueue[0] && S.msgQueue[0].text));

  // ④ 让第一条正常结束（done + 关流）：队列应自动接着发
  window.__push({ type: "token", text: "第一条的答复" });
  await sleep(40);
  window.__push({ type: "done" });
  window.__push({ type: "voice", url: "/x.mp3" });
  window.__end();
  await sleep(200);
  window.__rec("queue_auto_drains", window.__calls.length === 2, "calls=" + window.__calls.join("|"));
  window.__rec("queue_empty_after", S.msgQueue.length === 0, "len=" + S.msgQueue.length);
  window.__rec("drained_is_remaining", window.__calls[1] === "第三条", "sent=" + window.__calls[1]);
  window.__rec("queue_hidden_when_empty", $("#msg-queue").classList.contains("hidden"));

  // ⑤ 暂停冻结队列：发一条 → 流未结束时再排一条 → 暂停 → 那条不该被发
  await sleep(50);
  $("#msg-input").value = "第四条";
  mod.send();
  await sleep(60);
  $("#msg-input").value = "第五条";
  mod.send();
  await sleep(60);
  const before = window.__calls.length;
  mod.pauseChat();
  await sleep(200);
  window.__rec("pause_froze_queue", window.__calls.length === before, "calls=" + window.__calls.join("|"));
  window.__rec("queue_survives_pause", S.msgQueue.length === 1, "len=" + S.msgQueue.length);
  window.__rec("resume_chip_shown", !!$("#chips .chip-resume"));

  // ⑥ 停止：放行队列，且不给「继续」入口
  mod.stopChat();
  await sleep(200);
  window.__rec("stop_released_queue", window.__calls.length > before, "calls=" + window.__calls.join("|"));
  window.__rec("stop_no_resume_chip", !$("#chips .chip-resume"), "");
  window.__rec("stop_clears_resume_state", S.chatResume === null, "resume=" + S.chatResume);
  window.__rec("stop_added_sys", document.querySelector("#chat").textContent.includes("回答已停止"));

  const pre = document.createElement("pre");
  pre.id = "probe";
  pre.textContent = "PROBE:" + JSON.stringify(out);
  document.body.appendChild(pre);
});
</script>
"""


def run(browser: str, tmp: Path) -> None:
    page = tmp / "web" / "queue_probe.html"
    html = (tmp / "web" / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="static/', 'href="').replace('src="static/', 'src="')
    html = html.replace("</body>", PROBE + "</body>")
    page.write_text(html, encoding="utf-8")

    cmd = [browser, "--headless=new", "--disable-gpu", "--no-sandbox",
           "--virtual-time-budget=8000", "--dump-dom", page.as_uri()]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=120)
    dom = proc.stdout or ""
    m = re.search(r"PROBE:(\[.*?\])</pre>", dom, re.S)
    if not m:
        record("chrome_probe", False, f"没拿到探针输出（stderr={proc.stderr[-300:] if proc.stderr else ''}）")
        return
    for item in json.loads(m.group(1)):
        record(item["name"], bool(item["ok"]), item.get("note", ""))


def main() -> int:
    browser = find_browser()
    if not browser:
        print("未找到本机 Chrome/Edge，跳过队列行为验证（不影响其它测试）")
        return 0
    tmp = Path(tempfile.mkdtemp(prefix="panda_queue_"))
    try:
        shutil.copytree(WEB, tmp / "web")
        run(browser, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    for name, ok, note in RESULTS:
        if not ok:
            print(f"  失败：{name}  {note}")
    return 0 if passed == len(RESULTS) and RESULTS else 1


if __name__ == "__main__":
    sys.exit(main())
