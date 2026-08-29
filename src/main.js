import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import "./style.css";
import { DEFAULT_OFFICIAL_ACTION, OFFICIAL_ACTIONS } from "./official-actions.js";
import {
  barycentric2D,
  bindPointToFaceMesh,
  buildRegionFallbackSegments,
  buildMirrorIndexMap,
  computeCoverTransform,
  correctActionPoint,
  faceVertexIndices,
  imageLandmarkUv,
  landmarkToOrthographicWorld,
  parseCanonicalFaceObj,
  referenceFaceVertices as buildReferenceFaceVertices,
} from "./face-geometry.js";

const APP_BASE_URL = import.meta.env.BASE_URL;

function assetUrl(path) {
  if (/^(?:https?:)?\/\//.test(path)) return path;
  return `${APP_BASE_URL}${String(path).replace(/^\/+/, "")}`;
}

const video = document.querySelector("#camera");
const canvas = document.querySelector("#webgl");
const previewFace = document.querySelector("#previewFace");
const cameraButton = document.querySelector("#cameraButton");
const status = document.querySelector("#status");
const stepLabel = document.querySelector("#stepLabel");
const instructionText = document.querySelector("#instructionText");
const progressBar = document.querySelector("#progressBar");
const modeButtons = [...document.querySelectorAll(".action-button")];
const officialActionSelect = document.querySelector("#officialActionSelect");
const actionNumber = document.querySelector("#actionNumber");
const actionCategory = document.querySelector("#actionCategory");
const handOverlay = document.querySelector("#handOverlay");
const handCtx = handOverlay?.getContext("2d");
const cameraStage = document.querySelector(".camera-stage");

// ── 手部离开化妆区域 → 腕带震动（摄像头闭环）──
const HAPTIC_WS_URL = "ws://127.0.0.1:8787"; // nano_bridge.py 监听地址
const HAPTIC_LEAVE_MS = 250; // 手离开区域超过该时长才触发震动（防抖）
const HAPTIC_HOLD_MS = 400; // 震动期间重发 '3' 的间隔（喂 Nano 3s 看门狗）
const HAPTIC_ARM_MS = 4000; // 手最近出现超过该时长 → 不判定（防止手还没伸进画面就误震）
const HAPTIC_TRACK_EVERY_N = 2; // 手部检测隔帧执行，省性能
const HAPTIC_OPEN_TOL = 0.09; // 开放曲线区域（眼线等）指尖到折线距离阈值（按脸宽比例）
const HAPTIC_OPEN_MIN_PX = 0.02; // 同上，归一化坐标下限，防脸太远时阈值过小
const HAPTIC_REGION_PAD = 0.03; // 闭合区域额外容忍带（按脸宽比例，约 3% 脸宽），指尖出界不超过该距离仍算在区域内
const HAND_KEYPOINTS = [8, 12, 0]; // 食指指尖 / 中指指尖 / 掌根（任一在区域内即算在）

const MODES = {
  brow: {
    index: "01",
    label: "眉毛",
    instruction: "眉刷从眉中贴合眉形，顺势带向眉尾",
    sequence: "brow",
    frames: 33,
    fps: 12,
    planeWidth: 1.35,
    contactX: 0.42,
    contactY: 0.06,
    targetX: -0.2,
    targetY: 0.25,
  },
  eyeshadow: {
    index: "02",
    label: "眼影",
    instruction: "刷头贴近眼褶，小范围移动完成细节晕染",
    sequence: "eyeshadow",
    frames: 7,
    fps: 6,
    planeWidth: 1.35,
    contactX: 0.51,
    contactY: 0.08,
    targetX: -0.19,
    targetY: 0.16,
  },
  foundation: {
    index: "03",
    label: "粉底",
    instruction: "从面中向外移动，沿脸部曲面均匀推开",
    sequence: "foundation",
    frames: 17,
    fps: 9,
    planeWidth: 1.45,
    contactX: 0.286,
    contactY: 0.208,
    targetX: -0.22,
    targetY: 0.03,
  },
  contour: {
    index: "04",
    label: "修容",
    instruction: "沿颧骨下方斜向移动，保持刷面贴合",
    sequence: "contour",
    frames: 16,
    fps: 8,
    planeWidth: 1.45,
    contactX: 0.29,
    contactY: 0.15,
    targetX: -0.31,
    targetY: -0.04,
  },
  powder: {
    index: "05",
    label: "定妆",
    instruction: "粉扑贴近面中，以连续轻拍完成定妆",
    sequence: "powder",
    frames: 38,
    fps: 12,
    planeWidth: 1.35,
    contactX: 0.47,
    contactY: 0.25,
    targetX: -0.2,
    targetY: 0.01,
  },
};

let activeMode = DEFAULT_OFFICIAL_ACTION.toolMode;
let activeOfficialAction = DEFAULT_OFFICIAL_ACTION;
let activeToolKey = DEFAULT_OFFICIAL_ACTION.category;
let officialActionTrack = null;
let officialActionLoadVersion = 0;
let FaceLandmarker = null;
let HandLandmarker = null;
let FilesetResolver = null;
let faceLandmarker = null;
let stream = null;

// 手部离开区域 → 腕带震动 状态
let handLandmarker = null;
let liveHands = [];
let handTrackFrame = 0;
let lastHandSeenAt = -Infinity;
let handInRegion = false;
let hapticPhase = "idle"; // idle | out | vibrating
let hapticPhaseSince = 0;
let hapticLastSendAt = 0;
let hapticSocket = null;
let hapticSocketOpen = false;
let hapticRetryTimer = null;
let hapticReady = false;
let lastHapticBadgeText = "";

let liveLandmarks = null;
let liveFaceMesh = null;
let liveFacePoints = null;
let videoTexture = null;
let lastVideoTime = -1;
let animationStart = performance.now();
let previousCycle = -1;
let sequenceLoadVersion = 0;
let currentTextures = [];
let previewFaceWidth = 0.9;
let trackedFaceLayout = null;
let referenceMotion = {};
let referenceFaceVertices = null;
let referenceFaceVertexNormals = null;
let referenceFaceLandmarks = null;
let referenceFaceTriangles = [];
let canonicalFaceVertices = [];
let referenceFaceMirrorMap = [];
let referenceFaceVertexTriangles = [];
let photoHeadReady = false;
let viewYaw = 0;
let viewPitch = 0;
let viewDragging = false;
let viewPointerX = 0;
let viewPointerY = 0;
let userViewActive = false;
let smoothedToolContact = null;
let smoothedContactKey = "";
let currentFaceForward = new THREE.Vector3(0, 0, 1);
let liveFaceNormalHistory = [];
let renderFrameCount = 0;
let renderWindowStart = 0;

const sequenceCache = new Map();
const textureLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
let officialRegionLibraryPromise = null;
let canonicalFacePromise = null;

function loadOfficialRegionLibrary() {
  if (!officialRegionLibraryPromise) {
    officialRegionLibraryPromise = fetch(assetUrl("regions/all.json"))
      .then((response) => {
        if (!response.ok) throw new Error(`Region library HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => new Map((payload.regions ?? []).map((region) => [region.id, region])));
  }
  return officialRegionLibraryPromise;
}

// MediaPipe 478-point regions. Every path starts near the center of the face
// and follows the real cosmetic application area toward the outside.
const MAKEUP_REGION_PATHS = {
  brow: [
    [107, 66, 105, 63, 70],
    [336, 296, 334, 293, 300],
  ],
  eyeshadow: [
    [133, 158, 160, 33],
    [362, 385, 387, 263],
  ],
  foundation: [
    [129, 203, 206, 205, 50, 123],
    [358, 423, 426, 425, 280, 352],
  ],
  contour: [
    [123, 147, 187, 205, 203],
    [352, 376, 411, 425, 423],
  ],
  powder: [
    [205, 206, 216, 92, 186, 205],
    [425, 426, 436, 322, 410, 425],
  ],
};

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.16;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
camera.position.z = 5;

scene.add(new THREE.HemisphereLight(0xfffaf4, 0x7e685d, 2.7));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.5);
keyLight.position.set(-2.4, 3.2, 4.5);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xe9cbb8, 1.5);
rimLight.position.set(3, 1, 2);
scene.add(rimLight);

const photoHead = new THREE.Group();
photoHead.name = "photo-uv-478-face";
photoHead.visible = false;
photoHead.position.set(0, 0.01, -0.24);
scene.add(photoHead);

function loadCanonicalFace() {
  if (!canonicalFacePromise) {
    canonicalFacePromise = fetch(assetUrl("models/canonical-face-model.obj"))
      .then((response) => {
        if (!response.ok) throw new Error(`Canonical face HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        const canonical = parseCanonicalFaceObj(text);
        if (canonical.vertices.length !== 468 || canonical.faces.length < 800) {
          throw new Error("Canonical face topology is incomplete");
        }
        referenceFaceTriangles = canonical.faces;
        canonicalFaceVertices = canonical.vertices;
        referenceFaceMirrorMap = buildMirrorIndexMap(canonical.vertices);
        referenceFaceVertexTriangles = Array.from({ length: 468 }, () => []);
        canonical.faces.forEach((face) => {
          const indices = faceVertexIndices(face);
          indices.forEach((index) => referenceFaceVertexTriangles[index]?.push(indices));
        });
        return canonical;
      });
  }
  return canonicalFacePromise;
}

function makePhotoFaceGeometry(landmarks, canonical, imageAspect) {
  referenceFaceVertices = buildReferenceFaceVertices(landmarks, imageAspect);
  const meshVertices = referenceFaceVertices.slice(0, 468);
  const normalVectors = Array.from({ length: referenceFaceVertices.length }, () => new THREE.Vector3());
  canonical.faces.forEach((face) => {
    const [indexA, indexB, indexC] = faceVertexIndices(face);
    const a = new THREE.Vector3(...meshVertices[indexA]);
    const b = new THREE.Vector3(...meshVertices[indexB]);
    const c = new THREE.Vector3(...meshVertices[indexC]);
    const faceNormal = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a));
    normalVectors[indexA].add(faceNormal);
    normalVectors[indexB].add(faceNormal);
    normalVectors[indexC].add(faceNormal);
  });
  referenceFaceVertexNormals = normalVectors.map((normal) => (
    normal.lengthSq() > 1e-12 ? normal.normalize().toArray() : [0, 0, 1]
  ));

  const positions = [];
  const uvs = [];
  canonical.faces.forEach((face) => {
    face.forEach(({ vertexIndex }) => {
      positions.push(...meshVertices[vertexIndex]);
      uvs.push(...imageLandmarkUv(landmarks[vertexIndex]));
    });
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

async function ensureVisionRuntime() {
  if (!FaceLandmarker || !FilesetResolver) {
    const visionTasks = await import("@mediapipe/tasks-vision");
    FaceLandmarker = visionTasks.FaceLandmarker;
    HandLandmarker = visionTasks.HandLandmarker;
    FilesetResolver = visionTasks.FilesetResolver;
  }
  return FilesetResolver.forVisionTasks(assetUrl("vendor/wasm"));
}

async function loadPhotoHead() {
  setStatus("正在加载照片生成的 478 点投影人脸…");
  try {
    const [canonical, landmarks, texture] = await Promise.all([
      loadCanonicalFace(),
      fetch(assetUrl("models/reference-face-478.json")).then((response) => response.json()),
      textureLoader.loadAsync(assetUrl("models/reference-face-projection.png")),
    ]);
    if (!landmarks || landmarks.length !== 478) throw new Error("Reference image did not return 478 landmarks");
    referenceFaceLandmarks = landmarks;

    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const imageAspect = texture.image.naturalHeight / texture.image.naturalWidth;

    const face = new THREE.Mesh(
      makePhotoFaceGeometry(landmarks, canonical, imageAspect),
      new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        toneMapped: false,
        transparent: true,
        alphaTest: 0.015,
        depthWrite: true,
      }),
    );
    face.name = "reference-photo-uv-face-surface";
    face.renderOrder = 1;
    face.frustumCulled = false;
    photoHead.add(face);
    photoHeadReady = true;
    photoHead.visible = !stream;
    document.body.dataset.faceAsset = "reference-photo-direct-projection";
    document.body.dataset.photoBackdrop = "disabled-to-prevent-double-face";
    document.body.dataset.referenceProjection = "pixel-aspect-and-mediapipe-depth";
    document.body.dataset.referenceTexture = "edge-clean-projection-srgb";
    document.body.dataset.referenceLandmarkCount = String(landmarks.length);
    window.__referenceFaceLandmarks = landmarks;
    resize();
    if (!stream) setStatus(`照片投影 3D 人脸 · 478 点 · ${activeOfficialAction.categoryLabel}`);
  } catch (error) {
    console.error("Failed to build photo UV face", error);
    setStatus("照片人脸生成失败，请检查网络后重试", "is-error");
  }
}

const sequenceMaterial = new THREE.MeshBasicMaterial({
  transparent: true,
  depthTest: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false,
  alphaTest: 0.01,
});
const sequencePlane = new THREE.Mesh(new THREE.PlaneGeometry(4 / 3, 1), sequenceMaterial);
sequencePlane.position.z = 1.2;
sequencePlane.renderOrder = 20;
sequencePlane.visible = false;
scene.add(sequencePlane);

const VOLUME_SPECS = {
  brow: { scale: 0.76, depth: 0.075, contactLift: 0.038, tiltX: -0.2, tiltY: 0.035 },
  eyeshadow: { scale: 0.74, depth: 0.07, contactLift: 0.036, tiltX: -0.22, tiltY: 0.035 },
  foundation: { scale: 0.82, depth: 0.08, contactLift: 0.042, tiltX: -0.19, tiltY: 0.05 },
  contour: { scale: 0.86, depth: 0.085, contactLift: 0.046, tiltX: -0.21, tiltY: 0.065 },
  powder: { scale: 0.8, depth: 0.09, contactLift: 0.048, tiltX: -0.18, tiltY: 0.035 },
};

const TOOL_SPECS = {
  concealer: { asset: "brush-pencil.glb", scale: 0.52, roll: 0.82, tiltX: -0.78, tiltY: 0.08, contactLift: 0.009, contactZone: 0.14, contactNormalDot: 0.25 },
  eyebrow: { asset: "brush-angle-shader.glb", scale: 0.56, roll: 0.72, tiltX: -0.74, tiltY: 0.07, contactLift: 0.009, contactZone: 0.08, contactNormalDot: 0.18 },
  eyeshadow: { asset: "brush-angle-shader.glb", scale: 0.5, roll: 0.52, tiltX: -0.76, tiltY: 0.07, contactLift: 0.008, contactZone: 0.04, contactNormalDot: 0.18 },
  eyeliner: { asset: "brush-pencil.glb", scale: 0.54, roll: 0.64, tiltX: -0.82, tiltY: 0.06, contactLift: 0.007, contactZone: 0.1, contactNormalDot: 0.25 },
  foundation: { asset: "blender-sponge.glb", scale: 0.25, roll: 0.32, tiltX: 0.58, tiltY: 0.05, contactLift: 0.01, tip: "min", contactZone: 0.42, contactNormalDot: 0.15 },
  blush: { asset: "brush-large-blush.glb", scale: 0.62, roll: 0.88, tiltX: -0.72, tiltY: 0.09, contactLift: 0.011, contactZone: 0.22, contactNormalDot: 0.12 },
  face_contour: { asset: "brush-large-blush.glb", scale: 0.64, roll: 0.82, tiltX: -0.74, tiltY: 0.1, contactLift: 0.011, contactZone: 0.22, contactNormalDot: 0.12 },
  nose_contour: { asset: "brush-angle-shader.glb", scale: 0.5, roll: 0.28, tiltX: -0.8, tiltY: 0.07, contactLift: 0.008, contactZone: 0.15, contactNormalDot: 0.18 },
  highlight: { asset: "brush-angle-shader.glb", scale: 0.52, roll: 0.72, tiltX: -0.76, tiltY: 0.07, contactLift: 0.009, contactZone: 0.08, contactNormalDot: 0.18 },
  full_face_setting: { asset: "blender-sponge.glb", scale: 0.28, roll: 0.08, tiltX: 0.56, tiltY: 0.04, contactLift: 0.011, tip: "min", contactZone: 0.42, contactNormalDot: 0.15 },
  lip: { asset: "brush-lip-liner.glb", scale: 0.52, roll: 0.66, tiltX: -0.82, tiltY: 0.06, contactLift: 0.007, contactZone: 0.12, contactNormalDot: 0.3 },
};

const makeupTools = Object.fromEntries(
  Object.keys(TOOL_SPECS).map((category) => {
    const group = new THREE.Group();
    group.name = `${category}-true-3d-tool`;
    group.visible = false;
    group.renderOrder = 30;
    scene.add(group);
    return [category, {
      group,
      ready: false,
      supportPoints: [],
      collisionSamples: [],
      collisionTriangles: [],
      allTriangles: [],
      triangleComponents: [],
    }];
  }),
);

const makeupRegionGuide = new THREE.Group();
makeupRegionGuide.name = "makeup-region-path-guide";
makeupRegionGuide.visible = false;
scene.add(makeupRegionGuide);

const ACTION_RANGE_WIDTH = {
  concealer: 0.042,
  eyebrow: 0.026,
  eyeshadow: 0.052,
  eyeliner: 0.018,
  foundation: 0.075,
  blush: 0.085,
  face_contour: 0.068,
  nose_contour: 0.042,
  highlight: 0.052,
  full_face_setting: 0.095,
  lip: 0.032,
};

const actionRangeMeshes = [0, 1].map((rangeIndex) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(1536 * 3), 3));
  const material = new THREE.MeshBasicMaterial({
    color: rangeIndex === 0 ? 0xff8a2a : 0xffc27a,
    transparent: true,
    opacity: rangeIndex === 0 ? 0.28 : 0.1,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = rangeIndex === 0 ? "active-makeup-range" : "upcoming-makeup-range";
  mesh.renderOrder = 39;
  mesh.frustumCulled = false;
  makeupRegionGuide.add(mesh);
  return mesh;
});

