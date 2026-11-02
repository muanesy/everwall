/* ==========================================================
 * 槽位正式模型（乙负责）
 *
 * 对应 docs/美术需求-槽位与技能.md 里的「P1 六个槽位」。
 *
 * 设计原则（照文档的"制作方式建议"来）：
 *   1. 一个基础模型 + 4 级附件套件，不做 30 个独立模型
 *   2. 时代决定"长什么样"（投石机 / 车厢炮 / 履带炮塔 / 生物罐 / 能量环 / 黑球）
 *   3. 等级只决定"多大、加多少附件"，不换科技家族
 *   4. 全程序化几何体，零外部素材——文档也要求"特效优先程序化"
 *
 * 为什么不用 GLB：这六套东西全是箱体、圆柱、圆环的组合，
 * 用 200 行代码就能参数化出 30 个变体；做成 30 个 GLB 反而要 30 次建模 + 30 次加载。
 * 文档说的「模型统一 GLB、单个不超过 2MB」是针对要贴图的高模，这里不需要。
 * ========================================================== */

import * as THREE from 'three';

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
 * 等级附件
 *
 * 文档要求"每升 1 级至少多一个可识别的附件"。
 * 这里做四组通用附件，每个槽位按自己的形状取用——
 * 不做 30 套不同的附件，那和"从零建模"没区别。
 * ---------------------------------------------------------- */

// 2 级：加固支架。四角斜撑，读起来是"加固了一圈"
function addBraces(g, m, w, h) {
  const len = Math.hypot(w * 0.42, h * 0.75);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(g, new THREE.BoxGeometry(0.05, len, 0.05), m.accent,
        sx * w * 0.4, h * 0.38, sz * w * 0.4,
        sz * 0.42, 0, -sx * 0.42);
    }
  }
}

// 3 级：弹药架 / 备件架。侧面一排小箱子
function addAmmoRack(g, m, w, y) {
  for (let i = 0; i < 3; i++) {
    add(g, new THREE.BoxGeometry(0.12, 0.14, 0.1), m.accent,
      -w * 0.42 - 0.02, y + i * 0.16, 0.16);
  }
  add(g, new THREE.BoxGeometry(0.06, 0.5, 0.06), m.dark, -w * 0.42, y + 0.24, 0.2);
}

// 4 级：装甲护板。正面两块斜板
function addArmorPlate(g, m, w, h) {
  for (const sx of [-1, 1]) {
    add(g, new THREE.BoxGeometry(w * 0.34, h * 0.5, 0.05), m.accent,
      sx * w * 0.22, h * 0.42, w * 0.36, 0, sx * 0.3, 0);
  }
}

// 5 级：充能环 / 光带。这是"满级一眼可辨"的关键
function addChargeRing(g, m, radius, y, tube = 0.045) {
  const ring = add(g, new THREE.TorusGeometry(radius, tube, 6, 26), m.glow,
    0, y, 0, Math.PI / 2, 0, 0);
  ring.userData.spin = true;
  return ring;
}

/* ----------------------------------------------------------
 * 各槽位的时代变体
 *
 * 每个函数接收 (g, m, level)，只负责摆基础形状；
 * 等级附件由外部统一叠加。
 * ---------------------------------------------------------- */

