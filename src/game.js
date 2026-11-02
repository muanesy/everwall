/* ==========================================================
 * 玩法逻辑（甲负责）
 *
 * 玩法：
 * - 我方士兵在屏幕下方，左右移动，自动向上开火
 * - 屏幕左半边不断压下来一排排绿色 +1 屏障
 *   子弹打中一次，士兵 +1；屏障在屏幕外时打不到
 * - 屏幕右半边是大量僵尸，冲到最下面会让士兵减员
 * - 士兵归零，游戏结束
 *
 * 这里不做任何画面渲染。想让特效出现，就 emit 一个事件。
 * ========================================================== */

import {
  initVisuals,
  syncScene,
  hitBarrel,
  spawnBarrel,
  switchEra,
  pickEraMap,
} from './visuals.js';
import { initUI, updateUI } from './ui.js';

// 测试开关：true = 五个槽位默认解锁（含路障），方便逐个测试
// 测试完改回 false，槽位就会重新走抽卡解锁
const UNLOCK_ALL_SLOTS_FOR_TEST = true;

// 起始地图：开始页传入的 ?map=，默认废墟街道
const START_MAP =
  new URLSearchParams(window.location.search).get('map') || 'city';

/* ----------------------------------------------------------
 * 数值区：调难度和手感只改这里
 * ---------------------------------------------------------- */
const CONFIG = {
  world: {
    halfWidth: 8,
    playerZ: 9,
    spawnZ: -26,       // 在屏幕上方之外出生
    screenTopZ: -21.5, // 越过这条线才算进入屏幕，+1 屏障才能被打中
    touchZ: 8.2,       // 僵尸碰到士兵的判定线
    killZ: 8.4,        // 僵尸走到这条线就停住，沿防线滑向士兵，永远不越线
    leftZone: [-7.6, -0.6],  // +1 屏障出现的横向范围
    rightZone: [0.6, 7.6],   // 僵尸出现的横向范围
  },
  player: {
    speed: 14,
    baseFireInterval: 0.5, // 1 个士兵时的射击间隔
    bulletSpeed: 28,
    bulletDamage: 10,
    maxVolley: 5,          // 总火力上限，越大总射速越高
    // 兵种阶级：门槛和 visuals-tiers.js 的 5/20/50 保持一致
    tiers: [
      { min: 0, name: '保安', damage: 1.0, fireInterval: 0.18 },
      { min: 20, name: '正规军', damage: 1.15, fireInterval: 0.17 },
      { min: 50, name: '特种兵', damage: 1.35, fireInterval: 0.16 },
    ],
  },
  weapon: {
    maxLines: 8,         // 最多几个枪位
    jitterBase: 0.01,    // 枪口抖动
    pierceChance: 0.08,  // 穿透器：每命中一只僵尸后继续穿透的概率
    pierceMax: 3,        // 一颗子弹最多穿透几次
  },
  formation: {
    spacing: 0.42,       // 前排士兵之间的横向间距
    rowGap: 0.32,        // 排与排之间的纵向间距
    maxSoldiers: 120,    // 最多显示多少个士兵
  },
  card: {
    everyWaves: 2,       // 每几波抽一次
    slowMo: 0.25,        // 抽卡时全场慢放倍率
    duration: 10,        // 选择时间，秒
  },
  slots: {
    siege: { x: 4.5, z: 15, interval: 6, radius: 2.6, damage: 30 },        // 攻城，后排右
    support: { x: -4.5, z: 15, interval: 10, heal: 1 },                    // 支援，后排左
    command: { x: 0, z: 15, fireRate: 0.05 },                              // 指挥，后排中
    closeDefense: { x: 5.5, z: 4.5, interval: 0.5, radius: 3.0, damage: 8 },// 近防，前排右
    // 工事就是路障本身，位置在 CONFIG.barricade
  },
  barrel: {
    damageBase: 20,      // 炸药桶爆炸伤害的基础值
    damagePerWave: 4,    // 每波增加的伤害
    spawnInterval: 12,   // 每隔多少秒尝试补一个桶
  },
  barricade: {
    xMin: -0.4,          // 路障左边界，避开左边屏障通道
    z: 0,                // 路障所在纵深，接近屏幕中央
    blockZ: -0.6,        // 僵尸停在墙前的位置
    hitDamage: 6,        // 僵尸每啃一口的伤害
    attackInterval: 0.9, // 每只僵尸的啃咬间隔
    cooldown: 10,        // 碎掉后多久重建
    bossMultiplier: 3,   // Boss 对路障的伤害倍率
    // 等级 1-5：血量、每次反击伤害、横向宽度
    // 满级宽度 8.0，左边界 -0.4，右边界 7.6，刚好盖住僵尸的整条路
    levels: [
      { hp: 240, damage: 0,  width: 4.2 },
      { hp: 300, damage: 8,  width: 5.2 },
      { hp: 360, damage: 16, width: 6.2 },
      { hp: 420, damage: 26, width: 7.1 },
      { hp: 480, damage: 40, width: 8.0 },
    ],
  },
  barrier: {
    speed: 6.5,            // 压下来的速度
    spawnInterval: 2.4,
    rowGap: 1.44,          // 横向间隔，铺满左半边
    staggerRange: 8,       // 同一批屏障在纵向错开的范围，避免排成一条直线
    positiveBase: 1,       // 普通屏障的基础加兵数
    positiveStepWaves: 3,  // 每几波升级一次
    positiveMax: 5,        // 普通屏障最多 +5
    negativeMin: 10,       // 负数屏障最少扣 10
    negativeBase: 30,      // 初始扣血上限的基础值
    negativeGrowth: 2,     // 每波上限增加，比之前慢
    capMin: 10,            // 打满后的下限
    capBase: 30,           // 打满上限的基础值
    capGrowth: 3,          // 每波打满上限增加，比之前慢
    negativeChanceBase: 0.15,   // 负数屏障的基础概率
    negativeChancePerWave: 0.02, // 每波增加
    negativeChanceMax: 0.35,    // 概率上限
    greyChance: 0.35,           // 负数屏障里有多少比例是灰色的
    negativeLengthEveryWaves: 4, // 灰色屏障每几波变长一次
    negativeLengthMax: 3,        // 灰色屏障最长占几个格子
    weaponChance: 0.02,          // 火力增援屏障的出现概率
    piercerChance: 0.02,         // 穿透器的出现概率
    weaponHitsBase: 30,          // 火力增援需要的基础命中数
    weaponHitsPerWave: 6,        // 每波增加
    piercerHitsBase: 20,         // 穿透器需要的基础命中数
    piercerHitsPerWave: 4,       // 每波增加
  },
  zombie: {
    baseHp: 20,
    hpPerWave: 8,
    baseSpeed: 3.2,
    speedPerWave: 0.25,
    nightSpeedMul: 1.15, // 夜晚僵尸移速加成
    maxSpeed: 7.5,
    speedCap: 9,       // 快鬼加速后也不会超过这个速度
    spawnInterval: 0.35,
    minSpawnInterval: 0.16,
    intervalPerWave: 0.02,
    maxAlive: 120,
    aggroStartZ: 1,        // 比原来多一点点距离就开始拐弯
    aggroRadius: 6,        // 主动拐弯的范围
    turnSpeed: 3.8,        // 主动追击时的侧向速度，放慢一些
    lineSlideSpeed: 15,    // 到线后沿防线滑向士兵的速度，必须快过士兵
    touchBase: 0.9,        // 士兵阵型的基础接触半宽
    touchPerSoldier: 0.04, // 每多一个兵，接触范围加多少
    touchMaxBonus: 0.6,    // 接触范围最多额外加多少
    separation: 0.6,     // 僵尸之间的最小间距，防止叠成一坨

    // 0-4 的编号和 visuals.js 约定一致，改编号要两边一起改
    // baseWeight 是刚解锁时的权重，growth 是每波增减，minWeight / maxWeight 是上下限
    types: [
      { id: 0, name: '普通',   hp: 1.0, speed: 1.00, touchLoss: 1, score: 1, baseWeight: 50, growth: -1,  minWeight: 30, minWave: 1 },
      { id: 1, name: '大块头', hp: 2.5, speed: 0.70, touchLoss: 2, score: 3, baseWeight: 15, growth: 1.2, maxWeight: 28, minWave: 2 },
      { id: 2, name: '快鬼',   hp: 0.5, speed: 1.50, touchLoss: 1, score: 1, baseWeight: 22, growth: 0,                    minWave: 1 },
      { id: 3, name: '精英',   hp: 3.5, speed: 0.85, touchLoss: 3, score: 5, baseWeight: 6,  growth: 0.5, maxWeight: 12, minWave: 3 },
      { id: 4, name: '女僵尸', hp: 1.2, speed: 1.10, touchLoss: 1, score: 2, baseWeight: 12, growth: 0,                    minWave: 1 },
    ],
  },
  wave: {
    duration: 15,
  },
  era: {
    count: 6,          // 六个时代
    everyWaves: 4,     // 每 4 波进一个时代
  },
};