const makeupAreaGroup = new THREE.Group();
makeupAreaGroup.name = "official-478-makeup-regions";
makeupRegionGuide.add(makeupAreaGroup);

const makeupAreaStates = Array.from({ length: 12 }, (_, regionIndex) => {
  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(512 * 3), 3));
  const outlineGeometry = new THREE.BufferGeometry();
  outlineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(128 * 3), 3));
  const fill = new THREE.Mesh(
    fillGeometry,
    new THREE.MeshBasicMaterial({
      color: regionIndex === 0 ? 0xff8a2a : 0xffbc70,
      transparent: true,
      opacity: regionIndex === 0 ? 0.22 : 0.14,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const outline = new THREE.Line(
    outlineGeometry,
    new THREE.LineBasicMaterial({
      color: regionIndex === 0 ? 0xf36f18 : 0xffa34d,
      transparent: true,
      opacity: 0.92,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  fill.renderOrder = 37;
  outline.renderOrder = 38;
  fill.frustumCulled = false;
  outline.frustumCulled = false;
  fill.visible = false;
  outline.visible = false;
  makeupAreaGroup.add(fill, outline);
  return { fill, outline };
});

const regionSideGuides = [0, 1].map((side) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(1024 * 3), 3));
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0xff8124,
    transparent: true,
    opacity: 0.3,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const pointMaterial = new THREE.PointsMaterial({
    color: 0xffb263,
    size: 5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.34,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const line = new THREE.Line(geometry, lineMaterial);
  const points = new THREE.Points(geometry, pointMaterial);
  line.renderOrder = 40;
  points.renderOrder = 41;
  line.frustumCulled = false;
  points.frustumCulled = false;
  makeupRegionGuide.add(line, points);
  return { side, geometry, lineMaterial, pointMaterial };
});

const regionCursor = new THREE.Mesh(
  new THREE.RingGeometry(0.62, 1, 32),
  new THREE.MeshBasicMaterial({
    color: 0xff721c,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  }),
);
regionCursor.name = "active-makeup-contact";
regionCursor.renderOrder = 42;
makeupRegionGuide.add(regionCursor);

function updateActionRangeMesh(mesh, pathPoints, face, widthRatio) {
  const position = mesh.geometry.attributes.position;
  if (!pathPoints.length) {
    mesh.geometry.setDrawRange(0, 0);
    return;
  }
  const faceNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).normalize();
  const rangeWidth = face.width * widthRatio;
  let vertexIndex = 0;
  const writeDotRange = (center) => {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(face.quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(face.quaternion).normalize();
    const liftedCenter = center.clone().addScaledVector(faceNormal, face.width * 0.007);
    const sides = 18;
    for (let side = 0; side < sides && vertexIndex + 3 <= position.count; side += 1) {
      const angleA = side / sides * Math.PI * 2;
      const angleB = (side + 1) / sides * Math.PI * 2;
      const pointA = liftedCenter.clone()
        .addScaledVector(right, Math.cos(angleA) * rangeWidth)
        .addScaledVector(up, Math.sin(angleA) * rangeWidth);
      const pointB = liftedCenter.clone()
        .addScaledVector(right, Math.cos(angleB) * rangeWidth)
        .addScaledVector(up, Math.sin(angleB) * rangeWidth);
      [liftedCenter, pointA, pointB].forEach((point) => {
        position.setXYZ(vertexIndex, point.x, point.y, point.z);
        vertexIndex += 1;
      });
    }
  };
  for (let index = 0; index < pathPoints.length - 1 && vertexIndex + 6 <= position.count; index += 1) {
    const start = pathPoints[index];
    const end = pathPoints[index + 1];
    const tangent = end.clone().sub(start);
    if (tangent.lengthSq() < 1e-8) continue;
    tangent.normalize();
    const lateral = new THREE.Vector3().crossVectors(faceNormal, tangent).normalize();
    const lift = faceNormal.clone().multiplyScalar(face.width * 0.007);
    const leftStart = start.clone().addScaledVector(lateral, rangeWidth).add(lift);
    const rightStart = start.clone().addScaledVector(lateral, -rangeWidth).add(lift);
    const leftEnd = end.clone().addScaledVector(lateral, rangeWidth).add(lift);
    const rightEnd = end.clone().addScaledVector(lateral, -rangeWidth).add(lift);
    [leftStart, rightStart, leftEnd, leftEnd, rightStart, rightEnd].forEach((point) => {
      position.setXYZ(vertexIndex, point.x, point.y, point.z);
      vertexIndex += 1;
    });
  }
  if (vertexIndex === 0) writeDotRange(pathPoints[0]);
  position.needsUpdate = true;
  mesh.geometry.setDrawRange(0, vertexIndex);
}

const toolAssetCache = new Map();

function configureTrue3DTool(model, tip = "max") {
  model.updateMatrixWorld(true);
  const initialBox = new THREE.Box3().setFromObject(model);
  const initialSize = initialBox.getSize(new THREE.Vector3());
  if (!Number.isFinite(initialSize.y) || initialSize.y <= 0) throw new Error("3D tool has invalid bounds");

  model.scale.multiplyScalar(1 / initialSize.y);
  model.updateMatrixWorld(true);
  const normalizedBox = new THREE.Box3().setFromObject(model);
  const center = normalizedBox.getCenter(new THREE.Vector3());
  const contactY = tip === "min" ? normalizedBox.min.y : normalizedBox.max.y;
  model.position.x -= center.x;
  model.position.y -= contactY;
  model.position.z -= center.z;
  model.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = false;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach((material) => {
      material.transparent = true;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
      material.needsUpdate = true;
    });
  });
  model.updateMatrixWorld(true);
  return model;
}

function loadToolAsset(asset) {
  if (!toolAssetCache.has(asset)) {
    toolAssetCache.set(asset, gltfLoader.loadAsync(assetUrl(`models/${asset}`))
      .then((gltf) => gltf.scene));
  }
  return toolAssetCache.get(asset);
}

function toolCollisionGeometry(model) {
  model.updateMatrixWorld(true);
  const points = [];
  const triangles = [];
  const triangleComponents = [];
  let componentIndex = 0;
  model.traverse((object) => {
    const position = object.isMesh ? object.geometry?.attributes?.position : null;
    if (!position) return;
    const baseIndex = points.length;
    for (let index = 0; index < position.count; index += 1) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld));
    }
    const geometryIndex = object.geometry.index;
    const indexCount = geometryIndex?.count ?? position.count;
    for (let index = 0; index + 2 < indexCount; index += 3) {
      triangles.push([
        baseIndex + (geometryIndex ? geometryIndex.getX(index) : index),
        baseIndex + (geometryIndex ? geometryIndex.getX(index + 1) : index + 1),
        baseIndex + (geometryIndex ? geometryIndex.getX(index + 2) : index + 2),
      ]);
      triangleComponents.push(componentIndex);
    }
    componentIndex += 1;
  });
  const collisionSamples = points.map((point) => point.clone());
  triangles.forEach(([indexA, indexB, indexC]) => {
    const a = points[indexA];
    const b = points[indexB];
    const c = points[indexC];
    collisionSamples.push(
      a.clone().add(b).multiplyScalar(0.5),
      b.clone().add(c).multiplyScalar(0.5),
      c.clone().add(a).multiplyScalar(0.5),
      a.clone().add(b).add(c).multiplyScalar(1 / 3),
    );
  });
  return {
    supportPoints: points,
    collisionSamples,
    collisionTriangles: triangles,
    triangleComponents,
  };
}

async function loadMakeupTools() {
  await Promise.all(Object.entries(TOOL_SPECS).map(async ([category, spec]) => {
    try {
      const source = await loadToolAsset(spec.asset);
      const modelClone = source.clone(true);
      modelClone.traverse((object) => {
        if (!object.isMesh) return;
        object.material = Array.isArray(object.material)
          ? object.material.map((material) => material.clone())
          : object.material.clone();
      });
      const model = configureTrue3DTool(modelClone, spec.tip);
      model.name = `${category}-${spec.asset}`;
      const collisionGeometry = toolCollisionGeometry(model);
      makeupTools[category].supportPoints = collisionGeometry.supportPoints;
      makeupTools[category].collisionSamples = collisionGeometry.collisionSamples;
      makeupTools[category].allTriangles = collisionGeometry.collisionTriangles;
      makeupTools[category].triangleComponents = collisionGeometry.triangleComponents;
      makeupTools[category].collisionTriangles = collisionGeometry.collisionTriangles.filter((triangle, triangleIndex) => {
        if (spec.softComponent !== undefined) {
          return collisionGeometry.triangleComponents[triangleIndex] !== spec.softComponent;
        }
        const points = triangle.map((index) => collisionGeometry.supportPoints[index]);
        const centroidY = points.reduce((sum, point) => sum + point.y, 0) / 3;
        const insideContactZone = spec.tip === "min"
          ? centroidY <= spec.contactZone
          : centroidY >= -spec.contactZone;
        const triangleNormal = new THREE.Vector3().crossVectors(
          points[1].clone().sub(points[0]),
          points[2].clone().sub(points[0]),
        ).normalize();
        const contactDirection = new THREE.Vector3(0, spec.tip === "min" ? -1 : 1, 0);
        const facesSkin = triangleNormal.dot(contactDirection) >= spec.contactNormalDot;
        return !(insideContactZone && facesSkin);
      });
      makeupTools[category].group.add(model);
      makeupTools[category].ready = true;
      document.body.dataset[`${category}ToolAsset`] = spec.asset;
    } catch (error) {
      console.error(`Failed to load true 3D tool ${spec.asset}`, error);
    }
  }));
  const readyCount = Object.values(makeupTools).filter(({ ready }) => ready).length;
  document.body.dataset.true3DToolCount = String(readyCount);
  document.body.dataset.toolGeometry = "licensed-glb";
  await setMode(activeMode);
}

