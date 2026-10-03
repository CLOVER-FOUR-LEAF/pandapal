// Procedural felt panda: soft sculpture, woven accessories and quiet gestures.
// Geometry and fabric textures are generated locally; no remote assets required.
//
// 对外 API（scene3d.js 调用）：
//   useThree(THREE)               注入 three 模块（避免二次加载 CDN）
//   createPanda(THREE?)           -> THREE.Group；动画只改内部 rig，root.position 留给场景摆放
//   setPandaMood(group, mood)     idle | listening | curious | thinking | working | speaking
//                                 happy | excited | proud | shy | worried | sad | sleepy
//   triggerAction(group, name)    一次性动作：wave|nod|shake|hop|cheer|bow|stretch|hug|tilt|point
//   triggerWave(group)            挥手 1.6 秒（点击熊猫时用，等价 triggerAction(group,"wave")）
//   setPandaLook(group, x, y)     眼神跟随：-1..1 的屏幕偏移，熊猫会转头看过去
//   setPandaAttention(group, on)  被鼠标指着/摸到：耳朵竖起、眼睛睁大一点
//   updatePanda(group, dt)        每帧推进动画（由 scene3d 的 rAF 调用）
//   getFaceCount(group)           三角面数统计（自检用）
//
// 设计原则：姿势用"通道 + 平滑过渡"表达情绪，一次性动作用"包络叠加"叠在姿势之上；
// 两类动画都只改 rig 内部，绝不碰 root —— 场景负责摆位，拖拽/停靠都不会被动画冲掉。

let THREE_REF = null;

/** 注入 three 模块（scene3d 加载完 three 后调用一次即可）。 */
export function useThree(t) {
  if (t) THREE_REF = t;
  return THREE_REF;
}

function pick3(passed) {
  const t = passed || THREE_REF;
  if (!t) throw new Error("panda3d: 缺少 three 模块，请先 useThree(THREE) 或把 THREE 传进来");
  return t;
}

// ---------- 配色 ----------
const C = {
  white: 0xf8f4ec,
  black: 0x2a2b2e,
  black2: 0x3a3536,
  pink: 0xd9a08c,
  bamboo: 0x4f857a,
  paper: 0xf5eddc,
  book: 0x426a61,
  pen: 0xc49a60,
};

const FORM = {
  headRadius: 1.68, headScale: [1.1, 0.95, 0.97], headCenterY: 0.15, headRestY: 4.3,
  bodyRadius: 1.55, bodyScale: [1.06, 0.98, 0.9], bodyRestY: 2.06,
  browY: 0.52, mouthY: -0.62,
};

function fabricTexture(t) {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  let seed = 417;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const grain = (seed / 4294967296 - 0.5) * 30;
      const weave = Math.sin(x * Math.PI / 2) * 5 + Math.cos(y * Math.PI / 2) * 4;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 232 + grain + weave;
      data[i + 3] = 255;
    }
  }
  const texture = new t.DataTexture(data, size, size, t.RGBAFormat);
  texture.wrapS = texture.wrapT = t.RepeatWrapping;
  texture.repeat.set(7, 7);
  texture.magFilter = t.LinearFilter;
  texture.minFilter = t.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function furTextures(t) {
  const size = 256;
  let seed = 2197;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const field = (width, height) => ({ width, height, data: Float32Array.from({ length: width * height }, random) });
  const broad = field(16, 16), tufts = field(64, 24), fine = field(128, 64);
  const sample = (grid, u, v) => {
    const x = u * grid.width, y = v * grid.height;
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const at = (a, b) => grid.data[((b % grid.height + grid.height) % grid.height) * grid.width + (a % grid.width + grid.width) % grid.width];
    const top = at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx;
    const bottom = at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  const heights = new Float32Array(size * size);
  const colorData = new Uint8Array(size * size * 4);
  const normalData = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const bend = Math.sin(v * Math.PI * 8) * 0.009 + Math.sin(v * Math.PI * 22) * 0.003;
    const tuft = sample(tufts, u + bend, v), detail = sample(fine, u + bend, v);
    const broadValue = sample(broad, u, v);
    heights[y * size + x] = tuft * 0.65 + detail * 0.25 + broadValue * 0.1;
    const i = (y * size + x) * 4;
    const value = 243 + (broadValue - 0.5) * 5 + (tuft - 0.5) * 3;
    colorData[i] = colorData[i + 1] = colorData[i + 2] = value;
    colorData[i + 3] = 255;
  }
  const heightAt = (x, y) => heights[((y + size) % size) * size + (x + size) % size];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (heightAt(x - 1, y) - heightAt(x + 1, y)) * 0.38;
    const dy = (heightAt(x, y - 1) - heightAt(x, y + 1)) * 0.38;
    const inverseLength = 1 / Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
    normalData[i] = (dx * inverseLength * 0.5 + 0.5) * 255;
    normalData[i + 1] = (dy * inverseLength * 0.5 + 0.5) * 255;
    normalData[i + 2] = (inverseLength * 0.5 + 0.5) * 255;
    normalData[i + 3] = 255;
  }
  const texture = data => {
    const map = new t.DataTexture(data, size, size, t.RGBAFormat);
    map.wrapS = map.wrapT = t.RepeatWrapping;
    map.repeat.set(4, 4);
    map.magFilter = t.LinearFilter;
    map.minFilter = t.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.needsUpdate = true;
    return map;
  };
  return { color: texture(colorData), normal: texture(normalData) };
}

function cheekBulge(y) {
  return 1 + 0.075 * Math.exp(-Math.pow((y + 0.2) * 1.45, 2));
}

function headGeometry(t) {
  const geometry = new t.SphereGeometry(FORM.headRadius, 64, 48);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / FORM.headRadius;
    const cheek = cheekBulge(y);
    const x = p.getX(i) * cheek;
    const worldX = x * FORM.headScale[0], worldY = p.getY(i) * FORM.headScale[1] + FORM.headCenterY;
    const muzzle = p.getZ(i) > 0 ? muzzleDepth(worldX, worldY) * Math.min(1, p.getZ(i) / (FORM.headRadius * 0.75)) / FORM.headScale[2] : 0;
    p.setXYZ(i, x, p.getY(i), p.getZ(i) + muzzle);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function bodyGeometry(t, grow = 1, thetaStart = 0, thetaLength = Math.PI) {
  const geometry = new t.SphereGeometry(FORM.bodyRadius * grow, 40, 30, 0, Math.PI * 2, thetaStart, thetaLength);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / FORM.bodyRadius;
    p.setXYZ(i, p.getX(i) * (1 - y * 0.1), p.getY(i), p.getZ(i) * (1 - y * 0.04));
  }
  geometry.computeVertexNormals();
  return geometry;
}

function curveMesh(t, points, radius, material) {
  return new t.Mesh(new t.TubeGeometry(
    new t.CatmullRomCurve3(points.map(p => new t.Vector3(...p))),
    18, radius, 6, false
  ), material);
}

function muzzleDepth(x, y) {
  return 0.09 * Math.exp(-Math.pow(x / 0.6, 2) - Math.pow((y + 0.43) / 0.34, 2));
}

function faceDepth(x, y) {
  const ny = (y - FORM.headCenterY) / (FORM.headRadius * FORM.headScale[1]);
  const cheek = cheekBulge(ny);
  return FORM.headRadius * FORM.headScale[2] * Math.sqrt(Math.max(0, 1 - Math.pow(x / (FORM.headRadius * FORM.headScale[0] * cheek), 2) - ny * ny)) + muzzleDepth(x, y);
}