/* ----------------------------------------------------------
 * 游戏状态
 * visuals.js 和 ui.js 只读这里，不要从外部改。
 * ---------------------------------------------------------- */
const state = {
  status: 'menu', // menu | playing | over
  time: 0,
  wave: 1,
  score: 0,
  soldiers: 5,

  era: 0,
  mapId: START_MAP,
  usedMaps: [START_MAP],

  player: {
    x: 0,
    z: CONFIG.world.playerZ,
  },

  // 武器状态：默认一个枪位，没有扩散
  weapon: {
    lines: 1,
    pierce: false,
    timers: [0], // 每个枪位各自的发射计时，错开节奏
  },

  // 阵型：前排人数，由士兵总数算出来
  formation: {
    frontCount: 1,
  },

  // 抽卡和永久升级
  upgrades: {
    damage: 1,          // 士兵伤害倍率
    moveSpeed: 1,       // 士兵移速倍率
    damageReduction: 0, // 士兵受到伤害的减免
    barrelDamage: 1,    // 炸药桶伤害倍率
    fireRate: 1,        // 射速倍率
  },
  card: {
    active: false,
    choices: [],
    timeLeft: 0,
    version: 0,
  },
  timeScale: 1,
  // 槽位默认全部锁定，抽到对应卡才生效
  slots: { siege: false, support: false, closeDefense: false, command: false },
  slotTimers: { siege: 3, support: 6, closeDefense: 0 },
  slowUntil: 0,
  slowMul: 1,
  buffUntil: 0,
  buffMul: 1,

  // 路障：抽到卡才出现，挡在前排，有血量，碎了冷却后重建
  barricade: {
    unlocked: false,
    level: 0,
    hp: 0,
    maxHp: 240,
    active: false,
    cooldown: 0,
    xMin: -0.4,
    xMax: 3.8,
    width: 4.2,
    damage: 0,
  },

  bullets: [],  // { id, x, z, vz, damage }
  barriers: [], // { id, x, z, hp, speed }
  zombies: [],  // { id, x, z, hp, speed, type }

  barrierTimer: 0,
  zombieTimer: 0,
  barrelTimer: 0,
  nextId: 1,
  spawnCounts: [0, 0, 0, 0, 0], // 调试用：统计每种僵尸刷了多少只
};

// 调试用：浏览器控制台输入 __state 可以看实时数据
window.__state = state;

const events = new EventTarget();

const input = {
  left: false,
  right: false,
  pointerActive: false,
  pointerRatio: 0,
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// 兵种阶级：按士兵总数取当前档位
function getSoldierTier(soldiers) {
  const tiers = CONFIG.player.tiers;
  let current = tiers[0];
  for (const t of tiers) {
    if (soldiers >= t.min) current = t;
  }
  return current;
}

// 昼夜：每 3 波翻一次，和 visuals-daynight.js 的 nightForWave 一致
function isNight(wave) {
  return Math.floor((wave - 1) / 3) % 2 === 1;
}

// 士兵阵型的接触半宽：人越多站得越开，僵尸不需要滑到中心才算贴上
function formationHalfWidth() {
  return (
    CONFIG.zombie.touchBase +
    Math.min(
      CONFIG.zombie.touchMaxBonus,
      state.soldiers * CONFIG.zombie.touchPerSoldier
    )
  );
}
const emit = (name, detail = {}) =>
  events.dispatchEvent(new CustomEvent(name, { detail }));

/* ----------------------------------------------------------
 * 初始化
 * ---------------------------------------------------------- */
initVisuals(document.getElementById('game-container'), events);

initUI(state, {
  start: startGame,
  restart: startGame,
  revive: revive,
  chooseCard,
});

// 炸药桶爆炸：乙负责画面，这里按半径结算僵尸伤害
events.addEventListener('barrelExploded', (e) => {
  const detail = e.detail || {};
  const { x, z } = detail;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;

  const radius = Number.isFinite(detail.radius) ? detail.radius : 3.2;
  const damage =
    (CONFIG.barrel.damageBase +
      (state.wave - 1) * CONFIG.barrel.damagePerWave) *
    state.upgrades.barrelDamage;
  const r2 = radius * radius;

  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const zb = state.zombies[i];
    const dx = zb.x - x;
    const dz = zb.z - z;
    if (dx * dx + dz * dz > r2) continue;

    zb.hp -= damage;
    if (zb.hp <= 0) {
      state.zombies.splice(i, 1);
      state.score += CONFIG.zombie.types[zb.type]?.score || 1;
      emit('zombieDie', { x: zb.x, z: zb.z, type: zb.type });
    }
  }
});

/* ----------------------------------------------------------
 * 输入：键盘 + 触摸拖动
 * ---------------------------------------------------------- */
window.addEventListener('keydown', (e) => {
  if (state.card.active && (e.key === '1' || e.key === '2' || e.key === '3')) {
    chooseCard(Number(e.key) - 1);
    return;
  }

  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = true;
  if (e.key.startsWith('Arrow')) e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = false;
});

window.addEventListener('pointerdown', (e) => {
  input.pointerActive = true;
  input.pointerRatio = (e.clientX / window.innerWidth) * 2 - 1;
});

window.addEventListener('pointermove', (e) => {
  if (!input.pointerActive) return;
  input.pointerRatio = (e.clientX / window.innerWidth) * 2 - 1;
});

window.addEventListener('pointerup', () => {
  input.pointerActive = false;
});

window.addEventListener('pointercancel', () => {
  input.pointerActive = false;
});

/* ----------------------------------------------------------
 * 开局 / 复活
 * ---------------------------------------------------------- */
