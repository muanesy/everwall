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
  playZombieAttack,
  playBarrierHit,
  playBarrierApply,
  playArmyHurt,
  playWaveStart,
} from './audio.js';
// 三个乙层模块：兵种阶级外观表、昼夜轮转、炸药桶（新文件，按文件边界属乙）
import { TIERS, getTier, getTierIndex } from './visuals-tiers.js';
import { createDayNight, nightForWave } from './visuals-daynight.js';
import { initBarrels, updateBarrels, resetBarrels, hitTestBarrel } from './visuals-barrels.js';

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

const MAX_SOLDIER_VISUALS = 120;

// 僵尸开始挥拳的 z 线。game.js 里 touchZ=8.2（碰到扣兵）、killZ=8.4（停住滑行），
// 这里取 7.4：贴到防线跟前就进入攻击动作，配合滑行前倾读起来是"扑上去挠"
const ZOMBIE_ATK_Z = 7.4;

const GROUND_TILE = 40;  // 一格贴图铺多少世界单位。1k 贴图在这个尺度下约 1:1 像素
const GROUND_W = 140;
const GROUND_H = 76;     // 从 z=+24 铺到 z=-52：地面要比战斗区远一截，
                         // 后面的火山/雪脊/楼群这些大件才有地方站，不会悬空
const GROUND_Z = -14;

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

// 昼夜轮转：初始化时创建，波次切换时改状态，每帧推进过渡
let dayNight = null;

// 兵种阶级：记录当前档位，只在升级那一帧变外观，不每帧重算
let soldierTierIndex = -1;
let tierAnnounced = false;   // 开局那次不算"晋升"，不弹提示
let soldierBaseScale = 1;    // 原型归一化后的基准缩放（乘档位倍率用）
let soldierMats = null;      // [{ mat, baseColor, baseEmissive }]，用来还原再乘色
let lastWave = 1;            // 上一帧的波次，用来识别"重开一局"

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
  zombies: [],     // 五种僵尸原型，下标 = game.js 的 z.type，约定见 docs/僵尸类型.md
};

// 五种僵尸的外观表（数值归 game.js，这里只管外观）。
// tint 是乘色：白 = 原色。材质各自独立克隆，乘色不会互相串。
// walkSpeed 只影响走路动画节奏——比颜色更能传达"笨重"和"快"。
// score 只用来决定"死了飘不飘字"和飘多少，必须跟 game.js CONFIG.zombie.types[].score 对齐；
// 甲改那边分数的话这里跟着改。
const ZOMBIE_LOOKS = [
  { src: 'male',   scale: 1.0,  tint: [0.80, 0.90, 0.84], walkSpeed: 1.0, attackSpeed: 1.0, score: 1 },   // 0 普通 灰绿
  { src: 'male',   scale: 1.25, tint: [0.88, 0.62, 0.58], walkSpeed: 0.85, attackSpeed: 0.75, score: 3 },  // 1 大块头 暗红灰（出拳慢而重）
  { src: 'male',   scale: 0.85, tint: [0.92, 1.00, 0.55], walkSpeed: 1.3, attackSpeed: 1.6, score: 1 },    // 2 快鬼 黄绿（挠拳飞快）
  { src: 'female', scale: 1.1,  tint: [1.05, 1.06, 1.12], walkSpeed: 1.0, attackSpeed: 1.15, score: 5, emissive: 0.08 }, // 3 精英 灰白提亮
  { src: 'female', scale: 1.0,  tint: [0.70, 0.78, 0.74], walkSpeed: 1.0, attackSpeed: 1.2, score: 2 },    // 4 女僵尸 原色压暗
];
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