/* 攻城：投石机 → 车厢炮 → 履带炮塔 → 生物喷射罐 → 能量轨道 → 引力球 */
function buildSiege(g, m, era) {
  if (era === 0) {
    // 木架投石机：A 形木架 + 配重箱 + 抛臂
    add(g, new THREE.BoxGeometry(1.0, 0.16, 0.7), m.main, 0, 0.08, 0);
    for (const sx of [-1, 1]) {
      add(g, new THREE.BoxGeometry(0.1, 0.86, 0.1), m.main, sx * 0.34, 0.56, 0, 0, 0, sx * 0.2);
    }
    add(g, new THREE.BoxGeometry(0.3, 0.26, 0.3), m.accent, 0, 0.95, 0.26);  // 配重
    add(g, new THREE.BoxGeometry(0.09, 0.09, 1.15), m.accent, 0, 1.06, -0.32, -0.42, 0, 0); // 抛臂
    return;
  }
  if (era === 1) {
    // 装甲车厢 + 长炮管
    add(g, new THREE.BoxGeometry(0.9, 0.5, 1.15), m.main, 0, 0.3, 0);
    add(g, new THREE.CylinderGeometry(0.09, 0.11, 1.25, 10), m.accent,
      0, 0.56, -0.5, Math.PI / 2 - 0.12, 0, 0);
    for (const sx of [-1, 1]) {
      add(g, new THREE.CylinderGeometry(0.17, 0.17, 0.1, 10), m.dark,
        sx * 0.46, 0.17, 0.32, 0, 0, Math.PI / 2);
    }
    return;
  }
  if (era === 2) {
    // 履带底盘 + 炮塔
    add(g, new THREE.BoxGeometry(0.82, 0.24, 1.2), m.dark, 0, 0.16, 0);
    add(g, new THREE.CylinderGeometry(0.34, 0.38, 0.32, 12), m.main, 0, 0.44, 0.06);
    add(g, new THREE.CylinderGeometry(0.07, 0.08, 1.05, 10), m.accent,
      0, 0.48, -0.5, Math.PI / 2 - 0.08, 0, 0);
    return;
  }
  if (era === 3) {
    // 生物储罐 + 喷嘴
    add(g, new THREE.CylinderGeometry(0.3, 0.36, 0.76, 12), m.main, 0, 0.42, 0.06);
    add(g, new THREE.SphereGeometry(0.3, 12, 10), m.main, 0, 0.82, 0.06);
    add(g, new THREE.CylinderGeometry(0.06, 0.14, 0.5, 10), m.accent,
      0, 0.62, -0.44, Math.PI / 2 - 0.25, 0, 0);
    // 培养液：半透明发光内胆
    add(g, new THREE.SphereGeometry(0.22, 10, 8), m.glowSoft, 0, 0.82, 0.06);
    return;
  }
  if (era === 4) {
    // 能量环 + 轨道
    add(g, new THREE.CylinderGeometry(0.4, 0.48, 0.2, 14), m.main, 0, 0.1, 0);
    for (let i = 0; i < 2; i++) {
      add(g, new THREE.TorusGeometry(0.42 + i * 0.1, 0.035, 6, 24), m.glow,
        0, 0.52 + i * 0.34, 0, Math.PI / 2, 0, 0);
    }
    add(g, new THREE.BoxGeometry(0.1, 0.62, 0.1), m.accent, 0, 0.44, 0);
    add(g, new THREE.SphereGeometry(0.13, 10, 8), m.glow, 0, 0.84, 0);
    return;
  }
  // 终幕：黑色球体 + 引力环
  add(g, new THREE.SphereGeometry(0.36, 14, 12), m.main, 0, 0.5, 0);
  for (let i = 0; i < 3; i++) {
    add(g, new THREE.TorusGeometry(0.5 + i * 0.07, 0.028, 6, 22), m.glow,
      0, 0.5, 0, Math.PI / 2 + (i - 1) * 0.5, i * 0.7, 0);
  }
  add(g, new THREE.SphereGeometry(0.16, 10, 8), m.glow, 0, 0.5, 0);
}

/* 近防：滚油锅 → 火焰碉堡 → 霰弹炮塔 → 纳米刃 → 等离子网 → 熵刃 */
function buildCloseDefense(g, m, era) {
  // 共用底座：一个矮墩，其余按时代换上半部分
  add(g, new THREE.CylinderGeometry(0.38, 0.46, 0.3, 14), m.dark, 0, 0.15, 0);

  if (era === 0) {
    // 滚油锅
    add(g, new THREE.CylinderGeometry(0.28, 0.2, 0.26, 14), m.main, 0, 0.44, 0);
    add(g, new THREE.TorusGeometry(0.28, 0.035, 6, 18), m.accent, 0, 0.56, 0, Math.PI / 2, 0, 0);
    return;
  }
  if (era === 1) {
    // 火焰喷射碉堡：一个扁箱 + 前方喷口
    add(g, new THREE.BoxGeometry(0.6, 0.42, 0.5), m.main, 0, 0.5, 0.04);
    add(g, new THREE.CylinderGeometry(0.07, 0.11, 0.34, 10), m.accent,
      0, 0.52, -0.36, Math.PI / 2 - 0.2, 0, 0);
    return;
  }
  if (era === 2) {
    // 自动霰弹炮塔：转台 + 短粗炮管
    add(g, new THREE.CylinderGeometry(0.26, 0.3, 0.18, 12), m.main, 0, 0.38, 0);
    add(g, new THREE.CylinderGeometry(0.1, 0.12, 0.6, 10), m.accent,
      0, 0.5, -0.24, Math.PI / 2 - 0.16, 0, 0);
    return;
  }
  if (era === 3) {
    // 纳米刃发生器：细长刃片
    add(g, new THREE.BoxGeometry(0.16, 0.5, 0.16), m.main, 0, 0.48, 0.02);
    for (let i = 0; i < 3; i++) {
      add(g, new THREE.BoxGeometry(0.03, 0.06, 0.62), m.glow,
        (i - 1) * 0.1, 0.52, -0.38, -0.18, 0, 0);
    }
    return;
  }
  if (era === 4) {
    // 等离子网发射器：四根短杆 + 网面
    add(g, new THREE.CylinderGeometry(0.2, 0.24, 0.22, 12), m.main, 0, 0.4, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      add(g, new THREE.CylinderGeometry(0.03, 0.03, 0.46, 6), m.glow,
        Math.cos(a) * 0.2, 0.62, Math.sin(a) * 0.2, 0, 0, 0);
    }
    add(g, new THREE.TorusGeometry(0.24, 0.02, 5, 18), m.glowSoft, 0, 0.84, 0, Math.PI / 2, 0, 0);
    return;
  }
  // 终幕：熵刃，一片竖立的黑刃 + 边缘发光
  add(g, new THREE.BoxGeometry(0.06, 0.9, 0.5), m.main, 0, 0.62, 0);
  add(g, new THREE.BoxGeometry(0.02, 0.92, 0.04), m.glow, 0, 0.62, -0.26);
}