async function loadReferenceMotion() {
  try {
    const response = await fetch(assetUrl("sequences/motion.json"));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    referenceMotion = await response.json();
    document.body.dataset.motionSource = "sequence-frames";
  } catch (error) {
    console.error("Failed to load motion extracted from sequence frames", error);
  }
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const aspect = width / height;
  camera.left = -aspect;
  camera.right = aspect;
  camera.top = 1;
  camera.bottom = -1;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);

  const narrow = width < 620;
  const faceWidthPx = narrow ? Math.min(width * 0.72, 340) : Math.min(width * 0.53, 390);
  previewFaceWidth = faceWidthPx / width * aspect * 2;
  photoHead.scale.setScalar(previewFaceWidth);
  photoHead.position.y = narrow ? -0.02 : 0.01;
}

function setStatus(message, state = "") {
  status.className = `status ${state}`.trim();
  status.innerHTML = `<span class="status-mark"></span>${message}`;
}

function loadTexture(url) {
  return textureLoader.loadAsync(url).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  });
}

function loadSequence(config) {
  if (!sequenceCache.has(config.sequence)) {
    const urls = Array.from(
      { length: config.frames },
      (_, index) => assetUrl(`sequences/${config.sequence}/frame_${String(index).padStart(3, "0")}.png`),
    );
    sequenceCache.set(config.sequence, Promise.all(urls.map(loadTexture)));
  }
  return sequenceCache.get(config.sequence);
}

const ACTION_FALLBACK_LANDMARKS = {
  concealer: [133, 145, 153, 154, 155, 33],
  eyebrow: MAKEUP_REGION_PATHS.brow[0],
  eyeshadow: MAKEUP_REGION_PATHS.eyeshadow[0],
  eyeliner: [133, 157, 158, 159, 160, 33],
  foundation: MAKEUP_REGION_PATHS.foundation[0],
  blush: [123, 50, 101, 205],
  face_contour: MAKEUP_REGION_PATHS.contour[0],
  nose_contour: [168, 6, 197, 195, 5],
  highlight: [10, 109, 151, 8],
  full_face_setting: MAKEUP_REGION_PATHS.powder[0],
  lip: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
};

function mirrorLandmarkIndex(index) {
  return referenceFaceMirrorMap[index] ?? index;
}

function bindPointToSourceFace(point, sourceLandmarks, preferredBinding = null) {
  return bindPointToFaceMesh(point, sourceLandmarks, referenceFaceTriangles, {
    preferredBinding,
    targetVertices: canonicalFaceVertices,
  });
}

function fallbackTrack(action, regions = [], toolKey = action.category) {
  let indices = ACTION_FALLBACK_LANDMARKS[action.category] ?? MAKEUP_REGION_PATHS[action.toolMode][0];
  if (action.side === "right") indices = indices.map((index) => Number(mirrorLandmarkIndex(index)));
  const totalFrames = 120;
  const regionSegments = buildRegionFallbackSegments(regions, totalFrames);
  const segments = regionSegments.length ? regionSegments : [{
    startFrame: 0,
    endFrame: totalFrames,
    points: indices.map((index, pointIndex) => ({
      frame: pointIndex / Math.max(1, indices.length - 1) * totalFrames,
      binding: [{ index, weight: 1 }],
    })),
  }];
  return {
    action,
    fps: 30,
    totalFrames,
    segments,
    regions,
    toolKey,
    source: regionSegments.length ? "official-region-478-fallback" : "semantic-478-fallback",
  };
}

function toolKeyForActionData(action, actionData) {
  const toolType = String(actionData.tool?.toolType ?? "").trim();
  if (action.category === "foundation") {
    return /粉扑/.test(toolType) ? "full_face_setting" : "eyeshadow";
  }
  if (action.category === "concealer" && /粉扑/.test(toolType)) return "full_face_setting";
  return action.category;
}

function spreadTrackReposition(points, radiusFrames = 4) {
  const repositionFrames = points
    .filter((point) => point.reposition >= 0.999)
    .map((point) => point.frame);
  points.forEach((point) => {
    repositionFrames.forEach((repositionFrame) => {
      const distance = Math.abs(point.frame - repositionFrame);
      if (distance <= radiusFrames) {
        point.reposition = Math.max(point.reposition, 1 - distance / (radiusFrames + 1));
      }
    });
  });
}

function buildOfficialActionTrack(action, actionData, regionLibrary) {
  const regions = (actionData.regionSlots ?? [])
    .map((slot) => regionLibrary.get(slot.regionId))
    .filter(Boolean);
  const toolKey = toolKeyForActionData(action, actionData);
  const sourceFrame = actionData.faceMesh?.frames?.find((frame) => frame.landmarks?.length === 478);
  if (!sourceFrame) return fallbackTrack(action, regions, toolKey);
  const segments = (actionData.strokeSegments ?? [])
    .filter((segment) => segment.points?.length > 0)
    .map((segment) => {
      let previousBinding = null;
      const points = segment.points
        .slice()
        .sort((a, b) => Number(a.frame) - Number(b.frame))
        .map((point) => {
          const binding = bindPointToSourceFace(
            correctActionPoint(action, point, sourceFrame.landmarks),
            sourceFrame.landmarks,
            previousBinding,
          );
          previousBinding = binding;
          return {
            frame: Number(point.frame) || 0,
            binding,
            outside: Boolean(binding.outside),
            reposition: binding.reposition ? 1 : 0,
            clampDistance: binding.clampDistance,
          };
        });
      const canonicalWidth = new THREE.Vector3(...canonicalFaceVertices[234])
        .distanceTo(new THREE.Vector3(...canonicalFaceVertices[454]));
      for (let index = 1; index < points.length; index += 1) {
        const beforeTarget = points[index - 1].binding.targetPoint;
        const afterTarget = points[index].binding.targetPoint;
        if (!beforeTarget || !afterTarget) continue;
        const distance = Math.hypot(
          afterTarget[0] - beforeTarget[0],
          afterTarget[1] - beforeTarget[1],
          afterTarget[2] - beforeTarget[2],
        ) / canonicalWidth;
        if (distance > 0.03) {
          points[index - 1].reposition = 1;
          points[index].reposition = 1;
        }
      }
      spreadTrackReposition(points);
      return {
        startFrame: Number(segment.startFrame) || 0,
        endFrame: Number(segment.endFrame) || Number(segment.startFrame) || 0,
        actionType: segment.actionType ?? "sweeping",
        points,
      };
    })
    .sort((a, b) => a.startFrame - b.startFrame);
  if (segments.length > 1) {
    const canonicalWidth = new THREE.Vector3(...canonicalFaceVertices[234])
      .distanceTo(new THREE.Vector3(...canonicalFaceVertices[454]));
    segments.forEach((segment, index) => {
      const nextSegment = segments[(index + 1) % segments.length];
      const before = segment.points.at(-1);
      const after = nextSegment.points[0];
      if (!before?.binding.targetPoint || !after?.binding.targetPoint) return;
      const distance = Math.hypot(
        after.binding.targetPoint[0] - before.binding.targetPoint[0],
        after.binding.targetPoint[1] - before.binding.targetPoint[1],
        after.binding.targetPoint[2] - before.binding.targetPoint[2],
      ) / canonicalWidth;
      if (distance > 0.03) {
        before.reposition = 1;
        after.reposition = 1;
      }
    });
  }
  if (!segments.length) return fallbackTrack(action, regions, toolKey);
  const segmentEnd = Math.max(...segments.map((segment) => segment.endFrame));
  return {
    action,
    fps: Math.max(1, Number(actionData.videoMeta?.fps) || 30),
    totalFrames: Math.max(1, Number(actionData.videoMeta?.totalFrames) || segmentEnd),
    segments,
    regions,
    toolKey,
    source: "official-action-json-478",
  };
}

function updateOfficialActionLabels(action) {
  stepLabel.textContent = `${String(action.index).padStart(2, "0")} · ${action.categoryLabel}`;
  instructionText.textContent = action.instruction;
  actionNumber.textContent = `${action.index} / ${OFFICIAL_ACTIONS.length}`;
  actionCategory.textContent = action.categoryLabel;
  officialActionSelect.value = action.runtimeId;
}

async function setOfficialAction(action) {
  if (!action) return;
  const version = ++officialActionLoadVersion;
  activeOfficialAction = action;
  activeToolKey = action.category;
  officialActionTrack = null;
  updateOfficialActionLabels(action);
  await setMode(action.toolMode);
  if (version !== officialActionLoadVersion || activeOfficialAction !== action) return;
  updateOfficialActionLabels(action);
  setStatus(`正在适配${action.displayName}的 478 点笔触…`);
  try {
    const [response, regionLibrary] = await Promise.all([
      fetch(assetUrl(`actions/${encodeURIComponent(action.runtimeId)}`)),
      loadOfficialRegionLibrary(),
      loadCanonicalFace(),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const actionData = await response.json();
    if (version !== officialActionLoadVersion || activeOfficialAction !== action) return;
    officialActionTrack = buildOfficialActionTrack(action, actionData, regionLibrary);
    activeToolKey = officialActionTrack.toolKey;
    animationStart = performance.now();
    previousCycle = -1;
    smoothedToolContact = null;
    document.body.dataset.officialActionId = action.runtimeId;
    document.body.dataset.officialCanonicalActionId = action.canonicalId;
    document.body.dataset.actionTrackSource = officialActionTrack.source;
    document.body.dataset.actionTrackSegments = String(officialActionTrack.segments.length);
    setStatus(
      stream ? `478 点动态跟踪 · ${action.displayName}` : `61 动作已适配 · ${action.displayName}`,
      stream ? "is-live" : "",
    );
  } catch (error) {
    console.error(`Failed to load official action ${action.runtimeId}`, error);
    if (version !== officialActionLoadVersion) return;
    officialActionTrack = fallbackTrack(action);
    activeToolKey = officialActionTrack.toolKey;
    setStatus(`${action.displayName}使用 478 点区域路径`, "is-error");
  }
}

function populateOfficialActionSelect() {
  const categories = new Map();
  OFFICIAL_ACTIONS.forEach((action) => {
    if (!categories.has(action.categoryLabel)) categories.set(action.categoryLabel, []);
    categories.get(action.categoryLabel).push(action);
  });
  categories.forEach((actions, label) => {
    const group = document.createElement("optgroup");
    group.label = `${label} · ${actions.length}`;
    actions.forEach((action) => {
      const option = document.createElement("option");
      option.value = action.runtimeId;
      option.textContent = `${String(action.index).padStart(2, "0")} · ${action.displayName}`;
      group.append(option);
    });
    officialActionSelect.append(group);
  });
  updateOfficialActionLabels(DEFAULT_OFFICIAL_ACTION);
}

async function setMode(mode) {
  activeMode = mode;
  smoothedToolContact = null;
  smoothedContactKey = "";
  previousCycle = -1;
  animationStart = performance.now();
  const config = MODES[mode];
  const version = ++sequenceLoadVersion;
  currentTextures = [];
  sequencePlane.visible = false;

  stepLabel.textContent = `${config.index} · ${config.label}`;
  instructionText.textContent = config.instruction;
  modeButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.mode === mode));
  setStatus(`正在加载${config.label}动作…`);

  if (makeupTools[activeToolKey]?.ready) {
    document.body.dataset.sequence = mode;
    setStatus(
      stream ? "478 点动态跟踪 · 真实 3D 工具" : `3D 面部曲面 · ${config.label}真实工具模型`,
      stream ? "is-live" : "",
    );
    return;
  }

  try {
    const textures = await loadSequence(config);
    if (version !== sequenceLoadVersion || mode !== activeMode) return;
    currentTextures = textures;
    sequenceMaterial.map = textures[0];
    sequenceMaterial.needsUpdate = true;
    sequencePlane.visible = true;
    document.body.dataset.sequence = mode;
    setStatus(
      stream ? "478 点动态跟踪" : `照片投影 3D 人脸 · ${config.label}`,
      stream ? "is-live" : "",
    );
  } catch (error) {
    console.error(`Failed to load ${mode} sequence`, error);
    setStatus("动作序列加载失败", "is-error");
  }
}

function buildFaceIndices() {
  if (!referenceFaceTriangles.length) throw new Error("Canonical face topology is not loaded");
  return referenceFaceTriangles.flatMap((face) => faceVertexIndices(face));
}