// 把一种僵尸外观做成独立原型：独立克隆 + 独立材质（骨架克隆默认共享材质，
// 直接乘色会让同源的类型互相串色），再缩放到目标身高并乘色。
function prepareZombieType(rawProto, look) {
  const proto = skeletonClone(rawProto);
  // Object3D.clone 会把 userData 做 JSON 拷贝，AnimationClip 引用会被换成普通对象，
  // 这里必须把真动画引用补回来，否则这一类型的僵尸不会走路
  proto.userData.clip = rawProto.userData.clip;
  proto.userData.attackClip = rawProto.userData.attackClip;
  proto.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && o.material) {
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => m.clone())
        : o.material.clone();
    }
  });
  preparePrototype(
    proto,
    MODEL_TARGET.zombieHeight * look.scale,
    new THREE.Color(look.tint[0], look.tint[1], look.tint[2])
  );
  if (look.emissive) {
    // 精英在暗图上要能读出来，给一点点自发光提亮
    proto.traverse((o) => {
      if ((o.isMesh || o.isSkinnedMesh) && o.material?.emissive) {
        o.material.emissive.setScalar(look.emissive);
      }
    });
  }
  proto.userData.walkSpeed = look.walkSpeed;
  proto.userData.attackSpeed = look.attackSpeed || 1.0;
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
    // 攻击动画（UA 系列有 Punch 出拳），没有就留空 → 该类型不播攻击动作
    proto.userData.attackClip =
      clips.find((c) => /punch|attack|bite|slash/i.test(c.name)) || null;
    return proto;
  };

  Promise.all([
    loader.loadAsync(base + 'b-zombie-soldier.glb'),
    loader.loadAsync(base + 'b-zombie-male.glb'),
    loader.loadAsync(base + 'b-zombie-female.glb'),
  ])
    .then(([s, zm, zf]) => {
      modelLib.soldier = preparePrototype(grab(s, /idle/i), MODEL_TARGET.soldierHeight);
      // 男/女两个原始场景只作克隆源，五种类型各自从这里克隆
      const rawZombie = { male: grab(zm, /walk/i), female: grab(zf, /walk/i) };
      modelLib.zombies = ZOMBIE_LOOKS.map((look) =>
        prepareZombieType(rawZombie[look.src], look)
      );
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
    let walkAction = null;
    let attackAction = null;
    const clip = proto.userData.clip;
    if (clip) {
      mixer = new THREE.AnimationMixer(root);
      walkAction = mixer.clipAction(clip);
      walkAction.play();
      // 走路节奏按类型调：大块头慢（笨重）、快鬼快（窜）——比颜色更能传达体型差异
      if (proto.userData.walkSpeed) walkAction.timeScale = proto.userData.walkSpeed;
      walkAction.time = Math.random() * clip.duration; // 打散步伐
      // 攻击动作待命：走到防线附近时由 syncZombies 切换（走 ↔ 打）
      if (proto.userData.attackClip) {
        attackAction = mixer.clipAction(proto.userData.attackClip);
        attackAction.timeScale = proto.userData.attackSpeed || 1.0;
      }
      animMixers.add(mixer);
    }
    return { root, mixer, walkAction, attackAction, attacking: false };
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

// 战斗特效升级件（对象在 initVisuals 里创建）：
// muzzleLight 枪口点光源、粒子池（血雾/魂火共用一套 Points）、HTML 覆盖层（波次横幅/扣兵红屏/击杀飘字/升级提示）
let muzzleLight = null;
let fxBanner = null;
let fxHurt = null;
let fxFloats = null;   // 击杀飘字的容器（绝对定位，位置每帧由相机投影算）
let fxToast = null;    // 屏障升级之类的小提示条
const FX_P_MAX = 500;
const fxPool = Array.from({ length: FX_P_MAX }, () => ({ life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, g: 0 }));
let fxGeo = null;
let fxPos = null;
let fxCol = null;

// 击杀飘字：只给大块头/精英用，同屏最多 8 条，多了顶掉最老的
const FLOAT_MAX = 8;
const FLOAT_LIFE = 0.9;
const floatFeed = [];

// 地上血迹：僵尸死后留一片，10 秒淡出，场上最多 14 片（多了顶掉最早的，避免叠成一坨）
const BLOOD_MAX = 14;
const BLOOD_LIFE = 10;
const bloodDecals = [];
let bloodTex = null;

// 开火后坐力：整队沿 z 方向轻微一顿，衰减很快，只是"枪有后坐"的体感，不是真的位移
let soldierRecoil = 0;

// 升级提示条：同一时刻只显示一条，其余排队
const toastQueue = [];
let toastLife = 0;
const TOAST_LIFE = 1.5;

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

  // 昼夜轮转：把当前地图的灯光/雾/背景当基线记下来，之后只做倍数插值，
  // 六张地图亮度差异大，写死绝对值会让月球糊成黑屏、沙漠看不出变化
  dayNight = createDayNight({ scene, hemi, key: keyLight, ambient: fillLight });

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

  // 炸药桶：摆在两侧通道边（不压僵尸主路、不压士兵阵），模型全程序化生成。
  // 爆炸伤害归甲，这里只负责桶的样子、爆炸特效，以及给甲查命中用的 hitTestBarrel
  initBarrels({ scene, events });

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

  // 枪口火光点光源：shoot 时点亮、每帧快速衰减
  muzzleLight = new THREE.PointLight(0xffc36d, 0, 9);
  muzzleLight.position.set(0, 0.9, 8);
  scene.add(muzzleLight);

  // 粒子池：血雾/魂火共用一套 Points，逐帧只改坐标不分配几何体
  fxGeo = new THREE.BufferGeometry();
  fxPos = new Float32Array(FX_P_MAX * 3);
  fxCol = new Float32Array(FX_P_MAX * 3);
  fxGeo.setAttribute('position', new THREE.BufferAttribute(fxPos, 3));
  fxGeo.setAttribute('color', new THREE.BufferAttribute(fxCol, 3));
  const fxPoints = new THREE.Points(
    fxGeo,
    new THREE.PointsMaterial({
      size: 0.16,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
  );
  fxPoints.frustumCulled = false;
  for (let i = 0; i < FX_P_MAX; i++) fxPos[i * 3 + 1] = -999; // 藏到地下
  scene.add(fxPoints);

  // HTML 覆盖层：波次横幅 + 扣兵红屏 + 击杀飘字 + 升级提示（样式在 styles.css）
  const fxLayer = document.createElement('div');
  fxLayer.innerHTML = `
    <div class="fx-banner"><div class="fx-banner__title"></div><div class="fx-banner__sub"></div></div>
    <div class="fx-hurt"></div>
    <div class="fx-floats"></div>
    <div class="fx-toast"></div>`;
  document.body.appendChild(fxLayer);
  fxBanner = fxLayer.querySelector('.fx-banner');
  fxHurt = fxLayer.querySelector('.fx-hurt');
  fxFloats = fxLayer.querySelector('.fx-floats');
  fxToast = fxLayer.querySelector('.fx-toast');

  window.addEventListener('resize', resize);
  resize();

  // 环境音跟着地图走（雨林虫鸣、沙漠风沙、月球真空……）
  setAmbient(MAP_ID);

  // 预加载角色模型：加载完成前用色块顶替，完成后自动换
  loadModels();

  // 事件 → 特效 + 音效
  events.addEventListener('shoot', (e) => {
    const origins = e.detail.origins || [{ x: e.detail.x, z: e.detail.z }];
    for (const o of origins) spawnMuzzleFlash(o.x, o.z);

    if (muzzleLight) {
      const mid = origins[Math.floor(origins.length / 2)] || origins[0];
      muzzleLight.position.set(mid.x, 0.9, mid.z - 0.15);
      muzzleLight.intensity = 22;
    }

    // 后坐力：整队往后一顿，压着上限别让队伍真的跑位
    soldierRecoil = Math.min(0.05, soldierRecoil + 0.022);

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
    const x = e.detail.x;
    const z = e.detail.z;
    const type = e.detail.type ?? 0;
    const look = ZOMBIE_LOOKS[type] || ZOMBIE_LOOKS[0];

    // 血雾 + 几粒绿色魂火 + 原有红环，死亡更有"交代"
    spawnBurst(x, 1.0, z, 0x8a2f22, 16, { speed: 2.6, up: 2.4, spread: 0.5, life: 0.6 });
    spawnBurst(x, 0.8, z, 0x86c06c, 6, { speed: 1.4, up: 2.0, spread: 0.4, life: 0.7 });
    spawnRing(x, z, 0xff6a4a, 0.42);

    // 地上留血：越大越肉的死得越有痕迹
    spawnBlood(x, z, type === 1 ? 1.25 : type === 3 ? 1.1 : 0.9);

    // 大块头和精英才飘分数，普通怪不飘——不然满屏数字看不清
    if (look.score >= 3) spawnScoreFloat(x, z, look.score, type === 3);

    playZombieDie();
  });

  events.addEventListener('bulletPierce', (e) => {
    spawnRing(e.detail.x, e.detail.z, 0xb06bff, 0.16);
  });

  events.addEventListener('armyHurt', (e) => {
    const amount = e.detail?.amount ?? 1;
    shake = 0.3 + amount * 0.12;
    // 屏幕四周红色边缘光闪一下
    if (fxHurt) {
      fxHurt.classList.remove('show');
      void fxHurt.offsetWidth; // 强制重排，让动画能连续重触发
      fxHurt.classList.add('show');
    }
    playArmyHurt(amount);
  });

  events.addEventListener('waveStart', (e) => {
    shake = 0.2;
    const wave = e.detail?.wave;

    // 昼夜轮转：每 3 波换一次。夜晚画面变暗、雾变近（僵尸加速是甲的事）
    const wasNight = dayNight ? dayNight.isNight : false;
    const night = nightForWave(wave);
    if (dayNight) dayNight.setNight(night);
    if (night && !wasNight) pushToast('夜幕降临 · 僵尸加速', 'night');

    // 金色波次横幅：放大进场 → 停留 → 淡出
    if (fxBanner && wave) {
      fxBanner.querySelector('.fx-banner__title').textContent = `第 ${wave} 波`;
      fxBanner.querySelector('.fx-banner__sub').textContent = night
        ? '— 夜幕来袭 —'
        : '— 僵尸潮来袭 —';
      fxBanner.classList.remove('show');
      void fxBanner.offsetWidth;
      fxBanner.classList.add('show');
    }
    playWaveStart();
  });

  // 屏障攒满的两种升级：给一条短提示，让玩家知道刚才那波子弹换来了什么
  events.addEventListener('weaponUpgrade', (e) => {
    const lines = e.detail?.lines;
    pushToast(lines ? `火力增援 · 前排 ${lines} 排` : '火力增援', 'weapon');
    spawnBurst(0, 1.1, 6.5, 0x6fc2ff, 12, { speed: 3.0, up: 2.4, spread: 2.2, life: 0.7 });
    shake = Math.max(shake, 0.16);
  });

  events.addEventListener('pierceUnlock', () => {
    pushToast('穿透器已解锁', 'pierce');
    spawnBurst(0, 1.1, 6.5, 0xb06bff, 12, { speed: 3.0, up: 2.4, spread: 2.2, life: 0.7 });
    shake = Math.max(shake, 0.16);
  });
}

/* ----------------------------------------------------------
 * 给甲用的查询接口
 * ---------------------------------------------------------- */

/* 子弹有没有打中炸药桶。命中就点燃引信（0.12 秒后自动爆炸并派发
 * barrelExploded 事件给甲结算范围伤害），返回命中的桶对象或 null。
 * 用法：子弹每帧推进后调一次 hitBarrel(b.x, b.z)，非 null 就让子弹消失。 */
export function hitBarrel(x, z, radius = 0.5) {
  return hitTestBarrel(x, z, radius);
}

/* ----------------------------------------------------------
 * 每帧同步
 * ---------------------------------------------------------- */
export function syncScene(state, dt) {
  if (!renderer) return;

  // 重开一局：波次回到 1 而上一帧还在后面的波次，说明是新的一局
  if (lastWave > 1 && state.wave === 1) {
    resetBarrels();                      // 桶全部复原
    if (dayNight) dayNight.setNight(false, true); // 立刻回到白天，不要跨局慢慢过渡
    soldierTierIndex = -1;               // 兵种档位重算（不弹晋升提示）
    tierAnnounced = false;
  }
  lastWave = state.wave;

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
  syncZombies(state, dt);

  // 子弹
  syncBullets(state);

  updateEffects(dt);
  updateParticleFx(dt);
  updateFloats(dt);
  updateBlood(dt);
  updateToast(dt);
  updateBarrels(dt);
  if (dayNight) dayNight.update(dt);
  soldierRecoil = soldierRecoil > 0 ? Math.max(0, soldierRecoil - dt * 0.55) : 0;
  if (muzzleLight) muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 240);
  updateCamera(state, dt);

  // 骨骼动画：所有活着的 mixer 每帧推进（隐藏的士兵 timeScale=0 不耗动画计算）
  for (const m of animMixers) m.update(dt);

  renderer.render(scene, camera);
}

function soldierSlot(i, state) {
  // 前排最宽的三角阵：第 0 排 frontCount 人，往后每排少一人
  const r = state.formation ? state.formation.frontCount : 1;
  const spacing = 0.42;
  const rowGap = 0.32;

  let row = 0;
  let start = 0;
  let len = r;

  while (i >= start + len && len > 1) {
    start += len;
    row += 1;
    len = r - row;
  }

  const col = i - start;
  const width = Math.max(1, len);

  return {
    x: state.player.x + (col - (width - 1) / 2) * spacing,
    z: state.player.z + 0.25 + row * rowGap,
  };
}

const soldierVisuals = []; // 真模型池：{ root, mixer }

/* 兵种阶级：把档位外观套到士兵身上
 * 色块回退和真模型两条路都要管，而且只在档位变化那一帧做，不每帧重算材质。
 * 门槛 5 / 20 / 50（保安 → 正规军 → 特种兵）在 visuals-tiers.js 里，
 * 数值加成（伤害、射速）归甲，这里只管颜色、体型、微光。 */
function captureSoldierMats() {
  if (soldierMats) return;
  const proto = modelLib.soldier;
  if (!proto) return; // 模型还没加载完：下次再抓，别把空数组当"已抓过"
  const found = [];
  soldierBaseScale = proto.scale.x || 1;
  const seen = new Set();
  proto.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.color || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      found.push({
        mat: m,
        baseColor: m.color.clone(),
        baseEmissive: m.emissive ? m.emissive.clone() : null,
      });
    }
  });
  if (found.length) soldierMats = found;
}

