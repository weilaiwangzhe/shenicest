const EPSILON = 1e-10;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

export function landmarkCoordinates(landmark) {
  if (Array.isArray(landmark)) {
    return {
      x: finiteNumber(landmark[0], "landmark x"),
      y: finiteNumber(landmark[1], "landmark y"),
      z: Number.isFinite(Number(landmark[2])) ? Number(landmark[2]) : 0,
    };
  }
  return {
    x: finiteNumber(landmark?.x, "landmark x"),
    y: finiteNumber(landmark?.y, "landmark y"),
    z: Number.isFinite(Number(landmark?.z)) ? Number(landmark.z) : 0,
  };
}

export function imageLandmarkUv(landmark) {
  const point = landmarkCoordinates(landmark);
  return [
    Math.max(0, Math.min(1, point.x)),
    1 - Math.max(0, Math.min(1, point.y)),
  ];
}

function objIndex(value, itemCount) {
  const index = Number.parseInt(value, 10);
  if (!Number.isInteger(index) || index === 0) throw new Error(`Invalid OBJ index: ${value}`);
  return index > 0 ? index - 1 : itemCount + index;
}

export function parseCanonicalFaceObj(text) {
  const vertices = [];
  const uvs = [];
  const faces = [];

  String(text).split(/\r?\n/).forEach((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "v") vertices.push(parts.slice(1, 4).map(Number));
    if (parts[0] === "vt") uvs.push(parts.slice(1, 3).map(Number));
    if (parts[0] !== "f") return;

    const polygon = parts.slice(1).map((entry) => {
      const [vertexIndex, uvIndex] = entry.split("/");
      return {
        vertexIndex: objIndex(vertexIndex, vertices.length),
        uvIndex: uvIndex ? objIndex(uvIndex, uvs.length) : -1,
      };
    });
    for (let index = 1; index + 1 < polygon.length; index += 1) {
      faces.push([polygon[0], polygon[index], polygon[index + 1]]);
    }
  });

  return { vertices, uvs, faces };
}

export function faceVertexIndices(face) {
  return face.map((entry) => Number.isInteger(entry) ? entry : entry.vertexIndex);
}

export function barycentric2D(point, a, b, c) {
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= EPSILON) return null;
  const weightA = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denominator;
  const weightB = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denominator;
  return [weightA, weightB, 1 - weightA - weightB];
}

function closestPointOnSegment(point, start, end, startWeights, endWeights) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const mix = lengthSquared <= EPSILON ? 0 : Math.max(0, Math.min(1, (
    (point.x - start.x) * dx + (point.y - start.y) * dy
  ) / lengthSquared));
  const closestX = start.x + dx * mix;
  const closestY = start.y + dy * mix;
  return {
    distanceSquared: (point.x - closestX) ** 2 + (point.y - closestY) ** 2,
    weights: startWeights.map((weight, index) => (
      weight + (endWeights[index] - weight) * mix
    )),
  };
}

function closestPointOnTriangle(point, a, b, c, rawWeights) {
  if (rawWeights.every((weight) => weight >= -EPSILON)) {
    return { distanceSquared: 0, weights: rawWeights, outside: false };
  }
  const candidates = [
    closestPointOnSegment(point, a, b, [1, 0, 0], [0, 1, 0]),
    closestPointOnSegment(point, b, c, [0, 1, 0], [0, 0, 1]),
    closestPointOnSegment(point, c, a, [0, 0, 1], [1, 0, 0]),
  ];
  candidates.sort((left, right) => left.distanceSquared - right.distanceSquared);
  return { ...candidates[0], outside: true };
}

