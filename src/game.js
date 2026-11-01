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
    killZ: 8.4,        // 僵尸越过这条线就让士兵减员
    leftZone: [-7.6, -0.6],  // +1 屏障出现的横向范围
    rightZone: [0.6, 7.6],   // 僵尸出现的横向范围
  },
  player: {
    speed: 14,
    baseFireInterval: 0.5, // 1 个士兵时的射击间隔
    minFireInterval: 0.14, // 射击间隔的下限，防止子弹太多
    bulletSpeed: 28,
    bulletDamage: 10,
  },
  barrier: {
    hp: 30,
    speed: 2.2,
    spawnInterval: 1.9,
    rowSizeMin: 2,
    rowSizeMax: 3,
    soldierPerHit: 1,
  },
  zombie: {
    baseHp: 20,
    hpPerWave: 8,
    baseSpeed: 2.2,
    speedPerWave: 0.3,
    maxSpeed: 7,
    spawnInterval: 0.55,
    minSpawnInterval: 0.18,
    intervalPerWave: 0.05,
    soldierLoss: 1,
    maxAlive: 90,
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

const events = new EventTarget();

const input = {
  left: false,
  right: false,
  pointerActive: false,
  pointerRatio: 0,
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
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

  // 人越多，一次打出的弹道越宽，能覆盖更多僵尸
  const count = Math.min(4, 1 + Math.floor(state.soldiers / 10));
  const spread = Math.min(2.6, 0.8 + state.soldiers * 0.1);

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = clamp(state.player.x + (t - 0.5) * spread, -8.5, 8.5);

    state.bullets.push({
      id: state.nextId++,
      x,
      z: state.player.z - 0.9,
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

      if (Math.abs(b.x - bar.x) < 0.95 && Math.abs(b.z - bar.z) < 0.7) {
        bar.hp -= b.damage;
        state.soldiers += CONFIG.barrier.soldierPerHit;
        emit('barrierHit', { x: bar.x, z: bar.z });

        if (bar.hp <= 0) {
          state.barriers.splice(j, 1);
          emit('barrierBreak', { x: bar.x, z: bar.z });
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

      if (Math.abs(b.x - z.x) < 0.55 && Math.abs(b.z - z.z) < 0.7) {
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

    if (bar.z >= CONFIG.world.killZ) {
      state.barriers.splice(i, 1);
    }
  }
}

function spawnBarrierRow() {
  const [minX, maxX] = CONFIG.world.leftZone;
  const min = CONFIG.barrier.rowSizeMin;
  const max = CONFIG.barrier.rowSizeMax;
  const count = min + Math.floor(Math.random() * (max - min + 1));

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = minX + t * (maxX - minX);

    state.barriers.push({
      id: state.nextId++,
      x,
      z: CONFIG.world.spawnZ - i * 1.2,
      hp: CONFIG.barrier.hp,
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

  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];
    z.z += z.speed * dt;

    if (z.z >= CONFIG.world.killZ) {
      state.zombies.splice(i, 1);
      damageArmy(CONFIG.zombie.soldierLoss);
    }
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
  });
}

function damageArmy(amount) {
  if (state.status !== 'playing') return;

  state.soldiers -= amount;
  emit('armyHurt', { soldiers: state.soldiers });

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
