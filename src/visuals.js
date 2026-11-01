/* ==========================================================
 * 画面层（乙负责）
 *
 * 职责：搭 3D 场景、相机、灯光、地面、背景物，把 state 里的东西画出来，
 *      并接收 game.js 发来的事件播放特效。
 *
 * 这里只读 state，不改 state。
 * 换模型、换贴图、调画面，都只在这个文件里改。
 * ========================================================== */

import * as THREE from 'three';
// GLTFLoader / SkeletonUtils 用仓库本地副本（assets/vendor/），不新增 CDN 依赖：
// three 本体仍由 index.html 的 importmap 提供，加载器内部 import 'three' 会复用它。
import { GLTFLoader } from '../assets/vendor/loaders/GLTFLoader.js';
import { clone as skeletonClone } from '../assets/vendor/utils/SkeletonUtils.js';
import {
  setAmbient,
  updateAudio,
  playShoot,
  playZombieDie,
  playBarrierHit,
  playBarrierApply,
  playArmyHurt,
  playWaveStart,
} from './audio.js';

/* ----------------------------------------------------------
 * 地图配置表
 *
 * 六套地面，全部是 Poly Haven 的 CC0 扫描材质（免署名可商用）。
 * 预览方式：在地址后面加 ?map=jungle / desert / moon / snow / lava / city
 * 例如 http://127.0.0.1:5173/index.html?map=moon
 *
 * 每张地图自带：贴图三件套、地面乘色、雾色、灯光方案、背景物套件。
 * 机制（洪水、沙暴、失重……）归 game.js 管，这里只负责"长得像"。
 * ========================================================== */
const MAPS = {
  city: {
    name: '废墟街道（雨夜）',
    tex: 'b-map-city',      // road_damaged_2
    tint: 0x8d99ab,
    roughness: 0.42,
    bg: 0x0b0f14, fogNear: 30, fogFar: 82,
    hemi: { sky: 0x9fb8d8, ground: 0x10141a, intensity: 1.0 },
    key: { color: 0xfff1de, intensity: 2.4 },
    fill: { color: 0x4a7ab8, intensity: 60, pos: [16, 12, -18] },
  },
  jungle: {
    name: '热带雨林（机制建议：洪水上涨）',
    tex: 'b-map-jungle',    // brown_mud_rocks_01
    tint: 0xb2bfae,
    roughness: 0.75,
    bg: 0x081009, fogNear: 34, fogFar: 84,
    hemi: { sky: 0xcde8d2, ground: 0x2a3626, intensity: 1.7 },
    key: { color: 0xfff3d9, intensity: 3.0 },
    fill: { color: 0x3f8f5f, intensity: 55, pos: [14, 11, -16] },
  },
  desert: {
    name: '沙漠（机制建议：沙尘暴遮视野）',
    tex: 'b-map-desert',    // aerial_sand
    tint: 0xd8c4a2,
    roughness: 0.9,
    bg: 0x8a7452, fogNear: 24, fogFar: 80,
    hemi: { sky: 0xe8d4a8, ground: 0x4a3a26, intensity: 1.1 },
    key: { color: 0xffe8c0, intensity: 2.4 },
    fill: { color: 0xff9a4d, intensity: 70, pos: [18, 10, -18] },
  },
  moon: {
    name: '月球（机制建议：低重力）',
    tex: 'b-map-moon',      // rocks_ground_04
    tint: 0xaeb6bd,
    roughness: 0.95,
    bg: 0x05060a, fogNear: 42, fogFar: 100,
    hemi: { sky: 0x8a94a8, ground: 0x0a0c10, intensity: 0.45 },
    key: { color: 0xffffff, intensity: 2.6 },
    fill: { color: 0x223044, intensity: 24, pos: [-16, 11, -18] },
  },
  snow: {
    name: '雪原（机制建议：暴风雪减速）',
    tex: 'b-map-snow',      // snow_02
    tint: 0xdfe6ee,
    roughness: 0.6,
    bg: 0xb8c2cc, fogNear: 22, fogFar: 74,
    hemi: { sky: 0xdde8f2, ground: 0x3a4148, intensity: 1.15 },
    key: { color: 0xf2f6ff, intensity: 1.7 },
    fill: { color: 0x6a90c0, intensity: 45, pos: [14, 12, -16] },
  },
  lava: {
    name: '火山灰烬（机制建议：岩浆裂隙烫脚）',
    tex: 'b-map-lava',      // burned_ground_01
    tint: 0xa89a90,
    roughness: 0.85,
    bg: 0x120b08, fogNear: 26, fogFar: 88,
    hemi: { sky: 0xd8a878, ground: 0x140a06, intensity: 0.75 },
    key: { color: 0xffb070, intensity: 2.0 },
    fill: { color: 0xff5a2a, intensity: 90, pos: [12, 9, -14] },
  },
};

// 当前地图：从地址参数读，默认废墟街道
const MAP_ID = new URLSearchParams(window.location.search).get('map') || 'city';
const MAP = MAPS[MAP_ID] || MAPS.city;

/* ----------------------------------------------------------
 * 相机：斜视 2.5D
 *
 * 正交投影没有远近尺度差，物体不管多远都一样大，画面像航拍图。
 * 换成透视相机、45° 俯角：远处的东西会变小、收窄，纵深感就出来了。
 * ---------------------------------------------------------- */
const CAM = {
  tilt: 45,      // 俯角：90 = 正俯视，0 = 平视
  fov: 55,       // 垂直视角，越大越近，画面越有压迫感
  halfWidth: 9.4, // 玩家所在平面（z=9）必须能看见的左右半宽
};

const MAX_SOLDIER_VISUALS = 60;

const GROUND_TILE = 40;  // 一格贴图铺多少世界单位。1k 贴图在这个尺度下约 1:1 像素
const GROUND_W = 140;
const GROUND_H = 56;     // 从 z=+22 铺到 z=-34，再远靠背景墙和雾收掉
const GROUND_Z = -6;

