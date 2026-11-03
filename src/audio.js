/* ==========================================================
 * 音效层（乙负责）
 *
 * 全部用 Web Audio 实时合成，不加载任何音频文件：
 *   - 零下载体积（贴图已经占了 20MB，音频不再加）
 *   - 零版权问题（不需要找素材、不需要署名）
 *   - 可按地图调参数（雨林虫鸣、沙漠风、月球真空嗡鸣）
 *
 * 对外只暴露「播某个音」和「换环境音」，不碰游戏逻辑。
 * 浏览器要求音频必须在用户手势之后才能响，所以由 ui.js 的
 * 按钮点击触发 initAudio()。
 * ========================================================== */

let ctx = null;
let master = null;
let muted = false;

let noiseBuf = null; // 白噪，短促的撞击/碎裂用它
let brownBuf = null; // 棕噪，低频更重，风和环境音用它

// 音效限流：记录每个音效上次播放的时间，避免密集开火糊成一片噪音
const lastPlayed = {};
const THROTTLE = {
  shoot: 0.055,
  zombieDie: 0.08,
  barrierHit: 0.05,
  barrierApply: 0.06,
  armyHurt: 0.25,
  zombieAttack: 0.7, // 同类攻击吼至少隔 0.7 秒，防糊
};

/* 地图音色：同一套僵尸，在不同地图听起来不一样。
 * 纯参数调整，不加任何音频文件。 */
const MAP_ID = new URLSearchParams(window.location.search).get('map') || 'city';
const MAP_VOICE = {
  city:   { freq: 1.0,  q: 1.0, dur: 1.0,  gain: 1.0 },
  jungle: { freq: 0.88, q: 0.8, dur: 1.18, gain: 1.0, echo: true },   // 湿闷、带点回响
  desert: { freq: 1.06, q: 1.25, dur: 0.88, gain: 0.95, dry: true },  // 干脆
  moon:   { freq: 1.18, q: 1.5, dur: 0.82, gain: 0.9, ring: true },    // 真空感：更尖、带金属嗡鸣
  snow:   { freq: 0.78, q: 0.7, dur: 1.22, gain: 1.05 },              // 寒风里闷闷的
  lava:   { freq: 0.86, q: 0.95, dur: 1.28, gain: 1.1, rumble: true },// 低沉轰鸣
};
const VOICE = MAP_VOICE[MAP_ID] || MAP_VOICE.city;

// 环境音当前状态
let ambient = null;
let ambientId = null;
let growlTimer = 0;

/* ----------------------------------------------------------
 * 初始化
 * ---------------------------------------------------------- */

export function initAudio() {
  if (ctx) {
    // 已经初始化过，只要确保没被浏览器挂起
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return; // 老浏览器直接静音降级，不影响游戏

  ctx = new AC();
  master = ctx.createGain();
  // 上次如果是静音状态，这次直接保持静音（现场演示不想突然出声）
  master.gain.value = muted ? 0.0001 : 0.5;
  master.connect(ctx.destination);

  noiseBuf = makeNoiseBuffer(2, 'white');
  brownBuf = makeNoiseBuffer(3, 'brown');

  // 页面加载时 visuals 已经报过地图名了（那会儿还没有 ctx），这里补开环境音
  if (ambientId) {
    const mapId = ambientId;
    ambientId = null;
    setAmbient(mapId);
  }
}
function makeNoiseBuffer(seconds, kind) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);

  if (kind === 'white') {
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  } else {
    // 棕噪：白噪做一阶积分，低频更重，听感像风
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  }
  return buf;
}

/* ----------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------- */

function ready(key, gap) {
  if (!ctx || muted) return false;
  if (ctx.state === 'suspended') ctx.resume();

  const now = ctx.currentTime;
  if (key && gap) {
    if (now - (lastPlayed[key] || -99) < gap) return false;
    lastPlayed[key] = now;
  }
  return true;
}

