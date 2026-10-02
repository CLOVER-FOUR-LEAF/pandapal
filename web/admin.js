/**
 * web/admin.js — 后台管理（仅 admin 角色；服务端逐接口再校验，这里只做界面）
 *
 * 五个分区：
 *   总览 overview   账号/档案/调用统计 + 各服务配置状态
 *   配置 keys       LLM / 联网搜索 / TTS 的 Key 与端点（写 data/settings.json，立即生效）
 *   用户 users      账号清单 + 建号 + 改角色/绑档/密码/密保 + 踢下线 + 删号
 *   档案 children   每个孩子档案目录的文件级管理（读/改/删，.json 先校验再落盘）
 *   数据 data       共享数据文件（赛事库/交通库/别名/映射）JSON 直编
 *
 * 依赖（api/el/toast…）由 app.js 的 initAdmin() 注入，避免 app.js ↔ admin.js 循环取裸引用。
 */

let D = null;          // app.js 注入的依赖包
let curTab = "overview";
let bound = false;
let curChild = "";     // 档案管理：当前选中的孩子
let curFile = "";      //           当前打开的文件相对路径
let curData = "";      // 数据文件：当前打开的文件名
const SECRET_CLEAR = "[[clear]]";

export function initAdmin(deps) {
  D = deps;
  if (bound) return;
  bound = true;
  const tabs = D.$("#admin-tabs");
  if (tabs) {
    tabs.querySelectorAll("[data-atab]").forEach((b) => {
      b.onclick = () => showTab(b.dataset.atab);
    });
  }
  const on = (sel, fn) => { const n = D.$(sel); if (n) n.onclick = fn; };
  on("#an-create", createUser);
  on("#af-save", saveChildFile);
  on("#af-del", delChildFile);
  on("#df-save", saveDataFile);
  const roleSel = D.$("#an-role");
  if (roleSel) {
    roleSel.onchange = () => D.setHidden("#an-child", roleSel.value !== "parent");
  }
}

/** app.js 的 go("admin") 入口：进来就刷新当前分区。 */
export function loadAdmin() {
  if (!D) return;
  showTab(curTab, true);
}

