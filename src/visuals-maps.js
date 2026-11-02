/* ==========================================================
 * 新增地图（乙负责）
 *
 * 对应 docs/美术需求-槽位与技能.md 的「P2 地图与时代」：
 * 每个时代至少 3 张图，文档列了 17 张缺的。
 *
 * ## 为什么不新增贴图
 *
 * 现有 9 张图的贴图已经 18MB（每张 map 三件套：diff / nor_gl / rough）。
 * 再给 17 张图各下一套就是 34MB，直接破坏两个前提：
 *   - 「演示现场断网也能打开」
 *   - 首次加载不能让人干等
 *
 * 所以这里的做法是：**复用现有贴图，靠背景物 + 雾 + 灯光 + 地面乘色区分**。
 * 这不是偷懒——现有 9 张图里 city 和 base 贴图不同但观感接近，
 * 而 harbor 用沥青贴图却和海面、吊车、栈桥一起构成了完全不同的画面。
 * 说明**辨识度主要由背景物决定，不是贴图**。
 *
 * 贴图对应关系（每张都有依据，不是随便配的）：
 *   城堡/村庄/沼泽 → jungle（泥土）
 *   修道院/隔离区/空间站 → lab（瓷砖/水泥）
 *   战壕/城市高架/时间废墟 → city（碎石路面）
 *   登陆海滩/外星荒漠 → desert（沙）
 *   军港/地下停车场 → harbor（沥青）
 *   生化工厂/轨道平台 → base（锈铁皮）
 *   虚空神殿 → lava（焦土）
 *   黑洞边缘 → moon（岩石）
 *
 * ## 为什么用零件工厂 + 配置表
 *
 * 手写 17 个 props 函数约 1300 行，且会写出 17 套各自为政的摆放逻辑，
 * 一致性差、改起来到处都是。这里把物件拆成十来个零件工厂，
 * 每张图用配置组合它们——总行数少一半，风格还统一。
 * ========================================================== */

import * as THREE from 'three';

/* ----------------------------------------------------------
 * 基础材质与小工具
 *
 * 不复用 visuals.js 里的 mat/boxMesh：那个文件已经很大，
 * 而且跨模块共享内部函数会造成循环依赖。这三行工具重复一份更划算。
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

// 方块原点在底面中心，摆位直接写 y=0，和 visuals.js 的约定一致
function box(w, h, d, color, o) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, o));
  m.position.y = h / 2;
  return m;
}

function cyl(rTop, rBot, h, color, seg = 10, o) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat(color, o));
  m.position.y = h / 2;
  return m;
}

// 低面数石头：顶点抖动，flatShading 让棱角硬
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

/* ----------------------------------------------------------
 * 零件工厂
 *
 * 每个工厂都遵守两条约定：
 *   1. 只往传进来的 group 里塞东西，不返回新 group
 *   2. 所有摆放都避开战斗区（|x| < 8.6、z -30.5~15.4），
 *      不然会挡住玩家和士兵——这是项目里反复踩过的坑
 * ---------------------------------------------------------- */
const ARENA_HALF_X = 8.6;
const ARENA_MIN_Z = -30.5;
const ARENA_MAX_Z = 15.4;

/* 两侧排开的墙体/建筑带：所有"走廊感"的室内地图都用它 */
function addWalls(g, rng, o) {
  const {
    color, hMin = 3.4, hMax = 5, wMin = 5, wMax = 8,
    gapMin = 7, gapMax = 9, count = 8, dist = 13, rough = 1,
  } = o;
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      const h = hMin + rng() * (hMax - hMin);
      const w = wMin + rng() * (wMax - wMin);
      const b = box(w, h, 3 + rng() * 2, color, { rough });
      // dist 一定要 > ARENA_HALF_X，否则就压进战斗区了
      b.position.set(side * (dist + rng() * 3), h / 2, ARENA_MIN_Z + i * (gapMin + rng() * (gapMax - gapMin)));
      g.add(b);
    }
  }
}

/* 远景高楼带：压在出生线之外，给地平线高度 */
function addSkyline(g, rng, o) {
  const { color, count = 10, zBase = -44, spread = 46, hMin = 8, hMax = 22 } = o;
  for (let i = 0; i < count; i++) {
    const h = hMin + rng() * (hMax - hMin);
    const w = 4 + rng() * 7;
    const b = box(w, h, 3 + rng() * 3, color, { rough: 1 });
    b.position.set(-spread / 2 + (i / count) * spread + rng() * 3, h / 2, zBase - rng() * 10);
    g.add(b);
  }
}

/* 成堆的箱子/集装箱，给中景体积 */
function addCrates(g, rng, o) {
  const {
    colors, count = 9, w = 3.2, h = 2.4, d = 6.4,
    xMin = 11, xMax = 16, zMin = -26, zMax = 4,
  } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const c = box(w, h, d, colors[i % colors.length], { rough: 1 });
    c.position.set(side * (xMin + rng() * (xMax - xMin)), h / 2 + (rng() > 0.7 ? h : 0), zMin + rng() * (zMax - zMin));
    c.rotation.y = (rng() - 0.5) * 0.25;
    g.add(c);
  }
}

/* 散落的碎石/废墟块，填补地面空档 */
function addRubble(g, rng, o) {
  const { color, count = 22, rMin = 0.3, rMax = 0.9 } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const r = rMin + rng() * (rMax - rMin);
    const m = rock(rng, r, color);
    m.position.set(side * (9 + rng() * 9), r * 0.5, ARENA_MIN_Z + rng() * 44);
    m.rotation.y = rng() * Math.PI;
    g.add(m);
  }
}