/* 支援：医疗帐篷 → 战地医院 → 医疗直升机 → 克隆舱 → 量子塔 → 回溯祭坛 */
function buildSupport(g, m, era) {
  if (era === 0) {
    // 小帐篷：三棱柱用两个斜面盒拼
    add(g, new THREE.BoxGeometry(0.9, 0.06, 0.8), m.accent, 0, 0.03, 0);
    for (const sx of [-1, 1]) {
      add(g, new THREE.BoxGeometry(0.5, 0.05, 0.8), m.main, sx * 0.22, 0.3, 0, 0, 0, sx * 0.9);
    }
    add(g, new THREE.BoxGeometry(0.3, 0.08, 0.04), m.glow, 0, 0.3, 0.42);
    add(g, new THREE.BoxGeometry(0.08, 0.26, 0.04), m.glow, 0, 0.3, 0.42);
    return;
  }
  if (era === 1) {
    // 战地医院帐篷：大一号 + 立柱 + 红十字
    add(g, new THREE.BoxGeometry(1.05, 0.06, 0.9), m.accent, 0, 0.03, 0);
    add(g, new THREE.BoxGeometry(1.0, 0.5, 0.86), m.main, 0, 0.3, 0, 0, 0, 0);
    add(g, new THREE.BoxGeometry(0.9, 0.06, 0.92), m.accent, 0, 0.56, 0);
    add(g, new THREE.BoxGeometry(0.3, 0.09, 0.03), m.glow, 0, 0.32, 0.44);
    add(g, new THREE.BoxGeometry(0.09, 0.3, 0.03), m.glow, 0, 0.32, 0.44);
    return;
  }
  if (era === 2) {
    // 医疗直升机：机身 + 旋翼 + 尾梁
    add(g, new THREE.BoxGeometry(0.42, 0.34, 0.86), m.main, 0, 0.44, 0);
    add(g, new THREE.BoxGeometry(0.12, 0.1, 0.42), m.accent, 0, 0.48, 0.56);
    add(g, new THREE.CylinderGeometry(0.04, 0.04, 0.1, 8), m.dark, 0, 0.66, 0);
    // 旋翼：两片薄板，后面让它转
    const rotor = add(g, new THREE.BoxGeometry(1.05, 0.02, 0.08), m.accent, 0, 0.72, 0);
    rotor.userData.spin = true;
    add(g, new THREE.BoxGeometry(0.06, 0.02, 0.4), m.accent, 0, 0.72, 0);
    return;
  }
  if (era === 3) {
    // 克隆舱：竖立培养管 + 内部液体
    add(g, new THREE.CylinderGeometry(0.3, 0.34, 0.2, 12), m.dark, 0, 0.1, 0);
    add(g, new THREE.CylinderGeometry(0.24, 0.24, 0.86, 14), m.main, 0, 0.6, 0);
    add(g, new THREE.CylinderGeometry(0.18, 0.18, 0.8, 12), m.glowSoft, 0, 0.6, 0);
    add(g, new THREE.TorusGeometry(0.25, 0.03, 6, 18), m.glow, 0, 1.02, 0, Math.PI / 2, 0, 0);
    return;
  }
  if (era === 4) {
    // 量子修复塔：细高塔 + 三层光环
    add(g, new THREE.CylinderGeometry(0.18, 0.26, 0.9, 10), m.main, 0, 0.45, 0);
    for (let i = 0; i < 3; i++) {
      add(g, new THREE.TorusGeometry(0.26 - i * 0.04, 0.025, 5, 18), m.glow,
        0, 0.34 + i * 0.3, 0, Math.PI / 2, 0, 0);
    }
    add(g, new THREE.SphereGeometry(0.1, 8, 6), m.glow, 0, 0.98, 0);
    return;
  }
  // 终幕：时间回溯祭坛，倒流沙漏
  add(g, new THREE.CylinderGeometry(0.44, 0.5, 0.14, 14), m.main, 0, 0.07, 0);
  add(g, new THREE.ConeGeometry(0.24, 0.4, 12), m.accent, 0, 0.34, 0);
  add(g, new THREE.ConeGeometry(0.24, 0.4, 12), m.accent, 0, 0.74, 0, Math.PI, 0, 0);
  add(g, new THREE.TorusGeometry(0.3, 0.02, 5, 20), m.glow, 0, 0.54, 0, Math.PI / 2, 0, 0);
}

