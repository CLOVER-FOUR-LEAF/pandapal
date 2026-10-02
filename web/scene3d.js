// web/scene3d.js —— 记忆星球 3D 场景（PandaButler / 熊猫管家）
//
// v2「星球」重构：
//   · 星球是主角：一颗有海陆/极冰/云带/大气辉光/经纬球网的行星，自转；孩子本人就是这颗星球
//   · 五领域（德智体美劳）= 球面上按斐波那契螺旋钉住的五颗次行星，各带领域色轨道环与记忆计数
//   · 记忆节点 = 沿"领域法线"浮起的记忆星：球坐标分层 + 切平面黄金角螺旋 + 局部松弛，
//     互不重叠、不穿模；布局是确定性的（不是逐帧力导向），只在数据变化时算一次
//   · 每帧只做一次 O(n) 的位置阻尼插值，静止时降到 ~30fps
//   · 深浅色统一切换：画布内（着色器 uniform）与 DOM 标签（CSS 变量）同源
//
// 技术选型：three.js r160（web/vendor/three.module.min.js）+ 官方 addons
//   OrbitControls（阻尼轨道/触控）、CSS2DRenderer（HTML 中文标签，清晰可选中样式）
// 全部本地 vendor、原生 ES Module、动态 import：任何模块加载失败只会让 initScene reject，
// 不会拖垮 app.js 对本文件的静态 import。
//
// 导出 API（全部幂等、不抛错，可在 initScene 之前调用——配置会被记住，初始化后生效）：
//   initScene(containerEl)            async，失败 reject（调用方切 2D）
//   setGraphData({nodes, edges})
//   setRole("child"|"parent")
//   setTheme("dark"|"light")          跟随界面深浅色
//   setTimeline(null|"YYYY-MM"|"YYYY-MM-DD")
//   setFilter({domain, status}) / setDomainFilter(domain, status)
//   setNodeClickHandler(cb)
//   highlightRecall({nodes, edges})
//   spawnMemory({added_nodes, added_edges, updated})
//   spawnPlanSatellites([{id,title,depends_on}]) / setPlanNode(id,status) / clearPlanSatellites()
//   focusNode(id) / focusDomain(key)
//   setPandaMood(mood)
//   resize() / disposeScene() / isSceneReady()

// ============================================================
// 0. 视觉常量
// ============================================================

const DOMAINS = {
  ethics: { hex: 0xf07a6a, css: "#f07a6a", ch: "德", name: "品德" },
  intellect: { hex: 0x5aa2e6, css: "#5aa2e6", ch: "智", name: "智识" },
  health: { hex: 0x5cc28a, css: "#5cc28a", ch: "体", name: "健康" },
  aesthetics: { hex: 0xb78be0, css: "#b78be0", ch: "美", name: "审美" },
  labor: { hex: 0xf0b84a, css: "#f0b84a", ch: "劳", name: "劳动" },
};
const DOMAIN_KEYS = Object.keys(DOMAINS);
const OTHER_DOMAIN = { hex: 0x8fa7a0, css: "#8fa7a0", ch: "", name: "其他" };
const STATUS_NAME = { active: "进行中", done: "已完成", dropped: "已放下" };
const TYPE_NAME = { person: "人物", interest: "兴趣", trait: "特质", goal: "目标", event: "事件", health: "健康" };

const AMBER = 0xf0a24a;
const BAMBOO = 0x3fae74;
const GOLD = 0xf3c65c;
const PLAN_COLOR = { pending: 0x5f7d78, running: AMBER, done: BAMBOO, error: 0xf07a6a };

const R_PLANET = 9.4;        // 星球半径
const RING_R = 4.15;         // 领域轨道环半径
const PATCH_EDGE = 5.7;      // 领域星团在切平面上的活动半径
const SHELL_H0 = 1.05;       // 记忆星最小浮起高度（贴着球面外侧）
const SHELL_STEP = 1.45;      // 每层递增的浮起高度
const FOV = 42;
const RECENT_DAYS = 540;
const IDLE_RESUME_MS = 20000;
const RECALL_MS = 3200;
const SPIN = 0.035;          // 星球自转 rad/s
const IDLE_FPS = 30;         // 静止时降到这个帧率（省电，肉眼几乎无差）

