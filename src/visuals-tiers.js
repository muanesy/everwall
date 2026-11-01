/* ----------------------------------------------------------
 * 兵种阶级：外观数据表 + 查表工具（乙负责）
 *
 * 分工：玩法侧（甲，game.js）按士兵总数决定伤害/射速加成；
 * 这里只回答"这队兵现在该长什么样"——色块回退的颜色、
 * 真模型的乘色、体型倍率、一点自发光、HUD 点缀色。
 * 门槛数值只是外观档位，真正加成的数值在甲那边，别往这加。
 *
 * 用法（visuals.js）：
 *   import { getTier, tierProgress } from './visuals-tiers.js';
 *   const tier = getTier(state.soldiers);
 *   soldierMesh.material.color.setHex(tier.color);      // 方块回退的颜色
 *   dummy.scale.setScalar(tier.scale);                   // 写进实例矩阵的体型
 *   真模型：material.color.multiply(tier.tint 组成的 Color)
 *          material.emissiveIntensity = tier.emissive
 *   HUD 名牌：el.style.color = tier.accent
 *
 * 门槛跟 docs/点子池.md 对齐：5 个兵 = 保安，20 = 正规军，50 = 特种兵。
 * 开局就是 5 个兵，所以开局即"保安"；掉到 5 以下没有更低档，
 * 仍旧按保安画（宁可视作"空编保安队"，也不多造一档）。
 * ---------------------------------------------------------- */

export const TIERS = [
  {
    id: 0,
    name: '保安',
    threshold: 5,
    // 橄榄绿：一眼就是新兵/临时工，跟后面的制式色拉开
    color: 0x8d9257,
    // 乘色比 1 小、黄绿味重一些。模型本身有肤色和装备色，乘得温和点，别染成单色块
    tint: [0.96, 1.0, 0.74],
    scale: 1.0,
    emissive: 0,
    accent: '#c7cf82',
  },
  {
    id: 1,
    name: '正规军',
    threshold: 20,
    // 深蓝灰：制式感。刻意比夜城底色(0x0b0f14)亮一档，暗场里还能读出轮廓
    color: 0x4d7196,
    tint: [0.74, 0.84, 1.02],
    scale: 1.06,
    emissive: 0,
    accent: '#8fb6e0',
  },
  {
    id: 2,
    name: '特种兵',
    threshold: 50,
    // 墨黑偏钢灰 + 青蓝点缀：纯黑在夜景里会糊成一团，所以回退色留一点灰
    color: 0x46545c,
    tint: [0.66, 0.72, 0.78],
    scale: 1.12,
    emissive: 0.04, // 精锐在暗场里有一点存在感就够了，别亮成霓虹灯
    accent: '#35e6d8',
  },
];

const TOP = TIERS.length - 1;

// 兵数先过一遍：NaN/负数/非数字都当 0，小数取整（HUD 用不到小数兵）
function toCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

// 0 个兵返回 0；到 20 升正规军、到 50 升特种兵，满级后停在 2
export function getTierIndex(soldierCount) {
  const count = toCount(soldierCount);
  for (let i = TOP; i > 0; i--) {
    if (count >= TIERS[i].threshold) return i;
  }
  return 0; // 0~19 个兵都按保安
}

export function getTier(soldierCount) {
  return TIERS[getTierIndex(soldierCount)];
}

// 给 HUD 的「距离下一阶还差 N 个兵」：
//   index   当前档下标
//   current 当前档的门槛
//   next    下一档门槛（已满级为 null）
//   need    还差几个兵升级（已满级为 0）
//   ratio   本档内的进度 0~1（已满级为 1），直接喂进度条宽度
export function tierProgress(soldierCount) {
  const count = toCount(soldierCount);
  const index = getTierIndex(count);
  const nextTier = TIERS[index + 1] || null;

  if (!nextTier) {
    return { index, current: TIERS[index].threshold, next: null, need: 0, ratio: 1 };
  }

  // 保安这档从 0 个兵算起（没有更低的档），其余档从自己门槛算起
  const base = index === 0 ? 0 : TIERS[index].threshold;
  const span = Math.max(1, nextTier.threshold - base);
  const ratio = Math.min(1, Math.max(0, (count - base) / span));

  return {
    index,
    current: TIERS[index].threshold,
    next: nextTier.threshold,
    need: Math.max(0, nextTier.threshold - count),
    ratio,
  };
}
