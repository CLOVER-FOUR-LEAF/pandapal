/**
 * web/app.js — PandaButler 前端主控（零构建原生 ES Module）
 *
 * 职责：
 *   1. 登录 / 演示登录 / 退出 → 进入后并行拉 briefing + affairs + graph + history
 *   2. SSE（POST /api/chat）解析全部事件：mode/mood/recall/affair/plan/node/action/relay_result/card/memory/token/done/error
 *   3. 事务看板（阶段徽标、倒计时/进度、owner_next、详情抽屉 + DAG 回放 + 清单勾选 + 日志）
 *   4. 角色切换（孩子 ↔ 家长）：body[data-role] 驱动白天/夜色 + private 隐藏
 *   5. 家长视图：收件箱确认/驳回、传话筒（双向）
 *   6. 悄悄话模式（[[secret]] 前缀）
 *   7. 图谱视图：3D 画布全屏接管 / 2D 兜底，时间轴 + 筛选 + 节点抽屉
 *   8. 成长视图（真实 /api/growth）+ 梦想入口（/api/dream）、调用记录、记忆本
 *   9. window.__pandaFallback2D()：3D 不可用时切 2D
 *  10. 语音输入、打字指示、Enter 发送、busy 防重入、全量转义防 XSS
 *
 * 依赖：./scene3d.js（3D 场景，全部调用经 s3() 包 try/catch）、./graph2d.js（2D 兜底）、./panda.js（2D 熊猫）
 */

import * as scene3d from "./scene3d.js";
import { renderFallback } from "./graph2d.js";
import { mountPanda, setMood, attachLoginInteractions } from "./panda.js";
import { initAdmin, loadAdmin } from "./admin.js";
import { marked } from "./vendor/marked.esm.js";
import purify from "./vendor/purify.es.js";

/* ==========================================================================
 * 0. 常量
 * ========================================================================== */

const VIEWS = {
  login: "#login-view",
  main: "#main-view",
  graph: "#graph-view",
  parent: "#parent-view",
  growth: "#growth-view",
  logs: "#logs-view",
  memory: "#memory-view",
  admin: "#admin-view",
};

const STAGES = {
  discovered: "发现", planning: "规划中", executing: "执行中",
  waiting: "等确认", followup: "跟进中", done: "已结案",
  awaiting_parent: "等确认", following: "跟进中",
};
const STAGE_ORDER = ["discovered", "planning", "executing", "waiting", "followup"];
/* 后端可能返回非标准阶段名（awaiting_parent/following）→ 归到最近色系 */
const STAGE_CSS = { awaiting_parent: "waiting", following: "followup" };
const OWNERS = { butler: "管家在办", child: "等孩子", parent: "等家长" };

const DOMAINS = {
  ethics: ["德", "--dom-ethics"], intellect: ["智", "--dom-intellect"],
  health: ["体", "--dom-health"], aesthetics: ["美", "--dom-aesthetics"],
  labor: ["劳", "--dom-labor"],
  德: ["德", "--dom-ethics"], 智: ["智", "--dom-intellect"],
  体: ["体", "--dom-health"], 美: ["美", "--dom-aesthetics"], 劳: ["劳", "--dom-labor"],
};
const DOMAIN_KEYS = ["ethics", "intellect", "health", "aesthetics", "labor"];
const DOMAIN_COLOR = {
  ethics: "#ff8d84", intellect: "#74b9f6", health: "#82d492",
  aesthetics: "#d29ae0", labor: "#f2cf6b",
};

const NODE_STATUS = {
  active: ["进行中", "status-active"],
  dropped: ["放下了", "status-dropped"],
  done: ["完成啦", "status-done"],
};

const MOOD_2D = { happy: "happy", sad: "sad", nervous: "worried", normal: "normal" };
const MOOD_3D = { happy: "happy", sad: "worried", nervous: "worried", normal: "idle" };

const ACTION_KIND = {
  reminder: "加提醒", checklist: "生成清单",
  parent_confirm: "请家长确认", ics: "导出日历", draft: "写文稿",
};
const MODE_LABEL = { plan: "规划链", todo: "拆解待办", affair: "事务更新", relay: "传话筒", explain: "讲给你听", chat: "" };
// planner / synth 各要几十秒，没有阶段提示就像卡死——这里给一句人话顶着
const PHASE_LABEL = { planning: "正在拆解要办的事…", executing: "正在一件件办…", synthesizing: "快好了，正在整理成方案…" };

const KIND_ICON = { travel: "i-planet", goal: "i-growth", health: "i-heart", interest: "i-spark", study: "i-book", habit: "i-clock", event: "i-cal" };

/** 全局状态（渲染函数只读它） */
const state = {
  name: null,        // 绑定的孩子档案名
  username: null,    // 登录账号
  authRole: null,    // 账号角色：child | parent | admin
  token: null,       // Bearer token
  role: "child",     // 当前视角（admin 可切），权限只看 authRole
  view: "login",
  busy: false,
  secret: false,
  graph: { nodes: [], edges: [] },
  affairs: [],
  timeline: null,
  filters: { domain: "", status: "" },
  fallback2d: false,
  sceneReady: false,
  sceneTried: false,
  sendSeq: 0,
  chatAbort: null,   // 进行中回答的 AbortController（暂停用）
  chatPaused: false, // 本轮是不是被用户主动暂停
  chatCtx: null,     // 当前轮次的渲染上下文（暂停时按它决定「继续」入口）
  chatResume: null,  // 暂停后待续写的内容 {raw, bubble}
  retryText: "",     // 上一轮因网络失败的消息原文（点「重发」用）
  retryFiles: [],    // 上一轮带走的附件 id（重发时不能丢，否则悄悄少了一半输入）
  attach: [],        // 待发送的附件元数据（上传成功后进这里）
  attachBusy: false, // 还有附件在上传中，此时不让发
  attachSeq: 0,      // 上传序号：连点两次上传时不至于互相覆盖
  attachPending: [], // 上传中/失败的附件槽位
  recent: [],        // 服务端最近上传的附件（"最近上传"面板用）
  recentOpen: false, // 面板是否展开
  lightboxFile: null, // 大图浮层里正在看的附件（下载原图要用）
  needGraphRefresh: false,
  relayDir: "teacher2parent",
};

let pandaSvg = null;
let micRec = null;      // MediaRecorder（正在录音时非空）
let micStream = null;   // 麦克风流：用完必须停轨道，否则浏览器标签页一直亮着录音标
let micTimer = null;    // 最长录音时长的自动停止定时器
let micPending = false; // 已 stop()、正等 onstop 把最后一块数据交出来
let micAbort = false;   // 退出登录/切账号时置位：丢掉这一段，不上传
let micBusy = false;    // 正在识别上一句
let micMax = 60;        // 单段录音上限（秒），由 GET /api/asr 下发
let micAvail = true;    // 服务端有没有配好识别 Key（没配就如实说明，不假装能用）

/* ==========================================================================
 * 1. DOM / 字符串 / 图标 / 日期工具
 * ========================================================================== */

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function append(parent, ...kids) {
  if (parent) kids.forEach((k) => k && parent.appendChild(k));
  return parent;
}

/** 图标：icon("i-planet") → <svg class="ic"><use href="#i-planet"/></svg> */
const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name, cls = "ic") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${name}`);
  svg.appendChild(use);
  return svg;
}
function iconHTML(name, cls = "ic") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;
}

function setText(sel, text) {
  const n = $(sel);
  if (n) n.textContent = text == null ? "" : String(text);
}
function setHidden(sel, hidden) {
  const n = $(sel);
  if (n) n.classList.toggle("hidden", !!hidden);
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------- AI 回复 markdown 渲染（vendored marked + DOMPurify） ---------- */
try { marked.use({ gfm: true, breaks: true }); } catch { /* 老版本忽略 */ }

function mdRender(raw) {
  try {
    return purify.sanitize(marked.parse(String(raw == null ? "" : raw)), {
      USE_PROFILES: { html: true },
    });
  } catch {
    return null; // 解析异常 → 退化为纯文本
  }
}

/** 把 AI 文本写进 .md 容器；markdown 失败时纯文本兜底。 */
function setMd(target, raw) {
  if (!target) return;
  const html = mdRender(raw);
  if (html === null) target.textContent = String(raw == null ? "" : raw);
  else target.innerHTML = html;
}

/** token 合流渲染：marked+DOMPurify 是对全文的重解析，逐 token 调是 O(n²)。
 *  50ms 一批重画——窗口内所有 token 只画一次最新 aiRaw，长回复渲染次数从 token 数降到 ~时长/50ms。 */
function scheduleMd(ctx) {
  if (!ctx || ctx.mdTimer || !ctx.aiBubble) return;
  const md = ctx.aiBubble.querySelector(".md");
  if (!md) return;
  ctx.aiBubble.classList.add("streaming");
  ctx.mdTimer = setTimeout(() => {
    ctx.mdTimer = null;
    const el = ctx.aiBubble && ctx.aiBubble.querySelector(".md");
    if (el) setMd(el, ctx.aiRaw);
    scrollBottom();
  }, 50);
}

/** 流结束/出错/中止时把剩余文本一次性刷进气泡，不留半截。 */
function flushMd(ctx) {
  if (!ctx) return;
  if (ctx.mdTimer) { clearTimeout(ctx.mdTimer); ctx.mdTimer = null; }
  const el = ctx.aiBubble && ctx.aiBubble.querySelector(".md");
  if (el && ctx.aiRaw) setMd(el, ctx.aiRaw);
}
function truncate(s, n = 60) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function int(v, dflt = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysUntil(due) {
  if (!due) return null;
  const t = Date.parse(`${String(due).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(t)) return null;
  const base = Date.parse(`${todayStr()}T00:00:00`);
  return Math.round((t - base) / 86400000);
}
function countdownText(due) {
  const d = daysUntil(due);
  if (d === null) return "";
  if (d > 1) return `还有 ${d} 天`;
  if (d === 1) return "就是明天";
  if (d === 0) return "就是今天";
  return `已过期 ${-d} 天`;
}

/* ==========================================================================
 * 2. 网络 + 视图切换 + Toast
 * ========================================================================== */

/* 部署在子路径（如 /pandapal/）时，API 请求统一带上挂载前缀；根路径部署时为空串 */
const BASE = location.pathname.replace(/\/+$/, "");

