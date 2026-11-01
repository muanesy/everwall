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

import { initVisuals, syncScene } from './visuals.js';
import { initUI, updateUI } from './ui.js';

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
    minFireInterval: 0.18, // 射击间隔的下限，防止子弹太多
    bulletSpeed: 28,
    bulletDamage: 10,
    maxVolley: 5,          // 总火力上限，越大总射速越高
  },
  weapon: {
    lineGap: 1.1,        // 多条弹道之间的横向间距
    maxLines: 5,         // 最多几条弹道
    spreadMaxRatio: 0.15, // 扩散器：到屏幕顶端时单侧最大偏移 / 纵向距离
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
    negativeGrowth: 3,     // 每波上限增加
    capMin: 10,            // 打满后的下限
    capBase: 30,           // 打满上限的基础值
    capGrowth: 4,          // 每波打满上限增加
    negativeChanceBase: 0.15,   // 负数屏障的基础概率
    negativeChancePerWave: 0.02, // 每波增加
    negativeChanceMax: 0.35,    // 概率上限
    negativeLengthEveryWaves: 4, // 每几波变长一次
    negativeLengthMax: 3,        // 最长占几个格子
    weaponChance: 0.02,          // 武器强化屏障的出现概率
    spreaderChance: 0.02,        // 扩散器的出现概率
    weaponHitsBase: 30,          // 武器强化需要的基础命中数
    weaponHitsPerWave: 6,        // 每波增加
    spreaderHitsBase: 20,        // 扩散器需要的基础命中数
    spreaderHitsPerWave: 4,      // 每波增加
  },
  zombie: {
    baseHp: 20,
    hpPerWave: 8,
    baseSpeed: 3.2,
    speedPerWave: 0.25,
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

  player: {
    x: 0,
    z: CONFIG.world.playerZ,
  },

  // 武器状态：默认一条弹道，没有扩散
  weapon: {
    lines: 1,
    spread: false,
  },

  bullets: [],  // { id, x, z, vz, damage }
  barriers: [], // { id, x, z, hp, speed }
  zombies: [],  // { id, x, z, hp, speed, type }

  fireTimer: 0,
  barrierTimer: 0,
  zombieTimer: 0,
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
});

/* ----------------------------------------------------------
 * 输入：键盘 + 触摸拖动
 * ---------------------------------------------------------- */
window.addEventListener('keydown', (e) => {
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
  state.weapon.lines = 1;
  state.weapon.spread = false;

  state.bullets.length = 0;
  state.barriers.length = 0;
  state.zombies.length = 0;

  state.fireTimer = 0;
  state.barrierTimer = 0.6;
  state.zombieTimer = 0.8;
  state.nextId = 1;
  state.spawnCounts.fill(0);
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
  state.fireTimer = 0;
  state.barrierTimer = 0.4;
  state.zombieTimer = 0.8;
}

/* ----------------------------------------------------------
 * 每帧更新
 * ---------------------------------------------------------- */
function update(dt) {
  state.time += dt;

  const nextWave = Math.floor(state.time / CONFIG.wave.duration) + 1;
  if (nextWave !== state.wave) {
    state.wave = nextWave;
    emit('waveStart', { wave: nextWave });
  }

  updatePlayer(dt);
  updateFiring(dt);
  updateBullets(dt);
  updateBarriers(dt);
  updateZombies(dt);
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
      state.player.x + dir * CONFIG.player.speed * dt,
      -CONFIG.world.halfWidth,
      CONFIG.world.halfWidth
    );
  }
}

function updateFiring(dt) {
  state.fireTimer -= dt;
  if (state.fireTimer > 0) return;

  const lines = state.weapon.lines;

  // 总射速由士兵数决定，拆到几条弹道上，总子弹数不变
  const baseCount = Math.min(
    CONFIG.player.maxVolley,
    1 + Math.floor(state.soldiers / 10)
  );
  const baseInterval = Math.max(
    CONFIG.player.minFireInterval,
    CONFIG.player.baseFireInterval / Math.max(1, state.soldiers)
  );
  const totalRate = baseCount / baseInterval; // 每秒多少发

  state.fireTimer = lines / totalRate;

  const gap = CONFIG.weapon.lineGap;
  const maxVx = state.weapon.spread
    ? CONFIG.weapon.spreadMaxRatio * CONFIG.player.bulletSpeed
    : 0;

  for (let i = 0; i < lines; i++) {
    const offset = (i - (lines - 1) / 2) * gap;
    const vx = maxVx ? (Math.random() * 2 - 1) * maxVx : 0;

    state.bullets.push({
      id: state.nextId++,
      x: state.player.x + offset,
      z: state.player.z - 0.25,
      vx,
      vz: -CONFIG.player.bulletSpeed,
      damage: CONFIG.player.bulletDamage,
    });
  }

  emit('shoot', { x: state.player.x, z: state.player.z });
}