// 场景明暗只跟界面主题走（key 是 "dark"/"light"，不是角色）——
// 角色只决定"看得到哪些节点"，不改场景明暗（否则切视角时整屏闪）。
// 浅色底上 AdditiveBlending 只会更亮、等于隐形，additive:false 时统一换 NormalBlending。
const THEMES = {
  dark: {
    top: "#08161c", bottom: "#0f2c26", glow: "rgba(63,174,116,0.16)",
    fog: 0x0b1e22, fogD: 0.0115, hemi: 0.85, hemiGround: 0x0b1a1f, hemiSky: 0xcdeee2,
    keyI: 2.0, rimI: 1.0, fillI: 18,
    edge: 0.34, additive: true, bloom: 0.55, bloomTh: 0.72,
    dust: 0xb9e8d3, dustOp: 0.62,
    ring: 0x8fd9b6, ringOp: 0.18, grid: 0x7fc9a8, gridOp: 0.10,
    haloOp: 0.30,
    sea: 0x0d3f4a, land: 0x2f7d58, land2: 0x7fb46a, ice: 0xdfeee6, cloud: 0x8fd9c4,
    atmo: 0x64d8a8, atmoI: 0.95, planetRim: 0.55, shellI: 0.85, planetHaloOp: 0.28,
    starA: 0xdfeee9, starB: 0x9fd9c4, starC: 0x7fbde0,
  },
  light: {
    top: "#f2f7f3", bottom: "#c3dccb", glow: "rgba(72,160,110,0.20)",
    fog: 0xdceade, fogD: 0.010, hemi: 1.30, hemiGround: 0x9db8a8, hemiSky: 0xffffff,
    keyI: 2.1, rimI: 0.55, fillI: 6,
    edge: 0.44, additive: false, bloom: 0.14, bloomTh: 0.85,
    dust: 0x3d7d5e, dustOp: 0.34,
    ring: 0x4a9a72, ringOp: 0.32, grid: 0x3f8a66, gridOp: 0.20,
    haloOp: 0.16,
    sea: 0x8fc3d8, land: 0x63a87c, land2: 0x8fc98c, ice: 0xf4fbf7, cloud: 0xffffff,
    atmo: 0x4fae86, atmoI: 0.42, planetRim: 0.30, shellI: 0.40, planetHaloOp: 0.10,
    starA: 0xffffff, starB: 0x63a87c, starC: 0x4a8fc0,
  },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => {
  const c1 = 1.5, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const idOf = (x) => (x && typeof x === "object" ? x.id : x);
const str = (x) => (x == null ? "" : String(x));
const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ============================================================
// 1. 配置状态（initScene 之前也能设置）
// ============================================================

const cfg = {
  graph: { nodes: [], edges: [] },
  role: "child",
  theme: "dark",
  timeline: null,
  filter: { domain: "", status: "" },
  onClick: null,
  mood: "idle",
};

// 运行时（initScene 后存在）
let R = null;
let THREE = null;
let initPromise = null;

// ============================================================
// 2. 样式注入
// ============================================================

const STYLE_ID = "s3d-style";
const CSS = `
.s3d-root{position:absolute;inset:0;overflow:hidden;border-radius:inherit;background:#0b1a1f;user-select:none;-webkit-user-select:none}
.s3d-root>canvas{position:absolute;inset:0;display:block;width:100%;height:100%;outline:none;touch-action:none}
.s3d-vignette{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 78% 72% at 50% 44%,rgba(0,0,0,0) 52%,var(--s3d-vignette,rgba(2,9,10,.55)) 100%)}
.s3d-css2d{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.s3d-css2d>div{pointer-events:none}

/* 节点标签：胶囊在上、细尾在下，尾端圆点落在节点上（CSS2DObject.center=(.5,1)） */
.s3d-label{display:flex;flex-direction:column;align-items:center;font:600 12px/1.2 var(--s3d-font,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif);animation:s3d-in .28s ease-out both;will-change:transform}
.s3d-pill{display:flex;align-items:center;gap:6px;max-width:200px;padding:3px 9px 3px 7px;border-radius:999px;background:var(--s3d-label-bg,rgba(7,20,22,.74));border:1px solid var(--s3d-label-border,rgba(232,241,236,.14));color:var(--s3d-ink,#e8f1ec);white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.45);letter-spacing:.02em}
.s3d-txt{overflow:hidden;text-overflow:ellipsis}
.s3d-dot{width:7px;height:7px;border-radius:50%;background:var(--c,#8fa7a0);box-shadow:0 0 6px var(--c,#8fa7a0);flex:none}
.s3d-tail{width:1px;height:10px;background:linear-gradient(to bottom,var(--s3d-label-border,rgba(232,241,236,.28)),transparent);position:relative}
.s3d-tail::after{content:"";position:absolute;left:50%;bottom:-1px;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:var(--c,#8fa7a0);box-shadow:0 0 8px var(--c,#8fa7a0)}
.s3d-label.is-private .s3d-pill{border-style:dashed;border-color:var(--s3d-private,rgba(180,205,198,.55))}
.s3d-label.is-dropped .s3d-pill{color:var(--s3d-ink-dim,rgba(232,241,236,.6))}
.s3d-label.is-done .s3d-pill{border-color:rgba(243,198,92,.6)}
.s3d-label.is-hl .s3d-pill{border-color:var(--s3d-amber,#f0a24a);color:var(--s3d-ink-strong,#fff6ea);box-shadow:0 0 0 1px rgba(240,162,74,.35),0 0 14px rgba(240,162,74,.45)}
.s3d-label.is-hover .s3d-pill{border-color:rgba(232,241,236,.45)}
/* 星球自己的名字：浮在球体上方 */
.s3d-self{display:flex;flex-direction:column;align-items:center;gap:1px;animation:s3d-in .5s ease-out both;font-family:var(--s3d-font,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif);pointer-events:none}
.s3d-self-name{font-size:15px;font-weight:700;color:var(--s3d-ink-strong,#fff6ea);letter-spacing:.06em;padding:1px 10px;border-radius:999px;background:var(--s3d-self-bg,rgba(6,18,20,.42));text-shadow:0 0 14px rgba(243,198,92,.5),0 1px 2px rgba(0,0,0,.6)}
.s3d-self-sub{font-size:10px;letter-spacing:.24em;padding-left:.24em;margin-top:2px;color:var(--s3d-ink-dim,rgba(232,241,236,.78))}
/* 领域次行星标签 */
.s3d-planet{display:flex;flex-direction:column;align-items:center;gap:1px;font-family:var(--s3d-font,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif);transition:opacity .35s;animation:s3d-in .4s ease-out both}
.s3d-planet-ch{font-size:23px;font-weight:700;line-height:1;color:var(--c);text-shadow:0 0 16px var(--c),0 1px 2px rgba(0,0,0,.5)}
.s3d-planet-nm{font-size:10.5px;letter-spacing:.24em;padding-left:.24em;color:var(--s3d-ink,#e8f1ec);opacity:.66}
.s3d-planet-n{font-size:10px;font-weight:600;color:var(--s3d-ink-dim,rgba(232,241,236,.72));letter-spacing:.06em}
.s3d-planet.is-dim{opacity:.25}
.s3d-sat{display:flex;align-items:center;gap:6px;transform:translateY(-15px);font:600 11px/1.2 var(--s3d-font,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif);color:var(--s3d-ink,#e8f1ec);white-space:nowrap;animation:s3d-in .3s ease-out both}
.s3d-sat-n{min-width:17px;height:17px;border-radius:50%;display:grid;place-items:center;font-size:10px;background:rgba(7,20,22,.8);border:1px solid var(--c,#5f7d78);color:var(--c,#cfe)}
.s3d-sat-t{display:none;background:rgba(7,20,22,.78);border:1px solid var(--c,#5f7d78);padding:2px 8px;border-radius:999px;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.s3d-sat.is-running .s3d-sat-t,.s3d-sat.is-error .s3d-sat-t{display:block}
.s3d-tip{position:absolute;left:0;top:0;z-index:6;pointer-events:none;min-width:120px;max-width:240px;padding:8px 10px;border-radius:10px;background:var(--s3d-tip-bg,rgba(6,18,20,.92));border:1px solid var(--s3d-label-border,rgba(232,241,236,.14));box-shadow:0 8px 24px rgba(0,0,0,.35);color:var(--s3d-ink,#e8f1ec);font:500 12px/1.45 var(--s3d-font,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif);opacity:0;transition:opacity .15s;will-change:transform}
.s3d-tip.is-on{opacity:1}
.s3d-tip-title{font-weight:700;font-size:13px;margin-bottom:3px;word-break:break-all}
.s3d-tip-row{display:flex;align-items:center;gap:6px;color:var(--s3d-ink-dim,rgba(232,241,236,.7))}
.s3d-tip-chip{display:inline-flex;align-items:center;gap:5px;color:var(--c);font-weight:700}
.s3d-tip-chip i{width:8px;height:8px;border-radius:50%;background:var(--c);display:inline-block}
.s3d-tip-lock{display:inline-block;width:8px;height:6px;border:1.5px solid currentColor;border-radius:2px;position:relative;margin:4px 2px 0 1px}
.s3d-tip-lock::before{content:"";position:absolute;left:0;top:-6px;width:4px;height:5px;border:1.5px solid currentColor;border-bottom:0;border-radius:4px 4px 0 0}
@keyframes s3d-in{from{opacity:0;filter:blur(2px)}to{opacity:1;filter:none}}
/* 无障碍：画布是块"图像"，给它一段读屏说明；里面的标签不参与朗读 */
.s3d-a11y{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.s3d-label,.s3d-planet,.s3d-sat,.s3d-self{animation:none}}
/* 浅色主题：CSS2D 标签/提示/卫星编号随界面切浅（画布内颜色由 applyTheme 换） */
body[data-theme="light"] .s3d-root{background:#e3ede4;--s3d-ink:#22332b;--s3d-ink-dim:rgba(34,51,43,.66);--s3d-ink-strong:#141f18;--s3d-label-bg:rgba(255,255,255,.86);--s3d-label-border:rgba(24,44,36,.16);--s3d-private:rgba(120,85,140,.55);--s3d-tip-bg:rgba(255,255,255,.95);--s3d-vignette:rgba(255,255,255,.30)}
body[data-theme="light"] .s3d-pill{text-shadow:none}
body[data-theme="light"] .s3d-label.is-hl .s3d-pill{color:#7a4a12;border-color:#e0a04a}
body[data-theme="light"] .s3d-self-name{color:#22332b;background:rgba(255,255,255,.72);text-shadow:none}
body[data-theme="light"] .s3d-planet-ch{text-shadow:0 0 12px var(--c),0 1px 0 rgba(255,255,255,.5)}
body[data-theme="light"] .s3d-sat{color:#22332b}
body[data-theme="light"] .s3d-sat-n,body[data-theme="light"] .s3d-sat-t{background:rgba(255,255,255,.84);color:#3c5546}
body[data-theme="light"] .s3d-tip{box-shadow:0 8px 24px rgba(24,44,36,.18)}
`;

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS;
  (document.head || document.documentElement).appendChild(st);
}

// ============================================================
// 3. 小工具：贴图 / 着色器片段
// ============================================================

function canvasTex(size, draw, srgb = true) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeTextures() {
  const glow = canvasTex(128, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.18, "rgba(255,255,255,0.55)");
    gr.addColorStop(0.45, "rgba(255,255,255,0.14)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
  const ring = canvasTex(128, (g, s) => {
    g.strokeStyle = "#fff";
    g.lineWidth = 7;
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 0.35;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2 - 17, 0, Math.PI * 2);
    g.stroke();
  });
  // 私密：虚线圈 + 右下角小锁（纯绘制，无字符）
  const priv = canvasTex(128, (g, s) => {
    g.strokeStyle = "#fff";
    g.lineWidth = 4.5;
    g.setLineDash([9, 7]);
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2 - 22, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    const cx = s * 0.8, cy = s * 0.8;
    g.fillStyle = "rgba(6,18,20,0.9)";
    g.beginPath();
    g.arc(cx, cy, 19, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#fff";
    g.lineWidth = 3.5;
    g.beginPath();
    g.arc(cx, cy - 5, 6.5, Math.PI, 0);
    g.stroke();
    g.fillStyle = "#fff";
    g.fillRect(cx - 10, cy - 4, 20, 14);
    g.fillStyle = "rgba(6,18,20,0.9)";
    g.fillRect(cx - 1.5, cy, 3, 6);
  });
  // 轨道环：内虚外亮的一圈细环（行星轨道 / 赤道环共用）
  const orbit = canvasTex(256, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s * 0.5);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.72, "rgba(255,255,255,0.10)");
    gr.addColorStop(0.86, "rgba(255,255,255,0.72)");
    gr.addColorStop(0.94, "rgba(255,255,255,0.18)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
  return { glow, ring, priv, orbit };
}

function makeBackground(theme) {
  return canvasTex(512, (g, s) => {
    const lin = g.createLinearGradient(0, 0, 0, s);
    lin.addColorStop(0, theme.top);
    lin.addColorStop(1, theme.bottom);
    g.fillStyle = lin;
    g.fillRect(0, 0, s, s);
    const rad = g.createRadialGradient(s * 0.5, s * 0.6, 0, s * 0.5, s * 0.6, s * 0.62);
    rad.addColorStop(0, theme.glow);
    rad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rad;
    g.fillRect(0, 0, s, s);
  }, false);
}

/** 三维值噪声 + fbm（星球的海陆/云带在片段着色器里算，不依赖任何贴图下载） */
const GLSL_NOISE = `
float s3dHash(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float s3dNoise(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(s3dHash(i + vec3(0.0,0.0,0.0)), s3dHash(i + vec3(1.0,0.0,0.0)), f.x),
                 mix(s3dHash(i + vec3(0.0,1.0,0.0)), s3dHash(i + vec3(1.0,1.0,0.0)), f.x), f.y),
             mix(mix(s3dHash(i + vec3(0.0,0.0,1.0)), s3dHash(i + vec3(1.0,0.0,1.0)), f.x),
                 mix(s3dHash(i + vec3(0.0,1.0,1.0)), s3dHash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
}
float s3dFbm(vec3 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * s3dNoise(p); p *= 2.02; a *= 0.5; }
  return s;
}
`;

// ============================================================
// 4. 节点数据辅助
// ============================================================

function domainOf(key) {
  return DOMAINS[key] || OTHER_DOMAIN;
}

/** 球面五锚点：都放在朝向默认相机的前半球，但高低/左右错开——
 *  开场一眼能看全五科，又不会像等距五边形那样挤成一条竖线。 */
const ANCHOR_DIRS = [
  [0.00, 0.72, 0.69],   // 德 顶部
  [-0.80, 0.30, 0.52],  // 智 左上
  [0.78, 0.42, 0.46],   // 体 右上
  [0.72, -0.55, 0.42],  // 美 右下
  [-0.18, -0.72, 0.67], // 劳 下方
];

function computeDomainDirs() {
  const out = new Map();
  DOMAIN_KEYS.forEach((k, i) => {
    const v = ANCHOR_DIRS[i % ANCHOR_DIRS.length];
    out.set(k, new THREE.Vector3(v[0], v[1], v[2]).normalize());
  });
  return out;
}

/** 领域锚点（球面上的落点，随聚焦时的 pull 微调） */
function anchorOf(key, out) {
  const dir = R && R.domain ? R.domain.dir.get(key) : null;
  if (!dir) return out.set(0, -R_PLANET * 0.5, 0);
  const pull = R.domain.pull.get(key) || 1;
  return out.copy(dir).multiplyScalar(R_PLANET * pull);
}

function radiusOf(w) {
  const x = Number(w);
  return 0.24 + 0.1 * Math.sqrt(Number.isFinite(x) && x > 0 ? Math.min(x, 400) : 1);
}

function timeOf(s) {
  const t = Date.parse(str(s));
  return Number.isNaN(t) ? NaN : t;
}

function normalizeTimeline(v) {
  if (v == null || v === "") return null;
  const s = str(v).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return { len: 7, v: s };
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { len: 10, v: s.slice(0, 10) };
  return null;
}

// ============================================================
// 5. initScene
// ============================================================

function withTimeout(p, ms, msg) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

export function initScene(containerEl) {
  if (R && R.container && (containerEl === R.container || containerEl === R.hiddenCanvas)) {
    return Promise.resolve();
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (R) disposeScene();
    if (!containerEl || typeof containerEl !== "object" || !containerEl.appendChild) {
      throw new Error("initScene: 缺少容器元素");
    }
    let container = containerEl;
    let hiddenCanvas = null;
    if (containerEl.tagName === "CANVAS") {
      // 兼容旧调用：传入 canvas 时用其父元素作为容器，原 canvas 暂时隐藏
      container = containerEl.parentElement;
      if (!container) throw new Error("initScene: canvas 没有父元素");
      hiddenCanvas = containerEl;
    }
    const mods = await withTimeout(
      Promise.all([
        import("./vendor/three.module.min.js"),
        import("./vendor/OrbitControls.js"),
        import("./vendor/CSS2DRenderer.js"),
      ]),
      4000,
      "3D 模块加载超时"
    );
    THREE = mods[0];
    // 后处理 + 环境贴图：加载失败降级为普通渲染，不影响主体
    let post = null;
    try {
      post = await withTimeout(
        Promise.all([
          import("./vendor/addons/postprocessing/EffectComposer.js"),
          import("./vendor/addons/postprocessing/RenderPass.js"),
          import("./vendor/addons/postprocessing/UnrealBloomPass.js"),
          import("./vendor/addons/postprocessing/OutputPass.js"),
          import("./vendor/addons/environments/RoomEnvironment.js"),
        ]),
        3000,
        "postprocessing timeout"
      );
    } catch (_) {
      post = null;
    }
    let panda = null;
    try {
      panda = await withTimeout(import("./panda3d.js"), 1500, "panda timeout");
    } catch (_) {
      panda = null; // 熊猫可选
    }
    build(container, hiddenCanvas, mods[1].OrbitControls, mods[2], panda, post);
  })();
  const p = initPromise;
  p.then(
    () => { initPromise = null; },
    (e) => {
      initPromise = null;
      try { if (R) disposeScene(); } catch (_) {}
      console.warn("[scene3d] 初始化失败：", e && e.message, e && e.stack);
    }
  );
  return p;
}

function build(container, hiddenCanvas, OrbitControls, CSS2D, pandaMod, post) {
  injectStyle();
  const th0 = THEMES[cfg.theme === "light" ? "light" : "dark"];

  // ---- WebGL ----
  const canvas = document.createElement("canvas");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: true,
    });
  } catch (e) {
    throw new Error("WebGL 不可用");
  }
  if (!renderer.getContext()) throw new Error("WebGL 不可用");
  canvas.tabIndex = 0;   // 可聚焦 → 方向键旋转 / 加减缩放

  // ---- DOM ----
  if (hiddenCanvas) {
    hiddenCanvas.dataset.s3dPrevDisplay = hiddenCanvas.style.display || "";
    hiddenCanvas.style.display = "none";
  }
  let restorePos = null;
  try {
    if (getComputedStyle(container).position === "static") {
      restorePos = container.style.position || "";
      container.style.position = "relative";
    }
  } catch (_) {}

  const root = document.createElement("div");
  root.className = "s3d-root";
  root.appendChild(canvas);
  const vignette = document.createElement("div");
  vignette.className = "s3d-vignette";
  root.appendChild(vignette);
  const css2d = new CSS2D.CSS2DRenderer();
  css2d.domElement.className = "s3d-css2d";
  css2d.domElement.style.position = "absolute";
  css2d.domElement.style.top = "0";
  css2d.domElement.style.left = "0";
  root.appendChild(css2d.domElement);
  const tip = document.createElement("div");
  tip.className = "s3d-tip";
  root.appendChild(tip);
  const a11y = document.createElement("p");
  a11y.className = "s3d-a11y";
  a11y.textContent = "记忆星球：中心是孩子本人，五颗次行星分别是德智体美劳，悬浮的星星是记忆节点。" +
    "方向键旋转、+/- 缩放、Home 回到全景；点击星星查看详情。";
  root.appendChild(a11y);
  canvas.setAttribute("aria-label", "记忆星球三维视图");
  canvas.setAttribute("aria-describedby", "s3d-desc-a11y");
  a11y.id = "s3d-desc-a11y";
  container.appendChild(root);

  renderer.setClearColor(0x0b1a1f, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  // ---- 场景 ----
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 700);
  camera.position.set(0, 12, 34);
  const tex = makeTextures();
  const bgTex = { dark: makeBackground(THEMES.dark), light: makeBackground(THEMES.light) };
  scene.background = cfg.theme === "light" ? bgTex.light : bgTex.dark;
  scene.fog = new THREE.FogExp2(th0.fog, th0.fogD);

  // PMREM 环境反射：让 PBR 材质有商业级高光层次（失败则跳过）
  let envTex = null, pmrem = null;
  if (post && post[4] && post[4].RoomEnvironment) {
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      envTex = pmrem.fromScene(new post[4].RoomEnvironment(renderer), 0.04).texture;
      scene.environment = envTex;
    } catch (_) { envTex = null; }
  }

  const hemi = new THREE.HemisphereLight(th0.hemiSky, th0.hemiGround, th0.hemi);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e0, th0.keyI);  // 恒星主光（暖白）
  key.position.set(7, 11, 9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fe0bc, th0.rimI);  // 冷绿轮廓光
  rim.position.set(-9, 3, -10);
  scene.add(rim);
  const fill = new THREE.PointLight(0xf0a24a, th0.fillI, 46, 1.7); // 暖色补光
  fill.position.set(0, -6, 8);
  scene.add(fill);

  const world = new THREE.Group();
  scene.add(world);

  // 领域锚点（球面斐波那契）
  const dirs = computeDomainDirs();
  const domain = {
    dir: dirs,        // key -> 球面单位方向
    pull: new Map(),  // key -> 半径倍率（聚焦时略抬）
  };
  for (const k of DOMAIN_KEYS) domain.pull.set(k, 1);

  // ---------------------------------------------------------
  // 星球本体：海陆/极冰/云带 + 昼夜分界 + 边缘辉光（全在着色器里算）
  // ---------------------------------------------------------
  // ShaderMaterial 要自己带上 three 的雾 uniform（fog:true 时 renderer 会去更新它们）
  const planetUniforms = Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
    uTime: { value: 0 },
    uSea: { value: new THREE.Color(th0.sea) },
    uLand: { value: new THREE.Color(th0.land) },
    uLand2: { value: new THREE.Color(th0.land2) },
    uIce: { value: new THREE.Color(th0.ice) },
    uCloud: { value: new THREE.Color(th0.cloud) },
    uRim: { value: new THREE.Color(th0.atmo) },
    uRimI: { value: th0.planetRim },
    uLight: { value: new THREE.Vector3(7, 11, 9).normalize() },
  });
  const planetMat = new THREE.ShaderMaterial({
    uniforms: planetUniforms,
    fog: true,
    vertexShader: `
      varying vec3 vN;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSea; uniform vec3 uLand; uniform vec3 uLand2; uniform vec3 uIce; uniform vec3 uCloud;
      uniform vec3 uRim; uniform float uRimI; uniform vec3 uLight;
      varying vec3 vN;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${GLSL_NOISE}
      void main(){
        vec3 n = normalize(vN);
        vec3 p = normalize(vWorld) * 2.6;
        float c = s3dFbm(p + vec3(uTime * 0.012, 0.0, uTime * 0.006));
        float land = smoothstep(0.46, 0.58, c);
        float detail = s3dFbm(p * 3.1);
        vec3 col = mix(uSea, mix(uLand, uLand2, clamp(detail * 1.4 - 0.25, 0.0, 1.0)), land);
        float coast = smoothstep(0.40, 0.46, c) * (1.0 - land);
        col = mix(col, uLand2, coast * 0.35);
        float ice = smoothstep(0.80, 0.94, abs(n.y) + (detail - 0.5) * 0.10);
        col = mix(col, uIce, ice);
        float cl = s3dFbm(vec3(p.x * 1.3 + uTime * 0.02, p.y * 3.4, p.z * 1.3 - uTime * 0.014));
        float cloud = smoothstep(0.52, 0.72, cl) * (1.0 - ice * 0.5);
        col = mix(col, uCloud, cloud * 0.42);
        float lam = dot(n, normalize(uLight));
        float day = smoothstep(-0.22, 0.55, lam);
        col *= 0.30 + 0.92 * day;
        vec3 vd = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - clamp(dot(n, vd), 0.0, 1.0), 2.6);
        col += uRim * fres * uRimI;
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
  const planetGeo = new THREE.SphereGeometry(R_PLANET, 96, 64);
  const planet = new THREE.Mesh(planetGeo, planetMat);
  planet.name = "s3d-planet";
  world.add(planet);

  // 大气壳：外层辉光，背面渲染 + 叠加混合
  const atmoMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    uniforms: {
      uColor: { value: new THREE.Color(th0.atmo) },
      uIntensity: { value: th0.atmoI },
      uPower: { value: 3.1 },
      uLight: { value: planetUniforms.uLight.value },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vWorld;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uIntensity; uniform float uPower; uniform vec3 uLight;
      varying vec3 vN; varying vec3 vWorld;
      void main(){
        vec3 n = normalize(vN);
        vec3 vd = normalize(cameraPosition - vWorld);
        float f = pow(clamp(dot(n, vd) + 1.0, 0.0, 1.0), uPower);
        float lit = 0.42 + 0.58 * smoothstep(-0.5, 0.9, dot(-n, normalize(uLight)));
        gl_FragColor = vec4(uColor, f * uIntensity * lit);
      }`,
  });
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(R_PLANET * 1.055, 64, 48), atmoMat);
  world.add(atmo);

  // 星球外层柔光（bloom 拾取用；浅色主题下换普通混合，靠颜色本身出层次）
  const haloMat = new THREE.SpriteMaterial({
    map: tex.glow, color: th0.atmo, transparent: true, opacity: th0.planetHaloOp,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const planetHalo = new THREE.Sprite(haloMat);
  planetHalo.scale.setScalar(R_PLANET * 3.1);
  world.add(planetHalo);

  // 经纬球网：让球体"读得出来是个球"
  const gridMat = new THREE.LineBasicMaterial({
    color: th0.grid, transparent: true, opacity: th0.gridOp, depthWrite: false,
  });
  const gridGroup = new THREE.Group();
  for (const lat of [-45, 0, 45]) {
    const y = Math.sin((lat * Math.PI) / 180) * R_PLANET;
    const r = Math.cos((lat * Math.PI) / 180) * R_PLANET;
    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
  }
  for (let m = 0; m < 4; m++) {
    const pts = [];
    const a = (m / 4) * Math.PI;
    for (let i = 0; i <= 128; i++) {
      const t = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        Math.cos(t) * R_PLANET * Math.cos(a),
        Math.sin(t) * R_PLANET,
        Math.cos(t) * R_PLANET * Math.sin(a)
      ));
    }
    gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
  }
  world.add(gridGroup);

  // ---------------------------------------------------------
  // 星空：三层，远近不同大小与漂移速度（深空靠"深度"而不是数量堆）
  // ---------------------------------------------------------
  const starLayers = [];
  const starSpecs = [
    { r0: 46, r1: 96, size: 0.55, op: 0.85, drift: 0.006, n: 520 },
    { r0: 96, r1: 170, size: 0.95, op: 0.70, drift: 0.003, n: 300 },
    { r0: 170, r1: 280, size: 1.70, op: 0.55, drift: 0.0016, n: 160 },
  ];
  starSpecs.forEach((sp, li) => {
    const pos = new Float32Array(sp.n * 3);
    for (let i = 0; i < sp.n; i++) {
      const r = sp.r0 + Math.random() * (sp.r1 - sp.r0);
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph);
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: sp.size, map: tex.glow, transparent: true, opacity: sp.op,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
      color: li === 2 ? th0.starC : li === 1 ? th0.starB : th0.starA,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);
    starLayers.push({ points, mat, drift: sp.drift });
  });

  // 近场星尘（星球周围一圈微尘，随场景缓慢自转）
  const DUST = 340;
  const dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    const r = R_PLANET * 1.4 + Math.random() * 22;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    dustPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    dustPos[i * 3 + 1] = r * Math.cos(ph) * 0.75;
    dustPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    size: 0.3, map: tex.glow, color: th0.dust, transparent: true, opacity: th0.dustOp,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  scene.add(dust);

  // 赤道轨道环：星球外侧一圈细环，视觉上锚定"这是一颗行星"
  const orbitRingMat = new THREE.MeshBasicMaterial({
    map: tex.orbit, color: th0.ring, transparent: true, opacity: th0.ringOp,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const orbitRing = new THREE.Mesh(new THREE.PlaneGeometry(R_PLANET * 6.2, R_PLANET * 6.2), orbitRingMat);
  orbitRing.rotation.x = -Math.PI / 2 + 0.05;
  orbitRing.position.y = -0.35;
  world.add(orbitRing);

  // ---------------------------------------------------------
  // 领域次行星：球体 + 大气壳 + 轨道环 + 光晕 + 中文标签
  // ---------------------------------------------------------
  const planetGeoSmall = new THREE.IcosahedronGeometry(1, 3);
  const domainObjs = new Map();
  DOMAIN_KEYS.forEach((k) => {
    const d = DOMAINS[k];
    const dir = dirs.get(k);
    const g = new THREE.Group();
    g.position.copy(dir).multiplyScalar(R_PLANET);
    // 让每颗行星的"北极"朝向球心外法线，轨道环才贴着球面
    g.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone()));

    const bodyMat = new THREE.MeshStandardMaterial({
      color: d.hex, roughness: 0.55, metalness: 0.12,
      emissive: new THREE.Color(d.hex), emissiveIntensity: 0.34,
      transparent: true, envMapIntensity: 0.8,
    });
    const body = new THREE.Mesh(planetGeoSmall, bodyMat);
    body.scale.setScalar(0.86);
    g.add(body);

    const shellMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
      uniforms: { uColor: { value: new THREE.Color(d.hex) }, uI: { value: th0.shellI } },
      vertexShader: `varying vec3 vN; varying vec3 vW;
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz; vN = normalize(mat3(modelMatrix)*normal);
        gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform vec3 uColor; uniform float uI; varying vec3 vN; varying vec3 vW;
        void main(){ vec3 n = normalize(vN); vec3 vd = normalize(cameraPosition - vW);
        float f = pow(clamp(dot(n, vd) + 1.0, 0.0, 1.0), 3.0);
        gl_FragColor = vec4(uColor, f * uI); }`,
    });
    const shell = new THREE.Mesh(planetGeoSmall, shellMat);
    shell.scale.setScalar(1.1);
    g.add(shell);

    const ringPts = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * RING_R, 0, Math.sin(a) * RING_R));
    }
    const ringMat = new THREE.LineBasicMaterial({
      color: d.hex, transparent: true, opacity: th0.ringOp, depthWrite: false,
    });
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), ringMat);
    ring.rotation.z = 0.16;
    g.add(ring);

    const haloMatD = new THREE.SpriteMaterial({
      map: tex.glow, color: d.hex, transparent: true, opacity: th0.haloOp,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const halo = new THREE.Sprite(haloMatD);
    halo.scale.setScalar(7.5);
    g.add(halo);

    const el = document.createElement("div");
    el.className = "s3d-planet";
    el.style.setProperty("--c", d.css);
    const ch = document.createElement("div");
    ch.className = "s3d-planet-ch";
    ch.textContent = d.ch;
    const nm = document.createElement("div");
    nm.className = "s3d-planet-nm";
    nm.textContent = d.name;
    const cnt = document.createElement("div");
    cnt.className = "s3d-planet-n";
    cnt.textContent = "";
    el.appendChild(ch);
    el.appendChild(nm);
    el.appendChild(cnt);
    const lab = new CSS2D.CSS2DObject(el);
    lab.position.set(0, 3.6, 0);
    lab.center.set(0.5, 1);
    g.add(lab);

    world.add(g);
    domainObjs.set(k, {
      key: k, group: g, body, bodyMat, shell, shellMat, ring, ringMat, halo, haloMatD,
      lab, el, countEl: cnt, count: -1, alpha: 1, dimmed: false, phase: Math.random() * 6.28,
    });
  });

  // 边：一个 LineSegments，RGBA 顶点色
  const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });

  // 共享几何
  const sphereGeo = new THREE.SphereGeometry(1, 24, 18);
  const satGeo = new THREE.IcosahedronGeometry(1, 1);

  // ---- 控制 ----
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.66;
  controls.zoomSpeed = 0.8;
  controls.enablePan = false;               // 星球居中，平移只会让人迷路
  controls.minDistance = 13;                // 不能进到星球里
  controls.maxDistance = 78;
  controls.minPolarAngle = 0.22;
  controls.maxPolarAngle = Math.PI - 0.22;
  controls.autoRotate = !reduceMotion();
  controls.autoRotateSpeed = 0.42;
  controls.target.set(0, 0, 0);

  // ---------------------------------------------------------
  // 熊猫小视窗（可选，左下角，不吃主场景资源）
  // ---------------------------------------------------------
  let panda = null;
  if (pandaMod && typeof pandaMod.createPanda === "function") {
    try {
      pandaMod.useThree && pandaMod.useThree(THREE);
      const pScene = new THREE.Scene();
      if (envTex) pScene.environment = envTex;
      pScene.add(new THREE.HemisphereLight(0xffffff, 0x2a3a34, 1.1));
      const pk = new THREE.DirectionalLight(0xfff2dd, 1.7);
      pk.position.set(3, 6, 8);
      pScene.add(pk);
      const pkRim = new THREE.DirectionalLight(0x8fe0bc, 0.9);
      pkRim.position.set(-4, 2, -5);
      pScene.add(pkRim);
      const group = pandaMod.createPanda(THREE, { scale: 1 });
      group.rotation.y = 0.38;
      if (envTex) group.traverse((o) => {
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of ms) if ("envMapIntensity" in m) m.envMapIntensity = 0.55;
      });
      pScene.add(group);
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(Math.max(size.x, size.z) * 0.55, 32),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(center.x, box.min.y + 0.02, center.z);
      shadow.scale.set(1, 0.7, 1);
      pScene.add(shadow);
      const pCam = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
      const dist = (size.y * 1.35) / (2 * Math.tan((28 * Math.PI) / 360));
      pCam.position.set(center.x, center.y + size.y * 0.12, center.z + dist);
      pCam.lookAt(center.x, center.y, center.z);
      panda = { mod: pandaMod, scene: pScene, cam: pCam, group, rect: { x: 0, y: 0, w: 0, h: 0, on: false }, last: -1, sig: "" };
      pandaMod.setPandaMood(group, cfg.mood);
    } catch (e) {
      console.debug("[scene3d] 熊猫不可用：", e && e.message);
      panda = null;
    }
  }

  R = {
    container, hiddenCanvas, restorePos, root, canvas, renderer, css2d, CSS2D, tip, a11y,
    scene, camera, controls, world, tex, bgTex, hemi, key, rim, fill,
    planet, planetGeo, planetMat, planetUniforms, atmo, atmoMat, planetHalo, haloMat,
    gridMat, gridGroup, orbitRing, orbitRingMat,
    dustMat, dust, starLayers,
    domain, domainObjs, planetGeoSmall,
    composer: null, bloom: null, envTex, pmrem,
    edgeMat, edgeLines: null, edgeCap: 0, edgeList: [], edgePool: [],
    sphereGeo, satGeo,
    nodes: new Map(),   // id -> ns
    order: [],          // ns 列表（稳定）
    selfId: null, selfNs: null, selfLabel: null,
    additive: new Set(),
    addTexes: [tex.orbit],
    sim: { alpha: 0 },
    w: 0, h: 0, dpr: 1,
    running: false, raf: 0, last: 0, time: 0, frame: 0, idleAcc: 0,
    hidden: typeof document !== "undefined" && document.hidden,
    intersecting: true,
    lost: false,
    ready: false,
    failed: false,
    budget: { frames: 0, sum: 0, done: false, samples: 0, low: false },
    lastInteract: -1e9,
    dragging: false,
    reduce: reduceMotion(),
    spin: !reduceMotion(),
    pointer: { x: 0, y: 0, ndcX: 0, ndcY: 0, inside: false, dirty: false, downX: 0, downY: 0, downT: 0, down: false, type: "mouse" },
    hover: null,
    focusId: null,
    fly: null,
    raycaster: new THREE.Raycaster(),
    pickList: [],
    ndc: new THREE.Vector2(),
    v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), v4: new THREE.Vector3(),
    col: new THREE.Color(), col2: new THREE.Color(), gray: new THREE.Color(0x7d8b88), amber: new THREE.Color(AMBER),
    plan: null, planFading: [],
    bursts: [],
    labelBudget: 8,
    panda,
    listeners: [], observers: [],
    lostTimer: 0,
    theme: cfg.theme === "light" ? "light" : "dark",
  };
  ensureScratch();
  regAdditive(haloMat);
  for (const s of starLayers) regAdditive(s.mat);
  regAdditive(dustMat);
  regAdditive(orbitRingMat);

  // ---- 后处理链：RenderPass → Bloom → Output（加载失败自动降级普通渲染）----
  if (post && post[0] && post[1] && post[2] && post[3]) {
    try {
      const composer = new post[0].EffectComposer(renderer);
      composer.addPass(new post[1].RenderPass(scene, camera));
      const bloom = new post[2].UnrealBloomPass(new THREE.Vector2(512, 512), th0.bloom, 0.55, th0.bloomTh);
      composer.addPass(bloom);
      composer.addPass(new post[3].OutputPass());
      R.composer = composer;
      R.bloom = bloom;
    } catch (_) {
      R.composer = null;
      R.bloom = null;
    }
  }

  wireEvents();
  applyTheme();
  syncGraph(true);
  measure();
  fitOverview(true);
  R.ready = true;
  if (R.w > 0 && R.h > 0) renderFrame(0, true);
  updateRunning();
}

