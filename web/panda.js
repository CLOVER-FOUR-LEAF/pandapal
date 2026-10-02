// 熊猫形象：SVG + CSS 动画（眨眼/浮动/表情/点击互动）
// mood: normal | thinking | speaking | happy | sleepy

const SVG = `
<svg viewBox="0 0 200 200" class="panda-svg" xmlns="http://www.w3.org/2000/svg">
  <!-- 耳朵 -->
  <circle cx="58" cy="52" r="26" fill="#2e2a26"/>
  <circle cx="142" cy="52" r="26" fill="#2e2a26"/>
  <circle cx="58" cy="52" r="13" fill="#4a4239"/>
  <circle cx="142" cy="52" r="13" fill="#4a4239"/>
  <!-- 头 -->
  <circle cx="100" cy="106" r="66" fill="#ffffff" stroke="#e8dcc8" stroke-width="2"/>
  <!-- 黑眼圈 -->
  <ellipse cx="72" cy="98" rx="17" ry="22" fill="#2e2a26" transform="rotate(-14 72 98)"/>
  <ellipse cx="128" cy="98" rx="17" ry="22" fill="#2e2a26" transform="rotate(14 128 98)"/>
  <!-- 眼睛（眨眼动画作用于此） -->
  <g class="eye"><circle cx="75" cy="95" r="6.5" fill="#fff"/><circle cx="76.5" cy="96" r="3.4" fill="#222"/><circle cx="78" cy="93.5" r="1.2" fill="#fff"/></g>
  <g class="eye"><circle cx="125" cy="95" r="6.5" fill="#fff"/><circle cx="126.5" cy="96" r="3.4" fill="#222"/><circle cx="128" cy="93.5" r="1.2" fill="#fff"/></g>
  <!-- 腮红 -->
  <circle cx="52" cy="122" r="8" fill="#f7c8b8" opacity=".65"/>
  <circle cx="148" cy="122" r="8" fill="#f7c8b8" opacity=".65"/>
  <!-- 鼻子 -->
  <ellipse cx="100" cy="122" rx="7.5" ry="5.5" fill="#2e2a26"/>
  <!-- 嘴：微笑 / 说话张合 -->
  <path class="mouth-smile" d="M88 136 Q100 146 112 136" stroke="#2e2a26" stroke-width="3" fill="none" stroke-linecap="round"/>
  <ellipse class="mouth-open" cx="100" cy="139" rx="9" ry="7" fill="#b65a4e"/>
  <ellipse class="mouth-open" cx="100" cy="141" rx="5" ry="3.5" fill="#e8907f"/>
</svg>`;

export function mountPanda(holder) {
  holder.innerHTML = SVG;
  const svg = holder.querySelector("svg");
  svg.addEventListener("click", () => {
    svg.classList.remove("bounce");
    void svg.offsetWidth; // 重启动画
    svg.classList.add("bounce");
  });
  return svg;
}

export function setMood(svg, mood) {
  svg.classList.remove("thinking", "speaking", "happy", "sleepy");
  if (mood && mood !== "normal") svg.classList.add(mood);
}
