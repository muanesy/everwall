/* ==========================================================
 * 槽位正式模型（乙负责）
 *
 * 对应 docs/美术需求-槽位与技能.md 里的「P1 六个槽位」。
 *
 * 设计原则（按文档「槽位等级外观（1-5 级，新标准）」来）：
 *   1. 每个槽位按等级换主体轮廓，不是只放大
 *   2. 时代决定家族语言（投石机 / 列车炮 / 履带炮 / 培养罐 / 能量环 / 黑球）
 *   3. 等级决定结构：发射件数量、舱体数量、塔架层数、环的数量
 *   4. 全程序化几何体，零外部素材
 *
 * 30 个等级外形是「6 个槽位 × 5 级」的等级基础体；
 * 同一等级在不同时代换材质和时代附件，不重雕 180 个模型。
 * ========================================================== */

import * as THREE from 'three';
import { GLTFLoader } from '../assets/vendor/loaders/GLTFLoader.js';

/* ----------------------------------------------------------
 * 攻城 1 级的正式模型：Poly by Google「Catapult」，CC-BY 3.0
 * （署名见开始页底部小字）。只加载一次，之后每个槽位 clone 一份。
 *
 * 只给 1 级用：2-5 级要求独立轮廓（双联抛臂 / 带轮底盘 / 攻城塔），
 * 单个投石机 GLB 表达不了这些升级，所以高等级走程序化结构。
 * 加载失败就静默返回 null，走程序化兜底，槽位不会消失。
 * ---------------------------------------------------------- */
let siegeModelPromise = null;

function loadSiegeModel() {
  if (!siegeModelPromise) {
    const loader = new GLTFLoader();
    siegeModelPromise = new Promise((resolve) => {
      loader.load(
        new URL('../assets/models/b-slot-siege-0.glb', import.meta.url).href,
        (gltf) => resolve(gltf.scene),
        undefined,
        () => resolve(null),
      );
    });
  }
  return siegeModelPromise;
}

/* 把模型缩到槽位占位内（宽 ≥ 深取大的一边），脚底对齐 y=0，中心对齐原点 */
function fitSlotModel(obj, maxW, maxH) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = Math.min(
    maxW / Math.max(size.x, 1e-4),
    maxW / Math.max(size.z, 1e-4),
    maxH / Math.max(size.y, 1e-4),
  );
  obj.scale.setScalar(s);
  box.setFromObject(obj);
  const c = new THREE.Vector3();
  box.getCenter(c);
  obj.position.x -= c.x;
  obj.position.z -= c.z;
  obj.position.y -= box.min.y;
}

/* ----------------------------------------------------------
 * 时代美术基调
 *
 * 每个时代一套材质语言：中世纪是木头（粗糙、不反光、无发光），
 * 星际是金属+青蓝发光，终幕是近黑+橙红内发光。
 * 只改这三样（颜色、金属度、发光），六时代就能一眼分开。
 * ---------------------------------------------------------- */
const ERA_LOOK = [
  { // 0 中世纪：木架 + 麻绳
    main: 0x8a6a3c, accent: 0x5c4126, metal: 0.04, rough: 0.92,
    glow: 0x000000, glowI: 0,
  },
  { // 1 二战：军绿铁皮 + 少量黄铜
    main: 0x6b7360, accent: 0x4a5240, metal: 0.34, rough: 0.72,
    glow: 0x000000, glowI: 0,
  },
  { // 2 现代：橄榄灰装甲 + 微弱电子绿
    main: 0x8f9a7a, accent: 0x5a6350, metal: 0.5, rough: 0.55,
    glow: 0x2e6b52, glowI: 0.25,
  },
  { // 3 后现代：紫灰血肉金属 + 紫色生物光
    main: 0x7a5a86, accent: 0x4a3054, metal: 0.28, rough: 0.5,
    glow: 0x7a3a9c, glowI: 0.6,
  },
  { // 4 星际：冷青金属 + 青蓝能量
    main: 0x4a6a8a, accent: 0x2a3a4a, metal: 0.72, rough: 0.32,
    glow: 0x2a9ad0, glowI: 1.0,
  },
  { // 5 终幕：近黑 + 橙红内爆光
    main: 0x2a2028, accent: 0x160e12, metal: 0.62, rough: 0.38,
    glow: 0xff5a2a, glowI: 1.2,
  },
];

const ERA_COUNT = ERA_LOOK.length;

function clampEra(era) {
  const n = Math.floor(Number(era));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(ERA_COUNT - 1, n));
}

function clampLevel(level) {
  const n = Math.floor(Number(level));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, n));
}

/* 材质工厂：每个槽位实例独立持有材质，方便以后单独改色/单独淡出 */
function makeMats(eraId) {
  const look = ERA_LOOK[clampEra(eraId)];
  return {
    look,
    main: new THREE.MeshStandardMaterial({
      color: look.main, roughness: look.rough, metalness: look.metal,
      emissive: look.glow, emissiveIntensity: look.glowI * 0.35,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: look.accent, roughness: Math.min(0.95, look.rough + 0.08),
      metalness: look.metal * 0.7,
    }),
    glow: new THREE.MeshBasicMaterial({ color: look.glow }),
    glowSoft: new THREE.MeshBasicMaterial({
      color: look.glow, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1e242c, roughness: 0.85 }),
  };
}

/* 摆一个零件，省掉每处都写 position/rotation 的样板代码 */
function add(group, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  group.add(mesh);
  return mesh;
}

/* ----------------------------------------------------------
 * 通用等级零件
 * ---------------------------------------------------------- */

/* 水平发光环。外面包一层 Group 让"转环"绕 y 轴转，
 * 直接转 torus 因为对称看不出在转。 */
function spinRing(g, m, radius, y, tube = 0.032, tilt = 0) {
  const holder = new THREE.Group();
  holder.position.y = y;
  holder.userData.spinY = true;
  holder.userData.spinSpeed = 0.7;
  add(holder, new THREE.TorusGeometry(radius, tube, 6, 26), m.glow,
    0, 0, 0, Math.PI / 2 + tilt, 0, 0);
  g.add(holder);
  return holder;
}

/* 可旋转炮塔：lv >= 4 才转，低等级保持静止（文档要求） */
function turret(g, m, y, lv, spinSpeed = 0.4) {
  const t = new THREE.Group();
  t.position.y = y;
  if (lv >= 4) {
    t.userData.spinY = true;
    t.userData.spinSpeed = spinSpeed;
  }
  g.add(t);
  return t;
}