function applySoldierTier(tier) {
  // 色块回退：直接改材质颜色
  if (soldierMesh) {
    soldierMesh.material.color.setHex(tier.color);
    if (soldierMesh.material.emissive) {
      soldierMesh.material.emissive.setHex(tier.color);
      soldierMesh.material.emissiveIntensity = tier.emissive || 0;
    }
  }

  // 真模型：材质是骨架克隆共享的，全队同档位，改一次就够。
  // 必须先还原基准色再乘，否则每次升级颜色会越乘越偏。
  captureSoldierMats();
  if (soldierMats) {
    const tint = new THREE.Color(tier.tint[0], tier.tint[1], tier.tint[2]);
    for (const rec of soldierMats) {
      rec.mat.color.copy(rec.baseColor).multiply(tint);
      if (rec.baseEmissive && rec.mat.emissive) {
        rec.mat.emissive.copy(rec.baseEmissive).add(
          new THREE.Color(tier.accent).multiplyScalar(tier.emissive || 0)
        );
      }
    }
  }

  // 体型：两条路都按倍率缩放（模型缩放写进每帧的 root.scale，见下面）
  if (soldierMesh) soldierMesh.scale.setScalar(1); // 方块靠实例矩阵缩放，网格本身保持 1
}

function updateSoldiers(state) {
  const n = Math.min(state.soldiers, MAX_SOLDIER_VISUALS);

  // 档位变化：改外观 + 弹一条晋升提示（开局那次不弹）
  const ti = getTierIndex(state.soldiers);
  let tier = TIERS[ti];
  if (ti !== soldierTierIndex) {
    soldierTierIndex = ti;
    tier = getTier(state.soldiers);
    applySoldierTier(tier);
    if (tierAnnounced) {
      pushToast(`晋升 · ${tier.name}`, 'tier');
      spawnRing(state.player.x, state.player.z, tier.accent, 0.9);
      shake = Math.max(shake, 0.14);
    }
    tierAnnounced = true;
  }
  const tierScale = tier.scale || 1;

  // 模型没加载好（或加载失败）：维持甲写的实例化方块渲染，逻辑零风险
  if (!modelLib.loaded || !modelLib.soldier) {
    soldierMesh.visible = true;
    soldierMesh.count = n;

    for (let i = 0; i < n; i++) {
      const p = soldierSlot(i, state);
      dummy.position.set(p.x, 0.275 * tierScale, p.z + soldierRecoil);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(tierScale);
      dummy.updateMatrix();
      soldierMesh.setMatrixAt(i, dummy.matrix);
    }
    soldierMesh.instanceMatrix.needsUpdate = true;
    return;
  }

  soldierMesh.visible = false;

  // 模型是游戏开始后才异步加载完的：档位外观要补套一次，不然首批兵还是原色
  if (!soldierMats) applySoldierTier(tier);

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
      vis.root.position.z = p.z + soldierRecoil;
      // 体型跟档位走：精锐看着比新兵壮一圈
      vis.root.scale.setScalar(soldierBaseScale * tierScale);
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

function syncZombies(state, dt) {
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
        // 原型下标 = z.type（0-4），约定见 docs/僵尸类型.md；越界兜底回普通
        const proto = modelLib.zombies[z.type] || modelLib.zombies[0];
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

    // 到线后沿防线滑行的最后一段：身体朝移动方向前倾，脚下扬一点灰
    // 配合变短的滑行距离，读起来是"扑过去"，不是"被吸走"
    const sliding = z.z > 7.6;
    const dir = Math.sign(state.player.x - z.x) || 0;
    const targetTilt = sliding ? dir * 0.22 : 0;

    if (entry.isModel) {
      const root = entry.vis.root;
      root.position.x = z.x;
      root.position.z = z.z;
      root.rotation.z += (targetTilt - root.rotation.z) * Math.min(1, dt * 14);

      // 走 ↔ 攻击切换：贴近防线（touchZ=8.2 之前一小段）就开始挥拳挠阵，
      // 每种类型拳速不同（大块头慢而重、快鬼连挠）；切进攻击的瞬间吼一声
      const vis = entry.vis;
      if (vis.attackAction) {
        const wantAttack = z.z >= ZOMBIE_ATK_Z;
        if (wantAttack && !vis.attacking) {
          vis.attacking = true;
          vis.attackAction.reset();
          vis.attackAction.crossFadeFrom(vis.walkAction, 0.12, false);
          vis.attackAction.play();
          playZombieAttack(z.type);
        } else if (!wantAttack && vis.attacking) {
          vis.attacking = false;
          vis.walkAction.reset();
          vis.walkAction.crossFadeFrom(vis.attackAction, 0.18, false);
          vis.walkAction.play();
        }
      }

      if (sliding) {
        entry.dustTimer = (entry.dustTimer || 0) - dt;
        if (entry.dustTimer <= 0 && effects.length < 60) {
          entry.dustTimer = 0.18;
          spawnDust(z.x, z.z);
        }
      }
    } else {
      entry.mesh.position.set(z.x, 0.575, z.z);
      entry.mesh.rotation.z += (targetTilt - entry.mesh.rotation.z) * Math.min(1, dt * 14);
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
      mesh = makeBulletMesh();
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
 * 摆放规则（防止穿模）：
 *   战斗安全区见 ARENA——僵尸/屏障在 z=-30~-26 出生、玩家 x±8、士兵阵型最深 z≈14。
 *   中景道具一律用 keepOffArena() 按自己的占位半径推到安全区外；
 *   远景大件（楼群/岩壁/雪脊/火山锥/树墙）手动退到"前缘不越过出生线"的 z；
 *   前景（z ≥ 15.8）只放矮的，不然会插进士兵队列。
 *
 * 这些道具的作用不是"好看"，是给画面提供高度和遮挡：
 * 有高度的东西才有受光面和阴影面，眼睛才读得出这是斜视而不是俯视。
 * ---------------------------------------------------------- */
/* 战斗安全区：僵尸、屏障、士兵、玩家可能出现（或必须能看见）的范围。
 * 数值对齐 game.js CONFIG.world，那边改了这边要跟着改：
 *   僵尸 x∈[0.6,7.6]，从 z=-30~-26 出生；屏障在左半边同样的深度；
 *   玩家 x±8；120 个士兵的三角阵最多铺到 z≈14。
 * 横向半径 8.6 = 8 留 0.6 余量。
 */
const ARENA = { halfX: 8.6, minZ: -30.5, maxZ: 15.4 };

// 把一件道具挪出战斗区。radius 传它的最大占位半径（树冠、沙丘宽度都要算进去）：
// 落在安全区里的才动，沿 x 往最近的一侧推出去；本来就在区外的不碰。
function keepOffArena(obj, x, z, radius) {
  const inX = Math.abs(x) < ARENA.halfX + radius;
  const inZ = z + radius > ARENA.minZ && z - radius < ARENA.maxZ;
  if (inX && inZ) {
    x = Math.sign(x || 1) * (ARENA.halfX + radius + 0.3);
  }
  obj.position.x = x;
  obj.position.z = z;
  return obj;
}

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

  // 远景：楼群剪影，挡住地平线。楼深最大 10，退到 -36 保证前墙不越过出生线
  for (let i = 0; i < 9; i++) {
    const w = 5 + rng() * 7;
    const h = 9 + rng() * 14;
    const d = 5 + rng() * 5;
    const b = boxMesh(w, h, d, 0x161b23, { rough: 1 });
    b.position.set(-38 + i * 9 + rng() * 2, h / 2, -36 - rng() * 4);
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

  // 前景碎石堆：矮，只压画面下缘。z ≥ 15.8 避开士兵队尾（三角阵最深约 14）
  for (let i = 0; i < 10; i++) {
    const r = 0.25 + rng() * 0.5;
    const rock = rockMesh(rng, r, 0x4a4f57);
    rock.position.set((rng() - 0.5) * 26, r * 0.5, 15.8 + rng() * 4);
    g.add(rock);
  }
}

function buildJungleProps(g, rng) {
  const trunk = 0x3a2e22;
  const leafA = 0x1f3a24;
  const leafB = 0x2b4a2c;

  // 后面一整片树墙，挡住地平线。树冠半径到 3.9，退到 -34 前缘才不压出生线
  for (let i = 0; i < 16; i++) {
    const h = 7 + rng() * 6;
    const t = treeMesh(rng, h, trunk, rng() > 0.5 ? leafA : leafB);
    t.position.set(-40 + i * 5.2 + rng() * 2, 0, -34 - rng() * 4);
    t.rotation.y = rng() * Math.PI;
    g.add(t);
  }

  // 两侧的树，靠近镜头，形成框景。树冠半径 h*0.3 最大 3.9，按半径推到通道外
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const h = 8 + rng() * 5;
      const t = treeMesh(rng, h, trunk, rng() > 0.5 ? leafA : leafB);
      keepOffArena(t, side * (11 + rng() * 6), -16 + i * 5.5 + rng() * 2, h * 0.3);
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
    bush.position.y = r * 0.4;
    keepOffArena(bush, x, -26 + rng() * 40, r);
    g.add(bush);
  }

  // 石块
  for (let i = 0; i < 12; i++) {
    const r = 0.4 + rng() * 0.9;
    const rock = rockMesh(rng, r, 0x4a4f42);
    const x = (rng() - 0.5) * 32;
    rock.position.y = r * 0.5;
    keepOffArena(rock, x, -24 + rng() * 36, r);
    g.add(rock);
  }

  // 前景：倒伏的树干，横在画面下缘（避开士兵队尾）
  const log = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.55, 9, 8),
    mat(0x2f2419, { flat: true, rough: 1 })
  );
  log.rotation.z = Math.PI / 2;
  log.rotation.y = 0.15;
  log.position.set(-4, 0.5, 16.8);
  g.add(log);
}

