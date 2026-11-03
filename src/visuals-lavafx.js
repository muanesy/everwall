/* ==========================================================
 * 熔岩喷发地面特效（纯视觉，不参与伤害结算）
 *
 * 每个 lava 区域从下到上叠四层：
 *   1. 暗红热辉：极低透明度的大圆片，只负责"这片地是烫的"的范围感
 *   2. 发光地裂缝：4~7 条从中心向外辐射的折线带（自建三角带，带折点，不是直线）
 *   3. 熔岩泡：3~5 个缓慢鼓起又瘪下去的亮斑，比底色更亮
 *   4. 喷火星：Points 批量画的细小亮橙点，上升 + 重力回落 + 淡出
 *
 * 只处理 kind === 'lava'；毒雾（toxic）由别的模块负责，这里直接跳过，
 * 避免两套特效在同一片区域打架。
 * 事件万一被强切（没有 envEventEnd），靠 duration 自行计时兜底收掉。
 * ========================================================== */

import * as THREE from 'three';

const MAX_ZONES = 3;                     // 同屏最多三片熔岩
const SPARK_PER_ZONE = 40;               // 40 * 3 = 120，粒子总数上限
const DEFAULT_DURATION = 5;              // 事件默认时长（5 秒）
const FADE_IN = 0.35;                    // 淡入时长
const FADE_OUT = 0.9;                    // 结尾淡出预留时长

