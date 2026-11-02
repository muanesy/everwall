/* ----------------------------------------------------------
 * 时代规则：不同时代改「出什么僵尸」和「玩家用什么武器」
 *
 * 为什么单独拆一个文件：game.js 里 spawnZombie 抽签和 updateFiring
 * 算射速各在一处，把「时代差异」写进任何一边都会让那个函数变成一坨
 * if/else。这里只提供纯数据 + 纯函数，调用方各取所需。
 *
 * 设计原则：
 * - 权重表只写倍率，不重写 baseWeight。这样 wave 成长曲线仍然由
 *   CONFIG.zombie.types 说了算，时代只负责「放大或砍掉某一类」。
 * - 倍率 0 表示本时代完全不出现，用于做时代辨识度（中世纪没有远程）。
 * - 每个时代至少留 2 种高威胁类型，不能出现「没有硬怪」或「全是硬怪」。
 * ---------------------------------------------------------- */

const ERA_COUNT = 6;

// 僵尸 id 在这里写成常量，避免下面表格出现魔法数字时看不出是谁
const Z = {
  NORMAL: 0,   // 普通
  BRUTE: 1,    // 大块头
  RUNNER: 2,   // 快鬼
  ELITE: 3,    // 精英
  WOMAN: 4,    // 女僵尸
  BOSS: 10,    // 时代 Boss（永远不进随机池）
  BOMBER: 11,  // 自爆
  ARMOR: 12,   // 护甲
  RANGED: 13,  // 远程
};

/* ----------------------------------------------------------
 * 1. 时代 → 僵尸权重倍率
 * ---------------------------------------------------------- */
const ZOMBIE_MODS = [
  // 时代 0 中世纪：只有慢速近战。快鬼/远程/自爆/护甲全部为 0，
  // 逼玩家用「慢射速、单发重」的弩去处理成群普通 + 少量大块头。
  // 大块头拉到 1.35，是因为没有快鬼分摊压力，不加点硬怪会变成纯割草。
  {
    [Z.NORMAL]: 1.0,
    [Z.BRUTE]: 1.35,
    [Z.RUNNER]: 0,
    [Z.ELITE]: 0,
    [Z.WOMAN]: 0,
    [Z.BOMBER]: 0,
    [Z.ARMOR]: 0,
    [Z.RANGED]: 0,
  },
  // 时代 1 二战：快鬼当步兵冲锋，远程当步枪兵（第 7 波才解锁，
  // 所以本时代后半段才开始出现）。自爆留给现代，别一上来就三线压力。
  {
    [Z.NORMAL]: 1.0,
    [Z.BRUTE]: 1.15,
    [Z.RUNNER]: 1.5,
    [Z.ELITE]: 0.7,
    [Z.WOMAN]: 1.0,
    [Z.BOMBER]: 0,
    [Z.ARMOR]: 0,
    [Z.RANGED]: 1.4,
  },
  // 时代 2 现代：全类型开放，护甲登场（1.4）。这是第一个「什么都有」
  // 的时代，但每类都不算突出，作为后面两个时代的对照基线。
  {
    [Z.NORMAL]: 1.0,
    [Z.BRUTE]: 1.0,
    [Z.RUNNER]: 1.0,
    [Z.ELITE]: 1.0,
    [Z.WOMAN]: 1.0,
    [Z.BOMBER]: 1.0,
    [Z.ARMOR]: 1.4,
    [Z.RANGED]: 1.0,
  },
  // 时代 3 后现代：精英 + 自爆双高，强调「必须先点掉」的压力。
  // 普通僵尸压到 0.75，让场上数量少一点但每只都更难缠，
  // 否则杂兵会盖住精英/自爆的存在感。
  {
    [Z.NORMAL]: 0.75,
    [Z.BRUTE]: 1.0,
    [Z.RUNNER]: 0.9,
    [Z.ELITE]: 1.9,
    [Z.WOMAN]: 1.0,
    [Z.BOMBER]: 1.9,
    [Z.ARMOR]: 1.2,
    [Z.RANGED]: 1.0,
  },
  // 时代 4 星际：远程 + 快鬼为主，节奏最快。大块头压到 0.7，
  // 因为远程已经在逼玩家分火，再堆肉盾会变成单纯堆血。
  {
    [Z.NORMAL]: 0.7,
    [Z.BRUTE]: 0.7,
    [Z.RUNNER]: 1.8,
    [Z.ELITE]: 1.0,
    [Z.WOMAN]: 0.8,
    [Z.BOMBER]: 1.0,
    [Z.ARMOR]: 1.0,
    [Z.RANGED]: 2.0,
  },
  // 时代 5 终幕：全部拉满，精英/自爆/远程一起上。
  // 注意倍率只看相对大小，这里普通也留在 1.0，是为了保留「杂兵海」
  // 这个基础盘，否则会退化成只剩几只怪在场上、反而更轻松。
  {
    [Z.NORMAL]: 1.0,
    [Z.BRUTE]: 1.3,
    [Z.RUNNER]: 1.4,
    [Z.ELITE]: 2.0,
    [Z.WOMAN]: 1.2,
    [Z.BOMBER]: 2.0,
    [Z.ARMOR]: 1.6,
    [Z.RANGED]: 1.5,
  },
];

