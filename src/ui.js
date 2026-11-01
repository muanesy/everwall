/* ==========================================================
 * 界面层（乙负责）
 *
 * 职责：生成 HUD、开始页、结束页，并根据 state 更新显示。
 * 这里不碰 3D，也不改游戏数值。
 * 需要加新界面（比如波次提示、暂停页），就在这里加 DOM。
 * ========================================================== */

let els = null;
let actions = null;

export function initUI(state, actionsRef) {
  actions = actionsRef;
  els = buildDom();
  bindEvents();
  updateUI(state);
}

export function updateUI(state) {
  if (!els) return;

  els.hpText.textContent = Math.max(0, Math.ceil(state.player.hp));
  els.hpFill.style.width = `${Math.max(0, (state.player.hp / state.player.maxHp) * 100)}%`;
  els.waveText.textContent = state.wave;
  els.scoreText.textContent = state.score;

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
    <div class="hp">
      <div class="hp__label">生命 <span data-hp>100</span></div>
      <div class="hp__bar"><div class="hp__fill"></div></div>
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
      <p class="sub">左右移动，自动开火。活到最后一波。</p>
      <button class="btn" data-start>开始游戏</button>
      <p class="hint">键盘 ← → 或 A / D<br>手机上按住屏幕左右拖动</p>
    </div>
  `;
  document.body.appendChild(startScreen);

  const overScreen = document.createElement('div');
  overScreen.className = 'overlay hidden';
  overScreen.innerHTML = `
    <div class="card">
      <p class="eyebrow">你被啃了</p>
      <h2>游戏结束</h2>
      <p class="score-line">
        得分 <strong data-final-score>0</strong> · 第 <strong data-final-wave>1</strong> 波
      </p>
      <button class="btn btn--ad" data-revive>看广告复活</button>
      <button class="btn btn--ghost" data-restart>重新开始</button>
    </div>
  `;
  document.body.appendChild(overScreen);

  return {
    hud,
    hpText: hud.querySelector('[data-hp]'),
    hpFill: hud.querySelector('.hp__fill'),
    waveText: hud.querySelector('[data-wave]'),
    scoreText: hud.querySelector('[data-score]'),
    startScreen,
    overScreen,
    finalScore: overScreen.querySelector('[data-final-score]'),
    finalWave: overScreen.querySelector('[data-final-wave]'),
  };
}

function bindEvents() {
  els.startScreen.querySelector('[data-start]').addEventListener('click', () => actions.start());
  els.overScreen.querySelector('[data-revive]').addEventListener('click', () => actions.revive());
  els.overScreen.querySelector('[data-restart]').addEventListener('click', () => actions.restart());
}
