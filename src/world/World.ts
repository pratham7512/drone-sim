import * as THREE from 'three';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import { Backdrop, type CityMapBuilding } from './Backdrop';
import { Sky } from './Sky';
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

  constructor(
    private readonly scene: THREE.Scene,
    physics: PhysicsWorld,
    maxAnisotropy: number,
    pixelRatio: number,
    photos: PhotoTextures | null = null,
  ) {
    scene.fog = new THREE.FogExp2(0x0a0e14, 0.0044);
    scene.background = new THREE.Color(0x04060b);

    const hemisphere = new THREE.HemisphereLight(0x3a4a6e, 0x3a2416, 1.9);
    this.lights.push(hemisphere);
    this.group.add(hemisphere);

    // Cool, diffuse key mimicking the last sky-light on a moonless night.
    const moonlessKey = new THREE.DirectionalLight(0x9eb5e8, 1.7);
    moonlessKey.position.set(-26, 42, 18);
    moonlessKey.target.position.set(0, 9, 0);
    moonlessKey.castShadow = true;
    moonlessKey.shadow.mapSize.set(1024, 1024);
    moonlessKey.shadow.camera.left = -25;
    moonlessKey.shadow.camera.right = 25;
    moonlessKey.shadow.camera.top = 25;
    moonlessKey.shadow.camera.bottom = -25;
    moonlessKey.shadow.camera.near = 1;
    moonlessKey.shadow.camera.far = 90;
    moonlessKey.shadow.bias = -0.0006;
    moonlessKey.shadow.normalBias = 0.025;
    this.lights.push(moonlessKey);
    this.group.add(moonlessKey, moonlessKey.target);

    // A warm, low bounce from the sodium lamps and window light. It is not a
    // real light source, but it stops the alleys between buildings turning
    // into pure black wells at night.
    const warmBounce = new THREE.DirectionalLight(0xffa45c, 0.5);
    warmBounce.position.set(38, 10, -24);
    warmBounce.target.position.set(0, 4, 0);
    this.lights.push(warmBounce);
    this.group.add(warmBounce, warmBounce.target);

    const ambient = new THREE.AmbientLight(0x4a3826, 0.42);
    this.lights.push(ambient);
    this.group.add(ambient);

    this.textures = createProceduralTextures(maxAnisotropy);
    this.photos = photos;

    const groundGeometry = new THREE.PlaneGeometry(2000, 2000, 1, 1);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.textures.ground,
      roughness: 0.97,
      metalness: 0.015,
      bumpMap: this.textures.ground,
      bumpScale: 0.05,
    });
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

    this.backdrop = new Backdrop(pixelRatio, physics, this.textures, photos);
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
