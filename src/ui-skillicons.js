/* ==========================================================
 * 技能图标（乙负责）
 *
 * 对应 docs/美术需求-槽位与技能.md 的「P2 界面」：30 个一次性技能图标，
 * 左侧技能栏现在是纯文字。
 *
 * 为什么用内联 SVG 而不是 PNG：
 *   1. 30 个技能 × 多套主题 = 一堆位图，还要管 retina 和预加载
 *   2. 图标本身是"符号"，不是"插画"——线条 + 单色填充就够读
 *   3. 内联 SVG 能直接吃 `currentColor` 和 `--skill-color`，换色不用重出图
 *   4. 项目约定"演示现场断网能打开"，零外部资源最稳
 *
 * 设计规则（保证 30 个图标看起来像一套）：
 *   - 统一 24×24 viewBox，线宽 1.8，圆头线帽
 *   - 只用两种色：技能主色（描边 + 主要形状）+ 白色高光（少量）
 *   - 不画细碎纹理，缩到 44px 还要能认出来
 * ========================================================== */

/* 每个图标是一个返回 <path>/<circle> 等内容的函数，颜色由外部变量控制。
 * 用 `currentColor` 表示"跟随技能色"，`#fff` 只用于必须提亮的细节。 */

const ICONS = {
  /* ---- 中世纪 ---- */
  // 箭雨：三支斜下的箭 + 地面
  arrowRain: `
    <path d="M6 3v9M6 12l-1.8-2.2M6 12l1.8-2.2" />
    <path d="M12 2v10M12 12l-1.8-2.2M12 12l1.8-2.2" />
    <path d="M18 3v9M18 12l-1.8-2.2M18 12l1.8-2.2" />
    <path d="M3 19h18" opacity=".55" />`,

  // 滚木：圆柱 + 滚动弧线
  rollingLog: `
    <rect x="4" y="9" width="16" height="7" rx="3.5" />
    <path d="M9 9v7M15 9v7" opacity=".5" />
    <path d="M3.5 20c2-1.6 4-1.6 6 0M14.5 20c2-1.6 4-1.6 6 0" />`,

  // 圣水：水滴 + 光环
  holyWater: `
    <path d="M12 3c3.4 4 5.5 6.8 5.5 9.5a5.5 5.5 0 0 1-11 0C6.5 9.8 8.6 7 12 3z" />
    <path d="M9.2 13.2c0 1.6 1.2 2.8 2.8 2.8" opacity=".6" />
    <circle cx="12" cy="12.5" r="9.5" opacity=".22" />`,

  // 骑士冲锋：长枪 + 马头剪影
  knightCharge: `
    <path d="M3 17.5L20 6.5" />
    <path d="M17 5l3.5 1.2-1.4 3.4" />
    <path d="M6.5 20.5c0-2.6 1.7-4.6 4-5.4M11 20.5h-5" />
    <circle cx="8.2" cy="10.6" r="1.6" />`,

  // 篝火：柴堆 + 三层火苗
  campfire: `
    <path d="M12 3.5c2.6 3 4.2 5 4.2 7.2A4.2 4.2 0 0 1 12 15a4.2 4.2 0 0 1-4.2-4.3C7.8 8.5 9.4 6.5 12 3.5z" />
    <path d="M12 8.2c1.1 1.3 1.8 2.2 1.8 3.3a1.8 1.8 0 1 1-3.6 0c0-1.1.7-2 1.8-3.3z" opacity=".7" />
    <path d="M4.5 19.5l15-2.5M4.5 17l15 2.5" />`,

  /* ---- 二战 ---- */
  // 空袭：轰炸机 + 落弹
  airStrike: `
    <path d="M2.5 9.5l9-2.6v-3l2-.6 1.4 3.2 6.6-.4v2l-6.6 1.6-1.4 3.2-2-.6v-2.4z" />
    <path d="M7 15.5v3M12 16.5v3.5M17 15.5v3" opacity=".7" />`,

  // 炮火覆盖：三门炮 + 弹道弧
  barrage: `
    <path d="M4 20V13M12 20V11M20 20V13" />
    <path d="M4 13l-1.6-2M12 11l-1.6-2M20 13l-1.6-2" opacity=".6" />
    <path d="M6.5 8.5c2.5-3 8.5-3 11 0" opacity=".6" />
    <circle cx="4" cy="20" r="1.3" /><circle cx="12" cy="20" r="1.3" /><circle cx="20" cy="20" r="1.3" />`,

  // 燃烧弹：带火焰尾的炸弹
  napalm: `
    <ellipse cx="13" cy="14" rx="5" ry="6.5" />
    <path d="M13 7.5V4" />
    <path d="M10 4.5l1.5-2M16 4.5l-1.5-2" opacity=".6" />
    <path d="M6 9c-1.6 1.6-2 3.4-1 5" opacity=".6" />`,

  // 伞兵增援：降落伞 + 人
  paratroopers: `
    <path d="M4 10a8 8 0 0 1 16 0z" />
    <path d="M12 10v3.5M7 10l5 3.5M17 10l-5 3.5" opacity=".7" />
    <circle cx="12" cy="16.6" r="1.7" />
    <path d="M12 18.4v3M10 21.4h4" />`,

  // 坦克支援：车体 + 炮塔 + 履带
  tank: `
    <rect x="3" y="14" width="18" height="5" rx="2.5" />
    <rect x="8" y="9.5" width="7" height="4.5" rx="1.2" />
    <path d="M15 11.4h6" />
    <circle cx="7" cy="16.5" r="1.1" opacity=".5" />
    <circle cx="12" cy="16.5" r="1.1" opacity=".5" />
    <circle cx="17" cy="16.5" r="1.1" opacity=".5" />`,

  /* ---- 现代 ---- */
  // 精确打击：准星 + 十字线
  precision: `
    <circle cx="12" cy="12" r="6.2" />
    <circle cx="12" cy="12" r="1.6" />
    <path d="M12 2v4.2M12 17.8V22M2 12h4.2M17.8 12H22" />`,

  // 无人机蜂群：三架小四轴
  droneSwarm: `
    <path d="M7.5 6.5l2.2 2.2M16.5 6.5l-2.2 2.2M12 12v1" opacity=".8" />
    <rect x="9.5" y="9.5" width="5" height="4" rx="1" />
    <circle cx="6.5" cy="5.5" r="1.6" /><circle cx="17.5" cy="5.5" r="1.6" />
    <rect x="2.5" y="16" width="4" height="3" rx="1" />
    <circle cx="1.5" cy="13.8" r="1.2" /><circle cx="7.5" cy="13.8" r="1.2" />
    <rect x="17.5" y="16" width="4" height="3" rx="1" />
    <circle cx="16.5" cy="13.8" r="1.2" /><circle cx="22.5" cy="13.8" r="1.2" />`,

  // 电磁脉冲：同心弧 + 中心点
  emp: `
    <circle cx="12" cy="12" r="2" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4" />
    <path d="M4.8 4.8a10.2 10.2 0 0 0 0 14.4M19.2 4.8a10.2 10.2 0 0 1 0 14.4" opacity=".5" />`,

  // 装甲车冲锋：轮式车体 + 机枪
  apc: `
    <path d="M2.5 16.5V11l4-3h9l3.5 4v4.5z" />
    <path d="M6.5 8v4.5" opacity=".5" />
    <circle cx="7" cy="17.6" r="2" /><circle cx="16.5" cy="17.6" r="2" />
    <path d="M13 8V4.5h3" />`,

  // 空投补给：箱 + 伞
  supplyDrop: `
    <path d="M5 8.5a7 7 0 0 1 14 0z" />
    <path d="M12 8.5v2.2M8.5 8.5l3.5 2.2M15.5 8.5L12 10.7" opacity=".7" />
    <rect x="7.5" y="13" width="9" height="7.5" rx="1" />
    <path d="M7.5 16.4h9M12 13v7.5" opacity=".6" />`,

  /* ---- 后现代 ---- */
  // 病毒炸弹：罐体 + 毒雾泡
  virusBomb: `
    <rect x="8.5" y="7" width="7" height="13" rx="3" />
    <path d="M10.5 7V5h3v2" opacity=".7" />
    <circle cx="5" cy="12" r="1.5" opacity=".6" /><circle cx="19.2" cy="10.4" r="1.2" opacity=".6" />
    <circle cx="5.6" cy="17" r="1" opacity=".4" /><circle cx="18.6" cy="16.6" r="1.6" opacity=".4" />`,

  // 生物人军团：三个小人排开
  bioLegion: `
    <circle cx="6" cy="7.5" r="2" /><path d="M6 10v6M3.6 19l2.4-3 2.4 3" />
    <circle cx="12" cy="6" r="2.4" /><path d="M12 8.8v7M9 19l3-3.6 3 3.6" />
    <circle cx="18.2" cy="7.5" r="2" /><path d="M18.2 10v6M15.8 19l2.4-3 2.4 3" />`,

  // 基因爆发：双螺旋
  geneBurst: `
    <path d="M8 3c0 5 8 5 8 10s-8 5-8 8" />
    <path d="M16 3c0 5-8 5-8 10s8 5 8 8" opacity=".7" />
    <path d="M8.6 7.5h6.8M8.6 12h6.8M8.6 16.5h6.8" opacity=".5" />`,

  // 时间减速：沙漏 + 慢速刻度
  timeSlow: `
    <path d="M6.5 3h11M6.5 21h11" />
    <path d="M8 3v3.2L12 11l4-4.8V3M8 21v-3.2L12 13l4 4.8V21" />
    <circle cx="12" cy="12" r="9.6" opacity=".16" />`,

  // 记忆植入：卡牌 + 芯片
  memory: `
    <rect x="4" y="6" width="12" height="15" rx="1.6" transform="rotate(-8 10 13.5)" />
    <rect x="12" y="4.6" width="8" height="8" rx="1.2" opacity=".8" />
    <path d="M14.5 4.6V2.5M17.5 4.6V2.5M14.5 12.6v2M17.5 12.6v2" opacity=".6" />`,

  /* ---- 星际 ---- */
  // 轨道轰炸：垂直光柱 + 地面环
  orbital: `
    <path d="M12 2.2v13" stroke-width="3.4" opacity=".35" />
    <path d="M12 2.2v13" />
    <ellipse cx="12" cy="18" rx="7.5" ry="2.6" />
    <ellipse cx="12" cy="18" rx="3.6" ry="1.2" opacity=".6" />`,

  // 黑洞：吸积盘 + 弧
  blackHole: `
    <circle cx="12" cy="12" r="3.4" />
    <ellipse cx="12" cy="12" rx="9.4" ry="3.4" transform="rotate(-18 12 12)" opacity=".8" />
    <path d="M3.6 15.6a9.6 9.6 0 0 0 16.8 0" opacity=".45" />`,

  // 虫洞：两个嵌套椭圆 + 虚线
  wormhole: `
    <ellipse cx="12" cy="12" rx="9" ry="6" />
    <ellipse cx="12" cy="12" rx="4.6" ry="3" opacity=".7" />
    <path d="M3.4 9.2c1.4 1.4 3 2.1 5 2.1M20.6 14.8c-1.4-1.4-3-2.1-5-2.1" opacity=".5" />`,

  // 舰载无人机群：航母甲板 + 四架
  carrierDrones: `
    <path d="M2.5 19h19" />
    <path d="M6 19V15h3v4M15 19V15h3v4" opacity=".6" />
    <circle cx="7.5" cy="9" r="1.5" /><path d="M4.6 9h5.8" opacity=".8" />
    <circle cx="16.5" cy="9" r="1.5" /><path d="M13.6 9h5.8" opacity=".8" />
    <circle cx="12" cy="4.6" r="1.3" /><path d="M9.6 4.6h4.8" opacity=".8" />`,

  // 时间膨胀：钟面 + 拖影
  timeDilation: `
    <circle cx="13.5" cy="12" r="6.6" />
    <path d="M13.5 8.4V12l2.6 1.8" />
    <path d="M6.4 6.6C4.6 8.2 3.6 10.4 3.6 12.6c0 2.2 1 4.2 2.8 5.8" opacity=".4" />`,

  /* ---- 终幕 ---- */
  // 终焉审判：天平 + 光
  finalJudgment: `
    <path d="M12 3v16M6 20h12" />
    <path d="M4.5 8h15" />
    <path d="M4.5 8l-2 4.6a3 3 0 0 0 5.8 0zM19.5 8l-2 4.6a3 3 0 0 0 5.8 0z" opacity=".8" transform="translate(-1.4 0)" />`,

  // 宇宙坍缩：向心箭头
  cosmicCollapse: `
    <circle cx="12" cy="12" r="2.6" />
    <path d="M12 2.5v4.4M12 21.5v-4.4M2.5 12h4.4M21.5 12h-4.4" />
    <path d="M12 6.9l-1.5 1.5M12 6.9l1.5 1.5M12 17.1l-1.5-1.5M12 17.1l1.5-1.5" opacity=".7" />
    <path d="M6.9 12l1.5-1.5M6.9 12l1.5 1.5M17.1 12l-1.5-1.5M17.1 12l-1.5 1.5" opacity=".7" />`,

  // 献祭：向上托举的双手 + 光
  sacrifice: `
    <path d="M12 3v7" />
    <path d="M8.5 6.5a3.5 3.5 0 1 1 7 0" opacity=".7" />
    <path d="M5 20c0-3.2 2.2-5.4 5-6M19 20c0-3.2-2.2-5.4-5-6" />
    <path d="M12 13.4v6.6" opacity=".5" />`,

  // 重启：循环箭头
  reboot: `
    <path d="M20 12a8 8 0 1 1-3-6.2" />
    <path d="M20 3.6V9h-5.4" />`,

  // 熵增：碎裂方块 + 散点
  entropy: `
    <rect x="4" y="4" width="7" height="7" rx="1" />
    <rect x="13" y="4" width="7" height="4" rx="1" opacity=".6" />
    <rect x="4" y="13" width="4" height="7" rx="1" opacity=".6" />
    <path d="M13.5 12.5l3 3M18 11l2.5 1" opacity=".7" />
    <circle cx="17" cy="19" r="1.2" opacity=".5" />
    <circle cx="21" cy="15.5" r="1" opacity=".4" />`,
};

