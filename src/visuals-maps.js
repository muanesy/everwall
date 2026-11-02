/* ==========================================================
 * 新增地图（乙负责）
 *
 * 对应 docs/美术需求-槽位与技能.md 的「P2 地图与时代」。
 *
 * ## 摆位必须按相机实算，不能凭感觉
 *
 * 这台相机是 45° 俯视、画面只有 9:16 宽。**每个深度 z 能看见的横向范围是有限的**：
 * z=0 时约 ±11，z=-40 时约 ±19.4，而 z=16（玩家脚下）只有 ±7.8。
 *
 * 第一版我按"看起来够远"摆道具，城堡墙放到 x=22 / z=-40，
 * 投影后屏幕 x = −77 —— 完全在画面外，整张图空空荡荡，
 * 玩家以为"背景物没做"。所以现在所有摆放都走 `bandX()`：
 * 用调用方传进来的 `viewHalfX(z)` 算出该深度的可见半宽，
 * 只在「战场边界之外、画面之内」这条带子里取点，保证两侧都有东西且不出画。
 *
 * ## 为什么零件都做成多段几何而不是方块
 *
 * 单个 Box 在俯视图里读不出"这是什么"。能读出来的形状都需要**轮廓特征**：
 *   建筑 = 主体 + 坡屋顶 + 山墙 + 烟囱 + 一排亮窗 + 门（5 段以上轮廓才像房子）
 *   树   = 树干 + 斜枝 + 3~5 个大小不一的树冠球
 *   车   = 车体 + 驾驶室 + 四轮 + 挡风面 + 车灯
 *   城墙 = 墙体 + 雉堞 + 扶壁 + 圆塔锥顶
 * 所以下面的工厂都按"轮廓优先"堆零件，而不是一个大方块了事。
 * ========================================================== */

import * as THREE from 'three';

/* ----------------------------------------------------------
 * 基础工具
 * ---------------------------------------------------------- */
function mat(color, o = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: o.rough ?? 0.9,
    metalness: o.metal ?? 0.04,
    flatShading: o.flat ?? true,
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.ei ?? 1,
  });
}

/** 方盒，原点在底面中心（和 visuals.js 的约定一致） */
function box(w, h, d, color, o) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, o));
  m.position.y = h / 2;
  return m;
}

/** 圆柱，原点在底面中心 */
function cyl(rTop, rBot, h, color, seg = 10, o) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat(color, o));
  m.position.y = h / 2;
  return m;
}

/** 锥体，原点在底面中心 */
function cone(r, h, color, seg = 8, o) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat(color, o));
  m.position.y = h / 2;
  return m;
}

/** 低面数石头：顶点抖动，棱角硬 */
function rock(rng, r, color) {
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.72 + rng() * 0.56;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.8, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat(color, { rough: 1 }));
  m.position.y = r * 0.55;
  return m;
}

/** 发光面片（窗、灯、屏幕）。面片比方块便宜得多 */
function glowPlane(w, h, color, opacity = 0.85) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
}

/** 往 group 里加一个已摆好位置的子件，返回该子件方便继续改 */
function put(parent, child, x, y, z) {
  child.position.set(x, y, z);
  parent.add(child);
  return child;
}

/* ----------------------------------------------------------
 * 摆位：只在「战场外、画面内」的带子里取点
 * ---------------------------------------------------------- */
const ARENA_HALF_X = 8.6;   // 战场横向半径（玩家和僵尸活动范围）

function viewHalfX(ctx, z) {
  if (ctx && typeof ctx.viewHalfX === 'function') {
    const v = ctx.viewHalfX(z);
    if (Number.isFinite(v) && v > 0) return v;
  }
  // 退化估算：越远可见越宽，和实测表一致（z=0→11.1，z=-40→19.4）
  return Math.max(7.5, 11.1 - z * 0.21);
}

/**
 * 在某个深度找一条"画面内、战场外"的横坐标。
 * @returns {number|null} 没空间返回 null（调用方跳过，别硬摆）
 */
function bandX(ctx, z, rng, opt = {}) {
  const half = viewHalfX(ctx, z);
  const minX = opt.minX ?? ARENA_HALF_X + 0.5;
  const edge = opt.edge ?? 0.9;          // 留余量，别贴死画面边缘
  const maxX = half * edge;
  if (maxX <= minX + 0.4) return null;
  const side = rng() < 0.5 ? -1 : 1;
  return side * (minX + rng() * (maxX - minX));
}

/** 在 z 区间里挑一个能放东西的点 */
function pickSpot(ctx, rng, zMin, zMax, opt = {}) {
  for (let i = 0; i < 10; i++) {
    const z = zMin + rng() * (zMax - zMin);
    const x = bandX(ctx, z, rng, opt);
    if (x != null) return { x, z };
  }
  return null;
}

/**
 * 两侧各摆一排：让"左有右也有"成为结构性保证，不依赖随机。
 * fn(x, z, rng, side) 会在每侧调用 count 次，x 已带正负号。
 */
function bothSides(ctx, rng, o, fn) {
  const { count = 5, zMin = -30, zMax = 2, opt } = o;
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      // 每侧沿 z 均匀铺开 + 抖动，避免整齐得像栅栏
      const t = (i + 0.5) / count;
      const z = zMin + (zMax - zMin) * t + (rng() - 0.5) * 2.2;
      const x = bandX(ctx, z, rng, opt);
      if (x == null) continue;
      fn(side * Math.abs(x), z, rng, side);
    }
  }
}

/* ----------------------------------------------------------
 * 零件工厂（轮廓优先）
 * ---------------------------------------------------------- */

/* 建筑：主体 + 坡屋顶 + 山墙 + 烟囱 + 亮窗 + 门 */
function building(rng, o = {}) {
  const {
    wall = 0x8a8070, roof = 0x4a3828, winColor = 0xffd88a,
    w = 5, h = 4, d = 5, ruined = false,
  } = o;

  const g = new THREE.Group();
  const bodyH = ruined ? h * (0.45 + rng() * 0.35) : h;

  put(g, box(w, bodyH, d, wall, { rough: 0.95 }), 0, 0, 0);

  // 窗：正面一排亮面。"有亮着的窗"是"这是房子"最强的信号
  const cols = Math.max(2, Math.round(w / 1.6));
  const rows = Math.max(1, Math.floor(bodyH / 2.2));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const win = glowPlane(0.85, 1.1, winColor, 0.3 + rng() * 0.45);
      const span = cols > 1 ? (w - 1.8) / (cols - 1) : 0;
      put(g, win, -w / 2 + 0.9 + c * span, 1.4 + r * 2.0, d / 2 + 0.02);
    }
  }

  // 门
  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.9), mat(0x1a1410, { rough: 1 }));
  put(g, door, 0, 0.95, d / 2 + 0.03);

  if (!ruined) {
    // 坡屋顶：两块斜板拼人字，比一个锥体更像民房
    for (const dir of [-1, 1]) {
      const slope = box(w * 0.62, 0.2, d * 1.12, roof, { rough: 0.95 });
      put(g, slope, dir * w * 0.26, bodyH + 0.58, 0);
      slope.rotation.z = -dir * 0.5;
    }
    // 山墙：把两块斜板之间的三角补上，不补会从侧面漏光
    const gable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, w * 0.5, 1.15, 3),
      mat(wall, { rough: 0.95 })
    );
    put(g, gable, 0, bodyH + 0.58, 0);
    gable.rotation.y = Math.PI / 6;

    if (rng() > 0.45) {
      put(g, box(0.55, 1.5, 0.55, 0x6a5a50, { rough: 1 }), w * 0.28, bodyH + 0.9, -d * 0.2);
    }
  } else {
    // 废墟：屋顶塌一半，露出参差断口
    for (let i = 0; i < 4; i++) {
      const jag = box(w / 4.4, 0.5 + rng() * 1.2, d * 0.9, roof, { rough: 1 });
      put(g, jag, -w / 2.2 + i * (w / 4.4), bodyH + 0.3, (rng() - 0.5) * 0.6);
      jag.rotation.z = (rng() - 0.5) * 0.35;
    }
  }

  return g;
}

/* 树：树干 + 斜枝 + 3~5 个树冠球（团块轮廓比单圆柱像树） */
function tree(rng, o = {}) {
  const { trunk = 0x4a3a28, leaf = 0x2f5a32, h = 5 } = o;
  const g = new THREE.Group();

  const th = h * (0.55 + rng() * 0.3);
  put(g, cyl(0.13 * h / 5, 0.26 * h / 5, th, trunk, 6, { rough: 1 }), 0, 0, 0);

  for (let i = 0; i < 2; i++) {
    const br = cyl(0.07, 0.11, th * 0.5, trunk, 5, { rough: 1 });
    put(g, br, 0, th * (0.55 + i * 0.2), 0);
    br.rotation.z = (i ? 1 : -1) * (0.7 + rng() * 0.3);
  }

  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = h * 0.16 * (0.7 + rng() * 0.7);
    const c = rock(rng, r, leaf);
    put(g, c, (rng() - 0.5) * h * 0.28, th + h * 0.08 + rng() * h * 0.2, (rng() - 0.5) * h * 0.28);
  }

  return g;
}

/* 枯树（沼泽/废墟）：无叶，只有扭曲枝干 */
function deadTree(rng, o = {}) {
  const { trunk = 0x33301f, h = 6 } = o;
  const g = new THREE.Group();
  const th = h * (0.6 + rng() * 0.3);
  put(g, cyl(0.12, 0.28, th, trunk, 5, { rough: 1 }), 0, 0, 0);

  for (let i = 0; i < 3; i++) {
    const len = th * (0.3 + rng() * 0.3);
    const br = cyl(0.04, 0.09, len, trunk, 4, { rough: 1 });
    put(g, br, 0, th * (0.45 + i * 0.17), 0);
    br.rotation.z = (rng() - 0.5) * 2.2;
    br.rotation.x = (rng() - 0.5) * 1.2;
  }
  return g;
}

