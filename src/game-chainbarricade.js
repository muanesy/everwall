/* ==========================================================
 * 锁链路障：挡住半边通道，僵尸必须绕过去（点子池「锁链路障」）
 *
 * 和 CONFIG.barricade 的横墙是两回事：
 *   - 横墙：整条挡住，僵尸停下啃，墙有血量、会碎、会重建（消耗战）
 *   - 锁链：只挡半边、不可破坏，僵尸从空着的半边绕过去（纯寻路）
 * 所以这个模块里没有任何 hp 字段，也不需要伤害结算。
 *
 * 坐标沿用全局约定：僵尸从 z=-30 往 +z 走，右侧通道 x ∈ [0.6, 7.6]。
 *
 * game.js 接线（三段，都在 updateZombies 里）：
 *
 *   1) 文件顶部 import：
 *        import {
 *          createChain, isBlockedByChain, chainDetour, updateChain,
 *        } from './game-chainbarricade.js';
 *
 *   2) 建链（resetState / 切时代时重建，存进 state）：
 *        state.chain = createChain({ x: 2.2, z: -5, width: 3.2 });
 *      // 宽度别给满 7.0，给满了 chainDetour 会返回 dir=0（当墙处理）
 *
 *   3) updateZombies(dt) 里：
 *      a. 刷怪那段之后、`for (const z of state.zombies)` 之前加一行
 *           if (state.chain) updateChain(state.chain, dt);
 *
 *      b. 循环体里，把追人那两行（写本文件时在 2377 行；game.js 还在改，
 *         行号会漂，直接搜 `z.aggro && Math.abs(dx)` 更稳）
 *           if (z.aggro && Math.abs(dx) > 0.12) {
 *             z.x += Math.sign(dx) * CONFIG.zombie.turnSpeed * dt;
 *           }
 *         改成"绕链优先，否则追人"：
 *           const detour = chainDetour(state.chain, z.x, z.z);
 *           if (detour.dir !== 0) {
 *             z.x += detour.dir * CONFIG.zombie.turnSpeed * dt;
 *           } else if (z.aggro && Math.abs(dx) > 0.12) {
 *             z.x += Math.sign(dx) * CONFIG.zombie.turnSpeed * dt;
 *           }
 *         必须互斥：两个力同时加会互相抵消，僵尸会贴着链子原地磨。
 *
 *      c. 循环体末尾、`z.x = clamp(...)`（同上，约 2413 行）之前加"撞链不穿模"：
 *           if (isBlockedByChain(state.chain, z.x, z.z)) {
 *             z.z = Math.min(z.z, state.chain.nearZ);
 *           }
 *         这样它会停在链子外沿，靠 b 段的横向推力慢慢蹭出去。
 *         nearZ 是模块算好的停线（已含僵尸半径），别自己再减一次。
 * ========================================================== */

/* ----------------------------------------------------------
 * 可调常量
 * ---------------------------------------------------------- */

// 右侧通道，和 CONFIG.world.rightZone 保持一致，
// 这里复制一份是为了让模块能单独测试（不 import game.js 的 CONFIG）
const DEFAULT_LANE = [0.6, 7.6];

// 僵尸身板半径。判定带按「半厚 + 半径」算，这样僵尸贴到链子边缘就停下，
// 不会出现视觉上半个身子插进链条的情况
const ZOMBIE_RADIUS = 0.35;

// 锁链带厚度。太薄（<0.3）高帧率下会一步跨过去，太厚看着就不像链子了
const DEFAULT_THICKNESS = 0.8;

// 绕到链子外沿之后还要再让开的余量。
// 要大于 ZOMBIE_RADIUS：光"刚好越过边缘"在视觉上还是蹭着的
const DETOUR_MARGIN = 0.5;

// 正中死区：落在离中心线这么近的范围内统一按"往右绕"处理。
// 不做死区的话，僵尸被 separation 推一下就越过中线，方向跟着翻面，
// 表现就是贴着链子左右横跳
const CENTER_DEAD_ZONE = 0.2;

let nextChainId = 1;

/* ----------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------- */