function resetState() {
  state.status = 'playing';
  state.time = 0;
  state.wave = 1;
  state.score = 0;
  state.soldiers = 5;
  state.player.x = 0;
  state.era = 0;
  state.mapId = START_MAP;
  state.usedMaps = [START_MAP];
  state.weapon.lines = 1;
  state.weapon.pierce = false;
  state.weapon.timers = [0];

  state.upgrades.damage = 1;
  state.upgrades.moveSpeed = 1;
  state.upgrades.damageReduction = 0;
  state.upgrades.barrelDamage = 1;
  state.upgrades.fireRate = 1;

  state.card.active = false;
  state.card.choices = [];
  state.card.timeLeft = 0;
  state.timeScale = 1;

  state.slots.siege = false;
  state.slots.support = false;
  state.slots.closeDefense = false;
  state.slots.command = false;

  state.slotTimers.siege = 3;
  state.slotTimers.support = 6;
  state.slotTimers.closeDefense = 0;
  state.slowUntil = 0;
  state.slowMul = 1;
  state.buffUntil = 0;
  state.buffMul = 1;

  state.bullets.length = 0;
  state.barriers.length = 0;
  state.zombies.length = 0;

  state.barrierTimer = 0.6;
  state.zombieTimer = 1.0;
  state.barrelTimer = CONFIG.barrel.spawnInterval;
  state.nextId = 1;
  state.spawnCounts.fill(0);
  resetBarricade();

  if (UNLOCK_ALL_SLOTS_FOR_TEST) {
    state.slots.siege = true;
    state.slots.support = true;
    state.slots.closeDefense = true;
    state.slots.command = true;
    unlockBarricade();
  }

  // 把画面拉回第一个时代和起始地图，静默切换，不弹提示
  switchEra(0, START_MAP, { fade: false, silent: true });
}

function startGame() {
  resetState();
}

function revive() {
  if (state.status !== 'over') return;

  state.status = 'playing';
  // 复活兵力随波次增长，后期看广告复活不至于等于送死
  state.soldiers = 20 + 3 * state.wave;
  state.bullets.length = 0;
  state.barriers.length = 0;
  state.zombies.length = 0;
  state.barrierTimer = 0.4;
  state.zombieTimer = 0.8;

  // 复活保留已经解锁的路障，并把它修好；没解锁就保持没有
  const b = state.barricade;
  if (b.unlocked) {
    b.active = true;
    b.hp = b.maxHp;
    b.cooldown = 0;
    emit('barricadeRebuild', {});
  }
}

function barricadeStats(level) {
  const levels = CONFIG.barricade.levels;
  const i = Math.min(levels.length - 1, Math.max(0, Math.floor(level) - 1));
  return levels[i];
}

function applyBarricadeLevel(level, opts = {}) {
  const b = state.barricade;
  const next = Math.min(
    CONFIG.barricade.levels.length,
    Math.max(1, Math.floor(level))
  );
  const stats = barricadeStats(next);
  const prevMax = b.maxHp || stats.hp;

  b.unlocked = true;
  b.level = next;
  b.maxHp = stats.hp;
  b.width = stats.width;
  b.xMin = CONFIG.barricade.xMin;
  b.xMax = CONFIG.barricade.xMin + stats.width;
  b.damage = stats.damage;

  if (opts.full) b.hp = b.maxHp;
  else b.hp = Math.min(b.maxHp, b.hp + Math.max(0, stats.hp - prevMax));
}

function resetBarricade() {
  const b = state.barricade;
  b.unlocked = false;
  b.level = 0;
  b.hp = 0;
  b.active = false;
  b.cooldown = 0;
  b.damage = 0;
  b.width = 4.2;
  b.xMin = CONFIG.barricade.xMin;
  b.xMax = CONFIG.barricade.xMin + 4.2;
}

function unlockBarricade() {
  const b = state.barricade;
  if (b.unlocked) return;

  b.unlocked = true;
  b.active = true;
  b.cooldown = 0;
  applyBarricadeLevel(1, { full: true });
  emit('barricadeRebuild', {});
}

// 以后抽卡升级路障时调用；先暴露到 window 方便调试
function upgradeBarricade() {
  if (!state.barricade.unlocked) {
    unlockBarricade();
    return;
  }
  applyBarricadeLevel(state.barricade.level + 1);
  emit('barricadeUpgrade', { level: state.barricade.level });
}

if (typeof window !== 'undefined') {
  window.__setBarricadeLevel = (n) => {
    applyBarricadeLevel(n, { full: true });
    emit('barricadeUpgrade', { level: state.barricade.level });
  };
  window.__upgradeBarricade = upgradeBarricade;
  window.__castSkill = castSkill;
}

/* ----------------------------------------------------------
 * 抽卡
 * ---------------------------------------------------------- */
const CARD_POOL = [
  {
    id: 'barricadeUnlock',
    name: '路障',
    desc: '解锁路障，挡住前排僵尸',
    can: () => !state.barricade.unlocked,
    apply: () => unlockBarricade(),
  },
  {
    id: 'barricadeUpgrade',
    name: '路障升级',
    desc: '路障 +1 级，血量和宽度提升',
    can: () => state.barricade.unlocked &&
      state.barricade.level < CONFIG.barricade.levels.length,
    apply: () => upgradeBarricade(),
  },
  {
    id: 'slotSiege',
    name: '攻城槽',
    desc: '解锁攻城：每 6 秒范围炮击',
    can: () => !state.slots.siege,
    apply: () => {
      state.slots.siege = true;
      emit('slotUnlock', { id: 'siege' });
    },
  },
  {
    id: 'slotClose',
    name: '近防槽',
    desc: '解锁近防：持续打身边的僵尸',
    can: () => !state.slots.closeDefense,
    apply: () => {
      state.slots.closeDefense = true;
      emit('slotUnlock', { id: 'closeDefense' });
    },
  },
  {
    id: 'slotSupport',
    name: '支援槽',
    desc: '解锁支援：每 10 秒回兵',
    can: () => !state.slots.support,
    apply: () => {
      state.slots.support = true;
      emit('slotUnlock', { id: 'support' });
    },
  },
  {
    id: 'slotCommand',
    name: '指挥槽',
    desc: '解锁指挥：全队射速 +5%',
    can: () => !state.slots.command,
    apply: () => {
      state.slots.command = true;
      emit('slotUnlock', { id: 'command' });
    },
  },
  {
    id: 'damage',
    name: '火力强化',
    desc: '士兵伤害 +15%',
    can: () => state.upgrades.damage < 2,
    apply: () => { state.upgrades.damage = Math.min(2, state.upgrades.damage * 1.15); },
  },
  {
    id: 'speed',
    name: '急行军',
    desc: '士兵移速 +10%',
    can: () => state.upgrades.moveSpeed < 1.5,
    apply: () => { state.upgrades.moveSpeed = Math.min(1.5, state.upgrades.moveSpeed * 1.1); },
  },
  {
    id: 'armor',
    name: '护甲',
    desc: '士兵受到的伤害 -10%',
    can: () => state.upgrades.damageReduction < 0.5,
    apply: () => { state.upgrades.damageReduction = Math.min(0.5, state.upgrades.damageReduction + 0.1); },
  },
  {
    id: 'barrel',
    name: '炸药桶强化',
    desc: '爆炸伤害 +30%',
    can: () => state.upgrades.barrelDamage < 2.5,
    apply: () => { state.upgrades.barrelDamage = Math.min(2.5, state.upgrades.barrelDamage * 1.3); },
  },
  {
    id: 'fireRate',
    name: '快速射击',
    desc: '全队射速 +8%',
    can: () => state.upgrades.fireRate < 1.5,
    apply: () => { state.upgrades.fireRate = Math.min(1.5, state.upgrades.fireRate * 1.08); },
  },
  {
    id: 'gun',
    name: '火力增援',
    desc: '枪位 +1，最多 8 个',
    can: () => state.weapon.lines < CONFIG.weapon.maxLines,
    apply: () => { state.weapon.lines = Math.min(CONFIG.weapon.maxLines, state.weapon.lines + 1); },
  },
];

