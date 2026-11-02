/* ==========================================================
 * 界面层（乙负责）
 *
 * 职责：生成 HUD、开始页、结束页，并根据 state 更新显示。
 * 这里不碰 3D，也不改游戏数值。
 * ========================================================== */

import { initAudio, playClick, playRevive, toggleMute, isMuted, loadMuteState } from './audio.js';
// 兵种档位的数据在 visuals-tiers.js（数值只有这一份，别复制）
import { TIERS, getTier, tierProgress } from './visuals-tiers.js';
import { getWaveElapsed } from './visuals.js';
// 加载进度由画面层提供（models 在后台下载）
import { getModelLoadProgress } from './visuals.js';
// 技能与槽位图标：内联 SVG，零图片资源（见 ui-skillicons.js）
import { skillIconTag, slotIconTag } from './ui-skillicons.js';

let els = null;
let actions = null;
let currentState = null;

/* 地图列表：按时代分组排，同时代的连在一起。
 * 26 张（原 9 + 新 17）塞进 3 列网格会撑爆开始页，
 * 所以网格加了固定高度 + 纵向滚动，并在标签上写明总数。
 * 时代归属和 visuals-era.js 的 ERAS[].maps 保持一致。 */
const MAP_GROUPS = [
  { era: '中世纪', ids: ['jungle', 'castle', 'village', 'abbey', 'swamp'] },
  { era: '二战', ids: ['city', 'base', 'trench', 'beach', 'warport'] },
  { era: '现代', ids: ['desert', 'harbor', 'highway', 'parking'] },
  { era: '后现代', ids: ['snow', 'lab', 'quarantine', 'biofactory'] },
  { era: '星际', ids: ['moon', 'station', 'alienwaste', 'orbitalpad'] },
  { era: '终幕', ids: ['lava', 'voidtemple', 'timeruins', 'blackhole'] },
];

const MAP_NAMES_ALL = {
  city: '废墟街道', jungle: '热带雨林', desert: '沙漠', moon: '月球',
  snow: '雪地', lava: '熔岩', base: '军事基地', lab: '废弃医院', harbor: '港口码头',
  castle: '城堡攻城', village: '中世纪村庄', abbey: '修道院', swamp: '沼泽',
  trench: '战壕', beach: '登陆海滩', warport: '军港',
  highway: '城市高架', parking: '地下停车场',
  quarantine: '隔离区', biofactory: '生化工厂',
  station: '空间站内部', alienwaste: '外星荒漠', orbitalpad: '轨道平台',
  voidtemple: '虚空神殿', timeruins: '时间废墟', blackhole: '黑洞边缘',
};

const MAP_LIST = MAP_GROUPS.flatMap((g) =>
  g.ids.map((id) => ({ id, name: MAP_NAMES_ALL[id] || id, era: g.era }))
);

const currentMap = new URLSearchParams(window.location.search).get('map') || 'city';
const MAP_NAMES = MAP_NAMES_ALL;

/* 一波多少秒：和 game.js 的 CONFIG.wave.duration 保持一致（甲改了这个值要同步这里） */
const WAVE_SECONDS = 15;

/* 历史最好成绩：按地图分开记，存在本地。
 * 演示时能看到"这张图我打过多好"，也让结束页不只是三个数字。 */
const BEST_KEY = 'douyin-zombie-best-v1';

