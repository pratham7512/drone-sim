import * as THREE from 'three';
import { Random } from '../engine/math';

export const MOON_DIRECTION = new THREE.Vector3(0.42, 0.34, -0.84).normalize();

const SKY_RADIUS = 640;
const SKYLINE_RADIUS = 560;
const SKYLINE_SECTIONS = 240;

/**
 * A humid north-Indian winter night, built as five depth layers:
 *
 *  1. a sodium-lit haze gradient behind everything,
 *  2. a thin crescent moon with earthshine and a halo,
 *  3. slow smoke banks and high cirrus under-lit by the city,
 *  4. a faint Milky Way and a magnitude-limited star field,
 *  5. a dark skyline ring with thousands of far windows and aviation lamps.
 *
 * The sky group follows the camera so every layer stays at infinity. The city
 * itself is drawn afterwards with depth, which lets the near mohalla occlude
 * the distant skyline correctly.
 */
export class Sky {
  readonly group = new THREE.Group();
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly starsMaterial: THREE.ShaderMaterial;
  private skylineMaterial!: THREE.ShaderMaterial;
  private skylineLightsMaterial!: THREE.ShaderMaterial;
  private skylineTops!: Float32Array;
  private skylineTowers: Array<{ azimuth: number; top: number }> = [];
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private elapsed = 0;

