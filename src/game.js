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
  switchMapLook,
  pickEraMap,
  eraMaps,
  spawnCampfireFx,
  setWaterLevel,
  preloadGroundTexture,
  setWaveClock,
} from './visuals.js';
import { pickZombieTypeForEra, eraWeaponProfile } from './game-era-rules.js';
import { SUMMONER, createSummonerState, updateSummoner } from './game-summoner.js';
import { createChain, chainDetour, isBlockedByChain } from './game-chainbarricade.js';
import { initUI, updateUI } from './ui.js';

// 起始地图：开始页传入的 ?map=，默认废墟街道
// 无参数时默认和开始页保持一致：中世纪·城堡攻城
const START_MAP =
  new URLSearchParams(window.location.search).get('map') || 'castle';

/* ----------------------------------------------------------
 * 地图环境事件
 * 每张地图固定挂一个事件，进入地图时随机落在第 1/2/3 波。
 * 事件只影响僵尸 + 给玩家一个可躲的负面效果，不做全屏眩晕。
 * ---------------------------------------------------------- */
const MAP_ENV = {
  jungle: 'weather', castle: 'quake', village: 'quake', abbey: 'quake',
  swamp: 'toxic', city: 'weather', base: 'weather', trench: 'quake',
  beach: 'weather', warport: 'weather', desert: 'meteor', harbor: 'weather',
  highway: 'weather', parking: 'quake', snow: 'weather', lab: 'toxic',
  quarantine: 'toxic', biofactory: 'toxic', moon: 'meteor', station: 'emp',
  alienwaste: 'meteor', orbitalpad: 'emp', lava: 'lava',
  voidtemple: 'lava', timeruins: 'quake', blackhole: 'meteor',
};

const ENV_EVENTS = {
  quake:   { name: '地震', warn: 3, active: 4 },
  meteor:  { name: '陨石', warn: 3, active: 2 },
  weather: { name: '恶劣天气', warn: 3, active: 6 },
  toxic:   { name: '毒雾', warn: 3, active: 6 },
  lava:    { name: '熔岩喷发', warn: 3, active: 5 },
  emp:     { name: '电磁风暴', warn: 3, active: 2.5 },
};

const WEATHER_KIND = {
  jungle: 'rain', swamp: 'fog', beach: 'storm', city: 'rain',
  base: 'dust', warport: 'rain', harbor: 'rain', highway: 'wind',
  snow: 'snow',
};

const WEATHER_NAMES = {
  rain: '暴雨', fog: '浓雾', storm: '风暴', dust: '沙尘',
  wind: '强风', snow: '暴雪',
};

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
    // 兵种阶级：门槛和 visuals-tiers.js 的 5/20/50/100 保持一致
    tiers: [
      { min: 0, name: '保安', damage: 1.0, fireInterval: 0.18 },
      { min: 20, name: '正规军', damage: 1.15, fireInterval: 0.17 },
      { min: 50, name: '特种兵', damage: 1.35, fireInterval: 0.16 },
      { min: 100, name: '超级士兵', damage: 1.50, fireInterval: 0.15 },
    ],
  },
  weapon: {
    maxLines: 8,         // 最多几个枪位
    jitterBase: 0.01,    // 枪口抖动
    // 穿透器 1-3 级：等级越高，继续穿透概率和最多穿透次数越高
    pierceChanceByLevel: [0.08, 0.12, 0.16],
    pierceMaxByLevel: [3, 4, 5],
    pierceChance: 0.08,  // 兼容旧字段：未设置等级时按 1 级算
    pierceMax: 3,
  },
  formation: {
    spacing: 0.42,       // 前排士兵之间的横向间距
    rowGap: 0.32,        // 排与排之间的纵向间距
    maxSoldiers: 120,    // 最多显示多少个士兵
  },
  card: {
    everyWaves: 2,       // 每几波自动获得一个技能
  },
  slots: {
    // 每个槽位 1-5 级。等级只改规模：伤害倍率、半径、间隔、回兵数。
    // 时代倍率和欠级折扣在 CONFIG.era，结算时再乘。
    siege: {
      x: 4.5, z: 15, baseDamage: 30,
      flightTime: 0.5, // 炮弹飞行 0.5 秒，落地才结算伤害
      levels: [
        { damageMul: 1.00, radius: 2.6, interval: 6.0 },
        { damageMul: 1.25, radius: 2.9, interval: 5.7 },
        { damageMul: 1.55, radius: 3.2, interval: 5.4 },
        { damageMul: 1.90, radius: 3.5, interval: 5.1 },
        { damageMul: 2.30, radius: 3.8, interval: 4.8 },
      ],
    },
    support: {
      x: -4.5, z: 15, baseHeal: 1,
      levels: [
        { healMul: 1, interval: 10.0 },
        { healMul: 1, interval: 9.0 },
        { healMul: 2, interval: 8.5 },
        { healMul: 2, interval: 8.0 },
        { healMul: 3, interval: 7.0 },
      ],
    },
    command: {
      // 指挥改成集火标记：每 3 秒标记场上血量最高的敌人，子弹打中它时加伤
      x: 0, z: 15, baseMark: 0.15, markInterval: 3,
      levels: [
        { mul: 1.00 },
        { mul: 1.30 },
        { mul: 1.60 },
        { mul: 2.00 },
        { mul: 2.50 },
      ],
    },
    closeDefense: {
      x: 5.5, z: 4.5, baseDamage: 8,
      levels: [
        { damageMul: 1.00, radius: 3.0, interval: 0.50 },
        { damageMul: 1.20, radius: 3.2, interval: 0.47 },
        { damageMul: 1.45, radius: 3.4, interval: 0.44 },
        { damageMul: 1.75, radius: 3.6, interval: 0.41 },
        { damageMul: 2.10, radius: 3.8, interval: 0.38 },
      ],
    },
    // 第六槽位：后现代起抽卡解锁，星际起保底自动补 1 级。制造友方僵尸对冲。
    // 五级五兵种：等级提升不仅加数值，还会解锁更凶的兵种；
    // 预算按「小兵占 1、巨尸占 2」算，等级越高能同时在场越多。
    summon: {
      x: -5.5, z: 4.5, speed: 3.2,
      recommendedByEra: [0, 0, 0, 1, 3, 5],
      levels: [
        { hpMul: 1.00, damageMul: 1.00, interval: 8.0, budget: 2 },
        { hpMul: 1.25, damageMul: 1.20, interval: 7.2, budget: 2 },
        { hpMul: 1.55, damageMul: 1.45, interval: 6.4, budget: 3 },
        { hpMul: 1.90, damageMul: 1.75, interval: 5.6, budget: 3 },
        { hpMul: 2.30, damageMul: 2.10, interval: 4.8, budget: 4 },
      ],
      // 兵种基础值。最终血量/伤害再乘时代倍率、等级倍率、欠级折扣。
      units: {
        shield: {
          name: '盾尸', short: '盾',
          hp: 80, damage: 14, speed: 3.0, attackInterval: 0.8, cost: 1,
        },
        runner: {
          name: '疾尸', short: '疾',
          hp: 50, damage: 9, speed: 5.2, attackInterval: 0.45, cost: 1,
        },
        bomber: {
          name: '爆尸', short: '爆',
          hp: 60, damage: 55, speed: 3.6, cost: 1,
          explodeRadius: 1.8,
        },
        spitter: {
          name: '酸吐尸', short: '酸',
          hp: 55, damage: 8, speed: 3.0, attackInterval: 1.1, cost: 1,
          range: 4.5,
        },
        giant: {
          name: '巨尸', short: '巨',
          hp: 220, damage: 35, speed: 2.3, attackInterval: 1.0, cost: 2, max: 1,
          scale: 1.65,
        },
      },
      // 每个等级的出怪权重（百分制，不在表里的兵种不出）
      weights: [
        { shield: 100 },
        { shield: 65, runner: 35 },
        { shield: 45, runner: 30, bomber: 25 },
        { shield: 35, runner: 25, bomber: 22, spitter: 18 },
        { shield: 30, runner: 20, bomber: 20, spitter: 15, giant: 15 },
      ],
      // 升到该等级时新解锁的兵种；升级会免费送一只，之后的第一只也优先出它
      newUnitAtLevel: [null, null, 'runner', 'bomber', 'spitter', 'giant'],
    },
    // 工事就是路障本身，位置和等级在 CONFIG.barricade
  },
  barrel: {
    damageBase: 20,      // 炸药桶爆炸伤害的基础值
    damagePerWave: 4,    // 每波增加的伤害
    spawnInterval: 12,   // 每隔多少秒尝试补一个桶
  },
  rollingLog: {
    length: 6.0,       // 纵向长度，整根都要在屏幕内
    radius: 0.55,      // 横向粗细
    speed: 11,         // 从左往右的速度
    damageMul: 1.25,   // 普通僵尸当前血量 ×1.25：秒普通，不秒大块头
    zMargin: 0.6,      // 离屏幕上下边缘留的余量
  },
  knightCharge: {
    count: 3,          // 一次冲几个骑士
    minGap: 1.6,       // 两个骑士之间的最小横向距离
    speed: 20,         // 向上冲的速度
    damage: 50,        // 每个骑士对同一只僵尸只结算一次
    hitRadius: 0.9,    // 横向命中半径（比原来 0.75 放大一点）
    hitDepth: 1.25,    // 纵向命中厚度（比原来 1.1 放大一点）
    spawnZ: 9.8,       // 屏幕下方出生
  },
  campfire: {
    radius: 7.0,       // 范围大幅增大，覆盖大半个战场
    duration: 5,       // 火区存在 5 秒
    dps: 18,           // 圆心每秒伤害，总计 90
    falloff: 0.7,      // 越靠边伤害越低：边缘只保留 30%
  },
  tankSupport: {
    // 底部三大槽位在 z=15，坦克摆在它们后面（屏幕更下方），不再挡在士兵阵型前
    x: -5.5, z: 16.0,  // 底部槽位后方；再叫一辆就摆在它右边 spacing 格处
    spacing: 2.4,      // 第二辆在第一辆右边这么多格
    shots: 5,          // 每辆坦克一轮打 5 发
    shotInterval: 1.2, // 发射间隔放慢，别像机关枪
    damage: 60,
    radius: 3.0,       // 爆炸范围收回 3.0，3.9 太大
    flightTime: 0.32,  // 炮弹飞行时间 0.5 → 0.32，落点更快
    retreatDelay: 0.9, // 打完多久开始撤
    holdTime: 4,       // 打完最后一发后多停留 4 秒再撤退
    retreatSpeed: 4.5,
    despawnZ: 17.6,    // 撤退到屏幕下边缘外侧就移除
  },
  airStrike: {
    bombs: 3,
    damage: 70,
    radius: 2.2,
    delayStep: 0.22,   // 三颗炸弹错开落下
  },
  barrage: {
    waves: 6,
    damage: 25,
    radius: 2.2,
    areaRadius: 5,
    firstDelay: 0.15,
    waveInterval: 0.5,
  },
  napalmWall: {
    width: 8,
    depth: 1.8,
    duration: 4,
    dps: 12,
    slowMul: 0.6,
    impactDamage: 20,
  },
  apc: {
    spawnX: 0,         // 从底部中间开出来，不再随机左右偏移
    speed: 7.5,        // 比骑士慢很多
    damage: 90,        // 撞击伤害，每只僵尸一次
    hitRadius: 1.1,
    hitDepth: 1.2,
    spawnZ: 9.8,
    mgInterval: 0.35,  // 机枪间隔
    mgDamage: 12,
    mgRange: 8,
  },
  // 无人机蜂群：一波内陆续放出 10 架自杀式无人机，各自随机锁定一只僵尸
  droneSwarm: {
    count: 10,          // 一波总共 10 架
    duration: 12,       // 持续一波，和 CONFIG.wave.duration 保持一致
    speed: 13,          // 飞行速度
    damage: 65,         // 命中爆炸伤害
    aoeRadius: 2.2,     // 命中点的小范围
    startZ: 10.6,       // 从士兵阵型后方起飞，看得见"从屏幕下方出发"
    despawnZ: -24,      // 没目标一直往上游，飞出这条线就撤
    lockPad: 0.75,      // 离目标多近算命中
  },
  carrierDrones: {
    count: 4,
    life: 12,          // 持续一波，和 CONFIG.wave.duration 保持一致
    damage: 20,        // 每发小范围伤害
    interval: 0.45,
    range: 16,
    radius: 1.6,       // 无人机绕最密点转的半径
    aoeRadius: 1.8,    // 每发命中的小范围
  },
  orbital: {
    // 从士兵这一侧算起，只清掉最近的 2/3 僵尸，更远的一批留在场上继续压
    killFraction: 2 / 3,
    beamZMax: 6.9,     // 光柱最高到这条线，留出士兵阵型
    beamWidth: 3.0,
  },
  weaponDrop: {
    duration: 12,      // 空投重武器持续时间（从箱子被打中那一刻开始算）
    damageMul: 2.0,
    rateMul: 1.5,
    fallSpeed: 9,      // 箱子从天而降的速度
    offsetZ: 3.0,      // 落在玩家正前方，不然子弹从头顶飞过去打不到
  },
  virusBomb: {
    count: 2,
    radius: 2.6,
    maxConvert: 8,     // 每枚最多转化几只
    flightTime: 0.8,
  },
  bioLegion: {
    count: 20,
    hp: 36,
    damage: 7,
    speed: 3.4,
  },
  // 记忆植入：从地图外打进一枚传染炮弹，感染会在僵尸之间扩散
  plague: {
    flightTime: 0.6,
    radius: 2.2,        // 落点初始感染范围
    infectCount: 4,     // 落点最多直接感染几只
    duration: 6,        // 每只感染持续时间
    damagePct: 0.03,    // 每秒扣最大生命的比例
    slowMul: 0.7,       // 感染期间移速 ×0.7
    spreadInterval: 0.9,
    spreadRadius: 2.2,
    maxInfected: 15,    // 全场同时感染上限
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
    spawnInterval: 1.92,   // 从 2.4 缩到 1.92，保持每波约 6.25 排
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
    nightSpawnMul: 0.75, // 夜晚刷新间隔乘这个，越小越密（0.75 = 快 33%）
    maxSpeed: 7.5,
    speedCap: 9,       // 快鬼加速后也不会超过这个速度
    // 一波从 15 秒缩到 12 秒，刷怪间隔同步 ×0.8，
    // 保证每一波的僵尸数量不变，只是来得更密
    spawnInterval: 0.28,
    minSpawnInterval: 0.128,
    intervalPerWave: 0.016,
    maxAlive: 120,
    aggroStartZ: 0,        // 进入中后段就开始缓慢吸附
    aggroRadius: 9,        // 吸附范围比原来更早
    turnSpeed: 2.6,        // 吸附速度放慢
    lineSlideSpeed: 15,    // 到线后沿防线滑向士兵的速度，必须快过士兵
    chainDetourRange: 4,   // 离锁链多近才开始横向绕行，避免从出生点就吸附
    chargeDistance: 16,    // 离玩家超过这个距离才蓄力跑步
    chargeSpeedMul: 1.9,   // 远距离冲刺倍率
    absorbDistance: 8,     // 进入这个距离后放慢、开始吸附
    absorbSpeedMul: 0.55,  // 近距离吸附时的前进速度倍率
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
      // 11 自爆：死了炸一圈，逼玩家优先点掉它，别让它贴近阵型
      { id: 11, name: '自爆', hp: 1.6, speed: 0.90, touchLoss: 2, score: 4, baseWeight: 6, growth: 0.4, maxWeight: 12, minWave: 4, explode: { radius: 2.8, hpMul: 4 } },
      // 12 护甲：子弹伤害打对折，靠技能或集火处理
      { id: 12, name: '护甲', hp: 2.0, speed: 0.85, touchLoss: 2, score: 4, baseWeight: 8, growth: 0.3, maxWeight: 14, minWave: 5, armor: 0.5 },
      // 13 远程：走到半场就停住，隔着距离往阵型吐酸液，逼玩家优先点掉它
      { id: 13, name: '远程', hp: 1.4, speed: 0.95, touchLoss: 1, score: 5, baseWeight: 7, growth: 0.35, maxWeight: 13, minWave: 7, ranged: { stopZ: -13, interval: 2.6, damage: 1, speed: 7 } },
      // 14 召唤者：不参与随机抽签（baseWeight 0 + minWave 999 双保险），
      // 由 spawnSummoner() 单独刷。理由同 Boss：它是"全场唯一"的特殊单位，
      // 放进随机池会一次刷出好几只、每只都在召孩子，直接把场上刷满
      { id: 14, name: '召唤者', hp: 2.2, speed: 0.72, touchLoss: 2, score: 8, baseWeight: 0, growth: 0, minWave: 999, summoner: true },
      // 时代 Boss：不参与随机抽签（minWave 999 + boss 标记双保险），
      // 只由 spawnEraBoss() 在换地图时单独刷一只
      // hp 35 = 同波普通僵尸的 35 倍（第 4 波约 1540 血、第 46 波约 13300 血）
      { id: 10, name: '时代Boss', hp: 35, speed: 0.5, touchLoss: 6, score: 40, baseWeight: 0, growth: 0, minWave: 999, boss: true },
    ],
  },
  wave: {
    duration: 12,       // 一波 12 秒：比 15 秒快 20%，整局节奏更紧
  },
  era: {
    count: 6,          // 六个时代
    everyWaves: 3,     // 每张地图打几波
    mapsPerEra: 3,     // 每个时代打几张地图（打完 3 张才进下一个时代）
    names: ['中世纪', '二战', '现代', '后现代', '星际', '终幕'],
    // 槽位等级模型：最终值 = 基础值 × 时代倍率 × 等级倍率 × 欠级折扣
    attackPower: [1.00, 1.30, 1.70, 2.20, 2.80, 3.50],
    healPower: [1.00, 1.20, 1.50, 1.90, 2.40, 3.00],
    commandPower: [1.00, 1.20, 1.40, 1.70, 2.00, 2.40],
    hpPower: [1.00, 1.25, 1.55, 1.90, 2.30, 2.80],
    recommendedLevel: [1, 2, 3, 4, 4, 5],
    // 从该时代开局时的初始兵力：越晚的时代，起点越高，用来对冲该时代的僵尸强度
    startSoldiers: [5, 20, 40, 65, 90, 120],
    underLevelStep: 0.15, // 每差 1 级 -15%
    underLevelMin: 0.55,  // 最多 -45%
  },
  // 时代 Boss：每次切换时代刷一只，作为分段节点
  // 血量乘子和普通僵尸同一套公式（baseHp + 波次成长），再乘 types 里的 hp=60
  boss: {
    rewardSoldiers: 8,   // 击败奖励：加兵
    rewardScore: 30,     // 击败奖励：额外分数（types 里的 score 40 会另算）
    toast: true,
    // 打到防线后的连续攻击：Boss 不再"碰一下就消失"，而是站在线上反复出拳。
    // 每一拳扣 20 兵，且必须等上一拳的动作演完才打下一拳（节奏由动画驱动）
    attackLoss: 20,      // 每拳扣多少兵
    attackAnim: 1.5,     // 一拳的动作要播多久。画面层把 4.8 秒的动画裁成单次撕咬，
                         // 1.5 秒正好是正常速度，不再整条 3 倍速播放
    attackFallback: 1.8, // 拿不到动画结束回调时的兜底间隔（模型没加载也能按这个节奏打）
    attackGap: 0.4,      // 一拳演完到下一拳之间的最短停顿
  },
  // 洪水（点子池「洪水上涨」）：水位随波次上升，漫过脚踝后僵尸变慢
  flood: {
    startWave: 10,     // 第几波开始涨（新的时代排程下对应二战开场）
    perWave: 0.06,     // 每波涨多少（0~1 的水位值）
    maxLevel: 0.9,     // 涨到这儿封顶，不会真把画面淹掉
    slowFrom: 0.55,    // 水位超过这个值才开始拖慢僵尸
    slowMul: 0.62,     // 水里僵尸移速乘这个
  },
  // 地面塌陷（点子池「地面塌陷」）：地面裂开坑洞，玩家和僵尸都过不去
  pit: {
    startWave: 21,     // 新排程下对应现代时代
    interval: 11,      // 每隔多少秒尝试塌一个
    max: 3,            // 场上最多几个
    radius: 1.35,
    life: 26,          // 多少秒后自行回填，不会永久占场
    avoidPlayer: 2.4,  // 不在玩家脚下塌，否则会把人关在里面
    playerPad: 0.45,   // 玩家身板半径，判定比坑本身大一圈
  },
  // 掉落拾取（点子池「掉落拾取」）：场上掉武器箱，走过去换枪
  pickup: {
    interval: 26,      // 以前 14 秒一个，掉得太勤，拉到 26 秒
    firstDelay: 16,
    duration: 5,       // 换来的枪只能用 5 秒，到点换回时代武器（18 → 9 → 5）
    max: 1,            // 场上最多一个，以前是两个
    life: 24,          // 打不中就在场上待 24 秒自动消失，不然会一直占着刷新位
    hitW: 0.72,        // 子弹命中的横向半宽
    hitZ: 0.66,        // 子弹命中的纵向半宽
    weapons: [
      // 三发扇形：打单体目标只有中间一发能中（实测 0.39×），
      // 但打群体是 1.85×，这是它的定位，别为了单体好看把散布收窄
      { kind: 'shotgun', name: '霰弹枪', bullets: 3, spread: 2.8,
        intervalMul: 1.45, damageMul: 0.55, tint: 0xffb04a,
        desc: '三发扇形，近身压制（群体 ×1.85 / 单体 ×0.39）' },
      { kind: 'sniper', name: '狙击枪', bullets: 1, spread: 0.12,
        intervalMul: 2.2, damageMul: 3.2, pierce: true, tint: 0x9ad0ff,
        desc: '单发重击，必穿透' },
      { kind: 'mg', name: '机枪', bullets: 1, spread: 1.0,
        intervalMul: 0.42, damageMul: 0.58, tint: 0x8affc0,
        desc: '泼水射速，单发偏轻（DPS ×1.38）' },
    ],
  },
  // 锁链路障（点子池「锁链路障」）：挡半条通道，僵尸必须绕过去
  chain: {
    startWave: 11,     // 第几波开始出现（新排程下对应二战第二波）
    z: -6,             // 摆在半场偏下，给玩家留反应时间
    widthRatio: 0.52,  // 占通道宽度的比例，0.5 左右 = 挡半边
  },
  // 补给箱：场上随机掉一个木箱，打碎给随机奖励
  crate: {
    interval: 16,        // 每隔多少秒尝试刷一个
    max: 2,              // 场上最多几个
    firstDelay: 10,      // 开局多久后刷第一个，别一上来就掉
    fallSpeed: 9,        // 从天而降的速度
    hitW: 0.8,           // 横向命中半宽（比僵尸宽，别让玩家瞄不准）
    hitZ: 0.75,
    rewards: [
      { kind: 'soldiers', amount: 5, weight: 46, label: '援兵 +5' },
      { kind: 'score', amount: 30, weight: 34, label: '分数 +30' },
      { kind: 'soldiers', amount: 10, weight: 20, label: '援兵 +10' },
    ],
  },
};

