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
    killZ: 8.4,        // 僵尸越过这条线就算突过去，扣更多兵
    leftZone: [-7.6, -0.6],  // +1 屏障出现的横向范围
    rightZone: [0.6, 7.6],   // 僵尸出现的横向范围
  },
  player: {
    speed: 14,
    baseFireInterval: 0.5, // 1 个士兵时的射击间隔
    minFireInterval: 0.18, // 射击间隔的下限，防止子弹太多
    bulletSpeed: 28,
    bulletDamage: 10,
    volleySpread: 0.9,     // 多发子弹的横向总宽度，越小越集中
    maxVolley: 5,
  },
  barrier: {
    speed: 6.5,            // 压下来的速度
    spawnInterval: 2.4,
    rowGap: 1.44,          // 横向间隔，铺满左半边
    negativeChance: 0.15,  // 每一排里出现负数屏障的概率
    negativeMin: -30,
    negativeMax: -10,
    capMin: 10,            // 负数屏障打满后的上限
    capMax: 30,
    touchHalfWidth: 1.0,   // 屏障碰到士兵的判定半宽
  },
  zombie: {
    baseHp: 20,
    hpPerWave: 8,
    baseSpeed: 3.2,
    speedPerWave: 0.3,
    maxSpeed: 8,
    spawnInterval: 0.35,
    minSpawnInterval: 0.14,
    intervalPerWave: 0.03,
    touchLoss: 1,      // 碰到士兵扣 1
    maxAlive: 120,
    touchHalfWidth: 0.8, // 士兵队列的碰撞半宽
    aggroStartZ: -30,    // 从出生点就开始追人
    aggroRadius: 50,     // 保证所有僵尸都能吸附到士兵身上
    turnSpeed: 6,        // 侧向追击速度
    separation: 0.6,     // 僵尸之间的最小间距，防止叠成一坨
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

  bullets: [],  // { id, x, z, vz, damage }
  barriers: [], // { id, x, z, hp, speed }
  zombies: [],  // { id, x, z, hp, speed, type }

  fireTimer: 0,
  barrierTimer: 0,
  zombieTimer: 0,
  nextId: 1,
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

  state.bullets.length = 0;
  state.barriers.length = 0;
  state.zombies.length = 0;

  state.fireTimer = 0;
  state.barrierTimer = 0.6;
  state.zombieTimer = 0.8;
  state.nextId = 1;
}

function startGame() {
  resetState();
}

function revive() {
  if (state.status !== 'over') return;

  state.status = 'playing';
  state.soldiers = 20;
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

  // 人越多，射速越快
  state.fireTimer = Math.max(
    CONFIG.player.minFireInterval,
    CONFIG.player.baseFireInterval / Math.max(1, state.soldiers)
  );

  // 多发子弹，但发射点靠得很近，看起来是一束而不是散开
  const count = Math.min(
    CONFIG.player.maxVolley,
    1 + Math.floor(state.soldiers / 10)
  );
  const spread = CONFIG.player.volleySpread;

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = state.player.x + (t - 0.5) * spread;

    state.bullets.push({
      id: state.nextId++,
      x,
      z: state.player.z - 0.25,
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
    b.z += b.vz * dt;

    if (b.z < CONFIG.world.spawnZ - 1) {
      state.bullets.splice(i, 1);
      continue;
    }

    let consumed = false;

    // 先判定 +1 屏障。屏幕外的屏障打不到。
    for (let j = state.barriers.length - 1; j >= 0; j--) {
      const bar = state.barriers[j];

      if (bar.z < CONFIG.world.screenTopZ) continue;

      if (Math.abs(b.x - bar.x) < 0.8 && Math.abs(b.z - bar.z) < 0.7) {
        if (bar.negative) {
          // 负数屏障：每打一发 +1，打满上限就生效
          bar.value += 1;
          emit('barrierHit', { x: bar.x, z: bar.z, value: bar.value });

          if (bar.value >= bar.maxValue) {
            applySoldiers(bar.value);
            emit('barrierApply', { x: bar.x, z: bar.z, value: bar.value });
            state.barriers.splice(j, 1);
          }
        } else {
          // 普通 +1 屏障：一发就碎
          applySoldiers(1);
          emit('barrierApply', { x: bar.x, z: bar.z, value: 1 });
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
          state.score += 1;
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
      Math.abs(bar.x - state.player.x) < CONFIG.barrier.touchHalfWidth
    ) {
      applySoldiers(bar.value);
      emit('barrierApply', { x: bar.x, z: bar.z, value: bar.value });
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

  // 从左边界一直铺到中间，整排一起压下来
  for (let x = minX; x <= maxX + 0.01; x += step) {
    const negative = Math.random() < CONFIG.barrier.negativeChance;

    state.barriers.push({
      id: state.nextId++,
      x,
      z: CONFIG.world.spawnZ - Math.random() * 0.8,
      value: negative
        ? randInt(CONFIG.barrier.negativeMin, CONFIG.barrier.negativeMax)
        : 1,
      maxValue: negative
        ? randInt(CONFIG.barrier.capMin, CONFIG.barrier.capMax)
        : 1,
      negative,
      speed: CONFIG.barrier.speed,
    });
  }
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

    z.x = clamp(z.x, -CONFIG.world.halfWidth - 1, CONFIG.world.halfWidth + 1);
    z.z += z.speed * dt;
  }

  separateZombies();

  // 结算：碰到士兵扣 1，越过去扣 5
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];

    if (
      z.z >= CONFIG.world.touchZ &&
      Math.abs(z.x - state.player.x) < CONFIG.zombie.touchHalfWidth
    ) {
      state.zombies.splice(i, 1);
      damageArmy(CONFIG.zombie.touchLoss, 'touch');
      continue;
    }

    // 越过防线只是清理，不再扣兵
    if (z.z >= CONFIG.world.killZ) {
      state.zombies.splice(i, 1);
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

function spawnZombie() {
  const [minX, maxX] = CONFIG.world.rightZone;

  state.zombies.push({
    id: state.nextId++,
    x: minX + Math.random() * (maxX - minX),
    z: CONFIG.world.spawnZ - Math.random() * 4,
    hp: CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave,
    speed: Math.min(
      CONFIG.zombie.maxSpeed,
      CONFIG.zombie.baseSpeed + (state.wave - 1) * CONFIG.zombie.speedPerWave
    ),
    type: Math.floor(Math.random() * 3),
    aggro: false,
  });
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