function env(gainNode, t, peak, attack, decay) {
  const g = gainNode.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function noise(t, dur, { type = 'lowpass', freq = 2000, q = 1, gain = 0.4, sweepTo = null, attack = 0.004 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.9 + Math.random() * 0.2; // 每发略有差异，不呆板

  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur * 0.9);

  const g = ctx.createGain();
  env(g, t, gain, attack, dur);

  src.connect(f).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);
}

function tone(t, { type = 'sine', from = 440, to = null, dur = 0.12, gain = 0.3, attack = 0.004 } = {}) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t + dur * 0.9);

  const g = ctx.createGain();
  env(g, t, gain, attack, dur);

  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/* 僵尸嗓音：锯齿波 + 两个共振峰 + 气声。
 * 单共振峰听起来像电子蜂鸣，加第二共振峰后才像喉咙里发出来的声音。 */
function zombieVoice(t, {
  base = 120,
  dur = 0.6,
  gain = 0.25,
  formants = [600, 1200],
  formantGains = [1, 0.45],
  bend = [1.18, 0.82],
  breath = 0.35,
  breathFreq = 900,
  attack = 0.02,
} = {}) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(base, t);
  osc.frequency.linearRampToValueAtTime(
    Math.max(20, base * bend[0]), t + dur * 0.3
  );
  osc.frequency.linearRampToValueAtTime(
    Math.max(20, base * bend[1]), t + dur
  );

  const out = ctx.createGain();
  env(out, t, gain, attack, dur * 0.82);
  out.connect(master);

  formants.forEach((freq, i) => {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 3 + i * 1.6;
    const fg = ctx.createGain();
    fg.gain.value = formantGains[i] ?? 0.45;
    osc.connect(f).connect(fg).connect(out);
  });

  osc.start(t);
  osc.stop(t + dur + 0.1);

  if (breath > 0) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = breathFreq;
    bp.Q.value = 1.2;
    const bg = ctx.createGain();
    env(bg, t, gain * breath, 0.03, dur * 0.7);
    src.connect(bp).connect(bg).connect(master);
    src.start(t);
    src.stop(t + dur + 0.1);
  }
}

/* ----------------------------------------------------------
 * 具体音效
 * ---------------------------------------------------------- */

// 枪声：噪声爆发（快速低通下滑）+ 一记低频冲击
export function playShoot() {
  if (!ready('shoot', THROTTLE.shoot)) return;
  const t = ctx.currentTime;

  // 枪声稍微收一点，给僵尸音效让出空间
  noise(t, 0.11, { type: 'lowpass', freq: 3800, sweepTo: 380, gain: 0.18 });
  noise(t, 0.045, { type: 'highpass', freq: 2400, gain: 0.05 });

  tone(t, { type: 'sine', from: 130, to: 42, dur: 0.1, gain: 0.26 });
}

// 僵尸死亡：闷响 + 一声短促的下坠
export function playZombieDie() {
  if (!ready('zombieDie', THROTTLE.zombieDie)) return;
  const t = ctx.currentTime;

  // 喉咙里的湿声，不要低频扫频——那个听起来像放屁
  noise(t, 0.16 * VOICE.dur, {
    type: 'bandpass',
    freq: 720 * VOICE.freq,
    q: 1.1,
    gain: 0.12 * VOICE.gain,
  });
  // 一点点迸溅的中高频，保留“死掉”的实感
  noise(t + 0.02, 0.12, {
    type: 'highpass',
    freq: 1500,
    gain: 0.12 * VOICE.gain,
  });
  // 身体倒下的低频落地感，晚一点、短一点
  tone(t + 0.14, {
    type: 'sine',
    from: 80,
    to: 38,
    dur: 0.25 * VOICE.dur,
    gain: 0.2 * VOICE.gain,
  });

  if (VOICE.rumble) {
    // 熔岩：尸体倒下的同时溅起一小撮火星
    noise(t + 0.04, 0.16, { type: 'highpass', freq: 2600, gain: 0.105 });
  }
  if (VOICE.ring) {
    // 月球：真空里倒下的一声脆响
    tone(t + 0.02, { type: 'square', from: 1200, to: 700, dur: 0.1, gain: 0.075 });
  }

  // 死亡嚎叫：0.7 秒左右的下坠音，先撑一下再塌下去，别像“噗”一声就没了
  zombieVoice(t, {
    base: (230 + Math.random() * 70) * VOICE.freq,
    dur: (0.62 + Math.random() * 0.16) * VOICE.dur,
    gain: 0.4 * VOICE.gain,
    formants: [680 * VOICE.freq, 1600 * VOICE.freq],
    formantGains: [1, 0.52],
    bend: [1.1, 0.45],
    breath: 0.55,
    breathFreq: 1200 * VOICE.freq,
    attack: 0.06,
  });
}