const SLOT_IDS = ['siege', 'closeDefense', 'support', 'command', 'summon'];
const SLOT_NAMES = {
  siege: '攻城',
  closeDefense: '近防',
  support: '支援',
  command: '指挥',
  summon: '召唤',
  barricade: '工事',
};
const SLOT_MAX_LEVEL = 5;
const SKILL_BAG_MAX = 4;       // 技能栏最多存几种
const SKILL_MAX_CHARGES = 9;   // 同一种技能最多叠几次
const SKILL_USE_CD = 0.3;      // 两次使用之间的冷却，防连点

/* ----------------------------------------------------------
 * 游戏状态
 * visuals.js 和 ui.js 只读这里，不要从外部改。
 * ---------------------------------------------------------- */
const state = {
  status: 'menu', // menu | playing | over
  paused: false,
  time: 0,
  wave: 1,
  score: 0,
  soldiers: 5,
  // 本局兵数历史最高值：重启靠它算回补目标，每帧在 update() 里刷新
  peakSoldiers: 5,

  era: 0,
  mapId: START_MAP,
  usedMaps: [START_MAP],
  eraMaps: [START_MAP], // 当前时代随机选出的 3 张地图
  mapIndex: 0,          // 当前在 eraMaps 里的第几张
  startEra: 0,          // 开局选择的时代，重新开始时沿用
  startMap: START_MAP,  // 开局选择的地图

  // 测试模式：主界面开关打开后进入，左侧面板控制槽位和技能
  testMode: false,

  player: {
    x: 0,
    z: CONFIG.world.playerZ,
  },

  // 武器状态：默认一个枪位，没有扩散
  weapon: {
    lines: 1,
    pierce: false,
    pierceLevel: 0, // 0 未解锁，1-3 对应 pierceChanceByLevel / pierceMaxByLevel
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
  // 地图结束后的升级面板：3 次选择，没选完的次数累计到下一次
  upgradePanel: {
    active: false,
    picks: 0,
    timeLeft: 0,
    version: 0,
    pickCounts: {},   // 本次面板里每张卡点了几次：1 次蓝框，2 次及以上橙黄框
  },
  upgradeCarry: 0,
  // 地图环境事件：{ id, wave, phase, timer, spots, weatherKind }
  envEvent: null,
  envDebuff: { until: 0, moveMul: 1, fireRateMul: 1, spreadMul: 1 },
  envZones: [],       // 毒雾/熔岩地面区：{ x, z, radius, kind, until, pct, playerDps }
  envZoneTick: 0,
  envSlowMul: 1,      // 恶劣天气期间僵尸移速乘子
  envWeatherUntil: 0,
  waveDuration: CONFIG.wave.duration, // 界面层算下一波倒计时用，不要在 ui.js 另写一份
  timeScale: 1,
  // 槽位默认全部锁定，抽到对应卡才生效；level 0 = 未解锁，1-5 = 等级
  slots: { siege: false, support: false, closeDefense: false, command: false, summon: false },
  slotLevels: { siege: 0, support: 0, closeDefense: 0, command: 0, summon: 0 },
  slotTimers: { siege: 3, support: 6, closeDefense: 0, summon: 2 },
  commandMarkId: 0,     // 指挥槽集火目标
  commandMarkBonus: 0,  // 对标记目标的伤害加成
  commandMarkTimer: 0,  // 下次换标记的倒计时

  // 一次性技能栏：抽到卡后存次数，点左侧图标使用
  skillBag: [],        // [{ id, charges }]
  skillBagVersion: 0,  // UI 重建用
  lastGainedSkillId: null,   // 刚获得的技能，技能栏高亮用
  lastGainedSkillVersion: 0,
  skillUseCd: 0,
  slowUntil: 0,
  slowMul: 1,
  buffUntil: 0,
  buffMul: 1,
  // 电磁脉冲：冻结期间僵尸不移动、不啃墙
  freezeUntil: 0,
  // 熵增：持续掉百分比血的截止时间、起始时刻、每秒比例和减速递增系数
  entropyUntil: 0,
  entropyStart: 0,
  entropyPct: 0,
  entropyRamp: 0.88,
  entropyMinMul: 0.18,

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
  rollingLogs: [],   // { id, x, z, length, radius, speed, damage, spin, hit }
  knightCharges: [], // { id, x, z, speed, damage, hit }
  campfireZones: [], // { id, x, z, radius, remaining, dps }
  napalmWalls: [],   // { id, x, z, width, depth, remaining, dps }
  siegeShots: [],    // { x, z, radius, damage, timeLeft } 炮弹落地后才结算
  tankSupports: [],  // 场上的坦克：{ x, z, shotsLeft, timer, retreating, retreatDelay }
  apcCharges: [],    // { id, x, z, speed, damage, hit, mgTimer }
  carrierDrones: [], // { id, x, z, baseX, baseZ, life, mgTimer, phase }
  swarmDrones: [],   // 无人机蜂群：{ id, x, z, targetId, life, heading }
  swarm: { until: 0, left: 0, timer: 0 }, // 蜂群的结束时间、还剩几架没放、下一架倒计时
  friendlyZombies: [], // 见 docs/接口约定.md；召唤槽兵种额外带 unitType/cost/role/scale
  summonNextPreferred: null, // 升级后下一只优先出的新兵种
  blackHoles: [], // 黑洞：{ id, x, z, timeLeft, duration, radius, pullRadius, pullFactor, damagePct, bossPctMul }
  plagueShots: [],   // 记忆植入的传染炮弹：{ id, x, z, timeLeft, radius, infectCount }
  plagueSpreadTimer: 0,
  virusBombs: [],    // { id, x, z, timeLeft, radius, maxConvert }
  usedSkills: [],    // 一局只能用一次的技能 id，目前是轨道轰炸
  weaponBoostUntil: 0,
  weaponBoostDamage: 1,
  weaponBoostRate: 1,

  barrierTimer: 0,
  zombieTimer: 0,
  zombieSpawnPauseUntil: 0,
  barrelTimer: 0,
  crateTimer: 0,
  crates: [],        // 补给箱：{ id, x, z, y, landed, reward }
  enemyShots: [],    // 远程僵尸吐出来的酸液：{ id, x, z, tx, tz, speed, damage }
  floodLevel: 0,     // 当前水位 0~1，给画面层和僵尸减速共用
  chains: [],        // 锁链：{ id, x, z, width, xMin, xMax, nearZ, farZ }
  pits: [],          // 地面坑洞：{ id, x, z, r, life }
  pitTimer: 0,
  pickups: [],       // 武器箱：{ id, x, z, y, landed, weapon }
  pickupTimer: 0,
  playerWeapon: null,// 捡到的临时武器，null = 用时代武器
  nextId: 1,
  spawnCounts: new Array(15).fill(0), // 调试用：统计每种僵尸刷了多少只（0-14）
};

// 调试用：浏览器控制台输入 __state 可以看实时数据
window.__state = state;

// 按 id 查僵尸类型。注意**不能用 CONFIG.zombie.types[z.type] 当下标**：
// 类型 id 是约定编号（画面层按同一套编号，中间留了 5-9 给地图专属僵尸），
// 而数组里只放实际存在的几个，id 10 的 Boss 只排在第 6 个位置上。
const ZTYPE_BY_ID = new Map();
CONFIG.zombie.types.forEach((t) => ZTYPE_BY_ID.set(t.id, t));
function zombieTypeById(id) {
  return ZTYPE_BY_ID.get(id) || null;
}

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

/* 玩家还在开始页选图时就把地面贴图预载进显存。
 * 新地图的贴图是 2k 的（三件套约 3.7MB），不预载的话点开始会先看到一片灰地面。
 * 失败不影响游戏——真加载不出来会退化成乘色纯地面。 */
// 贴图名规则固定是 b-map-{地图id}，和 visuals.js 的 MAPS[].tex 一致
preloadGroundTexture(`b-map-${START_MAP}`);

// 环境事件陨石：画面层落地时派 meteorImpact，这里结算僵尸和玩家伤害
events.addEventListener('meteorImpact', (e) => {
  if (state.status !== 'playing') return;
  const d = e.detail || {};
  const radius = Number(d.radius) || 2.6;
  damageZombiesInRadius(d.x, d.z, radius, 70);
  if (Math.hypot(state.player.x - d.x, state.player.z - d.z) < radius) {
    damageArmy(10, 'env');
  }
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
      state.score += zombieTypeById(zb.type)?.score || 1;
      emit('zombieDie', { x: zb.x, z: zb.z, type: zb.type });
    }
  }
});

// 时代 Boss 被击败：给兵 + 额外分数。
// 僵尸死亡一共有四个结算点（炸药桶 / 攻城 / 技能 / 路障反击），
// 全都派 zombieDie，所以奖励在这里单点结算，不会漏也不会重复。
events.addEventListener('zombieDie', (e) => {
  const d = e.detail || {};

  // 自爆僵尸：死后炸一圈。伤害按"本波普通僵尸血量 × hpMul"算，
  // 所以它越晚死、周围僵尸越硬，炸得越狠；连锁引爆是允许的（死者已先被移出数组，不会重复炸）
  if (d.type === 11) {
    const cfg = zombieTypeById(11)?.explode;
    if (cfg && Number.isFinite(d.x) && Number.isFinite(d.z)) {
      const baseHp = CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave;
      emit('zombieExplode', { x: d.x, z: d.z, radius: cfg.radius });
      damageZombiesInRadius(d.x, d.z, cfg.radius, baseHp * cfg.hpMul);
    }
  }

  if (d.type !== 10) return;

  state.soldiers = Math.min(
    CONFIG.formation.maxSoldiers,
    state.soldiers + CONFIG.boss.rewardSoldiers
  );
  state.score += CONFIG.boss.rewardScore;
  emit('bossDefeated', {
    wave: state.wave,
    x: d.x,
    z: d.z,
    soldiers: CONFIG.boss.rewardSoldiers,
  });
});

// Boss 出拳动画演完了：画面层播完那个动作才派这条，玩法层据此允许下一拳。
// 拿不到这条（模型没加载 / 没有出拳动作）时会走 attackFallback 的兜底间隔。
events.addEventListener('bossAttackDone', (e) => {
  const id = e.detail && e.detail.id;
  const z = state.zombies.find((zb) => zb.id === id);
  if (!z || !z.boss || !z.attackAnimating) return;

  // 只留一个很短的收招停顿就开下一拳，别让动作接得太生硬
  z.attackAnimUntil = Math.min(
    z.attackAnimUntil,
    state.time + CONFIG.boss.attackGap
  );
});

/* ----------------------------------------------------------
 * 输入：键盘 + 触摸拖动
 * ---------------------------------------------------------- */
window.addEventListener('keydown', (e) => {
  // Esc 开关暂停；暂停期间不响应移动和选卡
  if (e.key === 'Escape' && state.status === 'playing') {
    if (!e.repeat) setPaused(!state.paused);
    return;
  }
  if (state.paused) return;

  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = true;
  if (e.key.startsWith('Arrow')) e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = false;
});

window.addEventListener('pointerdown', (e) => {
  // 只有点在游戏画布上才算"拖动战场"。
  // 技能栏、抽卡、暂停菜单、测试面板都在画布外，点它们不能带着士兵跑。
  if (!e.target || typeof e.target.closest !== 'function' ||
      !e.target.closest('#game-container')) {
    input.pointerActive = false;
    return;
  }

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
 * 时代 / 地图排程
 * 每个时代随机抽 3 张地图，每张打 CONFIG.era.everyWaves 波，
 * 三张打完才进下一个时代。
 * ---------------------------------------------------------- */
function wavesPerEra() {
  return CONFIG.era.everyWaves * CONFIG.era.mapsPerEra;
}

function eraForWaveNumber(wave) {
  return Math.min(
    CONFIG.era.count - 1,
    Math.floor((wave - 1) / wavesPerEra())
  );
}

function mapIndexForWave(wave) {
  const within = (wave - 1) % wavesPerEra();
  return Math.floor(within / CONFIG.era.everyWaves);
}

// 从该时代的图池里随机抽 3 张；preferred 是开始页选中的地图，优先放在第一张
function pickEraMapSet(era, preferred = null) {
  const need = CONFIG.era.mapsPerEra;
  const pool = eraMaps(era).filter((m) => m !== preferred);

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const picked = [];
  if (preferred) picked.push(preferred);
  for (const m of pool) {
    if (picked.length >= need) break;
    picked.push(m);
  }

  // 时代图池不足 3 张时循环补足，保证排程长度固定
  while (picked.length < need) {
    picked.push(picked[picked.length % Math.max(1, picked.length)] || START_MAP);
  }
  return picked.slice(0, need);
}

/* ----------------------------------------------------------
 * 地图环境事件
 * ---------------------------------------------------------- */
function envEventName(ev) {
  if (!ev) return '';
  if (ev.id === 'weather') {
    return WEATHER_NAMES[ev.weatherKind] || ENV_EVENTS.weather.name;
  }
  return ENV_EVENTS[ev.id]?.name || '';
}

function prepareMapEvent() {
  // 换地图/重开时先清掉上一张图的事件和负面状态
  if (state.envEvent?.phase === 'active' && state.envEvent.id === 'weather') {
    emit('envWeatherEnd', {});
  }
  state.envEvent = null;
  state.envZones.length = 0;
  state.envZoneTick = 0;
  state.envSlowMul = 1;
  state.envWeatherUntil = 0;
  state.envDebuff = { until: 0, moveMul: 1, fireRateMul: 1, spreadMul: 1 };

  const id = MAP_ENV[state.mapId];
  if (!id || !ENV_EVENTS[id]) return;

  state.envEvent = {
    id,
    mapId: state.mapId,
    wave: 1 + Math.floor(Math.random() * CONFIG.era.everyWaves),
    phase: 'idle',
    timer: 0,
    spots: [],
    weatherKind: id === 'weather'
      ? (WEATHER_KIND[state.mapId] || 'rain')
      : null,
  };
}

// 测试面板用：立刻触发当前地图的环境事件（测试模式不再等随机波次）
function triggerEnvEventNow() {
  if (state.status !== 'playing') return false;
  const ev = state.envEvent;
  if (!ev || ev.phase === 'warning' || ev.phase === 'active' ||
      ev.mapId !== state.mapId) {
    prepareMapEvent();
  }
  const next = state.envEvent;
  if (!next || next.phase === 'warning' || next.phase === 'active') return false;

  next.forced = true;
  next.phase = 'warning';
  next.timer = ENV_EVENTS[next.id].warn;
  buildEnvSpots(next);
  emit('skillNotice', {
    text: `环境事件：${envEventName(next)} · ${next.timer} 秒后生效`,
    kind: 'era',
  });
  for (const spot of next.spots) {
    emit('envWarning', {
      x: spot.x,
      z: spot.z,
      radius: spot.radius,
      kind: spot.kind,
    });
  }
  return true;
}

function buildEnvSpots(ev) {
  const half = CONFIG.world.halfWidth;
  const clampX = (x) => Math.max(-half + 1, Math.min(half - 1, x));
  const playerSpot = {
    x: clampX(state.player.x),
    z: state.player.z - 1.5,
    radius: 2.6,
    kind: 'meteor',
  };

  if (ev.id === 'meteor') {
    const points = topDensestPoints(2);
    ev.spots = [
      playerSpot,
      ...points.map((p) => ({ x: p.x, z: p.z, radius: 2.6, kind: 'meteor' })),
    ];
    return;
  }

  if (ev.id === 'toxic' || ev.id === 'lava') {
    const radius = ev.id === 'toxic' ? 2.5 : 2.4;
    const points = topDensestPoints(2);
    const playerZone = {
      x: clampX(state.player.x + (Math.random() * 2 - 1) * 2.4),
      z: state.player.z - 1.5,
      radius,
      kind: ev.id,
    };
    ev.spots = [
      playerZone,
      ...points.map((p) => ({ x: p.x, z: p.z, radius, kind: ev.id })),
    ];
    return;
  }

  ev.spots = [];
}

function setEnvDebuff(moveMul, fireRateMul, spreadMul, duration) {
  state.envDebuff = {
    until: state.time + duration,
    moveMul,
    fireRateMul,
    spreadMul,
  };
}

function startEnvActive(ev) {
  const now = state.time;

  if (ev.id === 'quake') {
    setEnvDebuff(0.8, 1, 1.5, 3);
    for (let i = state.zombies.length - 1; i >= 0; i--) {
      const z = state.zombies[i];
      z.envStunUntil = now + (z.boss ? 0.4 : 0.8);
      const maxHp = Math.max(1, z.maxHp || z.hp);
      damageZombieAt(i, maxHp * (z.boss ? 0.025 : 0.05));
    }
    emit('envQuake', {});
    return;
  }

  if (ev.id === 'meteor') {
    for (const spot of ev.spots) {
      emit('meteor', { x: spot.x, z: spot.z });
    }
    return;
  }

  if (ev.id === 'weather') {
    state.envSlowMul = 0.85;
    state.envWeatherUntil = now + ENV_EVENTS.weather.active;
    setEnvDebuff(1, 0.9, 1, ENV_EVENTS.weather.active);
    emit('envWeatherStart', { kind: ev.weatherKind });
    return;
  }

  if (ev.id === 'toxic' || ev.id === 'lava') {
    const active = ENV_EVENTS[ev.id].active;
    for (const spot of ev.spots) {
      state.envZones.push({
        x: spot.x,
        z: spot.z,
        radius: spot.radius,
        kind: ev.id,
        until: now + active,
        pct: ev.id === 'toxic' ? 0.02 : 0.04,
        playerDps: ev.id === 'toxic' ? 1 : 2,
      });
    }
    emit('envZoneStart', { zones: state.envZones.slice(), duration: active });
    return;
  }

  if (ev.id === 'emp') {
    setEnvDebuff(1, 0.75, 1, 2);
    for (const z of state.zombies) {
      z.envStunUntil = now + (z.boss ? 0.5 : 1.5);
    }
    emit('envEmp', {});
  }
}

function updateEnvZones(dt) {
  if (!state.envZones.length) return;

  state.envZones = state.envZones.filter((z) => state.time < z.until);
  if (!state.envZones.length) return;

  // 僵尸在毒雾/熔岩里持续掉最大生命
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];
    let pct = 0;
    for (const zone of state.envZones) {
      const dx = z.x - zone.x;
      const dz = z.z - zone.z;
      if (dx * dx + dz * dz <= zone.radius * zone.radius) {
        pct = Math.max(pct, zone.pct);
      }
    }
    if (pct <= 0) continue;
    const maxHp = Math.max(1, z.maxHp || z.hp);
    damageZombieAt(i, maxHp * pct * dt);
  }

  // 玩家站在毒雾/熔岩里每秒掉兵
  let playerDps = 0;
  for (const zone of state.envZones) {
    const dx = state.player.x - zone.x;
    const dz = state.player.z - zone.z;
    if (dx * dx + dz * dz <= zone.radius * zone.radius) {
      playerDps = Math.max(playerDps, zone.playerDps);
    }
  }

  if (playerDps <= 0) {
    state.envZoneTick = 0;
    return;
  }

  state.envZoneTick -= dt;
  if (state.envZoneTick <= 0) {
    state.envZoneTick = 1;
    damageArmy(playerDps, 'env');
  }
}

function endEnvEvent(ev) {
  if (ev.id === 'weather') emit('envWeatherEnd', {});
  state.envZones.length = 0;
  state.envZoneTick = 0;
  state.envSlowMul = 1;
  state.envWeatherUntil = 0;
  state.envDebuff = { until: 0, moveMul: 1, fireRateMul: 1, spreadMul: 1 };
  ev.phase = 'done';
  ev.timer = 0;
  emit('envEventEnd', { id: ev.id });
}

function updateEnvEvent(dt) {
  if (state.upgradePanel.active) return;
  if (state.testMode && !state.envEvent?.forced) return;
  if (!state.envEvent || state.status !== 'playing') return;

  const ev = state.envEvent;
  const db = state.envDebuff;
  if (db.until > 0 && state.time >= db.until) {
    state.envDebuff = { until: 0, moveMul: 1, fireRateMul: 1, spreadMul: 1 };
  }
  if (state.envWeatherUntil > 0 && state.time >= state.envWeatherUntil) {
    state.envSlowMul = 1;
    state.envWeatherUntil = 0;
  }

  const mapWave = ((state.wave - 1) % CONFIG.era.everyWaves) + 1;

  if (ev.phase === 'idle') {
    if (mapWave !== ev.wave) return;
    ev.phase = 'warning';
    ev.timer = ENV_EVENTS[ev.id].warn;
    buildEnvSpots(ev);
    emit('skillNotice', {
      text: `环境事件：${envEventName(ev)} · ${ev.timer} 秒后生效`,
      kind: 'era',
    });
    for (const spot of ev.spots) {
      emit('envWarning', {
        x: spot.x,
        z: spot.z,
        radius: spot.radius,
        kind: spot.kind,
      });
    }
    return;
  }

  if (ev.phase === 'warning') {
    ev.timer -= dt;
    if (ev.timer > 0) return;
    ev.phase = 'active';
    ev.timer = ENV_EVENTS[ev.id].active;
    startEnvActive(ev);
    return;
  }

  if (ev.phase === 'active') {
    updateEnvZones(dt);
    ev.timer -= dt;
    if (ev.timer <= 0) endEnvEvent(ev);
  }
}

/* ----------------------------------------------------------
 * 开局 / 复活
 * ---------------------------------------------------------- */
