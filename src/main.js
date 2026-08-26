import * as THREE from "three";
import "./style.css";
import { DEFAULT_OFFICIAL_ACTION, OFFICIAL_ACTIONS } from "./official-actions.js";

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
let officialActionTrack = null;
let officialActionLoadVersion = 0;
let FaceLandmarker = null;
let FilesetResolver = null;
let faceLandmarker = null;
let stream = null;
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
let referenceFaceLandmarks = null;
let photoHeadReady = false;
let viewYaw = 0;
let viewPitch = 0;
let viewDragging = false;
let viewPointerX = 0;
let viewPointerY = 0;
let userViewActive = false;
let smoothedToolContact = null;
let smoothedContactKey = "";

const sequenceCache = new Map();
const textureLoader = new THREE.TextureLoader();
let officialRegionLibraryPromise = null;

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
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
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

function parseCanonicalFaceObj(text) {
  const vertices = [];
  const uvs = [];
  const faces = [];
  text.split(/\r?\n/).forEach((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "v") vertices.push(parts.slice(1, 4).map(Number));
    if (parts[0] === "vt") uvs.push(parts.slice(1, 3).map(Number));
    if (parts[0] === "f") {
      faces.push(parts.slice(1, 4).map((entry) => {
        const [vertexIndex, uvIndex] = entry.split("/").map(Number);
        return { vertexIndex: vertexIndex - 1, uvIndex: uvIndex - 1 };
      }));
    }
  });
  return { vertices, uvs, faces };
}