export function bindPointToFaceMesh(point, sourceLandmarks, faces, options = {}) {
  const sourcePoint = landmarkCoordinates(point);
  const preferredIndices = options.preferredIndices ?? options.preferredBinding?.map(({ index }) => index);
  const preferredSet = preferredIndices ? new Set(preferredIndices) : null;
  const targetVertices = options.targetVertices;
  const preferredTargetPoint = options.preferredTargetPoint ?? options.preferredBinding?.targetPoint;
  const sourceLeft = sourceLandmarks[234] ? landmarkCoordinates(sourceLandmarks[234]) : null;
  const sourceRight = sourceLandmarks[454] ? landmarkCoordinates(sourceLandmarks[454]) : null;
  const sourceFaceWidth = sourceLeft && sourceRight
    ? Math.hypot(sourceRight.x - sourceLeft.x, sourceRight.y - sourceLeft.y)
    : 1;
  const targetFaceWidth = targetVertices?.[234] && targetVertices?.[454]
    ? Math.hypot(
      targetVertices[454][0] - targetVertices[234][0],
      targetVertices[454][1] - targetVertices[234][1],
      targetVertices[454][2] - targetVertices[234][2],
    )
    : 1;
  const candidates = [];
  let hasInsideCandidate = false;

  for (const face of faces) {
    const indices = faceVertexIndices(face);
    if (indices.length !== 3 || indices.some((index) => !sourceLandmarks[index])) continue;
    const vertices = indices.map((index) => landmarkCoordinates(sourceLandmarks[index]));
    const weights = barycentric2D(sourcePoint, vertices[0], vertices[1], vertices[2]);
    if (!weights) continue;
    const closest = closestPointOnTriangle(
      sourcePoint,
      vertices[0],
      vertices[1],
      vertices[2],
      weights,
    );
    hasInsideCandidate ||= !closest.outside;
    const targetPoint = targetVertices
      ? indices.reduce((result, index, itemIndex) => {
        result[0] += targetVertices[index][0] * closest.weights[itemIndex];
        result[1] += targetVertices[index][1] * closest.weights[itemIndex];
        result[2] += targetVertices[index][2] * closest.weights[itemIndex];
        return result;
      }, [0, 0, 0])
      : null;
    const sharedVertices = preferredSet
      ? indices.reduce((count, index) => count + Number(preferredSet.has(index)), 0)
      : 0;
    const continuityPenalty = preferredSet ? 3 - sharedVertices : 0;
    const interiorMargin = Math.min(...closest.weights);
    const targetCost = preferredTargetPoint && targetPoint
      ? Math.hypot(
        targetPoint[0] - preferredTargetPoint[0],
        targetPoint[1] - preferredTargetPoint[1],
        targetPoint[2] - preferredTargetPoint[2],
      ) / Math.max(targetFaceWidth, EPSILON)
      : 0;
    const targetDepth = targetPoint?.[2] ?? 0;
    candidates.push({
      indices,
      rawWeights: weights,
      continuityPenalty,
      interiorMargin,
      targetPoint,
      targetDepth,
      targetCost,
      ...closest,
    });
  }

  if (!candidates.length) throw new Error("Cannot bind point: face topology has no usable triangle");
  let pool = candidates.filter((candidate) => !candidate.outside);
  if (!pool.length) {
    const nearestDistance = Math.min(...candidates.map((candidate) => candidate.distanceSquared));
    pool = candidates.filter((candidate) => (
      Math.abs(candidate.distanceSquared - nearestDistance) <= EPSILON
    ));
  }
  pool.sort((left, right) => {
    if (preferredTargetPoint && Math.abs(left.targetCost - right.targetCost) > EPSILON) {
      return left.targetCost - right.targetCost;
    }
    if (left.continuityPenalty !== right.continuityPenalty) {
      return left.continuityPenalty - right.continuityPenalty;
    }
    if (!preferredTargetPoint && Math.abs(left.targetDepth - right.targetDepth) > EPSILON) {
      return right.targetDepth - left.targetDepth;
    }
    return right.interiorMargin - left.interiorMargin;
  });
  let best = pool[0];
  let reposition = !hasInsideCandidate;
  if (hasInsideCandidate && preferredTargetPoint && best.targetCost > 0.025) {
    const continuityCandidates = candidates
      .filter((candidate) => (
        candidate.outside
        && candidate.continuityPenalty < 3
        && Math.sqrt(candidate.distanceSquared) <= sourceFaceWidth * 0.012
      ))
      .sort((left, right) => left.targetCost - right.targetCost);
    const continuous = continuityCandidates[0];
    if (continuous && continuous.targetCost < best.targetCost * 0.6) {
      best = continuous;
      reposition = true;
    }
  }
  const binding = best.indices.map((index, itemIndex) => ({ index, weight: best.weights[itemIndex] }));
  Object.defineProperties(binding, {
    outside: { value: !hasInsideCandidate, enumerable: false },
    clamped: { value: best.distanceSquared > EPSILON, enumerable: false },
    reposition: { value: reposition, enumerable: false },
    clampDistance: { value: Math.sqrt(best.distanceSquared), enumerable: false },
    rawWeights: { value: best.rawWeights, enumerable: false },
    faceIndices: { value: best.indices, enumerable: false },
    targetPoint: { value: best.targetPoint, enumerable: false },
  });
  return binding;
}

export function resolveBinding2D(binding, landmarks) {
  return binding.reduce((point, { index, weight }) => {
    const landmark = landmarkCoordinates(landmarks[index]);
    point.x += landmark.x * weight;
    point.y += landmark.y * weight;
    return point;
  }, { x: 0, y: 0 });
}

export function buildMirrorIndexMap(canonicalVertices) {
  return canonicalVertices.map(([x, y, z]) => {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    canonicalVertices.forEach((candidate, index) => {
      const dx = candidate[0] + x;
      const dy = candidate[1] - y;
      const dz = candidate[2] - z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared < nearestDistance) {
        nearestDistance = distanceSquared;
        nearestIndex = index;
      }
    });
    return nearestIndex;
  });
}