function createLiveFaceMesh() {
  const vertexCount = 478;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2));
  geometry.setIndex(buildFaceIndices());

  videoTexture = new THREE.VideoTexture(video);
  videoTexture.colorSpace = THREE.SRGBColorSpace;
  videoTexture.minFilter = THREE.LinearFilter;
  videoTexture.magFilter = THREE.LinearFilter;

  const material = new THREE.MeshBasicMaterial({
    map: videoTexture,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  liveFaceMesh = new THREE.Mesh(geometry, material);
  liveFaceMesh.renderOrder = 2;
  liveFaceMesh.frustumCulled = false;
  scene.add(liveFaceMesh);

  const pointsGeometry = new THREE.BufferGeometry();
  pointsGeometry.setAttribute("position", geometry.attributes.position);
  const outline = new THREE.Points(
    pointsGeometry,
    new THREE.PointsMaterial({
      color: 0x241d19,
      size: 5,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const centers = new THREE.Points(
    pointsGeometry,
    new THREE.PointsMaterial({
      color: 0xfff8ef,
      size: 2.4,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  outline.renderOrder = 5;
  centers.renderOrder = 6;
  outline.frustumCulled = false;
  centers.frustumCulled = false;
  liveFacePoints = new THREE.Group();
  liveFacePoints.name = "face-landmarks-478";
  liveFacePoints.add(outline, centers);
  liveFacePoints.visible = false;
  scene.add(liveFacePoints);
}

function liveProjection() {
  return computeCoverTransform(
    video.videoWidth,
    video.videoHeight,
    canvas.clientWidth,
    canvas.clientHeight,
  );
}

function livePoint(landmark, z = 0, projection = liveProjection()) {
  const point = landmarkToOrthographicWorld(landmark, projection, {
    mirrorX: true,
    includeDepth: false,
    depthOrigin: z,
  });
  return new THREE.Vector3(point.x, point.y, z);
}

function liveFacePoint(landmark, projection = liveProjection()) {
  const point = landmarkToOrthographicWorld(landmark, projection, {
    mirrorX: true,
    includeDepth: true,
    depthOrigin: 0.1,
  });
  return new THREE.Vector3(point.x, point.y, point.z);
}

function updateLiveFaceGeometry() {
  if (!liveFaceMesh || !liveLandmarks) return;
  const geometry = liveFaceMesh.geometry;
  const positions = geometry.attributes.position;
  const uvs = geometry.attributes.uv;
  const projection = liveProjection();
  if (!projection) return;

  for (let index = 0; index < Math.min(478, liveLandmarks.length); index += 1) {
    const landmark = liveLandmarks[index];
    const point = liveFacePoint(landmark, projection);
    positions.setXYZ(index, point.x, point.y, point.z);
    uvs.setXY(index, landmark.x, 1 - landmark.y);
  }
  positions.needsUpdate = true;
  uvs.needsUpdate = true;
  geometry.computeVertexNormals();
}

async function initFaceTracking() {
  if (faceLandmarker) return;
  setStatus("正在准备 3D 人脸…");
  const [vision] = await Promise.all([ensureVisionRuntime(), loadCanonicalFace()]);
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: assetUrl("models/face_landmarker.task"),
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
}

async function initHandTracking() {
  if (handLandmarker) return;
  const vision = await ensureVisionRuntime();
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: assetUrl("models/hand_landmarker.task"),
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  console.log("[haptic] HandLandmarker ready");
}

async function startCamera() {
  cameraButton.disabled = true;
  cameraButton.textContent = "正在开启…";
  try {
    await initFaceTracking();
    initHandTracking().catch((error) => console.warn("Hand tracking unavailable", error));
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    lastVideoTime = -1;
    trackedFaceLayout = null;
    liveFaceNormalHistory = [];
    resetHapticState();
    sendHaptic("0");
    if (!liveFaceMesh) createLiveFaceMesh();
    liveFaceMesh.visible = true;
    if (liveFacePoints) liveFacePoints.visible = false;
    photoHead.visible = false;
    video.classList.add("is-visible");
    previewFace.classList.add("is-hidden");
    cameraButton.disabled = false;
    cameraButton.innerHTML = '<span class="camera-dot"></span>关闭摄像头';
    setStatus("请将面部保持在画面中央", "is-live");
  } catch (error) {
    console.error(error);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    video.classList.remove("is-visible");
    previewFace.classList.remove("is-hidden");
    if (liveFaceMesh) liveFaceMesh.visible = false;
    photoHead.visible = photoHeadReady;
    cameraButton.disabled = false;
    cameraButton.innerHTML = '<span class="camera-dot"></span>重新尝试';
    setStatus("摄像头不可用，继续显示 3D 预览", "is-error");
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  video.classList.remove("is-visible");
  previewFace.classList.remove("is-hidden");
  liveLandmarks = null;
  liveFaceNormalHistory = [];
  trackedFaceLayout = null;
  lastVideoTime = -1;
  resetHapticState();
  sendHaptic("0");
  document.body.dataset.landmarkCount = "0";
  if (liveFaceMesh) liveFaceMesh.visible = false;
  if (liveFacePoints) liveFacePoints.visible = false;
  photoHead.visible = photoHeadReady;
  cameraButton.innerHTML = '<span class="camera-dot"></span>开启摄像头';
  setStatus(`照片投影 3D 人脸 · 478 点 · ${activeOfficialAction.categoryLabel}`);
}

function updateTracking() {
  if (!faceLandmarker || !stream || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  try {
    const result = faceLandmarker.detectForVideo(video, performance.now());
    if (result.faceLandmarks?.length) {
      liveLandmarks = result.faceLandmarks[0];
      document.body.dataset.landmarkCount = String(liveLandmarks.length);
      if (liveFaceMesh) liveFaceMesh.visible = true;
      if (liveFacePoints) liveFacePoints.visible = true;
      updateLiveFaceGeometry();
      setStatus(`478 点动态跟踪 · ${activeOfficialAction.displayName}`, "is-live");
    } else {
      liveLandmarks = null;
      liveFaceNormalHistory = [];
      trackedFaceLayout = null;
      document.body.dataset.landmarkCount = "0";
      if (liveFaceMesh) liveFaceMesh.visible = false;
      if (liveFacePoints) liveFacePoints.visible = false;
      setStatus("请将面部保持在画面中央");
    }
  } catch (error) {
    console.warn("Face tracking frame skipped", error);
  }
  updateHandTracking();
}

function getFaceLayout() {
  if (liveLandmarks) {
    const projection = liveProjection();
    const worldPoint = (index) => liveFacePoint(liveLandmarks[index], projection);
    const left = worldPoint(454);
    const right = worldPoint(234);
    const top = worldPoint(10);
    const chin = worldPoint(152);
    const rightAxis = right.clone().sub(left).normalize();
    const roughUp = top.clone().sub(chin).normalize();
    const normalAxis = new THREE.Vector3().crossVectors(rightAxis, roughUp).normalize();
    if (normalAxis.z < 0) normalAxis.negate();
    currentFaceForward.copy(normalAxis);
    const upAxis = new THREE.Vector3().crossVectors(normalAxis, rightAxis).normalize();
    const basis = new THREE.Matrix4().makeBasis(rightAxis, upAxis, normalAxis);
    const rawLayout = {
      center: top.clone().lerp(chin, 0.53),
      width: left.distanceTo(right),
      quaternion: new THREE.Quaternion().setFromRotationMatrix(basis),
      surfaceOffset: 0.055,
    };

    if (!trackedFaceLayout) {
      trackedFaceLayout = {
        center: rawLayout.center.clone(),
        width: rawLayout.width,
        quaternion: rawLayout.quaternion.clone(),
        surfaceOffset: rawLayout.surfaceOffset,
      };
    } else {
      trackedFaceLayout.center.lerp(rawLayout.center, 0.42);
      trackedFaceLayout.width = THREE.MathUtils.lerp(trackedFaceLayout.width, rawLayout.width, 0.36);
      trackedFaceLayout.quaternion.slerp(rawLayout.quaternion, 0.38);
    }

    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(trackedFaceLayout.quaternion);
    document.body.dataset.faceYaw = THREE.MathUtils.radToDeg(
      Math.atan2(normal.x, normal.z),
    ).toFixed(1);
    return trackedFaceLayout;
  }
  if (!referenceFaceVertices?.[454]) {
    return {
      center: new THREE.Vector3(0, photoHead.position.y, 0),
      width: previewFaceWidth,
      quaternion: photoHead.getWorldQuaternion(new THREE.Quaternion()),
      surfaceOffset: 0.055,
    };
  }
  photoHead.updateMatrixWorld(true);
  const previewPoint = (index) => new THREE.Vector3(...referenceFaceVertices[index])
    .applyMatrix4(photoHead.matrixWorld);
  const left = previewPoint(234);
  const right = previewPoint(454);
  const top = previewPoint(10);
  const chin = previewPoint(152);
  const previewQuaternion = photoHead.getWorldQuaternion(new THREE.Quaternion());
  const previewNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(previewQuaternion);
  currentFaceForward.copy(previewNormal).normalize();
  document.body.dataset.faceYaw = THREE.MathUtils.radToDeg(
    Math.atan2(previewNormal.x, previewNormal.z),
  ).toFixed(1);
  return {
    center: top.clone().lerp(chin, 0.53),
    width: left.distanceTo(right),
    quaternion: previewQuaternion,
    surfaceOffset: 0.055,
  };
}

function getFaceLandmarkWorld(index, face) {
  if (liveLandmarks?.[index]) {
    return liveFacePoint(liveLandmarks[index]);
  }

  if (referenceFaceVertices?.[index]) {
    return new THREE.Vector3(...referenceFaceVertices[index]).applyMatrix4(photoHead.matrixWorld);
  }

  return face.center.clone();
}

function getFaceLandmarkNormal(index, face) {
  let cachedNormal = null;
  if (liveLandmarks?.[index] && liveFaceMesh?.geometry.attributes.normal?.count > index) {
    cachedNormal = new THREE.Vector3().fromBufferAttribute(
      liveFaceMesh.geometry.attributes.normal,
      index,
    ).transformDirection(liveFaceMesh.matrixWorld);
  } else if (referenceFaceVertexNormals?.[index]) {
    cachedNormal = new THREE.Vector3(...referenceFaceVertexNormals[index])
      .applyQuaternion(photoHead.quaternion);
  }
  if (cachedNormal?.lengthSq() > 1e-12) {
    cachedNormal.normalize();
    const orientationForward = liveLandmarks ? currentFaceForward : faceForward(face);
    if (cachedNormal.dot(orientationForward) < 0) cachedNormal.negate();
    if (liveLandmarks) {
      const previous = liveFaceNormalHistory[index];
      if (previous && cachedNormal.dot(previous) < 0) cachedNormal.negate();
      liveFaceNormalHistory[index] = cachedNormal.clone();
    }
    return cachedNormal;
  }
  const triangles = referenceFaceVertexTriangles[index] ?? [];
  if (!triangles.length) return faceForward(face);
  const normal = new THREE.Vector3();
  triangles.forEach((indices) => {
    const [a, b, c] = indices.map((vertexIndex) => getFaceLandmarkWorld(vertexIndex, face));
    normal.add(new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)));
  });
  if (normal.lengthSq() < 1e-12) return faceForward(face);
  normal.normalize();
  if (normal.dot(liveLandmarks ? currentFaceForward : faceForward(face)) < 0) normal.negate();
  return normal;
}

function resolveActionBinding(binding, face) {
  const point = new THREE.Vector3();
  binding.forEach(({ index, weight }) => {
    point.addScaledVector(getFaceLandmarkWorld(index, face), weight);
  });
  return point;
}

function faceForward(face) {
  return new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).normalize();
}

function resolveBindingNormal(binding, face) {
  const normal = new THREE.Vector3();
  binding.forEach(({ index, weight }) => {
    normal.addScaledVector(getFaceLandmarkNormal(index, face), weight);
  });
  if (normal.lengthSq() < 1e-12) return faceForward(face);
  normal.normalize();
  if (normal.dot(faceForward(face)) < 0) normal.negate();
  return normal;
}

function resolveActionSurface(binding, face) {
  return {
    point: resolveActionBinding(binding, face),
    normal: resolveBindingNormal(binding, face),
  };
}

function surfaceQuaternion(face, normal) {
  const surfaceNormal = normal?.clone().normalize() ?? faceForward(face);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(face.quaternion);
  right.addScaledVector(surfaceNormal, -right.dot(surfaceNormal));
  if (right.lengthSq() < 1e-8) right.set(0, 1, 0).applyQuaternion(face.quaternion);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(surfaceNormal, right).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, surfaceNormal),
  );
}

function sampleOfficialTrack(track, progress, face) {
  const frame = THREE.MathUtils.clamp(progress, 0, 1) * track.totalFrames;
  let segmentIndex = track.segments.findIndex(
    (segment) => frame >= segment.startFrame && frame <= segment.endFrame,
  );
  if (segmentIndex < 0) {
    let nearestDistance = Infinity;
    track.segments.forEach((segment, index) => {
      const distance = Math.min(Math.abs(frame - segment.startFrame), Math.abs(frame - segment.endFrame));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        segmentIndex = index;
      }
    });
  }
  const segment = track.segments[Math.max(0, segmentIndex)];
  const points = segment.points;
  if (points.length === 1) {
    return {
      ...resolveActionSurface(points[0].binding, face),
      segmentIndex,
      indices: points[0].binding.map((item) => item.index),
      offFace: Number(points[0].reposition ?? 0),
    };
  }
  const clampedFrame = THREE.MathUtils.clamp(frame, points[0].frame, points.at(-1).frame);
  let pointIndex = points.findIndex((point) => point.frame >= clampedFrame);
  if (pointIndex <= 0) pointIndex = 1;
  const before = points[pointIndex - 1];
  const after = points[pointIndex] ?? before;
  const range = Math.max(1, after.frame - before.frame);
  const mix = THREE.MathUtils.clamp((clampedFrame - before.frame) / range, 0, 1);
  const beforeSurface = resolveActionSurface(before.binding, face);
  const afterSurface = resolveActionSurface(after.binding, face);
  const point = beforeSurface.point.lerp(afterSurface.point, mix);
  const normal = beforeSurface.normal.lerp(afterSurface.normal, mix).normalize();
  return {
    point,
    normal,
    offFace: THREE.MathUtils.lerp(
      Number(before.reposition ?? 0),
      Number(after.reposition ?? 0),
      mix,
    ),
    segmentIndex,
    indices: [...new Set([...before.binding, ...after.binding].map((item) => item.index))],
  };
}

function sampleLandmarkPath(indices, progress, face) {
  const points = indices.map((index) => getFaceLandmarkWorld(index, face));
  const normals = indices.map((index) => getFaceLandmarkNormal(index, face));
  if (points.length < 2) {
    return { point: points[0] ?? face.center.clone(), normal: normals[0] ?? faceForward(face), segment: 0 };
  }

  const lengths = [];
  let totalLength = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const length = points[index].distanceTo(points[index + 1]);
    lengths.push(length);
    totalLength += length;
  }

  const easedProgress = 0.5 - Math.cos(THREE.MathUtils.clamp(progress, 0, 1) * Math.PI) * 0.5;
  let remaining = easedProgress * totalLength;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const mix = lengths[index] > 0 ? remaining / lengths[index] : 0;
      return {
        point: points[index].clone().lerp(points[index + 1], THREE.MathUtils.clamp(mix, 0, 1)),
        normal: normals[index].clone().lerp(normals[index + 1], THREE.MathUtils.clamp(mix, 0, 1)).normalize(),
        segment: index,
      };
    }
    remaining -= lengths[index];
  }

  return { point: points.at(-1).clone(), normal: normals.at(-1).clone(), segment: points.length - 2 };
}