function makePhotoFaceGeometry(landmarks, canonical) {
  const faceWidth = Math.hypot(
    landmarks[454].x - landmarks[234].x,
    landmarks[454].y - landmarks[234].y,
  );
  const centerX = (landmarks[454].x + landmarks[234].x) * 0.5;
  const centerY = (landmarks[10].y + landmarks[152].y) * 0.5;
  const canonicalWidth = new THREE.Vector3(...canonical.vertices[454])
    .distanceTo(new THREE.Vector3(...canonical.vertices[234]));
  const canonicalCenterX = (canonical.vertices[454][0] + canonical.vertices[234][0]) * 0.5;
  const canonicalCenterY = (canonical.vertices[10][1] + canonical.vertices[152][1]) * 0.5;
  const cheekDepth = (canonical.vertices[454][2] + canonical.vertices[234][2]) * 0.5;
  const sourceShapeWeight = 0.24;
  const shapedVertices = landmarks.slice(0, 468).map((landmark, index) => {
    const canonicalVertex = canonical.vertices[index];
    const sourceX = (landmark.x - centerX) / faceWidth;
    const sourceY = (centerY - landmark.y) / faceWidth;
    const canonicalX = (canonicalVertex[0] - canonicalCenterX) / canonicalWidth;
    const canonicalY = (canonicalVertex[1] - canonicalCenterY) / canonicalWidth;
    return [
      THREE.MathUtils.lerp(canonicalX, sourceX, sourceShapeWeight),
      THREE.MathUtils.lerp(canonicalY, sourceY, sourceShapeWeight),
      (canonicalVertex[2] - cheekDepth) / canonicalWidth,
    ];
  });
  referenceFaceVertices = shapedVertices;

  const positions = [];
  const uvs = [];
  canonical.faces.forEach((face) => {
    face.forEach(({ vertexIndex, uvIndex }) => {
      positions.push(...shapedVertices[vertexIndex]);
      uvs.push(...canonical.uvs[uvIndex]);
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
    FilesetResolver = visionTasks.FilesetResolver;
  }
  return FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm",
  );
}

async function loadPhotoHead() {
  setStatus("正在加载照片生成的 478 点 UV 人脸…");
  try {
    const [canonicalText, landmarks, texture, portraitTexture] = await Promise.all([
      fetch(assetUrl("models/canonical-face-model.obj")).then((response) => response.text()),
      fetch(assetUrl("models/reference-face-478.json")).then((response) => response.json()),
      textureLoader.loadAsync(assetUrl("models/reference-face-uv.png")),
      textureLoader.loadAsync(assetUrl("models/reference-portrait.png")),
    ]);
    if (!landmarks || landmarks.length !== 478) throw new Error("Reference image did not return 478 landmarks");
    referenceFaceLandmarks = landmarks;

    const canonical = parseCanonicalFaceObj(canonicalText);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    portraitTexture.colorSpace = THREE.SRGBColorSpace;
    portraitTexture.minFilter = THREE.LinearMipmapLinearFilter;
    portraitTexture.magFilter = THREE.LinearFilter;
    portraitTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    const sourceFaceWidth = Math.hypot(
      landmarks[454].x - landmarks[234].x,
      landmarks[454].y - landmarks[234].y,
    );
    const sourceCenterX = (landmarks[454].x + landmarks[234].x) * 0.5;
    const sourceCenterY = (landmarks[10].y + landmarks[152].y) * 0.5;
    const portraitWidth = 1 / sourceFaceWidth;
    const portraitHeight = portraitWidth * (
      portraitTexture.image.naturalHeight / portraitTexture.image.naturalWidth
    );
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(portraitWidth, portraitHeight),
      new THREE.MeshBasicMaterial({
        map: portraitTexture,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    backdrop.name = "full-reference-portrait-background";
    backdrop.position.set(
      -(sourceCenterX - 0.5) * portraitWidth,
      (sourceCenterY - 0.5) * portraitHeight,
      -0.42,
    );
    backdrop.renderOrder = 0;
    backdrop.frustumCulled = false;
    photoHead.add(backdrop);

    const face = new THREE.Mesh(
      makePhotoFaceGeometry(landmarks, canonical),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false }),
    );
    face.name = "reference-photo-uv-face-surface";
    face.renderOrder = 1;
    face.frustumCulled = false;
    photoHead.add(face);
    photoHeadReady = true;
    photoHead.visible = !stream;
    document.body.dataset.faceAsset = "reference-photo-uv";
    document.body.dataset.photoBackdrop = "full-reference-portrait";
    document.body.dataset.referenceLandmarkCount = String(landmarks.length);
    window.__referenceFaceLandmarks = landmarks;
    resize();
    if (!stream) setStatus(`照片 UV 3D 人脸 · 478 点 · ${activeOfficialAction.categoryLabel}`);
  } catch (error) {
    console.error("Failed to build photo UV face", error);
    setStatus("照片人脸生成失败，请检查网络后重试", "is-error");
  }
}

const sequenceMaterial = new THREE.MeshBasicMaterial({
  transparent: true,
  depthTest: false,
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

const makeupTools = Object.fromEntries(
  Object.keys(VOLUME_SPECS).map((mode) => {
    const group = new THREE.Group();
    group.name = `${mode}-sequence-extrusion-3d`;
    group.visible = false;
    group.renderOrder = 30;
    scene.add(group);
    return [mode, { group, frames: [], ready: false }];
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
    depthTest: false,
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
      depthTest: false,
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
      depthTest: false,
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
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const pointMaterial = new THREE.PointsMaterial({
    color: 0xffb263,
    size: 5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.34,
    depthTest: false,
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
    depthTest: false,
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

function volumeUvGenerator(frame, depth) {
  const minX = -frame.width * 0.5;
  const minY = -frame.height * 0.5;
  const topUv = (vertices, index) => new THREE.Vector2(
    (vertices[index * 3] - minX) / frame.width,
    (vertices[index * 3 + 1] - minY) / frame.height,
  );
  return {
    generateTopUV(_geometry, vertices, indexA, indexB, indexC) {
      return [topUv(vertices, indexA), topUv(vertices, indexB), topUv(vertices, indexC)];
    },
    generateSideWallUV(_geometry, vertices, indexA, indexB, indexC, indexD) {
      const xA = vertices[indexA * 3];
      const yA = vertices[indexA * 3 + 1];
      const zA = vertices[indexA * 3 + 2];
      const xB = vertices[indexB * 3];
      const yB = vertices[indexB * 3 + 1];
      const zB = vertices[indexB * 3 + 2];
      const useX = Math.abs(xA - xB) >= Math.abs(yA - yB);
      const edgeA = useX ? (xA - minX) / frame.width : (yA - minY) / frame.height;
      const edgeB = useX ? (xB - minX) / frame.width : (yB - minY) / frame.height;
      return [
        new THREE.Vector2(edgeA, zA / depth),
        new THREE.Vector2(edgeB, zB / depth),
        new THREE.Vector2(edgeB, 1),
        new THREE.Vector2(edgeA, 1),
      ];
    },
  };
}

function makeExtrudedSequenceFrame(mode, frame, texture) {
  const depth = VOLUME_SPECS[mode].depth;
  const group = new THREE.Group();
  group.name = `${mode}-extruded-frame`;
  group.visible = false;

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const faceMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.035,
    side: THREE.DoubleSide,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  const sideMaterial = new THREE.MeshStandardMaterial({
    color: frame.sideColor,
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });

  frame.polygons.forEach((polygon) => {
    const shape = new THREE.Shape();
    polygon.forEach(([x, y], index) => {
      if (index === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      steps: 1,
      bevelEnabled: true,
      bevelSize: 0.006,
      bevelThickness: 0.006,
      bevelSegments: 1,
      UVGenerator: volumeUvGenerator(frame, depth),
    });
    const mesh = new THREE.Mesh(geometry, [faceMaterial, sideMaterial]);
    mesh.position.set(-frame.anchor[0], -frame.anchor[1], -depth * 0.5);
    mesh.renderOrder = 30;
    mesh.frustumCulled = false;
    group.add(mesh);
  });
  return group;
}

async function loadMakeupTools() {
  try {
    const response = await fetch(assetUrl("volumes/volume-models.json"));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const volumeData = await response.json();
    await Promise.all(Object.keys(VOLUME_SPECS).map(async (mode) => {
      const frames = await Promise.all(volumeData[mode].map(async (frame) => {
        const texture = await textureLoader.loadAsync(
          `${assetUrl(frame.texture)}?v=hands-collision-v1`,
        );
        return makeExtrudedSequenceFrame(mode, frame, texture);
      }));
      makeupTools[mode].frames = frames;
      makeupTools[mode].group.add(...frames);
      makeupTools[mode].ready = frames.length === MODES[mode].frames;
      document.body.dataset[`${mode}Asset`] = "sequence-extrusion-3d";
    }));
    document.body.dataset.sequenceVolumeFrames = String(
      Object.values(makeupTools).reduce((total, tool) => total + tool.frames.length, 0),
    );
    await setMode(activeMode);
  } catch (error) {
    console.error("Failed to load extruded sequence-frame models", error);
  }
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
  photoHead.scale.setScalar(previewFaceWidth * (narrow ? 0.96 : 0.92));
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
      (_, index) => `/sequences/${config.sequence}/frame_${String(index).padStart(3, "0")}.png`,
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
  const pairs = {
    33: 263, 133: 362, 145: 374, 153: 380, 154: 381, 155: 382,
    157: 386, 158: 385, 159: 384, 160: 387, 61: 291, 146: 375,
    91: 321, 181: 405, 84: 314, 109: 338, 151: 337, 123: 352,
    50: 280, 101: 330, 205: 425,
  };
  return pairs[index] ?? Object.keys(pairs).find((key) => pairs[key] === index) ?? index;
}

function bindPointToSourceFace(point, sourceLandmarks) {
  const nearest = [];
  for (let index = 0; index < Math.min(468, sourceLandmarks.length); index += 1) {
    const landmark = sourceLandmarks[index];
    const dx = Number(point.x) - Number(landmark[0] ?? landmark.x);
    const dy = Number(point.y) - Number(landmark[1] ?? landmark.y);
    const distance2 = dx * dx + dy * dy;
    if (nearest.length < 4 || distance2 < nearest.at(-1).distance2) {
      nearest.push({ index, distance2 });
      nearest.sort((a, b) => a.distance2 - b.distance2);
      if (nearest.length > 4) nearest.pop();
    }
  }
  const rawWeights = nearest.map(({ distance2 }) => 1 / Math.max(16, distance2));
  const total = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
  return nearest.map(({ index }, itemIndex) => ({ index, weight: rawWeights[itemIndex] / total }));
}

function fallbackTrack(action, regions = []) {
  let indices = ACTION_FALLBACK_LANDMARKS[action.category] ?? MAKEUP_REGION_PATHS[action.toolMode][0];
  if (action.side === "right") indices = indices.map((index) => Number(mirrorLandmarkIndex(index)));
  const totalFrames = 120;
  return {
    action,
    fps: 30,
    totalFrames,
    segments: [{
      startFrame: 0,
      endFrame: totalFrames,
      points: indices.map((index, pointIndex) => ({
        frame: pointIndex / Math.max(1, indices.length - 1) * totalFrames,
        binding: [{ index, weight: 1 }],
      })),
    }],
    regions,
    source: "semantic-478-fallback",
  };
}

function buildOfficialActionTrack(action, actionData, regionLibrary) {
  const regions = (actionData.regionSlots ?? [])
    .map((slot) => regionLibrary.get(slot.regionId))
    .filter(Boolean);
  const sourceFrame = actionData.faceMesh?.frames?.find((frame) => frame.landmarks?.length >= 468);
  if (!sourceFrame) return fallbackTrack(action, regions);
  const segments = (actionData.strokeSegments ?? [])
    .filter((segment) => segment.points?.length > 0)
    .map((segment) => ({
      startFrame: Number(segment.startFrame) || 0,
      endFrame: Number(segment.endFrame) || Number(segment.startFrame) || 0,
      actionType: segment.actionType ?? "sweeping",
      points: segment.points
        .map((point) => ({
          frame: Number(point.frame) || 0,
          binding: bindPointToSourceFace(point, sourceFrame.landmarks),
        }))
        .sort((a, b) => a.frame - b.frame),
    }))
    .sort((a, b) => a.startFrame - b.startFrame);
  if (!segments.length) return fallbackTrack(action, regions);
  const segmentEnd = Math.max(...segments.map((segment) => segment.endFrame));
  return {
    action,
    fps: Math.max(1, Number(actionData.videoMeta?.fps) || 30),
    totalFrames: Math.max(1, Number(actionData.videoMeta?.totalFrames) || segmentEnd),
    segments,
    regions,
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
  activeOfficialAction = action;
  officialActionTrack = null;
  updateOfficialActionLabels(action);
  await setMode(action.toolMode);
  updateOfficialActionLabels(action);
  const version = ++officialActionLoadVersion;
  setStatus(`正在适配${action.displayName}的 478 点笔触…`);
  try {
    const [response, regionLibrary] = await Promise.all([
      fetch(assetUrl(`actions/${encodeURIComponent(action.runtimeId)}`)),
      loadOfficialRegionLibrary(),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const actionData = await response.json();
    if (version !== officialActionLoadVersion || activeOfficialAction !== action) return;
    officialActionTrack = buildOfficialActionTrack(action, actionData, regionLibrary);
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

  if (makeupTools[mode]?.ready) {
    document.body.dataset.sequence = mode;
    setStatus(
      stream ? "478 点动态跟踪 · 序列帧立体工具" : `照片 UV 3D 人脸 · ${config.label}序列帧立体模型`,
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
      stream ? "478 点动态跟踪" : `照片 UV 3D 人脸 · ${config.label}`,
      stream ? "is-live" : "",
    );
  } catch (error) {
    console.error(`Failed to load ${mode} sequence`, error);
    setStatus("动作序列加载失败", "is-error");
  }
}

function buildFaceIndices() {
  const connections = FaceLandmarker?.FACE_LANDMARKS_TESSELATION ?? [];
  const indices = [];
  for (let index = 0; index + 2 < connections.length; index += 3) {
    const vertices = [...new Set([
      connections[index].start,
      connections[index].end,
      connections[index + 1].start,
      connections[index + 1].end,
      connections[index + 2].start,
      connections[index + 2].end,
    ])];
    if (vertices.length === 3) indices.push(...vertices);
  }
  return indices;
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

function livePoint(landmark, z = 0) {
  if (!video.videoWidth || !video.videoHeight) return new THREE.Vector3(0, 0, z);
  const viewportWidth = canvas.clientWidth;
  const viewportHeight = canvas.clientHeight;
  const scale = Math.max(viewportWidth / video.videoWidth, viewportHeight / video.videoHeight);
  const renderedWidth = video.videoWidth * scale;
  const renderedHeight = video.videoHeight * scale;
  const offsetX = (viewportWidth - renderedWidth) * 0.5;
  const offsetY = (viewportHeight - renderedHeight) * 0.5;
  const pixelX = offsetX + (1 - landmark.x) * renderedWidth;
  const pixelY = offsetY + landmark.y * renderedHeight;
  const aspect = viewportWidth / viewportHeight;
  return new THREE.Vector3((pixelX / viewportWidth * 2 - 1) * aspect, 1 - pixelY / viewportHeight * 2, z);
}

function updateLiveFaceGeometry() {
  if (!liveFaceMesh || !liveLandmarks) return;
  const geometry = liveFaceMesh.geometry;
  const positions = geometry.attributes.position;
  const uvs = geometry.attributes.uv;
  const left = livePoint(liveLandmarks[234]);
  const right = livePoint(liveLandmarks[454]);
  const faceWidth = left.distanceTo(right);

  for (let index = 0; index < Math.min(478, liveLandmarks.length); index += 1) {
    const landmark = liveLandmarks[index];
    const point = livePoint(landmark, 0.1 - landmark.z * faceWidth * 1.35);
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
  const vision = await ensureVisionRuntime();
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
}

async function startCamera() {
  cameraButton.disabled = true;
  cameraButton.textContent = "正在开启…";
  try {
    await initFaceTracking();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    lastVideoTime = -1;
    trackedFaceLayout = null;
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
  trackedFaceLayout = null;
  lastVideoTime = -1;
  document.body.dataset.landmarkCount = "0";
  if (liveFaceMesh) liveFaceMesh.visible = false;
  if (liveFacePoints) liveFacePoints.visible = false;
  photoHead.visible = photoHeadReady;
  cameraButton.innerHTML = '<span class="camera-dot"></span>开启摄像头';
  setStatus(`照片 UV 3D 人脸 · 478 点 · ${activeOfficialAction.categoryLabel}`);
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
      trackedFaceLayout = null;
      document.body.dataset.landmarkCount = "0";
      if (liveFaceMesh) liveFaceMesh.visible = false;
      if (liveFacePoints) liveFacePoints.visible = false;
      setStatus("请将面部保持在画面中央");
    }
  } catch (error) {
    console.warn("Face tracking frame skipped", error);
  }
}

function getFaceLayout() {
  if (liveLandmarks) {
    const screenLeft = livePoint(liveLandmarks[454]);
    const screenRight = livePoint(liveLandmarks[234]);
    const screenWidth = screenLeft.distanceTo(screenRight);
    const worldPoint = (index) => {
      const landmark = liveLandmarks[index];
      return livePoint(landmark, 0.1 - landmark.z * screenWidth * 1.35);
    };
    const left = worldPoint(454);
    const right = worldPoint(234);
    const top = worldPoint(10);
    const chin = worldPoint(152);
    const rightAxis = right.clone().sub(left).normalize();
    const roughUp = top.clone().sub(chin).normalize();
    const normalAxis = new THREE.Vector3().crossVectors(rightAxis, roughUp).normalize();
    if (normalAxis.z < 0) normalAxis.negate();
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
  const previewQuaternion = photoHead.quaternion.clone();
  const previewNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(previewQuaternion);
  document.body.dataset.faceYaw = THREE.MathUtils.radToDeg(
    Math.atan2(previewNormal.x, previewNormal.z),
  ).toFixed(1);
  return {
    center: new THREE.Vector3(0, photoHead.position.y - 0.02, 0.9),
    width: previewFaceWidth,
    quaternion: previewQuaternion,
    surfaceOffset: 0.2,
  };
}

function getFaceLandmarkWorld(index, face) {
  if (liveLandmarks?.[index]) {
    const screenLeft = livePoint(liveLandmarks[454]);
    const screenRight = livePoint(liveLandmarks[234]);
    const screenWidth = screenLeft.distanceTo(screenRight);
    const landmark = liveLandmarks[index];
    return livePoint(landmark, 0.1 - landmark.z * screenWidth * 1.35);
  }

  if (referenceFaceVertices?.[index]) {
    photoHead.updateMatrixWorld(true);
    return new THREE.Vector3(...referenceFaceVertices[index]).applyMatrix4(photoHead.matrixWorld);
  }

  return face.center.clone();
}

function resolveActionBinding(binding, face) {
  const point = new THREE.Vector3();
  binding.forEach(({ index, weight }) => {
    point.addScaledVector(getFaceLandmarkWorld(index, face), weight);
  });
  return point;
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
    return { point: resolveActionBinding(points[0].binding, face), segmentIndex, indices: points[0].binding.map((item) => item.index) };
  }
  const clampedFrame = THREE.MathUtils.clamp(frame, points[0].frame, points.at(-1).frame);
  let pointIndex = points.findIndex((point) => point.frame >= clampedFrame);
  if (pointIndex <= 0) pointIndex = 1;
  const before = points[pointIndex - 1];
  const after = points[pointIndex] ?? before;
  const range = Math.max(1, after.frame - before.frame);
  const mix = THREE.MathUtils.clamp((clampedFrame - before.frame) / range, 0, 1);
  const point = resolveActionBinding(before.binding, face)
    .lerp(resolveActionBinding(after.binding, face), mix);
  return {
    point,
    segmentIndex,
    indices: [...new Set([...before.binding, ...after.binding].map((item) => item.index))],
  };
}

function sampleLandmarkPath(indices, progress, face) {
  const points = indices.map((index) => getFaceLandmarkWorld(index, face));
  if (points.length < 2) return { point: points[0] ?? face.center.clone(), segment: 0 };

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
        segment: index,
      };
    }
    remaining -= lengths[index];
  }

  return { point: points.at(-1).clone(), segment: points.length - 2 };
}

function getMakeupContact(mode, progress, cycle, face) {
  if (officialActionTrack) {
    const sampled = sampleOfficialTrack(officialActionTrack, progress, face);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).normalize();
    sampled.point.addScaledVector(normal, face.width * VOLUME_SPECS[mode].contactLift);
    const contactKey = `${activeOfficialAction.runtimeId}-${sampled.segmentIndex}-${liveLandmarks ? "live" : "preview"}`;
    if (liveLandmarks) {
      if (!smoothedToolContact || smoothedContactKey !== contactKey) {
        smoothedToolContact = sampled.point.clone();
        smoothedContactKey = contactKey;
      } else {
        smoothedToolContact.lerp(sampled.point, 0.52);
      }
      sampled.point.copy(smoothedToolContact);
    }
    return {
      ...sampled,
      segment: sampled.segmentIndex,
      side: activeOfficialAction.side === "right" ? 1 : 0,
    };
  }
  const side = Math.abs(cycle) % 2;
  const indices = MAKEUP_REGION_PATHS[mode][side];
  const sampled = sampleLandmarkPath(indices, progress, face);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).normalize();
  sampled.point.addScaledVector(normal, face.width * VOLUME_SPECS[mode].contactLift);
  const contactKey = `${mode}-${side}-${liveLandmarks ? "live" : "preview"}`;
  if (liveLandmarks) {
    if (!smoothedToolContact || smoothedContactKey !== contactKey) {
      smoothedToolContact = sampled.point.clone();
      smoothedContactKey = contactKey;
    } else {
      smoothedToolContact.lerp(sampled.point, 0.52);
    }
    sampled.point.copy(smoothedToolContact);
  }
  return { ...sampled, indices, side };
}

function officialRegionWorldPoints(region, face) {
  const indices = (region.indices ?? []).filter((index, itemIndex, values) => (
    Number.isInteger(index) && index >= 0 && index < 468 && (itemIndex === 0 || index !== values[itemIndex - 1])
  ));
  if (region.geomType === "closed" && indices.length > 2 && indices[0] === indices.at(-1)) indices.pop();
  const controlPoints = indices.map((index) => getFaceLandmarkWorld(index, face));
  if (controlPoints.length < 2) return controlPoints;
  const closed = region.geomType === "closed";
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
  const faceNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).normalize();
  regions.slice(0, makeupAreaStates.length).forEach((region, regionIndex) => {
    const state = makeupAreaStates[regionIndex];
    const pathPoints = officialRegionWorldPoints(region, face)
      .map((point) => point.addScaledVector(faceNormal, face.width * 0.009));
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
        .map((point) => resolveActionBinding(point.binding, face));
      if (pathPoints.length === 1) pathPoints.push(pathPoints[0].clone());
      const position = guide.geometry.attributes.position;
      pathPoints.slice(0, position.count).forEach((point, pointIndex) => {
        position.setXYZ(pointIndex, point.x, point.y, point.z + 0.006);
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
    regionCursor.quaternion.copy(face.quaternion);
    regionCursor.scale.setScalar(face.width * 0.034);
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
    const controlPoints = indices.map((landmarkIndex) => getFaceLandmarkWorld(landmarkIndex, face));
    const pathPoints = [];
    controlPoints.slice(0, -1).forEach((point, segmentIndex) => {
      for (let step = 0; step < 5; step += 1) {
        pathPoints.push(point.clone().lerp(controlPoints[segmentIndex + 1], step / 5));
      }
    });
    pathPoints.push(controlPoints.at(-1));
    const position = guide.geometry.attributes.position;
    pathPoints.forEach((point, pointIndex) => {
      position.setXYZ(pointIndex, point.x, point.y, point.z + 0.003);
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
  regionCursor.quaternion.copy(face.quaternion);
  regionCursor.scale.setScalar(face.width * 0.034);
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

function getToolMotion(mode, progress, mirrorSign) {
  const reference = sampleReferenceMotion(mode, progress);
  const base = {
    brow: { x: -0.2, y: 0.25, z: 0.025, roll: 0.72 },
    eyeshadow: { x: -0.19, y: 0.16, z: 0.025, roll: 0.52 },
    foundation: { x: -0.22, y: 0.03, z: 0.035, roll: 0.92 },
    contour: { x: -0.3, y: -0.04, z: 0.04, roll: 0.82 },
    powder: { x: -0.2, y: 0.01, z: 0.045, roll: 0.08 },
  }[mode];

  return {
    roll: (base.roll + reference.angle) * mirrorSign,
    scale: reference.scale,
  };
}

function update3DTool(mode, face, cycle, progress, frameIndex) {
  const toolState = makeupTools[mode];
  const tool = toolState.group;
  const volumeSpec = VOLUME_SPECS[mode];
  const mirrorSign = officialActionTrack
    ? (activeOfficialAction.side === "right" ? -1 : 1)
    : (cycle % 2 === 1 ? -1 : 1);
  const motion = getToolMotion(mode, progress, mirrorSign);
  const contact = getMakeupContact(mode, progress, cycle, face);
  toolState.frames.forEach((frame, index) => {
    frame.visible = index === frameIndex;
  });

  tool.position.copy(contact.point);
  const volumeScale = face.width * volumeSpec.scale * motion.scale;
  tool.scale.set(volumeScale * mirrorSign, volumeScale, volumeScale);
  tool.quaternion.copy(face.quaternion);
  // The applicator anchor stays on the makeup region. Pitching around that
  // anchor moves the hand and handle away from the curved face surface.
  tool.rotateY(volumeSpec.tiltY * mirrorSign);
  tool.rotateX(volumeSpec.tiltX);
  document.body.dataset.activeVolumeFrame = String(frameIndex);
  document.body.dataset.activeToolSource = "sequence-frame-extrusion";
  document.body.dataset.activeToolDepth = volumeSpec.depth.toFixed(3);
  document.body.dataset.toolSurfaceClearance = volumeSpec.contactLift.toFixed(3);
  document.body.dataset.toolTilt = `${THREE.MathUtils.radToDeg(volumeSpec.tiltX).toFixed(1)},${THREE.MathUtils.radToDeg(volumeSpec.tiltY * mirrorSign).toFixed(1)}`;
  document.body.dataset.activeMakeupRegion = `${mode}-${contact.side === 0 ? "left" : "right"}`;
  document.body.dataset.activeRegionLandmarks = contact.indices.join(",");
  document.body.dataset.activeRegionSegment = String(contact.segment);
  document.body.dataset.toolContactSource = officialActionTrack
    ? "official-action-json-478-binding"
    : "mediapipe-478-region-path";
  document.body.dataset.toolContactX = contact.point.x.toFixed(4);
  document.body.dataset.toolContactY = contact.point.y.toFixed(4);
  document.body.dataset.toolContactZ = contact.point.z.toFixed(4);
  const toolNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion);
  document.body.dataset.toolYaw = THREE.MathUtils.radToDeg(
    Math.atan2(toolNormal.x, toolNormal.z),
  ).toFixed(1);
  return contact;
}

function render(time) {
  updateTracking();

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
  const activeTool = makeupTools[activeMode];
  const uses3DTool = activeTool?.ready;
  Object.values(makeupTools).forEach(({ group }) => { group.visible = false; });
  if (uses3DTool) activeTool.group.visible = true;
  sequencePlane.visible = !uses3DTool && currentTextures.length > 0;
  const activeContact = uses3DTool
    ? update3DTool(activeMode, face, cycle, progress, frameIndex)
    : updateSequencePlane(cycle, progress, face);
  updateMakeupRegionGuide(activeMode, face, cycle, progress, activeContact);

  renderer.render(scene, camera);
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
loadMakeupTools().then(() => setOfficialAction(DEFAULT_OFFICIAL_ACTION));
requestAnimationFrame(render);
