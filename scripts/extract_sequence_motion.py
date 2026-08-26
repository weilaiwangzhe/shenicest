"""Extract 2D tool motion from the transparent PNG reference sequences."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SEQUENCES = ROOT / "public" / "sequences"
OUTPUT = SEQUENCES / "motion.json"
MODES = ("brow", "eyeshadow", "foundation", "contour", "powder")


def principal_angle(mask: np.ndarray) -> float:
    ys, xs = np.nonzero(mask)
    if len(xs) < 8:
        return 0.0
    points = np.column_stack((xs - xs.mean(), ys - ys.mean()))
    covariance = np.cov(points, rowvar=False)
    _, vectors = np.linalg.eigh(covariance)
    vector = vectors[:, -1]
    return float(math.atan2(vector[1], vector[0]))


def unwrap_angles(values: list[float]) -> np.ndarray:
    if not values:
        return np.zeros(0)
    doubled = np.unwrap(np.asarray(values) * 2.0)
    return doubled * 0.5


def extract_frame(mode: str, path: Path) -> dict[str, float]:
    rgba = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32)
    rgb = rgba[..., :3]
    alpha = rgba[..., 3] > 16
    ys, xs = np.nonzero(alpha)
    min_x, max_x = int(xs.min()), int(xs.max())
    min_y, max_y = int(ys.min()), int(ys.max())

    channel_spread = rgb.max(axis=2) - rgb.min(axis=2)
    brightness = rgb.mean(axis=2)
    dark = alpha & (brightness < 92)
    neutral = alpha & (channel_spread < 34) & (brightness > 72)

    if mode in ("brow", "eyeshadow"):
        tip_band = alpha & (np.indices(alpha.shape)[0] <= min_y + 14)
        tip_y, tip_x = np.nonzero(tip_band)
        contact_x = float(np.median(tip_x))
        contact_y = float(np.median(tip_y))
        tool_mask = dark
    elif mode == "foundation":
        tool_mask = neutral
        tool_y, tool_x = np.nonzero(tool_mask)
        edge = tool_x <= np.percentile(tool_x, 4)
        contact_x = float(np.median(tool_x[edge]))
        contact_y = float(np.median(tool_y[edge]))
    elif mode == "contour":
        tool_mask = neutral | dark
        tool_y, tool_x = np.nonzero(tool_mask)
        upper = tool_y < min_y + (max_y - min_y) * 0.42
        upper_x = tool_x[upper]
        upper_y = tool_y[upper]
        edge = upper_x <= np.percentile(upper_x, 7)
        contact_x = float(np.median(upper_x[edge]))
        contact_y = float(np.median(upper_y[edge]))
    else:
        tool_mask = neutral & (np.indices(alpha.shape)[0] < min_y + (max_y - min_y) * 0.58)
        tool_y, tool_x = np.nonzero(tool_mask)
        contact_x = float(np.mean(tool_x))
        contact_y = float(np.mean(tool_y))

    return {
        "contact_x": contact_x,
        "contact_y": contact_y,
        "angle": 0.0 if mode == "powder" else principal_angle(tool_mask),
        "width": float(max_x - min_x + 1),
        "height": float(max_y - min_y + 1),
    }


def extract_mode(mode: str) -> list[dict[str, float]]:
    frames = sorted((SEQUENCES / mode).glob("frame_*.png"))
    raw = [extract_frame(mode, frame) for frame in frames]
    angles = unwrap_angles([frame["angle"] for frame in raw])

    contact_x = np.asarray([frame["contact_x"] for frame in raw])
    contact_y = np.asarray([frame["contact_y"] for frame in raw])
    diagonal = np.asarray([
        math.hypot(frame["width"], frame["height"])
        for frame in raw
    ])
    center_x = float(np.mean(contact_x))
    center_y = float(np.mean(contact_y))
    center_angle = float(np.mean(angles))
    center_diagonal = float(np.mean(diagonal))

    return [
        {
            "x": round(float((contact_x[index] - center_x) / 640.0), 5),
            "y": round(float(-(contact_y[index] - center_y) / 480.0), 5),
            "angle": round(float(angles[index] - center_angle), 5),
            "scale": round(float(diagonal[index] / center_diagonal), 5),
        }
        for index in range(len(raw))
    ]


def main() -> None:
    motion = {mode: extract_mode(mode) for mode in MODES}
    OUTPUT.write_text(json.dumps(motion, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for mode, frames in motion.items():
        x_values = [frame["x"] for frame in frames]
        y_values = [frame["y"] for frame in frames]
        angle_values = [math.degrees(frame["angle"]) for frame in frames]
        print(
            f"{mode:10s} frames={len(frames):2d} "
            f"dx={min(x_values):+.3f}..{max(x_values):+.3f} "
            f"dy={min(y_values):+.3f}..{max(y_values):+.3f} "
            f"angle={min(angle_values):+.1f}..{max(angle_values):+.1f} deg"
        )


if __name__ == "__main__":
    main()
