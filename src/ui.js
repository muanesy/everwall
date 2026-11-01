/* ==========================================================
 * 界面层（乙负责）
 *
 * 职责：生成 HUD、开始页、结束页，并根据 state 更新显示。
 * 这里不碰 3D，也不改游戏数值。
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

  els.soldiersText.textContent = state.soldiers;
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
    <div class="army">
      <div class="army__label">士兵</div>
      <div class="army__value" data-soldiers>5</div>
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

  return {
    hud,
    soldiersText: hud.querySelector('[data-soldiers]'),
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
