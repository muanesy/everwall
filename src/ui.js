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
// 手机默认收起测试面板，留一个「测试」小按钮，避免整块面板挡住战场
let testPanelCollapsed =
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 600px)").matches;
// 测试面板里天气事件默认用暴雨，点天气类型可以换
let testWeatherKind = 'rain';

/* 地图列表：按时代分组排，同时代的连在一起。
 * 26 张（原 9 + 新 17）塞进 3 列网格会撑爆开始页，
 * 所以网格加了固定高度 + 纵向滚动，并在标签上写明总数。
 * 时代归属和 visuals-era.js 的 ERAS[].maps 保持一致。 */
const MAP_GROUPS = [
  { era: '中世纪', ids: ['castle', 'village', 'abbey', 'swamp'] },
  { era: '二战', ids: ['city', 'base', 'trench', 'beach', 'warport'] },
  { era: '现代', ids: ['desert', 'harbor', 'highway', 'parking'] },
  { era: '后现代', ids: ['snow', 'lab', 'quarantine', 'biofactory', 'jungle'] },
  { era: '星际', ids: ['moon', 'station', 'alienwaste', 'orbitalpad'] },
  { era: '终幕', ids: ['lava', 'voidtemple', 'timeruins', 'blackhole'] },
];

const MAP_NAMES_ALL = {
  city: '废墟街道', jungle: '感染丛林', desert: '沙漠', moon: '月球',
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

const START_PARAMS = new URLSearchParams(window.location.search);

function eraIndexOfMap(mapId) {
  return MAP_GROUPS.findIndex((g) => g.ids.includes(mapId));
}

// 起始时代和地图必须成对出现：
// 显式 ?era 优先；只有 ?map 时按地图所属时代走；都没有就默认中世纪。
const startEra = (() => {
  const raw = START_PARAMS.get('era');
  if (raw !== null && Number.isFinite(Number(raw))) {
    return Math.max(0, Math.min(MAP_GROUPS.length - 1, Math.floor(Number(raw))));
  }
  const byMap = eraIndexOfMap(START_PARAMS.get('map') || '');
  return byMap >= 0 ? byMap : 0;
})();

// 地图不属于该时代就退回该时代第一张，避免「星际数值配中世纪场景」
const currentMap = (() => {
  const raw = START_PARAMS.get('map');
  return raw && MAP_GROUPS[startEra].ids.includes(raw)
    ? raw
    : MAP_GROUPS[startEra].ids[0];
})();
const MAP_NAMES = MAP_NAMES_ALL;

/* 一波多少秒：兜底值。实际读 state.waveDuration（game.js 统一给），
 * 这样改波次长度不会出现 UI 倒计时和真实刷怪对不上 */
const WAVE_SECONDS = 12;

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
  updateCommandChip(state);
  updateBloodChip(state);
  updateLoadingBox();
  updateWaveCountdown(state);
  updateUpgradePanel(state);
  updateTestPanel(state);
  updateSkillRail(state);

  els.hud.classList.toggle('hidden', state.status !== 'playing');
  els.startScreen.classList.toggle('hidden', state.status !== 'menu');
  els.overScreen.classList.toggle('hidden', state.status !== 'over');
  els.pauseOverlay.classList.toggle(
    'hidden',
    !(state.status === 'playing' && state.paused)
  );

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

/* 下一波倒计时：长度取 state.waveDuration（game.js 的 CONFIG.wave.duration）
 * 只做提示，不影响任何玩法。 */
function updateWaveCountdown(state) {
  if (!els.waveNext) return;
  if (state.status !== 'playing') {
    els.waveNext.textContent = '';
    return;
  }
  const waveSeconds = state.waveDuration || WAVE_SECONDS;
  const left = Math.max(0, Math.ceil(waveSeconds - getWaveElapsed()));
  els.waveNext.textContent = left + 's';
}

/* 指挥槽集火加成：六个时代各一枚小图标，旁边跟一个实时百分比。
 * 只在指挥槽建起来（markBonus > 0）之后出现，平时不占 HUD 空间。 */
const CMD_ICONS = [
  // 中世纪：战鼓 + 旗
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.5" y="9.5" width="12" height="9" rx="2"/><path d="M3.5 12.6h12M3.5 15.4h12"/><path d="M18.5 4v9"/><path d="M18.5 4.4l3 1.5-3 1.5"/></svg>',
  // 二战：电台箱 + 天线
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="4" y="10" width="12" height="8" rx="1.5"/><path d="M16 12.5h3v5h-3"/><path d="M12.5 4l3.5 6"/><circle cx="7.5" cy="13.6" r="1"/></svg>',
  // 现代：抛物面锅 + 馈源
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 13a7.5 7.5 0 0 1 12.5-4.2"/><path d="M4 13l4.2 1"/><path d="M11 12.5v5.5"/><path d="M8 18.5h6"/><circle cx="17" cy="8.6" r="1.2"/></svg>',
  // 后现代：横躺胶囊 + 核心
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="5" y="9" width="14" height="7" rx="3.5"/><circle cx="9" cy="12.5" r="1.8"/><path d="M14 8.6c1.4-1.5 2.8-1.5 4.2 0"/></svg>',
  // 星际：斜面控制台 + 星点
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 16h16l-2-5H6z"/><path d="M7 16v3M17 16v3"/><circle cx="9" cy="8.4" r="1"/><circle cx="14.5" cy="6.4" r="1"/></svg>',
  // 终幕：高方碑 + 光环
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 20V7h6v13"/><path d="M7 20h10"/><ellipse cx="12" cy="10" rx="7" ry="1.9"/></svg>',
];
let lastCmdKey = '';

function updateCommandChip(state) {
  if (!els.cmdChip) return;
  const bonus = state.commandMarkBonus || 0;
  const show = state.status === 'playing' && bonus > 0;
  els.cmdChip.hidden = !show;
  if (!show) return;

  const era = Math.max(0, Math.min(CMD_ICONS.length - 1, state.era | 0));
  const pct = (bonus * 100).toFixed(1);
  const key = `${era}|${pct}`;
  if (key === lastCmdKey) return;
  lastCmdKey = key;

  els.cmdIcon.innerHTML = CMD_ICONS[era];
  els.cmdBonus.textContent = `+${pct}%`;
  els.cmdChip.title = `集火伤害加成 +${pct}%`;
}

/* 血月回兵：击杀数和已回兵数只在血月期间显示 */
function updateBloodChip(state) {
  if (!els.bloodChip) return;
  const show = state.status === 'playing' && state.bloodMoon;
  els.bloodChip.hidden = !show;
  if (!show) return;
  const kills = state.bloodMoonKills | 0;
  const healed = state.bloodMoonHealed | 0;
  if (els.bloodKills.textContent !== String(kills)) {
    els.bloodKills.textContent = String(kills);
  }
  if (els.bloodHealed.textContent !== String(healed)) {
    els.bloodHealed.textContent = String(healed);
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

/* ---------- 地图结束升级面板 ---------- */

const UPGRADE_EMOJI = {
  barricadeUnlock: '🧱', barricadeUpgrade: '🧱',
  slotSiege: '💣', slotSiegeUpgrade: '💣',
  slotClose: '🛡️', slotCloseUpgrade: '🛡️',
  slotSupport: '🩹', slotSupportUpgrade: '🩹',
  slotCommand: '🎯', slotCommandUpgrade: '🎯',
  slotSummon: '🧟', slotSummonUpgrade: '🧟',
  damage: '💥', speed: '👟', armor: '🦺',
  barrel: '🛢️', fireRate: '⚡', gun: '🔫',
};

function updateUpgradePanel(state) {
  if (!els.upgradeLayer) return;

  const active =
    state.status === 'playing' &&
    state.upgradePanel &&
    state.upgradePanel.active;
  const justOpened = active && !els.upgradeWasOpen;
  els.upgradeWasOpen = active;
  els.upgradeLayer.classList.toggle('hidden', !active);
  if (!active) return;

  els.upgradeTimer.textContent = `${Math.max(0, Math.ceil(state.upgradePanel.timeLeft))}s`;
  els.upgradePicks.textContent = `剩余 ${state.upgradePanel.picks} 次`;

  // 顶部再写一行「本轮已选」：解锁卡点完会从列表消失，光看边框容易忘
  const picked = state.upgradePanel.picked || [];
  els.upgradePicked.textContent = picked.length
    ? `本轮已选：${picked.map((p) => `${p.name}×${p.count}`).join(' · ')}`
    : '';

  if (justOpened && els.upgradePanel) {
    // 面板可能沿用上一次的滚动位置，开局先把第一排露出来
    els.upgradePanel.scrollTop = 0;
  }

  if (els.upgradeVersion !== state.upgradePanel.version) {
    els.upgradeVersion = state.upgradePanel.version;
    // 卡面由玩法层算好：格子顺序在面板打开时锁死，每格取「这一组当前还能升的那张」。
    // 点了「攻城槽」之后同一格原地变成「攻城升级」，再点一次就再 +1 级，
    // 既不会整列重排，也不会出现灰掉/消失的卡
    const cards = actions && actions.getUpgradePanelCards
      ? actions.getUpgradePanelCards()
      : (actions && actions.getUpgradePool
        ? actions.getUpgradePool().map((c) => ({ ...c, count: 0 }))
        : []);

    els.upgradeGrid.innerHTML = cards.map((c) => {
      // 本次面板里点过几次：1 次蓝框，2 次及以上橙黄框，方便看清重复升级
      const n = c.count || 0;
      const pickedClass = n >= 2 ? ' is-picked-2' : n === 1 ? ' is-picked-1' : '';
      const emoji = UPGRADE_EMOJI[c.id] || UPGRADE_EMOJI[c.id.replace(/(Upgrade|Unlock)$/, '')] || '⭐';
      return `
      <button class="upgrade-choice${pickedClass}" type="button" data-upgrade-id="${c.id}">
        ${n > 0 ? `<span class="upgrade-choice__picks">×${n}</span>` : ''}
        <strong>${c.name} ${emoji}</strong>
        <span>${c.desc}</span>
      </button>
    `;
    }).join('');
  }
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
  els.testPanel.classList.toggle('hidden', !show || testPanelCollapsed);
  els.testPanelTab.classList.toggle('hidden', !show || !testPanelCollapsed);
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

    // 空槽：技能栏固定四格（和 game.js 的 SKILL_BAG_MAX 一致）。
    // 没装满时补空位，玩家才知道"还能再捡一张"，而不是以为就这几个。
    const SLOT_COUNT = 4;
    const emptyCount = Math.max(0, SLOT_COUNT - bag.length);

    els.skillRail.innerHTML = bag.map((s, i) => {
      const color = '#' + (s.color >>> 0).toString(16).padStart(6, '0');
      const isNew =
        s.id === state.lastGainedSkillId &&
        state.skillBagVersion === state.lastGainedSkillVersion;
      return `
        <button class="skill-slot${isNew ? ' is-new' : ''}" type="button" data-skill-id="${s.id}"
          data-charges="${s.charges}" style="--skill-color:${color}">
          <span class="skill-slot__key">${i + 1}</span>
          <span class="skill-slot__icon">${skillIconTag(s.id, { size: 26 })}</span>
          <span class="skill-slot__name">${s.name}</span>
          <span class="skill-slot__charges">×${s.charges}</span>
        </button>
      `;
    }).join('') + Array.from({ length: emptyCount }, (_, i) => `
        <div class="skill-slot skill-slot--empty" aria-hidden="true">
          <span class="skill-slot__key">${bag.length + i + 1}</span>
          <span class="skill-slot__empty-mark">+</span>
        </div>
      `).join('');

    els.skillRail.querySelectorAll('[data-skill-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        initAudio();
        if (actions && actions.useSkill) actions.useSkill(btn.dataset.skillId);
      });
    });
  }

  // 每次更新都要跑：次数会变，冷却也在变。
  // bag 只在 version 变化时重建，但次数是靠 useSkill 直接改 state 的，
  // 所以要在这里把最新的次数同步回 DOM——否则徽章会一直显示旧数字。
  const liveBag = actions && actions.getSkillBag ? actions.getSkillBag() : [];
  const liveById = new Map(liveBag.map((b) => [b.id, b]));

  const cooling = state.skillUseCd > 0;
  els.skillRail.querySelectorAll('.skill-slot[data-skill-id]').forEach((btn) => {
    btn.disabled = cooling;

    const live = liveById.get(btn.dataset.skillId);
    if (live) {
      const n = Math.max(0, live.charges | 0);
      if (btn.dataset.charges !== String(n)) {
        btn.dataset.charges = String(n);
        const badge = btn.querySelector('.skill-slot__charges');
        if (badge) badge.textContent = `×${n}`;
      }
      // 次数徽章的三种状态。徽章是"还能用几次"的唯一提示，
      // 见底时必须变红，否则玩家会点下去才发现没了。
      btn.classList.toggle('is-low', n > 0 && n <= 1);
      btn.classList.toggle('is-out', n <= 0);
    }
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
      <em class="wave__next" data-wave-next>12s</em>
    </div>
    <div class="score-box">
      <div class="score" data-score>0</div>
      <div class="cmd-chip" data-cmd-chip hidden>
        <span class="cmd-chip__icon" data-cmd-icon></span>
        <span data-cmd-bonus>+0%</span>
      </div>
      <div class="blood-chip" data-blood-chip hidden>
        血月 · 击杀 <span data-blood-kills>0</span> · 回兵 +<span data-blood-healed>0</span>
      </div>
    </div>
    <button class="pause-btn" type="button" data-pause aria-label="暂停">
      <span></span><span></span><span></span>
    </button>
  `;
  document.body.appendChild(hud);

  const startScreen = document.createElement('div');
  startScreen.className = 'overlay';
  startScreen.innerHTML = `
    <div class="card">
      <h1>万古防线</h1>
      <p class="title-en">EVERWALL</p>
      <p class="sub">
        左右移动，自动开火。<br>
        打中左边压下来的 +1 屏障加兵，<br>
        挡住右边的僵尸潮。
      </p>
      <div class="map-picker era-picker">
        <p class="map-picker__label">起始时代 <span class="map-picker__count">从该时代对应波次开始</span></p>
        <div class="era-picker__grid">
          ${MAP_GROUPS.map((grp, i) => `
            <button class="map-chip${i === startEra ? ' is-active' : ''}" data-start-era="${i}">
              ${grp.era}
            </button>
          `).join('')}
        </div>
      </div>
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
      <p class="credit">模型：Poly by Google · Catapult · CC-BY 3.0</p>
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

  // 地图结束的升级面板：3 次选择，30 秒暂停，没选完的次数累计到下一次
  const upgradeLayer = document.createElement('div');
  upgradeLayer.className = 'card-layer upgrade-layer hidden';
  upgradeLayer.innerHTML = `
    <div class="card-panel upgrade-panel">
      <div class="card-layer__head">
        <span>已暂停 · 选择升级</span>
        <span class="card-layer__timer" data-upgrade-timer>30s</span>
      </div>
      <p class="upgrade-picks" data-upgrade-picks>剩余 3 次</p>
      <p class="upgrade-picked" data-upgrade-picked></p>
      <div class="upgrade-grid" data-upgrade-grid></div>
    </div>
  `;
  document.body.appendChild(upgradeLayer);

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

  const envButtons = (testData.envEvents || [])
    .map((e) => `<button class="test-chip" type="button" data-test-env-id="${e.id}">${e.name}</button>`)
    .join('');
  const weatherButtons = (testData.weatherKinds || [])
    .map((w) => `<button class="test-chip${w.id === testWeatherKind ? ' is-active' : ''}" type="button" data-test-weather="${w.id}">${w.name}</button>`)
    .join('');

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
      <button class="test-panel__collapse" type="button" data-test-collapse>收起</button>
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
    <div class="test-panel__section">
      <p class="test-panel__label">环境事件（点一下直接触发）</p>
      <div class="test-era-grid" data-test-env-grid>${envButtons}</div>
    </div>
    <div class="test-panel__section">
      <p class="test-panel__label">天气类型（触发天气前选）</p>
      <div class="test-era-grid" data-test-weather-grid>${weatherButtons}</div>
    </div>
    <div class="test-panel__section test-panel__actions">
      <button type="button" data-test-spawn>刷 20 只僵尸</button>
      <button type="button" data-test-clear>清空僵尸</button>
      <button type="button" data-test-env>当前地图事件</button>
    </div>
  `;
  document.body.appendChild(testPanel);

  // 测试面板收起后留的小按钮，手机默认显示这个
  const testPanelTab = document.createElement('button');
  testPanelTab.className = 'test-panel-tab hidden';
  testPanelTab.type = 'button';
  testPanelTab.textContent = '测试面板';
  document.body.appendChild(testPanelTab);

  // 静音开关：不影响游戏，只控制声音。现场演示嫌吵可以按一下。
  const soundBtn = document.createElement('button');
  soundBtn.className = 'sound-toggle';
  soundBtn.type = 'button';
  soundBtn.setAttribute('aria-label', '开关声音');
  const muted = isMuted();
  soundBtn.textContent = muted ? '🔇' : '🔊';
  if (muted) soundBtn.classList.add('is-muted');
  document.body.appendChild(soundBtn);

  // 暂停菜单：最后插入，盖在抽卡层和测试面板上面
  const pauseOverlay = document.createElement('div');
  pauseOverlay.className = 'overlay pause-overlay hidden';
  pauseOverlay.innerHTML = `
    <div class="card">
      <p class="eyebrow">已暂停</p>
      <h2>暂停</h2>
      <button class="btn" type="button" data-resume>继续游戏</button>
      <button class="btn btn--ghost" type="button" data-menu>返回菜单</button>
    </div>
  `;
  document.body.appendChild(pauseOverlay);

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
    cmdChip: hud.querySelector('[data-cmd-chip]'),
    bloodChip: hud.querySelector('[data-blood-chip]'),
    bloodKills: hud.querySelector('[data-blood-kills]'),
    bloodHealed: hud.querySelector('[data-blood-healed]'),
    cmdIcon: hud.querySelector('[data-cmd-icon]'),
    cmdBonus: hud.querySelector('[data-cmd-bonus]'),
    startScreen,
    overScreen,
    finalScore: overScreen.querySelector('[data-final-score]'),
    finalWave: overScreen.querySelector('[data-final-wave]'),
    finalMap: overScreen.querySelector('[data-final-map]'),
    bestScore: overScreen.querySelector('[data-best-score]'),
    bestWave: overScreen.querySelector('[data-best-wave]'),
    soundBtn,
    pauseBtn: hud.querySelector('[data-pause]'),
    pauseOverlay,
    resumeBtn: pauseOverlay.querySelector('[data-resume]'),
    menuBtn: pauseOverlay.querySelector('[data-menu]'),
    loadingBox: startScreen.querySelector('[data-loading]'),
    loadingFill: startScreen.querySelector('[data-loading-fill]'),
    loadingText: startScreen.querySelector('[data-loading-text]'),
    startBest,
    upgradeLayer,
    upgradePanel: upgradeLayer.querySelector('.upgrade-panel'),
    upgradeTimer: upgradeLayer.querySelector('[data-upgrade-timer]'),
    upgradePicks: upgradeLayer.querySelector('[data-upgrade-picks]'),
    upgradePicked: upgradeLayer.querySelector('[data-upgrade-picked]'),
    upgradeGrid: upgradeLayer.querySelector('[data-upgrade-grid]'),
    upgradeVersion: -1,
    upgradeWasOpen: false,
    skillRail,
    skillVersion: -1,
    testToggle: startScreen.querySelector('[data-test-toggle]'),
    testToggleLabel: startScreen.querySelector('[data-test-toggle-label]'),
    testStartBtn: startScreen.querySelector('[data-start]'),
    testPanel,
    testPanelTab,
    testCollapse: testPanel.querySelector('[data-test-collapse]'),
    testEraName: testPanel.querySelector('[data-test-era-name]'),
    testEraNames: testData.eras,
    testEraBtns: [...testPanel.querySelectorAll('[data-test-era-btn]')],
    testEnvBtns: [...testPanel.querySelectorAll('[data-test-env-id]')],
    testWeatherBtns: [...testPanel.querySelectorAll('[data-test-weather]')],
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
    actions.start({
      testMode: testModeEnabled,
      startingEra: startEra,
      map: currentMap,
    });
  });

  els.startScreen.querySelectorAll('[data-start-era]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const era = Number(btn.dataset.startEra);
      const params = new URLSearchParams(window.location.search);
      params.set('era', String(era));
      // 选时代时顺手把地形切到该时代的第一张图，避免出现星际数值配中世纪场景
      params.set('map', MAP_GROUPS[era].ids[0]);
      window.location.search = params.toString();
    });
  });

  els.startScreen.querySelectorAll('[data-map]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const map = btn.dataset.map;
      const era = eraIndexOfMap(map);
      const params = new URLSearchParams(window.location.search);
      // 地图和时代一起写：只改 map 的话，URL 里旧的 era 会优先，
      // 跨时代选图会被当成无效选择再退回原时代。
      if (era >= 0) params.set('era', String(era));
      params.set('map', map);
      window.location.search = params.toString();
    });
  });

  // 起始时代选好后，地图列表滚到当前地图，避免选中的图藏在滚动区下面
  const mapGrid = els.startScreen.querySelector('.map-picker__grid');
  const activeMapBtn = mapGrid?.querySelector('.map-chip.is-active[data-map]');
  if (mapGrid && activeMapBtn) {
    mapGrid.scrollTop = Math.max(0, activeMapBtn.offsetTop - mapGrid.offsetTop - 8);
  }

  // 测试面板收起/展开
  els.testCollapse.addEventListener('click', () => {
    testPanelCollapsed = true;
    updateTestPanel(currentState || { status: 'menu' });
  });
  els.testPanelTab.addEventListener('click', () => {
    testPanelCollapsed = false;
    updateTestPanel(currentState || { status: 'menu' });
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

  const envBtn = els.testPanel.querySelector('[data-test-env]');
  if (envBtn) {
    envBtn.addEventListener('click', () => {
      if (actions && actions.triggerEnvEvent) actions.triggerEnvEvent();
    });
  }

  // 指定环境事件：六类都能直接测，天气再按上面选的类型触发
  els.testEnvBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (actions && actions.triggerEnvEvent) {
        actions.triggerEnvEvent(btn.dataset.testEnvId, testWeatherKind);
      }
    });
  });

  els.testWeatherBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      testWeatherKind = btn.dataset.testWeather;
      els.testWeatherBtns.forEach((b) => {
        b.classList.toggle('is-active', b === btn);
      });
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

  // 暂停菜单
  els.pauseBtn.addEventListener('click', () => {
    initAudio();
    playClick();
    if (actions && actions.setPaused) actions.setPaused(true);
  });

  els.resumeBtn.addEventListener('click', () => {
    playClick();
    if (actions && actions.setPaused) actions.setPaused(false);
  });

  els.menuBtn.addEventListener('click', () => {
    playClick();
    if (actions && actions.returnToMenu) actions.returnToMenu();
  });

  // 升级面板：按钮会随版本重绘，用事件委托接点击。
  // 不能只用 click —— 每次点选后下一帧会 innerHTML 重建所有按钮，
  // 如果第二次按下和抬起之间正好夹着这次重建，浏览器就找不到
  // mousedown/mouseup 的共同祖先，click 事件根本不会产生（快速连点必丢一下）。
  // 改成按下记 id、抬起提交，不依赖按下的那个按钮还活着。
  let pressCard = null;
  els.upgradeGrid.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('[data-upgrade-id]');
    if (!btn || btn.disabled) {
      pressCard = null;
      return;
    }
    pressCard = { id: btn.dataset.upgradeId, x: e.clientX, y: e.clientY };
  });

  window.addEventListener('pointerup', (e) => {
    const p = pressCard;
    pressCard = null;
    if (!p) return;
    // 拖动超过 16px 当成在滚动列表，不算点选
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 16) return;
    initAudio();
    playClick();
    if (actions && actions.chooseUpgrade) actions.chooseUpgrade(p.id);
  });

  window.addEventListener('pointercancel', () => {
    pressCard = null;
  });

  // 键盘操作（Enter/空格）不产生指针事件，detail === 0 的 click 才是键盘来的
  els.upgradeGrid.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    const btn = e.target.closest('[data-upgrade-id]');
    if (!btn) return;
    initAudio();
    playClick();
    if (actions && actions.chooseUpgrade) actions.chooseUpgrade(btn.dataset.upgradeId);
  });

  // 技能栏数字键 1-4
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (currentState && (currentState.paused || currentState.status !== 'playing')) return;
    const n = Number(e.key);
    if (n < 1 || n > 4) return;
    if (!currentState || !currentState.skillBag) return;

    const entry = currentState.skillBag[n - 1];
    if (!entry) return;

    e.preventDefault();
    if (actions && actions.useSkill) actions.useSkill(entry.id);
  });
}
