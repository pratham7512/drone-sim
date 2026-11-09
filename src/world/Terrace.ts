import * as THREE from 'three';
import { Random } from '../engine/math';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import type { PhotoTextures, ProceduralTextures } from './textures';

interface GlowSource {
  position: THREE.Vector3;
  color: THREE.Color;
  size: number;
  phase: number;
  flicker: number;
}

const ROOF_HEIGHT = 9.9;
const BUILDING_HALF_WIDTH = 8.8;
const BUILDING_HALF_DEPTH = 7.7;
const PARAPET_HEIGHT = 0.82;
const PARAPET_THICKNESS = 0.24;
const RANGOLI_X = 0.75;
const RANGOLI_Z = -1.25;
const RANGOLI_RADIUS = 1.5;
const PAD_X = 1.15;
const PAD_Z = 3.4;
const PAD_RADIUS = 1.7;

/**
 * The single starting terrace for milestone one. Its dimensions are deliberately
 * authored in meters so rooftop landing pads and collision volumes can be lifted
 * directly into the eventual layout JSON.
 */
export class Terrace {
  readonly group = new THREE.Group();
  readonly spawnPoint = new THREE.Vector3(PAD_X, ROOF_HEIGHT + 0.14, PAD_Z);
  readonly padCenter = new THREE.Vector3(PAD_X, ROOF_HEIGHT + 0.02, PAD_Z);
  readonly padRadius = PAD_RADIUS;
  /** Slight left turn keeps the lantern and nearest diyas in the opening frame. */
  readonly spawnHeading = 0.07;

  private readonly lanternPivot = new THREE.Group();
  private readonly lanternLight: THREE.PointLight;
  private readonly diyaLight: THREE.PointLight;
  private readonly lanternGlowMaterial: THREE.SpriteMaterial;
  private readonly glowMaterial: THREE.ShaderMaterial;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly clonedTextures: THREE.Texture[] = [];
  private readonly lanternBaseY: number;
  private padRingMaterial!: THREE.MeshBasicMaterial;
  private padGlowMaterial!: THREE.MeshBasicMaterial;
  private readonly padLightPositions: THREE.Vector3[] = [];