function resetState(opts = {}) {
  state.status = 'playing';
  state.paused = false;
  state.testMode = !!opts.testMode;

  // 从指定时代开局：时代对应的波次一起跳过去，僵尸血量、Boss、卡池
  // 全部沿用现有的按波次规则，不需要再单独做一套僵尸数值。
  const startEra = Math.max(
    0,
    Math.min(CONFIG.era.count - 1, Math.floor(opts.startingEra || 0))
  );
  // 晚期时代开局只认该时代图池里的地图；?era=4 没带 ?map= 时不能落到 city
  const eraPool = eraMaps(startEra);
  // 地图必须属于起始时代。以前 startEra === 0 时放行任意地图，
  // 会出现「中世纪数值 + 星际场景」的搭配；现在开始页也双向绑定了时代。
  const pickedMap =
    opts.map && eraPool.includes(opts.map)
      ? opts.map
      : null;
  const startMap =
    pickedMap ||
    (startEra > 0 ? pickEraMap(startEra, []) : START_MAP) ||
    START_MAP;
  // 每个时代 3 张地图，开始页选中的那张排第一
  const startMaps = pickEraMapSet(startEra, startMap);
  const startWave = state.testMode
    ? 1
    : startEra * wavesPerEra() + 1;

  state.time = state.testMode ? 0 : (startWave - 1) * CONFIG.wave.duration;
  // HUD 的下一波倒计时以此为起点；不重置会沿用上一局/默认的旧值
  setWaveClock(state.time);
  state.wave = startWave;
  state.score = 0;
  state.soldiers = state.testMode
    ? 120
    : CONFIG.era.startSoldiers[startEra];
  state.peakSoldiers = state.soldiers;
  state.player.x = 0;
  state.era = startEra;
  state.eraMaps = startMaps;
  state.mapIndex = 0;
  state.mapId = startMaps[0] || startMap;
  state.usedMaps = [state.mapId];
  state.startEra = startEra;
  state.startMap = state.mapId;
  state.weapon.lines = 1;
  state.weapon.pierce = false;
  state.weapon.pierceLevel = 0;
  state.weapon.timers = [0];

  state.upgrades.damage = 1;
  state.upgrades.moveSpeed = 1;
  state.upgrades.damageReduction = 0;
  state.upgrades.barrelDamage = 1;
  state.upgrades.fireRate = 1;

  state.upgradePanel.active = false;
  state.upgradePanel.picks = 0;
  state.upgradePanel.timeLeft = 0;
  state.upgradeCarry = 0;
  state.envEvent = null;
  state.envDebuff = { until: 0, moveMul: 1, fireRateMul: 1, spreadMul: 1 };
  state.envZones.length = 0;
  state.envZoneTick = 0;
  state.envSlowMul = 1;
  state.envWeatherUntil = 0;
  state.timeScale = 1;

  state.slots.siege = false;
  state.slots.support = false;
  state.slots.closeDefense = false;
  state.slots.command = false;
  state.slots.summon = false;
  state.slotLevels = { siege: 0, support: 0, closeDefense: 0, command: 0, summon: 0 };
  state.commandMarkId = 0;
  state.commandMarkBonus = 0;
  state.commandMarkTimer = 0;
  state.skillBag = [];
  state.skillBagVersion += 1;
  state.lastGainedSkillId = null;
  state.lastGainedSkillVersion = 0;
  state.skillUseCd = 0;
  state.usedSkills = [];
  state.weaponBoostUntil = 0;
  state.weaponBoostDamage = 1;
  state.weaponBoostRate = 1;

  state.slotTimers.siege = 3;
  state.slotTimers.support = 6;
  state.slotTimers.closeDefense = 0;
  state.slotTimers.summon = 2;
  state.slowUntil = 0;
  state.slowMul = 1;
  state.buffUntil = 0;
  state.buffMul = 1;
  state.freezeUntil = 0;
  state.entropyUntil = 0;
  state.entropyStart = 0;
  state.entropyPct = 0;
  state.entropyRamp = 0.88;
  state.entropyMinMul = 0.18;

  state.bullets.length = 0;
  state.barriers.length = 0;
  state.zombies.length = 0;
  state.rollingLogs.length = 0;
  state.knightCharges.length = 0;
  state.campfireZones.length = 0;
  state.napalmWalls.length = 0;
  state.siegeShots.length = 0;
  state.tankSupports.length = 0;
  state.apcCharges.length = 0;
  state.carrierDrones.length = 0;
  state.swarmDrones.length = 0;
  state.swarm.until = 0;
  state.swarm.left = 0;
  state.swarm.timer = 0;
  state.friendlyZombies.length = 0;
  state.summonNextPreferred = null;
  state.blackHoles.length = 0;
  state.plagueShots.length = 0;
  state.plagueSpreadTimer = 0;
  state.virusBombs.length = 0;

  state.barrierTimer = 0.6;
  state.zombieTimer = 1.0;
  state.zombieSpawnPauseUntil = 0;
  state.barrelTimer = CONFIG.barrel.spawnInterval;
  state.crateTimer = CONFIG.crate.firstDelay;
  state.crates.length = 0;
  state.enemyShots.length = 0;
  state.floodLevel = 0;
  setWaterLevel(0);
  state.chains.length = 0;
  state.pits.length = 0;
  state.pitTimer = CONFIG.pit.interval;
  state.pickups.length = 0;
  state.pickupTimer = CONFIG.pickup.firstDelay;
  state.playerWeapon = null;
  state.nextId = 1;
  state.spawnCounts.fill(0);
  resetBarricade();

  // 测试模式：五个槽位全部 1 级，弹药和兵都管够
  if (state.testMode) {
    for (const id of SLOT_IDS) setSlotLevel(id, 1);
    setSlotLevel('barricade', 1);
  } else {
    applyStartingLoadout(startEra);
  }

  // 开局用的地图也要预载贴图：玩家在开始页已经选好图了，
  // 这里如果还没加载完，会先出现灰地面。预载是幂等的，重复调没代价。
  preloadGroundTexture(`b-map-${state.mapId}`);
  prepareMapEvent();

  // 把画面切到开局时代和地图，静默切换，不弹提示
  switchEra(state.era, state.mapId, { fade: false, silent: true });
}

function startGame(opts = {}) {
  resetState(opts);
}

// 暂停：主循环跳过 update，画面冻结在最后一帧
function setPaused(paused) {
  if (state.status !== 'playing') {
    state.paused = false;
    return;
  }

  state.paused = !!paused;
  if (state.paused) {
    input.left = false;
    input.right = false;
    input.pointerActive = false;
  }
}

// 从不同时代开局时的初始配置：
// 二战/现代给 1 级穿透器和 1 级火力增援；后现代起额外按时代给槽位；
// 中世纪什么都不给。
function applyStartingLoadout(era) {
  const weaponTier = era >= 5 ? 3 : era >= 4 ? 2 : era >= 1 ? 1 : 0;
  const slotTier = era >= 5 ? 3 : era >= 4 ? 2 : era >= 3 ? 1 : 0;

  if (weaponTier > 0) {
    state.weapon.pierce = true;
    state.weapon.pierceLevel = weaponTier;
    // 火力增援 1 级 = 2 个枪位，3 级 = 4 个
    state.weapon.lines = Math.min(CONFIG.weapon.maxLines, 1 + weaponTier);
  }

  if (slotTier > 0) {
    for (const id of SLOT_IDS) setSlotLevel(id, slotTier);
    setSlotLevel('barricade', slotTier);
  }
}

// 从暂停菜单返回开始页。整局状态等下一次开始游戏时再重置
function returnToMenu() {
  state.paused = false;
  state.status = 'menu';
  state.upgradePanel.active = false;
  state.upgradePanel.picks = 0;
  state.envEvent = null;
  state.envZones.length = 0;
  state.envDebuff = { until: 0, moveMul: 1, fireRateMul: 1, spreadMul: 1 };
  state.envSlowMul = 1;
  state.timeScale = 1;
  state.skillUseCd = 0;
  input.left = false;
  input.right = false;
  input.pointerActive = false;
}

function revive() {
  if (state.status !== 'over') return;

  state.status = 'playing';
  // 复活兵力随波次增长，后期看广告复活不至于等于送死
  state.soldiers = 20 + 3 * state.wave;
  state.bullets.length = 0;
  state.barriers.length = 0;
  state.zombies.length = 0;
  state.rollingLogs.length = 0;
  state.knightCharges.length = 0;
  state.campfireZones.length = 0;
  state.napalmWalls.length = 0;
  state.siegeShots.length = 0;
  state.tankSupports.length = 0;
  state.apcCharges.length = 0;
  state.carrierDrones.length = 0;
  state.swarmDrones.length = 0;
  state.swarm.until = 0;
  state.swarm.left = 0;
  state.swarm.timer = 0;
  state.friendlyZombies.length = 0;
  state.summonNextPreferred = null;
  state.blackHoles.length = 0;
  state.plagueShots.length = 0;
  state.plagueSpreadTimer = 0;
  state.virusBombs.length = 0;
  state.weaponBoostUntil = 0;
  state.weaponBoostDamage = 1;
  state.weaponBoostRate = 1;
  state.barrierTimer = 0.4;
  state.zombieTimer = 0.8;
  state.zombieSpawnPauseUntil = 0;

  // 复活保留已经解锁的路障，并把它修好；没解锁就保持没有
  const b = state.barricade;
  if (b.unlocked) {
    b.active = true;
    b.hp = b.maxHp;
    b.cooldown = 0;
    emit('barricadeRebuild', {});
  }
}

// 低于当前时代推荐等级时的折扣：每差 1 级 -15%，最多 -45%
function underLevelMul(level, era = state.era, recommendedOverride = null) {
  const cfg = CONFIG.era;
  const recommended = recommendedOverride
    ? (recommendedOverride[era] || 1)
    : (cfg.recommendedLevel[era] || 1);
  const behind = Math.max(0, recommended - level);
  return Math.max(
    cfg.underLevelMin,
    1 - cfg.underLevelStep * behind
  );
}

// 召唤槽某个兵种在某等级、某时代下的实际数值。
// 和槽位共用同一套公式：基础值 × 时代倍率 × 等级倍率 × 欠级折扣。
function summonUnitStatsAt(key, level, era = state.era) {
  const cfg = CONFIG.slots.summon;
  const unit = cfg.units[key];
  if (!unit) return null;

  const lv = Math.min(cfg.levels.length, Math.max(1, Math.floor(level)));
  const row = cfg.levels[lv - 1];
  const under = underLevelMul(lv, era, cfg.recommendedByEra);
  const atkMul = CONFIG.era.attackPower[era] * row.damageMul * under;

  return {
    key,
    name: unit.name,
    short: unit.short,
    hp: Math.round(unit.hp * CONFIG.era.hpPower[era] * row.hpMul * under),
    damage: Math.round(unit.damage * atkMul),
    speed: unit.speed,
    attackInterval: unit.attackInterval || 0.7,
    cost: unit.cost || 1,
    max: unit.max || Infinity,
    range: unit.range || 0,
    explodeRadius: unit.explodeRadius || 0,
    scale: unit.scale || 1,
  };
}

// 槽位在某个等级、某个时代下的实际数值（不读 state，方便卡面和测试面板预览）
function slotStatsAt(id, level, era = state.era) {
  const cfg = CONFIG.slots[id];
  if (!cfg) return null;

  const lv = Math.min(cfg.levels.length, Math.max(1, Math.floor(level)));
  const row = cfg.levels[lv - 1];
  const under = underLevelMul(lv, era, cfg.recommendedByEra || null);

  if (id === 'summon') {
    const units = {};
    for (const key of Object.keys(cfg.units)) {
      units[key] = summonUnitStatsAt(key, lv, era);
    }
    return {
      interval: row.interval,
      budget: row.budget,
      maxAlive: row.budget, // 兼容旧字段名
      weights: cfg.weights[lv - 1],
      units,
    };
  }

  if (id === 'support') {
    return {
      heal: Math.max(1, Math.round(cfg.baseHeal * CONFIG.era.healPower[era] * row.healMul * under)),
      interval: row.interval,
    };
  }

  if (id === 'command') {
    return {
      markBonus: cfg.baseMark * CONFIG.era.commandPower[era] * row.mul * under,
    };
  }

  return {
    damage: Math.round(cfg.baseDamage * CONFIG.era.attackPower[era] * row.damageMul * under),
    radius: row.radius,
    interval: row.interval,
  };
}

function slotStats(id) {
  return slotStatsAt(id, state.slotLevels[id] || 1);
}

// 一行文字描述，卡面和测试面板共用
function slotSummary(id, level, era = state.era) {
  if (id === 'barricade') {
    const s = barricadeStatsAt(level, era);
    return `${s.hp} 血 / 反击 ${s.damage} / 宽 ${s.width}`;
  }

  const s = slotStatsAt(id, level, era);
  if (!s) return '';

  if (id === 'support') return `${s.heal} 兵 / ${s.interval.toFixed(1)}s`;
  if (id === 'command') return `集火伤害 +${(s.markBonus * 100).toFixed(1)}%`;
  if (id === 'summon') {
    const mix = Object.entries(s.weights)
      .map(([key, w]) => `${s.units[key].short}${w}%`)
      .join(' ');
    return `${mix} · ${s.interval.toFixed(1)}s · 预算${s.budget}`;
  }
  return `${s.damage} 伤 / 半径 ${s.radius} / ${s.interval.toFixed(1)}s`;
}

function barricadeStatsAt(level, era = state.era) {
  const levels = CONFIG.barricade.levels;
  const i = Math.min(levels.length - 1, Math.max(0, Math.floor(level) - 1));
  const row = levels[i];
  const under = underLevelMul(i + 1, era);

  return {
    hp: Math.round(row.hp * CONFIG.era.hpPower[era] * under),
    damage: Math.round(row.damage * CONFIG.era.attackPower[era] * under),
    width: row.width,
  };
}

function applyBarricadeLevel(level, opts = {}) {
  const b = state.barricade;
  const next = Math.min(
    CONFIG.barricade.levels.length,
    Math.max(1, Math.floor(level))
  );
  const stats = barricadeStatsAt(next);
  const prevMax = b.maxHp || stats.hp;
  const hpRatio = prevMax > 0 ? b.hp / prevMax : 1;

  b.unlocked = true;
  b.level = next;
  b.maxHp = stats.hp;
  b.width = stats.width;
  b.xMin = CONFIG.barricade.xMin;
  b.xMax = CONFIG.barricade.xMin + stats.width;
  b.damage = stats.damage;

  if (opts.full) b.hp = b.maxHp;
  else if (opts.keepRatio) b.hp = Math.round(b.maxHp * hpRatio);
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

// 设置槽位等级：0 = 未解锁，1-5 = 对应等级。抽卡和测试面板都走这里。
function setSlotLevel(id, level) {
  if (id === 'barricade') {
    const lv = Math.max(0, Math.min(SLOT_MAX_LEVEL, Math.floor(level)));
    if (lv === 0) {
      resetBarricade();
      return;
    }

    const firstTime = state.barricade.level === 0;
    applyBarricadeLevel(lv, firstTime ? { full: true } : { keepRatio: true });
    state.barricade.active = true;
    state.barricade.cooldown = 0;
    emit('barricadeUpgrade', { level: state.barricade.level });
    return;
  }

  if (!SLOT_IDS.includes(id)) return;

  const prevLv = state.slotLevels[id] || 0;
  const lv = Math.max(0, Math.min(SLOT_MAX_LEVEL, Math.floor(level)));
  state.slotLevels[id] = lv;
  state.slots[id] = lv > 0;

  if (lv > 0) {
    // 刚解锁时尽快打一次，方便看效果
    state.slotTimers[id] = Math.min(state.slotTimers[id] ?? 0.5, 0.5);
    emit('slotUnlock', { id });
  }

  // 召唤槽升级：免费送一只新兵种，之后的第一只也优先出它。
  // 预算不够（比如场上已经塞满）就送不出来，等下一只按权重自然出。
  if (id === 'summon' && lv > prevLv && lv >= 2) {
    const newUnit = CONFIG.slots.summon.newUnitAtLevel[lv];
    if (newUnit) {
      const stats = slotStatsAt('summon', lv);
      state.summonNextPreferred = newUnit;
      trySpawnSummonUnit(stats, newUnit);
    }
  }
}

// 星际（era >= 4）起保底自动解锁召唤槽。
// 后现代（era 3）是「靠抽卡解锁」的窗口：解锁卡和升级卡都从这个时代开始出现，
// 所以不能一进后现代就自动送 1 级，否则解锁卡永远抽不到、等于白写一张卡。
function ensureSummonSlot() {
  if (state.era >= 4 && state.slotLevels.summon === 0) {
    setSlotLevel('summon', 1);
    emit('skillNotice', { text: '召唤槽已解锁', kind: 'skill' });
  }
}

// 换时代后重新算路障血量和反击伤害；槽位数值是每帧算的，不用刷新
function refreshSlotsForEra() {
  if (state.barricade.unlocked) {
    applyBarricadeLevel(state.barricade.level, { keepRatio: true });
  }
}

function getSlotInfo() {
  return [
    ...SLOT_IDS.map((id) => ({
      id,
      name: SLOT_NAMES[id],
      level: state.slotLevels[id] || 0,
      max: SLOT_MAX_LEVEL,
      desc: state.slotLevels[id] > 0
        ? slotSummary(id, state.slotLevels[id])
        : '未解锁',
    })),
    {
      id: 'barricade',
      name: SLOT_NAMES.barricade,
      level: state.barricade.unlocked ? state.barricade.level : 0,
      max: SLOT_MAX_LEVEL,
      desc: state.barricade.unlocked
        ? slotSummary('barricade', state.barricade.level)
        : '未解锁',
    },
  ];
}

function getTestData() {
  return {
    eras: CONFIG.era.names,
    slots: [
      ...SLOT_IDS.map((id) => ({ id, name: SLOT_NAMES[id] })),
      { id: 'barricade', name: SLOT_NAMES.barricade },
    ],
    skills: SKILL_DEFS.map((s) => ({
      id: s.id,
      name: s.name,
      era: s.era,
    })),
  };
}

// 测试模式：切时代不走波次逻辑，避免下一波又被拽回去
function setEraForTest(index) {
  if (!state.testMode) return;

  const eraIndex = Math.max(
    0,
    Math.min(CONFIG.era.count - 1, Math.floor(index))
  );
  if (eraIndex === state.era) return;

  const map = pickEraMap(eraIndex, state.usedMaps) || state.mapId || START_MAP;
  state.era = eraIndex;
  state.mapId = map;
  state.usedMaps.push(map);

  ensureSummonSlot();
  switchEra(eraIndex, map);
  refreshSlotsForEra();
}

function spawnTestZombies(count = 20) {
  if (!state.testMode) return;

  for (let i = 0; i < count; i++) {
    spawnZombie();
    const z = state.zombies[state.zombies.length - 1];
    if (z) z.z = -16 + Math.random() * 14; // 直接放在中场，方便技能命中
  }
}

function clearTestZombies() {
  if (!state.testMode) return;
  state.zombies.length = 0;
}

if (typeof window !== 'undefined') {
  window.__setBarricadeLevel = (n) => {
    applyBarricadeLevel(n, { full: true });
    emit('barricadeUpgrade', { level: state.barricade.level });
  };
  window.__upgradeBarricade = upgradeBarricade;
  window.__castSkill = castSkill;
  window.__setSlotLevel = setSlotLevel;
  window.__slotInfo = getSlotInfo;
  window.__gainSkill = gainSkill;
  window.__useSkill = useSkill;
  window.__skillBag = getSkillBag;
  window.__convertExpiredSkills = convertExpiredSkills;
  // 事件总线：排查"某条事件到底派没派"时只能靠它，控制台里 __events.addEventListener(...)
  window.__events = events;
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
    desc: () => `解锁攻城 1 级：${slotSummary('siege', 1)}`,
    can: () => !state.slotLevels.siege,
    apply: () => setSlotLevel('siege', 1),
  },
  {
    id: 'slotSiegeUpgrade',
    name: '攻城升级',
    desc: () => `攻城 ${state.slotLevels.siege} → ${state.slotLevels.siege + 1} 级，${slotSummary('siege', state.slotLevels.siege + 1)}`,
    can: () => state.slotLevels.siege > 0 && state.slotLevels.siege < SLOT_MAX_LEVEL,
    apply: () => setSlotLevel('siege', state.slotLevels.siege + 1),
  },
  {
    id: 'slotClose',
    name: '近防槽',
    desc: () => `解锁近防 1 级：${slotSummary('closeDefense', 1)}`,
    can: () => !state.slotLevels.closeDefense,
    apply: () => setSlotLevel('closeDefense', 1),
  },
  {
    id: 'slotCloseUpgrade',
    name: '近防升级',
    desc: () => `近防 ${state.slotLevels.closeDefense} → ${state.slotLevels.closeDefense + 1} 级，${slotSummary('closeDefense', state.slotLevels.closeDefense + 1)}`,
    can: () => state.slotLevels.closeDefense > 0 && state.slotLevels.closeDefense < SLOT_MAX_LEVEL,
    apply: () => setSlotLevel('closeDefense', state.slotLevels.closeDefense + 1),
  },
  {
    id: 'slotSupport',
    name: '支援槽',
    desc: () => `解锁支援 1 级：${slotSummary('support', 1)}`,
    can: () => !state.slotLevels.support,
    apply: () => setSlotLevel('support', 1),
  },
  {
    id: 'slotSupportUpgrade',
    name: '支援升级',
    desc: () => `支援 ${state.slotLevels.support} → ${state.slotLevels.support + 1} 级，${slotSummary('support', state.slotLevels.support + 1)}`,
    can: () => state.slotLevels.support > 0 && state.slotLevels.support < SLOT_MAX_LEVEL,
    apply: () => setSlotLevel('support', state.slotLevels.support + 1),
  },
  {
    id: 'slotCommand',
    name: '指挥槽',
    desc: () => `解锁指挥 1 级：${slotSummary('command', 1)}`,
    can: () => !state.slotLevels.command,
    apply: () => setSlotLevel('command', 1),
  },
  {
    id: 'slotCommandUpgrade',
    name: '指挥升级',
    desc: () => `指挥 ${state.slotLevels.command} → ${state.slotLevels.command + 1} 级，${slotSummary('command', state.slotLevels.command + 1)}`,
    can: () => state.slotLevels.command > 0 && state.slotLevels.command < SLOT_MAX_LEVEL,
    apply: () => setSlotLevel('command', state.slotLevels.command + 1),
  },
  {
    // 召唤是后现代（era >= 3）才登场的槽位：解锁卡和升级卡都只在这个时代之后出现。
    // 前期抽到也没有意义（只有一只盾尸），不如让三选一的位置留给别的卡。
    id: 'slotSummon',
    name: '召唤槽',
    desc: () => `解锁召唤 1 级：${slotSummary('summon', 1)}`,
    can: () => state.era >= 3 && !state.slotLevels.summon,
    apply: () => setSlotLevel('summon', 1),
  },
  {
    id: 'slotSummonUpgrade',
    name: '召唤升级',
    desc: () => `召唤 ${state.slotLevels.summon} → ${state.slotLevels.summon + 1} 级，${slotSummary('summon', state.slotLevels.summon + 1)}`,
    can: () => state.era >= 3 && state.slotLevels.summon > 0 && state.slotLevels.summon < SLOT_MAX_LEVEL,
    apply: () => setSlotLevel('summon', state.slotLevels.summon + 1),
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

/* 一次性技能：抽到后存进技能栏，按效果类型走通用逻辑 */
const SKILL_DEFS = [
  // 0 中世纪
  // 半径 4 = 屏幕半宽，直径 8 刚好是屏幕宽度的一半
  // 50 伤害：中世纪 1-4 波普通僵尸最高 44 血，保证能秒杀
  { id: 'arrowRain', name: '箭雨', era: 0, type: 'aoe', damage: 50, radius: 4.0, color: 0xd9b36c },
  { id: 'rollingLog', name: '滚木', era: 0, type: 'rollingLog', color: 0x9c6b3f },
  { id: 'holyWater', name: '圣水', era: 0, type: 'heal', soldiers: 20, color: 0x8fe3b0 },
  { id: 'knightCharge', name: '骑士冲锋', era: 0, type: 'knightCharge', color: 0xc9d4e0 },
  { id: 'campfire', name: '篝火', era: 0, type: 'campfire', radius: 3.5, color: 0xff9a4d },
  // 1 二战
  { id: 'airStrike', name: '空袭', era: 1, type: 'airStrike', damage: 70, radius: 2.2, bombs: 3, color: 0xffd27a },
  { id: 'barrage', name: '炮火覆盖', era: 1, type: 'barrage', damage: 25, radius: 2.2, areaRadius: 5, waves: 6, waveInterval: 0.5, color: 0xff8a4d },
  { id: 'napalm', name: '燃烧弹', era: 1, type: 'napalmWall', color: 0xff6a2a },
  { id: 'paratroopers', name: '伞兵增援', era: 1, type: 'heal', soldiers: 10, color: 0x8fb6e0 },
  { id: 'tank', name: '坦克支援', era: 1, type: 'tank', color: 0xb0b8a0 },
  // 2 现代
  { id: 'precision', name: '精确打击', era: 2, type: 'aoe', damage: 110, radius: 2.2, color: 0x9fe3ff },
  { id: 'droneSwarm', name: '无人机蜂群', era: 2, type: 'droneSwarm', color: 0x7fd4ff },
  { id: 'emp', name: '电磁脉冲', era: 2, type: 'freeze', duration: 2, color: 0x6fa8ff },
  { id: 'apc', name: '装甲车冲锋', era: 2, type: 'apc', color: 0x8f9a7a },
  { id: 'supplyDrop', name: '空投补给', era: 2, type: 'weaponDrop', color: 0x5adf7a },
  // 3 后现代
  { id: 'virusBomb', name: '病毒炸弹', era: 3, type: 'virusBomb', radius: 2.6, color: 0x8fe36a },
  { id: 'bioLegion', name: '生物人军团', era: 3, type: 'friendlyLegion', color: 0x9c6bff },
  { id: 'geneBurst', name: '基因爆发', era: 3, type: 'buff', duration: 5, mul: 2, color: 0x6dffb0 },
  { id: 'timeSlow', name: '时间减速', era: 3, type: 'slow', duration: 4, mul: 0.5, color: 0x8fb6ff },
  { id: 'memory', name: '记忆植入', era: 3, type: 'plague', color: 0x8fe36a },
  // 4 星际
  { id: 'orbital', name: '轨道轰炸', era: 4, type: 'orbital', color: 0x7fe3ff },
  // 黑洞：持续吸附 1.2 秒，结束时按最大生命百分比结算。
  // 不用固定伤害，避免低波次直接清场、高波次又像没伤害。
  { id: 'blackHole', name: '黑洞', era: 4, type: 'pull', duration: 1.2, damagePct: 0.12, bossPctMul: 0.5, radius: 3.0, pullRadius: 12, pullFactor: 0.85, color: 0x6a4dff },
  { id: 'wormhole', name: '虫洞', era: 4, type: 'warp', color: 0xb06bff },
  { id: 'carrierDrones', name: '舰载无人机群', era: 4, type: 'carrierDrones', color: 0x9fe3ff },
  { id: 'timeDilation', name: '时间膨胀', era: 4, type: 'slow', duration: 3, mul: 0.4, color: 0x8fb6ff },
  // 5 终幕
  // 三张牌三种单位：审判按敌人血量百分比处决，献祭按全场总血量比例削，
  // 重启按士兵峰值比例回补。固定数值在无限波次里会失效，见 docs/技能说明.md
  {
    id: 'finalJudgment', name: '终焉审判', era: 5, type: 'execute',
    executeLine: 0.5,   // 生命 ≤50% 直接处决
    chipDamage: 0.20,   // 没到阈值的吃 20% 最大生命
    bossDamage: 0.30,   // Boss 不处决，改吃 30% 最大生命
    color: 0xffffff,
  },
  { id: 'cosmicCollapse', name: '宇宙坍缩', era: 5, type: 'pull', radius: 6.0, pullRadius: 14, pullFactor: 0.85, innerCut: 0.35, outerCut: 0.15, bossCutMul: 0.5, color: 0x6a4dff },
  {
    id: 'sacrifice', name: '献祭', era: 5, type: 'sacrifice',
    soldiers: 20, requiresSoldiers: 20,
    shave: 0.5,         // 全场生命上限与当前生命一起砍半
    bossShave: 0.75,    // Boss 只砍到 75%
    color: 0xff5a5a,
  },
  {
    id: 'reboot', name: '重启', era: 5, type: 'reboot',
    restoreRatio: 0.8,  // 兵回补到本局峰值的 80%
    pause: 3,           // 随后几秒不刷怪
    color: 0xbfe9ff,
  },
  {
    id: 'entropy', name: '熵增', era: 5, type: 'slow',
    duration: 8,
    mul: 0.5,          // 起始减速：所有移动 ×0.5
    ramp: 0.88,        // 每秒再乘 0.88，越拖越慢
    minMul: 0.18,      // 最慢到这里
    dpsPct: 0.03,      // 每秒掉 3% 最大生命（8 秒共 24%），不致死
    color: 0x8a8f99,
  },
];

// 一次性技能改成存次数后，每张卡给几次。强技能少给，功能技能多给。
const SKILL_CHARGES = {
  // 中世纪
  arrowRain: 2, rollingLog: 2, holyWater: 3, knightCharge: 2, campfire: 2,
  // 二战
  airStrike: 2, barrage: 2, napalm: 2, paratroopers: 3, tank: 2,
  // 现代
  precision: 2, droneSwarm: 2, emp: 2, apc: 2, supplyDrop: 3,
  // 后现代
  virusBomb: 2, bioLegion: 3, geneBurst: 2, timeSlow: 2, memory: 2,
  // 星际
  orbital: 1, blackHole: 2, wormhole: 3, carrierDrones: 2, timeDilation: 2,
  // 终幕
  finalJudgment: 1, cosmicCollapse: 1, sacrifice: 1, reboot: 1, entropy: 2,
};

const SKILL_DESCS = {
  arrowRain: '圆形箭雨：半径 4 内 50 伤害（直径 8，约屏幕宽度一半）',
  rollingLog: '左侧随机出现，纵向 6 格，从左往右碾压；秒普通僵尸，不秒大块头',
  holyWater: '立刻 +20 兵',
  knightCharge: '右下随机冲 3 个骑士，向上贯穿，每个骑士对每只僵尸 50 伤害',
  campfire: '最密处半径 3.5 火区，持续 5 秒，每秒 12 伤害',
  airStrike: '3 架轰炸机分别炸最密的 3 个点，每颗 70 伤害、半径 2.2',
  barrage: '半径 5 的大范围连续轰炸：3 秒 6 波，每波 25 伤害',
  napalm: '最密处拉一道宽 8、纵深 1.8 的火墙，持续 4 秒，每秒 12 伤害并减速',
  paratroopers: '立刻 +10 兵',
  tank: '底部槽位后方出现坦克，打 5 发范围炮（每发 60、半径 3.0、间隔 1.2 秒）后撤退；场上已有坦克时，新的一辆出现在它右边',
  precision: '最密处半径 2.2 内 110 伤害',
  droneSwarm: '一波内陆续放出 10 架无人机，从屏幕下方起飞、各自随机锁定僵尸，命中造成 65 点小范围伤害',
  emp: '全场僵尸原地停顿 2 秒',
  apc: '慢速向上冲锋，撞到每只僵尸 90 伤害，同时机枪点射最近僵尸',
  supplyDrop: '空投重武器：12 秒内子弹伤害 ×2、射速 ×1.5',
  virusBomb: '最密处投放 2 枚病毒炸弹，范围内僵尸变成己方单位反冲（每枚最多 8 只）',
  bioLegion: '瞬间生成 20 名己方僵尸，向前对冲',
  geneBurst: '全队射速 ×2，持续 5 秒',
  timeSlow: '全场僵尸所有移动 ×0.5，持续 4 秒',
  memory: '从地图外打进一枚传染炮弹，落点感染最多 4 只；感染者每秒扣 3% 最大生命、减速 30%，并在僵尸之间扩散，同时最多 15 只',
  orbital: '横向轨道光柱，清掉离士兵最近的 2/3 僵尸（按数量，远的一批留着）；一局只能使用一次',
  blackHole: '半径 12 内僵尸被持续吸向中心 1.2 秒；结束时中心半径 3 内扣 12% 最大生命（Boss 减半）',
  wormhole: '全场僵尸一起送回出生点',
  carrierDrones: '召唤 4 架大型舰载无人机，持续一波（12 秒），每 0.45 秒造成 20 点小范围伤害',
  timeDilation: '全场僵尸所有移动 ×0.4，持续 3 秒',
  finalJudgment: '全场处决：生命 ≤50% 的僵尸直接消失并计分；其余受 20% 最大生命伤害；Boss 改吃 30% 最大生命',
  cosmicCollapse: '半径 14 内僵尸吸向中心（走完 85% 距离）；按吸引前的距离结算：中心 6 内扣 35% 最大生命，6~14 扣 15%，Boss 减半',
  sacrifice: '消耗 20 兵（需多于 20），全场僵尸生命上限与当前生命一起砍半，Boss 砍到 75%；不致死、不直接计分',
  reboot: '全场僵尸不计分消失；士兵回补到本局峰值的 80%；随后 3 秒不刷怪',
  entropy: '持续 8 秒：全场移动 ×0.5 起、每秒再慢 12%（最低 ×0.18）；期间每秒掉 3% 最大生命（共 24%），不致死',
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

// 空袭用：找最密的几个点，彼此分开，避免 3 颗炸弹全落在同一团
function topDensestPoints(count = 3, minDist = 2.8) {
  if (!state.zombies.length) return [];

  const candidates = state.zombies.map((z) => {
    let density = 0;
    for (const o of state.zombies) {
      const dx = o.x - z.x;
      const dz = o.z - z.z;
      if (dx * dx + dz * dz <= 9) density += 1;
    }
    return { x: z.x, z: z.z, density };
  });

  candidates.sort((a, b) => b.density - a.density);

  const picked = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.hypot(p.x - c.x, p.z - c.z) >= minDist)) {
      picked.push(c);
    }
  }

  // 场上只有一团时，后两颗落在它周围，避免三颗叠成一颗
  if (picked.length) {
    const base = picked[0];
    while (picked.length < count) {
      const a = Math.random() * Math.PI * 2;
      const r = minDist + Math.random() * 1.4;
      picked.push({
        x: Math.max(-7.4, Math.min(7.4, base.x + Math.cos(a) * r)),
        z: Math.max(-20, Math.min(5.5, base.z + Math.sin(a) * r)),
        density: 0,
      });
    }
  }

  return picked.slice(0, count);
}