function eyeTexture(t, side) {
  const size = 128, data = new Uint8Array(size * size * 4);
  const smooth = (a, b, value) => { const v = Math.max(0, Math.min(1, (value - a) / (b - a))); return v * v * (3 - 2 * v); };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size * 2 - 1, v = (y + 0.5) / size * 2 - 1;
    const dx = u - side * 0.03, dy = v - 0.0, radius = Math.hypot(dx, dy);
    const iris = 1 - smooth(0.965, 0.995, radius), pupil = 1 - smooth(0.62, 0.7, radius);
    const warmth = (1 - smooth(0.3, 0.9, radius)) * smooth(0.55, 0.7, radius);
    const highlight = (1 - smooth(0.6, 1, Math.hypot((dx + 0.3) / 0.15, (dy - 0.3) / 0.13))) * 0.92;
    const secondary = (1 - smooth(0.4, 1, Math.hypot((dx - 0.3) / 0.06, (dy + 0.3) / 0.06))) * 0.0;
    const base = [239, 236, 225], outer = [35, 43, 39], inner = [92, 70, 48], ink = [20, 29, 28];
    for (let c = 0; c < 3; c++) {
      const irisColor = outer[c] * (1 - warmth) + inner[c] * warmth;
      let color = base[c] * (1 - iris) + irisColor * iris;
      color = color * (1 - pupil) + ink[c] * pupil;
      const catchlight = Math.max(highlight, secondary);
      data[(y * size + x) * 4 + c] = color * (1 - catchlight) + [255, 252, 239][c] * catchlight;
    }
    data[(y * size + x) * 4 + 3] = 255;
  }
  const texture = new t.DataTexture(data, size, size, t.RGBAFormat);
  texture.colorSpace = t.SRGBColorSpace;
  texture.magFilter = t.LinearFilter;
  texture.minFilter = t.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function eyeGeometry(t) {
  const geometry = new t.RingGeometry(0, 1, 40, 10);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setXYZ(i, x * 0.185, y * 0.185, 0.062 * Math.sqrt(Math.max(0, 1 - x * x - y * y)));
  }
  geometry.computeVertexNormals();
  return geometry;
}

// Project facial markings onto the sculpt, keeping their edges flush from every angle.
function facePatch(t, cx, cy, width, height, angle, lift = 0.028, taper = 0) {
  const g = new t.RingGeometry(0, 1, 48, 8);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = p.getY(i), u = p.getX(i) * (1 - taper * v);
    const x = cx + u * width * Math.cos(angle) - v * height * Math.sin(angle);
    const y = cy + u * width * Math.sin(angle) + v * height * Math.cos(angle);
    p.setXYZ(i, x, y, faceDepth(x, y) + lift + 0.012 * (1 - u * u - v * v));
  }
  g.computeVertexNormals();
  return g;
}

function blushTexture(t) {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.pow(Math.max(0, 1 - radius), 1.5) * 255;
  }
  const texture = new t.DataTexture(data, size, size, t.RGBAFormat);
  texture.magFilter = texture.minFilter = t.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// 手绘感的小圆点贴图：用于腮红、汗滴、音符、星光这类"表情符号"附件。
// 全部用径向渐变本地生成，不引外部资源。
function dotTexture(t, soft = true) {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = ((x + 0.5) / size) * 2 - 1, v = ((y + 0.5) / size) * 2 - 1;
    const r = Math.hypot(u, v);
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = soft ? Math.pow(Math.max(0, 1 - r), 1.6) * 255 : (r <= 1 ? 255 : 0);
  }
  const texture = new t.DataTexture(data, size, size, t.RGBAFormat);
  texture.magFilter = texture.minFilter = t.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// 心形/星星这类轮廓贴图：同一个 64² 缓冲里按 (u,v) 判定，边缘用 3×3 超采样做抗锯齿。
function shapeTexture(t, inside) {
  const size = 64, data = new Uint8Array(size * size * 4);
  const at = (u, v) => inside(u, v);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let hit = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const u = ((x + (sx + 0.5) / 3) / size) * 2 - 1;
      const v = ((y + (sy + 0.5) / 3) / size) * 2 - 1;
      if (at(u, v)) hit++;
    }
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = (hit / 9) * 255;
  }
  const texture = new t.DataTexture(data, size, size, t.RGBAFormat);
  texture.magFilter = texture.minFilter = t.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// Bent ribbons follow a shared downward groom; their roots blend into the surface.
function addPile(t, mesh, material, count, length, seed = 17) {
  const source = mesh.geometry, positions = source.attributes.position;
  const normals = source.attributes.normal, uvs = source.attributes.uv, index = source.index;
  const triangleCount = (index ? index.count : positions.count) / 3;
  const cumulative = new Float32Array(triangleCount);
  const a = new t.Vector3(), b = new t.Vector3(), c = new t.Vector3();
  const edge = new t.Vector3(), normal = new t.Vector3(), tangent = new t.Vector3();
  const groom = new t.Vector3(), uv = new t.Vector2();
  let area = 0;
  const vi = i => index ? index.getX(i) : i;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < triangleCount; i++) {
    a.fromBufferAttribute(positions, vi(i * 3));
    b.fromBufferAttribute(positions, vi(i * 3 + 1));
    c.fromBufferAttribute(positions, vi(i * 3 + 2));
    area += edge.subVectors(b, a).cross(c.sub(a)).length() * 0.5;
    cumulative[i] = area;
  }
  const vertices = [], vertexNormals = [], surfaceUvs = [], furCoords = [];
  for (let i = 0; i < count; i++) {
    const sample = random() * area;
    let low = 0, high = triangleCount - 1;
    while (low < high) { const mid = (low + high) >>> 1; if (cumulative[mid] < sample) low = mid + 1; else high = mid; }
    const ids = [vi(low * 3), vi(low * 3 + 1), vi(low * 3 + 2)];
    const u = Math.sqrt(random()), v = random(), weights = [1 - u, u * (1 - v), u * v];
    a.set(0, 0, 0); normal.set(0, 0, 0); uv.set(0, 0);
    ids.forEach((id, j) => {
      a.addScaledVector(b.fromBufferAttribute(positions, id), weights[j]);
      normal.addScaledVector(b.fromBufferAttribute(normals, id), weights[j]);
      if (uvs) { uv.x += uvs.getX(id) * weights[j]; uv.y += uvs.getY(id) * weights[j]; }
    });
    normal.normalize();
    groom.set(0.12 * Math.sin(a.x * 5 + a.z * 3), -1, 0.1);
    groom.addScaledVector(normal, -groom.dot(normal));
    if (groom.lengthSq() < 0.0001) groom.set(1, 0, 0).addScaledVector(normal, -normal.x);
    groom.normalize();
    tangent.crossVectors(normal, groom).normalize();
    groom.addScaledVector(tangent, (random() - 0.5) * 0.16).normalize();
    const height = length * (0.75 + random() * 0.4), width = height * 0.16;
    const points = [[-1, 0], [1, 0], [-0.62, 0.48], [-0.62, 0.48], [1, 0], [0.62, 0.48], [-0.62, 0.48], [0.62, 0.48], [0, 1]];
    for (const [side, rise] of points) {
      b.copy(a).addScaledVector(tangent, width * side)
        .addScaledVector(normal, 0.0015 + height * (rise - 0.28 * rise * rise))
        .addScaledVector(groom, height * rise * rise * 0.9);
      vertices.push(b.x, b.y, b.z);
      vertexNormals.push(normal.x, normal.y, normal.z);
      surfaceUvs.push(uv.x, uv.y);
      furCoords.push(side < 0 ? 0 : side > 0 ? 1 : 0.5, rise);
    }
  }
  const geometry = new t.BufferGeometry();
  geometry.setAttribute('position', new t.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new t.Float32BufferAttribute(vertexNormals, 3));
  geometry.setAttribute('uv', new t.Float32BufferAttribute(surfaceUvs, 2));
  geometry.setAttribute('furCoord', new t.Float32BufferAttribute(furCoords, 2));
  const pile = new t.Mesh(geometry, material);
  pile.name = 'felt-pile';
  pile.receiveShadow = true;
  mesh.add(pile);
}