/* 车：车体 + 驾驶室 + 四轮 + 挡风 + 车灯 */
function car(rng, o = {}) {
  const { body: bodyColor = 0x5a6070, glass = 0x2a3a48, wheel = 0x151515, flip = false } = o;
  const g = new THREE.Group();
  const L = 4.4 + rng() * 1.2;

  put(g, box(2.0, 0.85, L, bodyColor, { rough: 0.8, metal: 0.35 }), 0, 0.7, 0);
  put(g, box(1.7, 0.72, L * 0.42, bodyColor, { rough: 0.8, metal: 0.3 }), 0, 1.45, L * 0.06);

  for (const dir of [-1, 1]) {
    const w = glowPlane(1.5, 0.55, glass, 0.9);
    put(g, w, 0, 1.45, L * 0.06 + dir * L * 0.21);
    w.rotation.x = dir * 0.18;
  }

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wl = cyl(0.42, 0.42, 0.26, wheel, 9, { rough: 1 });
      wl.rotation.z = Math.PI / 2;
      put(g, wl, sx * 0.98, 0.42, sz * L * 0.32);
    }
  }

  for (const sx of [-1, 1]) {
    put(g, glowPlane(0.28, 0.16, 0xffeec0, 0.8), sx * 0.6, 0.78, L / 2 + 0.02);
  }

  if (flip) g.rotation.z = (rng() > 0.5 ? 1 : -1) * Math.PI / 2;
  return g;
}

/* 断柱：柱础 + 柱身 + 不规则断口 */
function brokenColumn(rng, o = {}) {
  const { stone = 0x7a7a86, h = 4 } = o;
  const g = new THREE.Group();

  put(g, box(1.2, 0.24, 1.2, stone, { rough: 0.95 }), 0, 0, 0);
  put(g, cyl(0.42, 0.5, h, stone, 9, { rough: 0.95 }), 0, 0.24, 0);

  // 断口碎石：制造"断裂"而不是"切齐"的感觉
  for (let i = 0; i < 3; i++) {
    const r = rock(rng, 0.22 + rng() * 0.2, stone);
    put(g, r, (rng() - 0.5) * 0.6, h + 0.2 + rng() * 0.2, (rng() - 0.5) * 0.6);
  }
  return g;
}

/* 拱：两根立柱 + 半圆拱（修道院/城门） */
function arch(rng, o = {}) {
  const { stone = 0x8a8478, w = 3, h = 4.4 } = o;
  const g = new THREE.Group();

  for (const sx of [-1, 1]) {
    put(g, box(0.6, h, 0.6, stone, { rough: 0.95 }), sx * w / 2, 0, 0);
  }
  const arc = new THREE.Mesh(
    new THREE.TorusGeometry(w / 2, 0.3, 6, 16, Math.PI),
    mat(stone, { rough: 0.95 })
  );
  put(g, arc, 0, h, 0);
  return g;
}

/* 城墙：墙体 + 雉堞 + 扶壁 + 圆塔锥顶 */
function castleWall(rng, o = {}) {
  const { stone = 0x6e6a62, h = 8, len = 26, tower = true } = o;
  const g = new THREE.Group();

  put(g, box(len, h, 2.6, stone, { rough: 1 }), 0, 0, 0);

  // 雉堞：墙顶的骨牌齿，"城墙"最强的识别特征
  const n = Math.max(4, Math.round(len / 2.4));
  for (let i = 0; i < n; i++) {
    if (rng() > 0.9) continue;   // 偶尔缺一块，显得被打过
    put(g, box(1.3, 1.5, 2.6, stone, { rough: 1 }),
      -len / 2 + 1.2 + i * (len - 2.4) / (n - 1), h, 0);
  }

  // 扶壁：破掉"一整块板"的平
  for (let i = 0; i < 4; i++) {
    const b = box(0.8, h * 0.72, 1.2, stone, { rough: 1 });
    put(g, b, -len / 2 + len * (0.15 + i * 0.24), 0, 1.5);
    b.rotation.x = 0.12;
  }

  if (tower) {
    for (const sx of [-1, 1]) {
      put(g, cyl(2.0, 2.4, h + 3.5, stone, 12, { rough: 1 }), sx * (len / 2 - 1), 0, 0.6);
      put(g, cone(2.6, 2.8, 0x3a3630, 12, { rough: 1 }), sx * (len / 2 - 1), h + 3.5, 0.6);
    }
  }

  return g;
}

/* 沙袋垛：一排排横放的沙袋叠起来 */
function sandbagWall(rng, o = {}) {
  const { color = 0x8a7a5a, len = 6, rows = 3 } = o;
  const g = new THREE.Group();
  const perRow = Math.max(2, Math.round(len / 0.9));
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < perRow; i++) {
      const sb = box(0.86, 0.3, 0.5, color, { rough: 1 });
      put(g, sb, -len / 2 + 0.45 + i * 0.9 + (r % 2 ? 0.2 : 0), r * 0.3, (rng() - 0.5) * 0.1);
      sb.rotation.y = (rng() - 0.5) * 0.25;
    }
  }
  return g;
}

/* 反应罐：罐体 + 三道箍 + 顶盖 + 发光口 */
function tank(rng, o = {}) {
  const { body = 0x6a7a6a, trim = 0x4a5a4a, glow = 0x6aff9a, h = 4.6 } = o;
  const g = new THREE.Group();

  put(g, cyl(0.95, 1.15, h, body, 12, { rough: 0.6, metal: 0.4 }), 0, 0, 0);

  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.0 - i * 0.03, 0.07, 5, 14),
      mat(trim, { rough: 0.6, metal: 0.5 })
    );
    ring.rotation.x = Math.PI / 2;
    put(g, ring, 0, h * (0.25 + i * 0.25), 0);
  }

  put(g, cyl(1.0, 1.0, 0.2, trim, 12, { rough: 0.6, metal: 0.5 }), 0, h, 0);
  const cap = glowPlane(1.5, 1.5, glow, 0.5);
  cap.rotation.x = -Math.PI / 2;
  put(g, cap, 0, h + 0.22, 0);

  return g;
}

/* 龙门吊：四腿 + 横臂 + 配重 + 吊索 */
function crane(rng, o = {}) {
  const { steel = 0x53606a, rust = 0x7d4f33, h = 14 } = o;
  const g = new THREE.Group();

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      put(g, cyl(0.22, 0.28, h, steel, 6, { rough: 0.9, metal: 0.4 }), sx * 1.6, 0, sz * 1.6);
    }
  }
  put(g, box(12, 0.7, 0.8, rust, { rough: 0.9, metal: 0.35 }), 2, h, 0);
  put(g, box(1.6, 1.4, 1.2, 0x3a3a3a, { rough: 1 }), -3.6, h - 0.4, 0);

  const cable = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, h * 0.55, 4),
    mat(0x2a2a2a, { rough: 1 })
  );
  put(g, cable, 7.5, h - h * 0.27, 0);

  return g;
}

/* 集装箱堆：带竖棱的箱体（竖棱是集装箱的关键轮廓） */
function containerStack(rng, o = {}) {
  const { colors = [0x2f5f6b, 0x6b3f2f, 0x3f5f2f], count = 6 } = o;
  const g = new THREE.Group();

  for (let i = 0; i < count; i++) {
    const c = colors[i % colors.length];
    const w = 2.6, h = 2.4, d = 6.2;
    const stack = new THREE.Group();

    put(stack, box(w, h, d, c, { rough: 1 }), 0, 0, 0);
    for (let k = 0; k < 5; k++) {
      put(stack, box(w + 0.06, h * 0.92, 0.12, c, { rough: 1 }),
        0, h * 0.04, -d / 2 + 0.8 + k * (d - 1.6) / 4);
    }

    const side = i % 2 ? 1 : -1;
    stack.position.set(side * (11 + rng() * 3), (rng() > 0.65 ? h : 0), -22 + rng() * 24);
    stack.rotation.y = (rng() - 0.5) * 0.2;
    g.add(stack);
  }
  return g;
}

/* 护栏：立柱 + 两道横杆 */
function railing(rng, o = {}) {
  const { color = 0x8a8a86, len = 6, h = 1.3 } = o;
  const g = new THREE.Group();
  const n = Math.max(2, Math.round(len / 1.2));
  for (let i = 0; i <= n; i++) {
    put(g, cyl(0.07, 0.08, h, color, 5, { rough: 0.85, metal: 0.3 }), -len / 2 + i * len / n, 0, 0);
  }
  for (const y of [h * 0.55, h]) {
    put(g, box(len, 0.09, 0.09, color, { rough: 0.85, metal: 0.3 }), 0, y, 0);
  }
  return g;
}

/* 路灯：灯杆 + 弯臂 + 灯头 + 光晕 */
function streetLamp(rng, o = {}) {
  const { pole = 0x4a4f55, h = 6.5, lightColor = 0xffe0a0 } = o;
  const g = new THREE.Group();

  put(g, cyl(0.09, 0.13, h, pole, 6, { rough: 0.7, metal: 0.4 }), 0, 0, 0);

  const arm = cyl(0.06, 0.06, 1.2, pole, 5, { rough: 0.7, metal: 0.4 });
  arm.rotation.z = Math.PI / 2;
  put(g, arm, 0.5, h - 0.16, 0);

  put(g, box(0.7, 0.16, 0.34, pole, { rough: 0.6, metal: 0.5 }), 1.05, h - 0.32, 0);

  const halo = glowPlane(1.1, 1.1, lightColor, 0.32);
  halo.rotation.x = -Math.PI / 2;
  put(g, halo, 1.05, h - 0.36, 0);

  return g;
}

/* 管道：主管 + 法兰 + 支架 */
function pipeRun(rng, o = {}) {
  const { metal = 0x8a9a8a, rust = 0x6a4a2a, len = 8, h = 2.4 } = o;
  const g = new THREE.Group();
  const r = 0.22 + rng() * 0.14;
  const color = rng() > 0.6 ? rust : metal;

  const main = cyl(r, r, len, color, 9, { rough: 0.7, metal: 0.35 });
  main.rotation.z = Math.PI / 2;
  put(g, main, 0, h, 0);

  for (const sx of [-1, 1]) {
    const flange = cyl(r * 1.35, r * 1.35, 0.12, color, 9, { rough: 0.6, metal: 0.45 });
    flange.rotation.z = Math.PI / 2;
    put(g, flange, sx * len * 0.3, h, 0);
    put(g, cyl(0.08, 0.08, h, 0x5a5a5a, 5, { rough: 0.85, metal: 0.3 }), sx * len * 0.3, 0, 0);
  }

  return g;
}