function readBests() {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeBest(mapId, score, wave) {
  try {
    const all = readBests();
    const cur = all[mapId] || { score: 0, wave: 0 };
    const next = {
      score: Math.max(cur.score || 0, score || 0),
      wave: Math.max(cur.wave || 0, wave || 0),
    };
    all[mapId] = next;
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
    return next;
  } catch (e) {
    return { score: score || 0, wave: wave || 0 };
  }
}

export function initUI(state, actionsRef) {
  actions = actionsRef;
  addFavicon();
  loadMuteState(); // 读上次的静音状态
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
  currentState = state;

  els.soldiersText.textContent = state.soldiers;
  els.waveText.textContent = state.wave;
  els.scoreText.textContent = state.score;

  // 血条按 120 个兵算满格，和士兵显示上限一致
  const pct = Math.min(100, (state.soldiers / 120) * 100);
  els.armyFill.style.width = `${pct}%`;
  els.armyFill.classList.toggle('is-low', state.soldiers <= 10);

  updateTierBadge(state.soldiers);
  updateLoadingBox();
  updateWaveCountdown(state);
  updateCards(state);
  updateTestPanel(state);
  updateSkillRail(state);

  els.hud.classList.toggle('hidden', state.status !== 'playing');
  els.startScreen.classList.toggle('hidden', state.status !== 'menu');
  els.overScreen.classList.toggle('hidden', state.status !== 'over');

  if (state.status === 'over') {
    els.finalScore.textContent = state.score;
    els.finalWave.textContent = state.wave;
    els.finalMap.textContent = MAP_NAMES[currentMap] || '废墟街道';

    // 刷新历史最佳（本局成绩只涨不跌）
    const best = writeBest(currentMap, state.score, state.wave);
    els.bestScore.textContent = best.score;
    els.bestWave.textContent = best.wave;
  }
}

/* 下一波倒计时：一波 15 秒（甲的 CONFIG.wave.duration，改了这里要同步）
 * 只做提示，不影响任何玩法。 */
function updateWaveCountdown(state) {
  if (!els.waveNext) return;
  if (state.status !== 'playing') {
    els.waveNext.textContent = '';
    return;
  }
  const left = Math.max(0, Math.ceil(WAVE_SECONDS - getWaveElapsed()));
  els.waveNext.textContent = left + 's';
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

/* 抽卡：慢放时底部弹出三张，倒计时结束自动选 */
function updateCards(state) {
  if (!els.cardLayer) return;

  const show = state.status === 'playing' && state.card && state.card.active;
  els.cardLayer.classList.toggle('hidden', !show);
  if (!show) return;

  els.cardTimer.textContent = `${Math.max(0, Math.ceil(state.card.timeLeft))}s`;

  if (els.cardVersion !== state.card.version) {
    els.cardVersion = state.card.version;
    renderCards(state.card.choices);
  }
}

function renderCards(choices) {
  els.cardRow.innerHTML = choices.map((c, i) => `
    <button class="card-choice" data-card-index="${i}">
      <em>${i + 1}</em>
      <strong>${c.name}</strong>
      <span>${c.desc}</span>
    </button>
  `).join('');

  els.cardRow.querySelectorAll('[data-card-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (actions && actions.chooseCard) actions.chooseCard(Number(btn.dataset.cardIndex));
    });
  });
}

/* ---------- 测试模式面板 ---------- */

function slotLevelOf(state, id) {
  if (id === 'barricade') {
    return state.barricade.unlocked ? state.barricade.level : 0;
  }
  return state.slotLevels[id] || 0;
}

function updateTestPanel(state) {
  if (!els.testPanel) return;

  const show = state.status === 'playing' && state.testMode;
  els.testPanel.classList.toggle('hidden', !show);
  if (!show) return;

  const eraName = els.testEraNames[state.era] || '';
  if (els.testEraName.textContent !== eraName) {
    els.testEraName.textContent = eraName;
  }

  els.testEraBtns.forEach((btn, i) => {
    btn.classList.toggle('is-active', i === state.era);
  });

  const info = actions && actions.getSlotInfo ? actions.getSlotInfo() : [];
  for (const row of info) {
    const refs = els.testSlotRefs[row.id];
    if (!refs) continue;

    const levelText = row.level > 0 ? `Lv${row.level}` : '未解锁';
    if (refs.level.textContent !== levelText) refs.level.textContent = levelText;
    if (refs.desc.textContent !== row.desc) refs.desc.textContent = row.desc;

    refs.plus.disabled = row.level >= row.max;
    refs.minus.disabled = row.level <= 0;
  }
}

/* ---------- 左侧技能栏 ---------- */

