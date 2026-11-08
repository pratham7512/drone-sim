import * as THREE from 'three';
import { Random } from '../engine/math';

export interface ProceduralTextures {
  wall: THREE.CanvasTexture;
  roof: THREE.CanvasTexture;
  wood: THREE.CanvasTexture;
  glow: THREE.CanvasTexture;
  rangoli: THREE.CanvasTexture;
}

/**
 * Procedural stand-ins for the eventual photo atlas. They deliberately include
 * grime, patched plaster, seams and paint loss so that the night lighting has
 * something to catch. Replacing these with a KTX2 photo atlas later should not
 * require material changes (same maps, same UV scale).
 */
export function createProceduralTextures(maxAnisotropy: number): ProceduralTextures {
  return {
    wall: createWallTexture(maxAnisotropy),
    roof: createRoofTexture(maxAnisotropy),
    wood: createWoodTexture(maxAnisotropy),
    glow: createGlowTexture(),
    rangoli: createRangoliTexture(maxAnisotropy),
  };
}

function createCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  return { canvas, context };
}

function makeTexture(
  canvas: HTMLCanvasElement,
  anisotropy: number,
  repeatX = 1,
  repeatY = 1,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = Math.max(1, Math.min(8, anisotropy));
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function addFineNoise(
  context: CanvasRenderingContext2D,
  random: Random,
  strength: number,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const x = random.range(0, 512);
    const y = random.range(0, 512);
    const alpha = random.range(0.015, 0.075);
    const value = random.next() > 0.5 ? 255 : 0;
    context.fillStyle = `rgba(${value}, ${value - 6}, ${value - 14}, ${alpha * strength})`;
    const size = random.range(0.4, 2.4);
    context.fillRect(x, y, size, size);
  }
}

function drawCracks(
  context: CanvasRenderingContext2D,
  random: Random,
  count: number,
  alpha: number,
): void {
  for (let i = 0; i < count; i += 1) {
    let x = random.range(0, 512);
    let y = random.range(0, 512);
    const segments = random.int(3, 8);
    context.beginPath();
    context.moveTo(x, y);
    for (let segment = 0; segment < segments; segment += 1) {
      x += random.range(-13, 13);
      y += random.range(3, 18);
      context.lineTo(x, y);
    }
    context.strokeStyle = `rgba(25, 20, 15, ${alpha * random.range(0.4, 1)})`;
    context.lineWidth = random.range(0.35, 1.2);
    context.stroke();
  }
}