/* 一排横向位置：n 个零件居中排开 */
function spreadX(n, spacing) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((i - (n - 1) / 2) * spacing);
  return out;
}

/* 车轮：lv >= 4 的底盘用 */
function addWheels(g, m, halfW, zOff, r = 0.13) {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(g, new THREE.CylinderGeometry(r, r, 0.07, 10), m.accent,
        sx * halfW, r, sz * zOff, 0, 0, Math.PI / 2);
    }
  }
}

/* ----------------------------------------------------------
 * 攻城：投石机 → 列车炮 → 履带炮 → 生物喷射罐 → 轨道炮 → 引力炮
 *
 * 等级轮廓：
 *   1 单管/短臂 · 2 加长加固 · 3 双联 · 4 带底盘 · 5 多联装/塔架
 * ---------------------------------------------------------- */
function buildSiege(g, m, era, lv = 1) {
  if (era === 0) {
    // 1 级用正式 GLB；2-5 级走程序化，保证"双联/带轮/攻城塔"能读出来
    const base = new THREE.Group();
    g.add(base);

    const twin = lv >= 3;                       // 3 级起双联抛臂
    const wheeled = lv >= 4;                    // 4 级起带轮底盘
    const armLen = 0.78 + (lv - 1) * 0.12;      // 0.78 → 1.26
    const pivotY = 0.74 + (lv - 1) * 0.04;      // 0.74 → 0.90
    const legH = pivotY + 0.1;

    if (wheeled) {
      add(base, new THREE.BoxGeometry(1.0, 0.12, 0.72), m.dark, 0, 0.2, 0);
      addWheels(base, m, 0.4, 0.26, 0.13);
    } else {
      add(base, new THREE.BoxGeometry(0.96, 0.14, 0.64), m.main, 0, 0.07, 0);
    }

    if (twin) {
      add(base, new THREE.TorusGeometry(0.33, 0.028, 6, 20), m.accent,
        0, wheeled ? 0.27 : 0.15, 0, Math.PI / 2, 0, 0);
    }

    // 2 级起加 A 形加固斜撑
    if (lv >= 2) {
      const baseY = wheeled ? 0.26 : 0.14;
      for (const sx of [-1, 1]) {
        add(base, new THREE.BoxGeometry(0.06, 0.7, 0.06), m.accent,
          sx * 0.42, baseY + 0.3, 0.25, 0.35, 0, -sx * 0.3);
      }
    }

    const baseY = wheeled ? 0.26 : 0.14;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        add(base, new THREE.BoxGeometry(0.07, legH, 0.07), m.main,
          sx * 0.32, baseY + legH * 0.5, sz * 0.17,
          sz * 0.22, 0, -sx * 0.16);
      }
    }
    add(base, new THREE.BoxGeometry(0.74, 0.06, 0.06), m.main, 0, baseY + legH, 0);

    // 横轴 + 抛臂。抛臂整体挂在一个 Group 上，后坐动画不会把轴带歪
    const armGroup = new THREE.Group();
    armGroup.position.set(0, baseY + pivotY, 0);
    armGroup.rotation.x = -0.3;                 // 长臂朝 -z 抬起
    const armOffsets = twin ? [-0.1, 0.1] : [0];
    for (const ox of armOffsets) {
      add(armGroup, new THREE.BoxGeometry(0.07, 0.07, armLen), m.accent,
        ox, 0, -armLen * 0.12);
      add(armGroup, new THREE.BoxGeometry(0.22, 0.22, 0.2), m.dark,
        ox, -0.18, armLen * 0.32);
      add(armGroup, new THREE.SphereGeometry(0.075, 8, 6), m.dark,
        ox, 0.02, -armLen * 0.62);
    }
    base.add(armGroup);

    // 4 级：侧面弹药箱
    if (lv >= 4) {
      for (let i = 0; i < 3; i++) {
        add(base, new THREE.BoxGeometry(0.16, 0.12, 0.2), m.accent,
          -0.52, 0.3 + i * 0.14, -0.1);
      }
    }

    // 5 级：顶部塔架 + 充电环，远处看是"攻城塔"而不是放大版投石机
    if (lv >= 5) {
      for (const sx of [-1, 1]) {
        add(base, new THREE.BoxGeometry(0.06, 0.56, 0.06), m.main,
          sx * 0.36, baseY + legH + 0.26, 0.16, 0, 0, -sx * 0.06);
      }
      add(base, new THREE.BoxGeometry(0.8, 0.06, 0.34), m.accent,
        0, baseY + legH + 0.56, 0.16);
      const r = add(base, new THREE.TorusGeometry(0.5, 0.03, 6, 24), m.glow,
        0, 0.12, 0, Math.PI / 2, 0, 0);
      r.userData.spinY = true;
    }

    if (lv === 1) {
      loadSiegeModel().then((src) => {
        if (!src) return;
        const model = src.clone(true);
        // 1.04 已接近地基上沿（半径 0.85，四角仍落在圈内），比原来的 0.86 大约 21%
        fitSlotModel(model, 1.04, 1.45);
        base.visible = false;
        g.add(model);
      });
    }
    return;
  }

  if (era === 1) {
    // 二战列车炮：车厢 + 长炮管，升级加长、双联、带轮、四联
    add(g, new THREE.BoxGeometry(0.9, 0.42, 1.15), m.main, 0, 0.27, 0);
    const barrels = lv >= 5 ? 4 : lv >= 3 ? 2 : 1;
    const len = 0.9 + lv * 0.12;
    const xs = spreadX(barrels, 0.17);
    const t = turret(g, m, 0.5, lv, 0.32);
    for (const x of xs) {
      add(t, new THREE.CylinderGeometry(0.075, 0.095, len, 10), m.accent,
        x, 0, -len * 0.42, Math.PI / 2 - 0.1, 0, 0);
    }
    if (lv >= 2) {
      // 加固炮架 / 侧面装甲
      for (const sx of [-1, 1]) {
        add(g, new THREE.BoxGeometry(0.05, 0.3, 0.8), m.accent,
          sx * 0.46, 0.42, 0.1);
      }
    }
    if (lv >= 4) {
      addWheels(g, m, 0.46, 0.34, 0.17);
      // 驻锄：前方两根液压腿
      for (const sx of [-1, 1]) {
        add(g, new THREE.BoxGeometry(0.06, 0.5, 0.06), m.dark,
          sx * 0.32, 0.22, 0.5, 0.5, 0, 0);
      }
    }
    if (lv >= 5) {
      add(g, new THREE.BoxGeometry(0.34, 0.12, 0.3), m.dark, 0, 1.0, 0.2);
      spinRing(g, m, 0.46, 0.16);
    }
    return;
  }

  if (era === 2) {
    // 现代自行火炮：履带底盘 + 炮塔
    add(g, new THREE.BoxGeometry(0.82, 0.2, 1.05), m.dark, 0, 0.13, 0);
    if (lv >= 4) {
      // 履带侧裙
      for (const sx of [-1, 1]) {
        add(g, new THREE.BoxGeometry(0.12, 0.16, 1.1), m.accent, sx * 0.46, 0.13, 0);
      }
      addWheels(g, m, 0.4, 0.3, 0.11);
    }
    const barrels = lv >= 5 ? 2 : 1;
    const xs = barrels === 2 ? [-0.13, 0.13] : [0];
    const len = 0.8 + lv * 0.13;
    const t = turret(g, m, 0.34, lv, lv >= 5 ? 0.5 : 0.3);
    add(t, new THREE.CylinderGeometry(0.26, 0.3, 0.24 + lv * 0.02, 12), m.main, 0, 0.1, 0.04);
    for (const x of xs) {
      add(t, new THREE.CylinderGeometry(0.07, 0.085, len, 10), m.accent,
        x, 0.12, -len * 0.45, Math.PI / 2 - 0.08, 0, 0);
    }
    if (lv >= 3) {
      // 输弹机构
      add(g, new THREE.BoxGeometry(0.18, 0.16, 0.24), m.accent, 0.4, 0.34, 0.2);
    }
    if (lv >= 5) {
      add(g, new THREE.BoxGeometry(0.28, 0.1, 0.22), m.dark, 0, 0.86, 0.16);
      spinRing(g, m, 0.5, 0.14);
    }
    return;
  }

  if (era === 3) {
    // 后现代酸液迫击炮：储罐 + 喷嘴
    const tanks = lv >= 5 ? 3 : lv >= 3 ? 2 : 1;
    const xs = spreadX(tanks, 0.34);
    for (const x of xs) {
      const h = 0.5 + lv * 0.06;
      add(g, new THREE.CylinderGeometry(0.22, 0.26, h, 12), m.main, x, 0.1 + h * 0.5, 0.04);
      add(g, new THREE.SphereGeometry(0.22, 12, 8), m.main, x, 0.1 + h, 0.04);
      add(g, new THREE.SphereGeometry(0.15, 10, 7), m.glowSoft, x, 0.1 + h, 0.04);
      add(g, new THREE.CylinderGeometry(0.05, 0.12, 0.42 + lv * 0.04, 10), m.accent,
        x, 0.32 + h * 0.55, -0.4, Math.PI / 2 - 0.28, 0, 0);
    }
    if (lv >= 4) {
      add(g, new THREE.BoxGeometry(1.0, 0.1, 0.72), m.dark, 0, 0.1, 0);
      addWheels(g, m, 0.4, 0.26, 0.12);
    }
    if (lv >= 5) {
      spinRing(g, m, 0.58, 0.14);
      add(g, new THREE.TorusGeometry(0.34, 0.03, 6, 18), m.accent, 0, 1.12, 0.04, Math.PI / 2, 0, 0);
    }
    return;
  }

  if (era === 4) {
    // 星际轨道炮：底座 + 多层能量环 + 平行轨道
    add(g, new THREE.CylinderGeometry(0.4, 0.46, 0.16 + lv * 0.02, 14), m.main, 0, 0.08, 0);
    const rails = lv >= 5 ? 4 : lv >= 3 ? 2 : 1;
    const xs = spreadX(rails, 0.16);
    for (const x of xs) {
      add(g, new THREE.BoxGeometry(0.055, 0.7 + lv * 0.07, 0.055), m.accent, x, 0.4, 0);
    }
    const rings = lv;
    for (let i = 0; i < rings; i++) {
      spinRing(g, m, 0.34 + i * 0.055, 0.22 + i * 0.16, 0.03);
    }
    add(g, new THREE.SphereGeometry(0.12 + lv * 0.012, 10, 8), m.glow, 0, 0.6, 0);
    if (lv >= 5) {
      add(g, new THREE.BoxGeometry(0.22, 0.08, 0.5), m.dark, 0, 1.0, -0.16);
    }
    return;
  }

  // 终幕引力炮：黑色核心 + 多道不同倾角的引力环
  add(g, new THREE.CylinderGeometry(0.35, 0.44, 0.12 + lv * 0.03, 12), m.main, 0, 0.1, 0);
  add(g, new THREE.SphereGeometry(0.28 + lv * 0.025, 14, 12), m.main, 0, 0.52, 0);
  const ringCount = lv;
  for (let i = 0; i < ringCount; i++) {
    const holder = new THREE.Group();
    holder.position.y = 0.52;
    holder.rotation.y = i * 0.7;
    if (lv >= 4) {
      holder.userData.spinY = true;
      holder.userData.spinSpeed = 0.4 + i * 0.15;
    }
    add(holder, new THREE.TorusGeometry(0.42 + i * 0.06, 0.026, 6, 24),
      m.glow, 0, 0, 0, Math.PI / 2 + (i - 1) * 0.42, 0, 0);
    g.add(holder);
  }
  add(g, new THREE.SphereGeometry(0.13, 10, 8), m.glow, 0, 0.52, 0);
  if (lv >= 5) {
    add(g, new THREE.TorusGeometry(0.52, 0.025, 6, 26), m.glowSoft, 0, 0.52, 0, 0.2, 0, 0);
  }
}

