import * as THREE from 'three';

/**
 * 环境事件预警圈（纯程序化，零外部贴图）。
 * 1. 游戏只在预警开始时发一次 envWarning，之后不会发"结束"，所以本模块自己按 3 秒寿命收圈。
 * 2. 六类 kind：meteor / toxic / lava 有真实落点，按事件给的 x/z/radius 贴地画圈，半径严格等于 radius，
 *    玩家才敢照着圈判断躲避范围。
 * 3. emp / quake / weather 没有落点（x/z/radius 可能是 0），改为在画面边缘画一圈大环警示，不画地面圈。
 * 4. 判断口径统一：kind 属于无落点三类，或 radius < 1，一律按"无落点"处理，避免误画一个半径 0 的小点。
 * 5. 为了不"只闪一次"：底环常驻并呼吸，另外按节奏向外抛扩散环，扩散环透明度随半径衰减，
 *    形成"脉冲 + 扩散"的双层观感；间隔随时间收紧，越接近 3 秒越急。
 * 6. 动画全部靠 update(dt, t) 的 dt 累计驱动，不开 rAF / setInterval / setTimeout，暂停时不会脱节。
 * 7. 同屏最多 3 个落点、每个落点环数少于 8，Mesh 总数可控；移除时逐个释放几何体与材质。
 * 8. 所有环贴地放 y≈0.05 且 depthWrite=false，避免与地面 z-fighting，并设 renderOrder 压在地面之上。
 */

const LIFE = 3; // 预警总时长（秒），与游戏 warn 时长一致
const GROUND_Y = 0.05;
const MAX_SPOTS = 3; // 游戏一次最多发 3 个
const MAX_PULSES = 7; // 单落点同时存在的扩散环上限
const SCREEN_DIST = 4; // 屏幕边缘环挂在相机前方几米

const COLORS = {
  toxic: 0x8fe36a,
  lava: 0xff6a2a,
  meteor: 0xffb060,
  emp: 0x6fa8ff,
  quake: 0xffd88a,
  weather: 0xffd88a,
};

const NO_SPOT_KINDS = { emp: true, quake: true, weather: true };

