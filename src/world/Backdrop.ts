import type { Collider } from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Random, clamp } from '../engine/math';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import type { CityPrefab } from './cityKit';
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
const MAJOR_LANE_INDICES: readonly number[] = Array.from(
  { length: CITY_GRID },
  (_, index) => index,
).filter((index) => index % 7 === 3);

const MAJOR_LANES: readonly number[] = MAJOR_LANE_INDICES.map(
  (index) => -CITY_HALF + (index + 0.5) * CITY_CELL,
);

/**
 * Every 16 m cell boundary is a narrow gali. The asphalt is centred on the
 * boundary so two adjoining plots share the lane, leaving room for a doorstep
 * on either side. This is what removes the old "black gap" ambiguity: every
 * gap in the city is now a street, a courtyard, or a building — never a void.
 */
const MINOR_LANES: readonly number[] = Array.from(
  { length: CITY_GRID },
  (_, index) => -CITY_HALF + index * CITY_CELL,
);

const MINOR_ROAD_WIDTH = 3.4;
const MAJOR_ROAD_WIDTH = 11.2;
const MAJOR_WALK_WIDTH = 2.4;
const MAJOR_HALF_ROAD = MAJOR_ROAD_WIDTH / 2;
const MAJOR_WALK_CENTER = MAJOR_HALF_ROAD + MAJOR_WALK_WIDTH / 2;
const BUILDING_INSET = 1.8;

interface UpperMass {
  width: number;
  depth: number;
  height: number;
  offsetX: number;
  offsetZ: number;
}

interface BuildingSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  /** Overall collision/map height, including any rooftop room. */
  height: number;
  /** Height of the main mass, i.e. the roof terrace surface. */
  massHeight: number;
  floors: number;
  litFactor: number;
  tint: THREE.Color;
  /** Which procedural face looks at the street (0 +Z, 1 -Z, 2 +X, 3 -X). */
  frontFace: number;
  onArterial: boolean;
  kind: 'procedural' | 'prefab';
  prefabIndex?: number;
  prefabRotation?: number;
  prefabScale?: number;
  upper?: UpperMass;
}

interface PrefabPlacement {
  prefabIndex: number;
  x: number;
  z: number;
  rotationY: number;
  scale: number;
  spec: BuildingSpec;
}

export interface CityMapBuilding {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

/** A real light source the renderer can promote to a local point light. */
export interface CityLampSource {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  intensity: number;
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
  chajjas: DetailSpec[];
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
  private readonly prefabs: readonly CityPrefab[];
  private readonly prefabPlacements: PrefabPlacement[];
  private readonly physics: PhysicsWorld;
  private readonly colliderPool: Collider[] = [];
  private readonly collisionAnchor = new THREE.Vector2(Number.POSITIVE_INFINITY, 0);
  private readonly groundPools: DetailSpec[] = [];
  private readonly emptyCells: Array<{ x: number; z: number }> = [];
  private readonly lampSources: CityLampSource[] = [];
  private collisionTimer = 0;
  private visibleColliderCount = 0;
  private elapsed = 0;

  constructor(
    pixelRatio: number,
    physics: PhysicsWorld,
    textures: ProceduralTextures,
    photos: PhotoTextures | null,
    prefabs: readonly CityPrefab[] = [],
  ) {
    this.physics = physics;
    this.prefabs = prefabs;
    const random = new Random(0x1f0a11);
    const layout = this.generateBuildings(random, prefabs);
    this.specs = layout.specs;
    this.prefabPlacements = layout.placements;
    this.buildingCount = this.specs.length;
    this.mapBuildings = this.specs.map((spec) => ({
      x: spec.x,
      z: spec.z,
      width: spec.width,
      depth: spec.depth,
      height: spec.height,
    }));
    this.collectEmptyCells();

    const glowSources: GlowSpec[] = [];
    this.buildMasses(random, textures, photos);
    this.buildPrefabs(glowSources);
    const windows = this.buildWindows(random, glowSources);
    this.buildWindowMeshes(windows);
    this.buildFacadeDetails(random, glowSources);
    this.buildRoofScape(random, glowSources);
    this.buildStreetDetails(random, glowSources);
    this.buildOverheadCables(random);
    this.buildRoadNetwork(random, textures);
    this.buildEmptyLots(random);
    this.buildTrees(random);
    this.buildVehicles(random);
    this.buildStreetProps(random);
    this.buildStreetFurniture(random, glowSources);
    this.buildShopSigns(glowSources);
    this.buildLanternStrings(random, glowSources);
    this.buildRangoli(textures);
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

  get lampPositions(): readonly CityLampSource[] {
    return this.lampSources;
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

  private generateBuildings(
    random: Random,
    prefabs: readonly CityPrefab[],
  ): { specs: BuildingSpec[]; placements: PrefabPlacement[] } {
    const reserved = new Set<string>();
    const placements = this.planPrefabs(random, prefabs, reserved);
    const specs: BuildingSpec[] = placements.map((placement) => placement.spec);
    const palette = [
      new THREE.Color(0.8, 0.7, 0.56),
      new THREE.Color(0.74, 0.48, 0.4),
      new THREE.Color(0.58, 0.63, 0.56),
      new THREE.Color(0.53, 0.59, 0.68),
      new THREE.Color(0.82, 0.66, 0.43),
      new THREE.Color(0.68, 0.43, 0.5),
      new THREE.Color(0.78, 0.75, 0.68),
      new THREE.Color(0.56, 0.47, 0.37),
    ];

    for (let ix = 0; ix < CITY_GRID; ix += 1) {
      for (let iz = 0; iz < CITY_GRID; iz += 1) {
        // The entire cell is the arterial. Buildings only ever sit in the
        // plots beside it, never on the asphalt.
        if (ix % 7 === 3 || iz % 7 === 3) continue;
        if (reserved.has(cellKey(ix, iz))) continue;
        if (random.next() > 0.84) continue;

        const cellX = -CITY_HALF + (ix + 0.5) * CITY_CELL;
        const cellZ = -CITY_HALF + (iz + 0.5) * CITY_CELL;
        if (Math.hypot(cellX, cellZ) < 30) continue;

        // Prefer frontage on an arterial. A corner plot may front either
        // street; the building is pulled back to leave a usable forecourt.
        const arterialFaces: number[] = [];
        if (ix % 7 === 2) arterialFaces.push(2);
        if (ix % 7 === 4) arterialFaces.push(3);
        if (iz % 7 === 2) arterialFaces.push(0);
        if (iz % 7 === 4) arterialFaces.push(1);
        const onArterial = arterialFaces.length > 0;
        const frontFace = onArterial
          ? arterialFaces[random.int(0, arterialFaces.length)]!
          : random.int(0, 4);
        const forecourt = onArterial ? random.range(0.7, 2.3) : 0;

        const maxWidth = 16 - BUILDING_INSET * 2 - (frontFace === 2 || frontFace === 3 ? forecourt : 0);
        const maxDepth = 16 - BUILDING_INSET * 2 - (frontFace === 0 || frontFace === 1 ? forecourt : 0);
        const width = Math.min(random.range(8.8, 12.4), maxWidth);
        const depth = Math.min(random.range(8.8, 12.4), maxDepth);

        let offsetX = 0;
        let offsetZ = 0;
        if (onArterial) {
          if (frontFace === 2) offsetX = 8 - (BUILDING_INSET + forecourt) - width / 2;
          else if (frontFace === 3) offsetX = -(8 - (BUILDING_INSET + forecourt) - width / 2);
          else if (frontFace === 0) offsetZ = 8 - (BUILDING_INSET + forecourt) - depth / 2;
          else offsetZ = -(8 - (BUILDING_INSET + forecourt) - depth / 2);
        } else {
          offsetX = random.range(
            -Math.max(0, (16 - width) / 2 - BUILDING_INSET),
            Math.max(0, (16 - width) / 2 - BUILDING_INSET),
          );
          offsetZ = random.range(
            -Math.max(0, (16 - depth) / 2 - BUILDING_INSET),
            Math.max(0, (16 - depth) / 2 - BUILDING_INSET),
          );
        }

        const heightRoll = random.next();
        const floors = onArterial
          ? heightRoll < 0.045
            ? 1
            : heightRoll < 0.38
              ? 2
              : heightRoll < 0.74
                ? 3
                : heightRoll < 0.94
                  ? 4
                  : 5
          : heightRoll < 0.08
            ? 1
            : heightRoll < 0.56
              ? 2
              : heightRoll < 0.89
                ? 3
                : 4;
        const massHeight = 1.0 + floors * 3.05 + random.range(0, 1.2);

        let upper: UpperMass | undefined;
        if (floors >= 2 && width > 9.2 && depth > 9.2 && random.next() < 0.34) {
          const upperWidth = width * random.range(0.52, 0.78);
          const upperDepth = depth * random.range(0.52, 0.78);
          upper = {
            width: upperWidth,
            depth: upperDepth,
            height: random.range(2.7, 3.4),
            offsetX: random.range(-(width - upperWidth) / 2, (width - upperWidth) / 2),
            offsetZ: random.range(-(depth - upperDepth) / 2, (depth - upperDepth) / 2),
          };
        }

        const height = massHeight + (upper ? upper.height - 0.06 : 0);
        const tint = palette[random.int(0, palette.length)]!.clone();
        tint.multiplyScalar(random.range(0.78, 1.08));

        specs.push({
          x: cellX + offsetX,
          z: cellZ + offsetZ,
          width,
          depth,
          height,
          massHeight,
          floors,
        litFactor: random.range(0.34, 0.74),
          tint,
          frontFace,
          onArterial,
          kind: 'procedural',
          upper,
        });
      }
    }

    return { specs, placements };
  }

  /**
   * A handful of authored CC0 high-street buildings are placed on the arterial
   * frontage, always facing the asphalt. They are collision/map specs too, so
   * the same streaming and radar code treats them like any other building.
   */
  private planPrefabs(
    random: Random,
    prefabs: readonly CityPrefab[],
    reserved: Set<string>,
  ): PrefabPlacement[] {
    if (prefabs.length === 0) return [];

    const placements: PrefabPlacement[] = [];
    let skyscrapers = 0;

    const lanes: Array<{ axis: 'x' | 'z'; value: number; laneIndex: number }> = [];
    MAJOR_LANES.forEach((value, laneIndex) => {
      lanes.push({ axis: 'x', value, laneIndex });
      lanes.push({ axis: 'z', value, laneIndex });
    });

    for (const lane of lanes) {
      const initialSide = (lane.laneIndex + (lane.axis === 'x' ? 0 : 1)) % 2 === 0 ? 1 : -1;
      let side = initialSide;
      let cellX = 0;
      let cellZ = 0;
      let alongIndex = 0;
      let found = false;

      for (let attempt = 0; attempt < 44 && !found; attempt += 1) {
        const offset = Math.ceil(attempt / 2) * (attempt % 2 === 0 ? 1 : -1);
        alongIndex = ((lane.laneIndex * 11 + (lane.axis === 'x' ? 3 : 15) + offset) % CITY_GRID + CITY_GRID) % CITY_GRID;

        // Don't put a prefab on another arterial or in an already-reserved
        // plot. Also keep the opening terrace's airspace clear.
        if (MAJOR_LANE_INDICES.includes(alongIndex)) continue;
        const plotIndex = lane.laneIndex + side;
        if (plotIndex < 0 || plotIndex >= CITY_GRID) {
          side *= -1;
          continue;
        }
        const ix = lane.axis === 'x' ? plotIndex : alongIndex;
        const iz = lane.axis === 'x' ? alongIndex : plotIndex;
        if (ix % 7 === 3 || iz % 7 === 3) {
          side *= -1;
          continue;
        }
        cellX = -CITY_HALF + (ix + 0.5) * CITY_CELL;
        cellZ = -CITY_HALF + (iz + 0.5) * CITY_CELL;
        if (Math.hypot(cellX, cellZ) < 36) {
          side *= -1;
          continue;
        }
        if (reserved.has(cellKey(ix, iz))) {
          side *= -1;
          continue;
        }
        found = true;
      }

      if (!found) continue;

      let prefabIndex = random.int(0, prefabs.length);
      if (
        prefabs[prefabIndex]!.name.includes('skyscraper') &&
        skyscrapers >= 1
      ) {
        prefabIndex = (prefabIndex + 1) % prefabs.length;
      }
      const prefab = prefabs[prefabIndex]!;
      if (prefab.name.includes('skyscraper')) skyscrapers += 1;

      const rotationY =
        lane.axis === 'x'
          ? side > 0
            ? -Math.PI / 2
            : Math.PI / 2
          : side > 0
            ? Math.PI
            : 0;
      const front = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, rotationY);
      const frontFace = front.x > 0.5 ? 2 : front.x < -0.5 ? 3 : front.z > 0.5 ? 0 : 1;

      let targetWidth = prefab.name.includes('skyscraper')
        ? 10.4
        : random.range(9.4, 11.8);
      let scale = targetWidth / prefab.width;
      const rotated = Math.abs(Math.sin(rotationY)) > 0.5;
      const footprintW = (rotated ? prefab.depth : prefab.width) * scale;
      const footprintD = (rotated ? prefab.width : prefab.depth) * scale;
      const maxFootprint = 12.4;
      if (Math.max(footprintW, footprintD) > maxFootprint) {
        scale *= maxFootprint / Math.max(footprintW, footprintD);
        targetWidth *= maxFootprint / Math.max(footprintW, footprintD);
      }
      const width = (rotated ? prefab.depth : prefab.width) * scale;
      const depth = (rotated ? prefab.width : prefab.depth) * scale;
      const height = prefab.height * scale;
      const forecourt = Math.max(0.8, Math.min(2.4, 12.4 - Math.max(width, depth)));
      const frontSpan = frontFace === 2 || frontFace === 3 ? width : depth;
      const shift = 8 - (BUILDING_INSET + forecourt) - frontSpan / 2;
      const offsetX =
        frontFace === 2 ? shift : frontFace === 3 ? -shift : 0;
      const offsetZ =
        frontFace === 0 ? shift : frontFace === 1 ? -shift : 0;
      const tint = new THREE.Color(0.86, 0.8, 0.72);

      const spec: BuildingSpec = {
        x: cellX + offsetX,
        z: cellZ + offsetZ,
        width,
        depth,
        height,
        massHeight: height,
        floors: Math.max(1, Math.round(height / 3.1)),
        litFactor: 0.35,
        tint,
        frontFace,
        onArterial: true,
        kind: 'prefab',
        prefabIndex,
        prefabRotation: rotationY,
        prefabScale: scale,
      };

      reserved.add(
        cellKey(
          Math.floor((cellX + CITY_HALF) / CITY_CELL),
          Math.floor((cellZ + CITY_HALF) / CITY_CELL),
        ),
      );
      placements.push({
        prefabIndex,
        x: spec.x,
        z: spec.z,
        rotationY,
        scale,
        spec,
      });
    }

    return placements;
  }

  private buildMasses(
    random: Random,
    textures: ProceduralTextures,
    photos: PhotoTextures | null,
  ): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(geometry);

    const wallMap = this.cloneTexture(
      textures.wall,
      1.6,
      1.4,
      false,
    );
    const materialParams: THREE.MeshStandardMaterialParameters = {
      color: 0xffffff,
      map: wallMap,
      roughness: photos ? 1 : 0.96,
      metalness: 0.015,
    };
    if (photos) {
      materialParams.normalMap = this.cloneTexture(photos.wall.normalMap, 1.6, 1.4, true);
      materialParams.roughnessMap = this.cloneTexture(photos.wall.roughnessMap, 1.6, 1.4, true);
      materialParams.normalScale = new THREE.Vector2(0.72, 0.72);
    } else {
      materialParams.bumpMap = this.cloneTexture(textures.wall, 1.6, 1.4, true);
      materialParams.bumpScale = 0.028;
    }

    const material = new THREE.MeshStandardMaterial(materialParams);
    applyWallWeathering(material);
    this.materials.push(material);

    const procedural = this.specs.filter((spec) => spec.kind === 'procedural');
    const city = new THREE.InstancedMesh(geometry, material, procedural.length);
    city.name = 'mohalla-building-masses';
    city.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    city.castShadow = false;
    city.receiveShadow = false;
    city.frustumCulled = false;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    procedural.forEach((spec, index) => {
      position.set(spec.x, spec.massHeight / 2, spec.z);
      scale.set(spec.width, spec.massHeight, spec.depth);
      matrix.compose(position, quaternion, scale);
      city.setMatrixAt(index, matrix);
      city.setColorAt(index, spec.tint);
    });
    city.instanceMatrix.needsUpdate = true;
    if (city.instanceColor) city.instanceColor.needsUpdate = true;
    this.group.add(city);

    // Stepped upper floors break up the skyline. They reuse the same box and
    // wall material, so the extra silhouette costs one draw call, not one per
    // building.
    const upperSpecs = procedural.filter((spec) => spec.upper);
    if (upperSpecs.length > 0) {
      const upperMesh = new THREE.InstancedMesh(geometry, material, upperSpecs.length);
      upperMesh.name = 'mohalla-upper-masses';
      upperMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      upperMesh.frustumCulled = false;
      upperSpecs.forEach((spec, index) => {
        const upper = spec.upper!;
        position.set(
          spec.x + upper.offsetX,
          spec.massHeight + upper.height / 2 - 0.06,
          spec.z + upper.offsetZ,
        );
        scale.set(upper.width, upper.height, upper.depth);
        matrix.compose(position, quaternion, scale);
        upperMesh.setMatrixAt(index, matrix);
        upperMesh.setColorAt(index, spec.tint.clone().multiplyScalar(0.93));
      });
      upperMesh.instanceMatrix.needsUpdate = true;
      if (upperMesh.instanceColor) upperMesh.instanceColor.needsUpdate = true;
      this.group.add(upperMesh);
    }

    // A separate roof slab gives every building a proper concrete cap and a
    // small overhanging lip instead of stretching the wall scan over the roof.
    const roofMap = this.cloneTexture(textures.roof, 3.1, 2.6, false);
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

    const slabGeometry = new THREE.BoxGeometry(1, 0.1, 1);
    this.geometries.push(slabGeometry);
    const slabs: DetailSpec[] = [];
    const roofPalette = [
      new THREE.Color(0.92, 0.88, 0.82),
      new THREE.Color(0.76, 0.72, 0.66),
      new THREE.Color(0.62, 0.65, 0.6),
      new THREE.Color(0.5, 0.56, 0.48),
      new THREE.Color(0.72, 0.5, 0.4),
      new THREE.Color(0.4, 0.41, 0.4),
    ];
    procedural.forEach((spec) => {
      const baseTint = roofPalette[random.int(0, roofPalette.length)]!.clone()
        .multiplyScalar(random.range(0.82, 1.06));
      slabs.push({
        x: spec.x,
        // Keep the slab's top face above the mass. The previous coplanar roof
        // surface flickered badly (z-fighting) whenever the drone moved over a
        // terrace, because two different roof materials shared the exact same y.
        y: spec.massHeight + 0.045,
        z: spec.z,
        rotationY: 0,
        scaleX: spec.width + 0.22,
        scaleY: 1,
        scaleZ: spec.depth + 0.22,
        tint: baseTint,
      });
      if (spec.upper) {
        slabs.push({
          x: spec.x + spec.upper.offsetX,
          y: spec.height + 0.045,
          z: spec.z + spec.upper.offsetZ,
          rotationY: 0,
          scaleX: spec.upper.width + 0.18,
          scaleY: 1,
          scaleZ: spec.upper.depth + 0.18,
          tint: baseTint.clone().multiplyScalar(random.range(0.9, 1.04)),
        });
      }
    });
    this.addInstances(slabGeometry, roofMaterial, slabs, 'mohalla-roof-slabs');
  }