/* 火盆：石圈 + 交叉木柴 + 三层火苗 */
function brazier(rng, o = {}, anim) {
  const { stone = 0x5a5148, wood: woodColor = 0x4a3520 } = o;
  const g = new THREE.Group();

  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const s = rock(rng, 0.2 + rng() * 0.1, stone);
    put(g, s, Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45);
  }
  for (let k = 0; k < 3; k++) {
    const lg = cyl(0.07, 0.09, 0.9, woodColor, 5, { rough: 1 });
    lg.rotation.z = Math.PI / 2;
    lg.rotation.y = (k / 3) * Math.PI;
    put(g, lg, 0, 0.12, 0);
  }
  // 三层火苗：橙 → 黄 → 白，加色混合才有"在烧"的亮度
  const flames = [[0.34, 0.8, 0xff6a20], [0.24, 0.58, 0xffa030], [0.13, 0.36, 0xfff0b0]];
  for (const [r, hh, c] of flames) {
    const f = new THREE.Mesh(
      new THREE.ConeGeometry(r, hh, 7),
      new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.78,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    put(g, f, 0, 0.28 + hh / 2, 0);
    if (anim) anim.push({ kind: 'pulse', obj: f, phase: rng() * 10, base: 0.78 });
  }

  return g;
}

/* 反登陆障碍（捷克刺猬）：三根交叉钢梁 */
function hedgehog(rng, o = {}) {
  const { steel = 0x5a5650 } = o;
  const g = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const beam = box(0.16, 1.9, 0.16, steel, { rough: 0.75, metal: 0.55 });
    beam.rotation.set((k - 1) * 0.85, k * 1.05, (k - 1) * 0.6);
    put(g, beam, 0, 0.95, 0);
  }
  return g;
}

/* 铁丝网：三柱 + 交叉斜线 */
function wireFence(rng, o = {}) {
  const { color = 0x6a6a60, h = 1.7 } = o;
  const g = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    put(g, cyl(0.06, 0.07, h, color, 5, { rough: 0.8, metal: 0.4 }), (k - 1) * 1.1, 0, 0);
  }
  for (let k = 0; k < 2; k++) {
    const seg = cyl(0.025, 0.025, 2.3, color, 4, { rough: 0.8, metal: 0.4 });
    seg.rotation.z = Math.PI / 2;
    seg.rotation.y = (k ? 1 : -1) * 0.5;
    put(g, seg, 0, h * 0.55, 0);
  }
  return g;
}

/* 天线杆：主杆 + 横撑 + 顶端红灯 */
function antennaMast(rng, o = {}) {
  const { color = 0x6a7a8a, h = 9 } = o;
  const g = new THREE.Group();
  put(g, cyl(0.08, 0.16, h, color, 6, { rough: 0.6, metal: 0.5 }), 0, 0, 0);

  for (let i = 0; i < 3; i++) {
    const span = 1.6 - i * 0.35;
    put(g, box(span * 2, 0.07, 0.07, color, { rough: 0.6, metal: 0.5 }), 0, h * (0.5 + i * 0.16), 0);
  }
  put(g, glowPlane(0.22, 0.22, 0xff3a2a, 0.85), 0, h + 0.14, 0);
  return g;
}

/* 歪斜桁架塔：末世感的标志物 */
function wreckTower(rng, o = {}) {
  const { color = 0x5a5248, rust = 0x7a4a2a, h = 7 } = o;
  const g = new THREE.Group();
  const lean = (rng() - 0.5) * 0.35;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = box(0.3, h * (0.7 + rng() * 0.3), 0.3, rng() > 0.5 ? color : rust, { rough: 1 });
      leg.rotation.z = lean;
      put(g, leg, sx * 1.1, 0, sz * 1.1);
    }
  }
  for (let i = 0; i < 3; i++) {
    const br = box(2.8, 0.16, 0.16, rust, { rough: 1 });
    br.rotation.z = (i % 2 ? 1 : -1) * 0.5;
    br.rotation.y = i * 0.6;
    put(g, br, 0, h * (0.25 + i * 0.22), 0);
  }
  return g;
}

/* 前景剪影：贴画面最下缘的暗带，做纵深 */
function silhouette(g, rng, color, count = 7) {
  const m = mat(color, { flat: true, rough: 1 });
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const h = 0.7 + rng() * 1.3;
    const w = 0.8 + rng() * 1.8;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.8), m);
    b.position.set(side * (4.2 + rng() * 7.5), h / 2 - 0.15, 16.5 + rng() * 3.5);
    b.rotation.y = rng() * Math.PI;
    b.rotation.z = (rng() - 0.5) * 0.12;
    g.add(b);
  }
}

/* 远景天际线：压在地平线外，只做高度和体积。
 * 横向范围**必须按该深度的可见宽度限制**——第一版写死 ±46，
 * 而 z=-48 时可见半宽只有约 20，于是三分之二的楼都跑到画面外了。 */
function skyline(g, rng, ctx, o = {}) {
  const { color = 0x141a22, count = 10, zBase = -46, hMin = 10, hMax = 26 } = o;
  for (let i = 0; i < count; i++) {
    const h = hMin + rng() * (hMax - hMin);
    const w = 5 + rng() * 7;
    const z = zBase - rng() * 12;
    const half = viewHalfX(ctx, z);
    // 铺满整个可见宽度，略微超出一点让边缘不留缝（超出部分靠雾吃掉）
    const bx = (-half * 1.02) + (i / Math.max(1, count - 1)) * (half * 2.04) + (rng() - 0.5) * 3;
    const b = box(w, h, 4 + rng() * 3, color, { rough: 1 });
    put(g, b, bx, 0, z);

    // 零星亮窗，让天际线不死板
    if (rng() > 0.5) {
      for (let k = 0; k < 3; k++) {
        put(g, glowPlane(0.7, 0.9, 0xffd88a, 0.22 + rng() * 0.28),
          bx - w / 2 + 1 + rng() * (w - 2), h * (0.4 + rng() * 0.5), zBase + 2.4);
      }
    }
  }
}

/* 水面：一片大平面压在远处 */
function water(g, o = {}) {
  const {
    color = 0x1d4a63, emissive = 0x0d2c40, ei = 0.9,
    y = -0.3, z = -58, w = 1.6, rough = 0.12, metal = 0.5,
  } = o;
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(180 * w, 130),
    new THREE.MeshStandardMaterial({
      color, emissive, emissiveIntensity: ei, roughness: rough, metalness: metal,
    })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0, y, z);
  g.add(sea);
}

/* 地面碎石：散落在战场外，填补空档 */
function rubble(g, rng, ctx, o = {}) {
  const { color = 0x5a564e, count = 24 } = o;
  bothSides(ctx, rng, { count: Math.max(2, Math.round(count / 4)), zMin: -32, zMax: 6 }, (x, z) => {
    for (let k = 0; k < 3; k++) {
      const r = 0.25 + rng() * 0.6;
      const m = rock(rng, r, color);
      put(g, m, x + (rng() - 0.5) * 2.4, r * 0.45, z + (rng() - 0.5) * 2.4);
      m.rotation.y = rng() * Math.PI;
    }
  });
}

/* ----------------------------------------------------------
 * 17 张地图
 *
 * 每张的 build(g, rng, anim, ctx) 都先用 bothSides 保证两侧有东西，
 * 再叠 1~2 个"标志物"（城堡 / 军舰 / 黑洞……）做辨识度。
 * ---------------------------------------------------------- */