/* 指挥：战鼓旗杆 → 电台天线 → 卫星站 → 神经链接舱 → 舰队指挥台 → 终焉方碑 */
function buildCommand(g, m, era) {
  if (era === 0) {
    // 战鼓 + 旗杆
    add(g, new THREE.CylinderGeometry(0.3, 0.3, 0.3, 14), m.main, 0, 0.28, 0);
    add(g, new THREE.CylinderGeometry(0.31, 0.31, 0.03, 14), m.accent, 0, 0.44, 0);
    add(g, new THREE.CylinderGeometry(0.04, 0.04, 1.1, 8), m.accent, 0.34, 0.55, 0);
    add(g, new THREE.BoxGeometry(0.4, 0.24, 0.02), m.glow, 0.56, 0.94, 0);
    return;
  }
  if (era === 1) {
    // 前线电台 + 天线
    add(g, new THREE.BoxGeometry(0.56, 0.36, 0.42), m.main, 0, 0.24, 0);
    add(g, new THREE.CylinderGeometry(0.02, 0.02, 0.9, 6), m.accent, 0.18, 0.72, 0);
    add(g, new THREE.SphereGeometry(0.05, 8, 6), m.glow, -0.14, 0.46, 0.2);
    return;
  }
  if (era === 2) {
    // 卫星地面站：锅 + 支架
    add(g, new THREE.BoxGeometry(0.42, 0.24, 0.42), m.dark, 0, 0.12, 0);
    add(g, new THREE.CylinderGeometry(0.05, 0.06, 0.42, 8), m.main, 0, 0.4, 0);
    const dish = add(g, new THREE.SphereGeometry(0.32, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42),
      m.main, 0, 0.68, 0, -0.6, 0, 0);
    add(g, new THREE.SphereGeometry(0.04, 6, 5), m.glow, 0, 0.8, -0.16);
    return;
  }
  if (era === 3) {
    // 神经链接舱：横躺舱体 + 神经线
    // 注意别写成 `new THREE.CapsuleGeometry ? ...`：那会先真造一个默认胶囊
    // 再当条件用，每次重建都泄漏一份几何体
    add(g, THREE.CapsuleGeometry
      ? new THREE.CapsuleGeometry(0.22, 0.5, 6, 10)
      : new THREE.CylinderGeometry(0.22, 0.22, 0.7, 10),
      m.main, 0, 0.36, 0, 0, 0, Math.PI / 2);
    add(g, new THREE.SphereGeometry(0.13, 10, 8), m.glow, 0, 0.36, 0);
    for (let i = 0; i < 3; i++) {
      add(g, new THREE.CylinderGeometry(0.015, 0.015, 0.3, 5), m.glowSoft,
        (i - 1) * 0.14, 0.56, 0, 0.3, 0, (i - 1) * 0.4);
    }
    return;
  }
  if (era === 4) {
    // 舰队指挥台：斜台 + 全息星图
    add(g, new THREE.CylinderGeometry(0.34, 0.4, 0.14, 14), m.main, 0, 0.07, 0);
    add(g, new THREE.BoxGeometry(0.62, 0.2, 0.4), m.main, 0, 0.24, 0);
    add(g, new THREE.BoxGeometry(0.5, 0.02, 0.3), m.glow, 0, 0.36, 0);
    // 全息小星图：几个亮点
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(g, new THREE.SphereGeometry(0.025, 6, 5), m.glow,
        Math.cos(a) * 0.16, 0.44 + Math.sin(i) * 0.05, Math.sin(a) * 0.1);
    }
    return;
  }
  // 终幕：方碑 + 符文
  add(g, new THREE.BoxGeometry(0.44, 1.15, 0.18), m.main, 0, 0.6, 0);
  for (let i = 0; i < 3; i++) {
    add(g, new THREE.BoxGeometry(0.3, 0.03, 0.02), m.glow, 0, 0.34 + i * 0.28, 0.1);
  }
  add(g, new THREE.TorusGeometry(0.34, 0.02, 5, 20), m.glowSoft, 0, 0.6, 0, 0, 0, 0);
}