/* ----------------------------------------------------------
 * 2. 时代 → 武器档位
 *
 * 玩家是自动开火模型，所以「武器」只能通过三个乘子影响手感：
 *   fireIntervalMul 乘在射击间隔上，>1 = 更慢
 *   damageMul       乘在单发伤害上
 *   spreadMul       乘在枪口抖动（CONFIG.weapon.jitterBase）上，>1 = 更散
 *
 * 各代 DPS 大致按 damageMul / fireIntervalMul 算，故意控制在 1.0~1.3 倍：
 * 时代本身已经用 hpPower / attackPower 涨过一轮，武器再叠太多会失衡。
 * 差异应该体现在「手感」而不是纯数值：弩是一发一发顿，激光是连续线。
 * ---------------------------------------------------------- */
const WEAPON_PROFILES = [
  // 1.6 / 1.5 ≈ 1.07 倍，单发伤害高但节奏慢，打大块头舒服、打分裂的小怪难受
  { name: '弩', fireIntervalMul: 1.5, damageMul: 1.6, spreadMul: 0.55 },
  // 1.25 / 1.15 ≈ 1.09 倍，栓动：间隔比弩短一截，但仍然有「拉栓」的顿感
  { name: '栓动步枪', fireIntervalMul: 1.15, damageMul: 1.25, spreadMul: 0.8 },
  // 0.78 / 0.72 ≈ 1.08 倍，射速明显变快，散布略放大换取压制感
  { name: '自动步枪', fireIntervalMul: 0.72, damageMul: 0.78, spreadMul: 1.15 },
  // 0.58 / 0.5 ≈ 1.16 倍，冲锋枪：最散、最吵、最跟手
  { name: '冲锋枪', fireIntervalMul: 0.5, damageMul: 0.58, spreadMul: 1.45 },
  // 1.0 / 0.85 ≈ 1.18 倍，能量枪：中等射速但非常准，配合远程对枪
  { name: '能量枪', fireIntervalMul: 0.85, damageMul: 1.0, spreadMul: 0.6 },
  // 0.46 / 0.35 ≈ 1.31 倍，激光：终幕给的最强档，靠极高射速压场
  { name: '激光枪', fireIntervalMul: 0.35, damageMul: 0.46, spreadMul: 0.45 },
];

function clampEra(eraId) {
  const n = Math.floor(Number(eraId)) || 0;
  return Math.min(ERA_COUNT - 1, Math.max(0, n));
}

/**
 * 时代 → 僵尸权重倍率表，未列出的 id 按 1 处理，0 表示本时代不出现。
 * 返回副本，调用方乱改也不会污染模块内的常量表。
 */
export function eraZombieWeightMod(eraId) {
  return { ...ZOMBIE_MODS[clampEra(eraId)] };
}

/**
 * 时代 → 武器档位。返回副本，理由同上。
 */
export function eraWeaponProfile(eraId) {
  return { ...WEAPON_PROFILES[clampEra(eraId)] };
}

/**
 * 波次 → 时代 id。前 everyWaves 波是时代 0，之后每 everyWaves 波推进一个。
 * 封顶在 eraCount - 1，保证无限波次不会算出越界时代。
 */
export function eraForWave(wave, everyWaves = 4, eraCount = ERA_COUNT) {
  const w = Math.max(1, Math.floor(Number(wave)) || 1);
  const span = Math.max(1, Math.floor(everyWaves) || 1);
  const era = Math.floor((w - 1) / span);
  return Math.min(Math.max(1, eraCount) - 1, Math.max(0, era));
}

/**
 * 按时代 + 波次抽一只僵尸，替代 game.js 里直接按 baseWeight 抽。
 *
 * 顺序很关键：先过 minWave（波次不到就不该出现），再用 types 自带的
 * growth 算成长并夹取，最后乘时代倍率。夹取放在倍率之前，是为了让
 * 「倍率 0」能真正把类型清零——否则 minWeight 会把权重又抬回来。
 *
 * rand 注入是为了测试能固定随机序列。
 */
export function pickZombieTypeForEra(types, eraId, wave, rand = Math.random) {
  if (!Array.isArray(types) || types.length === 0) return undefined;

  const mods = eraZombieWeightMod(eraId);
  const pool = [];
  let total = 0;

  for (const type of types) {
    // Boss 永远不进随机池：它只由 spawnEraBoss() 在切换时代时单独刷
    if (type.boss) continue;
    if (wave < type.minWave) continue;

    let w = type.baseWeight + (wave - type.minWave) * (type.growth || 0);
    if (type.minWeight != null) w = Math.max(type.minWeight, w);
    if (type.maxWeight != null) w = Math.min(type.maxWeight, w);
    if (w <= 0) continue;

    const mul = mods[type.id] != null ? mods[type.id] : 1;
    w *= mul;
    if (w <= 0) continue;

    pool.push({ type, weight: w });
    total += w;
  }

  // 兜底：只要 CONFIG 里还有普通僵尸，就永远抽得到东西，绝不返回 undefined
  if (pool.length === 0 || total <= 0) {
    return (
      types.find((t) => t.id === Z.NORMAL) ||
      types.find((t) => !t.boss) ||
      types[0]
    );
  }

  let roll = rand() * total;
  for (const entry of pool) {
    roll -= entry.weight;
    if (roll <= 0) return entry.type;
  }
  // 浮点误差导致最后一格没被扣完时，退回池尾而不是 undefined
  return pool[pool.length - 1].type;
}