// ============================================================
// 6. 事件与生命周期
// ============================================================

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  R.listeners.push([target, type, fn, opts]);
}

function wireEvents() {
  const { canvas, controls } = R;
  controls.addEventListener("start", onControlStart);
  controls.addEventListener("end", onControlEnd);

  on(canvas, "pointermove", (e) => {
    const p = R.pointer;
    const rect = canvas.getBoundingClientRect();
    p.x = e.clientX - rect.left;
    p.y = e.clientY - rect.top;
    p.type = e.pointerType || "mouse";
    if (rect.width > 0 && rect.height > 0) {
      p.ndcX = (p.x / rect.width) * 2 - 1;
      p.ndcY = -(p.y / rect.height) * 2 + 1;
    }
    p.inside = true;
    p.dirty = true;
  });
  on(canvas, "pointerleave", () => {
    R.pointer.inside = false;
    R.pointer.dirty = false;
    setHover(null);
  });
  on(canvas, "pointerdown", (e) => {
    const p = R.pointer;
    p.down = true;
    p.downX = e.clientX;
    p.downY = e.clientY;
    p.downT = nowMs();
    R.lastInteract = nowMs();
    stopAutoRotate();
    wake();
  });
  on(canvas, "pointerup", (e) => {
    const p = R.pointer;
    if (!p.down) return;
    p.down = false;
    const moved = Math.hypot(e.clientX - p.downX, e.clientY - p.downY);
    if (moved > 6 || nowMs() - p.downT > 700) return;
    const rect = canvas.getBoundingClientRect();
    handleTap(e.clientX - rect.left, e.clientY - rect.top, rect);
  });
  on(canvas, "wheel", () => { R.lastInteract = nowMs(); stopAutoRotate(); wake(); }, { passive: true });

  // 键盘：方向键旋转 / +- 缩放 / Home 全景（画布可聚焦，属于无障碍基本要求）
  on(canvas, "keydown", (e) => {
    if (!R.ready) return;
    const step = 0.16;
    let hit = true;
    switch (e.key) {
      case "ArrowLeft": rotateAround(-step, 0); break;
      case "ArrowRight": rotateAround(step, 0); break;
      case "ArrowUp": rotateAround(0, -step * 0.7); break;
      case "ArrowDown": rotateAround(0, step * 0.7); break;
      case "+": case "=": dolly(0.88); break;
      case "-": case "_": dolly(1.14); break;
      case "Home": fitOverview(false); break;
      default: hit = false;
    }
    if (hit) {
      e.preventDefault();
      R.lastInteract = nowMs();
      stopAutoRotate();
      wake();
    }
  });

  on(canvas, "webglcontextlost", (e) => {
    e.preventDefault();
    R.lost = true;
    updateRunning();
    clearTimeout(R.lostTimer);
    R.lostTimer = setTimeout(() => {
      if (R && R.lost) triggerFallback("WebGL 上下文丢失");
    }, 4000);
  });
  on(canvas, "webglcontextrestored", () => {
    R.lost = false;
    clearTimeout(R.lostTimer);
    updateRunning();
  });

  on(document, "visibilitychange", () => {
    R.hidden = document.hidden;
    updateRunning();
  });

  observe(R.container);
}

