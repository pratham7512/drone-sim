import type { Collider } from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Random, clamp } from '../engine/math';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import type { PhotoTextures, ProceduralTextures } from './textures';

/**
 * The city repeats on a 512 m period. The shader wraps each instance to the
 * copy nearest the camera, so the pattern is stable but never ends. The period
 * is long enough that fog hides the seam and large enough to read as a real
 * neighbourhood rather than a treadmill.
 */
const CITY_PERIOD = 512;
const CITY_HALF = CITY_PERIOD / 2;
const CITY_CELL = 16;
const CITY_GRID = CITY_PERIOD / CITY_CELL;
const COLLISION_RADIUS = 115;
const MAX_CITY_COLLIDERS = 72;
const COLLISION_REFRESH_DISTANCE = 5;
const COLLISION_REFRESH_SECONDS = 0.35;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The generator carves wide arterial lanes through every seventh city column
 * and row. Streets, pavements, lamps, trees and traffic all key off the same
 * coordinates so the map and the world agree with each other.
 */
const MAJOR_LANES: readonly number[] = Array.from(
  { length: CITY_GRID },
  (_, index) => index,
)
  .filter((index) => index % 7 === 3)
  .map((index) => -CITY_HALF + (index + 0.5) * CITY_CELL);

interface BuildingSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  floors: number;
  litFactor: number;
  tint: THREE.Color;
}

export interface CityMapBuilding {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

interface DetailSpec {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  tint: THREE.Color;
}

interface WindowBuild {
  lit: DetailSpec[];
  dark: DetailSpec[];
  sills: DetailSpec[];
}

interface BulbSpec {
  position: THREE.Vector3;
  color: THREE.Color;
}

interface GlowSpec {
  position: THREE.Vector3;
  color: THREE.Color;
  size: number;
  phase: number;
}

/**
 * A Diwali-night mohalla that never runs out. Building masses, windows,
 * parapets, balconies, awnings, AC units, rooftop tanks, street lamps and fairy
 * lights are batched into instanced draws and wrapped in the vertex shader; a
 * small pool of Rapier colliders follows the camera.
 */
export class Backdrop {
  readonly group = new THREE.Group();
  readonly buildingCount: number;
  readonly mapBuildings: readonly CityMapBuilding[];

  private readonly glowMaterial: THREE.ShaderMaterial;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly ownedTextures: THREE.Texture[] = [];
  private readonly specs: BuildingSpec[];
  private readonly physics: PhysicsWorld;
  private readonly colliderPool: Collider[] = [];
  private readonly collisionAnchor = new THREE.Vector2(Number.POSITIVE_INFINITY, 0);
  private readonly groundPools: DetailSpec[] = [];
  private readonly emptyCells: Array<{ x: number; z: number }> = [];
  private collisionTimer = 0;
  private visibleColliderCount = 0;
  private elapsed = 0;

  constructor(
    pixelRatio: number,
    physics: PhysicsWorld,
    textures: ProceduralTextures,
    photos: PhotoTextures | null,
  ) {
    this.physics = physics;
    const random = new Random(0x1f0a11);
    this.specs = this.generateBuildings(random);
    this.buildingCount = this.specs.length;
    this.mapBuildings = this.specs.map((spec) => ({
      x: spec.x,
      z: spec.z,
      width: spec.width,
      depth: spec.depth,
      height: spec.height,
    }));

    const glowSources: GlowSpec[] = [];
    this.buildMasses(random, textures, photos);
    const windows = this.buildWindows(random, glowSources);
    this.buildWindowMeshes(windows);
    this.buildFacadeDetails(random, glowSources);
    this.buildRoofScape(random, glowSources);
    this.buildStreetDetails(random, glowSources);
    this.buildRoadNetwork(random, textures);
    this.buildEmptyLots(random);
    this.buildTrees(random);
    this.buildVehicles(random);
    this.buildStreetProps(random);
    this.buildGroundPools();

    this.glowMaterial = this.createGlowMaterial(glowSources, pixelRatio);
    this.group.add(this.glowMaterial.userData.points as THREE.Points);

    this.group.name = 'infinite-mohalla';
    this.group.traverse((object) => {
      object.frustumCulled = false;
    });
  }

  get activeColliderCount(): number {
    return this.visibleColliderCount;
  }

  get cityPeriod(): number {
    return CITY_PERIOD;
  }

  update(deltaSeconds: number, cameraPosition: THREE.Vector3): void {
    this.elapsed += deltaSeconds;
    this.glowMaterial.uniforms.uTime!.value = this.elapsed;

    this.collisionTimer += deltaSeconds;
    const moved = Math.hypot(
      cameraPosition.x - this.collisionAnchor.x,
      cameraPosition.z - this.collisionAnchor.y,
    );
    if (
      moved > COLLISION_REFRESH_DISTANCE ||
      this.collisionTimer > COLLISION_REFRESH_SECONDS
    ) {
      this.syncColliders(cameraPosition);
      this.collisionTimer = 0;
    }
  }

  dispose(): void {
    for (const collider of this.colliderPool) {
      this.physics.raw.removeCollider(collider, false);
    }
    this.colliderPool.length = 0;

    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.ownedTextures) texture.dispose();
    this.glowMaterial.dispose();
  }

  private generateBuildings(random: Random): BuildingSpec[] {
    const specs: BuildingSpec[] = [];
    const palette = [
      new THREE.Color(0.72, 0.65, 0.55),
      new THREE.Color(0.63, 0.49, 0.39),
      new THREE.Color(0.57, 0.58, 0.54),
      new THREE.Color(0.7, 0.56, 0.43),
      new THREE.Color(0.48, 0.52, 0.57),
      new THREE.Color(0.66, 0.43, 0.35),
      new THREE.Color(0.75, 0.7, 0.62),
    ];

    for (let ix = 0; ix < CITY_GRID; ix += 1) {
      for (let iz = 0; iz < CITY_GRID; iz += 1) {
        // A few broad lanes keep the city navigable and let street-level glow
        // read when the camera drops below the parapets.
        if ((ix % 7 === 3 || iz % 7 === 3) && random.next() > 0.16) continue;
        if (random.next() > 0.42) continue;

        const jitterX = random.range(-1.1, 1.1);
        const jitterZ = random.range(-1.1, 1.1);
        const x = -CITY_HALF + (ix + 0.5) * CITY_CELL + jitterX;
        const z = -CITY_HALF + (iz + 0.5) * CITY_CELL + jitterZ;
        if (Math.hypot(x, z) < 28) continue;

        const width = random.range(7.2, 12.8);
        const depth = random.range(7.2, 12.8);
        const heightRoll = random.next();
        const floors = heightRoll < 0.08 ? 1 : heightRoll < 0.62 ? 2 : heightRoll < 0.92 ? 3 : 4;
        const height = 1.0 + floors * 3.1 + random.range(0, 1.35);
        const tint = palette[random.int(0, palette.length)]!.clone();
        tint.multiplyScalar(random.range(0.72, 1.05));

        specs.push({
          x,
          z,
          width,
          depth,
          height,
          floors,
          litFactor: random.range(0.24, 0.56),
          tint,
        });
      }
    }

    return specs;
  }

  private buildMasses(
    random: Random,
    textures: ProceduralTextures,
    photos: PhotoTextures | null,
  ): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(geometry);

    const wallMap = this.cloneTexture(
      photos?.wall.map ?? textures.wall,
      2.4,
      1.8,
      false,
    );
    const materialParams: THREE.MeshStandardMaterialParameters = {
      color: 0xffffff,
      map: wallMap,
      roughness: photos ? 1 : 0.96,
      metalness: 0.015,
    };
    if (photos) {
      materialParams.normalMap = this.cloneTexture(photos.wall.normalMap, 2.4, 1.8, true);
      materialParams.roughnessMap = this.cloneTexture(photos.wall.roughnessMap, 2.4, 1.8, true);
      materialParams.normalScale = new THREE.Vector2(0.72, 0.72);
    } else {
      materialParams.bumpMap = this.cloneTexture(textures.wall, 2.4, 1.8, true);
      materialParams.bumpScale = 0.028;
    }

    const material = new THREE.MeshStandardMaterial(materialParams);
    applyCityWrap(material);
    this.materials.push(material);

    const city = new THREE.InstancedMesh(geometry, material, this.specs.length);
    city.name = 'mohalla-building-masses';
    city.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    city.castShadow = false;
    city.receiveShadow = false;
    city.frustumCulled = false;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    this.specs.forEach((spec, index) => {
      position.set(spec.x, spec.height / 2, spec.z);
      scale.set(spec.width, spec.height, spec.depth);
      matrix.compose(position, quaternion, scale);
      city.setMatrixAt(index, matrix);
      city.setColorAt(index, spec.tint);
    });
    city.instanceMatrix.needsUpdate = true;
    if (city.instanceColor) city.instanceColor.needsUpdate = true;
    this.group.add(city);