let renderer = null;
let scene = null;
let camera = null;
let containerEl = null;

let camDist = 40;  // 相机到注视点的距离，由 resize() 按视口算
let camY = 28;
let camZ = 28;

let playerMesh = null;
let playerShadow = null;
let soldierMesh = null;
let playerVisual = null; // 玩家的真模型（加载完成后替代蓝方块）

/* ----------------------------------------------------------
 * 模型库：Quaternius Ultimate Animated Characters（CC0，免署名）
 *
 * 士兵和僵尸同一套风格，带骨骼动画。模型在启动时预加载，
 * 加载完成前所有角色先用色块顶替（fallback），加载完成后自动换成模型。
 *
 * 性能实测（Playwright 无 GPU 软件渲染，比真机差好几倍）：
 * 120 只走路僵尸 48 FPS / 开阴影 18 FPS —— 真 GPU 上绰绰有余，
 * 所以士兵和僵尸都不限数量地用真模型。
 * ---------------------------------------------------------- */
const modelLib = {
  loaded: false,
  soldier: null,   // gltf.scene 原型（只作克隆源，不直接进场）
  zombies: [],     // 两种僵尸混用：男 4046 面 / 女 9750 面
};
const animMixers = new Set(); // 所有活着的骨骼动画，每帧 update

const MODEL_TARGET = {
  soldierHeight: 1.5, // 士兵目标身高（世界单位）
  zombieHeight: 1.55, // 僵尸目标身高，比方块(1.15)略高一点更有压迫感
};

// 这个 GLB 的节点树会让 Box3.setFromObject 崩（树里有坏引用），
// 手动遍历 mesh 的几何包围盒测身高，顺便返回最低点用来落地。
function measureModelBox(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      for (const y of [b.min.y, b.max.y]) {
        for (const x of [b.min.x, b.max.x]) {
          v.set(x, y, 0).applyMatrix4(o.matrixWorld);
          box.expandByPoint(v);
        }
      }
    }
  });
  return box;
}

// 把原型标准化：缩放到目标身高、按 tint 调材质色、修正动画名
// 这个 GLB 的材质偏灰白，在雨夜场景里太亮太"干净"，tint 乘色把它压进氛围
function preparePrototype(proto, targetHeight, tint) {
  const box = measureModelBox(proto);
  const size = box.getSize(new THREE.Vector3());
  proto.scale.setScalar(targetHeight / (size.y || 1.8));
  if (tint) {
    proto.traverse((o) => {
      if ((o.isMesh || o.isSkinnedMesh) && o.material?.color) {
        o.material.color.multiply(tint);
      }
    });
  }
  return proto;
}

function loadModels() {
  const loader = new GLTFLoader();
  const base = new URL('../assets/models/', import.meta.url).href;

  const grab = (gltf, clipPattern) => {
    const proto = gltf.scene;
    proto.updateMatrixWorld(true);
    const clips = gltf.animations || [];
    proto.userData.clip =
      clips.find((c) => clipPattern.test(c.name)) ||
      clips.find((c) => /walk|run|idle/i.test(c.name)) ||
      clips[0] ||
      null;
    return proto;
  };

  Promise.all([
    loader.loadAsync(base + 'b-zombie-soldier.glb'),
    loader.loadAsync(base + 'b-zombie-male.glb'),
    loader.loadAsync(base + 'b-zombie-female.glb'),
  ])
    .then(([s, zm, zf]) => {
      modelLib.soldier = preparePrototype(grab(s, /idle/i), MODEL_TARGET.soldierHeight);
      const zombieTint = new THREE.Color(0.8, 0.9, 0.84); // 压暗、偏灰绿，贴合雨夜
      modelLib.zombies = [
        preparePrototype(grab(zm, /walk/i), MODEL_TARGET.zombieHeight, zombieTint),
        preparePrototype(grab(zf, /walk/i), MODEL_TARGET.zombieHeight, zombieTint),
      ];
      modelLib.loaded = true;
      // 玩家也换成模型：面向僵尸潮（-z），移动交给 syncScene 只改 x/z
      const vis = spawnModel(modelLib.soldier, Math.PI);
      if (vis) {
        playerVisual = vis;
        vis.root.position.set(playerMesh.position.x, 0, playerMesh.position.z);
        scene.add(vis.root);
        playerMesh.visible = false;
      }
      console.log('[visuals] 模型加载完成，角色已切换为真模型');
    })
    .catch((err) => {
      console.warn('[visuals] 模型加载失败，继续用色块顶替：', err);
    });
}

// 从原型克隆一个会动的角色。失败（或还没加载）返回 null，调用方回退到色块。
function spawnModel(proto, faceDir) {
  if (!proto) return null;
  try {
    const root = skeletonClone(proto);
    const cb = measureModelBox(root); // 克隆后实际落地（骨架缩放后 min.y 未必是 0）
    root.position.y = -(cb.min.y || 0);
    root.rotation.y = faceDir;
    root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = true;
    });
    // 和色块版一致的假阴影，保证所有角色脚下都有"落地感"
    const shadow = makeBlobShadow(0.45);
    root.add(shadow);
    let mixer = null;
    const clip = proto.userData.clip;
    if (clip) {
      mixer = new THREE.AnimationMixer(root);
      const action = mixer.clipAction(clip);
      action.play();
      action.time = Math.random() * clip.duration; // 打散步伐
      animMixers.add(mixer);
    }
    return { root, mixer };
  } catch (err) {
    console.warn('[visuals] 模型克隆失败：', err);
    return null;
  }
}

function despawnModel(vis) {
  if (vis.mixer) {
    vis.mixer.stopAllAction();
    animMixers.delete(vis.mixer);
  }
  // clone 共享 geometry/material，只把根节点从场景摘掉，绝不 dispose 共享资源
  scene.remove(vis.root);
}

let camBaseX = 0;
let shake = 0;

const zombieMeshes = new Map();
const barrierMeshes = new Map();
const bulletMeshes = new Map();
const effects = [];