/* 一次性技能：抽到就立刻释放，按效果类型走通用逻辑 */
const SKILL_DEFS = [
  // 0 中世纪
  { id: 'arrowRain', name: '箭雨', era: 0, type: 'line', damage: 40, radius: 2.6, color: 0xd9b36c },
  { id: 'rollingLog', name: '滚木', era: 0, type: 'line', damage: 60, radius: 2.0, color: 0x9c6b3f },
  { id: 'holyWater', name: '圣水', era: 0, type: 'heal', soldiers: 2, color: 0x8fe3b0 },
  { id: 'knightCharge', name: '骑士冲锋', era: 0, type: 'aoe', damage: 50, radius: 3.0, color: 0xc9d4e0 },
  { id: 'campfire', name: '篝火', era: 0, type: 'aoe', damage: 30, radius: 3.5, color: 0xff9a4d },
  // 1 二战
  { id: 'airStrike', name: '空袭', era: 1, type: 'aoe', damage: 90, radius: 4.0, color: 0xffd27a },
  { id: 'barrage', name: '炮火覆盖', era: 1, type: 'line', damage: 70, radius: 3.0, color: 0xff8a4d },
  { id: 'napalm', name: '燃烧弹', era: 1, type: 'aoe', damage: 45, radius: 3.5, color: 0xff6a2a },
  { id: 'paratroopers', name: '伞兵增援', era: 1, type: 'heal', soldiers: 10, color: 0x8fb6e0 },
  { id: 'tank', name: '坦克支援', era: 1, type: 'line', damage: 80, radius: 3.0, color: 0xb0b8a0 },
  // 2 现代
  { id: 'precision', name: '精确打击', era: 2, type: 'aoe', damage: 110, radius: 2.2, color: 0x9fe3ff },
  { id: 'droneSwarm', name: '无人机蜂群', era: 2, type: 'aoe', damage: 60, radius: 4.5, color: 0x7fd4ff },
  { id: 'emp', name: '电磁脉冲', era: 2, type: 'slow', duration: 2, mul: 0.05, color: 0x6fa8ff },
  { id: 'apc', name: '装甲车冲锋', era: 2, type: 'line', damage: 70, radius: 3.0, color: 0x8f9a7a },
  { id: 'supplyDrop', name: '空投补给', era: 2, type: 'heal', soldiers: 15, color: 0x5adf7a },
  // 3 后现代
  { id: 'virusBomb', name: '病毒炸弹', era: 3, type: 'aoe', damage: 80, radius: 4.0, color: 0x8fe36a },
  { id: 'bioLegion', name: '生物人军团', era: 3, type: 'heal', soldiers: 8, color: 0x9c6bff },
  { id: 'geneBurst', name: '基因爆发', era: 3, type: 'buff', duration: 5, mul: 2, color: 0x6dffb0 },
  { id: 'timeSlow', name: '时间减速', era: 3, type: 'slow', duration: 4, mul: 0.5, color: 0x8fb6ff },
  { id: 'memory', name: '记忆植入', era: 3, type: 'upgradeSlot', color: 0xd0a0ff },
  // 4 星际
  { id: 'orbital', name: '轨道轰炸', era: 4, type: 'line', damage: 130, radius: 3.5, color: 0x7fe3ff },
  { id: 'blackHole', name: '黑洞', era: 4, type: 'pull', damage: 40, radius: 4.0, color: 0x6a4dff },
  { id: 'wormhole', name: '虫洞', era: 4, type: 'warp', color: 0xb06bff },
  { id: 'fleetSalvo', name: '舰队齐射', era: 4, type: 'line', damage: 100, radius: 3.0, color: 0x9fe3ff },
  { id: 'timeDilation', name: '时间膨胀', era: 4, type: 'slow', duration: 3, mul: 0.4, color: 0x8fb6ff },
  // 5 终幕
  { id: 'finalJudgment', name: '终焉审判', era: 5, type: 'aoe', damage: 200, radius: 6.0, color: 0xffffff },
  { id: 'cosmicCollapse', name: '宇宙坍缩', era: 5, type: 'pull', damage: 80, radius: 6.0, color: 0x6a4dff },
  { id: 'sacrifice', name: '献祭', era: 5, type: 'sacrifice', damage: 300, soldiers: 20, color: 0xff5a5a },
  { id: 'reboot', name: '重启', era: 5, type: 'clear', color: 0xffffff },
  { id: 'entropy', name: '熵增', era: 5, type: 'slow', duration: 5, mul: 0.5, damage: 8, color: 0x8a8f99 },
];

const SKILL_DESCS = {
  arrowRain: '横排箭雨，对一整条线造成 40 点伤害',
  rollingLog: '滚木横扫一条线，60 点伤害',
  holyWater: '圣水回复 2 个兵',
  knightCharge: '骑士冲锋，对最密的一群造成 50 点伤害',
  campfire: '篝火点燃一片区域，30 点伤害',
  airStrike: '空袭，对最密的一群造成 90 点伤害',
  barrage: '炮火覆盖一整条横线，70 点伤害',
  napalm: '燃烧弹，45 点范围伤害',
  paratroopers: '空降 10 个兵',
  tank: '坦克碾过一条横线，80 点伤害',
  precision: '精确打击，110 点范围伤害',
  droneSwarm: '无人机蜂群，60 点大范围伤害',
  emp: '电磁脉冲，全场僵尸减速 2 秒',
  apc: '装甲车冲锋，一条横线 70 点伤害',
  supplyDrop: '空投补给，增加 15 个兵',
  virusBomb: '病毒炸弹，80 点范围伤害',
  bioLegion: '生物人军团，增加 8 个兵',
  geneBurst: '基因爆发，全队射速翻倍 5 秒',
  timeSlow: '时间减速，全场僵尸减速 50%，持续 4 秒',
  memory: '记忆植入，路障 +1 级',
  orbital: '轨道轰炸，横排 130 点伤害',
  blackHole: '黑洞把周围僵尸吸到一点，并造成 40 点伤害',
  wormhole: '虫洞把最靠前的僵尸送回屏幕顶端',
  fleetSalvo: '舰队齐射，横排 100 点伤害',
  timeDilation: '时间膨胀，全场慢放 3 秒',
  finalJudgment: '终焉审判，200 点大范围伤害',
  cosmicCollapse: '宇宙坍缩，把大范围僵尸拉向中心，80 点伤害',
  sacrifice: '献祭 20 个兵，对全场僵尸造成 300 点伤害',
  reboot: '重启，清空场上所有僵尸',
  entropy: '熵增，全场僵尸减速并持续掉 8 点血',
};

