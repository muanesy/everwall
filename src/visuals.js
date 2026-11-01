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
const WORLD_HEIGHT = 32; // 竖屏下大约能看到的纵深范围

let renderer = null;
let scene = null;
let camera = null;
let containerEl = null;

let playerMesh = null;
let playerShadow = null;

let camBaseX = 0;
let shake = 0;

const zombieMeshes = new Map(); // id -> mesh
const bulletMeshes = new Map(); // id -> mesh
const effects = [];             // 临时特效

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
  scene.fog = new THREE.Fog(BG_COLOR, 26, 52);

  camera = new THREE.OrthographicCamera(-10, 10, 16, -16, 0.1, 200);
  camera.position.set(0, 18, 12);
  camera.lookAt(0, 0, -2);

  // 灯光：一盏天光 + 一盏主光。所有模型都从同一个方向受光。
  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x151a20, 1.15);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
  keyLight.position.set(-8, 16, 10);
  scene.add(keyLight);

  // 地面
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 80),
    new THREE.MeshStandardMaterial({ color: 0x1c242e, roughness: 0.95, metalness: 0.05 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 60, 0x2b3644, 0x1f2731);
  grid.position.y = 0.01;
  scene.add(grid);

  // 玩家占位方块。换成模型时替换这一块。
  playerMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.5, 1.0),
    new THREE.MeshStandardMaterial({
      color: 0x4ea1ff,
      roughness: 0.4,
      metalness: 0.1,
      emissive: 0x0b2a4a,
    })
  );
  playerMesh.position.set(0, 0.75, 9);
  scene.add(playerMesh);

  playerShadow = makeBlobShadow(0.75);
  playerShadow.position.set(0, 0.02, 9);
  scene.add(playerShadow);

  window.addEventListener('resize', resize);
  resize();

  // 事件 → 特效
  events.addEventListener('shoot', (e) => spawnMuzzleFlash(e.detail.x, e.detail.z));
  events.addEventListener('hit', (e) => spawnRing(e.detail.x, e.detail.z, 0xffd27a, 0.22));
  events.addEventListener('zombieDie', (e) => spawnRing(e.detail.x, e.detail.z, 0xff6a4a, 0.35));
  events.addEventListener('playerHurt', () => { shake = 0.5; });
  events.addEventListener('waveStart', () => { shake = 0.2; });
}

/* ----------------------------------------------------------
 * 每帧同步：把 state 里的数据画到屏幕上
 * ---------------------------------------------------------- */
export function syncScene(state, dt) {
  if (!renderer) return;

  // 玩家
  playerMesh.position.set(state.player.x, 0.75, state.player.z);
  playerShadow.position.set(state.player.x, 0.02, state.player.z);

  // 僵尸：有就建，没有就删
  const aliveZombies = new Set();
  for (const z of state.zombies) {
    aliveZombies.add(z.id);

    let mesh = zombieMeshes.get(z.id);
    if (!mesh) {
      mesh = makeZombieMesh(z.type);
      scene.add(mesh);
      zombieMeshes.set(z.id, mesh);
    }
    mesh.position.set(z.x, 0.62, z.z);
  }

  for (const [id, mesh] of zombieMeshes) {
    if (!aliveZombies.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      zombieMeshes.delete(id);
    }
  }

  // 子弹
  const aliveBullets = new Set();
  for (const b of state.bullets) {
    aliveBullets.add(b.id);

    let mesh = bulletMeshes.get(b.id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe08a })
      );
      scene.add(mesh);
      bulletMeshes.set(b.id, mesh);
    }
    mesh.position.set(b.x, 1.0, b.z);
  }

  for (const [id, mesh] of bulletMeshes) {
    if (!aliveBullets.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      bulletMeshes.delete(id);
    }
  }

  updateEffects(dt);
  updateCamera(state, dt);

  renderer.render(scene, camera);
}

/* ----------------------------------------------------------
 * 相机：轻微跟随玩家 + 受伤震动
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
 * 特效
 * ---------------------------------------------------------- */
function spawnMuzzleFlash(x, z) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 1 })
  );
  mesh.position.set(x, 1.0, z - 0.9);
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
  mesh.position.set(x, 0.05, z);
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
function makeZombieMesh(type) {
  const colors = [0x6b8f4e, 0x8f6b4e, 0x5e7a8f];

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.25, 0.9),
    new THREE.MeshStandardMaterial({
      color: colors[type % colors.length],
      roughness: 0.8,
    })
  );
  mesh.position.y = 0.62;

  // 脚下的影子跟着僵尸一起动
  const shadow = makeBlobShadow(0.55);
  shadow.position.set(0, -0.61, 0);
  shadow.rotation.x = -Math.PI / 2;
  mesh.add(shadow);

  return mesh;
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

  // 保证竖屏时左右至少能看见 18 个单位宽
  const viewH = Math.max(WORLD_HEIGHT, 18 / aspect);
  const viewW = viewH * aspect;

  camera.left = -viewW / 2;
  camera.right = viewW / 2;
  camera.top = viewH / 2;
  camera.bottom = -viewH / 2;
  camera.updateProjectionMatrix();

  renderer.setSize(w, h);
}
