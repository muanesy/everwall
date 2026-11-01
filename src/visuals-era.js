/* ==========================================================
 * 时代皮肤：换时代就换一套配色（乙负责，纯外观）
 *
 * 用法（visuals.js 接线）：
 *   import { ERAS, eraForWave, getEra, applyEraLook } from './visuals-era.js';
 *
 *   // 每波开始时
 *   const era = getEra(eraForWave(wave));
 *   applyEraLook(era, { soldierMats, zombieMats, bulletMats });
 *
 * 设计要点：
 * 1. 六个时代对应队长定的六张地图（中世纪=丛林、二战=城市、现代=沙漠、
 *    后现代=雪地、星际=月球、终幕=熔岩），见 docs/点子池.md「时代与地图」。
 * 2. 只改颜色，不改任何数值——伤害、速度、扣兵都是甲那边的事。
 * 3. tint 是「乘色」不是「赋色」：所有材质都先还原基准色再乘，
 *    否则来回切时代颜色会越乘越偏（这个坑在僵尸乘色上踩过一次）。
 * 4. 灯光和雾不在这个模块里管：昼夜轮转（visuals-daynight.js）已经
 *    抓了基线并在切昼夜时改写灯光雾，两边同时改会打架。
 *    等队长做时代切换（换图 + 重建场景）时再统一整合。
 * ========================================================== */

import * as THREE from 'three';

/* 每个时代的配色方案
 * soldierTint 士兵乘色、zombieTint 僵尸乘色、bulletTint 子弹/曳光色
 * ambient     环境基调（给以后接雾和背景留的接口，现在不生效）
 * props       这个时代该有的背景物关键词（以后换时代时替换背景物用）
 * desc        一句话说明 */
export const ERAS = [
  {
    id: 0,
    name: '中世纪',
    map: 'jungle',
    soldierTint: [1.12, 0.95, 0.62],   // 土黄麻衣
    zombieTint: [1.05, 1.00, 0.88],    // 灰白麻布
    bulletTint: [1.0, 0.80, 0.45],     // 火药暖黄
    ambient: [0.62, 0.60, 0.44],
    props: ['wooden_post', 'barrel', 'campfire', 'cart'],
    desc: '中世纪：麻衣火药，僵尸是干瘦的村民',
  },
  {
    id: 1,
    name: '二战',
    map: 'city',
    soldierTint: [0.58, 0.70, 1.00],   // 深蓝灰军服
    zombieTint: [1.00, 0.78, 0.62],    // 暗褐旧军装
    bulletTint: [1.0, 0.60, 0.30],     // 橙红曳光
    ambient: [0.44, 0.48, 0.56],
    props: ['rubble', 'sandbag', 'streetlight', 'barrel'],
    desc: '二战：军服与废墟，僵尸是穿着旧军装的老兵',
  },
  {
    id: 2,
    name: '现代',
    map: 'desert',
    soldierTint: [0.92, 1.05, 0.60],   // 橄榄军绿
    zombieTint: [0.72, 0.86, 0.95],    // 青灰战术装
    bulletTint: [0.95, 1.0, 0.95],     // 亮白曳光
    ambient: [0.70, 0.64, 0.46],
    props: ['sandbag', 'barrel', 'wire', 'jeep_wreck'],
    desc: '现代：战术装备，僵尸是穿防弹衣的暴徒',
  },
  {
    id: 3,
    name: '后现代',
    map: 'snow',
    soldierTint: [0.60, 0.78, 0.92],   // 冷灰战术
    zombieTint: [0.80, 0.92, 1.00],    // 白化感染体
    bulletTint: [0.80, 0.92, 1.0],     // 冷白
    ambient: [0.58, 0.66, 0.76],
    props: ['ice_spike', 'container', 'antenna', 'crane'],
    desc: '后现代：生化实验体，全场偏冷',
  },
  {
    id: 4,
    name: '星际',
    map: 'moon',
    soldierTint: [0.45, 0.85, 1.05],   // 冷青金属
    zombieTint: [0.80, 0.60, 1.05],    // 紫黑荧光
    bulletTint: [0.55, 0.85, 1.0],     // 青紫能量
    ambient: [0.34, 0.40, 0.56],
    props: ['crater', 'antenna', 'module', 'rover'],
    desc: '星际：太空装与外星感染体',
  },
  {
    id: 5,
    name: '终幕',
    map: 'lava',
    soldierTint: [1.10, 0.48, 0.38],   // 墨黑赤纹
    zombieTint: [1.10, 0.50, 0.40],    // 熔岩缝合体
    bulletTint: [1.0, 0.45, 0.30],     // 赤金
    ambient: [0.54, 0.28, 0.24],
    props: ['lava_crack', 'spire', 'charred_bone', 'obelisk'],
    desc: '终幕：熔岩与黑甲，最后的战场',
  },
];