async function api(path, opts) {
  let resp;
  try {
    opts = opts ? { ...opts } : {};
    if (state.token) {
      opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${state.token}` };
    }
    resp = await fetch(BASE + path, opts);
  } catch {
    throw new Error("网络好像断了，检查连接再试试～");
  }
  if (!resp.ok) {
    if (resp.status === 401 && state.token && !path.startsWith("/api/auth/")) {
      forceLogout(); // token 失效（如服务重启）→ 回登录页
    }
    let msg = "";
    try {
      const data = await resp.json();
      msg = data && (data.detail || data.message || data.error);
    } catch { /* 非 JSON */ }
    if (!msg) {
      if (resp.status === 401) msg = "用户名或密码不对";
      else if (resp.status === 403) msg = "当前账号没有这个权限";
      // 用户可见文案里不出现 HTTP 码，也不出现"开发中/未实现"——
      // 路演里评委看到"404""开发中"是无法挽回的
      else if (resp.status === 404) msg = "这个功能还在路上，先试试别的吧";
      else if (resp.status === 429) msg = "管家还在回上一条，稍等一下哦";
      else if (resp.status >= 500) msg = "管家后端打了个喷嚏，稍后再试";
      else msg = "这一步没成功，换个说法再试试";
    }
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

const jsonOpts = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const q = (name) => `name=${encodeURIComponent(name || "")}`;

/**
 * 读 GET 的 SSE 文本流（晨报/问候的 `?stream=1`）：每来一段 token 回调 onToken，
 * 返回 done 事件的载荷（含看板/提醒等本地数据）。服务端不支持流时退化为整段 JSON。
 */
async function readTextStream(resp, onToken, onEvent) {
  if (!resp.body || !resp.body.getReader) {
    const data = await resp.json().catch(() => ({}));
    if (data.text) onToken(data.text);
    if (data.voice) onEvent?.({ type: "voice", ...data.voice });
    return data;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = {};
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx).replace(/\r/g, "");
      buf = buf.slice(idx + 2);
      if (!raw.startsWith("data:")) continue;
      let ev;
      try { ev = JSON.parse(raw.slice(5)); } catch { continue; }
      // done 之后还可能跟 voice 事件（语音在正文上屏后才开始合成），
      // 交给调用方的通用回调，别在这里把它吞掉
      onEvent?.(ev);
      if (ev.type === "token") onToken(ev.text || "");
      else if (ev.type === "done") done = ev;
      else if (ev.type === "error") throw new Error(ev.message || "生成失败");
    }
  }
  return done;
}

/**
 * 大模型不可用时服务端返回的本地兜底（`degraded: true` / `llm: false`）：
 * 打一个显式标记，绝不让兜底文本看起来像 AI 实时生成。
 */
function degradedNote(reason) {
  const n = el("div", "degraded-note", "大模型暂不可用 · 以下为本地数据兜底，非 AI 生成");
  if (reason) n.title = String(reason);
  return n;
}

function show(viewId) {
  const sel = VIEWS[viewId] || (viewId.startsWith?.("#") ? viewId : null);
  const target = sel ? $(sel) : null;
  if (!target) return;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  target.classList.remove("hidden");
  state.view = viewId;
  document.querySelectorAll("[data-nav]").forEach((b) => {
    const on = b.dataset.nav === viewId;
    b.classList.toggle("active", on);
    b.setAttribute("aria-current", on ? "page" : "false");
  });
  // 3D 画布挂载点：主视图挂中栏，图谱视图全屏接管
  if (state.sceneReady) {
    if (viewId === "graph") s3("attachTo", $("#graph-canvas"), "graph");
    else if (viewId === "main") s3("attachTo", $("#scene-canvas"), "main");
  }
}

function go(viewId) {
  if (!state.name) return;
  show(viewId);
  if (viewId === "graph") loadGraphView();
  if (viewId === "parent") loadParentInbox();
  if (viewId === "growth") loadGrowth();
  if (viewId === "logs") loadLogs();
  if (viewId === "memory") loadMemory();
  if (viewId === "admin") loadAdmin();
}

/** 轻提示 */
let toastSeq = 0;
function toast(text, ms = 2600) {
  const root = $("#toast-root");
  if (!root) return;
  const box = el("div", "toast", text);
  box.dataset.seq = String(++toastSeq);
  root.innerHTML = "";
  root.appendChild(box);
  setTimeout(() => {
    box.classList.add("out");
    setTimeout(() => box.remove(), 260);
  }, ms);
}

/* ==========================================================================
 * 3. 3D 调用安全包装 + 2D 兜底
 * ========================================================================== */

async function s3(fnName, ...args) {
  if (!state.sceneReady) return undefined;
  const f = scene3d[fnName];
  if (typeof f !== "function") return undefined;
  try {
    return await f(...args);
  } catch (e) {
    console.warn(`[app] scene3d.${fnName} 失败（已忽略）：`, e && e.message);
    return undefined;
  }
}

function scene3dUsable() {
  return typeof scene3d.setGraphData === "function";
}

async function withTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve("__timeout__"), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function useFallback2D(reason) {
  if (state.fallback2d) return;
  state.fallback2d = true;
  state.sceneReady = false;
  state.sceneTried = true;
  setHidden("#scene-fallback", false);
  setHidden("#scene-canvas", true);
  setHidden("#graph-canvas-2d", false);
  const note = $("#scene-fallback .fallback-note");
  if (note) note.textContent = "2D 全景图谱 · 交互与数据实时同步";
  renderFallbackGraph();
  mount2DPanda();
}

function mount2DPanda() {
  const holder = $("#scene-fallback .fallback-panda");
  if (!holder || pandaSvg) return;
  try {
    pandaSvg = mountPanda(holder);
    setMood(pandaSvg, "normal");
  } catch (e) { console.warn("[app] 2D 熊猫挂载失败：", e && e.message); }
}

function renderFallbackGraph() {
  const box = $("#scene-fallback");
  if (!box) return;
  let host = box.querySelector(".fallback-graph");
  if (!host) {
    host = el("div", "fallback-graph");
    box.insertBefore(host, box.firstChild);
  }
  draw2D(host, filteredGraph());
}

function draw2D(host, graph, onClick) {
  if (!host) return;
  try {
    renderFallback(host, graph, {
      role: state.role,
      timeline: state.timeline,
      onNodeClick: onClick || ((n) => openNodeDrawer(n)),
    });
  } catch (e) {
    host.textContent = "图谱暂时画不出来，其他功能照常～";
    console.warn("[app] renderFallback 失败：", e && e.message);
  }
}

function renderMiniGraph() {
  /** 星球速览：五领域节点分布条 + 最近点亮的记忆（2D 缩略图在 146px 高度里只是一团色块，讲不清楚）。 */
  const host = $("#graph-mini .graph-mini-canvas");
  if (!host) return;
  const nodes = (state.graph.nodes || []).filter((n) => n && n.id !== "xiaodou" && n.type !== "self");
  host.innerHTML = "";
  host.classList.add("mini-stats");
  if (!nodes.length) {
    host.appendChild(el("p", "empty-hint", "多聊几句，管家就会把你的世界点亮成星球～"));
    return;
  }
  const counts = {};
  DOMAIN_KEYS.forEach((k) => (counts[k] = 0));
  nodes.forEach((n) => { if (counts[n.domain] !== undefined) counts[n.domain] += 1; });
  const max = Math.max(1, ...Object.values(counts));
  const bars = el("div", "mini-bars");
  DOMAIN_KEYS.forEach((k) => {
    const b = el("button", "mini-bar");
    b.type = "button";
    b.dataset.domain = k;
    b.setAttribute("aria-label", `${DOMAINS[k][0]}：${counts[k]} 个记忆节点`);
    const track = el("span", "mini-track");
    const fill = el("i", "mini-fill");
    fill.style.height = `${Math.max(8, Math.round((counts[k] / max) * 100))}%`;
    track.appendChild(fill);
    append(b, el("span", "mini-num", String(counts[k])), track, el("span", "mini-lab", DOMAINS[k][0]));
    b.onclick = (e) => {
      e.stopPropagation();
      state.filters = { ...(state.filters || {}), domain: k };
      go("graph");
      s3("setDomainFilter", state.filters.domain, state.filters.status);
    };
    bars.appendChild(b);
  });
  const recent = nodes.slice()
    .sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")) || (b.weight || 0) - (a.weight || 0))
    .slice(0, 3);
  const side = el("div", "mini-side");
  append(side, el("div", "mini-total", `${nodes.length}`), el("div", "mini-total-lab", "颗记忆星"));
  const rec = el("div", "mini-recent");
  recent.forEach((n) => {
    const pill = el("button", "node-pill");
    pill.type = "button";
    pill.dataset.domain = n.domain || "";
    pill.textContent = truncate(n.label || n.id, 6);
    pill.onclick = (e) => { e.stopPropagation(); go("graph"); openNodeDrawer(n); };
    rec.appendChild(pill);
  });
  side.appendChild(rec);
  append(host, bars, side);
}

/* ==========================================================================
 * 4. 登录 / 退出
 * ========================================================================== */

const AUTH_KEY = "pb_auth";

function saveAuth() {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({
      token: state.token, username: state.username,
      authRole: state.authRole, name: state.name, role: state.role,
    }));
    sessionStorage.removeItem(AUTH_KEY); // 旧版本存在 sessionStorage 的残值清掉
  } catch { /* 私密模式下静默 */ }
}

let loginPanda = null;
let loginBusy = false;

function setHint(sel, text, kind) {
  const hint = typeof sel === "string" ? $(sel) : sel;
  if (!hint) return;
  hint.textContent = text || "";
  hint.classList.toggle("err", kind === "err");
  hint.classList.toggle("ok", kind === "ok");
}
function setLoginHint(text, kind) { setHint("#login-hint", text, kind); }

function shakeCard() {
  const card = $("#login-card");
  if (card) { card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); }
}

function busyBtn(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle("loading", on);
}

/* 登录卡三个面板：登录 / 注册 / 找回密码 */
const AUTH_PANES = {
  login:    { sel: "#pane-login",    title: "欢迎回来",   sub: "登录后，管家会接着上次的话题继续陪伴" },
  register: { sel: "#pane-register", title: "创建新账号", sub: "选一个身份，注册即拥有专属档案" },
  forgot:   { sel: "#pane-forgot",   title: "找回密码",   sub: "答对注册时设的密保问题，就能重置密码" },
};

function setAuthPane(name) {
  const cfg = AUTH_PANES[name] || AUTH_PANES.login;
  Object.values(AUTH_PANES).forEach((p) => setHidden(p.sel, p.sel !== cfg.sel));
  setText("#login-card-title", cfg.title);
  setText("#login-card-sub", cfg.sub);
  ["#login-hint", "#register-hint", "#forgot-hint"].forEach((s) => setHint(s, ""));
  if (name === "forgot") forgotToStep1();
  if (loginPanda) setMood(loginPanda, "normal");
  const input = document.querySelector(`${cfg.sel} input`);
  if (input) input.focus({ preventScroll: true });
}

function fieldVal(sel, trim = true) {
  const n = $(sel);
  const v = n ? String(n.value) : "";
  return trim ? v.trim() : v;
}

/** 注册/找回/登录共用 loginBusy 防重入——同一时刻只允许一笔账号操作在飞。 */
async function register() {
  if (loginBusy) return;
  const u = fieldVal("#reg-name");
  const p1 = fieldVal("#reg-pass", false), p2 = fieldVal("#reg-pass2", false);
  const child = fieldVal("#reg-child"), q = fieldVal("#reg-question"), a = fieldVal("#reg-answer");
  const childPass = fieldVal("#reg-child-pass", false);
  const bad = !u ? ["先起个用户名吧", "#reg-name"]
    : p1.length < 4 ? ["密码太短啦，至少 4 位", "#reg-pass"]
    : p1 !== p2 ? ["两遍密码不一样哦", "#reg-pass2"]
    : regRole === "parent" && !child ? ["家长账号要填孩子的登录名", "#reg-child"]
    : regRole === "parent" && !childPass ? ["还要填孩子账号的密码，证明是一家人", "#reg-child-pass"]
    : !q ? ["设一个密保问题吧，忘密码时全靠它", "#reg-question"]
    : !a ? ["密保答案也要填哦", "#reg-answer"] : null;
  if (bad) {
    setHint("#register-hint", bad[0], "err");
    shakeCard();
    if (loginPanda) setMood(loginPanda, "oops");
    const t = $(bad[1]);
    if (t) t.focus();
    return;
  }
  loginBusy = true;
  const btn = $("#register-btn");
  busyBtn(btn, true);
  setHint("#register-hint", "正在创建账号…");
  if (loginPanda) setMood(loginPanda, "thinking");
  try {
    const resp = await api("/api/auth/register", jsonOpts({
      username: u, password: p1, role: regRole,
      child: regRole === "parent" ? child : "",
      child_password: regRole === "parent" ? childPass : "", question: q, answer: a,
    }));
    const data = await resp.json().catch(() => ({}));
    state.token = data.token;
    state.username = data.username;
    state.authRole = data.role || "child";
    state.name = data.name || u;
    state.role = state.authRole === "parent" ? "parent" : "child";
    saveAuth();
    setHint("#register-hint", "账号建好啦，正在进入…", "ok");
    if (loginPanda) setMood(loginPanda, "happy");
    await enterMain();
    setAuthPane("login");
    ["#reg-name", "#reg-pass", "#reg-pass2", "#reg-child", "#reg-child-pass", "#reg-question", "#reg-answer"]
      .forEach((s) => { const n = $(s); if (n) n.value = ""; });
  } catch (e) {
    setHint("#register-hint", e.message || "注册失败，请稍后再试", "err");
    if (loginPanda) setMood(loginPanda, "oops");
    shakeCard();
  } finally {
    loginBusy = false;
    busyBtn(btn, false);
  }
}

let regRole = "child";
let fpUser = "";  // 找回流程第二步要记住第一步查过的用户名

function setRegRole(role) {
  regRole = role === "parent" ? "parent" : "child";
  document.querySelectorAll("#reg-role .seg-btn").forEach((b) => {
    const on = b.dataset.role === regRole;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
  setHidden("#reg-child-field", regRole !== "parent");
  setHidden("#reg-child-pass-field", regRole !== "parent");
}

function forgotToStep1() {
  setHidden("#forgot-step1", false);
  setHidden("#forgot-step2", true);
  fpUser = "";
}

async function forgotNext() {
  if (loginBusy) return;
  const u = fieldVal("#fp-name");
  if (!u) {
    setHint("#forgot-hint", "先填一下用户名哦", "err");
    shakeCard();
    const t = $("#fp-name");
    if (t) t.focus();
    return;
  }
  loginBusy = true;
  const btn = $("#forgot-next-btn");
  busyBtn(btn, true);
  setHint("#forgot-hint", "正在查找账号…");
  try {
    const resp = await api(`/api/auth/question?username=${encodeURIComponent(u)}`);
    const data = await resp.json().catch(() => ({}));
    if (!data.recoverable) {
      setHint("#forgot-hint", "这个账号注册时没设密保，没法自助找回哦", "err");
      shakeCard();
      return;
    }
    fpUser = u;
    setText("#fp-question", data.question);
    setHidden("#forgot-step1", true);
    setHidden("#forgot-step2", false);
    setHint("#forgot-hint", "");
    const ans = $("#fp-answer");
    if (ans) ans.focus();
  } catch (e) {
    setHint("#forgot-hint", e.message || "查询失败，请稍后再试", "err");
    shakeCard();
  } finally {
    loginBusy = false;
    busyBtn(btn, false);
  }
}

async function forgotReset() {
  if (loginBusy || !fpUser) return;
  const a = fieldVal("#fp-answer");
  const p1 = fieldVal("#fp-pass", false), p2 = fieldVal("#fp-pass2", false);
  const bad = !a ? ["密保答案还没填", "#fp-answer"]
    : p1.length < 4 ? ["新密码太短啦，至少 4 位", "#fp-pass"]
    : p1 !== p2 ? ["两遍新密码不一样哦", "#fp-pass2"] : null;
  if (bad) {
    setHint("#forgot-hint", bad[0], "err");
    shakeCard();
    const t = $(bad[1]);
    if (t) t.focus();
    return;
  }
  loginBusy = true;
  const btn = $("#forgot-reset-btn");
  busyBtn(btn, true);
  setHint("#forgot-hint", "正在重置密码…");
  if (loginPanda) setMood(loginPanda, "thinking");
  try {
    await api("/api/auth/reset", jsonOpts({ username: fpUser, answer: a, password: p1 }));
    setAuthPane("login");
    const name = $("#login-name");
    if (name) name.value = fpUser;
    const pass = $("#login-pass");
    if (pass) { pass.value = ""; pass.focus(); }
    setLoginHint("密码已重置，用新密码登录吧～", "ok");
    if (loginPanda) setMood(loginPanda, "happy");
    ["#fp-name", "#fp-answer", "#fp-pass", "#fp-pass2"]
      .forEach((s) => { const n = $(s); if (n) n.value = ""; });
  } catch (e) {
    setHint("#forgot-hint", e.message || "重置失败，请稍后再试", "err");
    if (loginPanda) setMood(loginPanda, "oops");
    shakeCard();
  } finally {
    loginBusy = false;
    busyBtn(btn, false);
  }
}

async function login(username, password, trigger) {
  if (loginBusy) return;
  const u = String(username == null ? "" : username).trim();
  const p = String(password == null ? "" : password);
  if (!u || !p) {
    setLoginHint(!u ? "先填一下用户名哦" : "密码还没填呢", "err");
    shakeCard();
    if (loginPanda) setMood(loginPanda, "oops");
    const target = !u ? $("#login-name") : $("#login-pass");
    if (target) target.focus();
    return;
  }
  loginBusy = true;
  const mainBtn = $("#login-btn");
  const btns = [mainBtn, ...document.querySelectorAll(".demo-role")];
  btns.forEach((b) => b && (b.disabled = true));
  const busyBtn = trigger || mainBtn;
  if (busyBtn) busyBtn.classList.add("loading");
  if (busyBtn === mainBtn && mainBtn) mainBtn.disabled = false; // 保留可见态，pointer-events 已禁
  setLoginHint("正在验证身份…");
  if (loginPanda) setMood(loginPanda, "thinking");
  try {
    const resp = await api("/api/auth/login", jsonOpts({ username: u, password: p }));
    const data = await resp.json().catch(() => ({}));
    state.token = data.token;
    state.username = data.username;
    state.authRole = data.role || "child";
    state.name = data.name || u;
    state.role = state.authRole === "parent" ? "parent" : "child";
    saveAuth();
    setLoginHint(data.is_new ? "新账号已建好空白档案～" : `欢迎回来，${state.name}！`, "ok");
    if (loginPanda) setMood(loginPanda, "happy");
    await enterMain();
    setLoginHint("");
  } catch (e) {
    setLoginHint(e.message || "登录失败，请稍后再试", "err");
    if (loginPanda) setMood(loginPanda, "oops");
    const card = $("#login-card");
    if (card) { card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); }
  } finally {
    loginBusy = false;
    btns.forEach((b) => b && (b.disabled = false, b.classList.remove("loading")));
  }
}

function demoLogin(btn) {
  const b = btn && btn.dataset ? btn : $("#demo-btn");
  const user = (b && b.dataset.user) || "小豆";
  const pass = (b && b.dataset.pass) || "panda123";
  const name = $("#login-name");
  const pw = $("#login-pass");
  if (name) name.value = user;
  if (pw) pw.value = pass;
  login(user, pass, b);
}

function setupLoginExtras() {
  const nameInput = $("#login-name");
  const passInput = $("#login-pass");
  const toggle = $("#pass-toggle");
  let peek = false;
  const inter = attachLoginInteractions(loginPanda, {
    nameInput,
    passInputs: [passInput, "#reg-pass", "#reg-pass2", "#fp-pass", "#fp-pass2"]
      .map((s) => (typeof s === "string" ? $(s) : s)),
    isPeek: () => peek,
  });
  if (toggle && passInput) {
    toggle.addEventListener("pointerdown", (e) => e.preventDefault()); // 不抢输入框焦点
    toggle.onclick = () => {
      peek = !peek;
      passInput.type = peek ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(peek));
      toggle.setAttribute("aria-label", peek ? "隐藏密码" : "显示密码");
      const use = toggle.querySelector("use");
      if (use) use.setAttribute("href", peek ? "#i-eye-off" : "#i-eye");
      if (inter) inter.syncPass();
    };
  }
  const caps = $("#caps-hint");
  if (caps && passInput) {
    const check = (e) => {
      if (typeof e.getModifierState === "function") setHidden("#caps-hint", !e.getModifierState("CapsLock"));
    };
    passInput.addEventListener("keydown", check);
    passInput.addEventListener("keyup", check);
    passInput.addEventListener("blur", () => setHidden("#caps-hint", true));
  }
  [nameInput, passInput].forEach((n) => n && n.addEventListener("input", () => {
    const hint = $("#login-hint");
    if (hint && hint.classList.contains("err")) setLoginHint("");
  }));
  document.querySelectorAll(".demo-role").forEach((b) => { b.onclick = () => demoLogin(b); });

  // 注册面板：身份选择 + 输错提示即改即消
  document.querySelectorAll("#reg-role .seg-btn").forEach((b) => {
    b.onclick = () => setRegRole(b.dataset.role);
  });
  document.querySelectorAll("#pane-register input").forEach((n) => {
    n.addEventListener("input", () => {
      const hint = $("#register-hint");
      if (hint && hint.classList.contains("err")) setHint("#register-hint", "");
    });
  });
  document.querySelectorAll("#pane-forgot input").forEach((n) => {
    n.addEventListener("input", () => {
      const hint = $("#forgot-hint");
      if (hint && hint.classList.contains("err")) setHint("#forgot-hint", "");
    });
  });

  // 气泡轮播：讲解时展示管家"主动办事"的样子。
  // ⚠ 这里只能写「能力陈述」，不能写具体事件。原先的四条里有三条是编的
  // （明天科学课、周五春游、跳绳进步 20 个，档案里都不存在），"西客松还有 3 天"
  // 更是与真实到期日不符；而且硬编码了"小豆"，换任何一个档案都自相矛盾。
  // 评委听完这句话随手点进记忆星球就会发现对不上——开场 30 秒就把可信度输掉。
  // 现在每条都对应一个真的实现了的能力，且不依赖任何具体档案事实。
  const lines = [
    "你说过的事我都记着，明天要带什么，我今天就提醒你",
    "要办的事说一句就行，我拆成几步，一步一步替你跑",
    "比赛还有几天、准备到哪一步了，我替你数着",
    "心里话跟我说，不想让爸妈知道的，我替你保密",
  ];
  const txt = $("#hero-bubble-text");
  const bubble = txt && txt.parentElement;
  let i = 0;
  if (txt && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setInterval(() => {
      if (state.view !== "login" || document.hidden) return;
      i = (i + 1) % lines.length;
      txt.textContent = lines[i];
      bubble.classList.remove("swap"); void bubble.offsetWidth; bubble.classList.add("swap");
      if (loginPanda && !loginPanda.classList.contains("shy") && !loginPanda.classList.contains("peek")
          && !loginPanda.classList.contains("thinking")) {
        setMood(loginPanda, "speaking");
        setTimeout(() => {
          if (loginPanda && loginPanda.classList.contains("speaking")) setMood(loginPanda, "normal");
        }, 1400);
      }
    }, 4800);
  }
}

async function restoreAuth() {
  /** 刷新/重开浏览器后凭 localStorage 里的 token 恢复登录态。 */
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(AUTH_KEY)
      || sessionStorage.getItem(AUTH_KEY) || "null");
  } catch { /* ignore */ }
  if (!saved || !saved.token) return; // 没登录过：boot 的 finally 会揭幕，露出登录页
  state.token = saved.token;
  splashStage("auth");
  const hint = $("#login-hint");
  if (hint) hint.textContent = "正在恢复登录…";
  let me;
  try {
    const resp = await api("/api/auth/me");
    me = await resp.json();
  } catch (e) {
    // 只有 401 才作废登录态；网络/5xx 保留 token，刷新可重试
    if (e.status === 401) {
      state.token = null;
      try { localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
      if (hint) hint.textContent = "登录已过期，请重新登录";
    } else if (hint) {
      hint.textContent = `暂时连不上服务器：${e.message}（登录态已保留，可刷新重试）`;
    }
    return;
  }
  state.username = me.username;
  state.authRole = me.role;
  state.name = me.name;
  state.role = me.role === "admin" && saved.role === "parent" ? "parent"
    : me.role === "parent" ? "parent" : "child";
  saveAuth();
  if (hint) hint.textContent = "";
  try {
    await enterMain();
  } catch (e) {
    // 界面加载失败不清登录态；多数面板有自己的错误兜底
    console.warn("[app] 恢复登录后进入主界面失败：", e && e.message);
    show("main");
  }
}

const CHAT_WELCOME =
  '<div class="chat-welcome">' +
  '<div class="cw-logo" aria-hidden="true"><svg class="ic"><use href="#i-logo"/></svg></div>' +
  '<b>跟熊猫管家说点什么吧</b>' +
  '<span>今天发生的事、要办的事、心里的话都能说<br>我会记住，也会帮你拆解成一步一步办掉</span>' +
  '</div>';

/** 清掉上一账号留在界面上的内容，避免换号后看到旧数据。 */
function resetUserUI() {
  const box = chatBox();
  if (box) box.innerHTML = CHAT_WELCOME;
  const set = (sel, html) => { const n = $(sel); if (n) n.innerHTML = html; };
  set("#chips", ""); // 快捷话题是上一个账号的上下文，清掉等新账号的 /api/suggest
  // 附件是上一个账号/上一轮的遗留：清干净，别把别人的文件带给下一个账号
  state.attach = [];
  state.attachPending = [];
  state.recent = [];
  state.recentOpen = false;
  const fb = $("#files-btn");
  if (fb) fb.setAttribute("aria-expanded", "false");
  state.retryFiles = [];
  renderAttachList();
  // 图片缓存与大图浮层也是上一个账号的内容：URL 失效之外还要把内存里的 blob 丢掉
  closeLightbox();
  attachBlobs.clear();
  const fi = $("#file-input");
  if (fi) fi.value = "";
  set("#briefing-card .panel-body", '<div class="skeleton skeleton-lines"></div>');
  set("#affair-board .panel-body", '<p class="empty-hint">管家正在整理事务…</p>');
  setText("#affair-board .panel-sub", "— 件在办");
  set("#graph-mini .graph-mini-canvas", "");
  const strip = $("#due-strip");
  if (strip) { strip.innerHTML = ""; strip.classList.add("hidden"); }
  set("#parent-inbox", '<p class="empty-hint">没有待确认的事。</p>');
  setHidden("#secret-note", true);
  setRelayCol("#relay-t2p", "");
  setRelayCol("#relay-c2t", "");
  set("#weekly-out", "");
  setHidden("#weekly-out", true);
  const ri = $("#relay-input");
  if (ri) ri.value = "";
  set("#growth-radar", "");
  set("#growth-evidence", '<p class="empty-hint">还没有可回放的证据。</p>');
  setHidden("#growth-comment", true);
  const dream = $("#dream-out");
  if (dream) dream.remove();
  set("#memory-md", "");
  set("#memory-topics", '<p class="empty-hint">还没有主题记忆。</p>');
  set("#memory-daily", '<p class="empty-hint">还没有沉淀记录。</p>');
  const logs = $("#llm-logs");
  if (logs) {
    const head = logs.querySelector(".logs-head");
    logs.innerHTML = "";
    if (head) logs.appendChild(head);
  }
  setHidden("#node-drawer", true);
  setHidden("#affair-detail", true);
  if (state.chatAbort) { try { state.chatAbort.abort(); } catch { /* 忽略 */ } }
  state.chatAbort = null;
  state.chatPaused = false;
  state.chatCtx = null;
  state.chatResume = null;
  clearResumeChip();
  state.sendSeq++; // 在途的旧响应作废，别把上一个账号的内容写进新会话
  setPauseVisible(false);
  hideBubble($("#panda-bubble"));
  modeBadge("");
  chatStatus();
  const input = $("#msg-input");
  if (input) {
    input.value = "";
    input.disabled = false;
    input.classList.remove("secret-on");
    input.placeholder = "跟熊猫管家说说今天…";
  }
  const secretBtn = $("#secret-btn");
  if (secretBtn) secretBtn.setAttribute("aria-pressed", "false");
  micCancel();   // 还有没上传的录音就丢掉，别把上一个人的声音带进下一个账号
}

function logout() {
  // 退出 = 注销 token 回登录页；服务端会话仍在，同账号再进会续上历史
  if (state.token) api("/api/auth/logout", jsonOpts({})).catch(() => {});
  stopVoice();  // 别让上一个账号的回复在登录页继续念
  try { localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
  try { sessionStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
  state.token = null;
  state.username = null;
  state.authRole = null;
  state.name = null;
  state.role = "child";
  state.secret = false;
  state.busy = false;
  state.sendSeq++;
  state.graph = { nodes: [], edges: [] };
  state.affairs = [];
  state.timeline = null;
  state.filters = { domain: "", status: "" };
  state.needGraphRefresh = false;
  state.relayDir = "teacher2parent";
  applyRole("child");
  setRelayDir("teacher2parent");
  resetUserUI();
  setAuthPane("login");
  const hint = $("#login-hint");
  if (hint) hint.textContent = "";
  show("login");
  const input = $("#login-name");
  if (input) { input.value = ""; input.focus(); }
  const pass = $("#login-pass");
  if (pass) pass.value = "";
}

function forceLogout() {
  // token 失效的被动登出：先复位，再在登录页提示原因
  logout();
  const hint = $("#login-hint");
  if (hint) hint.textContent = "登录已失效，请重新登录";
}

/** 按账号角色收口可见入口（服务端仍逐接口校验，这里只做界面裁剪） */
function applyAuth() {
  const role = state.authRole || "child";
  const isAdmin = role === "admin";
  const isParent = role === "parent";
  // 顶栏入口
  setHidden("#nav-parent", role === "child");
  setHidden("#nav-logs", !isAdmin);
  setHidden("#nav-admin", !isAdmin);
  setHidden("#role-toggle", !isAdmin);
  // 子视图导航里的家长/记录/后台入口同样按角色收口
  document.querySelectorAll('[data-go="parent"]').forEach((b) => {
    b.classList.toggle("hidden", role === "child");
  });
  document.querySelectorAll('.subview-nav [data-go="logs"]').forEach((b) => {
    b.classList.toggle("hidden", !isAdmin);
  });
  document.querySelectorAll('[data-go="admin"]').forEach((b) => {
    b.classList.toggle("hidden", !isAdmin);
  });
  // 聊天 / 悄悄话 / 梦想：家长账号不可用（服务端同样 403）
  const canChat = !isParent;
  const input = $("#msg-input");
  const sendBtn = $("#send-btn");
  if (input) input.disabled = !canChat;
  if (sendBtn) sendBtn.disabled = !canChat;
  setHidden("#secret-btn", !canChat);
  setHidden("#dream-btn", !canChat);
  // 角色徽标 + 各子视图"返回"按钮回到本角色首页
  const roleName = { child: "孩子", parent: "家长", admin: "评委" }[role] || role;
  setText("#child-name", `@ ${state.name} · ${roleName}`);
  document.querySelectorAll('[data-go="main"] span').forEach((s) => {
    s.textContent = isParent ? "首页" : "管家";
  });
  document.querySelectorAll("#tabbar [data-go]").forEach((b) => {
    const key = b.dataset.go;
    if (key === "main") b.classList.toggle("hidden", isParent);
    if (key === "parent") b.classList.toggle("hidden", role === "child");
    if (key === "logs") b.classList.toggle("hidden", !isAdmin);
  });
}

async function enterMain() {
  applyAuth();
  renderLegendIfEmpty();
  initSceneSafe(); // 不 await：three.js 动态加载，3D 场景在启动层揭开后再慢慢长出来
  if (state.role === "parent") {
    // 家长首页 = 家长视图（收件箱 + 传话筒），不进孩子的管家台
    show("parent");
    applyRole("parent");
    splashStage("history");
    loadGraph();
    await loadParentInbox();
    splashDone();
    return;
  }
  show("main");
  applyRole(state.role);
  renderChips();
  setupMic();
  // 拉音色档案再放问候/晨报：喇叭图标要先知道服务端到底能不能发声
  fetchVoiceProfile();
  // 问候、晨报、看板、图谱同时开跑，各渲染各的，谁也不等谁（晨报是一整段 LLM 生成，
  // 以前要等它写完才轮到问候）。启动层只等历史这一项轻量请求——聊天区有内容再揭幕。
  splashStage("history");
  bindProjectTools();
  const greeting = loadGreeting();
  loadBriefing();
  loadAffairs();
  loadGraph();
  const historyCount = await loadHistory();
  splashDone();
  // 首次见面（没有任何历史）才把问候也写进聊天区；有记录时只做顶部气泡，
  // 否则每次登录都往聊天区插一条重复问候（服务端会话历史会跨登录保留）
  if (!historyCount) {
    const text = await greeting;
    if (text) addMsg("ai", text);
  }
  const input = $("#msg-input");
  if (input) input.focus();
}

/* ==========================================================================
 * 5. 左栏：晨报 / 事务看板 / 临近截止
 * ========================================================================== */

function briefingBody() { return $("#briefing-card .panel-body"); }

async function loadBriefing() {
  const box = briefingBody();
  if (!box) return;
  // 原先这里一进来就 box.innerHTML = ""，把骨架屏在流式请求发出之前就清掉了：
  // 晨报生成的全过程（2–10 秒）面板是纯空白，没有 aria-busy、没有转圈、没有文字
  // ——而讲者正指着这块面板说话。现在骨架屏留到第一个 token 真正到达再换。
  const skeleton = el("div", "skeleton skeleton-lines");
  skeleton.setAttribute("role", "status");
  skeleton.setAttribute("aria-label", "晨报生成中");
  box.innerHTML = "";
  box.appendChild(skeleton);
  box.setAttribute("aria-busy", "true");

  const textEl = el("div", "briefing-text", "");
  let full = "";
  let swapped = false;
  const swapIn = () => {
    if (swapped) return;            // 只换一次：后续 token 直接写 textEl
    swapped = true;
    box.innerHTML = "";
    box.appendChild(textEl);
    box.removeAttribute("aria-busy");
  };

  try {
    // 流式：正文逐字出，done 事件再补看板/截止/建议（首屏不必等整段 LLM）
    const resp = await api(`/api/briefing?${q(state.name)}&stream=1`);
    const done = await readTextStream(resp, (tok) => {
      swapIn();
      full += tok;
      textEl.textContent = full;
    }, onStreamEvent);
    swapIn();                        // 一个 token 都没有也要收掉骨架屏
    renderBriefingExtras(done, full);
    if (done && done.degraded) {
      textEl.textContent = done.text || "";
      box.insertBefore(degradedNote(done.degraded_reason), textEl);
    }
  } catch (e) {
    swapIn();
    textEl.textContent = `晨报暂时取不到：${e.message}`;
  }
}

/** 流式正文之外的附带信息：建议 chips + 临近截止条。 */
function renderBriefingExtras(data, text) {
  const box = briefingBody();
  if (!box) return;
  if (text !== undefined) {
    const textEl = box.querySelector(".briefing-text");
    if (textEl) textEl.textContent = text || "（今天没有特别的巡检结果）";
  }
  const suggestions = (data && data.suggestions) || [];
  if (suggestions.length) {
    const row = el("div", "chip-row");
    row.style.marginTop = "8px";
    suggestions.forEach((s) => {
      const b = el("button", "chip", s.text || "帮我做");
      b.type = "button";
      b.onclick = () => send(s.text || "帮我做个计划");
      row.appendChild(b);
    });
    box.appendChild(row);
  }
  renderDueStrip((data && data.due_soon) || []);
}

/** 剩余天数短文案（倒计时条用）。 */
function daysLeftText(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return "";
  if (days > 1) return `${days} 天`;
  if (days === 1) return "明天";
  if (days === 0) return "今天";
  return `逾期 ${-days} 天`;
}

/** 临近截止：合并进事务看板头部下方的横向滚动条，不再单占一块面板。 */
function renderDueStrip(due) {
  const strip = $("#due-strip");
  if (!strip) return;
  strip.innerHTML = "";
  if (!due || !due.length) {
    strip.classList.add("hidden");
    return;
  }
  strip.classList.remove("hidden");
  due.slice(0, 8).forEach((d) => {
    const days = d.days !== undefined ? d.days : daysUntil(d.due);
    const chip = el("button", "due-chip");
    chip.type = "button";
    chip.dataset.urgent = String(days !== null && days !== undefined && days <= 3);
    chip.title = `${d.title || d.id || ""} · ${d.due || ""}`;
    chip.appendChild(icon("i-clock"));
    chip.appendChild(el("span", "due-chip-title", d.title || d.id || ""));
    const left = daysLeftText(days);
    if (left) chip.appendChild(el("span", "due-chip-days", left));
    chip.onclick = () => d.id && openAffairDetail(d.id);
    strip.appendChild(chip);
  });
}

async function loadAffairs() {
  try {
    const resp = await api(`/api/affairs?${q(state.name)}`);
    const data = await resp.json();
    state.affairs = (data && data.affairs) || [];
    renderBoard(state.affairs);
  } catch (e) {
    const box = $("#affair-board .panel-body");
    if (box) {
      box.innerHTML = "";
      box.appendChild(el("p", "empty-hint", `事务看板暂时取不到：${e.message}`));
    }
  }
}

function renderBoard(affairs) {
  const box = $("#affair-board .panel-body");
  if (!box) return;
  box.innerHTML = "";
  const open = affairs.filter((a) => a && a.stage !== "done");
  const closed = affairs.filter((a) => a && a.stage === "done");
  open.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));

  const sub = $("#affair-board .panel-sub");
  if (sub) sub.textContent = `${open.length} 件在办`;

  if (!open.length && !closed.length) {
    box.appendChild(el("p", "empty-hint", "还没有事务，跟管家说一件要办的事试试～"));
    return;
  }
  open.forEach((a) => box.appendChild(affairCard(a)));
  if (closed.length) {
    // 已结案默认折叠，不占在办事务的空间
    const det = el("details", "closed-affairs");
    const sum = el("summary", null, `已结案 ${closed.length} 件`);
    det.appendChild(sum);
    const list = el("div", "closed-list");
    closed.forEach((a) => list.appendChild(affairCard(a)));
    det.appendChild(list);
    box.appendChild(det);
  }
}

/** 头行：图标 + 标题 + 右侧尾巴（倒计时 / 进度）。看板卡与详情抽屉共用。 */
function affairHeadEl(a) {
  const head = el("div", "affair-head");
  const iconBox = el("span", "affair-icon");
  iconBox.appendChild(icon(KIND_ICON[a.kind] || "i-board"));
  const tail = el("span", "affair-tail");
  tail.appendChild(progressEl(a));
  append(head, iconBox, el("span", "affair-title", a.title || a.id || ""), tail);
  return head;
}

function affairMetaEl(a, stage) {
  const meta = el("div", "affair-meta");
  meta.appendChild(el("span", "stage-name", STAGES[stage] || stage));
  if (OWNERS[a.owner_next]) {
    const badge = el("span", "owner-badge", OWNERS[a.owner_next]);
    badge.dataset.owner = a.owner_next;
    meta.appendChild(badge);
  }
  return meta;
}

function affairCard(a) {
  if (!a) return el("div");
  const stage = STAGES[a.stage] ? a.stage : "discovered";
  const cssStage = STAGE_CSS[stage] || stage;
  const card = el("article", `affair-card stage-${cssStage} clickable`);
  card.dataset.affair = a.id || "";
  card.dataset.stage = cssStage;
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  const days = daysUntil(a.due);
  if (days !== null && days <= 3) card.dataset.urgent = "true";

  card.appendChild(affairHeadEl(a));
  if (a.summary) card.appendChild(el("div", "affair-summary", a.summary));
  card.appendChild(affairMetaEl(a, stage));

  const linked = a.linked_nodes || [];
  if (linked.length) {
    const wrap = el("div", "linked-nodes");
    linked.slice(0, 3).forEach((id) => wrap.appendChild(el("span", "node-pill", nodeLabel(id))));
    if (linked.length > 3) wrap.appendChild(el("span", "node-pill", `+${linked.length - 3}`));
    card.appendChild(wrap);
  }

  const open = () => openAffairDetail(a.id);
  card.onclick = open;
  card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  return card;
}

function progressEl(a) {
  const p = a.progress;
  const mode = p && typeof p === "object" ? p.mode : typeof p === "number" ? "percent" : null;
  if (mode === "percent") {
    const v = Math.max(0, Math.min(100, Math.round(p && typeof p === "object" ? Number(p.value) || 0 : Number(p) * 100 || 0)));
    const wrap = el("span", "progress");
    const track = el("span", "progress-track");
    const fill = el("i", "progress-fill");
    fill.style.width = `${v}%`;
    track.appendChild(fill);
    append(wrap, track, el("span", "progress-num", `${v}%`));
    return wrap;
  }
  const cd = countdownText(a.due);
  const days = daysUntil(a.due);
  return el("span", `countdown${days !== null && days < 0 ? " overdue" : ""}`,
    cd || (mode === "days" && p ? `${p.value} 天` : ""));
}

function nodeLabel(id) {
  const hit = (state.graph.nodes || []).find((n) => n.id === id);
  return hit ? hit.label || id : id;
}

function onAffairEvent(ev) {
  const aff = ev && ev.affair;
  if (!aff || !aff.id) return;
  const idx = state.affairs.findIndex((x) => x && x.id === aff.id);
  const isNew = idx < 0;
  if (isNew) state.affairs.unshift(aff);
  else state.affairs[idx] = { ...state.affairs[idx], ...aff };
  renderBoard(state.affairs);
  toast(`事务「${truncate(aff.title || aff.id, 16)}」${isNew ? "已建立" : "已更新"} · ${STAGES[aff.stage] || ""}`);
}

/* ---------- 事务详情 ---------- */

async function openAffairDetail(aid) {
  if (!aid) return;
  let aff = state.affairs.find((a) => a && a.id === aid);
  try {
    const resp = await api(`/api/affairs/${encodeURIComponent(aid)}?${q(state.name)}`);
    const data = await resp.json();
    const got = data && (data.affair || (data.id ? data : null));
    if (got) aff = { ...(aff || {}), ...got };
  } catch { /* 用看板缓存 */ }
  if (!aff) return;
  // 镜头对准第一个关联节点
  const linked = aff.linked_nodes || [];
  if (linked.length) s3("focusNode", linked[0]);

  const holder = ensureDetailPanels();
  const box = holder.body;
  box.innerHTML = "";

  const stage = STAGES[aff.stage] ? aff.stage : "discovered";
  holder.wrap.dataset.stage = STAGE_CSS[stage] || stage;
  box.appendChild(affairHeadEl(aff));
  if (aff.summary) box.appendChild(el("div", "affair-summary", aff.summary));
  box.appendChild(affairMetaEl(aff, stage));

  const acts = el("div", "inbox-actions");
  const icsBtn = el("button", "btn-approve");
  icsBtn.type = "button";
  append(icsBtn, icon("i-cal"), document.createTextNode("导出日历"));
  // fetch + Authorization + blob 下载：window.open 带不了头只能 ?token=，
  // URL 会留浏览器历史/反代日志——token 等于账号本身，不能这么给。
  icsBtn.onclick = async () => {
    icsBtn.disabled = true;
    try {
      const resp = await api(`/api/ics/${encodeURIComponent(aff.id)}?${q(state.name)}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = el("a");
      a.href = url;
      a.download = `${aff.id || "affair"}.ics`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      addSys(`日历导出失败：${e.message}`);
    } finally {
      icsBtn.disabled = false;
    }
  };
  const closeBtn = el("button", "btn-reject", "关闭");
  closeBtn.type = "button";
  closeBtn.onclick = () => holder.wrap.classList.add("hidden");
  append(acts, icsBtn, closeBtn);
  box.appendChild(acts);

  box.appendChild(await checklistBlock(aff));
  box.appendChild(dagBlock(aff));
  box.appendChild(draftsBlock(aff));
  box.appendChild(logBlock(aff));
  holder.wrap.classList.remove("hidden");
  holder.wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function ensureDetailPanels() {
  let wrap = $("#affair-detail");
  if (!wrap) {
    wrap = el("section", "panel hidden");
    wrap.id = "affair-detail";
    wrap.innerHTML =
      `<div class="panel-head">
         <h3>${iconHTML("i-clip")} 事务详情</h3>
         <button class="icon-btn detail-close" type="button" aria-label="关闭事务详情">
           ${iconHTML("i-x")}
         </button>
       </div>
       <div class="panel-body scroll drawer-body"></div>`;
    const close = wrap.querySelector(".detail-close");
    if (close) close.onclick = () => wrap.classList.add("hidden");
    const board = $("#affair-board");
    (board && board.parentElement ? board.parentElement : document.body).appendChild(wrap);
  }
  return { wrap, body: wrap.querySelector(".drawer-body") || wrap };
}

async function checklistBlock(aff) {
  const wrap = el("div");
  wrap.appendChild(el("div", "drawer-sub", "清单"));
  const cid = aff.checklist_id;
  if (!cid) {
    wrap.appendChild(el("div", "empty-hint", "这件事还没有清单"));
    return wrap;
  }
  let items = aff.checklist && aff.checklist.items;
  if (!items) {
    try {
      const resp = await api(`/api/checklist/${encodeURIComponent(cid)}?${q(state.name)}`);
      const data = await resp.json();
      const cl = data.checklist || data;
      items = cl.items || (Array.isArray(cl) ? cl : []);
    } catch {
      wrap.appendChild(el("div", "empty-hint", "清单暂时取不到"));
      return wrap;
    }
  }
  if (!items.length) {
    wrap.appendChild(el("div", "empty-hint", "清单是空的"));
    return wrap;
  }
  const list = el("div", "checklist");
  items.forEach((item, i) => list.appendChild(checkRow(item, i, cid)));
  wrap.appendChild(list);
  const doneN = items.filter((i) => i && i.done).length;
  wrap.appendChild(el("div", "check-progress", `已勾 ${doneN}/${items.length}`));
  return wrap;
}

function checkRow(item, index, cid) {
  const row = el("label", `check-item${item.done ? " done" : ""}`);
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = !!item.done;
  if (state.authRole === "parent") {
    cb.disabled = true;           // 家长只读：勾选权在孩子手里（服务端也会 403）
    row.title = "家长视角只读";
  }
  cb.onchange = () => toggleChecklist(cid, index, cb.checked, cb, row);
  append(row, cb, el("span", "check-text", item.text || ""));
  if (item.note) row.appendChild(el("span", "check-note", `引用记忆：${item.note}`));
  return row;
}

async function toggleChecklist(cid, index, done, cb, row) {
  cb.disabled = true;
  try {
    await api(`/api/checklist/${encodeURIComponent(cid)}`, jsonOpts({ name: state.name, index, done }));
    if (row) row.classList.toggle("done", done);
  } catch (e) {
    cb.checked = !done;
    if (row) row.classList.toggle("done", !done);
    addSys(`清单没存上：${e.message}`);
  } finally {
    cb.disabled = false;
  }
}

function dagBlock(aff) {
  const wrap = el("div");
  const nodes = (aff.plan && aff.plan.nodes) || [];
  if (nodes.length) {
    // 真执行链：后端把 plan+节点终态存进了 affair，这里是回放而不是摆拍
    wrap.appendChild(el("div", "drawer-sub", "DAG 回放"));
    const dag = el("div", "dag");
    const title = el("div", "dag-title");
    title.appendChild(icon("i-board"));
    title.appendChild(document.createTextNode(aff.plan.title || `${aff.title || ""} 的执行链`));
    dag.appendChild(title);
    const names = {};
    nodes.forEach((n) => (names[n.id] = n.title || n.id));
    const box = el("div", "dag-nodes");
    nodes.forEach((n) => box.appendChild(dagNodeRow(n, names, n.status || "done")));
    dag.appendChild(box);
    wrap.appendChild(dag);
    return wrap;
  }
  // 没有执行链存档时如实展示"关联记忆"，不把记忆节点串成假 DAG
  const linked = aff.linked_nodes || [];
  if (!linked.length) return wrap;
  wrap.appendChild(el("div", "drawer-sub", "关联记忆"));
  const box = el("div", "linked-nodes");
  linked.forEach((id) => box.appendChild(el("span", "node-pill", nodeLabel(id))));
  wrap.appendChild(box);
  return wrap;
}

/** 单个 DAG 节点行（icon 用 SVG/CSS，不用 emoji） */
function dagNodeRow(n, names, status) {
  const dep = (n.depends_on || []).map((d) => names[d]).filter(Boolean).join("、");
  const row = el("div", "dag-node");
  row.dataset.id = n.id || "";
  row.dataset.status = status || "pending";
  const dot = el("span", "dag-dot");
  setDagDot(dot, row.dataset.status);
  const name = el("span", "dag-name");
  name.textContent = n.title || n.id || "";
  if (dep) name.appendChild(el("div", "dag-deps", `等「${dep}」完成后`));
  append(row, dot, name, el("span", "dag-detail"));
  // 点节点展开/收起该环节的完整结果（updatePlanNode 写入 dataset.full 后才可展开）
  row.addEventListener("click", () => {
    const d = row.querySelector(".dag-detail");
    const full = d && d.dataset.full;
    if (!full) return;
    const open = row.classList.toggle("is-open");
    d.textContent = open ? full : truncate(full, 26);
  });
  return row;
}

function setDagDot(dot, status) {
  dot.innerHTML = "";
  if (status === "done") dot.appendChild(icon("i-check"));
  else if (status === "error") dot.appendChild(icon("i-x"));
  else if (status === "running") dot.appendChild(icon("i-bolt"));
}

/** 交付文稿：draft 动作写成的稿子挂回事务（aff.drafts 由详情接口一起返回）。 */
function draftsBlock(aff) {
  const wrap = el("div");
  const drafts = aff.drafts || [];
  if (!drafts.length) return wrap;
  wrap.appendChild(el("div", "drawer-sub", "交付文稿"));
  drafts.forEach((d) => {
    const det = el("details", "draft-item");
    const sum = el("summary", "draft-sum");
    sum.appendChild(icon("i-doc"));
    sum.appendChild(el("span", "draft-title", d.title || "文稿"));
    if (d.created) {
      sum.appendChild(el("span", "draft-time", String(d.created).slice(5, 16).replace("T", " ")));
    }
    det.appendChild(sum);
    const body = el("div", "doc-body");
    body.textContent = d.body || "";
    det.appendChild(body);
    const copyBtn = el("button", "btn-approve doc-copy");
    copyBtn.type = "button";
    append(copyBtn, icon("i-clip"), document.createTextNode("复制全文"));
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(d.body || "");
        toast("已复制，拿去用吧");
      } catch {
        toast("复制没成功，手动选中文字复制吧");
      }
    };
    det.appendChild(copyBtn);
    wrap.appendChild(det);
  });
  return wrap;
}

