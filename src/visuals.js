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
  playBarrelFuse,
  playBarrelExplode,
  playBossRoar,
} from './audio.js';
// 三个乙层模块：兵种阶级外观表、昼夜轮转、炸药桶（新文件，按文件边界属乙）
import { TIERS, getTier, getTierIndex } from './visuals-tiers.js';
import { getEra, applyEraLook, tintMaterials } from './visuals-era.js';

export { eraMaps, pickEraMap } from './visuals-era.js';
import { createDayNight, nightForWave } from './visuals-daynight.js';
import { initBarrels, updateBarrels, resetBarrels, hitTestBarrel, spawnBarrelAt } from './visuals-barrels.js';
// 槽位正式模型：六槽位 × 六时代 × 五等级，全程序化（对应 docs/美术需求-槽位与技能.md P1）
import { buildSlotStructure, buildLevelDots, disposeSlotStructure } from './visuals-slots.js';
// 17 张新增地图：复用现有贴图，靠背景物/雾/光区分（见 visuals-maps.js 顶部说明）
import { NEW_MAPS, isNewMap, buildFlank } from './visuals-maps.js';

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
    hemi: { sky: 0x9fb8d8, ground: 0x10141a, intensity: 1.55 },
    key: { color: 0xfff1de, intensity: 3.0 },
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
    hemi: { sky: 0xe8d4a8, ground: 0x4a3a26, intensity: 1.4 },
    key: { color: 0xffe8c0, intensity: 2.6 },
    fill: { color: 0xff9a4d, intensity: 70, pos: [18, 10, -18] },
  },
  moon: {
    name: '月球（机制建议：低重力）',
    tex: 'b-map-moon',      // rocks_ground_04
    tint: 0xaeb6bd,
    roughness: 0.95,
    bg: 0x05060a, fogNear: 42, fogFar: 100,
    hemi: { sky: 0x8a94a8, ground: 0x0a0c10, intensity: 0.95 },
    key: { color: 0xffffff, intensity: 3.0 },
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
  harbor: {
    name: '港口码头（潮汐区）',
    tex: 'b-map-harbor',    // aerial_asphalt_01
    tint: 0x9fb0bc,
    roughness: 0.62,
    bg: 0x0b1a22, fogNear: 32, fogFar: 92,
    hemi: { sky: 0xa8c8dc, ground: 0x121e26, intensity: 1.6 },
    key: { color: 0xfff4e2, intensity: 2.9 },
    fill: { color: 0x3f7fa8, intensity: 60, pos: [16, 11, -20] },
  },
  lab: {
    name: '废弃医院（生化实验室）',
    tex: 'b-map-lab',       // worn_tile_floor
    tint: 0xb6c2b8,
    roughness: 0.38,
    bg: 0x0a1210, fogNear: 26, fogFar: 76,
    hemi: { sky: 0xbcd8cc, ground: 0x141c18, intensity: 1.45 },
    key: { color: 0xeafff6, intensity: 2.6 },
    fill: { color: 0x4ad9a0, intensity: 48, pos: [14, 10, -16] },
  },
  base: {
    name: '军事基地（封锁区）',
    tex: 'b-map-base',      // worn_corrugated_iron
    tint: 0x9aa3a8,
    roughness: 0.5,
    bg: 0x0d1116, fogNear: 30, fogFar: 84,
    hemi: { sky: 0xa8bccd, ground: 0x141a1f, intensity: 1.5 },
    key: { color: 0xf2f6ff, intensity: 2.8 },
    fill: { color: 0x6a86b0, intensity: 55, pos: [-16, 12, -18] },
  },
  lava: {
    name: '火山灰烬（机制建议：岩浆裂隙烫脚）',
    tex: 'b-map-lava',      // burned_ground_01
    tint: 0xa89a90,
    roughness: 0.85,
    bg: 0x120b08, fogNear: 26, fogFar: 88,
    hemi: { sky: 0xd8a878, ground: 0x140a06, intensity: 1.45 },
    key: { color: 0xffb070, intensity: 2.9 },
    fill: { color: 0xff5a2a, intensity: 90, pos: [12, 9, -14] },
  },
};

/* 把 17 张新地图并进 MAPS。
 *
 * ⚠️ 这一步**必须**在 `const MAP = MAPS[MAP_ID]` 之前。
 * 之前我把它写在 MAPS 定义后面、但排到了 MAP 快照之后，
 * 结果新地图在取 MAP 时还不存在，全部回落到 city——
 * 表现就是"新地图的贴图和配色全变成废墟街道的"。
 *
 * 它们带着自己的 tex（复用现有贴图）、tint、雾、灯光和 props 构建函数，
 * 并进来之后 switchMapLook / 开始页选图 / 时代选图都不用另外改。 */
for (const [id, m] of Object.entries(NEW_MAPS)) {
  MAPS[id] = {
    name: m.name,
    tex: m.tex,
    tint: m.tint,
    roughness: m.roughness,
    bg: m.bg,
    fogNear: m.fogNear,
    fogFar: m.fogFar,
    hemi: m.hemi,
    key: m.key,
    fill: m.fill,
    isNew: true,
  };
}

// 当前地图：从地址参数读，默认废墟街道
let MAP_ID = new URLSearchParams(window.location.search).get('map') || 'city';
const MAP = MAPS[MAP_ID] || MAPS.city;

/* 每张地图给僵尸套一层氛围色调（纯视觉，不改任何数值）
 * 同一批僵尸在城市是灰绿、在雪原偏冷白、在火山被岩浆照成暗红，
 * 换地图不用换模型也能一眼看出"这是另一片战场"。 */
const MAP_ZOMBIE_TINT = {
  city: [1.00, 1.00, 1.00], // 夜城：原色
  jungle: [0.88, 1.06, 0.86], // 雨林：湿绿
  desert: [1.14, 1.02, 0.80], // 沙漠：沙黄
  moon: [0.94, 0.99, 1.12], // 月球：真空冷蓝
  snow: [0.88, 0.96, 1.08], // 雪原：寒白
  lava: [1.18, 0.82, 0.72], // 火山：岩浆红
  base: [0.92, 0.98, 1.02],  // 军事基地：冷钢色
  lab: [0.80, 1.00, 0.88],    // 废弃医院：病态绿
  harbor: [0.98, 0.94, 0.88],  // 港口码头：咸湿的灰白
};
let MAP_TINT = MAP_ZOMBIE_TINT[MAP_ID] || MAP_ZOMBIE_TINT.city;

// 十六进制颜色乘一个 rgb 倍率（色块回退路径用）
function tintHex(hex, mul) {
  const c = new THREE.Color(hex);
  c.setRGB(
    Math.min(1, c.r * mul[0]),
    Math.min(1, c.g * mul[1]),
    Math.min(1, c.b * mul[2])
  );
  return c.getHex();
}

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

// 路障位置和尺寸：和 game.js 的 CONFIG.barricade 保持一致
const BARRICADE_X = 1.7;
const BARRICADE_Z = 0;
const BARRICADE_WIDTH = 4.2;

let renderer = null;
let scene = null;
let camera = null;
let containerEl = null;

let camDist = 40;  // 相机到注视点的距离，由 resize() 按视口算
let camY = 28;
let camZ = 28;
let camZoom = 0;      // Boss 在场时镜头推近的偏移
let bossOnField = false; // 场上是否有 Boss

let playerMesh = null;
let playerShadow = null;
let playerRing = null;     // 玩家脚下的指挥光环
let buffRing = null;       // 基因爆发的绿色攻速光环
let lastPlayerX = 0;
let soldierMesh = null;
let playerVisual = null; // 玩家的真模型（加载完成后替代蓝方块）

let barricadeGroup = null;
let barricadeHpBar = null;
let barricadeCountdown = null;
let barricadeCountdownSec = -1;
const countdownTextures = new Map();

// 昼夜轮转：初始化时创建，波次切换时改状态，每帧推进过渡
let dayNight = null;

// 场景里几个关键对象提到模块级：换地图（时代 Boss 换图）时需要能改它们
let hemiLight = null;
let keyLight = null;
let fillLight = null;
let groundMesh = null;
let backdropMesh = null;
let propsGroup = null;

// 兵种阶级：记录当前档位，只在升级那一帧变外观，不每帧重算
let maxPixelRatio = 2;       // 设备像素比上限
let qualityScale = 1;        // 当前渲染分辨率倍率（低帧时下调）
let fpsAcc = 0;              // 帧率采样
let fpsFrames = 0;
let fpsValue = 60;
let lowFpsTicks = 0;         // 连续低帧计数，用来避免来回抖动
let soldierTierIndex = -1;
let tierAnnounced = false;   // 开局那次不算"晋升"，不弹提示
let soldierBaseScale = 1;    // 原型归一化后的基准缩放（乘档位倍率用）
let soldierMats = null;      // [{ mat, baseColor, baseEmissive }]，用来还原再乘色
let lastWave = 1;            // 上一帧的波次，用来识别"重开一局"

// 时代皮肤：每 N 波换一个时代，换的是配色不改数值（详见 visuals-era.js）
let currentEra = null;
let eraSoldierTint = [1, 1, 1];
let eraZombieTint = [1, 1, 1];
let eraBulletTint = [1, 1, 1];
let lastSoldierCount = 0;
let zombieMats = [];        // 五种僵尸原型的材质（时代切换时统一乘色）

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
  soldiersByEra: {}, // 时代 → 士兵模型原型，换时代时整队换装
  bySrc: {},       // 模型来源名 → 原型，地图覆盖用（把这格的僵尸换成别的模型）
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
  // 5-7 是"地图专属僵尸"：同一套 Quaternius 角色包，不同年代的衣服一眼能认出来
  { src: 'knight', scale: 1.05, tint: [0.86, 0.80, 0.72], walkSpeed: 0.9, attackSpeed: 0.9, score: 4 },    // 5 僵尸骑士 锈甲（中世纪·丛林）
  { src: 'blue',   scale: 1.0,  tint: [0.74, 0.82, 0.98], walkSpeed: 1.0, attackSpeed: 1.05, score: 4 },   // 6 蓝军装僵尸（二战·城市）
  { src: 'casual', scale: 0.95, tint: [0.82, 0.90, 0.86], walkSpeed: 1.15, attackSpeed: 1.35, score: 3 },  // 7 便服僵尸 走得快（现代·沙漠）
  { src: 'pirate', scale: 1.0,  tint: [0.95, 0.72, 0.66], walkSpeed: 1.05, attackSpeed: 1.1, score: 5 },   // 8 海盗僵尸（终幕·熔岩）
  { src: 'cyber',  scale: 1.0,  tint: [0.86, 0.92, 1.05], walkSpeed: 1.25, attackSpeed: 1.4, score: 5 },   // 9 生化改造体（后现代·雪地）
  // 10 号是 Boss：模型自带咆哮/撕咬/死亡全套动画，体型大、走得慢、碰兵扣得多
  { src: 'boss',   scale: 1.0,  tint: [0.58, 0.54, 0.56], walkSpeed: 0.5, attackSpeed: 0.7, score: 40, isBoss: true, emissive: 0.10 },
  // 11 自爆：体型鼓、橙红自发光，像一颗要走路的炸弹——远远就该认出它
  { src: 'male',   scale: 1.15, tint: [1.15, 0.62, 0.42], walkSpeed: 1.0, attackSpeed: 1.0, score: 4, emissive: 0.30, color: 0xff6a3a },
  // 12 护甲：金属灰、体型略大，一眼看上去"很硬"
  { src: 'male',   scale: 1.2,  tint: [0.72, 0.76, 0.82], walkSpeed: 0.9, attackSpeed: 0.95, score: 4, color: 0x8a95a4 },
  // 13 远程：紫绿自发光——它吐酸液，颜色要和普通僵尸拉开，才好在人群里认出来优先点掉
  { src: 'male',   scale: 1.05, tint: [0.78, 1.15, 0.62], walkSpeed: 0.95, attackSpeed: 1.1, score: 5, emissive: 0.26, color: 0x8ce05a },
  // 14 召唤者：偏紫的自发光 + 体型略大。它是"刷怪源"，必须比普通怪更显眼，
  // 否则玩家不会意识到"要先杀这个"——这是这个类型的全部玩法意义
  { src: 'male',   scale: 1.25, tint: [0.92, 0.62, 1.15], walkSpeed: 0.72, attackSpeed: 1.0, score: 8, emissive: 0.34, color: 0xb060e0 },
];

/* 地图 → 僵尸模型覆盖：换地图时，同一种 type 换上本地图专属的模型。
 * 这样"每张图有自己的僵尸"不依赖甲改玩法，纯画面层就能做出来：
 * 数值（血量/速度/扣兵）还是甲的 type 说了算，这里只换穿什么。
 * 键是 type，值是模型来源名（对应 ZOMBIE_LOOKS 的 src）。 */
const MAP_TYPE_SRC = {
  jungle: { 0: 'knight' },   // 丛林：中世纪的僵尸骑士
  city:   { 0: 'blue' },     // 城市废墟：二战蓝军装
  desert: { 0: 'casual' },   // 沙漠：便服暴徒
  snow:   { 0: 'cyber' },    // 雪地：后现代生化改造体
  moon:   { 0: 'blue' },     // 月球：星际蓝甲（配色再往冷里拉）
  lava:   { 0: 'pirate' },   // 熔岩：终幕海盗
  base:   { 0: 'blue' },     // 军事基地：装甲兵
  lab:    { 0: 'cyber' },    // 废弃医院：生化体
  harbor: { 0: 'pirate' },   // 港口码头：海盗

  // ---- 17 张新地图：按时代气质选僵尸外观 ----
  // 中世纪系穿锈甲，二战系军装，现代系便服/蓝甲，后现代系生化体，星际系蓝甲，终幕系海盗
  castle:     { 0: 'knight' },
  village:    { 0: 'knight' },
  abbey:      { 0: 'knight' },
  swamp:      { 0: 'knight' },
  trench:     { 0: 'blue' },
  beach:      { 0: 'blue' },
  warport:    { 0: 'blue' },
  highway:    { 0: 'casual' },
  parking:    { 0: 'casual' },
  quarantine: { 0: 'cyber' },
  biofactory: { 0: 'cyber' },
  station:    { 0: 'blue' },
  alienwaste: { 0: 'blue' },
  orbitalpad: { 0: 'blue' },
  voidtemple: { 0: 'pirate' },
  timeruins:  { 0: 'pirate' },
  blackhole:  { 0: 'cyber' },
};
const animMixers = new Set(); // 所有活着的骨骼动画，每帧 update

const MODEL_TARGET = {
  soldierHeight: 1.5, // 士兵目标身高（世界单位）
  zombieHeight: 1.55, // 僵尸目标身高，比方块(1.15)略高一点更有压迫感
};

// Boss 体型是普通僵尸的几倍。
//
// 6 是**镜头完全不动**时能放到的上限，再大头顶就会从出生点起顶出画面。
// 这个数是按投影算出来的（b-boss-creep 原始宽高比 0.87，是张手爬行的横宽造型）：
//   5 倍 → 顶部 y=44px，还有富余
//   6 倍 → 顶部 y=5px，刚好卡满
//   7 倍 → 顶部 y=-36px，开始出画
// 相比最初的 1.95，相当于放大 3.1 倍：屏幕高度 65px → 213px，能形成压迫感，
// 又不用为它单独改相机。
const BOSS_HEIGHT_MUL = 6;

// Boss 血条宽度：跟体型匹配。Boss 按身高缩放后肩宽约 8 个单位，血条比肩略窄
const BOSS_HPBAR_WIDTH = 3.0;

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
  proto.userData.deathClip = rawProto.userData.deathClip;
  proto.userData.roarClip = rawProto.userData.roarClip;
  proto.userData.damageClip = rawProto.userData.damageClip;
  proto.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && o.material) {
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => m.clone())
        : o.material.clone();
    }
  });
  preparePrototype(
    proto,
    MODEL_TARGET.zombieHeight * look.scale * (look.isBoss ? BOSS_HEIGHT_MUL : 1),
    // 类型乘色 × 地图氛围色
    new THREE.Color(
      Math.min(1.2, look.tint[0] * MAP_TINT[0]),
      Math.min(1.2, look.tint[1] * MAP_TINT[1]),
      Math.min(1.2, look.tint[2] * MAP_TINT[2])
    )
  );
  // 暗场（夜城/熔岩/月球）里僵尸要能读出轮廓：给一点带环境色的自发光，
  // 相当于"被环境光照到"，比纯白自发光更贴场景。
  const ambTint = new THREE.Color(
    Math.min(1, look.tint[0] * MAP_TINT[0]),
    Math.min(1, look.tint[1] * MAP_TINT[1]),
    Math.min(1, look.tint[2] * MAP_TINT[2])
  );
  const emissiveLevel = 0.055 + (look.emissive || 0);
  proto.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && o.material?.emissive) {
      o.material.emissive.copy(ambTint).multiplyScalar(emissiveLevel);
    }
  });
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
    // 死亡动画：僵尸倒下，比直接消失好看很多
    proto.userData.deathClip =
      clips.find((c) => /death|defeat|dying/i.test(c.name)) || null;
    // 咆哮动画：只有 Boss 有，出场登场用
    proto.userData.roarClip =
      clips.find((c) => /roar/i.test(c.name)) || null;
    // 受击动画：被打中时抖一下（UA 系列叫 RecieveHit，Boss 那套叫 Damage_Action）
    proto.userData.damageClip =
      clips.find((c) => /recievehit|receivehit|damage|hit_/i.test(c.name)) || null;
    return proto;
  };

  // 加载进度：给界面层（ui.js）一个真实的百分比，模型在后台下载时不至于白屏干等
  // 核心三个（士兵/男僵尸/女僵尸）先加载，加载完就能玩；
  // 三种"地图专属僵尸"的模型放后台加载，不拖慢首屏，加载完再启用对应 type。
  const coreFiles = ['b-zombie-soldier.glb', 'b-zombie-male.glb', 'b-zombie-female.glb'];
  const extraFiles = [
    'b-zombie-knight.glb', 'b-soldier-blue.glb', 'b-zombie-casual.glb',
    'b-zombie-pirate.glb', 'b-zombie-cyber.glb', 'b-boss-creep.glb',
  ];
  const extraKeys = ['knight', 'blue', 'casual', 'pirate', 'cyber', 'boss'];
  const per = coreFiles.concat(extraFiles).map(() => ({ loaded: 0, total: 0, done: false }));

  const loadOne = (f, i) => new Promise((resolve, reject) => {
    loader.load(
      base + f,
      (gltf) => { per[i].done = true; resolve(gltf); },
      (e) => {
        per[i].loaded = e.loaded || 0;
        per[i].total = e.total || 0;
      },
      (err) => { per[i].done = true; reject(err); }
    );
  });

  const coreLoads = coreFiles.map((f, i) => loadOne(f, i));
  const extraLoads = extraFiles.map((f, i) => loadOne(f, coreFiles.length + i));
  // 额外模型失败不影响主流程，只是新僵尸类型用不上
  extraLoads.forEach((p) => p.catch(() => null));

  Promise.all(coreLoads)
    .then(([s, zm, zf]) => {
      modelLib.soldier = preparePrototype(grab(s, /idle/i), MODEL_TARGET.soldierHeight);
      // 男/女两个原始场景只作克隆源，各类型各自从这里克隆
      const rawZombie = { male: grab(zm, /walk/i), female: grab(zf, /walk/i) };
      modelLib.zombies = ZOMBIE_LOOKS.map((look) =>
        rawZombie[look.src]
          ? prepareZombieType(rawZombie[look.src], look)
          : null   // 5-7 号类型等后台模型到位后再补
      );
      modelLib.loaded = true;
      // 模型到位后把时代配色补上（模型是异步加载的，加载完之前没有材质可乘）
      if (currentEra) {
        collectZombieMats();
        applyEra(currentEra);
      }
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
      modelLoadState.failed = true;
    });

  // 专属僵尸模型（骑士/蓝军装/便服）后台加载完，再把 5-7 号类型补上。
  // 这期间如果甲那边已经刷出了这些 type，会走 modelLib.zombies[type] 的空值兜底（回退普通僵尸）。
  // 每个额外模型单独兜底：某一个下载/解析失败不能把 Boss 和其他模型一起拖死。
  // 以前直接 Promise.all(extraLoads)，任意一个 reject 都会跳过整段注册逻辑。
  Promise.all(extraLoads.map((p) => p.catch(() => null)))
    .then((list) => {
      if (!modelLib.loaded) return;
      const raw = {};
      list.forEach((gltf, i) => {
        if (gltf) raw[extraKeys[i]] = grab(gltf, /walk/i);
      });
      ZOMBIE_LOOKS.forEach((look, i) => {
        if (!raw[look.src]) return;
        try {
          modelLib.zombies[i] = prepareZombieType(raw[look.src], look);
        } catch (err) {
          console.warn('[visuals] 专属僵尸模型不可用：', look.src, err);
        }
      });

      // 按模型来源建索引：地图覆盖要用它（"这一格换成别的模型"）
      modelLib.bySrc = {
        male: modelLib.zombies[0],
        female: modelLib.zombies[3],
      };
      ZOMBIE_LOOKS.forEach((look, i) => {
        if (raw[look.src]) modelLib.bySrc[look.src] = modelLib.zombies[i];
      });

      // 时代换装：同一批模型也拿来当"这个时代的士兵"，
      // 换时代时士兵整队换模型（一眼就能看出换了个时代）
      // 注意：skeletonClone 会把 userData 做 JSON 拷贝，AnimationClip 引用会被毁掉，
      // 所以克隆后必须把 clip 的真引用补回去，否则换装后动画会报 createInterpolant 错误。
      const soldierProto = (raw, clip) => {
        if (!raw) return null;
        const p = skeletonClone(raw);
        // skeletonClone（Object3D.clone）会把 userData 做 JSON 拷贝，把真实的
        // AnimationClip 引用毁成普通对象（track 失去 createInterpolant 方法），
        // 克隆士兵时一调 clipAction 就崩、整队士兵消失。这里必须把全部动画真引用补回，
        // 和 prepareZombieType 的做法一致。
        p.userData.clip = clip;
        p.userData.attackClip = raw.userData.attackClip;
        p.userData.damageClip = raw.userData.damageClip;
        p.userData.deathClip = raw.userData.deathClip;
        p.userData.roarClip = raw.userData.roarClip;
        return preparePrototype(p, MODEL_TARGET.soldierHeight);
      };

      modelLib.soldiersByEra = {
        0: soldierProto(raw.knight, raw.knight?.userData.clip),   // 中世纪·骑士
        1: soldierProto(raw.blue, raw.blue?.userData.clip),       // 二战·蓝军装
        2: modelLib.soldier,                                        // 现代·现有军装
        3: soldierProto(raw.casual, raw.casual?.userData.clip),   // 后现代·便装
        4: soldierProto(raw.blue, raw.blue?.userData.clip),       // 星际·蓝甲
        5: modelLib.soldier,                                        // 终幕·沿用军装（配色区分）
      };

      // 新原型的材质要重新锁基准色，再补上当前时代的配色
      zombieMats = [];
      collectZombieMats();
      if (currentEra) applyEra(currentEra);
      console.log(
        '[visuals] 专属模型已就绪：',
        Object.keys(raw).join(' / ') || '(none)'
      );
    })
    .catch((err) => {
      console.warn('[visuals] 专属模型初始化失败：', err);
    });

  modelLoadState.per = per;
}

/* 模型加载进度：ui.js 用它显示真实的下载百分比
 * 返回 { progress: 0~1, done: boolean, failed: boolean }
 * 服务器没给 Content-Length 时按"已完成几个文件"估算，不会卡在 0。 */
const modelLoadState = { per: [], failed: false };

export function getModelLoadProgress() {
  if (modelLib.loaded) return { progress: 1, done: true, failed: false };
  const per = modelLoadState.per;
  if (!per.length) return { progress: 0, done: false, failed: false };

  let loaded = 0;
  let total = 0;
  let doneCount = 0;
  for (const p of per) {
    if (p.total > 0) {
      loaded += Math.min(p.loaded, p.total);
      total += p.total;
    }
    if (p.done) doneCount++;
  }

  // 有 Content-Length 就用真实字节数，没有就用完成文件数兜底
  const progress = total > 0
    ? loaded / total
    : doneCount / per.length;
  return { progress: Math.min(1, Math.max(0, progress)), done: false, failed: modelLoadState.failed };
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
    let deathAction = null;
    let roarAction = null;
    let damageAction = null;
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
      // 咆哮动作：只有 Boss 有，登场时播一遍
      if (proto.userData.roarClip) {
        roarAction = mixer.clipAction(proto.userData.roarClip);
        roarAction.setLoop(THREE.LoopOnce, 1);
        roarAction.clampWhenFinished = true;
        roarAction.paused = true;
      }
      // 受击动作待命：被打中时抖一下
      if (proto.userData.damageClip) {
        damageAction = mixer.clipAction(proto.userData.damageClip);
        damageAction.setLoop(THREE.LoopOnce, 1);
        damageAction.clampWhenFinished = true;
        damageAction.paused = true;
      }
      // 死亡动作待命：死的时候播一遍再消失
      if (proto.userData.deathClip) {
        deathAction = mixer.clipAction(proto.userData.deathClip);
        deathAction.setLoop(THREE.LoopOnce, 1);
        deathAction.clampWhenFinished = true;
        deathAction.paused = true;
      }
      animMixers.add(mixer);
    }
    const vis = { root, mixer, walkAction, attackAction, deathAction, roarAction, damageAction, attacking: false, zombieId: null };

    // 出拳动作演完的那一下：Boss 的攻击节奏靠这条同步回玩法层
    // （state 里只在收到 bossAttackDone 之后才允许打下一拳）
    if (mixer) {
      mixer.addEventListener('finished', (ev) => {
        if (!attackAction || ev.action !== attackAction) return;

        // 出拳之间不再切回走路：咬完保持收招姿势等下一拳。
        // 以前每次都 reset 走路再 crossFade 回攻击，0.15 秒的空隙里
        // 模型会在「走路」和「咬人」两个姿势之间来回闪，看起来就是抽搐。
        // 真正离开防线时由 syncZombies 统一切回走路。
        if (eventsRef && vis.zombieId != null) {
          eventsRef.dispatchEvent(
            new CustomEvent('bossAttackDone', { detail: { id: vis.zombieId } })
          );
        }
      });
    }

    return vis;
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

// 事件总线：陨石/火区这类"视觉演完要通知甲结算"的东西要靠它派发
let eventsRef = null;

const zombieMeshes = new Map();
const barrierMeshes = new Map();
const bulletMeshes = new Map();
const rollingLogMeshes = new Map();
const knightChargeMeshes = new Map();
const apcMeshes = new Map();
const carrierDroneMeshes = new Map();
const swarmDroneMeshes = new Map();
const friendlyZombieMeshes = new Map();
const virusBombMeshes = new Map();
const blackHoleMeshes = new Map();
const tankSupportMeshes = new Map(); // 坦克可以同时有多辆，key 是 t.id
const effects = [];

