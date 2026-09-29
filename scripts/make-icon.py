# Writes scripts/canvas.ico (32-bit BMP-in-ICO, sizes 16/32/48/256) without any imaging library:
# a blue rounded square with a white pen stroke and a page line.
import struct, os, math

def render(n):
    px = [[(0, 0, 0, 0)] * n for _ in range(n)]
    r = n * 0.22
    for y in range(n):
        for x in range(n):
            # rounded square coverage
            cx = min(max(x + 0.5, r), n - r); cy = min(max(y + 0.5, r), n - r)
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            a = 1.0 if d <= r - 0.7 else (0.0 if d >= r + 0.7 else (r + 0.7 - d) / 1.4)
            if a <= 0: continue
            col = (47, 111, 237)  # accent blue
            # page: a lighter rectangle bottom-left, with two text lines
            if 0.20 * n <= x <= 0.62 * n and 0.30 * n <= y <= 0.80 * n:
                col = (232, 240, 255)
                for ly in (0.45, 0.58, 0.71):
                    if abs(y - ly * n) < max(1.0, n * 0.035) and 0.26 * n <= x <= 0.56 * n: col = (150, 175, 230)
            # pen: diagonal white stroke from bottom-left of page to top-right
            t = (x - 0.38 * n) + (y - 0.62 * n)  # along-stroke coordinate is (x - y); perpendicular distance:
            perp = abs((x - 0.40 * n) - (0.66 * n - y)) / math.sqrt(2)
            along = ((x - 0.40 * n) + (0.66 * n - y)) / math.sqrt(2)
            if perp < max(1.2, n * 0.075) and -0.02 * n < along < 0.62 * n:
                col = (255, 255, 255) if along > 0.10 * n else (255, 214, 110)
            px[y][x] = (col[0], col[1], col[2], int(255 * a))
    return px

def bmp_entry(n):
    px = render(n)
    rows = b''
    for y in range(n - 1, -1, -1):
        for x in range(n):
            r, g, b, a = px[y][x]
            rows += struct.pack('<BBBB', b, g, r, a)
    mask_row = ((n + 31) // 32) * 4
    mask = b'\x00' * (mask_row * n)
    header = struct.pack('<IiiHHIIiiII', 40, n, n * 2, 1, 32, 0, len(rows) + len(mask), 0, 0, 0, 0)
    return header + rows + mask

sizes = [16, 32, 48, 256]
entries = [bmp_entry(s) for s in sizes]
out = struct.pack('<HHH', 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
dirs = b''
for s, e in zip(sizes, entries):
    dirs += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(e), offset)
    offset += len(e)
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pali.ico')
with open(path, 'wb') as f:
    f.write(out + dirs + b''.join(entries))
print('wrote', path, os.path.getsize(path), 'bytes')
