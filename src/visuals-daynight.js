/* ==========================================================
 * 昼夜轮转：灯光 / 雾 / 天空的过渡（乙负责）
 *
 * 用法：
 *   const dayNight = createDayNight({ scene, hemi, key, ambient });
 *   dayNight.setNight(nightForWave(wave), true); // 每波开局瞬时切换
 *   在渲染循环里 dayNight.update(dt);
 *
 * 设计要点：
 * 1. 构造时先把当前灯光/雾/背景"抓基线"，之后所有夜晚数值都是
 *    "基线的倍数或基线的插值"。六张地图亮度、雾距、灯色各不相同，
 *    写死绝对值会让 moon（本来就暗）糊成一团、desert（本来就亮）没变化。
 * 2. 只动 lights / fog / background，不碰 state、不碰材质。
 * 3. 任何传入对象缺失或字段类型不对，都只是跳过该项，不抛异常。
 * ========================================================== */

import * as THREE from 'three';

/* 夜晚相对白天基线的倍率（1 = 不变）。
 * hemi / key：环境与主光压到 ~55% / 60%，画面变暗但还能看清轮廓。
 * fogNear / fogFar：雾整体前移，远处更快糊掉，制造压迫感；
 *   near 收得比 far 更狠，避免整屏灰白。
 * bgMix / fogMix：背景与雾色往深蓝黑混的比例，留一点环境色，不做纯黑。
 * ambient：只有传了 AmbientLight 才生效，补一点底光防止暗部纯死黑。
 * tintMix：主光往月光蓝偏多少（在基线色上插值，所以沙漠的暖光夜里也不会变怪）。
 * duration：一次过渡的秒数，1.6 秒刚好够"天黑了"的仪式感，又不耽误打枪。 */
const NIGHT = {
  hemi: 0.55,
  key: 0.6,
  ambient: 0.7,
  fogNear: 0.72,
  fogFar: 0.85,
  bgMix: 0.62,
  fogMix: 0.62,
  tintMix: 0.6,
  duration: 1.6,
};

/* 夜晚的目标色：偏冷的月光蓝 / 深蓝黑。只用于 lerp，不直接赋值。 */
const NIGHT_KEY_TINT = new THREE.Color(0x8fb0ff);
const NIGHT_COLOR = new THREE.Color(0x060a16);

/* ----------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------- */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isColor = (c) => !!c && c.isColor === true;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// 在 a、b 之间按 p 取值；用来把"基线 → 基数×倍率"统一写成插值
const lerp = (a, b, p) => a + (b - a) * p;
// 平滑起停，避免过渡开头结尾"顿"一下
const easeInOut = (t) => t * t * (3 - 2 * t);

/* ----------------------------------------------------------
 * 昼夜控制器
 *
 * @param {THREE.Scene|null} scene  提供 fog / background
 * @param {THREE.HemisphereLight|null} hemi
 * @param {THREE.DirectionalLight|null} key
 * @param {THREE.AmbientLight|null} [ambient] 可选，没有就跳过
 * ---------------------------------------------------------- */