function showTab(tab, force) {
  if (!D) return;
  curTab = tab;
  D.$("#admin-tabs").querySelectorAll("[data-atab]").forEach((b) => {
    const on = b.dataset.atab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("#admin-view .admin-pane").forEach((p) => {
    p.classList.toggle("hidden", p.id !== `admin-pane-${tab}`);
  });
  hint("");
  ({
    overview: loadOverview,
    keys: loadKeys,
    users: loadUsers,
    children: loadChildren,
    data: loadDataFiles,
  })[tab]?.();
}

function hint(text, bad) {
  const n = D.$("#admin-hint");
  if (!n) return;
  n.textContent = text || "";
  n.classList.toggle("bad", !!bad);
}

const jopts = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB`
  : n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

const fmtTime = (ts) => new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });

function errHint(e) { hint(e && e.message ? e.message : String(e), true); }

/* ============================== 总览 ============================== */

async function loadOverview() {
  const box = D.$("#admin-overview");
  if (!box) return;
  box.innerHTML = "";
  try {
    const data = await (await D.api("/api/admin/overview")).json();
    const cards = [
      ["账号总数", data.users.total, `管理员 ${data.users.admin} · 孩子 ${data.users.child} · 家长 ${data.users.parent}`],
      ["在线会话", data.users.online, "持有有效 token 的账号"],
      ["孩子档案", data.children.total, `${data.children.graph_nodes} 个记忆节点 · ${data.children.affairs} 件事务`],
      ["LLM", data.llm.configured ? "已配置" : "未配置",
        `${data.llm.protocol} · ${data.llm.model}${data.llm.backup ? " · 有备 Key" : ""}`],
      ["联网搜索", data.search.configured ? "已配置" : "未配置", "未配置时用必应网页解析兜底"],
      // TTS 分三态说清楚：能不能用（available）取决于开关 + Key 都在，
      // 只填了 Key 但 TTS_ENABLED=0 照样是关的——别让"已配置"看起来像"已启用"。
      ["TTS 语音", data.tts.available ? "已启用"
        : data.tts.configured ? "已配置但关闭" : "未配置",
        data.tts.available
          ? `${data.tts.model} · ${data.tts.voice} · ${data.tts.mode}`
          : (data.tts.configured
            ? "已填 Key，但 TTS_ENABLED 是关的（见 API 配置页）"
            : "在 API 配置页填 TTS_API_KEY 即可让管家开口说话")],
      ["LLM 调用", data.logs, "累计留痕条数（记录页可查）"],
      ["后台覆盖项", data.overrides.length, data.overrides.join("、") || "全部走 .env / 默认值"],
    ];
    cards.forEach(([t, v, sub]) => {
      const c = D.el("div", "admin-card");
      c.appendChild(D.el("div", "ac-title", t));
      c.appendChild(D.el("div", "ac-value", String(v)));
      c.appendChild(D.el("div", "ac-sub", sub));
      box.appendChild(c);
    });
  } catch (e) {
    box.appendChild(D.el("p", "empty-hint", `总览加载失败：${e.message}`));
  }
}

/* ============================== API 配置 ============================== */

const SECRET_LABEL = { settings: "后台覆盖", env: "环境变量", default: "默认", unset: "未配置" };

async function loadKeys() {
  const box = D.$("#admin-keys");
  if (!box) return;
  box.innerHTML = "";
  try {
    const data = await (await D.api("/api/admin/settings")).json();
    data.groups.forEach((g) => box.appendChild(renderKeyGroup(g)));
  } catch (e) {
    box.appendChild(D.el("p", "empty-hint", `配置读取失败：${e.message}`));
  }
}

function renderKeyGroup(g) {
  const panel = D.el("div", "panel admin-sub");
  const head = D.el("div", "panel-head");
  head.appendChild(D.el("h3", null, g.title));
  const save = D.el("button", "btn btn-primary", "保存本组");
  save.type = "button";
  head.appendChild(save);
  panel.appendChild(head);

  const fields = [];
  g.fields.forEach((f) => {
    const row = D.el("div", "kv-row");
    const lab = D.el("label", "kv-label");
    lab.appendChild(D.el("code", null, f.key));
    const src = D.el("span", `tag src-${f.source}`, SECRET_LABEL[f.source] || f.source);
    lab.appendChild(src);
    row.appendChild(lab);

    const wrap = D.el("div", "kv-input");
    const input = D.el("input", "text-input");
    input.dataset.key = f.key;
    if (f.secret) {
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = f.set ? `已配置 ${f.preview}（留空不改动）` : "未配置，填入即启用";
    } else {
      input.type = "text";
      input.value = f.value || "";
      input.spellcheck = false;
    }
    wrap.appendChild(input);
    if (f.secret && f.set) {
      const clr = D.el("button", "btn btn-ghost kv-btn", "清除");
      clr.type = "button";
      clr.title = "把这把 Key 置空（覆盖为未配置）";
      clr.onclick = () => { input.dataset.clear = "1"; input.value = ""; input.placeholder = "保存后清除"; input.disabled = true; clr.disabled = true; };
      wrap.appendChild(clr);
    }
    if (f.overridden) {
      const rst = D.el("button", "btn btn-ghost kv-btn", "恢复环境变量");
      rst.type = "button";
      rst.onclick = () => unsetKeys([f.key]);
      wrap.appendChild(rst);
    }
    row.appendChild(wrap);
    panel.appendChild(row);
    fields.push({ f, input });
  });

  save.onclick = async () => {
    const set = {};
    fields.forEach(({ f, input }) => {
      const v = input.value.trim();
      if (input.dataset.clear === "1") { set[f.key] = ""; return; }
      if (f.secret) { if (v) set[f.key] = v; } // 密钥留空 = 不改动
      else set[f.key] = v;
    });
    save.disabled = true;
    try {
      await D.api("/api/admin/settings", jopts("PUT", { set }));
      D.toast("配置已保存并生效");
      loadKeys();
    } catch (e) { errHint(e); } finally { save.disabled = false; }
  };
  return panel;
}

async function unsetKeys(keys) {
  try {
    await D.api("/api/admin/settings", jopts("PUT", { unset: keys }));
    D.toast("已恢复环境变量取值");
    loadKeys();
  } catch (e) { errHint(e); }
}

/* ============================== 用户管理 ============================== */

const ROLE_TAG = { child: "tag-child", parent: "tag-parent", admin: "tag-admin" };

async function loadUsers() {
  const box = D.$("#admin-users");
  if (!box) return;
  box.innerHTML = "";
  try {
    const { users } = await (await D.api("/api/admin/users")).json();
    const head = D.el("div", "admin-row admin-row-head");
    ["用户名", "身份", "绑定档案", "密保", "在线"].forEach((t) => head.appendChild(D.el("span", null, t)));
    box.appendChild(head);
    users.forEach((u) => box.appendChild(userRow(u)));
  } catch (e) {
    box.appendChild(D.el("p", "empty-hint", `账号加载失败：${e.message}`));
  }
}

function userRow(u) {
  const row = D.el("div", "admin-row");
  row.appendChild(D.el("span", "au-name", u.username + (u.seed ? "（种子）" : "")));
  const role = D.el("span", `tag ${ROLE_TAG[u.role] || ""}`, u.role_name);
  row.appendChild(role);
  row.appendChild(D.el("span", null, u.child || "—"));
  row.appendChild(D.el("span", null, u.has_question ? "已设" : "未设"));
  row.appendChild(D.el("span", null, String(u.tokens)));
  const ops = D.el("span", "au-ops");

  const edit = D.el("button", "btn btn-ghost kv-btn", "编辑");
  edit.type = "button";
  edit.onclick = () => toggleUserEditor(row, u);
  const kick = D.el("button", "btn btn-ghost kv-btn", "踢下线");
  kick.type = "button";
  kick.title = "吊销该账号全部登录态";
  kick.onclick = async () => {
    try {
      const r = await (await D.api(`/api/admin/users/${encodeURIComponent(u.username)}/revoke`,
        jopts("POST", {}))).json();
      D.toast(`已踢下线 ${r.revoked} 个会话`);
      loadUsers();
    } catch (e) { errHint(e); }
  };
  const del = D.el("button", "btn btn-ghost kv-btn danger", "删除");
  del.type = "button";
  del.onclick = async () => {
    if (!confirm(`确定删除账号「${u.username}」？档案目录会保留。`)) return;
    try {
      await D.api(`/api/admin/users/${encodeURIComponent(u.username)}`, { method: "DELETE" });
      D.toast("账号已删除");
      loadUsers();
    } catch (e) { errHint(e); }
  };
  append(ops, edit, kick, del);
  row.appendChild(ops);
  return row;
}

function append(p, ...kids) { kids.forEach((k) => k && p.appendChild(k)); }

function toggleUserEditor(row, u) {
  const old = row.nextElementSibling;
  if (old && old.classList.contains("admin-edit-row")) { old.remove(); return; }
  const er = D.el("div", "admin-edit-row");
  const mk = (ph, v = "", len = 64, type = "text") => {
    const i = D.el("input", "text-input");
    i.type = type; i.placeholder = ph; i.maxLength = len; i.value = v; i.autocomplete = "off";
    return i;
  };
  const role = D.el("select", "text-input");
  [["child", "孩子"], ["parent", "家长"], ["admin", "管理员"]].forEach(([v, t]) => {
    const o = D.el("option", null, t); o.value = v; role.appendChild(o);
  });
  role.value = u.role;
  const child = mk("绑定档案名", u.child || "", 24);
  const pass = mk("新密码（留空不改）", "", 64);
  const qs = mk("新密保问题", "", 60);
  const as = mk("新密保答案", "", 60);
  const drop = D.el("label", "au-drop");
  const dropCb = D.el("input"); dropCb.type = "checkbox";
  drop.appendChild(dropCb);
  drop.appendChild(document.createTextNode(" 清除密保（该账号将不能自助找回）"));

  const ok = D.el("button", "btn btn-primary", "保存修改");
  ok.type = "button";
  ok.onclick = async () => {
    const patch = {};
    if (role.value !== u.role) patch.role = role.value;
    if (child.value.trim() && child.value.trim() !== u.child) patch.child = child.value.trim();
    if (pass.value) patch.password = pass.value;
    if (dropCb.checked) patch.drop_question = true;
    else if (qs.value.trim() && as.value.trim()) { patch.question = qs.value.trim(); patch.answer = as.value.trim(); }
    if (!Object.keys(patch).length) { hint("没有改动"); return; }
    ok.disabled = true;
    try {
      await D.api(`/api/admin/users/${encodeURIComponent(u.username)}`, jopts("PATCH", patch));
      D.toast("已保存，凭证类变更已踢下线");
      loadUsers();
    } catch (e) { errHint(e); } finally { ok.disabled = false; }
  };
  append(er, role, child, pass, qs, as, drop, ok);
  row.after(er);
}

async function createUser() {
  const body = {
    username: D.$("#an-name").value.trim(),
    password: D.$("#an-pass").value,
    role: D.$("#an-role").value,
    child: D.$("#an-child").value.trim(),
    question: D.$("#an-question").value.trim(),
    answer: D.$("#an-answer").value.trim(),
  };
  if (!body.username || !body.password) { hint("用户名和密码都要填", true); return; }
  try {
    await D.api("/api/admin/users", jopts("POST", body));
    D.toast(`账号「${body.username}」已创建`);
    ["#an-name", "#an-pass", "#an-child", "#an-question", "#an-answer"]
      .forEach((s) => { D.$(s).value = ""; });
    loadUsers();
  } catch (e) { errHint(e); }
}

/* ============================== 档案管理 ============================== */

async function loadChildren() {
  const box = D.$("#admin-children");
  if (!box) return;
  box.innerHTML = "";
  try {
    const { children } = await (await D.api("/api/admin/children")).json();
    if (!children.length) { box.appendChild(D.el("p", "empty-hint", "还没有孩子档案。")); return; }
    children.forEach((c) => {
      const row = D.el("button", "admin-row admin-pick");
      row.type = "button";
      row.appendChild(D.el("span", "au-name", c.name));
      row.appendChild(D.el("span", null, `${c.nodes} 节点`));
      row.appendChild(D.el("span", null, `${c.affairs} 事务`));
      row.appendChild(D.el("span", null, fmtSize(c.size)));
      row.onclick = () => { curChild = c.name; curFile = ""; loadChildFiles(); };
      box.appendChild(row);
    });
  } catch (e) {
    box.appendChild(D.el("p", "empty-hint", `档案加载失败：${e.message}`));
  }
}

async function loadChildFiles() {
  D.setText("#af-child-name", `${curChild} 的档案`);
  D.setHidden("#af-editor", true);
  const box = D.$("#af-files");
  box.innerHTML = "";
  try {
    const { files } = await (await D.api(
      `/api/admin/children/${encodeURIComponent(curChild)}/files`)).json();
    files.forEach((f) => {
      const row = D.el("button", "af-file");
      row.type = "button";
      row.dataset.path = f.path;
      row.appendChild(D.el("code", null, f.path));
      row.appendChild(D.el("span", "af-meta", `${fmtSize(f.size)} · ${fmtTime(f.mtime)}`));
      row.onclick = () => openChildFile(f.path);
      box.appendChild(row);
    });
    if (!files.length) box.appendChild(D.el("p", "empty-hint", "目录是空的。"));
  } catch (e) { box.appendChild(D.el("p", "empty-hint", `读取失败：${e.message}`)); }
}

async function openChildFile(path) {
  try {
    const { text } = await (await D.api(
      `/api/admin/children/${encodeURIComponent(curChild)}/file?path=${encodeURIComponent(path)}`)).json();
    curFile = path;
    D.setText("#af-path", path);
    D.$("#af-text").value = text;
    D.setHidden("#af-editor", false);
    document.querySelectorAll("#af-files .af-file").forEach((r) =>
      r.classList.toggle("active", r.dataset.path === path));
  } catch (e) { errHint(e); }
}

async function saveChildFile() {
  const text = D.$("#af-text").value;
  try {
    const r = await (await D.api(
      `/api/admin/children/${encodeURIComponent(curChild)}/file`,
      jopts("PUT", { path: curFile, content: text }))).json();
    D.toast(`已保存 ${curFile}（${fmtSize(r.size)}）`);
    loadChildFiles();
  } catch (e) { errHint(e); }
}

async function delChildFile() {
  if (!confirm(`确定删除 ${curChild} 档案里的 ${curFile}？`)) return;
  try {
    await D.api(`/api/admin/children/${encodeURIComponent(curChild)}/file?path=${encodeURIComponent(curFile)}`,
      { method: "DELETE" });
    D.toast("文件已删除");
    curFile = "";
    D.setHidden("#af-editor", true);
    loadChildFiles();
  } catch (e) { errHint(e); }
}

/* ============================== 数据文件 ============================== */

async function loadDataFiles() {
  const box = D.$("#admin-data");
  if (!box) return;
  box.innerHTML = "";
  try {
    const { files } = await (await D.api("/api/admin/data")).json();
    files.forEach((f) => {
      const row = D.el("button", "admin-row admin-pick");
      row.type = "button";
      if (!f.exists) row.disabled = true;
      row.appendChild(D.el("span", "au-name", f.title));
      row.appendChild(D.el("code", null, f.file));
      row.appendChild(D.el("span", null, f.exists ? fmtSize(f.size) : "缺失"));
      row.onclick = () => openDataFile(f.file, f.title);
      box.appendChild(row);
    });
  } catch (e) {
    box.appendChild(D.el("p", "empty-hint", `数据文件加载失败：${e.message}`));
  }
}

async function openDataFile(fname, title) {
  try {
    const { text } = await (await D.api(`/api/admin/data/${encodeURIComponent(fname)}`)).json();
    curData = fname;
    D.setText("#df-name", title);
    D.setText("#df-path", fname);
    D.$("#df-text").value = text;
    D.setHidden("#df-editor", false);
    D.setHidden("#df-empty", true);
  } catch (e) { errHint(e); }
}

async function saveDataFile() {
  try {
    const r = await (await D.api(`/api/admin/data/${encodeURIComponent(curData)}`,
      jopts("PUT", { text: D.$("#df-text").value }))).json();
    D.toast(`已保存 ${curData}（${fmtSize(r.size)}）`);
    loadDataFiles();
  } catch (e) { errHint(e); }
}