// 僵尸开始攻击的吼声，按类型换嗓子（type 约定见 docs/僵尸类型.md）：
//   1 大块头 = 低沉怒吼（狮子喉），2 快鬼 = 尖利急叫，3 精英 = 沙哑咆哮，
//   其余（普通/女僵尸）= 标准嘶吼。每种音色差异明显，闭着眼也能听出是谁在扑。
export function playZombieAttack(type = 0) {
  if (!ready('zombieAttack' + type, THROTTLE.zombieAttack)) return;
  const t = ctx.currentTime;

  const snarl = (base, { dur = 0.5, peak = 0.34, freq = 320, q = 3 } = {}) => {
    // 套上地图音色：滤波中心、Q、时长、响度都按地图缩放
    const d = dur * VOICE.dur;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.linearRampToValueAtTime(base * 1.3, t + d * 0.3);
    osc.frequency.linearRampToValueAtTime(base * 0.65, t + d);

    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq * VOICE.freq, t);
    f.Q.value = q * VOICE.q;

    const g = ctx.createGain();
    env(g, t, peak * VOICE.gain, 0.03, d);

    // 第二共振峰：从“电子嗡”变成喉咙里的沙哑
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.setValueAtTime(freq * 2.1 * VOICE.freq, t);
    f2.Q.value = q * 0.7 * VOICE.q;
    const g2 = ctx.createGain();
    g2.gain.value = 0.38;

    const breath = ctx.createBufferSource();
    breath.buffer = noiseBuf;
    const bg = ctx.createGain();
    env(bg, t, peak * 0.4 * VOICE.gain, 0.03, d * 0.8);

    osc.connect(f).connect(g).connect(master);
    osc.connect(f2).connect(g2).connect(g);
    breath.connect(bg).connect(master);
    osc.start(t);
    osc.stop(t + d + 0.05);

    // 雨林：加一层远处的回声，像在树丛里
    if (VOICE.echo) {
      const echoGain = ctx.createGain();
      env(echoGain, t + 0.16, peak * 0.22 * VOICE.gain, 0.05, d * 0.7);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      g.connect(lp).connect(echoGain).connect(master);
    }
    // 月球：真空里传不远，但有个金属感的嗡鸣
    if (VOICE.ring) {
      tone(t + 0.04, { type: 'sine', from: 1650, to: 1580, dur: d * 0.8, gain: 0.05 * VOICE.gain });
    }
    // 火山：底下压一层低频轰鸣
    if (VOICE.rumble) {
      tone(t, { type: 'sine', from: 44, to: 30, dur: d * 1.2, gain: 0.18 * VOICE.gain });
    }
  };

  if (type === 1) {
    // 大块头：很低很沉，但把共振峰抬到 320，手机喇叭也能听见
    snarl(78, { dur: 0.9, peak: 0.32, freq: 320, q: 2.5 });
    tone(t, { type: 'sine', from: 72, to: 38, dur: 0.5, gain: 0.22 });
  } else if (type === 2) {
    // 快鬼：尖利上扬再骤降，像尖叫
    snarl(360, { dur: 0.45, peak: 0.2, freq: 1200, q: 5 });
  } else if (type === 3) {
    // 精英：沙哑，滤波更窄更毛糙
    snarl(165, { dur: 0.75, peak: 0.3, freq: 620, q: 6 });
  } else {
    // 普通 / 女僵尸：标准嘶吼，女僵尸音色稍尖一点
    snarl(type === 4 ? 155 : 125, { dur: 0.7, peak: 0.28, freq: 620, q: 3.5 });
  }
}