function getMakeupContact(mode, progress, cycle, face) {
  const smoothOnCurrentSurface = (sampled, contactKey) => {
    sampled.normal ??= faceForward(face);
    const target = sampled.point.clone();
    if (liveLandmarks) {
      if (!smoothedToolContact || smoothedContactKey !== contactKey) {
        smoothedToolContact = target.clone();
        smoothedContactKey = contactKey;
      } else {
        smoothedToolContact.lerp(target, 0.52);
        const lag = smoothedToolContact.clone().sub(target);
        lag.addScaledVector(sampled.normal, -lag.dot(sampled.normal));
        smoothedToolContact.copy(target).add(lag);
      }
      sampled.point.copy(smoothedToolContact);
    }
    sampled.surfacePoint = sampled.point.clone();
    return sampled;
  };
  if (officialActionTrack) {
    let sampled = sampleOfficialTrack(officialActionTrack, progress, face);
    const contactKey = `${activeOfficialAction.runtimeId}-${sampled.segmentIndex}-${liveLandmarks ? "live" : "preview"}`;
    sampled = smoothOnCurrentSurface(sampled, contactKey);
    return {
      ...sampled,
      segment: sampled.segmentIndex,
      side: activeOfficialAction.side === "right" ? 1 : 0,
    };
  }
  const side = Math.abs(cycle) % 2;
  const indices = MAKEUP_REGION_PATHS[mode][side];
  let sampled = sampleLandmarkPath(indices, progress, face);
  const contactKey = `${mode}-${side}-${liveLandmarks ? "live" : "preview"}`;
  sampled = smoothOnCurrentSurface(sampled, contactKey);
  return { ...sampled, indices, side };
}

function regionEntryKey(entry) {
  return Array.isArray(entry) ? entry.join(":") : String(entry);
}

function validRegionEntry(entry) {
  const indices = (Array.isArray(entry) ? entry : [entry]).filter((index) => (
    Number.isInteger(index) && index >= 0 && index < 478
  ));
  return indices.length ? indices : null;
}

function regionEntryWorldSurface(entry, face) {
  const indices = validRegionEntry(entry);
  if (!indices) return null;
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  indices.forEach((index) => {
    point.add(getFaceLandmarkWorld(index, face));
    normal.add(getFaceLandmarkNormal(index, face));
  });
  return {
    point: point.multiplyScalar(1 / indices.length),
    normal: normal.normalize(),
  };
}

function fallbackClosedRegionPatch(region, entries, face) {
  const surfaces = entries.map((entry) => regionEntryWorldSurface(entry, face)).filter(Boolean);
  if (!surfaces.length) return [];
  const center = new THREE.Vector3();
  const normal = new THREE.Vector3();
  surfaces.forEach((surface) => {
    center.add(surface.point);
    normal.add(surface.normal);
  });
  center.multiplyScalar(1 / surfaces.length);
  normal.normalize();
  center.addScaledVector(normal, face.width * 0.009);
  const quaternion = surfaceQuaternion(face, normal);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  const [radiusX, radiusY] = region.variantGroup === "lip-highlight"
    ? [0.045, 0.018]
    : region.variantGroup === "nose-tip-highlight" ? [0.026, 0.022] : [0.03, 0.022];
  return Array.from({ length: 32 }, (_, index) => {
    const angle = index / 32 * Math.PI * 2;
    return center.clone()
      .addScaledVector(right, Math.cos(angle) * face.width * radiusX)
      .addScaledVector(up, Math.sin(angle) * face.width * radiusY);
  });
}

function officialRegionWorldPoints(region, face) {
  const rawEntries = (region.indices ?? []).filter((entry) => validRegionEntry(entry));
  const entries = rawEntries.filter((entry, itemIndex, values) => (
    validRegionEntry(entry)
    && (itemIndex === 0 || regionEntryKey(entry) !== regionEntryKey(values[itemIndex - 1]))
  ));
  if (
    region.geomType === "closed"
    && entries.length > 2
    && regionEntryKey(entries[0]) === regionEntryKey(entries.at(-1))
  ) entries.pop();
  if (region.geomType === "closed" && new Set(entries.map(regionEntryKey)).size < 3) {
    return fallbackClosedRegionPatch(region, rawEntries, face);
  }
  const controlPoints = entries.map((entry) => {
    const surface = regionEntryWorldSurface(entry, face);
    return surface.point.addScaledVector(surface.normal, face.width * 0.009);
  });
  if (controlPoints.length < 2) return controlPoints;
  const closed = region.geomType === "closed";
  if (closed && controlPoints.length >= 3) {
    const inverseFaceRotation = face.quaternion.clone().invert();
    const localPoints = controlPoints.map((point) => point.clone()
      .sub(face.center)
      .applyQuaternion(inverseFaceRotation));
    const doubleArea = localPoints.reduce((sum, point, index) => {
      const next = localPoints[(index + 1) % localPoints.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0);
    if (Math.abs(doubleArea) < face.width * face.width * 1e-5) {
      return fallbackClosedRegionPatch(region, rawEntries, face);
    }
  }
  const curve = new THREE.CatmullRomCurve3(controlPoints, closed, "centripetal", 0.42);
  return curve.getPoints(Math.min(96, Math.max(20, controlPoints.length * 6)));
}

function updateClosedMakeupArea(state, pathPoints, face) {
  const fillPosition = state.fill.geometry.attributes.position;
  const inverseFaceRotation = face.quaternion.clone().invert();
  const localPoints = pathPoints.map((point) => {
    const local = point.clone().sub(face.center).applyQuaternion(inverseFaceRotation);
    return new THREE.Vector2(local.x, local.y);
  });
  const triangles = THREE.ShapeUtils.triangulateShape(localPoints, []);
  let fillIndex = 0;
  triangles.forEach((triangle) => {
    triangle.forEach((pointIndex) => {
      if (fillIndex >= fillPosition.count) return;
      const point = pathPoints[pointIndex];
      fillPosition.setXYZ(fillIndex, point.x, point.y, point.z);
      fillIndex += 1;
    });
  });
  fillPosition.needsUpdate = true;
  state.fill.geometry.setDrawRange(0, fillIndex);
  state.fill.visible = fillIndex >= 3;
}

function updateOpenMakeupArea(state, pathPoints, face, region) {
  const fillPosition = state.fill.geometry.attributes.position;
  const faceNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).normalize();
  const widthRatio = region.variantGroup === "eyeliner-upper"
    ? 0.012
    : region.variantGroup === "eyebrow" ? 0.02 : 0.03;
  const width = face.width * widthRatio;
  let fillIndex = 0;
  for (let index = 0; index < pathPoints.length - 1 && fillIndex + 6 <= fillPosition.count; index += 1) {
    const start = pathPoints[index];
    const end = pathPoints[index + 1];
    const tangent = end.clone().sub(start);
    if (tangent.lengthSq() < 1e-8) continue;
    const lateral = new THREE.Vector3().crossVectors(faceNormal, tangent.normalize()).normalize();
    const vertices = [
      start.clone().addScaledVector(lateral, width),
      start.clone().addScaledVector(lateral, -width),
      end.clone().addScaledVector(lateral, width),
      end.clone().addScaledVector(lateral, width),
      start.clone().addScaledVector(lateral, -width),
      end.clone().addScaledVector(lateral, -width),
    ];
    vertices.forEach((point) => {
      fillPosition.setXYZ(fillIndex, point.x, point.y, point.z);
      fillIndex += 1;
    });
  }
  fillPosition.needsUpdate = true;
  state.fill.geometry.setDrawRange(0, fillIndex);
  state.fill.visible = fillIndex >= 3;
}

function updateMakeupAreaRegions(regions, face) {
  regions.slice(0, makeupAreaStates.length).forEach((region, regionIndex) => {
    const state = makeupAreaStates[regionIndex];
    const pathPoints = officialRegionWorldPoints(region, face);
    if (region.geomType === "closed" && pathPoints.length >= 3) {
      updateClosedMakeupArea(state, pathPoints, face);
    } else {
      // The official region library uses openCurve as a guide boundary, not
      // as a filled cosmetic area. Expanding it into a ribbon produced the
      // rectangular fill blocks visible around eye/brow actions.
      state.fill.geometry.setDrawRange(0, 0);
      state.fill.visible = false;
    }
    const outlinePosition = state.outline.geometry.attributes.position;
    const outlinePoints = region.geomType === "closed" && pathPoints.length
      ? [...pathPoints, pathPoints[0]]
      : pathPoints;
    outlinePoints.slice(0, outlinePosition.count).forEach((point, pointIndex) => {
      outlinePosition.setXYZ(pointIndex, point.x, point.y, point.z);
    });
    outlinePosition.needsUpdate = true;
    state.outline.geometry.setDrawRange(0, Math.min(outlinePoints.length, outlinePosition.count));
    state.outline.visible = outlinePoints.length >= 2;
  });
  makeupAreaStates.slice(regions.length).forEach((state) => {
    state.fill.visible = false;
    state.outline.visible = false;
  });
  makeupAreaGroup.visible = regions.length > 0;
  document.body.dataset.makeupRegionSource = "official-regions-all-json";
  document.body.dataset.makeupRegionCount = String(regions.length);
  document.body.dataset.makeupRegionIds = regions.map((region) => region.id).join(",");
}

function updateMakeupRegionGuide(mode, face, cycle, progress, activeContact = null) {
  if (!photoHeadReady && !liveLandmarks) {
    makeupRegionGuide.visible = false;
    return;
  }

  makeupRegionGuide.visible = true;
  if (officialActionTrack) {
    const sampled = activeContact ?? sampleOfficialTrack(officialActionTrack, progress, face);
    const activeIndex = sampled.segmentIndex ?? 0;
    regionSideGuides.forEach((guide, guideIndex) => {
      const segmentIndex = guideIndex === 0
        ? activeIndex
        : (activeIndex + 1) % officialActionTrack.segments.length;
      const segment = officialActionTrack.segments[segmentIndex];
      const pathPoints = segment.points
        .filter((_, index) => index % Math.max(1, Math.ceil(segment.points.length / 256)) === 0)
        .map((point) => {
          const surface = resolveActionSurface(point.binding, face);
          return surface.point.addScaledVector(surface.normal, face.width * 0.006);
        });
      if (pathPoints.length === 1) pathPoints.push(pathPoints[0].clone());
      const position = guide.geometry.attributes.position;
      pathPoints.slice(0, position.count).forEach((point, pointIndex) => {
        position.setXYZ(pointIndex, point.x, point.y, point.z);
      });
      position.needsUpdate = true;
      guide.geometry.setDrawRange(0, Math.min(pathPoints.length, position.count));
      const isActive = guideIndex === 0;
      guide.lineMaterial.color.setHex(isActive ? 0xff781f : 0xffc487);
      guide.pointMaterial.color.setHex(isActive ? 0xffad55 : 0xffd1a3);
      guide.lineMaterial.opacity = isActive ? 1 : 0.32;
      guide.pointMaterial.opacity = isActive ? 0.96 : 0.36;
      guide.pointMaterial.size = isActive ? 6.4 : 3.8;
      actionRangeMeshes[guideIndex].geometry.setDrawRange(0, 0);
    });
    updateMakeupAreaRegions(officialActionTrack.regions ?? [], face);
    regionCursor.position.copy(sampled.point);
    regionCursor.quaternion.copy(surfaceQuaternion(face, sampled.normal));
    regionCursor.scale.setScalar(face.width * 0.034);
    regionCursor.visible = (sampled.offFace ?? 0) < 0.35;
    document.body.dataset.regionGuide = "official-action-478-path";
    document.body.dataset.regionGuideMode = activeOfficialAction.canonicalId;
    document.body.dataset.regionGuideSide = activeOfficialAction.side ?? "neutral";
    document.body.dataset.regionRange = "official-478-makeup-area";
    return;
  }
  actionRangeMeshes.forEach((mesh) => mesh.geometry.setDrawRange(0, 0));
  makeupAreaGroup.visible = false;
  const activeSide = Math.abs(cycle) % 2;
  regionSideGuides.forEach((guide, side) => {
    const indices = MAKEUP_REGION_PATHS[mode][side];
    const controlPoints = indices.map((landmarkIndex) => (
      getFaceLandmarkWorld(landmarkIndex, face)
        .addScaledVector(getFaceLandmarkNormal(landmarkIndex, face), face.width * 0.004)
    ));
    const pathPoints = [];
    controlPoints.slice(0, -1).forEach((point, segmentIndex) => {
      for (let step = 0; step < 5; step += 1) {
        pathPoints.push(point.clone().lerp(controlPoints[segmentIndex + 1], step / 5));
      }
    });
    pathPoints.push(controlPoints.at(-1));
    const position = guide.geometry.attributes.position;
    pathPoints.forEach((point, pointIndex) => {
      position.setXYZ(pointIndex, point.x, point.y, point.z);
    });
    position.needsUpdate = true;
    guide.geometry.setDrawRange(0, pathPoints.length);
    const isActive = side === activeSide;
    guide.lineMaterial.color.setHex(isActive ? 0xff8124 : 0xffc487);
    guide.pointMaterial.color.setHex(isActive ? 0xffb263 : 0xffd1a3);
    guide.lineMaterial.opacity = isActive ? 1 : 0.38;
    guide.pointMaterial.opacity = isActive ? 0.96 : 0.48;
    guide.pointMaterial.size = isActive ? 6.2 : 4;
  });

  let contact = activeContact;
  if (!contact) {
    const indices = MAKEUP_REGION_PATHS[mode][activeSide];
    const sampled = sampleLandmarkPath(indices, progress, face);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).normalize();
    sampled.point.addScaledVector(normal, face.width * VOLUME_SPECS[mode].contactLift);
    contact = sampled;
  }
  regionCursor.position.copy(contact.point);
  regionCursor.quaternion.copy(surfaceQuaternion(face, contact.normal));
  regionCursor.scale.setScalar(face.width * 0.034);
  regionCursor.visible = true;
  document.body.dataset.regionGuide = "dual-path-with-active-contact";
  document.body.dataset.regionGuideMode = mode;
  document.body.dataset.regionGuideSide = activeSide === 0 ? "left" : "right";
}