// ---------- 表情通道的目标值（mood -> pose） ----------
// 每个通道都由 updatePanda 指数逼近，所以 mood 只是"想去哪"，不是硬切。
//   arm*     抬臂角度（正 = 向前抬）；左臂抱着记事本，右臂是"表达手"
//   headPitch 正 = 低头；headTilt 正 = 歪头；brow 正 = 担心内压、负 = 挑眉
//   mouth    张嘴程度；eye    眼睛整体缩放（>1 睁大、<1 眯起）
//   squash   纵向压扁（>1 挺直、<1 缩成一团）；lean 左右重心偏移
//   ear      耳朵起落：正 = 竖起（好奇），负 = 耷拉（难过）
const POSE = {
  idle:      { armL: 0.38, armR: 0.2,  headPitch: -0.025, headTilt: -0.055, brow: 0,     mouth: 0,    squash: 1,    eye: 1,    lean: 0,     ear: 0 },
  listening: { armL: 0.34, armR: 0.16, headPitch: -0.05,  headTilt: 0.06,   brow: -0.06, mouth: 0,    squash: 1.01, eye: 1.06, lean: -0.01, ear: 0.5 },
  curious:   { armL: 0.46, armR: 0.3,  headPitch: -0.08,  headTilt: 0.2,    brow: -0.14, mouth: 0.1,  squash: 1.02, eye: 1.12, lean: 0.02,  ear: 0.8 },
  thinking:  { armL: 0.4,  armR: 1.38, headPitch: -0.06,  headTilt: 0.12,   brow: 0.12,  mouth: 0,    squash: 1,    eye: 0.9,  lean: 0,     ear: 0.2 },
  working:   { armL: 0.68, armR: 0.95, headPitch: 0.18,   headTilt: -0.04,  brow: 0.04,  mouth: 0,    squash: 1,    eye: 0.94, lean: 0,     ear: 0.1 },
  speaking:  { armL: 0.36, armR: 0.48, headPitch: -0.025, headTilt: 0.04,   brow: -0.04, mouth: 0.25, squash: 1,    eye: 1.02, lean: 0.01,  ear: 0.35 },
  happy:     { armL: 0.45, armR: 2.1,  headPitch: -0.1,   headTilt: -0.07,  brow: -0.1,  mouth: 0.38, squash: 1,    eye: 1.1,  lean: 0,     ear: 0.7 },
  excited:   { armL: 0.6,  armR: 2.35, headPitch: -0.16,  headTilt: -0.1,   brow: -0.2,  mouth: 0.5,  squash: 1.03, eye: 1.18, lean: 0,     ear: 0.9 },
  proud:     { armL: 0.42, armR: 0.72, headPitch: -0.14,  headTilt: -0.05,  brow: -0.12, mouth: 0.24, squash: 1.03, eye: 1.06, lean: -0.02, ear: 0.6 },
  shy:       { armL: 0.3,  armR: 1.72, headPitch: 0.2,    headTilt: 0.16,   brow: -0.02, mouth: 0.06, squash: 0.99, eye: 0.82, lean: 0.01,  ear: -0.2 },
  worried:   { armL: 0.34, armR: 0.28, headPitch: 0.1,    headTilt: -0.06,  brow: 0.65,  mouth: 0.04, squash: 0.99, eye: 1.04, lean: 0,     ear: -0.1 },
  sad:       { armL: 0.24, armR: 0.14, headPitch: 0.24,   headTilt: 0.05,   brow: 0.78,  mouth: 0.02, squash: 0.97, eye: 0.86, lean: 0,     ear: -0.7 },
  sleepy:    { armL: 0.32, armR: 0.18, headPitch: 0.3,    headTilt: -0.14,  brow: -0.04, mouth: 0,    squash: 0.99, eye: 0.32, lean: -0.03, ear: -0.5 },
};

export const PANDA_MOODS = Object.keys(POSE);

// 一次性动作：{dur, gain} + 一个把 [0,1] 进度映射成通道偏移的函数（包络自带起落，
// 首尾都是 0，所以动作能随时被叠加或打断而不会跳）。
const ACTIONS = {
  // 挥手：抬起 + 左右摆
  wave: { dur: 1.6, apply(p, o) { const s = Math.pow(Math.sin(p * Math.PI), 0.65); o.armR += -2.25 * s; o.armRz += (-0.48 - Math.sin(p * Math.PI * 6) * 0.22) * s; o.headTilt += -0.06 * s; o.mouth += 0.16 * s; o.ear += 0.5 * s; } },
  // 点头：同意
  nod: { dur: 1.1, apply(p, o) { const s = Math.sin(p * Math.PI); o.headPitch += Math.sin(p * Math.PI * 3) * 0.2 * s; o.mouth += 0.14 * s; } },
  // 摇头：不确定/不行
  shake: { dur: 1.2, apply(p, o) { const s = Math.sin(p * Math.PI); o.headYaw += Math.sin(p * Math.PI * 4) * 0.22 * s; o.brow += 0.2 * s; } },
  // 原地小跳
  hop: { dur: 0.9, apply(p, o) { const s = Math.sin(p * Math.PI); o.jump += Math.pow(s, 1.5) * 0.3; o.tuck += s * 0.5; o.ear += 0.7 * s; } },
  // 欢呼：双臂举起 + 跳
  cheer: { dur: 1.7, apply(p, o) { const s = Math.sin(p * Math.PI); o.jump += Math.pow(s, 1.3) * 0.36; o.armR += -2.5 * s; o.armL += -0.9 * s; o.tuck += s * 0.6; o.mouth += 0.36 * s; o.eye += 0.16 * s; o.brow += -0.24 * s; o.ear += 0.9 * s; } },
  // 鞠躬：谢谢/抱歉
  bow: { dur: 1.5, apply(p, o) { const s = Math.sin(p * Math.PI); o.headPitch += 0.5 * s; o.armL += -0.3 * s; o.armR += -0.24 * s; o.squash += -0.04 * s; } },
  // 伸懒腰：双臂外张、抬头
  stretch: { dur: 1.9, apply(p, o) { const s = Math.sin(p * Math.PI); o.armR += -1.7 * s; o.armL += -1.1 * s; o.armRz += -0.5 * s; o.armLz += 0.5 * s; o.headPitch += -0.26 * s; o.mouth += 0.28 * s; o.squash += 0.05 * s; o.ear += 0.6 * s; } },
  // 抱一抱自己：安慰
  hug: { dur: 1.8, apply(p, o) { const s = Math.sin(p * Math.PI); o.armR += 1.35 * s; o.armL += 0.35 * s; o.armRz += 0.42 * s; o.headPitch += 0.16 * s; o.headTilt += 0.1 * s; o.eye += -0.16 * s; } },
  // 好奇歪头
  tilt: { dur: 1.3, apply(p, o) { const s = Math.sin(p * Math.PI); o.headTilt += 0.34 * s; o.ear += 0.7 * s; o.eye += 0.1 * s; } },
  // 指向某个节点（朝右前方伸爪）
  point: { dur: 1.4, apply(p, o) { const s = Math.sin(p * Math.PI); o.armR += -1.35 * s; o.armRz += -0.62 * s; o.headTilt += -0.12 * s; o.squash += 0.03 * s; } },
};

export const PANDA_ACTIONS = Object.keys(ACTIONS);

/** 空的动作偏移累加器（每帧复用，避免 GC）。 */
function blankOffsets() {
  return { armR: 0, armL: 0, armRz: 0, armLz: 0, headPitch: 0, headTilt: 0, headYaw: 0,
           brow: 0, mouth: 0, squash: 0, eye: 0, lean: 0, ear: 0, jump: 0, tuck: 0 };
}


