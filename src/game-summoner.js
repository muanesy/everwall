/* ==========================================================
 * 召唤僵尸：召唤者每隔几秒在脚边召两只小僵尸（点子池「定期召唤小僵尸」）
 *
 * 这个模块只管"什么时候召、召在哪、上限还有没有位置"，
 * 不碰 zombies 数组、不碰渲染——真正的 push 由 game.js 接线完成。
 *
 * 用法（game.js 接线）：
 *   import { SUMMONER, createSummonerState, updateSummoner } from './game-summoner.js';
 *
 *   // 生成召唤者时（spawnZombie / 特殊刷怪）
 *   const s = { id, x, z, hp, maxHp, speed, touchLoss, type: SUMMONER.typeId, aggro: false };
 *   s.summonerState = createSummonerState();
 *   state.zombies.push(s);
 *
 *   // updateZombies 里（建议放在刷怪判断之后、移动循环之前）
 *   for (const z of state.zombies) {
 *     if (z.type !== SUMMONER.typeId || !z.summonerState) continue;
 *     const reqs = updateSummoner(z, z.summonerState, {
 *       dt,
 *       aliveCount: state.zombies.filter((o) => o.summonerId === z.id).length,
 *       isInsideArena: (x, zz) => x >= 0.6 && x <= 7.6 && zz >= -28 && zz <= CONFIG.world.killZ,
 *       newId: () => state.nextId++,
 *     });
 *     for (const r of reqs) spawnSummoned(r);   // 见文件末尾的接线说明
 *   }
 *
 * 设计要点：
 * 1. 必须给"它自己召出来的"单独设上限。不限的话每 4.5 秒 2 只，
 *    一分钟 26 只，直接吃满 CONFIG.zombie.maxAlive（120）把帧率干崩。
 * 2. 上限满了**不重置计时器**：让它一直处于"想召但没位置"的状态，
 *    一旦有宝宝死掉，下一帧立刻补，玩家看到的是源源不断而不是断档 4.5 秒。
 * 3. 半径内取点用 sqrt(rand())：直接 rand()*r 会把宝宝挤在召唤者脚下，
 *    开方之后半径上的密度才是平的（圆盘面积均匀）。
 * 4. 位置合法就返回，8 次都不行就叠回召唤者身上——
 *    宁可重叠也不能"召不出来"，否则计时器会一直空转。
 * ========================================================== */

/* 召唤者配置。调用方不要把这些数字写死在自己那边，改这里一处就够 */
export const SUMMONER = {
  typeId: 14,        // 给"召唤者"这个新僵尸类型预留的 id
  interval: 4.5,     // 每隔几秒召唤一次
  maxAlive: 6,       // 它自己召唤出来的小僵尸最多同时存在几只
  count: 2,          // 每次召几只
  radius: 2.2,       // 在自身周围多大半径内生成
  minZ: -28,         // 生成位置不能比这个更靠上（别生成到画面外）
  childType: 2,      // 召唤出来的是快鬼（id 2）
  childHpMul: 0.8,   // 小僵尸只有 80% 血量
};

/* 召唤者缺 x/z 时的兜底落点：通道中线（0.6~7.6 的正中）、画面内偏上。
 * 只在召唤者对象残缺时用到，正常流程走不到这里。 */
const FALLBACK_POS = { x: 4.1, z: -22 };

/* 找合法点最多试几次。8 次足够：通道宽 7，半径才 2.2，
 * 只要召唤者不在通道最边上，第一次基本就中。 */
const SPAWN_TRIES = 8;

/* ----------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------- */

function isObj(v) {
  return v !== null && typeof v === 'object';
}

/* 取数字并兜底：NaN / undefined / 字符串全退回 fallback，可再给下限 */
function num(value, fallback, min = -Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n;
}

/* 包一层 rand()：外部传进来的随机源可能是残缺的，也可能返回 0/1 边界值。
 * 1 会被夹到 0.999999 —— sqrt(1) 正好落在半径圆上，越界概率最大。 */