/* ----------------------------------------------------------
 * 近防：滚油锅 → 火焰碉堡 → 霰弹炮塔 → 纳米刃 → 等离子网 → 熵刃
 *
 * 等级轮廓：
 *   1 单管/单锅 · 2 加长加固 · 3 双管 · 4 装甲罩/双弹药鼓 · 5 多管旋转/环形能量
 * ---------------------------------------------------------- */
function buildCloseDefense(g, m, era, lv = 1) {
  // 共用底座：高度随等级一点点长，但主体轮廓靠上面的发射件
  const baseH = 0.2 + lv * 0.03;
  add(g, new THREE.CylinderGeometry(0.36, 0.44, baseH, 14), m.dark, 0, baseH * 0.5, 0);

  if (era === 0) {
    // 油锅：1 口 → 2 口 → 3 口，4 级加装甲圈，5 级加充能环
    const pots = lv >= 5 ? 3 : lv >= 3 ? 2 : 1;
    const xs = spreadX(pots, 0.3);
    for (const x of xs) {
      const h = 0.2 + lv * 0.03;
      add(g, new THREE.CylinderGeometry(0.2, 0.17, h, 12), m.main, x, baseH + h * 0.5, 0);
      add(g, new THREE.TorusGeometry(0.2, 0.028, 6, 16), m.accent,
        x, baseH + h, 0, Math.PI / 2, 0, 0);
    }
    if (lv >= 4) {
      add(g, new THREE.TorusGeometry(0.3, 0.04, 6, 18), m.accent, 0, baseH + 0.14, 0, Math.PI / 2, 0, 0);
    }
    if (lv >= 5) spinRing(g, m, 0.42, baseH + 0.05);
    return;
  }

  if (era === 1) {
    // 火焰碉堡：喷口 1 → 2 → 3，4 级加燃料罐，5 级加环
    add(g, new THREE.BoxGeometry(0.5 + lv * 0.04, 0.32 + lv * 0.02, 0.46), m.main,
      0, baseH + 0.16 + lv * 0.01, 0.04);
    const nozzles = lv >= 5 ? 3 : lv >= 3 ? 2 : 1;
    const xs = spreadX(nozzles, 0.15);
    for (const x of xs) {
      add(g, new THREE.CylinderGeometry(0.06, 0.09, 0.28 + lv * 0.04, 10), m.accent,
        x, baseH + 0.16, -0.28, Math.PI / 2 - 0.2, 0, 0);
    }
    if (lv >= 4) {
      for (const sx of [-1, 1]) {
        add(g, new THREE.CylinderGeometry(0.09, 0.09, 0.3, 10), m.dark,
          sx * 0.24, baseH + 0.14, 0.26, 0, 0, Math.PI / 2);
      }
    }
    if (lv >= 5) spinRing(g, m, 0.4, baseH + 0.02);
    return;
  }

  if (era === 2) {
    // 自动霰弹炮塔：单管 → 双管 → 四管旋转
    const barrels = lv >= 5 ? 4 : lv >= 3 ? 2 : 1;
    const xs = spreadX(barrels, 0.14);
    const len = 0.4 + lv * 0.05;
    const t = turret(g, m, baseH + 0.1, lv, 0.55);
    add(t, new THREE.CylinderGeometry(0.24, 0.28, 0.16, 12), m.main, 0, 0.08, 0);
    for (const x of xs) {
      add(t, new THREE.CylinderGeometry(0.07, 0.09, len, 10), m.accent,
        x, 0.1, -len * 0.42, Math.PI / 2 - 0.16, 0, 0);
    }
    if (lv >= 4) {
      // 半球装甲罩 + 双弹药鼓
      add(g, new THREE.SphereGeometry(0.32, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), m.main,
        0, baseH + 0.06, 0, Math.PI, 0, 0);
      for (const sx of [-1, 1]) {
        add(g, new THREE.CylinderGeometry(0.1, 0.1, 0.2, 10), m.accent,
          sx * 0.34, baseH + 0.16, 0.18, 0, 0, Math.PI / 2);
      }
    }
    if (lv >= 5) spinRing(g, m, 0.4, baseH + 0.02);
    return;
  }

  if (era === 3) {
    // 纳米刃发生器：1 → 2 → 3 片刃，4 级加冷却罐，5 级加环
    const blades = lv >= 5 ? 5 : lv >= 4 ? 3 : lv >= 3 ? 2 : 1;
    add(g, new THREE.BoxGeometry(0.16, 0.3 + lv * 0.04, 0.16), m.main, 0, baseH + 0.16, 0.02);
    const xs = spreadX(blades, 0.1);
    for (const x of xs) {
      add(g, new THREE.BoxGeometry(0.03, 0.05, 0.5 + lv * 0.04), m.glow,
        x, baseH + 0.3, -0.3, -0.18, 0, 0);
    }
    if (lv >= 4) {
      add(g, new THREE.CylinderGeometry(0.07, 0.08, 0.22, 9), m.dark,
        0.26, baseH + 0.14, 0.14);
    }
    if (lv >= 5) spinRing(g, m, 0.38, baseH + 0.04);
    return;
  }

  if (era === 4) {
    // 等离子网：杆 2 → 4 → 6，环 0 → 1 → 2
    const rods = lv >= 5 ? 6 : lv >= 3 ? 4 : 2;
    add(g, new THREE.CylinderGeometry(0.2, 0.24, 0.2, 12), m.main, 0, baseH + 0.08, 0);
    for (let i = 0; i < rods; i++) {
      const a = (i / rods) * Math.PI * 2;
      add(g, new THREE.CylinderGeometry(0.025, 0.025, 0.4 + lv * 0.05, 6), m.glow,
        Math.cos(a) * 0.2, baseH + 0.32, Math.sin(a) * 0.2);
    }
    if (lv >= 3) spinRing(g, m, 0.24 + lv * 0.02, baseH + 0.55, 0.02);
    if (lv >= 5) spinRing(g, m, 0.34, baseH + 0.12, 0.025);
    return;
  }

  // 终幕熵刃：1 → 2 → 3 片黑刃，4 级加装甲，5 级加环
  const blades = lv >= 5 ? 3 : lv >= 4 ? 3 : lv >= 3 ? 2 : 1;
  const xs = spreadX(blades, 0.12);
  for (const x of xs) {
    add(g, new THREE.BoxGeometry(0.045 + (lv >= 4 ? 0.015 : 0), 0.55 + lv * 0.08, 0.4), m.main,
      x, baseH + 0.3, 0);
    add(g, new THREE.BoxGeometry(0.015, 0.57 + lv * 0.08, 0.03), m.glow,
      x, baseH + 0.3, -0.22);
  }
  if (lv >= 4) {
    add(g, new THREE.TorusGeometry(0.3, 0.03, 6, 18), m.accent, 0, baseH + 0.06, 0, Math.PI / 2, 0, 0);
  }
  if (lv >= 5) spinRing(g, m, 0.4, baseH + 0.02);
}