/* 细高的竖杆：旗杆、天线、电线杆、路灯共用 */
function addPoles(g, rng, o) {
  const { color, count = 6, h = 6, r = 0.14, xMin = 10, xMax = 15, emissive = 0x000000, ei = 0 } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const hh = h * (0.8 + rng() * 0.4);
    const p = cyl(r, r * 1.2, hh, color, 6, { rough: 0.7, metal: 0.3, emissive, ei });
    p.position.set(side * (xMin + rng() * (xMax - xMin)), 0, ARENA_MIN_Z + 4 + rng() * 38);
    g.add(p);
  }
}

/* 水面/液面：一片大平面压在远处，把地平线收住 */
function addWater(g, rng, o) {
  const {
    color, emissive, ei = 0.9, y = -0.3, zMin = -58, w = 1.6, rough = 0.12, metal = 0.5,
  } = o;
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(140 * w, 120),
    new THREE.MeshStandardMaterial({
      color, emissive, emissiveIntensity: ei, roughness: rough, metalness: metal,
    })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0, y, zMin);
  g.add(sea);
}

/* 铁丝网/栅栏：一排细柱 + 交叉斜线，读起来是"过不去" */
function addFence(g, rng, o) {
  const { color, count = 8, h = 1.6, span = 30 } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const baseX = side * (9.5 + rng() * 4);
    const baseZ = ARENA_MIN_Z + 2 + (i / count) * span;
    for (let k = 0; k < 3; k++) {
      const post = cyl(0.06, 0.07, h, color, 5, { rough: 0.8, metal: 0.4 });
      post.position.set(baseX + k * 0.7, 0, baseZ);
      g.add(post);
    }
    // 交叉斜线：两根细杆拧成 X
    for (const dir of [-1, 1]) {
      const bar = cyl(0.035, 0.035, Math.hypot(1.4, h), color, 4, { rough: 0.8, metal: 0.4 });
      bar.rotation.z = Math.PI / 2 * dir * 0.55;
      bar.position.set(baseX + 0.7, h / 2, baseZ);
      g.add(bar);
    }
  }
}

/* 管道带：横挂或竖立的管线，厂房/空间站用 */
function addPipes(g, rng, o) {
  const { metal, rust, count = 7, rMin = 0.28, rMax = 0.48 } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const r = rMin + rng() * (rMax - rMin);
    const p = cyl(r, r, 5 + rng() * 6, rng() > 0.6 ? rust : metal, 10, { rough: 0.7, metal: 0.35 });
    p.rotation.z = Math.PI / 2;
    p.position.y = 2.2 + rng() * 1.4;
    p.position.x = side * (11.5 + rng() * 2);
    p.position.z = ARENA_MIN_Z + i * 7 + rng() * 2;
    g.add(p);
  }
}

/* 顶部灯带：室内地图的天花板光，回来做成忽明忽暗 */
function addCeilingLights(g, rng, o, anim) {
  const { color = 0xdfffef, count = 5, w = 3.2, yMin = 3.6 } = o;
  for (let i = 0; i < count; i++) {
    const tube = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.14, 0.34),
      new THREE.MeshBasicMaterial({ color, fog: true })
    );
    tube.position.set((rng() - 0.5) * 6, yMin + rng() * 0.8, ARENA_MIN_Z + 4 + i * 12 + rng() * 3);
    g.add(tube);
    if (anim) anim.push({ kind: 'flicker', obj: tube, phase: rng() * 10, base: 1 });
  }
}

/* 篝火/火盆：一小堆火，给中世纪和废墟地图的暖点 */
function addBrazier(g, rng, o, anim) {
  const { stone = 0x5a5148, count = 4 } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const g2 = new THREE.Group();
    // 石圈
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const s = rock(rng, 0.18 + rng() * 0.1, stone);
      s.position.set(Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42);
      g2.add(s);
    }
    // 火苗：一个发光锥体，交给动画让它呼吸
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 0.55, 7),
      new THREE.MeshBasicMaterial({
        color: 0xff9a4d, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    flame.position.y = 0.32;
    g2.add(flame);
    if (anim) anim.push({ kind: 'pulse', obj: flame, phase: rng() * 10, base: 0.85 });

    g2.position.set(side * (10 + rng() * 4), 0, ARENA_MIN_Z + 6 + rng() * 34);
    g.add(g2);
  }
}

/* 城堡/要塞：一段带雉堞的高墙 + 两座塔。给中世纪系用 */
function addFortress(g, rng, o) {
  const { stone, count = 3, h = 9, dist = 22 } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const bx = side * (dist + rng() * 8);

    // 主墙
    const wall = box(22, h, 2.4, stone, { rough: 1 });
    wall.position.set(bx, h / 2, -40 - i * 6);
    g.add(wall);

    // 雉堞：墙顶一排骨牌似的齿
    for (let k = 0; k < 9; k++) {
      const m = box(1.2, 1.4, 2.4, stone, { rough: 1 });
      m.position.set(bx - 9 + k * 2.3, h + 0.7, -40 - i * 6);
      g.add(m);
    }

    // 圆塔
    for (const s2 of [-1, 1]) {
      const t = cyl(2.2, 2.6, h + 4, stone, 12, { rough: 1 });
      t.position.set(bx + s2 * 12, 0, -40 - i * 6);
      g.add(t);
      // 塔顶圆锥
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(2.7, 2.6, 12),
        mat(stone, { rough: 1 })
      );
      cap.position.set(bx + s2 * 12, h + 5.3, -40 - i * 6);
      g.add(cap);
    }
  }
}