// 打中负数屏障：金属声，提示"这个不该打"
export function playBarrierHit() {
  if (!ready('barrierHit', THROTTLE.barrierHit)) return;
  const t = ctx.currentTime;

  tone(t, { type: 'square', from: 1500, to: 1100, dur: 0.07, gain: 0.07 });
  noise(t, 0.06, { type: 'bandpass', freq: 3200, q: 6, gain: 0.06 });
}

// 屏障数值生效：正数明亮上行，负数低沉下行
export function playBarrierApply(value) {
  if (!ready('barrierApply', THROTTLE.barrierApply)) return;
  const t = ctx.currentTime;
  const positive = (value ?? 1) >= 0;

  if (positive) {
    tone(t, { type: 'sine', from: 660, to: 990, dur: 0.14, gain: 0.11 });
    tone(t + 0.07, { type: 'sine', from: 990, to: 1320, dur: 0.12, gain: 0.08 });
  } else {
    tone(t, { type: 'sawtooth', from: 320, to: 120, dur: 0.22, gain: 0.12 });
    noise(t, 0.16, { type: 'lowpass', freq: 700, gain: 0.08 });
  }
}

// 扣兵：两声低沉警报，扣得越多第二声越低
export function playArmyHurt(amount = 1) {
  if (!ready('armyHurt', THROTTLE.armyHurt)) return;
  const t = ctx.currentTime;
  const drop = Math.min(amount, 5) * 12;

  tone(t, { type: 'square', from: 220 - drop, to: 180 - drop, dur: 0.1, gain: 0.2 });
  tone(t + 0.13, { type: 'square', from: 175 - drop, to: 140 - drop, dur: 0.14, gain: 0.17 });
  noise(t, 0.1, { type: 'lowpass', freq: 500, gain: 0.1 });
}

// 新一波：一记低频冲击
export function playWaveStart() {
  if (!ready()) return;
  const t = ctx.currentTime;

  tone(t, { type: 'sine', from: 90, to: 38, dur: 0.5, gain: 0.34, attack: 0.01 });
  noise(t, 0.4, { type: 'lowpass', freq: 600, sweepTo: 120, gain: 0.12 });
}

// Boss 咆哮：登场时的一声低沉怒吼，压过所有别的声音
export function playBossRoar() {
  if (!ready('bossRoar', 1.5)) return;
  const t = ctx.currentTime;

  // 主体：低频锯齿波 + 慢慢下滑
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(95, t);
  osc.frequency.linearRampToValueAtTime(58, t + 1.1);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(700, t);
  lp.frequency.linearRampToValueAtTime(220, t + 1.1);
  const g = ctx.createGain();
  env(g, t, 0.26, 0.05, 1.1);
  osc.connect(lp).connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 1.25);

  // 底层的轰鸣和一点点气声
  tone(t, { type: 'sine', from: 42, to: 26, dur: 1.4, gain: 0.24 });
  noise(t, 1.0, { type: 'bandpass', freq: 520, q: 1.2, gain: 0.12 });
}

// 炸药桶：引信嘶嘶声（打中时）+ 爆炸（炸响 + 低频冲击 + 碎片）
export function playBarrelFuse() {
  if (!ready('barrelFuse', 0.12)) return;
  const t = ctx.currentTime;
  noise(t, 0.16, { type: 'highpass', freq: 3200, gain: 0.09 });
  tone(t, { type: 'sawtooth', from: 1800, to: 2600, dur: 0.14, gain: 0.04 });
}

