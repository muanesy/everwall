/* ==========================================================
 * 炸药桶（乙负责：视觉 + 命中查询）
 *
 * 本文件只做三件事：
 *   1. 把桶摆在场上（模型、位置、待爆闪烁）
 *   2. 播放爆炸/命中特效（全程序化，零外部素材）
 *   3. 给甲提供命中查询 hitTestBarrel()，爆炸伤害结算归甲
 *
 * 甲需要接的事件（events 是 game.js 里的 EventTarget）：
 *   - 监听 'barrelExploded'：本模块在桶爆炸时派发，
 *     detail = { x, z, id, radius, damage }，甲按 radius/damage 结算范围伤害
 *   - 派发 'barrelHit'（detail { x, z, id }）：甲若自己判命中可通知这里播闪光
 *   - 派发 'barrelExplode'（detail { x, z, id }）：甲自己炸桶时通知这里播爆炸
 *   两个监听都是可选的，没有事件也不影响桶正常显示。
 *
 * visuals.js 里的接入位置：
 *   import { initBarrels, updateBarrels, hitTestBarrel } from './visuals-barrels.js'
 *   - initVisuals() 末尾：initBarrels({ scene, events })
 *   - syncScene(state, dt) 末尾：updateBarrels(dt)
 *   - 子弹推进时：const b = hitTestBarrel(bullet.x, bullet.z, 0.45)
 * ========================================================== */

import * as THREE from 'three';

/* ----------------------------------------------------------
 * 可调常量
 * 注意：EXPLOSION_RADIUS / EXPLOSION_DAMAGE 是玩法数值，
 *      **需与甲确认**，甲那边可以按这个默认值收敛平衡。
 * ---------------------------------------------------------- */
const BARREL_RADIUS = 0.55;      // 桶身半径（命中判定的基础）
const BARREL_HEIGHT = 1.1;       // 桶高

/* 一组桶是三只横排捆在一起的，整体半宽 = 0.62 + 0.55 ≈ 1.17
 * 子弹是垂直往上飞的（点屏幕只控制左右移动），玩家要打到桶必须站到桶正上方，
 * 所以把命中范围做宽一点，玩家稍微挪一步就能打中，不至于出现"瞄准了却打不到"。 */
const BARREL_OFFSETS = [-0.62, 0, 0.62];
export const BARREL_HIT_RADIUS = 1.15;
/* 整组桶在横向上的半长：从中心到最外侧桶的外缘 */
const BARREL_SPAN = BARREL_OFFSETS[BARREL_OFFSETS.length - 1] + BARREL_RADIUS;

const EXPLOSION_RADIUS = 3.2;    // 爆炸范围（数值需与甲确认）
const EXPLOSION_DAMAGE = 3;      // 爆炸伤害（数值需与甲确认）

const FUSE_TIME = 0.12;          // 命中后引信时长：闪烁这么久才炸
const FX_DURATION = 0.9;         // 一组爆炸特效总时长
const MAX_FX = 3;                // 同屏最多几组特效（超了先清最旧）
const MAX_EMBERS = 18;           // 火星上限（粒子总数别乱加，帧率优先）
const SMOKE_COUNT = 5;           // 每团黑烟的球数

/* ----------------------------------------------------------
 * 默认桶位：写死，确定性（不随刷新变化，方便甲调试和录像）
 * 放在 x 侧带 ±4.6~7.4、z -14~1：僵尸从右半场往 +z 走时会路过，
 * 但不会正面堵住主通道，也不会压到左下的士兵阵。
 * 两两间距均 ≥ 2.2 个单位。
 * ---------------------------------------------------------- */
const DEFAULT_POSITIONS = [
  // 放在左半边：僵尸只从右半边 x0.6~7.6 来，不会从桶身上穿过去（穿模）；
  // 左半边是玩家打屏障加兵时本来就要去的位置，顺手就能把桶打爆。
  // 子弹是垂直往上飞的，所以桶必须在玩家走得到的范围内才打得中。
  { x: -4.6, z: -8.5 },
  { x: -3.4, z: 0.8 },
];

const MAX_LIVE_BARRELS = 3; // 场上同时最多几个桶

/* ----------------------------------------------------------
 * 模块内部状态
 * ---------------------------------------------------------- */
let sceneRef = null;
let eventsRef = null;

const barrels = [];   // { id, x, z, mesh, bodyMat, alive, hp, fuse, fuseActive }
const fxList = [];    // 特效组，最多 MAX_FX 组

