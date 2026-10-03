"""Web 静态一致性检查：不启动浏览器，检查 id/class/函数引用是否对得上。

用法：python tests/test_web_static.py

覆盖：
  - HTML 里出现的 id 与 app.js 里 $("#id") 的选择器一一对应（防止改了 HTML 忘了 JS）
  - HTML 里 <use href="#icon"> 的图标 symbol 都存在
  - app.js / style.css 大括号配平（粗粒度语法体检）
  - 暂停键、断网条、继续入口这些新增元素的关键钩子都在
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    RESULTS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {note}")


def read(name: str) -> str:
    return (WEB / name).read_text(encoding="utf-8")


def test_ids_resolve() -> None:
    html, js = read("index.html"), read("app.js")
    html_ids = set(re.findall(r'\bid="([^"]+)"', html))
    # 运行时动态建出来的容器（抽屉/梦想卡/底部 tab 栏），HTML 里本来就没有
    dynamic = {"affair-detail", "dream-out", "tabbar"}
    used = set(re.findall(r'\$\("#([A-Za-z0-9_-]+)"\)', js))
    missing = sorted(i for i in used if i not in html_ids and i not in dynamic)
    record("js_ids_exist_in_html", not missing, f"缺失={missing}")


def test_icons_resolve() -> None:
    html = read("index.html")
    defined = set(re.findall(r'<symbol id="(i-[a-z0-9-]+)"', html))
    used = set(re.findall(r'href="#(i-[a-z0-9-]+)"', html))
    used |= set(re.findall(r'icon\("(i-[a-z0-9-]+)"', read("app.js")))
    missing = sorted(i for i in used if i not in defined)
    record("icons_defined", not missing, f"缺失={missing}")


def test_braces_balanced() -> None:
    for name in ("app.js", "style.css"):
        src = read(name)
        record(f"{name}_braces", src.count("{") == src.count("}"),
               f"{{={src.count('{')} }}={src.count('}')}")
    for name in ("app.js", "index.html"):
        src = read(name)
        record(f"{name}_parens", src.count("(") == src.count(")"),
               f"(={src.count('(')} )={src.count(')')}")


def test_comment_parens_balanced() -> None:
    """注释里也不许出现"只有右括号"的写法（如序号 `1)` `2)`）。

    整个文件的括号配平是粗粒度计数，注释同样计入。注释里写 `1)` 会让统计差出
    负值、把 app.js_parens 判红，而代码本身完全正常——排查起来很费时间。
    序号统一写 `1.`，这样这条守卫和配平检查都稳定。
    """
    src = read("app.js")
    bad = []
    for i, ln in enumerate(src.splitlines(), 1):
        s = ln.strip()
        if (s.startswith("//") or s.startswith("*") or s.startswith("/*")) \
                and ln.count(")") > ln.count("("):
            bad.append(f"行{i}")
    record("comment_parens_balanced", not bad, f"注释里只有右括号：{bad[:8]}")


# 前端模块按 ES module 解析。括号配平挡不住"同一作用域重复声明"——
# 那是模块解析期就抛的 SyntaxError，整个 app.js 不会执行，页面永远停在启动层。
# 注意 node --check 对含 import 的文件按 CommonJS 解析，会漏报重复声明，
# 所以这里把源码落到 .mjs 再检查（与浏览器一致）。
ESM_MODULES = ("app.js", "admin.js", "scene3d.js", "graph2d.js", "panda.js",
               "panda3d.js", "splash.js", "sw.js")


def test_es_modules_parse() -> None:
    import shutil
    import subprocess
    import tempfile

    node = shutil.which("node")
    if not node:
        record("esm_parse_skipped", True, "本机无 node，跳过（CI 上应安装 node ）")
        return
    with tempfile.TemporaryDirectory() as tmp:
        for name in ESM_MODULES:
            mod = Path(tmp) / (name.replace(".js", "") + ".mjs")
            mod.write_text(read(name), encoding="utf-8")
            r = subprocess.run([node, "--check", str(mod)],
                               capture_output=True, text=True, timeout=30)
            first = (r.stderr or "").strip().splitlines()
            detail = next((l.strip() for l in first if "Error" in l), " ".join(first[:2]))
            record(f"{name}_esm_parse", r.returncode == 0, detail[:120])


def reset_src() -> str:
    """resetUserUI 的函数体（断言"切账号时把上一轮状态清干净"）。"""
    js = read("app.js")
    start = js.find("function resetUserUI")
    return js[start:start + 2000] if start >= 0 else ""


def _rule_depth(css: str, selector: str) -> int | None:
    """选择器所在的大括号深度：0 = 顶层，1+ = 嵌在 @media 等块内。找不到返回 None。"""
    depth = 0
    for line in css.splitlines():
        if depth == 0 and line.strip().startswith(selector):
            return depth
        depth += line.count("{") - line.count("}")
    return None


def test_wiring() -> None:
    html, js, css = read("index.html"), read("app.js"), read("style.css")
    # 暂停键必须在输入栏里（和发送键同排），且不再浮在对话栏
    inputbar = re.search(r'<div class="inputbar">(.*?)</div>', html, re.S)
    inside = inputbar.group(1) if inputbar else ""
    record("pause_btn_in_inputbar", 'id="pause-btn"' in inside)
    record("pause_btn_before_send",
           inside.find('id="pause-btn"') < inside.find('id="send-btn"') >= 0)
    record("pause_btn_not_floating", "position: absolute; right: 16px; bottom: 78px" not in css)
    record("pause_btn_outside_media", _rule_depth(css, ".pause-btn {") == 0,
           f"depth={_rule_depth(css, '.pause-btn {')}")
    record("send_hidden_when_busy", '.inputbar[data-busy="1"] .btn-send' in css)
    record("pause_wired", 'on("#pause-btn", pauseChat)' in js)
    record("esc_pauses", "if (!closed && state.busy) pauseChat();" in js)
    record("esc_ignores_ime", "e.isComposing" in js)
    record("resume_is_explicit", 'send("继续", { resume: true })' in js and "opts.resume &&" in js)
    record("resume_chip", "chip-resume" in js and ".chip-resume" in css)
    record("offline_bar", 'id="offline-bar"' in html and "setupOfflineBar" in js
           and ".offline-bar" in css)
    record("offline_wired", "setupOfflineBar();" in js)
    record("retry_entry", "retryableError" in js and ".msg.sys.retryable" in css)
    # 断网验真：兜底文本必须带"非 AI 生成"标记，且兜底问候不得写进聊天区
    record("degraded_note", "function degradedNote" in js and ".degraded-note" in css
           and js.count("degradedNote(") >= 4)
    record("degraded_greeting_not_in_chat", 'data && data.degraded ? "" : text' in js)
    # 附件（多模态上传）
    record("attach_btn_in_inputbar", 'id="attach-btn"' in inside)
    record("attach_before_input",
           inside.find('id="attach-btn"') < inside.find('id="file-input"') >= 0)
    record("attach_list_above_inputbar", 'id="attach-list"' in html
           and html.find('id="attach-list"') < html.find('<div class="inputbar">'))
    record("attach_wired", 'on("#attach-btn"' in js and 'fileInput.addEventListener("change"' in js)
    record("attach_upload_fn", "async function uploadFiles" in js)
    record("attach_dropzone", "function setupDropZone" in js and "#chat.drop-active" in css)
    record("attach_files_event", 'case "files":' in js and "filesRow" in js)
    record("attach_private_image", "loadPrivateImage" in js and "URL.createObjectURL" in js)
    record("attach_history_replay", "m.files || null" in js)
    record("attach_reset", "state.attach = [];" in reset_src())
    record("attach_css", ".attach-chip {" in css and ".msg-file {" in css)
    # 看图：点缩略图开大图（原图铺满），Esc/点背景关闭；缩略图不得裁剪原图
    record("attach_lightbox_dom",
           'id="lightbox"' in html and 'id="lightbox-img"' in html and "#i-download" in html)
    record("attach_lightbox_wired",
           "function openLightbox" in js and "function closeLightbox" in js
           and "openLightbox(f)" in js and 'on("#lightbox-close", closeLightbox)' in js)
    record("attach_lightbox_esc", "closeLightbox(); return;" in js)
    record("attach_thumb_not_cropped",
           "object-fit: cover" not in css[css.find(".attach-thumb"):css.find(".attach-thumb") + 200]
           and ".msg-file.msg-file-image img" in css)
    record("attach_img_fallback", "swapImgToIcon" in js and "async function loadPrivateImage(img, url, onFail)" in js)
    # 非图片（PDF/Word/Excel）绝不能被当成缩略图挂 <img>：原图是 octet-stream / attachment，
    # 浏览器解码失败就只剩空白，图标又被跳过——"传 Excel 不显示图标"就是这么来的
    record("attach_image_guard",
           "function isPreviewableImage" in js and "f.kind === \"image\"" in js
           and "if (isPreviewableImage(f))" in js
           and "if (f.preview) {" not in js)
    record("attach_content_url", "function fileContentUrl" in js and "f.content || f.preview" in js)


def test_pause_state_hygiene() -> None:
    js = read("app.js")
    for field in ("chatAbort", "chatPaused", "chatCtx", "chatResume"):
        record(f"state_has_{field}", re.search(rf"\b{field}:", js) is not None)
    reset = js[js.find("function resetUserUI"):]
    reset = reset[: reset.find("\nfunction ")]
    for field in ("chatAbort", "chatPaused", "chatCtx", "chatResume"):
        record(f"reset_clears_{field}", field in reset)


def main() -> int:
    try:
        test_ids_resolve()
        test_icons_resolve()
        test_braces_balanced()
        test_comment_parens_balanced()
        test_es_modules_parse()
        test_wiring()
        test_pause_state_hygiene()
    except Exception as e:  # noqa: BLE001
        record("检查脚本自身", False, repr(e))
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} 通过")
    for name, ok, note in RESULTS:
        if not ok:
            print(f"  失败：{name}  {note}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