export function playBarrelExplode() {
  if (!ready('barrelExplode', 0.15)) return;
  const t = ctx.currentTime;

  // 主体：低频冲击 + 宽带爆响
  tone(t, { type: 'sine', from: 120, to: 28, dur: 0.7, gain: 0.34, attack: 0.008 });
  noise(t, 0.55, { type: 'lowpass', freq: 1800, sweepTo: 180, gain: 0.26 });
  // 碎片：爆响后一小串噼啪
  for (let i = 0; i < 5; i++) {
    noise(t + 0.06 + i * 0.055, 0.06, {
      type: 'highpass',
      freq: 2400 + i * 500,
      gain: 0.05,
    });
  }
}

// 界面点击
export function playClick() {  if (!ready()) return;
  const t = ctx.currentTime;
  tone(t, { type: 'square', from: 880, to: 660, dur: 0.05, gain: 0.09 });
}

// 复活：一段上扬的明亮音阶
export function playRevive() {
  if (!ready()) return;
  const t = ctx.currentTime;
  [523, 659, 784, 1046].forEach((f, i) => {
    tone(t + i * 0.07, { type: 'sine', from: f, to: f, dur: 0.16, gain: 0.14 });
  });
}

/* ----------------------------------------------------------
 * 环境音（按地图切换）
 * ---------------------------------------------------------- */

// 每张地图一条底色：city 雨、jungle 虫鸣、desert 风沙、moon 真空嗡鸣、snow 寒风、lava 岩浆轰鸣、base 铁皮风
const AMBIENT = {
  city: { buf: 'white', type: 'bandpass', freq: 1400, q: 0.6, gain: 0.085, lfo: 0.12, lfoDepth: 0.03 },
  jungle: { buf: 'white', type: 'bandpass', freq: 4200, q: 3, gain: 0.05, lfo: 3.5, lfoDepth: 0.035 },
  desert: { buf: 'brown', type: 'bandpass', freq: 520, q: 0.7, gain: 0.13, lfo: 0.18, lfoDepth: 0.06 },
  moon: { buf: 'brown', type: 'lowpass', freq: 180, q: 1, gain: 0.1, lfo: 0.07, lfoDepth: 0.03 },
  snow: { buf: 'brown', type: 'bandpass', freq: 900, q: 1.2, gain: 0.12, lfo: 0.3, lfoDepth: 0.07 },
  lava: { buf: 'brown', type: 'lowpass', freq: 260, q: 1.5, gain: 0.15, lfo: 0.09, lfoDepth: 0.05 },
  // 军事基地：铁皮上的风 + 远处电流嗡鸣
  base: { buf: 'white', type: 'bandpass', freq: 2100, q: 0.9, gain: 0.07, lfo: 0.5, lfoDepth: 0.04 },
  // 废弃医院：通风管道的低鸣 + 一点高频电流声
  lab: { buf: 'brown', type: 'lowpass', freq: 300, q: 1.2, gain: 0.12, lfo: 0.4, lfoDepth: 0.05 },
  // 港口码头：海浪，一涨一落
  harbor: { buf: 'brown', type: 'lowpass', freq: 420, q: 0.8, gain: 0.14, lfo: 0.22, lfoDepth: 0.09 },
};

export function setAmbient(mapId) {
  if (ambientId === mapId) return;
  ambientId = mapId;

  if (!ctx) return;
  stopAmbient();
  if (muted) return;

  const cfg = AMBIENT[mapId] || AMBIENT.city;

  const src = ctx.createBufferSource();
  src.buffer = cfg.buf === 'brown' ? brownBuf : noiseBuf;
  src.loop = true;

  const f = ctx.createBiquadFilter();
  f.type = cfg.type;
  f.frequency.value = cfg.freq;
  f.Q.value = cfg.q;

  const g = ctx.createGain();
  g.gain.value = 0.0001;
  g.gain.exponentialRampToValueAtTime(cfg.gain, ctx.currentTime + 1.2); // 淡入，避免突然出现

  // 缓慢起伏，让底色不像一条死噪音
  const lfo = ctx.createOscillator();
  lfo.frequency.value = cfg.lfo;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = cfg.lfoDepth;
  lfo.connect(lfoGain).connect(g.gain);

  src.connect(f).connect(g).connect(master);
  src.start();
  lfo.start();

  ambient = { src, g, lfo };
}