    // A separate roof slab gives every building a proper concrete cap and a
    // small overhanging lip instead of stretching the wall scan over the roof.
    const roofMap = this.cloneTexture(photos?.roof.map ?? textures.roof, 3.1, 2.6, false);
    const roofParams: THREE.MeshStandardMaterialParameters = {
      color: 0xffffff,
      map: roofMap,
      roughness: photos ? 1 : 0.98,
      metalness: 0,
    };
    if (photos) {
      roofParams.normalMap = this.cloneTexture(photos.roof.normalMap, 3.1, 2.6, true);
      roofParams.roughnessMap = this.cloneTexture(photos.roof.roughnessMap, 3.1, 2.6, true);
      roofParams.normalScale = new THREE.Vector2(0.55, 0.55);
    } else {
      roofParams.bumpMap = this.cloneTexture(textures.roof, 3.1, 2.6, true);
      roofParams.bumpScale = 0.021;
    }
    const roofMaterial = new THREE.MeshStandardMaterial(roofParams);
    applyCityWrap(roofMaterial);
    this.materials.push(roofMaterial);

    const slabGeometry = new THREE.BoxGeometry(1, 0.08, 1);
    this.geometries.push(slabGeometry);
    const slabs: DetailSpec[] = this.specs.map((spec, index) => ({
      x: spec.x,
      y: spec.height - 0.04,
      z: spec.z,
      rotationY: 0,
      scaleX: spec.width + 0.22,
      scaleY: 1,
      scaleZ: spec.depth + 0.22,
      tint: new THREE.Color(0.62, 0.6, 0.55).multiplyScalar(0.82 + (index % 5) * 0.045),
    }));
    this.addInstances(slabGeometry, roofMaterial, slabs, 'mohalla-roof-slabs');