function densestPoint() {
  if (!state.zombies.length) return null;

  let best = state.zombies[0];
  let bestCount = -1;

  for (const z of state.zombies) {
    let count = 0;
    for (const o of state.zombies) {
      const dx = o.x - z.x;
      const dz = o.z - z.z;
      if (dx * dx + dz * dz <= 9) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = z;
    }
  }

  return { x: best.x, z: best.z };
}

function damageZombieAt(index, damage) {
  const zb = state.zombies[index];
  zb.hp -= damage;
  if (zb.hp > 0) return false;

  state.zombies.splice(index, 1);
  state.score += CONFIG.zombie.types[zb.type]?.score || 1;
  emit('zombieDie', { x: zb.x, z: zb.z, type: zb.type });
  return true;
}

function damageZombiesInRadius(x, z, radius, damage) {
  const r2 = radius * radius;
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const zb = state.zombies[i];
    const dx = zb.x - x;
    const dz = zb.z - z;
    if (dx * dx + dz * dz <= r2) damageZombieAt(i, damage);
  }
}

function damageZombiesInLine(z, radius, damage) {
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    if (Math.abs(state.zombies[i].z - z) <= radius) damageZombieAt(i, damage);
  }
}

function clearZombies() {
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    damageZombieAt(i, Infinity);
  }
}

function castSkill(id) {
  const def = SKILL_DEFS.find((s) => s.id === id);
  if (!def) return false;

  const target = densestPoint() || { x: 0, z: -6 };
  const announce = () => emit('skillCast', {
    id: def.id,
    name: def.name,
    type: def.type,
    x: target.x,
    z: target.z,
    radius: def.radius || 0,
    color: def.color,
  });

  switch (def.type) {
    case 'aoe':
      damageZombiesInRadius(target.x, target.z, def.radius, def.damage);
      break;
    case 'line':
      damageZombiesInLine(target.z, def.radius, def.damage);
      break;
    case 'slow':
      state.slowUntil = state.time + def.duration;
      state.slowMul = def.mul;
      if (def.damage) damageZombiesInRadius(target.x, target.z, 30, def.damage);
      break;
    case 'buff':
      state.buffUntil = state.time + def.duration;
      state.buffMul = def.mul;
      break;
    case 'heal':
      applySoldiers(def.soldiers);
      break;
    case 'upgradeSlot':
      upgradeBarricade();
      break;
    case 'pull':
      for (const zb of state.zombies) {
        const dx = target.x - zb.x;
        const dz = target.z - zb.z;
        const d = Math.hypot(dx, dz) || 1;
        const step = Math.min(d, 2.5);
        zb.x += (dx / d) * step;
        zb.z += (dz / d) * step;
      }
      damageZombiesInRadius(target.x, target.z, def.radius, def.damage);
      break;
    case 'warp': {
      const front = state.zombies.reduce(
        (a, b) => (b.z > a.z ? b : a),
        state.zombies[0]
      );
      if (front) {
        front.z = -20;
        front.aggro = false;
      }
      break;
    }
    case 'sacrifice':
      if (state.soldiers > def.soldiers) {
        applySoldiers(-def.soldiers);
        damageZombiesInRadius(0, -6, 40, def.damage);
      }
      break;
    case 'clear':
      clearZombies();
      break;
    default:
      break;
  }

  announce();
  return true;
}

function buildCardPool() {
  const skills = SKILL_DEFS
    .filter((s) => s.era === state.era)
    .map((s) => ({
      id: 'skill_' + s.id,
      name: s.name,
      desc: SKILL_DESCS[s.id] || '一次性技能，抽到立刻释放',
      can: () => true,
      apply: () => castSkill(s.id),
    }));

  return CARD_POOL.concat(skills);
}

function startCardDraw() {
  if (state.card.active) return;

  const pool = buildCardPool().filter((c) => c.can());
  if (!pool.length) return;

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  state.card.active = true;
  state.card.choices = pool.slice(0, 3);
  state.card.timeLeft = CONFIG.card.duration;
  state.card.version += 1;
  state.timeScale = CONFIG.card.slowMo;
  emit('cardStart', { choices: state.card.choices.map((c) => c.id) });
}

function chooseCard(index) {
  if (!state.card.active) return;

  const card = state.card.choices[index];
  if (!card) return;

  card.apply();
  state.card.active = false;
  state.card.choices = [];
  state.card.timeLeft = 0;
  state.timeScale = 1;
  emit('cardChosen', { id: card.id });
}

function updateCard(realDt) {
  if (!state.card.active) return;

  state.card.timeLeft -= realDt;
  if (state.card.timeLeft > 0) return;

  // 超时优先拿防御类，没有再拿第一张
  const preferred = state.card.choices.findIndex(
    (c) => c.id === 'armor' ||
      c.id === 'barricadeUnlock' ||
      c.id === 'barricadeUpgrade'
  );
  chooseCard(preferred >= 0 ? preferred : 0);
}

/* ----------------------------------------------------------
 * 每帧更新
 * ---------------------------------------------------------- */
// 每 4 波进一个时代：换配色和地图，场上实体全部保留
function syncEraWithWave(wave) {
  const eraIndex = Math.min(
    CONFIG.era.count - 1,
    Math.floor((wave - 1) / CONFIG.era.everyWaves)
  );
  if (eraIndex === state.era) return;

  const map = pickEraMap(eraIndex, state.usedMaps) || state.mapId || START_MAP;

  state.era = eraIndex;
  state.mapId = map;
  state.usedMaps.push(map);

  // 只换时代配色和地图，场上僵尸、子弹、屏障全部保留
  switchEra(eraIndex, map);
}

function update(dt) {
  state.time += dt;

  const nextWave = Math.floor(state.time / CONFIG.wave.duration) + 1;
  if (nextWave !== state.wave) {
    const completed = nextWave - 1; // 刚结束的那一波
    state.wave = nextWave;
    syncEraWithWave(nextWave);
    emit('waveStart', { wave: nextWave });

    // 每 2 波结束抽一次
    if (completed > 0 && completed % CONFIG.card.everyWaves === 0) {
      startCardDraw();
    }
  }

  updateFormation();
  updatePlayer(dt);
  updateFiring(dt);
  updateBarrelSpawn(dt);
  updateBullets(dt);
  updateSlots(dt);
  updateBarriers(dt);
  updateZombies(dt);
}

// 前排人数：1+2+...+r >= 士兵数，r 就是前排宽度
function updateFormation() {
  const n = Math.min(state.soldiers, CONFIG.formation.maxSoldiers);
  state.formation.frontCount = Math.ceil((Math.sqrt(8 * n + 1) - 1) / 2);
}

function updatePlayer(dt) {
  let dir = 0;
  if (input.left) dir -= 1;
  if (input.right) dir += 1;

  if (input.pointerActive) {
    const targetX = input.pointerRatio * CONFIG.world.halfWidth;
    const diff = targetX - state.player.x;
    if (Math.abs(diff) > 0.15) dir = Math.sign(diff);
  }

  if (dir !== 0) {
    state.player.x = clamp(
      state.player.x + dir * CONFIG.player.speed * state.upgrades.moveSpeed * dt,
      -CONFIG.world.halfWidth,
      CONFIG.world.halfWidth
    );
  }
}