/**
 * 创建熊猫管家。
 * @param {object} THREE three 模块（可选，未传则用 useThree 注入的）
 * @param {object} opts  {scale?: number}
 * @returns {THREE.Group} 根节点，userData.panda = true，可直接 add 到场景
 */
export function createPanda(THREE, opts = {}) {
  const t = pick3(THREE);
  const s = opts.scale || 1;

  const root = new t.Group();
  root.name = "panda3d";
  const rig = new t.Group(); // 所有动画偏移加在 rig 上，root 由场景负责摆放
  root.add(rig);

  const fabric = fabricTexture(t);
  const fur = furTextures(t);
  const blush = blushTexture(t);
  const eyeMaps = [eyeTexture(t, 1), eyeTexture(t, -1)];
  const mat = (color, o = {}) => new t.MeshPhysicalMaterial({
    color, roughness: 0.98, metalness: 0, specularIntensity: 0.12,
    envMapIntensity: 0.22, sheen: 0.3, sheenRoughness: 0.95,
    sheenColor: new t.Color(color).lerp(new t.Color(0xffffff), 0.16),
    map: fabric, bumpMap: fabric, bumpScale: 0.033, ...o,
  });
  const skin = (color, o = {}) => mat(color, {
    map: fur.color, normalMap: fur.normal, normalScale: new t.Vector2(0.18, 0.18),
    bumpMap: null, roughness: 0.94, sheen: 0.24, sheenRoughness: 0.92, ...o,
  });
  const M = {
    white: skin(C.white),
    black: skin(C.black, { sheen: 0.34 }),
    black2: skin(C.black2, { sheen: 0.3 }),
    pink: mat(C.pink, { map: blush, bumpMap: null, sheen: 0, transparent: true, opacity: 0.16, depthWrite: false }),
    muzzle: mat(0xd8c9b2, { map: blush, bumpMap: null, sheen: 0, transparent: true, opacity: 0.5, depthWrite: false }),
    bamboo: mat(C.bamboo, { bumpScale: 0.035 }),
    paper: mat(C.paper, { sheen: 0, bumpScale: 0.009 }),
    book: mat(C.book, { bumpScale: 0.028 }),
    pen: mat(C.pen, { roughness: 0.7, sheen: 0, bumpScale: 0.01 }),
    earIn: mat(0x4a4647, { sheen: 0.1 }),
    nose: mat(0x253032, { roughness: 0.42, specularIntensity: 0.5, sheen: 0, map: null, bumpMap: null }),
    thread: mat(0xb9c9b9, { sheen: 0.2, bumpMap: null }),
  };
  const pileMat = surface => {
    const material = surface.clone();
    material.name = 'panda-groomed-fur';
    material.normalMap = null;
    material.side = t.DoubleSide;
    material.transparent = true;
    material.depthWrite = false;
    material.forceSinglePass = true;
    // Match the parent lighting and shadows, with soft edges and restrained frontal coverage.
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 furCoord;\nvarying vec2 vPandaFurCoord;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPandaFurCoord = furCoord;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vPandaFurCoord;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', t.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', [
        'float fiberEdge = smoothstep(0.0, 0.24, vPandaFurCoord.x) * (1.0 - smoothstep(0.76, 1.0, vPandaFurCoord.x));',
        'float fiberTip = smoothstep(0.0, 0.16, vPandaFurCoord.y) * (1.0 - smoothstep(0.55, 1.0, vPandaFurCoord.y));',
        'float fiberRim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 1.5);',
        'diffuseColor.a *= fiberEdge * fiberTip * (0.16 + 0.64 * fiberRim);',
        '#include <opaque_fragment>',
      ].join('\n'));
    };
    material.customProgramCacheKey = () => 'groomed-fur-soft-coverage-v2';
    return material;
  };
  const lightPile = pileMat(M.white), darkPile = pileMat(M.black), softBlackPile = pileMat(M.black2);

  // 小工具：造 mesh 并摆位
  const mk = (geo, material, x = 0, y = 0, z = 0) => {
    const m = new t.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const scale = (obj, x, y, z) => {
    obj.scale.set(x, y, z);
    return obj;
  };

  // ---------- 腿脚 ----------
  const legGeo = new t.CapsuleGeometry(0.43, 0.24, 8, 20);
  const footGeo = new t.SphereGeometry(0.51, 24, 18);
  const legL = mk(legGeo, M.black, -0.64, 0.56, 0.02);
  const legR = mk(legGeo, M.black, 0.64, 0.56, 0.06);
  const footL = scale(mk(footGeo, M.black, -0.67, 0.31, 0.3), 1.06, 0.68, 1.25);
  const footR = scale(mk(footGeo, M.black, 0.67, 0.31, 0.38), 1.06, 0.68, 1.25);
  footL.rotation.y = -0.12;
  footR.rotation.y = 0.12;
  rig.add(legL, legR, footL, footR);

  // ---------- 身体 ----------
  const body = scale(mk(bodyGeometry(t), M.white, 0, FORM.bodyRestY, 0), ...FORM.bodyScale);
  const shoulderBand = scale(mk(bodyGeometry(t, 1.014, 0.52, 0.66), M.black, 0, FORM.bodyRestY, 0), ...FORM.bodyScale);
  shoulderBand.material = M.black.clone();
  shoulderBand.material.side = t.DoubleSide;
  rig.add(shoulderBand);
  const tail = scale(mk(new t.SphereGeometry(0.3, 20, 16), M.white, 0, 1.56, -1.32), 1, 0.9, 0.8);
  rig.add(body, tail);

  // ---------- 手臂（group 原点=肩，方便绕肩旋转）----------
  const armGeo = new t.CapsuleGeometry(0.45, 0.55, 8, 24);
  const pawGeo = new t.SphereGeometry(0.46, 24, 18);
  const armL = new t.Group();
  armL.position.set(-1.3, 3.07, 0.08);
  armL.add(mk(armGeo, M.black, 0, -0.49, 0), mk(pawGeo, M.black, 0, -1.0, 0.52));
  const armR = new t.Group();
  armR.position.set(1.3, 3.07, 0.08);
  armR.add(mk(armGeo, M.black, 0, -0.49, 0), mk(pawGeo, M.black, 0, -1.0, 0.12));
  const pawPad = scale(mk(new t.SphereGeometry(0.18, 20, 14), M.black2, 0, -1.0, 0.475), 1, 0.83, 0.16);
  armR.add(pawPad);
  rig.add(armL, armR);

  // ---------- 头部（整体挂在 headGroup 上，低头/挠头一起动）----------
  const headGroup = new t.Group();
  headGroup.position.set(0, FORM.headRestY, 0);
  rig.add(headGroup);

  const head = scale(mk(headGeometry(t), M.white, 0, FORM.headCenterY, 0), ...FORM.headScale);
  const earGeo = new t.SphereGeometry(0.6, 28, 22);
  const earInGeo = new t.SphereGeometry(0.27, 24, 16);
  const earL = scale(mk(earGeo, M.black, -1.36, 1.3, -0.2), 1, 1, 0.7);
  const earR = scale(mk(earGeo, M.black, 1.36, 1.3, -0.2), 1, 1, 0.7);
  const earInL = scale(mk(earInGeo, M.earIn, 0, -0.04, 0.6), 1, 1, 0.3);
  const earInR = scale(mk(earInGeo, M.earIn, 0, -0.04, 0.6), 1, 1, 0.3);
  earInL.castShadow = earInR.castShadow = false;
  earL.add(earInL);
  earR.add(earInR);
  const patchL = mk(facePatch(t, -0.82, -0.02, 0.41, 0.5, -0.3, 0.028, 0.1), M.black);
  const patchR = mk(facePatch(t, 0.82, -0.02, 0.41, 0.5, 0.3, 0.028, 0.1), M.black);
  const noseShape = new t.Shape();
  noseShape.moveTo(-0.18, 0.055);
  noseShape.quadraticCurveTo(0, 0.16, 0.18, 0.055);
  noseShape.quadraticCurveTo(0.19, -0.015, 0.035, -0.12);
  noseShape.quadraticCurveTo(0, -0.14, -0.035, -0.12);
  noseShape.quadraticCurveTo(-0.19, -0.015, -0.18, 0.055);
  const nose = scale(mk(new t.ExtrudeGeometry(noseShape, { depth: 0.029, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 3, steps: 1, curveSegments: 16 }), M.nose, 0, -0.33, faceDepth(0, -0.33) + 0.008), 0.8, 0.8, 0.8);
  const muzzlePatch = mk(facePatch(t, 0, -0.5, 0.5, 0.36, 0, 0.022), M.muzzle);
  muzzlePatch.castShadow = false;
  const cheekL = mk(facePatch(t, -1.2, -0.52, 0.34, 0.22, 0.3, 0.03), M.pink);
  const cheekR = mk(facePatch(t, 1.2, -0.52, 0.34, 0.22, -0.3, 0.03), M.pink);
  cheekL.castShadow = cheekR.castShadow = false;

  // 眼睛（group 用于眨眼：压扁 y）
  const eyeGeo = eyeGeometry(t);
  const eyeL = new t.Group();
  eyeL.position.set(-0.76, -0.01, faceDepth(-0.76, -0.01) + 0.05);
  eyeL.rotation.set(0.02, -0.24, 0);
  const eyeR = new t.Group();
  eyeR.position.set(0.76, -0.01, faceDepth(0.76, -0.01) + 0.05);
  eyeR.rotation.set(0.02, 0.24, 0);
  for (const [i, eye] of [eyeL, eyeR].entries()) {
    const material = new t.MeshPhysicalMaterial({ color: 0xffffff, map: eyeMaps[i], roughness: 0.32, metalness: 0, specularIntensity: 0.4, envMapIntensity: 0.3 });
    eye.add(mk(eyeGeo, material));
  }

  // 嘴：压扁的球，说话时 y 拉伸 = 开合
  const mouth = scale(mk(new t.SphereGeometry(0.17, 24, 18), M.nose, 0, FORM.mouthY, faceDepth(0, FORM.mouthY) + 0.02), 0.9, 0.01, 0.18);
  const smile = curveMesh(t, [[-0.2, -0.57], [-0.1, -0.625], [0.03, -0.64], [0.15, -0.61], [0.22, -0.55]].map(([x, y]) => [x, y, faceDepth(x, y) + 0.018]), 0.016, M.nose);
  const philtrum = curveMesh(t, [[0, -0.43, faceDepth(0, -0.43) + 0.032], [0, -0.51, faceDepth(0, -0.51) + 0.022], [0, -0.6, faceDepth(0, -0.6) + 0.018]], 0.0125, M.nose);

  // 眉毛（担心时向内下压）
  const browL = new t.Group();
  browL.position.set(-0.72, FORM.browY, faceDepth(-0.72, FORM.browY) + 0.015);
  browL.add(curveMesh(t, [[-0.13, 0, -0.035], [0, 0.026, 0.01], [0.12, 0, 0.035]], 0.019, M.black2));
  const browR = new t.Group();
  browR.position.set(0.72, FORM.browY, faceDepth(0.72, FORM.browY) + 0.015);
  browR.add(curveMesh(t, [[-0.12, 0, 0.035], [0, 0.026, 0.01], [0.13, 0, -0.035]], 0.019, M.black2));

  headGroup.add(head, earL, earR, muzzlePatch, patchL, patchR, nose, cheekL, cheekR, eyeL, eyeR, mouth, smile, philtrum, browL, browR);

  // Folded sage neckerchief with an embroidered sprout.
  const scarf = new t.Group();
  scarf.position.set(0.13, 3.1, 1.08);
  scarf.scale.set(0.82, 0.76, 0.86);
  scarf.rotation.z = -0.13;
  const scarfShape = new t.Shape();
  scarfShape.moveTo(-0.86, 0.2);
  scarfShape.quadraticCurveTo(0, 0.06, 0.86, 0.2);
  scarfShape.quadraticCurveTo(0.55, -0.15, 0.3, -0.6);
  scarfShape.quadraticCurveTo(0.21, -0.7, 0.06, -0.6);
  scarfShape.quadraticCurveTo(-0.55, -0.2, -0.86, 0.2);
  const scarfCloth = mk(new t.ExtrudeGeometry(scarfShape, { depth: 0.025, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.025, bevelSegments: 3, steps: 1, curveSegments: 18 }), M.bamboo);
  const clothPositions = scarfCloth.geometry.attributes.position;
  for (let i = 0; i < clothPositions.count; i++) clothPositions.setZ(i, clothPositions.getZ(i) - clothPositions.getY(i) * 0.55 - Math.pow(clothPositions.getX(i), 2) * 0.22);
  scarfCloth.geometry.computeVertexNormals();
  scarf.add(scarfCloth);
  scarf.add(curveMesh(t, [[-0.86, 0.2, -0.14], [-0.6, 0.1, 0.05], [0, 0.02, 0.13], [0.6, 0.1, 0.05], [0.86, 0.2, -0.14]], 0.032, M.bamboo));
  scarf.add(curveMesh(t, [[0.07, -0.55, 0.46], [0.09, -0.39, 0.38], [0.08, -0.25, 0.3]], 0.012, M.thread));
  const leafGeo = new t.SphereGeometry(0.09, 16, 12);
  const leafL = scale(mk(leafGeo, M.thread, 0.015, -0.33, 0.35), 0.55, 1, 0.16);
  const leafR = scale(mk(leafGeo, M.thread, 0.15, -0.28, 0.32), 0.55, 1, 0.16);
  leafL.rotation.z = 0.7;
  leafR.rotation.z = -0.7;
  scarf.add(leafL, leafR);
  rig.add(scarf);

  // ---------- 记事本（管家招牌）----------
  const padGroup = new t.Group();
  padGroup.position.set(0.12, -0.96, 0.97);
  padGroup.rotation.set(0.15, 0.08, -0.18);
  padGroup.scale.setScalar(0.86);
  const coverShape = new t.Shape();
  const bw = 0.54, bh = 0.68, br = 0.075;
  coverShape.moveTo(-bw + br, -bh);
  coverShape.lineTo(bw - br, -bh);
  coverShape.quadraticCurveTo(bw, -bh, bw, -bh + br);
  coverShape.lineTo(bw, bh - br);
  coverShape.quadraticCurveTo(bw, bh, bw - br, bh);
  coverShape.lineTo(-bw + br, bh);
  coverShape.quadraticCurveTo(-bw, bh, -bw, bh - br);
  coverShape.lineTo(-bw, -bh + br);
  coverShape.quadraticCurveTo(-bw, -bh, -bw + br, -bh);
  const coverGeo = new t.ExtrudeGeometry(coverShape, { depth: 0.025, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.018, bevelSegments: 2, steps: 1, curveSegments: 8 });
  const cover = mk(coverGeo, M.book, 0, 0, 0.16);
  const backCover = mk(coverGeo, M.book, 0, 0, -0.13);
  const pages = mk(new t.BoxGeometry(1.0, 1.24, 0.23), M.paper, 0.02, 0, 0.02);
  const spine = scale(mk(new t.CapsuleGeometry(0.085, 1.2, 6, 12), M.book, -0.52, 0, 0.015), 1, 1, 1.9);
  // 翻页：页面绕左侧书脊旋转
  const pagePivot = new t.Group();
  pagePivot.position.set(-0.48, 0, 0.145);
  const page = mk(new t.BoxGeometry(0.96, 1.22, 0.012), M.paper, 0.48, 0, 0);
  pagePivot.add(page);
  const bookMark = mk(new t.BoxGeometry(0.1, 0.32, 0.014), M.pen, 0.31, -0.64, 0.09);
  const bookEmblem = curveMesh(t, [[-0.23, 0.13, 0.211], [-0.1, 0.14, 0.211], [0, 0.07, 0.211], [0.1, 0.14, 0.211], [0.23, 0.13, 0.211]], 0.012, M.thread);
  const emblemBottom = curveMesh(t, [[-0.23, 0.13, 0.211], [-0.23, -0.13, 0.211], [-0.12, -0.13, 0.211], [0, -0.19, 0.211], [0.12, -0.13, 0.211], [0.23, -0.13, 0.211], [0.23, 0.13, 0.211]], 0.012, M.thread);
  const emblemSpine = curveMesh(t, [[0, 0.07, 0.212], [0, -0.06, 0.212], [0, -0.19, 0.212]], 0.011, M.thread);
  padGroup.add(backCover, bookMark, bookEmblem, emblemBottom, emblemSpine);
  // 笔（握在右手，写字时随手臂动）
  const penGroup = new t.Group();
  penGroup.position.set(-0.12, -0.94, 0.4);
  penGroup.rotation.set(0.3, 0, -0.3);
  penGroup.add(mk(new t.CylinderGeometry(0.045, 0.045, 0.83, 6), M.pen, 0, 0, 0));
  const tip = mk(new t.ConeGeometry(0.047, 0.16, 6), M.black2, 0, -0.49, 0);
  tip.rotation.x = Math.PI;
  penGroup.add(tip);
  armR.add(penGroup);

  padGroup.add(cover, pages, spine, pagePivot);
  armL.add(padGroup);
  armL.add(scale(mk(new t.SphereGeometry(0.2, 20, 16), M.black, 0.55, -1.13, 1.1), 1.05, 0.84, 0.62));

  addPile(t, head, lightPile, 5200, 0.024);
  addPile(t, body, lightPile, 3200, 0.026, 42);
  for (const [i, mesh] of [earL, earR, footL, footR, ...armL.children.filter(o => o.isMesh), ...armR.children.filter(o => o.isMesh)].entries()) {
    addPile(t, mesh, mesh.material === M.black2 ? softBlackPile : darkPile, 330, 0.022, 53 + i);
  }
  addPile(t, patchL, darkPile, 420, 0.01, 71);
  addPile(t, patchR, darkPile, 420, 0.01, 72);

  // ---------- 表情道具（贴在脸旁的小符号：汗滴/爱心/星光/音符/睡意）----------
  // 全部做成 Sprite 挂在 headGroup 上，随头一起动；默认透明，由 mood / 动作淡入淡出。
  const softDot = dotTexture(t, true);
  const heartTex = shapeTexture(t, (u, v) => {
    // 心形：两条圆 + 一个尖
    const x = u * 1.15, y = -v * 1.35 + 0.28;
    return (Math.pow(x * x + y * y - 0.55, 3) - x * x * y * y * y) <= 0;
  });
  const starTex = shapeTexture(t, (u, v) => {
    // 四角星光：|x|^0.55 + |y|^0.55 <= 1
    return Math.pow(Math.abs(u), 0.52) + Math.pow(Math.abs(v), 0.52) <= 1.02;
  });
  const noteTex = shapeTexture(t, (u, v) => {
    const head = Math.hypot((u + 0.34) / 0.42, (v + 0.46) / 0.36) <= 1;
    const stem = u > 0.28 && u < 0.44 && v > -0.46 && v < 0.72;
    const flag = u > 0.4 && u < 0.92 && v > 0.2 && v < 0.66;
    return head || stem || flag;
  });
  const sparkTex = shapeTexture(t, (u, v) => {
    const core = Math.hypot(u / 0.26, v / 0.26) <= 1;
    const cross = Math.abs(u) < 0.09 && Math.abs(v) < 0.86 || Math.abs(v) < 0.09 && Math.abs(u) < 0.86;
    return core || cross;
  });

  const props = new t.Group();
  props.name = "panda-props";
  headGroup.add(props);
  const spriteMat = (tex, color, opacity = 0) => new t.SpriteMaterial({
    map: tex, color, transparent: true, opacity, depthWrite: false, depthTest: true,
    blending: t.NormalBlending, fog: false,
  });
  const mkProp = (tex, color, x, y, z, sc, opacity = 0) => {
    const sp = new t.Sprite(spriteMat(tex, color, opacity));
    sp.position.set(x, y, z);
    sp.scale.setScalar(sc);
    sp.name = "panda-prop";
    props.add(sp);
    return sp;
  };
  // 头半径约 1.68，脸在 +z 一侧：道具贴在脸颊外侧/头顶，别糊在脸上
  const propBlushL = mkProp(softDot, 0xff9d86, -1.34, -0.5, faceDepth(-1.2, -0.52) - 0.1, 0.92);
  const propBlushR = mkProp(softDot, 0xff9d86, 1.34, -0.5, faceDepth(1.2, -0.52) - 0.1, 0.92);
  const propSweat = mkProp(softDot, 0xa9d8f5, 1.5, 0.62, faceDepth(1.2, 0.3) - 0.05, 0.5);
  const propHeartL = mkProp(heartTex, 0xff7f97, -1.5, 0.72, 0.55, 0.62);
  const propHeartR = mkProp(heartTex, 0xff7f97, 1.52, 0.86, 0.5, 0.5);
  const propSparkL = mkProp(sparkTex, 0xfff0b8, -1.32, 1.02, 0.7, 0.66);
  const propSparkR = mkProp(sparkTex, 0xfff0b8, 1.24, 1.16, 0.66, 0.84);
  const propNote = mkProp(noteTex, 0x9fe0c0, 1.56, 1.18, 0.42, 0.7);
  const propZzz = mkProp(noteTex, 0xbfe4ff, -1.46, 1.24, 0.3, 0.0);
  const propQuestion = mkProp(softDot, 0xffe7a8, 1.5, 0.9, 0.3, 0.0);

  root.scale.setScalar(s);
  root.userData = {
    panda: true,
    rig,
    mood: "idle",
    pose: { ...POSE.idle },
    t: 0,
    lookYaw: 0,
    lookPitch: 0,
    lookX: 0,
    lookY: 0,
    attention: 0,
    attentionTarget: 0,
    blinkAt: 1.6 + Math.random() * 2.4,
    blinkUntil: -1,
    waveUntil: -1,
    pageUntil: -1,
    idleUntil: 4 + Math.random() * 5,   // 下一次自发小动作
    idleAction: "",                      // 正在播的自发小动作
    action: "",                          // 正在播的手动动作
    actionUntil: -1,
    actionStart: 0,
    offset: blankOffsets(),              // 动作偏移（复用，不分配）
    props: {
      group: props, blushL: propBlushL, blushR: propBlushR, sweat: propSweat,
      heartL: propHeartL, heartR: propHeartR,
      sparkL: propSparkL, sparkR: propSparkR, note: propNote, zzz: propZzz, question: propQuestion,
    },
    textures: [fabric, blush, fur.color, fur.normal, ...eyeMaps, softDot, heartTex, starTex, noteTex, sparkTex],
    parts: {
      rig, body, tail, armL, armR, legL, legR, footL, footR,
      headGroup, head, earL, earR, eyeL, eyeR, mouth, smile, browL, browR, padGroup, pagePivot, penGroup,
    },
  };
  updatePanda(root, 0);
  return root;
}

