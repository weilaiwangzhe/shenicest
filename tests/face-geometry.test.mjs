import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  barycentric2D,
  bindPointToFaceMesh,
  buildMirrorIndexMap,
  buildRegionFallbackSegments,
  computeCoverTransform,
  correctActionPoint,
  imageLandmarkUv,
  landmarkToOrthographicWorld,
  parseCanonicalFaceObj,
  referenceFaceVertices,
  resolveBinding2D,
} from "../src/face-geometry.js";
import { OFFICIAL_ACTIONS } from "../src/official-actions.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonical = parseCanonicalFaceObj(fs.readFileSync(
  path.join(projectRoot, "public", "models", "canonical-face-model.obj"),
  "utf8",
));

test("barycentric coordinates reconstruct points inside and outside a triangle", () => {
  const triangle = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 2 }];
  for (const point of [{ x: 1, y: 0.5 }, { x: 5, y: -1 }]) {
    const weights = barycentric2D(point, ...triangle);
    assert.ok(weights);
    assert.ok(Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    const reconstructed = weights.reduce((result, weight, index) => ({
      x: result.x + triangle[index].x * weight,
      y: result.y + triangle[index].y * weight,
    }), { x: 0, y: 0 });
    assert.ok(Math.hypot(reconstructed.x - point.x, reconstructed.y - point.y) < 1e-12);
  }
});

test("official strokes bind inside the face or clamp safely to its boundary", () => {
  let pointCount = 0;
  let insidePointCount = 0;
  let outsidePointCount = 0;
  let clampedPointCount = 0;
  let maximumInsideError = 0;
  let maximumClampDistance = 0;
  let maximumAbsoluteWeight = 0;

  for (const action of OFFICIAL_ACTIONS) {
    const payload = JSON.parse(fs.readFileSync(path.join(projectRoot, "public", "actions", action.runtimeId), "utf8"));
    const sourceLandmarks = payload.faceMesh?.frames?.find((frame) => frame.landmarks?.length === 478)?.landmarks;
    assert.ok(sourceLandmarks, `missing source face: ${action.runtimeId}`);
    const sourceFaceWidth = Math.hypot(
      Number(sourceLandmarks[454][0]) - Number(sourceLandmarks[234][0]),
      Number(sourceLandmarks[454][1]) - Number(sourceLandmarks[234][1]),
    );
    for (const segment of payload.strokeSegments ?? []) {
      let previousBinding = null;
      const orderedPoints = (segment.points ?? []).slice().sort((a, b) => Number(a.frame) - Number(b.frame));
      for (const rawPoint of orderedPoints) {
        const point = correctActionPoint(action, rawPoint, sourceLandmarks);
        const binding = bindPointToFaceMesh(point, sourceLandmarks, canonical.faces, {
          preferredBinding: previousBinding,
          targetVertices: canonical.vertices,
        });
        previousBinding = binding;
        const resolved = resolveBinding2D(binding, sourceLandmarks);
        const error = Math.hypot(resolved.x - point.x, resolved.y - point.y);
        if (binding.outside) outsidePointCount += 1;
        else insidePointCount += 1;
        if (binding.clamped) {
          clampedPointCount += 1;
          assert.equal(binding.reposition, true);
          maximumClampDistance = Math.max(maximumClampDistance, binding.clampDistance);
          assert.ok(Math.abs(error - binding.clampDistance) < 1e-6);
          assert.ok(binding.outside || binding.clampDistance <= sourceFaceWidth * 0.012 + 1e-6);
        } else {
          maximumInsideError = Math.max(maximumInsideError, error);
        }
        maximumAbsoluteWeight = Math.max(
          maximumAbsoluteWeight,
          ...binding.map(({ weight }) => Math.abs(weight)),
        );
        assert.ok(binding.every(({ index, weight }) => (
          Number.isInteger(index) && index >= 0 && index < 468
          && Number.isFinite(weight) && weight >= -1e-10 && weight <= 1 + 1e-10
        )));
        assert.ok(Math.abs(binding.reduce((sum, { weight }) => sum + weight, 0) - 1) < 1e-10);
        pointCount += 1;
      }
    }
  }

  assert.equal(pointCount, 11209);
  assert.equal(insidePointCount, 11000);
  assert.equal(outsidePointCount, 209);
  assert.equal(clampedPointCount, 297);
  assert.ok(maximumInsideError <= 1e-6, `maximum inside round-trip error: ${maximumInsideError}`);
  assert.ok(maximumClampDistance > 0 && maximumClampDistance < 130);
  assert.ok(maximumAbsoluteWeight <= 1 + 1e-10, `invalid clamped weight: ${maximumAbsoluteWeight}`);
});

