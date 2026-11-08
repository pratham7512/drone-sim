import * as THREE from 'three';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import { Backdrop } from './Backdrop';
import { Sky } from './Sky';
import { Terrace } from './Terrace';
import { createProceduralTextures, type ProceduralTextures } from './textures';

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
  private readonly ground: THREE.Mesh;
  private readonly lights: THREE.Light[] = [];
  private readonly lanternLight: THREE.PointLight;

  constructor(
    private readonly scene: THREE.Scene,
    physics: PhysicsWorld,
    maxAnisotropy: number,
    pixelRatio: number,
  ) {
    scene.fog = new THREE.FogExp2(0x080b12, 0.0062);
    scene.background = new THREE.Color(0x03050b);

    const hemisphere = new THREE.HemisphereLight(0x2b3a5e, 0x160f0b, 1.05);
    this.lights.push(hemisphere);
    this.group.add(hemisphere);

    // Cool, diffuse key mimicking the last sky-light on a moonless night.
    const moonlessKey = new THREE.DirectionalLight(0x9eb5e8, 1.28);
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

    this.textures = createProceduralTextures(maxAnisotropy);

    const groundGeometry = new THREE.PlaneGeometry(1200, 1200, 1, 1);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x101116,
      roughness: 0.98,
      metalness: 0,
    });
    this.ground = new THREE.Mesh(groundGeometry, groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0;
    this.ground.receiveShadow = true;
    this.group.add(this.ground);

    physics.addStaticBox(
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(600, 1, 600),
    );

    this.terrace = new Terrace(scene, physics, this.textures, maxAnisotropy);
    this.group.add(this.terrace.group);
    this.spawnPoint = this.terrace.spawnPoint.clone();
    this.spawnHeading = this.terrace.spawnHeading;
    this.lanternLight = this.terrace.group.children.find(
      (child): child is THREE.PointLight => child instanceof THREE.PointLight,
    ) ?? new THREE.PointLight(0xffa45a, 1);

    this.sky = new Sky(pixelRatio);
    this.group.add(this.sky.group);

    this.backdrop = new Backdrop(pixelRatio);
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

  update(deltaSeconds: number, elapsedSeconds: number): void {
    this.sky.update(deltaSeconds);
    this.backdrop.update(deltaSeconds);
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
  }
}