export function createLavaFx(ctx) {
  const scene = ctx && ctx.scene;
  const events = ctx && ctx.events;
  const addShake = ctx && typeof ctx.addShake === 'function' ? ctx.addShake : null;

  const root = new THREE.Group();
  root.name = 'lavaFx';
  if (scene) scene.add(root);

  // 单位圆几何全区共用，靠 scale 复用，省几何体
  const circleGeo = new THREE.CircleGeometry(1, 36);
  const blobGeo = new THREE.CircleGeometry(1, 14);

  const zones = [];
  let remain = 0;                        // 兜底倒计时
  let fade = 0;                          // 全局淡入系数

  const rnd = (a, b) => a + Math.random() * (b - a);

  /* ---------- 裂缝形状：折点走位，避免看起来像画的直线 ---------- */
  function crackPath(r) {
    const pts = [];
    let ang = rnd(0, Math.PI * 2);
    let x = Math.cos(ang) * r * rnd(0.05, 0.14);
    let z = Math.sin(ang) * r * rnd(0.05, 0.14);
    pts.push({ x, z });
    const segs = 6 + Math.floor(Math.random() * 3);          // 6~8 段折线
    const step = (r * rnd(0.72, 1.02)) / segs;
    for (let i = 0; i < segs; i++) {
      ang += rnd(-0.34, 0.34);                               // 每段甩一点角度 = 折点
      const l = step * rnd(0.78, 1.26);
      x += Math.cos(ang) * l;
      z += Math.sin(ang) * l;
      pts.push({ x, z });
    }
    return pts;
  }

  /* ---------- 把一条折线加粗成带尖端的三角形带 ---------- */
  function ribbonGeometry(pts, w0) {
    const n = pts.length;
    const out = new Float32Array((n - 1) * 18);              // 每段 2 个三角形
    const left = [];
    const right = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[i > 0 ? i - 1 : i];
      const b = pts[i < n - 1 ? i + 1 : i];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const k = i / (n - 1);
      const w = w0 * (1 - k * k * 0.94);                     // 往尖端快速收细
      left.push(p.x - dz * w, p.z + dx * w);
      right.push(p.x + dz * w, p.z - dx * w);
    }
    let o = 0;
    const put = (x, z) => { out[o++] = x; out[o++] = 0; out[o++] = z; };
    for (let i = 0; i < n - 1; i++) {
      put(left[i * 2], left[i * 2 + 1]);
      put(right[i * 2], right[i * 2 + 1]);
      put(left[i * 2 + 2], left[i * 2 + 3]);
      put(left[i * 2 + 2], left[i * 2 + 3]);
      put(right[i * 2], right[i * 2 + 1]);
      put(right[i * 2 + 2], right[i * 2 + 3]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
    return geo;
  }

  /* ---------- 建一片熔岩 ---------- */
  function buildZone(data) {
    const r = data.radius > 0 ? data.radius : 5.2;
    const g = new THREE.Group();
    g.position.set(data.x || 0, 0, data.z || 0);
    root.add(g);

    // 1. 暗红热辉：极低透明度，杜绝"一块不透明橙圆盘"
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff3d0a,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(circleGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.05;
    glow.scale.setScalar(r * 1.02);
    glow.renderOrder = 1;
    g.add(glow);

    // 2. 地裂缝
    const crackN = 4 + Math.floor(Math.random() * 4);        // 4~7 条
    const cracks = [];
    const paths = [];
    for (let i = 0; i < crackN; i++) {
      const pts = crackPath(r);
      paths.push(pts);
      const geo = ribbonGeometry(pts, r * 0.03);
      const mat = new THREE.MeshBasicMaterial({
        color: Math.random() < 0.45 ? 0xffa838 : 0xff5410,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = 0.09;                                // 略高于热辉，压住不 z-fighting
      mesh.renderOrder = 2;
      g.add(mesh);
      cracks.push({ geo, mat, phase: rnd(0, 6.28), speed: rnd(1.3, 2.6), base: rnd(0.55, 0.9) });
    }

    // 3. 熔岩泡：单区 mesh 总数压在 12 个以内
    const bubbleN = Math.max(3, Math.min(3 + Math.floor(Math.random() * 3), 11 - crackN));
    const bubbles = [];
    for (let i = 0; i < bubbleN; i++) {
      const ang = rnd(0, Math.PI * 2);
      const dist = r * rnd(0.15, 0.8);
      const size = r * rnd(0.05, 0.12);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffc257,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(blobGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(Math.cos(ang) * dist, 0.12, Math.sin(ang) * dist);
      mesh.renderOrder = 3;
      g.add(mesh);
      bubbles.push({ mesh, mat, size, phase: rnd(0, 6.28), speed: rnd(0.9, 1.7) });
    }

    // 4. 火星：整区一个 Points，死掉的粒子涂黑（加法混合下等于隐身）
    const positions = new Float32Array(SPARK_PER_ZONE * 3);
    const colors = new Float32Array(SPARK_PER_ZONE * 3);
    for (let i = 0; i < SPARK_PER_ZONE; i++) positions[i * 3 + 1] = -50;
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    sparkGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sparkMat = new THREE.PointsMaterial({
      size: 0.17,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const sparkPts = new THREE.Points(sparkGeo, sparkMat);
    sparkPts.renderOrder = 4;
    g.add(sparkPts);

    const sparks = [];
    for (let i = 0; i < SPARK_PER_ZONE; i++) {
      sparks.push({ x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
    }

    return {
      group: g,
      glowMat,
      cracks,
      bubbles,
      paths,
      positions,
      colors,
      sparkGeo,
      sparkMat,
      sparks,
      emitTimer: rnd(0.1, 0.4),
      r,
    };
  }

  /* ---------- 喷一小簇火星（沿裂缝随机位置冒） ---------- */
  function emitSparks(z) {
    const count = 2 + Math.floor(Math.random() * 3);          // 每次 2~4 颗
    let spawned = 0;
    for (let i = 0; i < z.sparks.length && spawned < count; i++) {
      const s = z.sparks[i];
      if (s.life > 0) continue;
      const path = z.paths[Math.floor(Math.random() * z.paths.length)];
      const p = path[Math.floor(Math.random() * path.length)];
      s.x = p.x + rnd(-0.18, 0.18);
      s.z = p.z + rnd(-0.18, 0.18);
      s.y = 0.14;
      const ang = rnd(0, Math.PI * 2);
      const hs = rnd(0.4, 1.6);
      s.vx = Math.cos(ang) * hs;
      s.vz = Math.sin(ang) * hs;
      s.vy = rnd(2.4, 4.8);
      s.max = rnd(0.5, 0.95);
      s.life = s.max;
      spawned++;
    }
  }

  function updateZone(z, dt, t, env) {
    // 热辉整体呼吸，幅度很小，只做"在烧"的感觉
    z.glowMat.opacity = 0.115 * env * (0.88 + 0.12 * Math.sin(t * 1.7));

    for (let i = 0; i < z.cracks.length; i++) {
      const c = z.cracks[i];
      const k = 0.62 + 0.38 * Math.sin(t * c.speed * 2 + c.phase);
      c.mat.opacity = c.base * env * k;
    }

    for (let i = 0; i < z.bubbles.length; i++) {
      const b = z.bubbles[i];
      const k = 0.5 + 0.5 * Math.sin(t * b.speed + b.phase);
      const sc = b.size * (0.45 + 0.75 * k);
      b.mesh.scale.set(sc, sc, sc);
      b.mat.opacity = env * (0.12 + 0.55 * k);
    }

    // 火星：间歇喷发
    z.emitTimer -= dt;
    if (z.emitTimer <= 0) {
      emitSparks(z);
      z.emitTimer = rnd(0.3, 0.7);
    }

    const pos = z.positions;
    const col = z.colors;
    for (let i = 0; i < z.sparks.length; i++) {
      const s = z.sparks[i];
      const o = i * 3;
      if (s.life <= 0) {
        pos[o + 1] = -50;
        col[o] = col[o + 1] = col[o + 2] = 0;
        continue;
      }
      s.life -= dt;
      if (s.life <= 0) {
        pos[o + 1] = -50;
        col[o] = col[o + 1] = col[o + 2] = 0;
        continue;
      }
      s.vy -= 11 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      if (s.y < 0.06) {                                     // 落地就熄灭
        s.y = 0.06;
        s.life = 0;
        pos[o + 1] = -50;
        col[o] = col[o + 1] = col[o + 2] = 0;
        continue;
      }
      const a = s.life / s.max;
      const fadeA = a * a * env;                            // 尾部快速淡出更自然
      pos[o] = s.x;
      pos[o + 1] = s.y;
      pos[o + 2] = s.z;
      col[o] = fadeA;
      col[o + 1] = fadeA * 0.5;
      col[o + 2] = fadeA * 0.08;
    }
    z.sparkGeo.attributes.position.needsUpdate = true;
    z.sparkGeo.attributes.color.needsUpdate = true;
    z.sparkMat.opacity = 0.95 * env;
  }

  function disposeZone(z) {
    root.remove(z.group);
    z.glowMat.dispose();
    for (let i = 0; i < z.cracks.length; i++) {
      z.cracks[i].geo.dispose();
      z.cracks[i].mat.dispose();
    }
    for (let i = 0; i < z.bubbles.length; i++) z.bubbles[i].mat.dispose();
    z.sparkGeo.dispose();
    z.sparkMat.dispose();
  }

  function clearZones() {
    for (let i = 0; i < zones.length; i++) disposeZone(zones[i]);
    zones.length = 0;
    remain = 0;
    fade = 0;
  }

  /* ---------- 事件 ---------- */
  function onZoneStart(e) {
    const d = e && e.detail;
    if (!d || !Array.isArray(d.zones)) return;
    const lava = d.zones.filter((z) => z && z.kind === 'lava').slice(0, MAX_ZONES);
    if (!lava.length) return;                                // 只有毒雾就交给别的模块，不动现有特效
    clearZones();
    remain = d.duration > 0 ? d.duration : DEFAULT_DURATION;
    for (let i = 0; i < lava.length; i++) zones.push(buildZone(lava[i]));
    if (addShake) addShake(0.35);                            // 大地震一下，轻微就够
  }

  function onEventEnd(e) {
    const d = e && e.detail;
    if (d && d.id === 'lava') clearZones();
  }

  if (events) {
    events.addEventListener('envZoneStart', onZoneStart);
    events.addEventListener('envEventEnd', onEventEnd);
  }

  return {
    update(dt, t) {
      const step = dt > 0 ? Math.min(dt, 0.05) : 0;          // 卡帧时钳住，免得火星瞬移
      if (remain > 0) {
        remain -= step;
        if (remain <= 0) { clearZones(); return; }           // 兜底：没人发结束事件也自己收
      }
      if (!zones.length) return;
      fade = Math.min(1, fade + step / FADE_IN);
      const endK = remain > FADE_OUT ? 1 : Math.max(0, remain / FADE_OUT);
      const env = fade * endK;
      for (let i = 0; i < zones.length; i++) updateZone(zones[i], step, t, env);
    },
    reset() {
      clearZones();
    },
  };
}