/* 槽位图标：6 个，给槽位栏和等级标记用 */
const SLOT_ICONS = {
  siege: `
    <path d="M3 19h18" />
    <circle cx="7" cy="17" r="2" /><circle cx="15" cy="17" r="2" />
    <path d="M9 15.5V11h6v4.5" />
    <path d="M15 12.5l5-3" />`,
  barricade: `
    <path d="M3 18h18M3 12h18" />
    <path d="M6 18V8M12 18V6M18 18V8" />`,
  closeDefense: `
    <circle cx="12" cy="16.5" r="3.4" />
    <path d="M12 13.1V6M12 6l4.6 2.2" />
    <path d="M5 20h14" opacity=".5" />`,
  support: `
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <path d="M12 8.5v7M8.5 12h7" />`,
  command: `
    <path d="M12 21V5" />
    <path d="M12 5l7 2.6-7 2.6z" />
    <path d="M8 21h8" opacity=".6" />`,
  summon: `
    <ellipse cx="12" cy="12" rx="8.4" ry="5.6" />
    <ellipse cx="12" cy="12" rx="3.8" ry="2.4" opacity=".7" />
    <circle cx="12" cy="12" r="1.1" />`,
};

/* ----------------------------------------------------------
 * 对外接口
 * ---------------------------------------------------------- */