function logBlock(aff) {
  const wrap = el("div");
  wrap.appendChild(el("div", "drawer-sub", "执行日志"));
  const log = aff.log || [];
  if (!log.length) {
    wrap.appendChild(el("div", "empty-hint", "还没有日志"));
    return wrap;
  }
  const box = el("div", "affair-log");
  log.slice(-15).forEach((l) => {
    if (!l) return;
    const row = el("div", "log-line");
    append(row,
      el("span", null, String(l.ts || "").slice(5, 16).replace("T", " ")),
      el("span", "log-actor", actorName(l.actor)),
      el("span", null, l.text || ""));
    box.appendChild(row);
  });
  wrap.appendChild(box);
  return wrap;
}

function actorName(a) {
  return { butler: "管家", child: "孩子", parent: "家长" }[a] || a || "";
}

function applyActionToDetail(ev) {
  const detail = $("#affair-detail");
  if (!detail || detail.classList.contains("hidden")) return;
  const body = detail.querySelector(".drawer-body") || detail;
  body.appendChild(actionReceipt(ev));
}

function actionReceipt(ev) {
  const ok = !!(ev && ev.ok);
  const r = el("div", `action-receipt ${ok ? "ok" : "fail"}`);
  r.appendChild(icon(ok ? "i-check" : "i-x"));
  const body = el("span", "rc-body");
  const kind = el("span", "rc-kind", ACTION_KIND[ev && ev.kind] || "执行动作");
  body.appendChild(kind);
  body.appendChild(document.createTextNode((ev && (ev.detail || ev.label)) || (ok ? "完成" : "没成功")));
  r.appendChild(body);
  return r;
}

/* ==========================================================================
 * 6. 问候 + 历史
 * ========================================================================== */

// 问候气泡：停留一小会儿后渐隐，别一直挡着场景
const BUBBLE_HOLD_MS = 6000;
const BUBBLE_FADE_MS = 700;
let bubbleFadeTimer = 0;

/** 立刻收起问候气泡（发消息、退出登录时用）。 */
function hideBubble(bubble) {
  clearTimeout(bubbleFadeTimer);
  if (!bubble) return;
  bubble.classList.remove("bb-fade");
  bubble.classList.add("hidden");
}

/** 让气泡停留 holdMs 后渐隐，动画结束再真正隐藏。 */
function scheduleBubbleFade(bubble) {
  if (!bubble) return;
  clearTimeout(bubbleFadeTimer);
  bubble.classList.remove("hidden", "bb-fade");
  bubbleFadeTimer = setTimeout(() => {
    bubble.classList.add("bb-fade");
    bubbleFadeTimer = setTimeout(() => {
      bubble.classList.add("hidden");
      bubble.classList.remove("bb-fade");
    }, BUBBLE_FADE_MS);
  }, BUBBLE_HOLD_MS);
}

async function loadGreeting() {
  const bubble = $("#panda-bubble");
  const span = el("span", "bb-text");
  if (bubble) {
    clearTimeout(bubbleFadeTimer);
    bubble.classList.remove("hidden", "bb-fade");
    bubble.innerHTML = "";
    bubble.appendChild(span);
  }
  s3("setPandaMood", "speaking");
  let full = "";
  let data = {};
  try {
    // 流式：token 一到就上屏，比整段等完再 typewrite 更早出字
    const resp = await api(`/api/greeting?${q(state.name)}&stream=1`);
    data = await readTextStream(resp, (tok) => {
      full += tok;
      if (span) span.textContent = full;
    }, onStreamEvent);
  } catch (e) {
    // 连服务端都没连上：如实说，不写死一句"问候"冒充生成结果
    data = { degraded: true, degraded_reason: e.message };
    full = "管家暂时连不上，问候稍后再补上～";
  }
  const text = (data && data.text) || full || "管家暂时连不上，问候稍后再补上～";
  if (span) span.textContent = text;
  if (bubble && data && data.degraded) bubble.appendChild(degradedNote(data.degraded_reason));
  if (bubble) {
    const reminders = (data && data.reminders) || [];
    if (reminders.length && bubble.isConnected) {
      const box = el("div", "reminders");
      reminders.forEach((r) => {
        const pill = el("span", "reminder-pill");
        pill.appendChild(icon("i-clock"));
        pill.appendChild(document.createTextNode(` ${r.text || ""}`));
        box.appendChild(pill);
      });
      bubble.appendChild(box);
    }
  }
  scheduleBubbleFade(bubble);
  // 兜底文本不写进聊天区：聊天区里的 ai 消息只能是真实生成的
  return data && data.degraded ? "" : text;
}

async function loadHistory() {
  try {
    const resp = await api(`/api/history?${q(state.name)}`);
    const data = await resp.json();
    const history = (data && data.history) || [];
    if (history.length > 30) addSys("（只展示最近 30 条对话）");
    history.slice(-30).forEach((m) => {
      if (!m) return;
      addMsg(m.role === "user" ? "me" : "ai", m.content || "",
             String(m.content || "").startsWith("[[secret]]"), m.files || null);
    });
    return history.length;
  } catch { return 0; /* 无历史不阻塞 */ }
}

/* ---- 和管家说：新建项目 / 清空 / 切换历史项目 ---- */

function renderHistory(history) {
  const box = chatBox();
  if (box) box.innerHTML = CHAT_WELCOME;
  (history || []).slice(-30).forEach((m) => {
    if (!m) return;
    addMsg(m.role === "user" ? "me" : "ai", m.content || "",
           String(m.content || "").startsWith("[[secret]]"), m.files || null);
  });
}

async function chatAdmin(path, method) {
  if (state.busy) { toast("管家还在回复，等说完再操作吧"); return null; }
  try {
    const resp = await api(`${path}${path.includes("?") ? "&" : "?"}${q(state.name)}`, { method });
    return await resp.json();
  } catch (e) { toast(e.message || "操作没成功"); return null; }
}

async function newProject() {
  const d = await chatAdmin("/api/history/new", "POST");
  if (!d) return;
  renderHistory([]);
  toast(d.archived ? "已归档上一段对话，开始新项目" : "已开始新项目");
}

async function clearChat() {
  if (!window.confirm("清空当前对话记录？管家已记住的记忆和事务不会被删除。")) return;
  const d = await chatAdmin("/api/history", "DELETE");
  if (d) { renderHistory([]); toast("对话记录已清空"); }
}