/* 村舍：小坡屋顶的房子 */
function addCottages(g, rng, o) {
  const { wall, roof, count = 7, hMin = 2.4, hMax = 3.4 } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const h = hMin + rng() * (hMax - hMin);
    const w = 4 + rng() * 2.5;

    const g2 = new THREE.Group();
    const bodyM = box(w, h, 4 + rng() * 2, wall, { rough: 1 });
    g2.add(bodyM);

    // 坡屋顶：两块斜板拼成人字
    for (const dir of [-1, 1]) {
      const r = box(w * 0.62, 0.22, 5.2, roof, { rough: 1 });
      r.position.set(dir * w * 0.26, h + 0.6, 0);
      r.rotation.z = -dir * 0.5;
      g2.add(r);
    }

    g2.position.set(side * (11 + rng() * 7), 0, ARENA_MIN_Z + 4 + rng() * 32);
    g2.rotation.y = (rng() - 0.5) * 0.7;
    g.add(g2);
  }
}

/* 战壕：两侧的土堤 + 沙袋 + 木板护壁 */
function addTrench(g, rng, o) {
  const { soil, sandbag, wood, count = 10 } = o;
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      const z = ARENA_MIN_Z + 2 + i * 4.4 + rng() * 1.5;
      // 土堤：横向长条，堆得比地面高
      const ridge = box(2.6 + rng(), 1.1 + rng() * 0.5, 4.2, soil, { rough: 1 });
      ridge.position.set(side * (9.4 + rng() * 0.8), 0, z);
      g.add(ridge);

      // 沙袋：堤顶一摞
      for (let k = 0; k < 3; k++) {
        const sb = box(0.9, 0.32, 1.2, sandbag, { rough: 1 });
        sb.position.set(side * (9.4 + rng() * 0.8), 1.1 + k * 0.16, z - 1.4 + k * 0.9);
        sb.rotation.y = (rng() - 0.5) * 0.3;
        g.add(sb);
      }

      // 木板护壁：斜插进土里
      if (rng() > 0.5) {
        const plank = box(0.12, 1.6, 1.0, wood, { rough: 1 });
        plank.position.set(side * (8.9 + rng() * 0.4), 0.5, z + 1);
        plank.rotation.z = side * 0.28;
        g.add(plank);
      }
    }
  }
}

/* 空间站舱壁：竖立的舱段 + 舷窗发光 */
function addStationHull(g, rng, o, anim) {
  const { hull, trim, window: winColor, count = 7 } = o;
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      const h = 4 + rng() * 2;
      const w = 6 + rng() * 4;
      const z = ARENA_MIN_Z + 3 + i * 6.6;

      const panel = box(w, h, 2.6, hull, { rough: 0.55, metal: 0.55 });
      panel.position.set(side * (12.5 + rng() * 2), h / 2, z);
      g.add(panel);

      // 加强筋
      for (let k = 0; k < 3; k++) {
        const rib = box(0.22, h, 2.8, trim, { rough: 0.4, metal: 0.7 });
        rib.position.set(side * (12.5 + rng() * 2) - w / 2 + 1 + k * (w / 3), h / 2, z);
        g.add(rib);
      }

      // 舷窗：一块发光面片，呼吸
      const win = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 0.9),
        new THREE.MeshBasicMaterial({
          color: winColor, transparent: true, opacity: 0.55,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
        })
      );
      win.position.set(side * (11.15 + rng()), h * 0.62, z + (rng() - 0.5) * 2);
      win.rotation.y = -side * Math.PI / 2;
      g.add(win);
      if (anim) anim.push({ kind: 'pulse', obj: win, phase: rng() * 10, base: 0.55 });
    }
  }
}

/* 虚空裂隙/神殿：几根立柱 + 地面符文环 + 悬浮碎块 */
function addVoidTemple(g, rng, o, anim) {
  const { stone, glow, pillars = 6 } = o;

  // 立柱：一圈高柱，围出"神殿"
  for (let i = 0; i < pillars; i++) {
    const side = i % 2 ? 1 : -1;
    const p = cyl(0.7, 0.9, 8 + rng() * 5, stone, 8, { rough: 0.9, metal: 0.2 });
    p.position.set(side * (11 + rng() * 6), 0, ARENA_MIN_Z + 6 + (i / pillars) * 36);
    g.add(p);
    // 柱顶发光环
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.08, 6, 16),
      new THREE.MeshBasicMaterial({
        color: glow, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(p.position.x, 8, p.position.z);
    g.add(ring);
    if (anim) anim.push({ kind: 'pulse', obj: ring, phase: rng() * 10, base: 0.7 });
  }

  // 悬浮碎块
  for (let i = 0; i < 14; i++) {
    const side = i % 2 ? 1 : -1;
    const s = rock(rng, 0.3 + rng() * 0.6, stone);
    s.position.set(side * (10 + rng() * 10), 3 + rng() * 7, ARENA_MIN_Z + 4 + rng() * 38);
    s.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(s);
  }
}

/* 废车/机械残骸：现代和二战系的标志物 */
function addWrecks(g, rng, o) {
  const { body, rust, count = 6 } = o;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const g2 = new THREE.Group();

    const hull = box(2.6, 0.9, 5.2, body, { rough: 0.9, metal: 0.3 });
    hull.position.y = 0.75;
    g2.add(hull);

    // 车顶：比车体小一圈
    const cabin = box(2.2, 0.75, 2.4, rust, { rough: 0.95, metal: 0.2 });
    cabin.position.set(0, 1.2, 0.6);
    g2.add(cabin);

    // 轮子：四个黑圆柱压扁
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const wl = cyl(0.42, 0.42, 0.26, 0x1a1a1a, 8, { rough: 1 });
        wl.rotation.z = Math.PI / 2;
        wl.position.set(sx * 1.3, 0.42, sz * 1.7);
        g2.add(wl);
      }
    }

    g2.position.set(side * (10 + rng() * 6), 0, ARENA_MIN_Z + 6 + rng() * 30);
    g2.rotation.y = (rng() - 0.5) * 1.2;
    if (rng() > 0.65) g2.rotation.z = Math.PI / 2 * (rng() > 0.5 ? 1 : -1); // 翻车
    g.add(g2);
  }
}

