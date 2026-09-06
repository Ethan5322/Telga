"""
Build the Telga mark from the founder's reference render.

The reference (`gpt.png`) supplies the T and the figure — their form is not
redrawn, which was an explicit instruction. What this changes:

  1. the white background becomes genuinely transparent (the file had none —
     alpha was 255 everywhere, so the "transparent" look was just white);
  2. the asphalt road is removed **entirely**, markings included;
  3. the gold is remapped to deep teal, keeping the render's own shading so it
     still reads as a lit metal object rather than a flat fill;
  4. a new ground of warm stone and low bush is drawn, scattered around the
     figure's feet rather than laid down as a band;
  5. the piece is tilted further, so the T's foot is clearly OFF the ground —
     mid-fall, not standing on it.

## How the road is separated from the letter

Not by colour — the road markings are the same warm yellow as the gold, so a
hue filter keeps them. Not by connected components either: the letter's foot
rests ON the road, so they are one component and regrowing after an erosion
brings the road straight back. The asphalt is a flat plane seen edge-on, so
its top edge is a straight line; that line is fitted from the columns the
subject does not cover, and everything below it is cut.
"""

from __future__ import annotations

import colorsys
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

SRC = Path("gpt.png")
OUT = Path("apps/merchant-pos/assets/telga-logo.png")

# Deep teal metal; warm stone; muted bush. Light falls from the upper left,
# matching the render, so every drawn highlight sits on that side.
TEAL_HUE = 0.505
TEAL_SAT = 0.60
STONE_FACES = [(176, 158, 132), (152, 134, 110), (126, 110, 90), (101, 88, 71), (88, 76, 62)]
STONE_LIT = (211, 196, 172)
STONE_SHADE = (58, 49, 39)
BUSH_DARK = (32, 56, 34)
BUSH_MID = (50, 82, 48)
BUSH_LIT = (82, 118, 64)



def load_subject(path: Path) -> np.ndarray:
    """Cut the render off its white background, with a soft edge."""
    a = np.array(Image.open(path).convert("RGBA")).astype(np.int16)
    mn = a[..., :3].min(axis=2)
    # The background is near-white but noisy (240-252), so a hard threshold
    # leaves a halo. Ramp the alpha across the last few levels instead.
    a[..., 3] = np.clip((246 - mn) * (255.0 / 18.0), 0, 255)
    return a


def road_surface_line(a: np.ndarray) -> tuple[float, float]:
    """
    Fit the road's top edge.

    The asphalt is a flat plane seen almost edge-on, so its upper boundary is a
    straight line in the image. Sampled only in the columns the letter and the
    figure do not cover — elsewhere the letter's own shadowed underside is dark
    and desaturated too, and would drag the fit upwards.

    Returns the slope and intercept of `y = m*x + c`.
    """
    rgb = a[..., :3]
    mn, mx = rgb.min(axis=2), rgb.max(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0.0)
    asphalt = (mn < 235) & (mx < 105) & (sat < 0.45)

    xs, ys = [], []
    for x in list(range(160, 470, 8)) + list(range(1150, 1430, 8)):
        column = np.where(asphalt[:, x])[0]
        column = column[column > 430]
        if column.size:
            xs.append(x)
            ys.append(column.min())
    m, c = np.polyfit(np.array(xs, float), np.array(ys, float), 1)
    return float(m), float(c)


def despeckle(a: np.ndarray, min_px: int = 400) -> np.ndarray:
    """
    Drop stray marks.

    The render carries faint scuffs and a dashed rule near its edges that are
    part of the original canvas, not the subject. Once the road is cut they
    float on their own, so anything too small to be a limb is removed.
    """
    solid = a[..., 3] > 40
    labels, count = ndimage.label(solid)
    if count == 0:
        return a
    sizes = ndimage.sum(solid, labels, range(1, count + 1))
    keep = np.isin(labels, [i + 1 for i, n in enumerate(sizes) if n >= min_px])
    out = a.copy()
    out[..., 3] = np.where(keep, out[..., 3], 0)
    return out