async function toggleProjMenu() {
  const menu = $("#proj-menu"), btn = $("#proj-list");
  if (!menu) return;
  const open = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !open);
  btn.setAttribute("aria-expanded", String(open));
  if (!open) return;
  menu.textContent = "";
  menu.appendChild(el("div", "proj-empty", "加载中…"));
  let list = [];
  try {
    const resp = await api(`/api/history/archives?${q(state.name)}`);
    list = ((await resp.json()) || {}).archives || [];
  } catch (e) { toast(e.message || "读取失败"); }
  menu.textContent = "";
  if (!list.length) { menu.appendChild(el("div", "proj-empty", "还没有归档的项目，点「＋ 新项目」会把当前对话存进来")); return; }
  list.forEach((it) => {
    const row = el("div", "proj-item");
    const main = el("button", "pi-main", it.title || "对话");
    main.type = "button";
    main.onclick = async () => {
      const d = await chatAdmin(`/api/history/archives/${it.id}/restore`, "POST");
      if (d) { renderHistory(d.history); menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); toast("已切换项目"); }
    };
    const meta = el("span", "pi-meta", `${it.count} 条 · ${String(it.ts).slice(5, 10)}`);
    const del = el("button", "pi-del", "删除");
    del.type = "button";
    del.onclick = async () => {
      if (!window.confirm(`删除项目「${it.title || "对话"}」？删除后无法恢复。`)) return;
      if (await chatAdmin(`/api/history/archives/${it.id}`, "DELETE")) row.remove();
    };
    append(row, main, meta, del);
    menu.appendChild(row);
  });
}

function bindProjectTools() {
  const tools = $("#chat-tools");
  if (!tools) return;
  tools.classList.toggle("hidden", state.role === "parent");
  if (tools.dataset.bound) return;
  tools.dataset.bound = "1";
  $("#proj-new").addEventListener("click", newProject);
  $("#proj-list").addEventListener("click", toggleProjMenu);
  $("#chat-clear").addEventListener("click", clearChat);
}

/* ==========================================================================
 * 6.5 附件（多模态上传）
 * ========================================================================== */

const ATTACH_MAX = 5;                       // 与服务端 UPLOAD_MAX_FILES_PER_REQUEST 对齐
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;  // 与服务端 PANDA_UPLOAD_MAX_MB 对齐
const ATTACH_MAX_FILES = 60;                // 与服务端 UPLOAD_MAX_FILES_PER_CHILD 对齐（面板里显示配额）

function attachKindCn(kind) {
  return { image: "图片", pdf: "PDF", docx: "Word", xlsx: "表格", text: "文本",
           pptx: "PPT", legacy_office: "旧版 Office" }[kind] || "文件";
}

function attachIcon(file) {
  const kind = (file && file.kind) || "";
  if (kind === "image") return "i-image";
  if (kind === "text") return "i-book";
  return "i-doc";
}

function renderAttachList() {
  const box = $("#attach-list");
  if (!box) return;
  box.innerHTML = "";
  const items = [...(state.attach || []), ...(state.attachPending || [])];
  if (!items.length && !state.recentOpen) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  items.forEach((f) => {
    const chip = el("span", `attach-chip${f.error ? " error" : ""}${f.uploading ? " uploading" : ""}`);
    if (isPreviewableImage(f)) {
      const img = el("img", "attach-thumb");
      img.alt = "";
      img.loading = "lazy";
      loadPrivateImage(img, f.preview || f.content, () => swapImgToIcon(img, f));
      chip.appendChild(img);
    } else {
      // 非图片（PDF/Word/Excel/文本）：直接给类型图标，不去试解码原图
      chip.appendChild(icon(attachIcon(f)));
    }
    chip.appendChild(el("span", "attach-name", f.name || "文件"));
    const meta = f.uploading ? "读取中…"
      : f.error ? f.error
        : `${attachKindCn(f.kind)}${f.size_cn ? " · " + f.size_cn : ""}`;
    chip.appendChild(el("span", "attach-meta", meta));
    if (!f.uploading) {
      const rm = el("button", "icon-btn attach-rm");
      rm.type = "button";
      rm.setAttribute("aria-label", `移除 ${f.name || "附件"}`);
      rm.appendChild(icon("i-x"));
      rm.onclick = () => removeAttach(f.id);
      chip.appendChild(rm);
    }
    box.appendChild(chip);
  });
  if (state.recentOpen) box.appendChild(recentFilesPanel());
}

/** 最近上传面板：配额满了要能自己清；之前发过的图也要能一键再引用一次。 */
function recentFilesPanel() {
  const wrap = el("div", "attach-recent");
  const head = el("div", "attach-recent-head");
  head.appendChild(icon("i-clip"));
  head.appendChild(el("span", null, `最近上传（${(state.recent || []).length}/${ATTACH_MAX_FILES}）`));
  const close = el("button", "icon-btn");
  close.type = "button";
  close.setAttribute("aria-label", "收起最近上传");
  close.appendChild(icon("i-x"));
  close.onclick = () => { state.recentOpen = false; renderAttachList(); };
  head.appendChild(close);
  wrap.appendChild(head);
  const list = state.recent || [];
  if (!list.length) {
    wrap.appendChild(el("span", "attach-recent-empty", "还没有上传过文件"));
    return wrap;
  }
  list.forEach((f) => {
    const row = el("div", "attach-recent-row");
    row.appendChild(icon(attachIcon(f)));
    row.appendChild(el("span", "attach-name", f.name || "文件"));
    const bits = [attachKindCn(f.kind)];
    if (f.size_cn) bits.push(f.size_cn);
    if (f.has_text && f.chars) bits.push(`${f.chars} 字`);
    row.appendChild(el("span", "attach-meta", bits.join(" · ")));
    const again = el("button", "icon-btn");
    again.type = "button";
    again.setAttribute("aria-label", `再次引用 ${f.name || "附件"}`);
    again.title = "再次引用（下一轮带上它）";
    again.appendChild(icon("i-attach"));
    again.onclick = () => reuseAttach(f);
    row.appendChild(again);
    const rm = el("button", "icon-btn");
    rm.type = "button";
    rm.setAttribute("aria-label", `删除 ${f.name || "附件"}`);
    rm.title = "从服务器删除";
    rm.appendChild(icon("i-x"));
    rm.onclick = () => deleteRecent(f.id);
    row.appendChild(rm);
    wrap.appendChild(row);
  });
  return wrap;
}

async function toggleRecentFiles() {
  state.recentOpen = !state.recentOpen;
  const btn = $("#files-btn");
  if (btn) btn.setAttribute("aria-expanded", state.recentOpen ? "true" : "false");
  if (state.recentOpen) {
    try {
      const resp = await api(`/api/files?${q(state.name)}`);
      const data = await resp.json();
      state.recent = data.files || [];
    } catch (e) {
      toast(`读取附件列表失败：${e.message}`);
      state.recentOpen = false;
    }
  }
  renderAttachList();
}

/** 把服务器上的旧附件加回待发送区（图片可以再问一次，不用重新上传）。 */
function reuseAttach(f) {
  if (!f || !f.id) return;
  if ((state.attach || []).some((x) => x.id === f.id)) { toast("这个附件已经在待发送区了"); return; }
  if ((state.attach || []).length >= ATTACH_MAX) { toast(`一次最多带 ${ATTACH_MAX} 个附件`); return; }
  state.attach.push(f);
  renderAttachList();
}

async function deleteRecent(fid) {
  try {
    await api(`/api/files/${encodeURIComponent(fid)}?${q(state.name)}`, { method: "DELETE" });
  } catch (e) {
    toast(`删除失败：${e.message}`);
    return;
  }
  state.recent = (state.recent || []).filter((f) => f.id !== fid);
  state.attach = (state.attach || []).filter((f) => f.id !== fid);
  renderAttachList();
}

function removeAttach(fid) {
  state.attachPending = (state.attachPending || []).filter((f) => f.id !== fid);
  const hit = (state.attach || []).find((f) => f.id === fid);
  state.attach = (state.attach || []).filter((f) => f.id !== fid);
  if (hit) {
    // 顺手把服务端那份也删掉：不留没人引用的孤儿文件占配额
    api(`/api/files/${encodeURIComponent(fid)}?${q(state.name)}`, { method: "DELETE" })
      .catch(() => { /* 删不掉不影响使用，配额清理会兜底 */ });
  }
  renderAttachList();
}

