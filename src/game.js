/* ==========================================================
 * 玩法逻辑（甲负责）
 *
 * 职责：维护 state、处理输入、生成僵尸和子弹、判断碰撞、
 *      按波次提高难度、发事件给画面层。
 *
 * 这里不做任何画面渲染。想让特效出现，就 emit 一个事件，
 * 画面层（visuals.js）会接住。
 * ========================================================== */

import { initVisuals, syncScene } from './visuals.js';
import { initUI, updateUI } from './ui.js';

/* ----------------------------------------------------------
 * 数值区：调难度和手感只改这里
 * ---------------------------------------------------------- */
const CONFIG = {
  world: {
    halfWidth: 8,     // 玩家左右活动半宽（世界单位）
    playerZ: 9,       // 玩家所在的纵深位置
    spawnZ: -13,      // 僵尸出生的位置
    killZ: 8.4,       // 僵尸越过这条线就伤害玩家
  },
  player: {
    speed: 14,        // 移动速度
    maxHp: 100,
    fireInterval: 0.16, // 每 0.16 秒自动开一枪
    bulletSpeed: 28,
    bulletDamage: 10,
  },
  zombie: {
    baseSpeed: 2.0,
    speedPerWave: 0.22, // 每波变快多少
    maxSpeed: 5.5,
    baseHp: 20,
    hpPerWave: 6,       // 每波多多少血
    damage: 12,         // 碰到玩家掉多少血
  },
  wave: {
    duration: 20,           // 每 20 秒进下一波
    baseSpawnInterval: 1.1, // 初始刷新间隔
    intervalPerWave: 0.07,  // 每波缩短多少
    minSpawnInterval: 0.32,
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
  player: {
    x: 0,
    z: CONFIG.world.playerZ,
    hp: CONFIG.player.maxHp,
    maxHp: CONFIG.player.maxHp,
  },
  zombies: [], // { id, x, z, hp, speed, type }
  bullets: [], // { id, x, z, vz, damage }
  spawnTimer: 0,
  fireTimer: 0,
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
  state.player.x = 0;
  state.player.hp = state.player.maxHp;
  state.zombies.length = 0;
  state.bullets.length = 0;
  state.spawnTimer = 0.4;
  state.fireTimer = 0;
  state.nextId = 1;
}

function startGame() {
  resetState();
}

function revive() {
  if (state.status !== 'over') return;
  state.status = 'playing';
  state.player.hp = Math.round(state.player.maxHp * 0.5);
  state.zombies.length = 0;
  state.bullets.length = 0;
  state.spawnTimer = 0.8;
  state.fireTimer = 0;
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
  updateZombies(dt);
}

function updatePlayer(dt) {
  let dir = 0;
  if (input.left) dir -= 1;
  if (input.right) dir += 1;

  // 手机上按住屏幕：朝手指位置移动
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

  state.fireTimer = CONFIG.player.fireInterval;

  state.bullets.push({
    id: state.nextId++,
    x: state.player.x,
    z: state.player.z - 0.9,
    vz: -CONFIG.player.bulletSpeed,
    damage: CONFIG.player.bulletDamage,
  });

  emit('shoot', { x: state.player.x, z: state.player.z });
}

function updateBullets(dt) {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.z += b.vz * dt;

    if (b.z < -16) {
      state.bullets.splice(i, 1);
      continue;
    }

    for (let j = state.zombies.length - 1; j >= 0; j--) {
      const z = state.zombies[j];

      if (Math.abs(b.x - z.x) < 0.55 && Math.abs(b.z - z.z) < 0.8) {
        z.hp -= b.damage;
        state.bullets.splice(i, 1);
        emit('hit', { x: z.x, z: z.z });

        if (z.hp <= 0) {
          state.zombies.splice(j, 1);
          state.score += 10;
          emit('zombieDie', { x: z.x, z: z.z, type: z.type });
        }
        break;
      }
    }
  }
}

function updateZombies(dt) {
  state.spawnTimer -= dt;

  if (state.spawnTimer <= 0) {
    spawnZombie();
    state.spawnTimer = Math.max(
      CONFIG.wave.minSpawnInterval,
      CONFIG.wave.baseSpawnInterval - (state.wave - 1) * CONFIG.wave.intervalPerWave
    );
  }

  for (let i = state.zombies.length - 1; i >= 0; i--) {
    const z = state.zombies[i];
    z.z += z.speed * dt;

    if (z.z >= CONFIG.world.killZ) {
      state.zombies.splice(i, 1);
      damagePlayer(CONFIG.zombie.damage);
    }
  }
}

function spawnZombie() {
  const type = Math.floor(Math.random() * 3);

  state.zombies.push({
    id: state.nextId++,
    x: (Math.random() * 2 - 1) * (CONFIG.world.halfWidth - 0.6),
    z: CONFIG.world.spawnZ,
    hp: CONFIG.zombie.baseHp + (state.wave - 1) * CONFIG.zombie.hpPerWave,
    speed: Math.min(
      CONFIG.zombie.maxSpeed,
      CONFIG.zombie.baseSpeed + (state.wave - 1) * CONFIG.zombie.speedPerWave
    ),
    type,
  });
}

function damagePlayer(amount) {
  if (state.status !== 'playing') return;

  state.player.hp -= amount;
  emit('playerHurt', { hp: state.player.hp });

  if (state.player.hp <= 0) {
    state.player.hp = 0;
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