// 战斗特效升级件（对象在 initVisuals 里创建）：
// muzzleLight 枪口点光源、粒子池（血雾/魂火共用一套 Points）、HTML 覆盖层（波次横幅/扣兵红屏/击杀飘字/升级提示）
let muzzleLight = null;
let fxBanner = null;
let fxHurt = null;
let fxFlash = null;    // 全屏闪光：终幕技能、终焉审判、轨道轰炸共用
let fxSlow = null;
let fxFloats = null;   // 击杀飘字的容器（绝对定位，位置每帧由相机投影算）
let fxToast = null;
let fxFade = null;        // 换图用的全屏淡入淡出遮罩
let fxBloodMoon = null;   // 血月的全屏红色暗角
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
  eventsRef = events || null;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  maxPixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(maxPixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(MAP.bg);
  scene.fog = new THREE.Fog(MAP.bg, MAP.fogNear, MAP.fogFar);

  camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.5, 260);

  // 灯光：按地图走。整体思路是环境光压低、主光斜射，
  // 地面颗粒感靠主光 + 法线贴图，环境光太高会把细节冲平。
  hemiLight = new THREE.HemisphereLight(MAP.hemi.sky, MAP.hemi.ground, MAP.hemi.intensity);
  scene.add(hemiLight);

  keyLight = new THREE.DirectionalLight(MAP.key.color, MAP.key.intensity);
  keyLight.position.set(-10, 20, 14);
  scene.add(keyLight);

  // 一盏彩色补光，营造氛围（雨夜路灯 / 岩浆红光 / 沙漠热浪）
  fillLight = new THREE.PointLight(MAP.fill.color, MAP.fill.intensity, 90, 1.6);
  fillLight.position.set(...MAP.fill.pos);
  scene.add(fillLight);

  // 昼夜轮转：把当前地图的灯光/雾/背景当基线记下来，之后只做倍数插值，
  // 六张地图亮度差异大，写死绝对值会让月球糊成黑屏、沙漠看不出变化
  dayNight = createDayNight({ scene, hemi: hemiLight, key: keyLight, ambient: fillLight });

  // 地面：按地图加载贴图。路径用 import.meta.url 解析，避免受页面位置影响。
  const groundTex = loadGroundTextures(renderer, MAP.tex);

  groundMesh = new THREE.Mesh(
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
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.z = GROUND_Z;
  scene.add(groundMesh);

  // 远处的背景墙：把地面尽头挡住，配合雾看起来就是地平线
  backdropMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_W, 70),
    new THREE.MeshBasicMaterial({ color: MAP.bg, fog: true })
  );
  backdropMesh.position.set(0, 30, GROUND_Z - GROUND_H / 2);
  scene.add(backdropMesh);

  // 背景物：每张地图一套，全部是程序化生成的低面数道具，不占下载体积。
  // 必须接住返回值：后面 switchMapLook 切图时靠 propsGroup 引用把旧的拆掉。
  // 不接的话这里会多出一份永远删不掉的副本，切几次图就叠几层。
  propsGroup = buildProps();

  // 空气感：每张地图自己的粒子（雨丝/萤火虫/风沙/星尘/飘雪/火星）
  initAmbientFx();

  // 洪水用的水面：默认藏在地下，甲调 setWaterLevel 才会漫上来
  initWater();

  // 炸药桶：摆在两侧通道边（不压僵尸主路、不压士兵阵），模型全程序化生成。
  // 爆炸伤害归甲，这里只负责桶的样子、爆炸特效，以及给甲查命中用的 hitTestBarrel
  initBarrels({ scene, events });

  // 路障：前排一段可破坏的墙
  initBarricade();
  initSlots();

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

  // 玩家脚下的指挥环：一圈缓慢旋转的光环，标示"这是你操作的人"
  playerRing = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.78, 32),
    new THREE.MeshBasicMaterial({
      color: 0x4ea1ff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  playerRing.rotation.x = -Math.PI / 2;
  playerRing.position.set(0, 0.04, 9);
  scene.add(playerRing);

  // 基因爆发：只在增益生效时出现的大绿环。
  // 原来释放后只有一个砸在天上的特效，玩家看不出射速翻倍到底有没有生效
  buffRing = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 1.82, 40),
    new THREE.MeshBasicMaterial({
      color: 0x6dffb0,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
  );
  buffRing.rotation.x = -Math.PI / 2;
  buffRing.position.set(0, 0.05, 9);
  buffRing.visible = false;
  scene.add(buffRing);

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
  soldierMesh.frustumCulled = false; // 实例散落在原点之外（z≈9），基准包围球会被误剔除，整批不画
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
    <div class="fx-flash"></div>
    <div class="fx-slow"></div>
    <div class="fx-floats"></div>
    <div class="fx-toast"></div>
    <div class="fx-bloodmoon"></div>
    <div class="fx-fade"></div>`;
  document.body.appendChild(fxLayer);
  fxBanner = fxLayer.querySelector('.fx-banner');
  fxHurt = fxLayer.querySelector('.fx-hurt');
  fxFlash = fxLayer.querySelector('.fx-flash');
  fxSlow = fxLayer.querySelector('.fx-slow');
  fxFloats = fxLayer.querySelector('.fx-floats');
  fxToast = fxLayer.querySelector('.fx-toast');
  fxFade = fxLayer.querySelector('.fx-fade');
  fxBloodMoon = fxLayer.querySelector('.fx-bloodmoon');

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

  // Boss 出拳：单发播一次 Punch（LoopOnce），播完派 bossAttackDone 通知玩法层开下一拳。
  // 没有模型或没有出拳动作时不派 done，让玩法层按 attackFallback 的固定间隔继续
  events.addEventListener('bossAttack', (e) => {
    const d = e.detail || {};
    const entry = zombieMeshes.get(d.id);
    const vis = entry && entry.vis;
    if (!vis || !vis.attackAction) return;

    const act = vis.attackAction;
    // Boss 的出拳片段是 4.8 秒的超长动作（整个动捕包共用同一条时间轴），
    // 按玩法层给的时长做时间缩放，才能"一拳就是一拳"，也才演得完、派得出 done
    const target = d.animSeconds > 0 ? d.animSeconds : 1.2;
    act.timeScale = act.getClip().duration / target;

    act.setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = true;
    act.reset();
    act.setEffectiveWeight(1);
    act.play();
    // 只把走路淡出；出拳之间走路不再重新播放，避免两个动作各占一半权重
    if (vis.walkAction) vis.walkAction.fadeOut(0.12);
    vis.attacking = true;

    // 拳头砸在防线上的反馈：脚下扬尘 + 一道红色冲击环 + 震屏
    spawnRing(d.x, d.z, 0xff5a4a, 0.55);
    spawnBurst(d.x, 0.6, d.z, 0xff8a5a, 10, {
      speed: 2.2,
      up: 1.6,
      spread: 0.6,
      life: 0.45,
    });
    shake = Math.max(shake, 0.5);
  });

  events.addEventListener('slotStrike', (e) => {
    const d = e.detail;
    if (d.kind === 'siege' || d.kind === 'tank') {
      spawnMortar(d.fromX, d.fromZ, d.x, d.z, d.color || 0xffa64d, d.flightTime || 0.5);
    } else if (d.kind === 'closeDefense') {
      spawnTracer(d.fromX, d.fromZ, d.x, d.z, d.color || 0xff6a4a);
    }
    spawnRing(d.x, d.z, d.color || 0xffa64d, 0.5);

    // 槽位 Fire 动画：这个事件就是"槽位刚开了一炮"的唯一信号。
    // kind 直接对应槽位 id，不需要甲额外加事件。
    const slotId = d.kind === 'tank' ? 'siege' : d.kind;
    triggerSlotFire(slotId, d);
  });

  events.addEventListener('apcShot', (e) => {
    const d = e.detail;
    spawnTracer(d.fromX, d.fromZ, d.x, d.z, 0xffd27a, 0.9);
  });

  events.addEventListener('droneShot', (e) => {
    const d = e.detail;
    spawnTracer(d.fromX, d.fromZ, d.x, d.z, 0x7fe3ff, 2.6);
  });

  events.addEventListener('droneStrike', (e) => {
    const d = e.detail;
    spawnRing(d.x, d.z, 0x7fe3ff, 0.4);
    spawnBurst(d.x, 0.8, d.z, 0x7fe3ff, 6, {
      speed: 1.8,
      up: 1.6,
      spread: d.radius || 1.8,
      life: 0.4,
    });
  });

  events.addEventListener('airStrikeBomb', (e) => {
    const d = e.detail;
    spawnSkyStrike(d.x, d.z, d.color || 0xffd27a, d.delay || 0);
  });

  events.addEventListener('barrageWave', (e) => {
    const d = e.detail;
    spawnSkyStrike(d.x, d.z, d.color || 0xff8a4d, d.delay || 0);
  });

  // 所有延迟落地的炮弹/炸弹在这里统一出爆炸
  events.addEventListener('delayedImpact', (e) => {
    const d = e.detail;
    const power =
      d.kind === 'airStrike' ? 1.15 :
      d.kind === 'barrage' ? 0.7 :
      d.kind === 'tank' ? 0.9 : 1;
    // 坦克爆炸只缩小特效，伤害范围仍是 d.radius；3.0 的火球在屏幕上太抢眼
    const radius = d.kind === 'tank'
      ? Math.max(1.2, (d.radius || 3) * 0.8)
      : (d.radius || 2.2);

    spawnImpact(d.x, d.z, {
      radius,
      color: d.color || 0xffb060,
      power,
      dust: true,
    });
  });

  // 无人机蜂群起飞：脚下一小圈推进器光
  events.addEventListener('swarmLaunch', (e) => {
    const d = e.detail;
    spawnRing(d.x, d.z, 0x7fd4ff, 0.28);
  });

  // 无人机蜂群命中：小范围爆炸，力度比普通 AOE 轻
  events.addEventListener('swarmHit', (e) => {
    const d = e.detail;
    spawnImpact(d.x, d.z, {
      radius: d.radius || 2.2,
      color: 0x7fd4ff,
      power: 0.55,
      dust: false,
    });
  });

  events.addEventListener('friendlySpawn', (e) => {
    const style = friendlyRoleStyle(e.detail.unitType);
    spawnRing(e.detail.x, e.detail.z, style ? style.color : 0x5adf7a, 0.45);
  });

  // 爆尸自爆：黄绿色小爆炸，和敌方爆炸区分开
  events.addEventListener('friendlyExplode', (e) => {
    const d = e.detail;
    spawnImpact(d.x, d.z, {
      radius: d.radius || 1.8,
      color: 0xd6e05a,
      power: 0.7,
      dust: true,
    });
  });

  // 酸吐尸吐酸：一道绿色曳光打向目标
  events.addEventListener('friendlySpit', (e) => {
    const d = e.detail;
    spawnTracer(d.fromX, d.fromZ, d.x, d.z, 0x8fe36a, 0.7);
  });

  // 黑洞结束：猛地一缩 + 紫环扩散
  events.addEventListener('blackHoleImpact', (e) => {
    const d = e.detail;
    spawnImplosion(d.x, d.z, 0x8a5cff, d.radius || 3);
    spawnRing(d.x, d.z, 0xc9a6ff, 0.7);
    shake = Math.max(shake, 0.4);
  });

  events.addEventListener('friendlyDie', (e) => {
    spawnBurst(e.detail.x, 0.7, e.detail.z, 0x5adf7a, 8, {
      speed: 1.8,
      up: 1.4,
      spread: 0.3,
      life: 0.45,
    });
  });

  events.addEventListener('virusBombImpact', (e) => {
    const d = e.detail;
    spawnRing(d.x, d.z, 0x8fe36a, 0.8);
    spawnBurst(d.x, 0.8, d.z, 0x8fe36a, 24, {
      speed: 3.2,
      up: 2.4,
      spread: d.radius || 2.6,
      life: 0.8,
    });
  });

  events.addEventListener('slotHeal', (e) => {
    spawnRing(e.detail.x, e.detail.z, 0x5adf7a, 0.55);
  });

  events.addEventListener('skillCast', (e) => {
    const d = e.detail;
    // P0 通用打击：每个技能的差别只在参数（半径 / 颜色 / 力度 / 要不要尘土）
    const IMPACT_TUNING = {
      airStrike:     { power: 1.15, dust: true },   // 空袭：一整排轰炸，最大的尘土
      precision:     { power: 0.8, dust: false },   // 精确打击：小而准，不起尘
      droneSwarm:    { power: 0.7, dust: true },    // 无人机蜂群：轻、密
      holyWater:     { power: 0.5, dust: false },
      napalm:        { power: 0.9, dust: true },
    };

    if (d.type === 'line') {
      spawnBar(d.z, d.color || 0xffffff);
    } else if (d.type === 'heal') {
      spawnRing(d.x, d.z, d.color || 0x5adf7a, 0.7);
    } else if (d.type === 'buff') {
      // 增益光环由 syncScene 按 buffUntil 持续画，这里不再往僵尸堆里砸东西
      spawnRing(d.x, d.z, d.color || 0x6dffb0, 1.1);
    } else if (d.type === 'memory') {
      // 记忆回放：玩家脚下紫色圆环，复刻的技能会自己播自己的特效
      spawnRing(d.x, d.z, d.color || 0xd0a0ff, 0.9);
    } else if (d.id === 'arrowRain') {
      spawnArrowRain(d.x, d.z, d.radius || 4, d.color || 0xd9b36c);
    } else if (d.type === 'barrage') {
      // 落点由 barrageWave 逐波画；这里只铺一层大范围底色
      spawnGroundArea(d.x, d.z, d.areaRadius || 5, d.color || 0xff8a4d, 3.2);
    } else if (d.type === 'napalmWall') {
      spawnNapalmWallFx(
        d.x,
        d.z,
        d.width || 8,
        d.depth || 1.8,
        d.duration || 4,
        d.color || 0xff6a2a
      );
    } else if (d.type === 'airStrike') {
      // 三颗炸弹由 airStrikeBomb 事件逐颗画
    } else if (d.type === 'orbital') {
      // 光柱只铺被打掉的那一段（bandMin/bandMax 由 game.js 传入）
      spawnOrbitalBeam(d.z, d.color || 0x7fe3ff, d.bandMin, d.bandMax);
      // 再补远端新增的闪白和地面熔痕
      spawnFlash(d.color || 0x7fe3ff, 0.42);
      spawnCrater(0, d.z, 2.6);
    } else if (d.type === 'aoe') {
      // 所有纯伤害范围技都走这一套
      const tune = IMPACT_TUNING[d.id] || { power: 1, dust: true };
      spawnImpact(d.x, d.z, {
        radius: d.radius || 3,
        color: d.color || 0xffb060,
        power: tune.power,
        dust: tune.dust,
      });
      // 终焉审判已经走 execute 分支，这里不再重复给白闪
    } else if (d.type === 'pull') {
      // 黑洞 / 宇宙坍缩：不是炸开，是往里吸
      spawnImplosion(d.x, d.z, d.color || 0x6a4dff, d.radius || 4);
    } else if (d.type === 'weaponDrop') {
      // 箱子已经是实体（state.pickups 里的 boost 箱），由 syncPickups 负责画
      spawnRing(d.x, d.z, 0xffd27a, 0.5);
    } else if (d.type === 'friendlyLegion') {
      spawnRing(0, 8.5, 0x9c6bff, 0.8);
    } else if (d.type === 'execute') {
      spawnJudgmentFx(d.executed, d.chipped);
    } else if (d.type === 'sacrifice') {
      spawnSacrificeFx(d.shaved);
    } else if (d.type === 'reboot') {
      spawnRebootFx(d.removed);
    } else if (
      d.type === 'rollingLog' ||
      d.type === 'knightCharge' ||
      d.type === 'campfire' ||
      d.type === 'tank' ||
      d.type === 'apc' ||
      d.type === 'carrierDrones' ||
      d.type === 'droneSwarm' ||
      d.type === 'virusBomb'
    ) {
      // 持续实体由各自的 sync 负责画
    } else {
      spawnSkyStrike(d.x, d.z, d.color || 0xffffff);
    }
  });

  events.addEventListener('slotUnlock', (e) => {
    const v = slotVisuals.get(e.detail.id);
    if (v) spawnRing(v.x, v.z, v.color, 0.6);
  });

  events.addEventListener('skillNotice', (e) => {
    const d = e.detail || {};
    if (d.text) pushToast(d.text, d.kind || 'skill');
  });

  events.addEventListener('barricadeHit', (e) => {
    spawnBurst(e.detail.x, 0.3, e.detail.z, 0x8a7a5a, 2, {
      speed: 1.0,
      up: 0.8,
      spread: 0.3,
      life: 0.25,
    });
  });

  events.addEventListener('barricadeBreak', () => {
    const bx = barricadeGroup ? barricadeGroup.position.x : BARRICADE_X;
    spawnBurst(bx, 0.5, BARRICADE_Z, 0x8a7a5a, 14, {
      speed: 2.4,
      up: 1.8,
      spread: 0.5,
      life: 0.6,
    });
    shake = Math.max(shake, 0.22);
  });

  events.addEventListener('barricadeRebuild', () => {
    const bx = barricadeGroup ? barricadeGroup.position.x : BARRICADE_X;

    // 重建：先把破损段位强制归零，让墙立刻恢复完好外观，
    // 再叠一层绿色光柱表示"修好了"
    if (barricadeGroup) {
      barricadeGroup.userData.damageStage = -1;
      applyBarricadeDamage(1);
    }

    spawnRing(bx, BARRICADE_Z, 0x5adf7a, 0.4);
    spawnRing(bx, BARRICADE_Z, 0x9effc0, 0.7);
    spawnBurst(bx, 0.4, BARRICADE_Z, 0x5adf7a, 14, {
      speed: 2.2, up: 3.0, spread: 1.2, life: 0.6, gravity: -5,
    });
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
    // 记下本波起点，界面层用它算"还有几秒下一波"
    if (wave) lastWaveStartTime = currentState ? currentState.time : 0;

    // 昼夜轮转：每 3 波换一次。夜晚画面变暗、雾变近（僵尸加速是甲的事）
    const wasNight = dayNight ? dayNight.isNight : false;
    const night = nightForWave(wave);
    if (dayNight) dayNight.setNight(night);
    if (night && !wasNight) pushToast('夜幕降临 · 僵尸加速', 'night');

    // 血月：每 10 波来一次，到点自动开；下一波自动收
    if (bloodMoonAuto && wave) {
      const want = wave % BLOOD_MOON_EVERY === 0;
      if (want !== bloodMoonOn) triggerBloodMoon(want, { wave });
    }

    // 时代切换由 game.js 调 switchEra 驱动，这里不再按波次自动换

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

  // 炸药桶爆炸：甲那边派发这个事件结算伤害，这里负责声音、余震和地面火区
  events.addEventListener('barrelExploded', (e) => {
    playBarrelExplode();
    shake = Math.max(shake, 0.45);

    // 桶里装的是油，炸完地上留一片还在烧的火（视觉自己做闭环，
    // 持续灼烧伤害由甲监听 fireZoneSpawned 或轮询 getFireZones() 决定）
    const d = e.detail || {};
    // 爆炸痕迹比篝火短：2.2 秒就烧完，不在地面留太久
    igniteFireZone(
      d.x ?? 0,
      d.z ?? 0,
      Math.min(2.8, (d.radius || 3.2) * 0.78),
      2.2
    );
  });

  // 甲想主动砸陨石，派个 'meteor' 事件就行，不用 import 函数
  events.addEventListener('meteor', (e) => {
    const d = e.detail || {};
    if (isFinite(d.x) && isFinite(d.z)) triggerMeteor(d.x, d.z);
    else triggerMeteorRandom();
  });

  // 自爆僵尸炸开：一圈橙红冲击 + 火球 + 震屏，半径由甲传过来，光比伤害半径略小一点
  events.addEventListener('zombieExplode', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;

    const r = Math.max(1, Math.min(4, Number(d.radius) || 2.8));
    shake = Math.max(shake, 0.34);
    spawnRing(x, z, 0xffb060, 0.34);
    spawnRing(x, z, 0xff5a24, 0.5);
    spawnBurst(x, 0.55, z, 0xff8a3a, 20, {
      speed: 4.4, up: 3.6, spread: 0.7, life: 0.5, gravity: -8,
    });
    spawnBurst(x, 0.35, z, 0x4a3a30, 12, {
      speed: 2.6, up: 2.0, spread: r * 0.5, life: 0.9, gravity: -2.5,
    });
    // 地上留一小片烧痕，让人看得出这儿炸过
    spawnRing(x, z, 0x9a3010, 0.9);
  });

  // 地面塌陷：土石往下掉 + 震屏。落下去的是"塌"，不是"炸"，所以用碎石而不是火
  events.addEventListener('pitSpawn', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;
    const r = Math.max(0.8, Number(d.r) || 1.35);

    shake = Math.max(shake, 0.5);
    spawnRing(x, z, 0x6a5540, 0.7);
    spawnBurst(x, 0.25, z, 0x8a7458, Math.round(20 * r), {
      speed: 3.4, up: 2.6, spread: r * 0.7, life: 0.9, gravity: -7,
    });
    spawnBurst(x, 0.15, z, 0x3a2e22, Math.round(10 * r), {
      speed: 1.6, up: 1.2, spread: r * 0.9, life: 1.2, gravity: -2,
    });
  });

  // 回填：一圈淡土扬起来，提示"这块地能走了"
  events.addEventListener('pitFill', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;
    spawnRing(x, z, 0x9a8a70, 0.5);
    spawnBurst(x, 0.2, z, 0xa09078, 8, {
      speed: 1.4, up: 1.0, spread: 0.6, life: 0.6, gravity: -3,
    });
  });

  // 武器箱落地：轻震一下，别用爆炸那种分量
  events.addEventListener('pickupLand', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;
    spawnRing(x, z, 0xbcd0e0, 0.32);
    spawnBurst(x, 0.15, z, 0x9aa8b8, 7, {
      speed: 1.6, up: 1.2, spread: 0.45, life: 0.45, gravity: -6,
    });
    shake = Math.max(shake, 0.12);
  });

  // 子弹打碎武器箱：在箱子位置炸一小圈，再走 weaponPickup 的换枪表现
  events.addEventListener('pickupHit', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;
    spawnRing(x, z, 0x9ad0ff, 0.5);
    spawnBurst(x, 0.5, z, 0x9ad0ff, 12, {
      speed: 2.2, up: 1.8, spread: 0.45, life: 0.5, gravity: -6,
    });
    shake = Math.max(shake, 0.14);
  });

  // 箱子没被打中，自己在场上待够了时间：一小圈灰光提示它没了
  events.addEventListener('pickupExpired', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;
    spawnRing(x, z, 0x8a8f99, 0.28);
    spawnBurst(x, 0.4, z, 0x8a8f99, 6, {
      speed: 1.2, up: 0.8, spread: 0.35, life: 0.4, gravity: -4,
    });
  });

  // 捡到武器：一圈武器色光爆 + 提示条，让"换枪了"这件事被看见
  events.addEventListener('weaponPickup', (e) => {
    const d = e.detail || {};
    const tint = d.tint || 0xffd45a;
    const px = currentState ? currentState.player.x : 0;
    const pz = currentState ? currentState.player.z : 9;

    spawnRing(px, pz, tint, 0.6);
    spawnBurst(px, 0.8, pz, tint, 18, {
      speed: 3.0, up: 2.6, spread: 0.5, life: 0.6, gravity: -6,
    });
    shake = Math.max(shake, 0.2);
    pushToast(`换上 ${d.name}`, 'pickup');
  });

  // 临时武器到期：提示换回时代武器，不然玩家会以为是枪"坏了"
  events.addEventListener('weaponExpired', (e) => {
    const d = e.detail || {};
    pushToast(`${d.name} 用尽 · 换回旧枪`, 'pickup-off');
  });

  // 酸液打到阵型：一小片绿雾 + 轻微震屏，让玩家知道"被远程点到了'
  events.addEventListener('enemyShotHit', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;
    spawnRing(x, z, 0x9aff5a, 0.36);
    spawnBurst(x, 0.5, z, 0x9aff5a, 10, {
      speed: 1.8, up: 1.6, spread: 0.35, life: 0.4, gravity: -5,
    });
    shake = Math.max(shake, 0.18);
  });

  // 补给箱砸到地上：一圈土 + 轻微"咚"的震感（不用重震，它不是爆炸）
  events.addEventListener('crateLand', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;
    spawnRing(x, z, 0xc8a878, 0.34);
    spawnBurst(x, 0.12, z, 0x9a8a6a, 7, {
      speed: 1.6, up: 1.2, spread: 0.5, life: 0.45, gravity: -6,
    });
    shake = Math.max(shake, 0.12);
  });

  // 补给箱被打碎：木屑四散 + 一道绿色光圈（绿色 = 正向收益，和扣兵红屏区分开）
  events.addEventListener('crateHit', (e) => {
    const d = e.detail || {};
    const x = Number(d.x);
    const z = Number(d.z);
    if (!isFinite(x) || !isFinite(z)) return;

    spawnRing(x, z, 0x58e08a, 0.55);
    spawnBurst(x, 0.35, z, 0xb08148, 16, {
      speed: 3.0, up: 2.8, spread: 0.45, life: 0.6, gravity: -8,
    });
    spawnBurst(x, 0.4, z, 0x58e08a, 8, {
      speed: 1.6, up: 2.2, spread: 0.3, life: 0.5, gravity: -5,
    });
    // 奖励文案走已有的提示条，不新开 UI
    if (d.label) pushToast(d.label, 'crate');
  });
}

/* ----------------------------------------------------------
 * 给甲用的查询接口
 * ---------------------------------------------------------- */

/* 子弹有没有打中炸药桶。命中就点燃引信（0.12 秒后自动爆炸并派发
 * barrelExploded 事件给甲结算范围伤害），返回命中的桶对象或 null。
 * 用法：子弹每帧推进后调一次 hitBarrel(b.x, b.z)，非 null 就让子弹消失。 */
export function hitBarrel(x, z, radius = 0.5) {
  // 甲传的 radius 是"额外容差"，模块内部会收敛到合理范围。
  // 桶是三只横排的，用胶囊判定（点到横排线段的距离），视觉和判定完全对齐，
  // 不会出现"明明瞄准了却打不到"。
  const hit = hitTestBarrel(x, z, radius);
  if (hit) playBarrelFuse(); // 点燃引信的嘶嘶声
  return hit;
}

/* 运行时补一个炸药桶，归甲调用；场上最多 3 个，位置太近会返回 null */
export function spawnBarrel(x, z) {
  return spawnBarrelAt(x, z);
}

/* 换图过渡：淡出 → 换内容 → 淡入
 * 直接硬切会很突兀，队长那边"击败 Boss 换时代"必须走这个。 */
function fadeOut(ms = 420) {
  if (!fxFade) return Promise.resolve();
  fxFade.style.transition = `opacity ${ms}ms ease`;
  fxFade.style.opacity = '1';
  return new Promise((res) => setTimeout(res, ms));
}

function fadeIn(ms = 420) {
  if (!fxFade) return;
  fxFade.style.transition = `opacity ${ms}ms ease`;
  fxFade.style.opacity = '0';
}

/* ----------------------------------------------------------
 * 换地图（给队长的"时代 Boss 换图"用）
 *
 * 只换画面：地面贴图、背景物、雾、灯光、空气粒子、环境音。
 * 玩家状态、士兵数、波次这些一个都不动（那是 game.js 的事）。
 *
 * 用法：
 *   import { switchMapLook } from './visuals.js';
 *   switchMapLook('lava');   // 战场换成熔岩图
 *   applyEraIndex(5);        // 同时把时代切到终幕（可选）
 * ---------------------------------------------------------- */
export function switchMapLook(mapId, opts = {}) {
  const m = MAPS[mapId];
  if (!m || !scene) return false;

  // 带过渡的换图：先淡出，再换，最后淡入
  if (opts.fade) {
    const ms = opts.fadeMs || 420;
    fadeOut(ms);
    // 在淡出的黑屏期间把贴图 load 好，再换场景、再淡入。
    // 这样玩家看到的是"黑一下 → 新地图已经完整"，而不是"灰地面慢慢长出贴图"。
    const target = MAPS[mapId];
    const ready = target ? preloadGroundTexture(target.tex) : Promise.resolve(null);
    ready
      .catch(() => null)
      .then(() => {
        doSwitchMapLook(mapId);
        fadeIn(ms);
      });
    return true;
  }
  return doSwitchMapLook(mapId);
}

function doSwitchMapLook(mapId) {
  const m = MAPS[mapId];

  // 背景色与雾
  scene.background = new THREE.Color(m.bg);
  if (scene.fog) {
    scene.fog.color.setHex(m.bg);
    scene.fog.near = m.fogNear;
    scene.fog.far = m.fogFar;
  }
  if (backdropMesh) backdropMesh.material.color.setHex(m.bg);

  // 灯光
  if (hemiLight) {
    hemiLight.color.setHex(m.hemi.sky);
    hemiLight.groundColor.setHex(m.hemi.ground);
    hemiLight.intensity = m.hemi.intensity;
  }
  if (keyLight) {
    keyLight.color.setHex(m.key.color);
    keyLight.intensity = m.key.intensity;
  }
  if (fillLight) {
    fillLight.color.setHex(m.fill.color);
    fillLight.intensity = m.fill.intensity;
    fillLight.position.set(...m.fill.pos);
  }

  // 地面贴图：优先用预加载好的缓存。没缓存就现加载，加载完再贴上去。
  // 先染色（乘色）和粗糙度立刻生效，贴图到位后只是补上图，不会整块跳变。
  if (groundMesh) {
    const gm = groundMesh.material;
    gm.color.setHex(m.tint);
    gm.roughness = m.roughness;
    gm.needsUpdate = true;
    flushGroundTexture(m.tex);
  }

  // 背景物：旧的拆干净再重建（不 dispose 会泄漏显存）
  if (propsGroup) {
    scene.remove(propsGroup);
    propsGroup.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mm of mats) {
        if (!mm) continue;
        mm.map?.dispose();
        mm.dispose();
      }
    });
  }
  propsGroup = buildProps(mapId);

  // 空气粒子
  if (ambientFx) {
    scene.remove(ambientFx.points);
    ambientFx.geo.dispose();
    ambientFx.points.material.dispose();
    ambientFx = null;
  }
  initAmbientFx(mapId);

  // 当前地图变了：僵尸的地图氛围色、环境音跟着换
  MAP_ID = mapId;
  MAP_TINT = MAP_ZOMBIE_TINT[mapId] || MAP_ZOMBIE_TINT.city;
  setAmbient(mapId);

  console.log('[visuals] 战场已切换到', mapId);
  return true;
}

/* ----------------------------------------------------------
 * 给玩法层用的接口
 * ---------------------------------------------------------- */

/* 一整套「时代切换」演出：淡出 → 换时代（模型+配色）→ 换战场 → 淡入 → 提示
 * 队长那边「击败 Boss 换时代」只要调这一行：
 *   switchEra(5, 'lava');   // 切到终幕，战场换成熔岩
 * 不想淡出就 switchEra(5, 'lava', { fade: false }); */
export function switchEra(eraIndex, mapId, opts = {}) {
  const era = getEra(eraIndex);
  if (!era) return false;
  const useFade = opts.fade !== false;

  const doSwitch = () => {
    applyEra(era);                 // 换模型 + 换配色
    if (mapId && MAPS[mapId]) {
      doSwitchMapLook(mapId);       // 换战场（地面/背景/雾/灯/粒子/环境音）
    }
    if (!opts.silent) pushToast(`时代 · ${era.name}`, 'era');
  };

  if (!useFade) {
    doSwitch();
    return true;
  }

  const ms = opts.fadeMs || 460;
  fadeOut(ms);
  setTimeout(() => {
    doSwitch();
    fadeIn(ms);
  }, ms + 60);
  return true;
}

/* 地震：屏幕持续晃动 + 地面落灰 + 地面扬尘圈
 *
 * 两种触发方式：
 *   1. 甲主动调 triggerQuake(2.5)
 *   2. 自己按周期来（点子池「地震」归乙）：局内每 16~26 秒来一下，
 *      幅度比炸药桶（0.45）小得多，只是"地在动"的氛围，不抢战斗反馈。
 *      甲如果想让节奏自己控，调 setQuakeAuto(false) 关掉周期触发。
 *
 * 僵尸停顿属于玩法数值，甲要就自己在 triggerQuake 前后加。 */
let quakeTime = 0;
let quakeDuration = 0;
let quakeAuto = true;
let quakeCycle = 12;   // 开局先给 12 秒安静时间，等玩家摸清节奏再震
let quakeDust = 0;   // 扬尘圈的计时器（地震期间每 0.3 秒撒一圈）

export function triggerQuake(duration = 2.5) {
  quakeDuration = Math.max(0.4, duration);
  quakeTime = quakeDuration;
  shake = Math.max(shake, 0.35);
}

export function setQuakeAuto(on) {
  quakeAuto = !!on;
  quakeCycle = quakeAuto ? 16 + Math.random() * 10 : 0;
}

/* 只在局内推进：菜单和结算页不该无缘无故抖 */
function updateQuakeCycle(dt, playing) {
  if (!quakeAuto || !playing) return;
  if (quakeCycle > 0) {
    quakeCycle -= dt;
    if (quakeCycle > 0.001) return;
  }
  // 场上正震着（甲刚调过）就不叠加，等这一波震完再排下一次
  if (quakeTime > 0) {
    quakeCycle = 2;
    return;
  }
  triggerQuake(1.5);
  quakeCycle = 16 + Math.random() * 10;
}

/* 洪水：水位从 -2.2 升到 0（level 0~1），半透明水面 + 起伏
 * 用法：setWaterLevel(0.5); */
let waterMesh = null;
let waterLevel = 0;

export function setWaterLevel(level) {
  waterLevel = Math.max(0, Math.min(1, Number(level) || 0));
}

export function getWaterLevel() {
  return waterLevel;
}

function initWater() {
  waterMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_W, GROUND_H),
    new THREE.MeshStandardMaterial({
      color: 0x3f9fd0,
      emissive: 0x0d3446,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.55,
      roughness: 0.1,
      metalness: 0.35,
      depthWrite: false,
    })
  );
  waterMesh.rotation.x = -Math.PI / 2;
  waterMesh.position.set(0, -2.2, GROUND_Z);
  waterMesh.visible = false;
  scene.add(waterMesh);
}

function updateWater(dt) {
  if (!waterMesh) return;
  // level 0 → 全在地下（看不出来）；level 0.78 → 刚漫过地面；level 1 → 没过脚踝
  const target = -2.2 + waterLevel * 3.2;
  waterMesh.position.y += (target - waterMesh.position.y) * Math.min(1, dt * 1.2);
  waterMesh.visible = waterMesh.position.y > -0.04;
  // 水面轻轻起伏
  const t = performance.now() * 0.001;
  waterMesh.position.y += Math.sin(t * 1.3) * 0.008;
}

function updateQuake(dt) {
  if (quakeTime <= 0) return;
  quakeTime = Math.max(0, quakeTime - dt);
  // 持续的小幅晃动 + 偶尔落灰
  shake = Math.max(shake, 0.12 + (quakeTime / Math.max(0.01, quakeDuration)) * 0.14);
  if (Math.random() < dt * 14) {
    spawnBurst((Math.random() - 0.5) * 22, 0.2, -12 + Math.random() * 20, 0x8a7a5e, 3, {
      speed: 1.2, up: 1.6, spread: 0.8, life: 0.8,
    });
  }

  // 地面扬起一圈圈土：震感主要靠这个，光晃屏幕容易像相机抖了
  quakeDust += dt;
  if (quakeDust >= 0.3) {
    quakeDust = 0;
    spawnRing((Math.random() - 0.5) * 16, -20 + Math.random() * 22, 0x9a8a70, 0.9);
  }

  // 零星碎石子被颠起来
  if (Math.random() < dt * 5) {
    spawnBurst((Math.random() - 0.5) * 18, 0.12, -18 + Math.random() * 20, 0x6a6055, 2, {
      speed: 0.8, up: 2.2, spread: 0.4, life: 0.7, gravity: -9,
    });
  }
}

/* ----------------------------------------------------------
 * 陨石（纯视觉，伤害结算归甲）
 *
 * 三段演出，全部程序化，零外部素材：
 *   1. 预警圈：地面亮一圈红环，越接近落点闪得越急，内圈同时往里收
 *   2. 火石：从画面外斜着砸下来，拖着火星尾迹，边落边翻滚
 *   3. 砸地：白闪一下 + 震屏 + 冲击环 + 泥土飞溅 + 留一个黑坑
 *
 * 落地时派发 'meteorImpact'，detail = { x, z, radius }，
 * 甲按这个半径自己结算伤害（这里一点血都不扣）。
 *
 * 用法：
 *   triggerMeteor(x, z);      指定落点
 *   triggerMeteorRandom();    在战场里随机挑一个落点（不会砸在玩家脚下）
 * 甲也可以直接派事件：events.dispatchEvent(new CustomEvent('meteor', { detail: { x, z } }))
 * ---------------------------------------------------------- */
const meteors = [];        // 正在预警/坠落中的陨石
const craters = [];        // 砸出来的坑（贴地，慢慢淡出）
const METEOR_WARN = 1.1;   // 预警时长（秒）
const METEOR_FALL = 0.42;  // 坠落时长
const METEOR_WARN_R = 2.6; // 预警圈半径 = 默认伤害半径
const METEOR_TOP_Y = 15;   // 火石出现的空中高度
const CRATER_MAX = 6;
const CRATER_LIFE = 10;
let craterTex = null;

function ensureCraterTex() {
  if (craterTex) return craterTex;

  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  // 坑底：中间最黑，边上稍微透一点，看着像被烧穿的土
  const g = ctx.createRadialGradient(c, c, size * 0.04, c, c, size * 0.5);
  g.addColorStop(0, 'rgba(12,8,5,0.96)');
  g.addColorStop(0.42, 'rgba(26,17,11,0.86)');
  g.addColorStop(0.72, 'rgba(48,33,21,0.55)');
  g.addColorStop(1, 'rgba(60,45,30,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.5, 0, Math.PI * 2);
  ctx.fill();

  // 坑沿：一圈浅色的翻出来的土
  ctx.strokeStyle = 'rgba(150,124,88,0.62)';
  ctx.lineWidth = size * 0.05;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.36, 0, Math.PI * 2);
  ctx.stroke();

  // 放射状的裂纹，别让坑看着像一个规整的圆
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + Math.random() * 0.28;
    const r0 = size * (0.3 + Math.random() * 0.06);
    const r1 = size * (0.4 + Math.random() * 0.09);
    ctx.strokeStyle = `rgba(20,14,9,${0.4 + Math.random() * 0.35})`;
    ctx.lineWidth = size * (0.012 + Math.random() * 0.018);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    ctx.stroke();
  }

  craterTex = new THREE.CanvasTexture(canvas);
  craterTex.colorSpace = THREE.SRGBColorSpace;
  return craterTex;
}

function spawnCrater(x, z, scale = 1) {
  if (!scene) return;
  const s = METEOR_WARN_R * 2.1 * scale;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(s, s),
    new THREE.MeshBasicMaterial({
      map: ensureCraterTex(),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = Math.random() * Math.PI * 2;
  mesh.position.set(x, 0.028, z);
  mesh.renderOrder = 1;
  scene.add(mesh);
  craters.push({ mesh, life: 0 });

  while (craters.length > CRATER_MAX) {
    const old = craters.shift();
    scene.remove(old.mesh);
    old.mesh.geometry.dispose();
    old.mesh.material.dispose();
  }
}

function updateCraters(dt) {
  if (!craters.length) return;
  const fadeFrom = CRATER_LIFE - 3.5;

  for (let i = craters.length - 1; i >= 0; i--) {
    const c = craters[i];
    c.life += dt;

    if (c.life >= CRATER_LIFE) {
      scene.remove(c.mesh);
      c.mesh.geometry.dispose();
      c.mesh.material.dispose();
      craters.splice(i, 1);
      continue;
    }
    if (c.life > fadeFrom) {
      c.mesh.material.opacity = 0.9 * (1 - (c.life - fadeFrom) / 3.5);
    }
  }
}

function newMeteor(x, z) {
  const group = new THREE.Group();

  // 预警圈：外圈标范围，内圈往里收做倒计时
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(METEOR_WARN_R - 0.13, METEOR_WARN_R, 48),
    new THREE.MeshBasicMaterial({
      color: 0xff4a24,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.055, z);
  group.add(ring);

  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 32),
    new THREE.MeshBasicMaterial({
      color: 0xff8a4a,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.set(x, 0.058, z);
  inner.scale.setScalar(METEOR_WARN_R * 0.92);
  group.add(inner);

  // 火石本体 + 一层半透明的热壳，远看是一团带边的火球
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.62, 1),
    new THREE.MeshStandardMaterial({
      color: 0x2a1c12,
      emissive: 0xff5a1c,
      emissiveIntensity: 1.5,
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true,
    })
  );
  rock.position.set(x, METEOR_TOP_Y, z);
  rock.visible = false;
  group.add(rock);

  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 12, 10),
    new THREE.MeshBasicMaterial({
      color: 0xff7a2e,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  shell.position.copy(rock.position);
  shell.visible = false;
  group.add(shell);

  scene.add(group);

  return {
    x, z, group, ring, inner, rock, shell,
    time: 0,
    dropped: false,
    spinX: 3 + Math.random() * 4,
    spinZ: 2 + Math.random() * 3,
  };
}

function impactMeteor(m) {
  const { x, z } = m;

  shake = Math.max(shake, 0.92);

  // 冲击环两道，一快一慢，砸下来的分量靠这个撑住
  spawnRing(x, z, 0xffd0a0, 0.34);
  spawnRing(x, z, 0xff6a24, 0.62);

  spawnBurst(x, 0.5, z, 0xff8a34, 30, {
    speed: 6.4, up: 5.4, spread: 0.85, life: 0.62, gravity: -9,
  });
  spawnBurst(x, 0.3, z, 0x6b5540, 26, {
    speed: 4.8, up: 3.4, spread: 1.35, life: 1.15, gravity: -3.6,
  });

  spawnCrater(x, z, 1);

  if (eventsRef) {
    try {
      eventsRef.dispatchEvent(new CustomEvent('meteorImpact', {
        detail: { x, z, radius: METEOR_WARN_R },
      }));
    } catch (err) {
      // 事件系统出问题不能影响画面
    }
  }
}

/* 砸一颗陨石。同屏最多 3 颗，多了直接忽略（别把画面糊满、也省粒子） */
export function triggerMeteor(x, z) {
  if (!scene) return false;
  if (meteors.length >= 3) return false;

  const px = Math.max(-9, Math.min(9, Number(x) || 0));
  const pz = Math.max(-26, Math.min(4, Number(z) || 0));

  // 落点太近就把旧的那颗撤掉，别让两个预警圈叠在一起互相干扰
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    if (Math.hypot(m.x - px, m.z - pz) < 1.6) {
      scene.remove(m.group);
      disposeMesh(m.group);
      meteors.splice(i, 1);
    }
  }

  meteors.push(newMeteor(px, pz));
  return true;
}

/* 随机落点：避开玩家脚下 3 米，主要落在僵尸推进的那片区域 */
export function triggerMeteorRandom() {
  const p = currentState ? currentState.player : { x: 0, z: 9 };
  let x = 0;
  let z = 0;

  for (let i = 0; i < 6; i++) {
    x = (Math.random() - 0.5) * 16;
    z = -3 - Math.random() * 19;
    if (Math.hypot(x - p.x, z - p.z) > 3) break;
  }
  return triggerMeteor(x, z);
}

function updateMeteors(dt) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    m.time += dt;

    if (m.time < METEOR_WARN) {
      // —— 预警段：外圈闪得越来越急，内圈一路收到落点
      const t = m.time / METEOR_WARN;
      m.ring.material.opacity = 0.55 + 0.35 * Math.sin(m.time * (9 + t * 30));
      m.inner.scale.setScalar(Math.max(0.18, METEOR_WARN_R * 0.92 * (1 - t * 0.84)));
      m.inner.material.opacity = 0.45 + 0.45 * t;
      continue;
    }

    // —— 坠落段：预警圈收掉，火石加速下落
    if (!m.dropped) {
      m.dropped = true;
      m.ring.visible = false;
      m.inner.visible = false;
      m.rock.visible = true;
      m.shell.visible = true;
    }

    const t = Math.min(1, (m.time - METEOR_WARN) / METEOR_FALL);
    const e = t * t; // 加速下坠，越接近地面越快
    const y = METEOR_TOP_Y - (METEOR_TOP_Y - 0.4) * e;
    m.rock.position.y = y;
    m.shell.position.y = y;
    m.rock.rotation.x += dt * m.spinX;
    m.rock.rotation.z += dt * m.spinZ;

    // 尾迹：每帧借三颗粒子，够连成一条火线
    spawnBurst(m.x, y, m.z, 0xff7a2e, 3, {
      speed: 0.5, up: 0.5, spread: 0.55, life: 0.45, gravity: -1.5,
    });

    if (t >= 1) {
      impactMeteor(m);
      scene.remove(m.group);
      disposeMesh(m.group);
      meteors.splice(i, 1);
    }
  }
}

/* ----------------------------------------------------------
 * 油桶火区（纯视觉，持续灼烧伤害归甲）
 *
 * 炸药桶炸完，地面留一片还在烧的油：贴地火光 + 不停往上蹿的火苗 + 黑烟。
 * 火区自己烧 4.5 秒后灭掉，不需要甲来管。
 *
 * 甲要做持续伤害，两种接法任选：
 *   a. 监听 'fireZoneSpawned'（detail = { x, z, radius, duration }）自己计时
 *   b. 每帧调 getFireZones() 拿当前活着的火区（带 remaining 剩余秒数）
 * ---------------------------------------------------------- */
const fireZones = [];
const campfireFx = [];   // 篝火的木柴、火苗、火星、暖光
const napalmFx = [];     // 燃烧弹火墙
const FIRE_LIFE = 4.5;
const FIRE_RADIUS = 2.4;
const FIRE_MAX = 4;      // 同屏最多几片火，超了顶掉最早的
let fireTex = null;

/* 拆一片火：几何体各自独立要释放，贴图是共享的不能 dispose */
function removeFireZone(f) {
  if (!f) return;
  scene.remove(f.char);
  scene.remove(f.glow);
  f.char.geometry.dispose();
  f.char.material.dispose();
  f.glow.geometry.dispose();
  f.glow.material.dispose();
}

function ensureFireTex() {
  if (fireTex) return fireTex;

  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  // 中心白热 → 橙 → 暗红 → 透明，边缘故意做不规则
  const g = ctx.createRadialGradient(c, c, size * 0.03, c, c, size * 0.5);
  g.addColorStop(0, 'rgba(255,240,196,0.92)');
  g.addColorStop(0.2, 'rgba(255,166,60,0.78)');
  g.addColorStop(0.52, 'rgba(226,88,24,0.42)');
  g.addColorStop(0.78, 'rgba(140,36,8,0.16)');
  g.addColorStop(1, 'rgba(80,16,4,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.5, 0, Math.PI * 2);
  ctx.fill();

  // 从边上啃几块缺口，火焰轮廓就不会是个完美的圆
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = size * (0.34 + Math.random() * 0.18);
    const r = size * (0.05 + Math.random() * 0.12);
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  fireTex = new THREE.CanvasTexture(canvas);
  fireTex.colorSpace = THREE.SRGBColorSpace;
  return fireTex;
}

/* 点一片火。同一处 1.5 米内再点一次不新建，直接把旧火续满 */
export function igniteFireZone(x, z, radius = FIRE_RADIUS, duration = FIRE_LIFE) {
  if (!scene || !isFinite(x) || !isFinite(z)) return null;

  const r = Math.max(0.8, Math.min(4.0, Number(radius) || FIRE_RADIUS));
  const life = Math.max(0.5, Number(duration) || FIRE_LIFE);

  for (const f of fireZones) {
    if (Math.hypot(f.x - x, f.z - z) < 1.5) {
      f.life = 0;
      f.maxLife = Math.max(f.maxLife || FIRE_LIFE, life);
      f.radius = Math.max(f.radius, r);
      f.glow.scale.set(f.radius * 2.3, f.radius * 2.3, 1);
      // 焦土是按初始半径建的几何体，面积变大了靠缩放跟，不重建
      f.char.scale.setScalar(f.radius / f.charRadius);
      return f;
    }
  }

  // 烧黑的地面：先铺一层暗底，火光叠在上面才有"地上真有东西在烧"的层次
  const char = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.92, 28),
    new THREE.MeshBasicMaterial({
      color: 0x140d08,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    })
  );
  char.rotation.x = -Math.PI / 2;
  char.position.set(x, 0.03, z);
  char.renderOrder = 1;
  scene.add(char);

  // 火光本体：加色混合，压在地面上方一点点
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: ensureFireTex(),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.rotation.z = Math.random() * Math.PI * 2;
  glow.scale.set(r * 2.3, r * 2.3, 1);
  glow.position.set(x, 0.052, z);
  glow.renderOrder = 2;
  scene.add(glow);

  const zone = {
    x, z, radius: r,
    charRadius: r,
    life: 0,
    maxLife: life,
    char, glow,
    phase: Math.random() * Math.PI * 2,
    acc: 0,
  };
  fireZones.push(zone);

  // 火区最多 4 片：多了顶掉最早那片，免得场上火海一片、粒子池也被抽干
  while (fireZones.length > FIRE_MAX) removeFireZone(fireZones.shift());

  if (eventsRef) {
    try {
      eventsRef.dispatchEvent(new CustomEvent('fireZoneSpawned', {
        detail: { x, z, radius: r, duration: zone.maxLife },
      }));
    } catch (err) {
      // 同上，事件异常不影响画面
    }
  }
  return zone;
}

/* 篝火：交叉木柴 + 火苗 + 火星 + 暖光，和油桶火区叠在一起 */
export function spawnCampfireFx(x, z, duration = 5, radius = 3.5) {
  if (!scene || !isFinite(x) || !isFinite(z)) return null;

  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // 伤害范围：淡橙色地面 + 一圈边线，不铺大块焦土
  const area = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 56),
    new THREE.MeshBasicMaterial({
      color: 0xff6a1e,
      transparent: true,
      opacity: 0.045,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  area.rotation.x = -Math.PI / 2;
  area.position.y = 0.022;
  group.add(area);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius - 0.07, radius, 56),
    new THREE.MeshBasicMaterial({
      color: 0xff8a2b,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.032;
  group.add(ring);

  // 中心火堆底下的一小块焦土
  const char = new THREE.Mesh(
    new THREE.CircleGeometry(0.9, 24),
    new THREE.MeshBasicMaterial({
      color: 0x1a0f08,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    })
  );
  char.rotation.x = -Math.PI / 2;
  char.position.y = 0.012;
  group.add(char);

  // 火堆中心的高亮火光，让远处也能看出这里有火
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: ensureFireTex(),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.rotation.z = Math.random() * Math.PI * 2;
  glow.position.y = 0.06;
  glow.scale.set(2.6, 2.6, 1);
  group.add(glow);

  // 石圈
  const stoneMat = new THREE.MeshBasicMaterial({ color: 0x5b554c });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const stone = new THREE.Mesh(new THREE.SphereGeometry(0.15, 5, 4), stoneMat);
    stone.position.set(Math.cos(a) * 0.62, 0.11, Math.sin(a) * 0.62);
    stone.scale.set(1, 0.65, 1);
    group.add(stone);
  }

  // 交叉木柴
  const logMat = new THREE.MeshBasicMaterial({ color: 0x6b3f1d });
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 1.15, 6),
      logMat
    );
    log.rotation.z = Math.PI / 2;
    log.rotation.y = (i / 3) * Math.PI;
    log.position.y = 0.16 + i * 0.04;
    group.add(log);
  }

  // 三层火苗：外红橙、中黄、内白，整体比之前高
  const flameColors = [0xff4a0a, 0xffa22b, 0xfff0a0];
  const flames = [];
  for (let i = 0; i < 14; i++) {
    const h = 0.8 + Math.random() * 0.9;
    const color = flameColors[i < 8 ? 0 : i < 12 ? 1 : 2];
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.18 + Math.random() * 0.12, h, 7),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.78,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.36;
    const baseY = 0.22 + h / 2;
    mesh.position.set(Math.cos(a) * r, baseY, Math.sin(a) * r);
    group.add(mesh);
    flames.push({
      mesh,
      baseY,
      phase: Math.random() * Math.PI * 2,
      speed: 4.5 + Math.random() * 4,
    });
  }

  // 火星
  const emberCount = 36;
  const pos = new Float32Array(emberCount * 3);
  const seeds = new Float32Array(emberCount);
  for (let i = 0; i < emberCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.4;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0.2 + Math.random() * 1.4;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seeds[i] = Math.random();
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const embers = new THREE.Points(
    emberGeo,
    new THREE.PointsMaterial({
      color: 0xffc75a,
      size: 0.09,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  group.add(embers);

  // 暖光
  const light = new THREE.PointLight(0xff8a3d, 2.8, 9, 2);
  light.position.y = 1.4;
  group.add(light);

  scene.add(group);

  const fx = {
    group,
    flames,
    embers,
    emberSeeds: seeds,
    light,
    ring,
    area,
    glow,
    life: 0,
    maxLife: Math.max(0.5, duration),
  };
  campfireFx.push(fx);
  return fx;
}

function updateCampfireFx(dt) {
  for (let i = campfireFx.length - 1; i >= 0; i--) {
    const fx = campfireFx[i];
    fx.life += dt;

    if (fx.life >= fx.maxLife) {
      scene.remove(fx.group);
      disposeMesh(fx.group);
      campfireFx.splice(i, 1);
      continue;
    }

    // 最后 0.8 秒整体淡出
    const fade = Math.min(1, (fx.maxLife - fx.life) / 0.8);

    for (const fl of fx.flames) {
      const t = fx.life * fl.speed + fl.phase;
      const sx = 1 + Math.sin(t * 0.7) * 0.12;
      const sy = 0.82 + Math.sin(t * 1.1) * 0.2;
      fl.mesh.scale.set(sx, sy, sx);
      fl.mesh.position.y = fl.baseY + Math.sin(t * 0.9) * 0.05;
      fl.mesh.material.opacity = (0.45 + Math.sin(t * 1.3) * 0.18) * fade;
      fl.mesh.rotation.y += dt * 0.8;
    }

    const arr = fx.embers.geometry.attributes.position.array;
    for (let j = 0; j < arr.length; j += 3) {
      arr[j + 1] += dt * (0.35 + fx.emberSeeds[j / 3] * 0.45);
      if (arr[j + 1] > 1.5) arr[j + 1] = 0.18;
    }
    fx.embers.geometry.attributes.position.needsUpdate = true;
    fx.embers.material.opacity = 0.9 * fade;

    // 地面火光和范围圈也一起跳动
    const pulse = 0.85 + Math.sin(fx.life * 4.5) * 0.15;
    fx.glow.scale.set(2.6 * pulse, 2.6 * pulse, 1);
    fx.glow.rotation.z += dt * 0.45;
    fx.glow.material.opacity = (0.72 + Math.sin(fx.life * 11) * 0.14) * fade;
    fx.ring.material.opacity = 0.38 * pulse * fade;
    fx.area.material.opacity = 0.04 * fade;

    fx.light.intensity = (2.2 + Math.sin(fx.life * 17) * 0.5) * fade;
  }
}

/* 燃烧弹火墙：横向一条火带，和篝火的圆形火区分开 */
function spawnNapalmWallFx(x, z, width, depth, duration, color) {
  if (!scene) return;

  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const char = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({
      color: 0x180d08,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  char.rotation.x = -Math.PI / 2;
  char.position.y = 0.02;
  group.add(char);

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({
      map: ensureFireTex(),
      color,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  group.add(glow);

  const flameColors = [0xff4a0a, 0xffa22b, 0xfff0a0];
  const flames = [];
  for (let i = 0; i < 22; i++) {
    const h = 0.5 + Math.random() * 0.8;
    const colorPick = flameColors[i < 13 ? 0 : i < 19 ? 1 : 2];
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.14 + Math.random() * 0.1, h, 6),
      new THREE.MeshBasicMaterial({
        color: colorPick,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    const fx = -width / 2 + (i / 21) * width;
    const fz = (Math.random() - 0.5) * depth * 0.75;
    const baseY = 0.18 + h / 2;
    mesh.position.set(fx, baseY, fz);
    group.add(mesh);
    flames.push({
      mesh,
      baseY,
      phase: Math.random() * Math.PI * 2,
      speed: 4.5 + Math.random() * 4,
    });
  }

  const emberCount = 30;
  const pos = new Float32Array(emberCount * 3);
  const seeds = new Float32Array(emberCount);
  for (let i = 0; i < emberCount; i++) {
    pos[i * 3] = (Math.random() - 0.5) * width;
    pos[i * 3 + 1] = 0.2 + Math.random() * 1.2;
    pos[i * 3 + 2] = (Math.random() - 0.5) * depth;
    seeds[i] = Math.random();
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const embers = new THREE.Points(
    emberGeo,
    new THREE.PointsMaterial({
      color: 0xffc75a,
      size: 0.08,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  group.add(embers);

  const light = new THREE.PointLight(0xff8a3d, 2.4, 10, 2);
  light.position.y = 1.2;
  group.add(light);

  scene.add(group);
  napalmFx.push({
    group,
    flames,
    embers,
    emberSeeds: seeds,
    glow,
    light,
    life: 0,
    maxLife: Math.max(0.5, duration),
  });
}

function updateNapalmFx(dt) {
  for (let i = napalmFx.length - 1; i >= 0; i--) {
    const fx = napalmFx[i];
    fx.life += dt;

    if (fx.life >= fx.maxLife) {
      scene.remove(fx.group);
      disposeMesh(fx.group);
      napalmFx.splice(i, 1);
      continue;
    }

    const fade = Math.min(1, (fx.maxLife - fx.life) / 0.8);

    for (const fl of fx.flames) {
      const t = fx.life * fl.speed + fl.phase;
      const sx = 1 + Math.sin(t * 0.7) * 0.1;
      const sy = 0.85 + Math.sin(t * 1.2) * 0.2;
      fl.mesh.scale.set(sx, sy, sx);
      fl.mesh.position.y = fl.baseY + Math.sin(t * 0.9) * 0.05;
      fl.mesh.material.opacity = (0.5 + Math.sin(t * 1.3) * 0.2) * fade;
    }

    const arr = fx.embers.geometry.attributes.position.array;
    for (let j = 0; j < arr.length; j += 3) {
      arr[j + 1] += dt * (0.3 + fx.emberSeeds[j / 3] * 0.4);
      if (arr[j + 1] > 1.4) arr[j + 1] = 0.18;
    }
    fx.embers.geometry.attributes.position.needsUpdate = true;
    fx.embers.material.opacity = 0.9 * fade;

    fx.glow.material.opacity = (0.6 + Math.sin(fx.life * 9) * 0.12) * fade;
    fx.light.intensity = (1.9 + Math.sin(fx.life * 15) * 0.4) * fade;
  }
}

/* 甲查当前火区：remaining 是还能烧几秒 */
export function getFireZones() {
  return fireZones.map((f) => ({
    x: f.x,
    z: f.z,
    radius: f.radius,
    remaining: Math.max(0, f.maxLife - f.life),
    maxLife: f.maxLife,
  }));
}

function updateFireZones(dt) {
  for (let i = fireZones.length - 1; i >= 0; i--) {
    const f = fireZones[i];
    f.life += dt;

    if (f.life >= f.maxLife) {
      removeFireZone(f);
      fireZones.splice(i, 1);
      continue;
    }

    const t = f.life / f.maxLife;
    // 最后 0.7 秒慢慢收掉，不要突然消失
    const fade = t < 0.85 ? 1 : Math.max(0, 1 - (t - 0.85) / 0.15);

    // 两个不同频率的正弦叠一起，火光才像在跳，不像在呼吸
    const flicker =
      0.82 +
      Math.sin(f.life * 13 + f.phase) * 0.13 +
      Math.sin(f.life * 29 + f.phase * 2.1) * 0.09;

    f.glow.material.opacity = Math.max(0, Math.min(1, 1.05 * fade * flicker));
    f.glow.scale.set(
      f.radius * 2.3 * (0.96 + flicker * 0.08),
      f.radius * 2.3 * (0.96 + flicker * 0.08),
      1
    );
    f.char.material.opacity = 0.62 * fade;

    // 火苗：按面积给发射速率，大火区蹿得更猛
    f.acc += dt * (30 + f.radius * 10) * fade;
    while (f.acc >= 1) {
      f.acc -= 1;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * f.radius * 0.82;
      const px = f.x + Math.cos(a) * rr;
      const pz = f.z + Math.sin(a) * rr;
      const hot = Math.random() < 0.28;
      spawnBurst(px, 0.12, pz, hot ? 0xffd98a : 0xff6a22, 1, {
        speed: 0.45,
        up: 2.3,
        spread: 0.16,
        life: hot ? 0.34 : 0.5,
        gravity: 1.7,
      });
      // 偶尔冒一口黑烟，火区才有厚度
      if (Math.random() < 0.1) {
        spawnBurst(px, 0.5, pz, 0x3a2e26, 1, {
          speed: 0.3,
          up: 1.1,
          spread: 0.3,
          life: 1.2,
          gravity: 0.6,
        });
      }
    }
  }
}

// 重开一局：陨石、火区、弹坑全部清掉，别把上一局的火留到新局里
function clearHazards() {
  for (const m of meteors) {
    scene.remove(m.group);
    disposeMesh(m.group);
  }
  meteors.length = 0;

  for (const f of fireZones) removeFireZone(f);
  fireZones.length = 0;

  for (const f of campfireFx) {
    scene.remove(f.group);
    disposeMesh(f.group);
  }
  campfireFx.length = 0;

  for (const f of napalmFx) {
    scene.remove(f.group);
    disposeMesh(f.group);
  }
  napalmFx.length = 0;

  for (const c of craters) {
    scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    c.mesh.material.dispose();
  }
  craters.length = 0;
}

/* ----------------------------------------------------------
 * 血月（点子池「血月」那条，画面归乙，「出 Boss」归甲）
 *
 * 先说一个必须交代的限制：这台相机是 45° 俯视、画面顶边只到 z≈-52 的地面高度 y=0，
 * 屏幕上根本看不到天空。所以"天上一轮红月"这种做法在这个视角下是画不出来的
 * （试过，月盘投影到 y=-665px，整个在画面外）。血月改用三层在俯视下真看得见的东西：
 *
 *   1. 天色：交给昼夜模块的 setBloodMoon——背景/雾往暗血红混、主光偏红、环境光压暗
 *   2. 天光：一盏从正上方打下来的红光，地面和人群染红（这是俯视下最有"天色变了"感的一层）
 *   3. 暗角：全屏四边压一层血红 vignette，呼吸式明暗，像镜头被血雾包住
 *   4. 余烬：零星往上飘的红色火星
 *
 * 触发：triggerBloodMoon()，默认每 10 波自动来一次（BLOOD_MOON_EVERY）。
 * 甲要控节奏就 setBloodMoonAuto(false)，或直接 triggerBloodMoon(false) 关掉。
 * 开启/关闭都派发 'bloodMoon' 事件（detail { wave, on }），甲按这个刷 Boss。
 * ---------------------------------------------------------- */
const BLOOD_MOON_EVERY = 10;
let bloodMoonOn = false;
let bloodMoonAuto = true;
let bloodMoonProgress = 0;   // 视觉自己跟的淡入进度
let bloodMoonEmber = 0;      // 余烬发射计时
let bloodMoonLight = null;   // 头顶那盏红光

function ensureBloodMoon() {
  if (bloodMoonLight || !scene) return;
  bloodMoonLight = new THREE.DirectionalLight(0xff3a20, 0);
  bloodMoonLight.position.set(0, 30, -6);   // 正上方偏后，照亮整条战场
  scene.add(bloodMoonLight);
}

/* 开 / 关血月。传 false 收掉，传 truthy 开启。
 * 重复调用同状态不会重播过渡（除非 force）。 */
export function triggerBloodMoon(on = true, opts = {}) {
  const want = !!on;
  if (want === bloodMoonOn && !opts.force) return bloodMoonOn;

  bloodMoonOn = want;
  ensureBloodMoon();
  if (dayNight) dayNight.setBloodMoon(want, !!opts.instant);
  // instant：换图 / 重开时用，画面立刻到位，不走淡入
  if (opts.instant) {
    bloodMoonProgress = want ? 1 : 0;
    if (bloodMoonLight) bloodMoonLight.intensity = want ? 2.4 : 0;
    if (fxBloodMoon) fxBloodMoon.style.opacity = want ? '0.55' : '0';
  }

  if (!opts.silent) {
    if (want) {
      shake = Math.max(shake, 0.28);
      pushToast('血月升起 · 它来了', 'blood');
    } else {
      pushToast('血月退去', 'blood');
    }
  }

  if (eventsRef) {
    try {
      eventsRef.dispatchEvent(new CustomEvent('bloodMoon', {
        detail: { wave: opts.wave || (currentState ? currentState.wave : lastWave), on: want },
      }));
    } catch (err) {
      // 事件异常不影响画面
    }
  }
  return bloodMoonOn;
}

export function setBloodMoonAuto(on) {
  bloodMoonAuto = !!on;
}

export function isBloodMoon() {
  return bloodMoonOn;
}

function updateBloodMoon(dt) {
  if (!scene) return;

  const targetP = bloodMoonOn ? 1 : 0;
  // 淡入比淡出慢：升起来要有仪式感，收掉要干脆
  const speed = targetP > bloodMoonProgress ? 0.55 : 0.9;
  bloodMoonProgress += (targetP - bloodMoonProgress) * Math.min(1, dt * speed * 2.2);
  if (Math.abs(targetP - bloodMoonProgress) < 0.004) bloodMoonProgress = targetP;

  const p = bloodMoonProgress;
  if (p <= 0.001 && !bloodMoonLight) return;

  ensureBloodMoon();

  // 天光：强度跟着淡入走，还要有一点呼吸，否则像贴了一层静态红纸
  if (bloodMoonLight) {
    const breathe = 0.9 + Math.sin(performance.now() * 0.0013) * 0.1;
    bloodMoonLight.intensity = 2.4 * p * breathe;
  }

  // 暗角：用 CSS opacity 推，不走重排
  if (fxBloodMoon) {
    const halo = 0.55 + Math.sin(performance.now() * 0.0016) * 0.12;
    fxBloodMoon.style.opacity = (p * halo).toFixed(3);
  }

  // 余烬：血月期间从场地各处往上飘，密度压得很低，只是"空气里有东西"
  if (p > 0.35) {
    bloodMoonEmber += dt * 7 * p;
    while (bloodMoonEmber >= 1) {
      bloodMoonEmber -= 1;
      spawnBurst(
        (Math.random() - 0.5) * 17,
        0.15 + Math.random() * 1.4,
        -26 + Math.random() * 33,
        0xff4a30, 1,
        { speed: 0.25, up: 1.5, spread: 0.5, life: 1.5, gravity: 0.35 }
      );
    }
  }
}

// 本波已经过去多少秒（界面层用）
let lastWaveStartTime = 0;
let currentState = null;

export function getWaveElapsed() {
  if (!currentState) return 0;
  return Math.max(0, currentState.time - lastWaveStartTime);
}

/* 切换时代（只换配色，不改任何数值）。
 * 队长做"Boss 击败后换时代"时直接调这个：applyEraIndex(4) 就切到星际。 */
export function applyEraIndex(index) {
  const era = getEra(index);
  applyEra(era);
  return era;
}

/* 当前是第几个时代（0 起） */
export function getCurrentEraIndex() {
  return currentEra ? currentEra.id : 0;
}

/* ----------------------------------------------------------
 * 每帧同步
 * ---------------------------------------------------------- */
/* 自适应画质：帧率掉了就降渲染分辨率。
 * 演示用的机器不一定有独显，角色堆到几十只时降一档分辨率就能救回来。
 * 滞回设计：连续两秒低帧才降，帧率稳住五秒才升回去，避免来回抖。 */
function updateAdaptiveQuality(dt) {
  if (!renderer) return;
  fpsAcc += dt;
  fpsFrames += 1;
  if (fpsAcc < 1) return;

  fpsValue = fpsFrames / fpsAcc;
  fpsAcc = 0;
  fpsFrames = 0;

  if (fpsValue < 45 && qualityScale > 0.6) {
    lowFpsTicks += 1;
    if (lowFpsTicks >= 2) {
      qualityScale = Math.max(0.6, qualityScale - 0.2);
      renderer.setPixelRatio(maxPixelRatio * qualityScale);
      lowFpsTicks = 0;
    }
  } else if (fpsValue > 58 && qualityScale < 1) {
    lowFpsTicks -= 1;
    if (lowFpsTicks <= -5) {
      qualityScale = Math.min(1, qualityScale + 0.2);
      renderer.setPixelRatio(maxPixelRatio * qualityScale);
      lowFpsTicks = 0;
    }
  } else {
    lowFpsTicks = 0;
  }
}

export function syncScene(state, dt) {
  if (!renderer) return;

  // 重开一局：波次回到 1 而上一帧还在后面的波次，说明是新的一局
  if (lastWave > 1 && state.wave === 1) {
    resetBarrels();                      // 桶全部复原
    clearHazards();                      // 陨石坑、地上的火一起清掉
    clearCrates();                       // 补给箱模型也清掉，别留到新局
    clearChains();                       // 锁链也清掉
    clearPits();                         // 坑洞回填
    clearPickups();                      // 武器箱也清掉
    quakeTime = 0;
    quakeCycle = 10 + Math.random() * 6; // 新局第一震别来得太急
    if (dayNight) dayNight.setNight(false, true); // 立刻回到白天，不要跨局慢慢过渡
    if (bloodMoonOn || bloodMoonProgress > 0.01) {
      triggerBloodMoon(false, { instant: true, silent: true }); // 血月也一并收掉，别弹提示
    }
    soldierTierIndex = -1;               // 兵种档位重算（不弹晋升提示）
    tierAnnounced = false;
  }
  lastWave = state.wave;

  currentState = state;

  // 时间减速/时间膨胀/熵增生效时，叠一层蓝色慢放滤镜
  if (fxSlow) {
    fxSlow.classList.toggle(
      'show',
      state.status === 'playing' && state.time < state.slowUntil
    );
  }

  // 僵尸低吼的氛围音：交给音频层自己计时，这里只报数量和是否在局内
  updateAudio(
    dt,
    state.zombies ? state.zombies.length : 0,
    state.status === 'playing' && !state.paused
  );

  // 指挥光环：跟着玩家走，慢慢转
  if (playerRing) {
    playerRing.position.x = state.player.x;
    playerRing.position.z = state.player.z;
    playerRing.rotation.z += dt * 0.8;
    playerRing.material.opacity = 0.42 + Math.sin(performance.now() * 0.003) * 0.14;
  }

  // 基因爆发光环：跟着玩家走，增益结束自动消失
  if (buffRing) {
    const buffActive = state.status === 'playing' && state.time < state.buffUntil;
    buffRing.visible = buffActive;
    if (buffActive) {
      const now = performance.now();
      buffRing.position.set(state.player.x, 0.05, state.player.z);
      buffRing.rotation.z -= dt * 1.6;
      buffRing.scale.setScalar(1 + Math.sin(now * 0.008) * 0.07);
      buffRing.material.opacity = 0.3 + Math.sin(now * 0.01) * 0.12;
    }
  }

  // 队长
  if (playerVisual) {
    playerVisual.root.position.x = state.player.x;
    playerVisual.root.position.z = state.player.z;

    // 移动时身体微微前倾，像在压着枪线走
    const moveTilt = Math.max(-0.12, Math.min(0.12, (state.player.x - lastPlayerX) * 6));
    playerVisual.root.rotation.z += (moveTilt - playerVisual.root.rotation.z) * Math.min(1, dt * 8);
    lastPlayerX = state.player.x;
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
  syncBarricade(state);
  syncSlots(state, dt);
  syncCrates(state);
  syncChains(state);
  syncPits(state);
  syncBlackHoles(state, dt);
  syncPickups(state);
  updateBossPresence(state);
  updateZombieHitFeedback(state);

  // 子弹 + 远程僵尸的酸液
  syncBullets(state);
  syncEnemyShots(state);
  // 滚木和骑士冲锋：持续移动的实体，按 state 里的数组同步
  syncRollingLogs(state);
  syncKnightCharges(state);
  syncTankSupport(state);
  syncApcs(state);
  syncCarrierDrones(state);
  syncSwarmDrones(state);
  syncFriendlyZombies(state);
  syncVirusBombs(state);

  updateEffects(dt);
  updateParticleFx(dt);
  updateMeteors(dt);
  updateFireZones(dt);
  updateCampfireFx(dt);
  updateNapalmFx(dt);
  updateCraters(dt);
  updateFloats(dt);
  updateBlood(dt);
  updateToast(dt);
  // 只在局内推进桶的落体和引信，避免菜单阶段桶就掉完了
  if (state.status === 'playing') updateBarrels(dt);
  updateAmbientFx(dt);
  updateWater(dt);
  updateQuakeCycle(dt, state.status === 'playing');
  updateQuake(dt);
  updateBloodMoon(dt);
  updateDeathQueue(dt);
  updatePropAnimations(dt);
  updateAdaptiveQuality(dt);
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
    // 阵型在玩家身后（z 更大，靠近屏幕底部），第 0 排贴着玩家，往后每排再退一点
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
    soldierMesh.material.color
      .setHex(tier.color)
      .multiply(new THREE.Color(eraSoldierTint[0], eraSoldierTint[1], eraSoldierTint[2]));
    if (soldierMesh.material.emissive) {
      soldierMesh.material.emissive.setHex(tier.color);
      soldierMesh.material.emissiveIntensity = tier.emissive || 0;
    }
  }

  // 真模型：材质是骨架克隆共享的，全队同档位，改一次就够。
  // 必须先还原基准色再乘，否则每次升级颜色会越乘越偏。
  captureSoldierMats();
  if (soldierMats) {
    // 乘色顺序：基准色 × 兵种档位 × 时代（两个乘色叠在一起）
    const tint = new THREE.Color(
      Math.min(1.2, tier.tint[0] * eraSoldierTint[0]),
      Math.min(1.2, tier.tint[1] * eraSoldierTint[1]),
      Math.min(1.2, tier.tint[2] * eraSoldierTint[2])
    );
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

/* ----------------------------------------------------------
 * 时代皮肤：换时代 = 换一套配色（不改数值）
 * ---------------------------------------------------------- */

// 收集五种僵尸原型的材质，供时代切换统一乘色
function collectZombieMats() {
  if (zombieMats.length) return zombieMats;
  const seen = new Set();
  for (const proto of modelLib.zombies) {
    // 专属模型是后台加载的，进游戏那一刻数组里可能还是 null
    if (!proto) continue;
    proto.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !m.color || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        zombieMats.push(m);
      }
    });
  }
  // 锁定基准色：此刻的颜色 = 原始色 × 类型乘色 × 地图氛围色，
  // 之后时代切换都从这个基准重新乘，不会越乘越偏
  if (zombieMats.length) tintMaterials(zombieMats, [1, 1, 1]);
  return zombieMats;
}

// 时代换装：换时代时整队士兵换模型。
// 只换外观，数值一个都不动（数值归甲）。
function swapSoldierModel(proto) {
  if (!proto || proto === modelLib.soldier) return;

  const oldProto = modelLib.soldier;

  for (const vis of soldierVisuals) {
    scene.remove(vis.root);
    despawnModel(vis);
  }
  soldierVisuals.length = 0;
  modelLib.soldier = proto;

  // 旧原型的材质只有旧克隆在用，换装完可以释放（不释放会随换装次数累积内存）
  if (oldProto && oldProto !== proto) {
    oldProto.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        m.map?.dispose();
        m.dispose();
      }
    });
  }

  // 新原型的材质和旧的不是一套，基准色要重新抓一遍
  soldierMats = null;
  captureSoldierMats();
  applySoldierTier(getTier(lastSoldierCount));
}

function applyEra(era) {
  if (!era) return;
  currentEra = era;
  eraSoldierTint = era.soldierTint || [1, 1, 1];
  eraZombieTint = era.zombieTint || [1, 1, 1];
  eraBulletTint = era.bulletTint || [1, 1, 1];

  // 士兵：走档位那条路（里面已经叠了时代乘色）
  applySoldierTier(getTier(lastSoldierCount));

  // 时代换装：士兵整队换模型（模型没加载完之前没有可换的，跳过）
  const eraProto = modelLib.soldiersByEra ? modelLib.soldiersByEra[era.id] : null;
  if (eraProto) swapSoldierModel(eraProto);

  // 僵尸：基准色已锁定，这里只乘时代这一层
  if (modelLib.zombies.length) {
    applyEraLook(era, { zombieMats: collectZombieMats() });
  }

  // 路障换成这个时代的长相（木栅栏 → 沙袋 → 混凝土 → 钢板 → 能量场 → 激光）
  buildBarricadeLook(era.id);
}

function updateSoldiers(state) {
  const n = Math.min(state.soldiers, MAX_SOLDIER_VISUALS);
  lastSoldierCount = state.soldiers;

  // 档位变化：改外观 + 弹一条提示（开局那次不弹）
  const ti = getTierIndex(state.soldiers);
  const prevTierIndex = soldierTierIndex;
  let tier = TIERS[ti];
  if (ti !== soldierTierIndex) {
    soldierTierIndex = ti;
    tier = getTier(state.soldiers);
    applySoldierTier(tier);
    if (tierAnnounced) {
      const demoted = ti < prevTierIndex;
      pushToast(
        `${demoted ? '降级' : '晋升'} · ${tier.name}`,
        demoted ? 'tier-down' : 'tier'
      );
      spawnRing(
        state.player.x,
        state.player.z,
        demoted ? 0xff6a4a : tier.accent,
        0.9
      );
      shake = Math.max(shake, demoted ? 0.2 : 0.14);
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
        // 地图覆盖：这张图的专属僵尸长什么样（只换模型，数值还是 type 说了算）
        // 地图换场后新刷的僵尸要用当前地图的皮肤，不能一直用开局那张图的
        const mapOverride = MAP_TYPE_SRC[state.mapId] || null;
        const overrideSrc = mapOverride ? mapOverride[z.type] : null;
        const proto =
          (overrideSrc && modelLib.bySrc && modelLib.bySrc[overrideSrc]) ||
          modelLib.zombies[z.type] ||
          modelLib.zombies[0];
        const vis = spawnModel(proto, 0); // 面朝玩家（+z）
        // 记下 id：出拳动作演完时要用它派 bossAttackDone 回玩法层
        if (vis) vis.zombieId = z.id;
        entry = vis
          ? { isModel: true, vis }
          : { isModel: false, mesh: makeZombieMesh(z.type) };

        // 精英和 Boss 头顶挂血条；普通僵尸不显示，避免满屏血条
        const look = ZOMBIE_LOOKS[z.type];
        if (look && (look.isBoss || look.score >= 5)) {
          // Boss 血条也要跟着放大：2.0 是给 3 单位高的小 Boss 用的，
          // 现在它有 16 单位高，血条还那么细就成了一根头发丝
          const w = look.isBoss ? BOSS_HPBAR_WIDTH : 1.2;
          entry.hpBar = makeHpBar(w);
          entry.hpHeight =
            MODEL_TARGET.zombieHeight * look.scale * (look.isBoss ? BOSS_HEIGHT_MUL : 1);
        }

        if (look && look.isBoss) {
          if (vis && vis.roarAction) {
            vis.roarAction.reset();
            vis.roarAction.paused = false;
            vis.roarAction.play();
          }
          bossOnField = true;
          shake = Math.max(shake, 0.65);
          pushToast('BOSS 登场', 'boss');
          if (fxHurt) {
            fxHurt.classList.remove('show');
            void fxHurt.offsetWidth;
            fxHurt.classList.add('show');
          }
          playBossRoar();
        }
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

    if (entry.hpBar) {
      // 血条跟着僵尸走，始终面向相机
      const ratio = z.maxHp ? Math.max(0, Math.min(1, z.hp / z.maxHp)) : 1;
      entry.hpBar.fill.scale.x = entry.hpBar.width * ratio;
      entry.hpBar.group.position.set(z.x, (entry.hpHeight || 1.8) + 0.35, z.z);
    }

    if (entry.isModel) {
      const root = entry.vis.root;
      root.position.x = z.x;
      root.position.z = z.z;
      root.rotation.z += (targetTilt - root.rotation.z) * Math.min(1, dt * 14);

      // 走 ↔ 攻击切换：贴近防线（touchZ=8.2 之前一小段）就开始挥拳挠阵，
      // 每种类型拳速不同（大块头慢而重、快鬼连挠）；切进攻击的瞬间吼一声。
      // Boss 例外：它的拳头由玩法层的 bossAttack 事件单发驱动，
      // 不能在这里循环播，否则会变成一个永远在挥拳的动画，节奏和扣兵对不上
      const vis = entry.vis;
      const isBossVis = !!(ZOMBIE_LOOKS[z.type] && ZOMBIE_LOOKS[z.type].isBoss);
      // Boss 整块跳过：它的拳头由玩法层的 bossAttack 事件单发驱动。
      // 如果让它走下面这套自动切换，那个 `else if` 会在出拳的下一帧
      // 把动作淡回走路 —— 出拳永远演不完，bossAttackDone 也就永远等不到
      // Boss 离开防线（被虫洞/击退推回去）时，从收招姿势切回走路。
      // 出拳之间不要切，不然每拳结尾都会闪回走路再闪回攻击。
      if (isBossVis && vis.attacking && !z.attacking) {
        vis.attacking = false;
        if (vis.attackAction) vis.attackAction.fadeOut(0.3);
        if (vis.walkAction) {
          vis.walkAction.reset();
          vis.walkAction.play();
          vis.walkAction.fadeIn(0.3);
        }
      }

      if (vis.attackAction && !isBossVis) {
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
      // 僵尸从 state 里消失 = 被打死了。模型版先播死亡动画再消失，
      // 血雾和魂火由 zombieDie 事件负责。
      if (entry.hpBar) {
        // 血条跟着尸体一起消失
        disposeHpBar(entry.hpBar);
        entry.hpBar = null;
      }
      if (entry.isModel && entry.vis.deathAction) {
        playDeathAnim(entry.vis);
      } else {
        if (entry.isModel) despawnModel(entry.vis);
        else {
          scene.remove(entry.mesh);
          disposeMesh(entry.mesh);
        }
      }
      zombieMeshes.delete(id);
    }
  }
}

/* ----------------------------------------------------------
 * 死亡演出：僵尸倒下再消失
 * ---------------------------------------------------------- */

const deathQueue = [];   // { vis, t, life }

function playDeathAnim(vis) {
  const act = vis.deathAction;
  if (!act) {
    despawnModel(vis);
    return;
  }
  // 停掉走/打的动作，切到死亡动画播一遍
  if (vis.walkAction) vis.walkAction.stop();
  if (vis.attackAction) vis.attackAction.stop();
  act.reset();
  act.paused = false;
  act.play();
  deathQueue.push({ vis, t: 0, life: Math.min(1.1, (act.getClip().duration || 1) * 0.9) });
}

function updateDeathQueue(dt) {
  for (let i = deathQueue.length - 1; i >= 0; i--) {
    const d = deathQueue[i];
    d.t += dt;
    // 最后 0.3 秒往下沉一点，模拟陷进地里
    if (d.t > d.life - 0.3) {
      const k = Math.max(0, (d.life - d.t) / 0.3);
      d.vis.root.position.y -= (1 - k) * 0.5 * dt * 8;
      d.vis.root.scale.multiplyScalar(1 - 0.5 * dt * (1 - k));
    }
    if (d.t >= d.life) {
      despawnModel(d.vis);
      deathQueue.splice(i, 1);
    }
  }
}

/* 僵尸受击反馈
 * 玩法侧没有"被打中"的事件，但僵尸的血量会掉——视觉层自己盯着血量变化：
 * 血一掉就播一下受击动画并溅一点血雾，不用等队长加事件。 */
const zombieHpWatch = new Map();

function updateZombieHitFeedback(state) {
  const alive = new Set();
  for (const z of state.zombies) {
    alive.add(z.id);
    const last = zombieHpWatch.get(z.id);
    if (last !== undefined && z.hp < last - 0.001) {
      onZombieHit(z);
    }
    zombieHpWatch.set(z.id, z.hp);
  }
  for (const id of zombieHpWatch.keys()) {
    if (!alive.has(id)) zombieHpWatch.delete(id);
  }
}

function onZombieHit(z) {
  const entry = zombieMeshes.get(z.id);
  // 小血雾：比死亡时少一半
  spawnBurst(z.x, 1.0, z.z, 0x8a2f22, 7, { speed: 1.8, up: 1.8, spread: 0.35, life: 0.32 });

  if (entry && entry.isModel && entry.vis.damageAction) {
    const act = entry.vis.damageAction;
    act.reset();
    act.paused = false;
    act.play();
    // 受击动画播完停住，别一直抖
    setTimeout(() => { act.paused = true; }, 320);
  }
}

// 场上还有没有 Boss：没有就把镜头拉回去
function updateBossPresence(state) {
  let has = false;
  for (const z of state.zombies) {
    const look = ZOMBIE_LOOKS[z.type];
    if (look && look.isBoss) { has = true; break; }
  }
  bossOnField = has;
}

/* ----------------------------------------------------------
 * 远程僵尸吐的酸液（点子池「远程僵尸」）
 *
 * 一个亮绿小球 + 一条短拖尾，飞行途中冒几粒火星。
 * 它必须比僵尸的绿色更亮更饱和，否则混在人群里看不出来躲。
 * ---------------------------------------------------------- */
const enemyShotMeshes = new Map();
let enemyShotGeo = null;
let enemyShotMat = null;

function ensureEnemyShotAssets() {
  if (enemyShotGeo) return;
  enemyShotGeo = new THREE.SphereGeometry(0.16, 8, 6);
  enemyShotMat = new THREE.MeshBasicMaterial({
    color: 0xb4ff5a,
    transparent: true,
    opacity: 0.95,
  });
}

function syncEnemyShots(state) {
  if (!scene) return;
  const list = state.enemyShots || [];
  if (!list.length && !enemyShotMeshes.size) return;

  ensureEnemyShotAssets();
  const alive = new Set();

  for (const s of list) {
    alive.add(s.id);
    let mesh = enemyShotMeshes.get(s.id);
    if (!mesh) {
      mesh = new THREE.Mesh(enemyShotGeo, enemyShotMat);
      scene.add(mesh);
      enemyShotMeshes.set(s.id, mesh);
    }
    mesh.position.set(s.x, 0.85, s.z);
    // 一边飞一边冒一点点绿火，看得见来向。
    // 概率压得低：同屏可能有 5-6 发酸液，粒子池只有 500 个，别把血雾挤掉
    if (Math.random() < 0.18) {
      spawnBurst(s.x, 0.85, s.z, 0x9aff5a, 1, {
        speed: 0.4, up: 0.4, spread: 0.12, life: 0.3, gravity: -0.6,
      });
    }
  }

  // 几何体和材质是所有酸液共享的，这里只把 mesh 从场景摘掉，绝不 dispose
  for (const [id, mesh] of enemyShotMeshes) {
    if (alive.has(id)) continue;
    scene.remove(mesh);
    enemyShotMeshes.delete(id);
  }
}

function syncBullets(state) {  const alive = new Set();

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

/* 滚木：一根沿 z 轴躺着的圆柱，从左往右滚，绕自身轴旋转 */
function makeRollingLogEntry(log) {
  const group = new THREE.Group();
  const spinner = new THREE.Group();
  spinner.position.y = log.radius;

  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.95 });
  const bark = new THREE.MeshStandardMaterial({ color: 0x4a2f14, roughness: 1 });

  const geo = new THREE.CylinderGeometry(log.radius, log.radius, log.length, 10, 1);
  geo.rotateX(Math.PI / 2); // 圆柱轴从 Y 转到 Z，躺成纵向
  const body = new THREE.Mesh(geo, wood);
  spinner.add(body);

  // 端面铁箍
  for (const z of [-log.length / 2 + 0.06, log.length / 2 - 0.06]) {
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(log.radius * 1.01, 0.055, 6, 16),
      bark
    );
    band.position.z = z;
    spinner.add(band);
  }

  // 两个凸起的节疤，转动时能看出滚木在滚
  for (const [z, y] of [[-log.length * 0.18, 0], [log.length * 0.2, Math.PI]]) {
    const knot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.5), bark);
    knot.position.set(Math.cos(y) * log.radius * 0.98, Math.sin(y) * log.radius * 0.98, z);
    spinner.add(knot);
  }

  group.add(spinner);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(log.radius * 2.4, log.length),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(shadow);

  return { group, spinner };
}

function syncRollingLogs(state) {
  const alive = new Set();

  for (const log of state.rollingLogs || []) {
    alive.add(log.id);

    let entry = rollingLogMeshes.get(log.id);
    if (!entry) {
      entry = makeRollingLogEntry(log);
      scene.add(entry.group);
      rollingLogMeshes.set(log.id, entry);
    }

    entry.group.position.set(log.x, 0, log.z);
    entry.spinner.rotation.z = log.spin || 0;
  }

  for (const [id, entry] of rollingLogMeshes) {
    if (!alive.has(id)) {
      scene.remove(entry.group);
      disposeMesh(entry.group);
      rollingLogMeshes.delete(id);
    }
  }
}

/* 骑士：骑马 + 骑手 + 长枪的简单几何组合，朝 -z（屏幕上方）冲 */
function makeKnightEntry() {
  const group = new THREE.Group();

  const steel = new THREE.MeshStandardMaterial({
    color: 0xc9d4e0,
    roughness: 0.45,
    metalness: 0.45,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x343a44, roughness: 0.9 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x7c2a22, roughness: 0.95 });

  const add = (geo, mat, x, y, z) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };

  // 马
  add(new THREE.BoxGeometry(0.55, 0.42, 1.1), cloth, 0, 0.55, 0);
  add(new THREE.BoxGeometry(0.22, 0.45, 0.28), dark, 0, 0.82, -0.5);
  add(new THREE.BoxGeometry(0.22, 0.22, 0.42), dark, 0, 1.02, -0.68);
  for (const [lx, lz] of [[-0.2, -0.35], [0.2, -0.35], [-0.2, 0.35], [0.2, 0.35]]) {
    add(new THREE.BoxGeometry(0.1, 0.5, 0.1), dark, lx, 0.25, lz);
  }

  // 骑手
  add(new THREE.BoxGeometry(0.32, 0.5, 0.32), steel, 0, 1.0, 0.02);
  add(new THREE.ConeGeometry(0.18, 0.32, 6), steel, 0, 1.42, 0.02);

  // 长枪，指向前方
  const lance = add(new THREE.CylinderGeometry(0.045, 0.045, 2.0, 6), steel, 0.32, 1.05, -0.75);
  lance.rotation.x = Math.PI / 2;
  const tip = add(new THREE.ConeGeometry(0.09, 0.25, 6), steel, 0.32, 1.05, -1.78);
  tip.rotation.x = -Math.PI / 2;

  // 盾
  add(new THREE.BoxGeometry(0.08, 0.42, 0.34), steel, -0.28, 1.05, 0);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 1.4),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(shadow);

  return group;
}

function syncKnightCharges(state) {
  const alive = new Set();

  for (const k of state.knightCharges || []) {
    alive.add(k.id);

    let mesh = knightChargeMeshes.get(k.id);
    if (!mesh) {
      mesh = makeKnightEntry();
      scene.add(mesh);
      knightChargeMeshes.set(k.id, mesh);
    }
    mesh.position.set(k.x, 0, k.z);
  }

  for (const [id, mesh] of knightChargeMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      knightChargeMeshes.delete(id);
    }
  }
}

/* 坦克支援：左下方一辆坦克，打三发后撤退 */
function makeTankSupportMesh() {
  const group = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x6f7a58, roughness: 0.85 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2f28, roughness: 0.9 });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.5, 1.55), hullMat);
  hull.position.y = 0.45;
  group.add(hull);

  for (const x of [-0.55, 0.55]) {
    const track = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.38, 1.7), darkMat);
    track.position.set(x, 0.22, 0);
    group.add(track);
  }

  const turret = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.7), hullMat);
  turret.position.set(0, 0.82, 0.05);
  group.add(turret);

  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 1.1), darkMat);
  barrel.position.set(0, 0.9, -0.72);
  barrel.rotation.x = -0.3;
  group.add(barrel);

  return group;
}

function syncTankSupport(state) {
  const alive = new Set();

  for (const t of state.tankSupports || []) {
    alive.add(t.id);
    let mesh = tankSupportMeshes.get(t.id);
    if (!mesh) {
      mesh = makeTankSupportMesh();
      scene.add(mesh);
      tankSupportMeshes.set(t.id, mesh);
    }
    mesh.position.set(t.x, 0, t.z);
  }

  for (const [id, mesh] of tankSupportMeshes) {
    if (alive.has(id)) continue;
    scene.remove(mesh);
    disposeMesh(mesh);
    tankSupportMeshes.delete(id);
  }
}

/* 装甲车 */
function makeApcMesh() {
  const group = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x7d8872, roughness: 0.8 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x262b24, roughness: 0.95 });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 1.7), hullMat);
  hull.position.y = 0.45;
  group.add(hull);

  for (const [x, z] of [[-0.45, -0.55], [0.45, -0.55], [-0.45, 0.55], [0.45, 0.55]]) {
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.16, 10),
      darkMat
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.22, z);
    group.add(wheel);
  }

  const turret = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.3, 0.55), hullMat);
  turret.position.set(0, 0.8, -0.1);
  group.add(turret);

  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.8), darkMat);
  barrel.position.set(0, 0.86, -0.6);
  group.add(barrel);

  return group;
}

function syncApcs(state) {
  const alive = new Set();

  for (const a of state.apcCharges || []) {
    alive.add(a.id);
    let mesh = apcMeshes.get(a.id);
    if (!mesh) {
      mesh = makeApcMesh();
      scene.add(mesh);
      apcMeshes.set(a.id, mesh);
    }
    mesh.position.set(a.x, 0, a.z);
  }

  for (const [id, mesh] of apcMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      apcMeshes.delete(id);
    }
  }
}

/* 舰载无人机 */
function makeCarrierDroneMesh() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x9fe3ff,
    emissive: 0x2b6f8f,
    emissiveIntensity: 0.6,
    roughness: 0.4,
    metalness: 0.5,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x202a32, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.16, 0.46), bodyMat);
  group.add(body);

  for (const [x, z] of [[-0.22, -0.18], [0.22, -0.18], [-0.22, 0.18], [0.22, 0.18]]) {
    const rotor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 0.025, 10),
      darkMat
    );
    rotor.position.set(x, 0.1, z);
    group.add(rotor);
  }

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0x9fe3ff, transparent: true, opacity: 0.9 })
  );
  glow.position.y = -0.1;
  group.add(glow);

  return group;
}

function syncCarrierDrones(state) {
  const alive = new Set();

  for (const d of state.carrierDrones || []) {
    alive.add(d.id);
    let mesh = carrierDroneMeshes.get(d.id);
    if (!mesh) {
      mesh = makeCarrierDroneMesh();
      mesh.scale.setScalar(1.8);
      scene.add(mesh);
      carrierDroneMeshes.set(d.id, mesh);
    }
    mesh.position.set(d.x, 2.6, d.z);
    mesh.rotation.y = d.phase + performance.now() * 0.001;
  }

  for (const [id, mesh] of carrierDroneMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      carrierDroneMeshes.delete(id);
    }
  }
}

// 无人机蜂群：小型自杀机，贴着地面往目标飞，带一点倾斜
function syncSwarmDrones(state) {
  const alive = new Set();

  for (const d of state.swarmDrones || []) {
    alive.add(d.id);
    let entry = swarmDroneMeshes.get(d.id);
    if (!entry) {
      entry = { group: makeCarrierDroneMesh() };
      // 木机只有 0.32 宽，缩太小在竖屏上就是个点；1.0 才看得清是四旋翼
      entry.group.scale.setScalar(1.0);
      entry.group.traverse((o) => {
        if (o.material && o.material.color) o.material = o.material.clone();
      });
      scene.add(entry.group);
      swarmDroneMeshes.set(d.id, entry);
    }
    entry.group.position.set(d.x, 1.45 + Math.sin(d.life * 6) * 0.1, d.z);
    entry.group.rotation.y = d.heading || 0;
    entry.group.rotation.z = Math.sin(d.life * 9) * 0.12;
  }

  for (const [id, entry] of swarmDroneMeshes) {
    if (alive.has(id)) continue;
    scene.remove(entry.group);
    disposeMesh(entry.group);
    swarmDroneMeshes.delete(id);
  }
}

/* 友方僵尸：绿色单位，和敌方明显区分；召唤槽兵种按角色换颜色和体型 */
function makeFriendlyZombieMesh(role = null) {
  const group = new THREE.Group();
  const style = friendlyRoleStyle(role);
  const skin = new THREE.MeshStandardMaterial({
    color: style ? style.color : 0x5adf7a,
    emissive: 0x1f6b3a,
    emissiveIntensity: 0.45,
    roughness: 0.7,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x244532, roughness: 0.9 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.42), skin);
  body.position.y = 0.6;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), skin);
  head.position.y = 1.15;
  group.add(head);

  for (const x of [-0.18, 0.18]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.45, 0.15), dark);
    leg.position.set(x, 0.22, 0);
    group.add(leg);

    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), skin);
    arm.position.set(x * 1.9, 0.7, 0);
    group.add(arm);
  }

  // 脚下光环：双层，内圈实、外圈散，混在僵尸堆里也能一眼认出是自己人
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.48, 20),
    new THREE.MeshBasicMaterial({
      color: 0x5adf7a,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.48, 0.62, 22),
    new THREE.MeshBasicMaterial({
      color: 0x9effc0,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.015;
  group.add(halo);

  // 头顶阵营标记：一个朝下的小三角，比脚下光环更远也看得见——
  // 俯视视角下脚环容易被尸体和粒子盖住，头顶标记是最后一道保险
  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(0.13, 0.22, 3),
    new THREE.MeshBasicMaterial({
      color: 0x9effc0, transparent: true, opacity: 0.85, depthWrite: false,
    })
  );
  marker.position.y = 1.68;
  marker.rotation.x = Math.PI;   // 尖端朝下，指向自己
  marker.userData.bob = true;
  group.add(marker);

  group.userData.marker = marker;
  group.userData.ring = ring;
  return group;
}

/* ----------------------------------------------------------
 * 友方僵尸（生物人军团 / 病毒转化）
 *
 * 从几何体占位换成正式角色模型：复用敌人那套 b-zombie-* 的克隆管线
 * （自带 Walk / Punch / ReceiveHit / Death 全套动画），
 * 但材质整体染成阵营绿——这是"一眼分清敌我"的根本手段，比脚下光环更可靠。
 *
 * 为什么染色要改材质而不是叠一层绿色透明壳：
 * 叠壳会让模型变成一团糊绿，走路和出拳的形体全丢了；
 * 直接乘色能保住明暗结构，还能看出是个"人"。
 * ---------------------------------------------------------- */
const FRIENDLY_TINT = new THREE.Color(0.42, 1.32, 0.72);

// 召唤槽五种兵种的外观区分：染色 + 体型。
// 颜色都在绿色系里，保证一眼还是「自己人」，只是深浅和偏色不同。
const FRIENDLY_ROLE_STYLES = {
  shield: { tint: [0.42, 1.32, 0.72], color: 0x5adf7a, scale: 1.00 },
  runner: { tint: [0.62, 1.55, 0.52], color: 0x8cf07a, scale: 0.84 },
  bomber: { tint: [1.18, 1.20, 0.42], color: 0xd6e05a, scale: 0.92 },
  spitter: { tint: [0.34, 1.28, 1.22], color: 0x5ae0c8, scale: 0.96 },
  giant: { tint: [0.34, 1.10, 0.50], color: 0x3fbf5f, scale: 1.60 },
};

function friendlyRoleStyle(role) {
  return FRIENDLY_ROLE_STYLES[role] || null;
}

function tintFriendly(root, tint = FRIENDLY_TINT) {
  root.traverse((o) => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.material = Array.isArray(o.material)
      ? mats.map((m) => {
        const c = m.clone();
        if (c.color) c.color.multiply(tint);
        if (c.emissive) { c.emissive.setHex(0x1f6b3a); c.emissiveIntensity = 0.4; }
        return c;
      })
      : (() => {
        const c = mats[0].clone();
        if (c.color) c.color.multiply(tint);
        if (c.emissive) { c.emissive.setHex(0x1f6b3a); c.emissiveIntensity = 0.4; }
        return c;
      })();
  });
}

/* 在模型脚下挂阵营标识：双层光环 + 头顶三角。
 * 模型有 1.5 单位高，标识要按它的尺度放，不能沿用几何体那套数字。 */
function addFriendlyMarks(root, height) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.46, 20),
    new THREE.MeshBasicMaterial({
      color: 0x5adf7a, transparent: true, opacity: 0.6,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  root.add(ring);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.46, 0.6, 22),
    new THREE.MeshBasicMaterial({
      color: 0x9effc0, transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.025;
  root.add(halo);

  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(0.13, 0.22, 3),
    new THREE.MeshBasicMaterial({
      color: 0x9effc0, transparent: true, opacity: 0.85, depthWrite: false,
    })
  );
  marker.position.y = height + 0.2;
  marker.rotation.x = Math.PI;
  root.add(marker);

  root.userData.ring = ring;
  root.userData.halo = halo;
  root.userData.marker = marker;
  root.userData.markY = height + 0.2;
}

function syncFriendlyZombies(state) {
  const alive = new Set();
  const list = state.friendlyZombies || [];

  for (const f of list) {
    alive.add(f.id);
    let entry = friendlyZombieMeshes.get(f.id);

    if (!entry) {
      // 有模型就上正式角色，没有退回几何体占位（保证功能不会因为模型没加载就消失）
      const style = friendlyRoleStyle(f.role);
      // 召唤槽兵种按角色定体型；转化的僵尸稍大一点，和"召来的"区分开
      const scale = style ? style.scale : (f.converted ? 1.08 : 1);
      const proto = modelLib.zombies && modelLib.zombies[0];
      const vis = proto ? spawnModel(proto, 0) : null;

      if (vis) {
        const tint = style ? new THREE.Color(...style.tint) : FRIENDLY_TINT;
        tintFriendly(vis.root, tint);
        addFriendlyMarks(vis.root, MODEL_TARGET.zombieHeight);
        vis.root.scale.multiplyScalar(scale);
        scene.add(vis.root);
        entry = { isModel: true, vis, root: vis.root };
      } else {
        const mesh = makeFriendlyZombieMesh(f.role);
        mesh.scale.setScalar(scale);
        scene.add(mesh);
        entry = { isModel: false, root: mesh };
      }
      friendlyZombieMeshes.set(f.id, entry);
    }

    const root = entry.root;
    root.position.set(f.x, 0, f.z);

    // 头顶三角上下浮 + 光环呼吸。动起来才能在密堆里被眼睛挑出来
    const t = performance.now() * 0.0022;
    const mk = root.userData.marker;
    const rg = root.userData.ring;
    const ha = root.userData.halo;
    if (mk) mk.position.y = (root.userData.markY || 1.68) + Math.sin(t + f.id) * 0.07;
    if (rg) rg.material.opacity = 0.45 + Math.sin(t * 0.8 + f.id) * 0.16;
    if (ha) ha.material.opacity = 0.16 + Math.sin(t * 0.8 + f.id) * 0.1;

    // 朝向：友方是往 -z 走的，模型原生朝 +z，转 180°
    if (entry.isModel) root.rotation.y = Math.PI;
  }

  for (const [id, entry] of friendlyZombieMeshes) {
    if (alive.has(id)) continue;
    if (entry.isModel) {
      // 走的是共享几何体 + 独立材质：只摘场景、释放独立材质
      entry.root.traverse((o) => {
        if ((o.isMesh || o.isSkinnedMesh) && o.material) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of ms) m.dispose();
        }
      });
      despawnModel(entry.vis);
    } else {
      scene.remove(entry.root);
      disposeMesh(entry.root);
    }
    friendlyZombieMeshes.delete(id);
  }
}

/* 病毒炸弹：绿色罐体 + 地面预警圈 */
function makeVirusBombEntry(bomb) {
  const group = new THREE.Group();

  const canister = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 10, 8),
    new THREE.MeshStandardMaterial({
      color: 0x8fe36a,
      emissive: 0x3a7a22,
      emissiveIntensity: 0.7,
      roughness: 0.5,
    })
  );
  canister.position.y = 6.5;
  group.add(canister);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(bomb.radius - 0.07, bomb.radius, 44),
    new THREE.MeshBasicMaterial({
      color: 0x8fe36a,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  group.add(ring);

  return { group, canister, ring };
}

function syncVirusBombs(state) {
  const alive = new Set();

  for (const bomb of state.virusBombs || []) {
    alive.add(bomb.id);
    let entry = virusBombMeshes.get(bomb.id);
    if (!entry) {
      entry = makeVirusBombEntry(bomb);
      scene.add(entry.group);
      virusBombMeshes.set(bomb.id, entry);
    }

    const fall = bomb.fallTime || 0.8;
    const t = Math.max(0, Math.min(1, bomb.timeLeft / fall));
    entry.group.position.set(bomb.x, 0, bomb.z);
    entry.canister.position.y = 0.35 + t * 6;
    entry.ring.material.opacity = 0.18 + (1 - t) * 0.3;
  }

  for (const [id, entry] of virusBombMeshes) {
    if (!alive.has(id)) {
      scene.remove(entry.group);
      disposeMesh(entry.group);
      virusBombMeshes.delete(id);
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

  // Boss 在场时镜头缓缓推近一点，制造压迫感；退场后慢慢拉回。
  // 推近量受 Boss 体型约束：Boss 已经是 6 倍大、头顶贴到画面上沿，
  // 推得太近会把它顶出画，所以这里只留很小的位移。
  const wantZoom = bossOnField ? -0.5 : 0;
  camZoom += (wantZoom - camZoom) * Math.min(1, dt * 1.6);

  camera.position.set(camBaseX + sx, camY + sy, camZ + camZoom);
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

/* ----------------------------------------------------------
 * 背景物微动：让画面别呆板
 *   城市窗户一闪一灭、月球地球自转、雨林树冠轻摇、熔岩裂隙呼吸
 * 都是纯视觉的小动作，不影响任何玩法。
 * ---------------------------------------------------------- */

const propAnim = [];   // { kind, obj, phase, base }

function updatePropAnimations(dt) {
  const t = performance.now() * 0.001;
  for (const a of propAnim) {
    switch (a.kind) {
      case 'flicker': {
        // 窗户：大部分时间亮，偶尔灭一下再亮回来
        const f = Math.sin(t * 0.7 + a.phase) * Math.sin(t * 2.3 + a.phase * 1.7);
        a.obj.material.opacity = a.base + (f > 0.86 ? -a.base * 0.8 : 0);
        break;
      }
      case 'spin':
        a.obj.rotation.y += dt * 0.05;
        break;
      case 'sway':
        a.obj.rotation.z = Math.sin(t * 0.8 + a.phase) * 0.018;
        break;
      case 'breathe':
        // 岩浆：亮度一涨一落
        a.obj.material.opacity = a.base + Math.sin(t * 1.3 + a.phase) * 0.22;
        break;
      case 'pulse':
        // 新地图里的发光件（舷窗/反应罐顶/晶体/符文环）：幅度比 breathe 小，
        // 避免一片发光面来回闪得太扎眼
        a.obj.material.opacity = Math.max(
          0,
          Math.min(1, a.base + Math.sin(t * 1.1 + a.phase) * 0.12)
        );
        break;
      default:
        break;
    }
  }
}

/* 某个深度 z 处，画面横向能看见多宽（世界单位半宽）。
 *
 * 摆背景物必须用它：这台相机 45° 俯视、画面 9:16，
 * 每个深度能看见的横向范围差很多（z=0 约 ±11，z=-40 约 ±19.4），
 * 超出就会被左右裁掉，看起来像"没做背景物"。
 *
 * 相机是 lookAt(0,0,0)、位置 (0, camY, camZ)，
 * 所以可视半宽 = 相机到该点的深度 × tanH。 */
function viewHalfXAt(z) {
  if (!camera) return 11;
  const tilt = (CAM.tilt * Math.PI) / 180;
  const tanV = Math.tan((CAM.fov * Math.PI) / 360);
  const tanH = tanV * camera.aspect;
  // 视线方向（从相机指向原点）
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  const fz = -c;
  const fy = -s;
  // 相机在 (0, camY, camZ)，深度 = 点相对相机沿视线方向的分量
  // 深度 = 点相对相机、沿视线方向的投影长度。
  // 视线朝下朝里（fy、fz 都是负），所以 rel 点乘 f 本身就是正值，
  // **不要再取负**——我第一版多写了一个负号，深度变负后被 Math.max(1,…) 钳成 1，
  // 可见半宽算成 1 个单位，结果几乎所有道具都被判"没空间"而跳过。
  const relY = 0 - camY;
  const relZ = z - camZ;
  const depth = relY * fy + relZ * fz;
  return Math.max(6, depth * tanH);
}

/* 侧景物件的内侧边缘必须越过的世界 x。
 * 屏障横到 ±7.6、僵尸通道到 7.6，战场名义半宽 8.0，取 8.6 留 0.6 余量。 */
const ARENA_CLEAR_X = 8.6;

/* 战场纵深：z 在这个范围内的道具会盖住可玩区域。
 * 起点取 -29（Boss 出生点在 -34，已经在线外，不用管）；
 * 终点取 11（玩家站位 9、士兵阵 8.2，再往前一点留余量）。
 * z 全在这条线之后的属于"通道尽头背景"，投影和通道重叠是正常的。 */
const ARENA_CLEAR_Z = [-29, 11];

function keepArenaClear(group) {
  const box = new THREE.Box3();
  for (const child of group.children) {
    box.setFromObject(child);
    if (box.isEmpty()) continue;
    // 完全在战场纵深之外：不挡，跳过
    if (box.max.z < ARENA_CLEAR_Z[0] || box.min.z > ARENA_CLEAR_Z[1]) continue;

    const crossesMid = box.min.x < 0 && box.max.x > 0;
    const height = box.max.y - box.min.y;
    // 只豁免**真正贴地**的薄片：地砖、熔岩纹、水面、地面网格线。
    // 判据是"又薄又低"（厚度 < 0.35 且底面 < 0.15），不是只看厚度。
    // 之前阈值给到 1.2，结果 0.4~1.2 高的矮台、管道、矮石既没被推走、
    // 又实实在在压在中线上（实测 abbey/station/desert 画面正中有 250~440 个
    // 采样点被这些东西盖住），属于漏网。
    if (crossesMid && height < 0.35 && box.min.y < 0.15) continue;

    let push = 0;
    if (box.min.x >= 0) {
      // 纯右侧：让 min.x 抬到 ARENA_CLEAR_X
      if (box.min.x < ARENA_CLEAR_X) push = ARENA_CLEAR_X - box.min.x;
    } else if (box.max.x <= 0) {
      // 纯左侧：让 max.x 压到 -ARENA_CLEAR_X
      if (box.max.x > -ARENA_CLEAR_X) push = -ARENA_CLEAR_X - box.max.x;
    } else {
      // 横跨中线且够高（比如一堵长墙）：推一边还是会挡另一边，
      // 只能让它退到战场后面去，当远景
      child.position.z -= 40;
      continue;
    }

    if (push !== 0) child.position.x += push;
  }
}

function buildProps(mapId = MAP_ID) {
  const group = new THREE.Group();
  const rng = mulberry32(20261101);

  // 新地图（17 张）走自己的构建函数：零件工厂 + 配置组合，
  // 不用在这里堆 17 个 props 函数
  if (isNewMap(mapId) && NEW_MAPS[mapId].build) {
    // 把"某个深度画面能看见多宽"交给地图模块，让它只在可见带里摆道具。
    // 少了这个，道具会摆到画面外——第一版城堡墙就是这样被裁掉的。
    NEW_MAPS[mapId].build(group, rng, propAnim, { viewHalfX: viewHalfXAt });
  } else {
    const builder = {
      city: buildCityProps,
      jungle: buildJungleProps,
      desert: buildDesertProps,
      moon: buildMoonProps,
      snow: buildSnowProps,
      lava: buildLavaProps,
      base: buildBaseProps,
      lab: buildLabProps,
      harbor: buildHarborProps,
    }[mapId] || buildCityProps;

    builder(group, rng);
  }

  /* 近景两侧大件：所有地图（原有 9 张 + 新 17 张）都铺一层。
   *
   * 原有地图的 props 大多摆在中远景（z −20 ~ −44），那里 1 个单位只占几个像素，
   * 二十米高的楼在屏幕上也就一百多像素，看着仍然像"远处几个方块"。
   * 这一层贴近相机（z −10 ~ +8），并且**故意让它被画面左右边缘裁掉一部分**——
   * 只露出半面的墙、只露出屋顶的房子，才像真实场景里的框景。
   *
   * 放这里而不是放进每张图自己的构建函数：26 张图各写一遍会散，
   * 而且原有 9 张图的构建函数是早先写的，不该为了这一层去改它们。 */
  buildFlank(group, { viewHalfX: viewHalfXAt }, rng, mapId);

  // 前景剪影：画面最下缘一条参差不齐的暗色带，纵深立刻出来了。
  // 只放在左右两侧（|x| > 4），中间留空，不然会挡住玩家和士兵。
  const silhouette = {
    city:   { color: 0x0d1118, count: 7 },
    jungle: { color: 0x0a1409, count: 8 },
    desert: { color: 0x2a1d12, count: 7 },
    moon:   { color: 0x1a1c22, count: 8 },
    snow:   { color: 0x5c6672, count: 7 },
    lava:   { color: 0x140806, count: 8 },
    base:   { color: 0x141a20, count: 8 },
    lab:    { color: 0x121a16, count: 7 },
    harbor: { color: 0x101a20, count: 7 },
  }[mapId] || { color: 0x11151b, count: 7 };

  // 新地图的剪影在各自的 build 里处理（每张的暗带色调不同），这里跳过。
  // 注意这里**不能 return**：下面还有 scene.add，提前 return 会让新地图
  // 的背景物只存在于内存里、从来没渲染出来（踩过，表现就是"看不见背景物"）。
  if (!isNewMap(mapId)) {
    const silMat = mat(silhouette.color, { flat: true, rough: 1 });
    for (let i = 0; i < silhouette.count; i++) {
      const side = i % 2 ? 1 : -1;
      const h = 0.7 + rng() * 1.3;
      const w = 0.8 + rng() * 1.8;
      const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.8), silMat);
      /* 位置必须退到战场纵深之外。
       *
       * 原来是 z=16.5~20（比玩家还近、画面最下缘），那个深度的可见半宽只有约 6，
       * 而 x 从 4.2 起 —— 投影到屏幕上正好是画面下方 78%~100% 那一片，
       * 也就是左右两条屏障（绿/红）所在的位置，直接把它们盖住了。
       *
       * 现在放到 z=-30~-34：这个深度可见半宽约 17.5，x 从 8.8 起就完全在
       * 战场投影之外，同时仍在画面内（8.8/17.5 → 屏幕约 75%），
       * 作为通道尽头的两侧暗影，纵深还在，但不再挡任何可玩元素。 */
      const backZ = -30 - rng() * 4;
      block.position.set(
        side * (8.8 + rng() * 3.4),
        h / 2 - 0.15,
        backZ
      );
      block.rotation.y = rng() * Math.PI;
      block.rotation.z = (rng() - 0.5) * 0.12;
      group.add(block);
    }
  }

  /* 兜底：把挡住战场的道具推到战场之外。
   *
   * 为什么要在这一层统一做，而不是让每张地图各自注意：
   * 26 张地图各有自己的摆位代码（原有 9 张是早先写的，新 17 张用 bandX），
   * 它们都只约束了"物件中心"的世界坐标，没有一个知道自己造出来的东西有多宽。
   * 一栋 3.6 宽的房子中心在 9.0 时，内侧边缘只有 7.2，已经压进战场 ——
   * 表现就是用户看到的"中世纪村庄把左边那些绿条红条挡住了"。
   *
   * 这里在道具全部造完之后逐个量包围盒，越线的往外推。
   * 一处收口，26 张图一起受益，也不用去改那 9 个早先写的地图函数。 */
  keepArenaClear(group);

  /* 加进场景 + 返回引用，两件事必须都在这里，一处都不能少：
   *   - 少了 scene.add：道具全在内存里，画面上什么都没有（之前就是这个状态）
   *   - 少了 return：调用方拿不到引用，切图时旧道具删不掉，会一层层叠加
   * 之前两句都缺：新地图分支提前 return 跳过了 scene.add，
   * 原有地图的 return 是缺的，而 scene.add 又在上一轮修 return 时被我一起替换掉了。 */
  scene.add(group);
  return group;
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
      // 窗户会闪：登记一下，每帧改一点透明度
      propAnim.push({ kind: 'flicker', obj: win, phase: rng() * 10, base: 0.55 });
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
      // 近处的树轻轻摇，风的感觉
      propAnim.push({ kind: 'sway', obj: t, phase: rng() * 10, base: 0 });
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
    new THREE.SphereGeometry(3.6, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0x3f78b8, fog: false })
  );
  earth.position.set(-11.5, 0.6, -40);
  g.add(earth);
  propAnim.push({ kind: 'spin', obj: earth, phase: 0, base: 0 });

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

/* 军事基地：集装箱堆、铁丝网、沙袋、探照灯塔、雷达天线
 * 战场被军方封锁过：锈蚀铁皮地面 + 冷钢色调，和其他五张图完全不是一路。 */
function buildBaseProps(g, rng) {
  const steel = 0x4c545c;
  const rust = 0x7a4a32;
  const sand = 0x8a7d5e;

  // 远景：仓库与集装箱墙，挡住地平线
  for (let i = 0; i < 8; i++) {
    const w = 6 + rng() * 8;
    const h = 4 + rng() * 6;
    const b = boxMesh(w, h, 6 + rng() * 4, rng() > 0.5 ? steel : rust, { rough: 1, flat: true });
    b.position.set(-36 + i * 10 + rng() * 2, h / 2, -35 - rng() * 4);
    g.add(b);
  }

  // 集装箱：几个不同颜色的大箱子，错落堆放
  const boxColors = [0x2f5f6b, 0x6b3f2f, 0x3f5f2f, 0x5f5f3f];
  for (let i = 0; i < 10; i++) {
    const w = 3.2;
    const h = 2.4;
    const d = 6.4;
    const c = boxMesh(w, h, d, boxColors[i % boxColors.length], { rough: 1, flat: true });
    const side = i % 2 ? 1 : -1;
    c.position.set(side * (10 + rng() * 7), h / 2, -24 + rng() * 34);
    c.rotation.y = (rng() - 0.5) * 0.3;
    g.add(c);
  }

  // 铁丝网：两排柱子加横杆
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const post = boxMesh(0.22, 2.6, 0.22, steel, { rough: 1, flat: true });
      post.position.set(side * (13 + rng() * 2), 1.3, -26 + i * 6 + rng() * 2);
      g.add(post);
    }
    for (let k = 0; k < 3; k++) {
      const wire = boxMesh(0.1, 0.1, 40, 0x6d737a, { rough: 1, flat: true });
      wire.position.set(side * (13.6 + rng() * 1.6), 0.8 + k * 0.9, -12);
      g.add(wire);
    }
  }

  // 沙袋墙：矮矮一排，压在通道外侧
  for (let i = 0; i < 12; i++) {
    const bag = boxMesh(1.3, 0.55, 0.8, sand, { rough: 1, flat: true });
    const side = i % 2 ? 1 : -1;
    bag.position.set(side * (9.2 + rng() * 2.5), 0.28, -20 + i * 3.4 + rng() * 1.5);
    bag.rotation.y = (rng() - 0.5) * 0.2;
    g.add(bag);
  }

  // 探照灯塔：细杆加一个亮灯头，夜里是场景里最亮的点
  for (let i = 0; i < 3; i++) {
    const side = i % 2 ? 1 : -1;
    const poleH = 6 + rng() * 2;
    const pole = boxMesh(0.3, poleH, 0.3, steel, { rough: 1, flat: true });
    pole.position.set(side * (15 + rng() * 3), poleH / 2, -22 + i * 12 + rng() * 3);
    g.add(pole);

    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff0c0, fog: true })
    );
    lamp.position.set(pole.position.x, poleH + 0.3, pole.position.z);
    g.add(lamp);
    // 灯头会一闪一闪
    propAnim.push({ kind: 'flicker', obj: lamp, phase: rng() * 10, base: 1 });
  }

  // 雷达天线：斜着的圆盘
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42),
    new THREE.MeshStandardMaterial({ color: 0xb9c2c9, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide })
  );
  dish.position.set(-19, 5.5, -33);
  dish.rotation.set(-0.9, 0.5, 0.2);
  g.add(dish);
  const mast = boxMesh(0.35, 5, 0.35, steel, { rough: 1, flat: true });
  mast.position.set(-19, 2.5, -33);
  g.add(mast);

  // 前景：翻倒的油桶和破板
  for (let i = 0; i < 8; i++) {
    const r = 0.4 + rng() * 0.5;
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, r * 2, 12),
      mat(rng() > 0.5 ? rust : 0x3f5a44, { rough: 0.85 })
    );
    const side = i % 2 ? 1 : -1;
    drum.position.set(side * (4.5 + rng() * 7), r, 15.5 + rng() * 3);
    drum.rotation.set(rng() > 0.6 ? Math.PI / 2 : 0, rng() * Math.PI, 0);
    g.add(drum);
  }
}

/* 废弃医院 / 生化实验室：走廊墙、病床、器械架、垂落的管道、闪烁的荧光灯
 * 冷白加病态绿，和其他七张图都不一样。 */
/* 港口码头：海面、栈桥、集装箱吊车、远处货轮、系缆桩
 * 靠海的地方风大光冷，僵尸是海盗（地图覆盖表里配好了）。 */
function buildHarborProps(g, rng) {
  const steel = 0x53606a;
  const rust = 0x7d4f33;
  const wood = 0x6b5638;

  // 远处的海：一片大水面，把地平线压住
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_W * 1.6, 120),
    new THREE.MeshStandardMaterial({
      color: 0x1d4a63,
      emissive: 0x0d2c40,
      emissiveIntensity: 0.9,
      roughness: 0.12,
      metalness: 0.5,
    })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0, -0.3, -58);
  g.add(sea);

  // 远景：龙门吊和仓库剪影
  for (let i = 0; i < 6; i++) {
    const w = 4 + rng() * 3;
    const h = 10 + rng() * 8;
    const leg1 = boxMesh(1.1, h, 1.1, steel, { rough: 1, flat: true });
    const leg2 = boxMesh(1.1, h, 1.1, steel, { rough: 1, flat: true });
    const x = -40 + i * 15 + rng() * 3;
    leg1.position.set(x, h / 2, -38);
    leg2.position.set(x + w + 3, h / 2, -38);
    const top = boxMesh(w + 4, 1.2, 1.6, rust, { rough: 1, flat: true });
    top.position.set(x + (w + 3) / 2, h, -38);
    g.add(leg1, leg2, top);
  }

  // 集装箱堆：两层三列，颜色不同
  const boxColors = [0x2f5f6b, 0x6b3f2f, 0x3f5f2f, 0x5a5f3f, 0x6b5f2f];
  for (let i = 0; i < 9; i++) {
    const c = boxMesh(3.2, 2.4, 6.4, boxColors[i % boxColors.length], { rough: 1, flat: true });
    const side = i % 2 ? 1 : -1;
    c.position.set(side * (11 + rng() * 5), 1.2 + (rng() > 0.7 ? 2.4 : 0), -26 + rng() * 30);
    c.rotation.y = (rng() - 0.5) * 0.25;
    g.add(c);
  }

  // 栈桥：木板的桥从两侧伸向海面
  for (const side of [-1, 1]) {
    const deck = boxMesh(5, 0.3, 34, wood, { rough: 0.95, flat: true });
    deck.position.set(side * 15, 0.12, -36);
    g.add(deck);
    for (let i = 0; i < 8; i++) {
      const pile = boxMesh(0.4, 2.4, 0.4, wood, { rough: 0.95, flat: true });
      pile.position.set(side * (13 + rng() * 4), -1.0, -20 - i * 5);
      g.add(pile);
    }
  }

  // 系缆桩和缆绳
  for (let i = 0; i < 5; i++) {
    const side = i % 2 ? 1 : -1;
    const bollard = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.42, 0.9, 10),
      mat(steel, { rough: 0.8, flat: true })
    );
    bollard.position.set(side * (8.6 + rng() * 1.6), 0.45, -18 + i * 7 + rng() * 2);
    g.add(bollard);
  }

  // 远处的货轮：一条大船的剪影
  const hull = boxMesh(16, 3.2, 5, 0x2a3038, { rough: 1, flat: true });
  hull.position.set(-15, 0.5, -52);
  const cabin = boxMesh(4, 3, 3.4, 0x3a444e, { rough: 1, flat: true });
  cabin.position.set(-19, 3.2, -52);
  const mast = boxMesh(0.4, 6, 0.4, 0x4a545e, { rough: 1, flat: true });
  mast.position.set(-18, 7.2, -52);
  g.add(hull, cabin, mast);

  // 桅灯：夜里港口的标志性一点光
  const shipLamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffe9b8, fog: true })
  );
  shipLamp.position.set(-18, 10.2, -52);
  g.add(shipLamp);
  propAnim.push({ kind: 'flicker', obj: shipLamp, phase: 3.1, base: 1 });

  // 岸灯
  for (let i = 0; i < 3; i++) {
    const side = i % 2 ? 1 : -1;
    const poleH = 5 + rng() * 1.5;
    const pole = boxMesh(0.22, poleH, 0.22, steel, { rough: 1, flat: true });
    pole.position.set(side * (13 + rng() * 3), poleH / 2, -20 + i * 13 + rng() * 3);
    g.add(pole);
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe6b0, fog: true })
    );
    lamp.position.set(pole.position.x, poleH + 0.2, pole.position.z);
    g.add(lamp);
    propAnim.push({ kind: 'flicker', obj: lamp, phase: rng() * 10, base: 1 });
  }

  // 前景：缆绳盘和油桶
  for (let i = 0; i < 7; i++) {
    const side = i % 2 ? 1 : -1;
    const coil = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.16, 8, 14),
      mat(0x8a7a5e, { rough: 0.95, flat: true })
    );
    coil.rotation.x = -Math.PI / 2;
    coil.position.set(side * (4.8 + rng() * 6), 0.16, 15.5 + rng() * 3);
    g.add(coil);
  }
}

function buildLabProps(g, rng) {
  const wall = 0xc8d4cc;
  const metal = 0x9aa8a2;
  const rust = 0x6d5a3c;

  // 远景：走廊两侧的墙，压低一点形成"走廊"的观感
  for (const side of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const h = 3.4 + rng() * 1.6;
      const w = 5 + rng() * 3;
      const b = boxMesh(w, h, 3 + rng() * 2, wall, { rough: 1, flat: true });
      b.position.set(side * (13 + rng() * 3), h / 2, -32 + i * 8 + rng() * 2);
      g.add(b);
    }
  }

  // 病床：床架加床垫，倒着的也有
  for (let i = 0; i < 8; i++) {
    const side = i % 2 ? 1 : -1;
    const g2 = new THREE.Group();
    const frame = boxMesh(1.1, 0.16, 2.3, metal, { rough: 0.6, metalness: 0.3, flat: true });
    frame.position.y = 0.62;
    const mattress = boxMesh(1.0, 0.2, 2.1, 0xd8d2c4, { rough: 0.95, flat: true });
    mattress.position.y = 0.78;
    g2.add(frame, mattress);
    for (const [lx, lz] of [[-0.45, -1.0], [0.45, -1.0], [-0.45, 1.0], [0.45, 1.0]]) {
      const leg = boxMesh(0.1, 0.6, 0.1, metal, { rough: 0.6, flat: true });
      leg.position.set(lx, 0.3, lz);
      g2.add(leg);
    }
    g2.position.set(side * (9.5 + rng() * 2.5), 0, -24 + rng() * 32);
    g2.rotation.y = (rng() - 0.5) * 0.5;
    if (rng() > 0.7) g2.rotation.z = Math.PI / 2;   // 有的翻倒了
    g.add(g2);
  }

  // 垂落的管道：横着挂在墙边
  for (let i = 0; i < 7; i++) {
    const side = i % 2 ? 1 : -1;
    const r = 0.28 + rng() * 0.2;
    const pipe = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 5 + rng() * 6, 10),
      mat(rng() > 0.6 ? rust : metal, { rough: 0.7, metalness: 0.35, flat: true })
    );
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(side * (11.5 + rng() * 2), 2.2 + rng() * 1.4, -26 + i * 7 + rng() * 2);
    g.add(pipe);
  }

  // 荧光灯：横在天上，忽明忽暗
  for (let i = 0; i < 5; i++) {
    const tube = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.14, 0.34),
      new THREE.MeshBasicMaterial({ color: 0xdfffef, fog: true })
    );
    tube.position.set((rng() - 0.5) * 6, 3.6 + rng() * 0.8, -26 + i * 12 + rng() * 3);
    g.add(tube);
    propAnim.push({ kind: 'flicker', obj: tube, phase: rng() * 10, base: 1 });
  }

  // 器械推车和碎片
  for (let i = 0; i < 8; i++) {
    const side = i % 2 ? 1 : -1;
    const cart = boxMesh(1.2, 0.9, 0.7, metal, { rough: 0.6, metalness: 0.35, flat: true });
    cart.position.set(side * (8.8 + rng() * 3), 0.45, -22 + rng() * 30);
    cart.rotation.y = rng() * Math.PI;
    g.add(cart);
  }

  // 前景：碎瓷砖和倒下的轮椅
  for (let i = 0; i < 7; i++) {
    const side = i % 2 ? 1 : -1;
    const shard = boxMesh(0.6 + rng() * 0.7, 0.12, 0.5 + rng() * 0.6, 0xcdd6cc, { rough: 0.8, flat: true });
    shard.position.set(side * (4.5 + rng() * 7), 0.06, 15.5 + rng() * 3);
    shard.rotation.y = rng() * Math.PI;
    g.add(shard);
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
    // 岩浆会呼吸：亮度一涨一落
    propAnim.push({ kind: 'breathe', obj: crack, phase: rng() * 10, base: 0.75 });
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
  // 11 自爆=橙红、12 护甲=金属灰，按 type 取，取不到回落到普通
  const colors = [0x6f8f6a, 0x8f5a4a, 0x9aa04a, 0xb8bcc4, 0x647f68];
  const COLOR_BY_TYPE = { 10: 0x6b6068, 11: 0xd85a2a, 12: 0x8a95a4, 13: 0x7ac850, 14: 0xa050cc };
  const look = ZOMBIE_LOOKS[type] || ZOMBIE_LOOKS[0];

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 1.15, 0.7),
    new THREE.MeshStandardMaterial({
      // 色块版也跟地图氛围走，和模型版观感一致
      color: tintHex(COLOR_BY_TYPE[type] ?? colors[type % colors.length], MAP_TINT),
      roughness: 0.85,
    })
  );
  // 体型也跟着类型走，色块版和模型版观感一致
  mesh.scale.setScalar(look.scale);
  mesh.material.emissive.setHex(tintHex(look.color ?? 0xffffff, MAP_TINT)).multiplyScalar(0.055 + (look.emissive || 0));

  // 脚下的影子跟着僵尸一起动
  const shadow = makeBlobShadow(0.45);
  shadow.position.y = -0.55;
  mesh.add(shadow);

  return mesh;
}

/* ----------------------------------------------------------
 * 血条：给精英和 Boss 用
 * 自动检测僵尸对象上的 maxHp（甲加了字段就有血条，没加就按满血显示）
 * ---------------------------------------------------------- */

let hpBarTex = null;

function getHpBarTexture() {
  if (hpBarTex) return hpBarTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 8);
  hpBarTex = new THREE.CanvasTexture(c);
  hpBarTex.needsUpdate = true;
  return hpBarTex;
}

/* ----------------------------------------------------------
 * 路障：前排一段可破坏的墙 + 下方血条 + 冷却倒计时
 * ---------------------------------------------------------- */
/* ----------------------------------------------------------
 * 槽位地基：五个槽位的固定位置
 * 工事就是路障本身，这里放另外四个
 * ---------------------------------------------------------- */
const SLOT_DEFS = [
  { id: 'siege', name: '攻城', x: 4.5, z: 15, color: 0xffa64d },
  { id: 'support', name: '支援', x: -4.5, z: 15, color: 0x5adf7a },
  { id: 'command', name: '指挥', x: 0, z: 15, color: 0x6fa8ff },
  { id: 'closeDefense', name: '近防', x: 5.5, z: 4.5, color: 0xff6a4a },
  { id: 'summon', name: '召唤', x: -5.5, z: 4.5, color: 0x9c6bff },
];

const slotVisuals = new Map();

// 调试出口：和 game.js 的 window.__state 一套风格。
// 槽位可见性出问题时只能靠它查（模型是在 renderer 内部建的，控制台拿不到）
if (typeof window !== 'undefined') window.__slotVisuals = slotVisuals;

// 僵尸渲染表：排查"这个僵尸是模型还是色块""到底有没有出拳动作"时只能靠它
if (typeof window !== 'undefined') window.__zombieVisuals = zombieMeshes;

function initSlots() {
  for (const s of SLOT_DEFS) {
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 0.95, 0.08, 20),
      new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.85 })
    );
    pad.position.set(s.x, 0.04, s.z);
    scene.add(pad);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.88, 24),
      new THREE.MeshBasicMaterial({
        color: s.color,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.x, 0.09, s.z);
    scene.add(ring);

    // 正式模型按「时代 + 等级」现造，时代或等级变了就整个重建
    const era = getCurrentEraIndex();
    const level = 1;
    const structure = buildSlotStructure(s.id, era, level);
    structure.position.set(s.x, 0, s.z);
    scene.add(structure);

    // 地基上的 1-5 级小点
    const dots = buildLevelDots(0, s.color);
    dots.position.set(s.x, 0, s.z);
    scene.add(dots);

    slotVisuals.set(s.id, {
      pad,
      ring,
      structure,
      dots,
      x: s.x,
      z: s.z,
      color: s.color,
      era,
      level,
      spin: structure.userData.spinParts || [],
    });
  }
}

/* ----------------------------------------------------------
 * 槽位 Fire 动画（对应美术需求 P1「每个槽位至少 Idle 和 Fire 两条动画」）
 *
 * 没有骨骼模型，所以用"整体后坐 + 炮口闪光"两件事表达开火：
 *   1. 后坐：整个槽位沿远离目标的方向弹一下，0.22 秒内回位（阻尼衰减）
 *   2. 炮口闪光：在朝向目标的一侧生成一个快速膨胀的亮球 + 一圈冲击
 * 这两件事加起来，在俯视小尺寸下已经够读成"它打了一发"。
 *
 * 触发源是现有的 slotStrike 事件（kind = siege / closeDefense / tank），
 * 不需要甲新增接口。
 * ---------------------------------------------------------- */
function triggerSlotFire(slotId, d) {
  const v = slotVisuals.get(slotId);
  if (!v || !v.structure || !v.structure.visible) return;

  // 后坐：记下开始时间和指向目标的方向，syncSlots 里逐帧衰减
  v.recoil = 1;
  v.recoilDir = Math.atan2(v.x - (d.x || 0), v.z - (d.z || 0));

  // 炮口位置：槽位朝目标那一侧的边缘
  const dirX = Math.sign((d.x || 0) - v.x) || 0;
  const dirZ = Math.sign((d.z || 0) - v.z) || 0;
  const mx = v.x + dirX * 0.5;
  const mz = v.z + dirZ * 0.5;
  const color = d.color || 0xffa64d;

  // 炮口闪光：一个亮球从 0.15 涨到 0.5 再消失
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 8),
    new THREE.MeshBasicMaterial({
      color: 0xfff0c0, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  flash.position.set(mx, 0.62, mz);
  scene.add(flash);
  effects.push({
    mesh: flash, life: 0, maxLife: 0.16,
    type: 'fireball', baseScale: 0.55, baseY: 0.62,
  });

  spawnRing(mx, mz, color, 0.24);

  // 少量火星朝目标方向喷出
  spawnBurst(mx, 0.6, mz, color, 6, {
    speed: 2.4, up: 1.4, spread: 0.18, life: 0.3, gravity: -6,
  });
}

function syncSlots(state, dt) {
  const era = getCurrentEraIndex();
  const levels = (state && state.slotLevels) || {};
  const t = performance.now() * 0.001;

  for (const [id, v] of slotVisuals) {
    const on = !!(state.slots && state.slots[id]);
    const level = Math.max(0, Math.min(5, levels[id] | 0));

    // 时代或等级变了就重建：模型是按这两个参数造出来的，
    // 不重建就只能靠改材质色，附件和体量变不了
    if (v.era !== era || v.level !== Math.max(1, level)) {
      scene.remove(v.structure);
      disposeSlotStructure(v.structure);
      const rebuilt = buildSlotStructure(id, era, Math.max(1, level));
      rebuilt.position.set(v.x, 0, v.z);
      scene.add(rebuilt);
      v.structure = rebuilt;
      v.era = era;
      v.level = Math.max(1, level);
      v.spin = rebuilt.userData.spinParts || [];
    }

    // 六个槽位一视同仁：地基 / 光环 / 等级点永远在，只有模型按解锁状态出现。
    // 召唤槽以前有一条「era < 3 就连地基一起藏」的特殊规则，结果那个位置上
    // 什么都没有，看起来像模型丢了。五个槽位都是抽卡解锁的，未解锁时本来
    // 就该留一个空地基告诉玩家「这里还能开一个」，召唤不该例外。
    v.pad.visible = true;
    v.ring.visible = true;
    v.dots.visible = true;
    v.structure.visible = on;
    v.ring.material.opacity = on ? 0.8 : 0.16;

    // 等级点：只显示已解锁的，未解锁的保持很淡的底点
    v.dots.children.forEach((dot, i) => {
      dot.material.opacity = i < level ? 1 : 0.14;
    });

    // 后坐：沿着开火反方向弹一下，然后阻尼回位。
    // 用 structure.position 做位移，不动 x/z 基准（那是地基位置，重建模型要用）
    if (v.recoil > 0) {
      v.recoil = Math.max(0, v.recoil - dt * 4.5);
      const push = Math.sin(v.recoil * Math.PI) * 0.14;
      v.structure.position.x = v.x + Math.cos(v.recoilDir || 0) * push;
      v.structure.position.z = v.z + Math.sin(v.recoilDir || 0) * push;
    } else if (v.structure.position.x !== v.x || v.structure.position.z !== v.z) {
      // 回位后精确归零，否则会残留亚像素偏移，看着像槽位慢慢漂走了
      v.structure.position.x = v.x;
      v.structure.position.z = v.z;
    }

    // 满级 / 星际以上的旋转件转起来（炮塔缓转、能量环转、虫巢脉动）
    if (v.structure.visible) {
      for (let i = 0; i < v.spin.length; i++) {
        v.spin[i].rotation.z = t * (0.6 + i * 0.15);
      }
      // 5 级加一点呼吸，让"满级"不用看数字也认得出来
      if (v.level >= 5 && v.structure.userData.mats) {
        const gm = v.structure.userData.mats.glowSoft;
        if (gm) gm.opacity = 0.4 + Math.sin(t * 2.4) * 0.16;
      }
    }
  }
}

/* ----------------------------------------------------------
 * 补给箱（点子池「补给箱」）
 *
 * 玩法层管刷新、下落、命中、奖励；这里只负责画：
 *   木箱 + 金色包角 + 顶上一面小旗，落地砸起一圈灰，打碎炸成木屑。
 * 箱子在屏幕上只有十几像素，所以轮廓要做粗——深色底 + 亮金包角，
 * 比精细木纹更容易在手机屏上一眼认出来。
 * ---------------------------------------------------------- */
const crateVisuals = new Map();
let crateGeos = null;

function getCrateGeo() {
  if (crateGeos) return crateGeos;
  crateGeos = {
    body: new THREE.BoxGeometry(0.72, 0.62, 0.72),
    corner: new THREE.BoxGeometry(0.08, 0.66, 0.08),
    band: new THREE.BoxGeometry(0.78, 0.07, 0.78),
    flag: new THREE.PlaneGeometry(0.19, 0.13),
  };
  return crateGeos;
}

function makeCrateMesh() {
  const g = new THREE.Group();
  const geo = getCrateGeo();

  const woodMat = new THREE.MeshStandardMaterial({
    color: 0xa8793e, roughness: 0.85, metalness: 0.05,
    emissive: 0x3a2408, emissiveIntensity: 0.5,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xe8c060, roughness: 0.4, metalness: 0.7,
    emissive: 0x8a6008, emissiveIntensity: 0.6,
  });

  const body = new THREE.Mesh(geo.body, woodMat);
  body.position.y = 0.31;
  g.add(body);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const corner = new THREE.Mesh(geo.corner, goldMat);
      corner.position.set(sx * 0.33, 0.31, sz * 0.33);
      g.add(corner);
    }
  }
  const band = new THREE.Mesh(geo.band, goldMat);
  band.position.y = 0.31;
  g.add(band);

  // 小旗用金色而不是亮绿：亮绿在绿地面和绿色 HUD 里容易糊成一片，
  // 金色和包角同色系，箱子整体读起来就是一个"发光的小金块"
  const flag = new THREE.Mesh(
    geo.flag,
    new THREE.MeshBasicMaterial({
      color: 0xffd45a, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    })
  );
  flag.position.set(0.12, 0.82, 0);
  g.add(flag);

  return { group: g, flag, woodMat, goldMat };
}

function syncCrates(state) {
  if (!scene) return;
  const list = state.crates || [];
  const alive = new Set();

  for (const c of list) {
    alive.add(c.id);
    let entry = crateVisuals.get(c.id);
    if (!entry) {
      entry = makeCrateMesh();
      entry.phase = Math.random() * Math.PI * 2;
      scene.add(entry.group);
      crateVisuals.set(c.id, entry);
    }
    entry.group.position.set(c.x, c.y || 0, c.z);

    // 落地前翻滚，落地后停住；旗子一直轻轻晃，方便一眼找到
    if (!c.landed) {
      entry.group.rotation.y += 0.14;
      entry.group.rotation.z += 0.04;
    } else {
      entry.group.rotation.z *= 0.9;
    }
    entry.flag.rotation.y = Math.sin(performance.now() * 0.004 + entry.phase) * 0.5;
  }

  // 被打碎的箱子：把场上多余的模型拆掉（材质是每个箱子独立的，要释放）
  for (const [id, entry] of crateVisuals) {
    if (alive.has(id)) continue;
    scene.remove(entry.group);
    entry.woodMat.dispose();
    entry.goldMat.dispose();
    entry.flag.material.dispose();
    crateVisuals.delete(id);
  }
}

function clearCrates() {
  for (const [, entry] of crateVisuals) {
    scene.remove(entry.group);
    entry.woodMat.dispose();
    entry.goldMat.dispose();
    entry.flag.material.dispose();
  }
  crateVisuals.clear();
}

/* ----------------------------------------------------------
 * 锁链路障（点子池「锁链路障」）
 *
 * 玩法层（game-chainbarricade.js）算判定和绕行，这里只负责画。
 * 形状：两根铁桩 + 中间一条下垂的铁链 + 一串小环，一眼能读出"这儿过不去"。
 * 铁链做下垂是必须的：一条笔直的横杠会读成"栏杆"，玩家会以为能撞开。
 * ---------------------------------------------------------- */
const chainVisuals = new Map();
let chainGeos = null;
let chainMats = null;

function ensureChainAssets() {
  if (chainGeos) return;
  chainGeos = {
    post: new THREE.CylinderGeometry(0.09, 0.11, 1.15, 7),
    link: new THREE.TorusGeometry(0.1, 0.028, 5, 10),
    shadow: new THREE.PlaneGeometry(1, 0.5),
  };
  chainMats = {
    iron: new THREE.MeshStandardMaterial({
      color: 0x5a6068, roughness: 0.55, metalness: 0.75,
    }),
    link: new THREE.MeshStandardMaterial({
      color: 0x7a828c, roughness: 0.45, metalness: 0.85,
      emissive: 0x101418, emissiveIntensity: 0.6,
    }),
  };
}

function makeChainMesh(width) {
  ensureChainAssets();
  const g = new THREE.Group();
  const half = width / 2;

  // 两端铁桩
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(chainGeos.post, chainMats.iron);
    post.position.set(sx * half, 0.575, 0);
    g.add(post);
  }

  // 中间一串环，按宽度铺，越靠中间越往下垂
  const n = Math.max(3, Math.round(width / 0.26));
  const links = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;           // 0~1
    const x = -half + t * width;
    // 抛物线下垂：两头贴住铁桩顶，中间最低
    const sag = Math.sin(t * Math.PI) * 0.22;
    const link = new THREE.Mesh(chainGeos.link, chainMats.link);
    link.position.set(x, 0.95 - sag, 0);
    link.rotation.y = i % 2 ? Math.PI / 2 : 0;  // 环交替转向，读起来才像链条
    link.rotation.x = Math.PI / 2;
    g.add(link);
    links.push(link);
  }

  return { group: g, links };
}

function syncChains(state) {
  if (!scene) return;
  const list = state.chains || [];
  const alive = new Set();

  for (const c of list) {
    alive.add(c.id);
    let entry = chainVisuals.get(c.id);
    // 宽度变了（升级/改数值）就重建，比每帧改几何体省事
    if (entry && entry.width !== c.width) {
      scene.remove(entry.group);
      chainVisuals.delete(c.id);
      entry = null;
    }
    if (!entry) {
      entry = makeChainMesh(c.width);
      entry.width = c.width;
      scene.add(entry.group);
      chainVisuals.set(c.id, entry);
    }
    entry.group.position.set(c.x, 0, c.z);

    // 铁链轻微晃动：静止的铁链看着像贴图，晃一下才有重量感
    const t = performance.now() * 0.0018;
    for (let i = 0; i < entry.links.length; i++) {
      entry.links[i].rotation.z = Math.sin(t + i * 0.6) * 0.09;
    }
  }

  // 几何体和材质全链共享，只摘 mesh
  for (const [id, entry] of chainVisuals) {
    if (alive.has(id)) continue;
    scene.remove(entry.group);
    chainVisuals.delete(id);
  }
}

/* ----------------------------------------------------------
 * 地面坑洞（点子池「地面塌陷」）
 *
 * 难点是「怎么让俯视画面里的一个圆看起来是个洞，而不是一块黑斑」：
 *   1. 洞底要接近纯黑（比任何阴影都深），否则读成污渍
 *   2. 洞沿要有一圈亮的碎裂土层，光从上方打下来，近沿比远沿更亮
 *   3. 洞沿外侧再补一圈很淡的塌陷阴影，把洞「压」进地面
 * 三层叠起来才有下陷感。只画一层黑圆是最常见的失败做法。
 * ---------------------------------------------------------- */
const pitVisuals = new Map();
let pitTex = null;
let pitGeo = null;

function ensurePitTex() {
  if (pitTex) return pitTex;

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  // 洞外一圈塌陷阴影：很淡，作用是把洞压进地面
  const outer = ctx.createRadialGradient(c, c, size * 0.36, c, c, size * 0.5);
  outer.addColorStop(0, 'rgba(58,46,34,0.55)');
  outer.addColorStop(1, 'rgba(58,46,34,0)');
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.5, 0, Math.PI * 2);
  ctx.fill();

  // 洞沿：亮一点的碎裂土层，做成不规则边
  ctx.beginPath();
  const segs = 26;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const jag = 0.40 + Math.sin(a * 5.3) * 0.018 + Math.sin(a * 11.7) * 0.012;
    const r = size * jag;
    const x = c + Math.cos(a) * r;
    const y = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(122,100,72,0.9)';
  ctx.fill();

  // 洞内：接近纯黑，往下渐变更深
  const inner = ctx.createRadialGradient(c, c * 0.94, size * 0.02, c, c, size * 0.40);
  inner.addColorStop(0, 'rgba(4,3,2,1)');
  inner.addColorStop(0.62, 'rgba(10,7,5,0.98)');
  inner.addColorStop(1, 'rgba(26,18,12,0.94)');
  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const jag = 0.355 + Math.sin(a * 7.1 + 1.4) * 0.014;
    const r = size * jag;
    const x = c + Math.cos(a) * r;
    const y = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = inner;
  ctx.fill();

  // 从洞沿往外的放射裂纹
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + Math.random() * 0.2;
    const r0 = size * 0.41;
    const r1 = size * (0.45 + Math.random() * 0.045);
    ctx.strokeStyle = `rgba(22,16,11,${0.45 + Math.random() * 0.3})`;
    ctx.lineWidth = size * (0.008 + Math.random() * 0.012);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    ctx.stroke();
  }

  pitTex = new THREE.CanvasTexture(canvas);
  pitTex.colorSpace = THREE.SRGBColorSpace;
  return pitTex;
}

function syncPits(state) {
  if (!scene) return;
  const list = state.pits || [];
  const alive = new Set();

  if (!pitGeo) pitGeo = new THREE.PlaneGeometry(2, 2);

  for (const p of list) {
    alive.add(p.id);
    let mesh = pitVisuals.get(p.id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        pitGeo,
        new THREE.MeshBasicMaterial({
          map: ensurePitTex(),
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -6,
          polygonOffsetUnits: -6,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = Math.random() * Math.PI * 2;
      mesh.renderOrder = 2;
      scene.add(mesh);
      pitVisuals.set(p.id, mesh);
    }
    mesh.position.set(p.x, 0.035, p.z);
    // 平面几何体是 2×2，半径 r 的坑要缩放到 2r
    mesh.scale.setScalar(p.r);

    // 最后 3 秒慢慢回填：淡出比"啪一下消失"自然
    const left = (p.life != null && p.maxLife) ? p.maxLife - p.life : 99;
    mesh.material.opacity = left < 3 ? Math.max(0, left / 3) : 1;
  }

  for (const [id, mesh] of pitVisuals) {
    if (alive.has(id)) continue;
    scene.remove(mesh);
    mesh.material.dispose();
    pitVisuals.delete(id);
  }
}

/* ----------------------------------------------------------
 * 黑洞：持续 1.2 秒的漩涡，不是一帧爆炸
 * 盘面吸光、外圈紫环旋转，时长快结束时缩小，读起来像"合拢"
 * ---------------------------------------------------------- */
function makeBlackHoleMesh() {
  const group = new THREE.Group();

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 40),
    new THREE.MeshBasicMaterial({
      color: 0x030208,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.055;
  group.add(disc);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.05, 1.4, 48),
    new THREE.MeshBasicMaterial({
      color: 0x8a5cff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);

  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0.26, 0.46, 32),
    new THREE.MeshBasicMaterial({
      color: 0xc9a6ff,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.065;
  group.add(inner);

  group.userData.ring = ring;
  group.userData.inner = inner;
  return group;
}

function syncBlackHoles(state, dt) {
  if (!scene) return;
  const alive = new Set();

  for (const h of state.blackHoles || []) {
    alive.add(h.id);
    let mesh = blackHoleMeshes.get(h.id);
    if (!mesh) {
      mesh = makeBlackHoleMesh();
      scene.add(mesh);
      blackHoleMeshes.set(h.id, mesh);
    }

    mesh.position.set(h.x, 0, h.z);
    const left = Math.max(0, Math.min(1, h.timeLeft / h.duration));
    const pulse = 1 + Math.sin(performance.now() * 0.012) * 0.04;
    // 最后 0.25 秒缩小，视觉上「合拢」再结算
    const close = left < 0.2 ? 0.65 + (left / 0.2) * 0.35 : 1;
    mesh.scale.setScalar(pulse * close);
    mesh.userData.ring.rotation.z += dt * 3.2;
    mesh.userData.inner.rotation.z -= dt * 5.0;
    mesh.userData.ring.material.opacity = 0.35 + left * 0.3;
    mesh.userData.inner.material.opacity = 0.4 + left * 0.35;
  }

  for (const [id, mesh] of blackHoleMeshes) {
    if (alive.has(id)) continue;
    scene.remove(mesh);
    disposeMesh(mesh);
    blackHoleMeshes.delete(id);
  }
}

/* ----------------------------------------------------------
 * 武器箱（点子池「掉落拾取」）
 *
 * 必须和补给箱一眼分开：补给箱是木色 + 金角（要打碎），
 * 武器箱做成金属箱 + 武器色发光带 + 头顶一圈旋转光环。
 * 玩家在混战里靠"发光 + 转圈"这两个动态特征就能认出来。
 * ---------------------------------------------------------- */
const pickupVisuals = new Map();
let pickupGeo = null;

function ensurePickupGeo() {
  if (pickupGeo) return;
  pickupGeo = {
    body: new THREE.BoxGeometry(0.62, 0.34, 0.62),
    lid: new THREE.BoxGeometry(0.66, 0.07, 0.66),
    ring: new THREE.TorusGeometry(0.46, 0.035, 6, 20),
    bar: new THREE.BoxGeometry(0.5, 0.05, 0.9),
  };
}

function makePickupMesh(tint) {
  ensurePickupGeo();
  const g = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x3f4650, roughness: 0.5, metalness: 0.65,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: tint,
    emissive: tint,
    emissiveIntensity: 1.4,
    roughness: 0.35,
    metalness: 0.3,
  });
  const ringMat = new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.75,
  });

  const body = new THREE.Mesh(pickupGeo.body, bodyMat);
  body.position.y = 0.17;
  g.add(body);

  // 箱盖和一条发光带：发光带是"这是什么武器"的颜色标识
  const lid = new THREE.Mesh(pickupGeo.lid, bodyMat);
  lid.position.y = 0.37;
  g.add(lid);

  const bar = new THREE.Mesh(pickupGeo.bar, accentMat);
  bar.position.y = 0.25;
  g.add(bar);

  // 头顶光环，慢慢转
  const ring = new THREE.Mesh(pickupGeo.ring, ringMat);
  ring.position.y = 0.72;
  ring.rotation.x = Math.PI / 2;
  g.add(ring);

  return { group: g, ring, bodyMat, accentMat, ringMat, tint };
}

function syncPickups(state) {
  if (!scene) return;
  const list = state.pickups || [];
  const alive = new Set();

  for (const b of list) {
    alive.add(b.id);
    let entry = pickupVisuals.get(b.id);
    if (!entry) {
      const tint = (b.weapon && b.weapon.tint) || 0xffd45a;
      entry = makePickupMesh(tint);
      entry.phase = Math.random() * Math.PI * 2;
      scene.add(entry.group);
      pickupVisuals.set(b.id, entry);
    }
    entry.group.position.set(b.x, b.y || 0, b.z);

    // 落地前翻滚，落地后只转光环
    if (!b.landed) {
      entry.group.rotation.y += 0.16;
      entry.group.rotation.z += 0.05;
    } else {
      entry.group.rotation.z *= 0.88;
      entry.group.rotation.y += 0.012;
    }
    entry.ring.rotation.z = performance.now() * 0.003 + entry.phase;

    // 呼吸式发光，让它在暗场里也显眼
    const pulse = 1.1 + Math.sin(performance.now() * 0.005 + entry.phase) * 0.45;
    entry.accentMat.emissiveIntensity = pulse;
    entry.ringMat.opacity = 0.55 + Math.sin(performance.now() * 0.005 + entry.phase) * 0.2;
  }

  for (const [id, entry] of pickupVisuals) {
    if (alive.has(id)) continue;
    scene.remove(entry.group);
    entry.bodyMat.dispose();
    entry.accentMat.dispose();
    entry.ringMat.dispose();
    pickupVisuals.delete(id);
  }
}

function clearPickups() {
  for (const [, entry] of pickupVisuals) {
    scene.remove(entry.group);
    entry.bodyMat.dispose();
    entry.accentMat.dispose();
    entry.ringMat.dispose();
  }
  pickupVisuals.clear();
}

function clearPits() {
  for (const [, mesh] of pitVisuals) {
    scene.remove(mesh);
    mesh.material.dispose();
  }
  pitVisuals.clear();
}

function clearChains() {
  for (const [, entry] of chainVisuals) scene.remove(entry.group);
  chainVisuals.clear();
}

/* ----------------------------------------------------------
 * 路障外观随时代换（点子池「时代栅栏」）
 *
 * 同一堵墙换六种长相，占地宽度、位置、缩放完全沿用 syncBarricade 那套，
 * 血量/反击/冷却一个都不碰（那些是甲的数值）。
 *   0 中世纪 木栅栏 / 1 二战 沙袋掩体 / 2 现代 混凝土隔离墙
 *   3 后现代 钢板铁丝网 / 4 星际 能量屏障 / 5 终幕 激光栅栏
 * ---------------------------------------------------------- */
const barricadeParts = [];
let barricadeGlowMat = null;

function clearBarricadeLook() {
  if (!barricadeGroup) return;
  const mats = new Set();
  for (const p of barricadeParts) {
    barricadeGroup.remove(p);
    p.geometry?.dispose();
    const list = Array.isArray(p.material) ? p.material : [p.material];
    for (const m of list) if (m) mats.add(m);
  }
  for (const m of mats) m.dispose();
  barricadeParts.length = 0;
  barricadeGlowMat = null;
}

function addBarPart(geo, mat, x, y, z, rotY = 0) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  barricadeGroup.add(mesh);
  barricadeParts.push(mesh);
  return mesh;
}

function buildBarricadeLook(eraId) {
  if (!barricadeGroup) return;
  clearBarricadeLook();
  // 部件全换了新的，破损段位也要跟着归零——
  // 否则重建后的墙会继续沿用上一条命的段位，一建好就是破的
  barricadeGroup.userData.damageStage = -1;

  const W = BARRICADE_WIDTH;
  const std = (color, rough = 0.8, metal = 0.05, emissive = 0x000000, ei = 0) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: metal,
      emissive,
      emissiveIntensity: ei,
    });

  if (eraId === 1) {
    // 二战：一层层码起来的沙袋
    const a = std(0x8d7f5c, 0.95);
    const b = std(0x9c8e68, 0.95);
    for (let row = 0; row < 3; row++) {
      const n = row === 2 ? 4 : 5;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 0.86 + (row % 2 ? 0.2 : 0);
        addBarPart(
          new THREE.BoxGeometry(0.8, 0.2, 0.42),
          (i + row) % 2 ? a : b,
          x,
          0.13 + row * 0.22,
          0,
          (Math.random() - 0.5) * 0.12
        );
      }
    }
    return;
  }

  if (eraId === 2) {
    // 现代：混凝土隔离墩 + 黄黑警示条
    const conc = std(0x9b9a92, 0.9, 0.02);
    addBarPart(new THREE.BoxGeometry(W, 0.42, 0.46), conc, 0, 0.21, 0);
    addBarPart(new THREE.BoxGeometry(W, 0.16, 0.34), conc, 0, 0.5, 0);
    const warn = std(0xd8a63a, 0.6, 0.1);
    for (let i = 0; i < 5; i++) {
      addBarPart(new THREE.BoxGeometry(0.4, 0.1, 0.02), warn, -1.6 + i * 0.8, 0.36, 0.24);
    }
    return;
  }

  if (eraId === 3) {
    // 后现代：钢板墙 + 顶部一圈圈铁丝网
    const steel = std(0x6b727a, 0.5, 0.6);
    const rust = std(0x7a5236, 0.9, 0.15);
    const wire = std(0x9aa2aa, 0.4, 0.8);
    addBarPart(new THREE.BoxGeometry(W, 0.6, 0.1), steel, 0, 0.3, 0);
    for (let i = -2; i <= 2; i++) {
      addBarPart(new THREE.BoxGeometry(0.07, 0.6, 0.16), rust, i * 0.9, 0.3, 0.04);
    }
    for (let i = 0; i < 4; i++) {
      addBarPart(new THREE.TorusGeometry(0.19, 0.022, 6, 14), wire, -1.5 + i * 1.0, 0.74, 0, 0.3);
    }
    return;
  }

  if (eraId === 4) {
    // 星际：两根发光立柱 + 中间一层能量场
    const post = std(0x2f3a46, 0.4, 0.8, 0x1b6f8a, 0.9);
    addBarPart(new THREE.CylinderGeometry(0.09, 0.11, 1.0, 8), post, -1.9, 0.5, 0);
    addBarPart(new THREE.CylinderGeometry(0.09, 0.11, 1.0, 8), post, 1.9, 0.5, 0);
    addBarPart(new THREE.BoxGeometry(W, 0.1, 0.5), std(0x2a333d, 0.6, 0.5), 0, 0.05, 0);

    const fieldMat = new THREE.MeshBasicMaterial({
      color: 0x4ad9ff,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const fieldMesh = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.5, 0.86), fieldMat);
    fieldMesh.position.set(0, 0.5, 0);
    barricadeGroup.add(fieldMesh);
    barricadeParts.push(fieldMesh);
    barricadeGlowMat = fieldMat;
    return;
  }

  if (eraId === 5) {
    // 终幕：两根立柱之间拉四道激光
    const post = std(0x3a2a24, 0.5, 0.6, 0xff6a24, 0.9);
    addBarPart(new THREE.CylinderGeometry(0.1, 0.12, 1.05, 8), post, -1.9, 0.52, 0);
    addBarPart(new THREE.CylinderGeometry(0.1, 0.12, 1.05, 8), post, 1.9, 0.52, 0);
    const barMat = new THREE.MeshBasicMaterial({
      color: 0xff8a3c,
      transparent: true,
      opacity: 0.9,
    });
    for (let i = 0; i < 4; i++) {
      addBarPart(new THREE.BoxGeometry(W - 0.6, 0.035, 0.035), barMat, 0, 0.2 + i * 0.18, 0);
    }
    barricadeGlowMat = barMat;
    return;
  }

  // 默认 / 中世纪：木栅栏（立桩 + 两道横梁）
  const wood = std(0x7a5a34, 0.9, 0.02);
  const dark = std(0x5c4126, 0.95, 0.02);
  for (let i = 0; i < 7; i++) {
    const log = addBarPart(
      new THREE.CylinderGeometry(0.085, 0.1, 0.8, 6),
      i % 2 ? wood : dark,
      -1.8 + i * 0.6,
      0.4,
      (Math.random() - 0.5) * 0.06,
      (Math.random() - 0.5) * 0.16
    );
    log.rotation.z = (Math.random() - 0.5) * 0.06;
  }
  addBarPart(new THREE.BoxGeometry(W - 0.3, 0.09, 0.09), dark, 0, 0.62, 0.12);
  addBarPart(new THREE.BoxGeometry(W - 0.3, 0.09, 0.09), dark, 0, 0.24, 0.12);
}

function initBarricade() {
  barricadeGroup = new THREE.Group();
  barricadeGroup.position.set(BARRICADE_X, 0, BARRICADE_Z);

  buildBarricadeLook(getCurrentEraIndex());

  scene.add(barricadeGroup);

  barricadeHpBar = makeHpBar(2.4);
  barricadeHpBar.group.position.set(BARRICADE_X, 0.12, BARRICADE_Z + 0.5);

  barricadeCountdown = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getCountdownTexture(10),
      transparent: true,
      depthTest: false,
    })
  );
  barricadeCountdown.scale.set(1.5, 0.75, 1);
  barricadeCountdown.position.set(BARRICADE_X, 0.95, BARRICADE_Z + 0.2);
  barricadeCountdown.renderOrder = 21;
  barricadeCountdown.visible = false;
  scene.add(barricadeCountdown);
}

/* ----------------------------------------------------------
 * 工事三段破损（美术需求 P1）
 *
 * 三个段位，按血量比切：
 *   完好  >66%  —— 全部件在位、不歪
 *   一段  33~66% —— 约 1/4 部件缺失，剩下的轻微歪斜
 *   二段  <33%   —— 约一半部件缺失，缺口明显，剩下的明显歪斜、下沉
 *
 * 做法是**直接改已有部件**而不是重建模型：
 * 重建会在每次挨打时闪一下，反而看不出"越来越破"的连续过程。
 * 部件的原始位置在建的时候记在 userData 里，破损只改偏移，复原时能精确回去。
 * ---------------------------------------------------------- */
function applyBarricadeDamage(ratio) {
  if (!barricadeParts.length) return;

  let stage;
  if (ratio > 0.66) stage = 0;
  else if (ratio > 0.33) stage = 1;
  else stage = 2;

  // 段位没变就不动，避免每帧重算 60 次
  if (barricadeGroup.userData.damageStage === stage) return;
  barricadeGroup.userData.damageStage = stage;

  const n = barricadeParts.length;
  for (let i = 0; i < n; i++) {
    const p = barricadeParts[i];
    // 第一次进入时记住原始变换
    if (!p.userData.home) {
      p.userData.home = {
        x: p.position.x, y: p.position.y, z: p.position.z,
        rx: p.rotation.x, ry: p.rotation.y, rz: p.rotation.z,
        visible: p.visible,
      };
    }
    const h = p.userData.home;

    if (stage === 0) {
      p.visible = h.visible;
      p.position.set(h.x, h.y, h.z);
      p.rotation.set(h.rx, h.ry, h.rz);
      continue;
    }

    // 用下标做确定性伪随机：同一段位每次都落在同一批部件上，
    // 不能用 Math.random()，否则每帧跳一次、看着像在抽搐
    const hash = (i * 2654435761) % 1000 / 1000;

    if (stage === 1) {
      p.visible = hash > 0.25;                 // 约 1/4 部件没了
      p.position.set(h.x, h.y - (hash < 0.4 ? 0.06 : 0), h.z);
      p.rotation.set(
        h.rx + (hash - 0.5) * 0.24,
        h.ry + (hash - 0.5) * 0.3,
        h.rz + (hash - 0.5) * 0.22
      );
    } else {
      p.visible = hash > 0.5;                  // 约一半部件没了
      p.position.set(h.x + (hash - 0.5) * 0.1, h.y - 0.12, h.z);
      p.rotation.set(
        h.rx + (hash - 0.5) * 0.6,
        h.ry + (hash - 0.5) * 0.7,
        h.rz + (hash - 0.5) * 0.5
      );
    }
  }
}

function syncBarricade(state) {
  const b = state.barricade;
  if (!b || !barricadeGroup) return;

  // 还没抽到路障卡时不显示
  if (!b.unlocked) {
    barricadeGroup.visible = false;
    barricadeHpBar.group.visible = false;
    barricadeCountdown.visible = false;
    return;
  }

  // 等级会改宽度：左边界不动，向右长；整段墙和 UI 一起缩放
  const center = b.xMin + b.width / 2;
  const scale = b.width / BARRICADE_WIDTH;
  barricadeGroup.position.x = center;
  barricadeGroup.scale.x = scale;
  barricadeHpBar.group.position.x = center;
  barricadeHpBar.group.scale.x = scale;
  barricadeCountdown.position.x = center;

  const active = !!b.active;
  barricadeGroup.visible = active;
  barricadeHpBar.group.visible = active;
  barricadeCountdown.visible = !active;

  // 能量场 / 激光这种发光时代：拦得越久闪得越急一点，看起来"在扛"
  if (barricadeGlowMat && active) {
    const pulse = 0.22 + Math.sin(performance.now() * 0.004) * 0.09;
    barricadeGlowMat.opacity = pulse;
  }

  if (active) {
    const ratio = b.maxHp ? Math.max(0, Math.min(1, b.hp / b.maxHp)) : 0;
    barricadeHpBar.fill.scale.x = barricadeHpBar.width * ratio;
    barricadeHpBar.fill.position.x = -barricadeHpBar.width / 2;
    barricadeHpBar.fill.material.color.setHex(
      ratio > 0.5 ? 0x5adf7a : ratio > 0.25 ? 0xffc24a : 0xff5a44
    );

    // 三段破损（美术需求 P1「工事额外 3 段破损」）：
    // 不重建模型，直接按血量比改已有部件——隐藏一部分、把剩下的打歪。
    // 重建模型的话每被打一下就闪一次，反而看不出"越来越破"这个连续过程。
    applyBarricadeDamage(ratio);
  } else {
    const sec = Math.max(0, Math.ceil(b.cooldown));
    if (sec !== barricadeCountdownSec) {
      barricadeCountdownSec = sec;
      barricadeCountdown.material.map = getCountdownTexture(sec);
      barricadeCountdown.material.needsUpdate = true;
    }
  }
}

function getCountdownTexture(sec) {
  const key = String(sec);
  const cached = countdownTextures.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 96;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 192, 96);
  ctx.font = 'bold 52px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd27a';
  ctx.fillText(`${sec}s`, 96, 50);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  countdownTextures.set(key, tex);
  return tex;
}

function makeHpBar(width) {
  const tex = getHpBarTexture();
  const group = new THREE.Group();

  const bg = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color: 0x0d0d0d, transparent: true, opacity: 0.8, depthTest: false,
  }));
  bg.scale.set(width, 0.14, 1);

  const fill = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color: 0xff5a44, transparent: true, depthTest: false,
  }));
  fill.center.set(0, 0.5);          // 从左端往右长
  fill.position.x = -width / 2;
  fill.scale.set(width, 0.1, 1);

  group.add(bg);
  group.add(fill);
  scene.add(group);
  group.renderOrder = 20;
  return { group, bg, fill, width };
}

function disposeHpBar(bar) {
  if (!bar) return;
  scene.remove(bar.group);
  bar.bg.material.dispose();
  bar.fill.material.dispose();
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

/* ==========================================================
 * P0 通用范围打击特效（对应 docs/美术需求-槽位与技能.md 第一组）
 *
 * 一套系统覆盖八个技能：箭雨、空袭、炮火覆盖、精确打击、无人机蜂群、
 * 轨道轰炸、舰载无人机群、终焉审判、宇宙坍缩。区别只在参数，不在实现。
 *
 * 五层按顺序叠，缺一层就散：
 *   1. 落点圈  —— 贴地暗色圆盘，标"打的是这一片"
 *   2. 火球    —— 加色膨胀球，爆炸本体
 *   3. 冲击波  —— 贴地薄环，扩得最远，给"震开"的感觉
 *   4. 尘土    —— 棕色粒子往外抛，落点才有重量
 *   5. 迸射    —— 亮色粒子往上冲，补速度感
 *
 * 为什么不做"预警圈先出、0.4 秒后再炸"：
 * 甲的 aoe 技能在 castSkill 里是**立刻结算伤害**的（见 game.js damageZombiesInRadius）。
 * 视觉上延后 0.4 秒爆炸，就会变成"僵尸先死、后爆炸"，
 * 读起来像画面卡了。要真做预警，得甲那边把伤害延后，那是玩法改动，不在美术范围里。
 * 所以这里做的是"命中即炸"的瞬时冲击，落点圈只作为冲击的第一帧。
 * ========================================================== */
function spawnImpact(x, z, opts = {}) {
  if (!scene || !isFinite(x) || !isFinite(z)) return;

  const radius = Math.max(0.8, Number(opts.radius) || 3);
  const color = opts.color != null ? opts.color : 0xffffff;
  const power = Math.max(0.2, Math.min(1.6, Number(opts.power) || 1));
  const dust = opts.dust !== false;
  const coreY = 0.55 + radius * 0.08;

  // 1. 落点圈：暗色圆盘，压住地面，标范围
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 28),
    new THREE.MeshBasicMaterial({
      color: 0x120c08, transparent: true, opacity: 0.5,
      depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -5, polygonOffsetUnits: -5,
    })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(x, 0.03, z);
  disc.renderOrder = 2;
  scene.add(disc);
  effects.push({ mesh: disc, life: 0, maxLife: 0.5, type: 'areaDisc' });

  // 2. 火球：两层，内白外色，加色混合才有"发光"而不是"一个球"
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.42, 14, 12),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  ball.position.set(x, coreY, z);
  scene.add(ball);
  effects.push({
    mesh: ball, life: 0, maxLife: 0.38,
    type: 'fireball', baseScale: radius * 1.05, baseY: coreY,
  });

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.2, 10, 8),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  core.position.set(x, coreY + 0.1, z);
  scene.add(core);
  effects.push({
    mesh: core, life: 0, maxLife: 0.26,
    type: 'fireball', baseScale: radius * 0.62, baseY: coreY + 0.1,
  });

  // 3. 冲击波：贴地薄环，扩到 1.6 倍半径
  const wave = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.72, radius * 0.8, 40),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.75,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  wave.rotation.x = -Math.PI / 2;
  wave.position.set(x, 0.07, z);
  scene.add(wave);
  effects.push({ mesh: wave, life: 0, maxLife: 0.62, type: 'shockwave', baseScale: 1.6 });

  // 4. 尘土：往外抛，落下来
  if (dust) {
    spawnBurst(x, 0.3, z, 0x6b5540, Math.round(16 * power), {
      speed: 4.2 * power, up: 3.0 * power,
      spread: radius * 0.55, life: 1.05, gravity: -4.5,
    });
  }

  // 5. 迸射：亮色向上，补速度感
  spawnBurst(x, coreY, z, color, Math.round(22 * power), {
    speed: 6.0 * power, up: 4.6 * power,
    spread: radius * 0.3, life: 0.55, gravity: -10,
  });

  shake = Math.max(shake, 0.3 + 0.34 * power);
}

/* 内爆：黑洞 / 宇宙坍缩。粒子和光环从外圈往中心收 */
function spawnImplosion(x, z, color, radius) {
  if (!scene || !isFinite(x) || !isFinite(z)) return;
  const r = Math.max(1, Number(radius) || 4);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(r * 0.68, r * 0.78, 40),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.08, z);
  scene.add(ring);
  effects.push({ mesh: ring, life: 0, maxLife: 0.75, type: 'implosion', baseScale: 1 });

  // 单点内爆：收完之后补一下亮斑，证明"吸完了"
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.16, 10, 8),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  dot.position.set(x, 0.6, z);
  scene.add(dot);
  effects.push({ mesh: dot, life: 0, maxLife: 0.55, type: 'fireball', baseScale: r * 0.5, baseY: 0.6 });

  shake = Math.max(shake, 0.42);
}

/* 全屏白闪：终焉审判 / 轨道轰炸用。复用 fx-layer 里的一个 div */
function spawnFlash(color, strength) {
  if (!fxFlash) return;
  fxFlash.style.background = `#${new THREE.Color(color).getHexString()}`;
  fxFlash.style.transition = 'none';
  fxFlash.style.opacity = String(Math.min(1, strength));
  // 强制重排后再过渡，否则浏览器会把两次 opacity 合并成一次、闪不出来
  void fxFlash.offsetWidth;
  fxFlash.style.transition = 'opacity 420ms ease-out';
  fxFlash.style.opacity = '0';
}

/* 攻城：从炮口抛一颗炮弹到落点 */
function spawnMortar(fromX, fromZ, toX, toZ, color, flightTime = 0.5) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 8),
    new THREE.MeshBasicMaterial({ color })
  );
  mesh.position.set(fromX, 1.2, fromZ);
  scene.add(mesh);
  effects.push({
    mesh,
    life: 0,
    maxLife: flightTime,
    type: 'arc',
    from: { x: fromX, y: 1.2, z: fromZ },
    to: { x: toX, y: 0.3, z: toZ },
    arc: 2.2,
  });
}

