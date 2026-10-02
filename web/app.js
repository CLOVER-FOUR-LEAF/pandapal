import { mountPanda, setMood } from "./panda.js";

const $ = (s) => document.querySelector(s);
const state = { name: null, busy: false };
let pandaSvg = null;

const STATUS_TAG = { active: ["进行中", "status-active"], dropped: ["放下了", "status-dropped"], done: ["完成啦", "status-done"] };
const NODE_ICON = { pending: "○", done: "✓", error: "✕" };

// ---------- 视图切换 ----------
function show(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

// ---------- API ----------
async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let msg = `请求失败（${resp.status}）`;
    try { msg = (await resp.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return resp;
}

// ---------- 登录 ----------
async function doLogin() {
  const name = $("#login-name").value.trim();
  if (!name) { $("#login-hint").textContent = "先告诉我你的名字哦"; return; }
  $("#login-btn").disabled = true;
  $("#login-hint").textContent = "正在打开你的档案…";
  try {
    await api("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    state.name = name;
    enterMain();
    loadGreeting();
  } catch (e) {
    $("#login-hint").textContent = e.message;
  } finally {
    $("#login-btn").disabled = false;
  }
}

function enterMain() {
  show("#main-view");
  $("#child-name").textContent = `@ ${state.name}`;
  pandaSvg = mountPanda($("#main-panda"));
  renderChips();
  $("#msg-input").focus();
}

async function loadGreeting() {
  const bubble = $("#panda-bubble");
  bubble.classList.remove("hidden");
  bubble.textContent = "……";
  try {
    const resp = await api(`/api/greeting?name=${encodeURIComponent(state.name)}`);
    const { text } = await resp.json();
    bubble.textContent = text;
    addMsg("ai", text);
  } catch (e) {
    bubble.textContent = e.message;
  }
}

function renderChips() {
  const chips = ["西客松比赛我要准备啥？", "我最近在攒钱", "我又想学钢琴了"];
  const box = $("#chips");
  box.innerHTML = "";
  chips.forEach((c) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = c;
    b.onclick = () => { $("#msg-input").value = c; send(); };
    box.appendChild(b);
  });
}

// ---------- 聊天渲染 ----------
function addMsg(cls, text) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  $("#chat").appendChild(div);
  scrollBottom();
  return div;
}

function scrollBottom() {
  const c = $("#chat");
  c.scrollTop = c.scrollHeight;
}

function addTaskTree(title, nodes) {
  const box = document.createElement("div");
  box.className = "tasktree";
  const depsName = {};
  nodes.forEach((n) => (depsName[n.id] = n.title));
  box.innerHTML = `<div class="tt-title">📋 ${escapeHtml(title)}</div>` +
    nodes.map((n) => {
      const dep = (n.depends_on || []).map((d) => depsName[d]).filter(Boolean).join("、");
      return `<div class="tt-node pending" data-id="${n.id}">
        <span class="tt-icon">${NODE_ICON.pending}</span>
        <span class="tt-name">${escapeHtml(n.title)}
          ${dep ? `<div class="tt-deps">等「${escapeHtml(dep)}」完成后</div>` : ""}
        </span></div>`;
    }).join("");
  $("#chat").appendChild(box);
  scrollBottom();
  return box;
}

function updateNode(tree, ev) {
  const row = tree.querySelector(`[data-id="${ev.id}"]`);
  if (!row) return;
  row.classList.remove("pending", "running", "done", "error");
  row.classList.add(ev.status);
  const icon = row.querySelector(".tt-icon");
  icon.textContent = NODE_ICON[ev.status] || "";
  scrollBottom();
}

function addCard(card) {
  const box = document.createElement("div");
  box.className = "card";
  box.innerHTML = `<div class="card-title">${escapeHtml(card.emoji || "🐼")} ${escapeHtml(card.title)}</div>` +
    card.sections.map((s) => `
      <div class="sec">
        <div class="sec-h">${escapeHtml(s.heading)}</div>
        <ul class="sec-items">${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
      </div>`).join("") +
    (card.closing ? `<div class="card-closing">${escapeHtml(card.closing)}</div>` : "");
  $("#chat").appendChild(box);
  scrollBottom();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 发送 & SSE ----------
async function send() {
  const input = $("#msg-input");
  const text = input.value.trim();
  if (!text || state.busy) return;
  state.busy = true;
  $("#send-btn").disabled = true;
  input.value = "";
  addMsg("me", text);
  $("#panda-bubble").classList.add("hidden");
  setMood(pandaSvg, "thinking");

  let aiBubble = null;
  let tree = null;
  try {
    const resp = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: state.name, message: text }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!raw.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(raw.slice(5)); } catch { continue; }
        if (ev.type === "mode" && ev.mode === "plan") {
          setMood(pandaSvg, "thinking");
        } else if (ev.type === "token") {
          if (!aiBubble) { aiBubble = addMsg("ai", ""); setMood(pandaSvg, "speaking"); }
          aiBubble.textContent += ev.text;
          scrollBottom();
        } else if (ev.type === "plan") {
          tree = addTaskTree(ev.title, ev.nodes);
        } else if (ev.type === "node" && tree) {
          updateNode(tree, ev);
        } else if (ev.type === "card") {
          addCard(ev.card);
          setMood(pandaSvg, "happy");
        } else if (ev.type === "error") {
          addMsg("ai", `😵 ${ev.message}`);
        } else if (ev.type === "done") {
          // 流结束
        }
      }
    }
  } catch (e) {
    addMsg("ai", `😵 ${e.message}`);
  } finally {
    state.busy = false;
    $("#send-btn").disabled = false;
    setMood(pandaSvg, "normal");
    $("#msg-input").focus();
  }
}

// ---------- 记忆本 ----------
async function openMemory() {
  show("#memory-view");
  const topicsBox = $("#memory-topics");
  const dailyBox = $("#memory-daily");
  $("#memory-md").textContent = "加载中…";
  try {
    const resp = await api(`/api/memory?name=${encodeURIComponent(state.name)}`);
    const data = await resp.json();
    $("#memory-md").textContent = data.memory_md || "（还没有长期记忆）";
    topicsBox.innerHTML = data.topics.length ? "" : '<div class="msg sys">还没有主题记忆</div>';
    data.topics.forEach((t) => {
      const [label, cls] = STATUS_TAG[t.status] || [t.status, "status-active"];
      const div = document.createElement("div");
      div.className = "topic-card";
      div.innerHTML = `<div class="topic-head">
          <span class="topic-name">${escapeHtml(t.name)}</span>
          <span class="status-tag ${cls}">${label}</span>
          <span class="topic-rel">${t.related.map(escapeHtml).join(" · ")}</span>
        </div>
        <div class="topic-body">${escapeHtml(t.body)}</div>`;
      topicsBox.appendChild(div);
    });
    dailyBox.innerHTML = data.daily.length ? "" : '<div class="msg sys">还没有沉淀记录</div>';
    data.daily.forEach((d) => {
      const div = document.createElement("div");
      div.className = "daily-item";
      div.innerHTML = `<div class="daily-date">${escapeHtml(d.date)}</div>
        <div class="daily-content">${escapeHtml(d.content)}</div>`;
      dailyBox.appendChild(div);
    });
  } catch (e) {
    $("#memory-md").textContent = e.message;
  }
}

// ---------- 启动 ----------
mountPanda($("#login-panda"));
$("#login-btn").onclick = doLogin;
$("#login-name").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("#send-btn").onclick = send;
$("#msg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
$("#memory-btn").onclick = openMemory;
$("#memory-back").onclick = () => show("#main-view");