/* ----------------------------------------------------------
 * 支援：医疗帐篷 → 战地医院 → 医疗直升机 → 克隆舱 → 量子塔 → 回溯祭坛
 *
 * 等级轮廓：
 *   1 小帐/单药箱 · 2 大帐/仓储箱 · 3 医疗站/旋翼 · 4 双舱 · 5 量子塔/祭坛
 * ---------------------------------------------------------- */
function buildSupport(g, m, era, lv = 1) {
  if (era === 0) {
    // 中世纪：帐篷随等级变大，4 级双帐，5 级加塔架和光环
    const w = 0.55 + lv * 0.09;
    const h = 0.22 + lv * 0.035;
    add(g, new THREE.BoxGeometry(w + 0.1, 0.05, 0.74), m.accent, 0, 0.025, 0);
    for (const sx of [-1, 1]) {
      add(g, new THREE.BoxGeometry(w * 0.55, 0.05, 0.74), m.main,
        sx * w * 0.24, 0.03 + h * 0.5, 0, 0, 0, sx * 0.95);
    }
    add(g, new THREE.BoxGeometry(0.28, 0.07, 0.035), m.glow, 0, 0.3 + h * 0.2, 0.38);
    add(g, new THREE.BoxGeometry(0.07, 0.26 + lv * 0.03, 0.035), m.glow,
      0, 0.3 + h * 0.2, 0.38);
    if (lv >= 2) {
      // 担架 + 药箱堆
      add(g, new THREE.BoxGeometry(0.16, 0.08, 0.5), m.dark, w * 0.42, 0.08, 0);
      add(g, new THREE.BoxGeometry(0.14, 0.14, 0.14), m.accent, -w * 0.52, 0.09, 0.1);
      add(g, new THREE.BoxGeometry(0.14, 0.14, 0.14), m.accent, -w * 0.52, 0.23, 0.1);
    }
    if (lv >= 3) {
      add(g, new THREE.CylinderGeometry(0.03, 0.03, 0.62 + lv * 0.06, 6), m.accent, 0, 0.32, -0.34);
    }
    if (lv >= 4) {
      add(g, new THREE.BoxGeometry(0.5, 0.06, 0.3), m.main, -w * 0.3, 0.44, 0.1);
      add(g, new THREE.BoxGeometry(0.48, 0.05, 0.26), m.accent, -w * 0.3, 0.54, 0.1, 0, 0, 0.12);
    }
    if (lv >= 5) {
      spinRing(g, m, 0.42, 0.06, 0.025);
      add(g, new THREE.SphereGeometry(0.1, 9, 7), m.glow, 0, 0.78, 0);
    }
    return;
  }

  if (era === 1) {
    // 二战战地医院：帐篷 1 → 2 → 塔架
    const w = 0.62 + lv * 0.1;
    add(g, new THREE.BoxGeometry(w + 0.15, 0.05, 0.82), m.accent, 0, 0.025, 0);
    add(g, new THREE.BoxGeometry(w, 0.24 + lv * 0.04, 0.78), m.main, 0, 0.14 + lv * 0.02, 0);
    add(g, new THREE.BoxGeometry(w - 0.1, 0.05, 0.84), m.accent, 0, 0.26 + lv * 0.04, 0);
    add(g, new THREE.BoxGeometry(0.28, 0.075, 0.03), m.glow, 0, 0.15 + lv * 0.02, 0.4);
    add(g, new THREE.BoxGeometry(0.075, 0.28 + lv * 0.04, 0.03), m.glow,
      0, 0.15 + lv * 0.02, 0.4);
    if (lv >= 2) {
      add(g, new THREE.BoxGeometry(0.18, 0.08, 0.52), m.dark, -w * 0.4, 0.08, 0);
      add(g, new THREE.BoxGeometry(0.18, 0.14, 0.14), m.accent, w * 0.42, 0.09, 0.12);
    }
    if (lv >= 4) {
      add(g, new THREE.BoxGeometry(0.46, 0.28, 0.56), m.main, w * 0.3, 0.16, 0.1);
      add(g, new THREE.BoxGeometry(0.52, 0.05, 0.62), m.accent, w * 0.3, 0.32, 0.1);
    }
    if (lv >= 5) {
      add(g, new THREE.CylinderGeometry(0.03, 0.035, 0.7, 6), m.accent, 0, 0.36, -0.32);
      spinRing(g, m, 0.44, 0.06, 0.025);
    }
    return;
  }

  if (era === 2) {
    // 现代医疗直升机：旋翼 3 级才转，4 级双侧吊舱，5 级大旋翼 + 环
    add(g, new THREE.BoxGeometry(0.4 + lv * 0.02, 0.3, 0.8 + lv * 0.03), m.main, 0, 0.36, 0);
    add(g, new THREE.BoxGeometry(0.1, 0.09, 0.38 + lv * 0.03), m.accent, 0, 0.4, 0.5 + lv * 0.02);
    add(g, new THREE.CylinderGeometry(0.03, 0.03, 0.1, 8), m.dark, 0, 0.56, 0);
    const rotor = new THREE.Group();
    rotor.position.y = 0.62;
    rotor.userData.spinY = true;
    rotor.userData.spinSpeed = 1.6;
    add(rotor, new THREE.BoxGeometry(0.6 + lv * 0.16, 0.02, 0.08), m.accent, 0, 0, 0);
    add(rotor, new THREE.BoxGeometry(0.08, 0.02, 0.3), m.accent, 0, 0, 0);
    g.add(rotor);
    if (lv >= 4) {
      for (const sx of [-1, 1]) {
        add(g, new THREE.CylinderGeometry(0.08, 0.08, 0.34, 10), m.accent,
          sx * 0.3, 0.34, 0.1, 0, 0, Math.PI / 2);
      }
    }
    if (lv >= 5) spinRing(g, m, 0.42, 0.04);
    return;
  }

  if (era === 3) {
    // 后现代克隆舱：单舱 → 双舱 → 三舱，5 级加大环
    const pods = lv >= 5 ? 3 : lv >= 4 ? 2 : 1;
    const xs = spreadX(pods, 0.3);
    const h = 0.55 + lv * 0.07;
    add(g, new THREE.CylinderGeometry(0.36, 0.4, 0.14, 14), m.dark, 0, 0.07, 0);
    for (const x of xs) {
      add(g, new THREE.CylinderGeometry(0.17, 0.19, h, 12), m.main, x, 0.14 + h * 0.5, 0);
      add(g, new THREE.CylinderGeometry(0.12, 0.12, h - 0.06, 10), m.glowSoft, x, 0.14 + h * 0.5, 0);
      add(g, new THREE.TorusGeometry(0.18, 0.025, 6, 16), m.glow,
        x, 0.14 + h, 0, Math.PI / 2, 0, 0);
    }
    if (lv >= 3) {
      // 管线
      for (let i = 0; i < 3; i++) {
        add(g, new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), m.accent,
          Math.cos(i * 2.1) * 0.3, 0.32, Math.sin(i * 2.1) * 0.3, 0, 0, 0.3);
      }
    }
    if (lv >= 5) spinRing(g, m, 0.46, 0.05, 0.025);
    return;
  }

  if (era === 4) {
    // 星际量子塔：塔身随等级长高，环数 2 → 5
    const h = 0.5 + lv * 0.1;
    add(g, new THREE.CylinderGeometry(0.24, 0.32, 0.1, 14), m.main, 0, 0.05, 0);
    add(g, new THREE.CylinderGeometry(0.14, 0.2, h, 10), m.main, 0, 0.1 + h * 0.5, 0);
    for (let i = 0; i < lv; i++) {
      spinRing(g, m, 0.28 - i * 0.015, 0.2 + i * (h / lv), 0.02);
    }
    add(g, new THREE.SphereGeometry(0.1 + lv * 0.01, 9, 7), m.glow, 0, 0.12 + h, 0);
    if (lv >= 4) {
      for (const sx of [-1, 1]) {
        add(g, new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6), m.accent, sx * 0.3, 0.26, 0);
      }
    }
    return;
  }

  // 终幕时间祭坛：沙漏随等级变大，4 级双沙漏，5 级多层环
  const w = 0.38 + lv * 0.04;
  add(g, new THREE.CylinderGeometry(w, w + 0.06, 0.1 + lv * 0.02, 14), m.main, 0, 0.06, 0);
  const glassH = 0.24 + lv * 0.04;
  add(g, new THREE.ConeGeometry(0.2 + lv * 0.015, glassH, 12), m.accent, 0, 0.12 + glassH * 0.5, 0);
  add(g, new THREE.ConeGeometry(0.2 + lv * 0.015, glassH, 12), m.accent,
    0, 0.12 + glassH * 1.5, 0, Math.PI, 0, 0);
  add(g, new THREE.TorusGeometry(0.18 + lv * 0.015, 0.02, 5, 18), m.glow,
    0, 0.12 + glassH, 0, Math.PI / 2, 0, 0);
  if (lv >= 4) {
    add(g, new THREE.ConeGeometry(0.1, 0.2, 10), m.accent, -0.42, 0.2, 0.1);
    add(g, new THREE.ConeGeometry(0.1, 0.2, 10), m.accent, -0.42, 0.4, 0.1, Math.PI, 0, 0);
  }
  if (lv >= 5) {
    spinRing(g, m, 0.46, 0.08, 0.025);
    spinRing(g, m, 0.34, 0.5, 0.022);
  }
}