  private buildPrefabs(glowSources: GlowSpec[]): void {
    if (this.prefabPlacements.length === 0 || this.prefabs.length === 0) return;

    const byPrefab = new Map<number, PrefabPlacement[]>();
    for (const placement of this.prefabPlacements) {
      const list = byPrefab.get(placement.prefabIndex);
      if (list) list.push(placement);
      else byPrefab.set(placement.prefabIndex, [placement]);
    }

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (const [prefabIndex, placements] of byPrefab) {
      const prefab = this.prefabs[prefabIndex];
      if (!prefab) continue;
      const material = prefab.material;
      applyCityWrap(material);
      material.needsUpdate = true;

      const mesh = new THREE.InstancedMesh(
        prefab.geometry,
        material,
        placements.length,
      );
      mesh.name = `kenney-${prefab.name}`;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = false;
      placements.forEach((placement, index) => {
        position.set(placement.x, 0, placement.z);
        quaternion.setFromAxisAngle(UP, placement.rotationY);
        scale.setScalar(placement.scale);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    }

    // The authored kit has baked window colours, so add a few real bloom
    // sources along the high-street facades. This makes the prefabs feel lit
    // from inside instead of pasted onto the night.
    const random = new Random(0x4b17);
    for (const placement of this.prefabPlacements) {
      const spec = placement.spec;
      const normalX = spec.frontFace === 2 ? 1 : spec.frontFace === 3 ? -1 : 0;
      const normalZ = spec.frontFace === 0 ? 1 : spec.frontFace === 1 ? -1 : 0;
      const span = normalX !== 0 ? spec.depth : spec.width;
      const count = 4 + random.int(0, 4);
      for (let index = 0; index < count; index += 1) {
        const across = random.range(-0.38, 0.38) * span;
        const y = random.range(2.4, Math.max(3.2, spec.height - 1.6));
        const x = spec.x + (normalX !== 0
          ? normalX * (spec.width / 2 + 0.08)
          : across);
        const z = spec.z + (normalZ !== 0
          ? normalZ * (spec.depth / 2 + 0.08)
          : across);
        glowSources.push({
          position: new THREE.Vector3(x, y, z),
          color: new THREE.Color(1.0, random.range(0.45, 0.68), 0.22),
          size: random.range(0.42, 0.78),
          phase: random.range(0, Math.PI * 2),
        });
      }
      this.groundPools.push({
        x: spec.x + normalX * (spec.width / 2 + 2.4),
        y: 0.065,
        z: spec.z + normalZ * (spec.depth / 2 + 2.4),
        rotationY: 0,
        scaleX: random.range(7.4, 10.8),
        scaleY: 1,
        scaleZ: random.range(7.4, 10.8),
        tint: new THREE.Color(1.0, random.range(0.34, 0.5), 0.12),
      });
    }
  }

  private buildWindows(random: Random, glowSources: GlowSpec[]): WindowBuild {
    const lit: DetailSpec[] = [];
    const dark: DetailSpec[] = [];
    const sills: DetailSpec[] = [];
    const chajjas: DetailSpec[] = [];
    const orange = new THREE.Color(1.0, 0.45, 0.14);
    const amber = new THREE.Color(1.0, 0.63, 0.3);
    const pale = new THREE.Color(1.0, 0.82, 0.58);
    const cool = new THREE.Color(0.48, 0.7, 1.0);
    const rose = new THREE.Color(0.95, 0.24, 0.42);

    for (const spec of this.specs) {
      if (spec.kind === 'prefab') continue;
      const usableHeight = Math.max(1.2, spec.massHeight - 1.6);
      const rows = clamp(Math.floor(usableHeight / 2.9), 1, 6);

      for (let faceIndex = 0; faceIndex < 4; faceIndex += 1) {
        const face = getFace(spec, faceIndex);
        const columns = clamp(Math.floor(face.span / 2.75), 1, 5);

        for (let row = 0; row < rows; row += 1) {
          for (let column = 0; column < columns; column += 1) {
            const isLit = random.next() < spec.litFactor;
            if (!isLit && random.next() > 0.5) continue;

            const across = ((column + 0.5) / columns - 0.5) * (face.span - 1.5);
            const point = facePoint(spec, faceIndex, across + random.range(-0.2, 0.2), 0.034);
            const y =
              1.35 + usableHeight * ((row + 0.5) / rows) + random.range(-0.1, 0.1);
            const width = random.range(0.52, 0.98);
            const height = random.range(0.66, 1.12);

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

            // Iron grilles are baked into the window glass texture instead of
            // being modelled, so every window gets the detail for no geometry.
            // A shallow concrete sunshade above the window. On the street face
            // it creates the horizontal shadow rhythm that flat boxes lack.
            if (
              (faceIndex === spec.frontFace || random.next() < 0.14) &&
              random.next() < 0.28
            ) {
              chajjas.push({
                x: point.x + face.normalX * 0.2,
                y: y + height / 2 + 0.08,
                z: point.z + face.normalZ * 0.2,
                rotationY: face.rotationY,
                scaleX: width + random.range(0.28, 0.5),
                scaleY: 1,
                scaleZ: 1,
                tint: spec.tint.clone().multiplyScalar(random.range(0.72, 0.98)),
              });
            }
          }
        }
      }

      // Warm shopfront-scale windows at street level, always on the side that
      // actually faces the road.
      if (random.next() < 0.55) {
        const face = getFace(spec, spec.frontFace);
        const point = facePoint(
          spec,
          spec.frontFace,
          random.range(-0.3, 0.3) * face.span,
          0.04,
        );
        lit.push({
          x: point.x,
          y: 1.15,
          z: point.z,
          rotationY: face.rotationY,
          scaleX: random.range(0.9, 1.7),
          scaleY: random.range(1.2, 1.9),
          scaleZ: 1,
          tint: new THREE.Color(1.0, random.range(0.45, 0.68), 0.24),
        });
      }

      // A stepped roof room deserves its own windows, otherwise it reads as a
      // blank crate sitting on the terrace.
      if (spec.upper && random.next() < 0.8) {
        const upper = spec.upper;
        const centerX = spec.x + upper.offsetX;
        const centerZ = spec.z + upper.offsetZ;
        const windowY = spec.massHeight + upper.height * 0.52;
        const faces = [
          { rotationY: 0, normalX: 0, normalZ: 1, span: upper.width },
          { rotationY: Math.PI, normalX: 0, normalZ: -1, span: upper.width },
          { rotationY: Math.PI / 2, normalX: 1, normalZ: 0, span: upper.depth },
          { rotationY: -Math.PI / 2, normalX: -1, normalZ: 0, span: upper.depth },
        ];
        const face = faces[random.int(0, faces.length)]!;
        const across = random.range(-0.28, 0.28) * face.span;
        const x = centerX + (face.normalX !== 0
          ? face.normalX * (upper.width / 2 + 0.035)
          : across);
        const z = centerZ + (face.normalZ !== 0
          ? face.normalZ * (upper.depth / 2 + 0.035)
          : across);
        const litWindow = random.next() < 0.58;
        const windowWidth = random.range(0.6, 1.15);
        const windowHeight = random.range(0.7, 1.05);
        const target = litWindow ? lit : dark;
        target.push({
          x,
          y: windowY,
          z,
          rotationY: face.rotationY,
          scaleX: windowWidth,
          scaleY: windowHeight,
          scaleZ: 1,
          tint: litWindow
            ? new THREE.Color(1.0, random.range(0.42, 0.65), 0.22)
            : new THREE.Color(0.4, 0.5, 0.64).multiplyScalar(random.range(0.5, 0.9)),
        });
      }
    }

    return { lit, dark, sills, chajjas };
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

    const chajjaGeometry = createChajjaGeometry();
    this.geometries.push(chajjaGeometry);
    const chajjaMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.01,
    });
    applyCityWrap(chajjaMaterial);
    this.materials.push(chajjaMaterial);
    this.addInstances(chajjaGeometry, chajjaMaterial, windows.chajjas, 'mohalla-window-chajjas');
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
    const plinth: DetailSpec[] = [];
    const pilasters: DetailSpec[] = [];
    const balconies: DetailSpec[] = [];
    const awnings: DetailSpec[] = [];
    const acUnits: DetailSpec[] = [];
    const pipes: DetailSpec[] = [];
    const meterBoxes: DetailSpec[] = [];

    for (const spec of this.specs) {
      if (spec.kind === 'prefab') continue;
      const front = getFace(spec, spec.frontFace);
      const parapetY = spec.massHeight + 0.27;
      const parapetTint = spec.tint.clone().multiplyScalar(0.88);
      const plinthTint = new THREE.Color(0.36, 0.34, 0.3).multiplyScalar(
        random.range(0.72, 1.02),
      );
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

      // A dark, damp plinth grounds every facade and hides the seam between
      // wall and pavement at street level.
      plinth.push(
        {
          x: spec.x,
          y: 0.42,
          z: spec.z + spec.depth / 2 + 0.03,
          rotationY: 0,
          scaleX: spec.width + 0.06,
          scaleY: 0.72,
          scaleZ: 0.1,
          tint: plinthTint,
        },
        {
          x: spec.x,
          y: 0.42,
          z: spec.z - spec.depth / 2 - 0.03,
          rotationY: 0,
          scaleX: spec.width + 0.06,
          scaleY: 0.72,
          scaleZ: 0.1,
          tint: plinthTint,
        },
        {
          x: spec.x + spec.width / 2 + 0.03,
          y: 0.42,
          z: spec.z,
          rotationY: 0,
          scaleX: 0.1,
          scaleY: 0.72,
          scaleZ: spec.depth + 0.06,
          tint: plinthTint,
        },
        {
          x: spec.x - spec.width / 2 - 0.03,
          y: 0.42,
          z: spec.z,
          rotationY: 0,
          scaleX: 0.1,
          scaleY: 0.72,
          scaleZ: spec.depth + 0.06,
          tint: plinthTint,
        },
      );

      // Two concrete pilasters break up the street facade into bays. They
      // catch the lamplight as vertical highlights instead of one flat plane.
      const pilasterHeight = Math.max(2, spec.massHeight - 0.75);
      for (const side of [-1, 1] as const) {
        const point = facePoint(
          spec,
          spec.frontFace,
          side * (front.span / 2 - 0.3),
          0.09,
        );
        pilasters.push({
          x: point.x,
          y: 0.65 + pilasterHeight / 2,
          z: point.z,
          rotationY: front.rotationY,
          scaleX: 0.28,
          scaleY: pilasterHeight,
          scaleZ: 0.16,
          tint: spec.tint.clone().multiplyScalar(random.range(0.9, 1.12)),
        });
      }

      // Meter boxes, cable junction boxes and a few meters of conduit at the
      // ground floor. Small, but they stop the base of the wall reading clean.
      if (random.next() < 0.58) {
        const point = facePoint(
          spec,
          spec.frontFace,
          random.range(-0.4, 0.4) * front.span,
          0.12,
        );
        meterBoxes.push({
          x: point.x,
          y: random.range(1.35, 2.0),
          z: point.z,
          rotationY: front.rotationY,
          scaleX: random.range(0.22, 0.34),
          scaleY: random.range(0.3, 0.46),
          scaleZ: random.range(0.12, 0.2),
          tint: new THREE.Color(0.5, 0.5, 0.46).multiplyScalar(random.range(0.65, 1)),
        });
      }

      const courseTint = spec.tint.clone().multiplyScalar(0.72);
      for (const level of [3.05, 6.15]) {
        if (level > spec.massHeight - 1.2) continue;
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

      if (random.next() < 0.52 && spec.massHeight > 6.2) {
        const faceIndex = random.next() < 0.66 ? spec.frontFace : random.int(0, 4);
        const face = getFace(spec, faceIndex);
        const level = random.next() < 0.58 ? 3.35 : 6.35;
        if (level < spec.massHeight - 1.2) {
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
        const face = getFace(spec, spec.frontFace);
        const point = facePoint(
          spec,
          spec.frontFace,
          random.range(-0.28, 0.28) * face.span,
          0.48,
        );
        awnings.push({
          x: point.x,
          y: 2.72,
          z: point.z,
          rotationY: face.rotationY,
          scaleX: random.range(0.72, 1.2),
          scaleY: 1,
          scaleZ: random.range(0.82, 1.18),
          tint: random.next() < 0.5
            ? new THREE.Color(0.24, 0.36, 0.37)
            : new THREE.Color(0.48, 0.28, 0.2),
        });
      }

      if (random.next() < 0.44) {
        const faceIndex = random.next() < 0.72 ? spec.frontFace : random.int(0, 4);
        const face = getFace(spec, faceIndex);
        const level = random.next() < 0.55 ? 3.8 : 6.6;
        if (level < spec.massHeight - 0.9) {
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
          y: spec.massHeight / 2,
          z: spec.z + spec.depth / 2 + 0.075,
          rotationY: 0,
          scaleX: 1,
          scaleY: Math.max(1, spec.massHeight - 0.5),
          scaleZ: 1,
          tint: new THREE.Color(0.18, 0.19, 0.2),
        });
      }
    }

    const parapetGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(parapetGeometry);
    this.addInstances(parapetGeometry, stoneMaterial, parapets, 'mohalla-parapets');
    this.addInstances(parapetGeometry, stoneMaterial, courses, 'mohalla-string-courses');
    this.addInstances(parapetGeometry, stoneMaterial, plinth, 'mohalla-plinth-bands');
    this.addInstances(parapetGeometry, stoneMaterial, pilasters, 'mohalla-facade-pilasters');
    this.addInstances(parapetGeometry, darkMetal, meterBoxes, 'mohalla-meter-boxes');

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
        const faceIndex = spec.frontFace;
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
          this.lampSources.push({
            x: point.x + face.normalX * 0.8,
            y: 1.9,
            z: point.z + face.normalZ * 0.8,
            color: new THREE.Color(1.0, random.range(0.52, 0.68), 0.28),
            intensity: random.range(85, 150),
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
    const solar: DetailSpec[] = [];
    const railings: DetailSpec[] = [];
    const laundry: DetailSpec[] = [];
    const diyas: DetailSpec[] = [];
    const tyres: DetailSpec[] = [];
    const mumtyDoors: DetailSpec[] = [];
    const linePositions: number[] = [];
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

    const roofSpot = (
      spec: BuildingSpec,
      margin: number,
    ): { x: number; z: number } | null => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const x = spec.x + random.range(-0.38, 0.38) * spec.width;
        const z = spec.z + random.range(-0.38, 0.38) * spec.depth;
        if (spec.upper) {
          const upper = spec.upper;
          if (
            Math.abs(x - (spec.x + upper.offsetX)) < upper.width / 2 + margin &&
            Math.abs(z - (spec.z + upper.offsetZ)) < upper.depth / 2 + margin
          ) {
            continue;
          }
        }
        return { x, z };
      }
      return null;
    };

    for (const spec of this.specs) {
      if (spec.kind === 'prefab') continue;
      const roofY = spec.massHeight;
      const roll = random.next();
      if (roll < 0.48) {
        const spot = roofSpot(spec, 0.85);
        if (spot) {
          tanks.push({
            x: spot.x,
            y: roofY + 0.02,
            z: spot.z,
            rotationY: random.range(0, Math.PI * 2),
            scaleX: random.range(0.85, 1.25),
            scaleY: random.range(0.86, 1.24),
            scaleZ: random.range(0.85, 1.25),
            tint: random.next() < 0.72
              ? new THREE.Color(0.1, 0.11, 0.12)
              : new THREE.Color(0.48, 0.47, 0.42).multiplyScalar(random.range(0.8, 1.1)),
          });
        }
      }
      if (random.next() < 0.58) {
        const spot = roofSpot(spec, 1.2);
        if (spot) {
          const hutWidth = random.range(1.6, 3.2);
          const hutDepth = random.range(1.5, 2.8);
          const hutHeight = random.range(1.35, 2.15);
          huts.push({
            x: spot.x,
            y: roofY + hutHeight / 2,
            z: spot.z,
            rotationY: 0,
            scaleX: hutWidth,
            scaleY: hutHeight,
            scaleZ: hutDepth,
            tint: spec.tint.clone().multiplyScalar(random.range(0.72, 0.98)),
          });

          // A dark doorway on the roof-facing side stops the mumty reading as
          // a solid packing crate.
          const doorSide = random.next() < 0.5 ? -1 : 1;
          mumtyDoors.push({
            x: spot.x + doorSide * (hutWidth / 2 + 0.012),
            y: roofY + 0.68,
            z: spot.z,
            rotationY: doorSide > 0 ? Math.PI / 2 : -Math.PI / 2,
            scaleX: 0.62,
            scaleY: 1.32,
            scaleZ: 1,
            tint: new THREE.Color(0.055, 0.05, 0.045),
          });
        }
      }

      if (random.next() < 0.22) {
        const spot = roofSpot(spec, 0.9);
        if (spot) {
          solar.push({
            x: spot.x,
            y: roofY + 0.03,
            z: spot.z,
            rotationY: random.next() < 0.5 ? 0 : Math.PI,
            scaleX: random.range(0.9, 1.3),
            scaleY: random.range(0.9, 1.2),
            scaleZ: random.range(0.9, 1.2),
            tint: new THREE.Color(0.16, 0.2, 0.28).multiplyScalar(random.range(0.7, 1.05)),
          });
        }
      }

      // Pigeon-proof railings on a minority of roofs; they break the parapet
      // rhythm and show a different silhouette against the sky.
      if (random.next() < 0.07) {
        const edge = random.int(0, 4);
        const span = edge < 2 ? spec.width : spec.depth;
        const segments = Math.max(1, Math.round(span / 2.1));
        for (let segment = 0; segment < segments; segment += 1) {
          const t = (segment + 0.5) / segments - 0.5;
          const x = edge === 0 || edge === 1
            ? spec.x + t * spec.width * 0.9
            : spec.x + (edge === 2 ? 1 : -1) * (spec.width / 2 - 0.11);
          const z = edge === 2 || edge === 3
            ? spec.z + t * spec.depth * 0.9
            : spec.z + (edge === 0 ? 1 : -1) * (spec.depth / 2 - 0.11);
          railings.push({
            x,
            y: roofY + 0.12,
            z,
            rotationY: edge < 2 ? 0 : Math.PI / 2,
            scaleX: span / segments / 2.1,
            scaleY: 1,
            scaleZ: 1,
            tint: new THREE.Color(0.2, 0.21, 0.22),
          });
        }
      }

      // Clotheslines: the rooftop detail most associated with Indian
      // apartments, and a useful splash of colour when seen from the air.
      if (random.next() < 0.34) {
        const edge = random.int(0, 4);
        const lineLength = random.range(2.4, Math.min(6.2, spec.width - 1.4));
        const along = random.range(-0.25, 0.25) * (edge < 2 ? spec.width : spec.depth);
        const x = edge < 2 ? spec.x + along : spec.x + (edge === 2 ? 1 : -1) * (spec.width / 2 - 0.5);
        const z = edge < 2 ? spec.z + (edge === 0 ? 1 : -1) * (spec.depth / 2 - 0.5) : spec.z + along;
        const direction = edge < 2 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const lineY = roofY + 1.5;
        const start = new THREE.Vector3(x, lineY, z).addScaledVector(direction, -lineLength / 2);
        const end = new THREE.Vector3(x, lineY, z).addScaledVector(direction, lineLength / 2);
        linePositions.push(start.x, start.y, start.z, end.x, end.y, end.z);
        // Two posts holding the line.
        for (const point of [start, end]) {
          linePositions.push(
            point.x, point.y, point.z,
            point.x, roofY + 0.08, point.z,
          );
        }
        const pieces = random.int(3, 6);
        const laundryPalette = [
          new THREE.Color(0.86, 0.84, 0.74),
          new THREE.Color(0.68, 0.22, 0.18),
          new THREE.Color(0.2, 0.42, 0.5),
          new THREE.Color(0.86, 0.62, 0.2),
          new THREE.Color(0.5, 0.2, 0.42),
          new THREE.Color(0.32, 0.4, 0.24),
        ];
        for (let index = 0; index < pieces; index += 1) {
          const t = (index + 0.5) / pieces;
          laundry.push({
            x: start.x + direction.x * lineLength * t,
            y: lineY - 0.02,
            z: start.z + direction.z * lineLength * t,
            rotationY: edge < 2 ? 0 : Math.PI / 2,
            scaleX: random.range(0.72, 1.15),
            scaleY: random.range(0.7, 1.25),
            scaleZ: 1,
            tint: laundryPalette[random.int(0, laundryPalette.length)]!.clone(),
          });
        }
      }

      // Diwali diyas along the parapet. Tiny in world space, but the warm
      // pinpricks are exactly what makes a roof read as inhabited at night.
      if (random.next() < 0.5) {
        const edge = random.int(0, 4);
        const span = edge < 2 ? spec.width : spec.depth;
        const count = random.int(3, 7);
        for (let index = 0; index < count; index += 1) {
          const t = (index + 0.5) / count - 0.5;
          const x = edge < 2
            ? spec.x + t * span * 0.84
            : spec.x + (edge === 2 ? 1 : -1) * (spec.width / 2 - 0.14);
          const z = edge < 2
            ? spec.z + (edge === 0 ? 1 : -1) * (spec.depth / 2 - 0.14)
            : spec.z + t * span * 0.84;
          diyas.push({
            x,
            y: roofY + 0.58,
            z,
            rotationY: 0,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
            tint: new THREE.Color(1.0, 0.52, 0.16),
          });
          if (index % 2 === 0) {
            glowSources.push({
              position: new THREE.Vector3(x, roofY + 0.65, z),
              color: new THREE.Color(1.0, 0.42, 0.1),
              size: random.range(0.18, 0.3),
              phase: random.range(0, Math.PI * 2),
            });
          }
        }
      }

      if (random.next() < 0.13) {
        const count = random.int(2, 4);
        for (let index = 0; index < count; index += 1) {
          const spot = roofSpot(spec, 0.5);
          if (!spot) continue;
          tyres.push({
            x: spot.x,
            y: roofY + 0.12,
            z: spot.z,
            rotationY: random.range(0, Math.PI * 2),
            scaleX: random.range(0.7, 1),
            scaleY: random.range(0.7, 1),
            scaleZ: random.range(0.7, 1),
            tint: new THREE.Color(0.09, 0.09, 0.1),
          });
        }
      }

      if (random.next() < 0.4) {
        const spot = roofSpot(spec, 0.25);
        if (spot) {
          antennas.push({
            x: spot.x,
            y: roofY + random.range(0.9, 2.1),
            z: spot.z,
            rotationY: 0,
            scaleX: 1,
            scaleY: random.range(1.8, 4.4),
            scaleZ: 1,
            tint: darkTint,
          });
        }
      }

      if (random.next() < 0.36) {
        const spot = roofSpot(spec, 0.2);
        if (spot) {
          dishes.push({
            x: spot.x,
            y: roofY + 0.04,
            z: spot.z,
            rotationY: random.range(0, Math.PI * 2),
            scaleX: random.range(0.8, 1.22),
            scaleY: random.range(0.85, 1.2),
            scaleZ: random.range(0.8, 1.22),
            tint: new THREE.Color(0.58, 0.59, 0.58).multiplyScalar(random.range(0.6, 1)),
          });
        }
      }

      if (random.next() < 0.3) {
        const spot = roofSpot(spec, 0.2);
        if (spot) {
          plants.push({
            x: spot.x,
            y: roofY + 0.02,
            z: spot.z,
            rotationY: random.range(0, Math.PI * 2),
            scaleX: random.range(0.8, 1.3),
            scaleY: random.range(0.8, 1.35),
            scaleZ: random.range(0.8, 1.3),
            tint: new THREE.Color(0.36, 0.45, 0.28).multiplyScalar(random.range(0.6, 1)),
          });
        }
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
            z = spec.z + spec.depth / 2 - 0.1;
          } else if (edge === 1) {
            x = spec.x + (t - 0.5) * spec.width * 0.82;
            z = spec.z - spec.depth / 2 + 0.1;
          } else if (edge === 2) {
            x = spec.x + spec.width / 2 - 0.1;
            z = spec.z + (t - 0.5) * spec.depth * 0.82;
          } else {
            x = spec.x - spec.width / 2 + 0.1;
            z = spec.z + (t - 0.5) * spec.depth * 0.82;
          }
          const y = roofY + 0.34 - Math.sin(t * Math.PI) * sag;
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

    const tankGeometry = createWaterTankGeometry();
    this.geometries.push(tankGeometry);
    this.addInstances(tankGeometry, instancedMaterial, tanks, 'mohalla-roof-tanks');

    const hutGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(hutGeometry);
    this.addInstances(hutGeometry, instancedMaterial, huts, 'mohalla-roof-mumties');

    const doorGeometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(doorGeometry);
    const doorMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    applyCityWrap(doorMaterial);
    this.materials.push(doorMaterial);
    this.addInstances(doorGeometry, doorMaterial, mumtyDoors, 'mohalla-mumty-doors');

    const antennaGeometry = new THREE.CylinderGeometry(0.015, 0.02, 1, 4);
    this.geometries.push(antennaGeometry);
    this.addInstances(antennaGeometry, instancedMaterial, antennas, 'mohalla-antennas');

    const dishGeometry = createDishGeometry();
    this.geometries.push(dishGeometry);
    this.addInstances(dishGeometry, instancedMaterial, dishes, 'mohalla-dishes');

    const plantGeometry = createPlantGeometry();
    this.geometries.push(plantGeometry);
    this.addInstances(plantGeometry, instancedMaterial, plants, 'mohalla-roof-plants');

    const solarGeometry = createSolarHeaterGeometry();
    this.geometries.push(solarGeometry);
    this.addInstances(solarGeometry, instancedMaterial, solar, 'mohalla-solar-heaters');

    const railingGeometry = createRoofRailingGeometry();
    this.geometries.push(railingGeometry);
    this.addInstances(railingGeometry, instancedMaterial, railings, 'mohalla-roof-railings');

    const laundryGeometry = createLaundryGeometry();
    this.geometries.push(laundryGeometry);
    const laundryMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    applyCityWrap(laundryMaterial);
    this.materials.push(laundryMaterial);
    this.addInstances(laundryGeometry, laundryMaterial, laundry, 'mohalla-laundry');

    const tyreGeometry = new THREE.TorusGeometry(0.3, 0.11, 5, 10);
    tyreGeometry.rotateX(Math.PI / 2);
    this.geometries.push(tyreGeometry);
    this.addInstances(tyreGeometry, instancedMaterial, tyres, 'mohalla-roof-tyres');

    const diyaGeometry = createDiyaGeometry();
    this.geometries.push(diyaGeometry);
    const diyaMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
      fog: true,
    });
    applyCityWrap(diyaMaterial);
    this.materials.push(diyaMaterial);
    this.addInstances(diyaGeometry, diyaMaterial, diyas, 'mohalla-roof-diyas');

    if (linePositions.length > 0) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(linePositions, 3),
      );
      this.geometries.push(lineGeometry);
      const lineMaterial = new THREE.LineBasicMaterial({
        color: 0x090a0b,
        transparent: true,
        opacity: 0.82,
        fog: true,
      });
      applyCityWrap(lineMaterial);
      this.materials.push(lineMaterial);
      const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
      lines.name = 'mohalla-clotheslines';
      lines.frustumCulled = false;
      this.group.add(lines);
    }

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
      const glowColor = new THREE.Color(1.0, random.range(0.42, 0.58), 0.18);
      glowSources.push({
        position: new THREE.Vector3(x + head.x, head.y, z + head.z),
        color: glowColor,
        size: random.range(2.6, 3.8),
        phase: random.range(0, Math.PI * 2),
      });
      this.lampSources.push({
        x: x + head.x,
        y: head.y - 0.18,
        z: z + head.z,
        color: glowColor.clone(),
        intensity: random.range(420, 620),
      });

