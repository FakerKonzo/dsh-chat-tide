// 生成 Tide 图标：深色底 + 两道潮汐 + 一枚小点（纯 Node，无依赖）
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SIZE = 128;

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const px = Buffer.alloc(SIZE * SIZE * 4);
const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const alpha = a / 255;
  px[i] = Math.round(px[i] * (1 - alpha) + r * alpha);
  px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + g * alpha);
  px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + b * alpha);
  px[i + 3] = 255;
};

// 背景：垂直渐变
for (let y = 0; y < SIZE; y++) {
  const t = y / (SIZE - 1);
  const r = Math.round(7 + t * 6);
  const g = Math.round(18 + t * 12);
  const b = Math.round(34 + t * 18);
  for (let x = 0; x < SIZE; x++) set(x, y, r, g, b);
}

// 圆角遮罩
const radius = 26;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.min(Math.max(x, radius), SIZE - 1 - radius);
    const cy = Math.min(Math.max(y, radius), SIZE - 1 - radius);
    const d = Math.hypot(x - cx, y - cy);
    if (d > radius) px[(y * SIZE + x) * 4 + 3] = 0;
  }
}

// 两道潮汐
const waves = [
  { base: 74, amp: 11, freq: 18, thick: 6, color: [45, 212, 191], phase: 0 },
  { base: 96, amp: 9, freq: 14, thick: 5, color: [56, 189, 248], phase: 1.2 },
];
for (const w of waves) {
  for (let x = 0; x < SIZE; x++) {
    const y0 = w.base + Math.sin(x / w.freq + w.phase) * w.amp;
    for (let dy = -w.thick; dy <= w.thick; dy++) {
      const y = Math.round(y0) + dy;
      const falloff = 1 - Math.abs(dy) / (w.thick + 1);
      set(x, y, w.color[0], w.color[1], w.color[2], Math.round(255 * Math.max(0.25, falloff)));
    }
  }
}

// 一枚小点（种子 / 月亮）
const cx = 92;
const cy = 40;
const rr = 9;
for (let y = cy - rr - 1; y <= cy + rr + 1; y++) {
  for (let x = cx - rr - 1; x <= cx + rr + 1; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d > rr) continue;
    const edge = Math.min(1, rr - d);
    set(x, y, 230, 246, 255, Math.round(255 * Math.max(0.2, edge)));
  }
}

// 组装 PNG
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = fileURLToPath(new URL('../assets/icon.png', import.meta.url));
mkdirSync(fileURLToPath(new URL('../assets/', import.meta.url)), { recursive: true });
writeFileSync(out, png);
console.log('icon ->', out, png.length, 'bytes');