/* 技能范围打击：从天上砸下来 */
function spawnSkyStrike(x, z, color, delay = 0) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 8, 8),
    new THREE.MeshBasicMaterial({ color })
  );
  mesh.position.set(x, 12, z);
  mesh.visible = delay <= 0;
  scene.add(mesh);
  effects.push({
    mesh,
    life: -delay,
    maxLife: 0.4,
    type: 'arc',
    from: { x, y: 12, z },
    to: { x, y: 0.3, z },
    arc: 0,
  });
}

/* 炮火覆盖：圆形范围 + 8 发炮弹错开落下 */
function spawnBarrageFx(x, z, radius, color) {
  spawnGroundArea(x, z, radius, color, 0.9);

  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius * 0.9;
    spawnSkyStrike(
      x + Math.cos(a) * r,
      z + Math.sin(a) * r,
      color,
      i * 0.08 + Math.random() * 0.06
    );
  }
}

/* 轨道轰炸：只铺在被清掉的那一段（bandMin ~ bandMax），
 * z 已被甲限制在士兵阵型之前；没有范围时退回单道光柱。
 * 一整片淡光幕盖住清掉的纵深，近端和远端各压一条亮线，玩家一眼能看出打到哪。 */
function spawnOrbitalBeam(z, color, bandMin, bandMax) {
  const hasBand = Number.isFinite(bandMin) && Number.isFinite(bandMax);
  const lo = hasBand ? Math.min(bandMin, bandMax) : z;
  const hi = hasBand ? Math.max(bandMin, bandMax) : z;
  const span = Math.max(0, hi - lo);
  const midZ = (lo + hi) / 2;

  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(18.6, 0.8, Math.max(1.2, span + 1.0)),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  glow.position.set(0, 2.6, midZ);
  scene.add(glow);
  effects.push({ mesh: glow, life: 0, maxLife: 0.75, type: 'beamGlow' });

  // 亮线：范围够大就压近端 + 远端两条，太小只留中间一条
  const lines = span > 0.6 ? [hi, lo] : [midZ];
  for (const lz of lines) spawnOrbitalBeamAt(lz, color);

  shake = Math.max(shake, 0.55);
}

