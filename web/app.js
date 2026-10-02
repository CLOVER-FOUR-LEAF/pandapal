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
  parent_confirm: "请家长确认", ics: "导出日历",
};
const MODE_LABEL = { plan: "规划链", todo: "拆解待办", affair: "事务更新", relay: "传话筒", explain: "讲给你听", chat: "" };

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
  needGraphRefresh: false,
  relayDir: "teacher2parent",
};

let pandaSvg = null;
let micRec = null;

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
      else if (resp.status === 404) msg = "这个功能还没准备好（404）";
      else if (resp.status === 429) msg = "管家还在回上一条，稍等一下哦";
      else if (resp.status >= 500) msg = "管家后端打了个喷嚏，稍后再试";
      else msg = `请求失败（${resp.status}）`;
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
async function readTextStream(resp, onToken) {
  if (!resp.body || !resp.body.getReader) {
    const data = await resp.json().catch(() => ({}));
    if (data.text) onToken(data.text);
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
      if (ev.type === "token") onToken(ev.text || "");
      else if (ev.type === "done") done = ev;
      else if (ev.type === "error") throw new Error(ev.message || "生成失败");
    }
  }
  return done;
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
  const bad = !u ? ["先起个用户名吧", "#reg-name"]
    : p1.length < 4 ? ["密码太短啦，至少 4 位", "#reg-pass"]
    : p1 !== p2 ? ["两遍密码不一样哦", "#reg-pass2"]
    : regRole === "parent" && !child ? ["家长账号要填孩子的登录名", "#reg-child"]
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
      child: regRole === "parent" ? child : "", question: q, answer: a,
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
    ["#reg-name", "#reg-pass", "#reg-pass2", "#reg-child", "#reg-question", "#reg-answer"]
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

  // 气泡轮播：讲解时展示管家"主动办事"的样子
  const lines = [
    "小豆，明天科学课的实验材料我已经帮你列好啦～",
    "王老师说周五春游，我把要带的东西整理进清单了",
    "这周你跳绳进步了 20 个！要不要告诉妈妈？",
    "西客松还有 3 天，今晚先把演示稿过一遍吧",
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
  if (!saved || !saved.token) return;
  state.token = saved.token;
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
  setHidden("#panda-bubble", true);
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
  try { if (micRec && micRec.abort) micRec.abort(); } catch { /* 忽略 */ }
}

