#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const outputDir = process.argv[2];
if (!outputDir) {
  console.error('Usage: generate-icon.mjs <AppIcon.iconset>');
  process.exit(1);
}

const sizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

async function main() {
  await mkdir(outputDir, { recursive: true });

  for (const [fileName, size] of sizes) {
    const rgba = drawIcon(size);
    await writeFile(path.join(outputDir, fileName), encodePng(size, size, rgba));
  }
}

function drawIcon(size) {
  const image = new Uint8ClampedArray(size * size * 4);
  drawBackground(image, size);

  const grassDark = [28, 114, 43, 255];
  const grass = [70, 207, 89, 255];
  const grassLight = [137, 239, 142, 255];
  const water = [100, 204, 255, 255];
  const waterLight = [216, 249, 255, 255];
  const sprinkler = [214, 233, 213, 255];
  const sprinklerShadow = [37, 68, 43, 255];

  drawGrass(image, size, grassDark, grass, grassLight);

  const nozzle = [size * 0.5, size * 0.52];
  const streams = [
    { cp: [size * 0.26, size * 0.24], end: [size * 0.17, size * 0.42], radius: size * 0.026 },
    { cp: [size * 0.39, size * 0.18], end: [size * 0.32, size * 0.27], radius: size * 0.022 },
    { cp: [size * 0.61, size * 0.18], end: [size * 0.68, size * 0.27], radius: size * 0.022 },
    { cp: [size * 0.74, size * 0.24], end: [size * 0.83, size * 0.42], radius: size * 0.026 },
  ];

  for (const stream of streams) {
    drawQuadratic(image, size, nozzle, stream.cp, stream.end, size * 0.026, water, 0.92);
    drawCircle(image, size, stream.end[0], stream.end[1], stream.radius, waterLight, 0.98);
  }

  drawLine(image, size, size * 0.5, size * 0.52, size * 0.5, size * 0.25, size * 0.023, water, 0.92);
  drawCircle(image, size, size * 0.5, size * 0.22, size * 0.03, waterLight, 0.98);
  drawCircle(image, size, size * 0.23, size * 0.36, size * 0.017, waterLight, 0.84);
  drawCircle(image, size, size * 0.77, size * 0.36, size * 0.017, waterLight, 0.84);

  drawLine(image, size, size * 0.5, size * 0.74, size * 0.5, size * 0.56, size * 0.07, sprinklerShadow, 0.45);
  drawLine(image, size, size * 0.5, size * 0.72, size * 0.5, size * 0.55, size * 0.048, sprinkler, 1);
  drawRoundedRect(image, size, size * 0.5, size * 0.53, size * 0.22, size * 0.08, size * 0.034, sprinkler, 1);
  drawRoundedRect(image, size, size * 0.5, size * 0.75, size * 0.4, size * 0.11, size * 0.045, sprinklerShadow, 0.85);
  drawRoundedRect(image, size, size * 0.5, size * 0.73, size * 0.36, size * 0.09, size * 0.04, grassLight, 1);
  drawRoundedRect(image, size, size * 0.5, size * 0.73, size * 0.27, size * 0.034, size * 0.017, grassDark, 0.42);

  return image;
}

function drawGrass(image, size, grassDark, grass, grassLight) {
  const groundY = size * 0.82;
  drawRoundedRect(image, size, size * 0.5, groundY, size * 0.7, size * 0.13, size * 0.045, grassDark, 0.95);
  drawRoundedRect(image, size, size * 0.5, groundY - size * 0.025, size * 0.65, size * 0.045, size * 0.02, grass, 0.96);

  const blades = [
    [0.18, 0.78, 0.13, 0.64, 0.023],
    [0.25, 0.8, 0.25, 0.61, 0.026],
    [0.32, 0.79, 0.38, 0.64, 0.022],
    [0.42, 0.81, 0.4, 0.66, 0.021],
    [0.58, 0.81, 0.6, 0.66, 0.021],
    [0.68, 0.79, 0.62, 0.64, 0.022],
    [0.75, 0.8, 0.75, 0.61, 0.026],
    [0.82, 0.78, 0.87, 0.64, 0.023],
  ];

  for (const [x0, y0, x1, y1, width] of blades) {
    drawLine(image, size, size * x0, size * y0, size * x1, size * y1, size * width, grassLight, 0.98);
    drawLine(image, size, size * x0, size * y0, size * x1, size * y1, size * width * 0.45, grass, 0.9);
  }
}