function spawnOrbitalBeamAt(z, color) {
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(18, 0.22, 0.22),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    })
  );
  core.position.set(0, 2.8, z);
  scene.add(core);
  effects.push({ mesh: core, life: 0, maxLife: 0.75, type: 'fade' });

  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(18.6, 1.1, 1.1),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  glow.position.set(0, 2.8, z);
  scene.add(glow);
  effects.push({ mesh: glow, life: 0, maxLife: 0.75, type: 'beamGlow' });

  for (let i = 0; i < 10; i++) {
    spawnBurst(
      -8 + (i / 9) * 16,
      0.3,
      z,
      color,
      2,
      { speed: 1.4, up: 1.8, spread: 0.3, life: 0.5 }
    );
  }
}

/* ----------------------------------------------------------
 * 终幕三张牌的特效（审判 / 献祭 / 重启）
 *
 * 三张牌都不再是"在天上炸一下"，所以视觉也不用 AOE 那套：
 * 审判是垂直落下的白光柱（点名处决），献祭是从玩家脚下推出去的血环，
 * 重启是一条从阵型扫向出生点的扫描线。三者一眼能分清。
 * ---------------------------------------------------------- */

// 名单太长时抽样，避免一次几百个粒子
function thin(list, max) {
  if (list.length <= max) return list;
  const step = Math.ceil(list.length / max);
  return list.filter((_, i) => i % step === 0);
}