    void random;
  }

  private buildWindows(random: Random, glowSources: GlowSpec[]): WindowBuild {
    const lit: DetailSpec[] = [];
    const dark: DetailSpec[] = [];
    const sills: DetailSpec[] = [];
    const orange = new THREE.Color(1.0, 0.45, 0.14);
    const amber = new THREE.Color(1.0, 0.63, 0.3);
    const pale = new THREE.Color(1.0, 0.82, 0.58);
    const cool = new THREE.Color(0.48, 0.7, 1.0);
    const rose = new THREE.Color(0.95, 0.24, 0.42);

    for (const spec of this.specs) {
      const usableHeight = Math.max(1.2, spec.height - 1.6);
      const rows = clamp(Math.floor(usableHeight / 3.1), 1, 5);

      for (let faceIndex = 0; faceIndex < 4; faceIndex += 1) {
        const face = getFace(spec, faceIndex);
        const columns = clamp(Math.floor(face.span / 3.3), 1, 4);

        for (let row = 0; row < rows; row += 1) {
          for (let column = 0; column < columns; column += 1) {
            const isLit = random.next() < spec.litFactor;
            if (!isLit && random.next() > 0.46) continue;

            const across = ((column + 0.5) / columns - 0.5) * (face.span - 1.5);
            const point = facePoint(spec, faceIndex, across + random.range(-0.2, 0.2), 0.034);
            const y =
              1.35 + usableHeight * ((row + 0.5) / rows) + random.range(-0.1, 0.1);
            const width = random.range(0.46, 0.88);
            const height = random.range(0.58, 1.0);

            if (isLit) {
              const roll = random.next();
              let source = roll > 0.8 ? amber : orange;
              if (roll > 0.955) source = cool;
              else if (roll > 0.925) source = rose;
              if (source === amber && random.next() > 0.7) source = pale;

              const intensity = random.range(0.46, 1.5);
              const color = new THREE.Color(
                source.r * intensity,
                source.g * intensity,
                source.b * intensity,
              );

              lit.push({
                x: point.x,
                y,
                z: point.z,
                rotationY: face.rotationY,
                scaleX: width,
                scaleY: height,
                scaleZ: 1,
                tint: color,
              });

              if (random.next() < 0.14) {
                glowSources.push({
                  position: new THREE.Vector3(
                    point.x + face.normalX * 0.08,
                    y,
                    point.z + face.normalZ * 0.08,
                  ),
                  color: color.clone().multiplyScalar(0.72),
                  size: random.range(0.34, 0.68),
                  phase: random.range(0, Math.PI * 2),
                });
              }
            } else {
              const tint = new THREE.Color(0.46, 0.56, 0.72)
                .multiplyScalar(random.range(0.42, 0.95));
              dark.push({
                x: point.x,
                y,
                z: point.z,
                rotationY: face.rotationY,
                scaleX: width,
                scaleY: height,
                scaleZ: 1,
                tint,
              });
            }

            if (random.next() < 0.48) {
              sills.push({
                x: point.x + face.normalX * 0.055,
                y: y - height / 2 - 0.035,
                z: point.z + face.normalZ * 0.055,
                rotationY: face.rotationY,
                scaleX: width + random.range(0.16, 0.34),
                scaleY: 1,
                scaleZ: random.range(0.8, 1.25),
                tint: spec.tint.clone().multiplyScalar(random.range(0.62, 0.92)),
              });
            }
          }
        }
      }

      // Warm shopfront-scale windows at street level.
      if (random.next() < 0.55) {
        const point = facePoint(spec, 0, random.range(-0.3, 0.3) * spec.width, 0.04);
        lit.push({
          x: point.x,
          y: 1.15,
          z: point.z,
          rotationY: 0,
          scaleX: random.range(0.9, 1.7),
          scaleY: random.range(1.2, 1.9),
          scaleZ: 1,
          tint: new THREE.Color(1.0, random.range(0.45, 0.68), 0.24),
        });
      }
    }

    return { lit, dark, sills };
  }

  private buildWindowMeshes(windows: WindowBuild): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(geometry);

    const litTexture = createWindowTexture(true);
    const darkTexture = createWindowTexture(false);
    this.ownedTextures.push(litTexture, darkTexture);

    const litMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: litTexture,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: true,
    });
    applyCityWrap(litMaterial);
    this.materials.push(litMaterial);

    const darkMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: darkTexture,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: true,
    });
    applyCityWrap(darkMaterial);
    this.materials.push(darkMaterial);

    this.addInstances(geometry, darkMaterial, windows.dark, 'mohalla-dark-windows');
    this.addInstances(geometry, litMaterial, windows.lit, 'mohalla-lit-windows');

    const sillGeometry = createSillGeometry();
    this.geometries.push(sillGeometry);
    const sillMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.01,
    });
    applyCityWrap(sillMaterial);
    this.materials.push(sillMaterial);
    this.addInstances(sillGeometry, sillMaterial, windows.sills, 'mohalla-window-sills');
  }

  private buildFacadeDetails(
    random: Random,
    glowSources: GlowSpec[],
  ): void {
    const stoneTexture = createConcreteTexture();
    this.ownedTextures.push(stoneTexture);
    const stoneMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: stoneTexture,
      roughness: 0.92,
      metalness: 0.015,
    });
    applyCityWrap(stoneMaterial);
    this.materials.push(stoneMaterial);

    const darkMetal = new THREE.MeshStandardMaterial({
      color: 0x202329,
      roughness: 0.58,
      metalness: 0.55,
    });
    applyCityWrap(darkMetal);
    this.materials.push(darkMetal);

    const awningMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: stoneTexture,
      roughness: 0.82,
      metalness: 0.05,
    });
    applyCityWrap(awningMaterial);
    this.materials.push(awningMaterial);

    const parapets: DetailSpec[] = [];
    const courses: DetailSpec[] = [];
    const balconies: DetailSpec[] = [];
    const awnings: DetailSpec[] = [];
    const acUnits: DetailSpec[] = [];
    const pipes: DetailSpec[] = [];

    for (const spec of this.specs) {
      const parapetY = spec.height + 0.27;
      const parapetTint = spec.tint.clone().multiplyScalar(0.88);
      parapets.push(
        {
          x: spec.x,
          y: parapetY,
          z: spec.z + spec.depth / 2 - 0.09,
          rotationY: 0,
          scaleX: spec.width,
          scaleY: 0.54,
          scaleZ: 0.18,
          tint: parapetTint,
        },
        {
          x: spec.x,
          y: parapetY,
          z: spec.z - spec.depth / 2 + 0.09,
          rotationY: 0,
          scaleX: spec.width,
          scaleY: 0.54,
          scaleZ: 0.18,
          tint: parapetTint,
        },
        {
          x: spec.x + spec.width / 2 - 0.09,
          y: parapetY,
          z: spec.z,
          rotationY: 0,
          scaleX: 0.18,
          scaleY: 0.54,
          scaleZ: spec.depth,
          tint: parapetTint,
        },
        {
          x: spec.x - spec.width / 2 + 0.09,
          y: parapetY,
          z: spec.z,
          rotationY: 0,
          scaleX: 0.18,
          scaleY: 0.54,
          scaleZ: spec.depth,
          tint: parapetTint,
        },
      );

      const courseTint = spec.tint.clone().multiplyScalar(0.72);
      for (const level of [3.05, 6.15]) {
        if (level > spec.height - 1.2) continue;
        courses.push(
          {
            x: spec.x,
            y: level,
            z: spec.z + spec.depth / 2 + 0.035,
            rotationY: 0,
            scaleX: spec.width + 0.08,
            scaleY: 0.12,
            scaleZ: 0.16,
            tint: courseTint,
          },
          {
            x: spec.x,
            y: level,
            z: spec.z - spec.depth / 2 - 0.035,
            rotationY: 0,
            scaleX: spec.width + 0.08,
            scaleY: 0.12,
            scaleZ: 0.16,
            tint: courseTint,
          },
        );
      }

      if (random.next() < 0.4 && spec.height > 6.2) {
        const faceIndex = random.next() < 0.66 ? 0 : random.int(1, 4);
        const face = getFace(spec, faceIndex);
        const level = random.next() < 0.58 ? 3.35 : 6.35;
        if (level < spec.height - 1.2) {
          const point = facePoint(
            spec,
            faceIndex,
            random.range(-0.3, 0.3) * face.span,
            0.32,
          );
          balconies.push({
            x: point.x,
            y: level,
            z: point.z,
            rotationY: face.rotationY,
            scaleX: random.range(0.72, 1.08) * Math.min(1, face.span / 9),
            scaleY: random.range(0.9, 1.08),
            scaleZ: random.range(0.82, 1.08),
            tint: spec.tint.clone().multiplyScalar(random.range(0.56, 0.82)),
          });
        }
      }

      if (random.next() < 0.62) {
        const point = facePoint(spec, 0, random.range(-0.28, 0.28) * spec.width, 0.48);
        awnings.push({
          x: point.x,
          y: 2.72,
          z: point.z,
          rotationY: 0,
          scaleX: random.range(0.72, 1.2),
          scaleY: 1,
          scaleZ: random.range(0.82, 1.18),
          tint: random.next() < 0.5
            ? new THREE.Color(0.24, 0.36, 0.37)
            : new THREE.Color(0.48, 0.28, 0.2),
        });
      }

      if (random.next() < 0.44) {
        const faceIndex = random.next() < 0.72 ? 0 : random.int(1, 4);
        const face = getFace(spec, faceIndex);
        const level = random.next() < 0.55 ? 3.8 : 6.6;
        if (level < spec.height - 0.9) {
          const point = facePoint(
            spec,
            faceIndex,
            random.range(-0.32, 0.32) * face.span,
            0.24,
          );
          acUnits.push({
            x: point.x,
            y: level,
            z: point.z,
            rotationY: face.rotationY,
            scaleX: random.range(0.9, 1.18),
            scaleY: random.range(0.9, 1.15),
            scaleZ: random.range(0.9, 1.15),
            tint: new THREE.Color(0.64, 0.65, 0.64).multiplyScalar(random.range(0.7, 1)),
          });
        }
      }

      if (random.next() < 0.7) {
        const side = random.next() < 0.5 ? -1 : 1;
        pipes.push({
          x: spec.x + side * (spec.width / 2 - 0.32),
          y: spec.height / 2,
          z: spec.z + spec.depth / 2 + 0.075,
          rotationY: 0,
          scaleX: 1,
          scaleY: Math.max(1, spec.height - 0.5),
          scaleZ: 1,
          tint: new THREE.Color(0.18, 0.19, 0.2),
        });
      }
    }

    const parapetGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(parapetGeometry);
    this.addInstances(parapetGeometry, stoneMaterial, parapets, 'mohalla-parapets');
    this.addInstances(parapetGeometry, stoneMaterial, courses, 'mohalla-string-courses');

    const balconyGeometry = createBalconyGeometry();
    this.geometries.push(balconyGeometry);
    this.addInstances(balconyGeometry, darkMetal, balconies, 'mohalla-balconies');

    const awningGeometry = createAwningGeometry();
    this.geometries.push(awningGeometry);
    this.addInstances(awningGeometry, awningMaterial, awnings, 'mohalla-awnings');

    const acGeometry = createAcGeometry();
    this.geometries.push(acGeometry);
    this.addInstances(acGeometry, darkMetal, acUnits, 'mohalla-ac-units');

    const pipeGeometry = new THREE.CylinderGeometry(0.045, 0.052, 1, 6, 1, true);
    this.geometries.push(pipeGeometry);
    this.addInstances(pipeGeometry, darkMetal, pipes, 'mohalla-facade-pipes');

    this.buildShopfronts(random, glowSources, awnings);
  }

  private buildShopfronts(
    random: Random,
    glowSources: GlowSpec[],
    awnings: DetailSpec[],
  ): void {
    const shopTexture = createShopfrontTexture();
    this.ownedTextures.push(shopTexture);
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(geometry);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: shopTexture,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: true,
    });
    applyCityWrap(material);
    this.materials.push(material);

    const shops: DetailSpec[] = [];
    for (const spec of this.specs) {
      const count = random.next() < 0.72 ? random.int(1, 3) : 0;
      for (let index = 0; index < count; index += 1) {
        const faceIndex = random.next() < 0.82 ? 0 : random.int(1, 4);
        const face = getFace(spec, faceIndex);
        const point = facePoint(
          spec,
          faceIndex,
          random.range(-0.3, 0.3) * face.span,
          0.045,
        );
        const width = random.range(1.8, 3.4);
        const lit = random.next() < 0.62;
        shops.push({
          x: point.x,
          y: random.range(1.15, 1.4),
          z: point.z,
          rotationY: face.rotationY,
          scaleX: width,
          scaleY: random.range(2.1, 2.7),
          scaleZ: 1,
          tint: lit
            ? new THREE.Color(1.0, random.range(0.72, 0.9), random.range(0.58, 0.74))
            : new THREE.Color(0.33, 0.38, 0.4),
        });

        if (lit) {
          glowSources.push({
            position: new THREE.Vector3(
              point.x + face.normalX * 0.22,
              1.28,
              point.z + face.normalZ * 0.22,
            ),
            color: new THREE.Color(1.0, 0.55, 0.22),
            size: random.range(0.55, 0.92),
            phase: random.range(0, Math.PI * 2),
          });
        }

        if (random.next() < 0.56) {
          awnings.push({
            x: point.x,
            y: 2.62,
            z: point.z,
            rotationY: face.rotationY,
            scaleX: width / 2.2,
            scaleY: 1,
            scaleZ: random.range(0.9, 1.22),
            tint: random.next() < 0.5
              ? new THREE.Color(0.28, 0.42, 0.4)
              : new THREE.Color(0.58, 0.3, 0.19),
          });
        }

        if (random.next() < 0.42) {
          this.groundPools.push({
            x: point.x + face.normalX * random.range(1.2, 3.2),
            y: 0.025,
            z: point.z + face.normalZ * random.range(1.2, 3.2),
            rotationY: 0,
            scaleX: random.range(3.2, 5.8),
            scaleY: 1,
            scaleZ: random.range(3.2, 5.8),
            tint: new THREE.Color(1.0, random.range(0.42, 0.62), 0.18),
          });
        }
      }
    }

    this.addInstances(geometry, material, shops, 'mohalla-shopfronts');

    const awningGeometry = createAwningGeometry();
    this.geometries.push(awningGeometry);
    const awningMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.84,
      metalness: 0.03,
    });
    applyCityWrap(awningMaterial);
    this.materials.push(awningMaterial);
    this.addInstances(awningGeometry, awningMaterial, awnings, 'mohalla-shop-awnings');
  }

  private buildRoofScape(random: Random, glowSources: GlowSpec[]): void {
    const tanks: DetailSpec[] = [];
    const huts: DetailSpec[] = [];
    const antennas: DetailSpec[] = [];
    const dishes: DetailSpec[] = [];
    const plants: DetailSpec[] = [];
    const bulbs: BulbSpec[] = [];
    const darkTint = new THREE.Color(0.16, 0.18, 0.2);
    const warmBulb = new THREE.Color(1.0, 0.48, 0.16);
    const paleBulb = new THREE.Color(1.0, 0.72, 0.4);
    const festivalPalette = [
      warmBulb,
      paleBulb,
      new THREE.Color(1.0, 0.56, 0.24),
      new THREE.Color(0.94, 0.26, 0.6),
      new THREE.Color(0.38, 0.62, 1.0),
    ];

    for (const spec of this.specs) {
      const roll = random.next();
      if (roll < 0.3) {
        tanks.push({
          x: spec.x + random.range(-0.22, 0.22) * spec.width,
          y: spec.height + random.range(0.5, 0.85),
          z: spec.z + random.range(-0.22, 0.22) * spec.depth,
          rotationY: random.range(0, Math.PI * 2),
          scaleX: random.range(0.75, 1.25),
          scaleY: random.range(0.7, 1.15),
          scaleZ: random.range(0.75, 1.25),
          tint: darkTint,
        });
      } else if (roll < 0.52) {
        huts.push({
          x: spec.x + random.range(-0.2, 0.2) * spec.width,
          y: spec.height + 0.62,
          z: spec.z + random.range(-0.2, 0.2) * spec.depth,
          rotationY: 0,
          scaleX: random.range(1.5, 3.1),
          scaleY: random.range(1.1, 1.9),
          scaleZ: random.range(1.4, 2.7),
          tint: spec.tint.clone().multiplyScalar(0.55),
        });
      }

      if (random.next() < 0.3) {
        antennas.push({
          x: spec.x + random.range(-0.4, 0.4) * spec.width,
          y: spec.height + random.range(0.9, 2.1),
          z: spec.z + random.range(-0.4, 0.4) * spec.depth,
          rotationY: 0,
          scaleX: 1,
          scaleY: random.range(1.8, 4.4),
          scaleZ: 1,
          tint: darkTint,
        });
      }

      if (random.next() < 0.3) {
        dishes.push({
          x: spec.x + random.range(-0.34, 0.34) * spec.width,
          y: spec.height + 0.04,
          z: spec.z + random.range(-0.34, 0.34) * spec.depth,
          rotationY: random.range(0, Math.PI * 2),
          scaleX: random.range(0.8, 1.22),
          scaleY: random.range(0.85, 1.2),
          scaleZ: random.range(0.8, 1.22),
          tint: new THREE.Color(0.58, 0.59, 0.58).multiplyScalar(random.range(0.6, 1)),
        });
      }

      if (random.next() < 0.24) {
        plants.push({
          x: spec.x + random.range(-0.38, 0.38) * spec.width,
          y: spec.height + 0.02,
          z: spec.z + random.range(-0.38, 0.38) * spec.depth,
          rotationY: random.range(0, Math.PI * 2),
          scaleX: random.range(0.8, 1.3),
          scaleY: random.range(0.8, 1.35),
          scaleZ: random.range(0.8, 1.3),
          tint: new THREE.Color(0.36, 0.45, 0.28).multiplyScalar(random.range(0.6, 1)),
        });
      }

      if (random.next() < 0.42) {
        const count = random.int(4, 8);
        const edge = random.int(0, 4);
        const sag = random.range(0.15, 0.42);
        for (let index = 0; index < count; index += 1) {
          const t = (index + 1) / (count + 1);
          let x: number;
          let z: number;
          if (edge === 0) {
            x = spec.x + (t - 0.5) * spec.width * 0.82;
            z = spec.z + spec.depth / 2 + 0.08;
          } else if (edge === 1) {
            x = spec.x + (t - 0.5) * spec.width * 0.82;
            z = spec.z - spec.depth / 2 - 0.08;
          } else if (edge === 2) {
            x = spec.x + spec.width / 2 + 0.08;
            z = spec.z + (t - 0.5) * spec.depth * 0.82;
          } else {
            x = spec.x - spec.width / 2 - 0.08;
            z = spec.z + (t - 0.5) * spec.depth * 0.82;
          }
          const y = spec.height + 0.34 - Math.sin(t * Math.PI) * sag;
          const color =
            index % 3 === 0
              ? festivalPalette[random.int(0, festivalPalette.length)]!.clone()
              : warmBulb.clone();
          bulbs.push({ position: new THREE.Vector3(x, y, z), color });
          if (random.next() < 0.35) {
            glowSources.push({
              position: new THREE.Vector3(x, y, z),
              color: color.clone().multiplyScalar(0.8),
              size: random.range(0.26, 0.46),
              phase: random.range(0, Math.PI * 2),
            });
          }
        }
      }
    }

    const instancedMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.84,
      metalness: 0.08,
    });
    applyCityWrap(instancedMaterial);
    this.materials.push(instancedMaterial);

    const tankGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
    this.geometries.push(tankGeometry);
    this.addInstances(tankGeometry, instancedMaterial, tanks, 'mohalla-roof-tanks');

    const hutGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(hutGeometry);
    this.addInstances(hutGeometry, instancedMaterial, huts, 'mohalla-roof-mumties');

    const antennaGeometry = new THREE.CylinderGeometry(0.015, 0.02, 1, 4);
    this.geometries.push(antennaGeometry);
    this.addInstances(antennaGeometry, instancedMaterial, antennas, 'mohalla-antennas');

    const dishGeometry = createDishGeometry();
    this.geometries.push(dishGeometry);
    this.addInstances(dishGeometry, instancedMaterial, dishes, 'mohalla-dishes');

    const plantGeometry = createPlantGeometry();
    this.geometries.push(plantGeometry);
    this.addInstances(plantGeometry, instancedMaterial, plants, 'mohalla-roof-plants');

    const bulbGeometry = new THREE.OctahedronGeometry(0.034, 0);
    this.geometries.push(bulbGeometry);
    const bulbMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
      fog: true,
    });
    applyCityWrap(bulbMaterial);
    this.materials.push(bulbMaterial);

    const bulbMesh = new THREE.InstancedMesh(bulbGeometry, bulbMaterial, bulbs.length);
    bulbMesh.name = 'mohalla-string-lights';
    bulbMesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    bulbs.forEach((bulb, index) => {
      matrix.makeTranslation(bulb.position.x, bulb.position.y, bulb.position.z);
      bulbMesh.setMatrixAt(index, matrix);
      bulbMesh.setColorAt(index, bulb.color);
    });
    bulbMesh.instanceMatrix.needsUpdate = true;
    if (bulbMesh.instanceColor) bulbMesh.instanceColor.needsUpdate = true;
    this.group.add(bulbMesh);
  }

  private buildStreetDetails(random: Random, glowSources: GlowSpec[]): void {
    const lamps: DetailSpec[] = [];
    const darkMetal = new THREE.MeshStandardMaterial({
      color: 0x24272c,
      roughness: 0.58,
      metalness: 0.46,
    });
    applyCityWrap(darkMetal);
    this.materials.push(darkMetal);

    const lampGeometry = createStreetLampGeometry();
    this.geometries.push(lampGeometry);
    const lampHead = new THREE.Vector3(0.58, 3.28, 0);

    const addLamp = (x: number, z: number, rotationY: number): void => {
      lamps.push({
        x,
        y: 0,
        z,
        rotationY,
        scaleX: 1,
        scaleY: random.range(0.92, 1.08),
        scaleZ: 1,
        tint: new THREE.Color(0.54, 0.55, 0.56).multiplyScalar(random.range(0.78, 1)),
      });

      const head = lampHead.clone().applyAxisAngle(UP, rotationY);
      glowSources.push({
        position: new THREE.Vector3(x + head.x, head.y, z + head.z),
        color: new THREE.Color(1.0, random.range(0.34, 0.48), 0.13),
        size: random.range(2.1, 3.1),
        phase: random.range(0, Math.PI * 2),
      });

      this.groundPools.push({
        x: x + head.x,
        y: 0.022,
        z: z + head.z,
        rotationY: 0,
        scaleX: random.range(6.6, 10.2),
        scaleY: 1,
        scaleZ: random.range(6.6, 10.2),
        tint: new THREE.Color(1.0, random.range(0.3, 0.44), 0.09),
      });
    };

    // Courtyard lamps between the blocks.
    for (let index = 0; index < 68; index += 1) {
      let x = 0;
      let z = 0;
      let valid = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        x = random.range(-CITY_HALF + 12, CITY_HALF - 12);
        z = random.range(-CITY_HALF + 12, CITY_HALF - 12);
        if (!this.pointInsideBuilding(x, z, 1.1)) {
          valid = true;
          break;
        }
      }
      if (!valid) continue;
      addLamp(x, z, random.range(0, Math.PI * 2));
    }

    // A regular rhythm of lamps down each arterial. The arm always points at
    // the asphalt, so every street reads as a lit corridor from above.
    for (const lane of MAJOR_LANES) {
      let step = 0;
      for (let along = -CITY_HALF + 20; along < CITY_HALF - 12; along += 44) {
        const side = step % 2 === 0 ? 1 : -1;
        step += 1;

        const x = lane + side * 9.7;
        if (!this.pointInsideBuilding(x, along, 0.9)) {
          addLamp(x, along, side > 0 ? Math.PI : 0);
        }

        const z = lane + side * 9.7;
        if (!this.pointInsideBuilding(along, z, 0.9)) {
          addLamp(along, z, side > 0 ? Math.PI / 2 : -Math.PI / 2);
        }
      }
    }

    this.addInstances(lampGeometry, darkMetal, lamps, 'mohalla-street-lamps');
  }

  /**
   * Arterial asphalt, raised paver footpaths and curbs. The lanes are the same
   * gaps the building generator leaves open, so the streets actually line up
   * with the map instead of being painted on top of the blocks.
   */
  private buildRoadNetwork(random: Random, textures: ProceduralTextures): void {
    const asphaltMap = this.cloneTexture(textures.asphalt, 2, 64, false);
    const asphaltMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: asphaltMap,
      roughness: 0.82,
      metalness: 0.04,
    });
    applyCityWrap(asphaltMaterial);
    this.materials.push(asphaltMaterial);

    const paverMap = this.cloneTexture(textures.pavers, 1, 100, false);
    const paverMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: paverMap,
      roughness: 0.95,
      metalness: 0.01,
    });
    applyCityWrap(paverMaterial);
    this.materials.push(paverMaterial);

    const roadGeometry = new THREE.PlaneGeometry(16, CITY_PERIOD);
    roadGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(roadGeometry);

    const sidewalkGeometry = new THREE.PlaneGeometry(2.4, CITY_PERIOD);
    sidewalkGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(sidewalkGeometry);

    const curbGeometry = new THREE.BoxGeometry(0.24, 0.16, CITY_PERIOD);
    this.geometries.push(curbGeometry);

    const roads: DetailSpec[] = [];
    const sidewalks: DetailSpec[] = [];
    const curbs: DetailSpec[] = [];
    const roadTint = new THREE.Color(0.9, 0.9, 0.9);

    const addCrossSection = (
      lane: number,
      alongX: boolean,
    ): void => {
      const rotationY = alongX ? Math.PI / 2 : 0;
      const x = alongX ? 0 : lane;
      const z = alongX ? lane : 0;

      roads.push({
        x,
        y: alongX ? 0.016 : 0.012,
        z,
        rotationY,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
        tint: roadTint,
      });

      for (const side of [-1, 1] as const) {
        const offset = side * 9.15;
        sidewalks.push({
          x: alongX ? 0 : lane + offset,
          y: 0.07,
          z: alongX ? lane + offset : 0,
          rotationY,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
          tint: new THREE.Color(0.88, 0.86, 0.82).multiplyScalar(random.range(0.92, 1.04)),
        });
        curbs.push({
          x: alongX ? 0 : lane + side * 8.15,
          y: 0.09,
          z: alongX ? lane + side * 8.15 : 0,
          rotationY,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
          tint: new THREE.Color(0.74, 0.72, 0.68).multiplyScalar(random.range(0.9, 1.04)),
        });
      }
    };

    for (const lane of MAJOR_LANES) {
      addCrossSection(lane, false);
      addCrossSection(lane, true);
    }

    this.addInstances(roadGeometry, asphaltMaterial, roads, 'mohalla-arterial-asphalt');
    this.addInstances(sidewalkGeometry, paverMaterial, sidewalks, 'mohalla-pavements');
    this.addInstances(curbGeometry, paverMaterial, curbs, 'mohalla-curbs');

    // Every building gets a low plinth, which reads as swept concrete around
    // the base and stops the walls floating on the street texture.
    const plinthGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(plinthGeometry);
    const plinthMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.01,
    });
    applyCityWrap(plinthMaterial);
    this.materials.push(plinthMaterial);
    const plinths: DetailSpec[] = this.specs.map((spec) => ({
      x: spec.x,
      y: 0.11,
      z: spec.z,
      rotationY: 0,
      scaleX: spec.width + 0.5,
      scaleY: 0.22,
      scaleZ: spec.depth + 0.5,
      tint: spec.tint.clone().multiplyScalar(0.78),
    }));
    this.addInstances(plinthGeometry, plinthMaterial, plinths, 'mohalla-building-plinths');

    this.collectEmptyCells();
  }

  /** Empty 16 m cells become walled courtyards instead of black holes. */
  private buildEmptyLots(random: Random): void {
    const wallGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(wallGeometry);
    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0.01,
    });
    applyCityWrap(wallMaterial);
    this.materials.push(wallMaterial);

    const walls: DetailSpec[] = [];
    const nearLane = (value: number): boolean =>
      MAJOR_LANES.some((lane) => Math.abs(value - lane) < 9.5);

    for (const cell of this.emptyCells) {
      if (nearLane(cell.x) || nearLane(cell.z)) continue;
      if (random.next() > 0.58) continue;

      const tint = new THREE.Color(0.68, 0.6, 0.5).multiplyScalar(random.range(0.82, 1.08));
      const edges = [
        { x: cell.x, z: cell.z + 7.6, rotationY: 0 },
        { x: cell.x, z: cell.z - 7.6, rotationY: 0 },
        { x: cell.x + 7.6, z: cell.z, rotationY: Math.PI / 2 },
        { x: cell.x - 7.6, z: cell.z, rotationY: Math.PI / 2 },
      ];

      const count = random.int(2, 4);
      for (let index = 0; index < count; index += 1) {
        const edge = edges[random.int(0, edges.length)]!;
        const length = random.range(4.2, 6.4);
        const shift = random.range(-2.2, 2.2);
        walls.push({
          x: edge.x + (edge.rotationY === 0 ? shift : 0),
          y: 0.42,
          z: edge.z + (edge.rotationY === 0 ? 0 : shift),
          rotationY: edge.rotationY,
          scaleX: length,
          scaleY: 0.84,
          scaleZ: 0.16,
          tint,
        });
      }
    }

    this.addInstances(wallGeometry, wallMaterial, walls, 'mohalla-courtyard-walls');
  }

  private buildTrees(random: Random): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.15, 0.25, 2.9, 5);
    trunkGeometry.translate(0, 1.45, 0);
    this.geometries.push(trunkGeometry);

    const canopyGeometry = createTreeCanopyGeometry();
    this.geometries.push(canopyGeometry);

    const bushGeometry = new THREE.IcosahedronGeometry(0.82, 0);
    bushGeometry.scale(1, 0.68, 1);
    bushGeometry.translate(0, 0.5, 0);
    this.geometries.push(bushGeometry);

    const trunkMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a2b1f,
      roughness: 1,
      metalness: 0,
    });
    applyCityWrap(trunkMaterial);
    this.materials.push(trunkMaterial);

    const leafMaterial = new THREE.MeshStandardMaterial({
      color: 0x243a22,
      roughness: 1,
      metalness: 0,
    });
    applyCityWrap(leafMaterial);
    this.materials.push(leafMaterial);

    const trunks: DetailSpec[] = [];
    const canopies: DetailSpec[] = [];
    const bushes: DetailSpec[] = [];

    const addTree = (x: number, z: number, scale: number): void => {
      if (this.pointInsideBuilding(x, z, 1.4)) return;
      const rotationY = random.range(0, Math.PI * 2);
      const tint = new THREE.Color(0.72, 0.82, 0.66).multiplyScalar(random.range(0.72, 1.12));
      trunks.push({
        x,
        y: 0,
        z,
        rotationY,
        scaleX: scale * random.range(0.86, 1.06),
        scaleY: scale,
        scaleZ: scale * random.range(0.86, 1.06),
        tint: new THREE.Color(0.8, 0.7, 0.58),
      });
      canopies.push({
        x,
        y: 0,
        z,
        rotationY,
        scaleX: scale * random.range(0.9, 1.12),
        scaleY: scale * random.range(0.88, 1.08),
        scaleZ: scale * random.range(0.9, 1.12),
        tint,
      });
    };

    for (const cell of this.emptyCells) {
      if (random.next() > 0.48) continue;
      addTree(
        cell.x + random.range(-3.6, 3.6),
        cell.z + random.range(-3.6, 3.6),
        random.range(0.8, 1.5),
      );
      if (random.next() < 0.45) {
        bushes.push({
          x: cell.x + random.range(-5.4, 5.4),
          y: 0,
          z: cell.z + random.range(-5.4, 5.4),
          rotationY: random.range(0, Math.PI * 2),
          scaleX: random.range(0.7, 1.4),
          scaleY: random.range(0.7, 1.2),
          scaleZ: random.range(0.7, 1.4),
          tint: new THREE.Color(0.6, 0.75, 0.55).multiplyScalar(random.range(0.7, 1.1)),
        });
      }
    }

    // Street trees in the pavement margins.
    for (const lane of MAJOR_LANES) {
      let step = 0;
      for (let along = -CITY_HALF + 26; along < CITY_HALF - 18; along += 31) {
        const side = step % 2 === 0 ? 1 : -1;
        step += 1;
        const x = lane + side * 12.4;
        if (!this.pointInsideBuilding(x, along, 1.7)) {
          addTree(x, along, random.range(1.05, 1.8));
        }
        const z = lane + side * 12.4;
        if (!this.pointInsideBuilding(along, z, 1.7)) {
          addTree(along, z, random.range(1.05, 1.8));
        }
      }
    }

    // Planters along the courtyard walls.
    for (const cell of this.emptyCells) {
      if (random.next() > 0.35) continue;
      bushes.push({
        x: cell.x + random.range(-6.2, 6.2),
        y: 0,
        z: cell.z + random.range(-6.2, 6.2),
        rotationY: random.range(0, Math.PI * 2),
        scaleX: random.range(0.6, 1.2),
        scaleY: random.range(0.55, 1),
        scaleZ: random.range(0.6, 1.2),
        tint: new THREE.Color(0.58, 0.72, 0.52).multiplyScalar(random.range(0.68, 1.16)),
      });
    }

    this.addInstances(trunkGeometry, trunkMaterial, trunks, 'mohalla-tree-trunks');
    this.addInstances(canopyGeometry, leafMaterial, canopies, 'mohalla-tree-canopies');
    this.addInstances(bushGeometry, leafMaterial, bushes, 'mohalla-bushes');
  }

  private buildVehicles(random: Random): void {
    const bodyGeometry = createCarBodyGeometry();
    this.geometries.push(bodyGeometry);
    const detailGeometry = createCarDetailGeometry();
    this.geometries.push(detailGeometry);

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.34,
      metalness: 0.58,
    });
    applyCityWrap(bodyMaterial);
    this.materials.push(bodyMaterial);

    const detailMatererial = new THREE.MeshStandardMaterial({
      color: 0x090b0d,
      roughness: 0.48,
      metalness: 0.24,
    });
    applyCityWrap(detailMatererial);
    this.materials.push(detailMatererial);

    const carTints = [
      new THREE.Color(0.78, 0.78, 0.74),
      new THREE.Color(0.1, 0.11, 0.13),
      new THREE.Color(0.56, 0.13, 0.1),
      new THREE.Color(0.17, 0.23, 0.33),
      new THREE.Color(0.74, 0.68, 0.52),
      new THREE.Color(0.36, 0.38, 0.37),
    ];

    const bodies: DetailSpec[] = [];
    const details: DetailSpec[] = [];
    let placed = 0;

    for (const lane of MAJOR_LANES) {
      let step = 0;
      for (let along = -CITY_HALF + 18; along < CITY_HALF - 14; along += 34) {
        if (random.next() > 0.44) {
          step += 1;
          continue;
        }
        const side = step % 2 === 0 ? 1 : -1;
        step += 1;

        for (const alongX of [false, true]) {
          const x = alongX ? along : lane + side * 6.6;
          const z = alongX ? lane + side * 6.6 : along;
          if (this.pointInsideBuilding(x, z, 2.6)) continue;
          if (Math.hypot(x, z) < 17) continue;

          const facing = random.next() > 0.5 ? 0 : Math.PI;
          const rotationY = alongX ? facing + Math.PI / 2 : facing;
          const tint = carTints[random.int(0, carTints.length)]!.clone()
            .multiplyScalar(random.range(0.82, 1.1));
          const base = {
            x,
            y: 0,
            z,
            rotationY,
            scaleX: random.range(0.94, 1.06),
            scaleY: random.range(0.92, 1.04),
            scaleZ: random.range(0.92, 1.06),
          };
          bodies.push({ ...base, tint });
          details.push({ ...base, tint: new THREE.Color(0.16, 0.17, 0.18) });
          placed += 1;
        }

        if (placed >= 30) break;
      }
      if (placed >= 30) break;
    }

    this.addInstances(bodyGeometry, bodyMaterial, bodies, 'mohalla-parked-cars');
    this.addInstances(detailGeometry, detailMatererial, details, 'mohalla-car-wheels');

    // Scooters tucked against the walls, using the same dark detail material.
    const scooterBody = createScooterBodyGeometry();
    this.geometries.push(scooterBody);
    const scooterDetail = createScooterDetailGeometry();
    this.geometries.push(scooterDetail);

    const scooterBodies: DetailSpec[] = [];
    const scooterDetails: DetailSpec[] = [];
    for (const cell of this.emptyCells) {
      if (scooterBodies.length >= 14) break;
      if (random.next() > 0.42) continue;

      const x = cell.x + random.range(-4.8, 4.8);
      const z = cell.z + random.range(-4.8, 4.8);
      if (this.pointInsideBuilding(x, z, 1.2)) continue;
      if (Math.hypot(x, z) < 17) continue;

      const rotationY = random.range(0, Math.PI * 2);
      const base = {
        x,
        y: 0,
        z,
        rotationY,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      };
      scooterBodies.push({
        ...base,
        tint: carTints[random.int(0, carTints.length)]!.clone(),
      });
      scooterDetails.push({ ...base, tint: new THREE.Color(0.12, 0.13, 0.14) });
    }

    this.addInstances(scooterBody, bodyMaterial, scooterBodies, 'mohalla-scooters');
    this.addInstances(scooterDetail, detailMatererial, scooterDetails, 'mohalla-scooter-wheels');
  }

  private buildStreetProps(random: Random): void {
    const concrete = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.96,
      metalness: 0.01,
    });
    applyCityWrap(concrete);
    this.materials.push(concrete);

    const woodMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.02,
    });
    applyCityWrap(woodMaterial);
    this.materials.push(woodMaterial);

    const potteryMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.01,
    });
    applyCityWrap(potteryMaterial);
    this.materials.push(potteryMaterial);

    const crateGeometry = new THREE.BoxGeometry(0.74, 0.56, 0.74);
    this.geometries.push(crateGeometry);
    const potGeometry = new THREE.CylinderGeometry(0.24, 0.16, 0.44, 5);
    potGeometry.translate(0, 0.22, 0);
    this.geometries.push(potGeometry);
    const cartGeometry = createHandcartGeometry();
    this.geometries.push(cartGeometry);

    const crates: DetailSpec[] = [];
    const pots: DetailSpec[] = [];
    const carts: DetailSpec[] = [];

    for (const cell of this.emptyCells) {
      if (random.next() < 0.5) {
        const x = cell.x + random.range(-5.6, 5.6);
        const z = cell.z + random.range(-5.6, 5.6);
        if (!this.pointInsideBuilding(x, z, 0.9)) {
          crates.push({
            x,
            y: 0.28,
            z,
            rotationY: random.range(0, Math.PI * 2),
            scaleX: random.range(0.8, 1.25),
            scaleY: random.range(0.7, 1.2),
            scaleZ: random.range(0.8, 1.25),
            tint: new THREE.Color(0.48, 0.34, 0.21).multiplyScalar(random.range(0.7, 1.1)),
          });
        }
      }

      if (random.next() < 0.62) {
        const count = random.int(2, 4);
        for (let index = 0; index < count; index += 1) {
          const x = cell.x + random.range(-5.8, 5.8);
          const z = cell.z + random.range(-5.8, 5.8);
          if (this.pointInsideBuilding(x, z, 0.7)) continue;
          pots.push({
            x,
            y: 0,
            z,
            rotationY: random.range(0, Math.PI * 2),
            scaleX: random.range(0.7, 1.3),
            scaleY: random.range(0.8, 1.5),
            scaleZ: random.range(0.7, 1.3),
            tint: new THREE.Color(0.55, 0.29, 0.17).multiplyScalar(random.range(0.72, 1.08)),
          });
        }
      }

      if (carts.length < 9 && random.next() < 0.16) {
        const x = cell.x + random.range(-3.8, 3.8);
        const z = cell.z + random.range(-3.8, 3.8);
        if (!this.pointInsideBuilding(x, z, 1.8) && Math.hypot(x, z) > 17) {
          carts.push({
            x,
            y: 0,
            z,
            rotationY: random.range(0, Math.PI * 2),
            scaleX: random.range(0.9, 1.15),
            scaleY: 1,
            scaleZ: random.range(0.9, 1.15),
            tint: new THREE.Color(0.5, 0.34, 0.2).multiplyScalar(random.range(0.72, 1.05)),
          });
        }
      }
    }

    this.addInstances(crateGeometry, woodMaterial, crates, 'mohalla-crates');
    this.addInstances(potGeometry, potteryMaterial, pots, 'mohalla-pots');
    this.addInstances(cartGeometry, concrete, carts, 'mohalla-handcarts');
  }

  private collectEmptyCells(): void {
    if (this.emptyCells.length > 0) return;

    const occupied = new Set<string>();
    for (const spec of this.specs) {
      const ix = Math.floor((spec.x + CITY_HALF) / CITY_CELL);
      const iz = Math.floor((spec.z + CITY_HALF) / CITY_CELL);
      occupied.add(`${ix},${iz}`);
    }

    const laneCells = new Set<string>();
    for (let ix = 0; ix < CITY_GRID; ix += 1) {
      for (let iz = 0; iz < CITY_GRID; iz += 1) {
        if (ix % 7 === 3 || iz % 7 === 3) laneCells.add(`${ix},${iz}`);
      }
    }

    for (let ix = 0; ix < CITY_GRID; ix += 1) {
      for (let iz = 0; iz < CITY_GRID; iz += 1) {
        const key = `${ix},${iz}`;
        if (occupied.has(key) || laneCells.has(key)) continue;
        const x = -CITY_HALF + (ix + 0.5) * CITY_CELL;
        const z = -CITY_HALF + (iz + 0.5) * CITY_CELL;
        // Keep the starting terrace's airspace and the pad clear.
        if (Math.hypot(x, z) < 26) continue;
        this.emptyCells.push({ x, z });
      }
    }
  }

  private buildGroundPools(): void {
    if (this.groundPools.length === 0) return;
    const texture = createGroundPoolTexture();
    this.ownedTextures.push(texture);
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.geometries.push(geometry);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    applyCityWrap(material);
    this.materials.push(material);
    this.addInstances(geometry, material, this.groundPools, 'mohalla-ground-light-pools');
  }

  private pointInsideBuilding(x: number, z: number, margin: number): boolean {
    for (const spec of this.specs) {
      if (
        x > spec.x - spec.width / 2 - margin &&
        x < spec.x + spec.width / 2 + margin &&
        z > spec.z - spec.depth / 2 - margin &&
        z < spec.z + spec.depth / 2 + margin
      ) {
        return true;
      }
    }
    return false;
  }

  private addInstances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    specs: DetailSpec[],
    name: string,
  ): THREE.InstancedMesh | null {
    if (specs.length === 0) return null;

    const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    specs.forEach((spec, index) => {
      position.set(spec.x, spec.y, spec.z);
      quaternion.setFromAxisAngle(UP, spec.rotationY);
      scale.set(spec.scaleX, spec.scaleY, spec.scaleZ);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, spec.tint);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  private cloneTexture(
    texture: THREE.Texture,
    repeatX: number,
    repeatY: number,
    linear: boolean,
  ): THREE.Texture {
    const clone = texture.clone();
    clone.colorSpace = linear ? THREE.NoColorSpace : texture.colorSpace;
    clone.wrapS = THREE.RepeatWrapping;
    clone.wrapT = THREE.RepeatWrapping;
    clone.repeat.set(repeatX, repeatY);
    clone.needsUpdate = true;
    this.ownedTextures.push(clone);
    return clone;
  }

  private syncColliders(cameraPosition: THREE.Vector3): void {
    this.collisionAnchor.set(cameraPosition.x, cameraPosition.z);

    const candidates: Array<{ spec: BuildingSpec; x: number; z: number; distance: number }> = [];
    for (const spec of this.specs) {
      const x = cameraPosition.x + nearestDelta(spec.x, cameraPosition.x);
      const z = cameraPosition.z + nearestDelta(spec.z, cameraPosition.z);
      const distance = Math.hypot(x - cameraPosition.x, z - cameraPosition.z);
      if (distance < COLLISION_RADIUS) {
        candidates.push({ spec, x, z, distance });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const count = Math.min(candidates.length, MAX_CITY_COLLIDERS);

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates[index]!;
      const halfExtents = {
        x: candidate.spec.width / 2,
        y: candidate.spec.height / 2,
        z: candidate.spec.depth / 2,
      };
      const center = { x: candidate.x, y: candidate.spec.height / 2, z: candidate.z };

      let collider = this.colliderPool[index];
      if (!collider) {
        collider = this.physics.raw.createCollider(
          this.physics.rapier.ColliderDesc.cuboid(
            halfExtents.x,
            halfExtents.y,
            halfExtents.z,
          )
            .setTranslation(center.x, center.y, center.z)
            .setFriction(0.82)
            .setRestitution(0.02),
        );
        this.colliderPool.push(collider);
      } else {
        collider.setHalfExtents(halfExtents);
        collider.setTranslation(center);
      }
      collider.setEnabled(true);
    }

    for (let index = count; index < this.colliderPool.length; index += 1) {
      this.colliderPool[index]!.setEnabled(false);
    }
    this.visibleColliderCount = count;
  }

  private createGlowMaterial(glowSources: GlowSpec[], pixelRatio: number): THREE.ShaderMaterial {
    const count = glowSources.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);

    glowSources.forEach((glow, index) => {
      positions[index * 3] = glow.position.x;
      positions[index * 3 + 1] = glow.position.y;
      positions[index * 3 + 2] = glow.position.z;
      colors[index * 3] = glow.color.r;
      colors[index * 3 + 1] = glow.color.g;
      colors[index * 3 + 2] = glow.color.b;
      sizes[index] = glow.size;
      phases[index] = glow.phase;
    });

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
        uCityPeriod: { value: CITY_PERIOD },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uCityPeriod;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec2 delta = position.xz - cameraPosition.xz;
          vec2 wrapped = cameraPosition.xz
            + mod(delta + 0.5 * uCityPeriod, uCityPeriod)
            - 0.5 * uCityPeriod;
          vec4 worldPosition = vec4(wrapped.x, position.y, wrapped.y, 1.0);
          vec4 mvPosition = viewMatrix * worldPosition;
          gl_Position = projectionMatrix * mvPosition;

          float distanceToCamera = max(4.0, -mvPosition.z);
          gl_PointSize = clamp(
            aSize * uPixelRatio * (96.0 / distanceToCamera),
            1.4,
            28.0 * uPixelRatio
          );

          float flicker = 0.86 + 0.14 * sin(uTime * 1.2 + aPhase * 5.0);
          vColor = aColor;
          vAlpha = smoothstep(260.0, 35.0, distanceToCamera) * flicker;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec2 centered = gl_PointCoord * 2.0 - 1.0;
          float radius = dot(centered, centered);
          if (radius > 1.0) discard;
          float core = exp(-radius * 7.0);
          float halo = exp(-radius * 2.1) * 0.35;
          float alpha = clamp((core + halo) * vAlpha, 0.0, 1.0);
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(vColor * 1.3, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'mohalla-window-glow';
    material.userData.points = points;
    this.materials.push(material);
    return material;
  }
}

interface FaceInfo {
  rotationY: number;
  span: number;
  normalX: number;
  normalZ: number;
}

function getFace(spec: BuildingSpec, faceIndex: number): FaceInfo {
  if (faceIndex === 1) {
    return { rotationY: Math.PI, span: spec.width, normalX: 0, normalZ: -1 };
  }
  if (faceIndex === 2) {
    return { rotationY: Math.PI / 2, span: spec.depth, normalX: 1, normalZ: 0 };
  }
  if (faceIndex === 3) {
    return { rotationY: -Math.PI / 2, span: spec.depth, normalX: -1, normalZ: 0 };
  }
  return { rotationY: 0, span: spec.width, normalX: 0, normalZ: 1 };
}

function facePoint(
  spec: BuildingSpec,
  faceIndex: number,
  offset: number,
  outward: number,
): { x: number; z: number } {
  if (faceIndex === 1) {
    return { x: spec.x + offset, z: spec.z - spec.depth / 2 - outward };
  }
  if (faceIndex === 2) {
    return { x: spec.x + spec.width / 2 + outward, z: spec.z - offset };
  }
  if (faceIndex === 3) {
    return { x: spec.x - spec.width / 2 - outward, z: spec.z + offset };
  }
  return { x: spec.x + offset, z: spec.z + spec.depth / 2 + outward };
}

function createTreeCanopyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs = [
    { x: 0, y: 3.8, z: 0, radius: 1.55, squash: 0.82 },
    { x: 0.92, y: 3.1, z: 0.34, radius: 1.08, squash: 0.9 },
    { x: -0.74, y: 4.15, z: -0.26, radius: 1.02, squash: 0.86 },
  ];
  for (const blob of blobs) {
    const geometry = new THREE.IcosahedronGeometry(blob.radius, 0);
    geometry.scale(1, blob.squash, 1);
    geometry.translate(blob.x, blob.y, blob.z);
    parts.push(geometry);
  }
  return mergeParts(parts);
}

function createCarBodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hull = new THREE.BoxGeometry(1.86, 0.56, 4.1);
  hull.translate(0, 0.58, 0);
  parts.push(hull);

  const cabin = new THREE.BoxGeometry(1.62, 0.5, 2.12);
  cabin.translate(0, 1.0, -0.14);
  parts.push(cabin);

  const bonnet = new THREE.BoxGeometry(1.78, 0.14, 0.88);
  bonnet.translate(0, 0.91, 1.42);
  parts.push(bonnet);

  return mergeParts(parts);
}

function createCarDetailGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wheel = new THREE.BoxGeometry(0.2, 0.56, 0.56);
  for (const x of [-0.93, 0.93]) {
    for (const z of [-1.28, 1.28]) {
      const geometry = wheel.clone();
      geometry.translate(x, 0.29, z);
      parts.push(geometry);
    }
  }

  const glass = new THREE.BoxGeometry(1.66, 0.32, 2.18);
  glass.translate(0, 1.04, -0.14);
  parts.push(glass);
  wheel.dispose();

  return mergeParts(parts);
}

function createScooterBodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const floorboard = new THREE.BoxGeometry(0.34, 0.1, 0.98);
  floorboard.translate(0, 0.36, 0.06);
  parts.push(floorboard);

  const seat = new THREE.BoxGeometry(0.35, 0.22, 0.62);
  seat.translate(0, 0.86, 0.3);
  parts.push(seat);

  const apron = new THREE.BoxGeometry(0.4, 0.62, 0.14);
  apron.rotateX(-0.16);
  apron.translate(0, 0.62, -0.48);
  parts.push(apron);

  const tail = new THREE.BoxGeometry(0.36, 0.3, 0.5);
  tail.translate(0, 0.55, 0.52);
  parts.push(tail);

  return mergeParts(parts);
}

function createScooterDetailGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const column = new THREE.BoxGeometry(0.07, 0.74, 0.07);
  column.rotateX(-0.18);
  column.translate(0, 0.74, -0.5);
  parts.push(column);

  const handlebar = new THREE.BoxGeometry(0.64, 0.05, 0.05);
  handlebar.translate(0, 1.09, -0.53);
  parts.push(handlebar);

  for (const z of [-0.58, 0.52]) {
    const wheel = new THREE.BoxGeometry(0.12, 0.48, 0.48);
    wheel.translate(0, 0.24, z);
    parts.push(wheel);
  }

  return mergeParts(parts);
}

function createHandcartGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const bed = new THREE.BoxGeometry(0.96, 0.09, 1.8);
  bed.translate(0, 0.52, 0);
  parts.push(bed);

  for (const x of [-0.46, 0.46]) {
    const rail = new THREE.BoxGeometry(0.05, 0.26, 1.8);
    rail.translate(x, 0.67, 0);
    parts.push(rail);

    const wheel = new THREE.BoxGeometry(0.1, 0.62, 0.62);
    wheel.translate(x, 0.31, 0.16);
    parts.push(wheel);

    const handle = new THREE.BoxGeometry(0.06, 0.06, 0.62);
    handle.translate(x, 0.64, -1.14);
    parts.push(handle);
  }

  return mergeParts(parts);
}

function createBalconyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const slab = new THREE.BoxGeometry(1.8, 0.12, 0.58);
  slab.translate(0, 0, 0.29);
  parts.push(slab);

  const topRail = new THREE.BoxGeometry(1.8, 0.06, 0.06);
  topRail.translate(0, 0.58, 0.56);
  parts.push(topRail);

  const bottomRail = new THREE.BoxGeometry(1.8, 0.04, 0.04);
  bottomRail.translate(0, 0.1, 0.56);
  parts.push(bottomRail);

  for (let index = 0; index < 4; index += 1) {
    const bar = new THREE.BoxGeometry(0.028, 0.48, 0.028);
    bar.translate(-0.66 + index * 0.44, 0.34, 0.56);
    parts.push(bar);
  }

  for (const side of [-1, 1]) {
    const rail = new THREE.BoxGeometry(0.06, 0.06, 0.58);
    rail.translate(side * 0.87, 0.58, 0.29);
    parts.push(rail);

    const bracket = new THREE.BoxGeometry(0.06, 0.32, 0.06);
    bracket.rotateX(0.55);
    bracket.translate(side * 0.66, -0.13, 0.18);
    parts.push(bracket);
  }

  return mergeParts(parts);
}

function createAwningGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const slab = new THREE.BoxGeometry(2.2, 0.06, 0.92);
  slab.rotateX(-0.12);
  slab.translate(0, 0.02, 0.46);
  parts.push(slab);

  for (const side of [-1, 1]) {
    const bracket = new THREE.BoxGeometry(0.06, 0.36, 0.06);
    bracket.rotateX(0.5);
    bracket.translate(side * 0.84, -0.16, 0.24);
    parts.push(bracket);
  }
  return mergeParts(parts);
}

function createAcGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(0.92, 0.64, 0.38);
  body.translate(0, 0, 0.19);
  parts.push(body);

  const fan = new THREE.RingGeometry(0.14, 0.22, 12);
  fan.translate(0, 0.02, 0.382);
  parts.push(fan);

  const bracket = new THREE.BoxGeometry(0.72, 0.05, 0.24);
  bracket.translate(0, -0.35, 0.13);
  parts.push(bracket);

  return mergeParts(parts);
}

function createDishGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pole = new THREE.CylinderGeometry(0.022, 0.03, 1.1, 5);
  pole.translate(0, 0.55, 0);
  parts.push(pole);

  const cone = new THREE.ConeGeometry(0.34, 0.16, 12, 1, true);
  cone.rotateX(Math.PI / 2);
  cone.translate(0, 1.13, 0.1);
  parts.push(cone);

  const arm = new THREE.BoxGeometry(0.035, 0.035, 0.34);
  arm.translate(0, 1.13, 0.34);
  parts.push(arm);

  return mergeParts(parts);
}

function createPlantGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pot = new THREE.CylinderGeometry(0.17, 0.12, 0.28, 8);
  pot.translate(0, 0.14, 0);
  parts.push(pot);

  const foliage = new THREE.IcosahedronGeometry(0.25, 0);
  foliage.scale(1, 1.18, 1);
  foliage.translate(0, 0.47, 0);
  parts.push(foliage);

  return mergeParts(parts);
}

function createStreetLampGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pole = new THREE.CylinderGeometry(0.045, 0.06, 3.4, 6);
  pole.translate(0, 1.7, 0);
  parts.push(pole);

  const arm = new THREE.BoxGeometry(0.62, 0.05, 0.05);
  arm.translate(0.29, 3.36, 0);
  parts.push(arm);

  const head = new THREE.BoxGeometry(0.24, 0.1, 0.16);
  head.translate(0.58, 3.28, 0);
  parts.push(head);

  return mergeParts(parts);
}

function createSillGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const top = new THREE.PlaneGeometry(1, 1);
  top.rotateX(-Math.PI / 2);
  top.scale(1, 1, 0.16);
  top.translate(0, 0, 0.08);
  parts.push(top);

  const fascia = new THREE.PlaneGeometry(1, 0.065);
  fascia.translate(0, -0.033, 0.16);
  parts.push(fascia);

  return mergeParts(parts);
}