// 枪位从中间往两侧排：先中间两个，再依次向外，不会先占最左和最右
function shooterOffsets(count, width) {
  if (count <= 1) return [0];

  const max = CONFIG.weapon.maxLines;
  const step = width / Math.max(1, max - 1);
  const order = [];

  for (let k = 0; k < max; k++) {
    const rank = Math.floor(k / 2) + 0.5;
    const sign = k % 2 === 0 ? -1 : 1;
    order.push(sign * rank * step);
  }

  return order.slice(0, count);
}

function updateFiring(dt) {
  const shooters = state.weapon.lines;

  // 总射速由士兵数决定，拆到几个枪位上，总子弹数不变
  const baseCount = Math.min(
    CONFIG.player.maxVolley,
    1 + Math.floor(state.soldiers / 10)
  );
  const tier = getSoldierTier(state.soldiers);
  const baseInterval = Math.max(
    tier.fireInterval,
    CONFIG.player.baseFireInterval / Math.max(1, state.soldiers)
  );
  const commandMul = state.slots.command
    ? 1 + CONFIG.slots.command.fireRate * (1 + state.era * 0.2)
    : 1;
  const buffMul = state.time < state.buffUntil ? state.buffMul : 1;
  const effInterval = baseInterval / (state.upgrades.fireRate * commandMul * buffMul);
  const totalRate = baseCount / effInterval; // 每秒多少发
  const interval = shooters / totalRate;

  // 每个枪位各自计时，新枪位随机错开，避免整排同时开火
  const timers = state.weapon.timers;
  while (timers.length < shooters) {
    timers.push(Math.random() * interval * 0.6);
  }

  const front = state.formation;
  const width = Math.max(0, (front.frontCount - 1) * CONFIG.formation.spacing);
  const jitter = CONFIG.weapon.jitterBase * CONFIG.player.bulletSpeed;

  const origins = [];
  const offsets = shooterOffsets(shooters, width);

  for (let i = 0; i < shooters; i++) {
    timers[i] -= dt;
    if (timers[i] > 0) continue;

    timers[i] += interval;
    if (timers[i] < 0) timers[i] = interval;

    const x = state.player.x + offsets[i];
    const vx = (Math.random() * 2 - 1) * jitter;

    state.bullets.push({
      id: state.nextId++,
      x,
      z: state.player.z - 0.1,
      vx,
      vz: -CONFIG.player.bulletSpeed,
      damage: CONFIG.player.bulletDamage * tier.damage * state.upgrades.damage,
      pierces: 0,
    });

    origins.push({ x, z: state.player.z });
  }

  if (origins.length) {
    emit('shoot', { origins, x: state.player.x, z: state.player.z });
  }
}

/* ----------------------------------------------------------
 * 子弹：打屏障加人，打僵尸得分
 * ---------------------------------------------------------- */
// 动态补桶：场上最多 3 个，满了或位置太近时模块会拒绝
function updateBarrelSpawn(dt) {
  state.barrelTimer -= dt;
  if (state.barrelTimer > 0) return;

  state.barrelTimer = CONFIG.barrel.spawnInterval;

  const [minX, maxX] = CONFIG.world.rightZone;
  const x = minX + Math.random() * (maxX - minX);
  // 只补在路障上方，避免桶和墙重叠
  const z = -14 + Math.random() * 10;
  spawnBarrel(x, z);
}

function updateBullets(dt) {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x += (b.vx || 0) * dt;
    b.z += b.vz * dt;

    if (b.z < CONFIG.world.spawnZ - 1 || Math.abs(b.x) > 14) {
      state.bullets.splice(i, 1);
      continue;
    }

    // 打中炸药桶：点燃引信，子弹消失，爆炸伤害由 barrelExploded 结算
    if (hitBarrel(b.x, b.z, 0.45)) {
      state.bullets.splice(i, 1);
      continue;
    }

    let consumed = false;

    // 先判定 +1 屏障。屏幕外的屏障打不到。
    for (let j = state.barriers.length - 1; j >= 0; j--) {
      const bar = state.barriers[j];

      if (bar.z < CONFIG.world.screenTopZ) continue;

      if (
        Math.abs(b.x - bar.x) < bar.halfWidth + 0.12 &&
        Math.abs(b.z - bar.z) < 0.7
      ) {
        if (bar.kind === 'negative' || bar.kind === 'grey') {
          // 红色和灰色：每打一发 +1。红色打满给兵，灰色打满只消失
          bar.value += 1;
          emit('barrierHit', { x: bar.x, z: bar.z, value: bar.value });

          if (bar.value >= bar.maxValue) {
            if (bar.kind === 'negative') {
              applySoldiers(bar.value);
              emit('barrierApply', { x: bar.x, z: bar.z, value: bar.value });
            }
            state.barriers.splice(j, 1);
          }
        } else if (bar.kind === 'weapon' || bar.kind === 'pierce') {
          // 火力增援 / 扩散器：攒够命中才生效，没攒够就白打
          bar.hits += 1;
          emit('barrierHit', {
            x: bar.x,
            z: bar.z,
            kind: bar.kind,
            hits: bar.hits,
            required: bar.required,
          });

          if (bar.hits >= bar.required) {
            if (bar.kind === 'weapon') {
              state.weapon.lines = Math.min(
                CONFIG.weapon.maxLines,
                state.weapon.lines + 1
              );
              emit('weaponUpgrade', { lines: state.weapon.lines });
            } else {
              state.weapon.pierce = true;
              emit('pierceUnlock', {});
            }
            state.barriers.splice(j, 1);
          }
        } else {
          // 普通屏障：一发就碎，直接给当前数值（+1 到 +5，随波次升级）
          applySoldiers(bar.value);
          emit('barrierApply', { x: bar.x, z: bar.z, value: bar.value });
          state.barriers.splice(j, 1);
        }

        state.bullets.splice(i, 1);
        consumed = true;
        break;
      }
    }

    if (consumed) continue;

    // 再判定僵尸
    for (let j = state.zombies.length - 1; j >= 0; j--) {
      const z = state.zombies[j];

      if (Math.abs(b.x - z.x) < 0.72 && Math.abs(b.z - z.z) < 0.7) {
        z.hp -= b.damage;

        if (z.hp <= 0) {
          state.zombies.splice(j, 1);
          state.score += CONFIG.zombie.types[z.type].score;
          emit('zombieDie', { x: z.x, z: z.z, type: z.type });
        }

        // 穿透器：小概率不消耗子弹，继续打后面的僵尸
        const pierced =
          state.weapon.pierce &&
          (b.pierces || 0) < CONFIG.weapon.pierceMax &&
          Math.random() < CONFIG.weapon.pierceChance;

        if (pierced) {
          b.pierces = (b.pierces || 0) + 1;
          emit('bulletPierce', { x: b.x, z: b.z });
        } else {
          state.bullets.splice(i, 1);
          break;
        }
      }
    }
  }
}

/* ----------------------------------------------------------
 * +1 屏障：从屏幕外一排排压下来
 * ---------------------------------------------------------- */
