"""
Give the figure its own colour, so the mark reads as two objects.

## The problem this fixes

The mark was one colour throughout: the T and the figure pushing it were the
same teal, so at a glance the composition flattened into a single silhouette.
A logo whose two subjects cannot be told apart at 32px — which is what the
browser tab shows — is not finished, however good the render is.

The founder's note: *"the T and skeleton colour are not supposed to be the
same — make it more professional, show professionally designed."*

## The palette

Deep teal and warm stone, chosen earlier for the product. This applies it to
the mark itself:

  - the **T** keeps the teal, deepened slightly so it reads as the solid,
    heavy object it is meant to be;
  - the **figure** becomes warm bone — which is both the contrast the
    composition needs and the natural colour of the thing it depicts;
  - the **ground** is already warm stone and is left alone.

## How the figure is separated from the T

Not by colour: they are currently identical, which is the whole problem. Not
by connected components either — the figure's hands rest ON the T, so they are
one component.

By **thickness**. The T is a slab: a wide, solid form that survives a heavy
erosion. The figure is a skeleton: ribs, and limbs a few pixels across, which
an erosion removes entirely. So eroding the teal mask and keeping the largest
surviving component isolates the T's body; dilating that back to its original
extent recovers its edges without regrowing the limbs, because a dilation only
regrows what the erosion took from a shape that survived.

Whatever teal is left over is the figure.

The one place this is imperfect is where a hand overlaps the T's stem: those
pixels belong to both under this test, and the T wins. That reads correctly —
a hand in front of a slab is a small dark shape against it — and the
alternative is hand-editing the artwork, which is the thing that must not
happen.

## Shading is preserved

Each region is remapped by **luminance**, not filled flat. The render's own
highlights and shadows carry through, so the T still looks like a lit metal
object and the bone still looks modelled rather than cut out of paper.

## Run it once

This edits the asset in place, and it is **not** idempotent: after a successful
run the figure is bone, so a second run finds no teal figure to separate and
the size guard below refuses to write rather than recolouring the letter into
itself. That is the intended failure — it protects the asset — but it means the
script is a one-time conversion, not part of the build. `build-icons.py` is the
one to re-run, because the icons are derived.

To start over, restore the mark from git and run this once.

Run:  python scripts/brand/recolour-figure.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "apps" / "merchant-pos" / "assets" / "telga-logo.png"

# --- the palette -----------------------------------------------------------
# Sampled from the product's own tokens rather than invented here.
TEAL_DARK = np.array([9, 46, 51], dtype=float)      # deepest shadow in the T
TEAL_LIGHT = np.array([120, 214, 214], dtype=float)  # its brightest highlight
BONE_DARK = np.array([124, 106, 84], dtype=float)    # shadowed bone
BONE_LIGHT = np.array([245, 238, 224], dtype=float)  # lit bone


def luminance(rgb: np.ndarray) -> np.ndarray:
    """Perceptual weights — a green highlight is brighter than a blue one."""
    return (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]) / 255.0


def stretch(values: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """
    Rescale luminance to 0..1 across the masked region only.

    Using the region's own range rather than 0..255 keeps the full contrast of
    the new colour ramp. Percentiles rather than min/max so one stray specular
    pixel does not flatten everything else.
    """
    if not mask.any():
        return values
    low, high = np.percentile(values[mask], [2, 98])
    if high - low < 1e-6:
        return np.zeros_like(values)
    return np.clip((values - low) / (high - low), 0.0, 1.0)


def ramp(t: np.ndarray, dark: np.ndarray, light: np.ndarray) -> np.ndarray:
    """Map 0..1 onto a two-point colour ramp, keeping the render's modelling."""
    return dark[None, None, :] + t[..., None] * (light - dark)[None, None, :]


def main() -> int:
    if not SOURCE.exists():
        print(f"missing source: {SOURCE}", file=sys.stderr)
        return 1

    image = Image.open(SOURCE).convert("RGBA")
    pixels = np.array(image)
    rgb = pixels[..., :3].astype(float)
    alpha = pixels[..., 3]
    opaque = alpha > 40

    # Teal is where blue+green clearly dominates red. The ground stones are
    # warm and fail this test, which is what keeps them out of both regions.
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    teal = opaque & ((g + b) > (2.0 * r + 40.0))

    # --- separate by thickness ---------------------------------------------
    # A disc big enough to erase a limb but not a slab. Scaled from the image
    # so the script survives a re-render at a different resolution.
    radius = max(3, int(round(min(image.size) * 0.018)))
    yy, xx = np.mgrid[-radius : radius + 1, -radius : radius + 1]
    disc = (xx**2 + yy**2) <= radius**2

    core = ndimage.binary_erosion(teal, structure=disc)
    labels, count = ndimage.label(core)
    if count == 0:
        print("no surviving component after erosion — radius too large", file=sys.stderr)
        return 2
    sizes = ndimage.sum(core, labels, range(1, count + 1))

    # **Every** surviving slab, not just the biggest one.
    #
    # The erosion severs the T at its own joint — the crossbar and the stem
    # meet at an angle, and the disc eats through the corner — so the letter
    # arrives here as two components. Keeping only the largest kept the
    # crossbar and handed the entire stem to the figure, which recoloured two
    # thirds of the letter as bone.
    #
    # A limb cannot survive this erosion at all, so anything still standing is
    # part of the letter. The threshold only discards single-pixel survivors at
    # a thick joint.
    biggest = float(sizes.max())
    keep_core = {i + 1 for i, size in enumerate(sizes) if size >= max(50.0, biggest * 0.05)}
    core = np.isin(labels, list(keep_core))

    # Dilate back to recover the T's own edges. Bounded by `teal` so it cannot
    # spill onto the figure or the ground.
    letter = ndimage.binary_dilation(core, structure=disc, iterations=2) & teal
    figure = teal & ~letter

    # A limb detached by the erosion can leave specks. Anything tiny that is
    # not touching the figure proper is noise, not anatomy.
    figure_labels, figure_count = ndimage.label(figure)
    if figure_count > 0:
        figure_sizes = ndimage.sum(figure, figure_labels, range(1, figure_count + 1))
        keep = {i + 1 for i, size in enumerate(figure_sizes) if size >= 40}
        figure = np.isin(figure_labels, list(keep)) if keep else figure

    print(f"letter px {int(letter.sum())}  figure px {int(figure.sum())}  radius {radius}")
    # The figure is roughly a quarter of the teal on the original mark. A run
    # that finds far less has either been given an already-converted file — in
    # which case the only teal left IS the letter, and there is nothing to
    # separate — or has mis-segmented. Either way, writing would damage the
    # asset, so refuse. This threshold is what makes a second run safe.
    if figure.sum() < 0.10 * teal.sum():
        print(
            f"figure region implausibly small ({int(figure.sum())} px of {int(teal.sum())} teal) "
            "— already converted, or mis-segmented. Refusing to write.",
            file=sys.stderr,
        )
        return 3

    # --- recolour, keeping the modelling ------------------------------------
    lum = luminance(rgb)
    out = rgb.copy()

    t_letter = stretch(lum, letter)
    out[letter] = ramp(t_letter, TEAL_DARK, TEAL_LIGHT)[letter]

    t_figure = stretch(lum, figure)
    out[figure] = ramp(t_figure, BONE_DARK, BONE_LIGHT)[figure]

    result = np.dstack([np.clip(out, 0, 255).astype(np.uint8), alpha])
    Image.fromarray(result, "RGBA").save(SOURCE)
    print(f"wrote {SOURCE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