test("canonical mirror map is complete and involutive", () => {
  const mirrorMap = buildMirrorIndexMap(canonical.vertices);
  assert.equal(mirrorMap.length, 468);
  mirrorMap.forEach((mirroredIndex, index) => {
    assert.ok(Number.isInteger(mirroredIndex) && mirroredIndex >= 0 && mirroredIndex < 468);
    assert.equal(mirrorMap[mirroredIndex], index);
  });
});

test("reference geometry preserves pixel aspect and MediaPipe depth scale", () => {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  landmarks[234] = { x: 0.25, y: 0.5, z: 0.2 };
  landmarks[454] = { x: 0.75, y: 0.5, z: 0.2 };
  landmarks[10] = { x: 0.5, y: 0.25, z: 0 };
  landmarks[152] = { x: 0.5, y: 0.75, z: 0 };
  landmarks[1] = { x: 0.5, y: 0.5, z: -0.1 };
  const vertices = referenceFaceVertices(landmarks, 1.5);
  assert.deepEqual(vertices[234], [-0.5, 0, 0]);
  assert.deepEqual(vertices[454], [0.5, 0, 0]);
  assert.equal(vertices[10][1], 0.75);
  assert.equal(vertices[152][1], -0.75);
  assert.ok(Math.abs(vertices[1][2] - 0.6) < 1e-12);
  assert.equal(vertices.length, 478);
});

test("cover projection mirrors x, flips image y, and scales z once", () => {
  const transform = computeCoverTransform(1280, 720, 1000, 1000);
  assert.ok(transform);
  assert.equal(transform.renderedWidth, 1777.7777777777778);
  assert.equal(transform.renderedHeight, 1000);
  const world = landmarkToOrthographicWorld(
    { x: 0.25, y: 0.25, z: -0.1 },
    transform,
    { mirrorX: true, depthOrigin: 0.1 },
  );
  assert.ok(world.x > 0);
  assert.ok(world.y > 0);
  assert.ok(Math.abs(world.z - (0.1 + 0.1 * transform.worldUnitsPerNormalizedX)) < 1e-12);
});

test("reference-photo UVs sample the original portrait without an extra flip", () => {
  assert.deepEqual(imageLandmarkUv({ x: 0, y: 0 }), [0, 1]);
  assert.deepEqual(imageLandmarkUv({ x: 1, y: 1 }), [1, 0]);
  assert.deepEqual(imageLandmarkUv([0.25, 0.75]), [0.25, 0.25]);
});

test("declared left and right strokes stay on their matching source half", () => {
  for (const action of OFFICIAL_ACTIONS.filter(({ side }) => side)) {
    const payload = JSON.parse(fs.readFileSync(path.join(projectRoot, "public", "actions", action.runtimeId), "utf8"));
    const sourceLandmarks = payload.faceMesh?.frames?.find((frame) => frame.landmarks?.length === 478)?.landmarks;
    const points = (payload.strokeSegments ?? []).flatMap((segment) => segment.points ?? [])
      .map((point) => correctActionPoint(action, point, sourceLandmarks));
    if (!points.length) continue;
    const centerX = (Number(sourceLandmarks[234][0]) + Number(sourceLandmarks[454][0])) * 0.5;
    const meanX = points.reduce((sum, point) => sum + Number(point.x), 0) / points.length;
    assert.equal(
      meanX < centerX ? "left" : "right",
      action.side,
      `${action.canonicalId} is on the wrong source-face half`,
    );
  }
});

test("actions without strokes keep each official region in a separate segment", () => {
  const regionPayload = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "public", "regions", "all.json"),
    "utf8",
  ));
  const regionMap = new Map(regionPayload.regions.map((region) => [region.id, region]));
  const cases = [
    ["修容上庭长.json", 3],
    ["嘴唇1.json", 2],
  ];

  for (const [runtimeId, expectedSegments] of cases) {
    const payload = JSON.parse(fs.readFileSync(
      path.join(projectRoot, "public", "actions", runtimeId),
      "utf8",
    ));
    assert.equal((payload.strokeSegments ?? []).flatMap((segment) => segment.points ?? []).length, 0);
    const regions = payload.regionSlots.map((slot) => regionMap.get(slot.regionId));
    const segments = buildRegionFallbackSegments(regions, 120);
    assert.equal(segments.length, expectedSegments, runtimeId);
    segments.forEach((segment, index) => {
      assert.ok(segment.points.length >= 2);
      assert.equal(segment.startFrame, index / expectedSegments * 120);
      assert.equal(segment.endFrame, (index + 1) / expectedSegments * 120);
      const allowedIndices = new Set((regions[index].indices ?? []).flatMap((entry) => (
        Array.isArray(entry) ? entry : [entry]
      )));
      assert.ok(segment.points.every((point) => (
        point.binding.every(({ index: landmarkIndex }) => allowedIndices.has(landmarkIndex))
      )));
    });
  }
});