function updateSequencePlane(cycle, progress, face = getFaceLayout()) {
  const config = MODES[activeMode];
  const targetWidth = face.width * config.planeWidth;
  const scale = targetWidth / (4 / 3);
  const mirrored = officialActionTrack
    ? activeOfficialAction.side === "right"
    : cycle % 2 === 1;
  const mirrorSign = mirrored ? -1 : 1;
  const targetHeight = scale;

  // Each PNG has a different amount of transparent padding. Position the plane
  // by the applicator's contact point instead of centering the whole frame.
  const contactOffsetX = (config.contactX - 0.5) * targetWidth * mirrorSign;
  const contactOffsetY = (0.5 - config.contactY) * targetHeight;
  const contact = getMakeupContact(activeMode, progress, cycle, face);
  const visualContactOffset = new THREE.Vector3(
    contactOffsetX,
    contactOffsetY,
    0,
  ).applyQuaternion(face.quaternion);

  sequencePlane.scale.set(mirrorSign * scale, scale, 1);
  sequencePlane.position.copy(contact.point).sub(visualContactOffset);
  sequencePlane.quaternion.copy(face.quaternion);
  return contact;
}

function sampleReferenceMotion(mode, progress) {
  const frames = referenceMotion[mode];
  if (!frames?.length) return { x: 0, y: 0, angle: 0, scale: 1 };
  const loopProgress = ((progress % 1) + 1) % 1;
  const framePosition = loopProgress * frames.length;
  const index = Math.floor(framePosition) % frames.length;
  const nextIndex = (index + 1) % frames.length;
  const mix = framePosition - Math.floor(framePosition);
  const current = frames[index];
  const next = frames[nextIndex];
  return {
    x: THREE.MathUtils.lerp(current.x, next.x, mix),
    y: THREE.MathUtils.lerp(current.y, next.y, mix),
    angle: THREE.MathUtils.lerp(current.angle, next.angle, mix),
    scale: THREE.MathUtils.lerp(current.scale, next.scale, mix),
  };
}

function getToolMotion(mode, category, progress, mirrorSign) {
  const reference = sampleReferenceMotion(mode, progress);
  const spec = TOOL_SPECS[category];

  return {
    roll: (spec.roll + (spec.tip === "min" ? Math.PI : 0) - reference.angle) * mirrorSign,
    scale: 1,
  };
}

function collisionSafeToolPlacement(toolState, quaternion, surfaceNormal, toolScale, faceWidth) {
  let minimumProjection = 0;
  const transformedPoints = [];
  if (toolState.supportPoints.length) {
    minimumProjection = Infinity;
    toolState.supportPoints.forEach((sourcePoint) => {
      const transformed = sourcePoint.clone()
        .multiplyScalar(toolScale)
        .applyQuaternion(quaternion);
      transformedPoints.push(transformed);
      const projection = transformed.dot(surfaceNormal);
      minimumProjection = Math.min(minimumProjection, projection);
    });
  }
  const safetyMargin = faceWidth * 0.002;
  const patchThreshold = faceWidth * 0.002;
  const contactPatch = transformedPoints.filter((point) => (
    point.dot(surfaceNormal) <= minimumProjection + patchThreshold
  ));
  const tangentCentroid = new THREE.Vector3();
  (contactPatch.length ? contactPatch : transformedPoints).forEach((point) => {
    tangentCentroid.add(point);
  });
  if (contactPatch.length || transformedPoints.length) {
    tangentCentroid.multiplyScalar(1 / Math.max(1, contactPatch.length || transformedPoints.length));
    tangentCentroid.addScaledVector(surfaceNormal, -tangentCentroid.dot(surfaceNormal));
  }
  const anchorClearance = -minimumProjection + safetyMargin;
  const anchorOffset = tangentCentroid.clone().negate().addScaledVector(surfaceNormal, anchorClearance);
  return {
    anchorOffset,
    anchorClearance,
    minimumSurfaceDistance: anchorClearance + minimumProjection,
    tangentCorrection: tangentCentroid.length(),
  };
}

function buildFaceHeightField(face, surfacePoint, surfaceNormal) {
  const surfaceFrame = surfaceQuaternion(face, surfaceNormal);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(surfaceFrame);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(surfaceFrame);
  const worldVertices = Array.from({ length: 468 }, (_, index) => getFaceLandmarkWorld(index, face));
  const vertices = worldVertices.map((worldPoint) => {
    const relative = worldPoint.clone().sub(surfacePoint);
    return {
      x: relative.dot(right),
      y: relative.dot(up),
      z: relative.dot(surfaceNormal),
    };
  });
  const triangles = referenceFaceTriangles.map((faceTriangle) => {
    const indices = faceVertexIndices(faceTriangle);
    const points = indices.map((index) => vertices[index]);
    return {
      points,
      minX: Math.min(...points.map((point) => point.x)),
      maxX: Math.max(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxY: Math.max(...points.map((point) => point.y)),
    };
  });
  const collisionRecords = referenceFaceTriangles.map((faceTriangle) => {
    const points = faceVertexIndices(faceTriangle).map((index) => worldVertices[index]);
    return {
      points,
      box: new THREE.Box3().setFromPoints(points),
    };
  });
  const minX = Math.min(...vertices.map((point) => point.x));
  const maxX = Math.max(...vertices.map((point) => point.x));
  const minY = Math.min(...vertices.map((point) => point.y));
  const maxY = Math.max(...vertices.map((point) => point.y));
  const gridSize = 18;
  const cellWidth = Math.max((maxX - minX) / gridSize, 1e-6);
  const cellHeight = Math.max((maxY - minY) / gridSize, 1e-6);
  const cells = Array.from({ length: gridSize * gridSize }, () => []);
  const cellIndex = (x, y) => {
    const column = THREE.MathUtils.clamp(Math.floor((x - minX) / cellWidth), 0, gridSize - 1);
    const row = THREE.MathUtils.clamp(Math.floor((y - minY) / cellHeight), 0, gridSize - 1);
    return row * gridSize + column;
  };
  triangles.forEach((triangle) => {
    const minColumn = THREE.MathUtils.clamp(Math.floor((triangle.minX - minX) / cellWidth), 0, gridSize - 1);
    const maxColumn = THREE.MathUtils.clamp(Math.floor((triangle.maxX - minX) / cellWidth), 0, gridSize - 1);
    const minRow = THREE.MathUtils.clamp(Math.floor((triangle.minY - minY) / cellHeight), 0, gridSize - 1);
    const maxRow = THREE.MathUtils.clamp(Math.floor((triangle.maxY - minY) / cellHeight), 0, gridSize - 1);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        cells[row * gridSize + column].push(triangle);
      }
    }
  });
  const heightAt = (x, y) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return null;
    let height = -Infinity;
    for (const triangle of cells[cellIndex(x, y)]) {
      if (x < triangle.minX || x > triangle.maxX || y < triangle.minY || y > triangle.maxY) continue;
      const weights = barycentric2D({ x, y }, triangle.points[0], triangle.points[1], triangle.points[2]);
      if (!weights || weights.some((weight) => weight < -1e-6)) continue;
      height = Math.max(
        height,
        triangle.points.reduce((sum, point, index) => sum + point.z * weights[index], 0),
      );
    }
    return Number.isFinite(height) ? height : null;
  };
  return { right, up, heightAt, collisionRecords };
}

function buildFaceCollisionRecords(face) {
  const vertices = Array.from({ length: 468 }, (_, index) => getFaceLandmarkWorld(index, face));
  return referenceFaceTriangles.map((faceTriangle) => {
    const points = faceVertexIndices(faceTriangle).map((index) => vertices[index]);
    return { points, box: new THREE.Box3().setFromPoints(points) };
  });
}

function requiredFaceMeshLift(
  toolState,
  quaternion,
  toolScale,
  anchorPosition,
  surfacePoint,
  surfaceNormal,
  faceWidth,
  heightField,
) {
  const safetyMargin = faceWidth * 0.0015;
  let requiredLift = 0;
  let minimumGap = Infinity;
  toolState.collisionSamples.forEach((sample) => {
    const worldPoint = sample.clone()
      .multiplyScalar(toolScale)
      .applyQuaternion(quaternion)
      .add(anchorPosition);
    const relative = worldPoint.sub(surfacePoint);
    const x = relative.dot(heightField.right);
    const y = relative.dot(heightField.up);
    const z = relative.dot(surfaceNormal);
    const faceHeight = heightField.heightAt(x, y);
    if (faceHeight === null) return;
    const gap = z - faceHeight;
    minimumGap = Math.min(minimumGap, gap);
    requiredLift = Math.max(requiredLift, safetyMargin - gap);
  });
  return {
    requiredLift: Math.max(0, requiredLift),
    minimumGap: Number.isFinite(minimumGap) ? minimumGap : Infinity,
    safetyMargin,
  };
}

function segmentIntersectsTriangleStrict(start, end, a, b, c, epsilon) {
  const direction = end.clone().sub(start);
  const edgeA = b.clone().sub(a);
  const edgeB = c.clone().sub(a);
  const cross = new THREE.Vector3().crossVectors(direction, edgeB);
  const determinant = edgeA.dot(cross);
  if (Math.abs(determinant) <= epsilon) return false;
  const inverse = 1 / determinant;
  const offset = start.clone().sub(a);
  const u = inverse * offset.dot(cross);
  if (u < -epsilon || u > 1 + epsilon) return false;
  const q = new THREE.Vector3().crossVectors(offset, edgeA);
  const v = inverse * direction.dot(q);
  if (v < -epsilon || u + v > 1 + epsilon) return false;
  const distance = inverse * edgeB.dot(q);
  return distance > epsilon && distance < 1 - epsilon;
}

function projectTrianglePoint(point, dropAxis) {
  if (dropAxis === "x") return { x: point.y, y: point.z };
  if (dropAxis === "y") return { x: point.x, y: point.z };
  return { x: point.x, y: point.y };
}

function orientation2D(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangle2D(point, a, b, c, epsilon) {
  const values = [orientation2D(a, b, point), orientation2D(b, c, point), orientation2D(c, a, point)];
  return values.every((value) => value >= -epsilon) || values.every((value) => value <= epsilon);
}

function coplanarTrianglesOverlap(first, second, normal, epsilon) {
  const absolute = new THREE.Vector3(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
  const dropAxis = absolute.x >= absolute.y && absolute.x >= absolute.z
    ? "x"
    : absolute.y >= absolute.z ? "y" : "z";
  const a = first.map((point) => projectTrianglePoint(point, dropAxis));
  const b = second.map((point) => projectTrianglePoint(point, dropAxis));
  return pointInTriangle2D(a[0], b[0], b[1], b[2], epsilon)
    || pointInTriangle2D(b[0], a[0], a[1], a[2], epsilon);
}

function trianglesIntersectStrict(first, second, epsilon) {
  const normalA = new THREE.Vector3().crossVectors(
    first[1].clone().sub(first[0]),
    first[2].clone().sub(first[0]),
  );
  const normalB = new THREE.Vector3().crossVectors(
    second[1].clone().sub(second[0]),
    second[2].clone().sub(second[0]),
  );
  const lengthA = normalA.length();
  const lengthB = normalB.length();
  if (lengthA <= epsilon || lengthB <= epsilon) return false;
  normalA.multiplyScalar(1 / lengthA);
  normalB.multiplyScalar(1 / lengthB);
  const distancesB = second.map((point) => normalA.dot(point.clone().sub(first[0])));
  if (distancesB.every((value) => value > epsilon) || distancesB.every((value) => value < -epsilon)) return false;
  const distancesA = first.map((point) => normalB.dot(point.clone().sub(second[0])));
  if (distancesA.every((value) => value > epsilon) || distancesA.every((value) => value < -epsilon)) return false;
  const coplanar = distancesA.every((value) => Math.abs(value) <= epsilon)
    && distancesB.every((value) => Math.abs(value) <= epsilon);
  if (coplanar) return coplanarTrianglesOverlap(first, second, normalA, epsilon);
  for (let index = 0; index < 3; index += 1) {
    if (segmentIntersectsTriangleStrict(
      first[index],
      first[(index + 1) % 3],
      second[0],
      second[1],
      second[2],
      epsilon,
    )) return true;
    if (segmentIntersectsTriangleStrict(
      second[index],
      second[(index + 1) % 3],
      first[0],
      first[1],
      first[2],
      epsilon,
    )) return true;
  }
  return false;
}

function toolIntersectsFace(toolState, quaternion, toolScale, position, faceRecords, faceWidth) {
  if (!toolState.collisionTriangles.length) return false;
  const points = toolState.supportPoints.map((point) => point.clone()
    .multiplyScalar(toolScale)
    .applyQuaternion(quaternion)
    .add(position));
  const toolBox = new THREE.Box3().setFromPoints(points);
  const candidateFaces = faceRecords.filter((record) => record.box.intersectsBox(toolBox));
  const epsilon = faceWidth * 1e-9;
  for (const [indexA, indexB, indexC] of toolState.collisionTriangles) {
    const toolTriangle = [points[indexA], points[indexB], points[indexC]];
    const triangleBox = new THREE.Box3().setFromPoints(toolTriangle);
    for (const faceRecord of candidateFaces) {
      if (!faceRecord.box.intersectsBox(triangleBox)) continue;
      if (trianglesIntersectStrict(toolTriangle, faceRecord.points, epsilon)) return true;
    }
  }
  return false;
}

function pointToToolMeshDistance(toolState, quaternion, toolScale, position, targetPoint, surfaceNormal) {
  const points = toolState.supportPoints.map((point) => point.clone()
    .multiplyScalar(toolScale)
    .applyQuaternion(quaternion)
    .add(position));
  const closest = new THREE.Vector3();
  const bestPoint = new THREE.Vector3();
  let minimumDistance = Infinity;
  toolState.allTriangles.forEach(([indexA, indexB, indexC]) => {
    new THREE.Triangle(points[indexA], points[indexB], points[indexC])
      .closestPointToPoint(targetPoint, closest);
    const distance = closest.distanceTo(targetPoint);
    if (distance < minimumDistance) {
      minimumDistance = distance;
      bestPoint.copy(closest);
    }
  });
  const offset = bestPoint.sub(targetPoint);
  const normalDistance = offset.dot(surfaceNormal);
  const tangentDistance = offset.addScaledVector(surfaceNormal, -normalDistance).length();
  return { minimumDistance, normalDistance, tangentDistance };
}

function exactCollisionLift(
  toolState,
  quaternion,
  toolScale,
  position,
  surfaceNormal,
  faceRecords,
  faceWidth,
) {
  if (!toolIntersectsFace(toolState, quaternion, toolScale, position, faceRecords, faceWidth)) {
    return { lift: 0, resolved: true };
  }
  let lower = 0;
  let upper = faceWidth * 0.004;
  const candidatePosition = new THREE.Vector3();
  while (
    upper <= faceWidth * 0.16
    && toolIntersectsFace(
      toolState,
      quaternion,
      toolScale,
      candidatePosition.copy(position).addScaledVector(surfaceNormal, upper),
      faceRecords,
      faceWidth,
    )
  ) {
    lower = upper;
    upper *= 1.65;
  }
  upper = Math.min(upper, faceWidth * 0.16);
  for (let iteration = 0; iteration < 9; iteration += 1) {
    const middle = (lower + upper) * 0.5;
    const intersects = toolIntersectsFace(
      toolState,
      quaternion,
      toolScale,
      candidatePosition.copy(position).addScaledVector(surfaceNormal, middle),
      faceRecords,
      faceWidth,
    );
    if (intersects) lower = middle;
    else upper = middle;
  }
  const lift = upper + faceWidth * 0.0005;
  const resolved = !toolIntersectsFace(
    toolState,
    quaternion,
    toolScale,
    candidatePosition.copy(position).addScaledVector(surfaceNormal, lift),
    faceRecords,
    faceWidth,
  );
  return { lift, resolved };
}

function setToolOpacity(tool, opacity) {
  tool.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach((material) => {
      material.opacity = opacity;
      const depthWrite = opacity >= 0.98;
      if (material.depthWrite !== depthWrite) {
        material.depthWrite = depthWrite;
        material.needsUpdate = true;
      }
    });
  });
}