function damageZombiesInRect(x, z, halfW, halfD, damage) {
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const zb = state.zombies[i];
    if (Math.abs(zb.x - x) > halfW) continue;
    if (Math.abs(zb.z - z) > halfD) continue;
    damageZombieAt(i, damage);
  }
}

function damageZombieAt(index, damage) {
  const zb = state.zombies[index];
  zb.hp -= damage;
  if (zb.hp > 0) return false;

  state.zombies.splice(index, 1);
  state.score += zombieTypeById(zb.type)?.score || 1;
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

// 轨道轰炸：从士兵这一侧数起，只清掉最近的 fraction 比例僵尸，更远的一批留在场上。
// 士兵在 z 大的那一头，所以按 z 从大到小排，取前 fraction 名。
// 返回被打掉那一段的纵向范围，画面层拿它铺光柱。
function bombardNearestFraction(fraction) {
  const total = state.zombies.length;
  if (!total) return null;

  const sorted = state.zombies.slice().sort((a, b) => b.z - a.z);
  const killCount = Math.max(1, Math.min(total, Math.round(total * fraction)));
  const doomed = new Set(sorted.slice(0, killCount));

  let nearZ = -Infinity; // 最靠近士兵的一只（z 最大）
  let farZ = Infinity;   // 这段里最靠出生点的一只（z 最小）

  // 从后往前删，避免下标错位
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const zb = state.zombies[i];
    if (!doomed.has(zb)) continue;
    nearZ = Math.max(nearZ, zb.z);
    farZ = Math.min(farZ, zb.z);
    damageZombieAt(i, Infinity);
  }

  return { killed: killCount, nearZ, farZ };
}

// 终焉审判：全场按血量处决，不看位置也不看半径。
// 生命低于阈值线的直接消失（照常计分），没到线的吃一段最大生命伤害；
// Boss 不吃处决，改吃固定比例最大生命 —— 否则一张牌就能秒掉 9 倍血的 Boss。
function castJudgment(def) {
  const line = def.executeLine ?? 0.5;
  const chip = def.chipDamage ?? 0.2;
  const bossChip = def.bossDamage ?? 0.3;

  const executed = [];
  const chipped = [];

  // 从后往前删，避免 damageZombieAt 里的 splice 打乱下标
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const zb = state.zombies[i];
    const maxHp = Math.max(1, zb.maxHp || zb.hp);
    const at = { x: zb.x, z: zb.z, type: zb.type };

    let damage;
    if (zb.boss) damage = maxHp * bossChip;
    else if (zb.hp <= maxHp * line) damage = Infinity;
    else damage = maxHp * chip;

    (damageZombieAt(i, damage) ? executed : chipped).push(at);
  }

  return { executed, chipped, line };
}

// 宇宙坍缩收尾：按"离中心多远"分档扣最大生命，Boss 按 bossCutMul 打折。
// 和黑洞分开：黑洞是持续吸附 + 小幅百分比，坍缩是瞬拉 + 按距离分档的百分比压制。
function collapseDamage(def, distBefore) {
  const inner = def.radius ?? 6;
  const outer = def.pullRadius ?? 14;
  const bossMul = def.bossCutMul ?? 0.5;

  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const zb = state.zombies[i];
    const dist = distBefore.get(zb);
    if (dist == null) continue;
    const cut = dist <= inner ? def.innerCut : dist <= outer ? def.outerCut : 0;
    if (!cut) continue;

    const maxHp = Math.max(1, zb.maxHp || zb.hp);
    damageZombieAt(i, maxHp * cut * (zb.boss ? bossMul : 1));
  }
}

// 当前减速倍率：普通减速直接取 slowMul，熵增在它基础上每秒再乘一次 ramp
function currentSlowMul() {
  if (state.time >= state.slowUntil) return 1;
  if (state.time >= state.entropyUntil || !state.entropyPct) return state.slowMul;

  const elapsed = Math.max(0, state.time - state.entropyStart);
  const ramped = state.slowMul * Math.pow(state.entropyRamp, elapsed);
  return Math.max(state.entropyMinMul, ramped);
}

// 熵增的持续伤害：按最大生命百分比扣，至少留 1 血 —— 这张牌不负责杀人
function applyEntropyDot(amount) {
  if (amount <= 0) return;
  for (const zb of state.zombies) {
    const maxHp = Math.max(1, zb.maxHp || zb.hp);
    const next = zb.hp - maxHp * amount;
    zb.hp = next < 1 ? 1 : next;
  }
}

// 普通僵尸在当前波次的血量。滚木用它算伤害：1.25 倍能秒普通，大块头是 2.5 倍血，秒不掉。
function currentNormalHp() {
  return CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave;
}

// 滚木：从屏幕左边随机纵向位置出现，整根保持在屏幕内，从左往右滚
function spawnRollingLog() {
  const cfg = CONFIG.rollingLog;
  const half = cfg.length / 2;
  const zMin = CONFIG.world.screenTopZ + half + cfg.zMargin;
  const zMax = CONFIG.world.playerZ - half - cfg.zMargin;
  const z = zMin + Math.random() * Math.max(0, zMax - zMin);

  state.rollingLogs.push({
    id: state.nextId++,
    x: -CONFIG.world.halfWidth + cfg.radius + 0.05,
    z,
    length: cfg.length,
    radius: cfg.radius,
    speed: cfg.speed,
    damage: Math.max(1, Math.round(currentNormalHp() * cfg.damageMul)),
    spin: 0,
    hit: new Set(),
  });
}

// 骑士冲锋：从屏幕下方右半边随机位置冲 3 个骑士，横向留出最小间距
function spawnKnightCharge() {
  const cfg = CONFIG.knightCharge;
  const [minX, maxX] = CONFIG.world.rightZone;
  const span = maxX - minX;
  const slot = span / (cfg.count + 1);
  const jitter = Math.max(0, (slot - cfg.minGap) / 2);

  for (let i = 0; i < cfg.count; i++) {
    const base = minX + slot * (i + 1);
    const x = Math.min(
      maxX - cfg.hitRadius,
      Math.max(minX + cfg.hitRadius, base + (Math.random() * 2 - 1) * jitter)
    );

    state.knightCharges.push({
      id: state.nextId++,
      x,
      z: cfg.spawnZ,
      speed: cfg.speed,
      damage: cfg.damage,
      hit: new Set(),
    });
  }
}

function castSkill(id) {
  const def = SKILL_DEFS.find((s) => s.id === id);
  if (!def) return false;

  const target = densestPoint() || { x: 0, z: -6 };
  let castExtra = null;
  const announce = () => emit('skillCast', {
    id: def.id,
    name: def.name,
    type: def.type,
    x: target.x,
    z: target.z,
    radius: def.radius || 0,
    color: def.color,
    ...(castExtra || {}),
  });

  switch (def.type) {
    case 'aoe':
      damageZombiesInRadius(target.x, target.z, def.radius, def.damage);
      break;
    case 'line':
      damageZombiesInLine(target.z, def.radius, def.damage);
      break;
    case 'airStrike': {
      const cfg = CONFIG.airStrike;
      const points = topDensestPoints(cfg.bombs);
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const delay = 0.25 + i * cfg.delayStep;
        state.siegeShots.push({
          x: p.x,
          z: p.z,
          radius: cfg.radius,
          damage: cfg.damage,
          timeLeft: delay,
          kind: 'airStrike',
          color: def.color,
        });
        emit('airStrikeBomb', { x: p.x, z: p.z, delay, color: def.color });
      }
      break;
    }
    case 'barrage': {
      const cfg = CONFIG.barrage;
      for (let i = 0; i < cfg.waves; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * cfg.areaRadius;
        const x = Math.max(-7.4, Math.min(7.4, target.x + Math.cos(a) * r));
        const z = Math.max(
          CONFIG.world.screenTopZ + 1,
          Math.min(CONFIG.world.killZ - 1, target.z + Math.sin(a) * r)
        );
        const delay = cfg.firstDelay + i * cfg.waveInterval;
        state.siegeShots.push({
          x,
          z,
          radius: cfg.radius,
          damage: cfg.damage,
          timeLeft: delay,
          kind: 'barrage',
          color: def.color,
        });
        emit('barrageWave', { x, z, delay, color: def.color });
      }
      castExtra = { areaRadius: cfg.areaRadius, waves: cfg.waves };
      break;
    }
    case 'napalmWall': {
      const cfg = CONFIG.napalmWall;
      const halfW = cfg.width / 2;
      const x = Math.max(-8 + halfW, Math.min(8 - halfW, target.x));
      const z = Math.max(
        CONFIG.world.screenTopZ + cfg.depth / 2,
        Math.min(CONFIG.world.killZ - cfg.depth / 2, target.z)
      );
      state.napalmWalls.push({
        id: state.nextId++,
        x,
        z,
        width: cfg.width,
        depth: cfg.depth,
        remaining: cfg.duration,
        dps: cfg.dps,
      });
      damageZombiesInRect(x, z, halfW, cfg.depth / 2, cfg.impactDamage);
      target.x = x;
      target.z = z;
      castExtra = { width: cfg.width, depth: cfg.depth, duration: cfg.duration };
      break;
    }
    case 'tank':
      spawnTankSupport();
      break;
    case 'apc':
      spawnApcCharge();
      break;
    case 'carrierDrones':
      spawnCarrierDrones();
      break;
    case 'droneSwarm': {
      const cfg = CONFIG.droneSwarm;
      state.swarm.until = state.time + cfg.duration;
      state.swarm.left = cfg.count;
      state.swarm.timer = 0; // 立刻起飞第一架
      break;
    }
    case 'orbital': {
      const band = bombardNearestFraction(CONFIG.orbital.killFraction);
      // 清完之后留一口真空，不然下一只几乎立刻补上，看起来像没打
      state.zombieSpawnPauseUntil = state.time + 1.5;
      state.zombieTimer = Math.max(state.zombieTimer, 1.5);

      // 光柱只铺在被打掉的那一段：从士兵一侧往上 2/3，永远不穿过士兵阵型。
      // 万一被打掉的都在屏幕外，也至少在屏幕顶边留一道，玩家能看见打了
      const zMax = CONFIG.orbital.beamZMax;
      const zMin = CONFIG.world.screenTopZ;
      if (band) {
        const nearZ = Math.max(zMin, Math.min(band.nearZ, zMax));
        const farZ = Math.max(zMin, Math.min(band.farZ, zMax));
        target.z = (nearZ + farZ) / 2;
        castExtra = {
          bandMin: Math.min(nearZ, farZ),
          bandMax: Math.max(nearZ, farZ),
          killed: band.killed,
        };
      } else {
        target.z = Math.min(target.z, zMax);
      }
      break;
    }
    case 'rollingLog':
      spawnRollingLog();
      break;
    case 'knightCharge':
      spawnKnightCharge();
      break;
    case 'weaponDrop': {
      // 不再"放了就生效"：箱子落在玩家正前方，必须用子弹打中才开
      const cfg = CONFIG.weaponDrop;
      target.x = state.player.x;
      target.z = state.player.z - cfg.offsetZ;

      state.pickups.push({
        id: state.nextId++,
        x: target.x,
        z: target.z,
        y: 11,
        landed: false,
        kind: 'boost',
        life: 999, // 技能箱不自动消失，等玩家打
        boost: {
          name: '空投重武器',
          damageMul: cfg.damageMul,
          rateMul: cfg.rateMul,
          duration: cfg.duration,
        },
      });
      emit('skillNotice', { text: '空投重武器已投下 · 打中箱子才生效', kind: 'skill' });
      break;
    }
    case 'virusBomb':
      spawnVirusBombs(target);
      break;
    case 'friendlyLegion':
      spawnFriendlyLegion();
      break;
    case 'campfire': {
      const cfg = CONFIG.campfire;
      state.campfireZones.push({
        id: state.nextId++,
        x: target.x,
        z: target.z,
        radius: cfg.radius,
        remaining: cfg.duration,
        dps: cfg.dps,
        falloff: cfg.falloff,
      });
      // 篝火本体和地面范围圈都由画面层负责
      spawnCampfireFx(target.x, target.z, cfg.duration, cfg.radius);
      break;
    }
    case 'slow':
      state.slowUntil = state.time + def.duration;
      state.slowMul = def.mul;
      if (def.dpsPct) {
        // 熵增：减速从 mul 起每秒再乘 ramp，掉血按最大生命百分比，
        // 所以它不会随波次贬值（旧的每秒 8 点固定伤害到后期等于没有）
        state.entropyUntil = state.time + def.duration;
        state.entropyStart = state.time;
        state.entropyPct = def.dpsPct;
        state.entropyRamp = def.ramp ?? 0.88;
        state.entropyMinMul = def.minMul ?? 0.18;
      }
      // 保险：以后有减速带即时伤害的技能，范围按全屏算
      if (def.damage) damageZombiesInRadius(0, -6, 60, def.damage);
      break;
    case 'freeze':
      state.freezeUntil = state.time + def.duration;
      break;
    case 'buff':
      state.buffUntil = state.time + def.duration;
      state.buffMul = def.mul;
      // 增益以玩家脚下为圆心播特效，而不是砸在僵尸堆里；
      // 同时给一条提示，否则玩家只能靠数子弹判断它有没有生效
      castExtra = {
        x: state.player.x,
        z: state.player.z,
        duration: def.duration,
        mul: def.mul,
      };
      emit('skillNotice', {
        text: `${def.name}：全队射速 ×${def.mul}，持续 ${def.duration} 秒`,
        kind: 'skill',
      });
      break;
    case 'heal':
      applySoldiers(def.soldiers);
      break;
    case 'plague': {
      // 记忆植入：从地图外打进一枚传染炮弹，落地后感染一片并继续扩散
      const cfg = CONFIG.plague;
      state.plagueShots.push({
        id: state.nextId++,
        x: target.x,
        z: target.z,
        timeLeft: cfg.flightTime,
        radius: cfg.radius,
        infectCount: cfg.infectCount,
      });
      castExtra = { radius: cfg.radius, delay: cfg.flightTime };
      break;
    }
    case 'upgradeSlot':
      if (
        state.barricade.unlocked &&
        state.barricade.level >= CONFIG.barricade.levels.length
      ) {
        return false;
      }
      upgradeBarricade();
      break;
    case 'pull': {
      // 黑洞：不立刻结算，先开一个持续吸附场，时间到了再扣血。
      // 宇宙坍缩还是走下面那套「一帧拉完 + 按吸引前距离分档」。
      if (def.id === 'blackHole') {
        state.blackHoles.push({
          id: state.nextId++,
          x: target.x,
          z: target.z,
          timeLeft: def.duration,
          duration: def.duration,
          radius: def.radius,
          pullRadius: def.pullRadius,
          pullFactor: def.pullFactor ?? 0.85,
          damagePct: def.damagePct ?? 0.12,
          bossPctMul: def.bossPctMul ?? 0.5,
        });
        castExtra = {
          duration: def.duration,
          radius: def.radius,
          pullRadius: def.pullRadius,
        };
        break;
      }

      // 只吸 pullRadius 内的僵尸，按 pullFactor 拉向落点
      const pullR2 = (def.pullRadius || 12) ** 2;
      const factor = def.pullFactor ?? 0.85;
      // 分档伤害要记"被吸之前"的距离：85% 拉完大家都贴在中心，
      // 按拉完的位置算就只剩一档，两档设计会失效
      const distBefore = def.innerCut ? new Map() : null;

      for (const zb of state.zombies) {
        const dx = target.x - zb.x;
        const dz = target.z - zb.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > pullR2) continue;

        const d = Math.sqrt(d2) || 1;
        if (distBefore) distBefore.set(zb, d);

        const step = d * factor;
        zb.x += (dx / d) * step;
        zb.z += (dz / d) * step;
        zb.aggro = false;
      }

      if (def.innerCut) {
        // 宇宙坍缩：按吸引前的距离扣最大生命百分比，越挨着奇点越惨。
        // 80 点固定伤害到后期连杂兵血皮都掉不了，改成比例后它负责把整片压到斩杀线
        collapseDamage(def, distBefore);
      } else {
        damageZombiesInRadius(target.x, target.z, def.radius, def.damage);
      }
      break;
    }
    case 'warp': {
      // 全场僵尸一起送回出生点
      for (const zb of state.zombies) {
        zb.z = CONFIG.world.spawnZ - Math.random() * 2;
        zb.aggro = false;
        if (zb.ranged) zb.shotTimer = Math.max(zb.shotTimer || 0, 0.5);
      }
      break;
    }
    case 'sacrifice': {
      // 血祭：花 20 兵把全场砍半血。不致死，所以它买的是"接下来的收割条件"，
      // 不是清场——和终焉审判、重启刻意分成三种动词
      if (!state.zombies.length) return false;
      if (state.soldiers <= def.soldiers) return false;
      applySoldiers(-def.soldiers, { force: true });

      const shaved = [];
      for (const zb of state.zombies) {
        const mul = zb.boss ? def.bossShave : def.shave;
        const maxHp = Math.max(1, zb.maxHp || zb.hp);
        const newMax = Math.max(1, maxHp * mul);
        zb.maxHp = newMax;
        // 当前血量按同一比例缩，但至少留 1 点：这张牌不负责杀人
        zb.hp = Math.max(1, Math.min(newMax, zb.hp * mul));
        shaved.push({ x: zb.x, z: zb.z });
      }
      castExtra = { shaved, soldiers: state.soldiers };
      emit('skillNotice', {
        text: `献祭 ${def.soldiers} 兵 · 场上 ${shaved.length} 只僵尸生命减半`,
        kind: 'skill',
      });
      break;
    }
    case 'execute': {
      if (!state.zombies.length) return false;
      const result = castJudgment(def);
      castExtra = result;
      emit('skillNotice', {
        text: `处决 ${result.executed.length} 只 · ${result.chipped.length} 只受 20% 最大生命伤害`,
        kind: 'skill',
      });
      break;
    }
    case 'reboot': {
      const removed = [];
      // 直接移出数组：不计分、不走死亡结算，自爆僵尸也不会连锁
      for (let i = state.zombies.length - 1; i >= 0; i--) {
        const zb = state.zombies[i];
        removed.push({ x: zb.x, z: zb.z, type: zb.type });
        state.zombies.splice(i, 1);
      }

      const target = Math.floor(state.peakSoldiers * (def.restoreRatio ?? 0.8));
      const before = state.soldiers;
      if (target > state.soldiers) applySoldiers(target - state.soldiers);

      const pause = def.pause ?? 3;
      state.zombieSpawnPauseUntil = state.time + pause;
      state.zombieTimer = Math.max(state.zombieTimer, pause);

      castExtra = {
        removed,
        soldiersBefore: before,
        soldiersAfter: state.soldiers,
        pause,
      };
      emit('skillNotice', {
        text: `重启：清场 ${removed.length} 只（不计分）· 兵 ${before} → ${state.soldiers}`,
        kind: 'skill',
      });
      break;
    }
    case 'clear':
      clearZombies();
      break;
    default:
      break;
  }

  announce();
  return true;
}