/**
 * 切换情绪状态（立即记录，姿势由 updatePanda 平滑过渡过去）。
 * @param {THREE.Group} group createPanda 的返回值
 * @param {string} mood PANDA_MOODS 里的一个；未知值退回 idle
 */
export function setPandaMood(group, mood) {
  if (!group || !group.userData || !group.userData.panda) return;
  const m = POSE[mood] ? mood : "idle";
  const ud = group.userData;
  if (ud.mood === m) return;
  ud.mood = m;
  // 翻页只在"要动笔"的表情里出现；进入时立刻排一次，别等 1.6 秒才翻
  if (m === "thinking" || m === "working") ud.pageUntil = Math.min(ud.pageUntil, ud.t) || ud.t;
}

/**
 * 播一次动作。同名的正在播就忽略；不同名的直接顶掉（孩子连点不会排队卡住）。
 * @param {THREE.Group} group
 * @param {string} name PANDA_ACTIONS 里的一个；未知值忽略
 * @returns {boolean} 是否接受
 */
export function triggerAction(group, name) {
  if (!group || !group.userData || !group.userData.panda) return false;
  if (!ACTIONS[name]) return false;
  const ud = group.userData;
  if (ud.action === name && ud.t < ud.actionUntil) return false; // 正在播同一个，别重头再来
  ud.action = name;
  ud.actionStart = ud.t;
  ud.actionUntil = ud.t + ACTIONS[name].dur;
  ud.idleAction = "";           // 动作优先，自发小动作让位
  ud.idleUntil = ud.t + 2.5 + Math.random() * 4;
  return true;
}