      this.groundPools.push({
        x: x + head.x,
        y: 0.022,
        z: z + head.z,
        rotationY: 0,
        scaleX: random.range(8.2, 12.4),
        scaleY: 1,
        scaleZ: random.range(8.2, 12.4),
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

    // A regular rhythm of lamps down each arterial. Every second cell gets a
    // lamp, alternating sides, so the street reads as a lit corridor from
    // above without turning the pavement into a forest of poles.
    for (const lane of MAJOR_LANES) {
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell) || (cell + lane) % 2 !== 0) continue;
        const along = -CITY_HALF + (cell + 0.5) * CITY_CELL;
        const side = cell % 4 === 0 ? 1 : -1;
        const x = lane + side * (MAJOR_HALF_ROAD + 1.55);
        if (!this.pointInsideBuilding(x, along, 0.9)) {
          addLamp(x, along, side > 0 ? Math.PI : 0);
        }

        const z = lane + side * (MAJOR_HALF_ROAD + 1.55);
        if (!this.pointInsideBuilding(along, z, 0.9)) {
          addLamp(along, z, side > 0 ? Math.PI / 2 : -Math.PI / 2);
        }
      }
    }

    // A sparse lantern on the corner of every third gali keeps the side
    // streets from disappearing into the dark between arterials.
    for (let boundary = 0; boundary < CITY_GRID; boundary += 1) {
      if (!boundaryHasGali(boundary) || boundary % 3 !== 1) continue;
      const lane = MINOR_LANES[boundary]!;
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell) || cell % 5 !== 2) continue;
        const along = -CITY_HALF + (cell + 0.5) * CITY_CELL;
        const side = cell % 2 === 0 ? 1 : -1;
        addLamp(
          lane + side * (MINOR_ROAD_WIDTH / 2 + 0.55),
          along,
          side > 0 ? Math.PI : 0,
        );
      }
    }

    this.addInstances(lampGeometry, darkMetal, lamps, 'mohalla-street-lamps');
  }

  /**
   * Sagging overhead cable bundles. In an Indian mohalla the strip of sky
   * between facades is never empty: TV coax, phone lines and illegal power
   * taps cross every gali. One instanced tube mesh covers all of them.
   */
  private buildOverheadCables(random: Random): void {
    const geometry = createCableGeometry();
    this.geometries.push(geometry);
    const material = new THREE.MeshBasicMaterial({
      color: 0x07080c,
      fog: true,
      toneMapped: true,
    });
    applyCityWrap(material);
    this.materials.push(material);

    const cables: DetailSpec[] = [];
    const pushCable = (
      x: number,
      y: number,
      z: number,
      rotationY: number,
      span: number,
    ): void => {
      cables.push({
        x,
        y,
        z,
        rotationY,
        scaleX: span,
        scaleY: 1,
        scaleZ: 1,
        tint: new THREE.Color(1, 1, 1),
      });
    };

    for (let boundary = 0; boundary < CITY_GRID; boundary += 1) {
      if (!boundaryHasGali(boundary)) continue;
      const lane = MINOR_LANES[boundary]!;
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell)) continue;
        const along = -CITY_HALF + (cell + 0.5) * CITY_CELL;

        // Wires crossing the lane, tied to the facades on either side.
        if (random.next() < 0.21) {
          const z = along + random.range(-5.8, 5.8);
          const baseY = random.range(5.4, 8.6);
          const wires = random.int(1, 4);
          for (let wire = 0; wire < wires; wire += 1) {
            pushCable(
              lane + random.range(-0.35, 0.35),
              baseY + wire * random.range(0.13, 0.24),
              z + random.range(-0.16, 0.16),
              0,
              random.range(6.6, 9.2),
            );
          }
        }

        // Wires running down the lane, pole to pole.
        if (random.next() < 0.34) {
          const baseY = random.range(6.0, 9.2);
          const wires = random.int(1, 3);
          for (let wire = 0; wire < wires; wire += 1) {
            pushCable(
              lane + random.range(-1.0, 1.0),
              baseY + wire * random.range(0.14, 0.28),
              along,
              Math.PI / 2,
              CITY_CELL + random.range(0.6, 3.4),
            );
          }
        }
      }
    }

    // The odd high span across an arterial, where a bundle jumps the road.
    for (const lane of MAJOR_LANES) {
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell) || random.next() > 0.05) continue;
        const along = -CITY_HALF + (cell + 0.5) * CITY_CELL;
        pushCable(
          lane,
          random.range(8.5, 11.5),
          along + random.range(-4.5, 4.5),
          0,
          random.range(17.5, 21.5),
        );
      }
    }

    this.addInstances(geometry, material, cables, 'mohalla-overhead-cables');
  }

  /**
   * A fully connected street network. Arterials are whole 16 m cells with
   * 11.2 m of asphalt and a 2.4 m paver footpath on each side. Every other
   * cell boundary is a 3.4 m gali that stops at the arterial pavement and
   * crosses it with a dropped kerb. Roads are cut into ≤16 m chunks so the
   * city-wrap shader can keep every piece seamless while the drone flies.
   */
  private buildRoadNetwork(random: Random, textures: ProceduralTextures): void {
    const asphaltMap = this.cloneTexture(textures.asphalt, 1, 1, false);
    const asphaltMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: asphaltMap,
      roughness: 0.84,
      metalness: 0.04,
    });
    // The asphalt canvas covers roughly an 8 m square of road. Using world
    // space UVs avoids a visible restart at every 16 m chunk.
    applyCityWrap(asphaltMaterial, 8);
    this.materials.push(asphaltMaterial);

    const paverMap = this.cloneTexture(textures.pavers, 1, 1, false);
    const paverMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: paverMap,
      roughness: 0.96,
      metalness: 0.01,
    });
    applyCityWrap(paverMaterial, 4);
    this.materials.push(paverMaterial);

    const roadGeometry = new THREE.PlaneGeometry(1, 1);
    roadGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(roadGeometry);

    const sidewalkGeometry = new THREE.PlaneGeometry(1, 1);
    sidewalkGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(sidewalkGeometry);

    const curbGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(curbGeometry);

    const roads: DetailSpec[] = [];
    const sidewalks: DetailSpec[] = [];
    const curbs: DetailSpec[] = [];
    const roadTint = new THREE.Color(0.92, 0.9, 0.88);

    const addRoad = (x: number, z: number, width: number, depth: number, y: number): void => {
      roads.push({
        x,
        y,
        z,
        rotationY: 0,
        scaleX: width,
        scaleY: 1,
        scaleZ: depth,
        tint: roadTint,
      });
    };
    const addWalk = (x: number, z: number, width: number, depth: number): void => {
      sidewalks.push({
        x,
        y: 0.07,
        z,
        rotationY: 0,
        scaleX: width,
        scaleY: 1,
        scaleZ: depth,
        tint: new THREE.Color(0.9, 0.87, 0.82).multiplyScalar(random.range(0.92, 1.04)),
      });
    };
    const addCurb = (x: number, z: number, width: number, depth: number): void => {
      curbs.push({
        x,
        y: 0.08,
        z,
        rotationY: 0,
        scaleX: width,
        scaleY: 0.16,
        scaleZ: depth,
        tint: new THREE.Color(0.78, 0.75, 0.7).multiplyScalar(random.range(0.9, 1.04)),
      });
    };

    // Galis run along every non-arterial cell boundary. The longitudinal
    // direction is continuous; the crossing direction is trimmed by half a
    // gali so two asphalt planes never share the same y.
    for (let boundary = 0; boundary < CITY_GRID; boundary += 1) {
      if (!boundaryHasGali(boundary)) continue;
      const lane = MINOR_LANES[boundary]!;

      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        const cellCenter = -CITY_HALF + (cell + 0.5) * CITY_CELL;
        if (!isMajorCell(cell)) {
          // Vertical gali: full 16 m chunk. Horizontal gali: shorten at each
          // end where it meets another gali, because the vertical asphalt
          // already owns that square.
          addRoad(lane, cellCenter, MINOR_ROAD_WIDTH, CITY_CELL, 0.012);
          const trimStart = boundaryHasGali(cell) ? MINOR_ROAD_WIDTH / 2 : 0;
          const trimEnd = boundaryHasGali(cell + 1) ? MINOR_ROAD_WIDTH / 2 : 0;
          const depth = CITY_CELL - trimStart - trimEnd;
          addRoad(
            cellCenter + (trimStart - trimEnd) / 2,
            lane,
            depth,
            MINOR_ROAD_WIDTH,
            0.014,
          );
        } else {
          // The pavement is 2.4 m deep. A short asphalt apron lets the gali
          // meet the arterial asphalt instead of dead-ending at a curb.
          const arterialCenter = -CITY_HALF + (cell + 0.5) * CITY_CELL;
          for (const side of [-1, 1] as const) {
            const apron = arterialCenter
              + side * (MAJOR_HALF_ROAD + MAJOR_WALK_WIDTH / 2);
            addRoad(lane, apron, MINOR_ROAD_WIDTH, MAJOR_WALK_WIDTH, 0.016);
            addRoad(apron, lane, MAJOR_WALK_WIDTH, MINOR_ROAD_WIDTH, 0.017);
          }
        }
      }
    }

    // Arterials. Vertical carriageways run the whole length; horizontal ones
    // stop at each vertical carriageway so the crossing is one shared sheet
    // of asphalt rather than two coplanar pages fighting for the depth buffer.
    for (const lane of MAJOR_LANES) {
      addRoad(lane, 0, MAJOR_ROAD_WIDTH, CITY_PERIOD, 0.018);
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell)) continue;
        const center = -CITY_HALF + (cell + 0.5) * CITY_CELL;
        addRoad(center, lane, CITY_CELL, MAJOR_ROAD_WIDTH, 0.019);
      }
    }

    // Footpaths. A path is trimmed at every gali mouth so pedestrians step
    // down onto the side street, and skipped entirely at an arterial crossing
    // where the four corner squares take over.
    for (const lane of MAJOR_LANES) {
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell)) continue;
        const startTrim = boundaryHasGali(cell) ? MINOR_ROAD_WIDTH / 2 : 0;
        const endTrim = boundaryHasGali(cell + 1) ? MINOR_ROAD_WIDTH / 2 : 0;
        const length = CITY_CELL - startTrim - endTrim;
        const center =
          -CITY_HALF + cell * CITY_CELL + startTrim + length / 2;

        for (const side of [-1, 1] as const) {
          const offset = side * MAJOR_WALK_CENTER;
          const curbOffset = side * (MAJOR_HALF_ROAD + 0.12);
          addWalk(lane + offset, center, MAJOR_WALK_WIDTH, length);
          addWalk(center, lane + offset, length, MAJOR_WALK_WIDTH);
          addCurb(lane + curbOffset, center, 0.24, length);
          addCurb(center, lane + curbOffset, length, 0.24);
        }
      }
    }

    // Corner squares close the pavement ring at every intersection.
    const cornerSize = MAJOR_WALK_WIDTH - 0.04;
    for (const xLane of MAJOR_LANES) {
      for (const zLane of MAJOR_LANES) {
        for (const sx of [-1, 1] as const) {
          for (const sz of [-1, 1] as const) {
            const x = xLane + sx * MAJOR_WALK_CENTER;
            const z = zLane + sz * MAJOR_WALK_CENTER;
            addWalk(x, z, cornerSize, cornerSize);
            addCurb(
              xLane + sx * (MAJOR_HALF_ROAD + 0.12),
              z,
              0.24,
              cornerSize,
            );
            addCurb(
              x,
              zLane + sz * (MAJOR_HALF_ROAD + 0.12),
              cornerSize,
              0.24,
            );
          }
        }
      }
    }

    this.addInstances(roadGeometry, asphaltMaterial, roads, 'mohalla-asphalt');
    this.addInstances(sidewalkGeometry, paverMaterial, sidewalks, 'mohalla-pavements');
    this.addInstances(curbGeometry, paverMaterial, curbs, 'mohalla-curbs');

    this.buildRoadMarkings(random);
    this.buildPavementDetail();

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
  }

  /** Lane dashes, zebra crossings and the odd patched repair. */
  private buildRoadMarkings(random: Random): void {
    const markingGeometry = new THREE.PlaneGeometry(1, 1);
    markingGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(markingGeometry);

    const markingMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: true,
      toneMapped: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    applyCityWrap(markingMaterial);
    this.materials.push(markingMaterial);

    const dashes: DetailSpec[] = [];
    const zebra: DetailSpec[] = [];

    for (const lane of MAJOR_LANES) {
      for (let along = -CITY_HALF + 6; along < CITY_HALF - 4; along += 9) {
        if (MAJOR_LANES.some((cross) => Math.abs(along - cross) < 9.5)) continue;
        dashes.push({
          x: lane,
          y: 0.026,
          z: along,
          rotationY: 0,
          scaleX: 0.16,
          scaleY: 1,
          scaleZ: 3.2,
          tint: new THREE.Color(0.92, 0.83, 0.56),
        });
        dashes.push({
          x: along,
          y: 0.027,
          z: lane,
          rotationY: 0,
          scaleX: 3.2,
          scaleY: 1,
          scaleZ: 0.16,
          tint: new THREE.Color(0.92, 0.83, 0.56),
        });
      }
    }

    // Zebra stripes on all four approaches of every arterial crossing.
    for (const xLane of MAJOR_LANES) {
      for (const zLane of MAJOR_LANES) {
        for (const side of [-1, 1] as const) {
          for (let stripe = 0; stripe < 7; stripe += 1) {
            const across = (stripe - 3) * 1.45;
            zebra.push({
              x: xLane + across,
              y: 0.03,
              z: zLane + side * (MAJOR_HALF_ROAD + 1.15),
              rotationY: 0,
              scaleX: 0.62,
              scaleY: 1,
              scaleZ: 1.7,
              tint: new THREE.Color(0.9, 0.9, 0.86),
            });
            zebra.push({
              x: xLane + side * (MAJOR_HALF_ROAD + 1.15),
              y: 0.031,
              z: zLane + across,
              rotationY: 0,
              scaleX: 1.7,
              scaleY: 1,
              scaleZ: 0.62,
              tint: new THREE.Color(0.9, 0.9, 0.86),
            });
          }
        }
      }
    }

    this.addInstances(markingGeometry, markingMaterial, dashes, 'mohalla-lane-markings');
    this.addInstances(markingGeometry, markingMaterial, zebra, 'mohalla-zebra-crossings');

    void random;
  }

  /** Manhole covers, potholes and damp patches set into the asphalt. */
  private buildPavementDetail(): void {
    const discGeometry = new THREE.CircleGeometry(1, 12);
    discGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(discGeometry);

    const ringGeometry = new THREE.RingGeometry(0.62, 1, 12);
    ringGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(ringGeometry);

    const wetMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: true,
    });
    applyCityWrap(wetMaterial);
    this.materials.push(wetMaterial);

    const metalMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: true,
    });
    applyCityWrap(metalMaterial);
    this.materials.push(metalMaterial);

    const patches: DetailSpec[] = [];
    const covers: DetailSpec[] = [];
    const random = new Random(0x51a7);

    for (let index = 0; index < 120; index += 1) {
      const onVertical = random.next() < 0.5;
      const lane = MAJOR_LANES[random.int(0, MAJOR_LANES.length)]!;
      const along = random.range(-CITY_HALF + 10, CITY_HALF - 10);
      const x = onVertical
        ? lane + random.range(-4.4, 4.4)
        : along;
      const z = onVertical
        ? along
        : lane + random.range(-4.4, 4.4);
      if (MAJOR_LANES.some((cross) => Math.abs(
        (onVertical ? z : x) - cross,
      ) < 8.2)) continue;

      const radius = random.range(0.22, 0.68);
      patches.push({
        x,
        y: 0.029,
        z,
        rotationY: random.range(0, Math.PI),
        scaleX: radius,
        scaleY: 1,
        scaleZ: radius * random.range(0.55, 1.1),
        tint: new THREE.Color(0.11, 0.1, 0.09).multiplyScalar(random.range(0.6, 1.15)),
      });
      if (random.next() < 0.4) {
        covers.push({
          x: x + random.range(-1.4, 1.4),
          y: 0.031,
          z: z + random.range(-1.4, 1.4),
          rotationY: 0,
          scaleX: random.range(0.3, 0.4),
          scaleY: 1,
          scaleZ: random.range(0.3, 0.4),
          tint: new THREE.Color(0.22, 0.22, 0.21),
        });
      }
    }

    this.addInstances(discGeometry, wetMaterial, patches, 'mohalla-road-patches');
    this.addInstances(ringGeometry, metalMaterial, covers, 'mohalla-manhole-covers');
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
      // Keep the courtyard wall two metres inside the cell edge. The gali
      // asphalt owns 1.7 m of that edge, and a wall in the road is worse than
      // no wall at all.
      const inset = 6.1;
      const edges = [
        { x: cell.x, z: cell.z + inset, rotationY: 0 },
        { x: cell.x, z: cell.z - inset, rotationY: 0 },
        { x: cell.x + inset, z: cell.z, rotationY: Math.PI / 2 },
        { x: cell.x - inset, z: cell.z, rotationY: Math.PI / 2 },
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

    // Street trees in the pavement margins. They sit on the paver strip, not
    // behind the building line, so the canopy actually overhangs the asphalt.
    for (const lane of MAJOR_LANES) {
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell) || cell % 3 !== 0) continue;
        const along = -CITY_HALF + (cell + 0.5) * CITY_CELL;
        const side = cell % 2 === 0 ? 1 : -1;
        const x = lane + side * (MAJOR_HALF_ROAD + 1.25);
        if (!this.pointInsideBuilding(x, along, 1.2)) {
          addTree(x, along, random.range(0.9, 1.35));
        }
        const z = lane + side * (MAJOR_HALF_ROAD + 1.25);
        if (!this.pointInsideBuilding(along, z, 1.2)) {
          addTree(along, z, random.range(0.9, 1.35));
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

        if (MAJOR_LANES.some((cross) => Math.abs(along - cross) < 9.5)) {
          continue;
        }

        for (const alongX of [false, true]) {
          const x = alongX ? along : lane + side * 4.55;
          const z = alongX ? lane + side * 4.55 : along;
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

  /**
   * The small civic clutter that makes a street feel inhabited: signals at
   * arterials, service poles leaning through the galis, a roadside shrine and
   * a few parked auto-rickshaws.
   */
  private buildStreetFurniture(random: Random, glowSources: GlowSpec[]): void {
    const darkMetal = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.58,
      metalness: 0.48,
    });
    applyCityWrap(darkMetal);
    this.materials.push(darkMetal);

    const concrete = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
    });
    applyCityWrap(concrete);
    this.materials.push(concrete);

    const paint = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.48,
      metalness: 0.3,
    });
    applyCityWrap(paint);
    this.materials.push(paint);

    // ── Traffic signals ──────────────────────────────────────────────────
    const signalGeometry = createTrafficSignalGeometry();
    this.geometries.push(signalGeometry);
    const lensGeometry = new THREE.BoxGeometry(0.15, 0.15, 0.055);
    this.geometries.push(lensGeometry);

    const signalMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: true,
      toneMapped: false,
    });
    applyCityWrap(signalMaterial);
    this.materials.push(signalMaterial);

    const signals: DetailSpec[] = [];
    const lenses: DetailSpec[] = [];
    const lightPalette = [
      new THREE.Color(0.24, 1.0, 0.34),
      new THREE.Color(1.0, 0.2, 0.12),
    ];

    MAJOR_LANES.forEach((xLane, xIndex) => {
      MAJOR_LANES.forEach((zLane, zIndex) => {
        const sx = (xIndex + zIndex) % 2 === 0 ? 1 : -1;
        const sz = xIndex % 2 === 0 ? 1 : -1;
        const x = xLane + sx * (MAJOR_HALF_ROAD + 1.15);
        const z = zLane + sz * (MAJOR_HALF_ROAD + 1.15);
        const rotationY = sx > 0 ? Math.PI : 0;
        signals.push({
          x,
          y: 0.07,
          z,
          rotationY,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
          tint: new THREE.Color(0.24, 0.25, 0.25),
        });

        const armX = x + Math.cos(rotationY) * 3.0;
        const armZ = z - Math.sin(rotationY) * 3.0;
        const active = (xIndex + zIndex) % 2 === 0 ? 0 : 1;
        const colours = [
          new THREE.Color(0.16, 0.08, 0.06),
          new THREE.Color(0.16, 0.13, 0.06),
          new THREE.Color(0.07, 0.15, 0.08),
        ];
        colours[active === 0 ? 2 : 0] = lightPalette[active]!.clone();
        for (let lens = 0; lens < 3; lens += 1) {
          lenses.push({
            x: armX,
            y: 3.86 - lens * 0.3,
            z: armZ + 0.17,
            rotationY: 0,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
            tint: colours[lens]!.clone(),
          });
        }
        if (random.next() < 0.7) {
          glowSources.push({
            position: new THREE.Vector3(armX, 3.86 - (active === 0 ? 2 : 0) * 0.3, armZ + 0.24),
            color: lightPalette[active]!.clone(),
            size: random.range(0.34, 0.5),
            phase: random.range(0, Math.PI * 2),
          });
        }
      });
    });

    this.addInstances(signalGeometry, darkMetal, signals, 'mohalla-traffic-signals');
    this.addInstances(lensGeometry, signalMaterial, lenses, 'mohalla-signal-lenses');

    // ── Service poles in the galis ───────────────────────────────────────
    const poleGeometry = createUtilityPoleGeometry();
    this.geometries.push(poleGeometry);
    const poles: DetailSpec[] = [];
    for (let boundary = 0; boundary < CITY_GRID; boundary += 1) {
      if (!boundaryHasGali(boundary) || boundary % 4 !== 2) continue;
      const lane = MINOR_LANES[boundary]!;
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell) || cell % 5 !== 1) continue;
        const along = -CITY_HALF + (cell + 0.5) * CITY_CELL + random.range(-2.2, 2.2);
        const side = random.next() < 0.5 ? -1 : 1;
        const x = lane + side * 1.38;
        if (this.pointInsideBuilding(x, along, 0.3)) continue;
        poles.push({
          x,
          y: 0,
          z: along,
          rotationY: random.range(0, Math.PI),
          scaleX: 1,
          scaleY: random.range(0.92, 1.08),
          scaleZ: 1,
          tint: new THREE.Color(0.36, 0.35, 0.33).multiplyScalar(random.range(0.7, 1)),
        });

        // Every second pole blooms into a gali lamp.
        if (random.next() < 0.55) {
          glowSources.push({
            position: new THREE.Vector3(x, 6.35, along),
            color: new THREE.Color(1.0, random.range(0.5, 0.62), 0.24),
            size: random.range(0.8, 1.3),
            phase: random.range(0, Math.PI * 2),
          });
          this.lampSources.push({
            x,
            y: 6.2,
            z: along,
            color: new THREE.Color(1.0, random.range(0.5, 0.64), 0.26),
            intensity: random.range(180, 300),
          });
          this.groundPools.push({
            x,
            y: 0.06,
            z: along,
            rotationY: 0,
            scaleX: random.range(2.4, 4.2),
            scaleY: 1,
            scaleZ: random.range(2.4, 4.2),
            tint: new THREE.Color(1.0, random.range(0.45, 0.6), 0.16),
          });
        }
      }
    }
    this.addInstances(poleGeometry, concrete, poles, 'mohalla-utility-poles');

    // ── Roadside shrines ─────────────────────────────────────────────────
    const shrineGeometry = createShrineGeometry();
    this.geometries.push(shrineGeometry);
    const shrines: DetailSpec[] = [];
    for (const cell of this.emptyCells) {
      if (shrines.length >= 14 || random.next() > 0.22) continue;
      const x = cell.x + random.range(-4.4, 4.4);
      const z = cell.z + random.range(-4.4, 4.4);
      if (this.pointInsideBuilding(x, z, 1.2)) continue;
      if (Math.hypot(x, z) < 18) continue;
      const rotationY = random.range(0, Math.PI * 2);
      shrines.push({
        x,
        y: 0,
        z,
        rotationY,
        scaleX: random.range(0.8, 1.1),
        scaleY: random.range(0.85, 1.12),
        scaleZ: random.range(0.8, 1.1),
        tint: new THREE.Color(0.76, 0.52, 0.32).multiplyScalar(random.range(0.75, 1.05)),
      });
      glowSources.push({
        position: new THREE.Vector3(x, 1.25, z),
        color: new THREE.Color(1.0, 0.58, 0.2),
        size: random.range(0.6, 0.95),
        phase: random.range(0, Math.PI * 2),
      });
      this.groundPools.push({
        x,
        y: 0.05,
        z,
        rotationY: 0,
        scaleX: 3.2,
        scaleY: 1,
        scaleZ: 3.2,
        tint: new THREE.Color(1.0, 0.5, 0.16),
      });
    }
    this.addInstances(shrineGeometry, concrete, shrines, 'mohalla-shrines');

    // ── Auto-rickshaws ───────────────────────────────────────────────────
    const rickshawBody = createAutoRickshawGeometry();
    this.geometries.push(rickshawBody);
    const rickshawDetail = createAutoRickshawDetailGeometry();
    this.geometries.push(rickshawDetail);

    const rickshawBodies: DetailSpec[] = [];
    const rickshawDetails: DetailSpec[] = [];
    const rickshawTints = [
      new THREE.Color(0.22, 0.48, 0.2),
      new THREE.Color(0.78, 0.6, 0.12),
      new THREE.Color(0.16, 0.18, 0.2),
    ];

    for (const cell of this.emptyCells) {
      if (rickshawBodies.length >= 11 || random.next() > 0.3) continue;
      const x = cell.x + random.range(-3.8, 3.8);
      const z = cell.z + random.range(-3.8, 3.8);
      if (this.pointInsideBuilding(x, z, 1.6)) continue;
      if (Math.hypot(x, z) < 19) continue;
      const rotationY = random.range(0, Math.PI * 2);
      const base = {
        x,
        y: 0,
        z,
        rotationY,
        scaleX: random.range(0.92, 1.05),
        scaleY: random.range(0.92, 1.05),
        scaleZ: random.range(0.92, 1.05),
      };
      rickshawBodies.push({
        ...base,
        tint: rickshawTints[random.int(0, rickshawTints.length)]!.clone(),
      });
      rickshawDetails.push({ ...base, tint: new THREE.Color(0.09, 0.09, 0.1) });
    }
    this.addInstances(rickshawBody, paint, rickshawBodies, 'mohalla-auto-rickshaws');
    this.addInstances(rickshawDetail, darkMetal, rickshawDetails, 'mohalla-rickshaw-details');
  }

  /** Painted signboards above the shopfronts, with a few genuine neon ones. */
  private buildShopSigns(glowSources: GlowSpec[]): void {
    const texture = createShopSignTexture();
    this.ownedTextures.push(texture);
    texture.anisotropy = 4;
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(geometry);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: texture,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: true,
    });
    applyCityWrap(material);
    this.materials.push(material);

    const random = new Random(0x5b19);
    const signs: DetailSpec[] = [];
    const palette = [
      new THREE.Color(0.32, 0.62, 1.0),
      new THREE.Color(1.0, 0.38, 0.62),
      new THREE.Color(0.36, 0.9, 0.48),
      new THREE.Color(1.0, 0.72, 0.22),
      new THREE.Color(1.0, 0.42, 0.18),
      new THREE.Color(0.86, 0.3, 0.92),
    ];

    for (const spec of this.specs) {
      const face = getFace(spec, spec.frontFace);
      const count = spec.kind === 'prefab' ? 2 : random.next() < 0.72 ? random.int(1, 3) : 0;
      for (let index = 0; index < count; index += 1) {
        const width = random.range(1.8, Math.min(3.6, face.span * 0.6));
        const height = random.range(0.5, 0.82);
        const across = random.range(-0.32, 0.32) * face.span;
        const point = facePoint(spec, spec.frontFace, across, 0.075);
        const y = spec.kind === 'prefab'
          ? random.range(3.0, Math.min(7.4, spec.height - 1.1))
          : random.range(2.6, 3.0);
        const colour = palette[random.int(0, palette.length)]!.clone();
        signs.push({
          x: point.x,
          y,
          z: point.z,
          rotationY: face.rotationY,
          scaleX: width,
          scaleY: height,
          scaleZ: 1,
          tint: colour,
        });

        if (random.next() < 0.55) {
          glowSources.push({
            position: new THREE.Vector3(
              point.x + face.normalX * 0.18,
              y,
              point.z + face.normalZ * 0.18,
            ),
            color: colour.clone().multiplyScalar(1.25),
            size: random.range(0.5, 0.92),
            phase: random.range(0, Math.PI * 2),
          });
        }
      }
    }

    this.addInstances(geometry, material, signs, 'mohalla-shop-signs');
  }

  /** Lantern strings slung across the galis for Diwali. */
  private buildLanternStrings(random: Random, glowSources: GlowSpec[]): void {
    const geometry = new THREE.OctahedronGeometry(0.075, 0);
    this.geometries.push(geometry);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: true,
      toneMapped: false,
    });
    applyCityWrap(material);
    this.materials.push(material);

    const bulbs: BulbSpec[] = [];
    const palette = [
      new THREE.Color(1.0, 0.62, 0.2),
      new THREE.Color(1.0, 0.32, 0.58),
      new THREE.Color(0.36, 0.68, 1.0),
      new THREE.Color(0.5, 1.0, 0.52),
      new THREE.Color(1.0, 0.84, 0.42),
    ];

    const addString = (
      x: number,
      z: number,
      acrossX: boolean,
      span: number,
      baseY: number,
      colour: THREE.Color,
    ): void => {
      const count = 7 + random.int(0, 3);
      for (let index = 0; index < count; index += 1) {
        const t = (index + 0.5) / count;
        const across = (t - 0.5) * span;
        const y = baseY - Math.sin(t * Math.PI) * random.range(0.25, 0.5);
        const bx = x + (acrossX ? across : 0);
        const bz = z + (acrossX ? 0 : across);
        bulbs.push({ position: new THREE.Vector3(bx, y, bz), color: colour.clone() });
        if (random.next() < 0.22) {
          glowSources.push({
            position: new THREE.Vector3(bx, y, bz),
            color: colour.clone().multiplyScalar(0.9),
            size: random.range(0.22, 0.4),
            phase: random.range(0, Math.PI * 2),
          });
        }
      }
    };

    for (let boundary = 0; boundary < CITY_GRID; boundary += 1) {
      if (!boundaryHasGali(boundary)) continue;
      const lane = MINOR_LANES[boundary]!;
      for (let cell = 0; cell < CITY_GRID; cell += 1) {
        if (isMajorCell(cell)) continue;
        const along = -CITY_HALF + (cell + 0.5) * CITY_CELL;
        const colour = palette[random.int(0, palette.length)]!.clone();
        if (random.next() < 0.12) {
          addString(
            lane,
            along + random.range(-3.4, 3.4),
            true,
            random.range(4.0, 5.4),
            random.range(4.1, 5.4),
            colour,
          );
        }
        if (random.next() < 0.12) {
          addString(
            along + random.range(-3.4, 3.4),
            lane,
            false,
            random.range(4.0, 5.4),
            random.range(4.1, 5.4),
            colour,
          );
        }
      }
    }

    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, bulbs.length));
    mesh.name = 'mohalla-gali-lanterns';
    mesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    bulbs.forEach((bulb, index) => {
      matrix.makeTranslation(bulb.position.x, bulb.position.y, bulb.position.z);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, bulb.color);
    });
    mesh.count = bulbs.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  /** Hand-drawn rangoli at doorways and in the courtyards. */
  private buildRangoli(textures: ProceduralTextures): void {
    const map = textures.rangoli.clone();
    map.wrapS = THREE.ClampToEdgeWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.repeat.set(1, 1);
    map.needsUpdate = true;
    this.ownedTextures.push(map);

    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.geometries.push(geometry);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: true,
    });
    applyCityWrap(material);
    this.materials.push(material);

    const random = new Random(0x7a11);
    const decals: DetailSpec[] = [];

    for (const spec of this.specs) {
      if (random.next() > 0.35) continue;
      const face = getFace(spec, spec.frontFace);
      const point = facePoint(
        spec,
        spec.frontFace,
        random.range(-0.3, 0.3) * face.span,
        random.range(1.1, 1.9),
      );
      if (this.pointInsideBuilding(point.x, point.z, 0.35)) continue;
      if (Math.hypot(point.x, point.z) < 14) continue;
      decals.push({
        x: point.x,
        y: 0.034,
        z: point.z,
        rotationY: random.range(0, Math.PI * 2),
        scaleX: random.range(2.1, 3.4),
        scaleY: 1,
        scaleZ: random.range(2.1, 3.4),
        tint: new THREE.Color(1, 1, 1),
      });
    }

    for (const cell of this.emptyCells) {
      if (random.next() > 0.3) continue;
      decals.push({
        x: cell.x + random.range(-2.6, 2.6),
        y: 0.034,
        z: cell.z + random.range(-2.6, 2.6),
        rotationY: random.range(0, Math.PI * 2),
        scaleX: random.range(2.4, 4.2),
        scaleY: 1,
        scaleZ: random.range(2.4, 4.2),
        tint: new THREE.Color(1, 1, 1),
      });
    }

    this.addInstances(geometry, material, decals, 'mohalla-rangoli');
  }

  private collectEmptyCells(): void {
    if (this.emptyCells.length > 0) return;

    const occupied = new Set<string>();
    for (const spec of this.specs) {
      const ix = Math.floor((spec.x + CITY_HALF) / CITY_CELL);
      const iz = Math.floor((spec.z + CITY_HALF) / CITY_CELL);
      occupied.add(cellKey(ix, iz));
    }

    const laneCells = new Set<string>();
    for (let ix = 0; ix < CITY_GRID; ix += 1) {
      for (let iz = 0; iz < CITY_GRID; iz += 1) {
        if (isMajorCell(ix) || isMajorCell(iz)) laneCells.add(cellKey(ix, iz));
      }
    }

    for (let ix = 0; ix < CITY_GRID; ix += 1) {
      for (let iz = 0; iz < CITY_GRID; iz += 1) {
        const key = cellKey(ix, iz);
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

/** A black Sintex-style tank on a welded four-leg stand. */
function createWaterTankGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tank = new THREE.CylinderGeometry(0.55, 0.55, 1.3, 9);
  tank.translate(0, 1.18, 0);
  parts.push(tank);

  for (const y of [0.75, 1.55]) {
    const band = new THREE.CylinderGeometry(0.565, 0.565, 0.05, 9);
    band.translate(0, y, 0);
    parts.push(band);
  }

  const lid = new THREE.CylinderGeometry(0.35, 0.5, 0.12, 7);
  lid.translate(0, 1.88, 0);
  parts.push(lid);

  for (const x of [-0.36, 0.36]) {
    for (const z of [-0.36, 0.36]) {
      const leg = new THREE.BoxGeometry(0.075, 0.55, 0.075);
      leg.translate(x, 0.275, z);
      parts.push(leg);
    }
  }
  const platform = new THREE.BoxGeometry(1.08, 0.06, 1.08);
  platform.translate(0, 0.55, 0);
  parts.push(platform);

  return mergeParts(parts);
}

/** An angled solar collector with its horizontal storage tank. */
function createSolarHeaterGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const frame = new THREE.BoxGeometry(1.55, 0.09, 1.08);
  frame.rotateX(-0.42);
  frame.translate(0, 0.42, 0);
  parts.push(frame);

  for (const x of [-0.62, 0, 0.62]) {
    const tube = new THREE.BoxGeometry(0.055, 0.02, 1.0);
    tube.rotateX(-0.42);
    tube.translate(x, 0.48, 0.02);
    parts.push(tube);
  }

  const tank = new THREE.CylinderGeometry(0.18, 0.18, 1.25, 10);
  tank.rotateZ(Math.PI / 2);
  tank.translate(0, 0.88, -0.46);
  parts.push(tank);

  for (const x of [-0.52, 0.52]) {
    const leg = new THREE.BoxGeometry(0.05, 0.42, 0.05);
    leg.translate(x, 0.2, -0.4);
    parts.push(leg);
  }

  return mergeParts(parts);
}

/** A 2.1 m section of pipe railing with three posts and vertical bars. */
function createRoofRailingGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const y of [0.9, 0.16]) {
    const rail = new THREE.BoxGeometry(2.1, 0.045, 0.045);
    rail.translate(0, y, 0);
    parts.push(rail);
  }
  for (const x of [-1.02, 0, 1.02]) {
    const post = new THREE.BoxGeometry(0.045, 0.92, 0.045);
    post.translate(x, 0.46, 0);
    parts.push(post);
  }
  for (let index = 0; index < 3; index += 1) {
    const x = -0.72 + index * 0.72;
    const bar = new THREE.BoxGeometry(0.018, 0.74, 0.018);
    bar.translate(x, 0.53, 0);
    parts.push(bar);
  }
  return mergeParts(parts);
}