const dummy = new THREE.Object3D();

/* ----------------------------------------------------------
 * 初始化
 * ---------------------------------------------------------- */
export function initVisuals(container, events) {
  containerEl = container;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(MAP.bg);
  scene.fog = new THREE.Fog(MAP.bg, MAP.fogNear, MAP.fogFar);

  camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.5, 260);

  // 灯光：按地图走。整体思路是环境光压低、主光斜射，
  // 地面颗粒感靠主光 + 法线贴图，环境光太高会把细节冲平。
  const hemi = new THREE.HemisphereLight(MAP.hemi.sky, MAP.hemi.ground, MAP.hemi.intensity);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(MAP.key.color, MAP.key.intensity);
  keyLight.position.set(-10, 20, 14);
  scene.add(keyLight);

  // 一盏彩色补光，营造氛围（雨夜路灯 / 岩浆红光 / 沙漠热浪）
  const fillLight = new THREE.PointLight(MAP.fill.color, MAP.fill.intensity, 90, 1.6);
  fillLight.position.set(...MAP.fill.pos);
  scene.add(fillLight);

  // 地面：按地图加载贴图。路径用 import.meta.url 解析，避免受页面位置影响。
  const groundTex = loadGroundTextures(renderer, MAP.tex);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_W, GROUND_H),
    new THREE.MeshStandardMaterial({
      map: groundTex.map,
      normalMap: groundTex.normalMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughnessMap: groundTex.roughnessMap,
      color: MAP.tint, // 乘色：统一色调，往地图氛围拉
      roughness: MAP.roughness, // 数值越小越"湿"，反光越明显
      metalness: 0.05,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = GROUND_Z;
  scene.add(ground);

  // 远处的背景墙：把地面尽头挡住，配合雾看起来就是地平线
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_W, 70),
    new THREE.MeshBasicMaterial({ color: MAP.bg, fog: true })
  );
  backdrop.position.set(0, 30, GROUND_Z - GROUND_H / 2);
  scene.add(backdrop);

  // 背景物：每张地图一套，全部是程序化生成的低面数道具，不占下载体积
  buildProps();

  // 队长
  playerMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.35, 0.9),
    new THREE.MeshStandardMaterial({
      color: 0x4ea1ff,
      roughness: 0.4,
      metalness: 0.1,
      emissive: 0x0b2a4a,
    })
  );
  playerMesh.position.set(0, 0.675, 9);
  scene.add(playerMesh);

  playerShadow = makeBlobShadow(0.7);
  playerShadow.position.set(0, 0.02, 9);
  scene.add(playerShadow);

  // 士兵：用实例化渲染，最多同时画 60 个
  soldierMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.4, 0.55, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x6fc2ff, roughness: 0.5 }),
    MAX_SOLDIER_VISUALS
  );
  soldierMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  soldierMesh.count = 0;
  scene.add(soldierMesh);

  window.addEventListener('resize', resize);
  resize();

  // 环境音跟着地图走（雨林虫鸣、沙漠风沙、月球真空……）
  setAmbient(MAP_ID);

  // 预加载角色模型：加载完成前用色块顶替，完成后自动换
  loadModels();

  // 事件 → 特效 + 音效
  events.addEventListener('shoot', (e) => {
    spawnMuzzleFlash(e.detail.x, e.detail.z);
    playShoot();
  });

  // barrierHit 只在打中负数屏障时触发，所以是红色小环（提示"这个不能碰"）
  events.addEventListener('barrierHit', (e) => {
    spawnRing(e.detail.x, e.detail.z, 0xff5a5a, 0.2);
    playBarrierHit();
  });

  // barrierApply 是数值真正生效（打满上限，或屏障撞到士兵）：正数绿、负数红，数值越大环越大
  events.addEventListener('barrierApply', (e) => {
    const v = e.detail?.value ?? 1;
    const size = Math.min(0.9, 0.34 + Math.abs(v) * 0.02);
    spawnRing(e.detail.x, e.detail.z, v >= 0 ? 0x6dffb0 : 0xff5a5a, size);
    if (v < 0) shake = Math.max(shake, 0.35);
    playBarrierApply(v);
  });

  events.addEventListener('zombieDie', (e) => {
    spawnRing(e.detail.x, e.detail.z, 0xff6a4a, 0.3);
    playZombieDie();
  });

  events.addEventListener('armyHurt', (e) => {
    const amount = e.detail?.amount ?? 1;
    shake = 0.3 + amount * 0.12;
    playArmyHurt(amount);
  });

  events.addEventListener('waveStart', () => {
    shake = 0.2;
    playWaveStart();
  });
}

/* ----------------------------------------------------------
 * 每帧同步
 * ---------------------------------------------------------- */
export function syncScene(state, dt) {
  if (!renderer) return;

  // 僵尸低吼的氛围音：交给音频层自己计时，这里只报数量和是否在局内
  updateAudio(dt, state.zombies ? state.zombies.length : 0, state.status === 'playing');

  // 队长
  if (playerVisual) {
    playerVisual.root.position.x = state.player.x;
    playerVisual.root.position.z = state.player.z;
  } else {
    playerMesh.position.set(state.player.x, 0.675, state.player.z);
  }
  playerShadow.position.set(state.player.x, 0.02, state.player.z);

  // 士兵队伍
  updateSoldiers(state);

  // +1 屏障
  syncBarriers(state);

  // 僵尸
  syncZombies(state);

  // 子弹
  syncBullets(state);

  updateEffects(dt);
  updateCamera(state, dt);

  // 骨骼动画：所有活着的 mixer 每帧推进（隐藏的士兵 timeScale=0 不耗动画计算）
  for (const m of animMixers) m.update(dt);

  renderer.render(scene, camera);
}

function soldierSlot(i, state) {
  const row = Math.floor(i / 6);
  const col = i % 6;
  return {
    x: state.player.x + (col - 2.5) * 0.5,
    z: state.player.z + 0.7 + row * 0.55,
  };
}