/* 召唤：小裂隙 → 加固基座 → 培养槽 → 多舱 → 虫巢 → 虚空裂隙 */
function buildSummon(g, m, era) {
  if (era === 0) {
    // 单培养舱（早期时代其实是"小裂隙"，用一个暗色拱表示）
    add(g, new THREE.TorusGeometry(0.3, 0.07, 6, 16), m.main, 0, 0.34, 0, 0, 0, 0);
    add(g, new THREE.SphereGeometry(0.22, 10, 8), m.glowSoft, 0, 0.34, 0);
    return;
  }
  if (era === 1) {
    // 加固基座 + 双舱雏形
    add(g, new THREE.CylinderGeometry(0.4, 0.46, 0.22, 14), m.main, 0, 0.11, 0);
    for (const sx of [-1, 1]) {
      add(g, new THREE.CylinderGeometry(0.14, 0.15, 0.5, 10), m.accent, sx * 0.2, 0.42, 0);
    }
    add(g, new THREE.SphereGeometry(0.12, 8, 6), m.glowSoft, 0, 0.55, 0);
    return;
  }
  if (era === 2) {
    // 大培养槽 + 管线
    add(g, new THREE.CylinderGeometry(0.32, 0.36, 0.8, 14), m.main, 0, 0.42, 0);
    add(g, new THREE.CylinderGeometry(0.26, 0.26, 0.72, 12), m.glowSoft, 0, 0.42, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      add(g, new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6), m.accent,
        Math.cos(a) * 0.34, 0.36, Math.sin(a) * 0.34, 0, 0, 0.12);
    }
    return;
  }
  if (era === 3) {
    // 多舱 + 孵化臂
    add(g, new THREE.CylinderGeometry(0.38, 0.44, 0.18, 14), m.main, 0, 0.09, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      add(g, THREE.CapsuleGeometry
        ? new THREE.CapsuleGeometry(0.12, 0.28, 5, 9)
        : new THREE.CylinderGeometry(0.12, 0.12, 0.5, 9),
        m.main, Math.cos(a) * 0.2, 0.42, Math.sin(a) * 0.2);
      add(g, new THREE.SphereGeometry(0.09, 8, 6), m.glowSoft,
        Math.cos(a) * 0.2, 0.42, Math.sin(a) * 0.2);
    }
    return;
  }
  if (era === 4) {
    // 虫巢：一堆膨大的卵体 + 生物膜
    add(g, new THREE.SphereGeometry(0.4, 12, 10), m.main, 0, 0.42, 0);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      add(g, new THREE.SphereGeometry(0.15, 9, 7), m.accent,
        Math.cos(a) * 0.33, 0.34 + (i % 2) * 0.2, Math.sin(a) * 0.33);
    }
    add(g, new THREE.SphereGeometry(0.2, 10, 8), m.glowSoft, 0, 0.68, 0);
    return;
  }
  // 终幕：虚空裂隙，黑色竖缝 + 倒流粒子
  add(g, new THREE.BoxGeometry(0.1, 1.05, 0.34), m.main, 0, 0.6, 0);
  add(g, new THREE.BoxGeometry(0.05, 1.0, 0.12), m.glow, 0, 0.6, 0);
  for (let i = 0; i < 4; i++) {
    add(g, new THREE.SphereGeometry(0.03, 6, 5), m.glow,
      (i % 2 ? 0.12 : -0.12), 0.3 + i * 0.22, 0);
  }
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

  if (builder) builder(g, m, clampEra(era));

  // 等级附件：2 级起逐级叠加，5 级一起全有
  if (lv >= 2) addBraces(g, m, 0.95, 0.7);
  if (lv >= 3) addAmmoRack(g, m, 0.95, 0.28);
  if (lv >= 4) addArmorPlate(g, m, 0.95, 0.7);
  if (lv >= 5) addChargeRing(g, m, 0.62, 0.12);

  // 体积：1.0 → 1.32，5 级明显大一圈（文档要求）
  g.scale.setScalar(1 + (lv - 1) * 0.08);

  // 收集可旋转部件，交给外部每帧推进
  const spinParts = [];
  g.traverse((o) => {
    if (o.userData && o.userData.spin) spinParts.push(o);
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