def cut_road(a: np.ndarray) -> np.ndarray:
    """
    Delete everything below the road's surface.

    A colour filter cannot do this: the road markings are the same warm yellow
    as the gold, so they survive it. A geometric cut along the surface line
    removes the asphalt, the markings and the gravel verge together, and takes
    only the last few pixels of the feet with it — which the new ground covers.
    """
    m, c = road_surface_line(a)
    h, w = a.shape[:2]
    xs = np.arange(w)[None, :]
    ys = np.arange(h)[:, None]
    below = ys > (m * xs + c - 7.0)
    out = a.copy()
    out[..., 3] = np.where(below, 0, out[..., 3])
    return out


def recolour(a: np.ndarray) -> Image.Image:
    """
    Gold to deep teal, keeping the render's own light.

    Hue and saturation are replaced; **value is kept**, which preserves the
    highlights, the bevels and the shadow under the crossbar. Replacing the
    colour outright would flatten it to a silhouette.
    """
    rgb = a[..., :3].astype(np.float32) / 255.0
    alpha = a[..., 3].astype(np.uint8)

    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    v = np.clip((mx - 0.5) * 1.14 + 0.5, 0.0, 1.0)
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    s_new = np.clip(s * TEAL_SAT + 0.20, 0.0, 0.95)

    nr, ng, nb = np.vectorize(colorsys.hsv_to_rgb)(TEAL_HUE, s_new, v)
    rgb_out = (np.dstack([nr, ng, nb]) * 255.0).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb_out, alpha]).astype(np.uint8), "RGBA")