const soldierVisuals = []; // 真模型池：{ root, mixer }

function updateSoldiers(state) {
  const n = Math.min(state.soldiers, MAX_SOLDIER_VISUALS);

  // 模型没加载好（或加载失败）：维持甲写的实例化方块渲染，逻辑零风险
  if (!modelLib.loaded || !modelLib.soldier) {
    soldierMesh.visible = true;
    soldierMesh.count = n;

    for (let i = 0; i < n; i++) {
      const p = soldierSlot(i, state);
      dummy.position.set(p.x, 0.275, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      soldierMesh.setMatrixAt(i, dummy.matrix);
    }
    soldierMesh.instanceMatrix.needsUpdate = true;
    return;
  }

  soldierMesh.visible = false;

  // 补齐模型池（只在士兵变多时克隆，克隆失败就地保持方块）
  while (soldierVisuals.length < n) {
    const vis = spawnModel(modelLib.soldier, Math.PI); // 面朝僵尸来的方向
    if (!vis) {
      modelLib.soldier = null; // 这条路走不通，整队退回方块模式
      return;
    }
    scene.add(vis.root);
    soldierVisuals.push(vis);
  }

  for (let i = 0; i < soldierVisuals.length; i++) {
    const vis = soldierVisuals[i];
    const active = i < n;
    vis.root.visible = active;
    if (vis.mixer) vis.mixer.timeScale = active ? 1 : 0;
    if (active) {
      const p = soldierSlot(i, state);
      vis.root.position.x = p.x;
      vis.root.position.z = p.z;
    }
  }
}

function syncBarriers(state) {
  const alive = new Set();

  for (const bar of state.barriers) {
    alive.add(bar.id);

    let mesh = barrierMeshes.get(bar.id);
    if (!mesh) {
      mesh = makeBarrierMesh(bar);
      scene.add(mesh);
      barrierMeshes.set(bar.id, mesh);
    }
    mesh.position.set(bar.x, 0, bar.z);
    updateBarrierAppearance(mesh, bar);
  }

  for (const [id, mesh] of barrierMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      barrierMeshes.delete(id);
    }
  }
}

function syncZombies(state) {
  const alive = new Set();

  for (const z of state.zombies) {
    alive.add(z.id);

    let entry = zombieMeshes.get(z.id);
    // 模型加载完成的那一瞬间，把已经在场的色块统一换成模型
    if (entry && entry.isModel !== modelLib.loaded) {
      if (entry.isModel) despawnModel(entry.vis);
      else {
        scene.remove(entry.mesh);
        disposeMesh(entry.mesh);
      }
      entry = null;
    }

    if (!entry) {
      if (modelLib.loaded && modelLib.zombies.length) {
        // 每 5 只里出 1 只女僵尸（面数更高），按 type 稳定分配不闪烁
        const proto = modelLib.zombies[z.type % 5 === 4 ? 1 : 0];
        const vis = spawnModel(proto, 0); // 面朝玩家（+z）
        entry = vis
          ? { isModel: true, vis }
          : { isModel: false, mesh: makeZombieMesh(z.type) };
      } else {
        entry = { isModel: false, mesh: makeZombieMesh(z.type) };
      }
      scene.add(entry.isModel ? entry.vis.root : entry.mesh);
      zombieMeshes.set(z.id, entry);
    }

    if (entry.isModel) {
      entry.vis.root.position.x = z.x;
      entry.vis.root.position.z = z.z;
    } else {
      entry.mesh.position.set(z.x, 0.575, z.z);
    }
  }

  for (const [id, entry] of zombieMeshes) {
    if (!alive.has(id)) {
      if (entry.isModel) despawnModel(entry.vis);
      else {
        scene.remove(entry.mesh);
        disposeMesh(entry.mesh);
      }
      zombieMeshes.delete(id);
    }
  }
}

function syncBullets(state) {
  const alive = new Set();

  for (const b of state.bullets) {
    alive.add(b.id);

    let mesh = bulletMeshes.get(b.id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe08a })
      );
      scene.add(mesh);
      bulletMeshes.set(b.id, mesh);
    }
    mesh.position.set(b.x, 0.9, b.z);
  }

  for (const [id, mesh] of bulletMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      bulletMeshes.delete(id);
    }
  }
}

/* ----------------------------------------------------------
 * 相机：轻微跟随玩家 + 受伤震动
 * ---------------------------------------------------------- */
function updateCamera(state, dt) {
  camBaseX += (state.player.x * 0.22 - camBaseX) * Math.min(1, dt * 5);

  let sx = 0;
  let sy = 0;

  if (shake > 0) {
    shake = Math.max(0, shake - dt * 2.2);
    sx = (Math.random() - 0.5) * shake;
    sy = (Math.random() - 0.5) * shake;
  }

  camera.position.set(camBaseX + sx, camY + sy, camZ);
  camera.lookAt(camBaseX, 0, 0);
}

/* ----------------------------------------------------------
 * 背景物
 *
 * 全部程序化生成：低面数的方块 / 岩石 / 树，一套几十个，不增加下载体积。
 * 摆放避开玩法区：
 *   侧边  |x| ≥ 9.5    —— 左区屏障、右区僵尸都在 |x| < 8，摆在外面不挡
 *   后方  z ≤ -28      —— 僵尸和屏障从 z = -26 出生，摆得更远
 *   前景  z ≥ 13       —— 只有矮的东西，不然会挡住士兵队列
 *
 * 这些道具的作用不是"好看"，是给画面提供高度和遮挡：
 * 有高度的东西才有受光面和阴影面，眼睛才读得出这是斜视而不是俯视。
 * ---------------------------------------------------------- */
function buildProps() {
  const group = new THREE.Group();
  const rng = mulberry32(20261101);

  const builder = {
    city: buildCityProps,
    jungle: buildJungleProps,
    desert: buildDesertProps,
    moon: buildMoonProps,
    snow: buildSnowProps,
    lava: buildLavaProps,
  }[MAP_ID] || buildCityProps;

  builder(group, rng);
  scene.add(group);
}

