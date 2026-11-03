/* ==========================================================
 * 天气粒子层（乙负责）
 *
 * 支持六种 kind：rain 斜雨 / fog 贴地雾 / storm 暴雨+闪电 /
 * dust 横向沙线 / wind 细长风痕 / snow 落雪。
 *
 * 事件入口（ctx.events，原生 EventTarget）：
 *   envWeatherStart  e.detail = { kind }  起一层天气，0.6s 淡入
 *   envWeatherEnd    渐出 0.8s，结束后整组从 scene 摘除
 *   envEventEnd      e.detail.id === 'weather' 时同样按结束处理（换图/重开兜底）
 *
 * 性能约束：粒子总量 ≤ 600。雨/沙/风用 LineSegments 一次画完，雪用 Points，
 * 雾只有 20 个共享几何的低空球。全部 MeshBasic/Points/LineBasic，透明、
 * 不写深度、无灯光无阴影无贴图，手机 405×720 一档开销。
 * 时间只从 update(dt, t) 拿，自己不开 rAF / setInterval。
 * ========================================================== */

import * as THREE from 'three';

/* 粒子活动盒：必须落在相机俯视能看到的体积里。
 * x 比战场(-8..8)宽一圈，z 从僵尸出生点(-30)一直铺到玩家身后(12)，
 * y 只到 15——相机看不到天空，往上堆只是浪费顶点。 */
const BOX = { x0: -13, x1: 13, y0: 0, y1: 15, z0: -34, z1: 12 };
const W = BOX.x1 - BOX.x0;
const H = BOX.y1 - BOX.y0;
const D = BOX.z1 - BOX.z0;

const FADE_IN = 0.6;
const FADE_OUT = 0.8;

const rnd = (a, b) => a + Math.random() * (b - a);

/* 线状天气的数值表。vel 同时决定朝向和速度，线段沿 vel 反向拉出 len 长，
 * 所以雨是斜的、沙是横向的——不用另写方向逻辑。 */
const LINE_SPEC = {
  rain: { count: 300, color: 0x9ec6ea, opacity: 0.5, len: 1.15, vel: [2.4, -17, 1.1] },
  storm: { count: 260, color: 0xb0d0f2, opacity: 0.58, len: 1.5, vel: [3.4, -23, 1.5] },
  dust: { count: 220, color: 0xc9a86a, opacity: 0.4, len: 1.9, vel: [13, 0.4, 0.7] },
  wind: { count: 44, color: 0xdae6f2, opacity: 0.28, len: 3.6, vel: [21, 0, 0.5] },
};

const SNOW_COUNT = 190;
const FOG_COUNT = 20;