/* ----------------------------------------------------------
 * 指挥：战鼓旗杆 → 电台天线 → 卫星站 → 神经链接舱 → 舰队指挥台 → 终焉方碑
 *
 * 等级轮廓：
 *   1 旗杆/战鼓 · 2 电台箱 · 3 雷达锅 · 4 全息台/多面板 · 5 方碑/指挥塔 + 大环
 * ---------------------------------------------------------- */
function buildCommand(g, m, era, lv = 1) {
  if (era === 0) {
    // 中世纪：鼓 + 旗杆；4 级起平台，5 级成塔
    const drumR = 0.2 + lv * 0.02;
    add(g, new THREE.CylinderGeometry(drumR, drumR, 0.24 + lv * 0.02, 14), m.main, 0, 0.12, 0);
    add(g, new THREE.CylinderGeometry(drumR + 0.01, drumR + 0.01, 0.025, 14), m.accent, 0, 0.24 + lv * 0.02, 0);
    add(g, new THREE.CylinderGeometry(0.025, 0.03, 0.7 + lv * 0.14, 8), m.accent, drumR * 0.9, 0.36, 0);
    const flags = lv >= 4 ? 4 : lv >= 2 ? 2 : 1;
    for (let i = 0; i < flags; i++) {
      const f = add(g, new THREE.BoxGeometry(0.22, 0.14 + lv * 0.01, 0.02), m.glow,
        drumR * 0.9 + 0.12, 0.58 + lv * 0.14 + i * 0.1, 0);
      f.rotation.z = -0.2;
    }
    if (lv >= 4) {
      add(g, new THREE.BoxGeometry(0.9, 0.05, 0.5), m.accent, 0, 0.04, 0);
    }
    if (lv >= 5) {
      add(g, new THREE.CylinderGeometry(0.02, 0.025, 0.5, 6), m.accent, -0.36, 0.4, 0.1);
      spinRing(g, m, 0.42, 0.08, 0.025);
    }
    return;
  }

  if (era === 1) {
    // 二战电台：箱体 + 天线数量随等级增加
    const w = 0.4 + lv * 0.05;
    add(g, new THREE.BoxGeometry(w, 0.24 + lv * 0.03, 0.36 + lv * 0.02), m.main,
      0, 0.12 + lv * 0.015, 0);
    const antennas = lv >= 4 ? 3 : lv >= 3 ? 2 : 1;
    for (let i = 0; i < antennas; i++) {
      add(g, new THREE.CylinderGeometry(0.012, 0.014, 0.5 + lv * 0.1, 5), m.accent,
        (i - (antennas - 1) / 2) * 0.2, 0.24 + lv * 0.015, 0);
      add(g, new THREE.SphereGeometry(0.035, 7, 5), m.glow,
        (i - (antennas - 1) / 2) * 0.2, 0.52 + lv * 0.1, 0);
    }
    if (lv >= 5) {
      spinRing(g, m, 0.42, 0.05, 0.025);
      add(g, new THREE.BoxGeometry(0.24, 0.12, 0.2), m.dark, 0.32, 0.2, 0.1);
    }
    return;
  }

  if (era === 2) {
    // 现代雷达站：锅随等级变大，3 级起转向
    add(g, new THREE.BoxGeometry(0.36, 0.18, 0.36), m.dark, 0, 0.09, 0);
    add(g, new THREE.CylinderGeometry(0.04, 0.05, 0.3 + lv * 0.03, 8), m.main, 0, 0.26, 0);
    const dishR = 0.24 + lv * 0.035;
    const holder = new THREE.Group();
    holder.position.y = 0.42 + lv * 0.03;
    if (lv >= 3) {
      holder.userData.spinY = true;
      holder.userData.spinSpeed = 0.3;
    }
    add(holder, new THREE.SphereGeometry(dishR, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42),
      m.main, 0, 0, 0, -0.6, 0, 0);
    add(holder, new THREE.SphereGeometry(0.035, 6, 5), m.glow, 0, dishR * 0.3, -dishR * 0.45);
    g.add(holder);
    if (lv >= 4) {
      add(g, new THREE.SphereGeometry(dishR, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.4),
        m.accent, -0.36, 0.42, 0.12, -0.5, 0, 0.5);
    }
    if (lv >= 5) spinRing(g, m, 0.46, 0.05, 0.025);
    return;
  }

  if (era === 3) {
    // 后现代神经链接舱：横躺胶囊，4 级加控制台
    const r = 0.16 + lv * 0.02;
    add(g, THREE.CapsuleGeometry
      ? new THREE.CapsuleGeometry(r, 0.4 + lv * 0.05, 6, 10)
      : new THREE.CylinderGeometry(r, r, 0.6 + lv * 0.05, 10),
      m.main, 0, 0.24 + lv * 0.02, 0, 0, 0, Math.PI / 2);
    add(g, new THREE.SphereGeometry(0.09 + lv * 0.008, 10, 8), m.glow, 0, 0.24 + lv * 0.02, 0);
    const wires = lv >= 5 ? 4 : lv >= 3 ? 3 : 2;
    for (let i = 0; i < wires; i++) {
      add(g, new THREE.CylinderGeometry(0.012, 0.012, 0.24 + lv * 0.03, 5), m.glowSoft,
        (i - (wires - 1) / 2) * 0.12, 0.4, 0, 0.3, 0, (i - 1) * 0.35);
    }
    if (lv >= 4) {
      add(g, new THREE.BoxGeometry(0.3, 0.14, 0.24), m.main, 0.36, 0.12, 0.1);
      add(g, new THREE.BoxGeometry(0.24, 0.02, 0.18), m.glow, 0.36, 0.2, 0.1);
    }
    if (lv >= 5) spinRing(g, m, 0.4, 0.06, 0.025);
    return;
  }

  if (era === 4) {
    // 星际全息指挥台：星点数量随等级增加
    add(g, new THREE.CylinderGeometry(0.32 + lv * 0.02, 0.38 + lv * 0.02, 0.1, 14), m.main, 0, 0.05, 0);
    add(g, new THREE.BoxGeometry(0.5 + lv * 0.04, 0.14, 0.34), m.main, 0, 0.17, 0);
    add(g, new THREE.BoxGeometry(0.44 + lv * 0.04, 0.02, 0.28), m.glow, 0, 0.25, 0);
    const stars = 3 + lv * 2;
    for (let i = 0; i < stars; i++) {
      const a = (i / stars) * Math.PI * 2;
      add(g, new THREE.SphereGeometry(0.02, 6, 4), m.glow,
        Math.cos(a) * (0.16 + lv * 0.01), 0.34 + Math.sin(i) * 0.06, Math.sin(a) * 0.1);
    }
    if (lv >= 4) {
      for (const sx of [-1, 1]) {
        add(g, new THREE.BoxGeometry(0.06, 0.32, 0.2), m.accent, sx * 0.36, 0.18, 0.1);
      }
    }
    if (lv >= 5) spinRing(g, m, 0.44, 0.06, 0.025);
    return;
  }

  // 终幕方碑：高度和符文随等级增加，5 级大光环
  const h = 0.7 + lv * 0.12;
  add(g, new THREE.CylinderGeometry(0.3, 0.36, 0.08, 12), m.main, 0, 0.04, 0);
  add(g, new THREE.BoxGeometry(0.36 + lv * 0.02, h, 0.16), m.main, 0, 0.08 + h * 0.5, 0);
  for (let i = 0; i < lv; i++) {
    add(g, new THREE.BoxGeometry(0.24, 0.025, 0.02), m.glow, 0, 0.2 + i * (h / (lv + 1)), 0.09);
  }
  if (lv >= 3) {
    spinRing(g, m, 0.3 + lv * 0.015, 0.08 + h * 0.5, 0.02, 0);
  }
  if (lv >= 5) {
    add(g, new THREE.SphereGeometry(0.1, 9, 7), m.glow, 0, 0.1 + h, 0);
  }
}

