// 熊猫形象：SVG + CSS 动画
// mood: normal | thinking | speaking | happy | sleepy | sad | worried | shy | oops
// 交互：眨眼 / 浮动 / 点击弹跳 / 眼神跟随（lookAt）/ 输密码时捂眼（shy）

let uid = 0;

function svgMarkup(id) {
  const g = (n) => `${n}-${id}`;
  return `
<svg viewBox="0 0 240 240" class="panda-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="熊猫管家">
  <defs>
    <radialGradient id="${g("fur")}" cx="42%" cy="34%" r="72%">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset=".72" stop-color="#f4f1ea"/>
      <stop offset="1" stop-color="#ddd6ca"/>
    </radialGradient>
    <radialGradient id="${g("belly")}" cx="50%" cy="30%" r="75%">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e6e0d5"/>
    </radialGradient>
    <linearGradient id="${g("ink")}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3632"/>
      <stop offset="1" stop-color="#1c1a18"/>
    </linearGradient>
    <linearGradient id="${g("bam")}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#3f9f68"/>
      <stop offset=".5" stop-color="#7fdca4"/>
      <stop offset="1" stop-color="#3a9461"/>
    </linearGradient>
  </defs>

  <!-- 背后的竹子 -->
  <g class="p-bamboo">
    <rect x="186" y="40" width="11" height="186" rx="5.5" fill="url(#${g("bam")})"/>
    <rect x="185" y="88" width="13" height="4" rx="2" fill="#2f7d52"/>
    <rect x="185" y="146" width="13" height="4" rx="2" fill="#2f7d52"/>
    <path d="M196 90c14-10 28-10 36-4-12 6-24 8-36 4z" fill="#5fd39b"/>
    <path d="M187 148c-12-12-26-14-34-9 10 8 22 11 34 9z" fill="#4cc18a"/>
    <path d="M196 60c10-14 22-18 32-16-8 10-20 16-32 16z" fill="#7fdca4"/>
  </g>

  <!-- 地面阴影 -->
  <ellipse cx="118" cy="228" rx="66" ry="8" fill="#000" opacity=".28"/>

  <g class="p-body">
    <!-- 后腿 -->
    <ellipse cx="78" cy="212" rx="26" ry="18" fill="url(#${g("ink")})"/>
    <ellipse cx="158" cy="212" rx="26" ry="18" fill="url(#${g("ink")})"/>
    <ellipse cx="74" cy="214" rx="9" ry="7" fill="#5a4d48"/>
    <ellipse cx="162" cy="214" rx="9" ry="7" fill="#5a4d48"/>
    <!-- 身体 -->
    <path d="M60 196c-6-44 18-74 58-74s64 30 58 74c-3 18-28 26-58 26s-55-8-58-26z" fill="url(#${g("belly")})"/>
    <!-- 肩带 -->
    <path d="M62 160c10-22 32-34 56-34s46 12 56 34c-14-8-34-12-56-12s-42 4-56 12z" fill="url(#${g("ink")})"/>
  </g>

  <g class="p-head">
    <!-- 耳朵 -->
    <g class="p-ear p-ear-l"><circle cx="66" cy="44" r="23" fill="url(#${g("ink")})"/><circle cx="68" cy="47" r="10" fill="#4b423d"/></g>
    <g class="p-ear p-ear-r"><circle cx="170" cy="44" r="23" fill="url(#${g("ink")})"/><circle cx="168" cy="47" r="10" fill="#4b423d"/></g>
    <!-- 头 -->
    <ellipse cx="118" cy="92" rx="72" ry="62" fill="url(#${g("fur")})"/>
    <!-- 黑眼圈（外下垂的泪滴形） -->
    <path d="M78 82c10-10 26-6 28 8 2 13-6 28-20 30-14 2-22-10-20-20 1-7 6-13 12-18z" fill="url(#${g("ink")})"/>
    <path d="M158 82c-10-10-26-6-28 8-2 13 6 28 20 30 14 2 22-10 20-20-1-7-6-13-12-18z" fill="url(#${g("ink")})"/>
    <!-- 眼睛：外层 .eye 负责眨眼，内层 .look 负责眼神跟随 -->
    <g class="eye"><g class="look">
      <circle cx="91" cy="96" r="8" fill="#fff"/>
      <circle cx="92" cy="97" r="5.2" fill="#14110f"/>
      <circle cx="94.4" cy="94.2" r="2" fill="#fff"/>
      <circle cx="90" cy="99.4" r=".9" fill="#fff" opacity=".8"/>
    </g></g>
    <g class="eye"><g class="look">
      <circle cx="145" cy="96" r="8" fill="#fff"/>
      <circle cx="146" cy="97" r="5.2" fill="#14110f"/>
      <circle cx="148.4" cy="94.2" r="2" fill="#fff"/>
      <circle cx="144" cy="99.4" r=".9" fill="#fff" opacity=".8"/>
    </g></g>
    <!-- 闭眼（sleepy / happy 时显示） -->
    <path class="eye-closed" d="M84 98q7 6 14 0" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <path class="eye-closed" d="M138 98q7 6 14 0" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <!-- 口鼻区 -->
    <ellipse cx="118" cy="124" rx="24" ry="17" fill="#fbf9f4"/>
    <!-- 腮红 -->
    <ellipse class="blush" cx="66" cy="120" rx="11" ry="7" fill="#ff9c8f" opacity=".42"/>
    <ellipse class="blush" cx="170" cy="120" rx="11" ry="7" fill="#ff9c8f" opacity=".42"/>
    <!-- 鼻子 -->
    <path d="M110 114.5c0-3 3.6-4.5 8-4.5s8 1.5 8 4.5c0 3.4-4.4 6.6-8 6.6s-8-3.2-8-6.6z" fill="#1c1a18"/>
    <ellipse cx="115.5" cy="113" rx="2.4" ry="1.2" fill="#fff" opacity=".45"/>
    <!-- 嘴：微笑 / 张嘴 / 担心 -->
    <path class="mouth-smile" d="M108 126q5 6 10 0q5 6 10 0" stroke="#1c1a18" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <g class="mouth-open">
      <path d="M109 126q9 2 18 0q-1 12-9 12t-9-12z" fill="#7a2f2a"/>
      <ellipse cx="118" cy="134" rx="5" ry="3" fill="#ff8b80"/>
    </g>
    <path class="mouth-sad" d="M109 133q9-7 18 0" stroke="#1c1a18" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  </g>

  <!-- 手臂：shy 时抬起来捂眼 -->
  <g class="p-arm p-arm-l">
    <ellipse cx="70" cy="178" rx="17" ry="25" transform="rotate(22 70 178)" fill="url(#${g("ink")})"/>
    <circle cx="64" cy="194" r="3" fill="#5a4d48"/><circle cx="72" cy="198" r="3" fill="#5a4d48"/>
  </g>
  <g class="p-arm p-arm-r">
    <ellipse cx="166" cy="178" rx="17" ry="25" transform="rotate(-22 166 178)" fill="url(#${g("ink")})"/>
    <circle cx="172" cy="194" r="3" fill="#5a4d48"/><circle cx="164" cy="198" r="3" fill="#5a4d48"/>
  </g>

  <!-- 思考时头顶的小点 -->
  <g class="p-think" fill="#5fd39b">
    <circle cx="196" cy="22" r="4"/><circle cx="210" cy="14" r="5"/><circle cx="226" cy="8" r="6"/>
  </g>
  <!-- 睡觉 Z -->
  <text class="p-zzz" x="190" y="34" fill="#a8e6c1" font-size="20" font-weight="700" font-family="system-ui">z</text>
</svg>`;
}