function buildDesertProps(g, rng) {
  const sand = 0x9a8360;
  const rock = 0x7d6a4e;
  const dry = 0x6b5a40;

  // 远处岩壁，把地平线挡掉。深度最大 8，退到 -35 前壁才不越过出生线
  for (let i = 0; i < 8; i++) {
    const w = 7 + rng() * 8;
    const h = 6 + rng() * 9;
    const b = boxMesh(w, h, 4 + rng() * 4, 0x8a7250, { rough: 1, flat: true });
    b.position.set(-42 + i * 12 + rng() * 3, h / 2, -35 - rng() * 5);
    b.rotation.y = (rng() - 0.5) * 0.3;
    b.rotation.z = (rng() - 0.5) * 0.06;
    g.add(b);
  }

  // 沙丘：压扁的球。曾经放到 r=10，宽度 14 直接盖住中央通道——上限压到 5，
  // 位置按实际半宽（r*1.4）推到通道外
  for (let i = 0; i < 10; i++) {
    const r = 2.5 + rng() * 2.5;
    const dune = new THREE.Mesh(
      new THREE.SphereGeometry(r, 12, 8),
      mat(sand, { rough: 1, flat: true })
    );
    dune.scale.set(1.4, 0.22, 1);
    const x = (rng() - 0.5) * 46;
    dune.position.y = -0.2;
    keepOffArena(dune, x, -26 + rng() * 46, r * 1.4 + 0.3);
    g.add(dune);
  }

  // 岩石群
  for (let i = 0; i < 14; i++) {
    const r = 0.6 + rng() * 1.8;
    const rk = rockMesh(rng, r, rock);
    const x = (rng() - 0.5) * 34;
    rk.position.y = r * 0.5;
    keepOffArena(rk, x, -22 + rng() * 36, r);
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
    keepOffArena(t, t.position.x, t.position.z, 1.4);
    g.add(t);
  }

  // 前景：几块半埋的石头（避开士兵队尾）
  for (let i = 0; i < 8; i++) {
    const r = 0.5 + rng() * 1.0;
    const rk = rockMesh(rng, r, rock);
    rk.position.set((rng() - 0.5) * 28, r * 0.35, 15.8 + rng() * 4);
    g.add(rk);
  }
}