/**
 * 取技能图标的 SVG 内容（不含 <svg> 外壳，方便塞进按钮里）。
 * 未知 id 返回一个问号方块，不返回空字符串——空图标比问号更难排查。
 */
export function skillIconSvg(id) {
  const body = ICONS[id];
  if (!body) {
    return `<rect x="5" y="5" width="14" height="14" rx="2" opacity=".5"/>
      <path d="M9.6 9.6l4.8 4.8M14.4 9.6l-4.8 4.8" opacity=".7"/>`;
  }
  return body;
}

/** 完整 SVG 标签，给需要直接插 HTML 的地方用 */
export function skillIconTag(id, opts = {}) {
  const size = opts.size || 24;
  const cls = opts.className ? ` class="${opts.className}"` : '';
  return `<svg${cls} viewBox="0 0 24 24" width="${size}" height="${size}"
    fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round">${skillIconSvg(id)}</svg>`;
}

export function slotIconSvg(id) {
  return SLOT_ICONS[id] || SLOT_ICONS.command;
}

export function slotIconTag(id, opts = {}) {
  const size = opts.size || 24;
  const cls = opts.className ? ` class="${opts.className}"` : '';
  return `<svg${cls} viewBox="0 0 24 24" width="${size}" height="${size}"
    fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round">${slotIconSvg(id)}</svg>`;
}

/** 有没有这个技能的专用图标（调试用，能查出漏做的） */
export function hasSkillIcon(id) {
  return Object.prototype.hasOwnProperty.call(ICONS, id);
}

/** 全部已做图标的 id，测试用 */
export function listSkillIcons() {
  return Object.keys(ICONS);
}