/** 容器尺寸 / 可见性监听（attachTo 换挂载点时复用） */
function observe(container) {
  if (!R) return;
  for (const ob of R.observers) { try { ob.disconnect(); } catch (_) {} }
  R.observers.length = 0;
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => { if (R) { measure(); updateRunning(); } });
    ro.observe(container);
    R.observers.push(ro);
  } else {
    on(window, "resize", () => { measure(); updateRunning(); });
  }
  if (typeof IntersectionObserver !== "undefined") {
    const io = new IntersectionObserver((entries) => {
      if (!R) return;
      for (const en of entries) R.intersecting = en.isIntersecting;
      updateRunning();
    });
    io.observe(container);
    R.observers.push(io);
  }
}

function onControlStart() {
  if (!R) return;
  R.dragging = true;
  R.lastInteract = nowMs();
  R.fly = null;
  stopAutoRotate();
  hideTip();
}
function onControlEnd() {
  if (!R) return;
  R.dragging = false;
  R.lastInteract = nowMs();
}
function stopAutoRotate() {
  if (R && R.controls) R.controls.autoRotate = false;
}
/** 有人操作 / 有动画需求时把渲染唤醒 */
function wake() {
  if (!R) return;
  R.idleAcc = 0;
  updateRunning();
}

function measure() {
  if (!R) return;
  const el = R.container;
  const w = Math.floor(el.clientWidth || 0);
  const h = Math.floor(el.clientHeight || 0);
  const many = R.order.length > 70;
  const cap = many ? 1.5 : 2;
  const dpr = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, R.budget.low ? 1.35 : cap);
  if (w === R.w && h === R.h && dpr === R.dpr) return;
  R.w = w;
  R.h = h;
  R.dpr = dpr;
  if (w <= 0 || h <= 0) return;
  R.renderer.setPixelRatio(dpr);
  R.renderer.setSize(w, h, false);
  R.css2d.setSize(w, h);
  if (R.composer) { try { R.composer.setSize(w, h); } catch (_) {} }
  R.camera.aspect = w / h;
  R.camera.updateProjectionMatrix();
  R.labelBudget = w * h > 700000 ? 14 : w * h > 300000 ? 10 : 6;
  layoutPandaRect();
}

function layoutPandaRect() {
  if (!R.panda) return;
  const r = R.panda.rect;
  r.on = R.w >= 380 && R.h >= 280;
  const s = Math.round(clamp(R.h * 0.3, 96, 170));
  r.w = Math.round(s * 0.82);
  r.h = s;
  r.x = 10;
  r.y = 8; // 距底部（WebGL 视口原点在左下）
  R.panda.cam.aspect = r.w / r.h;
  R.panda.cam.updateProjectionMatrix();
}

function canRun() {
  return R && R.ready && !R.failed && !R.lost && !R.hidden && R.intersecting && R.w > 0 && R.h > 0;
}

/** 是否有"必须满帧"的动画：交互 / 相机飞行 / 布局收敛 / 特效 / 悬停 / 规划卫星 */
function busyFrames() {
  if (!R) return false;
  if (R.fly || R.dragging || R.controls.autoRotate) return true;
  if (R.sim.alpha > 0 || R.bursts.length || R.planFading.length) return true;
  if (R.hover || R.plan) return true;
  if (R.pointer.dirty) return true;
  if (R.panda && R.panda.rect.on) return true;
  return nowMs() - R.lastInteract < 1200;
}

function updateRunning() {
  if (!R) return;
  const want = canRun();
  if (want && !R.running) {
    R.running = true;
    R.last = nowMs();
    R.raf = requestAnimationFrame(loop);
  } else if (!want && R.running) {
    R.running = false;
    cancelAnimationFrame(R.raf);
    R.raf = 0;
    hideTip();
  }
}

function loop() {
  if (!R || !R.running) return;
  R.raf = requestAnimationFrame(loop);
  const t = nowMs();
  const dt = Math.min(0.05, Math.max(0, (t - R.last) / 1000));
  R.last = t;
  if (R.container.clientWidth !== R.w || R.container.clientHeight !== R.h) {
    measure();
    if (!canRun()) { updateRunning(); return; }
  }
  const busy = busyFrames();
  if (!busy) {
    // 空闲：只保留星球自转，帧率降到 IDLE_FPS；reduced-motion 时干脆停帧等下一次交互
    R.idleAcc += dt;
    if (R.reduce) {
      if (R.idleAcc > 0.4) R.running = false, cancelAnimationFrame(R.raf), R.raf = 0;
      return;
    }
    if (R.idleAcc < 1 / IDLE_FPS) return;
    R.idleAcc = 0;
  } else {
    R.idleAcc = 0;
  }
  renderFrame(dt, false);
  if (dt > 0) budgetCheck(dt);
}

/** 自适应画质：连续若干帧平均帧时超预算就降档（DPR → 关 bloom → 砍熊猫小窗），只降不升 */
function budgetCheck(dt) {
  const b = R.budget;
  if (b.done) return;
  b.frames++;
  b.sum += dt;
  if (b.frames < 90) return;
  const avg = b.sum / b.frames;
  b.frames = 0; b.sum = 0;
  b.samples++;
  if (avg <= 0.045) { b.done = true; return; }   // ≥22fps，合格
  if (b.samples >= 4) { b.done = true; return; }
  if (!b.low) {
    b.low = true;
    R.w = -1; measure();                          // 降 DPR
    if (R.bloom) R.bloom.strength = 0;            // 关掉最贵的一段
  } else if (R.panda) {
    R.panda.rect.on = false;
  }
}

function triggerFallback(reason) {
  if (!R || R.failed) return;
  R.failed = true;
  updateRunning();
  try {
    if (typeof window !== "undefined" && typeof window.__pandaFallback2D === "function") window.__pandaFallback2D(reason);
  } catch (e) {
    console.warn("[scene3d] 2D 兜底回调异常：", e && e.message);
  }
}

// ============================================================
// 7. 图数据同步 + 球面布局
// ============================================================

function syncGraph(initial) {
  if (!R) return;
  const data = cfg.graph;
  const seen = new Set();
  const added = [];
  let maxLast = -Infinity;
  for (const n of data.nodes) {
    const t = timeOf(n.last_seen);
    if (t > maxLast) maxLast = t;
  }
  R.refTime = Number.isFinite(maxLast) ? Math.max(maxLast, Date.now() - 86400000 * 30) : Date.now();

  // 星球本人（中心）：权重最高的 person
  if (!R.selfId || !data.nodes.some((n) => n.id === R.selfId)) {
    let best = null;
    for (const n of data.nodes) if (n.type === "person" && (!best || (+n.weight || 0) > (+best.weight || 0))) best = n;
    R.selfId = best ? best.id : null;
  }

  for (const n of data.nodes) {
    seen.add(n.id);
    let ns = R.nodes.get(n.id);
    if (!ns) {
      ns = createNodeState(n);
      R.nodes.set(n.id, ns);
      R.order.push(ns);
      added.push(ns);
    } else {
      ns.dying = false;
      ns.data = n;
    }
    styleNode(ns);
  }
  for (const ns of R.order) {
    if (!seen.has(ns.id) && !ns.dying) {
      ns.dying = true;
      ns.visTarget = 0;
    }
  }

  rebuildEdges();
  relayout();
  applyVisibility();

  if (added.length) {
    for (const ns of added) {
      ns.appear = 0;
      ns.appearDelay = initial ? 0.15 + Math.random() * 0.4 : 0.05;
    }
  }
  if (R.order.length > 70) measure();
  wake();
}

function createNodeState(n) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.06, transparent: true, envMapIntensity: 0.7 });
  const mesh = new THREE.Mesh(R.sphereGeo, mat);
  mesh.userData.nid = n.id;
  group.add(mesh);
  const halo = new THREE.Sprite(regAdditive(new THREE.SpriteMaterial({
    map: R.tex.glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  })));
  group.add(halo);
  // 标签：胶囊在上、细尾在下，尾端圆点落在节点上（center=(0.5,1)）
  const el = document.createElement("div");
  el.className = "s3d-label";
  const pill = document.createElement("span");
  pill.className = "s3d-pill";
  const dot = document.createElement("span");
  dot.className = "s3d-dot";
  const txt = document.createElement("span");
  txt.className = "s3d-txt";
  pill.appendChild(dot);
  pill.appendChild(txt);
  const tail = document.createElement("span");
  tail.className = "s3d-tail";
  el.appendChild(pill);
  el.appendChild(tail);
  const label = new R.CSS2D.CSS2DObject(el);
  label.center.set(0.5, 1);
  label.visible = false;
  group.add(label);
  group.visible = false;
  R.world.add(group);
  return {
    id: n.id, data: n, group, mesh, mat, halo, label, el, pillar: pill, txt,
    ring: null, priv: null,
    p: new THREE.Vector3(), wp: new THREE.Vector3(), tp: new THREE.Vector3(),
    u: 0, v: 0, h: SHELL_H0,
    mob: 1, r: 0.4, rec: 1, baseOpacity: 1, bob: Math.random() * 6.28,
    vis: 0, visTarget: 1, dim: 1, dimTarget: 1,
    appear: 0, appearDelay: 0, dying: false, placed: false,
    pulseUntil: 0, spawnedAt: 0,
    labelCls: "", sig: "",
  };
}

function styleNode(ns) {
  const n = ns.data;
  const sig = [n.domain, n.status, !!n.private, n.weight, n.last_seen, n.label].join("|");
  if (sig === ns.sig) return;
  ns.sig = sig;
  const d = domainOf(n.domain);
  ns.r = radiusOf(n.weight);
  const lt = timeOf(n.last_seen);
  ns.rec = Number.isFinite(lt) ? clamp(1 - (R.refTime - lt) / (RECENT_DAYS * 86400000), 0.28, 1) : 0.4;
  const dropped = n.status === "dropped";
  const c = R.col.setHex(d.hex);
  if (dropped) c.lerp(R.gray, 0.65);
  ns.mat.color.copy(c);
  ns.mat.emissive.copy(c);
  ns.mat.emissiveIntensity = dropped ? 0.14 : 0.3 + 0.7 * ns.rec;
  ns.baseOpacity = dropped ? 0.46 : 1;
  ns.halo.material.color.copy(c);
  ns.haloBase = dropped ? 0.08 : 0.18 + 0.44 * ns.rec;

  // 完成 = 金环
  if (n.status === "done") {
    if (!ns.ring) {
      ns.ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: R.tex.ring, color: GOLD, transparent: true, depthWrite: false, fog: false }));
      ns.group.add(ns.ring);
    }
  } else if (ns.ring) {
    ns.group.remove(ns.ring);
    ns.ring.material.dispose();
    ns.ring = null;
  }
  // 私密 = 虚线圈 + 小锁
  if (n.private) {
    if (!ns.priv) {
      ns.priv = new THREE.Sprite(new THREE.SpriteMaterial({ map: R.tex.priv, color: 0xc9ddd6, transparent: true, depthWrite: false, fog: false }));
      ns.group.add(ns.priv);
    }
  } else if (ns.priv) {
    ns.group.remove(ns.priv);
    ns.priv.material.dispose();
    ns.priv = null;
  }

  let text = str(n.label || n.id);
  if (text.length > 12) text = text.slice(0, 11) + "…";
  ns.txt.textContent = text;
  ns.el.style.setProperty("--c", d.css);
  ns.labelCls = "";
}