// 一次性技能也有出现条件
function skillCanAppear(def) {
  if (def.id === 'orbital') {
    // 一局只能拿一次、用一次
    return !state.usedSkills.includes('orbital') &&
      !state.skillBag.some((s) => s.id === 'orbital');
  }
  return true;
}

function skillDef(id) {
  return SKILL_DEFS.find((s) => s.id === id) || null;
}

function skillCharges(def) {
  return SKILL_CHARGES[def.id] || 2;
}

// 换算成兵时，越强的技能每次值越多：1 次=12 兵，2 次=8 兵，3 次=5 兵
function skillStrengthValue(def) {
  const charges = skillCharges(def);
  if (charges <= 1) return 12;
  if (charges === 2) return 8;
  return 5;
}

// 给 UI 读的技能栏数据
function getSkillBag() {
  return state.skillBag.map((entry, i) => {
    const def = skillDef(entry.id);
    return {
      id: entry.id,
      name: def ? def.name : entry.id,
      charges: entry.charges,
      color: def ? def.color : 0xffffff,
      key: i + 1,
    };
  });
}

// 抽到一次性技能卡：存进技能栏，不立刻释放
function gainSkill(id) {
  const def = skillDef(id);
  if (!def) return;

  // 轨道轰炸一局只能拿一次，重复抽到直接折算
  if (def.id === 'orbital' && state.usedSkills.includes('orbital')) {
    const soldiers = skillCharges(def) * skillStrengthValue(def);
    applySoldiers(soldiers);
    emit('skillNotice', {
      text: `轨道轰炸本局已经用过，这张卡折算 +${soldiers} 兵`,
      kind: 'skill',
    });
    state.skillBagVersion += 1;
    return;
  }

  const add = skillCharges(def);
  const maxCharges = def.id === 'orbital' ? 1 : SKILL_MAX_CHARGES;
  const existing = state.skillBag.find((s) => s.id === id);

  if (existing) {
    const room = maxCharges - existing.charges;
    const got = Math.max(0, Math.min(room, add));
    existing.charges += got;

    if (got < add) {
      const extra = add - got;
      const soldiers = extra * skillStrengthValue(def);
      applySoldiers(soldiers);
      emit('skillNotice', {
        text: `${def.name} 已达 ${maxCharges} 次上限，溢出 ${extra} 次折算 +${soldiers} 兵`,
        kind: 'skill',
      });
    }
  } else if (state.skillBag.length < SKILL_BAG_MAX) {
    state.skillBag.push({ id, charges: add });
  } else {
    // 技能栏满了：按获得顺序替换最早的那个（FIFO），
    // 剩余次数折算成兵。以前替换次数最少的，会让 1 次强技能被 3 次弱技能挤掉。
    const idx = 0;
    const old = state.skillBag[idx];
    const oldDef = skillDef(old.id);
    const soldiers = old.charges * (oldDef ? skillStrengthValue(oldDef) : 5);

    applySoldiers(soldiers);
    state.skillBag.splice(idx, 1);
    state.skillBag.push({ id, charges: add });

    emit('skillNotice', {
      text: `技能栏已满：${oldDef ? oldDef.name : old.id}×${old.charges} 折算 +${soldiers} 兵，换入 ${def.name}×${add}`,
      kind: 'skill',
    });
  }

  state.skillBagVersion += 1;
}

// 每 2 波自动获得一个当前时代技能。完全随机，不按强度加权。
function grantRandomSkill() {
  const pool = SKILL_DEFS.filter(
    (s) => s.era === state.era && skillCanAppear(s)
  );
  if (!pool.length) return;

  const def = pool[Math.floor(Math.random() * pool.length)];
  gainSkill(def.id);
  state.lastGainedSkillId = def.id;
  state.lastGainedSkillVersion = state.skillBagVersion;
  emit('skillNotice', {
    text: `自动获得技能：${def.name}`,
    kind: 'skill',
  });
}

// 使用一次技能。技能失败（兵不够、路障满级）时不扣次数。
function useSkill(id) {
  if (state.status !== 'playing') return false;
  if (state.skillUseCd > 0) return false;

  const entry = state.skillBag.find((s) => s.id === id);
  if (!entry) return false;

  const def = skillDef(id);
  if (!castSkill(id)) {
    emit('skillNotice', {
      text: `现在无法使用${def ? def.name : id}`,
      kind: 'skill',
    });
    return false;
  }

  if (id === 'orbital') state.usedSkills.push('orbital');

  entry.charges -= 1;
  if (entry.charges <= 0) {
    const idx = state.skillBag.indexOf(entry);
    if (idx >= 0) state.skillBag.splice(idx, 1);
  }

  state.skillUseCd = SKILL_USE_CD;
  state.skillBagVersion += 1;
  return true;
}

// 换时代：旧时代技能按剩余次数和强度折算成兵，然后清掉
function convertExpiredSkills() {
  const expired = [];

  for (let i = state.skillBag.length - 1; i >= 0; i--) {
    const entry = state.skillBag[i];
    const def = skillDef(entry.id);
    if (def && def.era < state.era) {
      expired.push({ def, charges: entry.charges });
      state.skillBag.splice(i, 1);
    }
  }

  if (!expired.length) return;

  let total = 0;
  const parts = [];
  for (const item of expired) {
    total += item.charges * skillStrengthValue(item.def);
    parts.push(`${item.def.name}×${item.charges}`);
  }

  applySoldiers(total);
  state.skillBagVersion += 1;
  emit('skillNotice', {
    text: `旧时代技能折算：${parts.join('、')} → +${total} 兵`,
    kind: 'skill',
  });
}

// 地图结束后的升级面板：只列槽位和基础卡，技能已经改成每 2 波自动获得
function buildUpgradePool() {
  return CARD_POOL
    .map((c) => ({
      ...c,
      desc: typeof c.desc === 'function' ? c.desc() : c.desc,
    }))
    .filter((c) => c.can());
}

function openUpgradePanel() {
  if (state.status !== 'playing' || state.testMode) return;
  if (state.upgradePanel.active) return;

  const picks = 3 + state.upgradeCarry;
  state.upgradeCarry = 0;

  if (!buildUpgradePool().length) {
    // 没什么可升的了，次数直接折算成兵
    if (picks > 0) applySoldiers(picks * 10);
    return;
  }

  state.upgradePanel.active = true;
  state.upgradePanel.picks = picks;
  state.upgradePanel.timeLeft = 30;
  state.upgradePanel.pickCounts = {};
  state.upgradePanel.version += 1;
  emit('upgradePanelOpen', { picks });
}

function closeUpgradePanel(carryRemaining = false) {
  if (!state.upgradePanel.active) return;

  if (carryRemaining && state.upgradePanel.picks > 0) {
    const left = state.upgradePanel.picks;
    state.upgradeCarry += left;
    emit('skillNotice', {
      text: `还有 ${left} 次升级没用，累计到下一次`,
      kind: 'skill',
    });
  }

  state.upgradePanel.active = false;
  state.upgradePanel.picks = 0;
  state.upgradePanel.timeLeft = 0;
  state.upgradePanel.version += 1;
  state.timeScale = 1;
}

function chooseUpgrade(id) {
  if (!state.upgradePanel.active || state.upgradePanel.picks <= 0) return false;

  const card = buildUpgradePool().find((c) => c.id === id);
  if (!card) return false;

  card.apply();
  const counts = state.upgradePanel.pickCounts;
  counts[id] = (counts[id] || 0) + 1;
  state.upgradePanel.picks -= 1;
  state.upgradePanel.version += 1;

  if (state.upgradePanel.picks <= 0) {
    closeUpgradePanel(false);
  } else if (!buildUpgradePool().length) {
    // 能升的都升完了，剩下的次数累计到下一次
    closeUpgradePanel(true);
  }
  return true;
}

function updateUpgradePanel(realDt) {
  if (!state.upgradePanel.active) return;
  if (state.status !== 'playing') {
    closeUpgradePanel(false);
    return;
  }
  if (state.paused) return;

  state.upgradePanel.timeLeft -= realDt;
  if (state.upgradePanel.timeLeft <= 0) {
    closeUpgradePanel(true);
  }
}

/* ----------------------------------------------------------
 * 每帧更新
 * ---------------------------------------------------------- */
// 每张地图打 3 波，每个时代打 3 张地图；三张打完才进下一个时代。
// 每换一张地图补一只 Boss，也就是每 3 波一个。
function syncEraWithWave(wave) {
  // 测试模式的时代由左侧面板控制，波次不再自动换
  if (state.testMode) return;

  const eraIndex = eraForWaveNumber(wave);
  const nextMapIndex = mapIndexForWave(wave);

  if (eraIndex !== state.era) {
    // 新时代：抽 3 张新地图，从第一张开始
    state.era = eraIndex;
    state.eraMaps = pickEraMapSet(eraIndex);
    state.mapIndex = 0;

    const map = state.eraMaps[0] || state.mapId || START_MAP;
    state.mapId = map;
    state.usedMaps.push(map);
    prepareMapEvent();

    // 旧时代没打完的技能次数折算成兵
    convertExpiredSkills();
    ensureSummonSlot();

    // 只换时代配色和地图，场上僵尸、子弹、屏障全部保留
    switchEra(eraIndex, map);
    refreshSlotsForEra();

    // 新地图开场：一只 Boss 压下来当分段节点
    spawnEraBoss(eraIndex);
    openUpgradePanel();
    return;
  }

  if (nextMapIndex === state.mapIndex) return;

  // 同一时代内换到下一张地图。终幕没有下一个时代，
  // 三张打完就重新抽一组，地图轮换继续。
  if (eraIndex === CONFIG.era.count - 1 && nextMapIndex === 0) {
    const nextSet = pickEraMapSet(eraIndex);
    // 重新抽的一组如果第一张刚好还是当前地图，换一下顺序，保证每轮都有视觉变化
    if (nextSet[0] === state.mapId && nextSet.length > 1) {
      [nextSet[0], nextSet[1]] = [nextSet[1], nextSet[0]];
    }
    state.eraMaps = nextSet;
  }

  state.mapIndex = nextMapIndex;
  const map = state.eraMaps[nextMapIndex] || state.eraMaps[0] || state.mapId;

  if (!map) return;

  if (map !== state.mapId) {
    state.mapId = map;
    state.usedMaps.push(map);
    // 只换地图：不重播时代配色、不折算技能
    switchMapLook(map, { fade: true });
    emit('skillNotice', {
      text: `战场转移 · ${CONFIG.era.names[eraIndex] || ''}`,
      kind: 'era',
    });
  }

  // 每张地图重新抽一次环境事件；同一张图重复出现也要重新抽
  prepareMapEvent();

  // 每换一张地图一个 Boss；场上已经有一只时 spawnEraBoss 会自己跳过
  spawnEraBoss(eraIndex);
  openUpgradePanel();
}

function update(dt) {
  state.time += dt;
  if (state.soldiers > state.peakSoldiers) state.peakSoldiers = state.soldiers;
  // 幂等兜底：以前只在换时代那一刻检查一次，测试面板把召唤降到 0 之后
  // 同一时代内再也不会自动解锁，召唤槽就永久空着了
  ensureSummonSlot();
  state.skillUseCd = Math.max(0, state.skillUseCd - dt);

  const nextWave = Math.floor(state.time / CONFIG.wave.duration) + 1;
  if (nextWave !== state.wave) {
    const completed = nextWave - 1; // 刚结束的那一波
    state.wave = nextWave;
    syncEraWithWave(nextWave);
    emit('waveStart', { wave: nextWave });

    // 召唤者：第 9 波起每波检查一次，场上没有就补一只（场上最多一只）
    if (nextWave >= SUMMONER_START_WAVE && !state.testMode) spawnSummoner();

    // 锁链：第 6 波起每波重摆一条（位置随波次变，玩家每波都要重新找路）
    if (nextWave >= CONFIG.chain.startWave && !state.testMode) spawnChain(nextWave);

    // 坑洞：进入起始波或之后，每波开头立刻塌一个，别让玩家白等一整个间隔
    if (nextWave >= CONFIG.pit.startWave && !state.testMode) {
      state.pitTimer = 0;
    }

    // 每 2 波自动获得 1 个当前时代的技能，完全随机；测试模式不抽
    if (
      !state.testMode &&
      completed > 0 &&
      completed % CONFIG.card.everyWaves === 0
    ) {
      grantRandomSkill();
    }
  }

  // 洪水：水位按波次上涨，漫过脚踝后整场僵尸变慢。
  // 只在数值真的变了才调画面层，免得每帧都写一遍水面
  const floodLevel = Math.min(
    CONFIG.flood.maxLevel,
    Math.max(0, (state.wave - CONFIG.flood.startWave) * CONFIG.flood.perWave)
  );
  if (Math.abs(floodLevel - state.floodLevel) > 0.001) {
    state.floodLevel = floodLevel;
    setWaterLevel(floodLevel);
    if (floodLevel >= CONFIG.flood.slowFrom) emit('floodRise', { level: floodLevel });
  }

  updateEnvEvent(dt);
  updateFormation();
  updatePlayer(dt);
  updateFiring(dt);
  updateBarrelSpawn(dt);
  updateCrates(dt);
  updatePickups(dt);
  updateEnemyShots(dt);
  updateBullets(dt);
  updateSlots(dt);
  updateBarriers(dt);
  updateVirusBombs(dt);
  updateNapalmWalls(dt);
  updateFriendlyZombies(dt);
  updateBlackHoles(dt);
  updatePlagueShots(dt);
  updatePlague(dt);
  updatePits(dt);
  updateZombies(dt);
  updateSummoners(dt);
  updateSiegeShots(dt);
  updateTankSupports(dt);
  updateApcCharges(dt);
  updateCarrierDrones(dt);
  updateSwarmDrones(dt);
  updateRollingLogs(dt);
  updateKnightCharges(dt);
  updateCampfireZones(dt);
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
    const envMove =
      state.envDebuff.until > state.time ? state.envDebuff.moveMul : 1;
    const nextX = clamp(
      state.player.x + dir * CONFIG.player.speed * state.upgrades.moveSpeed * envMove * dt,
      -CONFIG.world.halfWidth,
      CONFIG.world.halfWidth
    );

    // 坑洞挡人：目标点落在坑里就不让走（停在坑沿）。
    // 但如果玩家已经在坑里（理论上不会，生成时避开脚下），
    // 允许往外走，否则会被永久锁死。
    const pz = state.player.z;
    const pad = CONFIG.pit.playerPad;
    let blocked = false;
    let alreadyIn = false;
    for (const pit of state.pits) {
      if (pitBlocksPoint(pit, nextX, pz, pad)) blocked = true;
      if (pitBlocksPoint(pit, state.player.x, pz, pad)) alreadyIn = true;
    }

    if (!blocked || alreadyIn) state.player.x = nextX;
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
  // 指挥槽不再提供射速，改成集火标记；射速只由基础卡和技能提供
  const buffMul = state.time < state.buffUntil ? state.buffMul : 1;
  const boostActive = state.time < state.weaponBoostUntil;
  const boostRate = boostActive ? state.weaponBoostRate : 1;
  const boostDamage = boostActive ? state.weaponBoostDamage : 1;
  // 时代武器档位（点子池「时代规则」）：弩慢而重，冲锋枪快而轻。
  // 乘在升级倍率之后，所以玩家升级的收益在任何时代都成立，只是基数不同。
  const weapon = eraWeaponProfile(state.era);

  // 捡到的临时武器盖在时代武器之上（点子池「掉落拾取」）。
  // 只改射速/伤害/弹数/散布，不改 baseCount——那是「几个枪位」的结构，
  // 动了会让整排气派的观感变样。
  const picked = state.playerWeapon;
  const pickIntervalMul = picked ? picked.intervalMul : 1;
  const pickDamageMul = picked ? picked.damageMul : 1;
  const pickBullets = picked ? picked.bullets : 1;

  const envRate =
    state.envDebuff.until > state.time ? state.envDebuff.fireRateMul : 1;
  const effInterval =
    (baseInterval * weapon.fireIntervalMul * pickIntervalMul) /
    (state.upgrades.fireRate * buffMul * boostRate * envRate);
  const totalRate = baseCount / effInterval; // 每秒多少发
  const interval = shooters / totalRate;

  // 每个枪位各自计时，新枪位随机错开，避免整排同时开火
  const timers = state.weapon.timers;
  while (timers.length < shooters) {
    timers.push(Math.random() * interval * 0.6);
  }

  const front = state.formation;
  const width = Math.max(0, (front.frontCount - 1) * CONFIG.formation.spacing);
  const envSpread =
    state.envDebuff.until > state.time ? state.envDebuff.spreadMul : 1;
  const jitter =
    CONFIG.weapon.jitterBase * CONFIG.player.bulletSpeed * envSpread;

  const origins = [];
  const offsets = shooterOffsets(shooters, width);

  // 一帧最多补几枪：低帧率（尤其手机）时 interval 比 dt 还小，
  // 原来"每帧最多一发"会把机枪这类高射速武器直接压成 1/fps 发，
  // 看起来就是"机枪伤害特别低"
  const MAX_SHOTS_PER_FRAME = 6;

  for (let i = 0; i < shooters; i++) {
    timers[i] -= dt;
    if (timers[i] > 0) continue;

    const x = state.player.x + offsets[i];
    let shots = 0;

    while (timers[i] <= 0 && shots < MAX_SHOTS_PER_FRAME) {
      timers[i] += interval;
      shots += 1;

      // 同一帧补出来的几发错开一点 z，别叠在同一个点上
      const zOffset = (shots - 1) * 0.06;

      // 霰弹枪一次喷三发：横向散开但总伤害受 damageMul 约束过，
      // 不会因为弹数多就白赚输出
      for (let k = 0; k < pickBullets; k++) {
        const vx = (Math.random() * 2 - 1) * jitter +
          (pickBullets > 1 ? (k - (pickBullets - 1) / 2) * picked.spread : 0);

        state.bullets.push({
          id: state.nextId++,
          x,
          z: state.player.z - 0.1 - zOffset,
          vx,
          vz: -CONFIG.player.bulletSpeed,
          damage:
            CONFIG.player.bulletDamage *
            tier.damage *
            state.upgrades.damage *
            weapon.damageMul *
            pickDamageMul *
            boostDamage,
          pierces: 0,
        });
      }

      origins.push({ x, z: state.player.z });
    }

    // 掉帧太久拖下了一堆没打完：不无限追帧，直接对齐到下一发
    if (timers[i] < 0) timers[i] = interval;
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
  // 测试模式不生成炸药桶，避免爆炸伤害干扰观察
  if (state.testMode) return;

  state.barrelTimer -= dt;
  if (state.barrelTimer > 0) return;

  state.barrelTimer = CONFIG.barrel.spawnInterval;

  const [minX, maxX] = CONFIG.world.rightZone;
  const x = minX + Math.random() * (maxX - minX);
  // 只补在路障上方，避免桶和墙重叠
  const z = -14 + Math.random() * 10;
  spawnBarrel(x, z);
}

/* ----------------------------------------------------------
 * 补给箱（点子池「补给箱」）：场上随机掉一个木箱，打碎给随机奖励
 *
 * 只放在玩家能打到的地方：x 在战场内、z 在玩家上方不远处。
 * 子弹是垂直往上飞的，所以箱子必须落在玩家走位能覆盖的横向范围里，
 * 否则玩家永远打不到（炸药桶当初就踩过这个坑）。
 * ---------------------------------------------------------- */
function pickCrateReward() {
  const list = CONFIG.crate.rewards;
  const total = list.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of list) {
    roll -= r.weight;
    if (roll <= 0) return r;
  }
  return list[0];
}