  constructor(pixelRatio: number) {
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMoonDirection: { value: MOON_DIRECTION.clone() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;

        void main() {
          vec3 worldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
          vDirection = normalize(worldPosition - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * vec4(worldPosition, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uMoonDirection;
        varying vec3 vDirection;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbm(vec2 p) {
          float value = 0.0;
          float amplitude = 0.52;
          for (int i = 0; i < 4; i++) {
            value += amplitude * noise(p);
            p = p * 2.03 + vec2(17.1, 9.2);
            amplitude *= 0.5;
          }
          return value;
        }

        void main() {
          vec3 direction = normalize(vDirection);
          float height = clamp(direction.y, 0.0, 1.0);
          float azimuth = atan(direction.z, direction.x);

          // A near-black cobalt zenith over a wide, warm sodium horizon.
          vec3 zenith = vec3(0.0010, 0.0020, 0.0068);
          vec3 upper = vec3(0.0030, 0.0056, 0.0165);
          vec3 middle = vec3(0.0080, 0.0110, 0.0270);
          vec3 horizon = vec3(0.0700, 0.0360, 0.0210);

          vec3 color = mix(horizon, middle, smoothstep(0.0, 0.11, height));
          color = mix(color, upper, smoothstep(0.08, 0.42, height));
          color = mix(color, zenith, smoothstep(0.38, 0.95, height));

          // Light pollution varies around the horizon: denser bazaars one way,
          // darker fields the other. This is what stops the glow reading as a
          // perfect gradient.
          float sector = 0.52 + 0.48 * noise(vec2(azimuth * 1.7 + 11.0, 3.4));
          float lowGlow = exp(-height * 15.0);
          color += vec3(0.058, 0.024, 0.0085) * lowGlow * sector;

          // Faint airglow high up, an almost imperceptible green-violet lift.
          color += vec3(0.0018, 0.0030, 0.0045)
            * smoothstep(0.45, 1.0, height)
            * (0.7 + 0.3 * noise(vec2(azimuth * 3.0, height * 5.0)));

          // Milky Way: a soft, dusty band with dark rifts.
          vec3 galacticNormal = normalize(vec3(0.25, 0.34, 0.90));
          float band = exp(-pow(dot(direction, galacticNormal) * 2.55, 2.0));
          vec2 galacticUv = vec2(azimuth * 4.2, height * 7.5);
          float dust = fbm(galacticUv * 1.6 + 13.0);
          float rift = smoothstep(0.32, 0.56, fbm(galacticUv * 3.4 + 7.0));
          color += vec3(0.012, 0.010, 0.014)
            * band
            * smoothstep(0.22, 0.62, dust)
            * (1.0 - rift * 0.75)
            * smoothstep(0.02, 0.22, height);

          // Two drifting smoke layers. The low bank is broad smog; the high
          // layer is wispy cirrus catching the last of the city light.
          vec2 smokeUv = vec2(azimuth * 2.1 + uTime * 0.0022, height * 10.0 - uTime * 0.0013);
          float smokeWarp = fbm(smokeUv * 0.55 + 3.0);
          float smoke = fbm(smokeUv * 1.2 + vec2(smokeWarp * 1.4, smokeWarp * 0.5));
          smoke = smoothstep(0.44, 0.72, smoke)
            * smoothstep(0.005, 0.075, height)
            * (1.0 - smoothstep(0.34, 0.60, height));

          vec2 cirrusUv = vec2(azimuth * 3.4 - uTime * 0.0011, height * 6.2 + uTime * 0.0007);
          float cirrus = fbm(cirrusUv + fbm(cirrusUv * 0.6) * 1.1);
          cirrus = smoothstep(0.54, 0.78, cirrus)
            * smoothstep(0.08, 0.24, height)
            * (1.0 - smoothstep(0.62, 0.92, height));

          float lowLight = exp(-height * 7.0);
          vec3 smokeColor = mix(vec3(0.017, 0.019, 0.026), vec3(0.105, 0.052, 0.027), lowLight);
          vec3 cirrusColor = mix(vec3(0.021, 0.024, 0.032), vec3(0.070, 0.046, 0.033), lowLight * 0.8);
          color = mix(color, smokeColor, smoke * 0.8);
          color = mix(color, cirrusColor, cirrus * 0.5);

          // The moon: a 1.6-degree waning crescent, textured and hazed over.
          vec3 moonRight = normalize(cross(uMoonDirection, vec3(0.0, 1.0, 0.0)));
          vec3 moonUp = normalize(cross(moonRight, uMoonDirection));
          vec2 moonPoint = vec2(
            dot(direction, moonRight),
            dot(direction, moonUp)
          ) / 0.014;
          float moonRadius = length(moonPoint);
          float moonDisc = smoothstep(1.0, 0.93, moonRadius);
          float moonShadow = smoothstep(1.02, 0.94, length(moonPoint - vec2(0.52, 0.08)));
          float crescent = moonDisc * (1.0 - moonShadow);

          float crater = fbm(moonPoint * 3.2 + 4.0);
          vec3 moonColor = mix(vec3(0.66, 0.60, 0.48), vec3(0.98, 0.92, 0.78), crater);
          float moonVisibility = 1.0 - smoke * 0.55 - cirrus * 0.4;
          color += moonColor * crescent * 1.35 * moonVisibility;

          // Earthshine on the unlit limb and the atmospheric halo.
          float earthshine = smoothstep(1.18, 0.98, moonRadius) * (1.0 - crescent);
          color += vec3(0.012, 0.014, 0.018) * earthshine * moonVisibility;

          float halo = exp(-moonRadius * moonRadius * 0.16) * 0.10
            + exp(-moonRadius * moonRadius * 3.2) * 0.20;
          color += vec3(0.23, 0.19, 0.13) * halo * moonVisibility;

          // A hint of warm firework smoke high above the mohalla.
          float burstGlow = exp(-height * 5.0)
            * smoothstep(0.6, 0.9, noise(vec2(azimuth * 6.0 + uTime * 0.01, uTime * 0.02)));
          color += vec3(0.020, 0.008, 0.004) * burstGlow;

          // Dither at quantization scale, avoiding visible banding on OLEDs.
          float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
          gl_FragColor = vec4(color + dither, 1.0);

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    const sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 28), this.skyMaterial);
    sky.name = 'night-sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    this.group.add(sky);

    const skyline = this.createSkyline();
    skyline.name = 'distant-skyline';
    skyline.frustumCulled = false;
    skyline.renderOrder = -960;
    this.group.add(skyline);

    const skylineLights = this.createSkylineLights(pixelRatio);
    skylineLights.name = 'distant-skyline-lights';
    skylineLights.frustumCulled = false;
    skylineLights.renderOrder = -950;
    this.skylineLightsMaterial = skylineLights.material as THREE.ShaderMaterial;
    this.group.add(skylineLights);

    this.starsMaterial = this.createStars(pixelRatio);
    const stars = this.starsMaterial.userData.points as THREE.Points;
    stars.renderOrder = -970;
    this.group.add(stars);
  }

  update(deltaSeconds: number, cameraPosition?: THREE.Vector3): void {
    if (cameraPosition) this.group.position.copy(cameraPosition);
    this.elapsed += deltaSeconds;
    this.skyMaterial.uniforms.uTime!.value = this.elapsed;
    this.starsMaterial.uniforms.uTime!.value = this.elapsed;
    this.skylineLightsMaterial.uniforms.uTime!.value = this.elapsed;
  }

  /**
   * A ring of flat-roofed building runs. Each run holds one roof height, so
   * the horizon steps like real rooftops instead of rolling like hills. Gaps
   * between runs read as glowing street corridors, while rooftop boxes, a
   * temple spire and a pair of minarets break the parapet line.
   */
  private createSkyline(): THREE.Mesh {
    const random = new Random(0x5c1f11);
    const tops = new Float32Array(SKYLINE_SECTIONS);
    const runs: Array<{ start: number; end: number; top: number; shade: number }> = [];

    let cursor = 0;
    while (cursor < SKYLINE_SECTIONS) {
      const end = Math.min(cursor + random.int(2, 8), SKYLINE_SECTIONS);
      const roll = random.next();
      let top = random.range(2.2, 5.6);
      if (roll > 0.955) top = random.range(30, 44);
      else if (roll > 0.78) top = random.range(16, 27);
      else if (roll > 0.45) top = random.range(8, 14);
      runs.push({ start: cursor, end, top, shade: random.range(0.78, 1.14) });
      for (let index = cursor; index < end; index += 1) tops[index] = top;
      cursor = end;
      if (random.next() < 0.2 && cursor < SKYLINE_SECTIONS - 3) {
        cursor += random.int(1, 2);
      }
    }

    // The tallest runs carry red aviation beacons.
    this.skylineTowers = runs
      .filter((run) => run.top >= 30)
      .sort((a, b) => b.top - a.top)
      .slice(0, 4)
      .map((run) => ({
        azimuth: (((run.start + run.end) * 0.5) / SKYLINE_SECTIONS) * Math.PI * 2,
        top: run.top,
      }));

    const positions: number[] = [];
    const edges: number[] = [];
    const topAttributes: number[] = [];
    const shades: number[] = [];
    const baseY = -160;

    const pushVertex = (
      x: number,
      y: number,
      z: number,
      edge: number,
      top: number,
      shade: number,
    ): void => {
      positions.push(x, y, z);
      edges.push(edge);
      topAttributes.push(top);
      shades.push(shade);
    };

    for (const run of runs) {
      for (let index = run.start; index < run.end; index += 1) {
        const a0 = (index / SKYLINE_SECTIONS) * Math.PI * 2;
        const a1 = ((index + 1) / SKYLINE_SECTIONS) * Math.PI * 2;
        const x0 = Math.cos(a0) * SKYLINE_RADIUS;
        const z0 = Math.sin(a0) * SKYLINE_RADIUS;
        const x1 = Math.cos(a1) * SKYLINE_RADIUS;
        const z1 = Math.sin(a1) * SKYLINE_RADIUS;
        const leftEdge = index === run.start ? 1 : 0;
        const rightEdge = index === run.end - 1 ? 1 : 0;

        pushVertex(x0, baseY, z0, leftEdge, run.top, run.shade);
        pushVertex(x1, baseY, z1, rightEdge, run.top, run.shade);
        pushVertex(x1, run.top, z1, rightEdge, run.top, run.shade);
        pushVertex(x0, baseY, z0, leftEdge, run.top, run.shade);
        pushVertex(x1, run.top, z1, rightEdge, run.top, run.shade);
        pushVertex(x0, run.top, z0, leftEdge, run.top, run.shade);
      }

      // A parapet box or water tank on part of the roof, pulled 1.2 m toward
      // the camera so it breaks the roofline against the sky.
      if (run.end - run.start >= 2 && random.next() < 0.55) {
        const span = run.end - run.start;
        const start = run.start + random.int(0, Math.max(1, span - 1));
        const end = Math.min(run.end, start + random.int(1, 2));
        const bumpHeight = random.range(0.7, 1.9) * (run.top > 12 ? 1.6 : 1);
        const radius = SKYLINE_RADIUS - 1.2;
        const a0 = (start / SKYLINE_SECTIONS) * Math.PI * 2;
        const a1 = (end / SKYLINE_SECTIONS) * Math.PI * 2;
        const x0 = Math.cos(a0) * radius;
        const z0 = Math.sin(a0) * radius;
        const x1 = Math.cos(a1) * radius;
        const z1 = Math.sin(a1) * radius;
        const top = run.top + bumpHeight;
        const shade = run.shade * 0.7;
        pushVertex(x0, run.top - 0.4, z0, 0, top, shade);
        pushVertex(x1, run.top - 0.4, z1, 0, top, shade);
        pushVertex(x1, top, z1, 0, top, shade);
        pushVertex(x0, run.top - 0.4, z0, 0, top, shade);
        pushVertex(x1, top, z1, 0, top, shade);
        pushVertex(x0, top, z0, 0, top, shade);
      }
    }

    // Landmark silhouettes, placed on low runs so they read against the sky.
    const lowRuns = runs.filter((run) => run.top < 9);
    const spireRun = lowRuns[Math.floor(lowRuns.length * 0.36)] ?? runs[0]!;
    const spireAngle = (((spireRun.start + spireRun.end) * 0.5) / SKYLINE_SECTIONS) * Math.PI * 2;
    const spireBase = spireRun.top - 0.6;
    const spireRadius = SKYLINE_RADIUS - 1.8;
    const spireHalf = 0.014;
    const spireShade = 0.7;
    pushVertex(
      Math.cos(spireAngle - spireHalf) * spireRadius,
      spireBase,
      Math.sin(spireAngle - spireHalf) * spireRadius,
      0,
      spireBase + 9,
      spireShade,
    );
    pushVertex(
      Math.cos(spireAngle + spireHalf) * spireRadius,
      spireBase,
      Math.sin(spireAngle + spireHalf) * spireRadius,
      0,
      spireBase + 9,
      spireShade,
    );
    pushVertex(
      Math.cos(spireAngle) * spireRadius,
      spireBase + 9,
      Math.sin(spireAngle) * spireRadius,
      0,
      spireBase + 9,
      spireShade,
    );

    const minaretRun = lowRuns[Math.floor(lowRuns.length * 0.74)] ?? runs[Math.floor(runs.length * 0.7)]!;
    const minaretAngle = (((minaretRun.start + minaretRun.end) * 0.5) / SKYLINE_SECTIONS) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const angle = minaretAngle + side * 0.008;
      const radius = SKYLINE_RADIUS - 1.5;
      const half = 0.0026;
      const top = minaretRun.top + 14;
      for (const offset of [-half, half]) {
        pushVertex(
          Math.cos(angle + offset) * radius,
          minaretRun.top - 0.5,
          Math.sin(angle + offset) * radius,
          0,
          top,
          0.66,
        );
      }
      pushVertex(
        Math.cos(angle + half) * radius,
        top,
        Math.sin(angle + half) * radius,
        0,
        top,
        0.66,
      );
      pushVertex(
        Math.cos(angle - half) * radius,
        minaretRun.top - 0.5,
        Math.sin(angle - half) * radius,
        0,
        top,
        0.66,
      );
      pushVertex(
        Math.cos(angle + half) * radius,
        top,
        Math.sin(angle + half) * radius,
        0,
        top,
        0.66,
      );
      pushVertex(
        Math.cos(angle - half) * radius,
        top,
        Math.sin(angle - half) * radius,
        0,
        top,
        0.66,
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
    geometry.setAttribute('aTop', new THREE.Float32BufferAttribute(topAttributes, 1));
    geometry.setAttribute('aShade', new THREE.Float32BufferAttribute(shades, 1));

    this.skylineTops = tops;

    this.skylineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aEdge;
        attribute float aTop;
        attribute float aShade;
        varying float vY;
        varying float vAzimuth;
        varying float vEdge;
        varying float vTop;
        varying float vShade;

        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vY = position.y;
          vAzimuth = atan(position.z, position.x);
          vEdge = aEdge;
          vTop = aTop;
          vShade = aShade;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vY;
        varying float vAzimuth;
        varying float vEdge;
        varying float vTop;
        varying float vShade;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          float altitude = max(vY, 0.0);
          // Silhouettes sit just below the sky in value. Bases melt into the
          // horizon haze and roof edges pick up a little sodium light.
          vec3 base = vec3(0.0052, 0.0057, 0.0078);
          vec3 warm = vec3(0.0300, 0.0195, 0.0135);
          float haze = exp(-altitude * 0.075);
          vec3 color = mix(base, warm, haze * 0.9) * vShade;

          // The top metre of every facade catches skyglow; vertical corners
          // stay a touch darker than the face so runs separate.
          float roofBand = smoothstep(1.7, 0.0, abs(vY - vTop));
          color += vec3(0.0200, 0.0120, 0.0062) * roofBand * haze * 0.5;
          color *= 1.0 - vEdge * 0.16;

          // Occasional lit parapet and water-tank highlights.
          float edge = smoothstep(0.78, 1.0, hash21(vec2(floor(vAzimuth * 900.0), floor(altitude * 0.4))));
          color += vec3(0.010, 0.006, 0.003) * edge * 0.4;

          gl_FragColor = vec4(color, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    return new THREE.Mesh(geometry, this.skylineMaterial);
  }

  private createSkylineLights(pixelRatio: number): THREE.Points {
    const random = new Random(0x3a7712);
    const beaconCount = this.skylineTowers.length;
    const count = 2400 + beaconCount;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const blinks = new Float32Array(count);
    const tint = new THREE.Color();

    for (let index = 0; index < 2400; index += 1) {
      let angle = random.range(0, Math.PI * 2);
      let section = Math.floor((angle / (Math.PI * 2)) * SKYLINE_SECTIONS) % SKYLINE_SECTIONS;
      let top = this.skylineTops[section] ?? 0;
      // Never float a window above a roof or inside a street gap: retry the
      // angle until it lands on a built-up section.
      for (let attempt = 0; attempt < 4 && top <= 0.5; attempt += 1) {
        angle = random.range(0, Math.PI * 2);
        section = Math.floor((angle / (Math.PI * 2)) * SKYLINE_SECTIONS) % SKYLINE_SECTIONS;
        top = this.skylineTops[section] ?? 0;
      }
      if (top <= 0.5) top = 6;

      const radius = SKYLINE_RADIUS - 1.5;
      const y = random.range(0.5, Math.max(1.4, top - 0.9));
      positions[index * 3] = Math.cos(angle) * radius;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = Math.sin(angle) * radius;

      const roll = random.next();
      if (roll > 0.995) tint.setRGB(1.0, 0.2, 0.12);
      else if (roll > 0.93) tint.setRGB(0.62, 0.78, 1.0);
      else if (roll > 0.84) tint.setRGB(0.84, 0.89, 0.94);
      else tint.setRGB(1.0, random.range(0.42, 0.68), random.range(0.16, 0.3));
      const brightness = random.range(0.22, 0.9);
      colors[index * 3] = tint.r * brightness;
      colors[index * 3 + 1] = tint.g * brightness;
      colors[index * 3 + 2] = tint.b * brightness;
      sizes[index] = random.range(0.8, 2.6);
      phases[index] = random.range(0, Math.PI * 2);
    }

    // Slow red aviation beacons exactly on the tallest rooftops.
    this.skylineTowers.forEach((tower, beacon) => {
      const index = 2400 + beacon;
      const radius = SKYLINE_RADIUS - 0.8;
      positions[index * 3] = Math.cos(tower.azimuth) * radius;
      positions[index * 3 + 1] = tower.top + 1.3;
      positions[index * 3 + 2] = Math.sin(tower.azimuth) * radius;
      colors[index * 3] = 1.0;
      colors[index * 3 + 1] = 0.12;
      colors[index * 3 + 2] = 0.08;
      sizes[index] = 3.1;
      phases[index] = random.range(0, Math.PI * 2);
      blinks[index] = 1;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aBlink', new THREE.BufferAttribute(blinks, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(pixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uPixelRatio;
        attribute vec3 color;
        attribute float aSize;
        attribute float aPhase;
        attribute float aBlink;
        varying vec3 vColor;

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = aSize * uPixelRatio;
          float flicker = 0.85 + 0.15 * sin(uTime * 0.7 + aPhase * 7.0);
          float beacon = pow(0.5 + 0.5 * sin(uTime * 1.35 + aPhase), 5.0);
          vColor = color * mix(flicker, beacon, aBlink);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;

        void main() {
          float distanceToCenter = length(gl_PointCoord - vec2(0.5));
          float alpha = smoothstep(0.5, 0.06, distanceToCenter);
          if (alpha < 0.02) discard;
          gl_FragColor = vec4(vColor, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    return new THREE.Points(geometry, material);
  }

  private createStars(pixelRatio: number): THREE.ShaderMaterial {
    const random = new Random(0x57a71a);
    const count = 760;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const tint = new THREE.Color();

    for (let index = 0; index < count; index += 1) {
      const y = Math.pow(random.next(), 0.72) * 0.95 + 0.028;
      const radius = Math.sqrt(1 - y * y);
      const angle = random.range(0, Math.PI * 2);
      positions[index * 3] = Math.cos(angle) * radius * 610;
      positions[index * 3 + 1] = y * 610;
      positions[index * 3 + 2] = Math.sin(angle) * radius * 610;

      const roll = random.next();
      if (roll > 0.91) tint.setRGB(1.0, 0.58, 0.34);
      else if (roll > 0.8) tint.setRGB(0.62, 0.76, 1.0);
      else tint.setRGB(0.86, 0.9, 1.0);
      const brightness = Math.pow(random.next(), 1.7);
      colors[index * 3] = tint.r * (0.35 + brightness * 0.65);
      colors[index * 3 + 1] = tint.g * (0.35 + brightness * 0.65);
      colors[index * 3 + 2] = tint.b * (0.35 + brightness * 0.65);
      sizes[index] = 0.45 + Math.pow(random.next(), 2.2) * 2.2;
      phases[index] = random.range(0, Math.PI * 2);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(pixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uPixelRatio;
        attribute vec3 color;
        attribute float aSize;
        attribute float aPhase;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;

          float twinkle = 0.74 + 0.26 * sin(uTime * 0.42 + aPhase * 9.0);
          gl_PointSize = aSize * uPixelRatio * (0.9 + 0.1 * twinkle);
          vColor = color;
          vAlpha = smoothstep(-10.0, 120.0, position.y) * 0.72 * twinkle;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          float distanceToCenter = length(gl_PointCoord - vec2(0.5));
          float alpha = smoothstep(0.5, 0.05, distanceToCenter) * vAlpha;
          if (alpha < 0.008) discard;
          gl_FragColor = vec4(vColor, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'stars';
    points.frustumCulled = false;
    points.renderOrder = -900;
    material.userData.points = points;
    return material;
  }

  /**
   * Bakes the procedural sky into a small PMREM cubemap. Standard materials
   * then receive physically plausible sky/ground ambient instead of a flat
   * hemisphere fill: warm at the horizon, cobalt overhead, and enough
   * directional variation to keep plaster and asphalt from reading as paper.
   */
  createEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const material = this.skyMaterial.clone();
    material.side = THREE.BackSide;
    material.depthWrite = false;
    material.depthTest = false;

    const geometry = new THREE.SphereGeometry(20, 32, 20);
    const mesh = new THREE.Mesh(geometry, material);
    const scene = new THREE.Scene();
    scene.add(mesh);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environmentTarget = pmrem.fromScene(scene, 0.08, 0.1, 120);
    pmrem.dispose();
    geometry.dispose();
    material.dispose();

    return this.environmentTarget.texture;
  }

  dispose(): void {
    this.environmentTarget?.dispose();
    this.skyMaterial.dispose();
    this.starsMaterial.dispose();
    this.skylineMaterial.dispose();
    this.skylineLightsMaterial.dispose();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry.dispose();
      }
    });
  }
}
