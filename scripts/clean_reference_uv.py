from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT_ROOT / "public" / "models" / "reference-face-uv-raw.png"
OUTPUT = PROJECT_ROOT / "public" / "models" / "reference-face-uv.png"


image = Image.open(SOURCE).convert("RGB")
pixels = np.asarray(image).copy()
height, width, _ = pixels.shape

x_grid = np.arange(width)[None, :]
y_grid = np.arange(height)[:, None]
outer_side = ((x_grid < width * 0.24) | (x_grid > width * 0.76)) & (y_grid > height * 0.47)
dark_foreign_pixel = (
    (pixels[:, :, 0] < 145)
    & (pixels[:, :, 1] < 132)
    & (pixels[:, :, 2] < 125)
)
replace_mask = outer_side & dark_foreign_pixel

for y in range(height):
    row_mask = replace_mask[y]
    if not row_mask.any():
        continue
    center_strip = pixels[y, int(width * 0.36):int(width * 0.64)]
    skin_candidates = center_strip[
        (center_strip[:, 0] > 145)
        & (center_strip[:, 0] > center_strip[:, 1] * 1.02)
        & (center_strip[:, 1] > center_strip[:, 2] * 0.95)
    ]
    if len(skin_candidates):
        pixels[y, row_mask] = np.median(skin_candidates, axis=0).astype(np.uint8)

cleaned = Image.fromarray(pixels, "RGB")
feather = Image.fromarray((replace_mask * 255).astype(np.uint8), "L").filter(
    ImageFilter.GaussianBlur(radius=9),
)
result = Image.composite(cleaned, image, feather)
result.save(OUTPUT, optimize=True)

print(f"cleaned {int(replace_mask.sum())} UV edge pixels -> {OUTPUT}")