function spawnCrate() {
  if (state.crates.length >= CONFIG.crate.max) return null;

  // 横向铺满玩家能走到的范围（±半宽），纵向放在中场：
  // 太靠前会被僵尸挡住，太靠后会贴着玩家脚下，中场最容易在交火时被顺手打到
  const halfW = CONFIG.world.halfWidth;
  const x = (Math.random() * 2 - 1) * halfW * 0.85;
  const z = -8 + Math.random() * 12;

  const crate = {
    id: state.nextId++,
    x,
    z,
    y: 12,               // 从高处落下
    landed: false,
    reward: pickCrateReward(),
  };
  state.crates.push(crate);
  emit('crateSpawn', { x, z, id: crate.id });
  return crate;
}

function updateCrates(dt) {
  if (state.testMode) return;

  // 落地动画：从 y=12 掉到 0
  for (const c of state.crates) {
    if (c.landed) continue;
    c.y -= CONFIG.crate.fallSpeed * dt;
    if (c.y <= 0) {
      c.y = 0;
      c.landed = true;
      emit('crateLand', { x: c.x, z: c.z, id: c.id });
    }
  }

  state.crateTimer -= dt;
  if (state.crateTimer > 0) return;
  state.crateTimer = CONFIG.crate.interval;
  spawnCrate();
}

// 子弹打箱子：打中就碎，奖励当场结算
function hitCrate(bx, bz, prevZ = bz) {
  // 纵向按"这一帧飞过的那一段"判定：20fps 时一帧能飞 1.4 格，
  // 只测当前点会从箱子上跨过去
  const zMin = Math.min(bz, prevZ) - CONFIG.crate.hitZ;
  const zMax = Math.max(bz, prevZ) + CONFIG.crate.hitZ;

  for (let i = state.crates.length - 1; i >= 0; i--) {
    const c = state.crates[i];
    // 还在空中不能打，必须落地（和炸药桶一致）
    if (!c.landed) continue;
    if (Math.abs(bx - c.x) > CONFIG.crate.hitW) continue;
    if (c.z < zMin || c.z > zMax) continue;

    state.crates.splice(i, 1);
    const r = c.reward;
    if (r.kind === 'soldiers') {
      applySoldiers(r.amount);
    } else if (r.kind === 'score') {
      state.score += r.amount;
    }
    emit('crateHit', {
      x: c.x, z: c.z, id: c.id,
      kind: r.kind, amount: r.amount, label: r.label,
    });
    return true;
  }
  return false;
}

// 子弹打武器箱：和走过去捡等价，直接换上那把枪。
// 箱子落在玩家前面的弹道上，以前没有碰撞判定，子弹会从箱子里穿过去
function hitPickup(bx, bz, prevZ = bz) {
  const zMin = Math.min(bz, prevZ) - CONFIG.pickup.hitZ;
  const zMax = Math.max(bz, prevZ) + CONFIG.pickup.hitZ;

  for (let i = state.pickups.length - 1; i >= 0; i--) {
    const b = state.pickups[i];
    if (!b.landed) continue;
    if (Math.abs(bx - b.x) > CONFIG.pickup.hitW) continue;
    if (b.z < zMin || b.z > zMax) continue;

    state.pickups.splice(i, 1);

    // 空投补给掉下来的重武器箱：打中才开，buff 从这一刻开始计时
    if (b.kind === 'boost') {
      const boost = b.boost;
      state.weaponBoostUntil = state.time + boost.duration;
      state.weaponBoostDamage = boost.damageMul;
      state.weaponBoostRate = boost.rateMul;
      emit('pickupHit', { x: b.x, z: b.z, id: b.id, kind: 'boost', name: boost.name });
      emit('skillNotice', {
        text: `${boost.name} · 子弹 ×${boost.damageMul}、射速 ×${boost.rateMul}，持续 ${boost.duration} 秒`,
        kind: 'skill',
      });
      return true;
    }

    emit('pickupHit', {
      x: b.x, z: b.z, id: b.id,
      kind: b.weapon.kind, name: b.weapon.name,
    });
    equipWeapon(b.weapon);
    return true;
  }
  return false;
}

/* ----------------------------------------------------------
 * 远程僵尸的酸液（点子池「远程僵尸」）
 *
 * 从僵尸位置朝玩家当前位置飞一条直线，飞到就扣兵。玩家可以左右走位躲开，
 * 这就是"必须优先点掉它"的压力来源——躲一次躲不了十次。
 * ---------------------------------------------------------- */
function fireEnemyShot(z) {
  const targetX = state.player.x;
  const targetZ = state.player.z;
  const dx = targetX - z.x;
  const dz = targetZ - z.z;
  const len = Math.hypot(dx, dz) || 1;
  const speed = z.ranged.speed;

  state.enemyShots.push({
    id: state.nextId++,
    x: z.x,
    z: z.z,
    vx: (dx / len) * speed,
    vz: (dz / len) * speed,
    damage: z.ranged.damage,
    life: 0,
  });
  emit('enemyShot', { x: z.x, z: z.z });
}

function updateEnemyShots(dt) {
  for (let i = state.enemyShots.length - 1; i >= 0; i--) {
    const s = state.enemyShots[i];
    const prevX = s.x;
    const prevZ = s.z;
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    s.life += dt;

    // 扫掠碰撞：按这一帧走过的线段判，而不是只看终点。
    // 远程僵尸在 z=-13 左右吐，玩家在 z=9，每帧飞 0.35 格，
    // 只测终点偶尔会从士兵身边穿过去。
    const sx = s.x - prevX;
    const sz = s.z - prevZ;
    const seg2 = sx * sx + sz * sz;
    let t = 0;
    if (seg2 > 0) {
      t = Math.max(0, Math.min(1,
        ((state.player.x - prevX) * sx + (state.player.z - prevZ) * sz) / seg2
      ));
    }
    const nearX = prevX + sx * t;
    const nearZ = prevZ + sz * t;
    const dx = state.player.x - nearX;
    const dz = state.player.z - nearZ;

    if (dx * dx + dz * dz < 0.5 * 0.5) {
      state.enemyShots.splice(i, 1);
      emit('enemyShotHit', { x: nearX, z: nearZ });
      if (!state.testMode) damageArmy(s.damage, 'shot');
      continue;
    }

    // 飞太久或越过玩家身后的安全线就丢掉。
    // 旧值是 spawnZ + 30 = z 4，酸液还没飞到 z=9 的玩家就消失了。
    if (s.life > 4 || s.z > CONFIG.world.playerZ + 3) {
      state.enemyShots.splice(i, 1);
    }
  }
}

function updateBullets(dt) {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    const prevZ = b.z; // 低帧率下一帧能飞 1.4 格，箱子判定要用扫掠区间，别让它穿过去
    b.x += (b.vx || 0) * dt;
    b.z += b.vz * dt;

    if (b.z < CONFIG.world.spawnZ - 1 || Math.abs(b.x) > 14) {
      state.bullets.splice(i, 1);
      continue;
    }

    // 打中炸药桶：点燃引信，子弹消失，爆炸伤害由 barrelExploded 结算
    if (!state.testMode && hitBarrel(b.x, b.z, 0.45)) {
      state.bullets.splice(i, 1);
      continue;
    }

    // 打中补给箱：当场碎，奖励已经结算完
    if (!state.testMode && hitCrate(b.x, b.z, prevZ)) {
      state.bullets.splice(i, 1);
      continue;
    }

    // 打中武器箱：直接换枪
    if (!state.testMode && hitPickup(b.x, b.z, prevZ)) {
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
              state.weapon.pierceLevel = Math.max(1, state.weapon.pierceLevel || 0);
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

      // Boss 体型是普通僵尸的 6 倍（约 9.3 个单位高、8 个单位宽，横宽造型），
      // 判定跟着放大：否则贴着它身体边缘开枪，画面上明明打中了却是空的，
      // 读起来像"厚血打不动"
      const halfW = z.boss ? 1.9 : 0.72;
      const halfZ = z.boss ? 1.2 : 0.7;

      if (Math.abs(b.x - z.x) < halfW && Math.abs(b.z - z.z) < halfZ) {
        const markMul =
          z.id === state.commandMarkId ? 1 + state.commandMarkBonus : 1;
        z.hp -= b.damage * (z.armor ?? 1) * markMul;

        if (z.hp <= 0) {
          state.zombies.splice(j, 1);
          state.score += (zombieTypeById(z.type)?.score ?? 1);
          emit('zombieDie', { x: z.x, z: z.z, type: z.type });
        }

        // 穿透器：小概率不消耗子弹，继续打后面的僵尸
        // 狙击枪的穿透是「必穿」，不走概率；其余走穿透器那套
        const alwaysPierce = !!(state.playerWeapon && state.playerWeapon.pierce);
        const pierceLevel = state.weapon.pierce
          ? Math.max(1, state.weapon.pierceLevel || 1)
          : 0;
        const pierceMax =
          CONFIG.weapon.pierceMaxByLevel[pierceLevel - 1] ??
          CONFIG.weapon.pierceMax;
        const pierceChance =
          CONFIG.weapon.pierceChanceByLevel[pierceLevel - 1] ??
          CONFIG.weapon.pierceChance;
        const pierced =
          (alwaysPierce || state.weapon.pierce) &&
          (b.pierces || 0) < pierceMax &&
          (alwaysPierce || Math.random() < pierceChance);

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
        // 灰色陷阱打到 0 就消失，永远不会变成正数
        maxValue: grey ? 0 : randInt(CONFIG.barrier.capMin, valueCap),
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
// 指挥槽：每 3 秒标记场上血量最高的敌人，子弹打中标记目标时加伤
function updateCommandSlot(dt) {
  if (!state.slots.command) {
    state.commandMarkId = 0;
    state.commandMarkBonus = 0;
    return;
  }

  const stats = slotStats('command');
  state.commandMarkBonus = stats.markBonus;

  const current = state.zombies.find((z) => z.id === state.commandMarkId);
  if (!current) state.commandMarkTimer = 0;

  state.commandMarkTimer -= dt;
  if (state.commandMarkTimer > 0) return;

  state.commandMarkTimer = CONFIG.slots.command.markInterval;

  let best = null;
  for (const z of state.zombies) {
    if (z.z < CONFIG.world.screenTopZ) continue;
    const threat = z.hp + (z.boss ? 100000 : z.type === 3 ? 10000 : 0);
    if (!best || threat > best.threat) best = { z, threat };
  }

  state.commandMarkId = best ? best.z.id : 0;
  if (best) {
    emit('commandMark', {
      id: best.z.id,
      x: best.z.x,
      z: best.z.z,
      bonus: stats.markBonus,
    });
  }
}

function updateSlots(dt) {
  updateCommandSlot(dt);

  if (state.slots.siege) {
    const cfg = CONFIG.slots.siege;
    const stats = slotStats('siege');
    state.slotTimers.siege -= dt;
    if (state.slotTimers.siege <= 0) {
      state.slotTimers.siege = stats.interval;
      const target = densestPoint();
      if (target) {
        // 先让炮弹飞过去，落地时再结算伤害
        state.siegeShots.push({
          x: target.x,
          z: target.z,
          radius: stats.radius,
          damage: stats.damage,
          timeLeft: cfg.flightTime,
          kind: 'siege',
          color: 0xffa64d,
        });
        emit('slotStrike', {
          kind: 'siege',
          fromX: cfg.x,
          fromZ: cfg.z,
          x: target.x,
          z: target.z,
          radius: stats.radius,
          flightTime: cfg.flightTime,
          color: 0xffa64d,
        });
      }
    }
  }

  if (state.slots.closeDefense) {
    const cfg = CONFIG.slots.closeDefense;
    const stats = slotStats('closeDefense');
    state.slotTimers.closeDefense -= dt;
    if (state.slotTimers.closeDefense <= 0) {
      state.slotTimers.closeDefense = stats.interval;
      damageZombiesInRadius(cfg.x, cfg.z, stats.radius, stats.damage);

      // 找最近的僵尸，画一条曳光过去
      let tx = cfg.x;
      let tz = cfg.z;
      let best = Infinity;
      for (const zb of state.zombies) {
        const dx = zb.x - cfg.x;
        const dz = zb.z - cfg.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < stats.radius * stats.radius && d2 < best) {
          best = d2;
          tx = zb.x;
          tz = zb.z;
        }
      }

      emit('slotStrike', {
        kind: 'closeDefense',
        fromX: cfg.x,
        fromZ: cfg.z,
        x: tx,
        z: tz,
        radius: stats.radius,
        color: 0xff6a4a,
      });
    }
  }

  if (state.slots.support) {
    const cfg = CONFIG.slots.support;
    const stats = slotStats('support');
    state.slotTimers.support -= dt;
    if (state.slotTimers.support <= 0) {
      state.slotTimers.support = stats.interval;
      applySoldiers(stats.heal);
      emit('slotHeal', { x: cfg.x, z: cfg.z });
    }
  }

  if (state.slots.summon) {
    const stats = slotStats('summon');
    state.slotTimers.summon -= dt;
    if (state.slotTimers.summon <= 0) {
      state.slotTimers.summon = stats.interval;
      const preferred = state.summonNextPreferred;
      if (trySpawnSummonUnit(stats, preferred)) {
        state.summonNextPreferred = null;
      }
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

  // 熵增：按最大生命百分比掉血，按秒结算，游戏慢放时也跟着变慢；不致死
  if (state.time < state.entropyUntil && state.entropyPct > 0) {
    applyEntropyDot(state.entropyPct * dt);
  }

  // 电磁脉冲：冻结期间所有僵尸原地不动，也不啃路障
  const frozen = state.time < state.freezeUntil;

  // 刷怪间隔：波次越高越密；夜里再密一档（点子池「夜晚加密度」）
  // 夜晚倍率乘在波次压缩之后，再被 minSpawnInterval 兜底，不会密到瞬移
  const nightDensity = isNight(state.wave) ? CONFIG.zombie.nightSpawnMul : 1;
  const spawnInterval = Math.max(
    CONFIG.zombie.minSpawnInterval,
    (CONFIG.zombie.spawnInterval - (state.wave - 1) * CONFIG.zombie.intervalPerWave) *
      nightDensity
  );

  if (state.time < state.zombieSpawnPauseUntil) {
    // 轨道轰炸清屏后的短暂真空期
    state.zombieTimer = Math.max(state.zombieTimer, 0.2);
  } else if (state.zombieTimer <= 0) {
    if (state.zombies.length < CONFIG.zombie.maxAlive) {
      // 第一波只刷一只，之后才是 1 到 2 只
      const count = state.wave === 1 ? 1 : 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) spawnZombie();
    }
    state.zombieTimer = spawnInterval;
  }

  // 移动：进入下半场且离士兵够近时，开始横向追人
  const baseSlow = currentSlowMul();

  for (const z of state.zombies) {
    if (frozen) continue;

    // 被黑洞吸住：只跟着黑洞移动，不自己前进、不横移、不啃墙
    if (z.suckUntil && state.time < z.suckUntil) continue;

    // 环境事件（地震/电磁风暴）造成的短暂停顿
    if ((z.envStunUntil || 0) > state.time) continue;

    // 友方僵尸拦住敌人：停下互殴，不再往前走
    const blocker = state.friendlyZombies.find(
      (f) => Math.abs(f.x - z.x) < 0.9 && Math.abs(f.z - z.z) < 0.9
    );
    if (blocker) continue;

    // 燃烧弹火墙：站在墙里的僵尸额外减速
    const inNapalm = state.napalmWalls.some(
      (w) =>
        Math.abs(z.x - w.x) <= w.width / 2 &&
        Math.abs(z.z - w.z) <= w.depth / 2
    );
    const plagueSlow =
      (z.plagueUntil || 0) > state.time ? CONFIG.plague.slowMul : 1;
    const slowMul =
      baseSlow *
      (inNapalm ? CONFIG.napalmWall.slowMul : 1) *
      plagueSlow *
      state.envSlowMul;

    const bar = state.barricade;
    const cfg = CONFIG.barricade;

    // 路障挡在前排：范围内的僵尸停下来啃墙
    if (bar.active && z.z < cfg.z && z.x >= bar.xMin && z.x <= bar.xMax) {
      z.z = Math.min(cfg.blockZ, z.z + z.speed * dt * slowMul);

      if (z.z >= cfg.blockZ - 0.05) {
        if (z.attackTimer == null) {
          z.attackTimer = Math.random() * cfg.attackInterval;
        }
        z.attackTimer -= dt * slowMul;

        if (z.attackTimer <= 0) {
          z.attackTimer += cfg.attackInterval;
          const dmg =
            cfg.hitDamage * (z.type === 10 ? cfg.bossMultiplier : 1);
          // 测试模式：僵尸啃不动路障
          if (!state.testMode) bar.hp = Math.max(0, bar.hp - dmg);

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

    // 两段式移动：远距离蓄力跑步靠近，进入吸附距离后放慢
    let phaseMul = 1;
    if (dist > CONFIG.zombie.chargeDistance) {
      phaseMul = CONFIG.zombie.chargeSpeedMul;
    } else if (dist < CONFIG.zombie.absorbDistance) {
      phaseMul = CONFIG.zombie.absorbSpeedMul;
    }

    if (z.z > CONFIG.zombie.aggroStartZ && dist < CONFIG.zombie.aggroRadius) {
      z.aggro = true;
    }

    // 有锁链时"绕链"优先于"追人"，两者必须互斥：
    // 同时加两个方向的力会互相抵消，僵尸会贴着链子原地磨
    const chain = state.chains.length ? state.chains[0] : null;
    // 只在接近锁链时才开始横向绕行；太早调用会让僵尸从出生点就吸向缺口
    const detour = chain && z.z >= chain.z - CONFIG.zombie.chainDetourRange
      ? chainDetour(chain, z.x, z.z)
      : null;

    if (detour && detour.dir !== 0) {
      z.x += detour.dir * CONFIG.zombie.turnSpeed * dt * slowMul;
    } else if (z.aggro && Math.abs(dx) > 0.12) {
      z.x += Math.sign(dx) * CONFIG.zombie.turnSpeed * dt * slowMul;
    }

    // 远程僵尸：走到半场就停，隔着距离往阵型吐酸液
    // （它不参与贴线滑行，所以下面那段对它不生效）
    if (z.ranged && z.z >= z.ranged.stopZ) {
      z.z = z.ranged.stopZ;
      z.aggro = true;
      z.x = clamp(z.x, -CONFIG.world.halfWidth - 1, CONFIG.world.halfWidth + 1);

      // 测试模式下也照常吐：伤害由 damageArmy 内部挡掉，弹道该看还是能看
      z.shotTimer -= dt * slowMul;
      if (z.shotTimer <= 0) {
        z.shotTimer = z.ranged.interval;
        fireEnemyShot(z);
      }
      continue;
    }

    if (z.z >= CONFIG.world.killZ) {
      // 到线就停住，不再往前，改为沿着防线滑向士兵
      // 这样它永远不会越线，最终一定会贴上
      z.z = CONFIG.world.killZ;
      z.aggro = true;

      if (Math.abs(dx) > 0.05) {
        z.x += Math.sign(dx) * CONFIG.zombie.lineSlideSpeed * dt * slowMul;
      }
    } else {
      // 水里走不动：水位漫过脚踝后整场僵尸都慢下来
      const waterMul = state.floodLevel >= CONFIG.flood.slowFrom ? CONFIG.flood.slowMul : 1;

      // Boss 入场加速：新出生点在 z=-34（画面外），到进屏线 -21.5 有 12.5 个单位。
      // 按原速 1.6/秒要走 7.8 秒，玩家长时间看不到威胁、只听见声音，会以为卡住了。
      // 离屏阶段给 1.9 倍，约 4 秒走进画面；进屏后立刻恢复正常速度，
      // 所以不影响它进场之后的压迫节奏和平衡。
      const introMul = z.boss && z.z < CONFIG.world.screenTopZ ? 1.9 : 1;
      // 普通僵尸走 phaseMul（远冲近慢）；Boss 还要兼顾离屏入场加速
      const speedMul = z.boss ? Math.max(phaseMul, introMul) : phaseMul;

      z.z += z.speed * dt * slowMul * waterMul * speedMul;
    }

    z.x = clamp(z.x, -CONFIG.world.halfWidth - 1, CONFIG.world.halfWidth + 1);

    // 坑洞挡僵尸：横向让开，不从坑里穿过去
    resolvePitCollision(z);

    // 撞链不穿模：停在链子近端（nearZ 已含僵尸半径，别自己再减）
    if (chain && isBlockedByChain(chain, z.x, z.z)) {
      z.z = Math.min(z.z, chain.nearZ);
    }
  }

  if (!frozen) separateZombies();

  // 路障反击打死的僵尸在这里统一结算
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];
    if (z.hp > 0) continue;

    state.zombies.splice(i, 1);
    state.score += zombieTypeById(z.type)?.score || 1;
    emit('zombieDie', { x: z.x, z: z.z, type: z.type });
  }

  // 结算：普通僵尸碰到士兵就消失并扣兵；Boss 不消失，改成站在线上连续出拳
  const touchHalf = formationHalfWidth();
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];
    // 被环境事件定住的僵尸不结算贴线攻击
    if ((z.envStunUntil || 0) > state.time) continue;

    const touching =
      z.z >= CONFIG.world.touchZ &&
      Math.abs(z.x - state.player.x) < touchHalf;

    // 同时认 boss 标记和 type 10：防止某个生成路径漏了 boss 字段，
    // 导致 Boss 被当成普通僵尸“贴线即删”
    if (z.boss || z.type === 10) {
      // 被虫洞 / 击退推回半场以后就停拳，重新走上来会再启动
      if (!touching) {
        z.attacking = false;
        z.attackAnimating = false;
        continue;
      }
      // 测试模式：打不死也不扣兵，方便反复观察技能
      if (state.testMode) continue;

      if (!z.attacking) {
        z.attacking = true;
        // 先等一小段再出第一拳：画面层要在下一帧才建出 Boss 模型，
        // 这一帧直接派 bossAttack 会找不到动作，第一拳就白打且没有动画
        z.attackAnimating = true;
        z.attackAnimUntil = state.time + 0.25;
        z.attackCount = 0;
        emit('bossReachLine', { id: z.id, x: z.x, z: z.z });
      }

      advanceBossAttack(z);
      continue;
    }

    if (touching) {
      // 测试模式：僵尸贴到士兵也不消失，方便继续测试技能
      if (state.testMode) continue;

      state.zombies.splice(i, 1);
      damageArmy(z.touchLoss, 'touch');
      continue;
    }
  }
}

/* Boss 的连续攻击：一拳演完才打下一拳。
 * 节奏交给动画驱动 —— 画面层播完出拳动作派 bossAttackDone，这里才允许下一拳；
 * 模型没加载 / 没有出拳动作时退回 CONFIG.boss.attackFallback 的固定间隔。
 * 这样既不会"碰一下就秒消失"，也不会一帧连扣好几次兵。 */
function advanceBossAttack(z) {
  if (z.attackAnimating) {
    if (state.time < (z.attackAnimUntil || 0)) return;
    z.attackAnimating = false;
  }

  const cfg = CONFIG.boss;
  z.attackAnimating = true;
  z.attackAnimUntil = state.time + cfg.attackFallback;
  z.attackCount = (z.attackCount || 0) + 1;

  damageArmy(cfg.attackLoss, 'boss');
  emit('bossAttack', {
    id: z.id,
    type: z.type,
    x: z.x,
    z: z.z,
    count: z.attackCount,
    // 告诉画面层这一拳要播多久：Boss 的出拳片段原长 4.8 秒，
    // 由玩法层统一给时长、画面层做时间缩放，节奏才不会各算各的
    animSeconds: cfg.attackAnim,
  });
}

// 召唤槽当前占用的预算。只算召唤槽自己造的兵，
// 生物人军团和病毒转化的友军不占预算，免得技能替槽位养了一堆兵反而把槽位卡死。
function summonBudgetUsed() {
  let used = 0;
  for (const f of state.friendlyZombies) {
    if (f.slotUnit) used += f.cost || 1;
  }
  return used;
}

function summonUnitCount(key) {
  let n = 0;
  for (const f of state.friendlyZombies) {
    if (f.slotUnit && f.unitType === key) n += 1;
  }
  return n;
}

// 按当前等级的权重挑一个能出的兵种。
// 过滤条件：预算够、该兵种没到上限（巨尸最多 1 只）。
// preferredKey 是新解锁的兵种，升级后第一只优先出它。
function pickSummonUnit(stats, preferredKey = null) {
  const budgetLeft = stats.budget - summonBudgetUsed();

  const entries = Object.entries(stats.weights)
    .map(([key, weight]) => ({ key, weight, def: stats.units[key] }))
    .filter(({ key, def }) => (
      def && def.cost <= budgetLeft && summonUnitCount(key) < def.max
    ));

  if (!entries.length) return null;

  const pref = entries.find((e) => e.key === preferredKey);
  if (pref) return pref.key;

  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll <= 0) return e.key;
  }
  return entries[entries.length - 1].key;
}

