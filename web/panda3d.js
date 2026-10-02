// Procedural felt panda: soft sculpture, woven accessories and quiet gestures.
// Geometry and fabric textures are generated locally; no remote assets required.
//
// 对外 API（scene3d.js 调用）：
//   useThree(THREE)            注入 three 模块（避免二次加载 CDN）
//   createPanda(THREE?)        -> THREE.Group；动画只改内部 rig，root.position 留给场景摆放
//   setPandaMood(group, mood)  idle | thinking | working | happy | worried | speaking
//   updatePanda(group, dt)     每帧推进动画（由 scene3d 的 rAF 调用）
//   triggerWave(group)         挥手 1.6 秒（点击熊猫时用）
//   getFaceCount(group)        三角面数统计（自检用）

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
  white: 0xf2eee5,
  black: 0x242a2c,
  black2: 0x303936,
  pink: 0xc99187,
  bamboo: 0x779e93,
  paper: 0xf5eddc,
  book: 0x426a61,
  pen: 0xc49a60,
};

const FORM = {
  headRadius: 1.68, headScale: [1.13, 0.92, 0.94], headCenterY: 0.15, headRestY: 4.3,
  bodyRadius: 1.55, bodyScale: [0.98, 0.98, 0.86], bodyRestY: 2.06,
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

function headGeometry(t) {
  const geometry = new t.SphereGeometry(FORM.headRadius, 64, 48);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / FORM.headRadius;
    const cheek = 1 + 0.13 * Math.exp(-Math.pow((y + 0.26) * 2.4, 2));
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
  const cheek = 1 + 0.13 * Math.exp(-Math.pow((ny + 0.26) * 2.4, 2));
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
    const highlight = (1 - smooth(0.6, 1, Math.hypot((dx + 0.28) / 0.2, (dy - 0.3) / 0.17))) * 0.96;
    const secondary = (1 - smooth(0.4, 1, Math.hypot((dx - 0.3) / 0.085, (dy + 0.3) / 0.085))) * 0.5;
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
    p.setXYZ(i, x * 0.255, y * 0.225, 0.062 * Math.sqrt(Math.max(0, 1 - x * x - y * y)));
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

// ---------- 姿势通道的目标值（mood -> pose） ----------
// arm*: 抬臂角度（正=向前抬）；headPitch: 正=低头；brow: 1=皱眉担心；mouth: 张嘴程度
const POSE = {
  idle: { armL: 0.38, armR: 0.2, headPitch: -0.025, headTilt: -0.055, brow: 0, mouth: 0, squash: 1 },
  thinking: { armL: 0.4, armR: 1.38, headPitch: -0.06, headTilt: 0.12, brow: 0.12, mouth: 0, squash: 1 },
  working: { armL: 0.68, armR: 0.95, headPitch: 0.18, headTilt: -0.04, brow: 0.04, mouth: 0, squash: 1 },
  happy: { armL: 0.45, armR: 2.1, headPitch: -0.1, headTilt: -0.07, brow: -0.1, mouth: 0.38, squash: 1 },
  worried: { armL: 0.34, armR: 0.28, headPitch: 0.1, headTilt: -0.06, brow: 0.65, mouth: 0.04, squash: 0.99 },
  speaking: { armL: 0.36, armR: 0.48, headPitch: -0.025, headTilt: 0.04, brow: -0.04, mouth: 0.25, squash: 1 },
};

export const PANDA_MOODS = ["idle", "thinking", "working", "happy", "worried", "speaking"];

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
    pink: mat(C.pink, { map: blush, bumpMap: null, sheen: 0, transparent: true, opacity: 0.55, depthWrite: false }),
    muzzle: mat(0xd8c9b2, { map: blush, bumpMap: null, sheen: 0, transparent: true, opacity: 0.5, depthWrite: false }),
    bamboo: mat(C.bamboo, { bumpScale: 0.035 }),
    paper: mat(C.paper, { sheen: 0, bumpScale: 0.009 }),
    book: mat(C.book, { bumpScale: 0.028 }),
    pen: mat(C.pen, { roughness: 0.7, sheen: 0, bumpScale: 0.01 }),
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
  const armGeo = new t.CapsuleGeometry(0.39, 0.6, 8, 24);
  const pawGeo = new t.SphereGeometry(0.42, 24, 18);
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
  const earGeo = new t.SphereGeometry(0.52, 28, 22);
  const earInGeo = new t.SphereGeometry(0.25, 24, 16);
  const earL = scale(mk(earGeo, M.black, -1.35, 1.26, -0.17), 1, 1.02, 0.7);
  const earR = scale(mk(earGeo, M.black, 1.35, 1.26, -0.17), 1, 1.02, 0.7);
  const earInL = scale(mk(earInGeo, M.black2, 0, 0.015, 0.5), 1, 1, 0.18);
  const earInR = scale(mk(earInGeo, M.black2, 0, 0.015, 0.5), 1, 1, 0.18);
  earInL.castShadow = earInR.castShadow = false;
  earL.add(earInL);
  earR.add(earInR);
  const patchL = mk(facePatch(t, -0.8, -0.05, 0.4, 0.5, -0.55, 0.028, 0.26), M.black);
  const patchR = mk(facePatch(t, 0.8, -0.05, 0.4, 0.5, 0.55, 0.028, 0.26), M.black);
  const noseShape = new t.Shape();
  noseShape.moveTo(-0.18, 0.055);
  noseShape.quadraticCurveTo(0, 0.16, 0.18, 0.055);
  noseShape.quadraticCurveTo(0.19, -0.015, 0.035, -0.12);
  noseShape.quadraticCurveTo(0, -0.14, -0.035, -0.12);
  noseShape.quadraticCurveTo(-0.19, -0.015, -0.18, 0.055);
  const nose = scale(mk(new t.ExtrudeGeometry(noseShape, { depth: 0.029, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 3, steps: 1, curveSegments: 16 }), M.nose, 0, -0.33, faceDepth(0, -0.33) + 0.008), 0.8, 0.8, 0.8);
  const muzzlePatch = mk(facePatch(t, 0, -0.5, 0.5, 0.36, 0, 0.022), M.muzzle);
  muzzlePatch.castShadow = false;
  const cheekL = mk(facePatch(t, -1.0, -0.66, 0.22, 0.13, 0.25, 0.03), M.pink);
  const cheekR = mk(facePatch(t, 1.0, -0.66, 0.22, 0.13, -0.25, 0.03), M.pink);
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
  const arc = side => curveMesh(t, [[0, -0.585], [side * 0.05, -0.64], [side * 0.14, -0.645], [side * 0.22, -0.585]].map(([x, y]) => [x, y, faceDepth(x, y) + 0.018]), 0.0155, M.nose);
  const smile = new t.Group();
  smile.add(arc(-1), arc(1));
  const philtrum = curveMesh(t, [[0, -0.43, faceDepth(0, -0.43) + 0.032], [0, -0.51, faceDepth(0, -0.51) + 0.022], [0, -0.585, faceDepth(0, -0.585) + 0.018]], 0.0125, M.nose);

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

  root.scale.setScalar(s);
  root.userData = {
    panda: true,
    rig,
    mood: "idle",
    pose: { ...POSE.idle },
    t: 0,
    lookYaw: 0,
    blinkAt: 1.6 + Math.random() * 2.4,
    blinkUntil: -1,
    waveUntil: -1,
    pageUntil: -1,
    textures: [fabric, blush, fur.color, fur.normal, ...eyeMaps],
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
 * @param {string} mood idle|thinking|working|happy|worried|speaking
 */
export function setPandaMood(group, mood) {
  if (!group || !group.userData || !group.userData.panda) return;
  const m = POSE[mood] ? mood : "idle";
  group.userData.mood = m;
  if (m === "thinking") group.userData.pageUntil = group.userData.t + 1.2;
  if (m === "happy") group.userData.waveUntil = -1; // 跳一下优先
}

/** 点击熊猫时挥手。 */
export function triggerWave(group) {
  if (!group || !group.userData || !group.userData.panda) return;
  group.userData.waveUntil = group.userData.t + 1.6;
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

  // 眨眼：每 2~5 秒一次，持续 140ms
  if (t > ud.blinkAt) {
    ud.blinkAt = t + 2 + Math.random() * 3;
    ud.blinkUntil = t + 0.14;
  }
  const blinkPhase = Math.max(0, Math.min(1, (ud.blinkUntil - t) / 0.14));
  const eyeScaleY = 1 - Math.sin(blinkPhase * Math.PI) * 0.92;

  // ---------- 呼吸 ----------
  const breath = Math.sin(t * 1.45) * 0.012;
  P.body.scale.set((FORM.bodyScale[0] - breath * 0.3) * pose.squash, (FORM.bodyScale[1] + breath) * pose.squash, (FORM.bodyScale[2] - breath * 0.2) * pose.squash);
  P.tail.rotation.y = Math.sin(t * 1.1) * 0.08;

  // ---------- 头部 ----------
  let headPitch = pose.headPitch;
  let headTilt = pose.headTilt + Math.sin(t * 0.9) * 0.02;
  let headYaw = 0;
  if (ud.mood === "thinking") {
    headYaw = Math.sin(t * 1.8) * 0.035;
    headTilt += Math.sin(t * 1.8) * 0.02;
  } else if (ud.mood === "worried") {
    headYaw = Math.sin(t * 1.8) * 0.045;
  } else if (ud.mood === "speaking") {
    headPitch += Math.sin(t * 4) * 0.016;
  }
  P.headGroup.position.y = FORM.headRestY + Math.sin(t * 1.45 + 0.6) * 0.025 - pose.headPitch * 0.16;
  P.headGroup.rotation.set(headPitch, ud.lookYaw + headYaw, headTilt);
  P.eyeL.scale.y = eyeScaleY;
  P.eyeR.scale.y = eyeScaleY;

  // ---------- 眉毛 ----------
  const b = pose.brow;
  P.browL.rotation.z = -0.55 * b;
  P.browR.rotation.z = 0.55 * b;
  P.browL.position.y = FORM.browY - 0.08 * Math.max(0, b);
  P.browR.position.y = FORM.browY - 0.08 * Math.max(0, b);
  P.browL.visible = P.browR.visible = Math.abs(b) > 0.085;

  // ---------- 嘴 ----------
  let mouthOpen = pose.mouth;
  if (ud.mood === "speaking") mouthOpen = 0.08 + Math.abs(Math.sin(t * 9)) * 0.42;
  P.mouth.visible = mouthOpen > 0.025;
  P.mouth.scale.set(0.9, Math.max(0.01, mouthOpen), 0.22);
  P.mouth.position.y = FORM.mouthY - mouthOpen * 0.035;
  P.smile.scale.y = 1 - Math.max(0, pose.brow) * 0.16;

  // ---------- 手臂 ----------
  let armLx = -pose.armL;
  let armRx = -pose.armR;
  let armLz = 0.18 + Math.sin(t * 1.2) * 0.015;
  let armRz = 0.16 + Math.sin(t * 1.2 + 0.4) * 0.018;
  if (ud.mood === "thinking") {
    // 挠头：抬起 + 前后小幅摩擦
    armRx += Math.sin(t * 2.4) * 0.035;
    armRz = -0.24 - Math.sin(t * 2.4) * 0.025;
  } else if (ud.mood === "working") {
    // 写字：手臂小幅往复
    armRx += Math.sin(t * 5.5) * 0.035;
    armLx += Math.sin(t * 5.5 + 0.3) * 0.012;
  } else if (ud.mood === "happy") {
    armRz = -0.35 - Math.sin(t * 5) * 0.14;
  }
  // 挥手（点击熊猫）
  if (t < ud.waveUntil) {
    const p = 1 - (ud.waveUntil - t) / 1.6;
    const env = Math.pow(Math.sin(p * Math.PI), 0.65);
    armRx += (-2.25 - armRx) * env;
    armRz += (-0.48 - armRz - Math.sin(t * 10) * 0.22) * env;
  }
  P.armL.rotation.set(armLx, 0, armLz);
  P.armR.rotation.set(armRx, 0, armRz);

  // ---------- 腿：happy 时收腿 ----------
  const jump = ud.mood === "happy" ? happyJump(t) : 0;
  const tuck = jump * 0.5;
  P.legL.rotation.x = -tuck * 0.9;
  P.legR.rotation.x = -tuck * 0.75;
  P.footL.rotation.x = -tuck * 0.6;
  P.footR.rotation.x = -tuck * 0.5;
  P.rig.position.y = jump;
  P.rig.rotation.z = Math.sin(t * 1.1) * 0.005;

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

  // 耳朵随动作轻弹
  const earBob = Math.sin(t * 2.1) * 0.018;
  P.earL.rotation.z = earBob;
  P.earR.rotation.z = -earBob;
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