function buildMoonProps(g, rng) {
  const rockA = 0x6a6d72;
  const rockB = 0x4a4d52;

  // 陨石坑：一圈低矮的环。环半径最大 5.5，按半径推到通道外
  for (let i = 0; i < 6; i++) {
    const r = 3 + rng() * 2.5;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, r * 0.09, 6, 24),
      mat(rockB, { flat: true, rough: 1 })
    );
    ring.rotation.x = -Math.PI / 2;
    const x = (rng() - 0.5) * 40;
    ring.position.y = 0.25;
    keepOffArena(ring, x, -24 + rng() * 40, r + 0.4);
    g.add(ring);
  }

  // 巨石与碎石
  for (let i = 0; i < 22; i++) {
    const r = 0.7 + rng() * 3.2;
    const rk = rockMesh(rng, r, rng() > 0.5 ? rockA : rockB);
    const x = (rng() - 0.5) * 46;
    rk.position.y = r * 0.4;
    keepOffArena(rk, x, -28 + rng() * 50, r);
    rk.rotation.y = rng() * Math.PI;
    g.add(rk);
  }

  // 远处的地球：贴着地平线的大星球，一眼就知道这是月球。
  // 之前放在 z=-20 正好坐在僵尸出生区里，僵尸从球体里穿过去；
  // 现在退到 z=-40（僵尸最深到 -30，永远碰不到），球心压低成"从地平线探出半个球"。
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(3, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0x3f78b8, fog: false })
  );
  earth.position.set(-4.5, 0.2, -40);
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

  // 远处雪脊。锥底半径最大 8.5，退到 -40 底缘才不压出生线
  for (let i = 0; i < 9; i++) {
    const w = 8 + rng() * 9;
    const h = 5 + rng() * 8;
    const peak = new THREE.Mesh(
      new THREE.ConeGeometry(w / 2, h, 5),
      mat(0xd3dde8, { flat: true, rough: 1 })
    );
    peak.position.set(-42 + i * 11 + rng() * 3, h / 2 - 0.4, -40 - rng() * 4);
    peak.rotation.y = rng() * Math.PI;
    g.add(peak);
  }

  // 积雪堆。曾经 r=6 半宽 7.8 会压进通道，上限压到 4.5、按半宽推出去
  for (let i = 0; i < 12; i++) {
    const r = 2 + rng() * 2.5;
    const mound = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat(snow, { rough: 0.85 }));
    mound.scale.set(1.3, 0.3, 1);
    const x = (rng() - 0.5) * 44;
    mound.position.y = -0.1;
    keepOffArena(mound, x, -24 + rng() * 42, r * 1.3 + 0.3);
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
    keepOffArena(t, t.position.x, t.position.z, 1.4);
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
    spike.position.y = h / 2;
    keepOffArena(spike, x, -14 + rng() * 26, 0.5);
    g.add(spike);
  }

  // 前景的岩石（避开士兵队尾）
  for (let i = 0; i < 6; i++) {
    const r = 0.6 + rng() * 1.2;
    const rk = rockMesh(rng, r, rockC);
    rk.position.set((rng() - 0.5) * 26, r * 0.4, 15.8 + rng() * 4);
    g.add(rk);
  }
}

