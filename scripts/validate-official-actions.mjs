import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_ACTIONS } from "../src/official-actions.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const runtimeIds = new Set();
const canonicalIds = new Set();
const regionPayload = JSON.parse(fs.readFileSync(path.join(projectRoot, "public", "regions", "all.json"), "utf8"));
const regionIds = new Set((regionPayload.regions ?? []).map((region) => region.id));
let realStrokeActions = 0;
let fallbackActions = 0;
let actionRegionSlots = 0;

if (OFFICIAL_ACTIONS.length !== 61) failures.push(`expected 61 actions, found ${OFFICIAL_ACTIONS.length}`);

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
  const sourceLandmarks = actionData.faceMesh?.frames?.find((frame) => frame.landmarks?.length >= 468)?.landmarks;
  if (!sourceLandmarks) failures.push(`missing 478-point source face: ${action.runtimeId}`);
  for (const slot of actionData.regionSlots ?? []) {
    actionRegionSlots += 1;
    if (!regionIds.has(slot.regionId)) failures.push(`unknown region ${slot.regionId}: ${action.runtimeId}`);
  }
  if ((actionData.strokeSegments ?? []).some((segment) => segment.points?.length)) realStrokeActions += 1;
  else fallbackActions += 1;
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
}, null, 2));
