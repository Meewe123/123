#!/usr/bin/env python3
"""
Generate every app icon and the launch image from a single vector description.

No third-party imaging library is used: the mark is defined as signed distance
fields, sampled with analytic anti-aliasing, and written out as PNG with the
standard library's zlib. That keeps the art in version control as code — change
a colour here and every size regenerates identically.
"""

from __future__ import annotations

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "www", "assets", "icons")
IOS_ICON = os.path.join(ROOT, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset")
IOS_SPLASH = os.path.join(ROOT, "ios", "App", "App", "Assets.xcassets", "Splash.imageset")
SPLASH_SIZE = 2732  # what the iOS asset catalog expects

# Palette shared with the game's first zone.
BG_INNER = (0x15, 0x4A, 0x74)
BG_OUTER = (0x03, 0x08, 0x14)
RING = (0x5F, 0xF0, 0xE0)
RING_DIM = (0x1C, 0x6A, 0x72)
ORB = (0xFF, 0xE6, 0x6D)
CORE = (0xFF, 0xFF, 0xFF)

# Icon sizes: iOS asset catalog, Android/PWA and the App Store marketing icon.
SIZES = [1024, 512, 192, 180, 167, 152, 144, 128, 120, 114, 96, 87, 80, 76, 72,
         64, 60, 58, 57, 48, 40, 36, 32, 29, 20, 16]


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0) if e1 != e0 else 0.0)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def over(dst, src, alpha):
    return tuple(dst[i] + (src[i] - dst[i]) * alpha for i in range(3))


def add(dst, src, amount):
    return tuple(min(255.0, dst[i] + src[i] * amount) for i in range(3))


def ang_dist(a, b):
    d = abs((a - b) % (2 * math.pi))
    return 2 * math.pi - d if d > math.pi else d


def render(size: int, margin: float = 0.0):
    """Render the mark at `size` px. `margin` shrinks the artwork (for splash)."""
    px = 1.0 / size
    half = size / 2.0
    aa = 1.0  # one pixel of feather

    scale = size * (1.0 - margin)
    r_ring = 0.335 * scale
    t_ring = 0.062 * scale
    r_core = 0.088 * scale
    r_orb = 0.055 * scale
    gap_center = -math.pi / 2
    gap_half = 0.46

    max_r = math.hypot(half, half)
    rows = bytearray()

    for y in range(size):
        rows.append(0)  # PNG filter byte: none
        dy = y + 0.5 - half
        for x in range(size):
            dx = x + 0.5 - half
            r = math.hypot(dx, dy)
            theta = math.atan2(dy, dx)

            # Background: soft radial gradient, darker toward the corners.
            g = clamp(r / max_r)
            col = mix(BG_INNER, BG_OUTER, g ** 0.85)

            # Broad ring glow.
            glow = math.exp(-abs(r - r_ring) / (t_ring * 2.6))
            col = add(col, RING_DIM, glow * 0.55)

            # The ring itself, with a wedge removed and round caps on the ends.
            annulus = clamp((t_ring * 0.5 - abs(r - r_ring)) / aa + 0.5)
            gap = clamp(((gap_half - ang_dist(theta, gap_center)) * max(r, 1.0)) / aa + 0.5)
            cov = annulus * (1.0 - gap)
            for sign in (-1, 1):
                ca = gap_center + sign * gap_half
                cx = math.cos(ca) * r_ring
                cy = math.sin(ca) * r_ring
                d = math.hypot(dx - cx, dy - cy)
                cov = max(cov, clamp((t_ring * 0.5 - d) / aa + 0.5))
            if cov > 0:
                col = over(col, RING, cov)
                inner = clamp((t_ring * 0.16 - abs(r - r_ring)) / aa + 0.5) * cov
                col = over(col, CORE, inner * 0.7)

            # Core star at the centre.
            core_glow = math.exp(-max(0.0, r - r_core) / (r_core * 1.5))
            col = add(col, RING, core_glow * 0.8)
            core = clamp((r_core - r) / aa + 0.5)
            if core > 0:
                shade = 1.0 - 0.35 * smoothstep(-r_core, r_core, dx * 0.7 + dy * 0.7)
                col = over(col, tuple(c * shade for c in CORE), core)

            # The player orb, sitting in the gap.
            ox = math.cos(gap_center) * r_ring
            oy = math.sin(gap_center) * r_ring
            od = math.hypot(dx - ox, dy - oy)
            col = add(col, ORB, math.exp(-max(0.0, od - r_orb) / (r_orb * 1.2)) * 0.75)
            oc = clamp((r_orb - od) / aa + 0.5)
            if oc > 0:
                col = over(col, ORB, oc)
                col = over(col, CORE, clamp((r_orb * 0.42 - math.hypot(dx - ox + r_orb * 0.22,
                                                                      dy - oy + r_orb * 0.24)) / aa + 0.5) * 0.9)

            rows.append(int(clamp(col[0], 0, 255)))
            rows.append(int(clamp(col[1], 0, 255)))
            rows.append(int(clamp(col[2], 0, 255)))

    return bytes(rows)


def write_png(path: str, size: int, raw: bytes):
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def downscale(raw: bytes, src: int, dst: int) -> bytes:
    """Box-filter an RGB scanline buffer (with filter bytes) down to `dst`."""
    stride = src * 3 + 1
    out = bytearray()
    factor = src / dst
    for y in range(dst):
        out.append(0)
        y0 = int(y * factor)
        y1 = max(y0 + 1, int((y + 1) * factor))
        for x in range(dst):
            x0 = int(x * factor)
            x1 = max(x0 + 1, int((x + 1) * factor))
            r = g = b = n = 0
            for yy in range(y0, y1):
                base = yy * stride + 1
                for xx in range(x0, x1):
                    i = base + xx * 3
                    r += raw[i]
                    g += raw[i + 1]
                    b += raw[i + 2]
                    n += 1
            out.append(r // n)
            out.append(g // n)
            out.append(b // n)
    return bytes(out)


def main():
    os.makedirs(ICON_DIR, exist_ok=True)

    master_size = 1024
    print(f"rendering master {master_size}x{master_size} ...")
    master = render(master_size)
    write_png(os.path.join(ICON_DIR, "icon-1024.png"), master_size, master)

    for size in SIZES:
        if size == master_size:
            continue
        # Small icons are re-rendered rather than downscaled so the thin ring
        # stays crisp; larger ones are box-filtered from the master.
        if size >= 256:
            raw = downscale(master, master_size, size)
        else:
            raw = render(size)
        write_png(os.path.join(ICON_DIR, f"icon-{size}.png"), size, raw)
        print(f"  icon-{size}.png")

    # The native project gets the same artwork, so `npm run icons` is the one
    # command that regenerates every piece of art in the repository.
    if os.path.isdir(IOS_ICON):
        write_png(os.path.join(IOS_ICON, "AppIcon-512@2x.png"), master_size, master)
        print("  ios AppIcon-512@2x.png")

    if os.path.isdir(IOS_SPLASH):
        print(f"rendering launch image {SPLASH_SIZE}x{SPLASH_SIZE} (this one takes a minute) ...")
        splash = render(SPLASH_SIZE, margin=0.80)
        for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
            write_png(os.path.join(IOS_SPLASH, name), SPLASH_SIZE, splash)
            print(f"  ios {name}")

    print("done")


if __name__ == "__main__":
    main()
