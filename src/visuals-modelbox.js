/* ==========================================================
 * visuals-modelbox.js —— 蒙皮模型的"真实尺寸"测量与归一化（乙负责）
 *
 * 【解决什么问题】
 * 项目里给僵尸/Boss 统一身高的做法是量出模型包围盒再乘一个缩放系数。
 * 对静态模型没问题，但凡是"骨骼驱动"的蒙皮模型（SkinnedMesh + Bone），
 * Box3.setFromObject() 量出来的根本不是屏幕上看到的大小：
 *
 *   · setFromObject 走的是每个 Mesh 的 geometry.boundingBox，
 *     而蒙皮模型的顶点是在 GPU 里由骨骼矩阵变形出来的，
 *     geometry.boundingBox 只是"绑定姿势"(bind pose) 下的原始网格范围，
 *     通常还是 T-pose 张着双臂的状态，甚至被导出成原点附近的一坨。
 *   · 骨骼根节点上往往带 scale（Blender 导出常见 0.01 或者 100），
 *     setFromObject 只在 expandByObject 时按 matrixWorld 变换那八个角点，
 *     对蒙皮变形毫无感知。
 *
 * 真实踩坑记录：Boss（CreepCreature，Quaternius Ultimate Monsters）用
 * Box3.setFromObject 量出来 height ≈ 1.64 米，而它骨骼驱动的真实高度是
 * 4.92 米。差了 3 倍，于是"归一化"后模型被放大了 3 倍，直接撑破画面、
 * 脚陷进地里、摄像机全被糊住。
 *
 * 【本模块的做法】
 * 不信包围盒，只信骨骼的世界坐标：
 *   遍历 isBone / isSkinnedMesh 的节点，取 getWorldPosition()，
 *   用这些点的 AABB 当"真实占位"。骨骼是驱动网格的东西，它们的空间跨度
 *   和肉眼看到的体积强相关，所以拿来算身高、算脚底位置都足够准。
 *
 * 代价：骨骼点比网格表面稍微"内缩"一点（骨头在肉里），
 *      量出的高度会比真实渲染高度小几个百分点。
 *      做"归一化到某个目标身高"完全够用；不要拿它做精确碰撞盒。
 *
 * 【调用示例】——在 loadModels() 之后、加入场景之后
 *
 *   import { fitModelHeight, measureSkeletonBox } from './visuals-modelbox.js';
 *
 *   // 先把模型挂进场景（或至少保证 parent 是单位矩阵），矩阵才是对的
 *   scene.add(gltf.scene);
 *
 *   console.table(measureSkeletonBox(gltf.scene)); // 调试：看看真实身高多少
 *   const info = fitModelHeight(gltf.scene, 4.2);  // 把 Boss 拉到 4.2 米高
 *   console.log(info); // { scale, height, footOffset }
 *
 *   // 之后再用 skeletonClone() 复制出来的实例，已经继承了正确的 scale，
 *   // 只需要每只各自 fit 一次脚底（因为动画首帧的姿势可能不同）：
 *   const proto = skeletonClone(gltf.scene);
 *   scene.add(proto);
 *   fitModelHeight(proto, 4.2);
 *
 * 【约定】
 *   · 所有坐标都是世界坐标（world space）。
 *   · 调用方保证 root 已经在场景里，或者其祖先矩阵已更新；
 *     函数内部仍然会先 updateMatrixWorld(true) 兜底。
 *   · 只读不写场景结构，唯一的副作用是改 root.scale / root.position.y。
 * ========================================================== */

import { Vector3 } from 'three';

/** 内部复用的临时向量，避免每帧/每模型都 new 一堆 Vector3 */
const _v = new Vector3();

/**
 * 用一个空盒子做累加器。避免依赖 Box3（我们不信任 Box3 的语义，
 * 也不想让人误以为这里走的是 setFromObject）。
 */
function createAccumulator() {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
    count: 0,
  };
}

/** 把一个世界坐标点并进累加器 */
function accumulate(acc, p) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
  if (p.x < acc.minX) acc.minX = p.x;
  if (p.y < acc.minY) acc.minY = p.y;
  if (p.z < acc.minZ) acc.minZ = p.z;
  if (p.x > acc.maxX) acc.maxX = p.x;
  if (p.y > acc.maxY) acc.maxY = p.y;
  if (p.z > acc.maxZ) acc.maxZ = p.z;
  acc.count += 1;
}