/** A lightly waved cloth hanging from its top edge. */
function createLaundryGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(0.58, 0.82, 2, 2);
  geometry.translate(0, -0.41, 0);
  const position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const wave = Math.sin(x * 9.5 + y * 4.0) * 0.035;
    position.setZ(index, wave);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** A tiny clay diya flame; the bowl is too small to read at city distance. */
function createDiyaGeometry(): THREE.BufferGeometry {
  const flame = new THREE.ConeGeometry(0.045, 0.16, 4);
  flame.translate(0, 0.08, 0);
  return flame;
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

/** A single sagging wire, one metre long before it is instance-stretched. */
function createCableGeometry(): THREE.BufferGeometry {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.5, 0, 0),
    new THREE.Vector3(0, -0.55, 0),
    new THREE.Vector3(0.5, 0, 0),
  );
  return new THREE.TubeGeometry(curve, 12, 0.035, 3, false);
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

function createTrafficSignalGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pole = new THREE.CylinderGeometry(0.07, 0.09, 4.2, 6);
  pole.translate(0, 2.1, 0);
  parts.push(pole);

  const arm = new THREE.BoxGeometry(3.2, 0.075, 0.075);
  arm.translate(1.55, 4.05, 0);
  parts.push(arm);

  const head = new THREE.BoxGeometry(0.34, 1.04, 0.3);
  head.translate(3.0, 3.56, 0);
  parts.push(head);

  const base = new THREE.CylinderGeometry(0.16, 0.2, 0.32, 6);
  base.translate(0, 0.16, 0);
  parts.push(base);

  return mergeParts(parts);
}

function createUtilityPoleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pole = new THREE.CylinderGeometry(0.075, 0.12, 7.0, 6);
  pole.translate(0, 3.5, 0);
  parts.push(pole);

  for (const y of [5.9, 6.45]) {
    const arm = new THREE.BoxGeometry(1.75, 0.08, 0.09);
    arm.translate(0, y, 0);
    parts.push(arm);
    for (const x of [-0.68, 0, 0.68]) {
      const insulator = new THREE.CylinderGeometry(0.045, 0.055, 0.16, 5);
      insulator.translate(x, y + 0.11, 0);
      parts.push(insulator);
    }
  }

  const transformer = new THREE.CylinderGeometry(0.2, 0.2, 0.62, 7);
  transformer.translate(0.26, 4.85, 0);
  parts.push(transformer);

  return mergeParts(parts);
}

function createShrineGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.BoxGeometry(1.3, 0.34, 1.3);
  base.translate(0, 0.17, 0);
  parts.push(base);

  const body = new THREE.BoxGeometry(0.86, 0.94, 0.78);
  body.translate(0, 0.8, -0.02);
  parts.push(body);

  const arch = new THREE.CylinderGeometry(0.3, 0.3, 0.5, 8, 1, false, 0, Math.PI);
  arch.rotateZ(Math.PI / 2);
  arch.rotateY(Math.PI / 2);
  arch.translate(0, 1.12, 0.37);
  parts.push(arch);

  const roof = new THREE.CylinderGeometry(0.02, 0.78, 0.5, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, 1.6, -0.02);
  parts.push(roof);

  const finial = new THREE.CylinderGeometry(0.02, 0.03, 0.42, 5);
  finial.translate(0, 1.96, -0.02);
  parts.push(finial);

  return mergeParts(parts);
}

function createAutoRickshawGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const floor = new THREE.BoxGeometry(1.24, 0.22, 2.55);
  floor.translate(0, 0.48, 0);
  parts.push(floor);

  const nose = new THREE.BoxGeometry(1.0, 0.62, 0.86);
  nose.translate(0, 0.88, 0.95);
  parts.push(nose);

  const cabin = new THREE.BoxGeometry(1.18, 0.7, 1.55);
  cabin.translate(0, 0.92, -0.22);
  parts.push(cabin);

  const roof = new THREE.BoxGeometry(1.3, 0.1, 1.72);
  roof.translate(0, 1.86, -0.12);
  parts.push(roof);

  for (const x of [-0.57, 0.57]) {
    const post = new THREE.BoxGeometry(0.06, 0.9, 0.06);
    post.translate(x, 1.38, 0.58);
    parts.push(post);
    const rearPost = new THREE.BoxGeometry(0.06, 0.9, 0.06);
    rearPost.translate(x, 1.38, -0.86);
    parts.push(rearPost);
  }

  return mergeParts(parts);
}

function createAutoRickshawDetailGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const z of [-0.82, 0.94]) {
    const wheel = new THREE.BoxGeometry(0.2, 0.52, 0.52);
    wheel.translate(0, 0.26, z);
    parts.push(wheel);
  }

  const windshield = new THREE.BoxGeometry(1.04, 0.56, 0.06);
  windshield.translate(0, 1.2, 0.45);
  parts.push(windshield);

  const bumper = new THREE.BoxGeometry(1.18, 0.14, 0.12);
  bumper.translate(0, 0.46, 1.38);
  parts.push(bumper);

  return mergeParts(parts);
}

