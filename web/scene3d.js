// web/scene3d.js —— 记忆星球 3D 场景（PandaButler / 熊猫管家）
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
//   setTimeline(null|"YYYY-MM"|"YYYY-MM-DD")
//   setFilter({domain, status})
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

const ANCHOR_R = 10.5;
const ANCHOR_Y = [0.9, -0.5, 0.6, -0.8, 0.2];
const RECENT_DAYS = 540;
const FOV = 45;
const IDLE_RESUME_MS = 20000;
const RECALL_MS = 3200;

// 场景固定使用夜色竹林主题（唯一主题）。
// 角色只决定"看得到哪些节点"，不改场景明暗（否则切视角时整屏闪）。
const THEMES = {
  dark: {
    top: "#02030a", bottom: "#0b0720", glow: "rgba(120,90,220,0.20)",
    fog: 0x04050f, fogD: 0.0045, hemi: 0.42, hemiGround: 0x05060f,
    key: 1.1, rim: 0.9, fill: 950, env: 0.25, rough: 0.78, emiss: 1, exposure: 1.05,
    edge: 0.36, edgeShade: 1, additive: true, bloom: 0.6, bloomT: 0.8,
    dust: 0xb9c7ff, dustOp: 0.5, core: 0xffd9a0, coreOp: 0.13,
    disc: 0x6a5cff, discOp: 0.10, circle: 0x93a8ff, circleOp: 0.13,
    spoke: 0xa9b8ff, spokeOp: 0.09, haloBoost: 1,
    orbit: 0.22, arc: 0xcfe9de, arcOp: 0.32,
  },
};