// 程序化虚线环：按弧度切成 N 段短弧四边形，避免用贴图做虚线
function makeDashedRing(inner, outer, dashes, fill) {
  const pos = [];
  const arc = (Math.PI * 2) / dashes;
  const span = arc * fill;
  const SEG = 3;
  for (let d = 0; d < dashes; d++) {
    const a0 = d * arc;
    for (let i = 0; i < SEG; i++) {
      const t0 = a0 + (span * i) / SEG;
      const t1 = a0 + (span * (i + 1)) / SEG;
      const x0 = Math.cos(t0);
      const y0 = Math.sin(t0);
      const x1 = Math.cos(t1);
      const y1 = Math.sin(t1);
      pos.push(
        inner * x0, inner * y0, 0,
        outer * x0, outer * y0, 0,
        outer * x1, outer * y1, 0,
        inner * x0, inner * y0, 0,
        outer * x1, outer * y1, 0,
        inner * x1, inner * y1, 0
      );
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

/**
 * 环境事件预警圈：在 3 秒预警期内持续脉冲，让玩家看见落点。
 * @param {{ scene: THREE.Scene, events: EventTarget }} ctx
 * @returns {{ update(dt: number, t: number): void, reset(): void }}
 */
export function createEnvWarningFx(ctx) {
  const scene = ctx.scene;
  const events = ctx.events;
  const camera = ctx.camera || null; // 有就用来看齐屏幕边缘，没有则退化到远景大环

  const spots = [];

  function ringMat(color, opacity) {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false, // 预警必须始终清晰，不吃雾
    });
  }

  // ---- 有落点：贴地三件套（底环 + 旋转虚线环 + 周期性扩散环） ----
  function createGroundSpot(d) {
    const color = COLORS[d.kind] || 0xffd88a;
    const radius = Math.max(0.8, Math.abs(d.radius) || 0);
    const group = new THREE.Group();
    group.position.set(d.x || 0, GROUND_Y, d.z || 0);

    const baseMat = ringMat(color, 0.28);
    const base = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), baseMat);
    base.rotation.x = -Math.PI / 2;
    base.scale.setScalar(radius);
    base.renderOrder = 6;
    group.add(base);

    const dashMat = ringMat(color, 0.62);
    const dash = new THREE.Mesh(makeDashedRing(0.87, 1, 16, 0.5), dashMat);
    dash.rotation.x = -Math.PI / 2;
    dash.scale.setScalar(radius * 1.03);
    dash.renderOrder = 7;
    group.add(dash);

    scene.add(group);
    // 扩散环共用一个单位几何体，只各自持有材质（透明度独立）
    const pulseGeo = new THREE.RingGeometry(0.9, 1, 44);
    return {
      screen: false,
      group,
      color,
      radius,
      base,
      baseMat,
      dash,
      dashMat,
      pulseGeo,
      pulses: [],
      t: 0,
      nextPulse: 0, // 立刻抛第一圈，保证一出现就能看见
    };
  }

  // ---- 无落点：贴屏幕边缘的大环 ----
  function applyScreenTransform(group, mesh) {
    camera.getWorldPosition(group.position);
    camera.getWorldQuaternion(group.quaternion);
    const fov = ((camera.fov || 60) * Math.PI) / 180;
    const h = Math.tan(fov / 2) * SCREEN_DIST;
    const w = h * (camera.aspect || 0.5625);
    mesh.scale.set(w, h, 1); // 椭圆铺满竖屏一圈
  }

  function createScreenSpot(d) {
    const color = COLORS[d.kind] || 0xffd88a;
    const group = new THREE.Group();
    const mat = ringMat(color, 0.3);
    const mesh = new THREE.Mesh(new THREE.RingGeometry(1, 1.12, 96), mat);
    mesh.position.set(0, 0, -SCREEN_DIST);
    mesh.renderOrder = 20;
    group.add(mesh);

    if (camera) {
      applyScreenTransform(group, mesh);
    } else {
      // 拿不到相机就退化成远景上方的大环，仍然能看出"全屏级"威胁
      group.position.set(0, 7.5, -16);
      mesh.position.set(0, 0, 0);
      mesh.scale.setScalar(9);
    }
    scene.add(group);
    return { screen: true, group, color, mat, mesh, t: 0 };
  }

  function killPulse(s, index) {
    const q = s.pulses[index];
    s.group.remove(q.mesh);
    q.mesh.material.dispose();
    s.pulses.splice(index, 1);
  }

  function updateGround(s, dt) {
    const p = Math.min(1, s.t / LIFE);
    // 呼吸频率随进度加快：越接近落点，闪得越急
    const breath = 0.5 - 0.5 * Math.cos(s.t * (2.4 + 4.2 * p) * Math.PI * 2);
    s.baseMat.opacity = 0.16 + 0.36 * breath;
    s.base.scale.setScalar(s.radius); // 外径严格等于 radius，玩家据此判断躲避范围
    s.dashMat.opacity = 0.45 + 0.45 * breath;
    s.dash.rotation.z -= dt * (0.8 + 3.2 * p); // 虚线缓慢旋转，暗示倒计时在走

    for (let i = s.pulses.length - 1; i >= 0; i--) {
      const q = s.pulses[i];
      q.age += dt;
      const k = q.age / q.dur;
      if (k >= 1) {
        killPulse(s, i);
        continue;
      }
      q.mesh.scale.setScalar(s.radius * (0.18 + 0.87 * k));
      q.mesh.material.opacity = 0.85 * Math.pow(1 - k, 1.6);
    }

    if (s.t < LIFE - 0.12 && s.t >= s.nextPulse) {
      s.nextPulse = s.t + 0.5 - 0.24 * p; // 间隔从 0.5 秒收紧到约 0.26 秒
      if (s.pulses.length >= MAX_PULSES) killPulse(s, 0);
      const mesh = new THREE.Mesh(s.pulseGeo, ringMat(s.color, 0.8));
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 6;
      s.group.add(mesh);
      s.pulses.push({ mesh, age: 0, dur: 0.95 });
    }
  }

  function updateScreen(s, dt) {
    const p = Math.min(1, s.t / LIFE);
    const flick = 0.5 - 0.5 * Math.cos(s.t * (2.6 + 4.6 * p) * Math.PI * 2);
    s.mat.opacity = 0.1 + 0.42 * flick;
    if (camera) {
      applyScreenTransform(s.group, s.mesh);
      s.mesh.scale.x *= 1 + 0.03 * flick;
      s.mesh.scale.y *= 1 + 0.03 * flick;
    } else {
      s.mesh.scale.setScalar(9 * (1 + 0.06 * flick));
    }
  }

  function disposeSpot(s) {
    for (const q of s.pulses) q.mesh.material.dispose();
    s.pulses.length = 0;
    s.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    if (s.pulseGeo) s.pulseGeo.dispose();
    scene.remove(s.group);
  }

  function onWarning(ev) {
    const d = ev && ev.detail;
    if (!d) return;
    const noSpot = NO_SPOT_KINDS[d.kind] === true || !(Math.abs(d.radius) >= 1);
    while (spots.length >= MAX_SPOTS) {
      disposeSpot(spots.shift());
    }
    spots.push(noSpot ? createScreenSpot(d) : createGroundSpot(d));
  }

  events.addEventListener('envWarning', onWarning);

  function update(dt) {
    // 限幅防止切后台回来时一帧跳完整个生命周期
    const step = Math.min(Math.max(dt || 0, 0), 0.1);
    for (let i = spots.length - 1; i >= 0; i--) {
      const s = spots[i];
      s.t += step;
      if (s.screen) updateScreen(s, step);
      else updateGround(s, step);
      if (s.t >= LIFE) {
        disposeSpot(s);
        spots.splice(i, 1);
      }
    }
  }

  function reset() {
    while (spots.length) disposeSpot(spots.pop());
  }

  return { update, reset };
}