  constructor(
    scene: THREE.Scene,
    physics: PhysicsWorld,
    textures: ProceduralTextures,
    maxAnisotropy: number,
    photos: PhotoTextures | null = null,
  ) {
    this.group.name = 'starting-terrace';

    this.preparePhotoRepeat(photos);
    // Three warns when an optional map is present but undefined, so only add
    // the procedural bump and photo aux maps when they actually exist.
    const wallParams: THREE.MeshStandardMaterialParameters = {
      map: photos?.wall.map ?? textures.wall,
      normalScale: new THREE.Vector2(0.72, 0.72),
      roughness: photos ? 1 : 0.94,
      metalness: 0.01,
    };
    if (photos) {
      wallParams.normalMap = photos.wall.normalMap;
      wallParams.roughnessMap = photos.wall.roughnessMap;
    } else {
      wallParams.bumpMap = this.cloneLinear(textures.wall);
      wallParams.bumpScale = 0.035;
    }
    const wallMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial(wallParams),
    );
    const roofParams: THREE.MeshStandardMaterialParameters = {
      map: photos?.roof.map ?? textures.roof,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: photos ? 1 : 0.98,
      metalness: 0,
    };
    if (photos) {
      roofParams.normalMap = photos.roof.normalMap;
      roofParams.roughnessMap = photos.roof.roughnessMap;
    } else {
      roofParams.bumpMap = this.cloneLinear(textures.roof);
      roofParams.bumpScale = 0.024;
    }
    const roofMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial(roofParams),
    );
    const concreteMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({ color: 0x4c4a46, roughness: 0.94 }),
    );
    const darkMetal = this.trackMaterial(
      new THREE.MeshStandardMaterial({ color: 0x171b20, roughness: 0.56, metalness: 0.58 }),
    );
    const tankMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({ color: 0x151d23, roughness: 0.74, metalness: 0.18 }),
    );
    const woodMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        map: textures.wood,
        roughness: 0.82,
        metalness: 0.02,
      }),
    );
    const warmInterior = this.trackMaterial(
      new THREE.MeshBasicMaterial({ color: 0xffb265, toneMapped: false }),
    );
    const greenMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({ color: 0x18221a, roughness: 0.88 }),
    );
    const clayMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({ color: 0x603b28, roughness: 0.9 }),
    );
    const flameMaterial = this.trackMaterial(
      new THREE.MeshBasicMaterial({ color: 0xffe2a2, toneMapped: false }),
    );

    this.buildBuilding(wallMaterial, roofMaterial, concreteMaterial, darkMetal, warmInterior);
    this.buildRoofObjects(
      wallMaterial,
      concreteMaterial,
      darkMetal,
      tankMaterial,
      woodMaterial,
      warmInterior,
      greenMaterial,
    );
    this.buildWindowGlow();
    this.buildRangoli(textures.rangoli);
    this.buildLandingPad();

    // Collision: one block for the building mass + individual parapet and
    // rooftop solids. The terrace floor top is exactly ROOF_HEIGHT.
    physics.addStaticBox(
      new THREE.Vector3(0, ROOF_HEIGHT / 2, 0),
      new THREE.Vector3(BUILDING_HALF_WIDTH, ROOF_HEIGHT / 2, BUILDING_HALF_DEPTH),
    );
    this.addParapetCollision(physics);

    this.lanternLight = new THREE.PointLight(0xff9f53, 17, 17, 2);
    this.lanternLight.position.set(-1.7, 11.28, -3.35);
    this.lanternLight.castShadow = false;
    this.lanternLight.decay = 2;
    this.group.add(this.lanternLight);

    // A small warm pool from the rangoli diyas. This is the fourth and final
    // dynamic light: the rest of the festive glow is emissive geometry.
    this.diyaLight = new THREE.PointLight(0xff7a2e, 5.2, 7.2, 2);
    this.diyaLight.position.set(RANGOLI_X, ROOF_HEIGHT + 0.56, RANGOLI_Z);
    this.diyaLight.castShadow = false;
    this.group.add(this.diyaLight);

    const lanternGlow = createLanternGlowTexture();
    this.lanternGlowMaterial = new THREE.SpriteMaterial({
      map: lanternGlow,
      color: 0xffb366,
      transparent: true,
      opacity: 0.48,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    const lanternGlowSprite = new THREE.Sprite(this.lanternGlowMaterial);
    lanternGlowSprite.scale.setScalar(2.65);
    lanternGlowSprite.position.copy(this.lanternLight.position);
    this.group.add(lanternGlowSprite);

    this.buildLantern(warmInterior, darkMetal);
    this.lanternBaseY = this.lanternPivot.position.y;

    const festive = this.buildFestiveLights(clayMaterial, flameMaterial);
    this.glowMaterial = festive.material;

    scene.add(this.group);

    // The texture's UV transform is shared across facades; the roof reads best
    // with a denser repeat than the walls.
    textures.roof.repeat.set(4.1, 3.6);
    textures.roof.anisotropy = Math.min(8, maxAnisotropy);
  }

  update(_deltaSeconds: number, elapsedSeconds: number): void {
    const flicker =
      0.92 +
      Math.sin(elapsedSeconds * 7.4) * 0.045 +
      Math.sin(elapsedSeconds * 13.7 + 1.2) * 0.022;
    this.lanternLight.intensity = 17 * flicker;
    this.lanternGlowMaterial.opacity = 0.46 * flicker;
    this.lanternPivot.position.y = this.lanternBaseY + Math.sin(elapsedSeconds * 0.9) * 0.012;
    this.lanternPivot.rotation.z = Math.sin(elapsedSeconds * 0.65) * 0.012;

    const diyaFlicker =
      0.9 +
      Math.sin(elapsedSeconds * 8.6 + 0.4) * 0.06 +
      Math.sin(elapsedSeconds * 15.1 + 2.2) * 0.035;
    this.diyaLight.intensity = 5.2 * diyaFlicker;
    this.glowMaterial.uniforms.uTime!.value = elapsedSeconds;

    const padPulse = 0.72 + Math.sin(elapsedSeconds * 2.1) * 0.18;
    this.padRingMaterial.opacity = padPulse;
    this.padGlowMaterial.opacity = 0.12 + padPulse * 0.1;
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
        object.geometry.dispose();
      }
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line || object instanceof THREE.Sprite) {
        const material = object.material;
        if (Array.isArray(material)) {
          for (const item of material) item.dispose();
        } else if (material) {
          material.dispose();
        }
      }
    });
    for (const material of this.materials) material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const texture of this.clonedTextures) texture.dispose();
  }

  private buildBuilding(
    wallMaterial: THREE.Material,
    roofMaterial: THREE.Material,
    concreteMaterial: THREE.Material,
    darkMetal: THREE.Material,
    warmInterior: THREE.Material,
  ): void {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(BUILDING_HALF_WIDTH * 2, ROOF_HEIGHT - 0.4, BUILDING_HALF_DEPTH * 2),
      wallMaterial,
    );
    body.position.y = (ROOF_HEIGHT - 0.4) / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(BUILDING_HALF_WIDTH * 2 + 0.24, 0.4, BUILDING_HALF_DEPTH * 2 + 0.24),
      roofMaterial,
    );
    slab.position.y = ROOF_HEIGHT - 0.2;
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.group.add(slab);

    // Thin string course catches the warm lantern light and gives the facade a
    // readable horizon when looking back up from street level.
    const cornice = new THREE.Mesh(
      new THREE.BoxGeometry(BUILDING_HALF_WIDTH * 2 + 0.34, 0.12, BUILDING_HALF_DEPTH * 2 + 0.34),
      concreteMaterial,
    );
    cornice.position.y = ROOF_HEIGHT - 0.52;
    cornice.castShadow = true;
    this.group.add(cornice);

    // Small dark street-level passage and two shutter doors. Mostly silhouettes
    // at night, but they stop the ground floor reading as one solid slab.
    const doorway = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 2.2),
      new THREE.MeshBasicMaterial({ color: 0x030304 }),
    );
    doorway.position.set(-2.2, 1.1, BUILDING_HALF_DEPTH + 0.012);
    this.group.add(doorway);

    const shutter = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 2.1),
      darkMetal,
    );
    shutter.position.set(3.6, 1.05, BUILDING_HALF_DEPTH + 0.012);
    this.group.add(shutter);

    const warmWindow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.92, 1.16),
      warmInterior,
    );
    warmWindow.position.set(-5.2, 4.6, BUILDING_HALF_DEPTH + 0.015);
    this.group.add(warmWindow);

    const secondWindow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.92, 1.16),
      new THREE.MeshBasicMaterial({ color: 0x0a0c11 }),
    );
    secondWindow.position.set(1.6, 6.65, BUILDING_HALF_DEPTH + 0.014);
    this.group.add(secondWindow);

    // Simple iron grille bars over the lit window.
    for (let i = -1; i <= 1; i += 1) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.018, 1.18, 0.025),
        darkMetal,
      );
      bar.position.set(-5.2 + i * 0.28, 4.6, BUILDING_HALF_DEPTH + 0.04);
      this.group.add(bar);
    }

    const longParapetGeometry = new THREE.BoxGeometry(
      BUILDING_HALF_WIDTH * 2,
      PARAPET_HEIGHT,
      PARAPET_THICKNESS,
    );
    const sideParapetGeometry = new THREE.BoxGeometry(
      PARAPET_THICKNESS,
      PARAPET_HEIGHT,
      BUILDING_HALF_DEPTH * 2 - PARAPET_THICKNESS * 2,
    );

    const front = new THREE.Mesh(longParapetGeometry, wallMaterial);
    front.position.set(0, ROOF_HEIGHT + PARAPET_HEIGHT / 2, -BUILDING_HALF_DEPTH);
    front.castShadow = true;
    front.receiveShadow = true;
    this.group.add(front);

    const back = new THREE.Mesh(longParapetGeometry, wallMaterial);
    back.position.set(0, ROOF_HEIGHT + PARAPET_HEIGHT / 2, BUILDING_HALF_DEPTH);
    back.castShadow = true;
    back.receiveShadow = true;
    this.group.add(back);

    const left = new THREE.Mesh(sideParapetGeometry, wallMaterial);
    left.position.set(-BUILDING_HALF_WIDTH, ROOF_HEIGHT + PARAPET_HEIGHT / 2, 0);
    left.castShadow = true;
    left.receiveShadow = true;
    this.group.add(left);

    const right = new THREE.Mesh(sideParapetGeometry, wallMaterial);
    right.position.set(BUILDING_HALF_WIDTH, ROOF_HEIGHT + PARAPET_HEIGHT / 2, 0);
    right.castShadow = true;
    right.receiveShadow = true;
    this.group.add(right);

    // A weathered concrete lip, not a geometry-heavy railing.
    const copingGeometry = new THREE.BoxGeometry(
      BUILDING_HALF_WIDTH * 2 + 0.1,
      0.06,
      PARAPET_THICKNESS + 0.1,
    );
    for (const z of [-BUILDING_HALF_DEPTH, BUILDING_HALF_DEPTH]) {
      const coping = new THREE.Mesh(copingGeometry, concreteMaterial);
      coping.position.set(0, ROOF_HEIGHT + PARAPET_HEIGHT + 0.03, z);
      coping.castShadow = true;
      this.group.add(coping);
    }

    // Silhouette utility: a short stair-head venting pipe.
    const pipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 0.9, 10),
      new THREE.MeshStandardMaterial({ color: 0x1d1f21, roughness: 0.7, metalness: 0.3 }),
    );
    pipe.position.set(7.3, ROOF_HEIGHT + 0.45, 5.9);
    this.group.add(pipe);
  }

  private buildRoofObjects(
    wallMaterial: THREE.Material,
    concreteMaterial: THREE.Material,
    darkMetal: THREE.Material,
    tankMaterial: THREE.Material,
    woodMaterial: THREE.Material,
    warmInterior: THREE.Material,
    greenMaterial: THREE.Material,
  ): void {
    // Stair enclosure / mumty.
    const mumtyShape = new THREE.BoxGeometry(3.6, 2.75, 2.9);
    const mumty = new THREE.Mesh(mumtyShape, wallMaterial);
    mumty.position.set(-5.15, ROOF_HEIGHT + 1.375, -4.45);
    mumty.castShadow = true;
    mumty.receiveShadow = true;
    this.group.add(mumty);

    const mumtyRoof = new THREE.Mesh(new THREE.BoxGeometry(3.86, 0.2, 3.16), concreteMaterial);
    mumtyRoof.position.set(-5.15, ROOF_HEIGHT + 2.85, -4.45);
    mumtyRoof.castShadow = true;
    this.group.add(mumtyRoof);

    const doorwayDark = new THREE.Mesh(
      new THREE.PlaneGeometry(1.04, 2.05),
      new THREE.MeshBasicMaterial({ color: 0x070504 }),
    );
    doorwayDark.position.set(-5.15, ROOF_HEIGHT + 1.025, -2.99);
    this.group.add(doorwayDark);

    const door = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 1.95), woodMaterial);
    door.position.set(-5.44, ROOF_HEIGHT + 1.02, -2.975);
    door.rotation.y = -0.1;
    this.group.add(door);

    // Sliver of warm interior light behind the door.
    const doorLight = new THREE.Mesh(
      new THREE.PlaneGeometry(0.1, 1.9),
      warmInterior,
    );
    doorLight.position.set(-4.73, ROOF_HEIGHT + 1.03, -2.965);
    this.group.add(doorLight);

    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.1, 0.14), darkMetal);
    lintel.position.set(-5.15, ROOF_HEIGHT + 2.05, -2.95);
    this.group.add(lintel);

    // Overhead wire across the roof carries the akash kandil.
    const wireCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-5.15, ROOF_HEIGHT + 2.78, -4.45),
      new THREE.Vector3(-1.7, ROOF_HEIGHT + 2.52, -3.35),
      new THREE.Vector3(5.3, ROOF_HEIGHT + 2.16, -4.2),
    ]);
    const wire = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(wireCurve.getPoints(28)),
      new THREE.LineBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.66 }),
    );
    this.group.add(wire);

    // Water tank on short legs.
    const tankPosition = new THREE.Vector3(5.8, ROOF_HEIGHT + 1.62, -4.4);
    const tank = new THREE.Mesh(
      new THREE.CylinderGeometry(0.93, 0.93, 1.34, 18),
      tankMaterial,
    );
    tank.position.copy(tankPosition);
    tank.castShadow = true;
    tank.receiveShadow = true;
    this.group.add(tank);

    const tankLid = new THREE.Mesh(
      new THREE.CylinderGeometry(0.97, 0.97, 0.07, 18),
      new THREE.MeshStandardMaterial({ color: 0x293037, roughness: 0.6, metalness: 0.4 }),
    );
    tankLid.position.set(tankPosition.x, tankPosition.y + 0.7, tankPosition.z);
    this.group.add(tankLid);

    for (let index = 0; index < 3; index += 1) {
      const angle = (index / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.96, 0.07), darkMetal);
      leg.position.set(
        tankPosition.x + Math.cos(angle) * 0.6,
        ROOF_HEIGHT + 0.48,
        tankPosition.z + Math.sin(angle) * 0.6,
      );
      this.group.add(leg);
    }

    // Air-conditioner condenser with a fan face.
    const ac = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.66, 0.38), darkMetal);
    ac.position.set(7.1, ROOF_HEIGHT + 0.34, 1.8);
    ac.castShadow = true;
    this.group.add(ac);

    const fan = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 16),
      new THREE.MeshBasicMaterial({ color: 0x060708 }),
    );
    fan.position.set(7.1, ROOF_HEIGHT + 0.36, 2.001);
    this.group.add(fan);

    // Three humble potted plants: enough to break the roof's hard edges.
    const random = new Random(0x4e19);
    const potGeometry = new THREE.CylinderGeometry(0.17, 0.12, 0.27, 10);
    const leafGeometry = new THREE.IcosahedronGeometry(0.21, 0);
    for (let index = 0; index < 3; index += 1) {
      const x = 7.4 - index * 0.52;
      const z = 5.8 + random.range(-0.5, 0.2);
      const pot = new THREE.Mesh(potGeometry, new THREE.MeshStandardMaterial({
        color: 0x4a2f22,
        roughness: 0.92,
      }));
      pot.position.set(x, ROOF_HEIGHT + 0.135, z);
      pot.castShadow = true;
      this.group.add(pot);

      const foliage = new THREE.Mesh(leafGeometry, greenMaterial);
      foliage.position.set(x, ROOF_HEIGHT + 0.38, z);
      foliage.scale.set(1, random.range(0.9, 1.35), 1);
      foliage.rotation.set(random.range(0, 1), random.range(0, 3), random.range(0, 1));
      foliage.castShadow = true;
      this.group.add(foliage);
    }

    // Mounting pole for the string of lights.
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.78, 8), darkMetal);
      pole.position.set(side * (BUILDING_HALF_WIDTH - 0.4), ROOF_HEIGHT + PARAPET_HEIGHT + 0.36, -BUILDING_HALF_DEPTH + 0.28);
      this.group.add(pole);
    }

    const vent = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.22, 0.34, 10),
      concreteMaterial,
    );
    vent.position.set(2.8, ROOF_HEIGHT + 0.17, 3.4);
    this.group.add(vent);
  }

  private buildWindowGlow(): void {
    // Faint bounce of the terrace's own warm window light, faked with a flat
    // emissive plane instead of yet another dynamic light.
    const spill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 2.4),
      new THREE.MeshBasicMaterial({
        color: 0x9e5e2d,
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    spill.position.set(-5.2, 4.5, BUILDING_HALF_DEPTH + 0.02);
    this.group.add(spill);
  }

  private buildRangoli(texture: THREE.CanvasTexture): void {
    const geometry = new THREE.CircleGeometry(RANGOLI_RADIUS, 64);
    const material = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        map: texture,
        emissive: 0xffb168,
        emissiveMap: texture,
        emissiveIntensity: 0.45,
        transparent: true,
        depthWrite: false,
        roughness: 0.96,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    const rangoli = new THREE.Mesh(geometry, material);
    rangoli.rotation.x = -Math.PI / 2;
    rangoli.position.set(RANGOLI_X, ROOF_HEIGHT + 0.012, RANGOLI_Z);
    rangoli.renderOrder = 1;
    rangoli.receiveShadow = true;
    this.group.add(rangoli);
  }

  private buildLandingPad(): void {
    const baseGeometry = new THREE.CircleGeometry(PAD_RADIUS + 0.06, 64);
    this.geometries.push(baseGeometry);
    const baseMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x0a1210,
        roughness: 0.58,
        metalness: 0.32,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    base.rotation.x = -Math.PI / 2;
    base.position.set(PAD_X, ROOF_HEIGHT + 0.014, PAD_Z);
    base.receiveShadow = true;
    this.group.add(base);

    const ringGeometry = new THREE.RingGeometry(PAD_RADIUS - 0.1, PAD_RADIUS + 0.04, 64);
    this.geometries.push(ringGeometry);
    this.padRingMaterial = this.trackMaterial(
      new THREE.MeshBasicMaterial({
        color: 0xffc06a,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
        fog: true,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    const ring = new THREE.Mesh(ringGeometry, this.padRingMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(PAD_X, ROOF_HEIGHT + 0.021, PAD_Z);
    ring.renderOrder = 2;
    this.group.add(ring);

    const innerRingGeometry = new THREE.RingGeometry(PAD_RADIUS - 0.46, PAD_RADIUS - 0.41, 64);
    this.geometries.push(innerRingGeometry);
    const innerRingMaterial = this.trackMaterial(
      new THREE.MeshBasicMaterial({
        color: 0xffdcac,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
        fog: true,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    const innerRing = new THREE.Mesh(innerRingGeometry, innerRingMaterial);
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.set(PAD_X, ROOF_HEIGHT + 0.022, PAD_Z);
    innerRing.renderOrder = 2;
    this.group.add(innerRing);

    const markTexture = createLandingPadTexture();
    this.clonedTextures.push(markTexture);
    const markGeometry = new THREE.PlaneGeometry(PAD_RADIUS * 1.72, PAD_RADIUS * 1.72);
    this.geometries.push(markGeometry);
    const markMaterial = this.trackMaterial(
      new THREE.MeshBasicMaterial({
        map: markTexture,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        fog: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        polygonOffsetUnits: -5,
      }),
    );
    const mark = new THREE.Mesh(markGeometry, markMaterial);
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(PAD_X, ROOF_HEIGHT + 0.026, PAD_Z);
    mark.renderOrder = 3;
    this.group.add(mark);

    const glowTexture = createPadGlowTexture();
    this.clonedTextures.push(glowTexture);
    const glowGeometry = new THREE.PlaneGeometry(PAD_RADIUS * 3.3, PAD_RADIUS * 3.3);
    this.geometries.push(glowGeometry);
    this.padGlowMaterial = this.trackMaterial(
      new THREE.MeshBasicMaterial({
        map: glowTexture,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        fog: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6,
      }),
    );
    const glow = new THREE.Mesh(glowGeometry, this.padGlowMaterial);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(PAD_X, ROOF_HEIGHT + 0.03, PAD_Z);
    glow.renderOrder = 3;
    this.group.add(glow);

    for (let index = 0; index < 4; index += 1) {
      const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
      this.padLightPositions.push(
        new THREE.Vector3(
          PAD_X + Math.cos(angle) * (PAD_RADIUS - 0.02),
          ROOF_HEIGHT + 0.07,
          PAD_Z + Math.sin(angle) * (PAD_RADIUS - 0.02),
        ),
      );
    }
  }

  private buildLantern(
    warmInterior: THREE.Material,
    darkMetal: THREE.Material,
  ): void {
    this.lanternPivot.position.set(-1.7, 12.12, -3.35);
    this.group.add(this.lanternPivot);

    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.52, 6), darkMetal);
    cord.position.y = -0.26;
    this.lanternPivot.add(cord);

    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.16, 6), darkMetal);
    cap.position.y = -0.56;
    this.lanternPivot.add(cap);

    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.23, 0.34, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffac5c,
        transparent: true,
        opacity: 0.88,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    shade.position.y = -0.81;
    this.lanternPivot.add(shade);

    const innerGlow = new THREE.Mesh(new THREE.SphereGeometry(0.052, 10, 8), warmInterior);
    innerGlow.position.y = -0.8;
    this.lanternPivot.add(innerGlow);

    const base = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.08, 6), darkMetal);
    base.rotation.z = Math.PI;
    base.position.y = -1.01;
    this.lanternPivot.add(base);

    const tassel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.004, 0.28, 5), darkMetal);
    tassel.position.y = -1.16;
    this.lanternPivot.add(tassel);
  }

  private buildFestiveLights(
    clayMaterial: THREE.Material,
    flameMaterial: THREE.Material,
  ): { material: THREE.ShaderMaterial } {
    const glowSources: GlowSource[] = [];
    const bulbPositions: THREE.Vector3[] = [];
    const bulbColors: THREE.Color[] = [];
    const random = new Random(0xdead11);
    const palette = [
      new THREE.Color(1.0, 0.56, 0.18),
      new THREE.Color(1.0, 0.76, 0.4),
      new THREE.Color(1.0, 0.25, 0.08),
      new THREE.Color(0.35, 0.9, 0.4),
      new THREE.Color(0.9, 0.2, 0.7),
    ];

    const makeGarland = (
      start: THREE.Vector3,
      end: THREE.Vector3,
      sag: number,
      count: number,
    ): void => {
      const linePoints: THREE.Vector3[] = [];
      for (let index = 0; index < count; index += 1) {
        const t = index / (count - 1);
        const x = THREE.MathUtils.lerp(start.x, end.x, t);
        const z = THREE.MathUtils.lerp(start.z, end.z, t);
        const y = THREE.MathUtils.lerp(start.y, end.y, t) - Math.sin(Math.PI * t) * sag;
        const point = new THREE.Vector3(x, y, z);
        linePoints.push(point);

        if (index === 0 || index === count - 1) continue;
        const color = random.next() > 0.86
          ? palette[random.int(2, palette.length)] ?? palette[0]!
          : palette[random.int(0, 2)] ?? palette[0]!;
        bulbPositions.push(point.clone());
        bulbColors.push(color);
        glowSources.push({
          position: point.clone(),
          color,
          size: random.range(0.58, 0.8),
          phase: random.range(0, Math.PI * 2),
          flicker: 0.24,
        });
      }

      const cord = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(linePoints),
        new THREE.LineBasicMaterial({
          color: 0x171511,
          transparent: true,
          opacity: 0.5,
        }),
      );
      this.group.add(cord);
    };

    makeGarland(
      new THREE.Vector3(-BUILDING_HALF_WIDTH + 0.4, ROOF_HEIGHT + PARAPET_HEIGHT + 0.73, -BUILDING_HALF_DEPTH + 0.28),
      new THREE.Vector3(BUILDING_HALF_WIDTH - 0.4, ROOF_HEIGHT + PARAPET_HEIGHT + 0.73, -BUILDING_HALF_DEPTH + 0.28),
      0.38,
      31,
    );
    makeGarland(
      new THREE.Vector3(-BUILDING_HALF_WIDTH + 0.28, ROOF_HEIGHT + PARAPET_HEIGHT + 0.52, 2.6),
      new THREE.Vector3(-BUILDING_HALF_WIDTH + 0.28, ROOF_HEIGHT + PARAPET_HEIGHT + 0.52, BUILDING_HALF_DEPTH - 0.5),
      0.22,
      20,
    );

    // Bulb cores catch a tiny geometric highlight even before bloom is added.
    const bulbGeometry = new THREE.SphereGeometry(0.022, 8, 5);
    const bulbMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
    });
    this.geometries.push(bulbGeometry);
    this.materials.push(bulbMaterial);
    const bulbs = new THREE.InstancedMesh(bulbGeometry, bulbMaterial, bulbPositions.length);
    const matrix = new THREE.Matrix4();
    bulbPositions.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      bulbs.setMatrixAt(index, matrix);
      bulbs.setColorAt(index, bulbColors[index]!);
    });
    bulbs.instanceMatrix.needsUpdate = true;
    if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
    bulbs.name = 'string-light-bulbs';
    this.group.add(bulbs);

    // Diyas along the front coping and around the rangoli. The two clusters
    // share one instanced mesh, so the extra flames cost no draw calls.
    const diyaPositions = [
      new THREE.Vector3(-6.0, ROOF_HEIGHT + PARAPET_HEIGHT + 0.07, -BUILDING_HALF_DEPTH),
      new THREE.Vector3(-3.2, ROOF_HEIGHT + PARAPET_HEIGHT + 0.07, -BUILDING_HALF_DEPTH),
      new THREE.Vector3(-0.4, ROOF_HEIGHT + PARAPET_HEIGHT + 0.07, -BUILDING_HALF_DEPTH),
      new THREE.Vector3(2.4, ROOF_HEIGHT + PARAPET_HEIGHT + 0.07, -BUILDING_HALF_DEPTH),
      new THREE.Vector3(5.2, ROOF_HEIGHT + PARAPET_HEIGHT + 0.07, -BUILDING_HALF_DEPTH),
    ];
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2 + Math.PI / 8;
      diyaPositions.push(
        new THREE.Vector3(
          RANGOLI_X + Math.cos(angle) * 1.78,
          ROOF_HEIGHT + 0.03,
          RANGOLI_Z + Math.sin(angle) * 1.78,
        ),
      );
    }
    diyaPositions.push(new THREE.Vector3(RANGOLI_X, ROOF_HEIGHT + 0.03, RANGOLI_Z));
    const diyaGeometry = new THREE.CylinderGeometry(0.075, 0.045, 0.055, 10);
    this.geometries.push(diyaGeometry);
    const diyas = new THREE.InstancedMesh(diyaGeometry, clayMaterial, diyaPositions.length);
    diyaPositions.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      diyas.setMatrixAt(index, matrix);
    });
    diyas.instanceMatrix.needsUpdate = true;
    diyas.name = 'diyas';
    this.group.add(diyas);

    const flameGeometry = new THREE.ConeGeometry(0.018, 0.075, 6);
    this.geometries.push(flameGeometry);
    const flames = new THREE.InstancedMesh(flameGeometry, flameMaterial, diyaPositions.length);
    diyaPositions.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y + 0.075, position.z);
      flames.setMatrixAt(index, matrix);
      const flameColor = new THREE.Color(1.0, 0.69, 0.28);
      flames.setColorAt(index, flameColor);
      glowSources.push({
        position: new THREE.Vector3(position.x, position.y + 0.09, position.z),
        color: flameColor,
        size: 0.95,
        phase: index * 1.7,
        flicker: 0.34,
      });
    });
    flames.instanceMatrix.needsUpdate = true;
    if (flames.instanceColor) flames.instanceColor.needsUpdate = true;
    this.group.add(flames);

    for (const position of this.padLightPositions) {
      glowSources.push({
        position: position.clone(),
        color: new THREE.Color(1.0, 0.73, 0.38),
        size: 1.25,
        phase: position.x * 0.7 + position.z,
        flicker: 0.08,
      });
    }

    const material = this.createGlowMaterial(glowSources);
    return { material };
  }

  private createGlowMaterial(sources: GlowSource[]): THREE.ShaderMaterial {
    const positions = new Float32Array(sources.length * 3);
    const colors = new Float32Array(sources.length * 3);
    const sizes = new Float32Array(sources.length);
    const phases = new Float32Array(sources.length);
    const flickers = new Float32Array(sources.length);

    sources.forEach((source, index) => {
      positions.set([source.position.x, source.position.y, source.position.z], index * 3);
      colors.set([source.color.r, source.color.g, source.color.b], index * 3);
      sizes[index] = source.size;
      phases[index] = source.phase;
      flickers[index] = source.flicker;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aFlicker', new THREE.BufferAttribute(flickers, 1));
    this.geometries.push(geometry);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aPhase;
        attribute float aFlicker;
        uniform float uTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          float distanceToCamera = max(0.8, -mvPosition.z);

          // Point sprites are already a soft glow, so the size is intentionally
          // larger than the physical bulb. Near bulbs clamp to avoid white blobs.
          gl_PointSize = clamp(aSize * uPixelRatio * 82.0 / distanceToCamera, 1.1, 28.0 * uPixelRatio);

          // Layered sines read as an organic flame/bulb shimmer, not a strobe.
          float shimmer = 1.0 - aFlicker * 0.5
            + aFlicker * 0.5 * sin(uTime * 5.7 + aPhase * 6.28)
            + aFlicker * 0.22 * sin(uTime * 11.9 + aPhase * 3.1);

          vColor = aColor * (0.86 + shimmer * 0.32);
          vAlpha = smoothstep(140.0, 10.0, distanceToCamera) * (0.68 + shimmer * 0.28);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec2 centered = gl_PointCoord * 2.0 - 1.0;
          float radius = dot(centered, centered);
          if (radius > 1.0) discard;
          float core = exp(-radius * 9.0);
          float bloom = exp(-radius * 2.4) * 0.34;
          float alpha = (core + bloom) * vAlpha;
          if (alpha < 0.004) discard;
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
    points.name = 'festive-light-glows';
    points.renderOrder = 3;
    this.materials.push(material);
    this.group.add(points);
    return material;
  }

  private addParapetCollision(physics: PhysicsWorld): void {
    const y = ROOF_HEIGHT + PARAPET_HEIGHT / 2;
    const halfHeight = PARAPET_HEIGHT / 2;
    physics.addStaticBox(
      new THREE.Vector3(0, y, -BUILDING_HALF_DEPTH),
      new THREE.Vector3(BUILDING_HALF_WIDTH, halfHeight, PARAPET_THICKNESS / 2),
    );
    physics.addStaticBox(
      new THREE.Vector3(0, y, BUILDING_HALF_DEPTH),
      new THREE.Vector3(BUILDING_HALF_WIDTH, halfHeight, PARAPET_THICKNESS / 2),
    );
    physics.addStaticBox(
      new THREE.Vector3(-BUILDING_HALF_WIDTH, y, 0),
      new THREE.Vector3(PARAPET_THICKNESS / 2, halfHeight, BUILDING_HALF_DEPTH),
    );
    physics.addStaticBox(
      new THREE.Vector3(BUILDING_HALF_WIDTH, y, 0),
      new THREE.Vector3(PARAPET_THICKNESS / 2, halfHeight, BUILDING_HALF_DEPTH),
    );

    // Mumty block collision and water tank cylinder.
    physics.addStaticBox(
      new THREE.Vector3(-5.15, ROOF_HEIGHT + 1.375, -4.45),
      new THREE.Vector3(1.8, 1.375, 1.45),
    );
    physics.addStaticCylinder(
      new THREE.Vector3(5.8, ROOF_HEIGHT + 1.62, -4.4),
      0.68,
      0.93,
    );
  }

  private trackMaterial<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }

  private cloneLinear(texture: THREE.Texture): THREE.Texture {
    const clone = texture.clone();
    clone.colorSpace = THREE.NoColorSpace;
    clone.needsUpdate = true;
    this.clonedTextures.push(clone);
    return clone;
  }

  private preparePhotoRepeat(photos: PhotoTextures | null): void {
    if (!photos) return;
    setTextureRepeat(photos.wall, 3.6, 2.4);
    setTextureRepeat(photos.roof, 4.1, 3.6);
  }
}

