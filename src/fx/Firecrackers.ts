import * as THREE from 'three';
import { Random, clamp } from '../engine/math';

export type FirecrackerSound = 'launch' | 'burst';

/**
 * Distance and stereo pan are all the audio layer needs; both are computed
 * from the live camera position so every shell and burst is heard correctly
 * no matter which way the pilot is facing.
 */
export type FirecrackerListener = (
  distance: number,
  pan: number,
  kind: FirecrackerSound,
) => void;

interface Shell {
  active: boolean;
  start: THREE.Vector3;
  end: THREE.Vector3;
  position: THREE.Vector3;
  age: number;
  duration: number;
  trailTimer: number;
  color: THREE.Color;
}

interface Particle {
  active: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  color: THREE.Color;
  size: number;
  age: number;
  life: number;
  gravity: number;
  drag: number;
  flicker: number;
  phase: number;
  trail: boolean;
}

const MAX_PARTICLES = 2600;
const MAX_SHELLS = 6;
const SPAWN_MIN_SECONDS = 0.62;
const SPAWN_MAX_SECONDS = 1.45;

/**
 * Warm Diwali palette. Deliberately no green: green window/bulb tints were
 * reading as stray strips from altitude, and warm light is the local look.
 */
const PALETTE = [
  new THREE.Color(1.0, 0.82, 0.58),
  new THREE.Color(1.0, 0.58, 0.2),
  new THREE.Color(1.0, 0.32, 0.12),
  new THREE.Color(1.0, 0.18, 0.24),
  new THREE.Color(0.96, 0.3, 0.68),
  new THREE.Color(0.3, 0.55, 1.0),
];

/**
 * Diwali firecrackers below the drone.
 *
 * Every cracker in the sky is the same reusable effect: one shell pool, one
 * particle pool, one additive point cloud and one synthesised audio recipe.
 * A launch picks a pooled shell, it rises on an ember trail, then hands its
 * pooled spark slots to a bright spherical burst. Nothing is allocated while
 * the effect is running.
 */
export class Firecrackers {
  readonly group = new THREE.Group();

  private readonly random = new Random(0xd1a1a);
  private readonly shells: Shell[] = [];
  private readonly particles: Particle[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly cameraRight = new THREE.Vector3();
  private readonly listenerPosition = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly burstDirection = new THREE.Vector3();
  private cursor = 0;
  private shellCursor = 0;
  private schedule = 0.35;

  constructor(scene: THREE.Scene) {
    this.group.name = 'diwali-firecrackers';
    this.group.frustumCulled = false;

    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.alphas = new Float32Array(MAX_PARTICLES);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      'aColor',
      new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      'aSize',
      new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      'aAlpha',
      new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uProjScale: { value: 520 },
        // Required by three's fog chunks and refreshFogUniforms().
        fogColor: { value: new THREE.Color(0x080b12) },
        fogDensity: { value: 0.0062 },
        fogNear: { value: 1 },
        fogFar: { value: 200 },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>

        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uProjScale;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = clamp(
            aSize * uProjScale / max(0.7, -mvPosition.z),
            1.0,
            170.0
          );
          vColor = aColor;
          vAlpha = aAlpha;

          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>

        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec2 centered = gl_PointCoord * 2.0 - 1.0;
          float radius = dot(centered, centered);
          if (radius > 1.0) discard;

          float core = exp(-radius * 5.4);
          float halo = exp(-radius * 1.65) * 0.5;
          float alpha = clamp((core + halo) * vAlpha, 0.0, 1.0);
          if (alpha < 0.004) discard;

          vec3 color = vColor * (1.0 + core * 1.6);
          gl_FragColor = vec4(color, alpha);

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
      fog: true,
    });

    const points = new THREE.Points(this.geometry, this.material);
    points.name = 'firecracker-sparks';
    points.frustumCulled = false;
    points.renderOrder = 2;
    this.group.add(points);
    scene.add(this.group);

    for (let index = 0; index < MAX_PARTICLES; index += 1) {
      this.particles.push({
        active: false,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        color: new THREE.Color(),
        size: 0,
        age: 0,
        life: 0,
        gravity: 4.5,
        drag: 0.7,
        flicker: 0,
        phase: 0,
        trail: false,
      });
    }

