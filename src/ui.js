/* ==========================================================
 * 界面层（乙负责）
 *
 * 职责：生成 HUD、开始页、结束页，并根据 state 更新显示。
 * 这里不碰 3D，也不改游戏数值。
 * ========================================================== */

import { initAudio, playClick, playRevive, toggleMute, isMuted } from './audio.js';
// 兵种档位的数据在 visuals-tiers.js（数值只有这一份，别复制）
import { TIERS, getTier, tierProgress } from './visuals-tiers.js';
// 加载进度由画面层提供（models 在后台下载）
import { getModelLoadProgress } from './visuals.js';

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
  addFavicon();
  els = buildDom();
  bindEvents();
  updateUI(state);
}

/* 空 favicon：不给它，浏览器每次都会去请求 /favicon.ico 报 404，
 * 演示时控制台一片红字很碍眼。插一个空图标，一行解决。 */
function addFavicon() {
  if (document.querySelector('link[rel="icon"]')) return;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="%230b0f14"/><circle cx="8" cy="6.5" r="2.6" fill="%236dffb0"/><rect x="5" y="9.5" width="6" height="4" rx="1.6" fill="%236fc2ff"/></svg>';
  document.head.appendChild(link);
}

export function updateUI(state) {
  if (!els) return;

  els.soldiersText.textContent = state.soldiers;
  els.waveText.textContent = state.wave;
  els.scoreText.textContent = state.score;

  // 血条按 120 个兵算满格，和士兵显示上限一致
  const pct = Math.min(100, (state.soldiers / 120) * 100);
  els.armyFill.style.width = `${pct}%`;
  els.armyFill.classList.toggle('is-low', state.soldiers <= 10);

  updateTierBadge(state.soldiers);
  updateLoadingBox();

  els.hud.classList.toggle('hidden', state.status !== 'playing');
  els.startScreen.classList.toggle('hidden', state.status !== 'menu');
  els.overScreen.classList.toggle('hidden', state.status !== 'over');

  if (state.status === 'over') {
    els.finalScore.textContent = state.score;
    els.finalWave.textContent = state.wave;
  }
}

/* 兵种档位徽标：当前兵种 + 距下一阶还差几个兵。
 * 每帧都会调用，所以只在文字/颜色真的变了时才动 DOM。 */
let lastTierKey = '';

function updateTierBadge(count) {
  if (!els.tierBox) return;
  const tier = getTier(count);
  const prog = tierProgress(count);
  const nextName = prog.next ? (TIERS[prog.index + 1] || {}).name : '';
  const nextText = prog.next ? `再攒 ${prog.need} 兵升${nextName}` : '满级';

  const key = `${tier.name}|${nextText}`;
  if (key === lastTierKey) return;
  lastTierKey = key;

  els.tierName.textContent = tier.name;
  els.tierNext.textContent = nextText;
  els.tierBox.style.setProperty('--tier-color', tier.accent || '#8fb6e0');
  els.tierBox.classList.toggle('is-max', !prog.next);
}

/* 模型加载进度：画面层在后台下模型，这里把真实百分比显示出来。
 * 拿不到进度接口就退化成"加载中"，不至于卡住开始按钮。 */
let loadingDone = false;

function updateLoadingBox() {
  if (loadingDone || !els.loadingBox) return;

  let info = null;
  try {
    info = typeof getModelLoadProgress === 'function' ? getModelLoadProgress() : null;
  } catch (e) {
    info = null;
  }

  if (!info) {
    // 拿不到进度：超过 3 秒就当作加载完了，别让开始页一直挂着进度条
    if (performance.now() > 3000) {
      loadingDone = true;
      els.loadingBox.classList.add('is-done');
    }
    return;
  }

  const pct = Math.round(Math.min(1, Math.max(0, info.progress)) * 100);
  els.loadingFill.style.width = `${pct}%`;
  els.loadingText.textContent = info.failed
    ? '模型加载失败，已用简化角色'
    : `正在加载角色模型… ${pct}%`;

  if (info.done || info.failed || pct >= 100) {
    loadingDone = true;
    els.loadingBox.classList.add('is-done');
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
      <div class="tier" data-tier>
        <span class="tier__name" data-tier-name>保安</span>
        <span class="tier__next" data-tier-next>再攒 15 兵升正规军</span>
      </div>
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
      <div class="loading" data-loading>
        <div class="loading__bar"><div class="loading__fill" data-loading-fill></div></div>
        <p class="loading__text" data-loading-text>正在加载角色模型…</p>
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
    tierBox: hud.querySelector('[data-tier]'),
    tierName: hud.querySelector('[data-tier-name]'),
    tierNext: hud.querySelector('[data-tier-next]'),
    waveText: hud.querySelector('[data-wave]'),
    scoreText: hud.querySelector('[data-score]'),
    startScreen,
    overScreen,
    finalScore: overScreen.querySelector('[data-final-score]'),
    finalWave: overScreen.querySelector('[data-final-wave]'),
    soundBtn,
    loadingBox: startScreen.querySelector('[data-loading]'),
    loadingFill: startScreen.querySelector('[data-loading-fill]'),
    loadingText: startScreen.querySelector('[data-loading-text]'),
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