export const NEW_MAPS = {
  /* ================= 中世纪 ================= */
  castle: {
    name: '城堡攻城',
    tex: 'b-map-castle', tint: 0xa8a094, roughness: 0.86,
    bg: 0x14161a, fogNear: 32, fogFar: 84,
    hemi: { sky: 0xa8b8c8, ground: 0x1a1a1e, intensity: 1.75 },
    key: { color: 0xfff0d8, intensity: 3.1 },
    fill: { color: 0x6a8ab0, intensity: 58, pos: [16, 12, -18] },
    build(g, rng, anim, ctx) {
      // 两侧城墙：这张图的主体，左右各一段（顺着画面竖着排）
      bothSides(ctx, rng, { count: 2, zMin: -34, zMax: -16 }, (x, z, r) => {
        const wall = castleWall(r, { stone: 0x6e6a62, h: 7 + r() * 2, len: 12, tower: r() > 0.4 });
        wall.position.set(x, 0, z);
        // 墙沿 z 方向展开：绕 y 轴转 90°
        wall.rotation.y = Math.PI / 2 + (r() - 0.5) * 0.25;
        g.add(wall);
      });

      // 攻城塔：只放一侧，做非对称标志
      const spot = pickSpot(ctx, rng, -28, -12);
      if (spot) {
        const t = wreckTower(rng, { color: 0x5a4a30, rust: 0x6a4020, h: 8 });
        t.position.set(spot.x, 0, spot.z);
        t.rotation.y = rng() * 0.6;
        g.add(t);
      }

      bothSides(ctx, rng, { count: 2, zMin: -24, zMax: -2 }, (x, z, r) => {
        const b = brazier(r, { stone: 0x5a5148 }, anim);
        b.position.set(x, 0, z);
        g.add(b);
      });

      rubble(g, rng, ctx, { color: 0x5a564e, count: 28 });
      silhouette(g, rng, 0x0e1014, 8);
    },
  },

  village: {
    name: '中世纪村庄',
    tex: 'b-map-village', tint: 0xb8a88c, roughness: 0.92,
    bg: 0x1a1610, fogNear: 34, fogFar: 88,
    hemi: { sky: 0xb8c8d0, ground: 0x2a2218, intensity: 1.75 },
    key: { color: 0xffe8c0, intensity: 2.9 },
    fill: { color: 0x8a7050, intensity: 54, pos: [14, 11, -16] },
    build(g, rng, anim, ctx) {
      // 两侧村舍：坡顶 + 亮窗，每侧 3 栋
      bothSides(ctx, rng, { count: 3, zMin: -32, zMax: -6 }, (x, z, r) => {
        const b = building(r, {
          wall: r() > 0.5 ? 0x9a8a70 : 0x8a7a62,
          roof: r() > 0.5 ? 0x5a4030 : 0x4a3528,
          w: 4.5 + r() * 2, h: 3.4 + r() * 1.6, d: 4.5 + r() * 1.5,
        });
        b.position.set(x, 0, z);
        b.rotation.y = (x > 0 ? -1 : 1) * (0.2 + r() * 0.5);
        g.add(b);
      });

      // 树
      bothSides(ctx, rng, { count: 3, zMin: -22, zMax: 2 }, (x, z, r) => {
        const t = tree(r, { trunk: 0x4a3a28, leaf: 0x2f5a32, h: 4.5 + r() * 2 });
        t.position.set(x, 0, z);
        g.add(t);
      });

      bothSides(ctx, rng, { count: 1, zMin: -14, zMax: -2 }, (x, z, r) => {
        const b = brazier(r, { stone: 0x5a5148 }, anim);
        b.position.set(x, 0, z);
        g.add(b);
      });
      bothSides(ctx, rng, { count: 2, zMin: -28, zMax: -4, opt: { minX: 9.2 } }, (x, z, r) => {
        const f = railing(r, { color: 0x6a5638, len: 5, h: 1.0 });
        f.rotation.y = Math.PI / 2;
        f.position.set(x, 0, z);
        g.add(f);
      });

      rubble(g, rng, ctx, { color: 0x6a5a48, count: 20 });
      silhouette(g, rng, 0x140f0a, 8);
    },
  },

  abbey: {
    name: '修道院',
    tex: 'b-map-abbey', tint: 0xb8b2a4, roughness: 0.72,
    bg: 0x121418, fogNear: 30, fogFar: 80,
    hemi: { sky: 0xb0bcc8, ground: 0x1a1a1c, intensity: 1.65 },
    key: { color: 0xf4f8ff, intensity: 2.9 },
    fill: { color: 0x5a7a9a, intensity: 50, pos: [14, 12, -18] },
    build(g, rng, anim, ctx) {
      // 两侧回廊：连续拱券，修道院最强的识别特征
      bothSides(ctx, rng, { count: 5, zMin: -34, zMax: 2 }, (x, z, r) => {
        const a = arch(r, { stone: 0x8a8478, w: 3.2, h: 4.2 });
        a.rotation.y = Math.PI / 2;
        a.position.set(x, 0, z);
        g.add(a);
      });

      // 回廊后墙 + 三块竖长花窗
      bothSides(ctx, rng, { count: 3, zMin: -32, zMax: 0, opt: { minX: 11.2 } }, (x, z, r) => {
        const wall = box(2.2, 6.5, 9, 0x8a8478, { rough: 0.95 });
        wall.position.set(x + (x > 0 ? 1.4 : -1.4), 3.25, z);
        g.add(wall);
        for (let k = 0; k < 3; k++) {
          const win = glowPlane(0.5, 2.2, [0xffd88a, 0x9ad0ff, 0xff9a7a][k], 0.38);
          win.rotation.y = -Math.PI / 2;
          win.position.set(x + (x > 0 ? 0.3 : -0.3), 3.4, z - 2.4 + k * 2.4);
          g.add(win);
        }
      });

      bothSides(ctx, rng, { count: 2, zMin: -20, zMax: -2 }, (x, z, r) => {
        const b = brazier(r, { stone: 0x6a6458 }, anim);
        b.position.set(x, 0, z);
        g.add(b);
      });

      rubble(g, rng, ctx, { color: 0x7a7468, count: 16 });
      silhouette(g, rng, 0x0e1012, 7);
    },
  },

  swamp: {
    name: '沼泽',
    tex: 'b-map-swamp', tint: 0x8a9a78, roughness: 0.96,
    bg: 0x121c16, fogNear: 24, fogFar: 72,
    hemi: { sky: 0x9ab8a0, ground: 0x1e2a22, intensity: 1.85 },
    key: { color: 0xe0f8d8, intensity: 2.95 },
    fill: { color: 0x4a8a6a, intensity: 54, pos: [14, 10, -16] },
    build(g, rng, anim, ctx) {
      // 黑水：沼泽的核心是"踩不到底的暗水"
      water(g, {
        color: 0x1a2e22, emissive: 0x0a1810, ei: 0.72,
        y: -0.1, z: -56, w: 1.5, rough: 0.14, metal: 0.45,
      });

      // 枯树：扭曲枝干
      bothSides(ctx, rng, { count: 4, zMin: -34, zMax: 2 }, (x, z, r) => {
        const t = deadTree(r, { trunk: 0x33301f, h: 5 + r() * 3 });
        t.rotation.y = r() * Math.PI;
        t.position.set(x, 0, z);
        g.add(t);
      });

      // 芦苇丛
      bothSides(ctx, rng, { count: 4, zMin: -30, zMax: 4, opt: { minX: 9.0 } }, (x, z, r) => {
        for (let k = 0; k < 7; k++) {
          const reed = cyl(0.02, 0.035, 0.9 + r() * 0.8, 0x4a5a30, 4, { rough: 1 });
          reed.rotation.z = (r() - 0.5) * 0.3;
          reed.position.set(x + (r() - 0.5) * 1.6, 0, z + (r() - 0.5) * 1.6);
          g.add(reed);
        }
      });

      // 沼气微光
      bothSides(ctx, rng, { count: 3, zMin: -24, zMax: 0 }, (x, z, r) => {
        const bub = glowPlane(0.5, 0.5, 0x8affb0, 0.32);
        bub.rotation.x = -Math.PI / 2;
        bub.position.set(x, 0.08, z);
        g.add(bub);
        anim.push({ kind: 'pulse', obj: bub, phase: r() * 10, base: 0.32 });
      });

      rubble(g, rng, ctx, { color: 0x3a4230, count: 18 });
      silhouette(g, rng, 0x08100a, 9);
    },
  },

  /* ================= 二战 ================= */
  trench: {
    name: '战壕',
    tex: 'b-map-trench', tint: 0x98907e, roughness: 0.95,
    bg: 0x1a1814, fogNear: 28, fogFar: 78,
    hemi: { sky: 0xb0a898, ground: 0x201c16, intensity: 1.75 },
    key: { color: 0xfff2d8, intensity: 2.95 },
    fill: { color: 0x8a6a4a, intensity: 58, pos: [16, 11, -18] },
    build(g, rng, anim, ctx) {
      // 两侧土堤 + 沙袋：战壕的横向剖面
      bothSides(ctx, rng, { count: 6, zMin: -34, zMax: 4 }, (x, z, r) => {
        const hh = 1.15 + r() * 0.4;
        const ridge = box(2.2, hh, 5.4, 0x4a4232, { rough: 1 });
        ridge.position.set(x + (x > 0 ? 0.5 : -0.5), hh / 2, z);
        g.add(ridge);

        const bags = sandbagWall(r, { color: 0x8a7a5a, len: 4.4, rows: 2 });
        bags.rotation.y = Math.PI / 2;
        bags.position.set(x, hh, z);
        g.add(bags);
      });

      // 铁丝网
      bothSides(ctx, rng, { count: 3, zMin: -30, zMax: 0, opt: { minX: 9.0 } }, (x, z, r) => {
        const f = wireFence(r, { color: 0x6a6a60, h: 1.7 });
        f.rotation.y = Math.PI / 2;
        f.position.set(x, 0, z);
        g.add(f);
      });

      // 废坦克：一侧一辆做标志物
      const spot = pickSpot(ctx, rng, -22, -8);
      if (spot) {
        const yaw = Math.PI / 2 + (rng() - 0.5) * 0.5;
        const hull = box(3.0, 1.1, 5.6, 0x5a6050, { rough: 0.9, metal: 0.35 });
        hull.rotation.y = yaw;
        hull.position.set(spot.x, 0.72, spot.z);
        g.add(hull);

        const turret = box(2.0, 0.9, 2.2, 0x4a5040, { rough: 0.9, metal: 0.35 });
        turret.rotation.y = yaw;
        turret.position.set(spot.x, 1.72, spot.z);
        g.add(turret);

        const barrel = cyl(0.11, 0.13, 3.2, 0x3a4030, 8, { rough: 0.85, metal: 0.4 });
        barrel.rotation.z = Math.PI / 2;
        barrel.rotation.y = yaw;
        barrel.position.set(spot.x + 2.0, 1.75, spot.z);
        g.add(barrel);
      }

      rubble(g, rng, ctx, { color: 0x4a4238, count: 22 });
      silhouette(g, rng, 0x0e0c08, 8);
    },
  },

  beach: {
    name: '登陆海滩',
    tex: 'b-map-beach', tint: 0xc8b898, roughness: 0.94,
    bg: 0x2a3038, fogNear: 38, fogFar: 98,
    hemi: { sky: 0xc8d4e0, ground: 0x4a4234, intensity: 1.75 },
    key: { color: 0xfff4e0, intensity: 3.0 },
    fill: { color: 0x5a8ab0, intensity: 58, pos: [18, 12, -20] },
    build(g, rng, anim, ctx) {
      // 海：海滩辨识度全靠这条
      water(g, {
        color: 0x1d4a63, emissive: 0x0d2c40, ei: 0.9,
        y: -0.22, z: -60, w: 1.8, rough: 0.1, metal: 0.55,
      });

      // 反登陆障碍：两侧都铺
      bothSides(ctx, rng, { count: 5, zMin: -30, zMax: 2 }, (x, z, r) => {
        const h = hedgehog(r, { steel: 0x5a5650 });
        h.rotation.y = r() * Math.PI;
        h.position.set(x, 0, z);
        g.add(h);
      });

      // 登陆艇残骸
      const spot = pickSpot(ctx, rng, -20, -6);
      if (spot) {
        const hull = box(3.2, 1.3, 6.5, 0x5a6050, { rough: 0.85, metal: 0.4 });
        hull.rotation.y = Math.PI / 2 + (rng() - 0.5) * 0.4;
        hull.rotation.z = 0.1;
        hull.position.set(spot.x, 0.62, spot.z);
        g.add(hull);

        const ramp = box(2.6, 0.2, 3.0, 0x4a5040, { rough: 0.9, metal: 0.3 });
        ramp.rotation.x = -0.35;
        ramp.position.set(spot.x, 0.42, spot.z - 4.0);
        g.add(ramp);
      }

      rubble(g, rng, ctx, { color: 0x8a7a60, count: 20 });
      silhouette(g, rng, 0x2a2620, 7);
    },
  },

  warport: {
    name: '军港',
    tex: 'b-map-warport', tint: 0x9aa0a8, roughness: 0.62,
    bg: 0x0c1218, fogNear: 34, fogFar: 92,
    hemi: { sky: 0x9ab0c0, ground: 0x10161c, intensity: 1.7 },
    key: { color: 0xe8f0ff, intensity: 2.9 },
    fill: { color: 0x3a6a90, intensity: 58, pos: [16, 12, -20] },
    build(g, rng, anim, ctx) {
      water(g, {
        color: 0x16384a, emissive: 0x0a1e28, ei: 0.85,
        y: -0.3, z: -58, w: 1.7, rough: 0.13, metal: 0.5,
      });

      // 军舰：地平线上的舰体 + 舰桥 + 主炮（两侧各一艘）。
      // 横向位置按 z=-44 的可见半宽收，不能写死 24（那时可见半宽只有约 19）
      const shipHalf = Math.min(16, viewHalfX(ctx, -44) * 0.82);
      for (const side of [-1, 1]) {
        const bx = side * shipHalf;
        put(g, box(15, 3.2, 26, 0x4a5258, { rough: 0.8, metal: 0.45 }), bx, 0, -44);
        put(g, box(6, 5, 7, 0x3a4248, { rough: 0.75, metal: 0.5 }), bx, 1.6, -44);
        put(g, cyl(1.6, 1.9, 1.4, 0x3a4248, 10, { rough: 0.7, metal: 0.5 }), bx, 1.6, -54);

        const gun = cyl(0.12, 0.16, 4.2, 0x2a3238, 8, { rough: 0.7, metal: 0.5 });
        gun.rotation.x = Math.PI / 2 - 0.15;
        gun.position.set(bx, 3.0, -53);
        g.add(gun);
      }

      // 龙门吊
      bothSides(ctx, rng, { count: 2, zMin: -30, zMax: -8 }, (x, z, r) => {
        const c = crane(r, { steel: 0x53606a, rust: 0x7d4f33, h: 12 + r() * 4 });
        c.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
        c.position.set(x, 0, z);
        g.add(c);
      });

      // 集装箱 + 系缆桩
      bothSides(ctx, rng, { count: 2, zMin: -26, zMax: 2 }, (x, z, r) => {
        const stack = containerStack(r, { count: 2 });
        stack.position.set(x, 0, z);
        g.add(stack);
      });
      bothSides(ctx, rng, { count: 3, zMin: -24, zMax: 4, opt: { minX: 9.0 } }, (x, z, r) => {
        put(g, cyl(0.22, 0.28, 0.7, 0x3a3a3a, 8, { rough: 0.8, metal: 0.5 }), x, 0, z);
      });

      silhouette(g, rng, 0x080c10, 7);
    },
  },

  /* ================= 现代 ================= */
  highway: {
    name: '城市高架',
    tex: 'b-map-highway', tint: 0xa0a6ae, roughness: 0.5,
    bg: 0x0d1116, fogNear: 32, fogFar: 88,
    hemi: { sky: 0xa0b4c8, ground: 0x121820, intensity: 1.7 },
    key: { color: 0xfff2e0, intensity: 3.1 },
    fill: { color: 0x4a7ab8, intensity: 62, pos: [16, 12, -18] },
    build(g, rng, anim, ctx) {
      // 两侧护栏：把画面挤成一条路
      bothSides(ctx, rng, { count: 7, zMin: -34, zMax: 6, opt: { minX: 8.9 } }, (x, z, r) => {
        const rl = railing(r, { color: 0x8a8a86, len: 5.4, h: 1.35 });
        rl.rotation.y = Math.PI / 2;
        rl.position.set(x, 0, z);
        g.add(rl);
      });

      // 支撑柱：高架桥的核心证据。
      // minX 别设太大：z=-4 处可见半宽只有约 12.5，minX:11 会让绝大多数位置判"没空间"
      bothSides(ctx, rng, { count: 3, zMin: -34, zMax: -10, opt: { minX: 10 } }, (x, z, r) => {
        put(g, cyl(1.0, 1.3, 13, 0x7a7a76, 10, { rough: 0.85 }), x, 0, z);
        put(g, box(5.5, 0.8, 1.6, 0x6a6a66, { rough: 0.85 }), x, 12.6, z);
      });

      // 路灯
      bothSides(ctx, rng, { count: 2, zMin: -26, zMax: -6 }, (x, z, r) => {
        const lp = streetLamp(r, { pole: 0x4a4f55, h: 7, lightColor: 0xffe0a0 });
        lp.rotation.y = x > 0 ? Math.PI : 0;
        lp.position.set(x, 0, z);
        g.add(lp);
      });

      // 废车
      bothSides(ctx, rng, { count: 2, zMin: -24, zMax: 2 }, (x, z, r) => {
        const c = car(r, { body: 0x6a7080, glass: 0x2a3a48, flip: r() > 0.7 });
        c.rotation.y = Math.PI / 2 + (r() - 0.5) * 0.8;
        c.position.set(x, 0, z);
        g.add(c);
      });

      skyline(g, rng, ctx, { color: 0x141a22, count: 11, zBase: -48, hMin: 12, hMax: 30 });
      silhouette(g, rng, 0x090c10, 7);
    },
  },

  parking: {
    name: '地下停车场',
    tex: 'b-map-parking', tint: 0x9aa0a8, roughness: 0.55,
    bg: 0x0e1218, fogNear: 26, fogFar: 74,
    hemi: { sky: 0x94a4b4, ground: 0x12161c, intensity: 1.62 },
    key: { color: 0xe4eef8, intensity: 3.0 },
    fill: { color: 0x4a6a90, intensity: 52, pos: [14, 10, -16] },
    build(g, rng, anim, ctx) {
      // 两侧承重柱：停车场最典型的视觉
      bothSides(ctx, rng, { count: 6, zMin: -34, zMax: 6 }, (x, z, r) => {
        put(g, box(1.3, 3.9, 1.3, 0x8a8e92, { rough: 0.8 }), x, 1.95, z);
        // 柱脚黄黑警示漆
        put(g, box(1.36, 0.35, 1.36, 0xc8a630, { rough: 0.7 }), x, 0.5, z);
      });

      // 顶灯
      bothSides(ctx, rng, { count: 3, zMin: -30, zMax: 0, opt: { minX: 9.5 } }, (x, z, r) => {
        const tube = new THREE.Mesh(
          new THREE.BoxGeometry(2.8, 0.16, 0.34),
          new THREE.MeshBasicMaterial({ color: 0xe8f0ff, fog: true })
        );
        tube.position.set(x, 3.6, z);
        g.add(tube);
        anim.push({ kind: 'pulse', obj: tube, phase: r() * 10, base: 0.9 });
      });

      // 车位线
      bothSides(ctx, rng, { count: 5, zMin: -30, zMax: 4, opt: { minX: 8.8 } }, (x, z, r) => {
        const line = new THREE.Mesh(
          new THREE.PlaneGeometry(0.12, 4.6),
          new THREE.MeshBasicMaterial({ color: 0xd8d8c8, transparent: true, opacity: 0.25 })
        );
        line.rotation.x = -Math.PI / 2;
        line.position.set(x, 0.02, z);
        g.add(line);
      });

      // 废车
      bothSides(ctx, rng, { count: 2, zMin: -24, zMax: 0 }, (x, z, r) => {
        const c = car(r, { body: 0x5a6070, glass: 0x1a2a38, flip: r() > 0.75 });
        c.rotation.y = Math.PI / 2 + (r() - 0.5) * 0.5;
        c.position.set(x, 0, z);
        g.add(c);
      });

      silhouette(g, rng, 0x06080a, 6);
    },
  },

  /* ================= 后现代 ================= */
  quarantine: {
    name: '隔离区',
    tex: 'b-map-quarantine', tint: 0xb4c4b4, roughness: 0.5,
    bg: 0x0e1816, fogNear: 28, fogFar: 78,
    hemi: { sky: 0xb0d0c0, ground: 0x14201c, intensity: 1.62 },
    key: { color: 0xeafff6, intensity: 2.95 },
    fill: { color: 0x4ad9a0, intensity: 54, pos: [14, 11, -16] },
    build(g, rng, anim, ctx) {
      // 两侧隔离舱：舱体 + 内部绿光 + 舱顶警示灯
      bothSides(ctx, rng, { count: 4, zMin: -32, zMax: 2 }, (x, z, r) => {
        put(g, box(2.2, 2.8, 4.0, 0x8a9a94, { rough: 0.3, metal: 0.35 }), x, 1.4, z);

        const win = glowPlane(1.6, 2.0, 0x4ad9a0, 0.4);
        win.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
        win.position.set(x + (x > 0 ? -1.12 : 1.12), 1.5, z);
        g.add(win);
        anim.push({ kind: 'pulse', obj: win, phase: r() * 10, base: 0.4 });

        const beacon = glowPlane(0.3, 0.3, 0xff5a4a, 0.8);
        beacon.rotation.x = -Math.PI / 2;
        beacon.position.set(x, 3.0, z);
        g.add(beacon);
      });

      // 隔离塑料帘
      bothSides(ctx, rng, { count: 3, zMin: -28, zMax: 4, opt: { minX: 9.0 } }, (x, z, r) => {
        const curtain = new THREE.Mesh(
          new THREE.PlaneGeometry(2.4, 2.2),
          new THREE.MeshStandardMaterial({
            color: 0xc8e0d8, transparent: true, opacity: 0.2,
            side: THREE.DoubleSide, depthWrite: false, roughness: 0.2,
          })
        );
        curtain.rotation.y = Math.PI / 2;
        curtain.position.set(x, 1.1, z);
        g.add(curtain);
      });

      // 病床
      bothSides(ctx, rng, { count: 2, zMin: -22, zMax: -2 }, (x, z, r) => {
        put(g, box(1.1, 0.18, 2.3, 0x9aa8a2, { rough: 0.6, metal: 0.3 }), x, 0.66, z);
        put(g, box(1.0, 0.16, 2.1, 0xd8d2c4, { rough: 0.95 }), x, 0.82, z);
        for (const [lx, lz] of [[-0.45, -1.0], [0.45, -1.0], [-0.45, 1.0], [0.45, 1.0]]) {
          put(g, cyl(0.05, 0.05, 0.62, 0x8a9892, 5, { rough: 0.6, metal: 0.3 }), x + lx, 0, z + lz);
        }
      });

      silhouette(g, rng, 0x070c0a, 7);
    },
  },

  biofactory: {
    name: '生化工厂',
    tex: 'b-map-biofactory', tint: 0x8a9a8a, roughness: 0.68,
    bg: 0x0a100c, fogNear: 28, fogFar: 80,
    hemi: { sky: 0x90b098, ground: 0x101814, intensity: 1.5 },
    key: { color: 0xd8ffe0, intensity: 2.75 },
    fill: { color: 0x3aa060, intensity: 56, pos: [15, 11, -18] },
    build(g, rng, anim, ctx) {
      // 两侧反应罐
      bothSides(ctx, rng, { count: 4, zMin: -32, zMax: 2 }, (x, z, r) => {
        const t = tank(r, { body: 0x6a7a6a, trim: 0x4a5a4a, glow: 0x6aff9a, h: 4 + r() * 1.6 });
        t.position.set(x, 0, z);
        g.add(t);
      });

      // 厂房：铁皮棚 + 屋顶瓦楞
      bothSides(ctx, rng, { count: 2, zMin: -30, zMax: -6, opt: { minX: 12 } }, (x, z, r) => {
        const w = 7 + r() * 3, hh = 5 + r() * 2, dd = 8 + r() * 3;
        const cx = x + (x > 0 ? 1.6 : -1.6);
        put(g, box(w, hh, dd, 0x5a6a5a, { rough: 0.85, metal: 0.35 }), cx, hh / 2, z);
        for (let k = 0; k < 5; k++) {
          put(g, box(w + 0.1, 0.22, 0.4, 0x4a5a4a, { rough: 0.85, metal: 0.4 }),
            cx, hh + 0.11, z - dd / 2 + 0.8 + k * (dd - 1.6) / 4);
        }
      });

      // 管道
      bothSides(ctx, rng, { count: 3, zMin: -28, zMax: 0, opt: { minX: 9.4 } }, (x, z, r) => {
        const pr = pipeRun(r, { metal: 0x8a9a8a, rust: 0x6a4a2a, len: 7, h: 2.2 + r() });
        pr.rotation.y = Math.PI / 2;
        pr.position.set(x, 0, z);
        g.add(pr);
      });

      silhouette(g, rng, 0x060a08, 8);
    },
  },

  /* ================= 星际 ================= */
  station: {
    name: '空间站内部',
    tex: 'b-map-station', tint: 0xa8b8cc, roughness: 0.35,
    bg: 0x080c12, fogNear: 28, fogFar: 76,
    hemi: { sky: 0x9ab0cc, ground: 0x10161c, intensity: 1.62 },
    key: { color: 0xeaf6ff, intensity: 3.1 },
    fill: { color: 0x3a9ad0, intensity: 54, pos: [14, 11, -16] },
    build(g, rng, anim, ctx) {
      // 两侧舱壁：带加强筋和舷窗
      bothSides(ctx, rng, { count: 6, zMin: -34, zMax: 4 }, (x, z, r) => {
        const hh = 4.4 + r() * 1.6;
        const w = 6 + r() * 3;
        const cx = x + (x > 0 ? 1.3 : -1.3);

        put(g, box(2.6, hh, w, 0x5a6a7a, { rough: 0.5, metal: 0.6 }), cx, hh / 2, z);
        for (let k = 0; k < 3; k++) {
          put(g, box(2.8, hh * 0.94, 0.24, 0x3a4652, { rough: 0.4, metal: 0.7 }),
            cx, hh / 2, z - w / 2 + 1 + k * (w - 2) / 2);
        }

        const win = glowPlane(1.5, 0.9, 0x4ad9ff, 0.48);
        win.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
        win.position.set(x + (x > 0 ? -0.02 : 0.02), hh * 0.6, z);
        g.add(win);
        anim.push({ kind: 'pulse', obj: win, phase: r() * 10, base: 0.48 });
      });

      // 地板格栅
      for (let i = 0; i < 10; i++) {
        const strip = new THREE.Mesh(
          new THREE.PlaneGeometry(17, 0.1),
          new THREE.MeshBasicMaterial({ color: 0x6a90b0, transparent: true, opacity: 0.16 })
        );
        strip.rotation.x = -Math.PI / 2;
        strip.position.set(0, 0.015, -28 + i * 4.2);
        g.add(strip);
      }

      // 顶灯
      bothSides(ctx, rng, { count: 3, zMin: -30, zMax: 0, opt: { minX: 9.6 } }, (x, z, r) => {
        const tube = new THREE.Mesh(
          new THREE.BoxGeometry(2.6, 0.14, 0.3),
          new THREE.MeshBasicMaterial({ color: 0xdff0ff, fog: true })
        );
        tube.position.set(x, 3.7, z);
        g.add(tube);
        anim.push({ kind: 'pulse', obj: tube, phase: r() * 10, base: 0.9 });
      });

      silhouette(g, rng, 0x04060a, 6);
    },
  },

  alienwaste: {
    name: '外星荒漠',
    tex: 'b-map-alienwaste', tint: 0xa08a90, roughness: 0.92,
    bg: 0x18101a, fogNear: 34, fogFar: 92,
    hemi: { sky: 0xb09ac0, ground: 0x2a1828, intensity: 1.58 },
    key: { color: 0xffd8f0, intensity: 2.85 },
    fill: { color: 0x7a4aa0, intensity: 54, pos: [16, 11, -18] },
    build(g, rng, anim, ctx) {
      // 两侧尖岩柱：外星地貌的骨架
      bothSides(ctx, rng, { count: 5, zMin: -34, zMax: 2 }, (x, z, r) => {
        const h = 3 + r() * 6;
        put(g, cyl(0.25 + r() * 0.3, 1.1 + r() * 0.8, h, 0x6a5a70, 7, { rough: 1 }), x, 0, z);
        if (r() > 0.4) {
          put(g, cone(0.5 + r() * 0.3, 1.4 + r() * 1.2, 0x5a4a60, 6, { rough: 1 }), x, h, z);
        }
      });

      // 发光晶体：外星标志物
      bothSides(ctx, rng, { count: 3, zMin: -26, zMax: 0 }, (x, z, r) => {
        const cr = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.4 + r() * 0.4),
          new THREE.MeshBasicMaterial({
            color: 0xc06aff, transparent: true, opacity: 0.58,
            blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        cr.position.set(x, 0.5 + r() * 0.6, z);
        g.add(cr);
        anim.push({ kind: 'pulse', obj: cr, phase: r() * 10, base: 0.58 });
      });

      rubble(g, rng, ctx, { color: 0x7a6a80, count: 26 });
      silhouette(g, rng, 0x0c0810, 8);
    },
  },

  orbitalpad: {
    name: '轨道平台',
    tex: 'b-map-orbitalpad', tint: 0x8a98a8, roughness: 0.42,
    bg: 0x04060a, fogNear: 32, fogFar: 86,
    hemi: { sky: 0x8a9cb0, ground: 0x080c12, intensity: 1.3 },
    key: { color: 0xe8f4ff, intensity: 2.9 },
    fill: { color: 0x2a7ab0, intensity: 48, pos: [15, 12, -18] },
    build(g, rng, anim, ctx) {
      // 平台边缘护栏：外侧就是虚空
      bothSides(ctx, rng, { count: 7, zMin: -34, zMax: 6, opt: { minX: 9.0 } }, (x, z, r) => {
        const rl = railing(r, { color: 0x5a6a7a, len: 5, h: 1.3 });
        rl.rotation.y = Math.PI / 2;
        rl.position.set(x, 0, z);
        g.add(rl);
      });

      // 星球：巨大半圆压在地平线
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(28, 24, 16),
        new THREE.MeshStandardMaterial({
          color: 0x4a5a7a, emissive: 0x1a2a3a, emissiveIntensity: 0.55,
          roughness: 0.9, flatShading: true,
        })
      );
      planet.position.set(-20, -8, -80);
      g.add(planet);

      // 天线阵
      bothSides(ctx, rng, { count: 3, zMin: -30, zMax: -2 }, (x, z, r) => {
        const m = antennaMast(r, { color: 0x6a7a8a, h: 8 + r() * 4 });
        m.position.set(x, 0, z);
        g.add(m);
      });

      // 停机坪标记
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(2.2, 2.5, 24),
          new THREE.MeshBasicMaterial({
            color: 0x4ad9ff, transparent: true, opacity: 0.18,
            side: THREE.DoubleSide, depthWrite: false,
          })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, 0.02, -22 + i * 10);
        g.add(ring);
      }

      silhouette(g, rng, 0x03050a, 7);
    },
  },

  /* ================= 终幕 ================= */
  voidtemple: {
    name: '虚空神殿',
    tex: 'b-map-voidtemple', tint: 0x7a6a78, roughness: 0.82,
    bg: 0x12081a, fogNear: 30, fogFar: 82,
    hemi: { sky: 0x8a7aa0, ground: 0x140a1c, intensity: 1.8 },
    key: { color: 0xffe8d8, intensity: 3.2 },
    fill: { color: 0x9a3a6a, intensity: 58, pos: [15, 11, -18] },
    build(g, rng, anim, ctx) {
      // 两侧立柱：柱础 + 柱身 + 柱头 + 柱顶符文环
      bothSides(ctx, rng, { count: 4, zMin: -34, zMax: 2 }, (x, z, r) => {
        const h = 7 + r() * 4;
        put(g, box(1.6, 0.35, 1.6, 0x3a2f38, { rough: 0.95 }), x, 0, z);
        put(g, cyl(0.6, 0.85, h, 0x4a3f4a, 8, { rough: 0.9, metal: 0.15 }), x, 0.35, z);
        put(g, box(1.5, 0.3, 1.5, 0x3a2f38, { rough: 0.95 }), x, h + 0.35, z);

        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.95, 0.08, 6, 16),
          new THREE.MeshBasicMaterial({
            color: 0xff5a2a, transparent: true, opacity: 0.62,
            blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.set(x, h + 1.2, z);
        g.add(ring);
        anim.push({ kind: 'pulse', obj: ring, phase: r() * 10, base: 0.62 });
      });

      // 地面符文环
      for (let i = 0; i < 2; i++) {
        const glyph = new THREE.Mesh(
          new THREE.RingGeometry(3.4, 3.9, 32),
          new THREE.MeshBasicMaterial({
            color: 0xff5a2a, transparent: true, opacity: 0.13,
            side: THREE.DoubleSide, depthWrite: false,
          })
        );
        glyph.rotation.x = -Math.PI / 2;
        glyph.position.set(0, 0.02, -16 + i * 14);
        g.add(glyph);
      }

      // 悬浮碎块
      bothSides(ctx, rng, { count: 3, zMin: -28, zMax: 0 }, (x, z, r) => {
        for (let k = 0; k < 3; k++) {
          const s = rock(r, 0.3 + r() * 0.5, 0x4a3f4a);
          s.position.set(x + (r() - 0.5) * 2, 2.5 + r() * 5, z + (r() - 0.5) * 2);
          s.rotation.set(r() * 3, r() * 3, r() * 3);
          g.add(s);
        }
      });

      bothSides(ctx, rng, { count: 2, zMin: -22, zMax: -2 }, (x, z, r) => {
        const b = brazier(r, { stone: 0x3a2f38 }, anim);
        b.position.set(x, 0, z);
        g.add(b);
      });

      silhouette(g, rng, 0x06040a, 8);
    },
  },

  timeruins: {
    name: '时间废墟',
    tex: 'b-map-timeruins', tint: 0x8e8e9c, roughness: 0.9,
    bg: 0x100e18, fogNear: 28, fogFar: 78,
    hemi: { sky: 0xa8a0bc, ground: 0x161220, intensity: 1.68 },
    key: { color: 0xe8e0ff, intensity: 2.95 },
    fill: { color: 0x6a5aa0, intensity: 54, pos: [14, 11, -16] },
    build(g, rng, anim, ctx) {
      // 两侧断柱：高度参差，断口不规则
      bothSides(ctx, rng, { count: 5, zMin: -34, zMax: 2 }, (x, z, r) => {
        const c = brokenColumn(r, { stone: 0x7a7a86, h: 1.6 + r() * 4.5 });
        c.position.set(x, 0, z);
        g.add(c);
      });

      // 断墙：参差顶部
      bothSides(ctx, rng, { count: 2, zMin: -30, zMax: -8, opt: { minX: 11.5 } }, (x, z, r) => {
        const h = 2.5 + r() * 2.5;
        const cx = x + (x > 0 ? 1 : -1);
        put(g, box(2.0, h, 8, 0x6a6a76, { rough: 0.95 }), cx, h / 2, z);
        for (let k = 0; k < 5; k++) {
          const jag = box(0.9, 0.3 + r() * 0.8, 1.4, 0x6a6a76, { rough: 0.95 });
          jag.rotation.z = (r() - 0.5) * 0.4;
          put(g, jag, cx, h + 0.3, z - 3.4 + k * 1.7);
        }
      });

      // 悬浮钟环
      bothSides(ctx, rng, { count: 3, zMin: -26, zMax: 0 }, (x, z, r) => {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.95, 0.07, 6, 18),
          new THREE.MeshBasicMaterial({
            color: 0x9a8aff, transparent: true, opacity: 0.5,
            blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        ring.position.set(x, 3 + r() * 3.5, z);
        g.add(ring);
        anim.push({ kind: 'spin', obj: ring, phase: r() * 10, base: 0.5 });
      });

      rubble(g, rng, ctx, { color: 0x5a5a66, count: 22 });
      silhouette(g, rng, 0x07050c, 8);
    },
  },

  blackhole: {
    name: '黑洞边缘',
    tex: 'b-map-blackhole', tint: 0x8890a0, roughness: 0.94,
    bg: 0x03040a, fogNear: 36, fogFar: 96,
    hemi: { sky: 0x8090b0, ground: 0x06080c, intensity: 1.18 },
    key: { color: 0xd8e0ff, intensity: 2.6 },
    fill: { color: 0x4a3aa0, intensity: 46, pos: [-16, 12, -18] },
    build(g, rng, anim, ctx) {
      // 黑洞本体 + 三层吸积盘
      const hole = new THREE.Mesh(
        new THREE.SphereGeometry(12, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
      );
      hole.position.set(22, 18, -84);
      g.add(hole);

      for (let i = 0; i < 3; i++) {
        const disk = new THREE.Mesh(
          new THREE.RingGeometry(13 + i * 2.6, 14.8 + i * 2.6, 44),
          new THREE.MeshBasicMaterial({
            color: i === 1 ? 0xc0a0ff : 0x6a4aff,
            transparent: true, opacity: 0.36 - i * 0.1,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        disk.position.copy(hole.position);
        disk.rotation.x = -0.55;
        g.add(disk);
        anim.push({ kind: 'spin', obj: disk, phase: rng() * 10, base: 0.36 });
      }

      // 潮汐撕裂的岩块：被拉长的碎石，两侧都有
      bothSides(ctx, rng, { count: 5, zMin: -32, zMax: 2 }, (x, z, r) => {
        for (let k = 0; k < 2; k++) {
          const s = rock(r, 0.4 + r() * 1.0, 0x4a4f5a);
          s.scale.set(1 + r() * 1.3, 0.65, 0.65);
          s.position.set(x + (r() - 0.5) * 2.5, 0.2 + r() * 1.6, z + (r() - 0.5) * 2.5);
          g.add(s);
        }
      });

      silhouette(g, rng, 0x02030a, 7);
    },
  },
};

/* 地图列表给 UI 用 */
export const NEW_MAP_LIST = Object.entries(NEW_MAPS).map(([id, m]) => ({
  id,
  name: m.name,
}));

/** 每张新图属于哪个时代 */
export const NEW_MAP_ERA = {
  castle: 0, village: 0, abbey: 0, swamp: 0,
  trench: 1, beach: 1, warport: 1,
  highway: 2, parking: 2,
  quarantine: 3, biofactory: 3,
  station: 4, alienwaste: 4, orbitalpad: 4,
  voidtemple: 5, timeruins: 5, blackhole: 5,
};

export function isNewMap(mapId) {
  return Object.prototype.hasOwnProperty.call(NEW_MAPS, mapId);
}

/* ==========================================================================
 * 近景两侧大件（flank）
 *
 * 为什么单独加这一层：
 * 之前的道具大多摆在中远景（z −20 ~ −44），那里 1 个单位只占几个像素，
 * 一栋 20 米高的楼在屏幕上也就一百多像素，看起来仍然像"远处几个方块"。
 *
 * 这一层摆在中近景（z −8 ~ +8），贴近相机，**故意让它被画面左右边缘裁掉一部分**：
 * 只露出一半的墙、只露出屋顶的房子，才是真实的第一人称框景，
 * 也是让人一眼觉得"这地方有东西"的关键。全部露出反而像贴图。
 * ========================================================================== */

/* ---- 零件配方：每个都堆出轮廓，不用单个方块 ---- */

function fxWall(g, rng, a, b) {
  const w = 1.6 + rng() * 1.4;
  const h = 2.2 + rng() * 2.2;
  const body = box(w, h, 0.7, a, { rough: 0.95 });
  g.add(body);
  // 顶部压一圈稍宽的墙檐，边界立刻清楚
  put(g, box(w * 1.12, 0.18, 0.86, b, { rough: 1 }), 0, h + 0.09, 0);
  // 扶壁
  const nb = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < nb; i++) {
    const px = (-0.5 + (i + 0.5) / nb) * w;
    put(g, box(w * 0.13, h * 0.7, 0.95, b, { rough: 1 }), px, h * 0.35, 0);
  }
  // 墙上的裂口
  put(g, box(w * 0.18, h * 0.22, 0.76, 0x0a0d10, { rough: 1 }), w * 0.2, h * 0.62, 0);
}

function fxHouse(g, rng, a, b) {
  const w = 2.0 + rng() * 1.6;
  const d = 1.8 + rng() * 1.2;
  const h = 1.8 + rng() * 1.6;
  g.add(box(w, h, d, a, { rough: 0.9 }));
  // 坡屋顶：用旋转 45° 的扁盒子冒充双坡，俯视下轮廓对
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.16, 0.5, d * 1.14), mat(b, { rough: 1 }));
  roof.position.y = h + 0.16;
  roof.rotation.z = 0.06;
  g.add(roof);
  put(g, box(0.22, 0.9, 0.22, b, { rough: 1 }), w * 0.3, h + 0.55, -d * 0.2);   // 烟囱
  // 一排窗，暖光
  const winMat = mat(0xffb866, { emissive: 0.7, rough: 0.6 });
  const nc = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < nc; i++) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.34), winMat);
    win.position.set((-0.5 + (i + 0.5) / nc) * w, h * 0.58, d / 2 + 0.01);
    g.add(win);
  }
  // 门
  put(g, box(0.3, 0.7, 0.06, 0x1a120c, { rough: 1 }), -w * 0.22, 0.35, d / 2 + 0.02);
}

