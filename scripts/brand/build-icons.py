"""
Build the square Telga app icon set from the mark.

An app icon is not the logo scaled down. A wide landscape mark shrunk into a
square leaves most of the square empty and the letter unreadable at 48 px — so
the icon crops to the letter and the figure, drops the ground entirely, and
sits on a solid brand square with a safe margin.

Two shapes are produced:

  - `icon-<n>.png`  — the mark on a filled teal square, for platforms that use
    the icon exactly as given (Windows, older Android, favicons).
  - `icon-maskable-<n>.png` — the same with a much wider margin, for Android's
    maskable icons, where the launcher may crop the square to a circle or a
    squircle and anything near the edge is lost.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SRC = Path("apps/merchant-pos/assets/telga-logo.png")
OUT_DIR = Path("apps/merchant-pos/assets")

# The brand square. Deep enough that the teal metal reads against it.
BACKDROP_TOP = (18, 46, 48)
BACKDROP_BOTTOM = (10, 28, 30)

SIZES = (512, 192, 180, 32)

# The two app tiles shown on the launcher. Both carry the Telga mark, because
# both ARE Telga — they are told apart by their label and by a tint, not by
# borrowing an unrelated icon. Generic emoji were used here and were wrong:
# nothing in the Telga ecosystem should be iconed as something other than Telga.
APP_TILES = {
    "app-vending": ((20, 56, 58), (11, 33, 35)),
    "app-pay": ((16, 44, 62), (9, 26, 38)),
}
TILE_SIZE = 256


def subject_without_ground(path: Path) -> Image.Image:
    """
    The letter and the figure, with the ground removed.

    ## Why this is not a hue test any more

    It used to be. The comment read *"the ground is stone and bush — warm and
    green, the subject is teal metal"*, and that was true while the whole
    subject was teal. Once the figure was recoloured to bone
    (`recolour-figure.py`) the hue test started classifying **the figure as
    ground** and deleting it: the icon came out as a bare T with a ghost beside
    it, which is the opposite of the change that recolouring was for.

    ## What separates them now: structure, not colour

    The letter and the figure are one connected mass — the figure's hands rest
    on the T. The ground is scattered: individual pebbles and tufts, each its
    own small blob. So the subject is the **largest connected component**, and
    everything else is ground, whatever colour any of it happens to be.

    The bushes are removed by colour first — they are the one part of the
    ground that is unambiguously not subject, and taking them out breaks the
    chain of touching pebbles that would otherwise drag the whole ground band
    in through the figure's feet.

    A pebble the foot still touches comes along. That is a few dozen pixels at
    the bottom of a 512px icon, and it is a better failure than deleting the
    figure.
    """
    im = Image.open(path).convert("RGBA")
    a = np.array(im).astype(np.int16)
    opaque = a[..., 3] > 40

    # The bushes go first, by colour: they are the one part of the ground that
    # is unambiguously not subject, and removing them breaks the chain of
    # touching pebbles that would otherwise carry the whole ground band into
    # the largest component through the figure's feet.
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    bush = opaque & (g > r + 18) & (g > b + 18)
    standing = opaque & ~bush

    labels, count = ndimage.label(standing)
    if count == 0:
        raise SystemExit(f"{path} appears to be empty")
    sizes = ndimage.sum(standing, labels, range(1, count + 1))
    subject = labels == (int(np.argmax(sizes)) + 1)

    a[..., 3] = np.where(subject, a[..., 3], 0)
    out = Image.fromarray(a.astype(np.uint8), "RGBA")
    return out.crop(out.getbbox())


def backdrop(size: int, top=BACKDROP_TOP, bottom=BACKDROP_BOTTOM) -> Image.Image:
    """A vertical gradient square, so the icon has depth without a photo."""
    grad = Image.new("RGBA", (1, size))
    d = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point(
            (0, y),
            fill=(
                int(top[0] + (bottom[0] - top[0]) * t),
                int(top[1] + (bottom[1] - top[1]) * t),
                int(top[2] + (bottom[2] - top[2]) * t),
                255,
            ),
        )
    return grad.resize((size, size), Image.BILINEAR)


def rounded(im: Image.Image, radius_ratio: float = 0.22) -> Image.Image:
    """Round the corners, so a tile reads as an app icon rather than a photo."""
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, im.size[0] - 1, im.size[1] - 1],
        radius=int(im.size[0] * radius_ratio),
        fill=255,
    )
    out = im.copy()
    out.putalpha(mask)
    return out


def build(subject: Image.Image, size: int, margin: float) -> Image.Image:
    icon = backdrop(size)
    box = int(size * (1.0 - 2 * margin))
    scaled = subject.copy()
    scaled.thumbnail((box, box), Image.LANCZOS)
    icon.alpha_composite(
        scaled,
        ((size - scaled.width) // 2, (size - scaled.height) // 2),
    )
    return icon


def main() -> None:
    subject = subject_without_ground(SRC)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        build(subject, size, margin=0.11).save(OUT_DIR / f"icon-{size}.png")
        # Maskable: 20% margin on every side, so a circular crop keeps the mark.
        build(subject, size, margin=0.21).save(OUT_DIR / f"icon-maskable-{size}.png")
        print("wrote", OUT_DIR / f"icon-{size}.png")

    # The launcher's two app tiles.
    for name, (top, bottom) in APP_TILES.items():
        tile = backdrop(TILE_SIZE, top, bottom)
        mark = subject.copy()
        box = int(TILE_SIZE * 0.74)
        mark.thumbnail((box, box), Image.LANCZOS)
        tile.alpha_composite(
            mark, ((TILE_SIZE - mark.width) // 2, (TILE_SIZE - mark.height) // 2)
        )
        rounded(tile).save(OUT_DIR / f"{name}.png")
        print("wrote", OUT_DIR / f"{name}.png")


if __name__ == "__main__":
    main()