function createWallTexture(anisotropy: number): THREE.CanvasTexture {
  const random = new Random(0x0d1a1e);
  const { canvas, context } = createCanvas(512);

  context.fillStyle = '#80715f';
  context.fillRect(0, 0, 512, 512);

  // Broad lime-wash mottling.
  for (let i = 0; i < 34; i += 1) {
    const x = random.range(0, 512);
    const y = random.range(0, 512);
    const radius = random.range(18, 132);
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    const light = random.next() > 0.45;
    gradient.addColorStop(0, light ? 'rgba(180, 165, 139, 0.13)' : 'rgba(39, 33, 27, 0.16)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = gradient;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  // Bands of older paint and the odd exposed plaster scar.
  context.fillStyle = 'rgba(122, 102, 77, 0.18)';
  context.fillRect(0, 372, 512, 140);
  for (let i = 0; i < 8; i += 1) {
    const x = random.range(0, 512);
    const y = random.range(320, 500);
    context.beginPath();
    context.ellipse(
      x,
      y,
      random.range(15, 62),
      random.range(8, 35),
      random.range(-0.5, 0.5),
      0,
      Math.PI * 2,
    );
    context.fillStyle = `rgba(153, 137, 112, ${random.range(0.05, 0.16)})`;
    context.fill();
  }

  // Water streaks from the parapet.
  for (let i = 0; i < 22; i += 1) {
    const x = random.range(0, 512);
    const width = random.range(1, 8);
    const height = random.range(45, 265);
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `rgba(34, 31, 28, ${random.range(0.04, 0.16)})`);
    gradient.addColorStop(0.7, 'rgba(31, 28, 25, 0.02)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = gradient;
    context.fillRect(x, 0, width, height);
  }

  addFineNoise(context, random, 1.5, 10_500);
  drawCracks(context, random, 13, 0.2);

  // Faint brick courses under worn patches.
  context.globalAlpha = 0.09;
  context.strokeStyle = '#2c211a';
  context.lineWidth = 1;
  for (let row = 0; row < 4; row += 1) {
    const y = 420 + row * 16;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(512, y);
    context.stroke();
  }
  context.globalAlpha = 1;

  return makeTexture(canvas, anisotropy, 1.6, 1.4);
}

function createRoofTexture(anisotropy: number): THREE.CanvasTexture {
  const random = new Random(0x51ee77);
  const { canvas, context } = createCanvas(512);

  context.fillStyle = '#77736d';
  context.fillRect(0, 0, 512, 512);

  for (let i = 0; i < 42; i += 1) {
    const x = random.range(0, 512);
    const y = random.range(0, 512);
    const radius = random.range(15, 94);
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, random.next() > 0.5 ? 'rgba(167, 159, 146, 0.12)' : 'rgba(40, 39, 38, 0.17)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = gradient;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  addFineNoise(context, random, 2.4, 16_000);
  drawCracks(context, random, 17, 0.22);

  // Expansion joints and grout, heavily worn.
  context.strokeStyle = 'rgba(38, 37, 35, 0.28)';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(0, 256);
  context.lineTo(512, 256);
  context.moveTo(256, 0);
  context.lineTo(256, 512);
  context.stroke();

  context.strokeStyle = 'rgba(192, 183, 167, 0.08)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, 252);
  context.lineTo(512, 252);
  context.moveTo(252, 0);
  context.lineTo(252, 512);
  context.stroke();

  return makeTexture(canvas, anisotropy, 3.6, 3.2);
}

function createWoodTexture(anisotropy: number): THREE.CanvasTexture {
  const random = new Random(0xacab12);
  const { canvas, context } = createCanvas(256);

  context.fillStyle = '#3c2a20';
  context.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 150; i += 1) {
    const y = random.range(0, 256);
    context.beginPath();
    context.moveTo(0, y);
    context.bezierCurveTo(70, y + random.range(-8, 8), 180, y + random.range(-8, 8), 256, y);
    context.strokeStyle = `rgba(${random.int(18, 50)}, ${random.int(14, 35)}, ${random.int(11, 28)}, ${random.range(0.04, 0.14)})`;
    context.lineWidth = random.range(0.4, 2.4);
    context.stroke();
  }

  addFineNoise(context, random, 1.2, 2600);

  context.fillStyle = 'rgba(108, 67, 42, 0.18)';
  context.fillRect(0, 0, 256, 5);
  context.fillRect(0, 250, 256, 6);

  return makeTexture(canvas, anisotropy, 1, 1);
}

/**
 * A flat, hand-drawn rangoli for the terrace floor. The canvas is transparent
 * outside the powder pattern so the roof's grime still reads underneath. It
 * will be replaced by the shared festive decal atlas later.
 */
function createRangoliTexture(anisotropy: number): THREE.CanvasTexture {
  const random = new Random(0x5a1a0d);
  const size = 1024;
  const { canvas, context } = createCanvas(size);
  const center = size / 2;

  const ivory = 'rgba(255, 231, 187, 0.92)';
  const marigold = 'rgba(238, 150, 49, 0.9)';
  const vermilion = 'rgba(196, 57, 35, 0.86)';
  const rose = 'rgba(201, 54, 94, 0.8)';
  const leaf = 'rgba(74, 128, 78, 0.78)';

  context.translate(center, center);
  context.lineCap = 'round';

  const ring = (radius: number, width: number, style: string, alpha = 1): void => {
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.lineWidth = width;
    context.strokeStyle = style;
    context.globalAlpha = alpha;
    context.stroke();
    context.globalAlpha = 1;
  };

  // Worn outer border: two rings with a scatter of powder between them.
  ring(474, 7, ivory, 0.7);
  ring(446, 4, marigold, 0.8);
  ring(352, 3, ivory, 0.4);
  ring(196, 3, ivory, 0.4);

  context.save();
  context.rotate(Math.PI / 16);
  for (let index = 0; index < 16; index += 1) {
    context.rotate((Math.PI * 2) / 16);
    context.beginPath();
    context.arc(0, -421, 15, 0, Math.PI * 2);
    context.fillStyle = index % 2 === 0 ? vermilion : marigold;
    context.globalAlpha = 0.72;
    context.fill();
  }
  context.restore();
  context.globalAlpha = 1;

  // A ring of sixteen lotus petals.
  const petal = (inner: number, outer: number, halfWidth: number, fill: string): void => {
    context.beginPath();
    context.moveTo(0, -inner);
    context.bezierCurveTo(
      halfWidth,
      -(inner + (outer - inner) * 0.38),
      halfWidth * 0.72,
      -outer,
      0,
      -outer,
    );
    context.bezierCurveTo(
      -halfWidth * 0.72,
      -outer,
      -halfWidth,
      -(inner + (outer - inner) * 0.38),
      0,
      -inner,
    );
    context.closePath();
    context.fillStyle = fill;
    context.globalAlpha = 0.8;
    context.fill();
    context.globalAlpha = 1;
    context.lineWidth = 2;
    context.strokeStyle = 'rgba(255, 227, 176, 0.55)';
    context.stroke();
  };

  for (let index = 0; index < 16; index += 1) {
    context.save();
    context.rotate((Math.PI * 2 * index) / 16);
    petal(258, 404, 45, index % 2 === 0 ? marigold : vermilion);
    context.restore();
  }

  // Inner eight-petal flower and a marigold heart.
  for (let index = 0; index < 8; index += 1) {
    context.save();
    context.rotate((Math.PI * 2 * index) / 8 + Math.PI / 8);
    petal(86, 206, 50, index % 2 === 0 ? rose : marigold);
    context.restore();
  }

  ring(86, 5, ivory, 0.7);
  ring(48, 3, leaf, 0.8);

  context.beginPath();
  context.arc(0, 0, 31, 0, Math.PI * 2);
  context.fillStyle = marigold;
  context.globalAlpha = 0.94;
  context.fill();
  context.globalAlpha = 1;

  // Small dots of powder between the petals, plus the little imperfections of
  // a pattern drawn by hand on rough concrete.
  for (let index = 0; index < 32; index += 1) {
    context.save();
    context.rotate((Math.PI * 2 * index) / 32 + Math.PI / 32);
    context.beginPath();
    context.arc(0, -244, 5.5, 0, Math.PI * 2);
    context.fillStyle = index % 3 === 0 ? leaf : ivory;
    context.globalAlpha = 0.65;
    context.fill();
    context.restore();
  }
  context.globalAlpha = 1;

  for (let index = 0; index < 460; index += 1) {
    const angle = random.range(0, Math.PI * 2);
    const radius = random.range(40, 466);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const palette = [ivory, marigold, vermilion, rose, leaf];
    context.beginPath();
    context.arc(x, y, random.range(1, 4), 0, Math.PI * 2);
    context.fillStyle = palette[random.int(0, palette.length)] ?? marigold;
    context.globalAlpha = random.range(0.1, 0.42);
    context.fill();
  }
  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.max(1, Math.min(8, anisotropy));
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

/** Soft radial mask used as an additive stand-in for bloom on tiny lights. */
function createGlowTexture(): THREE.CanvasTexture {  const size = 128;
  const { canvas, context } = createCanvas(size);
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 238, 203, 1)');
  gradient.addColorStop(0.1, 'rgba(255, 218, 158, 0.72)');
  gradient.addColorStop(0.3, 'rgba(255, 162, 70, 0.23)');
  gradient.addColorStop(0.65, 'rgba(255, 130, 40, 0.055)');
  gradient.addColorStop(1, 'rgba(255, 120, 30, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}