// 行星质感变体：0 气态巨行星（条纹） 1 岩质（大陆/海洋/极冠） 2 涡旋云海
const PLANET_VARIANTS = 3;
const GALAXY_STARS = 6000;
const GALAXY_RADIUS = 40;
const BACK_STARS = 1400;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => {
  const c1 = 1.5, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const idOf = (x) => (x && typeof x === "object" ? x.id : x);
const str = (x) => (x == null ? "" : String(x));

// ============================================================
// 1. 配置状态（initScene 之前也能设置）
// ============================================================

const cfg = {
  graph: { nodes: [], edges: [] },
  role: "child",
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
.s3d-root{position:absolute;inset:0;overflow:hidden;border-radius:inherit;background:#02030a;user-select:none;-webkit-user-select:none}
.s3d-root>canvas{position:absolute;inset:0;display:block;width:100%;height:100%;outline:none;touch-action:none}
.s3d-vignette{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 75% 70% at 50% 46%,rgba(0,0,0,0) 55%,var(--s3d-vignette,rgba(2,9,10,.55)) 100%)}
.s3d-css2d{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.s3d-css2d>div{pointer-events:none}
.s3d-label{font:600 12px/1.25 var(--s3d-font,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif);color:var(--s3d-ink,#e8f1ec);background:var(--s3d-label-bg,rgba(7,20,22,.72));border:1px solid var(--s3d-label-border,rgba(232,241,236,.12));padding:3px 9px 3px 7px;border-radius:999px;white-space:nowrap;display:flex;align-items:center;gap:6px;transform:translateY(-16px);animation:s3d-in .28s ease-out both;text-shadow:0 1px 2px rgba(0,0,0,.45);letter-spacing:.02em}
.s3d-label .s3d-dot{width:7px;height:7px;border-radius:50%;background:var(--c,#8fa7a0);box-shadow:0 0 6px var(--c,#8fa7a0);flex:none}
.s3d-label.is-private{border-style:dashed;border-color:var(--s3d-private,rgba(180,205,198,.55))}
.s3d-label.is-dropped{color:var(--s3d-ink-dim,rgba(232,241,236,.6))}
.s3d-label.is-done{border-color:rgba(243,198,92,.55)}
.s3d-label.is-hl{border-color:var(--s3d-amber,#f0a24a);color:var(--s3d-ink-strong,#fff6ea);box-shadow:0 0 0 1px rgba(240,162,74,.35),0 0 14px rgba(240,162,74,.45)}
.s3d-label.is-hover{border-color:rgba(232,241,236,.4)}
.s3d-cluster{display:flex;flex-direction:column;align-items:center;gap:1px;font-family:var(--s3d-font,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif);transition:opacity .35s;animation:s3d-in .4s ease-out both}
.s3d-cluster-ch{font-size:17px;font-weight:700;line-height:1;color:var(--c);text-shadow:0 0 16px var(--c),0 1px 2px rgba(0,0,0,.5);opacity:.85}
.s3d-cluster-name{font-size:10px;letter-spacing:.2em;padding-left:.2em;color:var(--s3d-ink,#e8f1ec);opacity:.5}
.s3d-cluster.is-dim{opacity:.25}
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
@media (prefers-reduced-motion:reduce){.s3d-label,.s3d-cluster,.s3d-sat{animation:none}}
`;

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS;
  (document.head || document.documentElement).appendChild(st);
}

// ============================================================
// 3. 小工具：贴图
// ============================================================

function canvasTex(size, draw) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
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
  return { glow, ring, priv };
}

function makeBackground(theme) {
  return canvasTex(512, (g, s) => {
    const lin = g.createLinearGradient(0, 0, 0, s);
    lin.addColorStop(0, theme.top);
    lin.addColorStop(1, theme.bottom);
    g.fillStyle = lin;
    g.fillRect(0, 0, s, s);
    const rad = g.createRadialGradient(s * 0.5, s * 0.62, 0, s * 0.5, s * 0.62, s * 0.6);
    rad.addColorStop(0, theme.glow);
    rad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rad;
    g.fillRect(0, 0, s, s);
  });
}

// ---- 程序化行星贴图：值噪声 + fbm，按领域主色调色，三种质感 ----
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, seed, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (i) => ((i % period) + period) % period; // 横向无缝
  const a = hash2(w(xi), yi, seed), b = hash2(w(xi + 1), yi, seed);
  const c = hash2(w(xi), yi + 1, seed), d = hash2(w(xi + 1), yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, seed, period, oct) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(x * f, y * f, seed + o * 17, Math.round(period * f));
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hexRgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

function planetTexture(hex, variant, seed) {
  const W = 256, H = 128;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const img = g.createImageData(W, H);
  const base = hexRgb(hex);
  const deep = mixc(base, [8, 10, 28], 0.62);
  const light = mixc(base, [255, 255, 255], 0.55);
  const warm = mixc(base, [255, 214, 150], 0.45);
  const P = 4; // 基础横向周期（整数，保证左右接缝无缝）
  for (let y = 0; y < H; y++) {
    const lat = y / (H - 1);                 // 0 北极 → 1 南极
    const polar = Math.abs(lat - 0.5) * 2;   // 0 赤道 → 1 极点
    for (let x = 0; x < W; x++) {
      const u = (x / W) * P, v = lat * 2.2;
      let col;
      if (variant === 0) {                   // 气态巨行星：带状 + 湍流
        const warp = fbm(u, v * 3, seed, P, 4) * 0.55;
        const band = 0.5 + 0.5 * Math.sin((lat * 11 + warp * 5) * Math.PI);
        const t = band * 0.75 + fbm(u * 2, v * 9, seed + 5, P * 2, 3) * 0.25;
        col = t < 0.5 ? mixc(deep, base, t * 2) : mixc(base, light, (t - 0.5) * 1.6);
      } else if (variant === 1) {            // 岩质：大陆 / 海洋 / 极冠
        const h = fbm(u, v * 2.4, seed, P, 5);
        if (h < 0.5) col = mixc(deep, mixc(base, deep, 0.35), h * 2);        // 海
        else col = mixc(mixc(base, warm, 0.5), light, (h - 0.5) * 2.2);      // 陆
        if (polar > 0.82) col = mixc(col, [240, 246, 255], clamp((polar - 0.82) * 5, 0, 0.92));
      } else {                               // 涡旋云海
        const w1 = fbm(u, v * 2.2, seed, P, 4);
        const w2 = fbm(u * 2 + w1 * 2.2, v * 4.4 + w1 * 2.2, seed + 9, P * 2, 4);
        const t = clamp(w2 * 1.25, 0, 1);
        col = mixc(mixc(deep, base, 0.5), mixc(base, light, 0.7), t);
      }
      const i = (y * W + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// 星球图鉴：同领域同变体共用贴图，避免每个节点各生成一张（disposeScene 时统一释放）
const _planetTexCache = new Map();
function getPlanetTex(domainKey, variant) {
  const di = DOMAIN_KEYS.indexOf(domainKey);
  const key = domainKey + ":" + variant;
  let t = _planetTexCache.get(key);
  if (!t) {
    t = planetTexture(domainOf(domainKey).hex, variant, 3 + variant * 11 + (di < 0 ? 3 : di * 7));
    _planetTexCache.set(key, t);
  }
  return t;
}
function hashStr(sv) {
  let h = 2166136261;
  for (let i = 0; i < sv.length; i++) { h ^= sv.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 大气层：菲涅尔边缘辉光（边缘最亮、正对相机处透明）
function atmosphereMaterial(hex) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(hex) }, uOpacity: { value: 1 } },
    vertexShader: "varying vec3 vN; varying vec3 vV;\n" +
      "void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "uniform vec3 uColor; uniform float uOpacity; varying vec3 vN; varying vec3 vV;\n" +
      "void main(){ float f = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.6); gl_FragColor = vec4(uColor * (0.6 + f), f * uOpacity); }",
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
  });
}

// 螺旋星系背景。原先是 7000 颗同尺寸点按 4 臂均匀撒开：臂间没有暗区、
// 臂上没有连续的亮带，看上去只是一片噪点，核球又正好压在图谱节点背后抢视线。
// 现在分三层叠出旋臂结构：
//   haze  沿臂中心的大颗柔光（加色）→ 让旋臂读成连续的光带
//   dust  臂内侧的暗尘带（普通混合，压暗 haze）→ 臂与臂间有清晰的分界
//   stars 大小/亮度按幂律分布的星点（加色，轻微闪烁）+ 臂上的粉色星云结
// 节点所在的内圈（r < GALAXY_CLEAR）整体压暗，星系只在图谱外围铺开，不和标签抢。
const GALAXY_CLEAR = 13;
const GALAXY_ARM_TWIST = 0.36;   // 对数螺旋的缠绕率：越大臂越紧

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 屏幕空间尺寸的柔光点材质：gl_PointSize 随距离衰减，片元是高斯光斑
function galaxyPointsMaterial({ soft = 4.0, opacity = 1, additive = true, dark = false }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uScale: { value: 400 }, uOpacity: { value: opacity },
      uTwinkle: { value: 1 }, uNear: { value: new THREE.Vector2(8, 22) },
    },
    vertexShader: [
      "attribute float aSize; attribute float aBright; attribute float aPhase;",
      "attribute vec3 color;",
      "uniform float uTime; uniform float uScale; uniform float uTwinkle; uniform vec2 uNear;",
      "varying vec3 vColor; varying float vBright;",
      "void main(){",
      "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
      "  float tw = 1.0 + uTwinkle * 0.28 * sin(uTime * (0.6 + fract(aPhase * 7.13) * 1.9) + aPhase * 6.2831);",
      "  vBright = aBright * tw * smoothstep(uNear.x, uNear.y, -mv.z); vColor = color;",
      "  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 1.0, 96.0);",
      "  gl_Position = projectionMatrix * mv;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform float uOpacity; varying vec3 vColor; varying float vBright;",
      "void main(){",
      "  vec2 c = gl_PointCoord - 0.5; float d2 = dot(c, c) * 4.0;",
      "  if (d2 > 1.0) discard;",
      `  float a = exp(-d2 * ${soft.toFixed(2)}) * (1.0 - d2);`,
      dark
        ? "  gl_FragColor = vec4(vColor, a * vBright * uOpacity);"
        : "  gl_FragColor = vec4(vColor * vBright * a * uOpacity, a * vBright * uOpacity);",
      "}",
    ].join("\n"),
    transparent: true, depthWrite: false, fog: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

function pointsLayer(n, fill, mat) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const size = new Float32Array(n), bright = new Float32Array(n), phase = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (fill(i, pos, col, size, bright, phase)) k++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aBright", new THREE.BufferAttribute(bright, 1));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function buildGalaxy() {
  const rnd = mulberry32(20261002);   // 固定种子：每次打开都是同一片银河，不会"跳"
  const gauss = () => {               // 近似正态（Irwin–Hall），臂的截面要中间密两侧疏
    let x = 0;
    for (let i = 0; i < 4; i++) x += rnd();
    return (x - 2) / 0.577;
  };
  const lowEnd = typeof navigator !== "undefined" && (navigator.hardwareConcurrency || 8) <= 4;
  const scale = lowEnd ? 0.6 : 1;
  const ARMS = [   // 两条主臂 + 两条次臂：主次分明才看得出"旋"
    { a0: 0, w: 1.0 }, { a0: Math.PI, w: 1.0 },
    { a0: Math.PI * 0.5, w: 0.3 }, { a0: Math.PI * 1.5, w: 0.3 },
  ];
  const armW = ARMS.reduce((s, a) => s + a.w, 0);
  const pickArm = () => {
    let x = rnd() * armW;
    for (const a of ARMS) { if ((x -= a.w) <= 0) return a; }
    return ARMS[0];
  };
  const R0 = 4, RMAX = GALAXY_RADIUS;
  // 对数螺旋 θ(r) = a0 + ln(r/R0)/k
  const armAngle = (arm, r) => arm.a0 + Math.log(Math.max(r, R0) / R0) / GALAXY_ARM_TWIST;
  const radial = () => R0 + Math.pow(rnd(), 1.15) * (RMAX - R0);
  // 径向亮度包络：内圈让给图谱，外缘柔和淡出，中间一圈最亮——星环像一道光晕托在图谱外围
  const clearFade = (r) => {
    const t = clamp((r - GALAXY_CLEAR * 0.55) / (GALAXY_CLEAR * 0.75), 0, 1);
    const o = clamp((r - RMAX * 0.55) / (RMAX * 0.5), 0, 1);
    return (0.12 + 0.88 * t * t * (3 - 2 * t)) * (1 - o * o * (3 - 2 * o));
  };
  const cCore = new THREE.Color(0xffe2b0), cArm = new THREE.Color(0xbfd4ff),
        cOuter = new THREE.Color(0x8a7dff), cHII = new THREE.Color(0xff8fc8),
        cHaze = new THREE.Color(0x6f8dff), cHazeIn = new THREE.Color(0xb48cff);
  const tmp = new THREE.Color();
  const thick = (r) => (0.55 + 1.4 * Math.exp(-r / 7)) * (1 - 0.5 * r / RMAX);

  // ---- haze：沿臂中心铺连续光带
  const HN = Math.round(480 * scale);
  const haze = pointsLayer(HN, (i, pos, col, size, bright, phase) => {
    const arm = pickArm();
    const r = R0 + 2 + Math.pow(rnd(), 0.9) * (RMAX - R0 - 2);
    const th = armAngle(arm, r) + gauss() * 0.08;
    const off = gauss() * (0.9 + r * 0.05);
    pos[i * 3] = Math.cos(th) * r + Math.cos(th + 1.57) * off;
    pos[i * 3 + 1] = gauss() * 0.35;
    pos[i * 3 + 2] = Math.sin(th) * r + Math.sin(th + 1.57) * off;
    const t = clamp(r / RMAX, 0, 1);
    tmp.copy(cHazeIn).lerp(cHaze, t);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    size[i] = (6 + rnd() * 7) * (0.75 + t * 0.8);
    bright[i] = 0.17 * arm.w * clearFade(r) * (1 - 0.45 * t);
    phase[i] = rnd();
    return true;
  }, galaxyPointsMaterial({ soft: 2.2, opacity: 1 }));
  haze.material.uniforms.uTwinkle.value = 0;

  // ---- dust：臂内侧（朝核心一侧）的暗带，压在 haze 之上、星点之下
  const DN = Math.round(520 * scale);
  const dust = pointsLayer(DN, (i, pos, col, size, bright, phase) => {
    const arm = ARMS[i % 2];   // 只给两条主臂画尘带
    const r = R0 + 4 + rnd() * (RMAX * 0.82 - R0 - 4);
    const th = armAngle(arm, r) - 0.16 - Math.abs(gauss()) * 0.05;
    const off = gauss() * 0.45;
    pos[i * 3] = Math.cos(th) * r + Math.cos(th + 1.57) * off;
    pos[i * 3 + 1] = gauss() * 0.12 + 0.05;
    pos[i * 3 + 2] = Math.sin(th) * r + Math.sin(th + 1.57) * off;
    col[i * 3] = 0.01; col[i * 3 + 1] = 0.008; col[i * 3 + 2] = 0.03;
    size[i] = 1.6 + rnd() * 2.2;
    bright[i] = 0.42 * clearFade(r) * (1 - 0.4 * r / RMAX);
    phase[i] = 0;
    return true;
  }, galaxyPointsMaterial({ soft: 2.0, opacity: 1, additive: false, dark: true }));
  dust.material.uniforms.uTwinkle.value = 0;

  // ---- stars：臂上的星 + 臂间稀疏星 + 小核球 + 星云结
  const SN = Math.round(GALAXY_STARS * scale);
  const stars = pointsLayer(SN, (i, pos, col, size, bright, phase) => {
    const u = rnd();
    let x, y, z, r, c, b, sz;
    if (u < 0.08) {
      // 核球：紧凑、偏暖、亮度被 clearFade 压住——中心是"小豆"本人，别抢
      r = Math.pow(rnd(), 1.8) * 6;
      const th = rnd() * Math.PI * 2;
      x = Math.cos(th) * r; z = Math.sin(th) * r; y = gauss() * 0.9 * (1 - r / 7);
      c = cCore; b = 0.55; sz = 0.18 + rnd() * 0.2;
    } else if (u < 0.80) {
      const arm = pickArm();
      r = radial();
      const th = armAngle(arm, r) + gauss() * 0.06;
      const off = gauss() * (0.55 + r * 0.035);
      x = Math.cos(th) * r + Math.cos(th + 1.57) * off;
      z = Math.sin(th) * r + Math.sin(th + 1.57) * off;
      y = gauss() * 0.28 * thick(r);
      const t = r / RMAX;
      tmp.copy(cArm).lerp(cOuter, clamp((t - 0.35) / 0.65, 0, 1));
      c = tmp.clone();
      b = (0.55 + 0.45 * arm.w) * (1 - Math.min(1, Math.abs(off) / 4) * 0.5);
      sz = 0.16 + Math.pow(rnd(), 6) * 0.9;   // 幂律：大多数很小，少数亮星
      b *= 1.15;
    } else if (u < 0.84) {
      // 星云结（HII 区）：沿主臂外侧的粉色亮团
      const arm = ARMS[(rnd() * 2) | 0];
      r = R0 + 6 + rnd() * (RMAX * 0.75 - R0 - 6);
      const th = armAngle(arm, r) + 0.05 + gauss() * 0.03;
      const off = gauss() * 0.4;
      x = Math.cos(th) * r + Math.cos(th + 1.57) * off;
      z = Math.sin(th) * r + Math.sin(th + 1.57) * off;
      y = gauss() * 0.15;
      c = cHII; b = 0.75; sz = 0.3 + rnd() * 0.4;
    } else {
      // 臂间与外晕：稀疏、暗，给星盘一个完整轮廓
      r = R0 + Math.pow(rnd(), 0.7) * (RMAX * 1.05 - R0);
      const th = rnd() * Math.PI * 2;
      x = Math.cos(th) * r; z = Math.sin(th) * r; y = gauss() * 0.5 * thick(r);
      tmp.copy(cArm).lerp(cOuter, clamp(r / RMAX, 0, 1));
      c = tmp.clone(); b = 0.28; sz = 0.12 + rnd() * 0.12;
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    size[i] = sz;
    bright[i] = b * clearFade(r) * (0.6 + rnd() * 0.4);
    phase[i] = rnd();
    return true;
  }, galaxyPointsMaterial({ soft: 5.0, opacity: 0.95 }));

  haze.renderOrder = -3;
  dust.renderOrder = -2;
  stars.renderOrder = -1;
  const g = new THREE.Group();
  g.add(haze, dust, stars);
  // 星盘略低于图谱平面并微倾：读作"托着星球的银河"，而不是和节点搅在一起
  g.position.y = -0.6;
  g.rotation.x = 0.95;
  g.userData.materials = [haze.material, dust.material, stars.material];
  return g;
}

// 远景星空：球壳上均匀撒点，大小/亮度各异
function buildBackStars(glowTex) {
  const N = BACK_STARS;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const tmp = new THREE.Color();
  const tints = [0xffffff, 0xcfe0ff, 0xffe9c8, 0xd9c8ff];
  for (let i = 0; i < N; i++) {
    const r = 150 + Math.random() * 120;
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph);
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    tmp.setHex(tints[(Math.random() * tints.length) | 0]);
    const b = 0.25 + Math.pow(Math.random(), 3) * 0.9;
    col[i * 3] = tmp.r * b; col[i * 3 + 1] = tmp.g * b; col[i * 3 + 2] = tmp.b * b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: 1.6, map: glowTex, vertexColors: true, transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
  }));
}

// additive 材质登记处（夜色竹林的发光光晕统一走 AdditiveBlending）。
// R 建好之前创建的材质（如领域簇 halo）先存 early，R 初始化时并入。
const _earlyAdditive = [];
function regAdditive(mat) {
  if (!R) {
    _earlyAdditive.push(mat);
  } else {
    R.additive.add(mat);
  }
  return mat;
}

// ============================================================
// 4. 节点数据辅助
// ============================================================

function domainOf(key) {
  return DOMAINS[key] || OTHER_DOMAIN;
}

function anchorOf(key, out) {
  const i = DOMAIN_KEYS.indexOf(key);
  if (i < 0) return out.set(0, -3.2, 0);
  const a = -Math.PI / 2 + (i * Math.PI * 2) / DOMAIN_KEYS.length;
  return out.set(Math.cos(a) * ANCHOR_R, ANCHOR_Y[i] || 0, Math.sin(a) * ANCHOR_R);
}

function radiusOf(w) {
  const x = Number(w);
  return 0.42 + 0.13 * Math.sqrt(Number.isFinite(x) && x > 0 ? Math.min(x, 400) : 1);
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
    // 三组模块同时发请求：原先是"主体 → 后处理 → 熊猫"三轮串行，
    // 弱网下光排队就要多等两个往返。后两组可选，失败/超时都只降级不报错。
    const optional = (p, ms, why) => withTimeout(p, ms, why).catch(() => null);
    const postP = optional(Promise.all([
      import("./vendor/addons/postprocessing/EffectComposer.js"),
      import("./vendor/addons/postprocessing/RenderPass.js"),
      import("./vendor/addons/postprocessing/UnrealBloomPass.js"),
      import("./vendor/addons/postprocessing/OutputPass.js"),
      import("./vendor/addons/environments/RoomEnvironment.js"),
    ]), 6000, "postprocessing timeout");
    const pandaP = optional(import("./panda3d.js"), 6000, "panda timeout");
    const mods = await withTimeout(
      Promise.all([
        import("./vendor/three.module.min.js"),
        // ?v=2：OrbitControls 打过本地补丁（滚轮缩放在页面缩放 <100% 时会除以 0），
        // 而 /static/vendor/ 是按 immutable 长缓存的（max-age=86400），换 URL 才能让
        // 已经装过 SW / 缓存过旧文件的浏览器真正拿到修复，不用手动清缓存。
        import("./vendor/OrbitControls.js?v=2"),
        import("./vendor/CSS2DRenderer.js"),
      ]),
      8000,
      "3D 模块加载超时"
    );
    THREE = mods[0];
    const [post, panda] = await Promise.all([postP, pandaP]);
    build(container, hiddenCanvas, mods[1].OrbitControls, mods[2], panda, post);
  })();
  const p = initPromise;
  p.then(
    () => { initPromise = null; },
    (e) => {
      initPromise = null;
      try { if (R) disposeScene(); } catch (_) {}
      console.warn("[scene3d] 初始化失败：", e && e.message);
    }
  );
  return p;
}

function build(container, hiddenCanvas, OrbitControls, CSS2D, pandaMod, post) {
  injectStyle();

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
  container.appendChild(root);

  renderer.setClearColor(0x02030a, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  // ---- 场景 ----
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 600);
  camera.position.set(0, 12, 34);
  const tex = makeTextures();
  const bgTex = { dark: makeBackground(THEMES.dark) };
  scene.background = bgTex.dark;
  scene.fog = new THREE.FogExp2(THEMES.dark.fog, THEMES.dark.fogD);

  // PMREM 环境反射：让 PBR 材质有商业级高光层次（失败则跳过）
  let envTex = null, pmrem = null;
  if (post && post[4] && post[4].RoomEnvironment) {
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      envTex = pmrem.fromScene(new post[4].RoomEnvironment(renderer), 0.06).texture;
      scene.environment = envTex;
    } catch (_) { envTex = null; }
  }

  const hemi = new THREE.HemisphereLight(0x9fb4ff, THEMES.dark.hemiGround, THEMES.dark.hemi);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xdfe6ff, 1.1);   // 月光主光（暖白）
  key.position.set(6, 12, 9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8a6cff, 0.9);   // 冷绿轮廓光
  rim.position.set(-8, 3, -10);
  scene.add(rim);
  const fill = new THREE.PointLight(0xffc98a, 950, 0, 2); // 暖色底光（灯笼感）
  fill.position.set(0, 0.6, 0);
  scene.add(fill);

  // 中心"星球"柔光核：远处看是一颗微光星球
  const coreMat = new THREE.SpriteMaterial({
    map: tex.glow, color: THEMES.dark.core, transparent: true, opacity: THEMES.dark.coreOp,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const core = new THREE.Sprite(coreMat);
  core.scale.setScalar(11);
  scene.add(core);

  const world = new THREE.Group();
  scene.add(world);

  // 地台：柔光圆盘 + 同心圆
  const ground = new THREE.Group();
  ground.position.y = -0.3;
  const discMat = new THREE.MeshBasicMaterial({
    map: tex.glow, color: THEMES.dark.disc, transparent: true, opacity: THEMES.dark.discOp,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), discMat);
  disc.rotation.x = -Math.PI / 2;
  ground.add(disc);
  const circleMat = new THREE.LineBasicMaterial({ color: THEMES.dark.circle, transparent: true, opacity: THEMES.dark.circleOp, depthWrite: false });
  for (const r of [5, 10.5, 16, 22]) {
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    ground.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), circleMat));
  }
  world.add(ground);

  // 星尘
  const DUST = 260;
  const dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    const r = 14 + Math.random() * 26;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    dustPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    dustPos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
    dustPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    size: 0.32, map: tex.glow, color: THEMES.dark.dust, transparent: true, opacity: THEMES.dark.dustOp,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  scene.add(dust);
  // 银河：螺旋臂星盘（缓慢自转）+ 远景星空球壳
  const galaxy = buildGalaxy();
  scene.add(galaxy);
  const backStars = buildBackStars(tex.glow);
  scene.add(backStars);

  // 中心到五领域的虚线辐条
  const spokeMat = new THREE.LineDashedMaterial({ color: THEMES.dark.spoke, dashSize: 0.35, gapSize: 0.45, transparent: true, opacity: THEMES.dark.spokeOp, depthWrite: false });
  const spokePts = [];
  const tmpA = new THREE.Vector3();
  for (const k of DOMAIN_KEYS) {
    anchorOf(k, tmpA);
    spokePts.push(new THREE.Vector3(0, 0, 0), tmpA.clone());
  }
  const spokes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokePts), spokeMat);
  spokes.computeLineDistances();
  world.add(spokes);

  // 领域簇：柔光 + 标签
  const clusters = {};
  for (const k of DOMAIN_KEYS) {
    const d = DOMAINS[k];
    const g = new THREE.Group();
    anchorOf(k, g.position);
    const halo = new THREE.Sprite(regAdditive(new THREE.SpriteMaterial({
      map: tex.glow, color: d.hex, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    })));
    halo.scale.setScalar(9);
    g.add(halo);
    const el = document.createElement("div");
    el.className = "s3d-cluster";
    el.style.setProperty("--c", d.css);
    const ch = document.createElement("div");
    ch.className = "s3d-cluster-ch";
    ch.textContent = d.ch;
    const nm = document.createElement("div");
    nm.className = "s3d-cluster-name";
    nm.textContent = d.name;
    el.appendChild(ch);
    el.appendChild(nm);
    const lab = new CSS2D.CSS2DObject(el);
    lab.position.set(0, 3.6, 0);
    g.add(lab);
    world.add(g);
    clusters[k] = { group: g, halo, lab, el, count: 0, target: new THREE.Vector3().copy(g.position), dimmed: false, alpha: 0 };
  }

  // 边：一个 LineSegments，RGBA 顶点色
  const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });

  // 共享几何
  const sphereGeo = new THREE.SphereGeometry(1, 40, 26);
  const satGeo = new THREE.IcosahedronGeometry(1, 1);

  // ---- 控制 ----
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.7;
  controls.minDistance = 4;
  controls.maxDistance = 96;
  controls.maxPolarAngle = Math.PI * 0.86;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;
  controls.target.set(0, 0, 0);

  R = {
    container, hiddenCanvas, restorePos, root, canvas, renderer, css2d, CSS2D, tip,
    scene, camera, controls, world, tex, bgTex, hemi, key, rim, fill, core, ground, dust, galaxy, backStars, spokes, clusters,
    discMat, circleMat, spokeMat, dustMat, coreMat,
    additive: new Set([coreMat, discMat, dustMat, ..._earlyAdditive]),
    composer: null, bloom: null, envTex, pmrem,
    edgeMat, edgeLines: null, edgeCap: 0, edgeList: [],
    edgeShade: 1, haloBoost: 1,
    sphereGeo, satGeo,
    nodes: new Map(), // id -> ns
    order: [], // ns 列表（稳定）
    selfId: null,
    sim: { alpha: 0 },
    w: 0, h: 0, dpr: 1,
    running: false, raf: 0, last: 0, time: 0,
    hidden: typeof document !== "undefined" && document.hidden,
    intersecting: true,
    lost: false,
    ready: false,
    failed: false,
    fps: { active: 0, frames: 0, done: false },
    lastInteract: -1e9,
    dragging: false,
    pointer: { x: 0, y: 0, ndcX: 0, ndcY: 0, inside: false, dirty: false, downX: 0, downY: 0, downT: 0, down: false, type: "mouse" },
    hover: null,
    focusId: null,
    fly: null,
    raycaster: new THREE.Raycaster(),
    pickList: [],
    ndc: new THREE.Vector2(),
    v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), v4: new THREE.Vector3(),
    col: new THREE.Color(), col2: new THREE.Color(), gray: new THREE.Color(0x7d8b88), amber: new THREE.Color(AMBER),
    plan: null,
    planFading: [],
    bursts: [],
    labelBudget: 8,
    panda: null,
    listeners: [],
    observers: [],
    lostTimer: 0,
  };

  // ---- 熊猫（可选，左下角小视窗，不遮挡图谱主体）----
  if (pandaMod && typeof pandaMod.createPanda === "function") {
    try {
      pandaMod.useThree && pandaMod.useThree(THREE);
      const pScene = new THREE.Scene();
      if (envTex) pScene.environment = envTex;
      pScene.add(new THREE.HemisphereLight(0xf5f4ee, 0x68747b, 0.6));
      const pk = new THREE.DirectionalLight(0xfff3e2, 1.8);
      pk.position.set(-5.5, 7.5, 6);
      pk.target.position.set(0, 3.2, 0);
      pk.castShadow = true;
      pk.shadow.mapSize.set(1024, 1024);
      pk.shadow.camera.left = -5;
      pk.shadow.camera.right = 5;
      pk.shadow.camera.top = 5;
      pk.shadow.camera.bottom = -5;
      pk.shadow.camera.near = 1;
      pk.shadow.camera.far = 24;
      pk.shadow.normalBias = 0.035;
      pk.shadow.bias = -0.0001;
      pk.shadow.radius = 2.5;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      pScene.add(pk.target);
      pScene.add(pk);
      const pkFill = new THREE.DirectionalLight(0xe4edf4, 0.38);
      pkFill.position.set(5, 3, 5);
      pScene.add(pkFill);
      const pkRim = new THREE.DirectionalLight(0xf7f3e9, 1.3);
      pkRim.position.set(3, 6, -4);
      pScene.add(pkRim);
      const group = pandaMod.createPanda(THREE, { scale: 1 });
      group.rotation.y = 0.23;
      pScene.add(group);
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const contactTexture = canvasTex(128, (g, s) => {
        const gradient = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        gradient.addColorStop(0, "rgba(0,0,0,0.5)");
        gradient.addColorStop(0.45, "rgba(0,0,0,0.25)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gradient;
        g.fillRect(0, 0, s, s);
      });
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(5.4, 3.6),
        new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false })
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(center.x, box.min.y + 0.02, center.z);
      pScene.add(shadow);
      const pCam = new THREE.PerspectiveCamera(25, 1, 0.1, 200);
      const dist = (size.y * 1.22) / (2 * Math.tan((25 * Math.PI) / 360));
      pCam.position.set(center.x, center.y + size.y * 0.045, center.z + dist);
      pCam.lookAt(center.x, center.y, center.z);
      R.panda = { mod: pandaMod, scene: pScene, cam: pCam, group, rect: { x: 0, y: 0, w: 0, h: 0, on: false } };
      pandaMod.setPandaMood(group, cfg.mood);
    } catch (e) {
      console.debug("[scene3d] 熊猫不可用：", e && e.message);
      R.panda = null;
    }
  }

  // ---- 后处理链：RenderPass → Bloom → Output（加载失败自动降级普通渲染）----
  if (post && post[0] && post[1] && post[2] && post[3]) {
    try {
      const composer = new post[0].EffectComposer(renderer);
      composer.addPass(new post[1].RenderPass(scene, camera));
      const bloom = new post[2].UnrealBloomPass(new THREE.Vector2(512, 512), 0.62, 0.5, 0.8);
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
  ensureScratch();
  measure();
  fitOverview(true);
  R.ready = true;
  if (R.w > 0 && R.h > 0) renderFrame(0);
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
    R.pointer.dirty = true;
  });
  on(canvas, "pointerdown", (e) => {
    const p = R.pointer;
    p.down = true;
    p.downX = e.clientX;
    p.downY = e.clientY;
    p.downT = nowMs();
    R.lastInteract = nowMs();
    stopAutoRotate();
  });
  on(canvas, "pointerup", (e) => {
    const p = R.pointer;
    if (!p.down) return;
    p.down = false;
    const moved = Math.hypot(e.clientX - p.downX, e.clientY - p.downY);
    if (moved > 6 || nowMs() - p.downT > 700) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    handleTap(x, y, rect);
  });
  on(canvas, "wheel", () => { R.lastInteract = nowMs(); stopAutoRotate(); }, { passive: true });

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
    const ro = new ResizeObserver(() => { if (R) { measure(); layoutPandaRect(); updateRunning(); } });
    ro.observe(container);
    const bubble = container.id === "scene-canvas" && document.getElementById("panda-bubble");
    if (bubble) ro.observe(bubble);
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

function measure() {
  if (!R) return;
  const el = R.container;
  const w = Math.floor(el.clientWidth || 0);
  const h = Math.floor(el.clientHeight || 0);
  const many = R.order.length > 60;
  const dpr = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, many ? 1.5 : 2);
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
  // 星系点精灵按"世界尺寸 → 像素"换算：视口高度 × DPR / (2·tan(fov/2))
  const pxScale = (h * dpr) / (2 * Math.tan((R.camera.fov * Math.PI) / 360));
  for (const m of R.galaxy.userData.materials) m.uniforms.uScale.value = pxScale;
  R.labelBudget = w * h > 700000 ? 16 : w * h > 300000 ? 11 : 7;
  layoutPandaRect();
  if (R.ready && !R.running) renderFrame(0);
}

function layoutPandaRect() {
  const P = R.panda;
  if (!P) return;
  const r = P.rect;
  r.on = R.w >= 240 && R.h >= 220;
  const bubble = R.container.id === "scene-canvas" && document.getElementById("panda-bubble");
  const bubbleHeight = bubble && !bubble.classList.contains("hidden") ? bubble.offsetHeight : 0;
  const bottom = bubbleHeight ? bubbleHeight + 28 : 12;
  const s = Math.round(Math.min(clamp(R.h * 0.44, 140, 258), R.w * 0.58, Math.max(72, R.h - bottom - 48)));
  r.w = Math.round(s * 0.88);
  r.h = s;
  r.x = 12;
  r.y = bottom; // 距底部（WebGL 视口原点在左下），给问候气泡留位置
  P.cam.aspect = r.w / r.h;
  P.cam.updateProjectionMatrix();
}

function canRun() {
  return R && R.ready && !R.failed && !R.lost && !R.hidden && R.intersecting && R.w > 0 && R.h > 0;
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
  // 尺寸兜底：ResizeObserver 在某些重挂载场景下可能晚到
  if (R.container.clientWidth !== R.w || R.container.clientHeight !== R.h) {
    measure();
    if (!canRun()) { updateRunning(); return; }
  }
  renderFrame(dt);
  fpsCheck(dt);
}

function fpsCheck(dt) {
  const f = R.fps;
  if (f.done) return;
  f.active += dt;
  if (f.active < 1) return; // 跳过着色器编译的头 1 秒
  f.frames++;
  f.time = (f.time || 0) + dt;
  if (f.active >= 5) {
    f.done = true;
    const fps = f.frames / Math.max(0.001, f.time);
    if (fps < 20) triggerFallback("帧率不足");
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
// 7. 图数据同步 + 力导向布局
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

  // 中心"自己"节点：权重最高的 person
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
  // 移除
  for (const ns of R.order) {
    if (!seen.has(ns.id) && !ns.dying) {
      ns.dying = true;
      ns.visTarget = 0;
    }
  }

  // 新节点初始位置：邻居附近 / 领域锚点附近
  if (added.length) {
    const adj = buildAdjacency(data.edges);
    for (const ns of added) {
      if (ns.id === R.selfId) { ns.p.set(0, 0, 0); continue; }
      const nb = (adj.get(ns.id) || []).map((id) => R.nodes.get(id)).find((o) => o && !added.includes(o));
      if (nb) ns.p.copy(nb.p);
      else anchorOf(ns.data.domain, ns.p);
      ns.p.x += (Math.random() - 0.5) * 2.4;
      ns.p.y += (Math.random() - 0.5) * 2.4;
      ns.p.z += (Math.random() - 0.5) * 2.4;
    }
    const firstLayout = R.order.length === added.length;
    for (const ns of R.order) ns.mob = added.includes(ns) || firstLayout ? 1 : 0.12;
    if (firstLayout) {
      R.sim.alpha = 1;
      for (let i = 0; i < 260 && R.sim.alpha > 0.02; i++) simTick();
      // 入场：错峰弹出
      added.forEach((ns, i) => { ns.appearDelay = 0.15 + (i / Math.max(1, added.length)) * 0.9; });
    } else {
      R.sim.alpha = Math.max(R.sim.alpha, 0.4);
    }
    if (!initial || !firstLayout) for (const ns of added) if (!firstLayout) ns.appearDelay = 0;
  }
  rebuildEdges();
  applyVisibility();
  if (added.length && R.order.length > 60) measure();
}

function buildAdjacency(edges) {
  const m = new Map();
  for (const e of edges) {
    const s = idOf(e.source), t = idOf(e.target);
    if (!m.has(s)) m.set(s, []);
    if (!m.has(t)) m.set(t, []);
    m.get(s).push(t);
    m.get(t).push(s);
  }
  return m;
}

function createNodeState(n) {
  const group = new THREE.Group();
  const th = THEMES[R.theme] || THEMES.dark;
  const mat = new THREE.MeshStandardMaterial({ roughness: th.rough, metalness: 0.08, transparent: true, envMapIntensity: th.env });
  const mesh = new THREE.Mesh(R.sphereGeo, mat);
  const variant = hashStr(String(n.id)) % PLANET_VARIANTS;
  const atmoMat = atmosphereMaterial(0xffffff);
  const atmo = new THREE.Mesh(R.sphereGeo, atmoMat);
  atmo.scale.setScalar(1.16);
  mesh.add(atmo);
  const spin = 0.05 + ((hashStr(String(n.id) + 's') % 100) / 100) * 0.14;
  mesh.rotation.z = ((hashStr(String(n.id) + 't') % 100) / 100 - 0.5) * 0.7;
  mesh.userData.nid = n.id;
  group.add(mesh);
  const halo = new THREE.Sprite(regAdditive(new THREE.SpriteMaterial({
    map: R.tex.glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  })));
  group.add(halo);
  const el = document.createElement("div");
  el.className = "s3d-label";
  const dot = document.createElement("span");
  dot.className = "s3d-dot";
  const txt = document.createElement("span");
  el.appendChild(dot);
  el.appendChild(txt);
  const label = new R.CSS2D.CSS2DObject(el);
  label.visible = false;
  group.add(label);
  group.visible = false;
  R.world.add(group);
  return {
    id: n.id, data: n, group, mesh, mat, halo, label, el, txt, atmo, atmoMat, spin, variant, tint: new THREE.Color(),
    ring: null, priv: null,
    p: new THREE.Vector3(), v: new THREE.Vector3(),
    mob: 1, r: 0.4, rec: 1, baseOpacity: 1, emissBase: 0.2,
    vis: 0, visTarget: 1, dim: 1, dimTarget: 1,
    appear: 0, appearDelay: 0, dying: false,
    pulseUntil: 0, pulseColor: AMBER, spawnedAt: 0,
    labelOn: false, labelCls: "", sig: "",
  };
}

function styleNode(ns) {
  const n = ns.data;
  const sig = [n.domain, n.status, !!n.private, n.weight, n.last_seen, n.label].join("|");
  if (sig === ns.sig) return;
  ns.sig = sig;
  const d = domainOf(n.domain);
  ns.r = radiusOf(n.weight) * (n.id === R.selfId ? 1.15 : 1);
  const lt = timeOf(n.last_seen);
  ns.rec = Number.isFinite(lt) ? clamp(1 - (R.refTime - lt) / (RECENT_DAYS * 86400000), 0.28, 1) : 0.4;
  const dropped = n.status === "dropped";
  const c = R.col.setHex(d.hex);
  if (dropped) c.lerp(R.gray, 0.65);
  ns.tint.copy(c);
  const ptex = getPlanetTex(DOMAINS[n.domain] ? n.domain : 'ethics', ns.variant);
  if (ns.mat.map !== ptex) { ns.mat.map = ptex; ns.mat.emissiveMap = ptex; ns.mat.needsUpdate = true; }
  ns.mat.color.set(dropped ? 0x7d8b99 : 0xffffff);
  ns.mat.emissive.set(0xffffff);
  ns.emissBase = n.id === R.selfId ? 0.85 : dropped ? 0.05 : 0.07 + 0.2 * ns.rec;
  ns.atmoMat.uniforms.uColor.value.copy(c);
  ns.mat.emissiveIntensity = ns.emissBase * (THEMES[R.theme] || THEMES.dark).emiss;
  ns.baseOpacity = dropped ? 0.42 : 1;
  ns.halo.material.color.copy(c);
  ns.haloBase = dropped ? 0.08 : 0.16 + 0.42 * ns.rec;

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

  // 标签
  let text = str(n.label || n.id);
  if (text.length > 12) text = text.slice(0, 11) + "…";
  ns.txt.textContent = text;
  ns.el.style.setProperty("--c", d.css);
  ns.label.position.set(0, ns.r + 0.3, 0);
  ns.labelCls = "";
}

function simTick() {
  const list = R.order;
  const n = list.length;
  const alpha = R.sim.alpha;
  const A = R.v1, D = R.v2;
  // 斥力
  for (let i = 0; i < n; i++) {
    const a = list[i];
    if (a.dying) continue;
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      if (b.dying) continue;
      D.subVectors(a.p, b.p);
      let d2 = D.lengthSq();
      if (d2 < 0.0001) { D.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5); d2 = 0.01; }
      const minD = (a.r + b.r) * 2.0;
      const f = (5.5 * alpha) / Math.max(d2, 0.25) + (d2 < minD * minD ? 0.25 * alpha : 0);
      const inv = f / Math.sqrt(d2);
      a.v.addScaledVector(D, inv * a.mob);
      b.v.addScaledVector(D, -inv * b.mob);
    }
  }
  // 弹簧
  for (const e of R.edgeList) {
    const a = e.a, b = e.b;
    D.subVectors(b.p, a.p);
    const d = Math.max(0.01, D.length());
    const rest = a.data.domain === b.data.domain ? 2.4 : 4.2;
    const f = ((d - rest) * 0.045 * alpha) / d;
    a.v.addScaledVector(D, f * a.mob);
    b.v.addScaledVector(D, -f * b.mob);
  }
  // 领域引力 + 积分
  for (const a of list) {
    if (a.id === R.selfId) { a.p.set(0, 0, 0); a.v.set(0, 0, 0); continue; }
    anchorOf(a.data.domain, A);
    D.subVectors(A, a.p);
    a.v.addScaledVector(D, 0.035 * alpha * a.mob);
    a.v.multiplyScalar(0.78);
    const sp = a.v.length();
    if (sp > 0.6) a.v.multiplyScalar(0.6 / sp);
    a.p.add(a.v);
  }
  R.sim.alpha *= 0.975;
  if (R.sim.alpha < 0.02) R.sim.alpha = 0;
}

function rebuildEdges() {
  const list = [];
  const seenPair = new Set();
  for (const e of cfg.graph.edges) {
    const s = idOf(e.source), t = idOf(e.target);
    const a = R.nodes.get(s), b = R.nodes.get(t);
    if (!a || !b || a === b || a.dying || b.dying) continue;
    const k = s < t ? s + "\u0001" + t : t + "\u0001" + s;
    if (seenPair.has(k)) continue;
    seenPair.add(k);
    const old = R.edgeList.find((x) => x.k === k);
    list.push({ k, a, b, w: clamp(Number(e.weight) || 1, 1, 10), hlUntil: old ? old.hlUntil : 0, data: e });
  }
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
    const c = R.clusters[k];
    const dim = !!fd && fd !== k;
    if (dim !== c.dimmed) {
      c.dimmed = dim;
      c.el.classList.toggle("is-dim", dim);
    }
  }
  if (R.hover && R.hover.visTarget === 0) R.hover = null;
  if (!R.running && R.ready) renderFrame(0);
}

function applyTheme() {
  if (!R) return;
  // 场景固定用夜色竹林主题；角色只决定"看得到哪些节点"，不改场景明暗（否则切视角时整屏闪）
  const th = THEMES.dark;
  R.theme = "dark";
  R.scene.background = R.bgTex.dark;
  R.scene.fog.color.setHex(th.fog);
  R.scene.fog.density = th.fogD;
  R.hemi.intensity = th.hemi;
  R.hemi.groundColor.setHex(th.hemiGround);
  R.key.intensity = th.key;
  R.rim.intensity = th.rim;
  R.fill.intensity = th.fill;
  R.renderer.toneMappingExposure = th.exposure;
  R.edgeBase = th.edge;
  if (R.bloom) R.bloom.strength = th.bloom;
  R.dustMat.color.setHex(th.dust);
  R.dustMat.opacity = th.dustOp;
  R.coreMat.color.setHex(th.core);
  R.coreMat.opacity = th.coreOp;
  R.discMat.color.setHex(th.disc);
  R.discMat.opacity = th.discOp;
  R.circleMat.color.setHex(th.circle);
  R.circleMat.opacity = th.circleOp;
  R.spokeMat.color.setHex(th.spoke);
  R.spokeMat.opacity = th.spokeOp;
  const blend = th.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  for (const m of R.additive) {
    if (m.blending !== blend) {
      m.blending = blend;
      m.needsUpdate = true;
    }
  }
}

// ============================================================
// 9. 每帧
// ============================================================

function renderFrame(dt) {
  if (!R) return;
  R.time += dt;
  const time = R.time;
  const tms = nowMs();

  if (R.sim.alpha > 0) {
    simTick();
    simTick();
  }

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
  } else if (!R.controls.autoRotate && !R.dragging && tms - R.lastInteract > IDLE_RESUME_MS) {
    R.controls.autoRotate = true;
  }
  R.controls.update();

  // 节点
  const k6 = 1 - Math.exp(-dt * 6);
  const k10 = 1 - Math.exp(-dt * 10);
  for (let i = 0; i < R.clusterSums.length; i++) R.clusterSums[i].set(0, 0, 0);
  R.clusterCounts.fill(0);
  let anyDead = false;
  for (const ns of R.order) {
    ns.vis += (ns.visTarget - ns.vis) * (dt === 0 ? 1 : k6);
    ns.dim += (ns.dimTarget - ns.dim) * (dt === 0 ? 1 : k6);
    if (ns.appearDelay > 0) ns.appearDelay -= dt;
    else if (ns.appear < 1) ns.appear = Math.min(1, ns.appear + dt / 0.6);
    const shown = ns.vis > 0.01 && ns.appear > 0;
    if (!shown) {
      if (ns.group.visible) ns.group.visible = false;
      if (ns.label.visible) ns.label.visible = false;
      if (ns.dying && ns.vis < 0.01) anyDead = true;
      continue;
    }
    if (!ns.group.visible) ns.group.visible = true;
    ns.group.position.copy(ns.p);
    const di = DOMAIN_KEYS.indexOf(ns.data.domain);
    if (di >= 0 && ns.visTarget > 0) {
      R.clusterSums[di].add(ns.p);
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
    ns.mesh.rotation.y += dt * ns.spin;
    const op = ns.baseOpacity * ns.vis * ns.dim;
    ns.mat.opacity = op;
    ns.mat.depthWrite = op > 0.9;
    ns.mesh.visible = op > 0.01;
    ns.atmoMat.uniforms.uOpacity.value = 0.85 * op;
    const breathe = 1 + 0.06 * Math.sin(time * 1.6 + ns.p.x);
    ns.halo.scale.setScalar(s * (4.2 + 2.4 * pulse + hov) * breathe);
    if (pulse > 0) {
      ns.halo.material.color.copy(ns.tint).lerp(R.amber, 0.6 * pulse);
    } else if (ns.haloTinted) {
      ns.halo.material.color.copy(ns.tint);
    }
    ns.haloTinted = pulse > 0;
    ns.halo.material.opacity = Math.min(1, (ns.haloBase + 0.5 * pulse + 0.2 * hov) * ns.vis * ns.dim * R.haloBoost);
    if (ns.ring) {
      ns.ring.scale.setScalar(s * 2.9);
      ns.ring.material.opacity = 0.9 * ns.vis * ns.dim;
      ns.ring.material.rotation = time * 0.4;
    }
    if (ns.priv) {
      ns.priv.scale.setScalar(s * 3.4);
      ns.priv.material.opacity = 0.75 * ns.vis * ns.dim;
    }
    ns.label.position.y = s + 0.3;
  }
  if (anyDead) reapNodes();

  // 簇标签跟随质心
  for (let i = 0; i < DOMAIN_KEYS.length; i++) {
    const c = R.clusters[DOMAIN_KEYS[i]];
    const cnt = R.clusterCounts[i];
    if (cnt > 0) c.target.copy(R.clusterSums[i]).multiplyScalar(1 / cnt);
    c.group.position.lerp(c.target, dt === 0 ? 1 : k6 * 0.5);
    const want = cnt > 0 ? (c.dimmed ? 0.04 : 0.12) : 0;
    c.alpha += (want - c.alpha) * (dt === 0 ? 1 : k6);
    c.halo.material.opacity = Math.min(1, c.alpha * R.haloBoost);
    c.halo.visible = c.alpha > 0.003;
    const vis = cnt > 0;
    if (c.lab.visible !== vis) c.lab.visible = vis;
  }

  updateEdges(tms, time);
  updateLabels(tms);
  updatePlan(dt, tms, time);
  updateBursts(dt);

  R.dust.rotation.y += dt * 0.01;
  R.galaxy.rotation.y += dt * 0.006;
  for (const m of R.galaxy.userData.materials) m.uniforms.uTime.value = time;
  R.backStars.rotation.y -= dt * 0.002;

  // 悬停拾取
  if (R.pointer.dirty && !R.dragging) {
    R.pointer.dirty = false;
    doHover();
  }

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

  // 熊猫小视窗
  const P = R.panda;
  if (P && P.rect.on) {
    try {
      P.mod.updatePanda(P.group, dt);
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
    const p6 = i * 6, c8 = i * 8;
    pos[p6] = a.p.x; pos[p6 + 1] = a.p.y; pos[p6 + 2] = a.p.z;
    pos[p6 + 3] = b.p.x; pos[p6 + 4] = b.p.y; pos[p6 + 5] = b.p.z;
    const vis = Math.min(a.vis, b.vis) * Math.min(a.appear, b.appear);
    const dim = Math.min(a.dim, b.dim);
    let alpha = base * (0.55 + 0.08 * e.w) * vis * dim;
    ca.copy(a.tint);
    cb.copy(b.tint);
    if (R.edgeShade !== 1) { ca.multiplyScalar(R.edgeShade); cb.multiplyScalar(R.edgeShade); }
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

// ---- 标签互斥：屏幕空间 AABB 占位 ----------------------------------
// 原来只按权重取前 labelBudget 个，但 ① 悬停/高亮/聚焦/新生这些"豁免项"
// 完全绕过预算（连续召回时可见标签无上限增长）；② 簇标签走独立循环，
// 根本不参与互斥。结果就是"德智体美劳"和节点名互相压在一起，文字糊成一团。
// 现在改成：簇标签先占位（辨识度高，优先保住），节点标签按权重依次抢位，
// 撞上的这一帧就不发——下一帧它们的位置变了还会再试，不会永久消失。
const LABEL_PAD = 3;   // px，标签之间留一点缝
const LABEL_W = 60;    // 兜底宽度（标签还没显示过、量不到时）
const LABEL_H = 18;
const LABEL_BONUS = 3; // 豁免项（悬停/高亮/聚焦/新生）单独给几个位，别无限堆

function labelSize(holder) {
  // 只在标签当前可见时量（量得到才准），量到就缓存，避免每帧强制重排
  const w = holder.el && holder.el.offsetWidth;
  const h = holder.el && holder.el.offsetHeight;
  if (w > 0 && h > 0) { holder.lw = w; holder.lh = h; }
  return { w: holder.lw || LABEL_W, h: holder.lh || LABEL_H };
}

/** 世界坐标 → 标签的屏幕 AABB；相机背后返回 null */
function labelRectAt(pos, holder) {
  R.v3.copy(pos).project(R.camera);
  if (R.v3.z > 1) return null;               // 在相机背面，CSS2D 也不画
  const s = labelSize(holder);
  const out = R.labelProbe;
  out.w = s.w; out.h = s.h;
  out.x = (R.v3.x + 1) * (R.w / 2) - s.w / 2;  // CSS2D 用 translate(-50%,-50%)
  out.y = (1 - R.v3.y) * (R.h / 2) - s.h / 2;
  return out;
}

function rectHits(a, b) {
  return a.x < b.x + b.w + LABEL_PAD && a.x + a.w + LABEL_PAD > b.x &&
         a.y < b.y + b.h + LABEL_PAD && a.y + a.h + LABEL_PAD > b.y;
}

// 标签：按权重发放 + 屏幕空间互斥；只显示重要 / 悬停 / 高亮 / 聚焦 / 新生节点
function updateLabels(tms) {
  const cand = R.labelCand;
  cand.length = 0;
  for (const ns of R.order) {
    if (ns.visTarget > 0 && ns.dimTarget > 0.5 && ns.appear > 0.6 && ns.group.visible) cand.push(ns);
  }
  cand.sort(byWeightDesc);
  const budget = R.labelBudget;
  for (let i = 0; i < R.order.length; i++) R.order[i].wantLabel = false;

  const taken = R.labelRects;
  taken.length = 0;
  // 簇标签先占：只有"德智体美劳"这么几个，是识别整张图的骨架
  // （标签挂在 group 局部 (0,3.6,0)，要抬到真实位置再投影，否则矩形会算偏）
  for (let i = 0; i < DOMAIN_KEYS.length; i++) {
    const c = R.clusters[DOMAIN_KEYS[i]];
    if (!c || !R.clusterCounts[i] || !c.lab.visible) continue;
    R.v4.copy(c.group.position).add(c.lab.position);
    const r = labelRectAt(R.v4, c);
    if (r) taken.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }
  // 悬停 / 聚焦的节点是用户正盯着的那一个：最先占位、不受配额和互斥限制
  for (const ns of R.order) {
    if (!ns.group.visible || ns.vis <= 0.3) continue;
    if (R.hover !== ns && R.focusId !== ns.id) continue;
    ns.wantLabel = true;
    const r = labelRectAt(ns.p, ns);
    if (r) taken.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }
  // 节点标签按权重抢位
  for (let i = 0; i < cand.length && i < budget; i++) {
    const ns = cand[i];
    if (ns.wantLabel) continue;
    const r = labelRectAt(ns.p, ns);
    if (!r) continue;
    let hit = false;
    for (let j = 0; j < taken.length; j++) if (rectHits(r, taken[j])) { hit = true; break; }
    if (hit) continue;
    taken.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    ns.wantLabel = true;
  }
  // 豁免项：原来它们直接绕过预算，现在给一份独立的小配额并同样参与互斥
  let bonus = LABEL_BONUS;
  for (const ns of R.order) {
    if (ns.wantLabel || bonus <= 0) continue;
    if (!ns.group.visible || ns.vis <= 0.3) continue;
    const exempt = ns.pulseUntil > tms ||
                   (ns.spawnedAt && tms - ns.spawnedAt < 6000);
    if (!exempt) continue;
    const r = labelRectAt(ns.p, ns);
    if (!r) continue;
    let hit = false;
    for (let j = 0; j < taken.length; j++) if (rectHits(r, taken[j])) { hit = true; break; }
    if (hit) continue;
    taken.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    bonus--;
    ns.wantLabel = true;
  }
  for (const ns of R.order) {
    const hl = ns.pulseUntil > tms;
    const hov = R.hover === ns;
    const want = ns.wantLabel && ns.group.visible && ns.vis > 0.3;
    if (ns.label.visible !== want) ns.label.visible = want;
    if (!want) continue;
    const n = ns.data;
    const cls = "s3d-label" +
      (n.private ? " is-private" : "") +
      (n.status === "dropped" ? " is-dropped" : "") +
      (n.status === "done" ? " is-done" : "") +
      (hl ? " is-hl" : "") +
      (hov ? " is-hover" : "");
    if (cls !== ns.labelCls) {
      ns.labelCls = cls;
      ns.el.className = cls;
    }
  }
}
function byWeightDesc(a, b) {
  return (+b.data.weight || 0) - (+a.data.weight || 0);
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
  ns.atmoMat.dispose();
  ns.halo.material.dispose();
  if (ns.ring) ns.ring.material.dispose();
  if (ns.priv) ns.priv.material.dispose();
  if (ns.el.parentNode) ns.el.parentNode.removeChild(ns.el);
}

// ============================================================
// 10. 拾取 / 提示框
// ============================================================

function pickNode(ndcX, ndcY) {
  const list = R.pickList;
  list.length = 0;
  for (const ns of R.order) if (ns.group.visible && ns.mesh.visible && ns.visTarget > 0 && ns.dim > 0.3) list.push(ns.mesh);
  if (!list.length) return null;
  R.ndc.set(ndcX, ndcY);
  R.raycaster.setFromCamera(R.ndc, R.camera);
  const hits = R.raycaster.intersectObjects(list, false);
  if (hits.length) return R.nodes.get(hits[0].object.userData.nid) || null;
  // 小节点容差：屏幕距离 18px 内最近的节点
  let best = null, bestD = 18 * 18;
  for (const m of list) {
    R.v3.copy(m.parent.position).project(R.camera);
    if (R.v3.z > 1) continue;
    const dx = ((R.v3.x - ndcX) * R.w) / 2, dy = ((R.v3.y - ndcY) * R.h) / 2;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) { bestD = d2; best = m; }
  }
  return best ? R.nodes.get(best.userData.nid) || null : null;
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
  if (d.y < 0.12) { d.y = 0.25; d.normalize(); }
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
  if (!R.running && R.ready) {
    // 不在渲染（隐藏中）：直接到位
    cam.position.copy(R.fly.p1);
    R.controls.target.copy(R.fly.t1);
    R.fly = null;
  }
}

function visibleBounds(center) {
  let n = 0;
  center.set(0, 0, 0);
  for (const ns of R.order) if (ns.visTarget > 0) { center.add(ns.p); n++; }
  if (!n) return 10;
  center.multiplyScalar(1 / n);
  let r = 0;
  for (const ns of R.order) if (ns.visTarget > 0) r = Math.max(r, center.distanceTo(ns.p) + ns.r);
  return Math.max(6, r);
}

function fitDistance(radius) {
  const vf = (FOV * Math.PI) / 180;
  const aspect = R.w > 0 && R.h > 0 ? R.w / R.h : 1.6;
  const hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
  const f = Math.min(vf, hf);
  return (radius * 1.12) / Math.sin(f / 2);
}

function fitOverview(instant) {
  if (!R) return;
  const c = new THREE.Vector3();
  // 兜底半径：图谱未加载完（或只剩一两个节点）时也框住整个银河盘，否则相机贴脸、其余星球出画。
  const r = Math.max(visibleBounds(c), ANCHOR_R + 3);
  const dist = fitDistance(r);
  const dir = new THREE.Vector3(0, 0.42, 1);
  if (instant) {
    R.controls.target.copy(c);
    R.camera.position.copy(c).addScaledVector(dir.normalize(), dist);
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
// 13. 任务规划卫星
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
  const th = THEMES[R.theme] || THEMES.dark;
  const group = new THREE.Group();
  const self = R.selfId && R.nodes.get(R.selfId);
  group.position.set(0, (self ? self.r : 0.6) + 1.6, 0);
  group.rotation.x = 0.28;
  R.world.add(group);
  const radius = clamp(2.6 + ordered.length * 0.18, 2.8, 4.6);
  const sats = new Map();
  // 轨道圈
  const orbitPts = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    orbitPts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const orbit = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(orbitPts),
    new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: th.orbit, depthWrite: false })
  );
  group.add(orbit);
  ordered.forEach((it, i) => {
    const a = -Math.PI / 2 + (i / ordered.length) * Math.PI * 2;
    const mat = new THREE.MeshStandardMaterial({ roughness: th.rough, metalness: 0.15, transparent: true, envMapIntensity: th.env });
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
  // 依赖弧线
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
      new THREE.LineBasicMaterial({ color: th.arc, transparent: true, opacity: th.arcOp, depthWrite: false })
    );
    group.add(arcs);
  }
  R.plan = { group, sats, orbit, arcs, t: 0, fade: 1, fading: false };
}

function setSatStatus(sat, status) {
  const st = PLAN_COLOR[status] ? status : "pending";
  if (sat.status === st) return;
  const prev = sat.status;
  sat.status = st;
  const c = R.col.setHex(PLAN_COLOR[st]);
  sat.mat.color.copy(c);
  sat.mat.emissive.copy(c);
  sat.emissBase = st === "pending" ? 0.15 : 0.7;
  sat.mat.emissiveIntensity = sat.emissBase * (THEMES[R.theme] || THEMES.dark).emiss;
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
    sat.halo.material.opacity = Math.min(1, hb * k * R.haloBoost);
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
// 14. 导出 API
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
  const r = role === "parent" ? "parent" : "child";
  if (cfg.role === r && R && R.themeRole === r) return;
  cfg.role = r;
  if (R && R.ready) {
    R.themeRole = r;
    applyTheme();
    applyVisibility();
  }
});

export const setTimeline = safe(function setTimeline(dateStr) {
  cfg.timeline = normalizeTimeline(dateStr) ? str(dateStr) : null;
  if (R && R.ready) applyVisibility();
});

export const setFilter = safe(function setFilter(f) {
  const o = f && typeof f === "object" ? f : {};
  const domain = DOMAINS[o.domain] ? o.domain : "";
  const status = STATUS_NAME[o.status] ? o.status : "";
  cfg.filter = { domain, status };
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
    // 还原旧容器的 position 改动
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
    observe(el); // 重新挂 ResizeObserver / IntersectionObserver
  }
  R.w = -1; // 强制重算尺寸
  measure();
  updateRunning();
  fitOverview(mode !== "graph");
  return true;
});

export const setNodeClickHandler = safe(function setNodeClickHandler(cb) {
  cfg.onClick = typeof cb === "function" ? cb : null;
});

export const highlightRecall = safe(function highlightRecall(payload) {
  if (!R || !R.ready || !payload) return;
  const until = nowMs() + RECALL_MS;
  const hit = new Set();
  for (const x of Array.isArray(payload.nodes) ? payload.nodes : []) {
    let ns = R.nodes.get(idOf(x));
    if (!ns && x && x.label) ns = R.order.find((o) => o.data.label === x.label);
    if (ns && !ns.dying) { ns.pulseUntil = until; hit.add(ns.id); }
  }
  for (const e of Array.isArray(payload.edges) ? payload.edges : []) {
    if (!e) continue;
    const s = idOf(e.source), t = idOf(e.target);
    const k = s < t ? s + "\u0001" + t : t + "\u0001" + s;
    const ed = R.edgeList.find((x) => x.k === k);
    if (ed) {
      ed.hlUntil = until;
      ed.a.pulseUntil = Math.max(ed.a.pulseUntil, until);
      ed.b.pulseUntil = Math.max(ed.b.pulseUntil, until);
    }
  }
  if (!R.running) renderFrame(0);
});

export const spawnMemory = safe(function spawnMemory(payload) {
  if (!payload) return;
  const addN = Array.isArray(payload.added_nodes) ? payload.added_nodes : [];
  const addE = Array.isArray(payload.added_edges) ? payload.added_edges : [];
  const upd = Array.isArray(payload.updated) ? payload.updated : [];
  // 合并进当前数据（不改调用方对象）
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
    addBurst(ns.p, domainOf(ns.data.domain).hex, ns.r * 2.2);
  }
  for (const n of upd) {
    const ns = R.nodes.get(idOf(n));
    if (ns) ns.pulseUntil = tms + RECALL_MS * 0.7;
  }
  for (const e of addE) {
    if (!e) continue;
    const s = idOf(e.source), t = idOf(e.target);
    const k = s < t ? s + "\u0001" + t : t + "\u0001" + s;
    const ed = R.edgeList.find((x) => x.k === k);
    if (ed) ed.hlUntil = tms + RECALL_MS;
  }
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
  flyTo(ns.p, clamp(5 + ns.r * 6, 6, 12));
});

export const focusDomain = safe(function focusDomain(domain) {
  if (!R || !R.ready) return;
  R.focusId = null;
  if (!DOMAINS[domain]) { fitOverview(false); return; }
  const c = new THREE.Vector3();
  let n = 0;
  for (const ns of R.order) if (ns.visTarget > 0 && ns.data.domain === domain) { c.add(ns.p); n++; }
  if (!n) anchorOf(domain, c);
  else c.multiplyScalar(1 / n);
  let r = 3;
  for (const ns of R.order) if (ns.visTarget > 0 && ns.data.domain === domain) r = Math.max(r, c.distanceTo(ns.p) + ns.r);
  // 从外侧看向簇：方向 = 中心 → 簇
  const dir = new THREE.Vector3(c.x, 0, c.z);
  if (dir.lengthSq() < 0.01) dir.set(0, 0, 1);
  dir.normalize();
  dir.y = 0.45;
  flyTo(c, Math.max(9, fitDistance(r) * 0.95), dir);
});

export const setPandaMood = safe(function setPandaMood(mood) {
  const m = ["idle", "thinking", "working", "happy", "worried", "speaking"].includes(mood) ? mood : "idle";
  cfg.mood = m;
  if (R && R.panda) R.panda.mod.setPandaMood(R.panda.group, m);
});

export const resize = safe(function resize() {
  if (!R) return;
  R.w = -1; // 强制重算
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
  const disposeTree = (root) => root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        if (m.map && m.map !== S.tex.glow && m.map !== S.tex.ring && m.map !== S.tex.priv) m.map.dispose();
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
  // 行星贴图由缓存共享，统一释放
  for (const t of _planetTexCache.values()) t.dispose();
  _planetTexCache.clear();
  for (const t of Object.values(S.tex)) t.dispose();
  for (const t of Object.values(S.bgTex)) t.dispose();
  try { S.renderer.dispose(); S.renderer.forceContextLoss(); } catch (_) {}
  if (S.root.parentNode) S.root.parentNode.removeChild(S.root);
  if (S.restorePos !== null) S.container.style.position = S.restorePos;
  if (S.hiddenCanvas) S.hiddenCanvas.style.display = S.hiddenCanvas.dataset.s3dPrevDisplay || "";
  R = null;
});

// 预分配的簇统计缓冲（避免每帧分配）：build 末尾调用一次
function ensureScratch() {
  if (!R.clusterSums) {
    R.clusterSums = DOMAIN_KEYS.map(() => new THREE.Vector3());
    R.clusterCounts = new Array(DOMAIN_KEYS.length).fill(0);
    R.labelCand = [];
    R.labelRects = [];
    R.labelProbe = {};
    R.frameN = 0;
  }
}
