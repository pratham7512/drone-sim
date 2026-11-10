import * as THREE from 'three';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import { Backdrop, type CityMapBuilding } from './Backdrop';
import type { CityPrefab } from './cityKit';
import { MOON_DIRECTION, Sky } from './Sky';
import { Terrace } from './Terrace';
import {
  createProceduralTextures,
  disposeSurfaceTextureSet,
  type PhotoTextures,
  type ProceduralTextures,
} from './textures';

/**
 * Owns the scene dressing and static collision world. Milestone two replaces
 * the placeholder skyline with layout-driven mohalla masses; the lighting,
 * fog, terrace and camera framing established here carry forward.
 */
export class World {
  readonly group = new THREE.Group();
  readonly spawnPoint: THREE.Vector3;
  readonly spawnHeading: number;
  readonly terrace: Terrace;

  private readonly sky: Sky;
  private readonly backdrop: Backdrop;
  private readonly textures: ProceduralTextures;
  private readonly photos: PhotoTextures | null;
  private readonly ground: THREE.Mesh;
  private readonly groundCollider: ReturnType<PhysicsWorld['addStaticBox']>;
  private readonly groundCenter = new THREE.Vector2();
  private readonly lights: THREE.Light[] = [];
  private readonly lanternLight: THREE.PointLight;
  private readonly moonKey: THREE.DirectionalLight;
  private readonly streetLights: THREE.PointLight[] = [];
  private readonly streetLightAnchor = new THREE.Vector2(Number.POSITIVE_INFINITY, 0);

