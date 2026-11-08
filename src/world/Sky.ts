import * as THREE from 'three';
import { Random } from '../engine/math';

/**
 * New-moon Diwali sky: almost no direct moon, a low sodium-orange city glow,
 * and a thin smoky band that softens the horizon. A small point-star layer adds
 * depth without looking like a postcard.
 */
export class Sky {
  readonly group = new THREE.Group();
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly starsMaterial: THREE.ShaderMaterial;
  private elapsed = 0;

  constructor(pixelRatio: number) {
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
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
        varying vec3 vDirection;

        // Cheap value noise, used only for broad haze shapes.
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
          float amplitude = 0.5;
          for (int i = 0; i < 3; i++) {
            value += amplitude * noise(p);
            p = p * 2.03 + 17.1;
            amplitude *= 0.5;
          }
          return value;
        }

        void main() {
          vec3 direction = normalize(vDirection);
          float height = clamp(direction.y, 0.0, 1.0);
          float azimuth = atan(direction.z, direction.x);

          // Linear-space palette: near-black cobalt zenith, warm smog horizon.
          vec3 zenith = vec3(0.0015, 0.0028, 0.0090);
          vec3 middle = vec3(0.0080, 0.0130, 0.0320);
          vec3 horizon = vec3(0.0550, 0.0310, 0.0180);

          vec3 color = mix(horizon, middle, smoothstep(0.0, 0.16, height));
          color = mix(color, zenith, smoothstep(0.10, 0.78, height));

          // Broken bands of warm light pollution behind the rooftops.
          float glowVariation = 0.45 + 0.55 * noise(vec2(azimuth * 2.4 + 4.0, 2.7));
          float lowGlow = exp(-height * 13.0);
          color += vec3(0.060, 0.026, 0.010) * lowGlow * glowVariation;

          // Drifting smoke / winter haze, most legible just above the horizon.
          vec2 hazeUv = vec2(azimuth * 1.6 + uTime * 0.0025, height * 11.0 - uTime * 0.0035);
          float haze = fbm(hazeUv);
          haze = smoothstep(0.42, 0.78, haze) * exp(-height * 6.5);
          color += vec3(0.019, 0.013, 0.010) * haze;

          // A barely-there purple bloom high in the sky keeps the zenith alive.
          color += vec3(0.0045, 0.0028, 0.0085) * smoothstep(0.35, 0.95, height) * (0.7 + 0.3 * noise(hazeUv * 0.35));

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

    const sky = new THREE.Mesh(new THREE.SphereGeometry(640, 32, 20), this.skyMaterial);
    sky.name = 'night-sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    this.group.add(sky);

    this.starsMaterial = this.createStars(pixelRatio);
    this.group.add(this.starsMaterial.userData.points as THREE.Points);
  }

  update(deltaSeconds: number): void {
    this.elapsed += deltaSeconds;
    this.skyMaterial.uniforms.uTime!.value = this.elapsed;
    this.starsMaterial.uniforms.uTime!.value = this.elapsed;
  }

  private createStars(pixelRatio: number): THREE.ShaderMaterial {
    const random = new Random(0x57a71a);
    const count = 210;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const tint = new THREE.Color();

    for (let i = 0; i < count; i += 1) {
      // Upper hemisphere, weighted toward the clear zenith.
      const y = Math.pow(random.next(), 0.62) * 0.93 + 0.035;
      const radius = Math.sqrt(1 - y * y);
      const angle = random.range(0, Math.PI * 2);
      positions[i * 3] = Math.cos(angle) * radius * 610;
      positions[i * 3 + 1] = y * 610;
      positions[i * 3 + 2] = Math.sin(angle) * radius * 610;

      const warm = random.next() > 0.8;
      tint.setRGB(
        warm ? 1.0 : 0.68,
        warm ? 0.73 : 0.78,
        warm ? 0.48 : 1.0,
      );
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
      sizes[i] = random.range(0.65, 2.35);
      phases[i] = random.range(0, Math.PI * 2);
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

          // Keep distant stars to a few device pixels and twinkle slowly.
          float twinkle = 0.72 + 0.28 * sin(uTime * 0.55 + aPhase * 9.0);
          gl_PointSize = aSize * uPixelRatio * (0.88 + 0.12 * twinkle);
          vColor = color;
          vAlpha = smoothstep(-20.0, 80.0, position.y) * 0.7 * twinkle;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          float distanceToCenter = length(gl_PointCoord - vec2(0.5));
          float alpha = smoothstep(0.5, 0.08, distanceToCenter) * vAlpha;
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

  dispose(): void {
    this.skyMaterial.dispose();
    this.starsMaterial.dispose();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry.dispose();
      }
    });
  }
}