/* 每 N 波进一个时代（第 1-5 波中世纪，6-10 波二战，11-15 波现代……循环） */
export function eraForWave(wave, everyEraWaves = 5) {
  const n = Number(wave);
  const step = Number(everyEraWaves);
  if (!Number.isFinite(n) || n < 1) return 0;
  if (!Number.isFinite(step) || step < 1) return 0;
  const index = Math.floor((n - 1) / step) % ERAS.length;
  return index;
}

export function getEra(eraIndex) {
  const i = Number.isFinite(eraIndex) ? Math.floor(eraIndex) : 0;
  return ERAS[((i % ERAS.length) + ERAS.length) % ERAS.length];
}

/* 每个材质记住自己的基准色，换时代时从基准色重新乘，不做二次叠加 */
const baseColors = new WeakMap(); // material -> { color, emissive }

function rememberBase(mat) {
  if (!mat || !mat.color || baseColors.has(mat)) return baseColors.get(mat) || null;
  const rec = {
    color: mat.color.clone(),
    emissive: mat.emissive ? mat.emissive.clone() : null,
  };
  baseColors.set(mat, rec);
  return rec;
}

/* 把一组材质统一乘上某个 tint */
export function tintMaterials(mats, tint) {
  if (!Array.isArray(mats) || !tint) return;
  const t = new THREE.Color(tint[0], tint[1], tint[2]);
  for (const mat of mats) {
    if (!mat || !mat.color) continue;
    const base = rememberBase(mat);
    if (!base) continue;
    mat.color.copy(base.color).multiply(t);
    if (base.emissive && mat.emissive) {
      mat.emissive.copy(base.emissive);
    }
  }
}

/* 把一个时代的配色套到目标上
 * targets = { soldierMats: [], zombieMats: [], bulletMats: [] }
 * 每个字段都容错：不存在或类型不对直接跳过，绝不抛异常。 */
export function applyEraLook(era, targets) {
  if (!era || !targets) return;
  const t = targets;

  // 士兵：时代乘色 × 兵种档位乘色由 visuals.js 那边负责叠加，
  // 这里只负责时代这一层，所以由调用方先还原基准再连续乘。
  tintMaterials(t.soldierMats, era.soldierTint);
  tintMaterials(t.zombieMats, era.zombieTint);
  tintMaterials(t.bulletMats, era.bulletTint);

  // 自发光微调：精英僵尸（emissive>0）在别的时代里略微收一点，避免夜里太扎眼
  if (Array.isArray(t.zombieMats)) {
    for (const mat of t.zombieMats) {
      if (!mat || !mat.emissive) continue;
      const base = rememberBase(mat);
      if (!base || !base.emissive) continue;
      const e = base.emissive.r + base.emissive.g + base.emissive.b;
      if (e <= 0.001) continue;
      const k = era.id >= 4 ? 0.55 : 1.0;   // 星际之后自发光压暗一点
      mat.emissive.copy(base.emissive).multiplyScalar(k);
    }
  }
}