function update3DTool(mode, face, cycle, progress) {
  const category = activeToolKey;
  const toolState = makeupTools[category];
  const tool = toolState.group;
  const toolSpec = TOOL_SPECS[category];
  const mirrorSign = officialActionTrack
    ? (activeOfficialAction.side === "right" ? -1 : 1)
    : (cycle % 2 === 1 ? -1 : 1);
  const motion = getToolMotion(mode, category, progress, mirrorSign);
  const contact = getMakeupContact(mode, progress, cycle, face);
  const surfaceNormal = contact.normal ?? faceForward(face);
  const surfacePoint = contact.surfacePoint ?? contact.point.clone().addScaledVector(
    surfaceNormal,
    -face.width * toolSpec.contactLift,
  );
  const toolScale = face.width * toolSpec.scale * motion.scale;
  tool.scale.setScalar(toolScale);
  const surfaceFrame = surfaceQuaternion(face, surfaceNormal);
  const faceCollisionRecords = buildFaceCollisionRecords(face);
  const tiltDirection = Math.sign(toolSpec.tiltX) || (toolSpec.tip === "min" ? 1 : -1);
  const tiltCandidates = [];
  for (let step = 0; step < 10; step += 1) {
    const tilt = tiltDirection * Math.min(1.56, Math.abs(toolSpec.tiltX) + step * 0.12);
    if (!tiltCandidates.some((value) => Math.abs(value - tilt) < 1e-6)) tiltCandidates.push(tilt);
  }
  let selectedPose = null;
  tiltCandidates.forEach((tiltX) => {
    if (selectedPose && !selectedPose.exactIntersects) return;
    const quaternion = surfaceFrame.clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), motion.roll))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tiltX))
      .multiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        toolSpec.tiltY * mirrorSign,
      ));
    const placement = collisionSafeToolPlacement(
      toolState,
      quaternion,
      surfaceNormal,
      toolScale,
      face.width,
    );
    const anchorPosition = surfacePoint.clone().add(placement.anchorOffset);
    const basePosition = anchorPosition.clone();
    const exactIntersects = toolIntersectsFace(
      toolState,
      quaternion,
      toolScale,
      basePosition,
      faceCollisionRecords,
      face.width,
    );
    const candidate = {
      tiltX,
      quaternion,
      placement,
      anchorPosition,
      basePosition,
      exactIntersects,
    };
    if (
      !selectedPose
      || (!exactIntersects && selectedPose.exactIntersects)
      || (exactIntersects && selectedPose.exactIntersects)
    ) selectedPose = candidate;
  });
  const { placement, tiltX: resolvedTiltX } = selectedPose;
  const exactResolution = exactCollisionLift(
    toolState,
    selectedPose.quaternion,
    toolScale,
    selectedPose.basePosition,
    surfaceNormal,
    faceCollisionRecords,
    face.width,
  );
  const collisionOffFace = THREE.MathUtils.clamp(
    (exactResolution.lift / face.width - 0.0015) / 0.006,
    0,
    1,
  );
  const offFace = Math.max(
    THREE.MathUtils.clamp(contact.offFace ?? 0, 0, 1),
    collisionOffFace,
  );
  const offFaceEased = offFace * offFace * (3 - 2 * offFace);
  const repositionLift = face.width * 0.06 * offFaceEased;
  tool.quaternion.copy(selectedPose.quaternion);
  tool.position.copy(selectedPose.basePosition)
    .addScaledVector(surfaceNormal, exactResolution.lift + repositionLift);
  const fadeProgress = THREE.MathUtils.clamp((offFace - 0.2) / 0.65, 0, 1);
  const toolOpacity = 1 - fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
  setToolOpacity(tool, toolOpacity);
  if (!exactResolution.resolved || toolOpacity <= 0.01) tool.visible = false;
  const contactMetrics = pointToToolMeshDistance(
    toolState,
    tool.quaternion,
    toolScale,
    tool.position,
    surfacePoint,
    surfaceNormal,
  );
  const handleAxis = new THREE.Vector3(0, toolSpec.tip === "min" ? 1 : -1, 0)
    .applyQuaternion(tool.quaternion)
    .normalize();
  const handleOutward = handleAxis.dot(surfaceNormal);
  delete document.body.dataset.activeVolumeFrame;
  document.body.dataset.activeToolSource = "licensed-glb-true-3d";
  document.body.dataset.activeToolProfile = category;
  document.body.dataset.activeToolModel = toolSpec.asset;
  document.body.dataset.toolConfiguredClearance = toolSpec.contactLift.toFixed(4);
  document.body.dataset.toolSurfaceClearance = (
    (placement.anchorClearance + exactResolution.lift + repositionLift) / face.width
  ).toFixed(4);
  document.body.dataset.toolMinimumSurfaceDistance = (
    (placement.minimumSurfaceDistance + exactResolution.lift + repositionLift) / face.width
  ).toFixed(4);
  document.body.dataset.toolFaceMeshMinimumDistance = exactResolution.resolved ? "non-intersecting" : "unresolved";
  document.body.dataset.toolFaceMeshLift = "0.0000";
  document.body.dataset.toolExactCollisionLift = (exactResolution.lift / face.width).toFixed(4);
  document.body.dataset.toolExactCollisionResolved = String(exactResolution.resolved);
  document.body.dataset.toolContactMeshDistance = (contactMetrics.minimumDistance / face.width).toFixed(4);
  document.body.dataset.toolContactNormalDistance = (contactMetrics.normalDistance / face.width).toFixed(4);
  document.body.dataset.toolContactTangentDistance = (contactMetrics.tangentDistance / face.width).toFixed(4);
  document.body.dataset.toolOffFace = offFace.toFixed(4);
  document.body.dataset.toolCollisionOffFace = collisionOffFace.toFixed(4);
  document.body.dataset.toolRepositionLift = (repositionLift / face.width).toFixed(4);
  document.body.dataset.toolOpacity = toolOpacity.toFixed(4);
  document.body.dataset.toolResolvedTiltX = THREE.MathUtils.radToDeg(resolvedTiltX).toFixed(1);
  document.body.dataset.toolCollisionSampleCount = String(toolState.collisionSamples.length);
  document.body.dataset.toolProtectedTriangleCount = String(toolState.collisionTriangles.length);
  document.body.dataset.toolContactTriangleCount = String(
    toolState.allTriangles.length - toolState.collisionTriangles.length,
  );
  document.body.dataset.toolContactTangentCorrection = (placement.tangentCorrection / face.width).toFixed(4);
  document.body.dataset.toolPenetrationGuard = "soft-contact-zone-plus-exact-body-triangles";
  document.body.dataset.toolHandleOutward = handleOutward.toFixed(4);
  document.body.dataset.toolTilt = `${THREE.MathUtils.radToDeg(resolvedTiltX).toFixed(1)},${THREE.MathUtils.radToDeg(toolSpec.tiltY * mirrorSign).toFixed(1)},${THREE.MathUtils.radToDeg(motion.roll).toFixed(1)}`;
  document.body.dataset.activeMakeupRegion = `${mode}-${contact.side === 0 ? "left" : "right"}`;
  document.body.dataset.activeRegionLandmarks = contact.indices.join(",");
  document.body.dataset.activeRegionSegment = String(contact.segment);
  document.body.dataset.toolContactSource = officialActionTrack
    ? "official-action-json-478-binding"
    : "mediapipe-478-region-path";
  document.body.dataset.toolContactX = surfacePoint.x.toFixed(4);
  document.body.dataset.toolContactY = surfacePoint.y.toFixed(4);
  document.body.dataset.toolContactZ = surfacePoint.z.toFixed(4);
  document.body.dataset.toolAnchorX = tool.position.x.toFixed(4);
  document.body.dataset.toolAnchorY = tool.position.y.toFixed(4);
  document.body.dataset.toolAnchorZ = tool.position.z.toFixed(4);
  const toolNormal = surfaceNormal;
  document.body.dataset.toolYaw = THREE.MathUtils.radToDeg(
    Math.atan2(toolNormal.x, toolNormal.z),
  ).toFixed(1);
  return { ...contact, point: surfacePoint, offFace };
}

function render(time) {
  if (!renderWindowStart) renderWindowStart = time;
  renderFrameCount += 1;
  if (time - renderWindowStart >= 1000) {
    document.body.dataset.renderFps = (
      renderFrameCount * 1000 / Math.max(1, time - renderWindowStart)
    ).toFixed(1);
    renderFrameCount = 0;
    renderWindowStart = time;
  }
  updateTracking();
  updateHapticLogic();

  if (!stream) {
    photoHead.rotation.y = userViewActive ? viewYaw : Math.sin(time * 0.00045) * 0.18;
    photoHead.rotation.x = userViewActive ? viewPitch : Math.sin(time * 0.00031) * 0.024;
    document.body.dataset.viewYaw = THREE.MathUtils.radToDeg(photoHead.rotation.y).toFixed(1);
    document.body.dataset.viewPitch = THREE.MathUtils.radToDeg(photoHead.rotation.x).toFixed(1);
  }

  const config = MODES[activeMode];
  const duration = officialActionTrack
    ? officialActionTrack.totalFrames / officialActionTrack.fps
    : config.frames / config.fps;
  const elapsed = (time - animationStart) / 1000;
  const cycle = Math.floor(elapsed / duration);
  const progress = (((elapsed % duration) + duration) % duration) / duration;
  const frameIndex = Math.min(config.frames - 1, Math.floor(progress * config.frames));

  if (cycle !== previousCycle) previousCycle = cycle;
  if (currentTextures[frameIndex] && sequenceMaterial.map !== currentTextures[frameIndex]) {
    sequenceMaterial.map = currentTextures[frameIndex];
    sequenceMaterial.needsUpdate = true;
  }

  progressBar.style.width = `${Math.max(2, progress * 100)}%`;
  const face = getFaceLayout();
  const activeTool = makeupTools[activeToolKey];
  const faceReady = photoHeadReady || Boolean(liveLandmarks);
  const uses3DTool = faceReady && activeTool?.ready;
  Object.values(makeupTools).forEach(({ group }) => { group.visible = false; });
  if (uses3DTool) activeTool.group.visible = true;
  sequencePlane.visible = faceReady && !uses3DTool && currentTextures.length > 0;
  const activeContact = uses3DTool
    ? update3DTool(activeMode, face, cycle, progress)
    : updateSequencePlane(cycle, progress, face);
  updateMakeupRegionGuide(activeMode, face, cycle, progress, activeContact);

  renderer.render(scene, camera);
  drawHandOverlay();
  requestAnimationFrame(render);
}

cameraButton.addEventListener("click", () => {
  if (stream) stopCamera();
  else startCamera();
});

modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
officialActionSelect.addEventListener("change", () => {
  setOfficialAction(OFFICIAL_ACTIONS.find((action) => action.runtimeId === officialActionSelect.value));
});

canvas.title = "拖拽旋转 3D 视角，双击恢复正面";
canvas.addEventListener("pointerdown", (event) => {
  if (stream) return;
  if (!userViewActive) {
    viewYaw = photoHead.rotation.y;
    viewPitch = photoHead.rotation.x;
    userViewActive = true;
  }
  viewDragging = true;
  viewPointerX = event.clientX;
  viewPointerY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("is-dragging");
});
canvas.addEventListener("pointermove", (event) => {
  if (!viewDragging || stream) return;
  const deltaX = event.clientX - viewPointerX;
  const deltaY = event.clientY - viewPointerY;
  viewPointerX = event.clientX;
  viewPointerY = event.clientY;
  viewYaw = THREE.MathUtils.clamp(viewYaw + deltaX * 0.005, -0.56, 0.56);
  viewPitch = THREE.MathUtils.clamp(viewPitch + deltaY * 0.004, -0.32, 0.32);
});
const stopViewDrag = (event) => {
  if (!viewDragging) return;
  viewDragging = false;
  canvas.classList.remove("is-dragging");
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
};
canvas.addEventListener("pointerup", stopViewDrag);
canvas.addEventListener("pointercancel", stopViewDrag);
canvas.addEventListener("dblclick", () => {
  if (stream) return;
  userViewActive = true;
  viewYaw = 0;
  viewPitch = 0;
});
window.addEventListener("resize", resize);
window.addEventListener("beforeunload", () => stream?.getTracks().forEach((track) => track.stop()));

