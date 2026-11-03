/* ==========================================================
 * 电磁风暴的画面残留（只做视觉，不参与任何玩法判定）
 *
 * 用法：
 *   const empFx = createEmpFx({ scene, events, addShake });
 *   empFx.update(dt, t);   // 每帧调
 *
 * 设计要点：
 * 1. 自收：envEmp 只有"开始"没有"结束"，而 EMP 的真实生效时长是 2.5 秒，
 *    所以模块自己倒计时收尾；另外挂 envEventEnd(id==='emp') 做换图/强切的保险。
 * 2. 电弧：地面到半空随机起弧，3~5 段随机折点。单条 Line 画不了真分叉，
 *    于是用"走到分叉点 → 画两根短枝 → 折返回分叉点 → 继续主线"的走位，
 *    分叉被来回画一遍（只是更亮一点），不会出现跨屏的假连线。
 * 3. 电弧在存活期里反复重画（每 40~90ms），噼啪感靠几何抖动而不是换材质。
 * 4. 扫描线：一条横贯画面的光带从 z=-30 掠到 z=+9，1.2 秒一趟，2.5 秒里跑两趟。
 * 5. 抖屏：开场 0.12，之后每 0.6 秒补 0.06，节奏稀疏，避免晃晕玩家。
 * 6. 性能：电弧对象池上限 14 条、每条 ≤24 顶点，全部 Basic 材质、关深度写入，
 *    reset 时 dispose 几何与材质（下次触发按需重建，不做一次性耗材）。
 * ========================================================== */

import * as THREE from 'three';

const DURATION = 2.5;        // EMP 真实生效时长，到期自己收
const MAX_ARCS = 14;         // 同屏电弧上限
const MAX_VERTS = 24;        // 单条电弧顶点上限
const SCAN_DUR = 1.2;        // 一趟扫描的秒数
const SCAN_FROM = -30;       // 扫描起点（战场远端）
const SCAN_TO = 9;           // 扫描终点（玩家身前）
const FADE_TAIL = 0.35;      // 收尾这段时间不再补新弧，让画面自然淡下去

const rand = (a, b) => a + Math.random() * (b - a);
// 高度夹在 [0.2, 6]：相机是俯视，太高就飞出画面了
const clampY = (y) => (y < 0.2 ? 0.2 : y > 6 ? 6 : y);

/**
 * 电磁风暴：持续电弧 + 扫描线，覆盖事件生效的 2.5 秒。
 * @param {{ scene: THREE.Scene, events: EventTarget, addShake?: (v:number)=>void }} ctx
 * @returns {{ update(dt: number, t: number): void, reset(): void }}
 */