/* ----------------------------------------------------------
 * 召唤：小裂隙 → 加固基座 → 培养槽 → 多舱 → 虫巢 → 虚空裂隙
 *
 * 等级轮廓：
 *   1 单舱/窄裂隙 · 2 双舱 · 3 大槽/三卵 · 4 多舱环 · 5 母巢/巨裂隙
 * ---------------------------------------------------------- */
function buildSummon(g, m, era, lv = 1) {
  if (era === 0) {
    // 中世纪暗色拱环：1 道 → 2 道 → 大裂隙
    const rifts = lv >= 4 ? 3 : lv >= 2 ? 2 : 1;
    const xs = spreadX(rifts, 0.26);
    for (const x of xs) {
      add(g, new THREE.TorusGeometry(0.2 + lv * 0.02, 0.06, 6, 16), m.main, x, 0.3, 0);
      add(g, new THREE.SphereGeometry(0.14 + lv * 0.015, 10, 8), m.glowSoft, x, 0.3, 0);
    }
    if (lv >= 5) spinRing(g, m, 0.44, 0.04, 0.025);
    return;
  }

  if (era === 1) {
    // 二战加固基座 + 双舱：舱数随等级增加
    add(g, new THREE.CylinderGeometry(0.34, 0.4, 0.16 + lv * 0.02, 14), m.main, 0, 0.08, 0);
    const pods = lv >= 5 ? 3 : lv >= 3 ? 2 : 1;
    const xs = spreadX(pods, 0.28);
    for (const x of xs) {
      const h = 0.34 + lv * 0.05;
      add(g, new THREE.CylinderGeometry(0.12, 0.14, h, 10), m.accent, x, 0.16 + h * 0.5, 0);
      add(g, new THREE.SphereGeometry(0.1, 8, 6), m.glowSoft, x, 0.16 + h, 0);
    }
    if (lv >= 4) spinRing(g, m, 0.38, 0.04, 0.02);
    return;
  }

  if (era === 2) {
    // 现代大培养槽 + 管线，4 级双槽，5 级三槽
    const tanks = lv >= 5 ? 3 : lv >= 4 ? 2 : 1;
    const xs = spreadX(tanks, 0.3);
    const h = 0.5 + lv * 0.06;
    for (const x of xs) {
      add(g, new THREE.CylinderGeometry(0.2, 0.24, h, 12), m.main, x, 0.1 + h * 0.5, 0);
      add(g, new THREE.CylinderGeometry(0.15, 0.15, h - 0.06, 10), m.glowSoft, x, 0.1 + h * 0.5, 0);
      if (lv >= 3) {
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          add(g, new THREE.CylinderGeometry(0.025, 0.025, 0.4 + lv * 0.04, 6), m.accent,
            x + Math.cos(a) * 0.26, 0.28, Math.sin(a) * 0.26, 0, 0, 0.12);
        }
      }
    }
    if (lv >= 5) spinRing(g, m, 0.48, 0.05, 0.025);
    return;
  }

  if (era === 3) {
    // 后现代胶囊舱：1 → 2 → 3 → 4 → 5 个环形分布
    add(g, new THREE.CylinderGeometry(0.34, 0.4, 0.14, 14), m.main, 0, 0.07, 0);
    const pods = lv;
    const radius = 0.16 + lv * 0.02;
    for (let i = 0; i < pods; i++) {
      const a = (i / pods) * Math.PI * 2 + (lv >= 4 ? 0.4 : 0);
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      const h = 0.28 + lv * 0.04;
      add(g, THREE.CapsuleGeometry
        ? new THREE.CapsuleGeometry(0.075, h, 5, 9)
        : new THREE.CylinderGeometry(0.075, 0.075, h + 0.15, 9),
        m.main, x, 0.14 + h * 0.5, z);
      add(g, new THREE.SphereGeometry(0.06 + lv * 0.005, 8, 6), m.glowSoft, x, 0.14 + h * 0.5, z);
    }
    if (lv >= 4) {
      // 孵化臂
      for (const sx of [-1, 1]) {
        add(g, new THREE.BoxGeometry(0.04, 0.24, 0.04), m.accent, sx * 0.3, 0.34, 0, 0, 0, sx * 0.4);
      }
      spinRing(g, m, 0.4, 0.04, 0.02);
    }
    return;
  }

  if (era === 4) {
    // 星际虫巢：卵数 = 等级
    const coreR = 0.3 + lv * 0.03;
    add(g, new THREE.SphereGeometry(coreR, 12, 10), m.main, 0, 0.3 + lv * 0.03, 0);
    const eggs = lv;
    for (let i = 0; i < eggs; i++) {
      const a = (i / eggs) * Math.PI * 2 + 0.4;
      const rr = 0.26 + lv * 0.02;
      add(g, new THREE.SphereGeometry(0.13, 9, 7), m.accent,
        Math.cos(a) * rr, 0.24 + (i % 2) * 0.16, Math.sin(a) * rr);
    }
    add(g, new THREE.SphereGeometry(0.13 + lv * 0.008, 10, 8), m.glowSoft, 0, 0.5 + lv * 0.04, 0);
    if (lv >= 4) spinRing(g, m, 0.42, 0.05, 0.025);
    return;
  }

  // 终幕虚空裂隙：裂隙随等级变宽变高，粒子数 = 等级 + 2
  const h = 0.6 + lv * 0.12;
  add(g, new THREE.CylinderGeometry(0.26, 0.32, 0.08, 12), m.main, 0, 0.04, 0);
  add(g, new THREE.BoxGeometry(0.08 + lv * 0.02, h, 0.28 + lv * 0.02), m.main,
    0, 0.08 + h * 0.5, 0);
  add(g, new THREE.BoxGeometry(0.04, h - 0.06, 0.1), m.glow, 0, 0.08 + h * 0.5, 0);
  const parts = lv + 2;
  for (let i = 0; i < parts; i++) {
    add(g, new THREE.SphereGeometry(0.028, 6, 5), m.glow,
      (i % 2 ? 0.1 : -0.1), 0.16 + i * (h / (parts + 1)), 0);
  }
  if (lv >= 4) spinRing(g, m, 0.4, 0.05, 0.025);
}

