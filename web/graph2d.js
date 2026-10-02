// web/graph2d.js —— 2D SVG 全景知识图谱（高质感无重叠重构版）
// 零依赖：纯 DOM + 内联 SVG，原生自适应，支持深浅双主题无缝切换。

// 五领域柔和高级配色（德智体美劳）
const DOMAIN_COLOR = {
  ethics: "#fb7185",    // 德：赤诚蜜桃红
  intellect: "#38bdf8", // 智：清亮晴空蓝
  health: "#34d399",    // 体：生机竹叶绿
  aesthetics: "#c084fc",// 美：梦幻鸢尾紫
  labor: "#fbbf24",     // 劳：勤勉暖麦金
};
const DOMAIN_LABEL = { ethics: "德", intellect: "智", health: "体", aesthetics: "美", labor: "劳" };
const DOMAIN_SUB = { ethics: "品德修养", intellect: "学业认知", health: "身心健康", aesthetics: "艺术审美", labor: "生活劳动" };
const DOMAIN_ORDER = ["ethics", "intellect", "health", "aesthetics", "labor"];

const NS = "http://www.w3.org/2000/svg";

/** 把 #rrggbb 调亮/调暗；f>0 变亮，f<0 变暗。 */
function shade(hex, f) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = f >= 0 ? v + (255 - v) * f : v * (1 + f);
    return Math.max(0, Math.min(255, Math.round(x)));
  });
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

function daysAgo(dateStr) {
  if (!dateStr) return 999;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return 999;
  return Math.max(0, (Date.now() - t) / 86400000);
}

/** 智能多行标签排版，防止出现单调的截断 ... */
function renderMultiLineLabel(g, text, r, color, light) {
  const s = String(text == null ? "" : text).trim();
  const label = document.createElementNS(NS, "text");
  label.setAttribute("x", "0");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "g2d-node-label");
  label.setAttribute("fill", color);
  label.setAttribute("font-size", "11.5");
  label.setAttribute("font-weight", "600");
  label.style.letterSpacing = "0.02em";
  label.style.paintOrder = "stroke fill";
  label.style.stroke = light ? "rgba(255,255,255,0.92)" : "rgba(10,18,15,0.92)";
  label.style.strokeWidth = "3px";
  label.style.strokeLinejoin = "round";

  if (s.length <= 5) {
    label.setAttribute("y", String(r + 14));
    label.textContent = s;
  } else {
    const line1 = s.slice(0, 5);
    const line2 = s.length > 10 ? s.slice(5, 9) + "…" : s.slice(5);
    label.setAttribute("y", String(r + 13));
    const t1 = document.createElementNS(NS, "tspan");
    t1.setAttribute("x", "0");
    t1.setAttribute("dy", "0");
    t1.textContent = line1;
    const t2 = document.createElementNS(NS, "tspan");
    t2.setAttribute("x", "0");
    t2.setAttribute("dy", "12");
    t2.textContent = line2;
    label.appendChild(t1);
    label.appendChild(t2);
  }
  g.appendChild(label);
}

/**
 * 用 SVG 渲染知识图谱。
 * @param {HTMLElement} containerEl 容器
 * @param {object} graph 契约结构：{nodes:[...], edges:[...]}
 * @param {object} opts  { onNodeClick, onNodeHover, timeline, role, highlight }
 */