function buildLavaProps(g, rng) {
  const char = 0x2a2422;
  const stone = 0x3a2e28;

  // 远处火山锥。底半径最大 13，退到 -44 底缘才不压僵尸出生区
  for (let i = 0; i < 3; i++) {
    const w = 16 + rng() * 10;
    const h = 12 + rng() * 8;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(w / 2, h, 7), mat(0x241b18, { flat: true, rough: 1 }));
    cone.position.set(-38 + i * 34 + rng() * 6, h / 2 - 1, -44 - rng() * 4);
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
    spire.position.y = 0;
    keepOffArena(spire, x, -28 + rng() * 46, r);
    spire.rotation.y = rng() * Math.PI;
    g.add(spire);
  }

  // 地面上的岩浆裂隙：自发光的长条，纯粹为了给画面一点暖色
  // polygonOffset 压住 z-fighting（和血迹同层贴地，不压会闪纹）
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
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    crack.rotation.x = -Math.PI / 2;
    crack.rotation.z = (rng() - 0.5) * 1.6;
    const x = (rng() - 0.5) * 38;
    crack.position.y = 0.03;
    keepOffArena(crack, x, -26 + rng() * 44, 0.8);
    crack.renderOrder = 1;
    g.add(crack);
  }

  // 前景的焦炭块（避开士兵队尾）
  for (let i = 0; i < 7; i++) {
    const r = 0.5 + rng() * 1.0;
    const rk = rockMesh(rng, r, char);
    rk.position.set((rng() - 0.5) * 28, r * 0.4, 15.8 + rng() * 4);
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
function barrierKindColor(bar) {
  if (bar.kind === 'negative') {
    // 打到 0 以上就变绿，表示已经中和
    return bar.value >= 0
      ? { main: 0x2fbf71, emissive: 0x0d5c33 }
      : { main: 0xff5a5a, emissive: 0x5c0d0d };
  }
  if (bar.kind === 'grey') return { main: 0x8a9099, emissive: 0x2a2e35 };
  if (bar.kind === 'weapon') return { main: 0x39d0ff, emissive: 0x0b3f52 };
  if (bar.kind === 'pierce') return { main: 0xb06bff, emissive: 0x3a0d5c };
  return { main: 0x2fbf71, emissive: 0x0d5c33 };
}

function barrierLabel(bar) {
  if (bar.kind === 'weapon') {
    return { title: '火力增援', sub: `${bar.hits}/${bar.required}` };
  }
  if (bar.kind === 'pierce') {
    return { title: '穿透器', sub: `${bar.hits}/${bar.required}` };
  }
  if (bar.kind === 'grey') {
    return { title: String(bar.value), sub: null };
  }
  return {
    title: bar.value > 0 ? `+${bar.value}` : String(bar.value),
    sub: null,
  };
}

function makeBarrierMesh(bar) {
  const group = new THREE.Group();
  const color = barrierKindColor(bar);
  const labelInfo = barrierLabel(bar);

  const barMat = new THREE.MeshStandardMaterial({
    color: color.main,
    emissive: color.emissive,
    roughness: 0.5,
    metalness: 0.1,
  });

  const barMesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.28, 0.5), barMat);
  barMesh.position.y = 0.14;
  barMesh.scale.x = bar.length || 1;
  group.add(barMesh);

  // 浮在上面的标签，Sprite 永远朝向相机
  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getLabelTexture(labelInfo.title, color.main, labelInfo.sub),
      transparent: true,
      depthWrite: false,
    })
  );

  if (labelInfo.sub) {
    label.scale.set(2.2, 1.45, 1);
    label.position.y = 1.25;
  } else {
    label.scale.set(1.8, 0.9, 1);
    label.position.y = 1.0;
  }
  group.add(label);

  group.userData = {
    barMat,
    barMesh,
    label,
    labelKey: `${labelInfo.title}|${labelInfo.sub || ''}|${color.main}`,
  };
  return group;
}