function buildCityProps(g, rng) {
  const concrete = 0x3c434d;
  const rust = 0x6b4630;

  // 远景：楼群剪影，挡住地平线
  for (let i = 0; i < 9; i++) {
    const w = 5 + rng() * 7;
    const h = 9 + rng() * 14;
    const d = 5 + rng() * 5;
    const b = boxMesh(w, h, d, 0x161b23, { rough: 1 });
    b.position.set(-38 + i * 9 + rng() * 2, h / 2, -30 - rng() * 3);
    g.add(b);

    // 零星几扇亮着的窗，冷白或暖黄，只放几个，多了像圣诞树
    const winCount = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < winCount; k++) {
      const win = new THREE.Mesh(
        new THREE.PlaneGeometry(0.7, 1.0),
        new THREE.MeshBasicMaterial({
          color: rng() > 0.5 ? 0xffcc88 : 0x9fc8ff,
          transparent: true,
          opacity: 0.55,
          fog: true,
        })
      );
      win.position.set(
        b.position.x + (rng() - 0.5) * (w - 1.5),
        1.5 + rng() * (h - 3),
        b.position.z + d / 2 + 0.02
      );
      g.add(win);
    }
  }

  // 侧边：集装箱、卡车车厢，沿着街道排
  const containers = [
    [-13.5, -8, 3.2, 2.8, 7.5, 0x2f4a52],
    [12.5, -14, 3.0, 2.6, 8.0, 0x4a3226],
    [-12.0, 2, 3.0, 2.6, 6.5, 0x2a3a34],
    [13.0, 4, 3.4, 3.0, 7.0, 0x3a3540],
  ];
  for (const [x, z, w, h, d, c] of containers) {
    const box = boxMesh(w, h, d, c, { rough: 0.85, metal: 0.25 });
    box.position.set(x, h / 2, z);
    box.rotation.y = (rng() - 0.5) * 0.12;
    g.add(box);

    // 箱顶压条，远看有细节
    const rim = boxMesh(w + 0.1, 0.14, d + 0.1, 0x1b2026, { rough: 1 });
    rim.position.set(x, h + 0.07, z);
    rim.rotation.y = box.rotation.y;
    g.add(rim);
  }

  // 混凝土隔离墩
  for (let i = 0; i < 7; i++) {
    const side = i % 2 ? 1 : -1;
    const block = boxMesh(1.0, 0.95, 2.4, concrete, { rough: 1 });
    block.position.set(side * (10.6 + rng() * 0.9), 0.48, -10 + i * 3.4 + rng());
    block.rotation.y = (rng() - 0.5) * 0.2;
    g.add(block);
  }

  // 两盏路灯：灯头自发光，不真的打光（省性能）
  for (const lx of [-10.2, 10.8]) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.13, 7.2, 6),
      mat(0x1e242c, { rough: 0.8, metal: 0.4 })
    );
    pole.position.set(lx, 3.6, lx < 0 ? -4 : 6);
    g.add(pole);

    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.16, 1.1),
      mat(0x1e242c, { rough: 0.8, metal: 0.4 })
    );
    head.position.set(lx + (lx < 0 ? 0.5 : -0.5), 7.1, lx < 0 ? -4 : 6);
    g.add(head);

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, fog: true })
    );
    bulb.position.set(lx + (lx < 0 ? 0.7 : -0.7), 6.95, lx < 0 ? -4 : 6);
    g.add(bulb);
  }

  // 报废汽车：车身 + 车顶，两个盒子就够读出来了
  const car = new THREE.Group();
  const body = boxMesh(2.0, 0.85, 4.4, rust, { rough: 0.7, metal: 0.35 });
  body.position.y = 0.55;
  car.add(body);
  const cabin = boxMesh(1.75, 0.75, 2.2, 0x2b2a2a, { rough: 0.5, metal: 0.3 });
  cabin.position.set(0, 1.35, -0.2);
  car.add(cabin);
  car.position.set(-11.4, 0, 8.5);
  car.rotation.y = 0.28;
  g.add(car);

  // 前景碎石堆：矮，只压画面下缘
  for (let i = 0; i < 10; i++) {
    const r = 0.25 + rng() * 0.5;
    const rock = rockMesh(rng, r, 0x4a4f57);
    rock.position.set((rng() - 0.5) * 26, r * 0.5, 13 + rng() * 5);
    g.add(rock);
  }
}

function buildJungleProps(g, rng) {
  const trunk = 0x3a2e22;
  const leafA = 0x1f3a24;
  const leafB = 0x2b4a2c;

  // 后面一整片树墙，挡住地平线
  for (let i = 0; i < 16; i++) {
    const h = 7 + rng() * 6;
    const t = treeMesh(rng, h, trunk, rng() > 0.5 ? leafA : leafB);
    t.position.set(-40 + i * 5.2 + rng() * 2, 0, -28 - rng() * 5);
    t.rotation.y = rng() * Math.PI;
    g.add(t);
  }

  // 两侧的树，靠近镜头，形成框景
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const h = 8 + rng() * 5;
      const t = treeMesh(rng, h, trunk, rng() > 0.5 ? leafA : leafB);
      t.position.set(side * (11 + rng() * 6), 0, -16 + i * 5.5 + rng() * 2);
      t.rotation.y = rng() * Math.PI;
      g.add(t);
    }
  }

  // 灌木：压扁的球
  for (let i = 0; i < 18; i++) {
    const r = 0.8 + rng() * 1.1;
    const bush = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r, 1),
      mat(rng() > 0.5 ? leafA : leafB, { flat: true, rough: 1 })
    );
    bush.scale.y = 0.55;
    const x = (rng() - 0.5) * 34;
    bush.position.set(Math.abs(x) < 9.6 ? Math.sign(x || 1) * (10 + rng() * 4) : x, r * 0.4, -26 + rng() * 40);
    g.add(bush);
  }

  // 石块
  for (let i = 0; i < 12; i++) {
    const r = 0.4 + rng() * 0.9;
    const rock = rockMesh(rng, r, 0x4a4f42);
    const x = (rng() - 0.5) * 32;
    rock.position.set(Math.abs(x) < 9.6 ? Math.sign(x || 1) * (10 + rng() * 4) : x, r * 0.5, -24 + rng() * 36);
    g.add(rock);
  }

  // 前景：倒伏的树干，横在画面下缘
  const log = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.55, 9, 8),
    mat(0x2f2419, { flat: true, rough: 1 })
  );
  log.rotation.z = Math.PI / 2;
  log.rotation.y = 0.15;
  log.position.set(-4, 0.5, 15.5);
  g.add(log);
}