// 审判的处决柱：一根从天上插下来的细光柱 + 落地一圈环，比"掉个球"更像点名
function spawnVerdictPillar(x, z, color = 0xffffff) {
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 7.2, 0.26),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  beam.position.set(x, 3.6, z);
  scene.add(beam);
  effects.push({ mesh: beam, life: 0, maxLife: 0.32, type: 'fade' });

  spawnRing(x, z, 0xf2fbff, 0.45);
  spawnBurst(x, 0.4, z, 0xffffff, 4, {
    speed: 1.3,
    up: 2.2,
    spread: 0.25,
    life: 0.35,
  });
}

// 终焉审判：全屏白闪 + 被处决的僵尸头顶插下光柱 + 没到线的套一圈白环
function spawnJudgmentFx(executed = [], chipped = []) {
  spawnFlash(0xffffff, 0.75);
  shake = Math.max(shake, 0.45);

  for (const p of thin(executed, 36)) {
    spawnVerdictPillar(p.x, p.z);
  }

  for (const p of thin(chipped, 30)) {
    spawnRing(p.x, p.z, 0xdff0ff, 0.32);
  }
}

// 献祭：红色血光 + 从阵型向外推的两圈血环 + 每只僵尸脚下冒血雾
function spawnSacrificeFx(shaved = []) {
  spawnFlash(0xff2a1a, 0.55);
  spawnRing(0, 8.0, 0xff3a3a, 2.2);
  spawnRing(0, 8.0, 0xff9a7a, 1.5);
  shake = Math.max(shake, 0.4);

  for (const p of thin(shaved, 28)) {
    spawnBurst(p.x, 0.6, p.z, 0xff3a3a, 3, {
      speed: 1.1,
      up: 1.4,
      spread: 0.35,
      life: 0.45,
    });
  }
}