function updateBarriers(dt) {
  state.barrierTimer -= dt;

  if (state.barrierTimer <= 0) {
    spawnBarrierRow();
    state.barrierTimer = CONFIG.barrier.spawnInterval;
  }

  for (let i = state.barriers.length - 1; i >= 0; i--) {
    const bar = state.barriers[i];
    bar.z += bar.speed * dt;

    // 碰到士兵：数值立刻生效，正的加兵，负的扣兵
    if (
      bar.z >= CONFIG.world.touchZ &&
      Math.abs(bar.x - state.player.x) < bar.halfWidth + 0.3
    ) {
      // 火力增援和扩散器错过就不生效，只有正负数屏障会结算
      if (
        bar.kind === 'normal' ||
        bar.kind === 'negative' ||
        bar.kind === 'grey'
      ) {
        applySoldiers(bar.value);
        emit('barrierApply', { x: bar.x, z: bar.z, value: bar.value });
      }
      state.barriers.splice(i, 1);
      continue;
    }

    // 从旁边越过去：不生效
    if (bar.z >= CONFIG.world.killZ) {
      state.barriers.splice(i, 1);
    }
  }
}

function spawnBarrierRow() {
  const [minX, maxX] = CONFIG.world.leftZone;
  const step = CONFIG.barrier.rowGap;
  const wave = state.wave;

  // 普通屏障的 +N 随波次升级，最多 +5
  const positiveValue = Math.min(
    CONFIG.barrier.positiveMax,
    CONFIG.barrier.positiveBase +
      Math.floor((wave - 1) / CONFIG.barrier.positiveStepWaves)
  );

  // 负数屏障的扣血上限和打满上限都随波次变大
  const negativeCap =
    CONFIG.barrier.negativeBase + (wave - 1) * CONFIG.barrier.negativeGrowth;
  const valueCap =
    CONFIG.barrier.capBase + (wave - 1) * CONFIG.barrier.capGrowth;

  // 负数屏障越到后期越多；灰色屏障跟着变长，红色保持一格
  const negativeChance = Math.min(
    CONFIG.barrier.negativeChanceMax,
    CONFIG.barrier.negativeChanceBase +
      (wave - 1) * CONFIG.barrier.negativeChancePerWave
  );
  const negativeLength = Math.min(
    CONFIG.barrier.negativeLengthMax,
    1 + Math.floor((wave - 1) / CONFIG.barrier.negativeLengthEveryWaves)
  );

  const xs = [];
  for (let x = minX; x <= maxX + 0.01; x += step) xs.push(x);

  // 已经满级就不刷对应的特殊屏障，避免浪费玩家的火力
  const weaponChance =
    state.weapon.lines < CONFIG.weapon.maxLines
      ? CONFIG.barrier.weaponChance
      : 0;
  const piercerChance = state.weapon.pierce
    ? 0
    : CONFIG.barrier.piercerChance;
  const specialChance = weaponChance + piercerChance;

  let i = 0;
  while (i < xs.length) {
    const x = xs[i];
    const roll = Math.random();
    const z =
      CONFIG.world.spawnZ - Math.random() * CONFIG.barrier.staggerRange;

    if (roll < weaponChance) {
      state.barriers.push(makeSpecialBarrier('weapon', x, z, wave));
      i += 1;
    } else if (roll < specialChance) {
      state.barriers.push(makeSpecialBarrier('pierce', x, z, wave));
      i += 1;
    } else if (roll < specialChance + negativeChance) {
      const grey = Math.random() < CONFIG.barrier.greyChance;
      // 只有灰色屏障随时间变长，红色保持一格
      const len = grey ? Math.min(negativeLength, xs.length - i) : 1;
      const centerX = x + (step * (len - 1)) / 2;

      state.barriers.push({
        id: state.nextId++,
        kind: grey ? 'grey' : 'negative',
        x: centerX,
        z,
        value: -randInt(CONFIG.barrier.negativeMin, negativeCap),
        maxValue: randInt(CONFIG.barrier.capMin, valueCap),
        hits: 0,
        required: 0,
        length: len,
        halfWidth: (step * len) / 2 - 0.08,
        speed: CONFIG.barrier.speed,
      });
      i += len;
    } else {
      state.barriers.push({
        id: state.nextId++,
        kind: 'normal',
        x,
        z,
        value: positiveValue,
        maxValue: positiveValue,
        hits: 0,
        required: 0,
        length: 1,
        halfWidth: step / 2 - 0.08,
        speed: CONFIG.barrier.speed,
      });
      i += 1;
    }
  }
}

function makeSpecialBarrier(kind, x, z, wave) {
  const required =
    kind === 'weapon'
      ? CONFIG.barrier.weaponHitsBase +
        (wave - 1) * CONFIG.barrier.weaponHitsPerWave
      : CONFIG.barrier.piercerHitsBase +
        (wave - 1) * CONFIG.barrier.piercerHitsPerWave;

  return {
    id: state.nextId++,
    kind,
    x,
    z,
    value: 0,
    maxValue: 0,
    hits: 0,
    required,
    length: 1,
    halfWidth: CONFIG.barrier.rowGap / 2 - 0.08,
    speed: CONFIG.barrier.speed,
  };
}

/* ----------------------------------------------------------
 * 僵尸：从右侧大量压下来
 * ---------------------------------------------------------- */
function updateSlots(dt) {
  const eraMul = 1 + state.era * 0.25;

  if (state.slots.siege) {
    const siege = CONFIG.slots.siege;
    state.slotTimers.siege -= dt;
    if (state.slotTimers.siege <= 0) {
      state.slotTimers.siege = siege.interval;
      const target = densestPoint();
      if (target) {
        damageZombiesInRadius(target.x, target.z, siege.radius, siege.damage * eraMul);
        emit('slotStrike', {
          kind: 'siege',
          fromX: siege.x,
          fromZ: siege.z,
          x: target.x,
          z: target.z,
          radius: siege.radius,
          color: 0xffa64d,
        });
      }
    }
  }

  if (state.slots.closeDefense) {
    const close = CONFIG.slots.closeDefense;
    state.slotTimers.closeDefense -= dt;
    if (state.slotTimers.closeDefense <= 0) {
      state.slotTimers.closeDefense = close.interval;
      damageZombiesInRadius(close.x, close.z, close.radius, close.damage * eraMul);

      // 找最近的僵尸，画一条曳光过去
      let tx = close.x;
      let tz = close.z;
      let best = Infinity;
      for (const zb of state.zombies) {
        const dx = zb.x - close.x;
        const dz = zb.z - close.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < close.radius * close.radius && d2 < best) {
          best = d2;
          tx = zb.x;
          tz = zb.z;
        }
      }

      emit('slotStrike', {
        kind: 'closeDefense',
        fromX: close.x,
        fromZ: close.z,
        x: tx,
        z: tz,
        radius: close.radius,
        color: 0xff6a4a,
      });
    }
  }

  if (state.slots.support) {
    const support = CONFIG.slots.support;
    state.slotTimers.support -= dt;
    if (state.slotTimers.support <= 0) {
      state.slotTimers.support = support.interval;
      applySoldiers(support.heal + Math.floor(state.era / 2));
      emit('slotHeal', { x: support.x, z: support.z });
    }
  }
}

function updateBarricade(dt) {
  const b = state.barricade;
  if (!b.unlocked) return;
  if (b.active) return;

  b.cooldown -= dt;
  if (b.cooldown <= 0) {
    b.active = true;
    b.hp = b.maxHp;
    b.cooldown = 0;
    emit('barricadeRebuild', {});
  }
}