def rock(d: ImageDraw.ImageDraw, cx: int, cy: int, rw: int, rng: random.Random) -> None:
    """One stone: a lit top, a shaded underside, and a contact shadow."""
    rh = int(rw * rng.uniform(0.52, 0.78))
    face = STONE_FACES[rng.randrange(len(STONE_FACES))]
    d.ellipse([cx - rw, cy - rh + 3, cx + rw, cy + rh + 5], fill=(*STONE_SHADE, 90))
    d.ellipse([cx - rw, cy - rh, cx + rw, cy + rh], fill=(*face, 255))
    d.chord(
        [cx - rw, cy - rh, cx + rw, cy + rh],
        start=195, end=345, fill=(*STONE_LIT, 150),
    )
    d.arc(
        [cx - rw, cy - rh, cx + rw, cy + rh],
        start=15, end=165, fill=(*STONE_SHADE, 190), width=max(2, rw // 8),
    )


def bush(d: ImageDraw.ImageDraw, cx: int, cy: int, scale: float, rng: random.Random) -> None:
    """A low shrub: overlapping leaf clusters, lit from the upper left."""
    for tone, dy, spread in ((BUSH_DARK, 4, 1.0), (BUSH_MID, 0, 0.82), (BUSH_LIT, -5, 0.55)):
        for _ in range(rng.randint(5, 9)):
            lw = int(rng.uniform(10, 26) * scale * spread)
            lh = int(lw * rng.uniform(0.7, 1.15))
            ox = int(rng.uniform(-34, 34) * scale)
            oy = int(rng.uniform(-16, 6) * scale) + dy
            d.ellipse(
                [cx + ox - lw, cy + oy - lh, cx + ox + lw, cy + oy + lh],
                fill=(*tone, 255),
            )


def ground_plane(tilted: Image.Image) -> "np.ndarray":
    """
    The line the figure is standing on, per column.

    Not simply the lowest pixel of each column: over the crossbar that is the
    overhang, metres above the ground, and rocks laid along it trail off into
    the sky. The contact points are the columns whose bottom edge is near the
    lowest point of the whole subject — the two soles and the letter's foot —
    and a line fitted through those is the ground plane, extended across the
    canvas so the ground runs past the figure on both sides.
    """
    alpha = np.array(tilted)[..., 3]
    width = alpha.shape[1]

    bottoms = np.full(width, -1, dtype=int)
    for x in range(width):
        column = np.where(alpha[:, x] > 60)[0]
        if column.size:
            bottoms[x] = column.max()

    known = np.where(bottoms >= 0)[0]
    if known.size == 0:
        return np.full(width, alpha.shape[0] - 1, dtype=int)

    # Only the columns that actually reach the floor.
    lowest = bottoms[known].max()
    contact = known[bottoms[known] > lowest - 70]
    m, c = np.polyfit(contact.astype(float), bottoms[contact].astype(float), 1)
    xs = np.arange(width, dtype=float)
    return (m * xs + c).astype(int)


def draw_ground(size: tuple[int, int], floor: "np.ndarray") -> Image.Image:
    """
    Loose rock and low bush.

    Drawn rather than sourced: it has to sit under a specific pose at a
    specific angle, and stay legible when the whole mark is 34 px tall on a
    slip. Scattered along an uneven line rather than laid as a band, so it
    reads as ground the figure is standing among.
    """
    rng = random.Random(11)
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")
    w = size[0]
    left, right = int(w * 0.16), int(w * 0.80)

    def wobble(x: int) -> int:
        """
        The ground line: the subject's own bottom edge, made uneven.

        Following the silhouette keeps the rocks under the soles; the sine
        terms stop it reading as a kerb.
        """
        x = int(np.clip(x, 0, len(floor) - 1))
        t = x / max(1, w)
        return int(floor[x]) - 4 + int(11 * np.sin(t * 17.0) + 6 * np.sin(t * 37.0 + 1.2))

    for _ in range(13):
        x = rng.randint(left, right)
        bush(d, x, wobble(x) - rng.randint(0, 8), rng.uniform(0.60, 1.05), rng)

    for _ in range(46):
        x = rng.randint(left, right)
        rock(d, x, wobble(x) + rng.randint(-6, 10), rng.randint(9, 26), rng)

    for _ in range(80):
        x = rng.randint(left - 30, right + 30)
        rock(d, x, wobble(x) + rng.randint(2, 22), rng.randint(3, 9), rng)

    return layer.filter(ImageFilter.GaussianBlur(0.5))


def draw_foreground(size: tuple[int, int], floor: "np.ndarray") -> Image.Image:
    """A few stones in front of the soles, to seat the figure in the ground."""
    rng = random.Random(23)
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")
    w = size[0]
    for _ in range(26):
        x = rng.randint(int(w * 0.18), int(w * 0.78))
        y = int(floor[int(np.clip(x, 0, len(floor) - 1))]) + rng.randint(-2, 8)
        rock(d, x, y, rng.randint(4, 13), rng)
    return layer.filter(ImageFilter.GaussianBlur(0.4))


def main() -> None:
    subject = recolour(despeckle(cut_road(load_subject(SRC))))

    # Tilt further and lift. The reference has the letter's foot flat on the
    # road, which reads as standing; the brief is that the fall must be visible
    # at the bottom. Rotating about a pivot at the figure's rear foot swings
    # the letter's base up and clear of the ground.
    canvas = Image.new("RGBA", (1536, 1120), (0, 0, 0, 0))
    canvas.paste(subject, (0, 20), subject)
    # Rotated about the figure's rear foot, so the figure stays planted while
    # the letter's base swings up and clear. 15 degrees past the reference is
    # what makes the fall unmistakable at the bottom, which was the brief.
    tilted = canvas.rotate(-15.0, resample=Image.BICUBIC, center=(1010, 690), expand=False)

    ground = draw_ground(canvas.size, ground_plane(tilted))

    floor = ground_plane(tilted)
    out = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    out.alpha_composite(draw_ground(canvas.size, floor))
    out.alpha_composite(tilted)
    # A second, sparser scatter drawn OVER the subject, so a few stones sit in
    # front of the soles and the figure reads as standing in the ground rather
    # than on a strip pasted behind it.
    out.alpha_composite(draw_foreground(canvas.size, floor))

    out = out.crop(out.getbbox())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUT)
    print("wrote", OUT, out.size)


if __name__ == "__main__":
    main()