// 重启：冷色闪白 + 一条扫描线从士兵阵型扫向出生点 + 场上留消散白环
function spawnRebootFx(removed = []) {
  spawnFlash(0xbfe9ff, 0.7);
  shake = Math.max(shake, 0.5);

  // z 从士兵线（9）扫到出生点之前（-24），不依赖 CONFIG，画面层的固定取景范围
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(19, 0.16, 0.55),
    new THREE.MeshBasicMaterial({
      color: 0xbfe9ff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  bar.position.set(0, 1.0, 9);
  scene.add(bar);
  effects.push({ mesh: bar, life: 0, maxLife: 0.55, type: 'scan', fromZ: 9, toZ: -24 });

  for (const p of thin(removed, 26)) {
    spawnRing(p.x, p.z, 0xbfe9ff, 0.3);
  }
}

/* 地面范围圈：给圆形技能标出覆盖范围 */
function spawnGroundArea(x, z, radius, color, maxLife = 0.7) {
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(x, 0.045, z);
  scene.add(disc);
  effects.push({ mesh: disc, life: 0, maxLife, type: 'areaDisc' });

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.1, radius - 0.12), radius, 56),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.05, z);
  scene.add(ring);
  effects.push({ mesh: ring, life: 0, maxLife, type: 'fade' });
}

