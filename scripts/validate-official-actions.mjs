import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindPointToFaceMesh,
  buildRegionFallbackSegments,
  correctActionPoint,
  parseCanonicalFaceObj,
  resolveBinding2D,
} from "../src/face-geometry.js";
import { OFFICIAL_ACTIONS } from "../src/official-actions.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const runtimeIds = new Set();
const canonicalIds = new Set();
const regionPayload = JSON.parse(fs.readFileSync(path.join(projectRoot, "public", "regions", "all.json"), "utf8"));
const regionIds = new Set((regionPayload.regions ?? []).map((region) => region.id));
const regionMap = new Map((regionPayload.regions ?? []).map((region) => [region.id, region]));
const canonical = parseCanonicalFaceObj(fs.readFileSync(
  path.join(projectRoot, "public", "models", "canonical-face-model.obj"),
  "utf8",
));
const referenceLandmarks = JSON.parse(fs.readFileSync(
  path.join(projectRoot, "public", "models", "reference-face-478.json"),
  "utf8",
));
const projectionPath = path.join(projectRoot, "public", "models", "reference-face-projection.png");
const projectionMetaPath = path.join(projectRoot, "public", "models", "reference-face-projection.meta.json");
if (!fs.existsSync(projectionPath) || !fs.existsSync(projectionMetaPath)) {
  failures.push("missing generated reference projection texture or metadata");
} else {
  const projection = fs.readFileSync(projectionPath);
  const projectionMeta = JSON.parse(fs.readFileSync(projectionMetaPath, "utf8"));
  const projectionHash = crypto.createHash("sha256").update(projection).digest("hex");
  if (projection.readUInt32BE(16) !== 1179 || projection.readUInt32BE(20) !== 1869) {
    failures.push("reference projection dimensions must remain 1179x1869");
  }
  if (projection[25] !== 6 || !projection.includes(Buffer.from("iCCP"))) {
    failures.push("reference projection must be an ICC-tagged RGBA PNG");
  }
  if (
    projectionMeta.outputSha256 !== projectionHash
    || projectionMeta.changedCorePixels !== 0
    || projectionMeta.corePixelsUnchanged !== true
    || projectionMeta.gutterPixels < 32
    || projectionMeta.sourceColorProfile !== "embedded ICC -> sRGB"
  ) failures.push("reference projection color/edge contract failed");
}
const expectedStrokePoints = 11209;
const maximumAllowedRoundTripError = 1e-6;
const maximumAllowedClampDistance = 130;
let realStrokeActions = 0;
let fallbackActions = 0;
let actionRegionSlots = 0;
let strokePoints = 0;
let insideStrokePoints = 0;
let outsideClampedStrokePoints = 0;
let clampedStrokePoints = 0;
let repositionStrokePoints = 0;
let maximumUnclampedRoundTripError = 0;
let maximumClampDistance = 0;
let maximumAbsoluteWeight = 0;
let sideValidatedActions = 0;
let regionIndexValues = 0;
let scalarIndexEntries = 0;
let arrayIndexEntries = 0;
let proceduralClosedRegionFallbacks = 0;
const proceduralClosedRegionIds = [];
let fallbackRegionSegments = 0;

function referenceRegionPoint(entry) {
  const indices = Array.isArray(entry) ? entry : [entry];
  const points = indices.map((index) => referenceLandmarks[index]);
  return {
    x: points.reduce((sum, point) => sum + Number(point.x), 0) / points.length,
    y: points.reduce((sum, point) => sum + Number(point.y), 0) / points.length,
  };
}

if (OFFICIAL_ACTIONS.length !== 61) failures.push(`expected 61 actions, found ${OFFICIAL_ACTIONS.length}`);
if (canonical.vertices.length !== 468) {
  failures.push(`expected 468 canonical vertices, found ${canonical.vertices.length}`);
}
if (canonical.faces.length !== 898) {
  failures.push(`expected 898 canonical triangles, found ${canonical.faces.length}`);
}

