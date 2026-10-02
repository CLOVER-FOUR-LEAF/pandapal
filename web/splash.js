// 启动层控制器：在 app.js（ES module）及其依赖下载、解析期间盖住页面。
//
// 设计约束：
//   * 独立的同源经典脚本（defer），CSP 保持 script-src 'self'，不需要 'unsafe-inline'。
//   * 进度只跟真实里程碑走：boot（模块已执行）→ auth（正在恢复登录）→ history（主界面数据）
//     → done。两个里程碑之间只做"渐近爬升"，永远不会越过下一个里程碑，不假装加载完成。
//   * 不设强制淡出：如果真的卡住，告诉用户卡在哪，并给一个"重新加载"。
//   * 揭幕后把节点从 DOM 移除，不留常驻动画占 GPU。
(function () {
  "use strict";
  var root = document.getElementById("app-splash");
  if (!root) return;
  var bar = document.getElementById("splash-bar");
  var label = document.getElementById("splash-label");
  var slow = document.getElementById("splash-slow");
  var reload = document.getElementById("splash-reload");

  // 每个阶段：进度下限 + 文案。爬升上限 = 下一阶段的下限 - 3
  var STAGES = {
    load:    { at: 0.08, text: "正在唤醒熊猫管家…" },
    boot:    { at: 0.42, text: "正在打开管家台…" },
    auth:    { at: 0.62, text: "正在找回你的家庭档案…" },
    history: { at: 0.80, text: "正在翻开上次的聊天…" },
  };
  var ORDER = ["load", "boot", "auth", "history"];
  var idx = 0;
  var shown = STAGES.load.at;
  var finished = false;
  var raf = 0;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ceiling() {
    var next = ORDER[idx + 1];
    return next ? STAGES[next].at - 0.03 : 0.96;
  }

  function paint() {
    if (bar) bar.style.transform = "scaleX(" + shown.toFixed(4) + ")";
  }

  function tick() {
    raf = 0;
    if (finished) return;
    var cap = ceiling();
    // 每帧走剩余距离的 1.5%：越接近上限越慢，等得越久越像"还在动"而不是卡死
    if (shown < cap) {
      shown += Math.max(0.0004, (cap - shown) * 0.015);
      if (shown > cap) shown = cap;
      paint();
    }
    if (!reduce) raf = requestAnimationFrame(tick);
  }

  function stage(name) {
    if (finished) return;
    var i = ORDER.indexOf(name);
    if (i < 0 || i < idx) return; // 只前进不后退
    idx = i;
    var s = STAGES[name];
    if (shown < s.at) shown = s.at;
    if (label) label.textContent = s.text;
    paint();
    if (!raf && !reduce) raf = requestAnimationFrame(tick);
  }

  function done() {
    if (finished) return;
    finished = true;
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(slowTimer);
    clearTimeout(stuckTimer);
    shown = 1;
    paint();
    // 让进度条先走满（~180ms），再整体淡出；淡出结束后移除节点
    var gone = false;
    var remove = function () {
      if (gone) return;
      gone = true;
      if (root.parentNode) root.parentNode.removeChild(root);
    };
    setTimeout(function () {
      root.classList.add("is-done");
      root.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 600); // transitionend 不一定触发（减弱动效 / 页面在后台）
    }, reduce ? 0 : 180);
  }

  // 8 秒还没好：说明在等网络，诚实告知，而不是让进度条假装在走
  var slowTimer = setTimeout(function () {
    if (finished) return;
    root.classList.add("is-slow");
    if (slow) slow.textContent = "网络有点慢，管家还在路上…";
  }, 8000);
  // 20 秒还没揭幕：给一个重试出口。连 app.js 都没执行到多半是脚本下载失败；
  // 执行到了说明卡在等服务器
  var stuckTimer = setTimeout(function () {
    if (finished) return;
    root.classList.add("is-stuck");
    if (slow) slow.textContent = idx < ORDER.indexOf("boot")
      ? "页面没加载完整，刷新试试。"
      : "服务器迟迟没回应，刷新试试。";
  }, 20000);
  if (reload) reload.addEventListener("click", function () { location.reload(); });

  window.__splash = { stage: stage, done: done };
  paint();
  if (!reduce) raf = requestAnimationFrame(tick);
})();