function stopAmbient() {
  if (!ambient) return;
  const { src, g, lfo } = ambient;
  const t = ctx.currentTime;
  try {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.stop(t + 0.7);
    lfo.stop(t + 0.7);
  } catch (e) {
    // 已经停过就忽略
  }
  ambient = null;
}

/* ----------------------------------------------------------
 * 僵尸低吼：不定时随机播，有僵尸才吼
 *
 * 由 visuals 每帧调用 updateAudio，这里自己管计时，
 * 避免把氛围逻辑写进画面代码。
 * ---------------------------------------------------------- */

export function updateAudio(dt, zombieCount, playing) {
  if (!ctx || muted || !playing) return;
  if (zombieCount <= 0) {
    growlTimer = 0;
    return;
  }

  growlTimer -= dt;
  if (growlTimer > 0) return;

  // 僵尸越多吼得越勤，间隔 1.2~4 秒
  const density = Math.min(zombieCount / 14, 1);
  growlTimer = 4 - density * 2.6 + Math.random() * 1.2;
  playGrowl();
}

function playGrowl() {
  const t = ctx.currentTime;

  // 三种元音轮换，避免每一声都是同一个“哼哼”
  const vowels = [
    { base: 96,  formants: [480, 1080], gains: [1, 0.42], bend: [1.22, 0.78] },
    { base: 116, formants: [640, 1420], gains: [1, 0.5],  bend: [1.12, 0.82] },
    { base: 82,  formants: [420, 930],  gains: [1, 0.38], bend: [1.3, 0.72] },
  ];
  const v = vowels[Math.floor(Math.random() * vowels.length)];
  const base = (v.base + Math.random() * 28) * VOICE.freq;
  const dur = (1.1 + Math.random() * 0.4) * VOICE.dur;

  // 先慢慢鼓起来再塌下去，不要一上来就“嗯”一声
  zombieVoice(t, {
    base,
    dur,
    gain: 0.3 * VOICE.gain,
    formants: v.formants.map((f) => f * VOICE.freq),
    formantGains: v.gains,
    bend: v.bend,
    breath: 0.5,
    breathFreq: (900 + Math.random() * 350) * VOICE.freq,
    attack: 0.18,
  });

  // 偶尔接一声更低的回音，像不止一只在附近
  if (Math.random() < 0.35) {
    zombieVoice(t + dur * 0.55, {
      base: base * 0.72,
      dur: dur * 0.62,
      gain: 0.18 * VOICE.gain,
      formants: v.formants.map((f) => f * 0.82 * VOICE.freq),
      formantGains: v.gains,
      bend: [1.05, 0.7],
      breath: 0.35,
      breathFreq: 700 * VOICE.freq,
      attack: 0.16,
    });
  }
}

/* ----------------------------------------------------------
 * 静音开关（现场演示可能不想太吵）
 * ---------------------------------------------------------- */

export function toggleMute() {
  muted = !muted;
  try {
    // 记住静音状态：现场演示调好一次就行，下次打开还是这个状态
    localStorage.setItem('douyin-zombie-muted', muted ? '1' : '0');
  } catch (e) {
    // 隐私模式下 localStorage 可能不可用，忽略即可
  }
  if (!ctx) return muted;

  if (muted) {
    master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    stopAmbient();
  } else {
    master.gain.setTargetAtTime(0.5, ctx.currentTime, 0.05);
    // 重新打开环境音
    const mapId = ambientId;
    ambientId = null;
    if (mapId) setAmbient(mapId);
  }
  return muted;
}

// 上次是不是静音的（页面一加载就读，不用等用户点）
export function loadMuteState() {
  try {
    if (localStorage.getItem('douyin-zombie-muted') === '1') {
      muted = true;
    }
  } catch (e) {
    // 读不到就用默认（不静音）
  }
  return muted;
}

export function isMuted() {
  return muted;
}