const BUILDERS = {
  siege: buildSiege,
  closeDefense: buildCloseDefense,
  support: buildSupport,
  command: buildCommand,
  summon: buildSummon,
};

/* ----------------------------------------------------------
 * 对外接口
 * ---------------------------------------------------------- */

/**
 * 造一个槽位模型。
 * @param {string} id    siege / closeDefense / support / command / summon
 * @param {number} era   0-5
 * @param {number} level 1-5
 * @returns {THREE.Group}  group.userData.spinParts 里是可以转的部件
 */
export function buildSlotStructure(id, era, level) {
  const g = new THREE.Group();
  const m = makeMats(era);
  const lv = clampLevel(level);
  const builder = BUILDERS[id];

  if (builder) builder(g, m, clampEra(era), lv);

  // 体积只做轻微补偿：升级主要靠上面的结构变化，不再用 1.32 倍整体缩放
  // 去糊弄剪影（那会让 5 级看起来只是同一个模型放大）。
  g.scale.setScalar(1 + (lv - 1) * 0.05);

  // 收集可旋转部件，交给外部每帧推进（spinY 绕 y，其余沿用原来的 z）
  const spinParts = [];
  g.traverse((o) => {
    if (o.userData && (o.userData.spin || o.userData.spinY)) spinParts.push(o);
  });
  g.userData.spinParts = spinParts;
  g.userData.level = lv;
  g.userData.era = clampEra(era);
  g.userData.mats = m;

  return g;
}