let assets = null;    // 共享几何体/材质（桶身主体材质每桶独立，为了单独闪）
let nextId = 1;

/* ----------------------------------------------------------
 * 黄色警示条：程序化 canvas 斜条纹，不下载任何图片
 * ---------------------------------------------------------- */
function makeStripeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  // 深色底
  ctx.fillStyle = '#23231f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 斜条纹：45° 黄色带 + 细黑缝
  ctx.strokeStyle = '#f2c521';
  ctx.lineWidth = 16;
  for (let i = -canvas.width; i < canvas.width * 2; i += 34) {
    ctx.beginPath();
    ctx.moveTo(i, canvas.height + 10);
    ctx.lineTo(i + canvas.height, -10);
    ctx.stroke();
  }

  // 上下深色封边，让贴在桶上更结实
  ctx.fillStyle = '#1a1a18';
  ctx.fillRect(0, 0, canvas.width, 5);
  ctx.fillRect(0, canvas.height - 5, canvas.width, 5);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(3, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ----------------------------------------------------------
 * 共享资源（一局只建一次）
 * ---------------------------------------------------------- */
function ensureAssets() {
  if (assets) return assets;

  assets = {
    body: new THREE.CylinderGeometry(BARREL_RADIUS, BARREL_RADIUS * 0.97, BARREL_HEIGHT, 20, 1),
    band: new THREE.CylinderGeometry(BARREL_RADIUS + 0.02, BARREL_RADIUS + 0.02, 0.28, 20, 1, true),
    rim: new THREE.CylinderGeometry(BARREL_RADIUS + 0.035, BARREL_RADIUS + 0.035, 0.09, 20),
    lid: new THREE.CylinderGeometry(BARREL_RADIUS - 0.02, BARREL_RADIUS - 0.02, 0.05, 20),
    handle: new THREE.BoxGeometry(0.34, 0.05, 0.13),
    stripeTex: makeStripeTexture(),
  };

  assets.bandMat = new THREE.MeshStandardMaterial({
    map: assets.stripeTex,
    roughness: 0.72,
    metalness: 0.15,
  });
  assets.rimMat = new THREE.MeshStandardMaterial({
    color: 0xb9bdae,   // 顶部浅色边
    roughness: 0.62,
    metalness: 0.45,
  });
  assets.lidMat = new THREE.MeshStandardMaterial({
    color: 0x8d9086,
    roughness: 0.7,
    metalness: 0.4,
  });

  return assets;
}

/* ----------------------------------------------------------
 * 建一个桶
 * ---------------------------------------------------------- */
function buildBarrel(x, z, index) {
  const a = ensureAssets();
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = index * 0.7;   // 每组桶朝向错开一点，别像复制粘贴

  // 桶身：深绿 / 锈红交替；材质独立，爆炸前单独发光闪烁
  const bodyMat = new THREE.MeshStandardMaterial({
    color: index % 2 === 0 ? 0x3f5a44 : 0x7a3f2c,
    roughness: 0.85,
    metalness: 0.22,
    emissive: 0x000000,
  });

  // 三只桶并排捆成一组：单个桶只有 0.55 宽，很难打中，
  // 横排之后整组的可命中范围宽了一倍多（子弹是垂直往上飞的，
  // 玩家只要站到这组桶正上方就能打到）
  for (const ox of BARREL_OFFSETS) {
    const sub = new THREE.Group();
    sub.position.x = ox;

    const body = new THREE.Mesh(a.body, bodyMat);
    body.position.y = BARREL_HEIGHT / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    sub.add(body);

    // 黄色警示条
    const band = new THREE.Mesh(a.band, a.bandMat);
    band.position.y = BARREL_HEIGHT * 0.66;
    sub.add(band);

    // 顶盖边圈 + 盖子 + 提手
    const rim = new THREE.Mesh(a.rim, a.rimMat);
    rim.position.y = BARREL_HEIGHT + 0.01;
    sub.add(rim);

    const lid = new THREE.Mesh(a.lid, a.lidMat);
    lid.position.y = BARREL_HEIGHT + 0.07;
    sub.add(lid);

    const handle = new THREE.Mesh(a.handle, a.rimMat);
    handle.position.y = BARREL_HEIGHT + 0.12;
    sub.add(handle);

    group.add(sub);
  }

  sceneRef.add(group);

  return {
    id: nextId++,
    x,
    z,
    mesh: group,
    bodyMat,
    alive: true,
    hp: 1,
    fuse: 0,
    fuseActive: false,
  };
}

/* ----------------------------------------------------------
 * 初始化
 * positions 可选：[{ x, z }, ...]；不传就用 DEFAULT_POSITIONS
 * events 可能为 null，全部做容错
 * ---------------------------------------------------------- */
export function initBarrels({ scene, events, positions } = {}) {
  sceneRef = scene || null;
  eventsRef = events || null;

  // 清掉上一次的残留
  clearFx();
  for (const b of barrels) {
    if (b.mesh && b.mesh.parent) b.mesh.parent.remove(b.mesh);
    if (b.bodyMat) b.bodyMat.dispose();
  }
  barrels.length = 0;
  nextId = 1;

  if (!sceneRef) return [];

  const list = Array.isArray(positions) && positions.length
    ? positions
    : DEFAULT_POSITIONS;

  list.forEach((p, i) => {
    barrels.push(buildBarrel(p.x, p.z, i));
  });

  bindEvents();
  return getBarrelList();
}

/* ----------------------------------------------------------
 * 运行时补桶（给甲做动态生成）
 * 场上最多 3 个，位置太近会拒绝，返回新桶或 null
 * ---------------------------------------------------------- */
export function spawnBarrelAt(x, z) {
  if (!sceneRef || !Number.isFinite(x) || !Number.isFinite(z)) return null;

  let alive = 0;
  for (const b of barrels) {
    if (!b.alive) continue;
    alive += 1;

    const dx = b.x - x;
    const dz = b.z - z;
    if (dx * dx + dz * dz < 2.2 * 2.2) return null;
  }

  if (alive >= MAX_LIVE_BARRELS) return null;

  const b = buildBarrel(x, z, barrels.length);
  barrels.push(b);
  return b;
}

export function countAliveBarrels() {
  let n = 0;
  for (const b of barrels) if (b.alive) n += 1;
  return n;
}

/* ----------------------------------------------------------
 * 事件接入：甲派 barrelHit / barrelExplode 时播特效
 * ---------------------------------------------------------- */
let boundTarget = null;

function bindEvents() {
  if (!eventsRef || boundTarget === eventsRef) return;
  boundTarget = eventsRef;

  eventsRef.addEventListener('barrelHit', (e) => {
    const d = e && e.detail ? e.detail : null;
    if (!d || !isFinite(d.x) || !isFinite(d.z)) return;
    spawnHitFx(d.x, d.z);
  });

  eventsRef.addEventListener('barrelExplode', (e) => {
    const d = e && e.detail ? e.detail : null;
    if (!d || !isFinite(d.x) || !isFinite(d.z)) return;
    // 只播画面，伤害由甲自己算（甲派这个事件时说明它已经处理过了）
    spawnExplosionFx(d.x, d.z);
  });
}

/* ----------------------------------------------------------
 * 每帧推进：引信闪烁 + 特效
 * ---------------------------------------------------------- */
export function updateBarrels(dt) {
  const step = Math.min(dt || 0, 0.1);

  // 引信
  for (let i = barrels.length - 1; i >= 0; i--) {
    const b = barrels[i];
    if (!b.fuseActive) continue;

    b.fuse -= step;
    const blink = 0.5 + 0.5 * Math.sin(b.fuse * 90);
    // 红光越来越亮
    b.bodyMat.emissive.setRGB(blink * 0.95, blink * 0.22, 0);
    const s = 1 + blink * 0.045;
    b.mesh.scale.set(s, s, s);

    if (b.fuse <= 0) {
      b.fuseActive = false;
      b.fuse = 0;
      b.alive = false;
      b.mesh.visible = false;
      b.mesh.scale.set(1, 1, 1);
      b.bodyMat.emissive.setRGB(0, 0, 0);
      explodeBarrelAt(b.x, b.z, b.id);
    }
  }

  updateFx(step);
}

/* ----------------------------------------------------------
 * 指定点播放爆炸（内部引信到点会调，甲也可以直接调）
 * 会通过 events 派发 barrelExploded 给甲做伤害结算
 * ---------------------------------------------------------- */
export function explodeBarrelAt(x, z, id = 0, radius = EXPLOSION_RADIUS, damage = EXPLOSION_DAMAGE) {
  if (!isFinite(x) || !isFinite(z)) return;

  spawnExplosionFx(x, z);

  if (!eventsRef) return;
  try {
    eventsRef.dispatchEvent(new CustomEvent('barrelExploded', {
      detail: { x, z, id, radius, damage },
    }));
  } catch (err) {
    // 事件系统异常不能影响画面
  }
}

/* ----------------------------------------------------------
 * 命中查询（给甲做子弹-桶碰撞）
 * 返回命中的桶对象，没命中返回 null。
 * 命中后进入 0.12 秒引信闪烁，到点自动爆炸；一个桶只炸一次。
 * ---------------------------------------------------------- */
export function hitTestBarrel(x, z, tol = 0.45) {
  if (!isFinite(x) || !isFinite(z)) return null;

  // 容差：甲传进来的是"额外宽容量"，这里收敛一下别让判定大得离谱
  const extra = Math.min(isFinite(tol) ? tol : 0.25, 0.3);
  const reach = BARREL_RADIUS + extra;   // 到桶身表面的距离

  for (let i = 0; i < barrels.length; i++) {
    const b = barrels[i];
    if (!b.alive || b.fuseActive) continue;

    // 桶是三只横排，整体是一段横线：用"点到线段"的胶囊判定，
    // 球形判定的话横排两端就打不到（子弹垂直上飞，正好从桶上面过）
    const dx = Math.abs(x - b.x);
    const over = Math.max(0, dx - BARREL_SPAN);
    const dz = z - b.z;
    if (over * over + dz * dz > reach * reach) continue;

    // 点燃引信
    b.fuseActive = true;
    b.fuse = FUSE_TIME;
    return b;
  }

  return null;
}

/* ----------------------------------------------------------
 * 存活桶快照（给甲调试 / 存档）
 * ---------------------------------------------------------- */
export function getBarrelList() {
  const out = [];
  for (let i = 0; i < barrels.length; i++) {
    const b = barrels[i];
    if (b.alive) out.push({ id: b.id, x: b.x, z: b.z });
  }
  return out;
}

/* ----------------------------------------------------------
 * 重开一局：桶复原、特效清空（位置不变）
 * ---------------------------------------------------------- */
export function resetBarrels() {
  // 动态补的桶不能留到下一局，全部拆掉，只重建初始那两个
  for (const b of barrels) {
    if (b.mesh && b.mesh.parent) b.mesh.parent.remove(b.mesh);
    if (b.bodyMat) b.bodyMat.dispose();
  }
  barrels.length = 0;
  clearFx();

  if (!sceneRef) return;
  DEFAULT_POSITIONS.forEach((p, i) => {
    barrels.push(buildBarrel(p.x, p.z, i));
  });
}

/* ==========================================================
 * 特效部分
 * ========================================================== */

/* 命中闪光：小、快、便宜 */
function spawnHitFx(x, z) {
  if (!sceneRef) return;
  if (fxList.length >= MAX_FX) disposeFx(fxList.shift());

  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const mat = new THREE.MeshBasicMaterial({
    color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false,
  });
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), mat);
  spark.position.y = 0.72;
  spark.scale.setScalar(0.55);
  group.add(spark);

  sceneRef.add(group);
  fxList.push({ group, t: 0, dur: 0.26, spark });
}