  constructor(
    private readonly scene: THREE.Scene,
    physics: PhysicsWorld,
    maxAnisotropy: number,
    pixelRatio: number,
    photos: PhotoTextures | null = null,
    prefabs: readonly CityPrefab[] = [],
  ) {
    scene.fog = new THREE.FogExp2(0x171310, 0.0032);
    scene.background = new THREE.Color(0x04060b);

    const hemisphere = new THREE.HemisphereLight(0x586a94, 0x503521, 1.62);
    this.lights.push(hemisphere);
    this.group.add(hemisphere);

    // Moonlight, aligned with the crescent in the sky shader. It is weak and
    // cool compared with the sodium street lighting, but its raking shadows
    // give roofs and parapets a real edge.
    this.moonKey = new THREE.DirectionalLight(0xc6d6ff, 1.5);
    this.moonKey.position.copy(MOON_DIRECTION).multiplyScalar(80);
    this.moonKey.target.position.set(0, 9, 0);
    this.moonKey.castShadow = true;
    this.moonKey.shadow.mapSize.set(1536, 1536);
    this.moonKey.shadow.camera.left = -32;
    this.moonKey.shadow.camera.right = 32;
    this.moonKey.shadow.camera.top = 32;
    this.moonKey.shadow.camera.bottom = -32;
    this.moonKey.shadow.camera.near = 1;
    this.moonKey.shadow.camera.far = 180;
    this.moonKey.shadow.bias = -0.0005;
    this.moonKey.shadow.normalBias = 0.03;
    this.lights.push(this.moonKey);
    this.group.add(this.moonKey, this.moonKey.target);

    // Warm bounce from kilometres of sodium-lit walls. This is the global
    // fill that keeps the alleys readable without flattening the rooftops.
    const warmBounce = new THREE.DirectionalLight(0xffa45c, 0.58);
    warmBounce.position.set(38, 10, -24);
    warmBounce.target.position.set(0, 4, 0);
    this.lights.push(warmBounce);
    this.group.add(warmBounce, warmBounce.target);

    const ambient = new THREE.AmbientLight(0x4a3828, 0.38);
    this.lights.push(ambient);
    this.group.add(ambient);

    // Eight real point lights follow the nearest street lamps and lit
    // shopfronts around the drone. They replace the flat "warm texture" trick
    // with actual inverse-square illumination on walls, asphalt and props.
    for (let index = 0; index < 8; index += 1) {
      const light = new THREE.PointLight(0xff9a4c, 0, 32, 2);
      light.castShadow = false;
      this.streetLights.push(light);
      this.lights.push(light);
      this.group.add(light);
    }

    this.textures = createProceduralTextures(maxAnisotropy);
    this.photos = photos;

    const groundGeometry = new THREE.PlaneGeometry(2000, 2000, 1, 1);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0xb8a993,
      map: this.textures.ground,
      roughness: 0.94,
      metalness: 0.01,
      bumpMap: this.textures.ground,
      bumpScale: 0.07,
    });
    this.textures.ground.repeat.set(100, 100);
    this.ground = new THREE.Mesh(groundGeometry, groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0;
    this.ground.receiveShadow = true;
    this.group.add(this.ground);

    this.groundCollider = physics.addStaticBox(
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(2500, 1, 2500),
    );

    this.terrace = new Terrace(scene, physics, this.textures, maxAnisotropy, photos);
    this.group.add(this.terrace.group);
    this.spawnPoint = this.terrace.spawnPoint.clone();
    this.spawnHeading = this.terrace.spawnHeading;
    this.lanternLight = this.terrace.group.children.find(
      (child): child is THREE.PointLight => child instanceof THREE.PointLight,
    ) ?? new THREE.PointLight(0xffa45a, 1);

    this.sky = new Sky(pixelRatio);
    this.group.add(this.sky.group);

    this.backdrop = new Backdrop(
      pixelRatio,
      physics,
      this.textures,
      photos,
      prefabs,
    );
    this.group.add(this.backdrop.group);

    // Distant terrace silhouettes are dimmed by exp² fog, which hides their
    // box simplification while keeping their warm windows legible.
    this.backdrop.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.matrixAutoUpdate = false;
        child.updateMatrix();
      }
    });

    this.scene.add(this.group);
  }

  /**
   * Builds the PMREM sky probe and applies it to every standard material.
   * This gives walls, asphalt and metal a directional ambient response that a
   * flat hemisphere light can never reproduce.
   */
  enableImageBasedLighting(renderer: THREE.WebGLRenderer): void {
    this.scene.environment = this.sky.createEnvironment(renderer);
    this.scene.environmentIntensity = 1.0;
  }

  get terrainHeight(): number {
    return 0;
  }

  get heroLight(): THREE.PointLight {
    return this.lanternLight;
  }

  get cityBuildings(): number {
    return this.backdrop.buildingCount;
  }

  get activeColliders(): number {
    return this.backdrop.activeColliderCount;
  }

  get cityPeriod(): number {
    return this.backdrop.cityPeriod;
  }

  get radarBuildings(): readonly CityMapBuilding[] {
    return this.backdrop.mapBuildings;
  }

  get homePad(): { x: number; y: number; z: number; radius: number } {
    return {
      x: this.terrace.padCenter.x,
      y: this.terrace.padCenter.y,
      z: this.terrace.padCenter.z,
      radius: this.terrace.padRadius,
    };
  }

  update(deltaSeconds: number, elapsedSeconds: number, cameraPosition: THREE.Vector3): void {
    this.sky.update(deltaSeconds, cameraPosition);
    this.backdrop.update(deltaSeconds, cameraPosition);

    // The moon stays fixed at infinity, so the shadow-casting key light has to
    // follow the drone while keeping the same direction.
    this.moonKey.position
      .copy(cameraPosition)
      .addScaledVector(MOON_DIRECTION, 85);
    this.moonKey.target.position.set(cameraPosition.x, 0, cameraPosition.z);
    this.moonKey.target.updateMatrixWorld();

    const moved = Math.hypot(
      cameraPosition.x - this.streetLightAnchor.x,
      cameraPosition.z - this.streetLightAnchor.y,
    );
    if (moved > 3.5) {
      this.streetLightAnchor.set(cameraPosition.x, cameraPosition.z);
      this.updateStreetLights(cameraPosition);
    }

    // The ground is a local patch that follows the camera. The skyline repeats
    // on a long period, so only the horizon's parallax needs to stay continuous.
    this.ground.position.x = cameraPosition.x;
    this.ground.position.z = cameraPosition.z;

    // Anchor the earth texture to world space so the ground does not appear to
    // slide beneath the drone while it flies.
    const groundMap = (this.ground.material as THREE.MeshStandardMaterial).map;
    if (groundMap) {
      const tile = 20;
      groundMap.offset.set(
        (cameraPosition.x / tile) % 1,
        (-cameraPosition.z / tile) % 1,
      );
    }

    const groundDx = cameraPosition.x - this.groundCenter.x;
    const groundDz = cameraPosition.z - this.groundCenter.y;
    if (Math.hypot(groundDx, groundDz) > 900) {
      this.groundCenter.set(cameraPosition.x, cameraPosition.z);
      this.groundCollider.setTranslation({
        x: cameraPosition.x,
        y: -1,
        z: cameraPosition.z,
      });
    }

    this.terrace.update(deltaSeconds, elapsedSeconds);
  }

  /**
   * Promotes the closest authored lamps/shopfronts to real point lights. Only
   * six are active, but because they are chosen in wrapped world space the
   * lighting stays continuous as the city repeats.
   */
  private updateStreetLights(cameraPosition: THREE.Vector3): void {
    const period = this.backdrop.cityPeriod;
    const candidates: Array<{ x: number; y: number; z: number; distance: number; color: THREE.Color; intensity: number }> = [];
    for (const lamp of this.backdrop.lampPositions) {
      const x = cameraPosition.x + nearestDelta(lamp.x, cameraPosition.x, period);
      const z = cameraPosition.z + nearestDelta(lamp.z, cameraPosition.z, period);
      const distance = Math.hypot(x - cameraPosition.x, z - cameraPosition.z);
      if (distance > 60) continue;
      candidates.push({
        x,
        y: lamp.y,
        z,
        distance,
        color: lamp.color,
        intensity: lamp.intensity,
      });
    }
    candidates.sort((a, b) => a.distance - b.distance);

    this.streetLights.forEach((light, index) => {
      const candidate = candidates[index];
      if (!candidate) {
        light.intensity = 0;
        return;
      }
      light.position.set(candidate.x, candidate.y, candidate.z);
      light.color.copy(candidate.color);
      light.intensity = candidate.intensity;
      light.distance = 30;
      light.decay = 2;
    });
  }

  dispose(): void {
    this.terrace.dispose();
    this.sky.dispose();
    this.backdrop.dispose();
    this.scene.remove(this.group);
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    for (const light of this.lights) {
      light.dispose();
    }
    this.textures.wall.dispose();
    this.textures.roof.dispose();
    this.textures.wood.dispose();
    this.textures.glow.dispose();
    this.textures.rangoli.dispose();
    this.textures.ground.dispose();
    this.textures.asphalt.dispose();
    this.textures.pavers.dispose();
    if (this.photos) {
      disposeSurfaceTextureSet(this.photos.wall);
      disposeSurfaceTextureSet(this.photos.roof);
    }
  }
}

/** Signed distance to the nearest repeat of `value` around the camera. */
function nearestDelta(value: number, center: number, period: number): number {
  return value - center - period * Math.round((value - center) / period);
}