export function renderFallback(containerEl, graph, opts = {}) {
  if (!containerEl) throw new Error("renderFallback: 缺少容器元素");
  const nodes0 = (graph && graph.nodes) || [];
  const edges0 = (graph && graph.edges) || [];
  const role = opts.role || "child";
  const timeline = opts.timeline || null;

  // 家长视角：private 节点整体不渲染
  const nodes = role === "parent" ? nodes0.filter((n) => !n.private) : nodes0.slice();
  const ids = new Set(nodes.map((n) => n.id));
  let edges = edges0.filter((e) => ids.has(e.source) && ids.has(e.target));

  // 深浅色主题自适应
  const light = typeof document !== "undefined" && !!document.body && document.body.dataset.theme !== "dark";
  const C = {
    bgGlow: light
      ? [[0, "rgba(56,189,248,.12)"], [0.55, "rgba(52,211,153,.10)"], [1, "rgba(240,253,244,0)"]]
      : [[0, "rgba(52,211,153,.15)"], [0.55, "rgba(30,58,47,.45)"], [1, "rgba(11,19,17,0)"]],
    edge: light ? "rgba(71,85,105,.24)" : "rgba(148,163,184,.26)",
    hot: light ? "#d97706" : "#fbbf24",
    ringDone: light ? "#d97706" : "#f59e0b",
    dropFill: light ? "rgba(148,163,184,.25)" : "rgba(100,116,139,.35)",
    dropStroke: light ? "rgba(100,116,139,.45)" : "rgba(148,163,184,.45)",
    priv: light ? "#9333ea" : "#c084fc",
    label: light ? "#0f172a" : "#f8fafc",
    labelDropped: light ? "rgba(100,116,139,.65)" : "rgba(148,163,184,.65)",
  };

  // 时间轴筛选
  if (timeline) {
    const until = Date.parse(timeline);
    if (!Number.isNaN(until)) {
      const ok = new Set(nodes.filter((n) => !n.first_seen || Date.parse(n.first_seen) <= until).map((n) => n.id));
      edges = edges.filter((e) => ok.has(e.source) && ok.has(e.target));
    }
  }
  const visible = new Set([...edges.flatMap((e) => [e.source, e.target]), ...nodes.map((n) => n.id)]);

  const W = Math.max(340, containerEl.clientWidth || 640);
  const H = Math.max(300, containerEl.clientHeight || 480);
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.max(105, Math.min(W, H) / 2 - 45);

  // ---------- 布局：按领域分扇区，扩大排斥松弛 ----------
  const visibleNodes = nodes.filter((n) => visible.has(n.id));
  const buckets = new Map(DOMAIN_ORDER.map((d) => [d, []]));
  const others = [];
  visibleNodes.forEach((n) => {
    const b = buckets.get(n.domain);
    if (b) b.push(n);
    else others.push(n);
  });

  const pos = {};
  const pinned = [];
  DOMAIN_ORDER.forEach((dom, di) => {
    const list = buckets.get(dom) || [];
    if (!list.length) return;
    const ang = (di / DOMAIN_ORDER.length) * Math.PI * 2 - Math.PI / 2;
    const dx = cx + Math.cos(ang) * R * 0.68;
    const dy = cy + Math.sin(ang) * R * 0.68;
    pinned.push({ x: dx, y: dy, dom });

    list.sort((a, b) => (b.weight || 1) - (a.weight || 1));
    const inner = Math.min(list.length, 6);
    list.forEach((n, i) => {
      const rr = i === 0 ? 0 : 28 + (i % inner) * 18 + Math.min(1, n.weight || 1) * 3;
      const aa = (i / Math.max(1, inner)) * Math.PI * 2 * 1.2 + di * 0.7;
      pos[n.id] = { x: dx + Math.cos(aa) * rr, y: dy + Math.sin(aa) * rr };
    });
  });

  others.forEach((n, i) => {
    const aa = (i / Math.max(1, others.length)) * Math.PI * 2;
    pos[n.id] = { x: cx + Math.cos(aa) * R * 0.95, y: cy + Math.sin(aa) * R * 0.95 };
  });

  // 增大排斥半径（从 46 升级至 68），增加迭代次数，保证球体与文字绝不重叠
  const ids2 = Object.keys(pos);
  const MIN_DIST = 68;
  for (let it = 0; it < 80; it++) {
    for (let i = 0; i < ids2.length; i++) {
      const a = pos[ids2[i]];
      for (let j = i + 1; j < ids2.length; j++) {
        const b = pos[ids2[j]];
        let vx = b.x - a.x;
        let vy = b.y - a.y;
        let d2 = vx * vx + vy * vy;
        if (d2 < 1e-4) { vx = (Math.random() - 0.5) * 0.8; vy = (Math.random() - 0.5) * 0.8; d2 = 1; }
        const d = Math.sqrt(d2);
        if (d < MIN_DIST) {
          const push = ((MIN_DIST - d) / d) * 0.28;
          a.x -= vx * push; a.y -= vy * push;
          b.x += vx * push; b.y += vy * push;
        }
      }
    }
    pinned.forEach((p) => {
      (buckets.get(p.dom) || []).forEach((n) => {
        const q = pos[n.id];
        if (!q) return;
        q.x += (p.x - q.x) * 0.035;
        q.y += (p.y - q.y) * 0.035;
      });
    });
    ids2.forEach((id) => {
      const q = pos[id];
      const d = Math.hypot(q.x - cx, q.y - cy);
      if (d > R) {
        q.x = cx + ((q.x - cx) / d) * R;
        q.y = cy + ((q.y - cy) / d) * R;
      }
    });
  }

  // ---------- 构建 SVG ----------
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("class", "graph2d-svg");
  svg.style.display = "block";
  svg.style.touchAction = "none";

  // 背景微光与光环
  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "radialGradient");
  grad.setAttribute("id", "g2d-bg");
  grad.setAttribute("cx", "50%");
  grad.setAttribute("cy", "50%");
  grad.setAttribute("r", "50%");
  C.bgGlow.forEach(([o, c]) => {
    const st = document.createElementNS(NS, "stop");
    st.setAttribute("offset", String(o));
    st.setAttribute("stop-color", c);
    grad.appendChild(st);
  });
  defs.appendChild(grad);
  svg.appendChild(defs);

  const halo = document.createElementNS(NS, "circle");
  halo.setAttribute("cx", String(cx));
  halo.setAttribute("cy", String(cy));
  halo.setAttribute("r", String(R + 36));
  halo.setAttribute("fill", "url(#g2d-bg)");
  svg.appendChild(halo);

  const gEdges = document.createElementNS(NS, "g");
  gEdges.setAttribute("class", "g2d-edges");
  const gDomain = document.createElementNS(NS, "g");
  gDomain.setAttribute("class", "g2d-domains");
  const gNodes = document.createElementNS(NS, "g");
  gNodes.setAttribute("class", "g2d-nodes");
  svg.appendChild(gEdges);
  svg.appendChild(gDomain);
  svg.appendChild(gNodes);

  const highlight = opts.highlight || {};
  const hlNodes = new Set((highlight.nodes || []).map((n) => n.id || n));
  const hlEdgeKey = new Set((highlight.edges || []).map((e) => `${e.source}>${e.target}`));

  // 领域背景光斑与优雅标签
  pinned.forEach((p) => {
    const dom = document.createElementNS(NS, "circle");
    dom.setAttribute("cx", String(p.x));
    dom.setAttribute("cy", String(p.y));
    dom.setAttribute("r", "64");
    dom.setAttribute("fill", DOMAIN_COLOR[p.dom] || "#8fa3a0");
    dom.setAttribute("opacity", light ? "0.12" : "0.09");
    gDomain.appendChild(dom);

    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", String(p.x));
    txt.setAttribute("y", String(p.y - 80));
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("class", "g2d-domain-label");
    txt.setAttribute("fill", DOMAIN_COLOR[p.dom] || "#8fa3a0");
    txt.setAttribute("font-size", "16");
    txt.setAttribute("font-weight", "700");
    txt.setAttribute("letter-spacing", "0.08em");
    txt.textContent = `${DOMAIN_LABEL[p.dom]} · ${DOMAIN_SUB[p.dom] || ""}`;
    gDomain.appendChild(txt);
  });

  // 边线绘制
  const edgeEls = [];
  edges.forEach((e) => {
    const a = pos[e.source];
    const b = pos[e.target];
    if (!a || !b) return;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", a.x.toFixed(1));
    line.setAttribute("y1", a.y.toFixed(1));
    line.setAttribute("x2", b.x.toFixed(1));
    line.setAttribute("y2", b.y.toFixed(1));
    const hot = hlEdgeKey.has(`${e.source}>${e.target}`) || hlEdgeKey.has(`${e.target}>${e.source}`);
    line.setAttribute("stroke", hot ? C.hot : C.edge);
    line.setAttribute("stroke-width", hot ? "2.4" : "1.3");
    if (e.rel) line.setAttribute("stroke-dasharray", hot ? "none" : "3 4");
    gEdges.appendChild(line);
    edgeEls.push({ el: line, e, hot });

    if (hot && e.rel) {
      const tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", String((a.x + b.x) / 2));
      tx.setAttribute("y", String((a.y + b.y) / 2 - 4));
      tx.setAttribute("text-anchor", "middle");
      tx.setAttribute("font-size", "11");
      tx.setAttribute("font-weight", "600");
      tx.setAttribute("fill", C.hot);
      tx.textContent = e.rel;
      gEdges.appendChild(tx);
    }
  });

  // 节点绘制
  const nodeById = {};
  const nodeEls = [];
  const neighbours = new Map();
  edges.forEach((e) => {
    if (!neighbours.has(e.source)) neighbours.set(e.source, new Set());
    if (!neighbours.has(e.target)) neighbours.set(e.target, new Set());
    neighbours.get(e.source).add(e.target);
    neighbours.get(e.target).add(e.source);
  });

  visibleNodes.forEach((n) => {
    if (!pos[n.id]) return;
    nodeById[n.id] = n;
    const p = pos[n.id];
    const base = DOMAIN_COLOR[n.domain] || "#94a3b8";
    const age = daysAgo(n.last_seen);
    const recency = Math.max(0.4, Math.min(1, 1 - age / 540));
    const dropped = n.status === "dropped";
    const r = 7 + Math.min(15, Math.sqrt(Math.max(1, n.weight || 1)) * 4.8) * (dropped ? 0.84 : 1);

    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "g2d-node");
    g.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
    g.style.cursor = "pointer";

    if (n.status === "done") {
      const ring = document.createElementNS(NS, "circle");
      ring.setAttribute("r", String(r + 5.5));
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", C.ringDone);
      ring.setAttribute("stroke-width", "2.2");
      g.appendChild(ring);
    }
    const haloEl = document.createElementNS(NS, "circle");
    haloEl.setAttribute("r", String(r + 8));
    haloEl.setAttribute("fill", base);
    haloEl.setAttribute("opacity", light ? "0.22" : "0.16");
    g.appendChild(haloEl);

    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("r", String(r.toFixed(1)));
    if (dropped) {
      circle.setAttribute("fill", C.dropFill);
      circle.setAttribute("stroke", C.dropStroke);
      circle.setAttribute("stroke-dasharray", "3 3");
    } else {
      circle.setAttribute("fill", shade(base, light ? 0.15 : -0.35 * (1 - recency)));
      circle.setAttribute("stroke", shade(base, light ? -0.2 : 0.4 * recency));
    }
    circle.setAttribute("stroke-width", "1.8");
    circle.setAttribute("opacity", dropped ? "0.6" : String(recency.toFixed(2)));
    g.appendChild(circle);

    if (n.private) {
      const lock = document.createElementNS(NS, "circle");
      lock.setAttribute("r", String(r + 3.8));
      lock.setAttribute("fill", "none");
      lock.setAttribute("stroke", C.priv);
      lock.setAttribute("stroke-width", "1.5");
      lock.setAttribute("stroke-dasharray", "2.5 2.5");
      g.appendChild(lock);

      const lx = r + 1, ly = -r - 4;
      const body = document.createElementNS(NS, "rect");
      body.setAttribute("x", String(lx));
      body.setAttribute("y", String(ly));
      body.setAttribute("width", "7.5");
      body.setAttribute("height", "5.6");
      body.setAttribute("rx", "1.4");
      body.setAttribute("fill", C.priv);
      const shackle = document.createElementNS(NS, "path");
      shackle.setAttribute("d", `M ${lx + 1.8} ${ly} v-1.8 a2 2 0 0 1 4 0 v1.8`);
      shackle.setAttribute("fill", "none");
      shackle.setAttribute("stroke", C.priv);
      shackle.setAttribute("stroke-width", "1.4");
      g.appendChild(shackle);
      g.appendChild(body);
    }

    // 智能多行高清晰标签
    const labelColor = dropped ? C.labelDropped : C.label;
    renderMultiLineLabel(g, n.label, r, labelColor, light);

    // 悬浮与点击交互
    const onEnter = () => {
      const nb = neighbours.get(n.id) || new Set();
      nodeEls.forEach((rec) => {
        const on = rec.n.id === n.id || nb.has(rec.n.id);
        rec.g.setAttribute("opacity", on ? "1" : "0.22");
      });
      edgeEls.forEach((rec) => {
        const on = rec.e.source === n.id || rec.e.target === n.id;
        rec.el.setAttribute("opacity", on ? "1" : "0.1");
      });
      if (opts.onNodeHover) opts.onNodeHover(n);
    };
    const onLeave = () => {
      nodeEls.forEach((rec) => rec.g.setAttribute("opacity", ""));
      edgeEls.forEach((rec) => rec.el.setAttribute("opacity", ""));
      if (opts.onNodeHover) opts.onNodeHover(null);
    };
    g.addEventListener("mouseenter", onEnter);
    g.addEventListener("mouseleave", onLeave);
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (opts.onNodeClick) opts.onNodeClick(n);
    });

    gNodes.appendChild(g);
    nodeEls.push({ g, n, hl: hlNodes.has(n.id) });
  });

  containerEl.innerHTML = "";
  containerEl.appendChild(svg);

  return {
    destroy() {
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    },
    nodeById,
    width: W,
    height: H,
  };
}