/* 爆炸：火球 + 核心 + 冲击波 + 火星 + 黑烟 */
function spawnExplosionFx(x, z) {
  if (!sceneRef) return;
  // 同屏最多 MAX_FX 组，超了先清最旧
  while (fxList.length >= MAX_FX) disposeFx(fxList.shift());

  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // 火球（橙黄，快速膨胀到 3 倍再淡出）
  const fire = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffa62b, transparent: true, opacity: 0.95, depthWrite: false })
  );
  fire.position.y = 0.55;
  fire.scale.setScalar(0.42);
  group.add(fire);

  // 白热核心
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 1, depthWrite: false })
  );
  core.position.y = 0.55;
  core.scale.setScalar(0.38);
  group.add(core);

  // 贴地冲击波环
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.55, 36),
    new THREE.MeshBasicMaterial({
      color: 0xffd27a, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);

  // 火星：一个 Points 搞定，位置每帧原地改写，不 new 对象
  const emberCount = MAX_EMBERS;
  const pos = new Float32Array(emberCount * 3);
  const vel = new Float32Array(emberCount * 3);

  for (let i = 0; i < emberCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 1.6 + Math.random() * 2.8;
    pos[i * 3] = Math.cos(a) * 0.15;
    pos[i * 3 + 1] = 0.5 + Math.random() * 0.3;
    pos[i * 3 + 2] = Math.sin(a) * 0.15;
    vel[i * 3] = Math.cos(a) * sp;
    vel[i * 3 + 1] = 2.2 + Math.random() * 2.2;
    vel[i * 3 + 2] = Math.sin(a) * sp;
  }

  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const embers = new THREE.Points(emberGeo, new THREE.PointsMaterial({
    color: 0xffc75a, size: 0.12, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  group.add(embers);

  // 黑烟：几个半透明深灰球往上飘
  const smoke = [];
  for (let i = 0; i < SMOKE_COUNT; i++) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x2a2a2a, transparent: true, opacity: 0.3, depthWrite: false })
    );
    const a = (i / SMOKE_COUNT) * Math.PI * 2;
    m.position.set(Math.cos(a) * 0.35, 0.5 + i * 0.1, Math.sin(a) * 0.35);
    m.scale.setScalar(0.7 + Math.random() * 0.3);
    group.add(m);
    smoke.push(m);
  }

  sceneRef.add(group);
  fxList.push({ group, t: 0, dur: FX_DURATION, fire, core, ring, embers, emberVel: vel, smoke });
}