function safeRand(rand) {
  let raw;
  try {
    raw = rand();
  } catch (err) {
    raw = 0.5; // 随机源自己炸了也不能连累召唤逻辑
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 0.999999 : n;
}

/* 调 ctx.isInsideArena；没给判定就当成"哪儿都能放"，不让缺参数把召唤卡死 */
function isInside(ctx, x, z) {
  const test = ctx && ctx.isInsideArena;
  if (typeof test !== 'function') return true;
  try {
    return !!test(x, z);
  } catch (err) {
    return false;
  }
}

/* 要一个新 id。调用方的 nextId 一般就是 state.nextId++ */
function callNewId(ctx) {
  if (!ctx || typeof ctx.newId !== 'function') return null;
  try {
    const id = ctx.newId();
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    return null;
  }
}

/* 调用方可能传一个手搓的 { timer } 而不是 createSummonerState() 的返回值，
 * 这里补上集合，别让 childrenIds 缺失把整帧炸掉 */
function ensureIds(summonerState) {
  if (!(summonerState.childrenIds instanceof Set)) {
    summonerState.childrenIds = new Set();
  }
  return summonerState.childrenIds;
}

/* 这个召唤者自己的宝宝还活着几只。
 * 优先信调用方给的 aliveCount（它能真的去看 zombies 数组里还剩几只）；
 * 拿不到才退回本地 id 集合——我们只在召唤那一刻知道 id，
 * 宝宝被技能秒杀时这边收不到通知，集合会偏大。 */
function childAliveCount(summonerState, ctx) {
  if (ctx.aliveCount !== undefined && ctx.aliveCount !== null) {
    const n = Number(ctx.aliveCount);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }

  // 退路：给了存活 id 快照就顺手把已死的清出集合，别让上限被幽灵占着
  const ids = ensureIds(summonerState);
  const aliveIds = ctx.aliveIds;
  if (aliveIds && typeof aliveIds.has === 'function') {
    for (const id of ids) {
      if (!aliveIds.has(id)) ids.delete(id);
    }
  }
  return ids.size;
}

/* ----------------------------------------------------------
 * 对外接口
 * ---------------------------------------------------------- */

/* 初始化一个召唤者的运行状态 */
export function createSummonerState(rand = Math.random) {
  const roll = typeof rand === 'function' ? rand : Math.random;
  const interval = SUMMONER.interval > 0 ? SUMMONER.interval : 4.5;

  // 第一次故意错开 30%~80% 个周期：同屏好几只召唤者时不会同帧一起开口，
  // 但也不会拖到两三个周期之后才召第一次（那样玩家会以为它坏了）
  const firstDelay = interval * (0.3 + safeRand(roll) * 0.5);

  return {
    timer: firstDelay,
    childrenIds: new Set(), // 召唤者自己召出来的 id，aliveCount 缺失时的退路
    summoned: 0,            // 累计召出多少只，调参/测试用
  };
}

/* 每帧推进。到点要召唤时返回请求数组，否则返回空数组。
 * ctx = { dt, aliveCount, isInsideArena(x, z), newId() }
 * aliveCount 语义：**这只召唤者自己的**宝宝存活数（按 z.summonerId 过滤）。 */
export function updateSummoner(summoner, summonerState, ctx) {
  const requests = [];
  if (!isObj(summoner) || !isObj(summonerState) || !isObj(ctx)) return requests;

  // dt 是 NaN / 负数 / 0 时这一帧什么都不做：时间不前进就不该有召唤
  const dt = Number(ctx.dt);
  if (!Number.isFinite(dt) || dt <= 0) return requests;

  const interval = num(summoner.interval, SUMMONER.interval);
  if (!(interval > 0)) return requests; // 配成 0 或负数等于关掉，避免每帧刷满

  summonerState.timer = num(summonerState.timer, 0) + dt;
  if (summonerState.timer < interval) return requests;

  const maxAlive = Math.floor(num(summoner.maxAlive, SUMMONER.maxAlive, 0));
  const room = maxAlive - childAliveCount(summonerState, ctx);
  if (room <= 0) {
    // 满员：**故意不清计时器**。计时器继续累加，等宝宝死掉后
    // 下一帧条件满足就能立刻补两只，手感是连绵不断而不是断档一个周期
    return requests;
  }

  const count = Math.min(Math.floor(num(summoner.count, SUMMONER.count, 1)), room);
  const childType = num(summoner.childType, SUMMONER.childType);
  const hpMul = num(summoner.childHpMul, SUMMONER.childHpMul, 0);

  for (let i = 0; i < count; i++) {
    const pos = pickSpawnPos(summoner, ctx);
    const req = { x: pos.x, z: pos.z, type: childType, hpMul };

    // 带上召唤者 id，调用方写进 zombie.summonerId 之后，
    // 下一帧就能按 z.summonerId === summoner.id 精确数存活数
    if (summoner.id != null) req.summonerId = summoner.id;

    const childId = callNewId(ctx);
    if (childId != null) ensureIds(summonerState).add(childId);

    requests.push(req);
    summonerState.summoned = num(summonerState.summoned, 0) + 1;
  }

  summonerState.timer = 0;
  return requests;
}

/* 在召唤者周围找一个合法落点：不越通道、不太靠上。
 * 8 次都不合法就退回召唤者自身位置，保证一定召得出来。 */
export function pickSpawnPos(summoner, ctx, rand = Math.random) {
  const s = isObj(summoner) ? summoner : {};
  const c = isObj(ctx) ? ctx : {};
  const roll = typeof rand === 'function' ? rand : Math.random;

  // 召唤者坐标残缺时用通道中线的兜底点，而不是直接返回 NaN
  const sx = Number(s.x);
  const sz = Number(s.z);
  const cx = Number.isFinite(sx) ? sx : FALLBACK_POS.x;
  const cz = Number.isFinite(sz) ? sz : FALLBACK_POS.z;

  const radius = num(s.radius, SUMMONER.radius, 0);
  const minZ = num(s.minZ, SUMMONER.minZ);

  if (radius > 0) {
    for (let i = 0; i < SPAWN_TRIES; i++) {
      const angle = safeRand(roll) * Math.PI * 2;
      // sqrt 让半径上的密度变平（圆盘面积均匀）；直接 rand()*radius 会挤在中心
      const dist = radius * Math.sqrt(safeRand(roll));
      const x = cx + Math.cos(angle) * dist;
      const z = cz + Math.sin(angle) * dist;

      if (z < minZ) continue;      // 太靠上会刷到画面外，玩家看不见就白扣兵
      if (isInside(c, x, z)) return { x, z };
    }
  }

  // 兜底：召唤者贴在通道边上（或半径配得比通道还宽）时，
  // 8 次都可能不合法。叠在身上虽然不好看，但比"召不出来"强
  return { x: cx, z: cz };
}