/* 前景剪影：画面最下缘一条参差的暗带，纵深靠它。中间留空不挡玩家 */
function addSilhouette(g, rng, o) {
  const { color, count = 7 } = o;
  const silMat = mat(color, { flat: true, rough: 1 });
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const h = 0.7 + rng() * 1.3;
    const w = 0.8 + rng() * 1.8;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.8), silMat);
    b.position.set(side * (4.2 + rng() * 7.5), h / 2 - 0.15, 16.5 + rng() * 3.5);
    b.rotation.y = rng() * Math.PI;
    b.rotation.z = (rng() - 0.5) * 0.12;
    g.add(b);
  }
}

/* ----------------------------------------------------------
 * 17 张新地图的配置
 *
 * 每张只写"用哪些零件 + 什么颜色"，具体摆放由上面统一处理。
 * tex 复用现有贴图，tint 乘在地面贴图上做色偏。
 * ---------------------------------------------------------- */
export const NEW_MAPS = {
  /* ===== 中世纪 ===== */
  castle: {
    name: '城堡攻城',
    tex: 'b-map-jungle', tint: 0x9a9282, roughness: 0.88,
    bg: 0x14161a, fogNear: 30, fogFar: 78,
    hemi: { sky: 0xa8b8c8, ground: 0x1a1a1e, intensity: 1.45 },
    key: { color: 0xfff0d8, intensity: 2.7 },
    fill: { color: 0x6a8ab0, intensity: 52, pos: [16, 12, -18] },
    build(g, rng, anim) {
      addFortress(g, rng, { stone: 0x6e6a62, count: 3, h: 9, dist: 22 });
      addRubble(g, rng, { color: 0x5a564e, count: 20, rMin: 0.35, rMax: 1.0 });
      addBrazier(g, rng, { stone: 0x5a5148, count: 4 }, anim);
      addSilhouette(g, rng, { color: 0x0e1014, count: 8 });
    },
  },
  village: {
    name: '中世纪村庄',
    tex: 'b-map-jungle', tint: 0xb8a888, roughness: 0.92,
    bg: 0x1a1610, fogNear: 34, fogFar: 84,
    hemi: { sky: 0xb8c8d0, ground: 0x2a2218, intensity: 1.5 },
    key: { color: 0xffe8c0, intensity: 2.6 },
    fill: { color: 0x8a7050, intensity: 48, pos: [14, 11, -16] },
    build(g, rng, anim) {
      addCottages(g, rng, { wall: 0x9a8a70, roof: 0x5a4030, count: 8 });
      addPoles(g, rng, { color: 0x6a5638, count: 6, h: 7, r: 0.12 });
      addBrazier(g, rng, { stone: 0x5a5148, count: 3 }, anim);
      addSilhouette(g, rng, { color: 0x140f0a, count: 8 });
    },
  },
  abbey: {
    name: '修道院',
    tex: 'b-map-lab', tint: 0xb8b0a0, roughness: 0.7,
    bg: 0x121418, fogNear: 28, fogFar: 74,
    hemi: { sky: 0xb0bcc8, ground: 0x1a1a1c, intensity: 1.35 },
    key: { color: 0xf0f4ff, intensity: 2.5 },
    fill: { color: 0x5a7a9a, intensity: 44, pos: [14, 12, -18] },
    build(g, rng, anim) {
      // 修道院：回廊墙面 + 拱券柱列
      addWalls(g, rng, { color: 0x8a8478, hMin: 4, hMax: 6, wMin: 6, wMax: 9, count: 7, dist: 13, rough: 0.95 });
      for (const side of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          const col = cyl(0.42, 0.48, 4.4, 0x9a9488, 10, { rough: 0.9 });
          col.position.set(side * (9.6 + rng() * 1.2), 0, ARENA_MIN_Z + 4 + i * 6.2);
          g.add(col);
        }
      }
      addCeilingLights(g, rng, { color: 0xdfe8f0, count: 4, w: 2.4 }, anim);
      addSilhouette(g, rng, { color: 0x0e1012, count: 7 });
    },
  },
  swamp: {
    name: '沼泽',
    // 亮度实测只有 20.8（最暗的原有图 city 是 33），俯视下看不清僵尸。
    // 提亮 tint 和两盏灯，压到 city 那一档附近
    tex: 'b-map-jungle', tint: 0x8a9a78, roughness: 0.96,
    bg: 0x121c16, fogNear: 24, fogFar: 70,
    hemi: { sky: 0x9ab8a0, ground: 0x1e2a22, intensity: 1.85 },
    key: { color: 0xe0f8d8, intensity: 2.9 },
    fill: { color: 0x4a8a6a, intensity: 52, pos: [14, 10, -16] },
    build(g, rng, anim) {
      // 水面压在最下层，沼泽的核心是"踩不到底的黑水"
      addWater(g, rng, { color: 0x1a2e22, emissive: 0x0a1810, ei: 0.8, y: -0.12, zMin: -56, w: 1.5, rough: 0.16, metal: 0.4 });
      // 枯树：细高杆 + 斜枝
      for (let i = 0; i < 10; i++) {
        const side = i % 2 ? 1 : -1;
        const h = 5 + rng() * 4;
        const trunk = cyl(0.16, 0.26, h, 0x3a3a2e, 6, { rough: 1 });
        trunk.position.set(side * (10 + rng() * 8), 0, ARENA_MIN_Z + 4 + rng() * 34);
        g.add(trunk);
        for (let k = 0; k < 2; k++) {
          const branch = cyl(0.07, 0.11, 2.2, 0x3a3a2e, 5, { rough: 1 });
          branch.position.set(trunk.position.x, h * 0.6 + k * 0.8, trunk.position.z);
          branch.rotation.z = (k ? 1 : -1) * 1.1;
          g.add(branch);
        }
      }
      addRubble(g, rng, { color: 0x3a4230, count: 18, rMin: 0.3, rMax: 0.7 });
      addSilhouette(g, rng, { color: 0x08100a, count: 9 });
    },
  },

  /* ===== 二战 ===== */
  trench: {
    name: '战壕',
    tex: 'b-map-city', tint: 0x98907e, roughness: 0.95,
    bg: 0x1a1814, fogNear: 28, fogFar: 76,
    hemi: { sky: 0xb0a898, ground: 0x201c16, intensity: 1.55 },
    key: { color: 0xfff2d8, intensity: 2.75 },
    fill: { color: 0x8a6a4a, intensity: 54, pos: [16, 11, -18] },
    build(g, rng, anim) {
      addTrench(g, rng, { soil: 0x4a4232, sandbag: 0x8a7a5a, wood: 0x5a4028, count: 10 });
      addFence(g, rng, { color: 0x6a6a60, count: 8, h: 1.6 });
      addRubble(g, rng, { color: 0x4a4238, count: 18 });
      addSilhouette(g, rng, { color: 0x0e0c08, count: 8 });
    },
  },
  beach: {
    name: '登陆海滩',
    tex: 'b-map-desert', tint: 0xc0b090, roughness: 0.94,
    bg: 0x2a3038, fogNear: 34, fogFar: 90,
    hemi: { sky: 0xc8d4e0, ground: 0x4a4234, intensity: 1.5 },
    key: { color: 0xfff4e0, intensity: 2.7 },
    fill: { color: 0x5a8ab0, intensity: 52, pos: [18, 12, -20] },
    build(g, rng, anim) {
      // 海：海滩的辨识度全靠这条
      addWater(g, rng, { color: 0x1d4a63, emissive: 0x0d2c40, ei: 0.9, y: -0.25, zMin: -60, w: 1.7, rough: 0.12, metal: 0.5 });
      // 反登陆障碍："捷克刺猬"，三根交叉钢梁
      for (let i = 0; i < 12; i++) {
        const side = i % 2 ? 1 : -1;
        const g2 = new THREE.Group();
        for (let k = 0; k < 3; k++) {
          const beam = box(0.16, 1.8, 0.16, 0x5a5650, { rough: 0.8, metal: 0.5 });
          beam.position.y = 0.9;
          beam.rotation.set((k - 1) * 0.9, k * 0.9, (k - 1) * 0.6);
          g2.add(beam);
        }
        g2.position.set(side * (9.5 + rng() * 8), 0, ARENA_MIN_Z + 4 + rng() * 30);
        g.add(g2);
      }
      addWrecks(g, rng, { body: 0x5a6050, rust: 0x6b4530, count: 4 });
      addSilhouette(g, rng, { color: 0x2a2620, count: 7 });
    },
  },
  warport: {
    name: '军港',
    tex: 'b-map-harbor', tint: 0x8a9098, roughness: 0.6,
    bg: 0x0c1218, fogNear: 32, fogFar: 88,
    hemi: { sky: 0x9ab0c0, ground: 0x10161c, intensity: 1.5 },
    key: { color: 0xe8f0ff, intensity: 2.6 },
    fill: { color: 0x3a6a90, intensity: 55, pos: [16, 12, -20] },
    build(g, rng, anim) {
      addWater(g, rng, { color: 0x16384a, emissive: 0x0a1e28, ei: 0.85, y: -0.3, zMin: -58, w: 1.6, rough: 0.14, metal: 0.5 });
      // 军舰舰体：一个长条大块，压在地平线上
      for (let i = 0; i < 2; i++) {
        const hull = box(14, 3.2, 30, 0x4a5258, { rough: 0.8, metal: 0.4 });
        hull.position.set(-24 + i * 48, 1.2, -46);
        g.add(hull);
        const tower = box(4, 4, 5, 0x3a4248, { rough: 0.75, metal: 0.45 });
        tower.position.set(-24 + i * 48, 3.2, -46);
        g.add(tower);
      }
      addCrates(g, rng, { colors: [0x3a4a3a, 0x4a4230, 0x2a3a4a], count: 7, w: 2.6, h: 2, d: 4 });
      addPoles(g, rng, { color: 0x5a6068, count: 5, h: 8, r: 0.16, emissive: 0xffe8b0, ei: 0.5 });
      addSilhouette(g, rng, { color: 0x080c10, count: 7 });
    },
  },

  /* ===== 现代 ===== */
  highway: {
    name: '城市高架',
    tex: 'b-map-city', tint: 0x9aa0a8, roughness: 0.5,
    bg: 0x0d1116, fogNear: 30, fogFar: 84,
    hemi: { sky: 0xa0b4c8, ground: 0x121820, intensity: 1.5 },
    key: { color: 0xfff2e0, intensity: 2.9 },
    fill: { color: 0x4a7ab8, intensity: 58, pos: [16, 12, -18] },
    build(g, rng, anim) {
      // 高架：两侧的水泥护栏，把画面挤成一条路
      for (const side of [-1, 1]) {
        for (let i = 0; i < 10; i++) {
          const rail = box(1.0, 1.4, 6, 0x8a8a86, { rough: 0.85 });
          rail.position.set(side * (9.2 + rng() * 0.4), 0, ARENA_MIN_Z + 2 + i * 4.6);
          g.add(rail);
        }
      }
      // 支撑柱：高架桥下的粗柱
      for (let i = 0; i < 6; i++) {
        const side = i % 2 ? 1 : -1;
        const p = cyl(1.1, 1.4, 12, 0x7a7a76, 10, { rough: 0.85 });
        p.position.set(side * (13 + rng() * 5), 0, ARENA_MIN_Z + 8 + rng() * 30);
        g.add(p);
      }
      addSkyline(g, rng, { color: 0x141a22, count: 9, zBase: -46, hMin: 10, hMax: 26 });
      addWrecks(g, rng, { body: 0x6a7080, rust: 0x5a4030, count: 5 });
      addSilhouette(g, rng, { color: 0x090c10, count: 7 });
    },
  },
  parking: {
    name: '地下停车场',
    // 亮度 22.8 太暗：地下虽然该暗，但僵尸必须看得见
    tex: 'b-map-harbor', tint: 0x969ca4, roughness: 0.55,
    bg: 0x0e1218, fogNear: 22, fogFar: 66,
    hemi: { sky: 0x94a4b4, ground: 0x12161c, intensity: 1.55 },
    key: { color: 0xe4eef8, intensity: 3.0 },
    fill: { color: 0x4a6a90, intensity: 48, pos: [14, 10, -16] },
    build(g, rng, anim) {
      // 停车场：柱子 + 顶部灯管，四周全封
      for (const side of [-1, 1]) {
        for (let i = 0; i < 8; i++) {
          const col = box(1.2, 3.8, 1.2, 0x6a6e72, { rough: 0.8 });
          col.position.set(side * (9.4 + rng() * 1), 0, ARENA_MIN_Z + 3 + i * 6);
          g.add(col);
        }
      }
      // 车位线：一片片浅色细条
      for (let i = 0; i < 14; i++) {
        const side = i % 2 ? 1 : -1;
        const line = new THREE.Mesh(
          new THREE.PlaneGeometry(0.12, 4.4),
          new THREE.MeshBasicMaterial({ color: 0xc8c8b8, transparent: true, opacity: 0.22 })
        );
        line.rotation.x = -Math.PI / 2;
        line.position.set(side * (10.2 + (i % 3) * 1.8), 0.02, ARENA_MIN_Z + 4 + rng() * 34);
        g.add(line);
      }
      addCeilingLights(g, rng, { color: 0xe8f0ff, count: 7, w: 2.6, yMin: 3.2 }, anim);
      addWrecks(g, rng, { body: 0x5a6070, rust: 0x4a3830, count: 4 });
      addSilhouette(g, rng, { color: 0x06080a, count: 6 });
    },
  },

  /* ===== 后现代 ===== */
  quarantine: {
    name: '隔离区',
    // 亮度 29.5 略低于 city 档，小幅提亮
    tex: 'b-map-lab', tint: 0xb4c4b4, roughness: 0.45,
    bg: 0x0e1816, fogNear: 26, fogFar: 74,
    hemi: { sky: 0xb0d0c0, ground: 0x14201c, intensity: 1.5 },
    key: { color: 0xeafff6, intensity: 2.75 },
    fill: { color: 0x4ad9a0, intensity: 54, pos: [14, 11, -16] },
    build(g, rng, anim) {
      addWalls(g, rng, { color: 0x8a9a90, hMin: 4, hMax: 6, wMin: 6, wMax: 9, count: 8, dist: 13, rough: 0.8 });
      // 隔离舱：半透明的长条舱体，里面透绿光
      for (let i = 0; i < 6; i++) {
        const side = i % 2 ? 1 : -1;
        const pod = box(2.2, 2.6, 4.2, 0x7a8a80, { rough: 0.35, metal: 0.3 });
        pod.position.set(side * (10.5 + rng() * 3), 0, ARENA_MIN_Z + 6 + rng() * 28);
        g.add(pod);
        const glow = new THREE.Mesh(
          new THREE.PlaneGeometry(1.8, 2.2),
          new THREE.MeshBasicMaterial({
            color: 0x4ad9a0, transparent: true, opacity: 0.5,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
          })
        );
        glow.position.set(pod.position.x, 1.4, pod.position.z + 2.15);
        g.add(glow);
        if (anim) anim.push({ kind: 'pulse', obj: glow, phase: rng() * 10, base: 0.5 });
      }
      addPipes(g, rng, { metal: 0x9aa8a0, rust: 0x6a5a4a, count: 5 });
      addCeilingLights(g, rng, { color: 0xdfffe8, count: 4, w: 2.2 }, anim);
      addSilhouette(g, rng, { color: 0x070c0a, count: 7 });
    },
  },
  biofactory: {
    name: '生化工厂',
    tex: 'b-map-base', tint: 0x8a9a8a, roughness: 0.65,
    bg: 0x0a100c, fogNear: 26, fogFar: 74,
    hemi: { sky: 0x90b098, ground: 0x101814, intensity: 1.25 },
    key: { color: 0xd8ffe0, intensity: 2.4 },
    fill: { color: 0x3aa060, intensity: 52, pos: [15, 11, -18] },
    build(g, rng, anim) {
      // 厂房：大铁皮棚 + 反应罐
      for (let i = 0; i < 5; i++) {
        const side = i % 2 ? 1 : -1;
        const shed = box(8 + rng() * 4, 5 + rng() * 2, 6 + rng() * 3, 0x5a6a5a, { rough: 0.85, metal: 0.35 });
        shed.position.set(side * (14 + rng() * 4), 0, ARENA_MIN_Z + 6 + i * 8);
        g.add(shed);
      }
      // 反应罐：竖着的圆柱，顶上一个发光的圆
      for (let i = 0; i < 6; i++) {
        const side = i % 2 ? 1 : -1;
        const tank = cyl(1.0, 1.2, 4.5, 0x6a7a6a, 12, { rough: 0.6, metal: 0.4 });
        tank.position.set(side * (10 + rng() * 4), 0, ARENA_MIN_Z + 5 + rng() * 32);
        g.add(tank);
        const cap = new THREE.Mesh(
          new THREE.CircleGeometry(0.85, 12),
          new THREE.MeshBasicMaterial({
            color: 0x6aff9a, transparent: true, opacity: 0.6,
            blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        cap.rotation.x = -Math.PI / 2;
        cap.position.set(tank.position.x, 4.6, tank.position.z);
        g.add(cap);
        if (anim) anim.push({ kind: 'pulse', obj: cap, phase: rng() * 10, base: 0.6 });
      }
      addPipes(g, rng, { metal: 0x8a9a8a, rust: 0x6a4a2a, count: 8 });
      addSilhouette(g, rng, { color: 0x060a08, count: 8 });
    },
  },

  /* ===== 星际 ===== */
  station: {
    name: '空间站内部',
    // 亮度 23.0 太暗：舱内是白灯光环境，不该比废墟街道还黑
    tex: 'b-map-lab', tint: 0xa8b8cc, roughness: 0.35,
    bg: 0x080c12, fogNear: 28, fogFar: 74,
    hemi: { sky: 0x9ab0cc, ground: 0x10161c, intensity: 1.6 },
    key: { color: 0xeaf6ff, intensity: 3.1 },
    fill: { color: 0x3a9ad0, intensity: 52, pos: [14, 11, -16] },
    build(g, rng, anim) {
      addStationHull(g, rng, { hull: 0x5a6a7a, trim: 0x3a4652, window: 0x4ad9ff, count: 7 }, anim);
      // 地板格栅：横向细条
      for (let i = 0; i < 10; i++) {
        const strip = new THREE.Mesh(
          new THREE.PlaneGeometry(17, 0.1),
          new THREE.MeshBasicMaterial({ color: 0x6a90b0, transparent: true, opacity: 0.16 })
        );
        strip.rotation.x = -Math.PI / 2;
        strip.position.set(0, 0.015, ARENA_MIN_Z + 3 + i * 4.2);
        g.add(strip);
      }
      addCeilingLights(g, rng, { color: 0xdff0ff, count: 6, w: 2.8, yMin: 3.4 }, anim);
      addSilhouette(g, rng, { color: 0x04060a, count: 6 });
    },
  },
  alienwaste: {
    name: '外星荒漠',
    tex: 'b-map-desert', tint: 0xa08a90, roughness: 0.92,
    bg: 0x18101a, fogNear: 32, fogFar: 86,
    hemi: { sky: 0xb09ac0, ground: 0x2a1828, intensity: 1.3 },
    key: { color: 0xffd8f0, intensity: 2.5 },
    fill: { color: 0x7a4aa0, intensity: 48, pos: [16, 11, -18] },
    build(g, rng, anim) {
      // 外星地貌：尖岩柱 + 紫沙丘
      for (let i = 0; i < 10; i++) {
        const side = i % 2 ? 1 : -1;
        const h = 3 + rng() * 7;
        const spire = cyl(0.3 + rng() * 0.3, 1.2 + rng() * 0.8, h, 0x6a5a70, 7, { rough: 1 });
        spire.position.set(side * (10 + rng() * 9), 0, ARENA_MIN_Z + 4 + rng() * 34);
        g.add(spire);
      }
      addRubble(g, rng, { color: 0x7a6a80, count: 24, rMin: 0.25, rMax: 0.8 });
      // 发光晶体：给这张图一点"外星"的标志
      for (let i = 0; i < 6; i++) {
        const side = i % 2 ? 1 : -1;
        const cr = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.4 + rng() * 0.4),
          new THREE.MeshBasicMaterial({
            color: 0xc06aff, transparent: true, opacity: 0.65,
            blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        cr.position.set(side * (10 + rng() * 6), 0.5 + rng() * 0.6, ARENA_MIN_Z + 6 + rng() * 28);
        g.add(cr);
        if (anim) anim.push({ kind: 'pulse', obj: cr, phase: rng() * 10, base: 0.65 });
      }
      addSilhouette(g, rng, { color: 0x0c0810, count: 8 });
    },
  },
  orbitalpad: {
    name: '轨道平台',
    tex: 'b-map-base', tint: 0x8a98a8, roughness: 0.4,
    bg: 0x04060a, fogNear: 30, fogFar: 80,
    hemi: { sky: 0x8a9cb0, ground: 0x080c12, intensity: 1.1 },
    key: { color: 0xe8f4ff, intensity: 2.6 },
    fill: { color: 0x2a7ab0, intensity: 44, pos: [15, 12, -18] },
    build(g, rng, anim) {
      // 平台边缘：一圈高护栏，外面就是虚空
      for (const side of [-1, 1]) {
        for (let i = 0; i < 9; i++) {
          const rail = box(0.3, 1.2, 6.4, 0x5a6a7a, { rough: 0.5, metal: 0.6 });
          rail.position.set(side * (9.6 + rng() * 0.6), 0, ARENA_MIN_Z + 2 + i * 5.2);
          g.add(rail);
        }
      }
      // 远处的行星：一个巨大的半圆压在地平线
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(26, 20, 14),
        new THREE.MeshStandardMaterial({
          color: 0x4a5a7a, emissive: 0x1a2a3a, emissiveIntensity: 0.6,
          roughness: 0.9, flatShading: true,
        })
      );
      planet.position.set(-16, -6, -78);
      g.add(planet);
      // 天线阵
      addPoles(g, rng, { color: 0x6a7a8a, count: 7, h: 9, r: 0.12, emissive: 0x4ad9ff, ei: 0.7 });
      addSilhouette(g, rng, { color: 0x03050a, count: 7 });
    },
  },

  /* ===== 终幕 ===== */
  voidtemple: {
    name: '虚空神殿',
    // 亮度 17.9 是全场最暗（比 city 还低 46%）。虚空要暗但不能瞎，
    // 靠橙红火炬 + 抬高的主光把轮廓拉出来
    tex: 'b-map-lava', tint: 0x7a6a78, roughness: 0.8,
    bg: 0x12081a, fogNear: 28, fogFar: 78,
    hemi: { sky: 0x8a7aa0, ground: 0x140a1c, intensity: 1.8 },
    key: { color: 0xffe8d8, intensity: 3.2 },
    fill: { color: 0x9a3a6a, intensity: 56, pos: [15, 11, -18] },
    build(g, rng, anim) {
      addVoidTemple(g, rng, { stone: 0x4a3f4a, glow: 0xff5a2a, pillars: 7 }, anim);
      addBrazier(g, rng, { stone: 0x3a2f38, count: 4 }, anim);
      addSilhouette(g, rng, { color: 0x06040a, count: 8 });
    },
  },
  timeruins: {
    name: '时间废墟',
    // 亮度 24.9 偏暗，抬到 city 那一档
    tex: 'b-map-city', tint: 0x8e8e9c, roughness: 0.9,
    bg: 0x100e18, fogNear: 26, fogFar: 74,
    hemi: { sky: 0xa8a0bc, ground: 0x161220, intensity: 1.55 },
    key: { color: 0xe8e0ff, intensity: 2.85 },
    fill: { color: 0x6a5aa0, intensity: 50, pos: [14, 11, -16] },
    build(g, rng, anim) {
      // 断裂的柱廊：只剩半截的柱子，参差不齐
      for (let i = 0; i < 12; i++) {
        const side = i % 2 ? 1 : -1;
        const h = 1.5 + rng() * 5;
        const col = cyl(0.5, 0.6, h, 0x7a7a86, 9, { rough: 0.95 });
        col.position.set(side * (10 + rng() * 4), 0, ARENA_MIN_Z + 3 + rng() * 36);
        g.add(col);
        // 断口：柱顶一块斜的碎石
        if (rng() > 0.5) {
          const chip = rock(rng, 0.4, 0x7a7a86);
          chip.position.set(col.position.x, h, col.position.z);
          g.add(chip);
        }
      }
      // 悬浮的钟表残片：圆环，缓慢转
      for (let i = 0; i < 5; i++) {
        const side = i % 2 ? 1 : -1;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.9, 0.07, 6, 18),
          new THREE.MeshBasicMaterial({
            color: 0x9a8aff, transparent: true, opacity: 0.55,
            blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        ring.position.set(side * (11 + rng() * 6), 3 + rng() * 4, ARENA_MIN_Z + 6 + rng() * 28);
        g.add(ring);
        if (anim) anim.push({ kind: 'spin', obj: ring, phase: rng() * 10, base: 0.55 });
      }
      addRubble(g, rng, { color: 0x5a5a66, count: 20 });
      addSilhouette(g, rng, { color: 0x07050c, count: 8 });
    },
  },
  blackhole: {
    name: '黑洞边缘',
    tex: 'b-map-moon', tint: 0x707888, roughness: 0.94,
    bg: 0x03040a, fogNear: 34, fogFar: 92,
    hemi: { sky: 0x7080a0, ground: 0x06080c, intensity: 0.95 },
    key: { color: 0xd8e0ff, intensity: 2.4 },
    fill: { color: 0x4a3aa0, intensity: 40, pos: [-16, 12, -18] },
    build(g, rng, anim) {
      // 黑洞：一个纯黑的球 + 吸积盘光环
      const hole = new THREE.Mesh(
        new THREE.SphereGeometry(11, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
      );
      hole.position.set(18, 16, -80);
      g.add(hole);

      for (let i = 0; i < 3; i++) {
        const disk = new THREE.Mesh(
          new THREE.RingGeometry(12 + i * 2.4, 13.6 + i * 2.4, 40),
          new THREE.MeshBasicMaterial({
            color: i === 1 ? 0xc0a0ff : 0x6a4aff,
            transparent: true, opacity: 0.4 - i * 0.1,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        disk.position.copy(hole.position);
        disk.rotation.x = -0.5;
        g.add(disk);
        if (anim) anim.push({ kind: 'spin', obj: disk, phase: rng() * 10, base: 0.4 });
      }

      // 潮汐撕裂的岩块：被拉长的碎石
      for (let i = 0; i < 16; i++) {
        const side = i % 2 ? 1 : -1;
        const s = rock(rng, 0.4 + rng() * 1.1, 0x4a4f5a);
        s.position.set(side * (10 + rng() * 12), 0.2 + rng() * 2, ARENA_MIN_Z + 4 + rng() * 36);
        s.scale.set(1 + rng() * 1.2, 0.7, 0.7);
        g.add(s);
      }
      addSilhouette(g, rng, { color: 0x02030a, count: 7 });
    },
  },
};

/* 地图列表给 UI 用：id + 显示名 */
export const NEW_MAP_LIST = Object.entries(NEW_MAPS).map(([id, m]) => ({
  id,
  name: m.name,
}));

/** 这张新图属于哪个时代（给时代选图用） */
export const NEW_MAP_ERA = {
  castle: 0, village: 0, abbey: 0, swamp: 0,
  trench: 1, beach: 1, warport: 1,
  highway: 2, parking: 2,
  quarantine: 3, biofactory: 3,
  station: 4, alienwaste: 4, orbitalpad: 4,
  voidtemple: 5, timeruins: 5, blackhole: 5,
};

/** 是不是新地图（外部接线时用来分流） */
export function isNewMap(mapId) {
  return Object.prototype.hasOwnProperty.call(NEW_MAPS, mapId);
}