function setTextureRepeat(
  set: { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture },
  repeatX: number,
  repeatY: number,
): void {
  for (const texture of [set.map, set.normalMap, set.roughnessMap]) {
    texture.repeat.set(repeatX, repeatY);
    texture.needsUpdate = true;
  }
}

function createLandingPadTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');

  context.translate(size / 2, size / 2);
  context.lineCap = 'round';
  context.shadowColor = 'rgba(255, 184, 94, 0.9)';
  context.shadowBlur = 22;

  context.strokeStyle = 'rgba(255, 231, 196, 0.9)';
  context.lineWidth = 9;
  context.setLineDash([18, 15]);
  context.beginPath();
  context.arc(0, 0, 214, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);

  context.strokeStyle = 'rgba(247, 189, 108, 0.55)';
  context.lineWidth = 4;
  context.beginPath();
  context.arc(0, 0, 158, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = 'rgba(255, 242, 216, 0.98)';
  context.fillRect(-92, -74, 34, 148);
  context.fillRect(58, -74, 34, 148);
  context.fillRect(-58, -17, 116, 34);

  context.strokeStyle = 'rgba(255, 207, 139, 0.9)';
  context.lineWidth = 7;
  for (let index = 0; index < 4; index += 1) {
    context.save();
    context.rotate((index / 4) * Math.PI * 2);
    context.beginPath();
    context.moveTo(-34, -232);
    context.lineTo(0, -254);
    context.lineTo(34, -232);
    context.stroke();
    context.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function createPadGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    4,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, 'rgba(255, 210, 150, 0.7)');
  gradient.addColorStop(0.36, 'rgba(255, 170, 80, 0.22)');
  gradient.addColorStop(0.7, 'rgba(255, 130, 40, 0.05)');
  gradient.addColorStop(1, 'rgba(255, 120, 30, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function createLanternGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255, 248, 219, 1)');
  gradient.addColorStop(0.08, 'rgba(255, 210, 142, 0.86)');
  gradient.addColorStop(0.26, 'rgba(255, 153, 63, 0.26)');
  gradient.addColorStop(0.62, 'rgba(255, 122, 35, 0.06)');
  gradient.addColorStop(1, 'rgba(255, 100, 20, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}