function isFin(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/* 从 x / width 重算几条派生线。
 * 存在的意义：调用方可能改 width（比如"链子越用越长"），
 * 只要它改完调一次 updateChain 或者重建，边界就是同步的。 */
function syncBounds(chain) {
  const halfW = chain.width / 2;
  const halfBand = chain.thickness / 2 + ZOMBIE_RADIUS;
  chain.xMin = chain.x - halfW;
  chain.xMax = chain.x + halfW;
  chain.nearZ = chain.z - halfBand; // 僵尸从 -z 方向来，停在近端
  chain.farZ = chain.z + halfBand;  // 绕过之后从这里出去
  return chain;
}

/* ----------------------------------------------------------
 * 1. 创建锁链
 *
 * cfg: {
 *   x        锁链中心 x，默认通道正中
 *   z        锁链所在纵深，默认 -6（在横墙 z=0 之前，先绕链再啃墙）
 *   width    覆盖宽度，默认通道的一半（3.5）
 *   thickness 可选，默认 0.8
 *   laneMin / laneMax 可选，默认 [0.6, 7.6]
 *   alpha    可选，基础不透明度，默认 1
 * }
 * 返回普通对象（仓库风格：工厂函数 + 普通对象，不用 class）。
 * 注意：x / width 建好后当只读用。要做晃动动画请读 chain.wobble，
 * 别直接改 chain.x，否则边界和画面会对不上。
 * ---------------------------------------------------------- */
export function createChain(cfg = {}) {
  const laneMin = isFin(cfg.laneMin) ? cfg.laneMin : DEFAULT_LANE[0];
  const laneMax = isFin(cfg.laneMax) ? cfg.laneMax : DEFAULT_LANE[1];
  const laneWidth = Math.max(0, laneMax - laneMin);

  // 宽度缺省给一半通道，正好是"挡半边"的设定
  const width = isFin(cfg.width) && cfg.width > 0 ? cfg.width : laneWidth * 0.5;
  const x = isFin(cfg.x) ? cfg.x : (laneMin + laneMax) / 2;
  const z = isFin(cfg.z) ? cfg.z : -6;
  const thickness =
    isFin(cfg.thickness) && cfg.thickness > 0 ? cfg.thickness : DEFAULT_THICKNESS;

  const chain = {
    id: nextChainId++,
    x,
    z,
    width,
    thickness,
    laneMin,
    laneMax,
    // 只给画面用的字段，碰撞判定完全不读，避免"看着在闪其实撞得上"的割裂
    alpha: 1,
    alphaBase: isFin(cfg.alpha) ? clamp(cfg.alpha, 0, 1) : 1,
    age: 0,
    wobble: 0,
  };

  return syncBounds(chain);
}

/* ----------------------------------------------------------
 * 2. 这个点是不是被锁链挡住
 *
 * 判定就是一条横带：z 方向离链子中心小于「半厚 + 半径」，
 * 且 x 落在 [xMin, xMax] 内。
 * 不合法输入一律当"没挡住"——僵尸照常走远好过整局卡死。
 * ---------------------------------------------------------- */
export function isBlockedByChain(chain, x, z) {
  if (!chain || !isFin(x) || !isFin(z)) return false;
  if (!isFin(chain.x) || !isFin(chain.z) || !isFin(chain.width)) return false;

  const halfBand = chain.thickness / 2 + ZOMBIE_RADIUS;
  if (Math.abs(z - chain.z) >= halfBand) return false;

  return x >= chain.xMin && x <= chain.xMax;
}

/* ----------------------------------------------------------
 * 3. 该往哪边绕
 *
 * 返回 { dir, targetX }：
 *   dir = -1 往左（x 减小）/ 0 直接走 / 1 往右
 *   targetX 是绕过之后该去的 x（已在通道内，含余量）
 *
 * 选边规则，按优先级：
 *   a. 已经越过链子（z > chain.z）      → 0
 *   b. x 已经在链子外侧（不需要绕）      → 0，最多顺势再让开一点
 *   c. 近侧被通道边界堵死（没地方站）    → 改绕远侧
 *   d. 两侧都进不去（链子铺满通道）      → 0，交给调用方当墙处理
 *   e. 否则就近绕；正中（含死区）统一往右
 * ---------------------------------------------------------- */
export function chainDetour(chain, x, z) {
  // 环境不合法时不抛错：dir=0 让僵尸照直走，比崩掉整帧好排查
  if (!chain || !isFin(x) || !isFin(z)) {
    return { dir: 0, targetX: isFin(x) ? x : 0 };
  }
  if (!isFin(chain.x) || !isFin(chain.z) || !isFin(chain.width)) {
    return { dir: 0, targetX: x };
  }

  // 已经走过去了，不用再绕（也避免刚过链子又被往回拽）
  if (z > chain.z) return { dir: 0, targetX: x };

  const laneMin = isFin(chain.laneMin) ? chain.laneMin : DEFAULT_LANE[0];
  const laneMax = isFin(chain.laneMax) ? chain.laneMax : DEFAULT_LANE[1];
  const leftEdge = chain.x - chain.width / 2;
  const rightEdge = chain.x + chain.width / 2;

  // 两侧落点：外沿再让 DETOUR_MARGIN
  const leftTarget = leftEdge - DETOUR_MARGIN;
  const rightTarget = rightEdge + DETOUR_MARGIN;

  // 落点必须还在通道里，否则就是"绕了也站不住"
  const canLeft = leftTarget >= laneMin;
  const canRight = rightTarget <= laneMax;

  // 已经在链子左侧：还能往左就继续往左，绝不往回拐——
  // 往回拐会一头撞回链子上，比不绕更糟
  if (x < leftEdge) {
    if (canLeft) {
      if (x > leftTarget) {
        return { dir: -1, targetX: clamp(leftTarget, laneMin, laneMax) };
      }
      return { dir: 0, targetX: x };
    }
    // 左边压根没缝（链子贴到通道左界），身子还压着链子边缘的只能整体挪到右边。
    // 起步时 z 还在链子前面，横向穿过 x 范围是安全的
    if (canRight) {
      return { dir: 1, targetX: clamp(rightTarget, laneMin, laneMax) };
    }
    return { dir: 0, targetX: x };
  }

  // 已经在链子右侧，同理
  if (x > rightEdge) {
    if (canRight) {
      if (x < rightTarget) {
        return { dir: 1, targetX: clamp(rightTarget, laneMin, laneMax) };
      }
      return { dir: 0, targetX: x };
    }
    if (canLeft) {
      return { dir: -1, targetX: clamp(leftTarget, laneMin, laneMax) };
    }
    return { dir: 0, targetX: x };
  }

  // x 在锁链覆盖范围内，但两边都没有立足之地 = 整条通道被铺满
  if (!canLeft && !canRight) return { dir: 0, targetX: x };

  // 就近选边。死区内的（含正中）算右侧，保证同一位置反复调用结果一致
  let goLeft = x < chain.x - CENTER_DEAD_ZONE;
  if (goLeft && !canLeft) goLeft = false;
  else if (!goLeft && !canRight) goLeft = true;

  return {
    dir: goLeft ? -1 : 1,
    targetX: clamp(goLeft ? leftTarget : rightTarget, laneMin, laneMax),
  };
}

/* ----------------------------------------------------------
 * 4. 每帧更新（只动画面，不动碰撞）
 *
 * 锁链设定上不可破坏，所以这里不做消失/重建，只让 alpha 和 wobble 呼吸。
 * alpha 下限压在 0.78：链子永远不会淡到看不见，
 * 不然会出现"画面没链子了但僵尸还在绕"的怪事。
 * ---------------------------------------------------------- */
export function updateChain(chain, dt) {
  if (!chain) return chain;
  syncBounds(chain);

  // dt 可能是 0（暂停）或 NaN（首帧），都不该让 age 变成垃圾值
  if (!isFin(dt) || dt <= 0) return chain;

  chain.age += dt;

  // 两个节奏叠在一起：慢的是金属反光呼吸，快的是链节被风带动的轻晃
  const breathe = 0.5 + 0.5 * Math.sin(chain.age * 1.35);
  const base = isFin(chain.alphaBase) ? chain.alphaBase : 1;
  chain.alpha = base * (0.78 + 0.22 * breathe);
  chain.wobble = Math.sin(chain.age * 2.3) * 0.06;

  return chain;
}
