#!/usr/bin/env python3
"""
Shrink the generated App Store screenshots into small preview images for the
README. Full-resolution store assets are ~30 MB and are not tracked; these are
a few hundred kilobytes and are.

Run `npm run screenshots` first, then `python3 tools/make_previews.py`.
"""

from __future__ import annotations

import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "store", "screenshots", "6.9-inch")
DST = os.path.join(ROOT, "docs", "preview")
TARGET_WIDTH = 380
SHOTS = ["1-title", "2-first-run", "3-chain", "4-storm-zone", "5-skins", "6-daily"]


def read_png(path):
    """Decode a truecolour PNG (the only kind our own tools produce)."""
    with open(path, "rb") as fh:
        data = fh.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    pos = 8
    width = height = 0
    bit_depth = color_type = 0
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", body[:10])
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + length
    assert bit_depth == 8 and color_type in (2, 6), "expected 8-bit RGB(A)"
    channels = 3 if color_type == 2 else 4
    raw = zlib.decompress(bytes(idat))
    return width, height, channels, unfilter(raw, width, height, channels)


def unfilter(raw, width, height, channels):
    """Undo the per-scanline PNG filters, returning packed pixel bytes."""
    stride = width * channels
    out = bytearray(stride * height)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        line = raw[pos:pos + stride]
        pos += stride
        base = y * stride
        prior = base - stride
        for x in range(stride):
            value = line[x]
            left = out[base + x - channels] if x >= channels else 0
            up = out[prior + x] if y > 0 else 0
            upleft = out[prior + x - channels] if (y > 0 and x >= channels) else 0
            if ftype == 1:
                value += left
            elif ftype == 2:
                value += up
            elif ftype == 3:
                value += (left + up) >> 1
            elif ftype == 4:
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                value += left if (pa <= pb and pa <= pc) else (up if pb <= pc else upleft)
            out[base + x] = value & 0xFF
    return out


def box_downscale(pixels, width, height, channels, target_w):
    factor = width / target_w
    target_h = max(1, round(height / factor))
    out = bytearray()
    for y in range(target_h):
        out.append(0)  # filter: none
        y0 = int(y * height / target_h)
        y1 = max(y0 + 1, int((y + 1) * height / target_h))
        for x in range(target_w):
            x0 = int(x * factor)
            x1 = max(x0 + 1, int((x + 1) * factor))
            r = g = b = n = 0
            for yy in range(y0, y1):
                row = yy * width * channels
                for xx in range(x0, x1):
                    i = row + xx * channels
                    r += pixels[i]
                    g += pixels[i + 1]
                    b += pixels[i + 2]
                    n += 1
            out.append(r // n)
            out.append(g // n)
            out.append(b // n)
    return bytes(out), target_w, target_h


def write_png(path, width, height, raw):
    def chunk(tag, body):
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    if not os.path.isdir(SRC):
        print(f"No screenshots at {SRC}. Run `npm run screenshots` first.", file=sys.stderr)
        return 1
    os.makedirs(DST, exist_ok=True)
    for name in SHOTS:
        src = os.path.join(SRC, f"{name}.png")
        if not os.path.exists(src):
            continue
        w, h, channels, pixels = read_png(src)
        raw, tw, th = box_downscale(pixels, w, h, channels, TARGET_WIDTH)
        dst = os.path.join(DST, f"{name}.png")
        write_png(dst, tw, th, raw)
        print(f"  {name}.png  {tw}x{th}  {os.path.getsize(dst) // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
