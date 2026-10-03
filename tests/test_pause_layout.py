"""用本机 Chrome 无头模式验证暂停键的实际布局（不依赖 playwright）。

做法：
  1. 复制 index.html，去掉 main-view / pause-btn 上的 hidden，让静态页直接呈现输入栏；
  2. Chrome --headless --dump-dom 加载这个副本（web/ 同目录，能拿到样式）；
  3. 在页内用脚本量出暂停键与发送键的矩形（左右顺序、尺寸、是否同排、是否在输入栏内）。

用法：python tests/test_pause_layout.py
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
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
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


PROBE = """
<script>
window.addEventListener("load", () => {
  const bar = document.querySelector(".inputbar");
  const pause = document.querySelector("#pause-btn");
  const send = document.querySelector("#send-btn");
  const inp = document.querySelector("#msg-input");
  const r = (n) => { const b = n.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; };
  // ① 先量"非忙碌"态：此时发送键可见、暂停键隐藏——发送键在输入框右侧那个位置
  if (pause) pause.classList.add("hidden");
  if (bar) bar.dataset.busy = "0";
  const sendSlot = send ? r(send) : null;
  // ② 再切到"回答进行中"：暂停键顶替发送键
  if (pause) pause.classList.remove("hidden");
  if (bar) bar.dataset.busy = "1";
  const out = {
    pause: pause ? r(pause) : null,
    sendSlot: sendSlot,
    input: inp ? r(inp) : null,
    bar: bar ? r(bar) : null,
    pauseInBar: !!(bar && pause && bar.contains(pause)),
    sendHidden: send ? getComputedStyle(send).display === "none" : null,
    pauseDisplay: pause ? getComputedStyle(pause).display : null,
    pauseLastVisible: !!(bar && pause && [...bar.children]
      .filter((n) => getComputedStyle(n).display !== "none").pop() === pause),
  };
  const pre = document.createElement("pre");
  pre.id = "probe";
  pre.textContent = "PROBE:" + JSON.stringify(out);
  document.body.appendChild(pre);
});
</script>
"""


def check(browser: str, tmp: Path, label: str, window: str) -> None:
    """在给定视口下量一次布局。窄屏也要能看到暂停键（旧实现只在 ≥1100px 显示）。"""
    page = tmp / "web" / f"index_{label}.html"
    html = (tmp / "web" / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="static/', 'href="').replace('src="static/', 'src="')
    html = html.replace('<section id="main-view" class="view hidden"',
                        '<section id="main-view" class="view"')
    html = html.replace('<div id="login-view" class="view"',
                        '<div id="login-view" class="view hidden"')
    html = html.replace('id="pause-btn" class="pause-btn hidden"', 'id="pause-btn" class="pause-btn"')
    html = html.replace("</body>", PROBE + "</body>")
    page.write_text(html, encoding="utf-8")

    cmd = [browser, "--headless=new", "--disable-gpu", "--no-sandbox",
           "--virtual-time-budget=4000", "--dump-dom",
           f"--window-size={window}", page.as_uri()]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=90)
    dom = proc.stdout or ""
    m = re.search(r"PROBE:(\{.*?\})</pre>", dom, re.S)
    if not m:
        record(f"{label}_chrome_probe", False,
               f"没拿到探针输出（stderr={proc.stderr[-200:] if proc.stderr else ''}）")
        return
    data = json.loads(m.group(1))
    pause, slot, bar = data["pause"], data["sendSlot"], data["bar"]
    record(f"{label}_chrome_probe", True, "量到布局")
    record(f"{label}_pause_in_inputbar", bool(data["pauseInBar"]))
    record(f"{label}_pause_same_row_as_input",
           bool(pause and data["input"] and abs(pause["y"] - data["input"]["y"]) < 30),
           f"pause.y={pause and round(pause['y'])} input.y={data['input'] and round(data['input']['y'])}")
    record(f"{label}_pause_right_of_input",
           bool(pause and data["input"] and pause["x"] > data["input"]["x"]),
           f"pause.x={pause and round(pause['x'])} input.x={data['input'] and round(data['input']['x'])}")
    record(f"{label}_pause_takes_send_slot",
           bool(pause and slot and abs(pause["x"] - slot["x"]) < 1.5
                and abs(pause["y"] - slot["y"]) < 1.5
                and abs(pause["w"] - slot["w"]) < 1.5 and abs(pause["h"] - slot["h"]) < 1.5),
           f"pause=({pause and round(pause['x'])},{pause and round(pause['y'])}) "
           f"send=({slot and round(slot['x'])},{slot and round(slot['y'])})")
    record(f"{label}_pause_is_last_in_bar", bool(data["pauseLastVisible"]))
    record(f"{label}_pause_square", bool(pause and abs(pause["w"] - pause["h"]) < 1.5
                                         and abs(pause["w"] - 42) < 1.5),
           f"w={pause and round(pause['w'], 1)} h={pause and round(pause['h'], 1)}")
    record(f"{label}_pause_inside_bar_bounds",
           bool(pause and bar and pause["x"] + pause["w"] <= bar["x"] + bar["w"] + 1
                and pause["y"] + pause["h"] <= bar["y"] + bar["h"] + 1))
    record(f"{label}_send_hidden_when_busy", data["sendHidden"] is True)
    record(f"{label}_pause_visible", data["pauseDisplay"] not in ("none", None),
           f"display={data['pauseDisplay']}")
    page.unlink(missing_ok=True)


def main() -> int:
    browser = find_browser()
    if not browser:
        print("未找到本机 Chrome/Edge，跳过布局验证（不影响其它测试）")
        return 0

    tmp = Path(tempfile.mkdtemp(prefix="panda_layout_"))
    try:
        # 在 web/ 目录里操作，index.html 相对引用的 style.css/app.js 都能取到
        shutil.copytree(WEB, tmp / "web")
        check(browser, tmp, "desktop", "1280,800")
        check(browser, tmp, "mobile", "390,844")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    for name, ok, note in RESULTS:
        if not ok:
            print(f"  失败：{name}  {note}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