/** 把累加器收尾成对外返回的对象；一个点都没有时返回全 0 的安全值 */
function finalize(acc) {
  if (acc.count === 0) {
    return {
      minX: 0, minY: 0, minZ: 0,
      maxX: 0, maxY: 0, maxZ: 0,
      height: 0,
      centerX: 0,
      centerZ: 0,
      pointCount: 0,
    };
  }
  return {
    minX: acc.minX, minY: acc.minY, minZ: acc.minZ,
    maxX: acc.maxX, maxY: acc.maxY, maxZ: acc.maxZ,
    height: acc.maxY - acc.minY,
    centerX: (acc.minX + acc.maxX) / 2,
    centerZ: (acc.minZ + acc.maxZ) / 2,
    pointCount: acc.count,
  };
}

/**
 * 量一个模型"骨骼驱动"的真实包围盒。
 *
 * @param {import('three').Object3D} root 模型根节点（gltf.scene 或 skeletonClone 的产物）
 * @returns {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number,
 *            height:number,centerX:number,centerZ:number,pointCount:number}}
 *          世界坐标；没有任何骨骼/蒙皮节点时 height 为 0（安全值，不会 NaN）
 */
export function measureSkeletonBox(root) {
  const acc = createAccumulator();

  if (!root || typeof root.traverse !== 'function') return finalize(acc);

  // 必须先把世界矩阵刷新到最新，否则 getWorldPosition 拿到的是上一帧的残留
  if (typeof root.updateMatrixWorld === 'function') root.updateMatrixWorld(true);

  root.traverse((node) => {
    if (!node) return;

    if (node.isBone) {
      // 骨骼：直接取骨头关节的世界坐标，这是蒙皮变形的真正源头
      node.getWorldPosition(_v);
      accumulate(acc, _v);
      return;
    }

    if (node.isSkinnedMesh) {
      // 蒙皮网格：不要用 mesh 自己的 position（通常就落在原点，
      // 会把 minY 拉成 0，脚底对齐就废了），按它身上的骨骼位置计入。
      const bones = node.skeleton && node.skeleton.bones;
      if (bones && bones.length) {
        for (let i = 0; i < bones.length; i += 1) {
          const b = bones[i];
          if (!b) continue;
          b.getWorldPosition(_v);
          accumulate(acc, _v);
        }
      } else {
        // 极端情况：标了 isSkinnedMesh 却没有骨骼，只能退回自身世界坐标
        node.getWorldPosition(_v);
        accumulate(acc, _v);
      }
    }
  });

  return finalize(acc);
}

/**
 * 把模型等比缩放到指定身高，并把脚底对齐到 y = 0。
 *
 * 步骤：
 *   1) 用 measureSkeletonBox 量**真实**高度（不是 Box3 量出来的假高度）
 *   2) scale = targetHeight / height，乘到 root.scale 上（累乘，不覆盖）
 *   3) 再量一次，把 root.position.y 下移 newMinY，让最低点落在 y = 0
 *
 * @param {import('three').Object3D} root
 * @param {number} targetHeight 期望身高（世界单位，米）
 * @returns {{scale:number, height:number, footOffset:number}}
 *          scale   —— 本次施加的缩放倍数
 *          height  —— 缩放后实测的身高（略微内缩，略小于 targetHeight）
 *          footOffset —— 为了让脚底贴地而对 y 施加的位移量（= -缩放前的新 minY）
 */
export function fitModelHeight(root, targetHeight) {
  if (!root) return { scale: 1, height: 0, footOffset: 0 };

  const before = measureSkeletonBox(root);

  // 量不出高度（空场景 / 没有骨骼 / targetHeight 非法）就原样返回，绝不缩放。
  // 宁可模型大小不对，也不要 scale = Infinity 把整个场景炸掉。
  if (!(before.height > 0) || !Number.isFinite(targetHeight) || targetHeight <= 0) {
    return { scale: 1, height: before.height, footOffset: 0 };
  }

  const scale = targetHeight / before.height;
  root.scale.multiplyScalar(scale); // 累乘：保留模型原本自带的 scale
  if (typeof root.updateMatrixWorld === 'function') root.updateMatrixWorld(true);

  const after = measureSkeletonBox(root);
  const footOffset = -after.minY;
  root.position.y -= after.minY; // 最低点抬到 y = 0
  if (typeof root.updateMatrixWorld === 'function') root.updateMatrixWorld(true);

  return { scale, height: after.height, footOffset };
}