export function createWeatherFx(ctx) {
  const scene = ctx && ctx.scene;
  const events = ctx && ctx.events;
  const addShake = ctx && typeof ctx.addShake === 'function' ? ctx.addShake : null;
  if (!scene) return { update() {}, reset() {} };

  let cur = null; // 同一时刻只允许一层，切换时先硬收旧的

  /* ---------- 淡入淡出 ---------- */
  const applyFade = (L) => {
    const mats = L.mats;
    for (let i = 0; i < mats.length; i++) mats[i].opacity = L.bases[i] * L.fade;
  };

  const disposeLayer = (L) => {
    if (!L) return;
    scene.remove(L.group);
    for (let i = 0; i < L.geos.length; i++) L.geos[i].dispose();
    for (let i = 0; i < L.mats.length; i++) L.mats[i].dispose();
    L.geos.length = 0;
    L.mats.length = 0;
  };

  const stop = (immediate) => {
    if (!cur) return;
    if (immediate) {
      disposeLayer(cur);
      cur = null;
      return;
    }
    cur.phase = 'out';
  };

  /* ---------- 线状天气（雨 / 暴雨 / 沙 / 风） ---------- */
  const buildLines = (L, kind) => {
    const spec = LINE_SPEC[kind];
    const n = spec.count;
    L.spec = spec;
    L.n = n;
    L.head = new Float32Array(n * 3);
    L.lenJ = new Float32Array(n);
    L.ph = new Float32Array(n);
    L.pos = new Float32Array(n * 6);

    for (let i = 0; i < n; i++) {
      L.head[i * 3] = rnd(BOX.x0, BOX.x1);
      L.head[i * 3 + 1] = rnd(BOX.y0, BOX.y1);
      L.head[i * 3 + 2] = rnd(BOX.z0, BOX.z1);
      L.lenJ[i] = spec.len * rnd(0.7, 1.45);
      L.ph[i] = rnd(0, Math.PI * 2);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(L.pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: spec.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    L.geo = geo;
    L.mats.push(mat);
    L.bases.push(spec.opacity);
    L.geos.push(geo);
    L.group.add(new THREE.LineSegments(geo, mat));

    if (kind === 'storm') {
      /* 整屏一闪：一块贴在相机前的大面片，depthTest 关掉，只在闪电瞬间有透明度，
       * 这样不需要拿到 camera 也不需要后处理通道。 */
      const fgeo = new THREE.PlaneGeometry(46, 32);
      const fmat = new THREE.MeshBasicMaterial({
        color: 0xdfe9ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
      });
      const flash = new THREE.Mesh(fgeo, fmat);
      flash.position.set(0, 6, 12.5);
      flash.renderOrder = 999;
      L.geos.push(fgeo);
      L.mats.push(fmat);
      L.bases.push(0); // 平时全透明，亮度由 update 直接算，不吃通用淡入淡出
      L.flashMat = fmat;
      L.flash = 0;
      L.flashT = rnd(0.6, 2.2);
      L.group.add(flash);
    }
  };

  const stepLines = (L, dt, t) => {
    const s = L.spec;
    const n = L.n;
    const head = L.head;
    const pos = L.pos;
    const len = L.lenJ;
    const dvx = s.vel[0];
    const dvy = s.vel[1];
    const dvz = s.vel[2];
    const inv = 1 / Math.hypot(dvx, dvy, dvz);
    const ux = dvx * inv;
    const uy = dvy * inv;
    const uz = dvz * inv;
    const gust = L.kind === 'wind' || L.kind === 'dust';

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let x = head[i3] + dvx * dt;
      let y = head[i3 + 1] + dvy * dt;
      let z = head[i3 + 2] + dvz * dt;
      // 风痕/沙线加一点上下浮动，避免整层像一块板在平移
      if (gust) y += Math.sin(t * 1.7 + L.ph[i]) * 0.8 * dt;

      // 循环而不是销毁：雨/雪要撑满整场
      if (y < BOX.y0) y += H;
      else if (y > BOX.y1) y -= H;
      if (x < BOX.x0) x += W;
      else if (x > BOX.x1) x -= W;
      if (z < BOX.z0) z += D;
      else if (z > BOX.z1) z -= D;

      head[i3] = x;
      head[i3 + 1] = y;
      head[i3 + 2] = z;

      const j = i * 6;
      pos[j] = x;
      pos[j + 1] = y;
      pos[j + 2] = z;
      pos[j + 3] = x - ux * len[i];
      pos[j + 4] = y - uy * len[i];
      pos[j + 5] = z - uz * len[i];
    }
    L.geo.attributes.position.needsUpdate = true;
  };

  /* ---------- 雪：Points 一次画完 ---------- */
  const buildSnow = (L) => {
    const n = SNOW_COUNT;
    L.n = n;
    L.head = new Float32Array(n * 3);
    L.ph = new Float32Array(n);
    L.size = new Float32Array(n);
    L.pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      L.head[i * 3] = rnd(BOX.x0, BOX.x1);
      L.head[i * 3 + 1] = rnd(BOX.y0, BOX.y1);
      L.head[i * 3 + 2] = rnd(BOX.z0, BOX.z1);
      L.ph[i] = rnd(0, Math.PI * 2);
      L.size[i] = rnd(0.7, 1.5);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(L.pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.26,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    L.geo = geo;
    L.mats.push(mat);
    L.bases.push(0.85);
    L.geos.push(geo);
    L.group.add(new THREE.Points(geo, mat));
  };

  const stepSnow = (L, dt, t) => {
    const n = L.n;
    const head = L.head;
    const pos = L.pos;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const sway = Math.cos(t * 1.25 + L.ph[i]) * 0.75; // 左右摆动
      let x = head[i3] + sway * dt;
      let y = head[i3 + 1] - 1.7 * dt;
      let z = head[i3 + 2] + 0.25 * dt;

      if (y < BOX.y0) {
        y += H;
        x = rnd(BOX.x0, BOX.x1);
      }
      if (x < BOX.x0) x += W;
      else if (x > BOX.x1) x -= W;
      if (z > BOX.z1) z -= D;

      head[i3] = x;
      head[i3 + 1] = y;
      head[i3 + 2] = z;
      pos[i3] = x;
      pos[i3 + 1] = y;
      pos[i3 + 2] = z;
    }
    L.geo.attributes.position.needsUpdate = true;
  };

  /* ---------- 雾：20 个共享几何的低空球，贴地翻滚 ---------- */
  const buildFog = (L) => {
    const geo = new THREE.SphereGeometry(1, 8, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xc4ccd8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    L.geos.push(geo);
    L.mats.push(mat);
    L.bases.push(0.13);
    L.puffs = [];
    for (let i = 0; i < FOG_COUNT; i++) {
      const m = new THREE.Mesh(geo, mat);
      const p = {
        m,
        x: rnd(BOX.x0, BOX.x1),
        // y 压在 0.2~2.5：雾要趴在地上，飘高了就成了云
        y: rnd(0.2, 2.5),
        z: rnd(BOX.z0, BOX.z1),
        rx: rnd(2.2, 4.2),
        rz: rnd(2.0, 3.8),
        sp: rnd(0.25, 0.9),
        rs: rnd(-0.12, 0.12),
        ph: rnd(0, Math.PI * 2),
      };
      m.position.set(p.x, p.y, p.z);
      m.scale.set(p.rx, rnd(0.5, 1.05), p.rz);
      L.group.add(m);
      L.puffs.push(p);
    }
  };

  const stepFog = (L, dt, t) => {
    const list = L.puffs;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.x += p.sp * dt;
      if (p.x > BOX.x1 + 3) p.x -= W + 6;
      p.y += Math.sin(t * 0.5 + p.ph) * 0.12 * dt;
      if (p.y < 0.15) p.y = 0.15;
      if (p.y > 2.6) p.y = 2.6;
      p.m.rotation.y += p.rs * dt;
      p.m.position.set(p.x, p.y, p.z);
      // 呼吸式缩放，让雾团看起来在翻滚
      const k = 1 + Math.sin(t * 0.6 + p.ph) * 0.08;
      p.m.scale.set(p.rx * k, p.m.scale.y, p.rz * k);
    }
  };

  /* ---------- 暴雨闪电 ---------- */
  const stepStorm = (L, dt) => {
    L.flashT -= dt;
    if (L.flashT <= 0) {
      L.flash = rnd(0.45, 0.85);
      L.flashT = rnd(1.8, 4.2);
      if (addShake) addShake(0.15);
    }
    if (L.flash > 0) L.flash = Math.max(0, L.flash - dt * 3.4);
    L.flashMat.opacity = L.flash * L.fade;
  };

  /* ---------- 建层 ---------- */
  const build = (kind) => {
    const L = { kind, group: new THREE.Group(), mats: [], bases: [], geos: [], fade: 0, phase: 'in' };
    if (kind === 'fog') buildFog(L);
    else if (kind === 'snow') buildSnow(L);
    else if (LINE_SPEC[kind]) buildLines(L, kind);
    else return null;
    applyFade(L);
    scene.add(L.group);
    return L;
  };

  const start = (kind) => {
    stop(true); // 换天气不叠层：旧层直接销毁
    cur = build(kind);
  };

  /* ---------- 事件 ---------- */
  if (events) {
    events.addEventListener('envWeatherStart', (e) => {
      const kind = e && e.detail && e.detail.kind;
      if (kind) start(kind);
    });
    events.addEventListener('envWeatherEnd', () => stop(false));
    // 换图/重开时事件不一定走 end，这里兜底，保证不会带着旧天气进新图
    events.addEventListener('envEventEnd', (e) => {
      if (e && e.detail && e.detail.id === 'weather') stop(false);
    });
  }

  return {
    update(dt, t) {
      const L = cur;
      if (!L) return;
      // 切后台回来 dt 可能很大，夹一下，避免粒子一帧跳到盒子另一头
      const d = dt > 0.05 ? 0.05 : dt;
      if (d <= 0) return;

      if (L.phase === 'in') {
        L.fade += d / FADE_IN;
        if (L.fade >= 1) {
          L.fade = 1;
          L.phase = 'on';
        }
      } else if (L.phase === 'out') {
        L.fade -= d / FADE_OUT;
        if (L.fade <= 0) {
          disposeLayer(L);
          cur = null;
          return;
        }
      }
      applyFade(L);

      if (L.kind === 'fog') stepFog(L, d, t);
      else if (L.kind === 'snow') stepSnow(L, d, t);
      else {
        stepLines(L, d, t);
        if (L.kind === 'storm') stepStorm(L, d);
      }
    },

    reset() {
      stop(true);
    },
  };
}