export function createEmpFx(ctx) {
  const scene = ctx.scene;
  const events = ctx.events;
  const addShake = typeof ctx.addShake === 'function' ? ctx.addShake : null;

  const group = new THREE.Group();
  group.name = 'empFx';
  if (scene) scene.add(group);

  let arcs = [];
  let scanMesh = null;
  let scanMat = null;
  let edgeMesh = null;
  let edgeMat = null;
  let built = false;

  let active = false;
  let elapsed = 0;
  let spawnTimer = 0;
  let shakeTimer = 0;

  /* ----------------------------------------------------------
   * 电弧池：几何全量预分配，靠 setDrawRange 控制画几段
   * ---------------------------------------------------------- */
  function buildArc(arc) {
    const p = arc.pos;
    let n = 0;
    const put = (x, y, z) => {
      if (n >= MAX_VERTS) return;
      p[n * 3] = x;
      p[n * 3 + 1] = y;
      p[n * 3 + 2] = z;
      n++;
    };

    let x = arc.sx;
    let y = arc.sy;
    let z = arc.sz;
    let ang = arc.ang;
    const segs = 3 + ((Math.random() * 3) | 0); // 3~5 段
    let branches = Math.random() < 0.75 ? (Math.random() < 0.45 ? 2 : 1) : 0;

    put(x, y, z);
    for (let i = 0; i < segs; i++) {
      // 每段方向随机偏转，长短不一，避免出现"栅栏"感
      ang += (Math.random() - 0.5) * 1.5;
      const step = rand(1.0, 2.3);
      x += Math.cos(ang) * step;
      z += Math.sin(ang) * step;
      y = clampY(y + rand(-0.35, 0.75));
      put(x, y, z);

      // 分叉：画两根短枝再折返回起点，主线接着往下走
      if (branches > 0 && i >= 1) {
        branches--;
        const ox = x;
        const oy = y;
        const oz = z;
        let bang = ang + (Math.random() < 0.5 ? 1 : -1) * rand(0.8, 1.4);
        let bx = ox;
        let by = oy;
        let bz = oz;
        for (let k = 0; k < 2; k++) {
          bang += (Math.random() - 0.5) * 0.9;
          const bs = rand(0.6, 1.4);
          bx += Math.cos(bang) * bs;
          bz += Math.sin(bang) * bs;
          by = clampY(by + rand(-0.3, 0.6));
          put(bx, by, bz);
        }
        put(ox, oy, oz); // 折返点：让分叉闭合回主线，不留跨屏连线
      }
    }

    arc.n = n;
    arc.geo.setDrawRange(0, n);
    arc.geo.attributes.position.needsUpdate = true;
  }

  function spawnArc() {
    let arc = null;
    for (let i = 0; i < arcs.length; i++) {
      if (!arcs[i].alive) {
        arc = arcs[i];
        break;
      }
    }
    if (!arc) return; // 池满了就跳过，不排队（电弧本来就是一瞬的事）

    arc.alive = true;
    arc.maxLife = rand(0.15, 0.35);
    arc.life = arc.maxLife;
    arc.regen = 0;
    arc.sx = rand(-8, 8);
    arc.sz = rand(-28, 8);
    arc.sy = rand(0.3, 2.4);
    arc.ang = Math.random() * Math.PI * 2;
    // 蓝白之间随机，纯白的弧看起来像跳闸，蓝色像电流
    arc.mat.color.setHex(Math.random() < 0.45 ? 0xffffff : 0x8fd4ff);
    arc.line.visible = true;
    buildArc(arc);
  }

  /* ----------------------------------------------------------
   * 资源建 / 拆（建一次复用，reset 才真释放）
   * ---------------------------------------------------------- */
  function build() {
    if (built) return;
    built = true;

    arcs = [];
    for (let i = 0; i < MAX_ARCS; i++) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(MAX_VERTS * 3);
      const attr = new THREE.BufferAttribute(pos, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      geo.setDrawRange(0, 0);

      const mat = new THREE.LineBasicMaterial({
        color: 0x8fd4ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending, // 叠加混色，细线也能有"发亮"的感觉
      });

      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false; // 顶点每帧都在动，包围球信不过
      line.visible = false;
      group.add(line);

      arcs.push({ line, geo, mat, pos, n: 0, alive: false, life: 0, maxLife: 0, regen: 0, sx: 0, sy: 0, sz: 0, ang: 0 });
    }

    const scanGeo = new THREE.PlaneGeometry(18, 1.8);
    scanMat = new THREE.MeshBasicMaterial({
      color: 0x4fb0ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    scanMesh = new THREE.Mesh(scanGeo, scanMat);
    scanMesh.rotation.x = -Math.PI / 2; // 平铺在地面上，跟着 z 往前推
    scanMesh.position.set(0, 0.16, SCAN_FROM);
    scanMesh.visible = false;
    group.add(scanMesh);

    // 前缘再压一条更亮的细带，光带才不会糊成一坨
    const edgeGeo = new THREE.PlaneGeometry(18, 0.3);
    edgeMat = new THREE.MeshBasicMaterial({
      color: 0xdff2ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    edgeMesh = new THREE.Mesh(edgeGeo, edgeMat);
    edgeMesh.rotation.x = -Math.PI / 2;
    edgeMesh.position.set(0, 0.2, SCAN_FROM);
    edgeMesh.visible = false;
    group.add(edgeMesh);
  }

  function release() {
    if (!built) return;
    built = false;

    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i];
      group.remove(a.line);
      a.geo.dispose();
      a.mat.dispose();
    }
    arcs = [];

    if (scanMesh) {
      group.remove(scanMesh);
      scanMesh.geometry.dispose();
      scanMat.dispose();
      scanMesh = null;
      scanMat = null;
    }
    if (edgeMesh) {
      group.remove(edgeMesh);
      edgeMesh.geometry.dispose();
      edgeMat.dispose();
      edgeMesh = null;
      edgeMat = null;
    }
  }

  /* ----------------------------------------------------------
   * 事件
   * ---------------------------------------------------------- */
  function start() {
    build(); // 懒重建：reset 释放过就先搭回来
    elapsed = 0;
    active = true;
    spawnTimer = 0;
    shakeTimer = 0.6;
    if (scanMesh) scanMesh.visible = true;
    if (edgeMesh) edgeMesh.visible = true;
    if (addShake) addShake(0.12); // 开场一记重抖，给"电磁脉冲刚刚炸开"的重量
    // 头几帧先铺一层，别让 0~0.1s 空着
    for (let i = 0; i < 5; i++) spawnArc();
  }

  function stop() {
    active = false;
    elapsed = 0;
    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i];
      a.alive = false;
      a.line.visible = false;
      a.mat.opacity = 0;
    }
    if (scanMesh) scanMesh.visible = false;
    if (edgeMesh) edgeMesh.visible = false;
  }

  function onEmp() {
    start();
  }

  function onEnd(e) {
    // 只有 EMP 自己的结束才管，别的环境事件别误伤
    if (e && e.detail && e.detail.id === 'emp') stop();
  }

  if (events) {
    events.addEventListener('envEmp', onEmp);
    events.addEventListener('envEventEnd', onEnd);
  }

  build(); // 预建，第一次触发不卡帧

  /* ----------------------------------------------------------
   * 每帧
   * ---------------------------------------------------------- */
  function updateArcs(dt) {
    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i];
      if (!a.alive) continue;

      a.life -= dt;
      if (a.life <= 0) {
        a.alive = false;
        a.line.visible = false;
        a.mat.opacity = 0;
        continue;
      }

      const k = a.life / a.maxLife; // 1 → 0
      a.mat.opacity = 0.2 + 0.8 * k;

      a.regen -= dt;
      if (a.regen <= 0) {
        a.regen = rand(0.04, 0.09);
        buildArc(a); // 存活期内反复重画，弧身在抖，才有噼啪的电感
      }
    }
  }

  function updateScan() {
    if (!scanMesh || !edgeMesh) return;
    const phase = (elapsed % SCAN_DUR) / SCAN_DUR;
    const z = SCAN_FROM + phase * (SCAN_TO - SCAN_FROM);
    scanMesh.position.z = z;
    edgeMesh.position.z = z + 0.95;

    const fade = Math.sin(phase * Math.PI); // 两端淡入淡出，扫过去不会"啪"地出现
    scanMat.opacity = fade * 0.34;
    edgeMat.opacity = fade * 0.8;
  }

  function update(dt) {
    if (!active) return;
    if (!(dt > 0)) dt = 0;
    elapsed += dt;

    if (elapsed >= DURATION) {
      stop();
      return;
    }

    // 补弧：快到尾巴就停手，剩下的弧自己死掉，收得干净
    if (elapsed < DURATION - FADE_TAIL) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        spawnTimer = rand(0.05, 0.09);
        spawnArc();
        if (Math.random() < 0.6) spawnArc();
      }
    }

    updateArcs(dt);
    updateScan();

    // 抖屏节奏：0.6 秒补一记，别连成持续摇晃
    shakeTimer -= dt;
    if (shakeTimer <= 0 && elapsed < DURATION - FADE_TAIL) {
      shakeTimer = 0.6;
      if (addShake) addShake(0.06);
    }
  }

  function reset() {
    stop();
    release(); // 换代/切场景时把 GPU 资源还回去
  }

  return { update, reset };
}