export function createDayNight({ scene, hemi, key, ambient } = {}) {
  const fog = scene && scene.fog ? scene.fog : null;

  /* 基线快照：字段非法就记 null，后面 apply 时自动跳过该项。
   * 注意克隆颜色，否则会把 scene 上那份颜色对象改掉后再当基线用。 */
  const base = {
    hemi: hemi && isNum(hemi.intensity) ? hemi.intensity : null,
    key: key && isNum(key.intensity) ? key.intensity : null,
    keyColor: key && isColor(key.color) ? key.color.clone() : null,
    ambient: ambient && isNum(ambient.intensity) ? ambient.intensity : null,
    fogNear: fog && isNum(fog.near) ? fog.near : null,
    fogFar: fog && isNum(fog.far) ? fog.far : null,
    fogColor: fog && isColor(fog.color) ? fog.color.clone() : null,
    bg: scene && isColor(scene.background) ? scene.background.clone() : null,
  };

  // p = 0 白天（完全等于基线），p = 1 夜晚（全部倍率生效）
  function applyProgress(p) {
    if (hemi && base.hemi !== null) {
      hemi.intensity = base.hemi * lerp(1, NIGHT.hemi, p);
    }
    if (key && base.key !== null) {
      key.intensity = base.key * lerp(1, NIGHT.key, p);
    }
    if (key && base.keyColor && isColor(key.color)) {
      key.color.copy(base.keyColor).lerp(NIGHT_KEY_TINT, NIGHT.tintMix * p);
    }
    if (ambient && base.ambient !== null) {
      ambient.intensity = base.ambient * lerp(1, NIGHT.ambient, p);
    }

    if (fog && base.fogNear !== null) {
      fog.near = base.fogNear * lerp(1, NIGHT.fogNear, p);
    }
    if (fog && base.fogFar !== null) {
      // far 不能被 near 反超（极端参数下保护一下，避免雾完全失效）
      const far = base.fogFar * lerp(1, NIGHT.fogFar, p);
      fog.far = isNum(fog.near) && far <= fog.near ? fog.near + 1 : far;
    }
    if (fog && base.fogColor && isColor(fog.color)) {
      // 雾色跟着变暗，否则远处还是一层亮灰，和暗背景打架
      fog.color.copy(base.fogColor).lerp(NIGHT_COLOR, NIGHT.fogMix * p);
    }
    if (scene && base.bg && isColor(scene.background)) {
      scene.background.copy(base.bg).lerp(NIGHT_COLOR, NIGHT.bgMix * p);
    }
  }

  let progress = 0; // 当前实际进度 0~1
  let target = 0; // 目标进度
  let from = 0; // 本次过渡的起点
  let elapsed = 0; // 本次过渡已用时

  /**
   * 切昼夜。
   * @param {boolean|number} night true = 夜晚，false = 白天，数字 = 0~1 的进度
   * @param {boolean} [instant] true 立即到位（切地图 / 重开时用），否则 1.6 秒过渡
   */
  function setNight(night, instant = false) {
    target = isNum(night) ? clamp01(night) : night === true ? 1 : 0;

    if (instant) {
      progress = target;
      from = target;
      elapsed = NIGHT.duration;
      applyProgress(progress);
      return;
    }

    // 从当前进度接着走，中途改主意也不会跳变
    from = progress;
    elapsed = 0;
  }

  /** 推进过渡；dt 单位秒。 */
  function update(dt) {
    if (progress === target) return;

    // 单帧最长按 0.25 秒算：切后台回来或掉帧时不要"瞬移"到终点
    const step = isNum(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    elapsed += step;

    const t = clamp01(elapsed / NIGHT.duration);
    progress = t >= 1 ? target : from + (target - from) * easeInOut(t);
    applyProgress(progress);
  }

  return {
    setNight,
    update,
    /** 0 = 白天，1 = 全黑 */
    getProgress: () => progress,
    /** 目标状态：夜里为 true（过渡途中就已算夜晚，方便逻辑同步） */
    get isNight() {
      return target >= 0.5;
    },
    /** 本项目不用销毁场景，留空以免调用方报错；真要清也是一次性页面生命周期 */
    dispose() {},
  };
}

/* ----------------------------------------------------------
 * 波次 → 昼夜
 *
 * 每 everyN 波翻一次：1~3 白天、4~6 夜晚、7~9 白天……
 * wave 不是 >=1 的数字、everyN 不是 >=1 的数字，一律按白天处理。
 * ---------------------------------------------------------- */
export function nightForWave(wave, everyN = 3) {
  if (!isNum(wave) || !isNum(everyN)) return false;

  const step = Math.floor(everyN);
  const w = Math.floor(wave);
  if (step < 1 || w < 1) return false;

  return Math.floor((w - 1) / step) % 2 === 1;
}