function drawBackground(image, size) {
  const radius = size * 0.22;
  const border = Math.max(1.25, size * 0.035);
  const shadow = [5, 10, 6, 255];
  const fillA = [15, 33, 18, 255];
  const fillB = [31, 32, 31, 255];
  const borderColor = [64, 170, 70, 255];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sdf = roundedRectSdf(x + 0.5, y + 0.5, size / 2, size / 2, size * 0.92, size * 0.92, radius);
      const coverage = clamp(0.5 - sdf, 0, 1);
      if (coverage <= 0) continue;

      const t = y / Math.max(1, size - 1);
      const fill = mix(fillA, fillB, t);
      blendPixel(image, size, x, y, shadow, coverage * 0.22);
      blendPixel(image, size, x, y, fill, coverage);

      const edge = clamp((border + sdf) / border, 0, 1) * coverage;
      if (edge > 0) {
        blendPixel(image, size, x, y, borderColor, edge * 0.88);
      }
    }
  }
}

function drawRoundedRect(image, size, cx, cy, w, h, radius, color, opacity = 1) {
  const x0 = Math.max(0, Math.floor(cx - w / 2 - 2));
  const x1 = Math.min(size - 1, Math.ceil(cx + w / 2 + 2));
  const y0 = Math.max(0, Math.floor(cy - h / 2 - 2));
  const y1 = Math.min(size - 1, Math.ceil(cy + h / 2 + 2));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const sdf = roundedRectSdf(x + 0.5, y + 0.5, cx, cy, w, h, radius);
      const coverage = clamp(0.5 - sdf, 0, 1) * opacity;
      if (coverage > 0) blendPixel(image, size, x, y, color, coverage);
    }
  }
}

function drawQuadratic(image, size, p0, p1, p2, width, color, opacity = 1) {
  let previous = p0;
  for (let i = 1; i <= 28; i += 1) {
    const t = i / 28;
    const mt = 1 - t;
    const point = [
      mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
      mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1],
    ];
    drawLine(image, size, previous[0], previous[1], point[0], point[1], width, color, opacity);
    previous = point;
  }
}

function drawLine(image, size, x0, y0, x1, y1, width, color, opacity = 1) {
  const half = width / 2;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 2));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + half + 2));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 2));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + half + 2));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy || 1;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = clamp(((px - x0) * dx + (py - y0) * dy) / lengthSq, 0, 1);
      const nx = x0 + t * dx;
      const ny = y0 + t * dy;
      const distance = Math.hypot(px - nx, py - ny);
      const coverage = clamp(half + 0.5 - distance, 0, 1) * opacity;
      if (coverage > 0) blendPixel(image, size, x, y, color, coverage);
    }
  }
}

function drawCircle(image, size, cx, cy, radius, color, opacity = 1) {
  const x0 = Math.max(0, Math.floor(cx - radius - 2));
  const x1 = Math.min(size - 1, Math.ceil(cx + radius + 2));
  const y0 = Math.max(0, Math.floor(cy - radius - 2));
  const y1 = Math.min(size - 1, Math.ceil(cy + radius + 2));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = clamp(radius + 0.5 - distance, 0, 1) * opacity;
      if (coverage > 0) blendPixel(image, size, x, y, color, coverage);
    }
  }
}

function roundedRectSdf(x, y, cx, cy, w, h, radius) {
  const qx = Math.abs(x - cx) - w / 2 + radius;
  const qy = Math.abs(y - cy) - h / 2 + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function blendPixel(image, size, x, y, color, alpha) {
  const index = (y * size + x) * 4;
  const sourceAlpha = clamp(alpha * (color[3] / 255), 0, 1);
  const targetAlpha = image[index + 3] / 255;
  const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) return;

  for (let i = 0; i < 3; i += 1) {
    const source = color[i] / 255;
    const target = image[index + i] / 255;
    image[index + i] = Math.round(((source * sourceAlpha) + (target * targetAlpha * (1 - sourceAlpha))) / outAlpha * 255);
  }
  image[index + 3] = Math.round(outAlpha * 255);
}

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([
      u32(width),
      u32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  return Buffer.concat([
    u32(data.length),
    typeBuffer,
    data,
    u32(crc32(Buffer.concat([typeBuffer, data]))),
  ]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

await main();