/* ----------------------------------------------------------
 * 子弹：打屏障加人，打僵尸得分
 * ---------------------------------------------------------- */
function updateBullets(dt) {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x += (b.vx || 0) * dt;
    b.z += b.vz * dt;

    if (b.z < CONFIG.world.spawnZ - 1 || Math.abs(b.x) > 14) {
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
        if (bar.kind === 'negative') {
          // 负数屏障：每打一发 +1，打满上限就生效
          bar.value += 1;
          emit('barrierHit', { x: bar.x, z: bar.z, value: bar.value });

          if (bar.value >= bar.maxValue) {
            applySoldiers(bar.value);
            emit('barrierApply', { x: bar.x, z: bar.z, value: bar.value });
            state.barriers.splice(j, 1);
          }
        } else if (bar.kind === 'weapon' || bar.kind === 'spreader') {
          // 武器强化 / 扩散器：攒够命中才生效，没攒够就白打
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
              state.weapon.spread = true;
              emit('spreaderUnlock', {});
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
        state.bullets.splice(i, 1);

        if (z.hp <= 0) {
          state.zombies.splice(j, 1);
          state.score += CONFIG.zombie.types[z.type].score;
          emit('zombieDie', { x: z.x, z: z.z, type: z.type });
        }
        break;
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
      // 武器强化和扩散器错过就不生效，只有正负数屏障会结算
      if (bar.kind === 'normal' || bar.kind === 'negative') {
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

  // 负数屏障越到后期越多、越长
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
  const spreaderChance = state.weapon.spread
    ? 0
    : CONFIG.barrier.spreaderChance;
  const specialChance = weaponChance + spreaderChance;

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
      state.barriers.push(makeSpecialBarrier('spreader', x, z, wave));
      i += 1;
    } else if (roll < specialChance + negativeChance) {
      const len = Math.min(negativeLength, xs.length - i);
      const centerX = x + (step * (len - 1)) / 2;

      state.barriers.push({
        id: state.nextId++,
        kind: 'negative',
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
      : CONFIG.barrier.spreaderHitsBase +
        (wave - 1) * CONFIG.barrier.spreaderHitsPerWave;

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
function updateZombies(dt) {
  state.zombieTimer -= dt;

  const spawnInterval = Math.max(
    CONFIG.zombie.minSpawnInterval,
    CONFIG.zombie.spawnInterval - (state.wave - 1) * CONFIG.zombie.intervalPerWave
  );

  if (state.zombieTimer <= 0) {
    if (state.zombies.length < CONFIG.zombie.maxAlive) {
      const count = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) spawnZombie();
    }
    state.zombieTimer = spawnInterval;
  }

  // 移动：进入下半场且离士兵够近时，开始横向追人
  for (const z of state.zombies) {
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
      z.z += z.speed * dt;
    }

    z.x = clamp(z.x, -CONFIG.world.halfWidth - 1, CONFIG.world.halfWidth + 1);
  }

  separateZombies();

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

  state.zombies.push({
    id: state.nextId++,
    x: minX + Math.random() * (maxX - minX),
    z: CONFIG.world.spawnZ - Math.random() * 4,
    hp: baseHp * type.hp,
    speed: Math.min(CONFIG.zombie.speedCap, baseSpeed * type.speed),
    touchLoss: type.touchLoss,
    type: type.id,
    aggro: false,
  });

  if (state.spawnCounts) state.spawnCounts[type.id] += 1;
}

function damageArmy(amount, cause) {
  if (state.status !== 'playing') return;

  state.soldiers -= amount;
  emit('armyHurt', { soldiers: state.soldiers, amount, cause });

  if (state.soldiers <= 0) {
    state.soldiers = 0;
    state.status = 'over';
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
  }
}

/* ----------------------------------------------------------
 * 主循环
 * ---------------------------------------------------------- */
let lastTime = performance.now();

function loop(now) {
  requestAnimationFrame(loop);

  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (state.status === 'playing') update(dt);

  syncScene(state, dt);
  updateUI(state);
}

requestAnimationFrame(loop);