/**
 * 球面布局（确定性，只在数据变化时算一次）：
 *   1) 每个领域的节点在该领域的切平面 (u,v) 上按黄金角螺旋铺开（大权重靠内）
 *   2) 网格分桶 + 有限迭代的局部松弛，把重叠的推开（成本近似 O(n)）
 *   3) 世界坐标 = 领域法线 × (R + h) + 切平面 (u,v) —— 天然浮在球面外侧，不穿模
 */
function relayout() {
  if (!R) return;
  const byDomain = new Map();
  for (const k of DOMAIN_KEYS) byDomain.set(k, []);
  const others = [];
  for (const ns of R.order) {
    if (ns.id === R.selfId) continue;
    const list = byDomain.get(ns.data.domain);
    if (list) list.push(ns);
    else others.push(ns);
  }
  for (const k of DOMAIN_KEYS) layoutDomain(byDomain.get(k), domainFrame(k));
  layoutOrbit(others);

  // 首次落位：从星球内部飞出来；退场：往球心缩回去
  for (const ns of R.order) {
    if (ns.id === R.selfId) { ns.tp.set(0, 0, 0); ns.p.set(0, 0, 0); ns.placed = true; continue; }
    if (ns.dying) { ns.tp.multiplyScalar(0.02); continue; }
    if (!ns.placed) {
      ns.placed = true;
      ns.p.copy(ns.tp).multiplyScalar(0.22);
    }
  }
  R.sim.alpha = 1;
  updateSelfLabel();
}

/** 领域切平面基：法线 = 球面方向；另两轴取"尽量朝向默认相机"的那组，读起来永远正对观众 */
function domainFrame(key) {
  const n = (R.domain.dir.get(key) || new THREE.Vector3(0, 0, 1)).clone().normalize();
  const view = new THREE.Vector3(0, 0.36, 1).normalize();
  const u = view.clone().addScaledVector(n, -view.dot(n));
  if (u.lengthSq() < 1e-4) u.set(0, 1, 0).addScaledVector(n, -n.y);
  u.normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { n, u, v };
}

function layoutDomain(list, frame) {
  const n = list.length;
  if (!n) return;
  list.sort(byWeightDesc);                       // 大权重在前 → 靠内、靠上
  const GOLD = 2.39996323;
  const step = clamp((PATCH_EDGE * 0.55) / Math.sqrt(n + 1), 0.7, 2.8);
  for (let i = 0; i < n; i++) {
    const ns = list[i];
    const rr = step * Math.sqrt(i) * 1.12;
    const a = i * GOLD;
    ns.u = Math.cos(a) * rr;
    ns.v = Math.sin(a) * rr;
    // 高度：越重要越离球面远；最外圈压回来，免得飘成一片云
    const w = Math.min(+ns.data.weight || 1, 60);
    const hw = Math.log1p(w) / Math.log1p(60);
    const edge = clamp(rr / PATCH_EDGE, 0, 1);
    ns.h = SHELL_H0 + SHELL_STEP * (0.45 + 1.5 * hw) * (1 - 0.55 * edge * edge);
  }
  relax2D(list);
  for (const ns of list) {
    ns.tp.copy(frame.n).multiplyScalar(R_PLANET + ns.h)
      .addScaledVector(frame.u, ns.u)
      .addScaledVector(frame.v, ns.v);
  }
}

/** 无领域归属的节点：贴着赤道外侧的一圈"自由卫星" */
function layoutOrbit(list) {
  const n = list.length;
  if (!n) return;
  const RING = R_PLANET * 1.55;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    list[i].tp.set(Math.cos(a) * RING, Math.sin(a * 3) * 0.6, Math.sin(a) * RING);
  }
}

/** 切平面内的轻量松弛：网格分桶只看邻格，只把重叠推开，不改变所属领域 */
function relax2D(list) {
  const n = list.length;
  if (n < 2) return;
  let cell = 1.4;
  for (const ns of list) cell = Math.max(cell, ns.r * 2.6);
  const grid = new Map();
  for (let it = 0; it < 26; it++) {
    grid.clear();
    for (const ns of list) {
      const k = `${Math.round(ns.u / cell)},${Math.round(ns.v / cell)}`;
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(ns);
    }
    let moved = 0;
    for (const a of list) {
      const cx = Math.round(a.u / cell), cy = Math.round(a.v / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const arr = grid.get(`${gx},${gy}`);
          if (!arr) continue;
          for (const b of arr) {
            if (b === a) continue;
            let dx = a.u - b.u, dy = a.v - b.v;
            let d = Math.hypot(dx, dy);
            const min = (a.r + b.r) * 1.3 + 0.36;
            if (d >= min) continue;
            if (d < 1e-3) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 0.7; }
            const push = (min - d) * 0.5;
            a.u += (dx / d) * push;
            a.v += (dy / d) * push;
            moved++;
          }
        }
      }
    }
    if (!moved) break;
  }
  // 软边界：把散出去的拉回来，让星群始终是一团
  for (const ns of list) {
    const d = Math.hypot(ns.u, ns.v);
    if (d > PATCH_EDGE) {
      const k = PATCH_EDGE / d;
      ns.u *= k;
      ns.v *= k;
    }
  }
}

function byWeightDesc(a, b) {
  return (+b.data.weight || 0) - (+a.data.weight || 0);
}

function rebuildEdges() {
  const list = [];
  const pool = [];
  const seenPair = new Set();
  for (const e of cfg.graph.edges) {
    const s = idOf(e.source), t = idOf(e.target);
    const a = R.nodes.get(s), b = R.nodes.get(t);
    if (!a || !b || a === b || a.dying || b.dying) continue;
    const k = s < t ? s + "\u0001" + t : t + "\u0001" + s;
    if (seenPair.has(k)) continue;
    seenPair.add(k);
    const old = R.edgePool.find((x) => x.k === k);
    const item = old || { k, hlUntil: 0 };
    item.a = a; item.b = b;
    item.w = clamp(Number(e.weight) || 1, 1, 10);
    item.data = e;
    pool.push(item);
    list.push(item);
  }
  R.edgePool = pool;
  R.edgeList = list;
  const need = Math.max(16, list.length);
  if (!R.edgeLines || R.edgeCap < need) {
    if (R.edgeLines) {
      R.world.remove(R.edgeLines);
      R.edgeLines.geometry.dispose();
    }
    const cap = Math.ceil(need * 1.5);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cap * 8), 4).setUsage(THREE.DynamicDrawUsage));
    R.edgeLines = new THREE.LineSegments(geo, R.edgeMat);
    R.edgeLines.frustumCulled = false;
    R.edgeLines.renderOrder = -1;
    R.world.add(R.edgeLines);
    R.edgeCap = cap;
  }
  R.edgeLines.geometry.setDrawRange(0, list.length * 2);
}

// ============================================================
// 8. 可见性：角色 / 时间轴 / 筛选
// ============================================================

function applyVisibility() {
  if (!R) return;
  const tl = normalizeTimeline(cfg.timeline);
  const parent = cfg.role === "parent";
  const fd = cfg.filter.domain, fs = cfg.filter.status;
  for (const ns of R.order) {
    if (ns.id === R.selfId) { ns.visTarget = 1; ns.dimTarget = 1; continue; }
    const n = ns.data;
    let vis = !ns.dying;
    if (vis && parent && n.private) vis = false;
    if (vis && tl && n.first_seen) {
      const fsn = str(n.first_seen).slice(0, tl.len);
      if (fsn > tl.v) vis = false;
    }
    ns.visTarget = vis ? 1 : 0;
    let match = true;
    if (fd && n.domain !== fd) match = false;
    if (fs && n.status !== fs) match = false;
    ns.dimTarget = match ? 1 : 0.12;
  }
  for (const k of DOMAIN_KEYS) {
    const o = R.domainObjs.get(k);
    const dim = !!fd && fd !== k;
    if (dim !== o.dimmed) {
      o.dimmed = dim;
      o.el.classList.toggle("is-dim", dim);
    }
  }
  if (R.hover && R.hover.visTarget === 0) R.hover = null;
  wake();
  if (!R.running && R.ready) renderFrame(0, true);
}

function applyTheme() {
  if (!R) return;
  // 场景明暗只跟界面主题走：角色只决定"看得到哪些节点"
  const light = cfg.theme === "light";
  const th = light ? THEMES.light : THEMES.dark;
  R.theme = light ? "light" : "dark";
  R.scene.background = light ? R.bgTex.light : R.bgTex.dark;
  R.scene.fog.color.setHex(th.fog);
  R.scene.fog.density = th.fogD;
  R.hemi.intensity = th.hemi;
  R.hemi.color.setHex(th.hemiSky);
  R.hemi.groundColor.setHex(th.hemiGround);
  R.key.intensity = th.keyI;
  R.rim.intensity = th.rimI;
  R.fill.intensity = th.fillI;
  R.edgeBase = th.edge;
  if (R.bloom) { R.bloom.strength = th.bloom; R.bloom.threshold = th.bloomTh; }
  // 星球
  R.planetUniforms.uSea.value.setHex(th.sea);
  R.planetUniforms.uLand.value.setHex(th.land);
  R.planetUniforms.uLand2.value.setHex(th.land2);
  R.planetUniforms.uIce.value.setHex(th.ice);
  R.planetUniforms.uCloud.value.setHex(th.cloud);
  R.planetUniforms.uRim.value.setHex(th.atmo);
  R.planetUniforms.uRimI.value = th.planetRim;
  R.atmoMat.uniforms.uColor.value.setHex(th.atmo);
  R.atmoMat.uniforms.uIntensity.value = th.atmoI;
  R.haloMat.color.setHex(th.atmo);
  R.haloMat.opacity = th.planetHaloOp;
  R.gridMat.color.setHex(th.grid);
  R.gridMat.opacity = th.gridOp;
  R.orbitRingMat.color.setHex(th.ring);
  R.orbitRingMat.opacity = th.ringOp;
  R.dustMat.color.setHex(th.dust);
  R.dustMat.opacity = th.dustOp;
  const starCols = [th.starA, th.starB, th.starC];
  R.starLayers.forEach((s, i) => s.mat.color.setHex(starCols[i] || th.starA));
  // 叠加混合：浅底上 additive 只会更亮、等于隐形
  const blend = th.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  for (const m of R.additive) {
    if (m.blending !== blend) {
      m.blending = blend;
      m.needsUpdate = true;
    }
  }
  for (const o of R.domainObjs.values()) {
    o.ringMat.opacity = th.ringOp;
    o.haloMatD.opacity = th.haloOp;
    if (o.shellMat.blending !== blend) {
      o.shellMat.blending = blend;
      o.shellMat.needsUpdate = true;
    }
    o.shellMat.uniforms.uI.value = th.shellI;
    if (o.haloMatD.blending !== blend) {
      o.haloMatD.blending = blend;
      o.haloMatD.needsUpdate = true;
    }
  }
  wake();
  if (!R.running && R.ready) renderFrame(0, true);
}

// ============================================================
// 9. 每帧
// ============================================================