function updateSkillRail(state) {
  if (!els.skillRail) return;

  const show =
    state.status === 'playing' &&
    !state.testMode &&
    state.skillBag &&
    state.skillBag.length > 0;

  els.skillRail.classList.toggle('hidden', !show);
  if (!show) return;

  if (els.skillVersion !== state.skillBagVersion) {
    els.skillVersion = state.skillBagVersion;
    const bag = actions && actions.getSkillBag ? actions.getSkillBag() : [];

    els.skillRail.innerHTML = bag.map((s, i) => {
      const color = '#' + (s.color >>> 0).toString(16).padStart(6, '0');
      return `
        <button class="skill-slot" type="button" data-skill-id="${s.id}" style="--skill-color:${color}">
          <span class="skill-slot__key">${i + 1}</span>
          <span class="skill-slot__icon">${skillIconTag(s.id, { size: 26 })}</span>
          <span class="skill-slot__name">${s.name}</span>
          <span class="skill-slot__charges">×${s.charges}</span>
        </button>
      `;
    }).join('');

    els.skillRail.querySelectorAll('[data-skill-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        initAudio();
        if (actions && actions.useSkill) actions.useSkill(btn.dataset.skillId);
      });
    });
  }

  const cooling = state.skillUseCd > 0;
  els.skillRail.querySelectorAll('.skill-slot').forEach((btn) => {
    btn.disabled = cooling;
  });
}

/* ---------- 内部 ---------- */