function buildDesertProps(g, rng) {
  const sand = 0x9a8360;
  const rock = 0x7d6a4e;
  const dry = 0x6b5a40;

  // 远处岩壁，把地平线挡掉
  for (let i = 0; i < 8; i++) {
    const w = 7 + rng() * 8;
    const h = 6 + rng() * 9;
    const b = boxMesh(w, h, 4 + rng() * 4, 0x8a7250, { rough: 1, flat: true });
    b.position.set(-42 + i * 12 + rng() * 3, h / 2, -30 - rng() * 4);
    b.rotation.y = (rng() - 0.5) * 0.3;
    b.rotation.z = (rng() - 0.5) * 0.06;
    g.add(b);
  }

  // 沙丘：压扁的球
  for (let i = 0; i < 10; i++) {
    const r = 4 + rng() * 6;
    const dune = new THREE.Mesh(
      new THREE.SphereGeometry(r, 12, 8),
      mat(sand, { rough: 1, flat: true })
    );
    dune.scale.set(1.4, 0.22, 1);
    const x = (rng() - 0.5) * 46;
    dune.position.set(Math.abs(x) < 12 ? Math.sign(x || 1) * (13 + rng() * 6) : x, -0.2, -26 + rng() * 46);
    g.add(dune);
  }

  // 岩石群
  for (let i = 0; i < 14; i++) {
    const r = 0.6 + rng() * 1.8;
    const rk = rockMesh(rng, r, rock);
    const x = (rng() - 0.5) * 34;
    rk.position.set(Math.abs(x) < 9.8 ? Math.sign(x || 1) * (10.2 + rng() * 5) : x, r * 0.5, -22 + rng() * 36);
    g.add(rk);
  }

  // 枯树：细干 + 两三根歪枝
  for (let i = 0; i < 5; i++) {
    const h = 4 + rng() * 3;
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.24, h, 5), mat(dry, { flat: true, rough: 1 }));
    trunk.position.y = h / 2;
    t.add(trunk);
    for (let k = 0; k < 3; k++) {
      const bl = 1.2 + rng() * 1.2;
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, bl, 4), mat(dry, { flat: true, rough: 1 }));
      branch.position.set(0, h * (0.5 + k * 0.15), 0);
      branch.rotation.z = (rng() > 0.5 ? 1 : -1) * (0.7 + rng() * 0.5);
      branch.rotation.y = rng() * Math.PI;
      branch.translateY(bl / 2);
      t.add(branch);
    }
    const side = i % 2 ? 1 : -1;
    t.position.set(side * (10.5 + rng() * 5), 0, -14 + i * 6 + rng() * 2);
    g.add(t);
  }

  // 前景：几块半埋的石头
  for (let i = 0; i < 8; i++) {
    const r = 0.5 + rng() * 1.0;
    const rk = rockMesh(rng, r, rock);
    rk.position.set((rng() - 0.5) * 28, r * 0.35, 13 + rng() * 6);
    g.add(rk);
  }
}

function buildMoonProps(g, rng) {
  const rockA = 0x6a6d72;
  const rockB = 0x4a4d52;

  // 陨石坑：一圈低矮的环
  for (let i = 0; i < 6; i++) {
    const r = 4 + rng() * 5;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, r * 0.09, 6, 24),
      mat(rockB, { flat: true, rough: 1 })
    );
    ring.rotation.x = -Math.PI / 2;
    const x = (rng() - 0.5) * 40;
    ring.position.set(Math.abs(x) < 14 ? Math.sign(x || 1) * (16 + rng() * 6) : x, 0.25, -24 + rng() * 40);
    g.add(ring);
  }

  // 巨石与碎石
  for (let i = 0; i < 22; i++) {
    const r = 0.7 + rng() * 3.2;
    const rk = rockMesh(rng, r, rng() > 0.5 ? rockA : rockB);
    const x = (rng() - 0.5) * 46;
    rk.position.set(Math.abs(x) < 10 ? Math.sign(x || 1) * (10.5 + rng() * 6) : x, r * 0.4, -28 + rng() * 50);
    rk.rotation.y = rng() * Math.PI;
    g.add(rk);
  }

  // 远处的地球：贴着地平线升起的大星球，一眼就知道这是月球。
  // 球心压到地面高度（y≈0.5），一半沉在"地面尽头"之下，看起来就是从地平线探出大半个球。
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(3, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0x3f78b8, fog: false })
  );
  earth.position.set(4, -1, -20);
  g.add(earth);

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(3.9, 20, 20),
    new THREE.MeshBasicMaterial({
      color: 0x6fa8e0,
      transparent: true,
      opacity: 0.12,
      fog: false,
      depthWrite: false,
    })
  );
  glow.position.copy(earth.position);
  g.add(glow);
}