function renderFrame(dt, force) {
  if (!R) return;
  R.time += dt;
  R.frame++;
  const time = R.time;
  const tms = nowMs();
  const th = THEMES[R.theme];

  // 布局收敛：每帧一次 O(n) 的阻尼插值（不是力导向）
  if (R.sim.alpha > 0) {
    const k = dt === 0 ? 1 : 1 - Math.exp(-dt * 3.4);
    let settled = true;
    for (const ns of R.order) {
      ns.p.lerp(ns.tp, k);
      if (ns.p.distanceToSquared(ns.tp) > 0.0009) settled = false;
    }
    if (settled || dt === 0) R.sim.alpha = 0;
  }

  // 星球自转（着色器里的海陆云漂移跟同一时钟）
  if (R.spin) {
    R.planet.rotation.y += dt * SPIN;
    R.planetUniforms.uTime.value = time;
  }
  R.gridGroup.rotation.y = R.planet.rotation.y;
  R.atmo.rotation.y = R.planet.rotation.y;

  // 相机飞行
  const fly = R.fly;
  if (fly) {
    fly.t += dt / fly.dur;
    const k = easeInOut(Math.min(1, fly.t));
    R.camera.position.lerpVectors(fly.p0, fly.p1, k);
    R.controls.target.lerpVectors(fly.t0, fly.t1, k);
    if (fly.t >= 1) {
      R.fly = null;
      R.lastInteract = tms;
    }
  } else if (!R.controls.autoRotate && !R.dragging && !R.reduce && tms - R.lastInteract > IDLE_RESUME_MS) {
    R.controls.autoRotate = true;
  }
  R.controls.update();

  // ---- 记忆星 ----
  const k6 = dt === 0 ? 1 : 1 - Math.exp(-dt * 6);
  for (let i = 0; i < R.clusterCounts.length; i++) R.clusterCounts[i] = 0;
  for (const s of R.clusterSums) s.set(0, 0, 0);
  let anyDead = false;
  for (const ns of R.order) {
    ns.vis += (ns.visTarget - ns.vis) * k6;
    ns.dim += (ns.dimTarget - ns.dim) * k6;
    if (ns.appearDelay > 0) ns.appearDelay -= dt;
    else if (ns.appear < 1) ns.appear = Math.min(1, ns.appear + dt / 0.65);

    if (ns.id === R.selfId) {
      // 本人已由星球本身代表，不画小球
      if (ns.group.visible) ns.group.visible = false;
      continue;
    }
    const shown = ns.vis > 0.01 && ns.appear > 0;
    if (!shown) {
      if (ns.group.visible) ns.group.visible = false;
      if (ns.label.visible) ns.label.visible = false;
      if (ns.dying && ns.vis < 0.01) anyDead = true;
      continue;
    }
    if (!ns.group.visible) ns.group.visible = true;
    const bobAmp = 0.055 + 0.03 * ns.h;
    ns.wp.set(ns.p.x, ns.p.y + Math.sin(time * 0.7 + ns.bob) * bobAmp, ns.p.z);
    ns.group.position.copy(ns.wp);

    const di = DOMAIN_KEYS.indexOf(ns.data.domain);
    if (di >= 0 && ns.visTarget > 0) {
      R.clusterSums[di].add(ns.wp);
      R.clusterCounts[di]++;
    }

    const ap = easeOutBack(ns.appear);
    let pulse = 0;
    if (ns.pulseUntil > tms) {
      const rem = (ns.pulseUntil - tms) / RECALL_MS;
      pulse = (0.5 + 0.5 * Math.sin(time * 9)) * Math.min(1, rem * 3);
    }
    const hov = R.hover === ns ? 1 : 0;
    const s = ns.r * ap * (0.35 + 0.65 * ns.vis) * (1 + 0.18 * pulse + 0.1 * hov);
    ns.mesh.scale.setScalar(s);
    const op = ns.baseOpacity * ns.vis * ns.dim;
    ns.mat.opacity = op;
    ns.mat.depthWrite = op > 0.9;
    ns.mesh.visible = op > 0.01;
    const breathe = 1 + 0.06 * Math.sin(time * 1.6 + ns.bob);
    ns.halo.scale.setScalar(Math.max(0.001, s * (4.6 + 2.6 * pulse + hov) * breathe));
    if (pulse > 0) {
      ns.halo.material.color.copy(ns.mat.color).lerp(R.amber, 0.6 * pulse);
    } else if (ns.haloTinted) {
      ns.halo.material.color.copy(ns.mat.color);
    }
    ns.haloTinted = pulse > 0;
    ns.halo.material.opacity = (ns.haloBase + 0.5 * pulse + 0.2 * hov) * ns.vis * ns.dim;
    if (ns.ring) {
      ns.ring.scale.setScalar(s * 2.9);
      ns.ring.material.opacity = 0.9 * ns.vis * ns.dim;
      ns.ring.material.rotation = time * 0.4;
    }
    if (ns.priv) {
      ns.priv.scale.setScalar(s * 3.4);
      ns.priv.material.opacity = 0.75 * ns.vis * ns.dim;
    }
  }
  if (anyDead) reapNodes();

  // ---- 领域行星：跟着自家星群质心轻微游移（限幅，不脱离球面）+ 计数 ----
  for (let i = 0; i < DOMAIN_KEYS.length; i++) {
    const k = DOMAIN_KEYS[i];
    const o = R.domainObjs.get(k);
    const dir = R.domain.dir.get(k);
    const cnt = R.clusterCounts[i];
    R.v3.copy(dir).multiplyScalar(R_PLANET);
    if (cnt > 0) {
      R.v4.copy(R.clusterSums[i]).multiplyScalar(1 / cnt).sub(R.v3);
      const len = R.v4.length();
      if (len > 1.6) R.v4.multiplyScalar(1.6 / len);
      R.v3.add(R.v4);
    }
    R.v3.addScaledVector(dir, Math.sin(time * 0.5 + o.phase) * 0.12);
    o.group.position.lerp(R.v3, dt === 0 ? 1 : k6 * 0.5);
    o.body.rotation.y += dt * 0.18;
    const want = cnt > 0 ? (o.dimmed ? 0.06 : 1) : 0.35;
    o.alpha += (want - o.alpha) * k6;
    o.haloMatD.opacity = th.haloOp * o.alpha;
    o.halo.visible = o.alpha > 0.01;
    o.ringMat.opacity = th.ringOp * o.alpha;
    o.shellMat.uniforms.uI.value = th.shellI * o.alpha;
    o.el.style.opacity = String(clamp(o.alpha, 0, 1));
    if (o.count !== cnt) {
      o.count = cnt;
      o.countEl.textContent = cnt ? `${cnt} 颗记忆` : "暂无";
    }
  }

  updateEdges(tms, time);
  updateLabels(tms);
  updatePlan(dt, tms, time);
  updateBursts(dt);

  for (const s of R.starLayers) s.points.rotation.y += dt * s.drift;
  R.dust.rotation.y -= dt * 0.012;

  if (R.pointer.dirty && !R.dragging) {
    R.pointer.dirty = false;
    doHover();
  }

  // ---- 渲染 ----
  const r = R.renderer;
  r.setScissorTest(false);
  r.setViewport(0, 0, R.w, R.h);
  r.autoClear = true;
  if (R.composer) {
    try { R.composer.render(); }
    catch (_) { R.composer = null; r.render(R.scene, R.camera); }
  } else {
    r.render(R.scene, R.camera);
  }

  // 熊猫小视窗：降频到 ~15fps（第二视口是白给的开销，没必要每帧画两遍）
  const P = R.panda;
  if (P && P.rect.on) {
    const sig = `${P.rect.w}x${P.rect.h}`;
    if (P.last < 0 || tms - P.last > 66 || P.sig !== sig) {
      P.last = tms;
      P.sig = sig;
      try {
        P.mod.updatePanda(P.group, Math.max(dt, 0.066));
        const pr = P.rect;
        r.autoClear = false;
        r.clearDepth();
        r.setScissorTest(true);
        r.setScissor(pr.x, pr.y, pr.w, pr.h);
        r.setViewport(pr.x, pr.y, pr.w, pr.h);
        r.render(P.scene, P.cam);
        r.setScissorTest(false);
        r.setViewport(0, 0, R.w, R.h);
        r.autoClear = true;
      } catch (e) {
        R.panda = null;
      }
    }
  }

  R.css2d.render(R.scene, R.camera);
}

function updateEdges(tms, time) {
  const L = R.edgeLines;
  if (!L) return;
  const pos = L.geometry.attributes.position.array;
  const colA = L.geometry.attributes.color.array;
  const base = R.edgeBase || 0.34;
  const ca = R.col, cb = R.col2;
  let i = 0;
  for (const e of R.edgeList) {
    const a = e.a, b = e.b;
    // 连到"星球本人"的边：落在球面上的对应点，而不是穿进球心
    const sa = a.id === R.selfId ? surfacePoint(b.wp, R.v3) : a.wp;
    const sb = b.id === R.selfId ? surfacePoint(a.wp, R.v3) : b.wp;
    const p6 = i * 6, c8 = i * 8;
    pos[p6] = sa.x; pos[p6 + 1] = sa.y; pos[p6 + 2] = sa.z;
    pos[p6 + 3] = sb.x; pos[p6 + 4] = sb.y; pos[p6 + 5] = sb.z;
    const vis = Math.min(a.vis, b.vis) * Math.min(a.appear, b.appear);
    const dim = Math.min(a.dim, b.dim);
    let alpha = base * (0.55 + 0.08 * e.w) * vis * dim;
    ca.copy(a.mat.color);
    cb.copy(b.mat.color);
    if (e.hlUntil > tms) {
      const rem = Math.min(1, ((e.hlUntil - tms) / RECALL_MS) * 3);
      const p = (0.6 + 0.4 * Math.sin(time * 9)) * rem;
      ca.lerp(R.amber, p);
      cb.lerp(R.amber, p);
      alpha = Math.max(alpha, 0.95 * p * vis);
    } else if (R.hover && (R.hover === a || R.hover === b)) {
      alpha = Math.max(alpha, 0.8 * vis * dim);
    }
    colA[c8] = ca.r; colA[c8 + 1] = ca.g; colA[c8 + 2] = ca.b; colA[c8 + 3] = alpha;
    colA[c8 + 4] = cb.r; colA[c8 + 5] = cb.g; colA[c8 + 6] = cb.b; colA[c8 + 7] = alpha;
    i++;
  }
  L.geometry.attributes.position.needsUpdate = true;
  L.geometry.attributes.color.needsUpdate = true;
}

/** 把点投到球面外侧（用于"连到本人"的边） */
function surfacePoint(p, out) {
  const len = p.length() || 1;
  return out.copy(p).multiplyScalar((R_PLANET * 1.01) / len);
}

// 标签：重要节点优先，其次悬停/高亮/聚焦/新生；最后做一次屏幕碰撞，叠在一起就藏掉
function updateLabels(tms) {
  const placed = R.labelPlaced;
  placed.length = 0;
  // 1) 强制显示的（交互焦点）：先占位，永远不会被挤掉
  for (const ns of R.order) {
    if (ns.id === R.selfId) continue;
    const must = (R.hover === ns) || (R.focusId === ns.id) || (ns.pulseUntil > tms) ||
      (ns.spawnedAt && tms - ns.spawnedAt < 6000);
    if (!must || !ns.group.visible || ns.vis < 0.3) continue;
    if (!labelPlace(ns, placed)) continue;
  }
  // 2) 按权重补位：候选已经按权重排序，超出预算或与已占位重叠的都藏掉
  const cand = R.labelCand;
  cand.length = 0;
  for (const ns of R.order) {
    if (ns.id === R.selfId || !ns.group.visible) continue;
    if (ns.visTarget <= 0 || ns.dimTarget <= 0.5 || ns.appear <= 0.6 || ns.vis < 0.3) continue;
    if ((R.hover === ns) || (R.focusId === ns.id) || (ns.pulseUntil > tms)) continue; // 已占位
    cand.push(ns);
  }
  cand.sort(byWeightDesc);
  let used = placed.length;
  for (const ns of cand) {
    if (used >= R.labelBudget) break;
    if (labelPlace(ns, placed)) used++;
  }
  // 3) 统一的显隐与样式
  for (const ns of R.order) {
    if (ns.id === R.selfId) { if (ns.label.visible) ns.label.visible = false; continue; }
    const want = placed.indexOf(ns) >= 0;
    if (ns.label.visible !== want) ns.label.visible = want;
    if (!want) continue;
    const n = ns.data;
    const cls = "s3d-label" +
      (n.private ? " is-private" : "") +
      (n.status === "dropped" ? " is-dropped" : "") +
      (n.status === "done" ? " is-done" : "") +
      ((ns.pulseUntil > tms) ? " is-hl" : "") +
      ((R.hover === ns) ? " is-hover" : "");
    if (cls !== ns.labelCls) {
      ns.labelCls = cls;
      ns.el.className = cls;
    }
  }
}

/** 把节点标签放到屏幕上：被星球挡住 / 与已放好的标签重叠 就不放。返回是否放下。 */
function labelPlace(ns, placed) {
  if (occludedByPlanet(ns.wp)) return false;
  R.v3.copy(ns.wp).project(R.camera);
  if (R.v3.z > 1) return false;
  const x = (R.v3.x * 0.5 + 0.5) * R.w;
  const y = (-R.v3.y * 0.5 + 0.5) * R.h;
  const halfW = 62 + Math.min(60, ns.r * 12);   // 胶囊大致半宽
  const top = y - 22 - ns.r * 6, bottom = y;     // 胶囊挂在节点正上方
  for (const p of placed) {
    if (Math.abs(x - p.x) < halfW + p.halfW && bottom > p.top && top < p.bottom) return false;
  }
  placed.push({ x, halfW, top, bottom });
  return true;
}

function reapNodes() {
  const keep = [];
  for (const ns of R.order) {
    if (ns.dying && ns.vis < 0.01) {
      disposeNode(ns);
      R.nodes.delete(ns.id);
      if (R.hover === ns) R.hover = null;
    } else keep.push(ns);
  }
  R.order = keep;
}

function disposeNode(ns) {
  R.world.remove(ns.group);
  ns.mat.dispose();
  ns.halo.material.dispose();
  if (ns.ring) ns.ring.material.dispose();
  if (ns.priv) ns.priv.material.dispose();
  if (ns.el.parentNode) ns.el.parentNode.removeChild(ns.el);
}

// ============================================================
// 10. 拾取 / 提示框
// ============================================================

function pickNode(ndcX, ndcY) {
  const selfNs = R.selfId ? R.nodes.get(R.selfId) : null;
  const list = R.pickList;
  list.length = 0;
  for (const ns of R.order) {
    if (ns.id === R.selfId) continue;
    if (ns.group.visible && ns.mesh.visible && ns.visTarget > 0 && ns.dim > 0.3) list.push(ns.mesh);
  }
  if (selfNs) list.push(R.planet);          // 点星球本体 = 打开"本人"节点
  if (!list.length) return null;
  R.ndc.set(ndcX, ndcY);
  R.raycaster.setFromCamera(R.ndc, R.camera);
  const hits = R.raycaster.intersectObjects(list, false);
  if (hits.length) {
    if (hits[0].object === R.planet) return selfNs;
    return R.nodes.get(hits[0].object.userData.nid) || selfNs;
  }
  // 小节点容差：屏幕距离 18px 内最近的节点
  let best = null, bestD = 18 * 18;
  for (const m of list) {
    if (m === R.planet) continue;
    R.v3.copy(m.parent.position).project(R.camera);
    if (R.v3.z > 1) continue;
    const dx = ((R.v3.x - ndcX) * R.w) / 2, dy = ((R.v3.y - ndcY) * R.h) / 2;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD && !occludedByPlanet(m.parent.position)) { bestD = d2; best = m; }
  }
  return best ? R.nodes.get(best.userData.nid) || null : null;
}

/** 节点是否被星球本体挡住（相机→节点 的线段是否穿过球体）。CSS2D 标签不受深度测试
 *  约束，不判一下就会出现"星球背面的标签浮在星球前面"。 */
function occludedByPlanet(p) {
  const e = R.camera.position;
  R.v4.copy(p).sub(e);
  const len = R.v4.length();
  if (len < 1e-4) return false;
  R.v4.multiplyScalar(1 / len);
  const b = 2 * e.dot(R.v4);
  const c = e.dot(e) - R_PLANET * R_PLANET;
  const disc = b * b - 4 * c;
  if (disc <= 0) return false;
  const t = (-b - Math.sqrt(disc)) / 2;
  return t > 0.001 && t < len - 0.001;
}

function inPanda(x, y) {
  const P = R.panda;
  if (!P || !P.rect.on) return false;
  const r = P.rect;
  const top = R.h - r.y - r.h;
  return x >= r.x && x <= r.x + r.w && y >= top && y <= top + r.h;
}

function doHover() {
  const p = R.pointer;
  if (!p.inside || p.type === "touch" || inPanda(p.x, p.y)) {
    setHover(null);
    return;
  }
  setHover(pickNode(p.ndcX, p.ndcY));
}