/* 每帧推进所有特效 */
function updateFx(dt) {
  for (let i = fxList.length - 1; i >= 0; i--) {
    const fx = fxList[i];
    fx.t += dt;

    // 命中闪光
    if (fx.spark) {
      const k = Math.min(fx.t / fx.dur, 1);
      fx.spark.scale.setScalar(0.55 + k * 1.4);
      fx.spark.material.opacity = 0.9 * (1 - k);
    }

    // 火球：0.34 秒膨胀到最大，之后淡出
    if (fx.fire) {
      const p = Math.min(fx.t / 0.34, 1);
      const ease = 1 - (1 - p) * (1 - p);
      fx.fire.scale.setScalar(0.42 + ease * 2.58);
      fx.fire.position.y = 0.55 + fx.t * 0.55;
      fx.fire.material.opacity = fx.t < 0.16
        ? 0.95
        : Math.max(0, 0.95 * (1 - (fx.t - 0.16) / 0.5));

      fx.core.scale.setScalar(0.38 + ease * 1.5);
      fx.core.position.y = fx.fire.position.y;
      fx.core.material.opacity = Math.max(0, 1 - fx.t / 0.3);
    }

    // 冲击波：从 0.4 扩到 EXPLOSION_RADIUS
    if (fx.ring) {
      const k = Math.min(fx.t / 0.55, 1);
      const target = EXPLOSION_RADIUS / 0.55;
      fx.ring.scale.setScalar(1 + k * (target - 1));
      fx.ring.material.opacity = 0.85 * (1 - k);
    }

    // 火星：抛物线下落
    if (fx.embers) {
      const arr = fx.embers.geometry.attributes.position.array;
      const vel = fx.emberVel;
      for (let j = 0; j < arr.length; j += 3) {
        arr[j] += vel[j] * dt;
        arr[j + 1] += vel[j + 1] * dt;
        arr[j + 2] += vel[j + 2] * dt;
        vel[j + 1] -= 9.5 * dt;
        if (arr[j + 1] < 0.02) {
          arr[j + 1] = 0.02;
          vel[j + 1] *= -0.3;
        }
      }
      fx.embers.geometry.attributes.position.needsUpdate = true;
      fx.embers.material.opacity = Math.max(0, 0.95 * (1 - fx.t / 0.6));
    }

    // 黑烟：向上飘 + 变大 + 变淡
    if (fx.smoke) {
      const k = Math.min(fx.t / fx.dur, 1);
      for (let j = 0; j < fx.smoke.length; j++) {
        const m = fx.smoke[j];
        m.position.y += (0.75 + j * 0.05) * dt;
        m.position.x *= 1 + 0.35 * dt;
        m.position.z *= 1 + 0.35 * dt;
        m.scale.setScalar(0.7 + k * 1.8);
        m.material.opacity = 0.3 * (1 - k);
      }
    }

    if (fx.t >= fx.dur) disposeFx(fx);
  }
}

/* 从场景摘掉并释放几何体 / 材质 */
function disposeFx(fx) {
  if (!fx) return;
  const idx = fxList.indexOf(fx);
  if (idx >= 0) fxList.splice(idx, 1);

  if (sceneRef && fx.group) sceneRef.remove(fx.group);

  fx.group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  });
}

function clearFx() {
  while (fxList.length) disposeFx(fxList[0]);
}

/* 供调试在控制台看当前特效数量 */
export function getBarrelFxCount() {
  return fxList.length;
}