function buildSnowProps(g, rng) {
  const snow = 0xe6eef6;
  const ice = 0x9fc4d8;
  const rockC = 0x5a6068;

  // 远处雪脊
  for (let i = 0; i < 9; i++) {
    const w = 8 + rng() * 9;
    const h = 5 + rng() * 8;
    const peak = new THREE.Mesh(
      new THREE.ConeGeometry(w / 2, h, 5),
      mat(0xd3dde8, { flat: true, rough: 1 })
    );
    peak.position.set(-42 + i * 11 + rng() * 3, h / 2 - 0.4, -30 - rng() * 4);
    peak.rotation.y = rng() * Math.PI;
    g.add(peak);
  }

  // 积雪堆
  for (let i = 0; i < 12; i++) {
    const r = 2 + rng() * 4;
    const mound = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat(snow, { rough: 0.85 }));
    mound.scale.set(1.3, 0.3, 1);
    const x = (rng() - 0.5) * 44;
    mound.position.set(Math.abs(x) < 12 ? Math.sign(x || 1) * (13 + rng() * 6) : x, -0.1, -24 + rng() * 42);
    g.add(mound);
  }

  // 枯树
  for (let i = 0; i < 7; i++) {
    const h = 5 + rng() * 4;
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.3, h, 5), mat(0x3a4048, { flat: true, rough: 1 }));
    trunk.position.y = h / 2;
    t.add(trunk);
    for (let k = 0; k < 4; k++) {
      const bl = 1.4 + rng() * 1.4;
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, bl, 4), mat(0x3a4048, { flat: true, rough: 1 }));
      branch.position.set(0, h * (0.45 + k * 0.13), 0);
      branch.rotation.z = (rng() > 0.5 ? 1 : -1) * (0.6 + rng() * 0.6);
      branch.rotation.y = rng() * Math.PI;
      branch.translateY(bl / 2);
      t.add(branch);
    }
    const side = i % 2 ? 1 : -1;
    t.position.set(side * (10.8 + rng() * 5), 0, -16 + i * 5 + rng() * 2);
    g.add(t);
  }

  // 冰棱
  for (let i = 0; i < 8; i++) {
    const h = 1.2 + rng() * 2.2;
    const spike = new THREE.Mesh(
      new THREE.ConeGeometry(0.28 + rng() * 0.2, h, 4),
      mat(ice, { rough: 0.25, metal: 0.1, flat: true })
    );
    const x = (rng() - 0.5) * 30;
    spike.position.set(Math.abs(x) < 9.6 ? Math.sign(x || 1) * (10.2 + rng() * 4) : x, h / 2, -14 + rng() * 26);
    g.add(spike);
  }

  // 前景的岩石
  for (let i = 0; i < 6; i++) {
    const r = 0.6 + rng() * 1.2;
    const rk = rockMesh(rng, r, rockC);
    rk.position.set((rng() - 0.5) * 26, r * 0.4, 13 + rng() * 5);
    g.add(rk);
  }
}

function buildLavaProps(g, rng) {
  const char = 0x2a2422;
  const stone = 0x3a2e28;

  // 远处火山锥
  for (let i = 0; i < 3; i++) {
    const w = 16 + rng() * 10;
    const h = 12 + rng() * 8;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(w / 2, h, 7), mat(0x241b18, { flat: true, rough: 1 }));
    cone.position.set(-38 + i * 34 + rng() * 6, h / 2 - 1, -32 - rng() * 4);
    cone.rotation.y = rng() * Math.PI;
    g.add(cone);

    // 火山口的红光
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(w * 0.14, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff5a2a, fog: true })
    );
    glow.position.set(cone.position.x, h - 1.5, cone.position.z);
    glow.scale.y = 0.5;
    g.add(glow);
  }

  // 焦黑石柱
  for (let i = 0; i < 14; i++) {
    const r = 0.5 + rng() * 1.6;
    const h = 2 + rng() * 6;
    const spire = rockMesh(rng, r, rng() > 0.5 ? char : stone);
    spire.scale.y = h / (r * 0.9);
    const x = (rng() - 0.5) * 42;
    spire.position.set(Math.abs(x) < 10 ? Math.sign(x || 1) * (10.5 + rng() * 6) : x, 0, -28 + rng() * 46);
    spire.rotation.y = rng() * Math.PI;
    g.add(spire);
  }

  // 地面上的岩浆裂隙：自发光的长条，纯粹为了给画面一点暖色
  for (let i = 0; i < 9; i++) {
    const len = 2 + rng() * 5;
    const crack = new THREE.Mesh(
      new THREE.PlaneGeometry(0.35 + rng() * 0.3, len),
      new THREE.MeshBasicMaterial({
        color: 0xff6420,
        transparent: true,
        opacity: 0.75,
        fog: true,
        depthWrite: false,
      })
    );
    crack.rotation.x = -Math.PI / 2;
    crack.rotation.z = (rng() - 0.5) * 1.6;
    const x = (rng() - 0.5) * 38;
    crack.position.set(Math.abs(x) < 9.6 ? Math.sign(x || 1) * (10 + rng() * 5) : x, 0.03, -26 + rng() * 44);
    g.add(crack);
  }

  // 前景的焦炭块
  for (let i = 0; i < 7; i++) {
    const r = 0.5 + rng() * 1.0;
    const rk = rockMesh(rng, r, char);
    rk.position.set((rng() - 0.5) * 28, r * 0.4, 13 + rng() * 5);
    g.add(rk);
  }
}

/* ----------------------------------------------------------
 * 道具用的小工具
 * ---------------------------------------------------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mat(color, o = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: o.rough ?? 0.9,
    metalness: o.metal ?? 0.04,
    flatShading: o.flat ?? false,
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.ei ?? 1,
  });
}

// 每个方块的原点都在底面中心，摆位时直接写 y = 0
function boxMesh(w, h, d, color, o = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, o));
  m.position.y = h / 2;
  return m;
}

// 随机形变的石头：低面数，flatShading 让棱角更硬
function rockMesh(rng, r, color) {
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.7 + rng() * 0.6;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.85, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();

  const m = new THREE.Mesh(geo, mat(color, { flat: true, rough: 1 }));
  m.position.y = r * 0.5;
  return m;
}

function treeMesh(rng, h, trunkColor, leafColor) {
  const g = new THREE.Group();

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(h * 0.04, h * 0.075, h * 0.62, 6),
    mat(trunkColor, { flat: true, rough: 1 })
  );
  trunk.position.y = h * 0.31;
  g.add(trunk);

  for (let i = 0; i < 3; i++) {
    const r = h * 0.3 * (1 - i * 0.22);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(r, h * 0.42, 7),
      mat(leafColor, { flat: true, rough: 1 })
    );
    cone.position.y = h * 0.52 + i * h * 0.2;
    cone.rotation.y = rng() * Math.PI;
    g.add(cone);
  }

  return g;
}

/* ----------------------------------------------------------
 * 模型
 * ---------------------------------------------------------- */