function updateZombies(dt) {
  updateBarricade(dt);
  state.zombieTimer -= dt;

  const spawnInterval = Math.max(
    CONFIG.zombie.minSpawnInterval,
    CONFIG.zombie.spawnInterval - (state.wave - 1) * CONFIG.zombie.intervalPerWave
  );

  if (state.zombieTimer <= 0) {
    if (state.zombies.length < CONFIG.zombie.maxAlive) {
      // 第一波只刷一只，之后才是 1 到 2 只
      const count = state.wave === 1 ? 1 : 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) spawnZombie();
    }
    state.zombieTimer = spawnInterval;
  }

  // 移动：进入下半场且离士兵够近时，开始横向追人
  for (const z of state.zombies) {
    const bar = state.barricade;
    const cfg = CONFIG.barricade;

    // 路障挡在前排：范围内的僵尸停下来啃墙
    if (bar.active && z.z < cfg.z && z.x >= bar.xMin && z.x <= bar.xMax) {
      z.z = Math.min(cfg.blockZ, z.z + z.speed * dt);

      if (z.z >= cfg.blockZ - 0.05) {
        if (z.attackTimer == null) {
          z.attackTimer = Math.random() * cfg.attackInterval;
        }
        z.attackTimer -= dt;

        if (z.attackTimer <= 0) {
          z.attackTimer += cfg.attackInterval;
          const dmg =
            cfg.hitDamage * (z.type === 10 ? cfg.bossMultiplier : 1);
          bar.hp = Math.max(0, bar.hp - dmg);

          // 路障反击：等级 1 没有伤害
          if (bar.damage > 0) z.hp -= bar.damage;

          emit('barricadeHit', {
            hp: bar.hp,
            maxHp: bar.maxHp,
            x: z.x,
            z: z.z,
          });

          if (bar.hp <= 0) {
            bar.active = false;
            bar.cooldown = cfg.cooldown;
            emit('barricadeBreak', {});
          }
        }
      }

      z.x = clamp(z.x, -CONFIG.world.halfWidth - 1, CONFIG.world.halfWidth + 1);
      continue;
    }

    const dx = state.player.x - z.x;
    const dz = state.player.z - z.z;
    const dist = Math.hypot(dx, dz);

    if (z.z > CONFIG.zombie.aggroStartZ && dist < CONFIG.zombie.aggroRadius) {
      z.aggro = true;
    }

    if (z.aggro && Math.abs(dx) > 0.12) {
      z.x += Math.sign(dx) * CONFIG.zombie.turnSpeed * dt;
    }

    if (z.z >= CONFIG.world.killZ) {
      // 到线就停住，不再往前，改为沿着防线滑向士兵
      // 这样它永远不会越线，最终一定会贴上
      z.z = CONFIG.world.killZ;
      z.aggro = true;

      if (Math.abs(dx) > 0.05) {
        z.x += Math.sign(dx) * CONFIG.zombie.lineSlideSpeed * dt;
      }
    } else {
      const slowMul = state.time < state.slowUntil ? state.slowMul : 1;
      z.z += z.speed * dt * slowMul;
    }

    z.x = clamp(z.x, -CONFIG.world.halfWidth - 1, CONFIG.world.halfWidth + 1);
  }

  separateZombies();

  // 路障反击打死的僵尸在这里统一结算
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];
    if (z.hp > 0) continue;

    state.zombies.splice(i, 1);
    state.score += CONFIG.zombie.types[z.type]?.score || 1;
    emit('zombieDie', { x: z.x, z: z.z, type: z.type });
  }

  // 结算：碰到士兵扣 1
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];

    if (
      z.z >= CONFIG.world.touchZ &&
      Math.abs(z.x - state.player.x) < formationHalfWidth()
    ) {
      state.zombies.splice(i, 1);
      damageArmy(z.touchLoss, 'touch');
      continue;
    }

  }
}

function separateZombies() {
  const list = state.zombies;
  const sep = CONFIG.zombie.separation;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      if (Math.abs(a.z - b.z) > sep) continue;

      const dx = b.x - a.x;
      const adx = Math.abs(dx);
      if (adx >= sep) continue;

      const dir = dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dx);
      const push = (sep - adx) * 0.5;

      a.x -= dir * push;
      b.x += dir * push;
    }
  }

  for (const z of list) {
    z.x = clamp(z.x, -CONFIG.world.halfWidth - 1, CONFIG.world.halfWidth + 1);
  }
}

function typeWeight(type, wave) {
  if (wave < type.minWave) return 0;

  let w = type.baseWeight + (wave - type.minWave) * (type.growth || 0);
  if (type.minWeight != null) w = Math.max(type.minWeight, w);
  if (type.maxWeight != null) w = Math.min(type.maxWeight, w);
  return Math.max(0, w);
}

function pickZombieType(wave) {
  const pool = CONFIG.zombie.types
    .map((t) => ({ type: t, weight: typeWeight(t, wave) }))
    .filter((e) => e.weight > 0);

  const total = pool.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * total;

  for (const e of pool) {
    roll -= e.weight;
    if (roll <= 0) return e.type;
  }
  return pool[pool.length - 1].type;
}

function spawnZombie() {
  const [minX, maxX] = CONFIG.world.rightZone;
  const type = pickZombieType(state.wave);

  const baseHp =
    CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave;
  const baseSpeed =
    CONFIG.zombie.baseSpeed + (state.wave - 1) * CONFIG.zombie.speedPerWave;
  const nightMul = isNight(state.wave) ? CONFIG.zombie.nightSpeedMul : 1;

  state.zombies.push({
    id: state.nextId++,
    x: minX + Math.random() * (maxX - minX),
    z: CONFIG.world.spawnZ - Math.random() * 4,
    hp: baseHp * type.hp,
    speed: Math.min(
      CONFIG.zombie.speedCap,
      baseSpeed * type.speed * nightMul
    ),
    touchLoss: type.touchLoss,
    type: type.id,
    aggro: false,
  });

  if (state.spawnCounts) state.spawnCounts[type.id] += 1;
}

function damageArmy(amount, cause) {
  if (state.status !== 'playing') return;

  // 护甲按概率挡掉每一滴伤害，避免 1 点伤害被取整吃掉
  let dmg = amount;
  const reduction = state.upgrades.damageReduction || 0;
  if (reduction > 0) {
    for (let i = 0; i < amount; i++) {
      if (Math.random() < reduction) dmg -= 1;
    }
  }
  if (dmg <= 0) return;

  state.soldiers -= dmg;
  emit('armyHurt', { soldiers: state.soldiers, amount: dmg, cause });

  if (state.soldiers <= 0) {
    state.soldiers = 0;
    state.status = 'over';
    state.card.active = false;
    state.timeScale = 1;
  }
}

// 屏障数值生效：正数加兵，负数扣兵
function applySoldiers(delta) {
  if (state.status !== 'playing') return;

  state.soldiers += delta;

  if (delta < 0) {
    emit('armyHurt', { soldiers: state.soldiers, amount: -delta, cause: 'barrier' });
  }

  if (state.soldiers <= 0) {
    state.soldiers = 0;
    state.status = 'over';
    state.card.active = false;
    state.timeScale = 1;
  }
}

/* ----------------------------------------------------------
 * 主循环
 * ---------------------------------------------------------- */
let lastTime = performance.now();

function loop(now) {
  requestAnimationFrame(loop);

  const realDt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (state.status === 'playing') {
    updateCard(realDt);            // 抽卡倒计时用真实时间
    const dt = realDt * state.timeScale;
    update(dt);
    syncScene(state, dt);
  } else {
    syncScene(state, realDt);
  }

  updateUI(state);
}

requestAnimationFrame(loop);
