// web/panda3d.js —— 3D 低多边形熊猫管家
// 全部用 three.js 基础几何体拼装：没有模型文件、没有图片素材、没有版权问题。
// 三角面约 3 千面，投屏笔记本可跑满帧。
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
  white: 0xf7f9f4,
  belly: 0xe6ece4,
  black: 0x2e2c28,
  black2: 0x403c35,
  pink: 0xf0b6ac,
  bamboo: 0x4fbf7f,
  orange: 0xffb347,
  paper: 0xfdfbf3,
  book: 0x2f4a45,
  pen: 0xffd166,
};

// ---------- 姿势通道的目标值（mood -> pose） ----------
// arm*: 抬臂角度（正=向前抬）；headPitch: 正=低头；brow: 1=皱眉担心；mouth: 张嘴程度
const POSE = {
  idle: { armL: 0.05, armR: 0.05, headPitch: 0, headTilt: 0.04, brow: 0, mouth: 0.12, squash: 1 },
  thinking: { armL: 0.1, armR: 1.55, headPitch: -0.1, headTilt: 0.2, brow: 0.1, mouth: 0.06, squash: 1 },
  working: { armL: 1.02, armR: 1.2, headPitch: 0.34, headTilt: 0, brow: 0.05, mouth: 0.08, squash: 1.02 },
  happy: { armL: 2.3, armR: 2.3, headPitch: -0.18, headTilt: 0, brow: -0.12, mouth: 0.72, squash: 1 },
  worried: { armL: 0.22, armR: 0.24, headPitch: 0.14, headTilt: -0.06, brow: 0.8, mouth: 0.05, squash: 0.98 },
  speaking: { armL: 0.32, armR: 0.44, headPitch: -0.04, headTilt: 0.05, brow: -0.05, mouth: 0.45, squash: 1.01 },
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

  const mat = (color, o = {}) =>
    new t.MeshStandardMaterial({
      color,
      flatShading: o.flatShading === true,          // 默认圆滑高光面（商业质感）
      roughness: o.roughness == null ? 0.58 : o.roughness,
      metalness: o.metalness == null ? 0.04 : o.metalness,
      envMapIntensity: o.envMapIntensity == null ? 0.6 : o.envMapIntensity,
      emissive: o.emissive == null ? 0x000000 : o.emissive,
      emissiveIntensity: o.emissiveIntensity == null ? 0 : o.emissiveIntensity,
    });

  const M = {
    white: mat(C.white, { roughness: 0.52 }),
    belly: mat(C.belly, { roughness: 0.72 }),
    black: mat(C.black, { roughness: 0.5 }),
    black2: mat(C.black2, { roughness: 0.55 }),
    pink: mat(C.pink, { roughness: 0.85 }),
    bamboo: mat(C.bamboo, { roughness: 0.4, emissive: 0x0d3a24, emissiveIntensity: 0.8 }),
    paper: mat(C.paper, { roughness: 0.92 }),
    book: mat(C.book, { roughness: 0.62 }),
    pen: mat(C.pen, { roughness: 0.3, emissive: 0x4a3200, emissiveIntensity: 0.5 }),
  };

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
  const legGeo = new t.CapsuleGeometry(0.42, 0.5, 6, 16);
  const footGeo = new t.SphereGeometry(0.5, 20, 16);
  const legL = mk(legGeo, M.black, -0.78, 0.72, 0.05);
  const legR = mk(legGeo, M.black, 0.78, 0.72, 0.05);
  const footL = scale(mk(footGeo, M.black2, -0.78, 0.3, 0.32), 1, 0.72, 1.25);
  const footR = scale(mk(footGeo, M.black2, 0.78, 0.3, 0.32), 1, 0.72, 1.25);
  rig.add(legL, legR, footL, footR);

  // ---------- 身体 ----------
  const body = scale(mk(new t.SphereGeometry(2.05, 36, 26), M.white, 0, 2.72, 0), 1, 1.06, 0.9);
  const belly = scale(mk(new t.SphereGeometry(1.32, 24, 18), M.belly, 0, 2.5, 1.05), 1, 1.05, 0.42);
  const tail = scale(mk(new t.SphereGeometry(0.42, 16, 12), M.white, 0, 2.45, -1.92), 1, 0.9, 0.8);
  rig.add(body, belly, tail);

  // ---------- 手臂（group 原点=肩，方便绕肩旋转）----------
  const armGeo = new t.CapsuleGeometry(0.4, 1.15, 6, 16);
  const pawGeo = new t.SphereGeometry(0.44, 20, 16);
  const armL = new t.Group();
  armL.position.set(-1.82, 3.95, 0.05);
  armL.add(mk(armGeo, M.black, 0, -1.0, 0), mk(pawGeo, M.black2, 0, -1.92, 0.06));
  const armR = new t.Group();
  armR.position.set(1.82, 3.95, 0.05);
  armR.add(mk(armGeo, M.black, 0, -1.0, 0), mk(pawGeo, M.black2, 0, -1.92, 0.06));
  rig.add(armL, armR);

  // ---------- 头部（整体挂在 headGroup 上，低头/挠头一起动）----------
  const headGroup = new t.Group();
  headGroup.position.set(0, 5.15, 0);
  rig.add(headGroup);

  const head = scale(mk(new t.SphereGeometry(1.72, 36, 28), M.white, 0, 0.2, 0), 1, 0.98, 0.95);
  const earGeo = new t.SphereGeometry(0.62, 22, 16);
  const earInGeo = new t.SphereGeometry(0.3, 16, 12);
  const earL = mk(earGeo, M.black, -1.24, 1.42, -0.22);
  const earR = mk(earGeo, M.black, 1.24, 1.42, -0.22);
  const earInL = mk(earInGeo, M.black2, -1.24, 1.42, -0.02);
  const earInR = mk(earInGeo, M.black2, 1.24, 1.42, -0.02);
  const patchGeo = new t.SphereGeometry(0.5, 22, 16);
  const patchL = scale(mk(patchGeo, M.black, -0.66, 0.3, 1.44), 0.92, 1.22, 0.5);
  const patchR = scale(mk(patchGeo, M.black, 0.66, 0.3, 1.44), 0.92, 1.22, 0.5);
  const nose = scale(mk(new t.SphereGeometry(0.21, 16, 12), M.black, 0, -0.36, 1.66), 1.15, 0.85, 0.8);
  const cheekL = scale(mk(new t.SphereGeometry(0.3, 16, 12), M.pink, -1.02, -0.42, 1.3), 1, 0.7, 0.4);
  const cheekR = scale(mk(new t.SphereGeometry(0.3, 16, 12), M.pink, 1.02, -0.42, 1.3), 1, 0.7, 0.4);

  // 眼睛（group 用于眨眼：压扁 y）
  const eyeWhiteGeo = new t.SphereGeometry(0.2, 16, 12);
  const pupilGeo = new t.SphereGeometry(0.115, 14, 10);
  const sparkGeo = new t.SphereGeometry(0.045, 8, 6);
  const sparkMat = mat(0xffffff, { flatShading: false, roughness: 0.2, emissive: 0x666666, emissiveIntensity: 0.3 });
  const eyeL = new t.Group();
  eyeL.position.set(-0.68, 0.33, 1.68);
  eyeL.add(mk(eyeWhiteGeo, M.white, 0, 0, 0), mk(pupilGeo, M.black, 0.02, -0.02, 0.12), mk(sparkGeo, sparkMat, 0.06, 0.06, 0.16));
  const eyeR = new t.Group();
  eyeR.position.set(0.68, 0.33, 1.68);
  eyeR.add(mk(eyeWhiteGeo, M.white, 0, 0, 0), mk(pupilGeo, M.black, -0.02, -0.02, 0.12), mk(sparkGeo, sparkMat, -0.06, 0.06, 0.16));

  // 嘴：压扁的球，说话时 y 拉伸 = 开合
  const mouth = scale(mk(new t.SphereGeometry(0.3, 9, 7), M.black2, 0, -0.76, 1.42), 1, 0.36, 0.5);

  // 眉毛（担心时向内下压）
  const browGeo = new t.BoxGeometry(0.58, 0.1, 0.12);
  const browL = new t.Group();
  browL.position.set(-0.66, 0.86, 1.5);
  browL.add(mk(browGeo, M.black, 0, 0, 0));
  const browR = new t.Group();
  browR.position.set(0.66, 0.86, 1.5);
  browR.add(mk(browGeo, M.black, 0, 0, 0));

  headGroup.add(head, earL, earR, earInL, earInR, patchL, patchR, nose, cheekL, cheekR, eyeL, eyeR, mouth, browL, browR);

  // ---------- 领结（管家道具）----------
  const bowGeo = new t.ConeGeometry(0.4, 0.78, 4);
  const bowL = mk(bowGeo, M.bamboo, -0.42, 4.28, 1.42);
  bowL.rotation.set(0, 0, Math.PI / 2);
  const bowR = mk(bowGeo, M.bamboo, 0.42, 4.28, 1.42);
  bowR.rotation.set(0, 0, -Math.PI / 2);
  const bowC = mk(new t.SphereGeometry(0.17, 8, 6), M.pen, 0, 4.28, 1.46);
  rig.add(bowL, bowR, bowC);

  // ---------- 记事本（管家招牌）----------
  const padGroup = new t.Group();
  padGroup.position.set(0, 2.62, 1.95);
  padGroup.rotation.x = -0.42;
  const cover = mk(new t.BoxGeometry(1.62, 0.16, 1.16), M.book, 0, -0.1, 0);
  const pages = mk(new t.BoxGeometry(1.44, 0.22, 1.0), M.paper, 0, 0.06, 0);
  const spine = mk(new t.CylinderGeometry(0.1, 0.1, 1.16, 8), M.bamboo, -0.84, 0.02, 0);
  spine.rotation.z = Math.PI / 2;
  spine.rotation.y = Math.PI / 2;
  // 翻页：页面绕左侧书脊旋转
  const pagePivot = new t.Group();
  pagePivot.position.set(-0.72, 0.2, 0);
  const page = mk(new t.BoxGeometry(1.4, 0.03, 0.96), M.paper, 0.7, 0, 0);
  pagePivot.add(page);
  // 笔（握在右手，写字时随手臂动）
  const penGroup = new t.Group();
  penGroup.position.set(-0.1, -1.85, 0.28);
  penGroup.rotation.set(0.9, 0, 0.25);
  penGroup.add(mk(new t.CylinderGeometry(0.06, 0.06, 1.0, 6), M.pen, 0, 0, 0));
  const tip = mk(new t.ConeGeometry(0.07, 0.22, 6), M.black2, 0, -0.6, 0);
  tip.rotation.x = Math.PI;
  penGroup.add(tip);
  armR.add(penGroup);

  padGroup.add(cover, pages, spine, pagePivot);
  rig.add(padGroup);

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
    parts: {
      rig, body, belly, tail, armL, armR, legL, legR, footL, footR,
      headGroup, head, earL, earR, eyeL, eyeR, mouth, browL, browR, padGroup, pagePivot, penGroup,
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
  const blinking = t < ud.blinkUntil;
  const eyeScaleY = blinking ? 0.12 : 1;

  // ---------- 呼吸 ----------
  const breath = Math.sin(t * 1.7) * (ud.mood === "happy" ? 0.014 : 0.035);
  P.body.scale.set((1 - breath * 0.5) * pose.squash, (1 + breath) * pose.squash, (0.9 - breath * 0.4) * pose.squash);
  P.belly.scale.set(1 - breath * 0.3, 1.05 + breath * 0.5, 0.42);
  P.tail.rotation.y = Math.sin(t * 1.1) * 0.25;

  // ---------- 头部 ----------
  let headPitch = pose.headPitch;
  let headTilt = pose.headTilt + Math.sin(t * 0.9) * 0.02;
  let headYaw = 0;
  if (ud.mood === "thinking") {
    headYaw = Math.sin(t * 5.2) * 0.06; // 挠头时小幅度晃
    headTilt += Math.sin(t * 5.2) * 0.04;
  } else if (ud.mood === "worried") {
    headYaw = Math.sin(t * 2.4) * 0.1; // 担心：轻微摇头
  } else if (ud.mood === "speaking") {
    headPitch += Math.sin(t * 6) * 0.02;
  }
  P.headGroup.position.y = 5.15 + Math.sin(t * 1.7 + 0.6) * 0.055 - (ud.mood === "working" ? 0.1 : 0);
  P.headGroup.rotation.set(headPitch, ud.lookYaw + headYaw, headTilt);
  P.eyeL.scale.y = eyeScaleY;
  P.eyeR.scale.y = eyeScaleY;

  // ---------- 眉毛 ----------
  const b = pose.brow;
  P.browL.rotation.z = -0.55 * b;
  P.browR.rotation.z = 0.55 * b;
  P.browL.position.y = 0.86 - 0.1 * Math.max(0, b);
  P.browR.position.y = 0.86 - 0.1 * Math.max(0, b);

  // ---------- 嘴 ----------
  let mouthOpen = pose.mouth;
  if (ud.mood === "speaking") mouthOpen = 0.18 + Math.abs(Math.sin(t * 13)) * 0.85;
  P.mouth.scale.set(1, 0.34 + mouthOpen * 0.95, 0.5);
  P.mouth.position.y = -0.76 - mouthOpen * 0.06;

  // ---------- 手臂 ----------
  let armLx = -pose.armL;
  let armRx = -pose.armR;
  let armLz = 0.14 + Math.sin(t * 1.2) * 0.03;
  let armRz = -0.14 - Math.sin(t * 1.2 + 0.4) * 0.03;
  if (ud.mood === "thinking") {
    // 挠头：抬起 + 前后小幅摩擦
    armRx = -1.55 + Math.sin(t * 6) * 0.12;
    armRz = -0.34 - Math.sin(t * 6) * 0.1;
  } else if (ud.mood === "working") {
    // 写字：手臂小幅往复
    armRx = -1.2 + Math.sin(t * 7.5) * 0.07;
    armLx = -1.02 + Math.sin(t * 7.5 + 0.3) * 0.03;
  } else if (ud.mood === "happy") {
    armLz = 0.5 + Math.sin(t * 9) * 0.28;
    armRz = -0.5 - Math.sin(t * 9 + 0.5) * 0.28;
  }
  // 挥手（点击熊猫）
  if (t < ud.waveUntil) {
    const p = 1 - (ud.waveUntil - t) / 1.6;
    const env = Math.sin(Math.min(1, p * 1.15) * Math.PI); // 起落包络
    armRx = -2.35;
    armRz = -0.4 - Math.sin(t * 16) * 0.55 * env;
  }
  P.armL.rotation.set(armLx, 0, armLz);
  P.armR.rotation.set(armRx, 0, armRz);

  // ---------- 腿：happy 时收腿 ----------
  const jump = ud.mood === "happy" ? happyJump(t) : 0;
  const tuck = jump > 0.05 ? 0.9 : 0;
  P.legL.rotation.x = -tuck * 0.9;
  P.legR.rotation.x = -tuck * 0.75;
  P.footL.rotation.x = -tuck * 0.6;
  P.footR.rotation.x = -tuck * 0.5;
  P.rig.position.y = jump;
  P.rig.rotation.z = Math.sin(t * 1.3) * 0.008;

  // ---------- 记事本 ----------
  let padTilt = 0;
  if (ud.mood === "working") {
    padTilt = 0.16 + Math.sin(t * 3.4) * 0.05;
    P.padGroup.position.y = 2.74;
  } else if (ud.mood === "thinking") {
    padTilt = 0.1 + Math.sin(t * 1.6) * 0.06;
    P.padGroup.position.y = 2.66;
  } else {
    P.padGroup.position.y = 2.62 + Math.sin(t * 1.7) * 0.03;
  }
  P.padGroup.rotation.x = -0.42 + padTilt;

  // 翻页：thinking / working 时偶尔翻一页
  if (ud.mood === "working" || ud.mood === "thinking") {
    if (t > ud.pageUntil) ud.pageUntil = t + 1.6 + Math.random() * 1.6;
    const cycle = ud.pageUntil - t;
    const p = cycle > 1.1 ? 0 : Math.min(1, (1.1 - cycle) / 0.55);
    P.pagePivot.rotation.z = -p * 2.5;
  } else {
    P.pagePivot.rotation.z *= Math.max(0, 1 - d * 6);
  }

  // 耳朵随动作轻弹
  const earBob = Math.sin(t * 3.1) * 0.05;
  P.earL.rotation.z = earBob;
  P.earR.rotation.z = -earBob;
}

/** happy 的跳跃曲线：1.6 秒一轮，前 0.55 秒腾空。 */
function happyJump(t) {
  const p = t % 1.6;
  if (p > 0.62) return 0;
  return Math.max(0, Math.sin((p / 0.62) * Math.PI)) * 1.5;
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
