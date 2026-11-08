import * as THREE from 'three';
import { Random, clamp } from '../engine/math';

interface BuildingSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  radius: number;
  litFactor: number;
}

interface WindowSpec {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  width: number;
  height: number;
  color: THREE.Color;
}

/**
 * Milestone-one placeholder skyline. It is non-collidable and will be replaced
 * by the layout-driven mohalla. Until then it behaves like a painted backdrop:
 * dark layered masses, warm window grids and small rooftop silhouettes give
 * altitude and scale without spending draw calls.
 */
export class Backdrop {
  readonly group = new THREE.Group();
  private readonly glowMaterial: THREE.ShaderMaterial;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private elapsed = 0;

  constructor(pixelRatio: number) {
    const random = new Random(0x1f0a11);
    const specs = this.generateBuildings(random);
    const glowSources: number[] = [];

    this.buildMasses(specs, random);
    this.buildWindows(specs, random, glowSources);
    this.buildRoofScape(specs, random);

    this.glowMaterial = this.createGlowMaterial(glowSources, pixelRatio);
    this.group.add(this.glowMaterial.userData.points as THREE.Points);

    this.group.name = 'distant-mohalla';
    this.group.traverse((object) => {
      object.frustumCulled = false;
    });
  }

  update(deltaSeconds: number): void {
    this.elapsed += deltaSeconds;
    this.glowMaterial.uniforms.uTime!.value = this.elapsed;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.glowMaterial.dispose();
  }

  private generateBuildings(random: Random): BuildingSpec[] {
    const specs: BuildingSpec[] = [];

    // Authored silhouettes in the opening northward view. They sit at several
    // distances so the eye can separate near rooftops from the far city.
    const heroes = [
      { x: -36, z: -42, height: 9.5 },
      { x: 6, z: -49, height: 12 },
      { x: 27, z: -58, height: 15 },
      { x: -17, z: -66, height: 18 },
      { x: 48, z: -78, height: 24 },
      { x: -56, z: -88, height: 22 },
      { x: 19, z: -105, height: 27 },
      { x: -2, z: -132, height: 31 },
    ];
    for (const hero of heroes) {
      const radius = Math.hypot(hero.x, hero.z);
      specs.push({
        ...hero,
        width: random.range(7, 16),
        depth: random.range(6, 13),
        radius,
        litFactor: random.range(0.3, 0.6),
      });
    }

    // Near low-rise rooftops: the texture around the starting terrace. Keeping
    // these low means the camera looks across a real neighborhood, not a wall.
    for (let index = 0; index < 46; index += 1) {
      const angle = random.range(0, Math.PI * 2);
      const radius = random.range(29, 72);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      specs.push({
        x,
        z,
        width: random.range(4.5, 11),
        depth: random.range(4.5, 10),
        height: random.range(3.4, 10.5),
        radius,
        litFactor: random.range(0.25, 0.65),
      });
    }

    // Mid and far layers carry the horizon.
    for (let index = 0; index < 96; index += 1) {
      const angle = random.range(0, Math.PI * 2);
      const radius = random.range(68, 205);
      const far = clamp((radius - 68) / 137, 0, 1);
      specs.push({
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        width: random.range(5, 17),
        depth: random.range(5, 15),
        height: random.range(5, 16) + far * random.range(2, 13),
        radius,
        litFactor: random.range(0.25, 0.55),
      });
    }

    return specs;
  }