export function buildRegionFallbackSegments(regions, totalFrames = 120) {
  const duration = finiteNumber(totalFrames, "total frames");
  if (duration <= 0) throw new RangeError("total frames must be positive");
  const bindingGroups = (regions ?? []).map((region) => {
    const bindings = (region.indices ?? []).map((entry) => {
      const indices = (Array.isArray(entry) ? entry : [entry]).filter((index) => (
        Number.isInteger(index) && index >= 0 && index < 478
      ));
      return indices.map((index) => ({ index, weight: 1 / indices.length }));
    }).filter((binding) => binding.length);
    if (
      region.geomType === "closed"
      && bindings.length >= 2
      && JSON.stringify(bindings[0]) !== JSON.stringify(bindings.at(-1))
    ) bindings.push(bindings[0].map((item) => ({ ...item })));
    return { bindings, closed: region.geomType === "closed" };
  }).filter(({ bindings }) => bindings.length >= 2);

  return bindingGroups.map(({ bindings }, segmentIndex) => {
    const startFrame = segmentIndex / bindingGroups.length * duration;
    const endFrame = (segmentIndex + 1) / bindingGroups.length * duration;
    return {
      startFrame,
      endFrame,
      points: bindings.map((binding, pointIndex) => ({
        frame: startFrame + (endFrame - startFrame) * pointIndex / Math.max(1, bindings.length - 1),
        binding,
        reposition: bindingGroups.length > 1 && (pointIndex === 0 || pointIndex === bindings.length - 1)
          ? 1
          : 0,
      })),
    };
  });
}

export function referenceFaceVertices(landmarks, imageAspect, vertexCount = landmarks.length) {
  if (!landmarks?.[234] || !landmarks?.[454]) throw new Error("Reference face requires landmarks 234 and 454");
  const aspect = finiteNumber(imageAspect, "image aspect");
  if (aspect <= 0) throw new RangeError("image aspect must be positive");
  const left = landmarkCoordinates(landmarks[234]);
  const right = landmarkCoordinates(landmarks[454]);
  const centerX = (left.x + right.x) * 0.5;
  const centerY = (
    landmarkCoordinates(landmarks[10]).y + landmarkCoordinates(landmarks[152]).y
  ) * 0.5;
  const cheekDepth = (left.z + right.z) * 0.5;
  const faceWidth = Math.hypot(right.x - left.x, (right.y - left.y) * aspect);
  if (faceWidth <= EPSILON) throw new Error("Reference face width is zero");

  return landmarks.slice(0, vertexCount).map((landmark) => {
    const source = landmarkCoordinates(landmark);
    return [
      (source.x - centerX) / faceWidth,
      (centerY - source.y) * aspect / faceWidth,
      (cheekDepth - source.z) / faceWidth,
    ];
  });
}

export function computeCoverTransform(sourceWidth, sourceHeight, viewportWidth, viewportHeight) {
  const sourceW = finiteNumber(sourceWidth, "source width");
  const sourceH = finiteNumber(sourceHeight, "source height");
  const viewportW = finiteNumber(viewportWidth, "viewport width");
  const viewportH = finiteNumber(viewportHeight, "viewport height");
  if (Math.min(sourceW, sourceH, viewportW, viewportH) <= 0) return null;
  const scale = Math.max(viewportW / sourceW, viewportH / sourceH);
  const renderedWidth = sourceW * scale;
  const renderedHeight = sourceH * scale;
  return {
    viewportWidth: viewportW,
    viewportHeight: viewportH,
    renderedWidth,
    renderedHeight,
    offsetX: (viewportW - renderedWidth) * 0.5,
    offsetY: (viewportH - renderedHeight) * 0.5,
    aspect: viewportW / viewportH,
    worldUnitsPerNormalizedX: renderedWidth * 2 / viewportH,
  };
}

export function landmarkToOrthographicWorld(landmark, transform, options = {}) {
  if (!transform) return { x: 0, y: 0, z: options.depthOrigin ?? 0 };
  const source = landmarkCoordinates(landmark);
  const mirrorX = options.mirrorX ?? true;
  const includeDepth = options.includeDepth ?? true;
  const depthOrigin = options.depthOrigin ?? 0.1;
  const normalizedX = mirrorX ? 1 - source.x : source.x;
  const pixelX = transform.offsetX + normalizedX * transform.renderedWidth;
  const pixelY = transform.offsetY + source.y * transform.renderedHeight;
  return {
    x: (pixelX / transform.viewportWidth * 2 - 1) * transform.aspect,
    y: 1 - pixelY / transform.viewportHeight * 2,
    z: includeDepth
      ? depthOrigin - source.z * transform.worldUnitsPerNormalizedX
      : depthOrigin,
  };
}

const ACTION_POINT_CORRECTIONS = new Map([
  ["eyeshadow_lower_eyelid_left", "mirror-x"],
]);

export function correctActionPoint(action, point, sourceLandmarks) {
  if (ACTION_POINT_CORRECTIONS.get(action?.canonicalId) !== "mirror-x") return point;
  const left = landmarkCoordinates(sourceLandmarks[234]);
  const right = landmarkCoordinates(sourceLandmarks[454]);
  const centerX = (left.x + right.x) * 0.5;
  return { ...point, x: centerX * 2 - finiteNumber(point.x, "action point x") };
}
