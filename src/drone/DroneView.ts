import * as THREE from 'three';
import { clamp, damp } from '../engine/math';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import type { DronePhysics } from './DronePhysics';

interface Rotor {
  blades: THREE.Group;
  direction: number;
}

/**
 * Low-poly, light-catcher drone built entirely from primitives. It is mostly
 * off-camera in FPV, but the silhouette, LEDs and animated rotor discs make the
 * chase camera and future crash effects feel physical.
 */
export class DroneView {
  readonly model = new THREE.Group();
  private readonly rotors: Rotor[] = [];
  private readonly shadow: THREE.Mesh;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly carbon: THREE.MeshStandardMaterial;
  private readonly accentMaterial: THREE.MeshStandardMaterial;
  private leanPitch = 0;
  private leanRoll = 0;
  private rotorAngle = 0;

  constructor(
    scene: THREE.Scene,
    private readonly drone: DronePhysics,
    private readonly physics: PhysicsWorld,
  ) {
    this.carbon = new THREE.MeshStandardMaterial({
      color: 0x141518,
      roughness: 0.4,
      metalness: 0.62,
    });
    this.accentMaterial = new THREE.MeshStandardMaterial({
      color: 0x6e553b,
      roughness: 0.36,
      metalness: 0.76,
    });
    const matte = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.8 });
    const skidMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.65 });
    const propMat = new THREE.MeshStandardMaterial({
      color: 0x22252a,
      roughness: 0.3,
      metalness: 0.2,
      transparent: true,
      opacity: 0.72,
    });
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x07090d,
      roughness: 0.08,
      metalness: 0.8,
    });
    const lensGlass = new THREE.MeshBasicMaterial({ color: 0x202a39 });

    this.buildHull(matte);
    this.buildArms();
    this.buildLandingGear(skidMat);
    this.buildCameraGimbal(lensMat, lensGlass);
    this.buildRotors(propMat);
    this.buildLights();

    this.model.name = 'drone';
    this.model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });

    scene.add(this.model);

    const shadowTexture = createSoftShadowTexture();
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    scene.add(this.shadow);

    this.syncTransform();
  }

  update(deltaSeconds: number, timeSeconds: number): void {
    this.syncTransform();

    const targetPitch = -clamp(this.drone.forwardSpeed / 8.2, -1, 1) * 0.135;
    const targetRoll = -clamp(this.drone.sideSpeed / 8.2, -1, 1) * 0.17;
    this.leanPitch = damp(this.leanPitch, targetPitch, 5.5, deltaSeconds);
    this.leanRoll = damp(this.leanRoll, targetRoll, 5.5, deltaSeconds);

    this.model.rotation.order = 'YXZ';
    this.model.rotation.set(this.leanPitch, this.drone.yaw, this.leanRoll);

    const rotorTarget = 24 + this.drone.speed * 8 + (this.drone.hoverAssist ? 4 : 9);
    this.rotorAngle += rotorTarget * deltaSeconds;
    for (const rotor of this.rotors) {
      rotor.blades.rotation.y = this.rotorAngle * rotor.direction;
    }

    // Real pilots don't get a projector shadow, but a faint contact smudge
    // below the drone anchors it visually against the dark ground.
    const position = this.drone.body.translation();
    const hit = this.physics.castDown(
      new THREE.Vector3(position.x, position.y - 0.14, position.z),
      16,
      this.drone.collider,
    );

    if (hit && hit.distance < 13) {
      const fade = Math.pow(1 - hit.distance / 13, 1.45);
      this.shadow.visible = true;
      this.shadow.position.set(position.x, hit.point.y + 0.012, position.z);
      this.shadow.scale.setScalar(1.05 + hit.distance * 0.13);
      this.shadowMaterial.opacity = 0.27 * fade;
    } else {
      this.shadow.visible = false;
    }

    // Very subtle LED pulse keeps the prop silhouette alive at idle.
    const LED = this.model.getObjectByName('nav-led-red');
    if (LED) LED.scale.setScalar(0.85 + Math.sin(timeSeconds * 3.2) * 0.15);
  }

  private syncTransform(): void {
    const position = this.drone.body.translation();
    this.model.position.set(position.x, position.y, position.z);
  }

  private buildHull(matte: THREE.MeshStandardMaterial): void {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.085, 0.4), this.carbon);
    body.position.y = -0.005;
    this.model.add(body);

    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 8), this.carbon);
    canopy.scale.set(0.95, 0.36, 1.28);
    canopy.position.set(0, 0.042, -0.035);
    this.model.add(canopy);

    const topPlate = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.012, 0.29), matte);
    topPlate.position.set(0, 0.07, -0.01);
    this.model.add(topPlate);

    const noseTrim = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.016, 0.03), this.accentMaterial);
    noseTrim.position.set(0, 0.02, -0.205);
    this.model.add(noseTrim);

    for (const side of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.014, 0.22), this.accentMaterial);
      stripe.position.set(side * 0.138, 0.014, 0.02);
      this.model.add(stripe);
    }
  }

  private buildArms(): void {
    const armGeometry = new THREE.BoxGeometry(0.72, 0.021, 0.048);
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(armGeometry, this.carbon);
      arm.rotation.y = angle;
      arm.position.y = 0.006;
      this.model.add(arm);
    }

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.035, 12), this.accentMaterial);
    hub.position.y = 0.048;
    this.model.add(hub);
  }

  private buildLandingGear(skidMat: THREE.MeshStandardMaterial): void {
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.016, 0.34), skidMat);
      rail.position.set(side * 0.14, -0.16, 0.025);
      this.model.add(rail);

      for (const z of [-0.11, 0.14]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.115, 0.018), skidMat);
        leg.position.set(side * 0.105, -0.105, z);
        leg.rotation.z = side * -0.14;
        this.model.add(leg);
      }
    }
  }

  private buildCameraGimbal(
    lensMat: THREE.MeshStandardMaterial,
    lensGlass: THREE.MeshBasicMaterial,
  ): void {
    const gimbal = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.07), this.carbon);
    gimbal.position.set(0, -0.03, -0.205);
    this.model.add(gimbal);

    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.045, 16), lensMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, -0.03, -0.255);
    this.model.add(lens);

    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.024, 16), lensGlass);
    glass.rotation.y = Math.PI;
    glass.position.set(0, -0.03, -0.279);
    this.model.add(glass);
  }

  private buildRotors(propMat: THREE.MeshStandardMaterial): void {
    const bladeGeometry = new THREE.BoxGeometry(0.15, 0.0025, 0.028);
    const motorGeometry = new THREE.CylinderGeometry(0.026, 0.03, 0.042, 12);
    const shaftGeometry = new THREE.CylinderGeometry(0.006, 0.006, 0.018, 8);
    const directions = [-1, 1, 1, -1];

    let index = 0;
    for (const x of [-0.255, 0.255]) {
      for (const z of [-0.255, 0.255]) {
        const motor = new THREE.Mesh(motorGeometry, this.carbon);
        motor.position.set(x, 0.046, z);
        this.model.add(motor);

        const shaft = new THREE.Mesh(shaftGeometry, this.accentMaterial);
        shaft.position.set(x, 0.072, z);
        this.model.add(shaft);

        const blades = new THREE.Group();
        const bladeA = new THREE.Mesh(bladeGeometry, propMat);
        bladeA.position.x = 0.076;
        bladeA.rotation.x = 0.1;
        const bladeB = new THREE.Mesh(bladeGeometry, propMat);
        bladeB.position.x = -0.076;
        bladeB.rotation.x = -0.1;
        blades.add(bladeA, bladeB);
        blades.position.set(x, 0.08, z);
        this.model.add(blades);

        this.rotors.push({ blades, direction: directions[index] ?? 1 });
        index += 1;
      }
    }
  }

  private buildLights(): void {
    const green = new THREE.MeshBasicMaterial({ color: 0x77ffb2, toneMapped: false });
    const red = new THREE.MeshBasicMaterial({ color: 0xff543c, toneMapped: false });
    const warm = new THREE.MeshBasicMaterial({ color: 0xffce8c, toneMapped: false });

    const ledGeometry = new THREE.SphereGeometry(0.012, 8, 6);

    const frontLeft = new THREE.Mesh(ledGeometry, green);
    frontLeft.position.set(-0.145, 0.022, -0.17);
    this.model.add(frontLeft);

    const frontRight = new THREE.Mesh(ledGeometry, green);
    frontRight.position.set(0.145, 0.022, -0.17);
    this.model.add(frontRight);

    const rear = new THREE.Mesh(ledGeometry, red);
    rear.name = 'nav-led-red';
    rear.position.set(0, 0.04, 0.205);
    this.model.add(rear);

    const headlight = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), warm);
    headlight.position.set(0, -0.03, -0.283);
    this.model.add(headlight);
  }
}

function createSoftShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D context unavailable');

  const gradient = context.createRadialGradient(64, 64, 2, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.88)');
  gradient.addColorStop(0.38, 'rgba(0, 0, 0, 0.56)');
  gradient.addColorStop(0.72, 'rgba(0, 0, 0, 0.18)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}