/** 点击熊猫时挥手（等价 triggerAction(group, "wave")）。 */
export function triggerWave(group) {
  return triggerAction(group, "wave");
}

/**
 * 眼神/转头跟随：x、y 是 -1..1 的偏移（相对熊猫正面）。
 * 视觉上比真转头更"活"——眼睛跟着鼠标走是小朋友最容易察觉的生命感。
 */
export function setPandaLook(group, x, y) {
  if (!group || !group.userData || !group.userData.panda) return;
  const ud = group.userData;
  ud.lookX = Math.max(-1, Math.min(1, x || 0));
  ud.lookY = Math.max(-1, Math.min(1, y || 0));
}

/** 鼠标指着/摸着熊猫：耳朵竖起、眼睛睁大、停止自动小动作（它在看你）。 */
export function setPandaAttention(group, on) {
  if (!group || !group.userData || !group.userData.panda) return;
  group.userData.attentionTarget = on ? 1 : 0;
}

/** 是否正在被"注意"（拖拽/悬停中）。 */
export function isPandaAttentive(group) {
  return !!(group && group.userData && group.userData.panda && group.userData.attention > 0.5);
}

/**
 * 每帧推进动画。
 * @param {THREE.Group} group
 * @param {number} dt 秒
 */
export function updatePanda(group, dt) {
  if (!group || !group.userData || !group.userData.panda) return;
  const ud = group.userData;
  const P = ud.parts;
  const target = POSE[ud.mood] || POSE.idle;
  const d = Math.min(0.05, Math.max(0, dt));
  ud.t += d;
  const t = ud.t;

  // 姿势平滑过渡（指数逼近，与帧率无关）
  const k = 1 - Math.exp(-d * 7);
  const pose = ud.pose;
  for (const key in target) pose[key] += (target[key] - pose[key]) * k;

  // 被注意 / 眼神跟随都走平滑，避免鼠标一动头就抖
  ud.attention += (ud.attentionTarget - ud.attention) * (1 - Math.exp(-d * 6));
  ud.lookYaw += (ud.lookX * 0.34 - ud.lookYaw) * (1 - Math.exp(-d * 5));
  ud.lookPitch += (-ud.lookY * 0.22 - ud.lookPitch) * (1 - Math.exp(-d * 5));

  // ---------- 动作偏移（一次性动作 + 空闲小动作）----------
  const o = ud.offset;
  for (const key in o) o[key] = 0;
  if (ud.action && t < ud.actionUntil) {
    const spec = ACTIONS[ud.action];
    spec.apply(Math.max(0, Math.min(1, (t - ud.actionStart) / spec.dur)), o);
  } else if (ud.action) {
    ud.action = "";
    ud.actionUntil = -1;
  }
  // 空闲小动作：只有闲下来、没被注意、没在说话时才自娱自乐
  if (!ud.action && ud.attention < 0.35) {
    if (ud.idleAction) {
      const spec = ACTIONS[ud.idleAction];
      if (spec && t < ud.idleUntil) spec.apply(Math.max(0, Math.min(1, (t - ud.idleStart) / spec.dur)), o);
      else { ud.idleAction = ""; ud.idleUntil = t + 4 + Math.random() * 6; }
    } else if (t > ud.idleUntil && (ud.mood === "idle" || ud.mood === "listening")) {
      const pool = IDLE_ACTIONS;
      ud.idleAction = pool[(Math.random() * pool.length) | 0];
      ud.idleStart = t;
      ud.idleUntil = t + ACTIONS[ud.idleAction].dur;
    }
  }

  // 眨眼：每 2~5 秒一次，持续 140ms；被注意时眨得更"精神"（间隔略短）
  if (t > ud.blinkAt) {
    ud.blinkAt = t + (ud.attention > 0.5 ? 1.4 : 2) + Math.random() * 3;
    ud.blinkUntil = t + 0.14;
  }
  const blinkPhase = Math.max(0, Math.min(1, (ud.blinkUntil - t) / 0.14));
  const blink = Math.sin(blinkPhase * Math.PI);
  // 眯眼类表情（sleepy）本就该是眯的，别在闭眼上再叠
  const eyeOpen = pose.eye * (ud.attention > 0.5 ? 1 + 0.08 * ud.attention : 1);
  const eyeScaleY = Math.max(0.06, eyeOpen * (1 - blink * 0.92));

  // ---------- 呼吸 ----------
  const breath = Math.sin(t * 1.45) * 0.012;
  const squash = pose.squash + o.squash;
  P.body.scale.set(
    (FORM.bodyScale[0] - breath * 0.3) * squash,
    (FORM.bodyScale[1] + breath) * squash,
    (FORM.bodyScale[2] - breath * 0.2) * squash
  );
  P.tail.rotation.y = Math.sin(t * 1.1) * 0.08;

  // ---------- 头部 ----------
  let headPitch = pose.headPitch + o.headPitch + ud.lookPitch;
  let headTilt = pose.headTilt + o.headTilt + Math.sin(t * 0.9) * 0.02;
  let headYaw = ud.lookYaw + o.headYaw;
  if (ud.mood === "thinking") {
    headYaw += Math.sin(t * 1.8) * 0.035;
    headTilt += Math.sin(t * 1.8) * 0.02;
  } else if (ud.mood === "worried" || ud.mood === "sad") {
    headYaw += Math.sin(t * 1.4) * 0.045;
  } else if (ud.mood === "speaking") {
    headPitch += Math.sin(t * 4) * 0.016;
  } else if (ud.mood === "curious" || ud.mood === "listening") {
    headTilt += Math.sin(t * 0.7) * 0.03; // 歪着头听，慢一点显得在认真听
  }
  P.headGroup.position.y = FORM.headRestY + Math.sin(t * 1.45 + 0.6) * 0.025 - headPitch * 0.16;
  P.headGroup.rotation.set(headPitch, headYaw, headTilt);
  P.eyeL.scale.y = eyeScaleY;
  P.eyeR.scale.y = eyeScaleY;
  // 眼睛整体缩放：睁大眼（好奇/惊喜）会明显变精神，这是最省成本的"有生命力"
  const eyeXZ = Math.max(0.4, eyeOpen) * (1 + (1 - blink) * 0);
  P.eyeL.scale.x = eyeXZ;
  P.eyeR.scale.x = eyeXZ;

  // ---------- 眉毛 ----------
  const b = pose.brow + o.brow;
  P.browL.rotation.z = -0.55 * b;
  P.browR.rotation.z = 0.55 * b;
  P.browL.position.y = FORM.browY - 0.08 * Math.max(0, b);
  P.browR.position.y = FORM.browY - 0.08 * Math.max(0, b);
  P.browL.visible = P.browR.visible = Math.abs(b) > 0.085;

  // ---------- 嘴 ----------
  let mouthOpen = pose.mouth + o.mouth;
  if (ud.mood === "speaking") mouthOpen = 0.08 + Math.abs(Math.sin(t * 9)) * 0.42;
  P.mouth.visible = mouthOpen > 0.025;
  P.mouth.scale.set(0.9, Math.max(0.01, mouthOpen), 0.22);
  P.mouth.position.y = FORM.mouthY - mouthOpen * 0.035;
  // 微笑：眉毛下压（担心）时收敛，越开心越弯
  P.smile.scale.y = 1 - Math.max(0, pose.brow) * 0.16 + Math.max(0, mouthOpen) * 0.12;

  // ---------- 手臂 ----------
  let armLx = -pose.armL + o.armL;
  let armRx = -pose.armR + o.armR;
  let armLz = 0.18 + Math.sin(t * 1.2) * 0.015 + o.armLz;
  let armRz = 0.16 + Math.sin(t * 1.2 + 0.4) * 0.018 + o.armRz;
  if (ud.mood === "thinking") {
    // 挠头：抬起 + 前后小幅摩擦
    armRx += Math.sin(t * 2.4) * 0.035;
    armRz = -0.24 - Math.sin(t * 2.4) * 0.025;
  } else if (ud.mood === "working") {
    // 写字：手臂小幅往复
    armRx += Math.sin(t * 5.5) * 0.035;
    armLx += Math.sin(t * 5.5 + 0.3) * 0.012;
  } else if (ud.mood === "happy" || ud.mood === "excited") {
    armRz = -0.35 - Math.sin(t * 5) * 0.14;
  } else if (ud.mood === "shy") {
    armRx += Math.sin(t * 1.6) * 0.02;
  }
  P.armL.rotation.set(armLx, 0, armLz);
  P.armR.rotation.set(armRx, 0, armRz);

  // ---------- 腿：开心时收腿 + 动作带来的跳 ----------
  const jump = (ud.mood === "happy" || ud.mood === "excited" ? happyJump(t) : 0) + o.jump;
  const tuck = jump * 0.5 + o.tuck;
  P.legL.rotation.x = -tuck * 0.9;
  P.legR.rotation.x = -tuck * 0.75;
  P.footL.rotation.x = -tuck * 0.6;
  P.footR.rotation.x = -tuck * 0.5;
  P.rig.position.y = jump;
  // 重心轻移 + 左右晃：静止的熊猫也会"站不住"
  P.rig.position.x = (pose.lean + o.lean) * 0.5 + Math.sin(t * 0.55) * 0.02;
  P.rig.rotation.z = Math.sin(t * 1.1) * 0.005 + (pose.lean + o.lean) * 0.05;

  // ---------- 记事本 ----------
  P.padGroup.rotation.x = 0.15 + Math.max(0, pose.armL - 0.38) * 0.3;
  P.penGroup.visible = ud.mood === "working" || ud.mood === "thinking";

  // 翻页：thinking / working 时偶尔翻一页
  if (ud.mood === "working" || ud.mood === "thinking") {
    if (t > ud.pageUntil) ud.pageUntil = t + 1.6 + Math.random() * 1.6;
    const cycle = ud.pageUntil - t;
    const p = cycle > 1.1 ? 0 : Math.sin((1.1 - cycle) / 1.1 * Math.PI);
    P.pagePivot.rotation.y = -p * 0.4;
  } else {
    P.pagePivot.rotation.y *= Math.max(0, 1 - d * 6);
  }

  // 耳朵：起落（好奇竖起 / 难过耷拉）+ 随动作轻弹
  const ear = pose.ear + o.ear;
  const earBob = Math.sin(t * 2.1) * 0.018;
  P.earL.rotation.z = earBob - ear * 0.3;
  P.earR.rotation.z = -earBob + ear * 0.3;
  P.earL.position.y = 1.3 + ear * 0.07;
  P.earR.position.y = 1.3 + ear * 0.07;

  // ---------- 表情道具：按 mood / 动作淡入淡出 ----------
  updateProps(ud, P, t, d);
}