function fxTree(g, rng, a, b) {
  const h = 2.0 + rng() * 2.4;
  const trunk = cyl(0.11, 0.17, h, a, 7, { rough: 1 });
  g.add(trunk);
  // 两三条斜枝
  const nBr = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < nBr; i++) {
    const br = cyl(0.04, 0.07, h * 0.42, a, 5, { rough: 1 });
    br.position.set(0, h * 0.6, 0);
    br.rotation.z = (rng() - 0.5) * 1.5;
    br.rotation.x = (rng() - 0.5) * 1.1;
    g.add(br);
  }
  // 3~5 个大小不一的圆冠
  const nc = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < nc; i++) {
    const r = 0.42 + rng() * 0.5;
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), mat(b, { rough: 1, flat: true }));
    crown.position.set((rng() - 0.5) * 0.9, h + (rng() - 0.4) * 0.8, (rng() - 0.5) * 0.9);
    crown.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(crown);
  }
}

function fxRock(g, rng, a) {
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = 0.5 + rng() * 1.1;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), mat(a, { rough: 1, flat: true }));
    rock.position.set((rng() - 0.5) * 1.6, r * 0.75, (rng() - 0.5) * 1.4);
    rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    rock.scale.y = 0.7 + rng() * 0.5;
    g.add(rock);
  }
}

