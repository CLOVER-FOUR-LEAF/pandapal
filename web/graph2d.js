// web/graph2d.js —— 2D SVG 降级图谱
// 什么时候用：WebGL 不可用、three.js 加载失败、或 3D 帧率低于 25 时，
// app.js 的 window.__pandaFallback2D() 会切到 #scene-fallback，用这个模块渲染。
// 零依赖：纯 DOM + 内联 SVG，不需要任何外部库。

// 五领域配色（契约 §2.4：德智体美劳）
const DOMAIN_COLOR = {
  ethics: "#ff8a80",
  intellect: "#64b5f6",
  health: "#81c784",
  aesthetics: "#ce93d8",
  labor: "#ffd54f",
};
const DOMAIN_LABEL = { ethics: "德", intellect: "智", health: "体", aesthetics: "美", labor: "劳" };
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

/** 标签太长会撑爆布局，按字符数硬截断（中文按 1 个字算）。 */
function clip(text, max) {
  const s = String(text == null ? "" : text);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * 用 SVG 渲染知识图谱。
 * @param {HTMLElement} containerEl 容器（宽高自适应，读 clientWidth/clientHeight）
 * @param {object} graph 契约 §3.2 export() 的结构：{nodes:[{id,label,domain,status,weight,first_seen,last_seen,private}], edges:[{source,target,rel}]}
 * @param {object} opts  { onNodeClick?(node), onNodeHover?(node), timeline?(string|null), role?:"child"|"parent", highlight?:{nodes,edges} }
 * @returns {{destroy:()=>void, nodeById:Object, width:number, height:number}}
 */
export function renderFallback(containerEl, graph, opts = {}) {
  if (!containerEl) throw new Error("renderFallback: 缺少容器元素");
  const nodes0 = (graph && graph.nodes) || [];
  const edges0 = (graph && graph.edges) || [];
  const role = opts.role || "child";
  const timeline = opts.timeline || null;

  // 家长视角：private 节点整体不渲染（连边一起丢掉）
  const nodes = role === "parent" ? nodes0.filter((n) => !n.private) : nodes0.slice();
  const ids = new Set(nodes.map((n) => n.id));
  let edges = edges0.filter((e) => ids.has(e.source) && ids.has(e.target));
  // 时间轴：first_seen <= 该日期的才画
  if (timeline) {
    const until = Date.parse(timeline);
    if (!Number.isNaN(until)) {
      const ok = new Set(nodes.filter((n) => !n.first_seen || Date.parse(n.first_seen) <= until).map((n) => n.id));
      edges = edges.filter((e) => ok.has(e.source) && ok.has(e.target));
    }
  }
  const visible = new Set([...edges.flatMap((e) => [e.source, e.target]), ...nodes.map((n) => n.id)]);

  const W = Math.max(320, containerEl.clientWidth || 640);
  const H = Math.max(280, containerEl.clientHeight || 480);
  const cx = W / 2;
  const cy = H / 2;
  // 星星球半径：留出标签空间
  const R = Math.max(80, Math.min(W, H) / 2 - 54);

  // ---------- 布局：按领域分扇区，扇区内做少量斥力松弛 ----------
  // （3D 那边是手写力导向；这里为了确定性用解析式极坐标分布，快且稳）
  const visibleNodes = nodes.filter((n) => visible.has(n.id));
  const buckets = new Map(DOMAIN_ORDER.map((d) => [d, []]));
  const others = [];
  visibleNodes.forEach((n) => {
    const b = buckets.get(n.domain);
    if (b) b.push(n);
    else others.push(n);
  });

  const pos = {};
  const pinned = []; // 领域中心，参与斥力但不动
  DOMAIN_ORDER.forEach((dom, di) => {
    const list = buckets.get(dom) || [];
    if (!list.length) return;
    const ang = (di / DOMAIN_ORDER.length) * Math.PI * 2 - Math.PI / 2;
    const dx = cx + Math.cos(ang) * R * 0.62;
    const dy = cy + Math.sin(ang) * R * 0.62;
    pinned.push({ x: dx, y: dy, dom });
    // 领域内：weight 大的靠中心，其余绕成小环
    list.sort((a, b) => (b.weight || 1) - (a.weight || 1));
    const inner = Math.min(list.length, 9);
    list.forEach((n, i) => {
      const rr = i === 0 ? 0 : 20 + (i % inner) * 8 + Math.min(1, n.weight || 1) * 0;
      const aa = (i / Math.max(1, inner)) * Math.PI * 2 * (list.length > inner ? 1.8 : 1) + di * 0.7;
      pos[n.id] = { x: dx + Math.cos(aa) * rr, y: dy + Math.sin(aa) * rr };
    });
  });
  // 未知领域的节点：撒在外圈
  others.forEach((n, i) => {
    const aa = (i / Math.max(1, others.length)) * Math.PI * 2;
    pos[n.id] = { x: cx + Math.cos(aa) * R * 0.95, y: cy + Math.sin(aa) * R * 0.95 };
  });

  // 松弛：节点互相推开 + 领域中心回拉，避免标签重叠
  const ids2 = Object.keys(pos);
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < ids2.length; i++) {
      const a = pos[ids2[i]];
      for (let j = i + 1; j < ids2.length; j++) {
        const b = pos[ids2[j]];
        let vx = b.x - a.x;
        let vy = b.y - a.y;
        let d2 = vx * vx + vy * vy;
        if (d2 < 1e-4) { vx = (Math.random() - 0.5) * 0.6; vy = (Math.random() - 0.5) * 0.6; d2 = 1; }
        const d = Math.sqrt(d2);
        const MIN = 46;
        if (d < MIN) {
          const push = (MIN - d) / d * 0.24;
          a.x -= vx * push; a.y -= vy * push;
          b.x += vx * push; b.y += vy * push;
        }
      }
    }
    // 向领域中心回拉 + 兜住圆内
    pinned.forEach((p) => {
      (buckets.get(p.dom) || []).forEach((n) => {
        const q = pos[n.id];
        if (!q) return;
        q.x += (p.x - q.x) * 0.03;
        q.y += (p.y - q.y) * 0.03;
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

  // ---------- 建 SVG ----------
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("class", "graph2d-svg");
  svg.style.display = "block";
  svg.style.touchAction = "none";

  // 星星球底光
  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "radialGradient");
  grad.setAttribute("id", "g2d-bg");
  grad.setAttribute("cx", "50%");
  grad.setAttribute("cy", "50%");
  grad.setAttribute("r", "50%");
  [[0, "rgba(79,191,127,.10)"], [0.6, "rgba(28,43,42,.35)"], [1, "rgba(15,26,31,0)"]].forEach(([o, c]) => {
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
  halo.setAttribute("r", String(R + 30));
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

  // 领域名 + 星区光斑
  pinned.forEach((p) => {
    const dom = document.createElementNS(NS, "circle");
    dom.setAttribute("cx", String(p.x));
    dom.setAttribute("cy", String(p.y));
    dom.setAttribute("r", "58");
    dom.setAttribute("fill", DOMAIN_COLOR[p.dom] || "#8fa3a0");
    dom.setAttribute("opacity", "0.07");
    gDomain.appendChild(dom);
    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", String(p.x));
    txt.setAttribute("y", String(p.y - 74));
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("class", "g2d-domain-label");
    txt.setAttribute("fill", DOMAIN_COLOR[p.dom] || "#8fa3a0");
    txt.setAttribute("font-size", "17");
    txt.setAttribute("font-weight", "600");
    txt.setAttribute("opacity", "0.75");
    txt.textContent = DOMAIN_LABEL[p.dom] || "";
    gDomain.appendChild(txt);
  });

  // 边
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
    line.setAttribute("stroke", hot ? "#ffb347" : "rgba(160,200,185,.28)");
    line.setAttribute("stroke-width", hot ? "2" : "1.2");
    if (e.rel) line.setAttribute("stroke-dasharray", hot ? "none" : "4 5");
    gEdges.appendChild(line);
    edgeEls.push({ el: line, e, hot });
    // 关系文字放在中点，只给高亮的边画（避免糊成一片）
    if (hot && e.rel) {
      const tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", String((a.x + b.x) / 2));
      tx.setAttribute("y", String((a.y + b.y) / 2 - 4));
      tx.setAttribute("text-anchor", "middle");
      tx.setAttribute("font-size", "11");
      tx.setAttribute("fill", "#ffb347");
      tx.textContent = e.rel;
      gEdges.appendChild(tx);
    }
  });

  // 节点
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
    const base = DOMAIN_COLOR[n.domain] || "#9fb3ae";
    const age = daysAgo(n.last_seen);
    // 亮度按 last_seen 衰减：新记忆亮，旧记忆暗（最低 0.34）
    const recency = Math.max(0.34, Math.min(1, 1 - age / 540));
    const dropped = n.status === "dropped";
    const r = 6 + Math.min(14, Math.sqrt(Math.max(1, n.weight || 1)) * 4.6) * (dropped ? 0.82 : 1);

    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "g2d-node");
    g.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
    g.style.cursor = "pointer";

    if (n.status === "done") {
      const ring = document.createElementNS(NS, "circle");
      ring.setAttribute("r", String(r + 5));
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", "#ffd166");
      ring.setAttribute("stroke-width", "2");
      g.appendChild(ring);
    }
    const haloEl = document.createElementNS(NS, "circle");
    haloEl.setAttribute("r", String(r + 7));
    haloEl.setAttribute("fill", base);
    haloEl.setAttribute("opacity", "0.13");
    g.appendChild(haloEl);

    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("r", String(r.toFixed(1)));
    if (dropped) {
      circle.setAttribute("fill", "rgba(150,160,158,.35)");
      circle.setAttribute("stroke", "rgba(190,200,198,.5)");
      circle.setAttribute("stroke-dasharray", "3 3");
    } else {
      circle.setAttribute("fill", shade(base, -0.42 * (1 - recency)));
      circle.setAttribute("stroke", shade(base, 0.35 * recency));
    }
    circle.setAttribute("stroke-width", "1.6");
    circle.setAttribute("opacity", dropped ? "0.55" : String(recency.toFixed(2)));
    g.appendChild(circle);

    if (n.private) {
      // 悄悄话：紫色虚线圈 + 纯绘制小锁（家长视角已在过滤阶段整体剔除）
      const lock = document.createElementNS(NS, "circle");
      lock.setAttribute("r", String(r + 3.5));
      lock.setAttribute("fill", "none");
      lock.setAttribute("stroke", "#ce93d8");
      lock.setAttribute("stroke-width", "1.4");
      lock.setAttribute("stroke-dasharray", "2.5 2.5");
      g.appendChild(lock);
      const lx = r + 1, ly = -r - 4;
      const body = document.createElementNS(NS, "rect");
      body.setAttribute("x", String(lx));
      body.setAttribute("y", String(ly));
      body.setAttribute("width", "7");
      body.setAttribute("height", "5.2");
      body.setAttribute("rx", "1.2");
      body.setAttribute("fill", "#ce93d8");
      const shackle = document.createElementNS(NS, "path");
      shackle.setAttribute("d", `M ${lx + 1.6} ${ly} v-1.6 a1.9 1.9 0 0 1 3.8 0 v1.6`);
      shackle.setAttribute("fill", "none");
      shackle.setAttribute("stroke", "#ce93d8");
      shackle.setAttribute("stroke-width", "1.3");
      g.appendChild(shackle);
      g.appendChild(body);
    }

    const label = document.createElementNS(NS, "text");
    label.setAttribute("y", String(r + 13));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "g2d-node-label");
    label.setAttribute("font-size", "12.5");
    label.setAttribute("fill", dropped ? "rgba(210,220,218,.55)" : "#e6efeb");
    label.textContent = clip(n.label, 6);
    g.appendChild(label);

    // 交互
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