function setHover(ns) {
  if (R.hover === ns) {
    if (ns) positionTip();
    return;
  }
  R.hover = ns;
  R.canvas.style.cursor = ns ? "pointer" : "";
  if (ns) R.lastInteract = nowMs();
  wake();
  if (!ns) { hideTip(); return; }
  fillTip(ns.data);
  positionTip();
  R.tip.classList.add("is-on");
}

function fillTip(n) {
  const tip = R.tip;
  tip.textContent = "";
  const d = domainOf(n.domain);
  const t = document.createElement("div");
  t.className = "s3d-tip-title";
  t.textContent = str(n.label || n.id);
  tip.appendChild(t);
  const row = document.createElement("div");
  row.className = "s3d-tip-row";
  const chip = document.createElement("span");
  chip.className = "s3d-tip-chip";
  chip.style.setProperty("--c", d.css);
  chip.appendChild(document.createElement("i"));
  chip.appendChild(document.createTextNode(d.ch ? d.ch + " · " + d.name : d.name));
  row.appendChild(chip);
  const meta = [];
  if (STATUS_NAME[n.status]) meta.push(STATUS_NAME[n.status]);
  if (TYPE_NAME[n.type]) meta.push(TYPE_NAME[n.type]);
  if (meta.length) row.appendChild(document.createTextNode(meta.join(" · ")));
  tip.appendChild(row);
  if (n.private || n.last_seen) {
    const r2 = document.createElement("div");
    r2.className = "s3d-tip-row";
    if (n.private) {
      const lock = document.createElement("span");
      lock.className = "s3d-tip-lock";
      r2.appendChild(lock);
      r2.appendChild(document.createTextNode("私密  "));
    }
    if (n.last_seen) r2.appendChild(document.createTextNode("最近 " + str(n.last_seen).slice(0, 10)));
    tip.appendChild(r2);
  }
}

function positionTip() {
  const p = R.pointer, tip = R.tip;
  const tw = tip.offsetWidth || 160, th = tip.offsetHeight || 60;
  let x = p.x + 14, y = p.y + 14;
  if (x + tw > R.w - 6) x = p.x - tw - 12;
  if (y + th > R.h - 6) y = p.y - th - 12;
  tip.style.transform = `translate3d(${Math.max(4, x) | 0}px,${Math.max(4, y) | 0}px,0)`;
}

function hideTip() {
  if (R && R.tip) R.tip.classList.remove("is-on");
}

function handleTap(x, y, rect) {
  if (inPanda(x, y)) {
    try { R.panda.mod.triggerWave(R.panda.group); } catch (_) {}
    return;
  }
  const ns = pickNode((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  if (!ns) return;
  if (R.pointer.type === "touch") {
    R.pointer.x = x;
    R.pointer.y = y;
    R.hover = null;
    setHover(ns);
    setTimeout(() => { if (R && R.hover === ns) setHover(null); }, 1800);
  }
  const cb = cfg.onClick;
  if (typeof cb === "function") {
    try { cb(ns.data); } catch (e) { console.warn("[scene3d] 点击回调异常：", e && e.message); }
  }
}

// ============================================================
// 11. 相机
// ============================================================

function flyTo(target, distance, dir) {
  if (!R) return;
  const cam = R.camera;
  const d = dir ? R.v1.copy(dir) : R.v1.subVectors(cam.position, R.controls.target);
  if (d.lengthSq() < 1e-6) d.set(0, 0.4, 1);
  d.normalize();
  R.fly = {
    t: 0,
    dur: 1.15,
    p0: cam.position.clone(),
    t0: R.controls.target.clone(),
    t1: target.clone(),
    p1: target.clone().addScaledVector(d, distance),
  };
  stopAutoRotate();
  R.lastInteract = nowMs();
  wake();
  if (!R.running && R.ready) {
    cam.position.copy(R.fly.p1);
    R.controls.target.copy(R.fly.t1);
    R.fly = null;
  }
}

/** 绕当前目标水平/垂直转一点（键盘操作用） */
function rotateAround(dAz, dPol) {
  if (!R) return;
  const off = R.v1.subVectors(R.camera.position, R.controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta += dAz;
  sph.phi = clamp(sph.phi + dPol, R.controls.minPolarAngle, R.controls.maxPolarAngle);
  R.camera.position.copy(R.controls.target).add(new THREE.Vector3().setFromSpherical(sph));
  R.camera.lookAt(R.controls.target);
  R.controls.update();
  R.fly = null;
}

function dolly(k) {
  if (!R) return;
  const off = R.v1.subVectors(R.camera.position, R.controls.target);
  const d = clamp(off.length() * k, R.controls.minDistance, R.controls.maxDistance);
  R.camera.position.copy(R.controls.target).addScaledVector(off.normalize(), d);
  R.controls.update();
  R.fly = null;
}

/** 可见节点的包围半径（用布局目标点，收敛中也能算准） */
function visibleBounds(center) {
  let n = 0;
  center.set(0, 0, 0);
  for (const ns of R.order) if (ns.visTarget > 0) { center.add(ns.tp); n++; }
  let r = R_PLANET * 1.2;
  if (!n) return r;
  center.multiplyScalar(1 / n);
  for (const ns of R.order) if (ns.visTarget > 0) r = Math.max(r, center.distanceTo(ns.tp) + ns.r);
  return r;
}

function fitDistance(radius) {
  const vf = (FOV * Math.PI) / 180;
  const aspect = R.w > 0 && R.h > 0 ? R.w / R.h : 1.6;
  const hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
  const f = Math.min(vf, hf);
  return (radius * 1.16) / Math.sin(f / 2);
}

function fitOverview(instant) {
  if (!R) return;
  const c = new THREE.Vector3();
  const r = visibleBounds(c);
  const dist = clamp(fitDistance(r), R.controls.minDistance, R.controls.maxDistance);
  const dir = new THREE.Vector3(0, 0.36, 1).normalize();
  if (instant) {
    R.controls.target.copy(c);
    R.camera.position.copy(c).addScaledVector(dir, dist);
    R.camera.lookAt(c);
  } else {
    flyTo(c, dist, dir);
  }
}

// ============================================================
// 12. 新生 / 召回特效
// ============================================================

function addBurst(pos, color, size) {
  const sp = new THREE.Sprite(regAdditive(new THREE.SpriteMaterial({
    map: R.tex.ring, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  })));
  sp.position.copy(pos);
  sp.scale.setScalar(0.1);
  R.world.add(sp);
  R.bursts.push({ sp, t: 0, size });
  wake();
}

function updateBursts(dt) {
  if (!R.bursts.length) return;
  for (let i = R.bursts.length - 1; i >= 0; i--) {
    const b = R.bursts[i];
    b.t += dt / 1.1;
    const k = Math.min(1, b.t);
    b.sp.scale.setScalar(b.size * (0.3 + 2.2 * (1 - Math.pow(1 - k, 3))));
    b.sp.material.opacity = (1 - k) * 0.9;
    if (k >= 1) {
      R.world.remove(b.sp);
      b.sp.material.dispose();
      R.bursts.splice(i, 1);
    }
  }
}

// ============================================================
// 13. 任务规划卫星（绕星球运行的一圈小行星）
// ============================================================

function planOrder(items) {
  const byId = new Map(items.map((x) => [x.id, x]));
  const depth = new Map();
  const visiting = new Set();
  const dep = (it) => {
    if (depth.has(it.id)) return depth.get(it.id);
    if (visiting.has(it.id)) return 0;
    visiting.add(it.id);
    let d = 0;
    for (const p of it.depends_on) {
      const o = byId.get(p);
      if (o) d = Math.max(d, dep(o) + 1);
    }
    visiting.delete(it.id);
    depth.set(it.id, d);
    return d;
  };
  items.forEach(dep);
  return items.map((it, i) => ({ it, i, d: depth.get(it.id) || 0 })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.it);
}

function buildPlan(list) {
  destroyPlan(true);
  const items = [];
  const seen = new Set();
  for (const x of list) {
    if (!x || x.id == null || seen.has(String(x.id))) continue;
    seen.add(String(x.id));
    items.push({
      id: String(x.id),
      title: str(x.title || x.name || x.id),
      depends_on: Array.isArray(x.depends_on) ? x.depends_on.map(String) : [],
      status: PLAN_COLOR[x.status] ? x.status : "pending",
    });
  }
  if (!items.length) return;
  const ordered = planOrder(items);
  const group = new THREE.Group();
  const lat = 0.42;                                    // 悬在星球上方一段纬度带，不遮星群
  const orbitY = Math.sin(lat) * R_PLANET * 1.35;
  const radius = clamp(R_PLANET * 1.35 * Math.cos(lat) + ordered.length * 0.14, 9.5, 14);
  group.position.set(0, orbitY, 0);
  group.rotation.x = 0.16;
  R.world.add(group);
  const sats = new Map();
  const orbitPts = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    orbitPts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const orbitMat = new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.26, depthWrite: false });
  const orbit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(orbitPts), orbitMat);
  group.add(orbit);
  ordered.forEach((it, i) => {
    const a = -Math.PI / 2 + (i / ordered.length) * Math.PI * 2;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.15, transparent: true, envMapIntensity: 0.7 });
    const mesh = new THREE.Mesh(R.satGeo, mat);
    mesh.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    mesh.scale.setScalar(0.001);
    const halo = new THREE.Sprite(regAdditive(new THREE.SpriteMaterial({ map: R.tex.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    halo.position.copy(mesh.position);
    const el = document.createElement("div");
    el.className = "s3d-sat";
    const num = document.createElement("span");
    num.className = "s3d-sat-n";
    num.textContent = String(i + 1);
    const tt = document.createElement("span");
    tt.className = "s3d-sat-t";
    tt.textContent = it.title.length > 16 ? it.title.slice(0, 15) + "…" : it.title;
    el.appendChild(num);
    el.appendChild(tt);
    const lab = new R.CSS2D.CSS2DObject(el);
    lab.position.copy(mesh.position);
    lab.position.y += 0.35;
    group.add(mesh, halo, lab);
    const sat = { it, mesh, mat, halo, lab, el, status: "", born: i * 0.08, flash: 0 };
    sats.set(it.id, sat);
    setSatStatus(sat, it.status);
  });
  const arcPts = [];
  const tmp = new THREE.Vector3();
  for (const it of ordered) {
    const b = sats.get(it.id);
    for (const dep of it.depends_on) {
      const a = sats.get(dep);
      if (!a) continue;
      const pa = a.mesh.position, pb = b.mesh.position;
      const mid = tmp.addVectors(pa, pb).multiplyScalar(0.5);
      mid.multiplyScalar(0.55);
      mid.y += 0.9;
      const SEG = 14;
      let prev = pa.clone();
      for (let s = 1; s <= SEG; s++) {
        const t = s / SEG, u = 1 - t;
        const q = new THREE.Vector3(
          u * u * pa.x + 2 * u * t * mid.x + t * t * pb.x,
          u * u * pa.y + 2 * u * t * mid.y + t * t * pb.y,
          u * u * pa.z + 2 * u * t * mid.z + t * t * pb.z
        );
        arcPts.push(prev, q);
        prev = q;
      }
    }
  }
  let arcs = null;
  if (arcPts.length) {
    arcs = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(arcPts),
      new THREE.LineBasicMaterial({ color: 0xcfe9de, transparent: true, opacity: 0.32, depthWrite: false })
    );
    group.add(arcs);
  }
  R.plan = { group, sats, orbit, arcs, t: 0, fade: 1, fading: false };
  wake();
}

function setSatStatus(sat, status) {
  const st = PLAN_COLOR[status] ? status : "pending";
  if (sat.status === st) return;
  const prev = sat.status;
  sat.status = st;
  const c = R.col.setHex(PLAN_COLOR[st]);
  sat.mat.color.copy(c);
  sat.mat.emissive.copy(c);
  sat.mat.emissiveIntensity = st === "pending" ? 0.15 : 0.7;
  sat.halo.material.color.copy(c);
  sat.el.className = "s3d-sat is-" + st;
  sat.el.style.setProperty("--c", "#" + c.getHexString());
  if (prev && (st === "done" || st === "error")) {
    sat.flash = 1;
    sat.mesh.getWorldPosition(R.v3);
    addBurst(R.v3, PLAN_COLOR[st], 0.9);
  }
}

function updatePlan(dt, tms, time) {
  for (let i = R.planFading.length - 1; i >= 0; i--) {
    const P = R.planFading[i];
    P.fade -= dt / 0.6;
    if (P.fade <= 0 || dt === 0) {
      disposePlanObj(P);
      R.planFading.splice(i, 1);
    } else applyPlanFade(P, P.fade);
  }
  const P = R.plan;
  if (!P) return;
  P.t += dt;
  P.group.rotation.y += dt * 0.22;
  for (const sat of P.sats.values()) {
    const k = clamp((P.t - sat.born) / 0.5, 0, 1);
    let s = 0.26 * easeOutBack(k);
    let hb = 0.25;
    if (sat.status === "running") {
      const pz = 0.5 + 0.5 * Math.sin(time * 6);
      s *= 1 + 0.25 * pz;
      hb = 0.5 + 0.4 * pz;
    } else if (sat.status === "done") hb = 0.45;
    else if (sat.status === "error") hb = 0.55;
    if (sat.flash > 0) { sat.flash = Math.max(0, sat.flash - dt * 1.5); s *= 1 + 0.5 * sat.flash; }
    sat.mesh.scale.setScalar(Math.max(0.001, s));
    sat.mesh.rotation.y += dt * 0.8;
    sat.halo.scale.setScalar(Math.max(0.001, s * 5));
    sat.halo.material.opacity = hb * k;
    sat.mat.opacity = k;
  }
}

function applyPlanFade(P, f) {
  P.group.traverse((o) => {
    if (o.material) o.material.opacity = Math.min(o.material.opacity, f);
    if (o.isCSS2DObject) o.element.style.opacity = String(f);
  });
}

function disposePlanObj(P) {
  R.world.remove(P.group);
  P.group.traverse((o) => {
    if (o.isCSS2DObject && o.element.parentNode) o.element.parentNode.removeChild(o.element);
    if (o.material) o.material.dispose();
    if (o.geometry && o.geometry !== R.satGeo) o.geometry.dispose();
  });
}

function destroyPlan(instant) {
  const P = R && R.plan;
  if (!P) return;
  R.plan = null;
  if (instant || !R.running) disposePlanObj(P);
  else {
    P.fade = 1;
    R.planFading.push(P);
  }
}

// ============================================================
// 14. 星球本人（中心 = 孩子）
// ============================================================

/** 星球的名字标签：挂在球体北极上方，不随球自转（始终朝上） */
function updateSelfLabel() {
  if (!R || !R.selfId) return;
  const ns = R.nodes.get(R.selfId);
  if (!ns) return;
  R.selfNs = ns;
  if (!R.selfLabel) {
    const el = document.createElement("div");
    el.className = "s3d-self";
    const name = document.createElement("div");
    name.className = "s3d-self-name";
    const sub = document.createElement("div");
    sub.className = "s3d-self-sub";
    el.appendChild(name);
    el.appendChild(sub);
    const lab = new R.CSS2D.CSS2DObject(el);
    lab.center.set(0.5, 1);
    lab.position.set(0, R_PLANET * 1.44, 0);
    R.world.add(lab);
    R.selfLabel = { el, name, sub, lab };
  }
  R.selfLabel.name.textContent = str(ns.data.label || ns.data.id);
  R.selfLabel.sub.textContent = cfg.timeline ? "记忆星球 · " + cfg.timeline : "记忆星球 · 本人";
}

// ============================================================
// 15. 导出 API
// ============================================================

function safe(fn) {
  return function () {
    try {
      return fn.apply(null, arguments);
    } catch (e) {
      console.warn("[scene3d] 已忽略异常：", e && e.message);
      return undefined;
    }
  };
}

function cleanNode(n) {
  if (!n || typeof n !== "object" || n.id == null || n.id === "") return null;
  return n;
}

export const setGraphData = safe(function setGraphData(graph) {
  let g = graph;
  if (g && g.graph && typeof g.graph === "object") g = g.graph;
  const nodes = [];
  const ids = new Set();
  for (const n of (g && Array.isArray(g.nodes) ? g.nodes : [])) {
    const c = cleanNode(n);
    if (c && !ids.has(c.id)) { ids.add(c.id); nodes.push(c); }
  }
  const edges = [];
  for (const e of (g && Array.isArray(g.edges) ? g.edges : [])) {
    if (e && ids.has(idOf(e.source)) && ids.has(idOf(e.target))) edges.push(e);
  }
  cfg.graph = { nodes, edges };
  if (R && R.ready) {
    const wasEmpty = R.order.length === 0;
    syncGraph(false);
    if (wasEmpty && R.order.length) fitOverview(!R.running);
  }
});

export const setRole = safe(function setRole(role) {
  cfg.role = role === "parent" ? "parent" : "child";
  if (R && R.ready) applyVisibility();
});

/** 深浅色切换：整个 3D 场景（背景/雾/光照/星球着色器/叠加材质/bloom）跟随界面主题。 */
export const setTheme = safe(function setTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  if (cfg.theme === t && (!R || R.theme === t)) return;
  cfg.theme = t;
  if (R && R.ready) applyTheme();
});