/**
 * 槽位地基上的等级标识：1-5 个小点，亮 = 已有，暗 = 未到。
 * 属于 UI 层的小件，但用 3D 画比叠 HTML 省事，也跟着槽位一起缩放。
 * @returns {THREE.Group}
 */
export function buildLevelDots(level, color) {
  const g = new THREE.Group();
  const lv = Math.max(0, Math.min(5, Math.floor(Number(level)) || 0));

  // 每个点必须有自己的材质：外面每帧按等级改 opacity，
  // 共用一份材质的话改第 1 个点会把 5 个点一起改掉（踩过）
  const geo = new THREE.CircleGeometry(0.055, 10);

  // 五个点排在槽位前方，间距 0.16
  for (let i = 0; i < 5; i++) {
    const dot = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color, transparent: true,
        opacity: i < lv ? 1 : 0.16,
        depthWrite: false,
      })
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.set((i - 2) * 0.16, 0.1, 0.78);
    dot.renderOrder = 3;
    g.add(dot);
  }
  return g;
}

/** 一个槽位模型占多少材质，拆的时候要释放 */
export function disposeSlotStructure(group) {
  if (!group) return;
  const m = group.userData && group.userData.mats;
  if (m) {
    m.main.dispose();
    m.accent.dispose();
    m.glow.dispose();
    m.glowSoft.dispose();
    m.dark.dispose();
  }
  group.traverse((o) => {
    if (o.isMesh && o.geometry) o.geometry.dispose();
  });
}

/** 时代名，给 UI 用 */
export function slotEraName(era) {
  return ['中世纪', '二战', '现代', '后现代', '星际', '终幕'][clampEra(era)];
}