function fxTank(g, rng, a, b) {
  const r = 0.55 + rng() * 0.35;
  const h = 2.0 + rng() * 1.6;
  const body = cyl(r, r, h, a, 12, { rough: 0.6, metal: 0.4 });
  g.add(body);
  // 三道箍
  for (let i = 1; i <= 3; i++) {
    const ring = cyl(r * 1.06, r * 1.06, 0.1, b, 12, { rough: 0.8 });
    ring.position.y = (h * i) / 4;
    g.add(ring);
  }
  put(g, cyl(r * 0.5, r * 0.5, 0.18, b, 10, { rough: 0.5 }), 0, h + 0.09, 0);  // 顶盖
  // 顶部发光口
  const glow = new THREE.Mesh(new THREE.SphereGeometry(r * 0.34, 8, 6), mat(0x66e0ff, { emissive: 1.2, rough: 0.3 }));
  glow.position.y = h + 0.24;
  g.add(glow);
  // 侧面管道
  put(g, cyl(0.08, 0.08, 1.5, b, 6, { rough: 0.7, metal: 0.5 }), r + 0.1, 0.75, 0).rotation.z = Math.PI / 2;
}

function fxPillar(g, rng, a, b) {
  const h = 2.6 + rng() * 2.6;
  g.add(cyl(0.26, 0.32, h, a, 8, { rough: 0.9 }));
  put(g, cyl(0.42, 0.34, 0.2, b, 8, { rough: 0.9 }), 0, 0.1, 0);        // 柱础
  put(g, cyl(0.4, 0.4, 0.18, b, 8, { rough: 0.9 }), 0, h - 0.05, 0);   // 柱头
  // 断柱：顶部缺一块
  if (rng() < 0.5) {
    const chip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), mat(0x0d1014, { rough: 1 }));
    chip.position.set(0.2, h - 0.2, 0.1);
    g.add(chip);
  }
}