export const setTimeline = safe(function setTimeline(dateStr) {
  cfg.timeline = normalizeTimeline(dateStr) ? str(dateStr) : null;
  if (R && R.ready) {
    applyVisibility();
    if (R.selfLabel) {
      R.selfLabel.sub.textContent = cfg.timeline ? "记忆星球 · " + cfg.timeline : "记忆星球 · 本人";
    }
  }
});

export const setFilter = safe(function setFilter(f) {
  const o = f && typeof f === "object" ? f : {};
  cfg.filter = {
    domain: DOMAINS[o.domain] ? o.domain : "",
    status: STATUS_NAME[o.status] ? o.status : "",
  };
  if (R && R.ready) applyVisibility();
});

/** 便捷版筛选：setDomainFilter("ethics", "done")，空串清除 */
export const setDomainFilter = safe(function setDomainFilter(domain, status) {
  cfg.filter = {
    domain: DOMAINS[domain] ? domain : "",
    status: STATUS_NAME[status] ? status : "",
  };
  if (R && R.ready) applyVisibility();
});

/**
 * 把已初始化的场景迁移到另一个容器（主视图小窗 ⇄ 星球全屏）。
 * mode: "main" | "graph"，graph 模式下做一次全景对焦。
 */
export const attachTo = safe(function attachTo(el, mode) {
  if (!R || !R.ready || !el || typeof el.appendChild !== "function") return false;
  if (R.container !== el) {
    if (R.restorePos !== null && R.container) {
      try { R.container.style.position = R.restorePos; } catch (_) {}
      R.restorePos = null;
    }
    try {
      if (getComputedStyle(el).position === "static") {
        R.restorePos = el.style.position || "";
        el.style.position = "relative";
      }
    } catch (_) {}
    el.appendChild(R.root);
    R.container = el;
    observe(el);
  }
  R.w = -1; // 强制重算尺寸
  measure();
  updateRunning();
  if (mode === "graph") fitOverview(false);
  return true;
});

export const setNodeClickHandler = safe(function setNodeClickHandler(cb) {
  cfg.onClick = typeof cb === "function" ? cb : null;
});

export const highlightRecall = safe(function highlightRecall(payload) {
  if (!R || !R.ready || !payload) return;
  const until = nowMs() + RECALL_MS;
  for (const x of Array.isArray(payload.nodes) ? payload.nodes : []) {
    let ns = R.nodes.get(idOf(x));
    if (!ns && x && x.label) ns = R.order.find((o) => o.data.label === x.label);
    if (ns && !ns.dying) ns.pulseUntil = until;
  }
  for (const e of Array.isArray(payload.edges) ? payload.edges : []) {
    if (!e) continue;
    const s = idOf(e.source), t = idOf(e.target);
    const k = s < t ? s + "\u0001" + t : t + "\u0001" + s;
    const ed = R.edgePool.find((x) => x.k === k);
    if (ed) {
      ed.hlUntil = until;
      ed.a.pulseUntil = Math.max(ed.a.pulseUntil, until);
      ed.b.pulseUntil = Math.max(ed.b.pulseUntil, until);
    }
  }
  wake();
  if (!R.running) renderFrame(0, true);
});

export const spawnMemory = safe(function spawnMemory(payload) {
  if (!payload) return;
  const addN = Array.isArray(payload.added_nodes) ? payload.added_nodes : [];
  const addE = Array.isArray(payload.added_edges) ? payload.added_edges : [];
  const upd = Array.isArray(payload.updated) ? payload.updated : [];
  const nodes = cfg.graph.nodes.slice();
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  for (const n of addN.concat(upd)) {
    const c = cleanNode(n);
    if (!c || typeof c.label === "undefined") continue; // 只有 id 的更新不覆盖
    if (idx.has(c.id)) nodes[idx.get(c.id)] = Object.assign({}, nodes[idx.get(c.id)], c);
    else { idx.set(c.id, nodes.length); nodes.push(c); }
  }
  const edges = cfg.graph.edges.slice();
  const ek = new Set(edges.map((e) => idOf(e.source) + "\u0001" + idOf(e.target)));
  for (const e of addE) {
    if (!e) continue;
    const k = idOf(e.source) + "\u0001" + idOf(e.target);
    if (!ek.has(k) && idx.has(idOf(e.source)) && idx.has(idOf(e.target))) { ek.add(k); edges.push(e); }
  }
  const before = R ? new Set(R.nodes.keys()) : null;
  setGraphData({ nodes, edges });
  if (!R || !R.ready) return;
  const tms = nowMs();
  for (const n of addN) {
    const ns = R.nodes.get(idOf(n));
    if (!ns) continue;
    if (before && !before.has(ns.id)) {
      ns.appear = 0;
      ns.appearDelay = 0.25;
    }
    ns.spawnedAt = tms;
    ns.pulseUntil = tms + RECALL_MS;
    addBurst(ns.tp, domainOf(ns.data.domain).hex, ns.r * 2.2);
  }
  for (const n of upd) {
    const ns = R.nodes.get(idOf(n));
    if (ns) ns.pulseUntil = tms + RECALL_MS * 0.7;
  }
  for (const e of addE) {
    if (!e) continue;
    const s = idOf(e.source), t = idOf(e.target);
    const k = s < t ? s + "\u0001" + t : t + "\u0001" + s;
    const ed = R.edgePool.find((x) => x.k === k);
    if (ed) ed.hlUntil = tms + RECALL_MS;
  }
  wake();
});

export const spawnPlanSatellites = safe(function spawnPlanSatellites(list) {
  if (!R || !R.ready) return;
  buildPlan(Array.isArray(list) ? list : []);
});

export const setPlanNode = safe(function setPlanNode(id, status) {
  if (!R || !R.plan) return;
  const sat = R.plan.sats.get(String(id));
  if (sat) setSatStatus(sat, status);
});

export const clearPlanSatellites = safe(function clearPlanSatellites() {
  if (R) destroyPlan(false);
});

export const focusNode = safe(function focusNode(nodeId) {
  if (!R || !R.ready) return;
  const ns = R.nodes.get(idOf(nodeId));
  if (!ns || ns.dying || ns.visTarget === 0) return;
  R.focusId = ns.id;
  ns.pulseUntil = nowMs() + 1800;
  if (ns.id === R.selfId) fitOverview(false);
  else flyTo(ns.tp, clamp(9 + ns.r * 6, R.controls.minDistance, 22));
  wake();
});

export const focusDomain = safe(function focusDomain(domain) {
  if (!R || !R.ready) return;
  R.focusId = null;
  if (!DOMAINS[domain]) { fitOverview(false); return; }
  const c = new THREE.Vector3();
  let n = 0;
  for (const ns of R.order) if (ns.visTarget > 0 && ns.data.domain === domain) { c.add(ns.tp); n++; }
  if (!n) anchorOf(domain, c);
  else c.multiplyScalar(1 / n);
  let r = 3;
  for (const ns of R.order) if (ns.visTarget > 0 && ns.data.domain === domain) r = Math.max(r, c.distanceTo(ns.tp) + ns.r);
  const dir = new THREE.Vector3(c.x, c.y * 0.6 + 0.4, c.z);
  if (dir.lengthSq() < 0.01) dir.set(0, 0.4, 1);
  dir.normalize();
  flyTo(c, clamp(fitDistance(r) * 0.92, R.controls.minDistance, 40), dir);
  wake();
});

export const setPandaMood = safe(function setPandaMood(mood) {
  const m = ["idle", "thinking", "working", "happy", "worried", "speaking"].includes(mood) ? mood : "idle";
  cfg.mood = m;
  if (R && R.panda) R.panda.mod.setPandaMood(R.panda.group, m);
});

export const resize = safe(function resize() {
  if (!R) return;
  R.w = -1;
  measure();
  updateRunning();
});

export function isSceneReady() {
  return !!(R && R.ready && !R.failed);
}

export const disposeScene = safe(function disposeScene() {
  if (!R) return;
  const S = R;
  S.ready = false;
  S.running = false;
  cancelAnimationFrame(S.raf);
  clearTimeout(S.lostTimer);
  for (const [t, ty, fn, o] of S.listeners) t.removeEventListener(ty, fn, o);
  for (const ob of S.observers) ob.disconnect();
  try { S.controls.removeEventListener("start", onControlStart); S.controls.removeEventListener("end", onControlEnd); S.controls.dispose(); } catch (_) {}
  const keepGeo = new Set([S.sphereGeo, S.satGeo, S.planetGeo, S.planetGeoSmall]);
  const disposeTree = (root) => root.traverse((o) => {
    if (o.geometry && !keepGeo.has(o.geometry)) o.geometry.dispose();
    if (o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        if (m.map && m.map !== S.tex.glow && m.map !== S.tex.ring && m.map !== S.tex.priv && m.map !== S.tex.orbit) m.map.dispose();
        m.dispose();
      }
    }
  });
  try { disposeTree(S.scene); } catch (_) {}
  if (S.panda) { try { disposeTree(S.panda.scene); } catch (_) {} }
  try {
    if (S.composer) {
      if (S.bloom && S.bloom.dispose) S.bloom.dispose();
      if (S.composer.renderTarget1) S.composer.renderTarget1.dispose();
      if (S.composer.renderTarget2) S.composer.renderTarget2.dispose();
    }
    if (S.envTex) S.envTex.dispose();
    if (S.pmrem) S.pmrem.dispose();
  } catch (_) {}
  for (const g of keepGeo) { try { g.dispose(); } catch (_) {} }
  for (const t of Object.values(S.tex)) { try { t.dispose(); } catch (_) {} }
  for (const t of Object.values(S.bgTex)) { try { t.dispose(); } catch (_) {} }
  for (const t of S.addTexes) { try { t.dispose(); } catch (_) {} }
  try { S.renderer.dispose(); S.renderer.forceContextLoss(); } catch (_) {}
  if (S.root.parentNode) S.root.parentNode.removeChild(S.root);
  if (S.restorePos !== null) S.container.style.position = S.restorePos;
  if (S.hiddenCanvas) S.hiddenCanvas.style.display = S.hiddenCanvas.dataset.s3dPrevDisplay || "";
  R = null;
});

// ============================================================
// 16. 共用：叠加材质登记（浅色主题统一切回普通混合）
// ============================================================

const _earlyAdditive = [];
function regAdditive(mat) {
  if (R && R.additive) {
    R.additive.add(mat);
    if (!THEMES[R.theme].additive) {
      mat.blending = THREE.NormalBlending;
      mat.needsUpdate = true;
    }
  } else {
    _earlyAdditive.push(mat);
  }
  return mat;
}

// 预分配的簇统计缓冲（避免每帧分配）
function ensureScratch() {
  if (!R) return;
  if (!R.labelPlaced) R.labelPlaced = [];
  if (!R.clusterSums) {
    R.clusterSums = DOMAIN_KEYS.map(() => new THREE.Vector3());
    R.clusterCounts = new Array(DOMAIN_KEYS.length).fill(0);
    R.labelCand = [];
  }
  if (!R.additive) R.additive = new Set();
  for (const m of _earlyAdditive) R.additive.add(m);
  _earlyAdditive.length = 0;
}