function logout() {
  // 退出 = 注销 token 回登录页；服务端会话仍在，同账号再进会续上历史
  if (state.token) api("/api/auth/logout", jsonOpts({})).catch(() => {});
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
  setHidden("#role-toggle", !isAdmin);
  // 子视图导航里的家长/记录入口同样按角色收口
  document.querySelectorAll('[data-go="parent"]').forEach((b) => {
    b.classList.toggle("hidden", role === "child");
  });
  document.querySelectorAll('.subview-nav [data-go="logs"]').forEach((b) => {
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
  initSceneSafe(); // 不 await
  if (state.role === "parent") {
    // 家长首页 = 家长视图（收件箱 + 传话筒），不进孩子的管家台
    show("parent");
    applyRole("parent");
    await Promise.all([loadParentInbox(), loadGraph()]);
    return;
  }
  show("main");
  applyRole(state.role);
  renderChips();
  setupMic();
  await Promise.all([loadBriefing(), loadAffairs(), loadGraph(), loadHistory()]);
  loadGreeting();
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
  box.innerHTML = "";
  const textEl = el("div", "briefing-text", "");
  box.appendChild(textEl);
  let full = "";
  try {
    // 流式：正文逐字出，done 事件再补看板/截止/建议（首屏不必等整段 LLM）
    const resp = await api(`/api/briefing?${q(state.name)}&stream=1`);
    const done = await readTextStream(resp, (tok) => {
      full += tok;
      textEl.textContent = full;
    });
    renderBriefingExtras(done, full);
  } catch (e) {
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
    const days = d.days !== undefined ? d.days : (d.due_in_days !== undefined ? d.due_in_days : daysUntil(d.due));
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
  const days = a.due_in_days !== undefined ? a.due_in_days : daysUntil(a.due);
  if (days !== null && days !== undefined && days <= 3) card.dataset.urgent = "true";

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
  const days = a.due_in_days !== undefined ? a.due_in_days : daysUntil(a.due);
  return el("span", `countdown${days !== null && days !== undefined && days < 0 ? " overdue" : ""}`,
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
  icsBtn.onclick = () => window.open(`${BASE}/api/ics/${encodeURIComponent(aff.id)}?${q(state.name)}&token=${encodeURIComponent(state.token || "")}`, "_blank");
  const closeBtn = el("button", "btn-reject", "关闭");
  closeBtn.type = "button";
  closeBtn.onclick = () => holder.wrap.classList.add("hidden");
  append(acts, icsBtn, closeBtn);
  box.appendChild(acts);

  box.appendChild(await checklistBlock(aff));
  box.appendChild(dagBlock(aff));
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
  return row;
}

function setDagDot(dot, status) {
  dot.innerHTML = "";
  if (status === "done") dot.appendChild(icon("i-check"));
  else if (status === "error") dot.appendChild(icon("i-x"));
  else if (status === "running") dot.appendChild(icon("i-bolt"));
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

async function loadGreeting() {
  const bubble = $("#panda-bubble");
  const span = el("span", "bb-text");
  if (bubble) {
    bubble.classList.remove("hidden");
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
    });
  } catch (e) {
    full = `早呀，${state.name || "小豆"}！今天有什么想和管家聊聊的吗？无论是生活小事、竞赛备战还是心里话，我都一直陪着你～`;
  }
  const text = (data && data.text) || full || "早呀！今天想聊点什么？";
  if (span) span.textContent = text;
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
  addMsg("ai", text);
}

async function loadHistory() {
  try {
    const resp = await api(`/api/history?${q(state.name)}`);
    const data = await resp.json();
    const history = (data && data.history) || [];
    if (history.length > 30) addSys("（只展示最近 30 条对话）");
    history.slice(-30).forEach((m) => {
      if (!m) return;
      addMsg(m.role === "user" ? "me" : "ai", m.content || "", String(m.content || "").startsWith("[[secret]]"));
    });
  } catch { /* 无历史不阻塞 */ }
}

/* ==========================================================================
 * 7. 对话渲染
 * ========================================================================== */

function chatBox() { return $("#chat"); }

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
function addMsg(cls, text, secret) {
  const box = chatBox();
  if (!box) return null;
  clearChatHint();
  const shown = secret ? String(text).replace(/^\[\[secret\]\]/, "") : text;
  if (cls === "ai") {
    const row = el("div", `msg ai${secret ? " secret" : ""}`);
    const av = el("span", "msg-avatar");
    av.appendChild(icon("i-logo"));
    const body = el("div", "msg-text");
    if (secret) body.appendChild(secretTag());
    const md = el("div", "md");
    setMd(md, shown);
    body.appendChild(md);
    append(row, av, body);
    box.appendChild(row);
    scrollBottom();
    return row;
  }
  const div = el("div", `msg ${cls}${secret ? " secret" : ""}`);
  if (secret) div.appendChild(secretTag());
  div.appendChild(document.createTextNode(shown));
  box.appendChild(div);
  scrollBottom();
  return div;
}

function addSys(text) { return addMsg("sys", text); }

function scrollBottom() {
  const c = chatBox();
  if (c) c.scrollTop = c.scrollHeight;
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
    detail.textContent = tip ? truncate(tip, 26) : "";
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

  const cl = card.checklist;
  if (cl && (cl.items || []).length) {
    wrap.appendChild(el("div", "sec-h", cl.title || "清单"));
    const list = el("div", "checklist");
    const cid = card.checklist_id || card.id || cl.id || "";
    const total = cl.items.length;
    const doneN = cl.items.filter((i) => i && i.done).length;
    cl.items.forEach((item, i) => {
      const row = checkRow(item, i, cid);
      if (!cid) row.querySelector("input").disabled = true;
      list.appendChild(row);
    });
    wrap.appendChild(list);
    wrap.appendChild(el("div", "check-progress", `已勾 ${doneN}/${total}`));
  }

  if (card.closing) wrap.appendChild(el("div", "card-closing", card.closing));

  const footnotes = card.footnotes || [];
  if (footnotes.length) {
    const cites = el("div", "cite-list");
    footnotes.forEach((f) => {
      const item = el("span", "cite-item cite", f.text || "");
      if (f.node_id) {
        item.style.cursor = "pointer";
        item.onclick = () => openNodeDrawer({ id: f.node_id, label: f.text || f.node_id });
      }
      cites.appendChild(item);
    });
    wrap.appendChild(cites);
  }

  box.appendChild(wrap);
  scrollBottom();
  s3("setPandaMood", "happy");
}

/* ==========================================================================
 * 8. 发送 + SSE 全事件解析
 * ========================================================================== */

function unlockInput() {
  state.busy = false;
  const btn = $("#send-btn");
  if (btn) btn.disabled = false;
  const input = $("#msg-input");
  if (input) input.placeholder = state.secret ? "悄悄话（家长视角看不到）…" : "跟熊猫管家说说今天…";
}

async function send(preset) {
  const input = $("#msg-input");
  const raw = preset !== undefined ? String(preset) : input ? input.value : "";
  const text = raw.trim();
  if (!text || !state.name) return;
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
  state.busy = true;
  const sendBtn = $("#send-btn");
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.placeholder = "管家正在想…";

  const secret = state.secret;
  if (input && preset === undefined) input.value = "";
  addMsg("me", text, secret);
  const bubble = $("#panda-bubble");
  if (bubble) bubble.classList.add("hidden");
  s3("setPandaMood", "thinking");
  if (pandaSvg) setMood(pandaSvg, "thinking");
  chatStatus("正在想…", true);

  const ctx = { seq, typing: addTyping(), aiBubble: null, aiRaw: "", tree: null };
  const dropTyping = () => {
    if (ctx.typing) { ctx.typing.remove(); ctx.typing = null; }
  };

  const payload = secret ? `[[secret]]${text}` : text;
  try {
    const resp = await api("/api/chat", jsonOpts({ name: state.name, message: payload }));
    await readSSE(resp, ctx, dropTyping);
  } catch (e) {
    dropTyping();
    if (!ctx.aiRaw && input && preset === undefined && !input.value) {
      input.value = text; // 一个 token 都没回来：请求根本没生效，恢复草稿免得重打
    }
    if (e.status === 429) addMsg("ai", "管家还在回上一条，稍等 1 秒再说～");
    else addMsg("ai", `唔……${e.message}`);
    s3("setPandaMood", "worried");
  } finally {
    dropTyping();
    flushMd(ctx);
    if (ctx.aiBubble) ctx.aiBubble.classList.remove("streaming");
    if (seq === state.sendSeq) {
      unlockInput();
      s3("setPandaMood", "idle");
      if (pandaSvg) setMood(pandaSvg, "normal");
      modeBadge("");
      chatStatus();
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
    const { done, value } = await reader.read();
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

function handleEvent(ev, ctx, dropTyping) {
  if (!ev || !ev.type) return;
  if (ctx && ctx.seq !== undefined && ctx.seq !== state.sendSeq) return; // 过期会话的事件丢弃
  switch (ev.type) {
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

    case "recall": {
      dropTyping();
      addRecallChip(ev);
      const edges = (ev.edges || []).map((e) => (Array.isArray(e) ? { source: e[0], target: e[1] } : e));
      s3("highlightRecall", { nodes: ev.nodes || [], edges });
      break;
    }

    case "affair":
      onAffairEvent(ev);
      break;

    case "plan":
      dropTyping();
      s3("clearPlanSatellites");
      ctx.tree = addPlanTree(ev.title, ev.nodes || []);
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
      break;

    case "action":
      addActionRow(ev);
      applyActionToDetail(ev);
      if (ev.detail) toast(ev.detail);
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
        ctx.aiRaw = (ctx.aiRaw || "") + (ev.text || "");
        scheduleMd(ctx);
      }
      scrollBottom();
      break;

    // done 之后还可能有 memory 事件：只解锁输入，绝不中断读取
    case "done":
      dropTyping();
      flushMd(ctx);
      if (ctx.aiBubble) ctx.aiBubble.classList.remove("streaming");
      unlockInput();
      s3("setPandaMood", "idle");
      modeBadge("");
      chatStatus();
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
    if (data && data.relay) renderRelay(data.relay);
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
       <span class="inbox-status">${escapeHtml(String(item.created || item.ts || "").slice(0, 16))}</span>
     </div>
     <div class="inbox-detail">${escapeHtml(item.detail || "")}</div>`;
  const reply = item.reply || item.answer;
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
    (item.options || []).forEach((opt) => {
      const b = el("button", "btn-approve", opt);
      b.type = "button";
      b.onclick = () => decideInbox(item.id, "approve", b, opt);
      row.appendChild(b);
    });
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
};

function setRelayDir(dir) {
  state.relayDir = dir === "child2teacher" ? "child2teacher" : "teacher2parent";
  document.querySelectorAll("#parent-view .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.direction === state.relayDir);
  });
  const heads = RELAY_HEADS[state.relayDir];
  const c1 = $("#relay-t2p .relay-head");
  const c2 = $("#relay-c2t .relay-head");
  if (c1) c1.textContent = heads[0];
  if (c2) c2.textContent = heads[1];
  const input = $("#relay-input");
  if (input) {
    input.placeholder = state.relayDir === "child2teacher"
      ? "把孩子的原话写进来，管家整理成得体的话发给老师…"
      : "把老师的话粘进来，管家翻成家长能听懂的话…";
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

function setupMic() {
  const btn = $("#mic-btn");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !btn) {
    if (btn) btn.remove();
    return;
  }
  btn.classList.remove("hidden");
  micRec = new SR();
  micRec.lang = "zh-CN";
  micRec.interimResults = true;
  let recording = false;
  micRec.onresult = (e) => {
    let text = "";
    for (const r of e.results) text += r[0].transcript;
    const input = $("#msg-input");
    if (input) input.value = text;
  };
  const stop = () => {
    recording = false;
    btn.classList.remove("recording");
    btn.setAttribute("aria-pressed", "false");
  };
  micRec.onend = stop;
  micRec.onerror = stop;
  btn.onclick = () => {
    if (recording) { micRec.stop(); return; }
    recording = true;
    btn.classList.add("recording");
    btn.setAttribute("aria-pressed", "true");
    try { micRec.start(); } catch { stop(); }
  };
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
  // 窄屏下主视图顶栏导航是隐藏的，退出入口只能放底部 tab
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
  on("#role-toggle", toggleRole);
  on("#secret-btn", toggleSecret);
  on("#dream-btn", runDream);
  on("#relay-btn", runRelay);
  on("#memory-back", () => go("main"));
  on("#logs-back", () => go("main"));
  // 退出按钮：主视图顶栏 + 各子视图导航里的 [data-act="logout"] 统一生效
  document.querySelectorAll('[data-act="logout"]').forEach((b) => { b.onclick = logout; });

  wireNav();
  buildTabbar();

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
  const msgInput = $("#msg-input");
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
  // ESC 关抽屉
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const drawer = $("#node-drawer");
      if (drawer && !drawer.classList.contains("hidden")) drawer.classList.add("hidden");
      const detail = $("#affair-detail");
      if (detail && !detail.classList.contains("hidden")) detail.classList.add("hidden");
    }
  });
  window.addEventListener("resize", () => {
    if (state.name) renderMiniGraph();
  });
  // 跨断点补建底部 tab（老 Safari 只有 addListener）
  if (TABBAR_MQ.addEventListener) TABBAR_MQ.addEventListener("change", syncTabbar);
  else if (TABBAR_MQ.addListener) TABBAR_MQ.addListener(syncTabbar);
  window.addEventListener("pagehide", () => {
    try {
      if (state.sceneReady && typeof scene3d.disposeScene === "function") scene3d.disposeScene();
    } catch { /* 忽略 */ }
  });
}

function boot() {
  if ($("#login-panda")) {
    try {
      loginPanda = mountPanda($("#login-panda"));
    } catch (e) { console.warn("[app] 登录页熊猫挂载失败：", e && e.message); }
  }
  setHidden("#secret-note", true);
  bind();
  try { setupLoginExtras(); } catch (e) { console.warn("[app] 登录页增强失败：", e && e.message); }
  Promise.resolve(restoreAuth()).finally(() => {
    // 还停在登录页时直接聚焦名字输入框，评委上手少点一步
    if (!state.name) { const n = $("#login-name"); if (n) n.focus({ preventScroll: true }); }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