const MOODS = ["thinking", "speaking", "happy", "sleepy", "sad", "worried", "shy", "oops", "peek"];

export function mountPanda(holder) {
  holder.innerHTML = svgMarkup(++uid);
  const svg = holder.querySelector("svg");
  svg.addEventListener("click", () => {
    svg.classList.remove("bounce");
    void svg.getBoundingClientRect(); // 重启动画
    svg.classList.add("bounce");
  });
  svg.addEventListener("animationend", (e) => {
    if (e.animationName === "panda-bounce") svg.classList.remove("bounce");
    if (e.animationName === "panda-shake") svg.classList.remove("oops");
  });
  return svg;
}

export function setMood(svg, mood) {
  if (!svg) return;
  svg.classList.remove(...MOODS);
  if (mood && mood !== "normal") svg.classList.add(mood);
}

/** 眼神看向页面坐标 (x, y)；传 null 回正。 */
export function lookAt(svg, x, y) {
  if (!svg) return;
  let dx = 0, dy = 0;
  if (x != null) {
    const r = svg.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height * 0.4;
    const ang = Math.atan2(y - cy, x - cx);
    const dist = Math.min(1, Math.hypot(x - cx, y - cy) / 360);
    dx = Math.cos(ang) * 3.2 * dist;
    dy = Math.sin(ang) * 2.6 * dist;
  }
  svg.style.setProperty("--look-x", `${dx.toFixed(2)}px`);
  svg.style.setProperty("--look-y", `${dy.toFixed(2)}px`);
}

/** 登录页互动：鼠标跟随 + 输入用户名时盯着看 + 输密码捂眼（显示密码时偷看）。 */
export function attachLoginInteractions(svg, { nameInput, passInput, isPeek } = {}) {
  if (!svg) return;
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let focusMode = "";
  let raf = 0;
  const onMove = (e) => {
    if (focusMode || reduce) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => lookAt(svg, e.clientX, e.clientY));
  };
  window.addEventListener("pointermove", onMove, { passive: true });

  const followCaret = () => {
    if (!nameInput) return;
    const r = nameInput.getBoundingClientRect();
    const ratio = Math.min(1, (nameInput.value.length || 0) / 12);
    lookAt(svg, r.left + 20 + ratio * (r.width - 40), r.top + r.height / 2);
  };
  if (nameInput) {
    nameInput.addEventListener("focus", () => { focusMode = "name"; setMood(svg, "normal"); followCaret(); });
    nameInput.addEventListener("input", followCaret);
    nameInput.addEventListener("blur", () => { focusMode = ""; lookAt(svg, null); });
  }
  const syncPass = () => setMood(svg, isPeek && isPeek() ? "peek" : "shy");
  if (passInput) {
    passInput.addEventListener("focus", () => { focusMode = "pass"; syncPass(); });
    passInput.addEventListener("blur", () => { focusMode = ""; setMood(svg, "normal"); lookAt(svg, null); });
  }
  return { syncPass: () => { if (focusMode === "pass") syncPass(); } };
}