/* 箭雨：圆形覆盖区 + 一批箭矢从上方落进圈里 */
function spawnArrowRain(x, z, radius, color) {
  spawnGroundArea(x, z, radius, color, 0.75);

  const count = 16;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius * 0.92;
    const ax = x + Math.cos(a) * r;
    const az = z + Math.sin(a) * r;
    const fall = 0.32 + Math.random() * 0.28;

    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.075, 0.55, 5),
      new THREE.MeshBasicMaterial({ color })
    );
    arrow.rotation.x = Math.PI; // 尖端朝下
    arrow.position.set(ax, 8.5, az);
    scene.add(arrow);
    effects.push({
      mesh: arrow,
      life: 0,
      maxLife: fall,
      type: 'arrow',
      from: { x: ax, y: 8.5, z: az },
      to: { x: ax, y: 0.18, z: az },
      arc: 0,
    });
  }
}

/* 近防：从炮塔拉一条曳光到目标 */
function spawnTracer(fromX, fromZ, toX, toZ, color, fromY = 0.8) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len = Math.hypot(dx, dz) || 0.1;

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.06, len),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
  );
  mesh.position.set((fromX + toX) / 2, fromY, (fromZ + toZ) / 2);
  mesh.lookAt(toX, fromY, toZ);
  scene.add(mesh);
  effects.push({ mesh, life: 0, maxLife: 0.15, type: 'fade' });
}