// 召唤槽：按预算造一个友方僵尸。返回是否真的造出来了
function trySpawnSummonUnit(stats, preferredKey = null) {
  const unitKey = pickSummonUnit(stats, preferredKey);
  if (!unitKey) return false;

  const def = stats.units[unitKey];
  const cfg = CONFIG.slots.summon;
  const x = cfg.x + (Math.random() * 2 - 1) * 0.35;
  const z = cfg.z + 0.3;

  state.friendlyZombies.push({
    id: state.nextId++,
    x,
    z,
    hp: def.hp,
    maxHp: def.hp,
    speed: def.speed,
    damage: def.damage,
    attackTimer: Math.random() * 0.4,
    attackInterval: def.attackInterval,
    life: 0,
    unitType: unitKey,
    role: unitKey,
    cost: def.cost,
    range: def.range,
    explodeRadius: def.explodeRadius,
    scale: def.scale,
    slotUnit: true,
  });
  emit('friendlySpawn', { x, z, unitType: unitKey });
  return true;
}

// 生物人军团：瞬间在阵型前沿生成 20 名友方僵尸
function spawnFriendlyLegion() {
  const cfg = CONFIG.bioLegion;
  const n = cfg.count;

  for (let i = 0; i < n; i++) {
    const x = -7 + (i / Math.max(1, n - 1)) * 14;
    const z = 8.4 + Math.random() * 0.4;
    state.friendlyZombies.push({
      id: state.nextId++,
      x,
      z,
      hp: cfg.hp,
      maxHp: cfg.hp,
      speed: cfg.speed,
      damage: cfg.damage,
      attackTimer: Math.random() * 0.5,
      life: 0,
      converted: false,
    });
  }

  emit('friendlySpawn', { x: 0, z: 8.5 });
}

// 病毒炸弹：在最密点周围落两枚，落地把范围内僵尸转成友方
function spawnVirusBombs(target) {
  const cfg = CONFIG.virusBomb;

  for (let i = 0; i < cfg.count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.4 + Math.random() * 1.4;
    const x = Math.max(-7.4, Math.min(7.4, target.x + Math.cos(a) * r));
    const z = Math.max(-20, Math.min(5.5, target.z + Math.sin(a) * r));

    state.virusBombs.push({
      id: state.nextId++,
      x,
      z,
      timeLeft: cfg.flightTime,
      fallTime: cfg.flightTime,
      radius: cfg.radius,
      maxConvert: cfg.maxConvert,
    });
  }
}

function updateVirusBombs(dt) {
  for (let i = state.virusBombs.length - 1; i >= 0; i--) {
    const bomb = state.virusBombs[i];
    bomb.timeLeft -= dt;
    if (bomb.timeLeft > 0) continue;

    let converted = 0;
    for (let j = state.zombies.length - 1; j >= 0 && converted < bomb.maxConvert; j--) {
      const zb = state.zombies[j];
      const dx = zb.x - bomb.x;
      const dz = zb.z - bomb.z;
      if (dx * dx + dz * dz > bomb.radius * bomb.radius) continue;

      const maxHp = zb.maxHp || zb.hp;
      const typeHp = CONFIG.zombie.types[zb.type]?.hp || 1;

      state.zombies.splice(j, 1);
      state.friendlyZombies.push({
        id: state.nextId++,
        x: zb.x,
        z: zb.z,
        hp: Math.max(1, Math.round(maxHp * 0.6)),
        maxHp: Math.max(1, Math.round(maxHp * 0.6)),
        speed: 3.2,
        damage: Math.max(6, Math.round(10 * typeHp)),
        attackTimer: Math.random() * 0.4,
        life: 0,
        converted: true,
        type: zb.type,
      });
      converted += 1;
    }

    emit('virusBombImpact', {
      x: bomb.x,
      z: bomb.z,
      radius: bomb.radius,
      count: converted,
    });
    state.virusBombs.splice(i, 1);
  }
}

// 记忆植入：传染炮弹落地，感染落点附近的一批僵尸
function updatePlagueShots(dt) {
  const cfg = CONFIG.plague;

  for (let i = state.plagueShots.length - 1; i >= 0; i--) {
    const s = state.plagueShots[i];
    s.timeLeft -= dt;
    if (s.timeLeft > 0) continue;

    state.plagueShots.splice(i, 1);

    let infected = 0;
    const r2 = s.radius * s.radius;
    for (const z of state.zombies) {
      if (infected >= s.infectCount) break;
      const dx = z.x - s.x;
      const dz = z.z - s.z;
      if (dx * dx + dz * dz > r2) continue;
      z.plagueUntil = state.time + cfg.duration;
      infected += 1;
    }

    emit('plagueImpact', {
      x: s.x,
      z: s.z,
      radius: s.radius,
      count: infected,
    });
  }
}

// 感染者持续掉血，并每隔一段时间向附近未感染的僵尸扩散
function updatePlague(dt) {
  const cfg = CONFIG.plague;

  let infectedCount = 0;
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];
    if ((z.plagueUntil || 0) <= state.time) continue;
    infectedCount += 1;
    const maxHp = Math.max(1, z.maxHp || z.hp);
    damageZombieAt(i, maxHp * cfg.damagePct * dt);
  }

  if (infectedCount === 0) {
    state.plagueSpreadTimer = 0;
    return;
  }

  state.plagueSpreadTimer -= dt;
  if (state.plagueSpreadTimer > 0) return;
  state.plagueSpreadTimer = cfg.spreadInterval;

  if (infectedCount >= cfg.maxInfected) return;

  // 感染者是传播源；Boss 只吃伤害和减速，不负责传播
  const sources = state.zombies.filter(
    (z) => (z.plagueUntil || 0) > state.time && !z.boss
  );

  for (const src of sources) {
    if (infectedCount >= cfg.maxInfected) break;

    let best = null;
    let bestD2 = cfg.spreadRadius * cfg.spreadRadius;

    for (const z of state.zombies) {
      if ((z.plagueUntil || 0) > state.time) continue;
      const dx = z.x - src.x;
      const dz = z.z - src.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = z;
      }
    }

    if (!best) continue;
    best.plagueUntil = state.time + cfg.duration;
    infectedCount += 1;
    emit('plagueSpread', {
      fromX: src.x,
      fromZ: src.z,
      x: best.x,
      z: best.z,
    });
  }
}

// 黑洞：持续吸附，结束时按最大生命百分比结算。
// 吸附用指数逼近：rate 由「duration 内拉近 pullFactor」反推，
// 每帧把距离乘以固定比例，不需要给每只僵尸记起点，新进圈的也会被吸。
function updateBlackHoles(dt) {
  for (let i = state.blackHoles.length - 1; i >= 0; i--) {
    const h = state.blackHoles[i];
    h.timeLeft -= dt;

    const rate = -Math.log(Math.max(0.05, 1 - h.pullFactor)) / h.duration;
    const step = 1 - Math.exp(-rate * dt);
    const pullR2 = h.pullRadius * h.pullRadius;

    for (const zb of state.zombies) {
      const dx = h.x - zb.x;
      const dz = h.z - zb.z;
      if (dx * dx + dz * dz > pullR2) continue;

      zb.x += dx * step;
      zb.z += dz * step;
      zb.aggro = false;
      zb.suckUntil = state.time + 0.1; // 这一小段时间内不自己走，只跟着黑洞
    }

    if (h.timeLeft > 0) continue;

    // 结算：中心半径内按最大生命扣百分比，Boss 减半
    const r2 = h.radius * h.radius;
    for (let j = state.zombies.length - 1; j >= 0; j--) {
      const zb = state.zombies[j];
      const dx = zb.x - h.x;
      const dz = zb.z - h.z;
      if (dx * dx + dz * dz > r2) continue;

      const maxHp = Math.max(1, zb.maxHp || zb.hp);
      const pct = h.damagePct * (zb.boss ? h.bossPctMul : 1);
      damageZombieAt(j, maxHp * pct);
    }

    emit('blackHoleImpact', { x: h.x, z: h.z, radius: h.radius });
    state.blackHoles.splice(i, 1);
  }
}

// 爆尸自爆：范围伤害 + 画面层的小爆炸
function explodeFriendlyBomber(f) {
  const radius = f.explodeRadius || 1.8;
  damageZombiesInRadius(f.x, f.z, radius, f.damage);
  emit('friendlyExplode', { x: f.x, z: f.z, radius });
}

// 友方僵尸：冲向最近敌人。召唤槽的兵种分三种打法：
// 近战（盾/疾/巨）、贴身自爆（爆尸）、射程外吐酸（酸吐尸）；
// 生物人军团和病毒转化的友军没有 role，照旧近战。12 秒后自然消失。
function updateFriendlyZombies(dt) {
  const endZ = CONFIG.world.spawnZ - 2;

  for (let i = state.friendlyZombies.length - 1; i >= 0; i--) {
    const f = state.friendlyZombies[i];
    f.life += dt;

    let targetIndex = -1;
    let best = Infinity;
    for (let j = 0; j < state.zombies.length; j++) {
      const zb = state.zombies[j];
      const dx = zb.x - f.x;
      const dz = zb.z - f.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        targetIndex = j;
      }
    }

    let remove = false;

    if (targetIndex >= 0) {
      const zb = state.zombies[targetIndex];
      const dx = zb.x - f.x;
      const dz = zb.z - f.z;
      const dist = Math.sqrt(best) || 1;
      // 酸吐尸停在射程边上，其他兵种贴身才开打
      const stopDist = f.role === 'spitter' ? (f.range || 4.5) : 0.9;

      if (dist > stopDist) {
        f.x += (dx / dist) * f.speed * dt;
        f.z += (dz / dist) * f.speed * dt;
      } else if (f.role === 'bomber') {
        explodeFriendlyBomber(f);
        remove = true;
      } else {
        f.attackTimer -= dt;
        if (f.attackTimer <= 0) {
          f.attackTimer = f.attackInterval || 0.7;
          if (f.role === 'spitter') {
            emit('friendlySpit', { fromX: f.x, fromZ: f.z, x: zb.x, z: zb.z });
          }
          damageZombieAt(targetIndex, f.damage);
        }
      }
    } else {
      // 场上没有敌人：继续往上走，走出屏幕就消失
      f.z -= f.speed * 0.65 * dt;
    }

    if (!remove) {
      // 被身边的敌人围殴
      let contacts = 0;
      for (const zb of state.zombies) {
        if (Math.abs(zb.x - f.x) < 0.9 && Math.abs(zb.z - f.z) < 0.9) contacts += 1;
      }
      if (contacts > 0) f.hp -= contacts * 14 * dt;

      f.x = Math.max(-CONFIG.world.halfWidth, Math.min(CONFIG.world.halfWidth, f.x));

      if (f.hp <= 0 || f.life > 12 || f.z < endZ) {
        // 爆尸死也要炸，不然白占一个预算
        if (f.role === 'bomber') explodeFriendlyBomber(f);
        remove = true;
      }
    }

    if (remove) {
      state.friendlyZombies.splice(i, 1);
      emit('friendlyDie', { x: f.x, z: f.z, unitType: f.unitType });
    }
  }
}

// 最近的僵尸下标，找不到返回 -1
function nearestZombieIndex(x, z, maxRange) {
  let best = -1;
  let bestD2 = maxRange * maxRange;

  for (let i = 0; i < state.zombies.length; i++) {
    const zb = state.zombies[i];
    const dx = zb.x - x;
    const dz = zb.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }

  return best;
}

// 坦克支援：左下方出现，打 3 发范围炮后向下撤退
/* 坦克支援：可以叠着叫。新的一辆摆在已有坦克右边，不会把前一辆顶掉；
 * 原来 state.tankSupport 是单例，第二发技能直接把第一辆覆盖了 */
function spawnTankSupport() {
  const cfg = CONFIG.tankSupport;

  // 从默认点开始往右找第一个空位。撤退中的坦克也算占位，
  // 否则两辆车会重叠着一起往后开
  const used = state.tankSupports.map((t) => t.x);
  let x = cfg.x;
  while (used.some((u) => Math.abs(u - x) < cfg.spacing * 0.5)) {
    x += cfg.spacing;
  }

  state.tankSupports.push({
    id: state.nextId++,
    x,
    z: cfg.z,
    shotsLeft: cfg.shots,
    timer: 0.25,
    retreating: false,
    retreatDelay: cfg.retreatDelay,
  });
}

function updateTankSupports(dt) {
  const cfg = CONFIG.tankSupport;

  for (let i = state.tankSupports.length - 1; i >= 0; i--) {
    const t = state.tankSupports[i];

    if (t.retreating) {
      t.z += cfg.retreatSpeed * dt;
      if (t.z > cfg.despawnZ) state.tankSupports.splice(i, 1);
      continue;
    }

    t.timer -= dt;

    if (t.shotsLeft > 0 && t.timer <= 0) {
      t.shotsLeft -= 1;
      t.timer = cfg.shotInterval;

      const target = densestPoint();
      if (target) {
        // 和攻城共用延迟炮弹队列
        state.siegeShots.push({
          x: target.x,
          z: target.z,
          radius: cfg.radius,
          damage: cfg.damage,
          timeLeft: cfg.flightTime,
          kind: 'tank',
          color: 0xffa64d,
        });
        emit('slotStrike', {
          kind: 'tank',
          fromX: t.x,
          fromZ: t.z,
          x: target.x,
          z: target.z,
          radius: cfg.radius,
          flightTime: cfg.flightTime,
          color: 0xffa64d,
        });
      }

      if (t.shotsLeft <= 0) {
        // 打完多停 4 秒再走，延长坦克在场时间
        t.retreatDelay = cfg.retreatDelay + (cfg.holdTime || 0);
      }
    }

    if (t.shotsLeft <= 0) {
      t.retreatDelay -= dt;
      if (t.retreatDelay <= 0) t.retreating = true;
    }
  }
}

// 装甲车：慢速向上，撞击伤害 + 机枪点射最近僵尸
function spawnApcCharge() {
  const cfg = CONFIG.apc;
  state.apcCharges.push({
    id: state.nextId++,
    // 固定从底部中间出发。以前 x 在 -3~3 随机，镜头跟着玩家往右偏时，
    // 最左那几档会贴着屏幕左边出现，看起来像从侧边冒出来
    x: cfg.spawnX,
    z: cfg.spawnZ,
    speed: cfg.speed,
    damage: cfg.damage,
    hit: new Set(),
    mgTimer: 0.2,
  });
}

function updateApcCharges(dt) {
  const cfg = CONFIG.apc;

  for (let i = state.apcCharges.length - 1; i >= 0; i--) {
    const a = state.apcCharges[i];
    a.z -= a.speed * dt;

    // 撞击：每只僵尸只结算一次
    for (let j = state.zombies.length - 1; j >= 0; j--) {
      const zb = state.zombies[j];
      if (a.hit.has(zb.id)) continue;
      if (Math.abs(zb.x - a.x) > cfg.hitRadius) continue;
      if (Math.abs(zb.z - a.z) > cfg.hitDepth) continue;

      a.hit.add(zb.id);
      damageZombieAt(j, a.damage);
    }

    // 机枪：每 0.35 秒打最近的僵尸
    a.mgTimer -= dt;
    if (a.mgTimer <= 0) {
      const idx = nearestZombieIndex(a.x, a.z, cfg.mgRange);
      if (idx >= 0) {
        const zb = state.zombies[idx];
        emit('apcShot', {
          fromX: a.x,
          fromZ: a.z - 0.45,
          x: zb.x,
          z: zb.z,
        });
        damageZombieAt(idx, cfg.mgDamage);
        a.mgTimer = cfg.mgInterval;
      } else {
        a.mgTimer = 0.15;
      }
    }

    if (a.z < CONFIG.world.spawnZ - 2) state.apcCharges.splice(i, 1);
  }
}

// 舰载无人机群：绕最密点转，持续一波 12 秒，自动射击最近僵尸
function spawnCarrierDrones() {
  const cfg = CONFIG.carrierDrones;
  const base = densestPoint() || { x: 0, z: -6 };

  for (let i = 0; i < cfg.count; i++) {
    const phase = (i / cfg.count) * Math.PI * 2;
    state.carrierDrones.push({
      id: state.nextId++,
      baseX: base.x,
      baseZ: base.z,
      x: base.x + Math.cos(phase) * cfg.radius,
      z: base.z + Math.sin(phase) * cfg.radius,
      phase,
      life: 0,
      mgTimer: Math.random() * cfg.interval,
    });
  }
}

function updateCarrierDrones(dt) {
  const cfg = CONFIG.carrierDrones;

  for (let i = state.carrierDrones.length - 1; i >= 0; i--) {
    const d = state.carrierDrones[i];
    d.life += dt;
    d.phase += dt * 0.9;
    d.x = d.baseX + Math.cos(d.phase) * cfg.radius;
    d.z = d.baseZ + Math.sin(d.phase) * cfg.radius;
    d.mgTimer -= dt;

    if (d.mgTimer <= 0) {
      const idx = nearestZombieIndex(d.x, d.z, cfg.range);
      if (idx >= 0) {
        const zb = state.zombies[idx];
        emit('droneShot', { fromX: d.x, fromZ: d.z, x: zb.x, z: zb.z });
        emit('droneStrike', { x: zb.x, z: zb.z, radius: cfg.aoeRadius });
        damageZombiesInRadius(zb.x, zb.z, cfg.aoeRadius, cfg.damage);
        d.mgTimer = cfg.interval;
      } else {
        d.mgTimer = 0.15;
      }
    }

    if (d.life >= cfg.life) state.carrierDrones.splice(i, 1);
  }
}

// 无人机蜂群：一波内陆续放出，每架从屏幕下方起飞，随机锁定一只僵尸后自爆
function spawnSwarmDrone() {
  const cfg = CONFIG.droneSwarm;
  // 横向贴着玩家当前站位起飞，纵向在阵型后方（屏幕更下方）
  const x = state.player.x + (Math.random() * 2 - 1) * 2.2;

  state.swarmDrones.push({
    id: state.nextId++,
    x,
    z: cfg.startZ,
    targetId: 0,
    life: 0,
    heading: 0,
  });
  emit('swarmLaunch', { x, z: cfg.startZ });
}

function pickRandomZombie() {
  if (!state.zombies.length) return null;
  return state.zombies[Math.floor(Math.random() * state.zombies.length)];
}

function updateSwarmDrones(dt) {
  const cfg = CONFIG.droneSwarm;

  // 起飞排队：一波内匀速放完 10 架
  if (state.swarm.left > 0) {
    state.swarm.timer -= dt;
    if (state.swarm.timer <= 0) {
      spawnSwarmDrone();
      state.swarm.left -= 1;
      state.swarm.timer = cfg.duration / cfg.count;
    }
  }

  for (let i = state.swarmDrones.length - 1; i >= 0; i--) {
    const d = state.swarmDrones[i];
    d.life += dt;

    // 目标死了就重新随机锁一个
    let target = d.targetId
      ? state.zombies.find((z) => z.id === d.targetId)
      : null;
    if (!target) {
      target = pickRandomZombie();
      d.targetId = target ? target.id : 0;
    }

    if (target) {
      const dx = target.x - d.x;
      const dz = target.z - d.z;
      const dist = Math.hypot(dx, dz) || 1;
      d.heading = Math.atan2(dx, dz);

      // 撞上目标：小范围爆炸后自毁
      if (dist < cfg.lockPad) {
        emit('swarmHit', { x: target.x, z: target.z, radius: cfg.aoeRadius });
        damageZombiesInRadius(target.x, target.z, cfg.aoeRadius, cfg.damage);
        state.swarmDrones.splice(i, 1);
        continue;
      }

      const step = Math.min(dist, cfg.speed * dt);
      d.x += (dx / dist) * step;
      d.z += (dz / dist) * step;
    } else {
      // 场上没僵尸：慢慢往上游，别停在半路
      d.z -= cfg.speed * dt * 0.6;
    }

    if (d.z < cfg.despawnZ || d.life > cfg.duration + 8) {
      state.swarmDrones.splice(i, 1);
    }
  }
}

// 攻城：炮弹飞行结束后，在落点结算伤害
function updateSiegeShots(dt) {
  for (let i = state.siegeShots.length - 1; i >= 0; i--) {
    const shot = state.siegeShots[i];
    shot.timeLeft -= dt;

    if (shot.timeLeft <= 0) {
      damageZombiesInRadius(shot.x, shot.z, shot.radius, shot.damage);
      emit('delayedImpact', {
        x: shot.x,
        z: shot.z,
        radius: shot.radius,
        color: shot.color || 0xffb060,
        kind: shot.kind || 'siege',
      });
      state.siegeShots.splice(i, 1);
    }
  }
}