function updateBarrierAppearance(mesh, bar) {
  const { barMat, barMesh, label } = mesh.userData;
  const color = barrierKindColor(bar);

  barMat.color.setHex(color.main);
  barMat.emissive.setHex(color.emissive);
  barMesh.scale.x = bar.length || 1;

  const labelInfo = barrierLabel(bar);
  const key = `${labelInfo.title}|${labelInfo.sub || ''}|${color.main}`;

  if (mesh.userData.labelKey !== key) {
    mesh.userData.labelKey = key;
    label.material.map = getLabelTexture(
      labelInfo.title,
      color.main,
      labelInfo.sub
    );
    label.material.needsUpdate = true;
  }
}

function makeZombieMesh(type) {
  // 色块版的五色：和 ZOMBIE_LOOKS 的 tint 方向一致（普通绿/暗红灰/黄绿/灰白/灰绿）
  const colors = [0x6f8f6a, 0x8f5a4a, 0x9aa04a, 0xb8bcc4, 0x647f68];
  const look = ZOMBIE_LOOKS[type] || ZOMBIE_LOOKS[0];

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 1.15, 0.7),
    new THREE.MeshStandardMaterial({
      color: colors[type % colors.length],
      roughness: 0.85,
    })
  );
  // 体型也跟着类型走，色块版和模型版观感一致
  mesh.scale.setScalar(look.scale);
  if (look.emissive) mesh.material.emissive.setScalar(look.emissive);

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

const labelTextures = new Map();

function getLabelTexture(title, color, sub) {
  const key = `${title}|${sub || ''}|${color}`;
  const cached = labelTextures.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = sub ? 128 : 96;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;

  if (sub) {
    // 特殊屏障两行：上面写类型，下面写进度
    ctx.font = 'bold 38px "Microsoft YaHei", sans-serif';
    ctx.fillText(title, 96, 34);
    ctx.font = 'bold 48px "Microsoft YaHei", sans-serif';
    ctx.fillText(sub, 96, 92);
  } else {
    ctx.font = 'bold 54px "Microsoft YaHei", sans-serif';
    ctx.fillText(title, 96, 50);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  labelTextures.set(key, tex);
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
  mesh.position.set(x, 0.9, z - 0.15);
  scene.add(mesh);
  effects.push({ mesh, life: 0, maxLife: 0.09, type: 'flash' });
}

function spawnDust(x, z) {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 10),
    new THREE.MeshBasicMaterial({
      color: 0x9aa4b2,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.04, z);
  scene.add(mesh);
  effects.push({ mesh, life: 0, maxLife: 0.35, type: 'dust' });
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

// 从粒子池里借位置发射一簇粒子（血雾/魂火/尘土共用）
const fxC = new THREE.Color();
function spawnBurst(x, y, z, color, count, opts = {}) {
  if (!fxGeo) return;
  const speed = opts.speed ?? 2.4;
  const up = opts.up ?? 2;
  const life = opts.life ?? 0.55;
  let n = 0;
  for (let i = 0; i < FX_P_MAX && n < count; i++) {
    const p = fxPool[i];
    if (p.life > 0) continue;
    p.maxLife = p.life = life * (0.6 + Math.random() * 0.7);
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * speed;
    p.vx = Math.cos(a) * r;
    p.vz = Math.sin(a) * r;
    p.vy = Math.random() * up;
    p.g = opts.gravity ?? -7;
    const s = opts.spread ?? 0.3;
    fxPos[i * 3] = x + (Math.random() - 0.5) * s;
    fxPos[i * 3 + 1] = y + Math.random() * s;
    fxPos[i * 3 + 2] = z + (Math.random() - 0.5) * s;
    fxC.set(color).multiplyScalar(0.7 + Math.random() * 0.5);
    fxCol[i * 3] = Math.min(1, fxC.r);
    fxCol[i * 3 + 1] = Math.min(1, fxC.g);
    fxCol[i * 3 + 2] = Math.min(1, fxC.b);
    n++;
  }
}

function updateParticleFx(dt) {
  if (!fxGeo) return;
  let dirty = false;
  for (let i = 0; i < FX_P_MAX; i++) {
    const p = fxPool[i];
    if (p.life <= 0) continue;
    dirty = true;
    p.life -= dt;
    if (p.life <= 0) {
      fxPos[i * 3 + 1] = -999; // 回收：藏到地下
      continue;
    }
    p.vy += p.g * dt;
    fxPos[i * 3] += p.vx * dt;
    fxPos[i * 3 + 1] += p.vy * dt;
    fxPos[i * 3 + 2] += p.vz * dt;
    if (fxPos[i * 3 + 1] < 0.03) {
      fxPos[i * 3 + 1] = 0.03;
      p.vy = 0;
      p.vx *= 0.85;
      p.vz *= 0.85;
    }
  }
  if (dirty) {
    fxGeo.attributes.position.needsUpdate = true;
    fxGeo.attributes.color.needsUpdate = true;
  }
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
    } else if (fx.type === 'dust') {
      fx.mesh.scale.setScalar(0.7 + t * 0.8);
      fx.mesh.material.opacity = (1 - t) * 0.32;
    } else {
      fx.mesh.scale.setScalar(1 + t * 0.6);
      fx.mesh.material.opacity = 1 - t;
    }
  }
}

/* ----------------------------------------------------------
 * 击杀飘字：大块头/精英死了飘 +分数
 *
 * 位置每帧重新投影到屏幕，所以相机跟随时字会跟着尸体走，不会飘在半空。
 * 外层的 left/top 用 transform 写，元素本身留在 (0,0)，避免每帧触发布局。
 * ---------------------------------------------------------- */
const _projV = new THREE.Vector3();

function spawnScoreFloat(x, z, score, strong) {
  if (!fxFloats || !score) return;
  while (floatFeed.length >= FLOAT_MAX) {
    const old = floatFeed.shift();
    old.el.remove();
  }
  const el = document.createElement('div');
  el.className = strong ? 'fx-float fx-float--elite' : 'fx-float';
  el.textContent = `+${score}`;
  fxFloats.appendChild(el);
  floatFeed.push({ el, x, z, life: 0 });
}

