// Generates frontend/public/og-image.png (1200x630) with zero dependencies.
// Run manually: node scripts/generate-og-image.mjs  (result is committed)
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIDTH = 1200;
const HEIGHT = 630;

// ---- 5x7 bitmap font ('.' = off, any other char = on) ---------------------
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '#####'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['.###.', '....#', '....#', '.###.', '....#', '....#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '#....', '####.', '....#', '....#', '####.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '..##.', '..##.'],
  "'": ['..##.', '..##.', '.....', '.....', '.....', '.....', '.....'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '!': ['..#..', '..#..', '..#..', '..#..', '.....', '..#..', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

// ---- canvas ----------------------------------------------------------------
const pixels = new Uint8Array(WIDTH * HEIGHT * 4);

function setPixel(x, y, [r, g, b, a = 255]) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = a;
}

function fillRect(x, y, w, h, color) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      setPixel(px, py, color);
    }
  }
}

function fillRoundedRect(x, y, w, h, r, color) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const cx = Math.min(Math.max(px, x + r), x + w - r - 1);
      const cy = Math.min(Math.max(py, y + r), y + h - r - 1);
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r * r) setPixel(px, py, color);
    }
  }
}

function drawText(text, x, y, scale, color) {
  let cx = x;
  for (const char of text.toUpperCase()) {
    const glyph = FONT[char];
    if (!glyph) continue;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '.') {
          fillRect(cx + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cx += 6 * scale; // 5 columns + 1 spacing column
  }
}

function textWidth(text, scale) {
  return text.length * 6 * scale;
}

// ---- PNG encoding -----------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- design ------------------------------------------------------------------
const PRIMARY_TOP = [79, 70, 229]; // #4f46e5
const PRIMARY_BOTTOM = [67, 56, 202]; // #4338ca
const CARD = [255, 255, 255];
const CARD_VALUE = [67, 56, 202];
const TITLE = [255, 255, 255];
const SUBTITLE = [199, 210, 254]; // #c7d2fe

// vertical gradient background
for (let y = 0; y < HEIGHT; y++) {
  const t = y / (HEIGHT - 1);
  const color = [
    Math.round(PRIMARY_TOP[0] + (PRIMARY_BOTTOM[0] - PRIMARY_TOP[0]) * t),
    Math.round(PRIMARY_TOP[1] + (PRIMARY_BOTTOM[1] - PRIMARY_TOP[1]) * t),
    Math.round(PRIMARY_TOP[2] + (PRIMARY_BOTTOM[2] - PRIMARY_TOP[2]) * t),
  ];
  fillRect(0, y, WIDTH, 1, color);
}

// card fan (back-to-front so the front card overlaps)
const CARD_W = 150;
const CARD_H = 210;
const CARD_R = 14;
const CARD_STEP_X = 120;
const CARD_STEP_Y = 14;
const cardsStartX = (WIDTH - (CARD_STEP_X * 4 + CARD_W)) / 2;
const cardsStartY = 60;
const CARD_VALUES = ['1', '2', '3', '5', '8'];
for (let i = CARD_VALUES.length - 1; i >= 0; i--) {
  const x = Math.round(cardsStartX + i * CARD_STEP_X);
  const y = Math.round(cardsStartY + (CARD_VALUES.length - 1 - i) * CARD_STEP_Y);
  fillRoundedRect(x, y, CARD_W, CARD_H, CARD_R, CARD);
  const valueScale = 10;
  const valueX = x + Math.round((CARD_W - textWidth(CARD_VALUES[i], valueScale)) / 2);
  const valueY = y + Math.round((CARD_H - 7 * valueScale) / 2);
  drawText(CARD_VALUES[i], valueX, valueY, valueScale, CARD_VALUE);
}

// title + subtitle
const title = 'EstimateNest';
const titleScale = 13;
drawText(title, Math.round((WIDTH - textWidth(title, titleScale)) / 2), 330, titleScale, TITLE);

const subtitle = 'Planning Poker for Teams';
const subtitleScale = 7;
drawText(
  subtitle,
  Math.round((WIDTH - textWidth(subtitle, subtitleScale)) / 2),
  460,
  subtitleScale,
  SUBTITLE
);

// ---- write --------------------------------------------------------------------
const png = encodePng(WIDTH, HEIGHT, pixels);
const outPath = fileURLToPath(new URL('../frontend/public/og-image.png', import.meta.url));
writeFileSync(outPath, png);
console.log(`generate-og-image: wrote ${outPath} (${png.length} bytes, ${WIDTH}x${HEIGHT})`);
