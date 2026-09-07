#!/usr/bin/env python3
"""Generate AppMute icon assets (tray + window) with zero dependencies.

Pure-stdlib PNG writer (struct + zlib): dark rounded square, blue speaker
glyph, lighter-blue sound waves. Regenerate with:  python3 generate-icons.py
"""
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))

BG = (31, 41, 55, 255)        # #1f2937
GLYPH = (147, 197, 253, 255)  # #93c5fd
WAVE = (96, 165, 250, 255)    # #60a5fa


def rounded_rect_mask(size, radius):
    mask = [[False] * size for _ in range(size)]
    c = radius - 0.5
    for y in range(size):
        for x in range(size):
            dx = max(c - x, 0, x - (size - 1 - c))
            dy = max(c - y, 0, y - (size - 1 - c))
            mask[y][x] = dx * dx + dy * dy <= radius * radius
    return mask


def draw(size):
    px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]
    s = size / 22.0  # design grid is 22x22
    mask = rounded_rect_mask(size, int(5 * s))
    for y in range(size):
        for x in range(size):
            if mask[y][x]:
                px[y][x] = BG
    gx, gy = x / s, y / s  # noqa: F841 (kept for clarity)

    def setp(dx, dy, color):
        x, y = int(dx * s), int(dy * s)
        for yy in range(y, min(size, y + max(1, int(round(s))))):
            for xx in range(x, min(size, x + max(1, int(round(s))))):
                px[yy][xx] = color

    # Speaker body: rect (4..8, 9..13) + cone (8..12, 6..16 triangle).
    for dy in range(9, 14):
        for dx in range(3, 8):
            setp(dx, dy, GLYPH)
    for dy in range(6, 17):
        t = abs(dy - 11) / 5.0
        for dx in range(8, int(13 - t * 2)):
            setp(dx, dy, GLYPH)
    # Sound waves: two arcs centred near (12, 11).
    for dy in range(22):
        for dx in range(22):
            d = math.hypot(dx - 11.5, dy - 11)
            if abs(d - 5.2) < 0.75 and dx > 12:
                setp(dx, dy, WAVE)
            if abs(d - 8.2) < 0.75 and dx > 12:
                setp(dx, dy, WAVE)
    return px


def write_png(path, size):
    px = draw(size)
    raw = b''.join(
        b'\x00' + b''.join(struct.pack('BBBB', *p) for p in row) for row in px
    )

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )
    with open(path, 'wb') as f:
        f.write(png)
    print(f'wrote {path} ({size}x{size})')


if __name__ == '__main__':
    write_png(os.path.join(HERE, 'tray.png'), 22)
    write_png(os.path.join(HERE, 'tray@2x.png'), 44)
    write_png(os.path.join(HERE, 'app-icon.png'), 256)