/** 空闲时自己找点事做（只在 idle/listening 且没被注意时触发）。 */
const IDLE_ACTIONS = ["tilt", "nod", "stretch", "hop", "shake"];

/** 表情道具的显隐与浮动。目标透明度按 mood 定，指数逼近避免"啪"地出现。 */
function updateProps(ud, P, t, d) {
  const mood = ud.mood;
  const target = {
    blushL: mood === "happy" || mood === "shy" || mood === "excited" || mood === "proud" ? 0.5 : mood === "sad" ? 0.18 : 0.2,
    blushR: 0,
    sweat: mood === "worried" || mood === "sad" ? 0.62 : 0,
    heartL: mood === "happy" || mood === "proud" ? 0.8 : 0,
    heartR: mood === "happy" || mood === "proud" ? 0.62 : 0,
    sparkL: mood === "excited" || mood === "proud" ? 0.85 : 0,
    sparkR: mood === "excited" || mood === "proud" ? 0.9 : 0,
    note: mood === "speaking" ? 0.5 : 0,
    zzz: mood === "sleepy" ? 0.85 : 0,
    question: mood === "curious" ? 0.8 : 0,
  };
  target.blushR = target.blushL;
  const props = ud.props;
  const k = Math.min(1, d * 3);
  const float = (name, sp, baseY, speed = 1.4, amp = 0.06) => {
    sp.material.opacity += (target[name] - sp.material.opacity) * k;
    sp.visible = sp.material.opacity > 0.01;
    if (!sp.visible) return;
    sp.position.y = baseY + Math.sin(t * speed + baseY * 3) * amp;
  };
  float("blushL", props.blushL, -0.5, 0.8, 0.01);
  float("blushR", props.blushR, -0.5, 0.8, 0.01);
  float("sweat", props.sweat, 0.62, 2.2, 0.09);
  float("heartL", props.heartL, 0.72, 1.8, 0.09);
  float("heartR", props.heartR, 0.86, 1.5, 0.11);
  float("sparkL", props.sparkL, 1.02, 2.6, 0.08);
  float("sparkR", props.sparkR, 1.16, 2.1, 0.1);
  float("note", props.note, 1.18, 2.4, 0.08);
  float("zzz", props.zzz, 1.24, 1.1, 0.13);
  float("question", props.question, 0.9, 1.6, 0.07);
  // 星星/爱心随呼吸缩放，别像贴纸一样死板
  const pulse = 1 + Math.sin(t * 2.4) * 0.07;
  if (props.sparkL.visible) props.sparkL.scale.setScalar(0.66 * (1 + Math.sin(t * 2.9) * 0.12));
  if (props.sparkR.visible) props.sparkR.scale.setScalar(0.84 * pulse);
  if (props.heartL.visible) props.heartL.scale.setScalar(0.62 * pulse);
  if (props.heartR.visible) props.heartR.scale.setScalar(0.5 * (1 + Math.sin(t * 2.1 + 1) * 0.09));
}

/** A small celebratory bounce, with a rest between gestures. */
function happyJump(t) {
  const p = t % 2.8;
  if (p > 0.8) return 0;
  return Math.pow(Math.sin((p / 0.8) * Math.PI), 2) * 0.24;
}

/** 三角面数统计（自检用）。 */
export function getFaceCount(group) {
  let tris = 0;
  if (!group || !group.traverse) return tris;
  group.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      const count = g.index ? g.index.count : g.attributes && g.attributes.position ? g.attributes.position.count : 0;
      tris += count / 3;
    }
  });
  return Math.round(tris);
}