function makeBarrierMesh(bar) {
  const group = new THREE.Group();

  const barMat = new THREE.MeshStandardMaterial({
    color: 0x2fbf71,
    emissive: 0x0d5c33,
    roughness: 0.5,
    metalness: 0.1,
  });

  const barMesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.28, 0.5), barMat);
  barMesh.position.y = 0.14;
  group.add(barMesh);

  // 浮在上面的数值标签，Sprite 永远朝向相机
  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getValueTexture(bar.value),
      transparent: true,
      depthWrite: false,
    })
  );
  label.scale.set(1.3, 0.65, 1);
  label.position.y = 0.95;
  group.add(label);

  group.userData = { barMat, label, labelValue: bar.value };
  return group;
}

function updateBarrierAppearance(mesh, bar) {
  const { barMat, label } = mesh.userData;
  const isNegative = bar.value < 0;

  barMat.color.setHex(isNegative ? 0xff5a5a : 0x2fbf71);
  barMat.emissive.setHex(isNegative ? 0x5c0d0d : 0x0d5c33);

  if (mesh.userData.labelValue !== bar.value) {
    mesh.userData.labelValue = bar.value;
    label.material.map = getValueTexture(bar.value);
    label.material.needsUpdate = true;
  }
}

function makeZombieMesh(type) {
  const colors = [0x8f5a5a, 0x6b8f5a, 0x5a6f8f];

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 1.15, 0.7),
    new THREE.MeshStandardMaterial({
      color: colors[type % colors.length],
      roughness: 0.85,
    })
  );

  // 脚下的影子跟着僵尸一起动
  const shadow = makeBlobShadow(0.45);
  shadow.position.y = -0.55;
  mesh.add(shadow);

  return mesh;
}

function makeBlobShadow(radius) {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 24),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

const valueTextures = new Map();

function getValueTexture(value) {
  const key = String(value);
  const cached = valueTextures.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 64);
  ctx.font = 'bold 46px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = value < 0 ? '#ff8a8a' : '#6dffb0';
  ctx.fillText(value > 0 ? `+${value}` : String(value), 64, 34);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  valueTextures.set(key, tex);
  return tex;
}

/* ----------------------------------------------------------
 * 特效
 * ---------------------------------------------------------- */
function spawnMuzzleFlash(x, z) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 1 })
  );
  mesh.position.set(x, 0.9, z - 0.9);
  scene.add(mesh);
  effects.push({ mesh, life: 0, maxLife: 0.09, type: 'flash' });
}

function spawnRing(x, z, color, maxLife) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.18, 0.32, 20),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.06, z);
  scene.add(mesh);
  effects.push({ mesh, life: 0, maxLife, type: 'ring' });
}

function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const fx = effects[i];
    fx.life += dt;

    const t = fx.life / fx.maxLife;

    if (t >= 1) {
      scene.remove(fx.mesh);
      disposeMesh(fx.mesh);
      effects.splice(i, 1);
      continue;
    }

    if (fx.type === 'ring') {
      const s = 1 + t * 3;
      fx.mesh.scale.set(s, s, s);
      fx.mesh.material.opacity = (1 - t) * 0.9;
    } else {
      fx.mesh.scale.setScalar(1 + t * 0.6);
      fx.mesh.material.opacity = 1 - t;
    }
  }
}

/* ----------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------- */
function loadGroundTextures(renderer, mapId) {
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // 一格贴图铺 GROUND_TILE 个世界单位。铺多大是关键参数：
  // 太小会糊（纹理颗粒比屏幕像素还细，被平均掉），太大会失真。
  // 全部贴图统一用 1k，所以六张地图共用同一个尺度。
  const rx = GROUND_W / GROUND_TILE;
  const ry = GROUND_H / GROUND_TILE;

  const load = (file, isColor) => {
    const tex = loader.load(new URL(`../assets/${file}.jpg`, import.meta.url).href);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(rx, ry);
    tex.anisotropy = maxAniso;
    if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  return {
    map: load(`${mapId}-diff`, true),
    normalMap: load(`${mapId}-nor_gl`, false),
    roughnessMap: load(`${mapId}-rough`, false),
  };
}

function disposeMesh(mesh) {
  mesh.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
}

/* ----------------------------------------------------------
 * 视口变化：重算透视相机的距离
 *
 * 约束只有一个——玩家能左右走到 ±8，所以玩家所在平面（z=9）
 * 必须看见至少 ±9.4。反过来解相机该站在多远：
 *   斜距 S = halfWidth / tan(水平半角)
 *   D² - 2·z0·cosθ·D + (z0² - S²) = 0
 * 解出来的正根就是相机到注视点的距离。
 * ---------------------------------------------------------- */
function resize() {
  if (!containerEl || !renderer || !camera) return;

  const w = containerEl.clientWidth;
  const h = containerEl.clientHeight;
  const aspect = w / h;

  const tilt = (CAM.tilt * Math.PI) / 180;
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);

  const tanV = Math.tan((CAM.fov * Math.PI) / 360);
  const tanH = tanV * aspect;

  const z0 = 9; // 玩家所在平面
  const S = CAM.halfWidth / tanH; // 到该平面需要的斜距

  const D = z0 * c + Math.sqrt(Math.max(4, S * S - z0 * z0 * s * s));

  camDist = D;
  camY = D * s;
  camZ = D * c;

  camera.aspect = aspect;
  camera.fov = CAM.fov;
  camera.updateProjectionMatrix();

  renderer.setSize(w, h);
}