for (const region of regionPayload.regions ?? []) {
  const rawIndices = region.indices;
  if (rawIndices === undefined || rawIndices === null) {
    failures.push(`region indices must be number or number[]: ${region.id}`);
    continue;
  }
  const entries = Array.isArray(rawIndices) ? rawIndices : [rawIndices];
  if (!entries.length) failures.push(`region has no landmark indices: ${region.id}`);
  for (const entry of entries) {
    let indices;
    if (Number.isInteger(entry)) {
      indices = [entry];
      scalarIndexEntries += 1;
    } else if (Array.isArray(entry)) {
      indices = entry;
      arrayIndexEntries += 1;
    } else {
      failures.push(`region index entry must be number or number[]: ${region.id}`);
      continue;
    }
    if (!indices.length) failures.push(`region has an empty landmark index group: ${region.id}`);
    for (const index of indices) {
      regionIndexValues += 1;
      if (!Number.isInteger(index) || index < 0 || index > 477) {
        failures.push(`invalid region landmark index ${JSON.stringify(index)} in ${region.id}`);
      }
    }
  }
  if (region.geomType === "closed") {
    const deduplicated = entries.filter((entry, index, values) => (
      index === 0 || JSON.stringify(entry) !== JSON.stringify(values[index - 1])
    ));
    if (
      deduplicated.length > 2
      && JSON.stringify(deduplicated[0]) === JSON.stringify(deduplicated.at(-1))
    ) deduplicated.pop();
    const points = deduplicated.map(referenceRegionPoint);
    const doubleArea = points.length >= 3 ? points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) : 0;
    if (new Set(deduplicated.map((entry) => JSON.stringify(entry))).size < 3 || Math.abs(doubleArea) < 1e-8) {
      proceduralClosedRegionFallbacks += 1;
      proceduralClosedRegionIds.push(region.id);
    }
  }
}

const expectedProceduralClosedRegions = [
  "custom-1786034386720",
  "highlight-cheek-left",
  "highlight-lip",
  "highlight-nose-tip",
];
if (proceduralClosedRegionIds.slice().sort().join("|") !== expectedProceduralClosedRegions.slice().sort().join("|")) {
  failures.push(`unexpected procedural closed regions: ${proceduralClosedRegionIds.join(",")}`);
}

for (const action of OFFICIAL_ACTIONS) {
  if (runtimeIds.has(action.runtimeId)) failures.push(`duplicate runtime id: ${action.runtimeId}`);
  if (canonicalIds.has(action.canonicalId)) failures.push(`duplicate canonical id: ${action.canonicalId}`);
  runtimeIds.add(action.runtimeId);
  canonicalIds.add(action.canonicalId);

  const actionPath = path.join(projectRoot, "public", "actions", action.runtimeId);
  if (!fs.existsSync(actionPath)) {
    failures.push(`missing action JSON: ${action.runtimeId}`);
    continue;
  }
  const actionData = JSON.parse(fs.readFileSync(actionPath, "utf8"));
  const sourceLandmarks = actionData.faceMesh?.frames?.find((frame) => frame.landmarks?.length === 478)?.landmarks;
  if (!sourceLandmarks) failures.push(`missing 478-point source face: ${action.runtimeId}`);
  for (const slot of actionData.regionSlots ?? []) {
    actionRegionSlots += 1;
    if (!regionIds.has(slot.regionId)) failures.push(`unknown region ${slot.regionId}: ${action.runtimeId}`);
  }
  const rawPoints = (actionData.strokeSegments ?? []).flatMap((segment) => segment.points ?? []);
  if (rawPoints.length) realStrokeActions += 1;
  else {
    fallbackActions += 1;
    const fallbackRegions = (actionData.regionSlots ?? [])
      .map((slot) => regionMap.get(slot.regionId))
      .filter(Boolean);
    const fallbackSegments = buildRegionFallbackSegments(fallbackRegions, 120);
    fallbackRegionSegments += fallbackSegments.length;
    if (fallbackSegments.length !== fallbackRegions.length) {
      failures.push(`fallback must keep one segment per region: ${action.runtimeId}`);
    }
  }
  if (!sourceLandmarks) continue;

  const correctedPoints = [];
  for (const segment of actionData.strokeSegments ?? []) {
    let previousBinding = null;
    const orderedPoints = (segment.points ?? []).slice().sort((a, b) => Number(a.frame) - Number(b.frame));
    for (const rawPoint of orderedPoints) {
      try {
        const point = correctActionPoint(action, rawPoint, sourceLandmarks);
        correctedPoints.push(point);
        const binding = bindPointToFaceMesh(point, sourceLandmarks, canonical.faces, {
          preferredBinding: previousBinding,
          targetVertices: canonical.vertices,
        });
        previousBinding = binding;
      const resolved = resolveBinding2D(binding, sourceLandmarks);
      const error = Math.hypot(resolved.x - Number(point.x), resolved.y - Number(point.y));
      if (binding.outside) outsideClampedStrokePoints += 1;
      else insideStrokePoints += 1;
      if (binding.clamped) {
        clampedStrokePoints += 1;
        if (!binding.reposition) {
          failures.push(`clamped binding must be marked for reposition: ${action.runtimeId} frame ${rawPoint.frame}`);
        }
        maximumClampDistance = Math.max(maximumClampDistance, binding.clampDistance);
        if (Math.abs(error - binding.clampDistance) > maximumAllowedRoundTripError) {
          failures.push(`outside clamp distance mismatch: ${action.runtimeId} frame ${rawPoint.frame}`);
        }
      } else {
        maximumUnclampedRoundTripError = Math.max(maximumUnclampedRoundTripError, error);
      }
      if (binding.reposition) repositionStrokePoints += 1;
      maximumAbsoluteWeight = Math.max(
        maximumAbsoluteWeight,
        ...binding.map(({ weight }) => Math.abs(weight)),
      );
      if (binding.some(({ index, weight }) => (
        !Number.isInteger(index) || index < 0 || index >= 468 || !Number.isFinite(weight)
        || weight < -1e-10 || weight > 1 + 1e-10
      ))) {
        failures.push(`invalid triangle binding: ${action.runtimeId} frame ${rawPoint.frame}`);
      }
      const weightSum = binding.reduce((sum, { weight }) => sum + weight, 0);
      if (Math.abs(weightSum - 1) > 1e-10) {
        failures.push(`binding weights do not sum to 1: ${action.runtimeId} frame ${rawPoint.frame}`);
      }
      if (!Number.isFinite(error)) {
        failures.push(`non-finite round-trip error: ${action.runtimeId} frame ${rawPoint.frame}`);
      }
        strokePoints += 1;
      } catch (error) {
        failures.push(`cannot bind stroke point: ${action.runtimeId} frame ${rawPoint.frame}: ${error.message}`);
      }
    }
  }

  if (action.side && correctedPoints.length) {
    const landmarkX = (landmark) => Number(Array.isArray(landmark) ? landmark[0] : landmark.x);
    const centerX = (landmarkX(sourceLandmarks[234]) + landmarkX(sourceLandmarks[454])) * 0.5;
    const meanX = correctedPoints.reduce((sum, point) => sum + Number(point.x), 0) / correctedPoints.length;
    const actualSide = meanX < centerX ? "left" : meanX > centerX ? "right" : "center";
    if (actualSide !== action.side) {
      failures.push(`${action.canonicalId} is on the ${actualSide} source-face half, expected ${action.side}`);
    }
    sideValidatedActions += 1;
  }
}