/* 横排技能：一道贯穿全屏的光带 */
function spawnBar(z, color) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(18, 0.15, 0.5),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
  );
  mesh.position.set(0, 0.6, z);
  scene.add(mesh);
  effects.push({ mesh, life: 0, maxLife: 0.45, type: 'fade' });
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

    if (fx.life < 0) {
      if (fx.mesh.visible) fx.mesh.visible = false;
      continue;
    }
    if (!fx.mesh.visible) fx.mesh.visible = true;

    const t = fx.life / fx.maxLife;

    if (t >= 1) {
      if (fx.type === 'arc') {
        spawnRing(fx.to.x, fx.to.z, fx.mesh.material.color.getHex(), 0.5);
      }
      scene.remove(fx.mesh);
      disposeMesh(fx.mesh);
      effects.splice(i, 1);
      continue;
    }

    if (fx.type === 'ring') {
      const s = 1 + t * 3;
      fx.mesh.scale.set(s, s, s);
      fx.mesh.material.opacity = (1 - t) * 0.9;
    } else if (fx.type === 'fireball') {
      // 火球：先快速涨到最大，再在最后三成时间里收亮度。
      // 只淡出不变小，看起来才像"烧掉"而不是"缩回去"
      const grow = Math.min(1, t / 0.35);
      const sc = fx.baseScale * (0.35 + grow * 0.9);
      fx.mesh.scale.setScalar(sc);
      fx.mesh.position.y = fx.baseY + grow * 0.45;
      fx.mesh.material.opacity = t < 0.35 ? 0.95 : Math.max(0, (1 - t) / 0.65) * 0.95;
    } else if (fx.type === 'shockwave') {
      // 冲击波：贴地薄环，扩得比 ring 更快更远，透明度掉得更狠
      const e = 1 - (1 - t) * (1 - t); // easeOutQuad：一开始猛，后面减速
      const sc = fx.baseScale * (0.2 + e);
      fx.mesh.scale.set(sc, sc, sc);
      fx.mesh.material.opacity = (1 - t) * 0.75;
    } else if (fx.type === 'implosion') {
      // 内爆：从外圈往里收，和爆炸正好相反
      const e = t * t;
      const sc = fx.baseScale * (1 - e) + 0.05;
      fx.mesh.scale.set(sc, sc, sc);
      fx.mesh.material.opacity = 0.85 * (1 - t * 0.4);
    } else if (fx.type === 'dust') {
      fx.mesh.scale.setScalar(0.7 + t * 0.8);
      fx.mesh.material.opacity = (1 - t) * 0.32;
    } else if (fx.type === 'areaDisc') {
      fx.mesh.material.opacity = (1 - t) * 0.14;
    } else if (fx.type === 'arc' || fx.type === 'arrow') {
      const x = fx.from.x + (fx.to.x - fx.from.x) * t;
      const z = fx.from.z + (fx.to.z - fx.from.z) * t;
      const y =
        fx.from.y +
        (fx.to.y - fx.from.y) * t +
        Math.sin(Math.PI * t) * fx.arc;
      fx.mesh.position.set(x, y, z);
    } else if (fx.type === 'fade') {
      fx.mesh.material.opacity = (1 - t) * 0.9;
    } else if (fx.type === 'beamGlow') {
      fx.mesh.material.opacity = (1 - t) * 0.35;
      fx.mesh.scale.set(1, 1 + t * 0.6, 1 + t * 0.6);
    } else if (fx.type === 'scan') {
      // 重启的扫描线：从阵型一路扫向出生点
      fx.mesh.position.z = fx.fromZ + (fx.toZ - fx.fromZ) * t;
      fx.mesh.material.opacity = (1 - t) * 0.8;
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
  el.textContent = `分数 +${score}`;
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

  // 子弹颜色跟着时代走（中世纪火药暖黄、二战橙红、星际青紫……）
  const bulletColor = new THREE.Color(0xfff2c0).multiply(
    new THREE.Color(eraBulletTint[0], eraBulletTint[1], eraBulletTint[2])
  );

  const core = buildBulletCore(currentEra ? currentEra.id : 0, bulletColor);
  group.add(core);

  // 拖尾：跟随时代色，给弹道一点"速度感"
  const trail = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.95),
    new THREE.MeshBasicMaterial({
      map: ensureTrailTexture(),
      color: bulletColor,
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

/* 按时代决定弹体外观（全部朝 -z 飞行，与子弹 vz 方向一致）：
 *   0 中世纪 → 箭矢（木杆 + 钢镞 + 三片尾羽）
 *   1 二战   → 拉长黄铜曳光弹
 *   2 现代   → 白色曳光弹
 *   3 后现代 → 青色能量弹
 *   4 星际   → 等离子球
 *   5 终幕   → 赤金激光束（细长发光柱）
 * 中世纪箭矢是用户点名要的"中世纪箭武器"的画面落地；其余时代顺手做了差异化，
 * 让六时代弹道各有辨识度。全部是代码生成的几何体，不加载任何模型文件——
 * 士兵在 720×1280 下只有 35px 高，挂持枪模型看不出形状，已决定不做（见点子池决策记录）。 */
function buildBulletCore(eraId, bulletColor) {
  const core = new THREE.Group();

  if (eraId === 0) {
    // 中世纪箭矢
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.55, 6),
      new THREE.MeshBasicMaterial({ color: 0x7a5230 })
    );
    shaft.rotation.x = Math.PI / 2; // 杆身沿 z
    core.add(shaft);

    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.06, 0.16, 8),
      new THREE.MeshBasicMaterial({ color: 0xd8dde3 })
    );
    head.rotation.x = -Math.PI / 2; // 锥尖朝 -z（飞行方向）
    head.position.z = -0.34;
    core.add(head);

    // 三片尾羽，按时代色，绕杆身分散
    const fletchMat = new THREE.MeshBasicMaterial({ color: bulletColor, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.1), fletchMat);
      const a = (i / 3) * Math.PI * 2;
      f.position.set(Math.cos(a) * 0.03, Math.sin(a) * 0.03, 0.26);
      f.rotation.z = a;
      f.rotation.y = Math.PI / 2;
      core.add(f);
    }
    return core;
  }

  if (eraId === 4) {
    // 星际：等离子球
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 12),
      new THREE.MeshBasicMaterial({ color: bulletColor })
    );
    core.add(orb);
    return core;
  }

  if (eraId === 5) {
    // 终幕：激光束（细长发光柱）
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1.1, 8),
      new THREE.MeshBasicMaterial({ color: bulletColor })
    );
    beam.rotation.x = Math.PI / 2;
    core.add(beam);
    return core;
  }

  if (eraId === 3) {
    // 后现代：能量弹（略粗的胶囊）
    const bolt = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.06, 0.32, 3, 8),
      new THREE.MeshBasicMaterial({ color: bulletColor })
    );
    bolt.rotation.x = Math.PI / 2;
    core.add(bolt);
    return core;
  }

  // 二战(1) / 现代(2)：标准曳光弹，二战略长一点更有"重弹"感
  const len = eraId === 1 ? 0.42 : 0.3;
  const radius = eraId === 1 ? 0.06 : 0.055;
  const round = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, len, 3, 8),
    new THREE.MeshBasicMaterial({ color: bulletColor })
  );
  round.rotation.x = Math.PI / 2;
  core.add(round);
  return core;
}

/* ----------------------------------------------------------
 * 地图氛围粒子：每张图有自己的空气感
 *   城市=雨丝  雨林=萤火虫  沙漠=风沙  月球=星尘  雪原=飘雪  熔岩=火星
 * 全部用一个 Points 池，逐帧只改坐标和颜色，不新建对象。
 * ---------------------------------------------------------- */

const AMBIENT_FX = {
  city:   { kind: 'rain',   count: 90,  color: [0.62, 0.72, 0.85], size: 0.055, speed: 16, area: [26, 26] },
  jungle: { kind: 'firefly', count: 34, color: [0.75, 1.0, 0.35], size: 0.13, speed: 0.5, area: [22, 20] },
  desert: { kind: 'sand',   count: 80,  color: [0.85, 0.75, 0.52], size: 0.05, speed: 7, area: [30, 18] },
  moon:   { kind: 'star',   count: 70,  color: [0.72, 0.86, 1.0], size: 0.16, speed: 0.25, area: [26, 24] },
  snow:   { kind: 'snow',   count: 110, color: [0.92, 0.96, 1.0], size: 0.075, speed: 2.6, area: [26, 24] },
  lava:   { kind: 'ember',  count: 95,  color: [1.0, 0.6, 0.22], size: 0.13, speed: 3.8, area: [22, 18] },
  base:   { kind: 'sand',   count: 55,  color: [0.78, 0.82, 0.85], size: 0.045, speed: 4.5, area: [28, 20] },
  lab:    { kind: 'motes',  count: 60,  color: [0.55, 1.0, 0.78], size: 0.085, speed: 0.5, area: [22, 20] },
  harbor: { kind: 'fog',    count: 45,  color: [0.72, 0.82, 0.9], size: 0.22, speed: 0.35, area: [26, 22] },

  // ---- 17 张新地图 ----
  // 每张都选一个和它气质对得上的粒子：沼泽升雾、停车场落灰、
  // 空间站飘微弱尘埃、黑洞边缘是冷蓝星点
  castle:     { kind: 'ember',  count: 45,  color: [1.0, 0.72, 0.36], size: 0.09, speed: 2.2, area: [24, 20] },
  village:    { kind: 'ember',  count: 38,  color: [1.0, 0.78, 0.42], size: 0.08, speed: 1.8, area: [24, 20] },
  abbey:      { kind: 'motes',  count: 52,  color: [0.86, 0.9, 0.98], size: 0.07, speed: 0.3, area: [22, 20] },
  swamp:      { kind: 'fog',    count: 60,  color: [0.55, 0.72, 0.55], size: 0.26, speed: 0.22, area: [26, 22] },
  trench:     { kind: 'fog',    count: 50,  color: [0.68, 0.64, 0.52], size: 0.24, speed: 0.3, area: [26, 22] },
  beach:      { kind: 'sand',   count: 70,  color: [0.9, 0.85, 0.7], size: 0.05, speed: 5.5, area: [30, 20] },
  warport:    { kind: 'fog',    count: 48,  color: [0.7, 0.78, 0.86], size: 0.22, speed: 0.32, area: [26, 22] },
  highway:    { kind: 'rain',   count: 80,  color: [0.66, 0.74, 0.86], size: 0.055, speed: 15, area: [26, 26] },
  parking:    { kind: 'motes',  count: 66,  color: [0.7, 0.76, 0.84], size: 0.06, speed: 0.35, area: [22, 20] },
  quarantine: { kind: 'motes',  count: 58,  color: [0.5, 0.95, 0.72], size: 0.08, speed: 0.4, area: [22, 20] },
  biofactory: { kind: 'motes',  count: 56,  color: [0.6, 1.0, 0.7], size: 0.075, speed: 0.45, area: [22, 20] },
  station:    { kind: 'motes',  count: 44,  color: [0.6, 0.82, 1.0], size: 0.055, speed: 0.25, area: [22, 20] },
  alienwaste: { kind: 'sand',   count: 64,  color: [0.8, 0.68, 0.88], size: 0.05, speed: 5.0, area: [30, 20] },
  orbitalpad: { kind: 'star',   count: 62,  color: [0.78, 0.9, 1.0], size: 0.14, speed: 0.22, area: [26, 24] },
  voidtemple: { kind: 'ember',  count: 78,  color: [1.0, 0.42, 0.24], size: 0.12, speed: 3.0, area: [22, 18] },
  timeruins:  { kind: 'motes',  count: 60,  color: [0.72, 0.68, 1.0], size: 0.07, speed: 0.3, area: [22, 20] },
  blackhole:  { kind: 'star',   count: 74,  color: [0.7, 0.82, 1.0], size: 0.15, speed: 0.2, area: [26, 24] },
};

let ambientFx = null;   // { points, geo, pos, col, cfg, state }

function initAmbientFx(mapId = MAP_ID) {
  const cfg = AMBIENT_FX[mapId];
  if (!cfg) return;

  const n = cfg.count;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const state = [];

  for (let i = 0; i < n; i++) {
    const p = randomAmbientPoint(cfg, true);
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    const bright = 0.4 + Math.random() * 0.6;
    col[i * 3] = cfg.color[0] * bright;
    col[i * 3 + 1] = cfg.color[1] * bright;
    col[i * 3 + 2] = cfg.color[2] * bright;
    state.push({ phase: Math.random() * Math.PI * 2, speed: 0.6 + Math.random() * 0.8 });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: cfg.size,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: cfg.kind === 'ember' || cfg.kind === 'firefly'
        ? THREE.AdditiveBlending
        : THREE.NormalBlending,
      sizeAttenuation: true,
    })
  );
  points.frustumCulled = false;
  scene.add(points);
  ambientFx = { points, geo, pos, col, cfg, state };
}

// 在场景上方随机撒一个点（按类型决定怎么撒）
function randomAmbientPoint(cfg, init) {
  const [aw, ad] = cfg.area;
  const x = (Math.random() - 0.5) * aw;
  const z = -6 + (Math.random() - 0.5) * ad;

  switch (cfg.kind) {
    case 'rain':
      return { x, y: init ? Math.random() * 22 : 20 + Math.random() * 4, z };
    case 'snow':
      return { x, y: init ? Math.random() * 20 : 18 + Math.random() * 4, z };
    case 'ember':
      return { x, y: init ? Math.random() * 8 : 0.2, z };
    case 'firefly':
      return { x, y: 0.8 + Math.random() * 5, z };
    case 'sand':
      return { x, y: 0.4 + Math.random() * 2.5, z };
    case 'motes':
      // 废弃医院里飘着的尘埃和孢子
      return { x, y: 0.6 + Math.random() * 5, z };
    case 'fog':
      // 港口贴着地面的海雾
      return { x, y: 0.3 + Math.random() * 1.6, z };
    case 'star':
      // 低空漂浮的冷光尘埃：这个世界里没有真正的天空，撒太高看不见
      return { x, y: 1.5 + Math.random() * 5.5, z };
    default:
      return { x, y: 2, z };
  }
}

function updateAmbientFx(dt) {
  if (!ambientFx) return;
  const { cfg, pos, col, geo, state } = ambientFx;
  const n = state.length;
  const t = performance.now() * 0.001;

  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const s = state[i];

    switch (cfg.kind) {
      case 'rain':
        pos[o + 1] -= cfg.speed * dt;
        pos[o] += 1.6 * dt;
        if (pos[o + 1] < 0) {
          const p = randomAmbientPoint(cfg, false);
          pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
        }
        break;
      case 'snow':
        pos[o + 1] -= cfg.speed * s.speed * dt;
        pos[o] += Math.sin(t * 0.7 + s.phase) * 0.5 * dt;
        if (pos[o + 1] < 0) {
          const p = randomAmbientPoint(cfg, false);
          pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
        }
        break;
      case 'ember':
        pos[o + 1] += cfg.speed * s.speed * dt;
        pos[o] += Math.sin(t * 1.6 + s.phase) * 0.8 * dt;
        // 火星越飘越暗，灭了就重新来
        const k = 1 - pos[o + 1] / 12;
        col[o] = cfg.color[0] * k;
        col[o + 1] = cfg.color[1] * k * k;
        col[o + 2] = cfg.color[2] * k * k * k;
        if (pos[o + 1] > 12) {
          const p = randomAmbientPoint(cfg, false);
          pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
        }
        break;
      case 'firefly':
        // 萤火虫：慢慢飘 + 一明一暗
        pos[o] += Math.sin(t * 0.5 + s.phase) * cfg.speed * dt;
        pos[o + 1] += Math.cos(t * 0.8 + s.phase * 1.7) * cfg.speed * 0.6 * dt;
        pos[o + 2] += Math.cos(t * 0.4 + s.phase * 0.6) * cfg.speed * 0.5 * dt;
        if (pos[o + 1] < 0.5 || pos[o + 1] > 6.5) s.phase += Math.PI;
        const glow = 0.25 + 0.75 * Math.max(0, Math.sin(t * 2.2 + s.phase));
        col[o] = cfg.color[0] * glow;
        col[o + 1] = cfg.color[1] * glow;
        col[o + 2] = cfg.color[2] * glow * 0.6;
        break;
      case 'fog':
        pos[o] += Math.sin(t * 0.25 + s.phase) * cfg.speed * dt;
        pos[o + 1] += Math.cos(t * 0.2 + s.phase * 1.2) * cfg.speed * 0.2 * dt;
        const fg = 0.25 + 0.35 * Math.max(0, Math.sin(t * 0.5 + s.phase));
        col[o] = cfg.color[0] * fg;
        col[o + 1] = cfg.color[1] * fg;
        col[o + 2] = cfg.color[2] * fg;
        break;
      case 'motes':
        pos[o] += Math.sin(t * 0.4 + s.phase) * cfg.speed * dt;
        pos[o + 1] += Math.cos(t * 0.6 + s.phase * 1.4) * cfg.speed * 0.5 * dt;
        pos[o + 2] += Math.cos(t * 0.3 + s.phase * 0.8) * cfg.speed * 0.4 * dt;
        const g3 = 0.3 + 0.7 * Math.max(0, Math.sin(t * 1.6 + s.phase));
        col[o] = cfg.color[0] * g3;
        col[o + 1] = cfg.color[1] * g3;
        col[o + 2] = cfg.color[2] * g3;
        break;
      case 'sand':
        pos[o] -= cfg.speed * s.speed * dt;
        pos[o + 1] += Math.sin(t * 1.4 + s.phase) * 0.35 * dt;
        if (pos[o] < -15) {
          const p = randomAmbientPoint(cfg, false);
          pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
        }
        break;
      case 'star':
        pos[o] += Math.sin(t * 0.35 + s.phase) * cfg.speed * dt;
        pos[o + 1] += Math.cos(t * 0.5 + s.phase * 1.3) * cfg.speed * 0.5 * dt;
        const glow2 = 0.45 + 0.55 * Math.max(0, Math.sin(t * 1.1 + s.phase));
        col[o] = cfg.color[0] * glow2;
        col[o + 1] = cfg.color[1] * glow2;
        col[o + 2] = cfg.color[2] * glow2;
        break;
      default:
        break;
    }
  }

  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
}

/* ----------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------- */
function loadGroundTextures(renderer, mapId) {
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // 一格贴图铺 GROUND_TILE 个世界单位。铺多大是关键参数：
  // 太小会糊（纹理颗粒比屏幕像素还细，被平均掉），太大会失真。
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

  const set = {
    map: load(`${mapId}-diff`, true),
    normalMap: load(`${mapId}-nor_gl`, false),
    roughnessMap: load(`${mapId}-rough`, false),
  };

  // 预加载好的贴图直接给出去；没预加载过就返回一组"还在加载"的纹理。
  // flushGroundTextures 会在贴图到位后把它们贴到地面上，
  // 所以切图不会出现"先灰一片、过一会才变"的跳变。
  return set;
}

/* ----------------------------------------------------------
 * 贴图预加载
 *
 * 新地图的贴图是 2k 的，一张图三件套约 3.7MB。按需加载会让切图瞬间
 * 出现一片没有贴图的灰地面，所以：
 *   1. 进游戏前先预加载「当前选中的地图」
 *   2. 切图时如果目标图还没加载好，在淡出黑屏期间等它
 * 用户明确说过"体积先不管，加载完再展示"，所以这里优先体验。
 * ---------------------------------------------------------- */
const groundTexCache = new Map();   // mapId → { map, normalMap, roughnessMap } | 'loading'

function groundTextureUrl(mapId, kind) {
  return new URL(`../assets/${mapId}-${kind}.jpg`, import.meta.url).href;
}

/** 预加载一张地图的地面贴图。已在加载/已加载则复用同一个 Promise */
export function preloadGroundTexture(mapId) {
  const hit = groundTexCache.get(mapId);
  if (hit && hit !== 'loading') return Promise.resolve(hit);
  if (hit === 'loading') {
    return groundPreloadPromises.get(mapId) || Promise.resolve(null);
  }

  groundTexCache.set(mapId, 'loading');
  const loader = new THREE.TextureLoader();

  const one = (kind) => new Promise((res) => {
    loader.load(
      groundTextureUrl(mapId, kind),
      (t) => res(t),
      undefined,
      () => res(null)     // 加载失败也 resolve，别让整张图卡住
    );
  });

  const p = Promise.all([one('diff'), one('nor_gl'), one('rough')]).then(([diff, nor, rough]) => {
    if (!diff) { groundTexCache.delete(mapId); return null; }

    const rx = GROUND_W / GROUND_TILE;
    const ry = GROUND_H / GROUND_TILE;
    const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
    const setup = (t, isColor) => {
      if (!t) return null;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.anisotropy = maxAniso;
      if (isColor) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    };
    const set = {
      map: setup(diff, true),
      normalMap: setup(nor, false),
      roughnessMap: setup(rough, false),
    };
    groundTexCache.set(mapId, set);
    groundPreloadPromises.delete(mapId);
    return set;
  });

  groundPreloadPromises.set(mapId, p);
  return p;
}

const groundPreloadPromises = new Map();

/** 把缓存里的贴图贴到地面材质上（切图后调用；没缓存就现加载再贴） */
function flushGroundTexture(mapId) {
  const apply = (set) => {
    if (!groundMesh || !set) return;
    const gm = groundMesh.material;
    if (gm.map && gm.map !== set.map) gm.map.dispose();
    if (gm.normalMap && gm.normalMap !== set.normalMap) gm.normalMap.dispose();
    if (gm.roughnessMap && gm.roughnessMap !== set.roughnessMap) gm.roughnessMap.dispose();
    gm.map = set.map;
    gm.normalMap = set.normalMap;
    gm.roughnessMap = set.roughnessMap;
    gm.needsUpdate = true;
  };

  const hit = groundTexCache.get(mapId);
  if (hit && hit !== 'loading') { apply(hit); return; }
  preloadGroundTexture(mapId).then(apply);
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