/** 上传一批文件：逐个 POST（失败只影响那一个），完成后再放到待发送区。 */
async function uploadFiles(fileList) {
  const picked = Array.from(fileList || []);
  if (!picked.length) return;
  if (!state.name) return;
  const room = ATTACH_MAX - ((state.attach || []).length + (state.attachPending || []).length);
  if (room <= 0) {
    toast(`一次最多带 ${ATTACH_MAX} 个附件`);
    return;
  }
  const queue = picked.slice(0, room);
  if (picked.length > room) toast(`一次最多带 ${ATTACH_MAX} 个附件，多的没上传`);
  state.attachPending = state.attachPending || [];
  for (const f of queue) {
    if (f.size > ATTACH_MAX_BYTES) {
      state.attachPending.push({ id: `err-${f.name}-${Date.now()}`, name: f.name,
                                 error: `超过 ${Math.round(ATTACH_MAX_BYTES / 1024 / 1024)}MB`, uploading: false });
      continue;
    }
    const slot = { id: `up-${f.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                   name: f.name, uploading: true };
    state.attachPending.push(slot);
    renderAttachList();
    try {
      const fd = new FormData();
      fd.append("file", f, f.name);
      const resp = await api(`/api/files?${q(state.name)}`, { method: "POST", body: fd });
      const data = await resp.json();
      state.attachPending = state.attachPending.filter((x) => x !== slot);
      state.attach.push(data.file);
    } catch (e) {
      state.attachPending = state.attachPending.filter((x) => x !== slot);
      state.attachPending.push({ id: slot.id, name: f.name, error: e.message, uploading: false });
    }
    renderAttachList();
  }
  state.attachPending = (state.attachPending || []).filter((f) => !f.error);
  if ((state.attachPending || []).length) {
    const first = state.attachPending[0];
    toast(`「${first.name}」${first.error}`);
    state.attachPending = [];
  }
  renderAttachList();
  const input = $("#msg-input");
  if (input) input.focus();
}

/** 附件原图缓存：url → { blob, size }。
 *
 * 缓存是为了点开大图时不用再请求一次原图（列表里的缩略图通常就是刚存下的那张）；
 * 但绝不复用 objectURL 本身——URL 一旦被 revoke 就永久失效，二次挂到 <img> 上
 * 会静默变空白（"图时有时无"就是这么来的）。每次上屏生成一个新的。
 */
const attachBlobs = new Map();

/**
 * 带鉴权的图片加载：<img> 不能带 Authorization 头，所以 fetch 成 blob 再挂上去。
 *
 * onFail：拿不到图时回调，调用方据此换成文件图标——只留一个破了的小方块
 * （或干脆空白）会让人以为"文件传丢了"，其实多半只是这张图挂了。
 *
 * 两道保险，因为"服务端说是图片"不等于"浏览器解得了"（HEIC、坏图、被截断）：
 *   1. fetch 失败 / 空 blob 立刻回调；
 *   2. 挂上去后等一次 load——有些图能取到字节却解码不了，那就同样回落成图标。
 */
async function loadPrivateImage(img, url, onFail) {
  if (!img || !url) { onFail?.(); return; }
  let objUrl = "";
  try {
    let blob = (attachBlobs.get(url) || {}).blob;
    if (!blob) {
      const resp = await api(url);
      blob = await resp.blob();
      if (!blob || !blob.size) throw new Error("空文件");
      attachBlobs.set(url, { blob });
    }
    if (!img.isConnected) return;   // 已经换了一轮/被移除，别白挂
    objUrl = URL.createObjectURL(blob);
    // 记在元素上，重绘时由 sweepPendingObjectUrls 统一回收
    img.dataset.objurl = objUrl;
    img.src = objUrl;
    if (typeof img.decode === "function") {
      await img.decode();           // 解码失败会 reject，走到下面的 onFail
      if (!img.isConnected) return;
    }
  } catch {
    if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch { /* 忽略 */ } }
    onFail?.();
  }
}

/** 把"没挂上的 <img>"换回文件图标：卡片仍然可读，只是没有预览。 */
function swapImgToIcon(img, file) {
  if (!img || !img.isConnected) return;
  const svg = icon(attachIcon(file));
  img.replaceWith(svg);
}

/** 清掉还没用上的 objectURL：暂存区/对话区重绘前叫一次，别让 blob 越攒越多。 */
function sweepPendingObjectUrls(root) {
  if (!root) return;
  if (root._pendingUrls) {
    root._pendingUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* 忽略 */ } });
    root._pendingUrls = null;
  }
  root.querySelectorAll("img[data-objurl]").forEach((im) => {
    try { URL.revokeObjectURL(im.dataset.objurl); } catch { /* 忽略 */ }
  });
}

/** 点开大图：附件原图在对话框里只有缩略图那么大，看不清题面/手写答案。 */
let lightboxUrl = null;

function closeLightbox() {
  const box = $("#lightbox");
  if (box) { box.classList.add("hidden"); box.setAttribute("aria-hidden", "true"); }
  state.lightboxFile = null;
  if (lightboxUrl) {
    try { URL.revokeObjectURL(lightboxUrl); } catch { /* 忽略 */ }
    lightboxUrl = null;
  }
  const img = $("#lightbox-img");
  if (img) img.removeAttribute("src");
}

/** 显示原图（不裁剪、按屏幕缩放）。blob 已在缓存里就直接用，避免二次下载。 */
async function openLightbox(file) {
  const box = $("#lightbox");
  const img = $("#lightbox-img");
  const url = fileContentUrl(file);
  if (!box || !img || !isPreviewableImage(file) || !url) return;
  try {
    let blob = (attachBlobs.get(url) || {}).blob;
    if (!blob) {
      const resp = await api(url);
      blob = await resp.blob();
      attachBlobs.set(url, { blob });
    }
    if (lightboxUrl) { try { URL.revokeObjectURL(lightboxUrl); } catch { /* 忽略 */ } }
    lightboxUrl = URL.createObjectURL(blob);
    state.lightboxFile = file;
    img.alt = file.name || "图片";
    img.src = lightboxUrl;
    const cap = $("#lightbox-cap");
    if (cap) {
      const bits = [file.name || "图片"];
      if (file.width && file.height) bits.push(`${file.width}×${file.height}`);
      if (file.size_cn) bits.push(file.size_cn);
      cap.textContent = bits.join(" · ");
    }
    box.classList.remove("hidden");
    box.setAttribute("aria-hidden", "false");
  } catch (e) {
    toast(`这张图打不开了：${e.message}`);
  }
}

/** 一轮对话 / 一条历史消息附带的文件卡（点在图片上看大图，其它文件走下载）。 */
function filesRow(files) {
  const list = (files || []).filter((f) => f && f.id);
  if (!list.length) return null;
  const row = el("div", "msg-files");
  list.forEach((f) => {
    const isImage = isPreviewableImage(f);
    const card = el("a", `msg-file${isImage ? " msg-file-image" : ""}`);
    card.href = fileContentUrl(f) || "#";
    card.setAttribute("aria-label", isImage
      ? `${f.name || "图片"}（点开看大图）`
      : `${f.name || "文件"}（${attachKindCn(f.kind)}）`);
    // 图片：先给一个文件图标兜底，图挂上了再把它去掉——上传的就是张坏图时，
    // 卡片不会变成一个破图占位，而是如实回落到"图片 · 2.1 MB"。
    let ph = null;
    if (isImage) {
      ph = icon("i-image");
      card.appendChild(ph);
    }
    card.onclick = (e) => {
      e.preventDefault();
      if (isImage) openLightbox(f); else downloadAttach(f);
    };
    if (isImage) {
      const img = el("img");
      img.alt = f.name || "图片";
      img.loading = "lazy";
      loadPrivateImage(img, fileContentUrl(f), () => img.remove());
      img.addEventListener("load", () => { ph?.remove(); ph = null; }, { once: true });
      card.appendChild(img);
      // 缩略图本身可点开大图；旁边再给一个明确的"下载原图"入口，
      // 否则想存下来的人只能先点开大图、再点浮层里的按钮，多一步。
      const dl = el("button", "msg-file-dl");
      dl.type = "button";
      dl.setAttribute("aria-label", `下载原图 ${f.name || "图片"}`);
      dl.title = "下载原图";
      dl.appendChild(icon("i-download"));
      dl.onclick = (e) => { e.preventDefault(); e.stopPropagation(); downloadAttach(f); };
      card.appendChild(dl);
    } else {
      card.appendChild(icon(attachIcon(f)));
    }
    const info = el("span", "msg-file-info");
    info.appendChild(el("span", "msg-file-name", f.name || "文件"));
    const bits = [attachKindCn(f.kind)];
    if (f.size_cn) bits.push(f.size_cn);
    // 图片的 text 是元信息行（"图片：W×H"），不是抽取正文——不能显示成"已读出 N 字"
    if (f.kind !== "image" && f.has_text && f.chars) bits.push(`已读出 ${f.chars} 字`);
    else if (f.note) bits.push(f.note);
    info.appendChild(el("span", "msg-file-sub", bits.join(" · ")));
    card.appendChild(info);
    row.appendChild(card);
  });
  return row;
}

/** 下载 / 查看原文件：fetch + blob（token 不能进 URL，见日历导出那里的说明）。 */
async function downloadAttach(f) {
  if (!f || !f.id) return;
  try {
    const resp = await api(`/api/files/${encodeURIComponent(f.id)}/content?${q(state.name)}&download=1`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = f.name || "附件";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast(`下载失败：${e.message}`);
  }
}

/** 拖拽上传：拖到聊天区就收（桌面端最顺手的入口）。 */
function setupDropZone() {
  const box = chatBox();
  if (!box) return;
  const over = (e) => { e.preventDefault(); box.classList.add("drop-active"); };
  const leave = () => box.classList.remove("drop-active");
  box.addEventListener("dragover", (e) => {
    if (!e.dataTransfer) return;
    over(e);
    e.dataTransfer.dropEffect = "copy";
  });
  box.addEventListener("dragleave", leave);
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    leave();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) uploadFiles(files);
  });
}



function chatBox() { return $("#chat"); }

/** 只挂附件时用的占位文本（服务端的意图分类要一句话；这句话不该当成孩子说的上屏）。 */
const ATTACH_ONLY_TEXT = "（看看这个附件）";

/** 上屏前过滤占位文本：附件轮只显示文件卡，不伪造一句孩子的原话（G3）。 */
function visibleUserText(text, files) {
  const t = String(text == null ? "" : text);
  if (t === ATTACH_ONLY_TEXT && (files || []).length) return "";
  return t;
}

function clearChatHint() {
  const hint = $("#chat .empty-hint, #chat .chat-welcome");
  if (hint) hint.remove();
}

function secretTag() {
  const tag = el("span", "secret-tag");
  tag.appendChild(icon("i-lock"));
  tag.appendChild(document.createTextNode("悄悄话"));
  return tag;
}

/** AI 消息 = 熊猫头像 + 全宽正文（markdown 渲染）；用户/系统消息仍是气泡。 */
function addMsg(cls, text, secret, files) {
  const box = chatBox();
  if (!box) return null;
  clearChatHint();
  // 只发附件时服务端需要一个占位文本才能分类；那句话不是孩子说的，别上屏（G3）
  const raw = visibleUserText(text, files);
  const shown = secret ? String(raw).replace(/^\[\[secret\]\]/, "") : raw;
  if (cls === "ai") {
    const row = el("div", `msg ai${secret ? " secret" : ""}`);
    const av = el("span", "msg-avatar");
    av.appendChild(icon("i-logo"));
    const body = el("div", "msg-text");
    if (secret) body.appendChild(secretTag());
    const md = el("div", "md");
    setMd(md, shown);
    body.appendChild(md);
    const filesEl = filesRow(files);
    if (filesEl) body.appendChild(filesEl);
    append(row, av, body);
    box.appendChild(row);
    scrollBottom();
    return row;
  }
  const div = el("div", `msg ${cls}${secret ? " secret" : ""}`);
  if (secret) div.appendChild(secretTag());
  if (String(shown).length) div.appendChild(document.createTextNode(shown));
  const filesEl = filesRow(files);
  if (filesEl) div.appendChild(filesEl);
  box.appendChild(div);
  scrollBottom(cls === "me");
  return div;
}

function addSys(text) { return addMsg("sys", text); }

// 只在本来就在底部（或用户自己发消息）时才滚到底——
// 流式回复时用户上翻读历史，不能再被拽回底部
function scrollBottom(force) {
  const c = chatBox();
  if (!c) return;
  if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 140) {
    c.scrollTop = c.scrollHeight;
  }
}

function addTyping() {
  const box = chatBox();
  if (!box) return null;
  clearChatHint();
  const t = el("div", "msg ai typing");
  const av = el("span", "msg-avatar");
  av.appendChild(icon("i-logo"));
  const dots = el("span", "typing-dots");
  dots.innerHTML = "<i></i><i></i><i></i>";
  append(t, av, dots);
  box.appendChild(t);
  scrollBottom();
  return t;
}

function addRecallChip(payload) {
  const box = chatBox();
  if (!box) return;
  const labels = ((payload && payload.nodes) || []).map((n) => n.label || n.id).filter(Boolean);
  if (!labels.length) return;
  clearChatHint();
  const row = el("div", "chip-row");
  const chip = el("span", "chip recall");
  chip.appendChild(icon("i-spark"));
  chip.appendChild(document.createTextNode(` 想起了：${labels.slice(0, 4).join("、")}`));
  row.appendChild(chip);
  box.appendChild(row);
  scrollBottom();
}

function addMemoryChip(payload) {
  const box = chatBox();
  if (!box) return;
  const secret = !!(payload && payload.secret);
  const added = (payload && payload.added_nodes) || [];
  const edges = (payload && payload.added_edges) || [];
  const updated = (payload && payload.updated) || [];
  const nameOf = (id) => {
    const hit = added.concat(updated).find((n) => n && n.id === id);
    return hit ? hit.label || hit.id : id;
  };
  let text = payload && payload.note;
  if (!text) {
    const parts = added.map((n) => n.label || n.id);
    edges.forEach((e) => parts.push(`${nameOf(e.source)} —${e.rel || "关联"}→ ${nameOf(e.target)}`));
    if (!parts.length) updated.forEach((n) => parts.push(`更新了「${n.label || n.id}」`));
    text = parts.length ? `记下了：${parts.join("、")}` : "记下了";
  }
  clearChatHint();
  const row = el("div", "chip-row");
  const chip = el("span", `chip memory${secret ? " secret" : ""}`);
  chip.appendChild(icon(secret ? "i-lock" : "i-book"));
  chip.appendChild(document.createTextNode(` ${text}${secret ? "（只有我知道）" : ""}`));
  if (secret) chip.title = "悄悄话：只写进孩子的档案，家长视角看不到";
  row.appendChild(chip);
  box.appendChild(row);
  scrollBottom();
}

/** 工具调用条：「🔧 联网搜索「西客松」…」→ 完成打勾 / 失败打叉。同一调用按 key 原地更新。 */
function addToolChip(ev, ctx) {
  const box = chatBox();
  if (!box) return;
  clearChatHint();
  ctx.toolChips = ctx.toolChips || {};
  const key = `${ev.tool}:${ev.label || ""}`;
  let chip = ctx.toolChips[key];
  if (!chip) {
    const row = el("div", "chip-row");
    chip = el("span", "chip tool");
    row.appendChild(chip);
    box.appendChild(row);
    ctx.toolChips[key] = chip;
  }
  const status = ev.status || "running";
  chip.dataset.status = status;
  chip.innerHTML = "";
  chip.appendChild(icon(status === "done" ? "i-check" : status === "error" ? "i-x" : "i-globe"));
  chip.appendChild(document.createTextNode(` ${ev.label || ev.tool}${status === "running" ? "…" : ""}`));
  scrollBottom();
}

function addPlanTree(title, nodes) {
  const box = chatBox();
  if (!box) return null;
  clearChatHint();
  const dag = el("div", "dag");
  const t = el("div", "dag-title");
  t.appendChild(icon("i-board"));
  t.appendChild(document.createTextNode(title || "执行计划"));
  dag.appendChild(t);
  const names = {};
  (nodes || []).forEach((n) => (names[n.id] = n.title || n.id));
  const list = el("div", "dag-nodes");
  (nodes || []).forEach((n) => list.appendChild(dagNodeRow(n, names, "pending")));
  dag.appendChild(list);
  box.appendChild(dag);
  scrollBottom();
  return dag;
}

function updatePlanNode(tree, ev) {
  if (!tree || !ev || !ev.id) return;
  const row = tree.querySelector(`[data-id="${CSS.escape(ev.id)}"]`);
  if (!row) return;
  const status = ["pending", "running", "done", "error"].includes(ev.status) ? ev.status : "pending";
  row.dataset.status = status;
  const dot = row.querySelector(".dag-dot");
  if (dot) setDagDot(dot, status);
  const detail = row.querySelector(".dag-detail");
  if (detail) {
    const tip = ev.detail || (ev.args && ev.args.query ? String(ev.args.query) : "");
    if (tip) {
      // 环节结果常常上百字：默认只露一行摘要，但全文必须可达——
      // 悬停看 tooltip，点节点展开全文，否则 DAG 跑出来的东西等于白跑。
      detail.textContent = truncate(tip, 26);
      detail.dataset.full = tip;
      detail.title = tip;
      row.classList.add("has-detail");
    } else {
      detail.textContent = "";
      delete detail.dataset.full;
      detail.removeAttribute("title");
    }
  }
  scrollBottom();
}

function addActionRow(ev) {
  const box = chatBox();
  if (!box) return;
  clearChatHint();
  box.appendChild(actionReceipt(ev));
  scrollBottom();
}

/** 代办文书卡：draft 动作的产出物，正文整段可读完、可复制。 */
function addDocCard(d) {
  const box = chatBox();
  if (!box || !d) return;
  clearChatHint();
  const wrap = el("div", "card doc-card");
  const title = el("div", "card-title");
  title.appendChild(icon("i-doc"));
  title.appendChild(document.createTextNode(d.title || "写好的文稿"));
  wrap.appendChild(title);
  const body = el("div", "doc-body");
  body.textContent = d.body || "";
  wrap.appendChild(body);
  const foot = el("div", "doc-foot");
  const copyBtn = el("button", "btn-approve doc-copy");
  copyBtn.type = "button";
  append(copyBtn, icon("i-clip"), document.createTextNode("复制全文"));
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(d.body || "");
      toast("已复制，拿去用吧");
    } catch {
      toast("复制没成功，手动选中文字复制吧");
    }
  };
  foot.appendChild(copyBtn);
  if (d.created) {
    foot.appendChild(el("span", "doc-time", String(d.created).slice(0, 16).replace("T", " ")));
  }
  wrap.appendChild(foot);
  box.appendChild(wrap);
  scrollBottom();
}

function addCard(card) {
  if (!card) return;
  const box = chatBox();
  if (!box) return;
  clearChatHint();
  const wrap = el("div", "card plan-card");
  const title = el("div", "card-title");
  title.appendChild(icon("i-logo"));
  title.appendChild(document.createTextNode(card.title || "方案"));
  wrap.appendChild(title);

  const due = card.due || card.due_date;
  if (due) {
    const cd = el("div", "countdown");
    cd.appendChild(icon("i-clock"));
    cd.appendChild(document.createTextNode(` ${countdownText(due) || due}`));
    wrap.appendChild(cd);
  } else if (card.countdown) {
    wrap.appendChild(el("div", "countdown", String(card.countdown)));
  }

  (card.sections || []).forEach((s) => {
    const sec = el("div", "sec");
    sec.appendChild(el("div", "sec-h", s.heading || ""));
    const ul = el("ul", "sec-items");
    (s.items || []).forEach((i) => ul.appendChild(el("li", null, i)));
    sec.appendChild(ul);
    wrap.appendChild(sec);
  });

  if (card.closing) wrap.appendChild(el("div", "card-closing", card.closing));

  box.appendChild(wrap);
  scrollBottom();
  s3("setPandaMood", "happy");
}

/* ==========================================================================
 * 8. 发送 + SSE 全事件解析
 * ========================================================================== */

function unlockInput() {
  state.busy = false;
  setPauseVisible(false);
  const btn = $("#send-btn");
  if (btn) btn.disabled = false;
  const input = $("#msg-input");
  if (input) input.placeholder = state.secret ? "悄悄话（家长视角看不到）…" : "跟熊猫管家说说今天…";
}

/** 暂停键与发送键同位置切换：回答进行中显示暂停键，其余时间显示发送键。 */
function setPauseVisible(on) {
  const btn = $("#pause-btn");
  if (btn) btn.classList.toggle("hidden", !on);
  const bar = document.querySelector(".inputbar");
  // data-busy 让 CSS 把发送键收起来（两个键同尺寸同位置，切换不跳动）
  if (bar) bar.dataset.busy = on ? "1" : "0";
}

/** 暂停后给一个「继续」快捷入口：接着没说完的往下说，而不是重开一轮对话。 */
function showResumeChip() {
  const box = $("#chips");
  if (!box || !state.chatResume || !state.chatResume.bubble || !state.chatResume.bubble.isConnected) return;
  if (box.querySelector(".chip-resume")) return;
  const b = el("button", "chip chip-resume", "继续刚才的回答");
  b.type = "button";
  b.title = "接着没说完的往下说";
  b.onclick = () => {
    b.remove();
    send("继续", { resume: true });
  };
  box.insertBefore(b, box.firstChild);
  box.scrollLeft = 0;
}

function clearResumeChip() {
  const b = document.querySelector("#chips .chip-resume");
  if (b) b.remove();
}

/** 断网/弱网提示条：离线时明确告知，恢复后自动收起。 */
function setupOfflineBar() {
  const bar = $("#offline-bar");
  if (!bar) return;
  const sync = () => setHidden("#offline-bar", navigator.onLine !== false);
  window.addEventListener("online", () => { sync(); toast("网络回来了"); });
  window.addEventListener("offline", sync);
  sync();
}

/** 网络类失败给一个「重试」入口，而不是只丢一句报错——点一下就重发刚才那条。 */
function retryableError(msg) {
  const text = state.retryText;
  const files = state.retryFiles || [];
  const row = addMsg("sys", text ? `${msg}（点这里重发）` : msg);
  if (!row || !text) return;
  row.classList.add("retryable");
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  const again = () => {
    if (state.busy) return;
    row.classList.remove("retryable");
    row.removeAttribute("role");
    row.removeAttribute("tabindex");
    send(text, { attach: files }); // 上一轮带的附件一并重发，不能只重发文字
  };
  row.addEventListener("click", again);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); again(); }
  });
}

/** 用户中途叫停：中止这一轮的 SSE 读取，已生成的部分保留，并给一个「继续」入口。 */
function pauseChat() {
  if (!state.busy) return;
  state.chatPaused = true;
  if (state.chatAbort) {
    try { state.chatAbort.abort(); } catch { /* 已结束 */ }
  }
  const ctx = state.chatCtx;
  if (ctx && ctx.aiRaw && ctx.aiBubble && ctx.aiBubble.isConnected) {
    // 原问题跟着存：被打断那一轮没进服务端历史，续写要靠客户端把上下文带回去
    state.chatResume = { raw: ctx.aiRaw, bubble: ctx.aiBubble, question: ctx.question };
  }
  addSys("回答已暂停");
  showResumeChip();
  chatStatus("已暂停");
  toast("已暂停回答");
  // 规划链跑到一半被叫停：事务/清单可能已经落盘，看板刷新一下，别让用户以为什么都没发生
  // 只有服务端真的回过事务事件才这么说——规划还没落盘就被叫停时不能报喜
  if (ctx && ctx.tree) {
    loadAffairs();
    if (ctx.affairTouched) addSys("刚才那件事已经记到事务看板了");
  }
}

/**
 * 发送入口：任何一处没接住的异常都不能把 state.busy 永久锁成 true——
 * 那会让输入框、「新项目/项目/清空」全部卡在"管家还在回复"（曾因 ctx 先用后声明出过这事）。
 */
async function send(preset, opts = {}) {
  const seq0 = state.sendSeq;
  try {
    await sendInner(preset, opts);
  } catch (e) {
    console.error("[send] 未捕获异常：", e);
    // 只收拾本轮自己开的局：已经有更新的一轮在跑就别去动它
    if (state.busy && state.sendSeq === seq0 + 1) {
      state.chatAbort = null;
      state.chatCtx = null;
      document.querySelectorAll("#chat .typing").forEach((n) => n.remove());
      unlockInput();
      chatStatus();
      addSys("这条没发出去，再试一次吧");
    }
  }
}

async function sendInner(preset, opts = {}) {
  const input = $("#msg-input");
  const raw = preset !== undefined ? String(preset) : input ? input.value : "";
  let text = raw.trim();
  // 只发文件不写字也允许：模型看得到图/文档，用户想说的往往就在文件里
  // 重发（preset）时走 opts.attach 找回上一轮带的附件，preset 本身不带暂存区
  const attach = preset === undefined ? (state.attach || []) : (opts.attach || []);
  const pending = (state.attachPending || []).length > 0;
  if (!text && !attach.length) return;
  if (!state.name) return;
  if (pending) {
    toast("附件还在上传，稍等一下再发");
    return;
  }
  if (!text) text = ATTACH_ONLY_TEXT;
  if (state.authRole === "parent") {
    // 家长账号没有聊天能力（服务端 /api/chat 同样 403）。这里必须出声：
    // 静默 return 会让「问问管家」这类入口点了像死机，看不出到底为什么没反应。
    toast("家长账号不能直接和管家聊天，家长视图里可以用传话筒转达");
    return;
  }
  if (state.busy) {
    toast("管家还在回上一条，稍等一下～");
    return;
  }

  const seq = ++state.sendSeq;
  // 发了新消息就立刻闭嘴：晨报/问候那类环境音已经跟当前话题无关了。
  // 不在这里掐的话，得等新回复的语音做好（十几到几十秒）才会切，
  // 那一整段时间都在放已经过时的内容。
  stopVoice();
  state.busy = true;
  state.chatPaused = false;
  clearResumeChip(); // 新一轮开始：上一轮的「继续」入口作废
  const abort = new AbortController();
  state.chatAbort = abort;
  setPauseVisible(true);
  const sendBtn = $("#send-btn");
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.placeholder = "管家正在想…";

  // 暂停后接着往下说：只有「继续」入口显式要求时才续写进同一个气泡。
  // 暂停后孩子直接打了一句新问题，那就是新的一轮，旧的半截回答原样留着。
  const r = state.chatResume;
  const resume = opts.resume && r && r.bubble && r.bubble.isConnected && r.raw && r.question
    ? r : null;
  state.chatResume = null;

  // 续写沿用原问题的悄悄话状态，不看孩子此刻有没有切换开关
  const secret = resume ? resume.question.startsWith("[[secret]]") : state.secret;
  if (input && preset === undefined) input.value = "";
  const payload = secret && !resume ? `[[secret]]${text}` : text;
  // ctx 必须先于用户气泡建好：附件回填（file 事件）要挂回 ctx.userRow
  const ctx = { seq, typing: null, aiBubble: resume ? resume.bubble : null,
                aiRaw: resume ? resume.raw : "", resumeBase: resume ? resume.raw : "",
                question: resume ? resume.question : payload, tree: null, affairTouched: false,
                userRow: null };
  if (!resume) {
    ctx.userRow = addMsg("me", text, secret, secret ? null : attach);
  }
  // 附件已经交给这一轮，清空暂存区（图片预览走 id，不受影响）；
  // 悄悄话轮不消耗附件——服务端也会丢弃，留在暂存区让用户看见没发出去
  if (attach.length && !secret) {
    state.attach = [];
    renderAttachList();
  }
  hideBubble($("#panda-bubble"));
  s3("setPandaMood", "thinking");
  if (pandaSvg) setMood(pandaSvg, "thinking");
  chatStatus("正在想…", true);

  ctx.typing = addTyping();
  state.chatCtx = ctx; // 暂停时要按当前轮次的状态决定「继续」入口与看板刷新
  const dropTyping = () => {
    if (ctx.typing) { ctx.typing.remove(); ctx.typing = null; }
  };

  const fileIds = secret ? [] : attach.map((f) => f.id).filter(Boolean);
  if (secret && attach.length) toast("悄悄话不带附件，文件还留在输入框上方");
  const body = { name: state.name, message: payload, files: fileIds };
  // 续写：把被打断那一轮的原问题与半截回答带回去（服务端据此接着往下说）
  if (resume) body.resume = { question: resume.question, partial: resume.raw };
  try {
    const resp = await api("/api/chat", { ...jsonOpts(body), signal: abort.signal });
    await readSSE(resp, ctx, dropTyping);
  } catch (e) {
    dropTyping();
    if (state.chatPaused || e.name === "AbortError") {
      // 用户主动暂停：保留已生成的内容，不报错、不恢复草稿
    } else {
      // 续写时 aiRaw 一开始就是旧内容：判断"有没有新 token"要和起点比，不能只看是否为空
      const gotNothing = ctx.aiRaw === ctx.resumeBase;
      if (gotNothing && !resume && input && preset === undefined && !input.value) {
        input.value = text; // 一个 token 都没回来：请求根本没生效，恢复草稿免得重打
      }
      if (gotNothing && !resume && preset === undefined && attach.length && !state.attach.length) {
        state.attach = attach; // 附件一并放回暂存区：请求没生效，文件 id 仍然有效
        renderAttachList();
      }
      // 网络层失败（没有 HTTP 状态码）留一份原文，聊天区那条提示点一下就重发
      state.retryText = !e.status && gotNothing && !resume ? text : "";
      state.retryFiles = state.retryText ? attach : [];
      if (resume && gotNothing) {
        // 续写没连上：把「继续」入口还回去，别让那半截回答再也接不上
        state.chatResume = resume;
        state.chatPaused = true;
        showResumeChip();
      }
      // 429 有两种：上一条还没回完 / 额度用完——服务端的话说得更准，直接用
      if (e.status === 429) addMsg("ai", e.message || "管家还在回上一条，稍等 1 秒再说～");
      else if (!e.status) retryableError("没能连上管家");
      else addMsg("ai", `唔……${e.message}`);
      s3("setPandaMood", "worried");
    }
  } finally {
    if (state.chatAbort === abort) state.chatAbort = null;
    if (state.chatCtx === ctx) state.chatCtx = null;
    dropTyping();
    flushMd(ctx);
    if (ctx.aiBubble) ctx.aiBubble.classList.remove("streaming");
    if (seq === state.sendSeq) {
      unlockInput();
      // 这一轮没被暂停：正常结束，上一轮的「继续」入口不再有意义
      if (!state.chatPaused) { state.chatResume = null; clearResumeChip(); }
      s3("setPandaMood", "idle");
      if (pandaSvg) setMood(pandaSvg, "normal");
      modeBadge("");
      if (!state.chatPaused) chatStatus();
      const inp = $("#msg-input");
      if (inp) inp.focus();
      if (state.needGraphRefresh) {
        state.needGraphRefresh = false;
        loadGraph();
      }
    }
  }
}

async function readSSE(resp, ctx, dropTyping) {
  if (!resp.body || !resp.body.getReader) {
    const raw = await resp.text();
    raw.split(/\r?\n/).forEach((line) => {
      if (!line.startsWith("data:")) return;
      try { handleEvent(JSON.parse(line.slice(5)), ctx, dropTyping); } catch { /* 坏行 */ }
    });
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 用户暂停会 abort 掉底层连接，reader.read() 抛 AbortError：静默收尾
      if (state.chatPaused || (e && e.name === "AbortError")) break;
      throw e;
    }
    const { done, value } = chunk;
    if (done) break;
    if (ctx.seq !== state.sendSeq) {
      try { await reader.cancel(); } catch { /* 忽略 */ }
      break; // 已退出登录/换了新会话：中止读取，避免写进旧消息
    }
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx).replace(/\r/g, "");
      buf = buf.slice(idx + 2);
      if (!raw.startsWith("data:")) continue;
      let ev;
      try { ev = JSON.parse(raw.slice(5)); } catch { continue; }
      handleEvent(ev, ctx, dropTyping);
    }
  }
}

// ---------------------------------------------------------------- 管家朗读
// 浏览器不允许没有用户手势的自动播放，所以声音默认是关的：孩子点一下喇叭
// 才打开——这既是浏览器要求，也正好是"我想听管家说话"的明确表态。
const VOICE_KEY = "pandapal.voiceOn";
const voice = { on: false, avail: false, cur: null, src: null, el: null,
                lastP: 0, lastT: 0 };

/** 播放失败的原因分类。别把除 NotAllowedError 以外的一律说成"查音量"——
 *  NotSupportedError 跟音量毫无关系，那是浏览器放不出声音（内嵌面板/无声卡
 *  的环境最常见），说成音量问题只会把人带偏。 */
const VOICE_ERR_TEXT = {
  NotAllowedError: "浏览器拦了自动播放，再点一次喇叭就好",
  NotSupportedError: "这个浏览器放不出声音，换普通浏览器窗口打开就能听",
  AbortError: "播放被中断了",
};

function voiceErrorText(e) {
  const name = (e && e.name) || "";
  return VOICE_ERR_TEXT[name] || ("声音没放出来（" + (name || "未知原因") + "）");
}

/** Web Audio 的 AudioContext：懒创建，整页复用一个。
 *  它和 <audio> 元素是两条独立通路——<audio> 要先起媒体播放器，Web Audio 直接
 *  在音频图上渲染。有些环境（无声卡的内嵌面板、被策略限制的 WebView）媒体播放器
 *  起不来，但 Web Audio 这条还能走。 */
let audioCtx = null;
function getAudioCtx() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    audioCtx = new AC();
  } catch (e) {
    console.warn("[voice] 建不了 AudioContext：", e && e.name, e && e.message);
    return null;
  }
  return audioCtx;
}

/** 0.1 秒静音 WAV：点开开关的那一下顺手播掉，把音频通道"解锁"。
 *  浏览器对无手势的播放会直接 NotAllowedError；先在真实手势里播一次，
 *  后面异步拿到音频再播就能过。播放它听不见任何声音。
 *
 *  这里故意把错误也打出来：这段音频是浏览器自己现造的 PCM，一定能解，
 *  连它都失败，就说明是这台浏览器根本没有音频输出能力（内嵌面板、
 *  无声卡、被静音的系统），跟我们的音频文件、跟电脑音量都无关。 */
function primeAudio() {
  try {
    const sr = 8000, n = 800;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
    const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    const a = new Audio(url);
    a.volume = 0.01;
    a.play().catch((e) => {
      console.warn("[voice] 连浏览器自造的静音音都放不出来：", e && e.name, e && e.message);
    }).finally(() => URL.revokeObjectURL(url));
  } catch (e) {
    console.warn("[voice] 音频解锁失败：", e && e.name, e && e.message);
  }
  // 同一个手势里把 AudioContext 也唤醒，省得后面 decode 完才发现是 suspended
  const ctx = getAudioCtx();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

/** 立刻闭嘴：正在播的掐掉，状态复位。
 *  Web Audio 的 source 不会自己结束，<audio> 元素也不会——不显式停就会一直出声，
 *  而新的语音又叠上来，两句话搅在一起正是"对不上"的由来。 */
function stopVoice() {
  voice.cur = null;
  if (voice.src) {
    try { voice.src.onended = null; voice.src.stop(); } catch { /* 已放完 */ }
    voice.src = null;
  }
  if (voice.el) {
    try { voice.el.onended = null; voice.el.pause(); } catch { /* 已放完 */ }
    voice.el = null;
  }
  $("#voice-btn")?.classList.remove("speaking");
  s3("setPandaMood", "idle");
}

/** 取一段音频并播完（fetch + 鉴权头，同 ICS 导出：裸 <audio src> 带不了 Authorization）。
 *
 *  两条通路，先 Web Audio 再 <audio>：
 *    Web Audio（decodeAudioData）解出来的错误很精确——EncodingError/NotSupportedError
 *    说明是"音频解不开"（格式问题），而能解出 AudioBuffer 却发不出声才是环境问题。
 *    而且它不经过 <audio> 的媒体播放器，在无声卡的内嵌面板里反而更可能活下来。
 *  两条都不通才算真失败，这时才提示用户。
 *
 *  done() 只清理"自己那一份"：被新语音接管时（voice.cur 已经换人）就直接收尾，
 *  别去动新一轮的 speaking 状态和表情——否则旧的一收尾会把新的刚设上的状态抹掉。 */
function playOne(ev) {
  return new Promise((resolve) => {
    let blobUrl = null;
    const btn = $("#voice-btn");
    const done = () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      if (voice.cur !== ev) return resolve();  // 已被新语音接管，别碰共享状态
      voice.cur = null;
      voice.src = null;
      voice.el = null;
      btn?.classList.remove("speaking");
      s3("setPandaMood", "idle");
      resolve();
    };
    (async () => {
      try {
        const resp = await api(`${ev.url}?name=${encodeURIComponent(state.name || "")}`);
        if (!resp.ok) {
          console.warn("[voice] 音频取不到：", resp.status, ev.url);
          toast("这段语音没取到，管家先不出声了");
          return done();
        }
        const ab = await resp.arrayBuffer();
        const mime = resp.headers.get("content-type") || "audio/mpeg";

        // ---- 通路一：Web Audio
        const ctx = getAudioCtx();
        if (ctx) {
          try {
            if (ctx.state === "suspended") await ctx.resume();
            // decodeAudioData 会"转移"掉传入的 ArrayBuffer，所以传副本，
            // 万一这条走不通，下面还能拿原始字节去喂 <audio>
            const buf = await ctx.decodeAudioData(ab.slice(0));
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            voice.src = src;
            btn?.classList.add("speaking");
            s3("setPandaMood", "happy");
            src.onended = () => { voice.src = null; done(); };
            src.start();
            return;
          } catch (e) {
            console.warn("[voice] Web Audio 这条路走不通：", e && e.name, e && e.message);
          }
        }

        // ---- 通路二：<audio> 元素
        const a = new Audio();
        blobUrl = URL.createObjectURL(new Blob([ab], { type: mime }));
        a.src = blobUrl;
        voice.el = a;              // 登记上去，stopVoice 才掐得断
        a.onended = done;
        a.onerror = () => { console.warn("[voice] <audio> 解码失败：", ev.url, mime, ab.byteLength); done(); };
        btn?.classList.add("speaking");
        s3("setPandaMood", "happy");
        await a.play();
      } catch (e) {
        // 两条路都试过了还是不行：现在提示才是有依据的
        console.warn("[voice] 播放失败：", e && e.name, e && e.message);
        toast(voiceErrorText(e));
        done();
      }
    })();
  });
}

/** 收到一段语音：按 (优先级, 轮次) 仲裁，只播"当前最该听"的那一条。
 *
 *  priority  2 = 对话音（聊天、试音）  1 = 环境音（问候、晨报）
 *  turn      服务端在轮次开始时分配的递增序号（不是合成完成时间，否则先开始
 *             的慢问候反而拿到更大的号，"最新优先"会变成"最晚完成优先"）
 *
 *  比较规则先看优先级、再看轮次，于是：
 *    · 孩子发了新消息 → 对话音优先级更高，立刻把还在念的晨报掐掉
 *    · 迟到的环境音   → 优先级低，直接丢，绝不插进当前话题
 *    · 同一类里更新的一轮 → 轮次更大，覆盖上一条
 *  比较结果记在 lastP/lastT 里；每次页面加载都会重新初始化，所以刷新后
 *  晨报依然能正常播（不会因为上一轮聊过天就永久被对话音压住）。 */
function enqueueVoice(ev) {
  if (!voice.on || !ev || !ev.url) return;
  const p = Number(ev.priority) || 1;
  const t = Number(ev.turn) || 0;
  if (p < voice.lastP || (p === voice.lastP && t <= voice.lastT)) return;
  voice.lastP = p;
  voice.lastT = t;
  stopVoice();                 // 旧的立刻停，只留这一条
  voice.cur = ev;
  playOne(ev);
}

/** 问候/晨报走 readTextStream，不经过 handleEvent，语音事件在这里单独接。 */
function onStreamEvent(ev) {
  if (ev && ev.type === "voice") enqueueVoice(ev);
}

function paintVoiceBtn() {
  const b = $("#voice-btn");
  if (!b) return;
  b.classList.toggle("hidden", !voice.avail);
  b.setAttribute("aria-pressed", voice.on ? "true" : "false");
  b.setAttribute("aria-label", voice.on ? "朗读已打开，点一下静音" : "朗读：点一下打开管家的声音");
  b.title = voice.on ? "管家正在说话（点一下静音）" : "打开管家的声音";
  const use = b.querySelector("use");
  if (use) use.setAttribute("href", voice.on ? "#i-sound" : "#i-sound-off");
}

function loadVoicePref() {
  try { voice.on = localStorage.getItem(VOICE_KEY) === "1"; } catch { voice.on = false; }
  paintVoiceBtn();
}

function saveVoicePref() {
  try { localStorage.setItem(VOICE_KEY, voice.on ? "1" : "0"); } catch { /* 私密模式 */ }
}

/** 拉一次服务端音色档案：没配 Key / 关了开关就不显示喇叭。 */
async function fetchVoiceProfile() {
  try {
    const r = await api(`/api/voice?${q(state.name || "")}`);
    const d = await r.json().catch(() => ({}));
    voice.avail = !!d.available;
  } catch {
    voice.avail = false;
  }
  paintVoiceBtn();
}

/** 试音：点开朗读开关时立刻念一句。听到声音才算真的打开；
 *  听不到就说明这个浏览器放不出来，当场给原因，别让人干等下一条消息。 */
async function previewVoice() {
  try {
    const r = await api("/api/voice/preview", jsonOpts({ name: state.name || "" }));
    const d = await r.json().catch(() => ({}));
    if (!d.voice) throw new Error(r.status === 503 ? "服务端没合成出声音" : "试音失败");
    enqueueVoice(d.voice);   // 走同一条路：先闭嘴再播，试音也遵守"最新者优先"
  } catch (e) {
    console.warn("[voice] 试音失败：", e && e.name, e && e.message);
    toast(voiceErrorText(e));
  }
}

function toggleVoice() {
  voice.on = !voice.on;
  saveVoicePref();
  paintVoiceBtn();
  if (!voice.on) {
    stopVoice();
    toast("好，管家先安静一会儿");
  } else {
    primeAudio();  // 趁着这次真实点击把音频通道解锁
    toast("管家的声音打开了，正在试音…");
    previewVoice();
  }
}

function handleEvent(ev, ctx, dropTyping) {
  if (!ev || !ev.type) return;
  if (ctx && ctx.seq !== undefined && ctx.seq !== state.sendSeq) return; // 过期会话的事件丢弃
  switch (ev.type) {
    case "files": {
      // 附件的权威元数据（含抽取结果）：把文件卡挂到本轮用户消息上
      const box = $("#chat");
      if (!ctx.userRow || !box || !box.contains(ctx.userRow)) break;
      const old = ctx.userRow.querySelector(".msg-files");
      if (old) old.remove();
      const row = filesRow(ev.files || []);
      if (row) ctx.userRow.appendChild(row);
      break;
    }

    case "mode":
      dropTyping();
      modeBadge(MODE_LABEL[ev.mode] ?? ev.mode);
      chatStatus(MODE_LABEL[ev.mode] ? `${MODE_LABEL[ev.mode]} · 进行中` : "回复中…", true);
      if (ev.mood) setMoodAll(ev.mood === "normal" ? (ev.mode === "plan" ? "working" : "speaking") : ev.mood);
      else if (ev.mode === "plan") setMoodAll("working");
      break;

    case "mood":
      setMoodAll(ev.mood);
      break;

    case "phase": {
      const txt = PHASE_LABEL[ev.phase];
      if (txt) chatStatus(txt, true);
      break;
    }

    case "recall": {
      dropTyping();
      addRecallChip(ev);
      const edges = (ev.edges || []).map((e) => (Array.isArray(e) ? { source: e[0], target: e[1] } : e));
      s3("highlightRecall", { nodes: ev.nodes || [], edges });
      break;
    }

    case "affair":
      ctx.affairTouched = true;
      onAffairEvent(ev);
      break;

    case "plan":
      dropTyping();
      s3("clearPlanSatellites");
      ctx.tree = addPlanTree(ev.title, ev.nodes || []);
      chatStatus(PHASE_LABEL.executing, true);
      s3("spawnPlanSatellites", (ev.nodes || []).map((n) => ({
        id: n.id, title: n.title, depends_on: n.depends_on || [],
      })));
      break;

    case "node":
      if (!ctx.tree && ev.title) {
        ctx.tree = addPlanTree("执行计划", [{ id: ev.id, title: ev.title, depends_on: [] }]);
      }
      updatePlanNode(ctx.tree, ev);
      s3("setPlanNode", ev.id, ev.status);
      if (ev.status === "running" && ev.title) chatStatus(`正在办：${ev.title}`, true);
      break;

    case "action":
      addActionRow(ev);
      applyActionToDetail(ev);
      if (ev.detail) toast(ev.detail);
      // 代办文书：全文随回执一起到了，直接出文稿卡（"给我一个结果"）
      if (ev.kind === "draft" && ev.ok && ev.payload && ev.payload.body) {
        addDocCard(ev.payload);
      }
      break;

    case "tool":
      dropTyping();
      addToolChip(ev, ctx);
      break;

    case "relay_result": {
      dropTyping();
      const text = ev.message || ev.parent_text || "";
      if (text) addMsg("ai", text);
      if (ev.child_text) addMsg("ai", `给孩子：${ev.child_text}`);
      if (ev.advice) addSys(`建议：${ev.advice}`);
      break;
    }

    case "suggest":
      renderChips(ev.chips || []);
      break;

    case "card":
      dropTyping();
      addCard(ev.card);
      s3("clearPlanSatellites");
      loadAffairs();
      break;

    case "memory":
      dropTyping();
      addMemoryChip(ev);
      mergeGraphLocally(ev);
      s3("spawnMemory", ev);
      state.needGraphRefresh = true;
      break;

    case "token":
      dropTyping();
      if (!ctx.aiBubble) {
        ctx.aiBubble = addMsg("ai", "");
        setMoodAll("speaking");
      }
      if (ctx.aiBubble) {
        // 续写：新 token 追加在原有内容之后，模型接着往下说，不另起一条消息
        ctx.aiRaw = (ctx.aiRaw || "") + (ev.text || "");
        scheduleMd(ctx);
      }
      scrollBottom();
      break;

    // done 之后还可能有 memory / voice 事件：只解锁输入，绝不中断读取
    case "done":
      dropTyping();
      flushMd(ctx);
      if (ctx.aiBubble) ctx.aiBubble.classList.remove("streaming");
      unlockInput();
      s3("setPandaMood", "idle");
      modeBadge("");
      chatStatus();
      break;

    // 语音在正文上屏之后才合成好，到达通常晚于 done：排队播，别打断孩子看字
    case "voice":
      enqueueVoice(ev);
      break;

    // 孩子跟管家说了"换个声音"：管家已自行改好音色，这里提示一声
    case "voice_profile":
      if (ev.profile) {
        voice.avail = true;
        paintVoiceBtn();
        if (ctx.aiBubble) ctx.aiBubble.classList.remove("streaming");
        toast(`声音换好啦～现在是${ev.profile.label || "新的声音"}`);
      }
      break;

    case "error":
      dropTyping();
      flushMd(ctx);
      if (ctx.aiBubble) ctx.aiBubble.classList.remove("streaming");
      addMsg("ai", `唔……${ev.message || "出了点小问题，再试一次吧"}`);
      setMoodAll("worried");
      modeBadge("");
      chatStatus();
      break;

    default:
      console.debug("[app] 未识别的 SSE 事件：", ev.type);
  }
}

function setMoodAll(mood) {
  s3("setPandaMood", MOOD_3D[mood] || "idle");
  if (pandaSvg) setMood(pandaSvg, MOOD_2D[mood] || "normal");
}

function modeBadge(text) {
  const b = $("#mode-badge");
  if (!b) return;
  b.textContent = text || "";
  b.classList.toggle("hidden", !text);
}

/** 对话面板副标题：随 SSE 阶段显示「正在想…/规划链 · 进行中/回复即生成」。 */
function chatStatus(text, live) {
  const sub = $("#chat-sub");
  if (!sub) return;
  sub.textContent = text || "回复即生成";
  sub.classList.toggle("live", !!live);
}

function mergeGraphLocally(ev) {
  const g = state.graph || (state.graph = { nodes: [], edges: [] });
  (ev.added_nodes || []).forEach((n) => {
    if (n && n.id && !g.nodes.some((x) => x.id === n.id)) g.nodes.push(n);
  });
  (ev.added_edges || []).forEach((e) => {
    if (e && !g.edges.some((x) => x.source === e.source && x.target === e.target)) g.edges.push(e);
  });
  renderMiniGraph();
  if (state.fallback2d) {
    renderFallbackGraph();
    drawGraph2D();
  }
}

/* ==========================================================================
 * 9. 3D 初始化
 * ========================================================================== */

async function initSceneSafe() {
  if (state.sceneTried) return;
  state.sceneTried = true;
  const canvas = $("#scene-canvas");
  if (!canvas || typeof scene3d.initScene !== "function") {
    useFallback2D("3D 模块未加载");
    return;
  }
  try {
    const res = await withTimeout(
      Promise.resolve(scene3d.initScene(canvas)).then(() => "ok").catch((e) => {
        console.warn("[app] initScene 失败：", e && e.message);
        return "fail";
      }),
      8000
    );
    if (res !== "ok" || !scene3dUsable()) {
      useFallback2D(res === "__timeout__" ? "3D 初始化超时" : "3D 初始化失败");
      return;
    }
    state.sceneReady = true;
    await s3("setNodeClickHandler", (node) => openNodeDrawer(node));
    await s3("setRole", state.role);
    await s3("setGraphData", state.graph);
    await s3("setTimeline", state.timeline);
    await s3("setPandaMood", "idle");
  } catch (e) {
    console.warn("[app] 3D 初始化异常：", e && e.message);
    useFallback2D("3D 初始化异常");
  }
}

/* ==========================================================================
 * 10. 图谱视图
 * ========================================================================== */

async function loadGraph() {
  const view = state.role === "parent" ? "parent" : "child";
  try {
    const resp = await api(`/api/graph?${q(state.name)}&view=${view}`);
    const data = await resp.json();
    state.graph = { nodes: (data && data.nodes) || [], edges: (data && data.edges) || [] };
    // 事务卡的关联记忆标签依赖图谱节点名；看板可能先于图谱渲染，这里补刷一次
    if (state.affairs && state.affairs.length) renderBoard(state.affairs);
    await s3("setGraphData", state.graph);
    renderMiniGraph();
    if (state.fallback2d) {
      renderFallbackGraph();
      if (!$("#graph-view").classList.contains("hidden")) drawGraph2D();
    }
  } catch (e) {
    const host = $("#graph-canvas-2d");
    if (host && state.fallback2d) host.textContent = `图谱暂时取不到：${e.message}`;
  }
}

function loadGraphView() {
  if (state.sceneReady) {
    setHidden("#graph-canvas", false);
    setHidden("#graph-canvas-2d", true);
    s3("attachTo", $("#graph-canvas"), "graph");
  } else {
    setHidden("#graph-canvas", true);
    setHidden("#graph-canvas-2d", false);
    drawGraph2D();
  }
  renderTimeline();
  renderFilters();
  renderLegendIfEmpty();
}

function drawGraph2D() {
  const host = $("#graph-canvas-2d");
  if (host) draw2D(host, filteredGraph());
}

function filteredGraph() {
  const nodes = (state.graph.nodes || []).filter((n) => {
    if (state.role === "parent" && n.private) return false; // 家长视角私密节点前端再滤一道
    if (state.filters.domain && n.domain !== state.filters.domain) return false;
    if (state.filters.status && n.status !== state.filters.status) return false;
    if (state.timeline && String(n.first_seen || "").slice(0, 7) > state.timeline) return false;
    return true;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (state.graph.edges || []).filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

function renderTimeline() {
  const box = $("#graph-timeline");
  if (!box) return;
  const range = box.querySelector(".tl-range");
  const labels = box.querySelectorAll(".tl-label");
  const months = (state.graph.nodes || [])
    .map((n) => String(n.first_seen || "").slice(0, 7))
    .filter((s) => /^\d{4}-\d{2}$/.test(s))
    .sort();
  if (range) range.disabled = !months.length;
  if (range && months.length) {
    const min = months[0];
    const max = months[months.length - 1];
    if (labels[0]) labels[0].textContent = min.slice(0, 4);
    if (labels[labels.length - 1]) labels[labels.length - 1].textContent = max.slice(0, 4);
    if (!range.dataset.wired) {
      range.dataset.wired = "1";
      range.addEventListener("input", () => {
        const v = Number(range.value);
        state.timeline = v >= 100 ? null : ratioToMonth(min, max, v / 100);
        s3("setTimeline", state.timeline);
        if (state.fallback2d) drawGraph2D();
        renderMiniGraph();
      });
    }
  }
  const play = box.querySelector(".tl-play");
  if (play && !play.dataset.wired) {
    play.dataset.wired = "1";
    play.onclick = () => playTimeline(
      months.length ? months[0] : `${new Date().getFullYear()}-01`,
      months.length ? months[months.length - 1] : `${new Date().getFullYear()}-12`,
      range, play);
  }
}

function monthNum(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  return (y || 0) * 12 + ((m || 1) - 1);
}
function numMonth(n) {
  const v = Math.max(0, Math.round(n));
  return `${Math.floor(v / 12)}-${String((v % 12) + 1).padStart(2, "0")}`;
}
function ratioToMonth(min, max, ratio) {
  const a = monthNum(min);
  const b = monthNum(max);
  return numMonth(a + Math.max(0, Math.min(1, ratio)) * Math.max(0, b - a));
}

function playTimeline(min, max, range, playBtn) {
  if (range && range.dataset.playing === "1") {
    range.dataset.playing = "0";
    if (playBtn) playBtn.classList.remove("playing");
    return;
  }
  if (range) range.dataset.playing = "1";
  if (playBtn) playBtn.classList.add("playing");
  const a = monthNum(min);
  const b = monthNum(max);
  let step = a;
  const tick = () => {
    if (range && range.dataset.playing !== "1") return;
    if (step > b) {
      if (range) { range.value = "100"; range.dataset.playing = "0"; }
      if (playBtn) playBtn.classList.remove("playing");
      state.timeline = null;
    } else {
      state.timeline = numMonth(step);
      if (range) range.value = String(Math.round(((step - a) / Math.max(1, b - a)) * 100));
    }
    s3("setTimeline", state.timeline);
    if (state.fallback2d) drawGraph2D();
    if (step > b) return;
    step += 1;
    setTimeout(tick, 260);
  };
  tick();
}

function renderFilters() {
  const box = $("#graph-filters");
  if (!box) return;
  box.innerHTML = "";
  const mk = (text, group, value, color) => {
    const b = el("button", "filter-chip", text);
    b.type = "button";
    if (color) b.style.setProperty("--dom", color);
    const on = state.filters[group] === value;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
    b.onclick = () => {
      state.filters[group] = on ? "" : value;
      renderFilters();
      s3("setDomainFilter", state.filters.domain, state.filters.status);
      if (state.fallback2d) drawGraph2D();
      renderMiniGraph();
    };
    return b;
  };
  DOMAIN_KEYS.forEach((k) => box.appendChild(mk(DOMAINS[k][0], "domain", k, DOMAIN_COLOR[k])));
  Object.entries(NODE_STATUS).forEach(([k, v]) => box.appendChild(mk(v[0], "status", k)));
}

function renderLegendIfEmpty() {
  const box = $("#graph-legend");
  if (!box || box.querySelector(".lg-private")) return;
  const item = el("span", "lg lg-private");
  item.appendChild(icon("i-lock"));
  item.appendChild(el("span", null, "悄悄话（家长视角隐藏）"));
  item.style.cursor = "pointer";
  item.onclick = () => toast(state.role === "parent"
    ? "家长视角下，孩子的悄悄话节点整体不显示"
    : "带锁标记的是悄悄话，切到家长视角就看不见了");
  box.appendChild(item);
}

/** 节点抽屉：点开节点看事实时间线 */
function openNodeDrawer(node) {
  const drawer = $("#node-drawer");
  const body = drawer && drawer.querySelector(".drawer-body");
  if (!drawer || !body || !node) return;
  const id = node.id || node.node_id;
  const full = (state.graph.nodes || []).find((n) => n.id === id) || node;
  // 家长账号没有 chat 能力（server/auth.py CAPS.parent 不含 chat，服务端 403）。
  // 抽屉里的「问问管家」是给能聊天的人看的，家长要看到的是一句说明，不是一颗点了没反应的按钮。
  const canChat = state.authRole !== "parent";
  const dom = full.domain;
  const domName = DOMAINS[dom] ? DOMAINS[dom][0] : dom || "";
  const domColor = DOMAIN_COLOR[dom] || "";
  const [stName, stCls] = NODE_STATUS[full.status] || [full.status || "", ""];

  const links = (state.graph.edges || [])
    .filter((e) => e.source === id || e.target === id)
    .map((e) => {
      const out = e.source === id;
      const otherId = out ? e.target : e.source;
      return { rel: e.rel || "关联", label: nodeLabel(otherId), otherId, out };
    });

  body.innerHTML =
    `<div class="drawer-head">
       <span class="drawer-label">${escapeHtml(full.label || id || "")}</span>
       ${full.private ? iconHTML("i-lock") : ""}
     </div>
     <div class="drawer-meta">
       ${domName ? `<span class="tag" style="color:${escapeHtml(domColor)}">${escapeHtml(domName)}</span>` : ""}
       ${stName ? `<span class="tag ${stCls}">${escapeHtml(stName)}</span>` : ""}
       <span>首次 ${escapeHtml(String(full.first_seen || "?"))}</span>
       <span>最近 ${escapeHtml(String(full.last_seen || "?"))}</span>
       <span>提到 ${int(full.weight, 1)} 次</span>
     </div>
     <div class="drawer-sub">事实时间线</div>
     ${(full.facts || []).length
       ? `<div class="drawer-facts">${(full.facts || []).map((f) => `
           <div class="drawer-fact">
             <span class="fact-date">${escapeHtml(f.date || "")}</span>
             <span>${escapeHtml(f.text || "")}</span>
           </div>`).join("")}</div>`
       : '<div class="empty-hint">还没有具体记录</div>'}
     <div class="drawer-sub">关联节点</div>
     ${links.length
       ? `<div class="drawer-links">${links.map((l) => `
           <span class="link-node" data-goto="${escapeHtml(l.otherId)}">
             ${l.out ? "" : "← "}${escapeHtml(l.rel)} ${escapeHtml(l.label)}
           </span>`).join("")}</div>`
       : '<div class="empty-hint">还没有关联节点</div>'}
     <div class="inbox-actions">
       ${canChat
      ? `<button class="btn-approve" type="button" data-act="ask">${iconHTML("i-chat")} 问问管家这件事</button>`
      : '<span class="drawer-note">家长账号不能直接和管家聊天，家长视图里可以用传话筒转达</span>'}
       <button class="btn-reject" type="button" data-act="close">${iconHTML("i-x")} 关闭</button>
     </div>`;

  body.querySelectorAll("[data-goto]").forEach((n) => {
    n.style.cursor = "pointer";
    n.onclick = () => openNodeDrawer({ id: n.dataset.goto });
  });
  const close = body.querySelector('[data-act="close"]');
  if (close) close.onclick = () => drawer.classList.add("hidden");
  const ask = body.querySelector('[data-act="ask"]');
  if (ask) {
    ask.onclick = () => {
      drawer.classList.add("hidden");
      go("main");
      send(`关于「${full.label || id}」，你还记得什么`);
    };
  }
  // #node-drawer 挂在图谱视图里（index.html），主视图点星球也会走这里。
  // 不先切视图的话抽屉开在 display:none 的祖先下，点了跟没点一样——与 :443 同一套写法。
  if (state.view !== "graph") go("graph");
  drawer.classList.remove("hidden");
  s3("focusNode", id);
}

/* ==========================================================================
 * 11. 角色切换 + 家长视图
 * ========================================================================== */

function applyRole(role) {
  document.body.dataset.role = role;
  document.body.dataset.view = role;
  s3("setRole", role); // 场景复用时（换号重登）也要同步角色
  const btn = $("#role-toggle");
  if (btn) {
    btn.dataset.role = role;
    btn.setAttribute("aria-pressed", String(role === "parent"));
    const span = btn.querySelector("span");
    if (span) span.textContent = role === "parent" ? "家长视角" : "孩子视角";
  }
  // 悄悄话只对孩子有意义
  const secretBtn = $("#secret-btn");
  if (secretBtn) {
    secretBtn.disabled = role === "parent";
    if (role === "parent" && state.secret) toggleSecret();
  }
}

async function toggleRole() {
  if (state.authRole !== "admin") return; // 视角切换是评委演示特权；普通账号的角色由登录决定
  const role = state.role === "child" ? "parent" : "child";
  state.role = role;
  applyRole(role);
  saveAuth(); // 记住评委选择的视角，刷新后保持
  await s3("setRole", role);
  await loadGraph(); // 家长视角后端剔除 private 节点及其边

  if (role === "parent") {
    go("parent");
  } else {
    go("main");
    setHidden("#secret-note", true);
  }
}

async function loadParentInbox() {
  const box = $("#parent-inbox");
  const note = $("#secret-note");
  try {
    const resp = await api(`/api/parent/inbox?${q(state.name)}`);
    const data = await resp.json();
    const n = int(data && data.secret_count, 0);
    if (note) {
      note.innerHTML = "";
      if (n) {
        note.appendChild(icon("i-lock"));
        note.appendChild(document.createTextNode(`孩子有 ${n} 条悄悄话，管家替他保密（内容不在这里显示）`));
      }
      note.classList.toggle("hidden", !n);
    }
    renderInbox(box, (data && data.items) || []);
  } catch (e) {
    if (box) box.innerHTML = `<p class="empty-hint">收件箱暂时取不到：${escapeHtml(e.message)}</p>`;
  }
}

function renderInbox(box, items) {
  if (!box) return;
  box.innerHTML = "";
  const live = items.filter((i) => i && i.status === "pending");
  const past = items.filter((i) => i && i.status !== "pending");
  if (!live.length && !past.length) {
    box.appendChild(el("p", "empty-hint", "没有待确认的事。"));
    return;
  }
  live.forEach((it) => box.appendChild(inboxCard(it, true)));
  if (past.length) {
    box.appendChild(el("p", "empty-hint", `已处理 ${past.length} 件`));
    past.forEach((it) => box.appendChild(inboxCard(it, false)));
  }
}

function inboxCard(item, actionable) {
  const status = item.status || "pending";
  const card = el("article", "inbox-card");
  card.dataset.status = status;
  card.innerHTML =
    `<div class="inbox-head">
       <span class="inbox-title">${escapeHtml(item.title || item.id || "")}</span>
       <span class="inbox-status">${escapeHtml(String(item.created || item.ts || "").slice(5, 16).replace("T", " "))}</span>
     </div>
     <div class="inbox-detail">${escapeHtml(item.detail || "")}</div>`;
  const reply = item.reply;
  if (reply) card.appendChild(el("div", "inbox-reply", `家长回复：${reply}`));

  if (actionable) {
    const row = el("div", "inbox-actions");
    const approve = el("button", "btn-approve");
    approve.type = "button";
    append(approve, icon("i-check"), document.createTextNode("已办好了"));
    approve.onclick = () => decideInbox(item.id, "approve", approve);
    const reject = el("button", "btn-reject");
    reject.type = "button";
    append(reject, icon("i-x"), document.createTextNode("先不用"));
    reject.onclick = () => decideInbox(item.id, "reject", reject);
    append(row, approve, reject);
    card.appendChild(row);
  }
  return card;
}

async function decideInbox(iid, action, btn, reply) {
  if (!iid) return;
  if (btn) btn.disabled = true;
  try {
    const body = { name: state.name, action };
    if (reply) body.reply = reply;
    await api(`/api/parent/inbox/${encodeURIComponent(iid)}`, jsonOpts(body));
    await loadParentInbox();
    await loadAffairs();
    s3("setPandaMood", "happy");
  } catch (e) {
    addSys(`确认没提交上：${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 传话筒：方向由 segmented control 决定 */
async function runRelay() {
  const input = $("#relay-input");
  const text = input ? String(input.value || "").trim() : "";
  const btn = $("#relay-btn");
  if (!text) {
    toast("先把要转达的话写进来～");
    return;
  }
  if (btn) btn.disabled = true;
  try {
    if (state.relayDir === "notice") {
      await runNotice(text);
      if (input) input.value = "";
      return;
    }
    const resp = await api("/api/relay", jsonOpts({ name: state.name, direction: state.relayDir, text }));
    renderRelay(await resp.json());
    if (input) input.value = "";
  } catch (e) {
    setRelayCol("#relay-t2p", `传话筒暂时用不了：${e.message}`);
    setRelayCol("#relay-c2t", "");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderRelay(data) {
  if (!data) return;
  const dir = data.direction || state.relayDir;
  const parentText = data.parent_text || data.for_parent || "";
  const childText = data.child_text || data.for_child || "";
  if (dir === "child2teacher") {
    // 孩子的话 → 得体版本发给老师；建议单独一栏
    setRelayCol("#relay-t2p", data.message || parentText || "");
    setRelayCol("#relay-c2t", childText || "", data.advice);
    return;
  }
  setRelayCol("#relay-t2p", parentText || data.message || "");
  setRelayCol("#relay-c2t", childText, data.advice);
}

function setRelayCol(sel, text, advice) {
  const col = $(sel);
  if (!col) return;
  const body = col.querySelector(".relay-body") || col;
  body.textContent = text || "";
  col.classList.toggle("is-empty", !text);
  const old = col.querySelector(".relay-advice");
  if (old) old.remove();
  if (advice) {
    const adv = el("div", "relay-advice");
    adv.appendChild(icon("i-spark"));
    adv.appendChild(document.createTextNode(` ${advice}`));
    col.appendChild(adv);
  }
}

const RELAY_HEADS = {
  teacher2parent: ["给家长", "给孩子"],
  child2teacher: ["给老师", "备注建议"],
  notice: ["给家长 · 专属版", "给孩子 · 已落成待办"],
};
const RELAY_PLACEHOLDERS = {
  teacher2parent: "把老师的话粘进来，管家翻成家长能听懂的话…",
  child2teacher: "把孩子的原话写进来，管家整理成得体的话发给老师…",
  notice: "把学校/机构的通知原文粘进来，管家结合孩子的情况出专属版，并建好事务、清单和提醒…",
};

/** 通知落地：专属版文案 + 事务/清单/提醒真落盘，结果分两栏展示 */
async function runNotice(text) {
  const resp = await api("/api/notice", jsonOpts({ name: state.name, text }));
  const data = await resp.json();
  const res = (data && data.results && data.results[0]) || {};
  const personal = (res.personal || []).map((p) => `· ${p}`).join("\n");
  setRelayCol("#relay-t2p", [res.parent_text, personal && `只针对${state.name}：\n${personal}`]
    .filter(Boolean).join("\n\n"));
  const aff = res.affair || {};
  const done = (res.actions || []).filter((a) => a.ok).map((a) => a.detail).join("；");
  setRelayCol("#relay-c2t", res.child_text || "",
    `${res.created ? "已新建" : "已更新"}事务「${aff.title || ""}」${done ? `：${done}` : ""}`);
  toast(res.created ? `管家接下了「${aff.title || "这件事"}」` : `「${aff.title || "这件事"}」已更新`);
  loadAffairs();
}

function setRelayDir(dir) {
  state.relayDir = RELAY_HEADS[dir] ? dir : "teacher2parent";
  document.querySelectorAll("#parent-view .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.direction === state.relayDir);
  });
  const heads = RELAY_HEADS[state.relayDir];
  const c1 = $("#relay-t2p .relay-head");
  const c2 = $("#relay-c2t .relay-head");
  if (c1) c1.textContent = heads[0];
  if (c2) c2.textContent = heads[1];
  const input = $("#relay-input");
  if (input) input.placeholder = RELAY_PLACEHOLDERS[state.relayDir];
  const btn = $("#relay-btn");
  if (btn) btn.textContent = state.relayDir === "notice" ? "交给管家落地" : "翻译转达";
}

/* 家长周报：按需生成（一次 LLM 调用），不随进入页面自动跑 */
async function loadWeekly() {
  const box = $("#weekly-out");
  const btn = $("#weekly-btn");
  if (!box) return;
  if (btn) btn.disabled = true;
  box.classList.remove("hidden");
  box.innerHTML = '<p class="empty-hint">管家正在翻这一周的记录…</p>';
  try {
    const resp = await api(`/api/parent/weekly?${q(state.name)}`);
    renderWeekly(box, await resp.json());
    if (btn) btn.textContent = "重新生成";
  } catch (e) {
    box.innerHTML = `<p class="empty-hint">周报暂时生成不了：${escapeHtml(e.message)}</p>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderWeekly(box, data) {
  const r = (data && data.report) || {};
  const s = (data && data.stats) || {};
  const list = (title, items, cls) => (items && items.length
    ? `<div class="weekly-sec ${cls}"><div class="weekly-sec-head">${title}</div><ul>${
      items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>` : "");
  const stat = (n, label) => `<span class="weekly-stat"><b>${int(n, 0)}</b>${label}</span>`;
  box.innerHTML =
    `<p class="weekly-headline">${escapeHtml(r.headline || "")}</p>
     <div class="weekly-stats">${stat(s.affairs_open, "件在办")}${stat(s.moved, "件推进")}${
       stat(s.closed, "件办完")}${stat(s.new_memories, "条新变化")}${stat(s.inbox_pending, "件待你确认")}</div>
     <div class="weekly-grid">${list("这周的进展", r.highlights, "")}${list("接下来留意", r.watch, "is-watch")}</div>
     ${r.suggestion ? `<div class="relay-advice">周末可以做：${escapeHtml(r.suggestion)}</div>` : ""}
     ${r.praise ? `<p class="weekly-praise">可以当面夸 TA：“${escapeHtml(r.praise)}”</p>` : ""}
     <p class="weekly-foot">${escapeHtml(data.since || "")} ~ ${escapeHtml(data.until || "")}${
       s.secret_count ? ` · 另有 ${int(s.secret_count, 0)} 条悄悄话，管家替 TA 保密，未计入` : ""}${
       r.llm === false ? " · 管家的大脑暂时连不上，以上是统计数据" : ""}</p>`;
}

/* 童年备忘录：整份档案打包下载（fetch + Blob，token 不进 URL） */
async function exportMemoir() {
  const btn = $("#export-btn");
  if (btn) btn.disabled = true;
  try {
    const resp = await api(`/api/export?${q(state.name)}`);
    const url = URL.createObjectURL(await resp.blob());
    const a = el("a");
    a.href = url;
    a.download = `童年备忘录-${state.name}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("档案已打包下载：数据即文件，它属于你自己");
  } catch (e) {
    toast(`导出失败：${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ==========================================================================
 * 12. 成长视图 + 梦想
 * ========================================================================== */

async function loadGrowth() {
  const radar = $("#growth-radar");
  if (radar) radar.innerHTML = '<p class="empty-hint">正在汇总成长证据…</p>';
  try {
    const view = state.role === "parent" ? "parent" : "child";
    const resp = await api(`/api/growth?${q(state.name)}&view=${view}`);
    renderGrowth(await resp.json());
  } catch (e) {
    renderGrowthFallback(e.status === 404 ? "该功能开发中" : `成长雷达暂时取不到：${e.message}`);
  }
}

function normalizeGrowth(data) {
  const raw = data && (data.dimensions || data.dims || data.radar);
  if (!raw) return { dims: [], comment: "", totals: null };
  let dims;
  if (Array.isArray(raw)) {
    dims = raw.map((d) => ({
      name: d.name || d.domain || "",
      domain: d.domain || "",
      value: Number(d.score !== undefined ? d.score : d.value) || 0,
      evidence: d.evidence || [],
      nodes: d.nodes || 0,
    }));
  } else {
    dims = Object.entries(raw).map(([k, v]) => ({
      name: (DOMAINS[k] && DOMAINS[k][0]) || k,
      domain: k,
      value: Number(v && v.score !== undefined ? v.score : v) || 0,
      evidence: (v && v.evidence) || [],
      nodes: 0,
    }));
  }
  return { dims, comment: data.comment || "", totals: data.totals || null };
}

function renderGrowth(data) {
  const { dims, comment } = normalizeGrowth(data);
  if (!dims.length) {
    renderGrowthFallback("还没有足够的记忆数据来画雷达图，先跟管家聊几天吧。");
    return;
  }
  drawRadar(dims);

  const commentEl = $("#growth-comment");
  if (commentEl) {
    commentEl.textContent = comment || "";
    commentEl.classList.toggle("hidden", !comment);
  }

  const box = $("#growth-evidence");
  if (!box) return;
  box.innerHTML = "";
  let any = false;
  dims.forEach((d) => {
    if (!(d.evidence || []).length) return;
    any = true;
    const card = el("div", "evidence-item");
    if (d.domain) card.dataset.domain = d.domain;
    card.appendChild(el("div", "ev-date", `${d.name || "维度"} · ${Math.round(d.value)}`));
    d.evidence.forEach((ev) => {
      const row = el("div", "ev-row");
      row.appendChild(el("span", "ev-date-sm", String(ev.date || "").slice(5)));
      row.appendChild(document.createTextNode(ev.text || ev.label || ""));
      if (ev && ev.node_id) {
        row.classList.add("clickable");
        row.onclick = () => { go("graph"); openNodeDrawer({ id: ev.node_id, label: ev.node || ev.label || ev.text }); };
      }
      card.appendChild(row);
    });
    box.appendChild(card);
  });
  if (!any) box.appendChild(el("p", "empty-hint", "还没有可回放的证据。"));
}

function renderGrowthFallback(reason) {
  const radar = $("#growth-radar");
  if (radar) {
    radar.innerHTML = "";
    radar.appendChild(el("p", "empty-hint", reason));
  }
  const evi = $("#growth-evidence");
  if (evi) evi.innerHTML = `<p class="empty-hint">${escapeHtml(reason)}</p>`;
  const commentEl = $("#growth-comment");
  if (commentEl) commentEl.classList.add("hidden");
}

/** 五轴雷达（原生 SVG） */
function drawRadar(dims) {
  const box = $("#growth-radar");
  if (!box) return;
  const size = 280;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const R = 96;
  const n = dims.length;
  const pt = (i, ratio) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + Math.cos(ang) * R * ratio, cy + Math.sin(ang) * R * ratio];
  };
  const norm = (v) => Math.max(0, Math.min(1, (Number(v) || 0) / 100));
  const rings = [0.25, 0.5, 0.75, 1].map((r) =>
    `<polygon points="${dims.map((_, i) => pt(i, r).map((x) => x.toFixed(1)).join(",")).join(" ")}"
       fill="none" stroke="var(--line-strong)" stroke-width="1"/>`).join("");
  const axes = dims.map((_, i) => {
    const [x, y] = pt(i, 1);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line-strong)"/>`;
  }).join("");
  const poly = dims.map((d, i) => pt(i, norm(d.value)).map((x) => x.toFixed(1)).join(",")).join(" ");
  const dots = dims.map((d, i) => {
    const [x, y] = pt(i, norm(d.value));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="var(--bamboo)"/>`;
  }).join("");
  const labels = dims.map((d, i) => {
    const [x, y] = pt(i, 1.26);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="currentColor" font-size="12.5" font-weight="600"
              text-anchor="middle" dominant-baseline="middle" data-idx="${i}">${escapeHtml(d.name)}</text>`;
  }).join("");
  const scores = dims.map((d, i) => {
    const [x, y] = pt(i, 1.26);
    return `<text x="${x.toFixed(1)}" y="${(y + 15).toFixed(1)}" fill="var(--ink-dim)" font-size="10"
              text-anchor="middle" dominant-baseline="middle" font-family="var(--font-num)">${int(d.value)}</text>`;
  }).join("");
  box.innerHTML =
    `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="五领域成长雷达"
          style="width:100%;height:100%;display:block;color:var(--ink-2);max-width:340px;margin:auto">
       ${rings}${axes}
       <polygon points="${poly}" fill="rgba(95,211,155,.28)" stroke="var(--bamboo)" stroke-width="2" stroke-linejoin="round"/>
       ${dots}${labels}${scores}
     </svg>`;
  box.querySelectorAll("text[data-idx]").forEach((t) => {
    t.style.cursor = "pointer";
    t.onclick = () => {
      const d = dims[int(t.dataset.idx)];
      const key = DOMAIN_KEYS.find((k) => DOMAINS[k][0] === d.name) || d.domain || d.name;
      state.filters.domain = key;
      state.filters.status = "";
      go("graph");
      renderFilters();
      s3("setDomainFilter", state.filters.domain, "");
      if (state.fallback2d) drawGraph2D();
    };
  });
}

/** 梦想：先看邀请语，孩子说完再正式回答并落记忆 */
async function runDream() {
  const btn = $("#dream-btn");
  if (btn) btn.disabled = true;
  let out = $("#dream-out");
  if (!out) {
    out = el("div", "panel dream-out hidden");
    out.id = "dream-out";
    $(".growth-grid").appendChild(out);
  }
  out.classList.remove("hidden");
  out.textContent = "管家正在翻你的记忆…";
  try {
    const resp = await api("/api/dream", jsonOpts({ name: state.name }));
    const data = await resp.json();
    out.textContent = data.text || "跟我说说你的梦想吧。";
    if (data.llm === false) out.appendChild(degradedNote());
    // 追加输入行：孩子把梦想说出来 → 再发一次带 text 的请求
    const row = el("div", "inbox-actions");
    const input = el("input", "text-input");
    input.type = "text";
    input.placeholder = "我的梦想是…";
    input.maxLength = 200;
    input.style.flex = "1";
    const goBtn = el("button", "btn-approve");
    goBtn.type = "button";
    goBtn.appendChild(icon("i-send"));
    goBtn.appendChild(document.createTextNode("告诉管家"));
    const submit = () => {
      const t = String(input.value || "").trim();
      if (t) submitDream(t, out, input, goBtn);
    };
    goBtn.onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
    });
    out.appendChild(row);
    row.appendChild(input);
    row.appendChild(goBtn);
    input.focus();
  } catch (e) {
    out.textContent = `梦想频道暂时打不开：${e.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function submitDream(text, out, input, btn) {
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;
  try {
    const resp = await api("/api/dream", jsonOpts({ name: state.name, text }));
    const data = await resp.json();
    out.textContent = data.text || "记下了。";
    if (data.memory) {
      addMemoryChip(data.memory);
      mergeGraphLocally(data.memory);
      s3("spawnMemory", data.memory);
      await loadGraph();
    }
    toast("梦想已经记进记忆星球了");
  } catch (e) {
    out.textContent = `这次没说成：${e.message}`;
  } finally {
    if (btn) btn.disabled = false;
    if (input) input.disabled = false;
  }
}

/* ==========================================================================
 * 13. 调用记录 / 记忆本
 * ========================================================================== */

async function loadLogs() {
  const box = $("#llm-logs");
  if (!box) return;
  const head = box.querySelector(".logs-head");
  box.innerHTML = "";
  if (head) box.appendChild(head);
  try {
    const resp = await api("/api/logs?limit=60");
    const data = await resp.json();
    const calls = ((data && data.calls) || []).slice().reverse();
    if (!calls.length) {
      box.appendChild(el("p", "empty-hint", "还没有 API 调用记录"));
      return;
    }
    calls.forEach((c) => {
      const row = el("div", "log-row");
      const ok = c.ok;
      row.innerHTML =
        `<span class="ts">${escapeHtml(String(c.ts || "").slice(5))}</span>
         <span class="caller">${escapeHtml(c.caller || "")}</span>
         <span>${escapeHtml(c.model || "")}${c.protocol ? `<span class="ts"> ·${escapeHtml(c.protocol)}</span>` : ""}</span>
         <span>${c.ms !== undefined ? `${escapeHtml(c.ms)}ms` : "—"}</span>
         <span>${ok
           ? `<span class="ok">成功</span>${c.tokens !== undefined ? ` <span class="ts">${escapeHtml(c.tokens)} tok</span>` : ""}`
           : `<span class="bad">失败</span> <span class="err">${escapeHtml(c.err || "")}</span>`}</span>`;
      box.appendChild(row);
    });
  } catch (e) {
    box.appendChild(el("p", "empty-hint", `调用记录暂时不可用：${e.message}`));
  }
}

async function loadMemory() {
  setHidden("#export-btn", state.authRole === "parent"); // 档案里有悄悄话，只交还给孩子本人
  const md = $("#memory-md");
  const topicsBox = $("#memory-topics");
  const dailyBox = $("#memory-daily");
  if (md) md.textContent = "加载中…";
  try {
    const resp = await api(`/api/memory?${q(state.name)}`);
    const data = await resp.json();
    if (md) md.textContent = data.memory_md || "（还没有长期记忆）";
    if (topicsBox) {
      topicsBox.innerHTML = "";
      const topics = data.topics || [];
      if (!topics.length) topicsBox.appendChild(el("p", "empty-hint", "还没有主题记忆。"));
      topics.forEach((t) => {
        const [label, cls] = NODE_STATUS[t.status] || [t.status || "", ""];
        const card = el("div", "topic-card");
        card.innerHTML =
          `<div class="topic-head">
             <span class="topic-name">${escapeHtml(t.name || "")}</span>
             <span class="status-tag ${escapeHtml(cls)}">${escapeHtml(label)}</span>
             <span class="topic-rel">${escapeHtml((t.related || []).join(" · "))}</span>
           </div>
           <div class="topic-body">${escapeHtml(t.body || "")}</div>`;
        topicsBox.appendChild(card);
      });
    }
    if (dailyBox) {
      dailyBox.innerHTML = "";
      const daily = data.daily || [];
      if (!daily.length) dailyBox.appendChild(el("p", "empty-hint", "还没有沉淀记录。"));
      daily.forEach((d) => {
        const item = el("div", "daily-item");
        item.innerHTML = `<div class="daily-date">${escapeHtml(d.date || "")}</div>
          <div class="daily-content">${escapeHtml(d.content || "")}</div>`;
        dailyBox.appendChild(item);
      });
    }
  } catch (e) {
    if (md) md.textContent = `记忆本暂时取不到：${e.message}`;
  }
}

/* ==========================================================================
 * 14. 快捷 chips / 语音 / 悄悄话
 * ========================================================================== */

let chipsReqSeq = 0;

/** 快捷话题：开场由服务端按孩子当下的事务/截止/兴趣/时段生成（见 /api/suggest），每轮对话后换成 SSE suggest 下发的"下一步"。 */
const CHIP_FALLBACK = ["帮我排一下今天要做的事", "跟你说说我今天的心情", "你能帮我做什么？"];

async function renderChips(chips) {
  const box = $("#chips");
  if (!box) return;
  let list = chips;
  if (list) chipsReqSeq++; // 新一轮的 suggest 先到：作废还在路上的开场请求
  if (!list) {
    const seq = ++chipsReqSeq; // 换号/退出期间在途的旧响应直接丢弃
    try {
      const resp = await api(`/api/suggest?${q(state.name)}`);
      if (seq !== chipsReqSeq) return;
      list = ((await resp.json()) || {}).chips;
    } catch { if (seq !== chipsReqSeq) return; list = null; }
  }
  if (!Array.isArray(list) || !list.length) list = CHIP_FALLBACK.map((text) => ({ text, kind: "fallback" }));
  if (!box.dataset.wheel) {
    box.dataset.wheel = "1"; // 桌面鼠标滚轮 → 横向滑动
    box.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { box.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
  }
  box.innerHTML = "";
  list.forEach((c) => {
    const text = typeof c === "string" ? c : c && c.text;
    if (!text) return;
    const b = el("button", `chip chip-${(c && c.kind) || "x"}`, text);
    b.type = "button";
    b.title = text;
    b.onclick = () => send(text);
    box.appendChild(b);
  });
  box.scrollLeft = 0;
}

/* ---- 语音输入：浏览器只负责录音，识别在服务端（小米 MiMo ASR） ----
 *
 * 为什么不再是 window.webkitSpeechRecognition：那条路在 Chrome/Edge 上是把音频
 * 送到 Google 的语音服务，国内直连不通，一按就 network / service-not-allowed；
 * Firefox / Safari 干脆没这个接口，旧代码会把按钮整个删掉——评委看到的就是
 * "点了没反应"或者"根本没这个功能"。改成 MediaRecorder 录音 + POST /api/asr 之后，
 * 能不能用只取决于"服务端配没配 Key"，跟浏览器和网络环境都无关。
 */

/** 录音上行链路是否具备（安全上下文 + getUserMedia + MediaRecorder），不具备时给出人话原因。 */
function micCapability() {
  const Rec = window.MediaRecorder || window.webkitMediaRecorder;
  if (!window.isSecureContext) {
    return { ok: false, why: "麦克风只在 https 或 localhost 下才能用：请用 https 打开这个页面" };
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { ok: false, why: "这个浏览器不给网页用麦克风，换 Chrome / Edge 试试" };
  }
  if (!Rec) return { ok: false, why: "这个浏览器不支持网页录音，换 Chrome / Edge 试试" };
  return { ok: true, why: "" };
}

/** 录制容器：优先 opus/webm，其次 mp4/aac（Safari）。拿到什么容器都行——
 *  上传前统一解成 16k 单声道 wav，上游只认 wav/mp3。 */
function pickMicMime() {
  const Rec = window.MediaRecorder || window.webkitMediaRecorder;
  if (!Rec || !Rec.isTypeSupported) return "";
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus",
                 "audio/mp4", "audio/mpeg"];
  return cands.find((m) => Rec.isTypeSupported(m)) || "";
}

/** 解出 PCM。decodeAudioData 要一个 AudioContext，复用播放语音的那个。 */
async function decodeAudioBlob(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = getAudioCtx() || (AC ? new AC() : null);
  if (!ctx || !ctx.decodeAudioData) throw new Error("这个浏览器解不了录音");
  return ctx.decodeAudioData(await blob.arrayBuffer());
}

/** 重采样到 16k 单声道。优先 OfflineAudioContext：它自带带限重采样（48k→16k
 *  直接抽取会混叠，糊掉辅音，识别率掉得比想象中多），顺手把多声道混成单声道。
 *  老浏览器没有这个接口时退回"取平均 + 线性插值"：精度差一点，但不会因此用不了。 */
async function resampleToMono(buf, rate) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (OAC) {
    try {
      const off = new OAC(1, Math.max(1, Math.ceil(buf.duration * rate)), rate);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start();
      return (await off.startRendering()).getChannelData(0);
    } catch (e) {
      console.warn("[mic] OfflineAudioContext 重采样失败，退回线性插值：", e && e.message);
    }
  }
  let mono = buf.getChannelData(0);
  if (buf.numberOfChannels > 1) {
    mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
  }
  const ratio = buf.sampleRate / rate;
  const n = Math.max(1, Math.floor(mono.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = mono[Math.floor(i * ratio)] || 0;
  return out;
}

/** Float32 单声道 → 16bit PCM 的 WAV 字节。 */
function encodeWav(pcm, rate) {
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] || 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/** Blob（webm/mp4/ogg 都行）→ 16kHz 单声道 16bit WAV。
 *  自己转的原因：上游只收 wav/mp3，而 MediaRecorder 不产出这两种；让服务端依赖
 *  ffmpeg 不是我们想背的运维负担，而在浏览器里解码 + 重采样几毫秒就做完了，
 *  顺手把上行体积压到 32KB/s（60 秒约 1.9MB）。 */
async function blobToWav(blob) {
  const rate = 16000;
  const buf = await decodeAudioBlob(blob);
  return encodeWav(await resampleToMono(buf, rate), rate);
}

const MIC_ERR_TEXT = {
  NotAllowedError: "麦克风权限没给：点地址栏左边的锁，允许麦克风再试一次",
  PermissionDeniedError: "麦克风权限没给：点地址栏左边的锁，允许麦克风再试一次",
  NotFoundError: "没找到麦克风，插一个或者换台设备试试",
  DevicesNotFoundError: "没找到麦克风，插一个或者换台设备试试",
  NotReadableError: "麦克风被别的程序占着（会议 / 录音软件），关掉再试",
  TrackStartError: "麦克风被别的程序占着（会议 / 录音软件），关掉再试",
  SecurityError: "浏览器拦了麦克风：请用 https 或 localhost 打开这个页面",
  AbortError: "录音被打断了，再试一次",
};

function micErrorText(e) {
  const name = (e && e.name) || "";
  if (MIC_ERR_TEXT[name]) return MIC_ERR_TEXT[name];
  const msg = (e && e.message) || "";
  if (name === "NotSupportedError" || /decode|解不了/.test(msg)) {
    return "这个浏览器解不了录音，换 Chrome / Edge 试试";
  }
  return msg || "语音识别没成功，再试一次";
}

/** 松开麦克风：停轨道 + 停定时器。用完必调，否则标签页上的录音标一直亮。 */
function micRelease() {
  if (micTimer) { clearTimeout(micTimer); micTimer = null; }
  if (micStream) {
    try { micStream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
    micStream = null;
  }
}

function micPaint(recording) {
  const btn = $("#mic-btn");
  if (!btn) return;
  btn.classList.toggle("recording", !!recording);
  btn.setAttribute("aria-pressed", recording ? "true" : "false");
}

/** 结束这一段录音（到点自动停和手动停都走这里）。abort=true 表示这段不要了。 */
function micStop(abort) {
  if (abort) micAbort = true;
  const rec = micRec;
  if (rec && rec.state === "recording") {
    try {
      micPending = true;
      rec.stop();   // 数据在 onstop 里交出来，真正的上传在那边发起
    } catch {
      // stop() 失败（浏览器已经替你停了）：别把"待收尾"永远挂住，
      // 否则 micStart 会一直以为上一段还没结束，语音键就此点不动了
      micPending = false;
    }
  }
  micRelease();
  micPaint(false);
}

/** 退出登录 / 切账号：丢掉正在录的这段，不上传、不再回调。 */
function micCancel() {
  micAbort = true;
  micStop(true);
}

/** 识别结果写进输入框：**接着**已有内容写，不再清掉孩子已经打的字（旧实现会整段覆盖）。 */
function micFill(text) {
  const input = $("#msg-input");
  if (!input) return;
  const cur = input.value.trim();
  input.value = cur ? `${cur}${/[，。！？,.!?]$/.test(cur) ? "" : " "}${text}` : text;
  input.focus();
  toast("听清了，确认一下再发送", 2200);
}

async function micUpload(chunks, mime) {
  if (!chunks || !chunks.length) { toast("没录到声音，凑近一点再说一遍"); return; }
  let raw;
  try {
    raw = new Blob(chunks, mime ? { type: mime } : {});
  } catch { raw = new Blob(chunks); }
  if (raw.size < 1200) { toast("这段太短啦，说完再点一下语音键"); return; }
  micBusy = true;
  const btn = $("#mic-btn");
  if (btn) btn.classList.add("mic-wait");
  try {
    // 少数浏览器（Safari）本来就录出 mp3：直接上行，省一次解码
    const wav = /audio\/mpeg/.test(raw.type) ? raw : await blobToWav(raw);
    const fd = new FormData();
    fd.append("file", wav, /audio\/mpeg/.test(wav.type) ? "voice.mp3" : "voice.wav");
    const r = await api(`/api/asr?${q(state.name || "")}`, { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    const text = String((d && d.text) || "").trim();
    if (!text) { toast("没听清，再说一遍试试"); return; }
    micFill(text);
  } catch (e) {
    console.warn("[mic] 识别失败：", e && e.name, e && e.message);
    toast(micErrorText(e));
  } finally {
    micBusy = false;
    if (btn) btn.classList.remove("mic-wait");
  }
}

async function micStart() {
  const cap = micCapability();
  if (!cap.ok) { toast(cap.why); return; }
  if (!micAvail) { toast("语音识别还没开通：先打字跟我说吧"); return; }
  if (micPending || micBusy) { toast("稍等一下，上一句还在处理"); return; }
  micAbort = false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    console.warn("[mic] 拿不到麦克风：", e && e.name, e && e.message);
    toast(micErrorText(e));
    return;
  }
  micStream = stream;
  const Rec = window.MediaRecorder || window.webkitMediaRecorder;
  const mime = pickMicMime();
  try {
    micRec = mime ? new Rec(stream, { mimeType: mime }) : new Rec(stream);
  } catch (e) {
    console.warn("[mic] 建 MediaRecorder 失败：", e && e.name, e && e.message);
    micRelease();
    toast("这个浏览器录不了音，换 Chrome / Edge 试试");
    return;
  }
  const chunks = [];
  micRec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  micRec.onerror = (e) => {
    console.warn("[mic] 录音出错：", e && e.name, e && e.message);
    micAbort = true;
    micPending = false;
    micStop(true);
    toast("录音出错了，再试一次");
  };
  micRec.onstop = () => {
    micPending = false;
    micRelease();
    micPaint(false);
    if (micAbort) return;   // 退出登录/切账号期间录的这段直接丢
    micUpload(chunks, mime);
  };
  try {
    micRec.start();
  } catch (e) {
    console.warn("[mic] 录音起不来：", e && e.name, e && e.message);
    micRelease();
    toast("麦克风起不来，再试一次");
    return;
  }
  micPaint(true);
  toast(`我在听，说完再点一下（最多 ${micMax} 秒）`, 2400);
  micTimer = setTimeout(() => {
    toast("到时间啦，我先去识别", 1800);
    micStop(false);
  }, micMax * 1000);
}

/** 拉一次服务端识别状态：能不能用、单段最长多少秒。 */
async function fetchAsrState() {
  try {
    const r = await api(`/api/asr?${q(state.name || "")}`);
    const d = await r.json().catch(() => ({}));
    micAvail = !!d.available;
    micMax = Number(d.max_seconds) > 0 ? Number(d.max_seconds) : 60;
  } catch {
    // 探测失败不挡输入：真按了再让 /api/asr 回真实原因（403/503 都是人话）
    micAvail = true;
  }
  const btn = $("#mic-btn");
  if (btn && !micAvail) btn.title = "语音识别还没开通：让管理员在后台「API 配置」里配一下 Key";
}

function setupMic() {
  const btn = $("#mic-btn");
  if (!btn) return;
  const cap = micCapability();
  // 不能用的原因写在 title 上、点击时如实说出来——而不是像旧代码那样删掉按钮：
  // 删掉只会让人以为"这个产品没有语音输入"，说清楚才知道是浏览器/环境的问题。
  btn.title = cap.ok ? "语音输入：点一下开始说，再点一下结束"
                     : `语音输入暂时用不了：${cap.why}`;
  setHidden("#mic-btn", (state.authRole || "child") === "parent"); // 家长不能发消息，自然也不能说
  btn.onclick = () => {
    if (micRec && micRec.state === "recording") { micStop(false); return; }
    micStart();
  };
  fetchAsrState();
}

function toggleSecret() {
  state.secret = !state.secret;
  const btn = $("#secret-btn");
  const input = $("#msg-input");
  if (btn) {
    btn.setAttribute("aria-pressed", String(state.secret));
    btn.title = state.secret ? "悄悄话模式已开：家长视角看不到" : "悄悄话：家长视角看不到";
  }
  if (input) {
    input.classList.toggle("secret-on", state.secret);
    input.placeholder = state.secret ? "悄悄话（家长视角看不到）…" : "跟熊猫管家说说今天…";
  }
  toast(state.secret ? "悄悄话模式开了，这条家长看不到" : "悄悄话模式关了");
}

/* ==========================================================================
 * 15. 2D 兜底入口
 * ========================================================================== */

window.__pandaFallback2D = function pandaFallback2D() {
  try {
    useFallback2D("3D 不可用");
  } catch (e) {
    console.warn("[app] 2D 兜底也出错了（已忽略）：", e && e.message);
  }
};

/* ==========================================================================
 * 16. 启动
 * ========================================================================== */

function wireNav() {
  // 统一事件委托：凡带 data-go 的按钮都走这里（含顶栏导航、子视图返回、底部 tab）
  document.addEventListener("click", (e) => {
    const target = e.target;
    const btn = target && target.closest ? target.closest("[data-go]") : null;
    if (!btn) return;
    const key = btn.dataset.go;
    if (!VIEWS[key]) return;
    if (key === "parent") {
      if (state.authRole === "child") return; // 孩子账号没有家长入口
      if (state.authRole === "admin" && state.role !== "parent") {
        toggleRole(); // 评委演示：切到家长视角
        return;
      }
    }
    if (key === "main" && state.authRole === "parent") {
      go("parent"); // 家长账号的"首页"是家长视图
      return;
    }
    if (key === "main" && state.authRole === "admin" && state.role === "parent") {
      toggleRole(); // 评委从家长视角回管家台：角色一并切回孩子，否则主界面带着家长过滤
      return;
    }
    go(key);
  });
}

/** 窄屏断点：底部 tab 必须跟着它实时增删，不能只在开机判一次 */
const TABBAR_MQ = window.matchMedia("(min-width: 1100px)");

/** 窄屏底部 tab：克隆主导航 */
function buildTabbar() {
  if (TABBAR_MQ.matches) return;
  let bar = $("#tabbar");
  if (bar) return;
  bar = el("nav", "");
  bar.id = "tabbar";
  bar.setAttribute("aria-label", "底部导航");
  // 全量创建，由 applyAuth() 按角色隐藏无权限项（见函数末尾）
  const items = [
    ["main", "i-chat", "管家"],
    ["parent", "i-users", "家长"],
    ["graph", "i-planet", "星球"],
    ["growth", "i-growth", "成长"],
    ["memory", "i-book", "记忆"],
    ["logs", "i-log", "记录"],
    ["admin", "i-gear", "后台"],
  ];
  items.forEach(([go_, ic, label]) => {
    const b = el("button", "nav-btn");
    b.type = "button";
    b.dataset.go = go_;
    if (VIEWS[go_]) b.dataset.nav = go_;
    b.appendChild(icon(ic));
    b.appendChild(el("span", null, label));
    bar.appendChild(b);
  });
  // 窄屏下主视图顶栏导航是隐藏的，退出入口只能放底部 tab（主题固定夜色竹林，无切换）
  const out = el("button", "nav-btn");
  out.type = "button";
  out.setAttribute("aria-label", "退出登录");
  out.appendChild(icon("i-out"));
  out.appendChild(el("span", null, "退出"));
  out.onclick = logout;
  bar.appendChild(out);
  document.body.appendChild(bar);
  // 断点跨越后才建的话，登录时的 applyAuth() 早就跑完了，角色收口不会自动补上——
  // 孩子/家长会看到自己没有的入口（服务端仍会 403，但界面不该漏）。
  applyAuth();
}

/** 断点跨越时补建底部 tab：宽屏打开 → 再把窗口收窄，原来会掉进窄屏布局却一颗 tab 都没有，
    而窄屏下主/子视图顶栏导航都是隐藏的，等于全站无入口、连退出都没了。 */
function syncTabbar() {
  if (TABBAR_MQ.matches) return; // 宽屏由 CSS 隐藏 #tabbar，节点留着即可，不必删
  buildTabbar();
}

function bind() {
  const on = (sel, handler) => {
    const n = $(sel);
    if (n) n.onclick = handler;
  };
  on("#login-btn", () => login(
    $("#login-name") ? $("#login-name").value : "",
    $("#login-pass") ? $("#login-pass").value : ""));
  // 登录卡三个面板的切换与提交
  on("#to-register", () => setAuthPane("register"));
  on("#to-forgot", () => setAuthPane("forgot"));
  on("#back-login-reg", () => setAuthPane("login"));
  on("#back-login-fp", () => setAuthPane("login"));
  on("#register-btn", register);
  on("#forgot-next-btn", forgotNext);
  on("#forgot-reset-btn", forgotReset);
  on("#send-btn", () => send());
  on("#pause-btn", pauseChat);
  on("#attach-btn", () => {
    const input = $("#file-input");
    if (input) input.click();
  });
  on("#files-btn", toggleRecentFiles);
  // 粘贴上传：截图后 Ctrl+V 直接进待发送区（桌面端最省事的一条路）
  const msgInput = $("#msg-input");
  if (msgInput) {
    msgInput.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.files) || [];
      if (!items.length) return;
      e.preventDefault();
      uploadFiles(items);
    });
  }
  const fileInput = $("#file-input");
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      uploadFiles(fileInput.files);
      fileInput.value = ""; // 同一个文件能再传一次
    });
  }
  setupDropZone();
  on("#role-toggle", toggleRole);
  on("#secret-btn", toggleSecret);
  on("#voice-btn", toggleVoice);
  on("#dream-btn", runDream);
  on("#relay-btn", runRelay);
  on("#weekly-btn", loadWeekly);
  on("#export-btn", exportMemoir);
  on("#memory-back", () => go("main"));
  on("#logs-back", () => go("main"));
  // 退出按钮：主视图顶栏 + 各子视图导航里的 [data-act="logout"] 统一生效
  document.querySelectorAll('[data-act="logout"]').forEach((b) => { b.onclick = logout; });

  wireNav();
  buildTabbar();
  initAdmin({ api, el, icon, escapeHtml, toast, setText, setHidden, $ });

  // 星球速览整卡可点 → 星球页（节点自身 click 已 stopPropagation，先开详情）
  const mini = $("#graph-mini");
  if (mini) mini.onclick = () => go("graph");

  // 传话筒方向切换
  document.querySelectorAll("#parent-view .seg-btn[data-direction]").forEach((b) => {
    b.onclick = () => setRelayDir(b.dataset.direction);
  });
  setRelayDir("teacher2parent");

  const nameInput = $("#login-name");
  const passInput = $("#login-pass");
  if (nameInput) {
    nameInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      if (passInput && !passInput.value) passInput.focus();
      else login(nameInput.value, passInput ? passInput.value : "");
    });
  }
  if (passInput) {
    passInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) login(nameInput ? nameInput.value : "", passInput.value);
    });
  }
  // 注册 / 找回面板：输入框里回车 = 点当前面板的主按钮
  const paneEnter = (paneSel, btnSel) => {
    const pane = $(paneSel);
    if (!pane) return;
    pane.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || e.target.tagName !== "INPUT") return;
      const btn = $(btnSel);
      if (btn && !btn.closest(".hidden")) btn.click();
    });
  };
  paneEnter("#pane-register", "#register-btn");
  paneEnter("#forgot-step1", "#forgot-next-btn");
  paneEnter("#forgot-step2", "#forgot-reset-btn");
  // 复用上面粘贴上传那处取的 msgInput：同一个函数内不能重复声明 const
  if (msgInput) {
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
  }
  const relayInput = $("#relay-input");
  if (relayInput) {
    relayInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runRelay();
      }
    });
  }
  // ESC：大图先关（看图为最上层），然后停回答，最后关抽屉
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return; // 输入法里按 Esc 是取消候选字
    const lb = $("#lightbox");
    if (lb && !lb.classList.contains("hidden")) { closeLightbox(); return; }
    // 再关开着的抽屉；没有可关的，回答进行中才是停回答
    let closed = false;
    for (const sel of ["#node-drawer", "#affair-detail"]) {
      const d = $(sel);
      if (d && !d.classList.contains("hidden")) { d.classList.add("hidden"); closed = true; }
    }
    if (!closed && state.busy) pauseChat();
  });
  window.addEventListener("resize", () => {
    if (state.name) renderMiniGraph();
  });
  setupOfflineBar();
  // 跨断点补建底部 tab（老 Safari 只有 addListener）
  if (TABBAR_MQ.addEventListener) TABBAR_MQ.addEventListener("change", syncTabbar);
  else if (TABBAR_MQ.addListener) TABBAR_MQ.addListener(syncTabbar);
  window.addEventListener("pagehide", () => {
    try {
      if (state.sceneReady && typeof scene3d.disposeScene === "function") scene3d.disposeScene();
    } catch { /* 忽略 */ }
  });
}

function registerSW() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("[app] SW 注册失败：", e && e.message));
}

/** 启动层（web/splash.js）的阶段推进：只按真实里程碑走，不存在时静默。 */
function splashStage(stage) {
  try { if (window.__splash) window.__splash.stage(stage); } catch { /* 启动层可选 */ }
}
function splashDone() {
  try { if (window.__splash) window.__splash.done(); } catch { /* 启动层可选 */ }
}

function boot() {
  splashStage("boot");
  registerSW();
  if ($("#login-panda")) {
    try {
      loginPanda = mountPanda($("#login-panda"));
    } catch (e) { console.warn("[app] 登录页熊猫挂载失败：", e && e.message); }
  }
  setHidden("#secret-note", true);
  bind();
  loadVoicePref();
  try { setupLoginExtras(); } catch (e) { console.warn("[app] 登录页增强失败：", e && e.message); }
  Promise.resolve(restoreAuth()).finally(() => {
    splashDone(); // 已进主界面时 enterMain 早就揭过了，这里是登录页/失败路径的兜底
    // 还停在登录页时直接聚焦名字输入框，评委上手少点一步
    if (!state.name) { const n = $("#login-name"); if (n) n.focus({ preventScroll: true }); }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
