import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp } from '../engine/math';

interface PropUnit {
  material: THREE.ShaderMaterial;
  direction: number;
}

/** Camera-space position of each front motor. */
const ROTOR_X = 0.335;
const ROTOR_Y = -0.195;
const ROTOR_Z = -0.25;
/** A 5-inch prop is 127 mm across. */
const ROTOR_DIAMETER = 0.132;
const CAMERA_UPTILT = -0.043;

/**
 * The two front rotors, mounted to the camera rather than the airframe.
 *
 * A nose-mounted FPV camera sits behind and above the front props, so a real
 * rig only ever catches the inner top edge of each disc in the extreme lower
 * corners. Everything else - arms, camera cage, antenna - is kept out of the
 * frame. The visible parts are two camera-facing swept-disc shaders plus one
 * merged mesh containing both motor bells, so the whole rig costs three draws.
 */
export class FpvRig {
  readonly group = new THREE.Group();
  private readonly units: PropUnit[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private spin = 0;
  private throttle = 0;
  private shake = 0;

  constructor(camera: THREE.PerspectiveCamera) {
    this.group.name = 'fpv-front-rotors';
    this.group.frustumCulled = false;
    camera.add(this.group);

    const discGeometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(discGeometry);

    const hardwareGeometry = createMotorHardware();
    this.geometries.push(hardwareGeometry);

    const hardwareMaterial = new THREE.MeshStandardMaterial({
      color: 0x23272d,
      roughness: 0.3,
      metalness: 0.78,
    });
    this.materials.push(hardwareMaterial);

    // One draw for both motors. The tiny dark bells are the only solid pieces
    // that survive at the frame edge; arms and the camera cage stay outside.
    const hardware = new THREE.Mesh(hardwareGeometry, hardwareMaterial);
    hardware.name = 'fpv-front-motor-hardware';
    hardware.renderOrder = 6;
    hardware.frustumCulled = false;
    this.group.add(hardware);

    for (const side of [-1, 1] as const) {
      const unit = new THREE.Group();
      unit.position.set(side * ROTOR_X, ROTOR_Y, ROTOR_Z);
      // Compensate for the camera's 2.5 degree uptilt so the rotor planes stay
      // physically horizontal relative to the airframe.
      unit.rotation.x = CAMERA_UPTILT;
      unit.rotation.z = side * 0.018;
      unit.frustumCulled = false;

      const material = createPropMaterial();
      const disc = new THREE.Mesh(discGeometry, material);
      disc.name = side < 0 ? 'fpv-front-left-rotor' : 'fpv-front-right-rotor';
      disc.rotation.x = -Math.PI / 2;
      disc.scale.setScalar(ROTOR_DIAMETER);
      disc.renderOrder = 5;
      disc.frustumCulled = false;
      unit.add(disc);

      this.group.add(unit);
      this.units.push({ material, direction: side < 0 ? 1 : -1 });
    }
  }

  update(
    deltaSeconds: number,
    elapsedSeconds: number,
    throttle: number,
    speedRatio: number,
    crashed: boolean,
  ): void {
    this.group.visible = !crashed;
    if (crashed) return;

    this.throttle = damp(this.throttle, clamp(throttle, 0, 1), 6, deltaSeconds);
    this.shake = damp(
      this.shake,
      this.throttle * 0.0006 + clamp(speedRatio, 0, 1) * 0.0014,
      6,
      deltaSeconds,
    );

    const spinRate = 38 + this.throttle * 96;
    this.spin = (this.spin + deltaSeconds * spinRate) % (Math.PI * 2);

    const jitterX = Math.sin(elapsedSeconds * 71.3) * this.shake;
    const jitterZ = Math.cos(elapsedSeconds * 63.7) * this.shake;

    for (const unit of this.units) {
      const uniforms = unit.material.uniforms;
      uniforms.uTime!.value = elapsedSeconds;
      uniforms.uSpeed!.value = clamp(speedRatio, 0, 1);
      uniforms.uThrottle!.value = this.throttle;
      uniforms.uSpin!.value = this.spin * unit.direction;
      uniforms.uJitter!.value = new THREE.Vector2(jitterX, jitterZ);
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const unit of this.units) unit.material.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Both motor stacks baked into a single geometry. Arms are intentionally
 * absent: this is only what a camera mounted just behind the props can see.
 */
function createMotorHardware(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  for (const side of [-1, 1] as const) {
    const transform = new THREE.Matrix4()
      .makeRotationX(CAMERA_UPTILT)
      .setPosition(side * ROTOR_X, ROTOR_Y, ROTOR_Z);

    const stack = [
      new THREE.CylinderGeometry(0.022, 0.026, 0.026, 12),
      new THREE.CylinderGeometry(0.016, 0.021, 0.008, 12),
      new THREE.CylinderGeometry(0.012, 0.014, 0.012, 10),
      new THREE.CylinderGeometry(0.0065, 0.0075, 0.007, 8),
      new THREE.TorusGeometry(0.024, 0.0015, 4, 14).rotateX(Math.PI / 2),
    ];
    const offsets = [-0.024, -0.04, -0.004, 0.007, -0.014];

    for (let index = 0; index < stack.length; index += 1) {
      const part = stack[index]!;
      part.translate(0, offsets[index]!, 0);
      part.applyMatrix4(transform);
      parts.push(part);
    }
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('Could not merge FPV motor hardware');
  merged.computeBoundingSphere();
  return merged;
}

function createPropMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSpin: { value: 0 },
      uSpeed: { value: 0 },
      uThrottle: { value: 0 },
      uJitter: { value: new THREE.Vector2() },
    },
    vertexShader: /* glsl */ `
      uniform vec2 uJitter;
      varying vec2 vUv;

      void main() {
        vUv = uv;
        vec3 displaced = position + vec3(uJitter.x, 0.0, uJitter.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uSpin;
      uniform float uSpeed;
      uniform float uThrottle;
      varying vec2 vUv;

      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float radius = length(p);
        if (radius > 1.0) discard;

        float angle = atan(p.y, p.x);
        float sector = 6.2831853 / 3.0;

        // Sweeping the phase along the radius curves the blade backwards,
        // exactly like a real propeller under load.
        float swept = angle + uSpin + radius * 1.45;
        float phase = fract(swept / sector);
        float trail = mix(0.13, 0.58, uThrottle);
        float bladeBody = smoothstep(trail, 0.0, phase);
        float softTail = smoothstep(trail * 1.9, 0.0, phase) * 0.36;
        float blades = max(bladeBody, softTail);

        float radial = smoothstep(0.11, 0.27, radius)
          * (1.0 - smoothstep(0.94, 1.0, radius));
        // Read as carbon rather than a black mask: the blade body is dark but
        // the leading edge and tip pick up the warm city light.
        float discAlpha = radial * (0.006 + blades * (0.24 + uThrottle * 0.24));
        float tipRing = smoothstep(0.84, 0.94, radius)
          * (1.0 - smoothstep(0.955, 1.0, radius))
          * blades * (0.13 + uThrottle * 0.1);
        float hub = 1.0 - smoothstep(0.045, 0.085, radius);

        float alpha = clamp(discAlpha + tipRing + hub * 0.8, 0.0, 1.0);
        if (alpha < 0.01) discard;

        vec3 blade = vec3(0.075, 0.085, 0.1) * (0.78 + bladeBody * 1.15);
        float leadingEdge = smoothstep(0.03, 0.0, phase);
        blade += vec3(0.52, 0.55, 0.6) * leadingEdge * radial * 0.34;
        float warmGlint = pow(blades, 2.0) * radial * smoothstep(0.2, 0.9, radius);
        blade += vec3(0.62, 0.38, 0.2) * warmGlint * 0.22;
        float sheen = pow(max(0.0, 1.0 - abs(phase - 0.08) * 12.0), 2.0);
        blade += vec3(0.34, 0.38, 0.42) * sheen * radial * 0.24;
        blade = mix(blade, vec3(0.02, 0.024, 0.03), hub);

        gl_FragColor = vec4(blade, alpha);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    toneMapped: true,
  });
}