function createWindowTexture(lit: boolean): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');

  context.fillStyle = lit ? '#1b1008' : '#080b10';
  context.fillRect(0, 0, size, size);

  const inset = 9;
  if (lit) {
    const gradient = context.createLinearGradient(0, inset, 0, size - inset);
    gradient.addColorStop(0, '#fff0c8');
    gradient.addColorStop(0.45, '#ffc272');
    gradient.addColorStop(1, '#e47f34');
    context.fillStyle = gradient;
    context.fillRect(inset, inset, size - inset * 2, size - inset * 2);

    context.fillStyle = 'rgba(94, 43, 17, 0.32)';
    context.fillRect(inset, inset, size - inset * 2, 22);
    context.fillStyle = 'rgba(70, 34, 15, 0.2)';
    context.fillRect(inset, inset, 20, size - inset * 2);
    context.fillStyle = 'rgba(255, 239, 195, 0.24)';
    context.fillRect(size / 2 - 18, inset, 13, size - inset * 2);
  } else {
    const gradient = context.createLinearGradient(0, inset, 0, size - inset);
    gradient.addColorStop(0, '#1c2a3d');
    gradient.addColorStop(0.55, '#101a28');
    gradient.addColorStop(1, '#070c13');
    context.fillStyle = gradient;
    context.fillRect(inset, inset, size - inset * 2, size - inset * 2);

    context.save();
    context.beginPath();
    context.rect(inset, inset, size - inset * 2, size - inset * 2);
    context.clip();
    context.strokeStyle = 'rgba(124, 164, 209, 0.13)';
    context.lineWidth = 8;
    context.beginPath();
    context.moveTo(-10, 108);
    context.lineTo(138, 30);
    context.moveTo(-10, 128);
    context.lineTo(138, 50);
    context.stroke();
    context.restore();
  }

  context.fillStyle = lit ? 'rgba(28, 14, 5, 0.92)' : 'rgba(5, 7, 10, 0.94)';
  context.fillRect(size / 2 - 3, inset, 6, size - inset * 2);
  context.fillRect(inset, size / 2 - 3, size - inset * 2, 6);
  context.strokeStyle = lit ? 'rgba(32, 16, 6, 0.95)' : 'rgba(3, 5, 8, 0.96)';
  context.lineWidth = 7;
  context.strokeRect(inset, inset, size - inset * 2, size - inset * 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function createShopfrontTexture(): THREE.CanvasTexture {
  const width = 256;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');

  context.fillStyle = '#100c08';
  context.fillRect(0, 0, width, height);

  const interior = context.createLinearGradient(0, 0, 0, height);
  interior.addColorStop(0, '#ffe0a4');
  interior.addColorStop(0.46, '#f6a24f');
  interior.addColorStop(1, '#773615');
  context.fillStyle = interior;
  context.fillRect(7, 26, 142, 95);

  context.fillStyle = 'rgba(52, 26, 10, 0.62)';
  for (let index = 0; index < 5; index += 1) {
    context.fillRect(16, 44 + index * 15, 120, 3);
  }

  context.fillStyle = '#252a2d';
  context.fillRect(154, 12, 96, 109);
  context.strokeStyle = 'rgba(184, 193, 194, 0.18)';
  context.lineWidth = 2;
  for (let index = 0; index < 11; index += 1) {
    context.beginPath();
    context.moveTo(156, 18 + index * 10);
    context.lineTo(248, 18 + index * 10);
    context.stroke();
  }

  context.fillStyle = 'rgba(255, 203, 125, 0.82)';
  context.fillRect(0, 5, width, 13);
  context.fillStyle = 'rgba(105, 44, 17, 0.7)';
  for (let index = 0; index < 7; index += 1) {
    context.fillRect(18 + index * 32, 8, 15, 6);
  }

  context.fillStyle = 'rgba(26, 13, 5, 0.9)';
  context.fillRect(6, 26, 5, 96);
  context.fillRect(147, 26, 5, 96);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function createGroundPoolTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, 'rgba(255, 231, 189, 0.55)');
  gradient.addColorStop(0.28, 'rgba(255, 176, 84, 0.18)');
  gradient.addColorStop(0.64, 'rgba(255, 126, 36, 0.045)');
  gradient.addColorStop(1, 'rgba(255, 110, 20, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function createConcreteTexture(): THREE.CanvasTexture {
  const size = 128;
  const random = new Random(0x91c0de);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');

  context.fillStyle = '#b4ab9d';
  context.fillRect(0, 0, size, size);
  for (let index = 0; index < 2600; index += 1) {
    const value = random.next() > 0.5 ? 255 : 0;
    context.fillStyle = `rgba(${value}, ${value - 5}, ${value - 12}, ${random.range(0.012, 0.06)})`;
    context.fillRect(random.range(0, size), random.range(0, size), random.range(0.4, 1.8), random.range(0.4, 1.8));
  }
  context.strokeStyle = 'rgba(48, 43, 37, 0.16)';
  context.lineWidth = 0.7;
  for (let index = 0; index < 8; index += 1) {
    let x = random.range(0, size);
    let y = random.range(0, size);
    context.beginPath();
    context.moveTo(x, y);
    for (let segment = 0; segment < 4; segment += 1) {
      x += random.range(-8, 8);
      y += random.range(2, 10);
      context.lineTo(x, y);
    }
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.6, 1.6);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Primitives disagree about indexing (boxes are indexed, icosahedra are not).
  // Normalise only when the set is mixed so the merged detail geometry always
  // succeeds without inflating every prop.
  const mixed = parts.some((part) => part.index !== null)
    && parts.some((part) => part.index === null);
  const mergeable = mixed
    ? parts.map((part) => (part.index !== null ? part.toNonIndexed() : part))
    : parts;
  const merged = mergeGeometries(mergeable, false);
  if (!merged) throw new Error('Unable to merge city detail geometry');
  for (const part of parts) part.dispose();
  if (mergeable !== parts) {
    for (const part of mergeable) {
      if (!parts.includes(part)) part.dispose();
    }
  }
  merged.computeBoundingSphere();
  return merged;
}

/** Injects nearest-copy wrapping for any instanced material. */
function applyCityWrap(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCityPeriod = { value: CITY_PERIOD };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uCityPeriod;
        vec2 wrapCityXZ(vec2 point) {
          vec2 delta = point - cameraPosition.xz;
          return cameraPosition.xz
            + mod(delta + 0.5 * uCityPeriod, uCityPeriod)
            - 0.5 * uCityPeriod;
        }`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          vec2 cityOrigin = instanceMatrix[3].xz;
          mvPosition.xz += wrapCityXZ(cityOrigin) - cityOrigin;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () => 'mohalla-city-wrap-v1';
  material.needsUpdate = true;
}

function nearestDelta(value: number, center: number): number {
  return value - center - CITY_PERIOD * Math.round((value - center) / CITY_PERIOD);
}