if (strokePoints !== expectedStrokePoints) {
  failures.push(`expected ${expectedStrokePoints} bound stroke points, found ${strokePoints}`);
}
if (insideStrokePoints !== 11000 || outsideClampedStrokePoints !== 209) {
  failures.push(`unexpected inside/outside stroke split: ${insideStrokePoints}/${outsideClampedStrokePoints}`);
}
if (clampedStrokePoints !== 297 || repositionStrokePoints !== clampedStrokePoints) {
  failures.push(`unexpected clamped/reposition split: ${clampedStrokePoints}/${repositionStrokePoints}`);
}
if (maximumUnclampedRoundTripError > maximumAllowedRoundTripError) {
  failures.push(`maximum unclamped round-trip error ${maximumUnclampedRoundTripError} exceeds ${maximumAllowedRoundTripError}`);
}
if (maximumClampDistance > maximumAllowedClampDistance) {
  failures.push(`maximum clamp distance ${maximumClampDistance} exceeds ${maximumAllowedClampDistance}`);
}
if (maximumAbsoluteWeight > 1 + 1e-10) {
  failures.push(`maximum clamped binding weight ${maximumAbsoluteWeight} exceeds 1`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  actions: OFFICIAL_ACTIONS.length,
  realStrokeActions,
  semanticFallbackActions: fallbackActions,
  officialRegions: regionIds.size,
  actionRegionSlots,
  allHaveSourceFace: true,
  strokePoints,
  insideStrokePoints,
  outsideClampedStrokePoints,
  clampedStrokePoints,
  repositionStrokePoints,
  maximumUnclampedRoundTripError,
  maximumClampDistance,
  maximumAbsoluteWeight,
  sideValidatedActions,
  regionIndexValues,
  regionIndexForms: {
    number: scalarIndexEntries,
    numberArray: arrayIndexEntries,
  },
  proceduralClosedRegionFallbacks,
  proceduralClosedRegionIds,
  fallbackRegionSegments,
}, null, 2));