function buildDom() {
  const testData = actions && actions.getTestData
    ? actions.getTestData()
    : { eras: [], slots: [], skills: [] };

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
    <div class="wave">
      第 <span data-wave>1</span> 波
      <em class="wave__next" data-wave-next>15s</em>
    </div>
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
        <p class="map-picker__label">地形 <span class="map-picker__count">${MAP_LIST.length}</span></p>
        <div class="map-picker__grid">
          ${MAP_GROUPS.map((grp) => `
            <p class="map-picker__era">${grp.era}</p>
            ${grp.ids.map((id) => `
              <button class="map-chip${id === currentMap ? ' is-active' : ''}" data-map="${id}">
                ${MAP_NAMES_ALL[id] || id}
              </button>
            `).join('')}
          `).join('')}
        </div>
      </div>
      <button class="test-toggle" type="button" data-test-toggle>
        <span class="test-toggle__dot"></span>
        <span data-test-toggle-label>测试模式：关</span>
      </button>
      <div class="loading" data-loading>
        <div class="loading__bar"><div class="loading__fill" data-loading-fill></div></div>
        <p class="loading__text" data-loading-text>正在加载角色模型…</p>
      </div>
      <p class="best-line" data-start-best></p>
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
      <p class="best-line">
        <span data-final-map>废墟街道</span> ·
        最佳 <strong data-best-score>0</strong> 分 / 第 <strong data-best-wave>1</strong> 波
      </p>
      <button class="btn btn--ad" data-revive>看广告复活 +20 兵</button>
      <button class="btn btn--ghost" data-restart>重新开始</button>
    </div>
  `;
  document.body.appendChild(overScreen);

  // 抽卡层：慢放时从底部滑出，不暂停游戏
  const cardLayer = document.createElement('div');
  cardLayer.className = 'card-layer hidden';
  cardLayer.innerHTML = `
    <div class="card-panel">
      <div class="card-layer__head">
        <span>选择一张强化</span>
        <span class="card-layer__timer" data-card-timer>6s</span>
      </div>
      <div class="card-layer__row" data-card-row></div>
    </div>
  `;
  document.body.appendChild(cardLayer);

  // 左侧技能栏：抽到一次性技能卡后存次数，点图标或按数字键使用
  const skillRail = document.createElement('aside');
  skillRail.className = 'skill-rail hidden';
  document.body.appendChild(skillRail);

  // 测试模式面板：只在主界面打开测试开关、进游戏后出现
  const testPanel = document.createElement('aside');
  testPanel.className = 'test-panel hidden';

  const eraButtons = testData.eras.map((name, i) => `
    <button class="test-chip" type="button" data-test-era-btn="${i}">${name}</button>
  `).join('');

  const slotRows = testData.slots.map((s) => `
    <div class="test-slot">
      <div class="test-slot__top">
        <span class="test-slot__icon">${slotIconTag(s.id, { size: 18 })}</span>
        <span class="test-slot__name">${s.name}</span>
        <span class="test-slot__level" data-test-level="${s.id}">Lv0</span>
        <button class="test-step" type="button" data-test-minus="${s.id}" aria-label="${s.name} 降一级">−</button>
        <button class="test-step" type="button" data-test-plus="${s.id}" aria-label="${s.name} 升一级">+</button>
      </div>
      <p class="test-slot__desc" data-test-desc="${s.id}">未解锁</p>
    </div>
  `).join('');

  const skillGroups = testData.eras.map((name, era) => {
    const list = testData.skills.filter((s) => s.era === era);
    if (!list.length) return '';
    return `
      <p class="test-skill-era">${name}</p>
      <div class="test-skill-grid">
        ${list.map((s) => `<button class="test-skill" type="button" data-test-skill="${s.id}"><span class="test-skill__icon">${skillIconTag(s.id, { size: 15 })}</span>${s.name}</button>`).join('')}
      </div>
    `;
  }).join('');

  testPanel.innerHTML = `
    <div class="test-panel__head">
      <strong>测试模式</strong>
      <span data-test-era-name></span>
    </div>
    <div class="test-panel__section">
      <p class="test-panel__label">时代</p>
      <div class="test-era-grid" data-test-eras>${eraButtons}</div>
    </div>
    <div class="test-panel__section">
      <p class="test-panel__label">槽位</p>
      <div class="test-slots" data-test-slots>${slotRows}</div>
    </div>
    <div class="test-panel__section">
      <p class="test-panel__label">一次性技能</p>
      <div data-test-skills>${skillGroups}</div>
    </div>
    <div class="test-panel__section test-panel__actions">
      <button type="button" data-test-spawn>刷 20 只僵尸</button>
      <button type="button" data-test-clear>清空僵尸</button>
    </div>
  `;
  document.body.appendChild(testPanel);

  // 静音开关：不影响游戏，只控制声音。现场演示嫌吵可以按一下。
  const soundBtn = document.createElement('button');
  soundBtn.className = 'sound-toggle';
  soundBtn.type = 'button';
  soundBtn.setAttribute('aria-label', '开关声音');
  const muted = isMuted();
  soundBtn.textContent = muted ? '🔇' : '🔊';
  if (muted) soundBtn.classList.add('is-muted');
  document.body.appendChild(soundBtn);

  // 开始页也显示这张图的历史最佳，给玩家一个目标
  // 注意：buildDom 执行时 els 还没赋值，这里只能用局部变量
  const startBest = startScreen.querySelector('[data-start-best]');
  if (startBest) {
    const best = readBests()[currentMap];
    startBest.textContent = best && best.score
      ? `本图最佳 ${best.score} 分 · 第 ${best.wave} 波`
      : '这张图还没有记录，来打个第一';
  }

  return {
    hud,
    soldiersText: hud.querySelector('[data-soldiers]'),
    armyFill: hud.querySelector('.army__fill'),
    tierBox: hud.querySelector('[data-tier]'),
    tierName: hud.querySelector('[data-tier-name]'),
    tierNext: hud.querySelector('[data-tier-next]'),
    waveText: hud.querySelector('[data-wave]'),
    waveNext: hud.querySelector('[data-wave-next]'),
    scoreText: hud.querySelector('[data-score]'),
    startScreen,
    overScreen,
    finalScore: overScreen.querySelector('[data-final-score]'),
    finalWave: overScreen.querySelector('[data-final-wave]'),
    finalMap: overScreen.querySelector('[data-final-map]'),
    bestScore: overScreen.querySelector('[data-best-score]'),
    bestWave: overScreen.querySelector('[data-best-wave]'),
    soundBtn,
    loadingBox: startScreen.querySelector('[data-loading]'),
    loadingFill: startScreen.querySelector('[data-loading-fill]'),
    loadingText: startScreen.querySelector('[data-loading-text]'),
    startBest,
    cardLayer,
    cardTimer: cardLayer.querySelector('[data-card-timer]'),
    cardRow: cardLayer.querySelector('[data-card-row]'),
    cardVersion: -1,
    skillRail,
    skillVersion: -1,
    testToggle: startScreen.querySelector('[data-test-toggle]'),
    testToggleLabel: startScreen.querySelector('[data-test-toggle-label]'),
    testStartBtn: startScreen.querySelector('[data-start]'),
    testPanel,
    testEraName: testPanel.querySelector('[data-test-era-name]'),
    testEraNames: testData.eras,
    testEraBtns: [...testPanel.querySelectorAll('[data-test-era-btn]')],
    testSlotRefs: Object.fromEntries(
      testData.slots.map((s) => [s.id, {
        level: testPanel.querySelector(`[data-test-level="${s.id}"]`),
        desc: testPanel.querySelector(`[data-test-desc="${s.id}"]`),
        plus: testPanel.querySelector(`[data-test-plus="${s.id}"]`),
        minus: testPanel.querySelector(`[data-test-minus="${s.id}"]`),
      }])
    ),
  };
}

function bindEvents() {
  // 测试模式开关：打开后开始按钮变成「开始测试」，进游戏出现左侧面板
  let testModeEnabled =
    new URLSearchParams(window.location.search).get('test') === '1';

  const applyTestToggle = () => {
    els.testToggle.classList.toggle('is-active', testModeEnabled);
    els.testToggleLabel.textContent = testModeEnabled ? '测试模式：开' : '测试模式：关';
    els.testStartBtn.textContent = testModeEnabled ? '开始测试' : '开始游戏';
  };
  applyTestToggle();

  els.testToggle.addEventListener('click', () => {
    testModeEnabled = !testModeEnabled;
    applyTestToggle();
  });

  els.testStartBtn.addEventListener('click', () => {
    initAudio(); // 音频必须由用户点击触发，这里是最早的手势
    playClick();
    actions.start({ testMode: testModeEnabled });
  });

  els.startScreen.querySelectorAll('[data-map]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.location.search = `?map=${btn.dataset.map}`;
    });
  });

  // 测试面板：切时代、升级槽位、放技能、刷/清僵尸
  els.testEraBtns.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (actions && actions.setEra) actions.setEra(i);
    });
  });

  els.testPanel.querySelectorAll('[data-test-plus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.testPlus;
      const lv = currentState ? slotLevelOf(currentState, id) : 0;
      if (actions && actions.setSlotLevel) actions.setSlotLevel(id, Math.min(5, lv + 1));
    });
  });

  els.testPanel.querySelectorAll('[data-test-minus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.testMinus;
      const lv = currentState ? slotLevelOf(currentState, id) : 1;
      if (actions && actions.setSlotLevel) actions.setSlotLevel(id, Math.max(0, lv - 1));
    });
  });

  els.testPanel.querySelectorAll('[data-test-skill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      initAudio();
      if (actions && actions.castSkill) actions.castSkill(btn.dataset.testSkill);
    });
  });

  const spawnBtn = els.testPanel.querySelector('[data-test-spawn]');
  if (spawnBtn) {
    spawnBtn.addEventListener('click', () => {
      if (actions && actions.spawnTestZombies) actions.spawnTestZombies(20);
    });
  }

  const clearBtn = els.testPanel.querySelector('[data-test-clear]');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (actions && actions.clearZombies) actions.clearZombies();
    });
  }

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

  // 技能栏数字键 1-4
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    const n = Number(e.key);
    if (n < 1 || n > 4) return;
    if (!currentState || !currentState.skillBag) return;

    const entry = currentState.skillBag[n - 1];
    if (!entry) return;

    e.preventDefault();
    if (actions && actions.useSkill) actions.useSkill(entry.id);
  });
}