// 滚木：横向移动，经过的僵尸每只只吃一次伤害
function updateRollingLogs(dt) {
  for (let i = state.rollingLogs.length - 1; i >= 0; i--) {
    const log = state.rollingLogs[i];
    log.x += log.speed * dt;
    log.spin += (log.speed / log.radius) * dt;

    for (let j = state.zombies.length - 1; j >= 0; j--) {
      const zb = state.zombies[j];
      if (log.hit.has(zb.id)) continue;
      if (Math.abs(zb.z - log.z) > log.length / 2 + 0.2) continue;
      if (Math.abs(zb.x - log.x) > log.radius + 0.3) continue;

      log.hit.add(zb.id);
      damageZombieAt(j, log.damage);
    }

    // 整根滚木离开右边界就移除，不让它半截露在屏幕外
    if (log.x + log.radius >= CONFIG.world.halfWidth) {
      state.rollingLogs.splice(i, 1);
    }
  }
}

// 篝火：火区内持续掉血，离圆心越远伤害越低，5 秒后消失
function updateCampfireZones(dt) {
  for (let i = state.campfireZones.length - 1; i >= 0; i--) {
    const fire = state.campfireZones[i];
    fire.remaining -= dt;

    if (fire.remaining > 0) {
      const r2 = fire.radius * fire.radius;

      for (let j = state.zombies.length - 1; j >= 0; j--) {
        const zb = state.zombies[j];
        const dx = zb.x - fire.x;
        const dz = zb.z - fire.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;

        // 线性衰减：圆心 100%，边缘保留 (1 - falloff)
        const dist = Math.sqrt(d2);
        const mul = Math.max(0, 1 - fire.falloff * (dist / fire.radius));
        damageZombieAt(j, fire.dps * mul * dt);
      }
    }

    if (fire.remaining <= 0) state.campfireZones.splice(i, 1);
  }
}

// 燃烧弹火墙：矩形区域内持续掉血，僵尸在墙里移动变慢
function updateNapalmWalls(dt) {
  for (let i = state.napalmWalls.length - 1; i >= 0; i--) {
    const wall = state.napalmWalls[i];
    wall.remaining -= dt;

    if (wall.remaining > 0) {
      const halfW = wall.width / 2;
      const halfD = wall.depth / 2;

      for (let j = state.zombies.length - 1; j >= 0; j--) {
        const zb = state.zombies[j];
        if (Math.abs(zb.x - wall.x) > halfW) continue;
        if (Math.abs(zb.z - wall.z) > halfD) continue;
        damageZombieAt(j, wall.dps * dt);
      }
    }

    if (wall.remaining <= 0) state.napalmWalls.splice(i, 1);
  }
}

// 骑士冲锋：向上贯穿，每个骑士对每只僵尸只结算一次
function updateKnightCharges(dt) {
  const endZ = CONFIG.world.spawnZ - 2;

  for (let i = state.knightCharges.length - 1; i >= 0; i--) {
    const k = state.knightCharges[i];
    k.z -= k.speed * dt;

    for (let j = state.zombies.length - 1; j >= 0; j--) {
      const zb = state.zombies[j];
      if (k.hit.has(zb.id)) continue;
      if (Math.abs(zb.x - k.x) > CONFIG.knightCharge.hitRadius) continue;
      if (Math.abs(zb.z - k.z) > CONFIG.knightCharge.hitDepth) continue;

      k.hit.add(zb.id);
      damageZombieAt(j, k.damage);
    }

    if (k.z < endZ) state.knightCharges.splice(i, 1);
  }
}

function separateZombies() {
  const list = state.zombies;
  const sep = CONFIG.zombie.separation;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      // 被黑洞吸住的僵尸不要互相推开，否则聚不成一团
      if (
        (a.suckUntil && state.time < a.suckUntil) ||
        (b.suckUntil && state.time < b.suckUntil)
      ) continue;

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
  // Boss 永远不进随机池：它只在切换时代时由 spawnEraBoss() 单独刷
  if (type.boss) return 0;
  if (wave < type.minWave) return 0;

  let w = type.baseWeight + (wave - type.minWave) * (type.growth || 0);
  if (type.minWeight != null) w = Math.max(type.minWeight, w);
  if (type.maxWeight != null) w = Math.min(type.maxWeight, w);
  return Math.max(0, w);
}

/* 旧的按权重直抽，已被 era-rules 的 pickZombieTypeForEra 取代。
 * 保留成一行转发：万一有调试脚本还在调它，不至于报 undefined。 */
function pickZombieType(wave) {
  return pickZombieTypeForEra(CONFIG.zombie.types, state.era, wave);
}

function spawnZombie() {
  const [minX, maxX] = CONFIG.world.rightZone;
  // 按时代抽：不同时代能刷出的类型和权重不一样（点子池「时代规则」）。
  // 用 state.era 而不是按波次重算，这样测试模式下面板切时代能立刻生效。
  const type = pickZombieTypeForEra(CONFIG.zombie.types, state.era, state.wave);
  const newId = state.nextId++;

  const baseHp =
    CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave;
  const baseSpeed =
    CONFIG.zombie.baseSpeed + (state.wave - 1) * CONFIG.zombie.speedPerWave;
  const nightMul = isNight(state.wave) ? CONFIG.zombie.nightSpeedMul : 1;
  const hp = baseHp * type.hp;

  state.zombies.push({
    id: newId,
    x: minX + Math.random() * (maxX - minX),
    z: CONFIG.world.spawnZ - Math.random() * 4,
    hp,
    maxHp: hp,
    speed: Math.min(
      CONFIG.zombie.speedCap,
      baseSpeed * type.speed * nightMul
    ),
    touchLoss: type.touchLoss,
    type: type.id,
    aggro: false,
    armor: type.armor || 1,        // 子弹伤害乘子（护甲僵尸 0.5）
    explode: type.explode || null, // 自爆僵尸：死了按这个半径和倍率炸
    ranged: type.ranged || null,   // 远程僵尸：停下吐东西的参数
    // 召唤者：每只自带一份召唤计时和"我召出来的孩子"上限
    summonerCfg: type.summoner ? { ...SUMMONER, id: null } : null,
    summonerState: type.summoner ? createSummonerState() : null,
    // 第一次吐之前随机等一会儿，不然一群远程会同时齐射，画面像被人打了一梭子
    shotTimer: type.ranged ? type.ranged.interval * (0.4 + Math.random() * 0.6) : 0,
    boss: !!type.boss || type.id === 10,
  });

  if (state.spawnCounts) state.spawnCounts[type.id] += 1;
}

/* ----------------------------------------------------------
 * 时代 Boss
 *
 * 每次切换时代刷一只，从右侧通道正中压下来，作为"这一时代开场的高潮"。
 * 不参与随机抽签（typeWeight 里直接返回 0），一局最多同时存在一只。
 * 血量沿用普通僵尸那套公式再乘 types 里的 hp=60，所以越往后的时代越硬。
 * ---------------------------------------------------------- */
function spawnEraBoss(eraIndex) {
  const type = CONFIG.zombie.types.find((t) => t.boss);
  if (!type) return null;

  // 场上已经有一只就不刷第二只
  if (state.zombies.some((z) => z.type === type.id)) return null;

  const [minX, maxX] = CONFIG.world.rightZone;
  const baseHp = CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave;
  const hp = baseHp * type.hp;

  const boss = {
    id: state.nextId++,
    // 从通道正中来，正对士兵，不走边缘
    x: (minX + maxX) / 2,
    // 出生点必须比普通僵尸更远。
    //
    // 普通僵尸身高 1.55，在 spawnZ(-26) 出生时头顶屏幕 y≈205，虽然已在画面里，
    // 但只占很小一块，看不出来"凭空冒出"。
    // Boss 身高 9.3（6 倍体型），在 -28 出生时头顶 y=5、脚底 218 —— 一出生就
    // 有整条身子露在画面里，玩家看到的就是"从半路长出来"。
    // 按投影算，只有 z ≤ -32 才完全出画；取 -34 留一点余量（头顶 y=-41）。
    // 这段距离在雾里（各图 fogFar 最小 72，此处深度约 62），
    // 所以效果是它从雾里一步步显形走过来，正是想要的压迫感。
    z: CONFIG.world.spawnZ - 8,
    hp,
    maxHp: hp,          // 画面层靠这个显示头顶血条
    speed: Math.min(CONFIG.zombie.speedCap, CONFIG.zombie.baseSpeed * type.speed),
    touchLoss: type.touchLoss,
    type: type.id,
    aggro: false,
    armor: type.armor || 1,
    explode: type.explode || null,
    ranged: null,
    shotTimer: 0,
    boss: true,
    era: eraIndex,
  };

  state.zombies.push(boss);
  state.spawnCounts[type.id] = (state.spawnCounts[type.id] || 0) + 1;
  emit('bossSpawn', { x: boss.x, z: boss.z, hp, wave: state.wave, era: eraIndex });
  return boss;
}

/* ----------------------------------------------------------
 * 召唤者（点子池「召唤僵尸」）
 *
 * 和 Boss 一样是"全场唯一"的特殊单位：第 9 波起，场上没有就补一只。
 * 它自己走得很慢、血也不算厚，真正的威胁是不断召快鬼——
 * 玩家必须优先点掉它，否则会被源源不断的小怪拖死。
 * 具体召唤节奏和上限在 game-summoner.js 里，这里只做接线。
 * ---------------------------------------------------------- */
// 新排程下对应现代时代开场（原来是第 9 波）
const SUMMONER_START_WAVE = 19;

function spawnSummoner() {
  const type = CONFIG.zombie.types.find((t) => t.summoner);
  if (!type) return null;
  if (state.zombies.some((z) => z.type === type.id)) return null;

  const [minX, maxX] = CONFIG.world.rightZone;
  const baseHp = CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave;
  const hp = baseHp * type.hp;
  const id = state.nextId++;

  const summons = createSummonerState();
  const z = {
    id,
    x: minX + Math.random() * (maxX - minX),
    z: CONFIG.world.spawnZ - 1,
    hp,
    maxHp: hp,
    speed: Math.min(CONFIG.zombie.speedCap, CONFIG.zombie.baseSpeed * type.speed),
    touchLoss: type.touchLoss,
    type: type.id,
    aggro: false,
    armor: type.armor || 1,
    explode: null,
    ranged: null,
    summonerCfg: { ...SUMMONER, id },
    summonerState: summons,
    shotTimer: 0,
    boss: false,
  };

  state.zombies.push(z);
  state.spawnCounts[type.id] = (state.spawnCounts[type.id] || 0) + 1;
  emit('summonerSpawn', { x: z.x, z: z.z, id });
  return z;
}

/* 每帧让所有召唤者推进一次。召唤请求直接落成新僵尸，
 * 用 summonerId 标记"谁生的"，上限才能按只统计。 */
function updateSummoners(dt) {
  for (const z of state.zombies) {
    if (!z.summonerCfg || !z.summonerState) continue;

    // 只数它自己生的孩子，别的召唤者生多少跟它无关
    let own = 0;
    for (const c of state.zombies) if (c.summonerId === z.summonerCfg.id) own++;

    const reqs = updateSummoner(z.summonerCfg, z.summonerState, {
      dt,
      aliveCount: own,
      isInsideArena: (x, zz) =>
        x >= CONFIG.world.rightZone[0] - 0.4 &&
        x <= CONFIG.world.rightZone[1] + 0.4 &&
        zz >= -28,
    });

    for (const r of reqs) {
      const baseHp = CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave;
      const childType = zombieTypeById(r.type);
      const hp = baseHp * (childType ? childType.hp : 1) * r.hpMul;
      state.zombies.push({
        id: state.nextId++,
        x: r.x,
        z: r.z,
        hp,
        maxHp: hp,
        speed: Math.min(
          CONFIG.zombie.speedCap,
          CONFIG.zombie.baseSpeed * (childType ? childType.speed : 1)
        ),
        touchLoss: childType ? childType.touchLoss : 1,
        type: r.type,
        aggro: false,
        armor: 1,
        explode: null,
        ranged: null,
        summonerCfg: null,
        summonerState: null,
        summonerId: z.summonerCfg.id,  // 归属：计入上限统计
        shotTimer: 0,
        boss: false,
      });
    }
  }
}

/* ----------------------------------------------------------
 * 锁链路障（点子池「锁链路障」）
 *
 * 和路障的区别：路障是"停下来啃"，锁链是"过不去、必须绕"。
 * 所以锁链不可破坏，只占半条通道——另外半条留出来给僵尸绕。
 * 判定和绕行方向都在 game-chainbarricade.js 里算，这里只负责摆放。
 *
 * 位置按波次交替左右，玩家不能靠"记住上次从哪边绕"过关。
 * ---------------------------------------------------------- */
function spawnChain(wave) {
  const [laneMin, laneMax] = CONFIG.world.rightZone;
  const laneWidth = laneMax - laneMin;
  const width = laneWidth * CONFIG.chain.widthRatio;

  // 只挡半边：奇数波挡左边（留右侧缝），偶数波挡右边（留左侧缝）
  const onLeft = wave % 2 === 1;
  const x = onLeft
    ? laneMin + width / 2
    : laneMax - width / 2;

  // 只换锁链本身。坑洞、武器箱、玩家手上的枪都不该被换链顺手清掉——
  // 之前这里误插了清空语句，导致每波开始都会把捡到的枪悄悄收回
  state.chains.length = 0;
  const chain = createChain({ x, z: CONFIG.chain.z, width, laneMin, laneMax });
  state.chains.push(chain);
  emit('chainSpawn', { x: chain.x, z: chain.z, width: chain.width });
  return chain;
}

/* ----------------------------------------------------------
 * 地面塌陷（点子池「地面塌陷」）：地面裂开坑洞，玩家和僵尸都过不去
 *
 * 两种落点，各有各的用处：
 *   - 撒在僵尸通道里（z -16~4）：挡僵尸的路，逼它们绕行
 *   - 撒在玩家那条线上（z 7~9.2）：挡玩家走位，压缩可选的站位
 * 只撒一种的话，另一种"过不去"就是空话。
 *
 * 关键约束：坑的横向位置必须离通道边界留出绕行空间，
 * 否则僵尸会横着让不开、堵在坑前把整条道堵死。
 * ---------------------------------------------------------- */
function pitBlocksPoint(pit, x, z, pad) {
  const dx = x - pit.x;
  const dz = z - pit.z;
  const r = pit.r + pad;
  return dx * dx + dz * dz < r * r;
}

function spawnPit() {
  if (state.pits.length >= CONFIG.pit.max) return null;

  const r = CONFIG.pit.radius;
  const [laneMin, laneMax] = CONFIG.world.rightZone;
  const laneW = laneMax - laneMin;

  // 六成撒在僵尸通道，四成撒在玩家线上——两种"过不去"都得真的出现
  let x;
  let z;
  if (Math.random() < 0.6) {
    // 通道里：左右都留够绕行宽度，僵尸一定能从旁边挤过去
    const lo = laneMin + r + 0.9;
    const hi = laneMax - r - 0.9;
    x = lo + Math.random() * (hi - lo);
    z = -16 + Math.random() * 20;
  } else {
    x = -CONFIG.world.halfWidth + r + 0.4 + Math.random() * (CONFIG.world.halfWidth * 2 - r * 2 - 0.8);
    z = 7 + Math.random() * 2.2;
  }

  // 不塌在玩家脚下：塌了就等于把人锁死在坑中心
  const px = state.player.x;
  const pz = state.player.z;
  if (Math.hypot(x - px, z - pz) < CONFIG.pit.avoidPlayer) return null;

  const pit = { id: state.nextId++, x, z, r, life: 0, maxLife: CONFIG.pit.life };
  state.pits.push(pit);
  emit('pitSpawn', { x, z, r });
  return pit;
}

function updatePits(dt) {
  if (state.testMode) return;

  // 回填：活够时间自己愈合，坑不会永久占场把玩家逼死
  for (let i = state.pits.length - 1; i >= 0; i--) {
    const p = state.pits[i];
    p.life += dt;
    if (p.life >= CONFIG.pit.life) {
      state.pits.splice(i, 1);
      emit('pitFill', { x: p.x, z: p.z, r: p.r });
    }
  }

  // 计时器一直走，只是波次没到就先不塌。
  // 之前写成"波次不够直接 return"，结果计时器被冻住，
  // 进入起始波之后还要白等一整个 interval 才会出现第一个坑。
  state.pitTimer -= dt;
  if (state.pitTimer > 0) return;
  state.pitTimer = CONFIG.pit.interval;
  if (state.wave < CONFIG.pit.startWave) return;
  spawnPit();
}

/* 僵尸被坑挡住时往旁边让。
 * 只往横向推，不往纵向推：僵尸是往 +z 走的，纵向推会把它顶回去，
 * 下一步又往前走，形成原地来回抖——和之前锁链那个坑是同一类问题。 */
function resolvePitCollision(z) {
  if (!state.pits.length) return;

  for (const pit of state.pits) {
    const minD = pit.r + 0.38;
    const dx = z.x - pit.x;
    const dz = z.z - pit.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= minD * minD) continue;

    // 在坑中心（几乎不该发生）时统一往通道中间让，避免随机翻面
    let side = dx >= 0 ? 1 : -1;
    if (Math.abs(dx) < 0.02) side = z.x > 4.1 ? -1 : 1;

    z.x = pit.x + side * minD;
  }
}

/* ----------------------------------------------------------
 * 掉落拾取（点子池「掉落拾取」）：场上掉武器箱，走过去换枪
 *
 * 和补给箱的区别（别混）：
 *   - 补给箱是「打碎」，给兵/分，是资源
 *   - 武器箱是「走过去」，临时换一把枪，是手感变化
 *
 * 换来的枪只持续 CONFIG.pickup.duration 秒，然后自动换回时代武器。
 * 做成永久的话「时代规则」那套武器档位就永远被盖掉了——
 * 中世纪捡到一把机枪之后，后面五个时代的武器差异全白做。
 * ---------------------------------------------------------- */
function spawnWeaponPickup() {
  if (state.pickups.length >= CONFIG.pickup.max) return null;

  const list = CONFIG.pickup.weapons;
  const weapon = list[Math.floor(Math.random() * list.length)];

  // 落在玩家走位圈里：这个箱子是"走过去捡"的，横向必须在可走范围
  const halfW = CONFIG.world.halfWidth;
  const x = (Math.random() * 2 - 1) * (halfW - 0.8);
  // 纵向放在玩家线上方不远，走两步就能到，不用穿越僵尸阵
  const z = state.player.z - 2.5 - Math.random() * 3.5;

  const box = {
    id: state.nextId++, x, z, y: 11, landed: false,
    kind: 'weapon', weapon, life: CONFIG.pickup.life,
  };
  state.pickups.push(box);
  emit('pickupSpawn', { x, z, id: box.id, kind: weapon.kind });
  return box;
}

function updatePickups(dt) {
  if (state.testMode) return;

  // 落地
  for (const b of state.pickups) {
    if (b.landed) continue;
    b.y -= 10 * dt;
    if (b.y <= 0) {
      b.y = 0;
      b.landed = true;
      emit('pickupLand', { x: b.x, z: b.z, id: b.id });
    }
  }

  // 箱子不再"走过去自动生效"：掉下来的箱子一律要用子弹打中才算数。
  // 打不中就在场上待 pickup.life 秒自动消失，否则会一直占着刷新位
  for (let i = state.pickups.length - 1; i >= 0; i--) {
    const b = state.pickups[i];
    if (!b.landed) continue;
    b.life -= dt;
    if (b.life <= 0) {
      state.pickups.splice(i, 1);
      emit('pickupExpired', { x: b.x, z: b.z, id: b.id });
    }
  }

  // 倒计时：到点换回时代武器
  if (state.playerWeapon) {
    state.playerWeapon.remaining -= dt;
    if (state.playerWeapon.remaining <= 0) {
      const name = state.playerWeapon.name;
      state.playerWeapon = null;
      emit('weaponExpired', { name });
    }
  }

  state.pickupTimer -= dt;
  if (state.pickupTimer > 0) return;
  state.pickupTimer = CONFIG.pickup.interval;
  spawnWeaponPickup();
}

function equipWeapon(weapon) {
  const prev = state.playerWeapon;
  state.playerWeapon = {
    kind: weapon.kind,
    name: weapon.name,
    desc: weapon.desc,
    bullets: weapon.bullets || 1,
    spread: weapon.spread || 0,
    intervalMul: weapon.intervalMul || 1,
    damageMul: weapon.damageMul || 1,
    pierce: !!weapon.pierce,
    tint: weapon.tint,
    remaining: CONFIG.pickup.duration,
    maxDuration: CONFIG.pickup.duration,
  };
  emit('weaponPickup', {
    kind: weapon.kind,
    name: weapon.name,
    desc: weapon.desc,
    tint: weapon.tint,
    replaced: prev ? prev.name : null,
  });
}

function damageArmy(amount, cause) {
  if (state.status !== 'playing') return;
  // 测试模式：僵尸和负数屏障都不扣兵，方便反复观察技能
  if (state.testMode) return;

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
    state.upgradePanel.active = false;
    state.upgradePanel.picks = 0;
    state.upgradeCarry = 0;
    state.timeScale = 1;
  }
}

// 屏障数值生效：正数加兵，负数扣兵
// testMode 下负数不生效；献祭这类主动扣兵用 force 绕过
function applySoldiers(delta, opts = {}) {
  if (state.status !== 'playing') return;
  if (state.testMode && delta < 0 && !opts.force) return;

  state.soldiers += delta;

  if (delta < 0) {
    emit('armyHurt', { soldiers: state.soldiers, amount: -delta, cause: 'barrier' });
  }

  if (state.soldiers <= 0) {
    state.soldiers = 0;
    state.status = 'over';
    state.upgradePanel.active = false;
    state.upgradePanel.picks = 0;
    state.upgradeCarry = 0;
    state.timeScale = 1;
  }
}

/* ----------------------------------------------------------
 * 初始化 UI
 * 放在文件末尾：buildDom 会立刻读取 SKILL_DEFS，提前调用会触发 TDZ 报错
 * ---------------------------------------------------------- */
initUI(state, {
  start: (opts) => startGame(opts),
  restart: () => startGame({
    testMode: state.testMode,
    startingEra: state.startEra,
    map: state.startMap,
  }),
  setPaused,
  returnToMenu,
  revive: revive,
  castSkill,
  setSlotLevel,
  setEra: setEraForTest,
  spawnTestZombies,
  clearZombies: clearTestZombies,
  getTestData,
  getSlotInfo,
  useSkill,
  getSkillBag,
  getUpgradePool: buildUpgradePool,
  chooseUpgrade,
  triggerEnvEvent: triggerEnvEventNow,
});

/* ----------------------------------------------------------
 * 主循环
 * ---------------------------------------------------------- */
let lastTime = performance.now();

function loop(now) {
  requestAnimationFrame(loop);

  const realDt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (state.status === 'playing') {
    if (state.paused) {
      // 暂停菜单：画面冻结，升级面板的倒计时也停住
      syncScene(state, 0);
    } else if (state.upgradePanel.active) {
      // 升级面板：完全暂停游戏，但面板自己的 30 秒倒计时继续走
      updateUpgradePanel(realDt);
      syncScene(state, 0);
    } else {
      const dt = realDt * state.timeScale;
      update(dt);
      syncScene(state, dt);
    }
  } else {
    syncScene(state, realDt);
  }

  updateUI(state);
}

requestAnimationFrame(loop);