  private buildMasses(specs: BuildingSpec[], random: Random): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
    });
    this.geometries.push(geometry);
    this.materials.push(material);

    const city = new THREE.InstancedMesh(geometry, material, specs.length);
    city.name = 'distant-mohalla-silhouettes';
    city.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const tint = new THREE.Color();

    specs.forEach((spec, index) => {
      position.set(spec.x, spec.height / 2, spec.z);
      scale.set(spec.width, spec.height, spec.depth);
      matrix.compose(position, quaternion, scale);
      city.setMatrixAt(index, matrix);

      // Closer masses catch more of the blue city haze. Far masses sink into it.
      const near = 1 - clamp((spec.radius - 30) / 170, 0, 1);
      const base = 0.045 + near * 0.075;
      const warmth = random.range(0.82, 1.12);
      tint.setRGB(
        base * 0.72 * warmth,
        base * 0.80,
        base * 1.04,
      );
      city.setColorAt(index, tint);
    });

    city.instanceMatrix.needsUpdate = true;
    if (city.instanceColor) city.instanceColor.needsUpdate = true;
    city.castShadow = false;
    city.receiveShadow = false;
    this.group.add(city);
  }

  private buildWindows(
    specs: BuildingSpec[],
    random: Random,
    glowSources: number[],
  ): void {
    const windowSpecs: WindowSpec[] = [];
    const orange = new THREE.Color(1.0, 0.46, 0.14);
    const amber = new THREE.Color(1.0, 0.65, 0.32);
    const pale = new THREE.Color(1.0, 0.84, 0.62);
    const cool = new THREE.Color(0.48, 0.67, 1.0);
    const magenta = new THREE.Color(0.9, 0.16, 0.4);
    const green = new THREE.Color(0.2, 0.7, 0.36);
    const dark = new THREE.Color(0.004, 0.007, 0.013);

    for (const spec of specs) {
      const faces: Array<{
        normalX: number;
        normalZ: number;
        rotationY: number;
        span: number;
        positionOnFace: (offset: number) => { x: number; z: number };
      }> = [
        {
          normalX: 0,
          normalZ: 1,
          rotationY: 0,
          span: spec.width,
          positionOnFace: (offset) => ({ x: spec.x + offset, z: spec.z + spec.depth / 2 + 0.025 }),
        },
        {
          normalX: 0,
          normalZ: -1,
          rotationY: Math.PI,
          span: spec.width,
          positionOnFace: (offset) => ({ x: spec.x + offset, z: spec.z - spec.depth / 2 - 0.025 }),
        },
        {
          normalX: 1,
          normalZ: 0,
          rotationY: Math.PI / 2,
          span: spec.depth,
          positionOnFace: (offset) => ({ x: spec.x + spec.width / 2 + 0.025, z: spec.z - offset }),
        },
        {
          normalX: -1,
          normalZ: 0,
          rotationY: -Math.PI / 2,
          span: spec.depth,
          positionOnFace: (offset) => ({ x: spec.x - spec.width / 2 - 0.025, z: spec.z + offset }),
        },
      ];

      const usableHeight = Math.max(1.4, spec.height - 1.4);
      const rows = clamp(Math.floor(usableHeight / 3.05), 1, 6);

      for (const face of faces) {
        const columns = clamp(Math.floor(face.span / 2.7), 1, 4);

        for (let row = 0; row < rows; row += 1) {
          for (let column = 0; column < columns; column += 1) {
            if (random.next() < 0.16) continue;

            const across = ((column + 0.5) / columns - 0.5) * (face.span - 1.5);
            const acrossJitter = random.range(-0.22, 0.22);
            const onFace = face.positionOnFace(across + acrossJitter);
            const y = 1.35 + usableHeight * ((row + 0.5) / rows) + random.range(-0.09, 0.09);
            const width = random.range(0.55, 0.98);
            const height = random.range(0.72, 1.08);

            const lit = random.next() < spec.litFactor;
            let color: THREE.Color;
            if (lit) {
              const roll = random.next();
              let source = roll > 0.82 ? amber : orange;
              if (roll > 0.965) source = cool;
              else if (roll > 0.94) source = magenta;
              else if (roll > 0.925) source = green;
              if (source === amber && random.next() > 0.72) source = pale;
              const intensity = random.range(0.55, 1.38);
              color = new THREE.Color(
                source.r * intensity,
                source.g * intensity,
                source.b * intensity,
              );
            } else {
              color = dark.clone().multiplyScalar(random.range(0.6, 1.8));
            }

            windowSpecs.push({
              x: onFace.x,
              y,
              z: onFace.z,
              rotationY: face.rotationY,
              width,
              height,
              color,
            });

            // Sparse glow halos keep the windows from looking like flat decals.
            if (lit && random.next() < 0.22) {
              glowSources.push(
                onFace.x + face.normalX * 0.08,
                y,
                onFace.z + face.normalZ * 0.08,
                color.r * 0.8,
                color.g * 0.8,
                color.b * 0.8,
                random.range(0.42, 0.78),
                random.range(0, Math.PI * 2),
              );
            }
          }
        }
      }

      // A few rooftop fairy lights on the near terraces.
      if (spec.radius < 115 && random.next() > 0.7) {
        const bulbCount = 3 + random.int(0, 4);
        for (let bulb = 0; bulb < bulbCount; bulb += 1) {
          const side = random.next();
          const x = side > 0.5
            ? spec.x + random.range(-0.45, 0.45) * spec.width
            : spec.x + (random.next() > 0.5 ? 0.5 : -0.5) * spec.width;
          const z = side > 0.5
            ? spec.z + (random.next() > 0.5 ? 0.5 : -0.5) * spec.depth
            : spec.z + random.range(-0.45, 0.45) * spec.depth;
          glowSources.push(
            x,
            spec.height + random.range(0.1, 0.6),
            z,
            1.0,
            0.48,
            0.18,
            random.range(0.3, 0.52),
            random.range(0, Math.PI * 2),
          );
        }
      }
    }

    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.FrontSide,
      fog: false,
      toneMapped: true,
    });
    this.geometries.push(geometry);
    this.materials.push(material);

    const windows = new THREE.InstancedMesh(geometry, material, windowSpecs.length);
    windows.name = 'distant-window-grid';
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    windowSpecs.forEach((window, index) => {
      position.set(window.x, window.y, window.z);
      rotation.setFromAxisAngle(up, window.rotationY);
      scale.set(window.width, window.height, 1);
      matrix.compose(position, rotation, scale);
      windows.setMatrixAt(index, matrix);
      windows.setColorAt(index, window.color);
    });
    windows.instanceMatrix.needsUpdate = true;
    if (windows.instanceColor) windows.instanceColor.needsUpdate = true;
    this.group.add(windows);

    // A couple of large, very soft ground-level glows evoke street lamps and
    // spill without adding geometry or real dynamic lights.
    for (let index = 0; index < 18; index += 1) {
      const angle = random.range(0, Math.PI * 2);
      const radius = random.range(32, 150);
      glowSources.push(
        Math.cos(angle) * radius,
        random.range(0.8, 3.5),
        Math.sin(angle) * radius,
        1.0,
        random.range(0.22, 0.4),
        0.08,
        random.range(2.6, 5.6),
        random.range(0, Math.PI * 2),
      );
    }
  }

  private buildRoofScape(specs: BuildingSpec[], random: Random): void {
    const tankGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
    const tankMaterial = new THREE.MeshStandardMaterial({
      color: 0x101419,
      roughness: 0.74,
      metalness: 0.18,
    });
    const tankSpecs = specs.filter(
      (spec) => spec.radius < 140 && spec.width > 5 && random.next() > 0.63,
    );
    const tanks = new THREE.InstancedMesh(tankGeometry, tankMaterial, tankSpecs.length);
    tanks.name = 'distant-rooftop-tanks';
    this.geometries.push(tankGeometry);
    this.materials.push(tankMaterial);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    tankSpecs.forEach((spec, index) => {
      position.set(
        spec.x + random.range(-0.23, 0.23) * spec.width,
        spec.height + random.range(0.5, 0.9),
        spec.z + random.range(-0.23, 0.23) * spec.depth,
      );
      scale.set(random.range(0.8, 1.5), random.range(0.8, 1.3), random.range(0.8, 1.5));
      matrix.compose(position, quaternion, scale);
      tanks.setMatrixAt(index, matrix);
    });
    tanks.instanceMatrix.needsUpdate = true;
    this.group.add(tanks);

    const hutGeometry = new THREE.BoxGeometry(1, 1, 1);
    const hutMaterial = new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 1 });
    const hutSpecs = specs.filter(
      (spec) => spec.radius < 120 && spec.height > 5.5 && random.next() > 0.72,
    );
    const huts = new THREE.InstancedMesh(hutGeometry, hutMaterial, hutSpecs.length);
    huts.name = 'distant-rooftop-mumties';
    this.geometries.push(hutGeometry);
    this.materials.push(hutMaterial);

    hutSpecs.forEach((spec, index) => {
      position.set(
        spec.x + random.range(-0.24, 0.24) * spec.width,
        spec.height + 0.55,
        spec.z + random.range(-0.24, 0.24) * spec.depth,
      );
      scale.set(random.range(1.2, 2.8), random.range(1.1, 2.2), random.range(1.2, 2.4));
      matrix.compose(position, quaternion, scale);
      huts.setMatrixAt(index, matrix);
    });
    huts.instanceMatrix.needsUpdate = true;
    this.group.add(huts);

    // Thin antenna silhouettes. One LineSegments draw call covers them all.
    const antennaPositions: number[] = [];
    for (const spec of specs) {
      if (spec.radius > 130 || random.next() > 0.27) continue;
      const x = spec.x + random.range(-0.4, 0.4) * spec.width;
      const z = spec.z + random.range(-0.4, 0.4) * spec.depth;
      const top = spec.height + random.range(1.2, 3.8);
      antennaPositions.push(x, spec.height + 0.3, z, x, top, z);
    }
    const antennaGeometry = new THREE.BufferGeometry();
    antennaGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(antennaPositions, 3),
    );
    const antennaMaterial = new THREE.LineBasicMaterial({
      color: 0x141820,
      transparent: true,
      opacity: 0.75,
    });
    this.geometries.push(antennaGeometry);
    this.materials.push(antennaMaterial);
    this.group.add(new THREE.LineSegments(antennaGeometry, antennaMaterial));
  }

  private createGlowMaterial(glowData: number[], pixelRatio: number): THREE.ShaderMaterial {
    const stride = 8;
    const count = glowData.length / stride;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      const offset = index * stride;
      positions[index * 3] = glowData[offset]!;
      positions[index * 3 + 1] = glowData[offset + 1]!;
      positions[index * 3 + 2] = glowData[offset + 2]!;
      colors[index * 3] = glowData[offset + 3]!;
      colors[index * 3 + 1] = glowData[offset + 4]!;
      colors[index * 3 + 2] = glowData[offset + 5]!;
      sizes[index] = glowData[offset + 6]!;
      phases[index] = glowData[offset + 7]!;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    this.geometries.push(geometry);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(pixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          float distanceToCamera = max(8.0, -mvPosition.z);

          // Keep the glow a few pixels wide even in the deep city.
          gl_PointSize = clamp(
            aSize * uPixelRatio * (72.0 / distanceToCamera),
            1.5,
            22.0 * uPixelRatio
          );

          float flicker = 0.88 + 0.12 * sin(uTime * 1.1 + aPhase * 5.0);
          vColor = aColor;
          vAlpha = smoothstep(230.0, 20.0, distanceToCamera) * flicker;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec2 centered = gl_PointCoord * 2.0 - 1.0;
          float radius = dot(centered, centered);
          if (radius > 1.0) discard;
          float core = exp(-radius * 6.0);
          float halo = exp(-radius * 2.2) * 0.34;
          float alpha = clamp((core + halo) * vAlpha, 0.0, 1.0);
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(vColor * 1.25, alpha);

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
    points.name = 'distant-window-glow';
    material.userData.points = points;
    this.materials.push(material);
    return material;
  }
}
