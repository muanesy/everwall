/* ==========================================================
 * 画面层（乙负责）
 *
 * 职责：搭 3D 场景、相机、灯光、地面，把 state 里的东西画出来，
 *      并接收 game.js 发来的事件播放特效。
 *
 * 这里只读 state，不改 state。
 * 换模型、换贴图、调画面，都只在这个文件里改。
 * ========================================================== */

import * as THREE from 'three';

const BG_COLOR = 0x0b0f14;
const WORLD_HEIGHT = 32;
const MAX_SOLDIER_VISUALS = 60;

let renderer = null;
let scene = null;
let camera = null;
let containerEl = null;

let playerMesh = null;
let playerShadow = null;
let soldierMesh = null;
let plusOneTexture = null;

let camBaseX = 0;
let shake = 0;

const zombieMeshes = new Map();
const barrierMeshes = new Map();
const bulletMeshes = new Map();
const effects = [];

const dummy = new THREE.Object3D();

/* ----------------------------------------------------------
 * 初始化
 * ---------------------------------------------------------- */
export function initVisuals(container, events) {
  containerEl = container;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);
  scene.fog = new THREE.Fog(BG_COLOR, 30, 56);

  camera = new THREE.OrthographicCamera(-10, 10, 16, -16, 0.1, 200);
  camera.position.set(0, 18, 12);
  camera.lookAt(0, 0, -2);

  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x151a20, 1.15);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
  keyLight.position.set(-8, 16, 10);
  scene.add(keyLight);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 80),
    new THREE.MeshStandardMaterial({ color: 0x1c242e, roughness: 0.95, metalness: 0.05 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 60, 0x2b3644, 0x1f2731);
  grid.position.y = 0.01;
  scene.add(grid);

  // 队长
  playerMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 1.2, 0.8),
    new THREE.MeshStandardMaterial({
      color: 0x4ea1ff,
      roughness: 0.4,
      metalness: 0.1,
      emissive: 0x0b2a4a,
    })
  );
  playerMesh.position.set(0, 0.6, 9);
  scene.add(playerMesh);

  playerShadow = makeBlobShadow(0.7);
  playerShadow.position.set(0, 0.02, 9);
  scene.add(playerShadow);

  // 士兵：用实例化渲染，最多同时画 60 个
  soldierMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.32, 0.45, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x6fc2ff, roughness: 0.5 }),
    MAX_SOLDIER_VISUALS
  );
  soldierMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  soldierMesh.count = 0;
  scene.add(soldierMesh);

  plusOneTexture = makePlusOneTexture();

  window.addEventListener('resize', resize);
  resize();

  // 事件 → 特效
  events.addEventListener('shoot', (e) => spawnMuzzleFlash(e.detail.x, e.detail.z));
  events.addEventListener('barrierHit', (e) => spawnRing(e.detail.x, e.detail.z, 0x6dffb0, 0.22));
  events.addEventListener('barrierBreak', (e) => spawnRing(e.detail.x, e.detail.z, 0x6dffb0, 0.4));
  events.addEventListener('zombieDie', (e) => spawnRing(e.detail.x, e.detail.z, 0xff6a4a, 0.3));
  events.addEventListener('armyHurt', (e) => {
    const amount = e.detail?.amount ?? 1;
    shake = 0.3 + amount * 0.12;
  });
  events.addEventListener('waveStart', () => { shake = 0.2; });
}

/* ----------------------------------------------------------
 * 每帧同步
 * ---------------------------------------------------------- */
export function syncScene(state, dt) {
  if (!renderer) return;

  // 队长
  playerMesh.position.set(state.player.x, 0.6, state.player.z);
  playerShadow.position.set(state.player.x, 0.02, state.player.z);

  // 士兵队伍
  updateSoldiers(state);

  // +1 屏障
  syncBarriers(state);

  // 僵尸
  syncZombies(state);

  // 子弹
  syncBullets(state);

  updateEffects(dt);
  updateCamera(state, dt);

  renderer.render(scene, camera);
}

function updateSoldiers(state) {
  const n = Math.min(state.soldiers, MAX_SOLDIER_VISUALS);
  soldierMesh.count = n;

  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 6);
    const col = i % 6;

    dummy.position.set(
      state.player.x + (col - 2.5) * 0.5,
      0.22,
      state.player.z + 0.7 + row * 0.5
    );
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();

    soldierMesh.setMatrixAt(i, dummy.matrix);
  }

  soldierMesh.instanceMatrix.needsUpdate = true;
}