function createShopSignTexture(): THREE.CanvasTexture {
  const width = 256;
  const height = 64;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return new THREE.CanvasTexture(canvas);

  context.fillStyle = '#f3e7cf';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#2a1a10';
  context.lineWidth = 5;
  context.strokeRect(2.5, 2.5, width - 5, height - 5);

  // Blocky, unreadable-at-distance "lettering" that reads as a local sign.
  context.fillStyle = '#24160e';
  let x = 18;
  while (x < width - 18) {
    const w = 8 + Math.floor(Math.random() * 14);
    context.fillRect(x, 20, w, 6);
    context.fillRect(x, 32, Math.max(4, w - 4), 12);
    x += w + 9 + Math.floor(Math.random() * 8);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
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

/**
 * A shallow sloped chajja with two iron brackets.
 */
function createChajjaGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const slab = new THREE.BoxGeometry(1, 0.07, 0.34);
  slab.rotateX(-0.14);
  slab.translate(0, 0, 0.17);
  parts.push(slab);

  const bracket = new THREE.BoxGeometry(0.035, 0.26, 0.03);
  bracket.rotateX(0.72);
  bracket.translate(0, -0.12, 0.08);
  parts.push(bracket);
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

  // Security grille. Baking it into the glass map gives every window the
  // cross-hatched silhouette of the real thing without one extra triangle.
  context.fillStyle = lit ? 'rgba(22, 12, 6, 0.9)' : 'rgba(2, 4, 6, 0.92)';
  for (const x of [27, 46, 82, 101]) {
    context.fillRect(x, inset, 4, size - inset * 2);
  }
  for (const y of [42, 84]) {
    context.fillRect(inset, y, size - inset * 2, 4);
  }
  context.fillStyle = 'rgba(172, 184, 188, 0.09)';
  for (const x of [27, 46, 82, 101]) {
    context.fillRect(x + 4, inset, 1, size - inset * 2);
  }

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

/**
 * Wall-only shader layer: broad plaster mottling, rain streaks and the dark
 * damp plinth that real unpainted buildings collect. It shares the city-wrap
 * vertex shader and adds no texture memory.
 */
function applyWallWeathering(material: THREE.Material): void {
  applyCityWrap(material);
  const wrapped = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (wrapped) wrapped.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vWallWorld;`,
      )
      .replace(
        'mvPosition = modelViewMatrix * mvPosition;',
        /* glsl */ `vWallWorld = mvPosition.xyz;
        mvPosition = modelViewMatrix * mvPosition;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vWallWorld;

        float wallHash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float wallNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = wallHash(i);
          float b = wallHash(i + vec2(1.0, 0.0));
          float c = wallHash(i + vec2(0.0, 1.0));
          float d = wallHash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        vec2 wallPlane = vec2(vWallWorld.x + vWallWorld.z, vWallWorld.y);
        float wallWash = wallNoise(wallPlane * 0.24 + 3.0);
        float wallGrain = wallNoise(wallPlane * 1.7 + 11.0);
        float wallStreak = wallNoise(vec2((vWallWorld.x + vWallWorld.z) * 1.15, vWallWorld.y * 0.3));
        float wallPlinth = smoothstep(3.1, 0.15, vWallWorld.y);
        float rainStreak = smoothstep(0.57, 0.9, wallStreak) * smoothstep(0.5, 6.0, vWallWorld.y);

        // Large lime-wash patches, fine render grain, then damp brick-dark
        // streaks rising from the plinth.
        diffuseColor.rgb *= 0.82 + wallWash * 0.28 + wallGrain * 0.07;
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.64, 0.58, 0.49), wallPlinth * 0.62);
        diffuseColor.rgb *= 1.0 - rainStreak * 0.22;
        diffuseColor.rgb *= mix(
          vec3(1.0),
          vec3(0.94, 0.96, 1.02),
          smoothstep(4.0, 16.0, vWallWorld.y) * 0.35
        );`,
      );
  };
  material.customProgramCacheKey = () => 'mohalla-wall-weathering-v1';
  material.needsUpdate = true;
}

/** Injects nearest-copy wrapping for any instanced material. */
function applyCityWrap(material: THREE.Material, worldUvTile = 0): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCityPeriod = { value: CITY_PERIOD };
    shader.uniforms.uStreetTile = { value: worldUvTile };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uCityPeriod;
        uniform float uStreetTile;
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
        #if defined(USE_MAP) && defined(USE_INSTANCING)
          if (uStreetTile > 0.0) {
            // World-space road UVs keep the aggregate continuous across every
            // 16 m chunk. The tile divides 512 m, so the wrap seam stays hidden.
            vMapUv = mvPosition.xz / uStreetTile;
          }
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () =>
    worldUvTile > 0 ? `mohalla-city-wrap-uv-${worldUvTile}` : 'mohalla-city-wrap-v1';
  material.needsUpdate = true;
}

function cellKey(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

function isMajorCell(index: number): boolean {
  return MAJOR_LANE_INDICES.includes(index);
}

/**
 * A 16 m cell boundary is a gali unless one of the two cells it separates is
 * an arterial corridor. Boundaries that touch an arterial belong to that
 * street's pavement, not to a side lane.
 */
function boundaryHasGali(boundary: number): boolean {
  const right = ((boundary % CITY_GRID) + CITY_GRID) % CITY_GRID;
  const left = (right - 1 + CITY_GRID) % CITY_GRID;
  return !isMajorCell(left) && !isMajorCell(right);
}

function nearestDelta(value: number, center: number): number {
  return value - center - CITY_PERIOD * Math.round((value - center) / CITY_PERIOD);
}
