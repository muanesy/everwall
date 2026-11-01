/* ==========================================================
 * 界面层（乙负责）
 *
 * 职责：生成 HUD、开始页、结束页，并根据 state 更新显示。
 * 这里不碰 3D，也不改游戏数值。
 * ========================================================== */

import { initAudio, playClick, playRevive, toggleMute, isMuted } from './audio.js';

let els = null;
let actions = null;

const MAP_LIST = [
  { id: 'city', name: '废墟街道' },
  { id: 'jungle', name: '热带雨林' },
  { id: 'desert', name: '沙漠' },
  { id: 'moon', name: '月球' },
  { id: 'snow', name: '雪地' },
  { id: 'lava', name: '熔岩' },
];

const currentMap = new URLSearchParams(window.location.search).get('map') || 'city';

export function initUI(state, actionsRef) {
  actions = actionsRef;
  els = buildDom();
  bindEvents();
  updateUI(state);
}

export function updateUI(state) {
  if (!els) return;

  els.soldiersText.textContent = state.soldiers;
  els.waveText.textContent = state.wave;
  els.scoreText.textContent = state.score;

  // 血条按 50 个兵算满格，超出的部分不显示
  const pct = Math.min(100, (state.soldiers / 50) * 100);
  els.armyFill.style.width = `${pct}%`;
  els.armyFill.classList.toggle('is-low', state.soldiers <= 10);

  els.hud.classList.toggle('hidden', state.status !== 'playing');
  els.startScreen.classList.toggle('hidden', state.status !== 'menu');
  els.overScreen.classList.toggle('hidden', state.status !== 'over');

  if (state.status === 'over') {
    els.finalScore.textContent = state.score;
    els.finalWave.textContent = state.wave;
  }
}

/* ---------- 内部 ---------- */

function buildDom() {
  const hud = document.createElement('div');
  hud.className = 'hud hidden';
  hud.innerHTML = `
    <div class="army">
      <div class="army__head">
        <span class="army__label">士兵</span>
        <span class="army__value" data-soldiers>5</span>
      </div>
      <div class="army__bar"><div class="army__fill"></div></div>
    </div>
    <div class="wave">第 <span data-wave>1</span> 波</div>
    <div class="score" data-score>0</div>
  `;
  document.body.appendChild(hud);

  const startScreen = document.createElement('div');
  startScreen.className = 'overlay';
  startScreen.innerHTML = `
    <div class="card">
      <p class="eyebrow">广告里的游戏</p>
      <h1>向僵尸开炮</h1>
      <p class="sub">
        左右移动，自动开火。<br>
        打中左边压下来的 +1 屏障加兵，<br>
        挡住右边的僵尸潮。
      </p>
      <div class="map-picker">
        <p class="map-picker__label">地形</p>
        <div class="map-picker__grid">
          ${MAP_LIST.map((m) => `
            <button class="map-chip${m.id === currentMap ? ' is-active' : ''}" data-map="${m.id}">
              ${m.name}
            </button>
          `).join('')}
        </div>
      </div>
      <button class="btn" data-start>开始游戏</button>
      <p class="hint">键盘 ← → 或 A / D<br>手机上按住屏幕左右拖动</p>
    </div>
  `;
  document.body.appendChild(startScreen);

  const overScreen = document.createElement('div');
  overScreen.className = 'overlay hidden';
  overScreen.innerHTML = `
    <div class="card">
      <p class="eyebrow">士兵打光了</p>
      <h2>游戏结束</h2>
      <p class="score-line">
        得分 <strong data-final-score>0</strong> · 第 <strong data-final-wave>1</strong> 波
      </p>
      <button class="btn btn--ad" data-revive>看广告复活 +20 兵</button>
      <button class="btn btn--ghost" data-restart>重新开始</button>
    </div>
  `;
  document.body.appendChild(overScreen);

  // 静音开关：不影响游戏，只控制声音。现场演示嫌吵可以按一下。
  const soundBtn = document.createElement('button');
  soundBtn.className = 'sound-toggle';
  soundBtn.type = 'button';
  soundBtn.setAttribute('aria-label', '开关声音');
  soundBtn.textContent = '🔊';
  document.body.appendChild(soundBtn);

  return {
    hud,
    soldiersText: hud.querySelector('[data-soldiers]'),
    armyFill: hud.querySelector('.army__fill'),
    waveText: hud.querySelector('[data-wave]'),
    scoreText: hud.querySelector('[data-score]'),
    startScreen,
    overScreen,
    finalScore: overScreen.querySelector('[data-final-score]'),
    finalWave: overScreen.querySelector('[data-final-wave]'),
    soundBtn,
  };
}

function bindEvents() {
  els.startScreen.querySelector('[data-start]').addEventListener('click', () => {
    initAudio(); // 音频必须由用户点击触发，这里是最早的手势
    playClick();
    actions.start();
  });

  els.startScreen.querySelectorAll('[data-map]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.location.search = `?map=${btn.dataset.map}`;
    });
  });

  els.overScreen.querySelector('[data-revive]').addEventListener('click', () => {
    initAudio();
    playRevive();
    actions.revive();
  });

  els.overScreen.querySelector('[data-restart]').addEventListener('click', () => {
    initAudio();
    playClick();
    actions.restart();
  });

  els.soundBtn.addEventListener('click', () => {
    initAudio();
    const muted = toggleMute();
    els.soundBtn.textContent = muted ? '🔇' : '🔊';
    els.soundBtn.classList.toggle('is-muted', muted);
    if (!muted) playClick();
  });
}