function syncBarriers(state) {
  const alive = new Set();

  for (const bar of state.barriers) {
    alive.add(bar.id);

    let mesh = barrierMeshes.get(bar.id);
    if (!mesh) {
      mesh = makeBarrierMesh();
      scene.add(mesh);
      barrierMeshes.set(bar.id, mesh);
    }
    mesh.position.set(bar.x, 0, bar.z);
  }

  for (const [id, mesh] of barrierMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      barrierMeshes.delete(id);
    }
  }
}

function syncZombies(state) {
  const alive = new Set();

  for (const z of state.zombies) {
    alive.add(z.id);

    let mesh = zombieMeshes.get(z.id);
    if (!mesh) {
      mesh = makeZombieMesh(z.type);
      scene.add(mesh);
      zombieMeshes.set(z.id, mesh);
    }
    mesh.position.set(z.x, 0.45, z.z);
  }

  for (const [id, mesh] of zombieMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      zombieMeshes.delete(id);
    }
  }
}

function syncBullets(state) {
  const alive = new Set();

  for (const b of state.bullets) {
    alive.add(b.id);

    let mesh = bulletMeshes.get(b.id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe08a })
      );
      scene.add(mesh);
      bulletMeshes.set(b.id, mesh);
    }
    mesh.position.set(b.x, 0.9, b.z);
  }

  for (const [id, mesh] of bulletMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      bulletMeshes.delete(id);
    }
  }
}

/* ----------------------------------------------------------
 * 相机
 * ---------------------------------------------------------- */
function updateCamera(state, dt) {
  camBaseX += (state.player.x * 0.22 - camBaseX) * Math.min(1, dt * 5);

  let sx = 0;
  let sy = 0;

  if (shake > 0) {
    shake = Math.max(0, shake - dt * 2.2);
    sx = (Math.random() - 0.5) * shake;
    sy = (Math.random() - 0.5) * shake;
  }

  camera.position.set(camBaseX + sx, 18 + sy, 12);
  camera.lookAt(camBaseX, 0, -2);
}

/* ----------------------------------------------------------
 * 模型
 * ---------------------------------------------------------- */
function makeBarrierMesh() {
  const group = new THREE.Group();

  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.28, 0.5),
    new THREE.MeshStandardMaterial({
      color: 0x2fbf71,
      emissive: 0x0d5c33,
      roughness: 0.5,
      metalness: 0.1,
    })
  );
  bar.position.y = 0.14;
  group.add(bar);

  // 浮在上面的 +1 标签，Sprite 永远朝向相机
  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: plusOneTexture,
      transparent: true,
      depthWrite: false,
    })
  );
  label.scale.set(1.15, 0.6, 1);
  label.position.y = 0.95;
  group.add(label);

  return group;
}

function makeZombieMesh(type) {
  const colors = [0x8f5a5a, 0x6b8f5a, 0x5a6f8f];

  return new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.9, 0.55),
    new THREE.MeshStandardMaterial({
      color: colors[type % colors.length],
      roughness: 0.85,
    })
  );
}

function makeBlobShadow(radius) {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 24),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function makePlusOneTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 64);
  ctx.font = 'bold 52px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#6dffb0';
  ctx.fillText('+1', 64, 34);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ----------------------------------------------------------
 * 特效
 * ---------------------------------------------------------- */
function spawnMuzzleFlash(x, z) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 1 })
  );
  mesh.position.set(x, 0.9, z - 0.9);
  scene.add(mesh);
  effects.push({ mesh, life: 0, maxLife: 0.09, type: 'flash' });
}

function spawnRing(x, z, color, maxLife) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.18, 0.32, 20),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.06, z);
  scene.add(mesh);
  effects.push({ mesh, life: 0, maxLife, type: 'ring' });
}

function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const fx = effects[i];
    fx.life += dt;

    const t = fx.life / fx.maxLife;

    if (t >= 1) {
      scene.remove(fx.mesh);
      disposeMesh(fx.mesh);
      effects.splice(i, 1);
      continue;
    }

    if (fx.type === 'ring') {
      const s = 1 + t * 3;
      fx.mesh.scale.set(s, s, s);
      fx.mesh.material.opacity = (1 - t) * 0.9;
    } else {
      fx.mesh.scale.setScalar(1 + t * 0.6);
      fx.mesh.material.opacity = 1 - t;
    }
  }
}

/* ----------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------- */
function disposeMesh(mesh) {
  mesh.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
}

function resize() {
  if (!containerEl || !renderer || !camera) return;

  const w = containerEl.clientWidth;
  const h = containerEl.clientHeight;
  const aspect = w / h;

  const viewH = Math.max(WORLD_HEIGHT, 18 / aspect);
  const viewW = viewH * aspect;

  camera.left = -viewW / 2;
  camera.right = viewW / 2;
  camera.top = viewH / 2;
  camera.bottom = -viewH / 2;
  camera.updateProjectionMatrix();

  renderer.setSize(w, h);
}
