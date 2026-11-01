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
  zombieDie: 0.045,
  barrierHit: 0.05,
  barrierApply: 0.06,
  armyHurt: 0.25,
  zombieAttack: 0.7, // 同类攻击吼至少隔 0.7 秒，防糊
};

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
  master.gain.value = 0.5;
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

/* ----------------------------------------------------------
 * 具体音效
 * ---------------------------------------------------------- */

// 枪声：噪声爆发（快速低通下滑）+ 一记低频冲击
export function playShoot() {
  if (!ready('shoot', THROTTLE.shoot)) return;
  const t = ctx.currentTime;

  noise(t, 0.11, { type: 'lowpass', freq: 3800, sweepTo: 380, gain: 0.34 });
  noise(t, 0.045, { type: 'highpass', freq: 2400, gain: 0.1 });

  tone(t, { type: 'sine', from: 130, to: 42, dur: 0.1, gain: 0.45 });
}

// 僵尸死亡：闷响 + 一声短促的下坠
export function playZombieDie() {
  if (!ready('zombieDie', THROTTLE.zombieDie)) return;
  const t = ctx.currentTime;

  noise(t, 0.2, { type: 'lowpass', freq: 900, sweepTo: 160, gain: 0.2 });
  tone(t, { type: 'triangle', from: 180, to: 60, dur: 0.18, gain: 0.16 });
}

// 僵尸开始攻击的吼声，按类型换嗓子（type 约定见 docs/僵尸类型.md）：
//   1 大块头 = 低沉怒吼（狮子喉），2 快鬼 = 尖利急叫，3 精英 = 沙哑咆哮，
//   其余（普通/女僵尸）= 标准嘶吼。每种音色差异明显，闭着眼也能听出是谁在扑。
export function playZombieAttack(type = 0) {
  if (!ready('zombieAttack' + type, THROTTLE.zombieAttack)) return;
  const t = ctx.currentTime;

  const snarl = (base, { dur = 0.5, peak = 0.14, freq = 320, q = 3 } = {}) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.linearRampToValueAtTime(base * 1.3, t + dur * 0.3);
    osc.frequency.linearRampToValueAtTime(base * 0.65, t + dur);

    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    f.Q.value = q;

    const g = ctx.createGain();
    env(g, t, peak, 0.03, dur);

    const breath = ctx.createBufferSource();
    breath.buffer = noiseBuf;
    const bg = ctx.createGain();
    env(bg, t, peak * 0.4, 0.03, dur * 0.8);

    osc.connect(f).connect(g).connect(master);
    breath.connect(bg).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  };

  if (type === 1) {
    // 大块头：很低很沉，收得慢，像胸腔里滚出来的
    snarl(46, { dur: 0.7, peak: 0.2, freq: 160, q: 2.5 });
    tone(t, { type: 'sine', from: 60, to: 32, dur: 0.5, gain: 0.22 });
  } else if (type === 2) {
    // 快鬼：尖利上扬再骤降，像尖叫
    snarl(340, { dur: 0.32, peak: 0.1, freq: 1100, q: 5 });
  } else if (type === 3) {
    // 精英：沙哑，滤波更窄更毛糙
    snarl(120, { dur: 0.55, peak: 0.15, freq: 420, q: 7 });
  } else {
    // 普通 / 女僵尸：标准嘶吼，女僵尸音色稍尖一点
    snarl(type === 4 ? 105 : 88, { dur: 0.5, peak: 0.13, freq: 340, q: 3.5 });
  }
}

// 打中负数屏障：金属声，提示"这个不该打"
export function playBarrierHit() {
  if (!ready('barrierHit', THROTTLE.barrierHit)) return;
  const t = ctx.currentTime;

  tone(t, { type: 'square', from: 1500, to: 1100, dur: 0.07, gain: 0.11 });
  noise(t, 0.06, { type: 'bandpass', freq: 3200, q: 6, gain: 0.1 });
}

// 屏障数值生效：正数明亮上行，负数低沉下行
export function playBarrierApply(value) {
  if (!ready('barrierApply', THROTTLE.barrierApply)) return;
  const t = ctx.currentTime;
  const positive = (value ?? 1) >= 0;

  if (positive) {
    tone(t, { type: 'sine', from: 660, to: 990, dur: 0.14, gain: 0.16 });
    tone(t + 0.07, { type: 'sine', from: 990, to: 1320, dur: 0.12, gain: 0.12 });
  } else {
    tone(t, { type: 'sawtooth', from: 320, to: 120, dur: 0.22, gain: 0.18 });
    noise(t, 0.16, { type: 'lowpass', freq: 700, gain: 0.12 });
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

// 界面点击
export function playClick() {
  if (!ready()) return;
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

// 每张地图一条底色：city 雨、jungle 虫鸣、desert 风沙、moon 真空嗡鸣、snow 寒风、lava 岩浆轰鸣
const AMBIENT = {
  city: { buf: 'white', type: 'bandpass', freq: 1400, q: 0.6, gain: 0.085, lfo: 0.12, lfoDepth: 0.03 },
  jungle: { buf: 'white', type: 'bandpass', freq: 4200, q: 3, gain: 0.05, lfo: 3.5, lfoDepth: 0.035 },
  desert: { buf: 'brown', type: 'bandpass', freq: 520, q: 0.7, gain: 0.13, lfo: 0.18, lfoDepth: 0.06 },
  moon: { buf: 'brown', type: 'lowpass', freq: 180, q: 1, gain: 0.1, lfo: 0.07, lfoDepth: 0.03 },
  snow: { buf: 'brown', type: 'bandpass', freq: 900, q: 1.2, gain: 0.12, lfo: 0.3, lfoDepth: 0.07 },
  lava: { buf: 'brown', type: 'lowpass', freq: 260, q: 1.5, gain: 0.15, lfo: 0.09, lfoDepth: 0.05 },
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
  const base = 68 + Math.random() * 34; // 每只音高不同，听着不像同一个

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(base, t);
  osc.frequency.linearRampToValueAtTime(base * 1.25, t + 0.25);
  osc.frequency.linearRampToValueAtTime(base * 0.8, t + 0.65);

  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 320;
  f.Q.value = 4;

  const g = ctx.createGain();
  env(g, t, 0.1, 0.14, 0.5);

  // 一点气声，让吼叫不干
  const breath = ctx.createBufferSource();
  breath.buffer = noiseBuf;
  const bg = ctx.createGain();
  env(bg, t, 0.05, 0.1, 0.45);

  osc.connect(f).connect(g).connect(master);
  breath.connect(bg).connect(master);

  osc.start(t);
  osc.stop(t + 0.7);
  breath.start(t);
  breath.stop(t + 0.6);
}

/* ----------------------------------------------------------
 * 静音开关（现场演示可能不想太吵）
 * ---------------------------------------------------------- */

export function toggleMute() {
  muted = !muted;
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

export function isMuted() {
  return muted;
}