function fxStall(g, rng, a, b) {
  const w = 1.5 + rng() * 0.8;
  g.add(box(w, 0.9, 1.1, a, { rough: 0.95 }));
  // 四根杆 + 斜顶棚
  for (const sx of [-0.42, 0.42]) {
    for (const sz of [-0.4, 0.4]) {
      put(g, cyl(0.05, 0.05, 1.2, b, 5, { rough: 0.9 }), sx * w, 1.5, sz * 1.1);
    }
  }
  const cloth = new THREE.Mesh(new THREE.BoxGeometry(w * 1.1, 0.08, 1.5), mat(b, { rough: 0.85 }));
  cloth.position.y = 2.05;
  cloth.rotation.z = 0.1;
  g.add(cloth);
}

function fxCrate(g, rng, a, b) {
  const n = 2 + Math.floor(rng() * 3);
  let stackY = 0;
  for (let i = 0; i < n; i++) {
    const s = 0.6 + rng() * 0.4;
    const c = box(s, s, s, a, { rough: 0.9 });
    c.position.set((rng() - 0.5) * 0.5, stackY + s / 2, (rng() - 0.5) * 0.5);
    c.rotation.y = rng() * 0.6;
    g.add(c);
    // 木箱的十字加强条
    put(g, box(s * 1.02, 0.07, 0.07, b, { rough: 1 }), 0, 0, 0);
    stackY += s * 0.95;
  }
}