function updateFloats(dt) {
  if (!camera || !floatFeed.length) return;
  const rect = containerEl
    ? containerEl.getBoundingClientRect()
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  if (!rect.width || !rect.height) return;

  camera.updateMatrixWorld();

  for (let i = floatFeed.length - 1; i >= 0; i--) {
    const f = floatFeed[i];
    f.life += dt;
    const t = f.life / FLOAT_LIFE;

    if (t >= 1) {
      f.el.remove();
      floatFeed.splice(i, 1);
      continue;
    }

    _projV.set(f.x, 1.3 + t * 1.05, f.z);
    _projV.project(camera);

    const sx = rect.left + (_projV.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-_projV.y * 0.5 + 0.5) * rect.height;
    const scale = t < 0.16 ? 0.65 + (t / 0.16) * 0.5 : 1.15 - (t - 0.16) * 0.12;

    f.el.style.transform =
      `translate(-50%, -50%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    f.el.style.opacity = t < 0.62 ? '1' : (1 - (t - 0.62) / 0.38).toFixed(3);
  }
}

/* ----------------------------------------------------------
 * 地上血迹：贴地一层，10 秒淡出，最多 14 片
 *
 * 贴图只生成一次，14 片共用；材质各自独立（要单独淡出）。
 * polygonOffset + renderOrder 把血迹压在贴地网格上面，避免 z-fighting 闪纹。
 * ---------------------------------------------------------- */
function ensureBloodTexture() {
  if (bloodTex) return bloodTex;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const blob = (cx, cy, r, a) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(98,17,13,${a})`);
    g.addColorStop(0.6, `rgba(74,12,10,${a * 0.85})`);
    g.addColorStop(1, 'rgba(48,8,6,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  blob(size / 2, size / 2, size * 0.4, 0.95);
  // 四周溅出几滴，形状不规则才像真的
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = size * (0.13 + Math.random() * 0.26);
    blob(
      size / 2 + Math.cos(a) * d,
      size / 2 + Math.sin(a) * d,
      size * (0.06 + Math.random() * 0.12),
      0.6 + Math.random() * 0.25
    );
  }

  bloodTex = new THREE.CanvasTexture(canvas);
  bloodTex.colorSpace = THREE.SRGBColorSpace;
  return bloodTex;
}

function spawnBlood(x, z, scale = 1) {
  if (!scene) return;

  const size = (1.1 + Math.random() * 0.7) * scale;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: ensureBloodTexture(),
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = Math.random() * Math.PI * 2;
  mesh.position.set(
    x + (Math.random() - 0.5) * 0.6,
    0.02,
    z + (Math.random() - 0.5) * 0.6
  );
  mesh.renderOrder = 1;
  scene.add(mesh);
  bloodDecals.push({ mesh, life: 0 });

  // 超量就顶掉最早的一片（贴图是共享的，别 dispose）
  while (bloodDecals.length > BLOOD_MAX) {
    const old = bloodDecals.shift();
    scene.remove(old.mesh);
    old.mesh.geometry.dispose();
    old.mesh.material.dispose();
  }
}

function updateBlood(dt) {
  if (!bloodDecals.length) return;
  const fadeFrom = BLOOD_LIFE - 3;

  for (let i = bloodDecals.length - 1; i >= 0; i--) {
    const b = bloodDecals[i];
    b.life += dt;

    if (b.life >= BLOOD_LIFE) {
      scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
      bloodDecals.splice(i, 1);
      continue;
    }

    if (b.life > fadeFrom) {
      b.mesh.material.opacity = 0.7 * (1 - (b.life - fadeFrom) / 3);
    }
  }
}

/* ----------------------------------------------------------
 * 升级提示条：屏幕中下部一行小字，同一时刻只显示一条
 * ---------------------------------------------------------- */
function pushToast(text, kind) {
  toastQueue.push({ text, kind: kind || '' });
}

function updateToast(dt) {
  if (!fxToast) return;

  if (toastLife > 0) {
    toastLife -= dt;
    if (toastLife <= 0) fxToast.classList.remove('show');
    return;
  }
  if (!toastQueue.length) return;

  const item = toastQueue.shift();
  fxToast.className = 'fx-toast' + (item.kind ? ` fx-toast--${item.kind}` : '');
  fxToast.textContent = item.text;
  void fxToast.offsetWidth; // 强制重排，让动画能连续重触发
  fxToast.classList.add('show');
  toastLife = TOAST_LIFE;
}

/* ----------------------------------------------------------
 * 曳光弹：拉长的弹头 + 一条往身后拖的发光带
 *
 * 子弹都朝 -z 飞，所以尾迹固定挂在 +z 侧，不用每帧算朝向。
 * ---------------------------------------------------------- */
let trailTex = null;

function ensureTrailTexture() {
  if (trailTex) return trailTex;

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // 纵向：头端最亮（v=1），尾端透明
  const along = ctx.createLinearGradient(0, 128, 0, 0);
  along.addColorStop(0, 'rgba(255,255,255,0)');
  along.addColorStop(0.5, 'rgba(255,236,176,0.5)');
  along.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, 32, 128);

  // 横向收窄，光带才有芯
  const across = ctx.createLinearGradient(0, 0, 32, 0);
  across.addColorStop(0, 'rgba(0,0,0,0)');
  across.addColorStop(0.5, 'rgba(0,0,0,1)');
  across.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, 32, 128);

  trailTex = new THREE.CanvasTexture(canvas);
  trailTex.colorSpace = THREE.SRGBColorSpace;
  return trailTex;
}

function makeBulletMesh() {
  const group = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.055, 0.3, 3, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff2c0 })
  );
  core.rotation.x = Math.PI / 2; // 胶囊默认沿 y，转成沿 z 飞
  group.add(core);

  const trail = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.95),
    new THREE.MeshBasicMaterial({
      map: ensureTrailTexture(),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  trail.rotation.x = -Math.PI / 2;
  trail.position.set(0, -0.01, 0.5);
  group.add(trail);

  return group;
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
