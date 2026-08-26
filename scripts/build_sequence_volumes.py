"""Convert the extracted transparent PNG sequences into textured 3D extrusion data."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from extract_sequence_motion import extract_frame


ROOT = Path(__file__).resolve().parents[1]
SEQUENCES = ROOT / "public" / "sequences"
OUTPUT_ROOT = ROOT / "public" / "volumes"
OUTPUT_JSON = OUTPUT_ROOT / "volume-models.json"
MODES = ("brow", "eyeshadow", "foundation", "contour", "powder")


def simplify_contour(contour: np.ndarray) -> np.ndarray:
    perimeter = cv2.arcLength(contour, True)
    epsilon = perimeter * 0.0035
    simplified = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    while len(simplified) > 140:
        epsilon *= 1.3
        simplified = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    return simplified


def frame_volume(mode: str, path: Path, output_path: Path) -> dict:
    image = Image.open(path).convert("RGBA")
    rgba = np.asarray(image)
    alpha = rgba[..., 3]
    mask = (alpha > 16).astype(np.uint8) * 255
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise ValueError(f"No opaque pixels in {path}")

    padding = 3
    left = max(0, int(xs.min()) - padding)
    top = max(0, int(ys.min()) - padding)
    right = min(image.width, int(xs.max()) + padding + 1)
    bottom = min(image.height, int(ys.max()) + padding + 1)
    crop = image.crop((left, top, right, bottom))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    crop.save(output_path, optimize=True)

    crop_mask = mask[top:bottom, left:right]
    contours, _ = cv2.findContours(crop_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = [contour for contour in contours if cv2.contourArea(contour) >= 18]
    contours.sort(key=cv2.contourArea, reverse=True)

    crop_width = right - left
    crop_height = bottom - top
    normalizer = float(max(crop_width, crop_height))
    width = crop_width / normalizer
    height = crop_height / normalizer
    polygons: list[list[list[float]]] = []
    for contour in contours:
        points = simplify_contour(contour)
        polygon = [
            [
                round((float(x) - crop_width * 0.5) / normalizer, 5),
                round((crop_height * 0.5 - float(y)) / normalizer, 5),
            ]
            for x, y in points
        ]
        if len(polygon) >= 3:
            polygons.append(polygon)

    motion = extract_frame(mode, path)
    anchor = [
        round((motion["contact_x"] - left - crop_width * 0.5) / normalizer, 5),
        round((crop_height * 0.5 - (motion["contact_y"] - top)) / normalizer, 5),
    ]
    opaque_rgb = rgba[..., :3][alpha > 32]
    side_color = np.percentile(opaque_rgb, 42, axis=0).astype(np.uint8)

    return {
        "texture": f"/volumes/{mode}/{output_path.name}",
        "width": round(width, 5),
        "height": round(height, 5),
        "anchor": anchor,
        "polygons": polygons,
        "sideColor": "#" + "".join(f"{value:02x}" for value in side_color),
    }


def main() -> None:
    resolved_output = OUTPUT_ROOT.resolve()
    expected_parent = (ROOT / "public").resolve()
    if resolved_output.parent != expected_parent or resolved_output.name != "volumes":
        raise RuntimeError(f"Refusing to replace unexpected output directory: {resolved_output}")
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    OUTPUT_ROOT.mkdir(parents=True)

    payload: dict[str, list[dict]] = {}
    for mode in MODES:
        frames = sorted((SEQUENCES / mode).glob("frame_*.png"))
        payload[mode] = []
        for index, frame in enumerate(frames):
            output_path = OUTPUT_ROOT / mode / f"frame_{index:03d}.png"
            payload[mode].append(frame_volume(mode, frame, output_path))
        print(f"{mode:10s}: {len(frames):3d} extruded frame models")

    OUTPUT_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {OUTPUT_JSON}")


if __name__ == "__main__":
    main()