const FLANK_KINDS = {
  wall: fxWall, house: fxHouse, tree: fxTree, rock: fxRock,
  tank: fxTank, pillar: fxPillar, stall: fxStall, crate: fxCrate,
};

/* 每张地图的近景件：按气质挑。a 是主体色，b 是配色（檐口/箍/棚布） */
const FLANK_CONF = {
  // 原有 9 张
  city:       { kind: 'house',  a: 0x2c333c, b: 0x141920 },
  jungle:     { kind: 'tree',   a: 0x3b2f1f, b: 0x1d3a1c },
  desert:     { kind: 'rock',   a: 0x7a5f3c },
  moon:       { kind: 'rock',   a: 0x6a6e78 },
  snow:       { kind: 'tree',   a: 0x2b3038, b: 0x8fa4b4 },
  lava:       { kind: 'rock',   a: 0x3a1e16 },
  base:       { kind: 'wall',   a: 0x3a4148, b: 0x1c2228 },
  lab:        { kind: 'pillar', a: 0x6e7a80, b: 0x39434a },
  harbor:     { kind: 'crate',  a: 0x4a5560, b: 0x2a323a },
  // 17 张新图
  castle:     { kind: 'wall',   a: 0x6b6255, b: 0x3c372f },
  village:    { kind: 'house',  a: 0x6a5a44, b: 0x3a2f22 },
  abbey:      { kind: 'pillar', a: 0x8a8478, b: 0x4c473e },
  swamp:      { kind: 'tree',   a: 0x3a3428, b: 0x2c3f26 },
  trench:     { kind: 'crate',  a: 0x5c5140, b: 0x332c22 },
  beach:      { kind: 'rock',   a: 0x8a7a5e },
  warport:    { kind: 'crate',  a: 0x3f4a54, b: 0x232b32 },
  highway:    { kind: 'pillar', a: 0x4a4f56, b: 0x24282e },
  parking:    { kind: 'pillar', a: 0x5a6068, b: 0x2c3138 },
  quarantine: { kind: 'tank',   a: 0x8a9a94, b: 0x47544f },
  biofactory: { kind: 'tank',   a: 0x5c6a58, b: 0x2e372c },
  station:    { kind: 'wall',   a: 0x7a848e, b: 0x3e464e },
  alienwaste: { kind: 'rock',   a: 0x6a5a76 },
  orbitalpad: { kind: 'tank',   a: 0x5e6870, b: 0x303840 },
  voidtemple: { kind: 'pillar', a: 0x4a3a4a, b: 0x8a4a3a },
  timeruins:  { kind: 'pillar', a: 0x6a6470, b: 0x3a3644 },
  blackhole:  { kind: 'rock',   a: 0x4a4e58 },
};

/**
 * 给一张地图铺近景两侧大件。
 * @param {THREE.Group} g  目标组
 * @param {{viewHalfX:Function}} ctx
 * @param {Function} rng
 * @param {string} mapId
 */
/* 把颜色按 HSL 提亮：保住色相和饱和度关系，只抬明度。
 *
 * 为什么必须提：这些色原本是照"远景剪影"的思路选的（0x2c333c 这类近黑），
 * 但近景件是要被看见的主体。实测道具像素均亮 38.6、地面 34.5 —— 差 4，
 * 等于隐形。抬到 0.30~0.62 明度区间后，才和地面的 30~40 拉开可见差距。 */
function liftColor(hex, mul) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.05), Math.min(0.6, hsl.l * mul + 0.16));
  return c.getHex();
}

/**
 * 给一张地图铺近景两侧大件。
 *
 * 摆位用**屏幕比例**反算世界坐标，不用世界坐标硬凑：
 * 目标是"物件中心落在画面 78%~92% 宽度处"，这样它本身就有一小半在画面外，
 * 形成真实的框景；而中心一定可见，不会整块跑到画外。
 *
 * 第一版是反过来做的——把世界 x 上限写成 `可见半宽 × 1.05`，
 * 结果 z=8 那种贴近相机的位置上，一个 3 单位宽的墙被投影放大到 300px，
 * 中心落在画面 96% 处，只剩一条边露在画面里。实测差分像素只占 0.69%。
 */
export function buildFlank(g, ctx, rng, mapId) {
  const conf = FLANK_CONF[mapId] || FLANK_CONF.city;
  const recipe = FLANK_KINDS[conf.kind] || fxRock;
  const mainA = liftColor(conf.a, 2.05);
  const mainB = liftColor(conf.b || conf.a, 1.85);

  // 两段纵深：贴近相机的（−2~+7）和稍远一点的（−16~−4）。
  // pMin/pMax 是"物件中心该落在画面宽度的哪个比例"，两段都保持在画面内。
  const bands = [
    { z0: -2.0, z1: 7.0,  count: 3, pMin: 0.80, pMax: 0.94, hMul: 1.0 },
    { z0: -16.0, z1: -4.0, count: 3, pMin: 0.76, pMax: 0.92, hMul: 1.25 },
  ];

  for (const band of bands) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < band.count; i++) {
        const t = (i + 0.5) / band.count;
        const z = band.z0 + (band.z1 - band.z0) * t + (rng() - 0.5) * 1.2;
        const half = ctx.viewHalfX(z);

        // 屏幕比例 p → 世界 x。sx = (x/(half))*0.5+0.5 = p  ⇒  x = (2p−1)·half
        const p = band.pMin + rng() * (band.pMax - band.pMin);
        let x = side * (2 * p - 1) * half;

        // 不能压进战场：否则会挡住玩家走位和僵尸通道
        const minAbs = ARENA_HALF_X + 0.4;
        if (Math.abs(x) < minAbs) x = side * minAbs;
        // 但这个深度的可见半宽如果连 minAbs 都不够，说明这条带没空间，跳过
        if (Math.abs(x) > half * 0.99) continue;

        const piece = new THREE.Group();
        recipe(piece, rng, mainA, mainB);
        piece.position.set(x, 0, z);
        piece.rotation.y = Math.atan2(-x, 0) + (rng() - 0.5) * 0.5;
        piece.scale.setScalar(band.hMul * (0.9 + rng() * 0.35));
        g.add(piece);
      }
    }
  }
}