    for (let index = 0; index < MAX_SHELLS; index += 1) {
      this.shells.push({
        active: false,
        start: new THREE.Vector3(),
        end: new THREE.Vector3(),
        position: new THREE.Vector3(),
        age: 0,
        duration: 1,
        trailTimer: 0,
        color: new THREE.Color(),
      });
    }
  }

  get activeParticles(): number {
    return this.geometry.drawRange.count;
  }

  update(
    deltaSeconds: number,
    camera: THREE.PerspectiveCamera,
    dronePosition: THREE.Vector3,
    viewportHeight: number,
    onSound: FirecrackerListener,
  ): void {
    const delta = Math.min(deltaSeconds, 0.05);

    this.material.uniforms.uProjScale!.value =
      camera.projectionMatrix.elements[5]! * viewportHeight * 0.5;

    this.cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.listenerPosition.copy(camera.position);

    this.schedule -= delta;
    if (this.schedule <= 0) {
      this.schedule = this.random.range(SPAWN_MIN_SECONDS, SPAWN_MAX_SECONDS);
      this.launchShell(dronePosition, onSound);
    }

    for (const shell of this.shells) {
      if (!shell.active) continue;
      shell.age += delta;

      const t = clamp(shell.age / shell.duration, 0, 1);
      const eased = t * t * (3 - 2 * t);
      shell.position.lerpVectors(shell.start, shell.end, eased);
      shell.trailTimer -= delta;
      if (shell.trailTimer <= 0) {
        shell.trailTimer = 0.018;
        this.spawnTrail(shell.position, shell.color, 0.2, 1.8);
      }

      if (shell.age >= shell.duration) {
        shell.active = false;
        this.burst(shell);
        this.emit('burst', shell.end, onSound);
      }
    }

    this.updateParticles(delta);
    this.writeBuffers();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }

  /**
   * The one reusable firecracker: a pooled shell rises from the street and
   * bursts at a height that stays below the drone, but close enough to see
   * from any heading. Launches are spread all the way around the pilot.
   */
  private launchShell(drone: THREE.Vector3, onSound: FirecrackerListener): void {
    const angle = this.random.range(0, Math.PI * 2);
    const distance = this.random.range(24, 72);
    const x = drone.x + Math.sin(angle) * distance;
    const z = drone.z + Math.cos(angle) * distance;

    // Rocket ceiling is a real altitude, not a constant: when the pilot climbs
    // the festival climbs with them, so a burst is always in the lower half of
    // the view rather than hundreds of metres below the camera.
    const targetY = clamp(
      drone.y - this.random.range(5, 18),
      5,
      Math.max(6, drone.y - 3),
    );
    const startY = this.random.range(0.8, 1.5);

    const shell = this.shells[this.shellCursor]!;
    this.shellCursor = (this.shellCursor + 1) % this.shells.length;
    shell.active = true;
    shell.start.set(x, startY, z);
    shell.end.set(
      x + this.random.range(-1.8, 1.8),
      targetY,
      z + this.random.range(-1.8, 1.8),
    );
    shell.position.copy(shell.start);
    shell.age = 0;
    shell.duration = clamp(0.5 + targetY * 0.017, 0.7, 2.15);
    shell.trailTimer = 0;
    shell.color.copy(PALETTE[this.random.int(0, PALETTE.length)]!);

    this.emit('launch', shell.start, onSound);
  }

  private burst(shell: Shell): void {
    const center = shell.end;
    const primary = shell.color;
    const secondary = PALETTE[this.random.int(0, PALETTE.length)]!;
    const scale = this.random.range(0.95, 1.3);
    const count = Math.round(128 * scale);

    // A bright core and a long, soft glow make the burst readable from any
    // angle and from far away, not just as a handful of single-pixel sparks.
    const flash = this.nextParticle();
    flash.position.copy(center);
    flash.velocity.set(0, 0, 0);
    flash.color.setRGB(1.0, 0.94, 0.8);
    flash.size = this.random.range(3.2, 4.8) * scale;
    flash.age = 0;
    flash.life = 0.24;
    flash.gravity = 0;
    flash.drag = 0;
    flash.flicker = 0;
    flash.phase = 0;
    flash.trail = false;

    const halo = this.nextParticle();
    halo.position.copy(center);
    halo.velocity.set(0, 0, 0);
    halo.color.copy(primary).multiplyScalar(0.85);
    halo.size = this.random.range(7.5, 11) * scale;
    halo.age = 0;
    halo.life = this.random.range(0.7, 1.05);
    halo.gravity = 0;
    halo.drag = 0;
    halo.flicker = 0;
    halo.phase = 0;
    halo.trail = false;

    for (let index = 0; index < count; index += 1) {
      const particle = this.nextParticle();
      particle.position.copy(center);
      particle.age = 0;

      this.burstDirection.set(
        this.random.range(-1, 1),
        this.random.range(-1, 1),
        this.random.range(-1, 1),
      );
      if (this.burstDirection.lengthSq() < 0.0001) this.burstDirection.set(0, 1, 0);
      this.burstDirection.normalize();

      // A slightly flattened sphere reads like a real aerial shell.
      const speed = this.random.range(6.5, 16.5) * scale;
      particle.velocity.copy(this.burstDirection).multiplyScalar(speed);
      particle.velocity.y *= 0.82;
      particle.life = this.random.range(1.15, 2.45);
      particle.gravity = this.random.range(3.4, 5.2);
      particle.drag = this.random.range(0.5, 0.78);
      particle.size = this.random.range(0.18, 0.38) * scale;
      particle.trail = index % 3 === 0;

      const color = index % 5 === 0 ? secondary : primary;
      particle.color.copy(color).multiplyScalar(this.random.range(0.9, 1.6));
      particle.flicker = this.random.next() < 0.18 ? this.random.range(0.45, 1) : 0;
      particle.phase = this.random.range(0, Math.PI * 2);
    }

    // Slow, dim embers give the burst volume without another draw call.
    for (let index = 0; index < 26; index += 1) {
      const particle = this.nextParticle();
      const theta = this.random.range(0, Math.PI * 2);
      particle.position.copy(center);
      particle.velocity.set(
        Math.cos(theta) * this.random.range(0.8, 3.8),
        this.random.range(-1.8, 2.4),
        Math.sin(theta) * this.random.range(0.8, 3.8),
      );
      particle.color.copy(primary).multiplyScalar(0.36);
      particle.size = this.random.range(0.4, 0.85) * scale;
      particle.age = 0;
      particle.life = this.random.range(0.75, 1.5);
      particle.gravity = 0.7;
      particle.drag = 1.5;
      particle.flicker = 0;
      particle.phase = 0;
      particle.trail = false;
    }
  }

  private updateParticles(delta: number): void {
    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.age += delta;
      if (particle.age >= particle.life) {
        particle.active = false;
        continue;
      }

      particle.velocity.y -= particle.gravity * delta;
      particle.velocity.multiplyScalar(Math.exp(-particle.drag * delta));
      particle.position.addScaledVector(particle.velocity, delta);

      if (particle.position.y < 0.05) {
        particle.position.y = 0.05;
        particle.velocity.y *= -0.16;
        particle.velocity.x *= 0.7;
        particle.velocity.z *= 0.7;
      }

      if (particle.trail && particle.age < particle.life * 0.78) {
        if (this.random.next() < delta * 16) {
          this.spawnTrail(particle.position, particle.color, particle.size * 0.6, 0.9);
        }
      }
    }
  }

  private spawnTrail(
    position: THREE.Vector3,
    color: THREE.Color,
    size: number,
    brightness: number,
  ): void {
    const particle = this.nextParticle();
    particle.position.copy(position);
    particle.velocity.set(
      this.random.range(-0.2, 0.2),
      this.random.range(-0.16, 0.4),
      this.random.range(-0.2, 0.2),
    );
    particle.color.copy(color).multiplyScalar(brightness);
    particle.size = size * this.random.range(0.7, 1.2);
    particle.age = 0;
    particle.life = this.random.range(0.2, 0.46);
    particle.gravity = 1.2;
    particle.drag = 1.8;
    particle.flicker = 0;
    particle.phase = 0;
    particle.trail = false;
  }

  private nextParticle(): Particle {
    const particle = this.particles[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.particles.length;
    particle.active = true;
    return particle;
  }

  private emit(
    kind: FirecrackerSound,
    position: THREE.Vector3,
    onSound: FirecrackerListener,
  ): void {
    this.offset.copy(position).sub(this.listenerPosition);
    const distance = this.offset.length();
    const horizontal = Math.hypot(this.offset.x, this.offset.z);
    const pan = horizontal > 0.001
      ? clamp(
        (this.offset.x * this.cameraRight.x + this.offset.z * this.cameraRight.z)
          / horizontal,
        -1,
        1,
      ) * 0.85
      : 0;
    onSound(distance, pan, kind);
  }

  private writeBuffers(): void {
    let count = 0;
    for (const particle of this.particles) {
      if (!particle.active) continue;
      const lifeRatio = particle.age / particle.life;
      const fadeIn = Math.min(1, lifeRatio * 7);
      const fade = fadeIn * (1 - lifeRatio) ** 1.15;
      const twinkle = particle.flicker > 0
        ? 0.68 + 0.32 * Math.sin(particle.age * 44 + particle.phase)
        : 1;
      const alpha = fade * twinkle;
      const index3 = count * 3;
      this.positions[index3] = particle.position.x;
      this.positions[index3 + 1] = particle.position.y;
      this.positions[index3 + 2] = particle.position.z;
      this.colors[index3] = particle.color.r;
      this.colors[index3 + 1] = particle.color.g;
      this.colors[index3 + 2] = particle.color.b;
      this.sizes[count] = particle.size;
      this.alphas[count] = alpha;
      count += 1;
    }

    this.geometry.setDrawRange(0, count);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }
}
