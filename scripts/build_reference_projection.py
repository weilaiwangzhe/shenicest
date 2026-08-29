"""Build a face-projection texture with a clean, feathered outer edge.

The center of the supplied portrait is preserved pixel-for-pixel. Only a narrow
band inside MediaPipe's face oval is extended from the nearest safe interior
pixels, preventing hair, ears, clothing, and background pixels from stretching
across the side of the 3D face when it rotates.
"""

from __future__ import annotations

import json
import hashlib
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "models" / "reference-portrait.png"
LANDMARKS = ROOT / "public" / "models" / "reference-face-478.json"
OUTPUT = ROOT / "public" / "models" / "reference-face-projection.png"
METADATA = ROOT / "public" / "models" / "reference-face-projection.meta.json"

# Clockwise MediaPipe face-oval path. These are geometry boundary vertices, not
# a hand-drawn crop, so the generated texture follows the runtime mesh exactly.
FACE_OVAL = (
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
)


def shifted(array: np.ndarray, dy: int, dx: int, fill: int | bool = 0) -> np.ndarray:
    """Shift without wraparound."""
    output = np.full_like(array, fill)
    source_y = slice(max(0, -dy), array.shape[0] - max(0, dy))
    source_x = slice(max(0, -dx), array.shape[1] - max(0, dx))
    target_y = slice(max(0, dy), array.shape[0] - max(0, -dy))
    target_x = slice(max(0, dx), array.shape[1] - max(0, -dx))
    output[target_y, target_x] = array[source_y, source_x]
    return output


NEIGHBORS = tuple(
    (dy, dx)
    for dy in (-1, 0, 1)
    for dx in (-1, 0, 1)
    if dy or dx
)


def erode_once(mask: np.ndarray) -> np.ndarray:
    result = mask.copy()
    for dy, dx in NEIGHBORS:
        result &= shifted(mask, dy, dx, False)
    return result


def dilate_once(mask: np.ndarray) -> np.ndarray:
    result = mask.copy()
    for dy, dx in NEIGHBORS:
        result |= shifted(mask, dy, dx, False)
    return result


def extend_from_core(rgb: np.ndarray, core: np.ndarray, target: np.ndarray, steps: int) -> np.ndarray:
    """Grow averaged core colors through the target mask."""
    known = core.copy()
    extended = np.zeros_like(rgb, dtype=np.float32)
    extended[known] = rgb[known]
    for _ in range(steps):
        sums = np.zeros_like(extended)
        counts = np.zeros(core.shape, dtype=np.float32)
        for dy, dx in NEIGHBORS:
            neighbor_known = shifted(known, dy, dx, False)
            neighbor_color = shifted(extended, dy, dx, 0)
            sums += neighbor_color * neighbor_known[..., None]
            counts += neighbor_known
        new_pixels = target & ~known & (counts > 0)
        if not np.any(new_pixels):
            break
        extended[new_pixels] = sums[new_pixels] / counts[new_pixels][:, None]
        known |= new_pixels
    if np.any(target & ~known):
        raise RuntimeError("Color extension did not reach the complete face gutter")
    return extended


def main() -> None:
    source_image = Image.open(SOURCE)
    source_icc = source_image.info.get("icc_profile")
    srgb_profile = ImageCms.createProfile("sRGB")
    if source_icc:
        image = ImageCms.profileToProfile(
            source_image,
            ImageCms.ImageCmsProfile(BytesIO(source_icc)),
            srgb_profile,
            outputMode="RGB",
        )
    else:
        image = source_image.convert("RGB")
    srgb_icc = ImageCms.ImageCmsProfile(srgb_profile).tobytes()
    rgb = np.asarray(image, dtype=np.uint8)
    height, width = rgb.shape[:2]
    landmarks = json.loads(LANDMARKS.read_text(encoding="utf-8"))

    oval = np.asarray([
        [round(landmarks[index]["x"] * width), round(landmarks[index]["y"] * height)]
        for index in FACE_OVAL
    ], dtype=np.int32)
    mask_image = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask_image).polygon([tuple(point) for point in oval], fill=255)
    face_mask = np.asarray(mask_image, dtype=np.uint8) > 0

    left = landmarks[234]
    right = landmarks[454]
    face_width_pixels = float(np.hypot(
        (right["x"] - left["x"]) * width,
        (right["y"] - left["y"]) * height,
    ))
    band_pixels = max(16, round(face_width_pixels * 0.06))
    gutter_pixels = 32
    feather_pixels = max(3, round(face_width_pixels * 0.005))
    core_mask = face_mask.copy()
    inside_depth = np.full(face_mask.shape, band_pixels, dtype=np.int16)
    for depth in range(band_pixels):
        eroded = erode_once(core_mask)
        inside_depth[core_mask & ~eroded] = depth
        core_mask = eroded
    if not np.any(core_mask):
        raise RuntimeError("Face core disappeared; check landmarks or edge-band width")

    gutter_mask = face_mask.copy()
    for _ in range(gutter_pixels):
        gutter_mask = dilate_once(gutter_mask)
    extended = extend_from_core(
        rgb.astype(np.float32),
        core_mask,
        gutter_mask,
        band_pixels * 3 + gutter_pixels + 8,
    )
    edge_mix = np.clip((band_pixels - inside_depth) / band_pixels, 0.0, 1.0)
    color_delta = np.sqrt(np.mean((rgb.astype(np.float32) - extended) ** 2, axis=2))
    outlier_strength = np.clip((color_delta - 6.0) / 30.0, 0.0, 1.0)
    repair_strength = 0.16 + outlier_strength * 0.80
    edge_mix *= face_mask.astype(np.float32) * repair_strength
    edge_mix = edge_mix[..., None]

    corrected = np.rint(
        rgb.astype(np.float32) * (1.0 - edge_mix)
        + extended.astype(np.float32) * edge_mix
    ).clip(0, 255).astype(np.uint8)
    output_rgb = rgb.copy()
    output_rgb[gutter_mask] = np.rint(extended[gutter_mask]).clip(0, 255).astype(np.uint8)
    output_rgb[face_mask] = corrected[face_mask]
    alpha = np.zeros(face_mask.shape, dtype=np.uint8)
    alpha[face_mask] = np.rint(
        np.clip(inside_depth[face_mask] / feather_pixels, 0.0, 1.0) * 255
    ).astype(np.uint8)
    rgba = np.dstack((output_rgb, alpha))
    Image.fromarray(rgba, "RGBA").save(OUTPUT, optimize=True, icc_profile=srgb_icc)

    changed = np.any(output_rgb != rgb, axis=2)
    core_unchanged = np.array_equal(corrected[core_mask > 0], rgb[core_mask > 0])
    metadata = {
        "output": str(OUTPUT),
        "size": [width, height],
        "faceWidthPixels": round(face_width_pixels, 2),
        "edgeBandPixels": band_pixels,
        "gutterPixels": gutter_pixels,
        "featherPixels": feather_pixels,
        "changedPixels": int(changed.sum()),
        "changedCorePixels": int(np.any(corrected != rgb, axis=2)[core_mask].sum()),
        "corePixelsUnchanged": bool(core_unchanged),
        "sourceColorProfile": "embedded ICC -> sRGB" if source_icc else "assumed sRGB",
        "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "outputSha256": hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
    }
    METADATA.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