populateOfficialActionSelect();
resize();
loadPhotoHead();
loadReferenceMotion();
loadMakeupTools().then(() => {
  if (officialActionLoadVersion === 0) setOfficialAction(DEFAULT_OFFICIAL_ACTION);
});
requestAnimationFrame(render);
connectHapticBridge();

// ════════════════════════════════════════════════════════════
// 手部离开指定化妆区域 → 腕带震动（摄像头闭环）
// 链路：HandLandmarker 手部 21 点 → 与当前动作化妆区域（人脸 478 点）
//       做 2D 包含判定 → 离开超时 → WebSocket → nano_bridge.py → Nano 马达
// ════════════════════════════════════════════════════════════

function resetHapticState() {
  liveHands = [];
  lastHandSeenAt = -Infinity;
  handInRegion = false;
  hapticPhase = "idle";
  hapticPhaseSince = 0;
  hapticLastSendAt = 0;
  updateHapticBadge();
}

function updateHandTracking() {
  // 新帧已由调用方 updateTracking() 判定；此处不再用 lastVideoTime 守卫，
  // 否则面部跟踪刚更新 lastVideoTime 会导致手部检测永远跳过。
  if (!handLandmarker || !stream || video.readyState < 2) return;
  handTrackFrame = (handTrackFrame + 1) % HAPTIC_TRACK_EVERY_N;
  if (handTrackFrame !== 0) return;
  try {
    const result = handLandmarker.detectForVideo(video, performance.now());
    liveHands = result.landmarks ?? [];
    if (liveHands.length) lastHandSeenAt = performance.now();
  } catch (error) {
    console.warn("Hand tracking frame skipped", error);
  }
}

/** 当前动作的化妆区域 → 归一化坐标多边形/折线列表（含容差）。 */
function getActiveRegionPolys() {
  if (!liveLandmarks) return [];
  const regions = officialActionTrack?.regions;
  if (regions?.length) {
    return regions.map((region) => {
      const points = (region.indices ?? [])
        .filter((index) => Number.isInteger(index) && index >= 0 && index < 468)
        .map((index) => [liveLandmarks[index].x, liveLandmarks[index].y]);
      if (points.length < 3) return null;
      if (points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
      return {
        points,
        closed: region.geomType === "closed",
        tolerance: Number(region.tolerance) || 1.05,
      };
    }).filter(Boolean);
  }
  // 无 regionSlots 的动作：用内置 478 点区域路径（左右两侧都判定）
  return [0, 1].map((side) => ({
    points: MAKEUP_REGION_PATHS[activeMode][side]
      .map((index) => [liveLandmarks[index].x, liveLandmarks[index].y]),
    closed: true,
    tolerance: 1.15,
  })).filter((region) => region.points.length >= 3);
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersect = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToPolyline(x, y, points) {
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const ax = points[i][0];
    const ay = points[i][1];
    const bx = points[i + 1][0];
    const by = points[i + 1][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < min) min = d;
  }
  return min;
}

/** 实时脸宽（归一化坐标），用于把按脸宽比例的容忍阈值换算成坐标距离。 */
function faceWidthNorm() {
  return Math.abs(liveLandmarks[454].x - liveLandmarks[234].x);
}

/** 按 region.tolerance 以质心为中心外扩闭合区域点集。 */
function scaledRegionPoints(region) {
  if (region.tolerance === 1) return region.points;
  let cx = 0;
  let cy = 0;
  for (const [px, py] of region.points) {
    cx += px;
    cy += py;
  }
  cx /= region.points.length;
  cy /= region.points.length;
  return region.points.map(([px, py]) => [
    cx + (px - cx) * region.tolerance,
    cy + (py - cy) * region.tolerance,
  ]);
}

/** 点到闭合多边形边界的最短距离（含收尾边）。 */
function distToClosedPolyline(x, y, points) {
  let min = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < min) min = d;
  }
  return min;
}

function handPointInsideRegion(x, y, region) {
  if (region.closed) {
    if (region.points.length < 3) return false;
    const pts = scaledRegionPoints(region);
    if (pointInPolygon(x, y, pts)) return true;
    // 容忍带：指尖出了区域边界，但距边界不超过 HAPTIC_REGION_PAD（按脸宽比例）仍算「在区域内」
    const pad = Math.max(HAPTIC_OPEN_MIN_PX, faceWidthNorm() * HAPTIC_REGION_PAD);
    return distToClosedPolyline(x, y, pts) <= pad;
  }
  // 开放曲线（眼线等）：点到折线距离 < 阈值（按实时脸宽比例，带下限）
  const threshold = Math.max(HAPTIC_OPEN_MIN_PX, faceWidthNorm() * HAPTIC_OPEN_TOL);
  return distToPolyline(x, y, region.points) <= threshold;
}

function handKeyPoints(hand) {
  return HAND_KEYPOINTS.map((index) => [hand[index].x, hand[index].y]);
}

function updateHapticLogic() {
  if (!hapticSocketOpen) return;
  const now = performance.now();

  // 只在摄像头 + 人脸跟踪 + 有化妆区域时启用判定
  if (!stream || !liveLandmarks) {
    if (hapticPhase !== "idle") {
      hapticPhase = "idle";
      sendHaptic("0");
    }
    updateHapticBadge();
    return;
  }
  const regions = getActiveRegionPolys();
  if (!regions.length) {
    if (hapticPhase !== "idle") {
      hapticPhase = "idle";
      sendHaptic("0");
    }
    updateHapticBadge();
    return;
  }
  // 手从没出现过（或很久没出现）→ 判定不生效，避免未伸手就误震
  if (now - lastHandSeenAt > HAPTIC_ARM_MS) {
    if (hapticPhase !== "idle") {
      hapticPhase = "idle";
      sendHaptic("0");
    }
    updateHapticBadge();
    return;
  }

  // 指尖 / 掌根任一点落在任一化妆区域内 → 视为「手在区域内」
  handInRegion = liveHands.some((hand) =>
    handKeyPoints(hand).some(([x, y]) =>
      regions.some((region) => handPointInsideRegion(x, y, region)),
    ),
  );

  if (hapticPhase === "vibrating") {
    if (handInRegion) {
      hapticPhase = "idle";
      hapticPhaseSince = now;
      sendHaptic("0");
    } else if (now - hapticLastSendAt >= HAPTIC_HOLD_MS) {
      // 持续离开：周期性重发 '3' 保持震动（Nano 3s 无命令自动关断）
      sendHaptic("3");
      hapticLastSendAt = now;
    }
  } else if (!handInRegion) {
    if (hapticPhase !== "out") {
      hapticPhase = "out";
      hapticPhaseSince = now;
    }
    if (now - hapticPhaseSince >= HAPTIC_LEAVE_MS) {
      hapticPhase = "vibrating";
      hapticLastSendAt = 0;
      sendHaptic("3");
      hapticLastSendAt = now;
    }
  } else {
    hapticPhase = "idle";
    hapticPhaseSince = now;
  }
  updateHapticBadge();
}

function connectHapticBridge() {
  clearTimeout(hapticRetryTimer);
  if (hapticSocket) {
    try {
      hapticSocket.close();
    } catch (error) {
      /* ignore */
    }
    hapticSocket = null;
  }
  hapticReady = false;
  updateHapticBadge();
  try {
    hapticSocket = new WebSocket(HAPTIC_WS_URL);
  } catch (error) {
    scheduleHapticReconnect();
    return;
  }
  hapticSocket.addEventListener("open", () => {
    hapticSocketOpen = true;
    hapticReady = false; // 等桥回 ready 帧
    updateHapticBadge();
  });
  hapticSocket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "ready") hapticReady = true;
    } catch (error) {
      /* ignore non-json */
    }
    updateHapticBadge();
  });
  hapticSocket.addEventListener("close", () => {
    hapticSocketOpen = false;
    hapticReady = false;
    if (hapticPhase === "vibrating") {
      // 桥断了不再续发，Nano 3s 后自动停震（固件看门狗）
      hapticPhase = "idle";
    }
    updateHapticBadge();
    scheduleHapticReconnect();
  });
  hapticSocket.addEventListener("error", () => {
    // close 事件会随后触发，这里只负责更新
    updateHapticBadge();
  });
}

function scheduleHapticReconnect() {
  clearTimeout(hapticRetryTimer);
  hapticRetryTimer = setTimeout(connectHapticBridge, 2000);
}

function sendHaptic(cmd) {
  if (hapticSocketOpen && hapticSocket) {
    try {
      hapticSocket.send(cmd);
      return true;
    } catch (error) {
      /* fall through */
    }
  }
  return false;
}

function updateHapticBadge() {
  const el = document.querySelector("#hapticBadge");
  if (!el) return;
  let text;
  let cls;
  if (!hapticSocketOpen) {
    text = "腕带桥未连接";
    cls = "off";
  } else if (hapticPhase === "vibrating") {
    text = "手离开区域 · 震动中";
    cls = "alert";
  } else {
    const handText = handInRegion
      ? "手在区域内"
      : (liveHands.length ? "手离开区域" : "等待手进入区域");
    text = `腕带桥已连接 · ${handText}`;
    cls = "ok";
  }
  if (text !== lastHapticBadgeText) {
    lastHapticBadgeText = text;
    el.textContent = text;
    el.className = `haptic-badge ${cls}`;
  }
}

// ════════════════════════════════════════════════════════════
// 手部可视化叠加层：在摄像头画面上绘制 化妆区域 + 手部骨架
// ════════════════════════════════════════════════════════════
const HAND_SKELETON = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

/** video 归一化坐标(0~1) → 容器内 CSS 像素（cover 适配，不含镜像） */
function videoPointToStage(u, v) {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const cw = cameraStage.clientWidth || 1;
  const ch = cameraStage.clientHeight || 1;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const ox = (cw - dw) / 2;
  const oy = (ch - dh) / 2;
  return { x: u * dw + ox, y: v * dh + oy };
}

function drawHandOverlay() {
  if (!handCtx || !cameraStage) return;
  const stageW = cameraStage.clientWidth;
  const stageH = cameraStage.clientHeight;
  if (handOverlay.width !== stageW || handOverlay.height !== stageH) {
    handOverlay.width = stageW;
    handOverlay.height = stageH;
  }
  handCtx.clearRect(0, 0, stageW, stageH);
  if (!stream || !liveLandmarks) return;

  // ── 当前动作的化妆区域（2D 投影）──
  const regions = getActiveRegionPolys();
  const regionColor = handInRegion ? "201,162,39" : "201,162,39";
  for (const region of regions) {
    const pts = region.closed ? scaledRegionPoints(region) : region.points;
    const pixel = pts.map(([x, y]) => videoPointToStage(x, y));
    handCtx.beginPath();
    pixel.forEach((p, index) => {
      if (index === 0) handCtx.moveTo(p.x, p.y);
      else handCtx.lineTo(p.x, p.y);
    });
    if (region.closed) handCtx.closePath();
    handCtx.fillStyle = `rgba(${regionColor},0.10)`;
    handCtx.strokeStyle = `rgba(${regionColor},0.75)`;
    handCtx.lineWidth = 2;
    if (region.closed) handCtx.fill();
    handCtx.stroke();
    if (region.closed) {
      // 容忍带可视化：按质心近似外扩，虚线圈即实际判定的最外边界
      let cx = 0;
      let cy = 0;
      let radiusSum = 0;
      for (const [px, py] of pts) { cx += px; cy += py; }
      cx /= pts.length;
      cy /= pts.length;
      for (const [px, py] of pts) radiusSum += Math.hypot(px - cx, py - cy);
      const pad = Math.max(HAPTIC_OPEN_MIN_PX, faceWidthNorm() * HAPTIC_REGION_PAD);
      const outerScale = 1 + pad / Math.max(1e-6, radiusSum / pts.length);
      const outer = pts.map(([x, y]) =>
        videoPointToStage(cx + (x - cx) * outerScale, cy + (y - cy) * outerScale));
      handCtx.beginPath();
      outer.forEach((p, index) => {
        if (index === 0) handCtx.moveTo(p.x, p.y);
        else handCtx.lineTo(p.x, p.y);
      });
      handCtx.closePath();
      handCtx.setLineDash([6, 6]);
      handCtx.strokeStyle = `rgba(${regionColor},0.45)`;
      handCtx.lineWidth = 1.5;
      handCtx.stroke();
      handCtx.setLineDash([]);
    }
  }

  // ── 手部骨架 ──
  const color = handInRegion ? "96,199,128" : "255,110,90";
  for (const hand of liveHands) {
    const pts = hand.map((lm) => videoPointToStage(lm.x, lm.y));
    handCtx.lineWidth = 3;
    handCtx.lineJoin = "round";
    handCtx.strokeStyle = `rgba(${color},0.92)`;
    for (const [a, b] of HAND_SKELETON) {
      handCtx.beginPath();
      handCtx.moveTo(pts[a].x, pts[a].y);
      handCtx.lineTo(pts[b].x, pts[b].y);
      handCtx.stroke();
    }
    pts.forEach((p, index) => {
      handCtx.beginPath();
      const r = index === 8 ? 6 : index === 12 ? 5 : index === 0 ? 5 : 3;
      handCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
      handCtx.fillStyle = index === 8 ? "#ffd166" : index === 12 ? "#ffa94d" : `rgba(255,255,255,0.9)`;
      handCtx.fill();
    });
  }
}
