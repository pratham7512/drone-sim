import * as THREE from 'three';
import { clamp, dampFactor } from '../engine/math';
import type { FlightCommand } from './InputController';
import { MAX_HORIZONTAL_SPEED, type DronePhysics } from './DronePhysics';

/**
 * Nose-mounted FPV camera.
 *
 * Unlike the old chase-style rig, this camera is rigidly bolted to the
 * airframe: acro rolls and flips are real. A ~2.5 degree uptilt matches a
 * cruising FPV camera, and a little high-frequency vibration is added in
 * camera space so the airframe still feels alive.
 */
export class FpvCamera {
  private readonly bodyQuaternion = new THREE.Quaternion();
  private readonly tiltQuaternion = new THREE.Quaternion();
  private readonly shakeQuaternion = new THREE.Quaternion();
  private readonly targetQuaternion = new THREE.Quaternion();
  private readonly shakeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly cameraOffset = new THREE.Vector3(0, 0.105, -0.27);
  private readonly rotatedOffset = new THREE.Vector3();
  private readonly prefs = window.matchMedia('(prefers-reduced-motion: reduce)');
  private initialized = false;
  private shake = 0;
  private vibrationTime = 0;
  private baseFov = 82;
  private currentFov = 82;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly drone: DronePhysics,
  ) {
    this.baseFov = camera.fov;
    this.currentFov = camera.fov;
    this.tiltQuaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.043);
    this.synchronize(false);
  }

  update(deltaSeconds: number, command: FlightCommand): void {
    const rotation = this.drone.body.rotation();
    this.bodyQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

    const speedRatio = clamp(this.drone.speed / MAX_HORIZONTAL_SPEED, 0, 1.25);
    const yawBank = command.yaw * 0.012;
    const crashed = this.drone.isCrashed;

    this.shake = Math.max(0, this.shake - deltaSeconds * 2.2);
    const trauma = this.shake * this.shake;

    this.vibrationTime += deltaSeconds * (56 + speedRatio * 42);
    const vibrationScale = this.prefs.matches ? 0.22 : 1;
    const vibrationX =
      Math.sin(this.vibrationTime * 1.7) * (0.0011 + speedRatio * 0.002) * vibrationScale;
    const vibrationY =
      Math.cos(this.vibrationTime * 2.3) * (0.0009 + speedRatio * 0.0016) * vibrationScale;

    const shakeX = Math.sin(this.vibrationTime * 14.1 + 1.7) * trauma * 0.16;
    const shakeY = Math.cos(this.vibrationTime * 11.7) * trauma * 0.11;
    const shakeRoll = Math.sin(this.vibrationTime * 17.3) * trauma * 0.07;
    const shakePitch = Math.cos(this.vibrationTime * 9.4) * trauma * 0.05;

    this.rotatedOffset.copy(this.cameraOffset).applyQuaternion(this.bodyQuaternion);

    const translation = this.drone.body.translation();
    this.camera.position.set(
      translation.x + this.rotatedOffset.x + vibrationX + shakeX,
      translation.y + this.rotatedOffset.y + vibrationY + shakeY,
      translation.z + this.rotatedOffset.z,
    );

    this.shakeEuler.set(shakePitch, yawBank, shakeRoll, 'YXZ');
    this.shakeQuaternion.setFromEuler(this.shakeEuler);

    this.targetQuaternion
      .copy(this.bodyQuaternion)
      .multiply(this.tiltQuaternion)
      .multiply(this.shakeQuaternion);

    if (!this.initialized) {
      this.camera.quaternion.copy(this.targetQuaternion);
      this.initialized = true;
    } else {
      this.camera.quaternion.slerp(
        this.targetQuaternion,
        dampFactor(crashed ? 12 : 28, deltaSeconds),
      );
    }

    const speedFov = this.baseFov + Math.min(speedRatio, 1) * 8.5;
    const nextFov = this.currentFov + (speedFov - this.currentFov) * dampFactor(3.8, deltaSeconds);
    if (Math.abs(nextFov - this.currentFov) > 0.005) {
      this.currentFov = nextFov;
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }

    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
  }

  /** Keep the camera's local Euler readable for future gimbal modes. */
  get localAngles(): THREE.Euler {
    return this.euler;
  }

  addCollisionShake(strength = 1): void {
    this.shake = Math.min(1, this.shake + strength);
  }

  synchronize(snap = true): void {
    if (snap) this.initialized = false;
    this.update(1 / 60, {
      forward: 0,
      strafe: 0,
      lift: 0,
      descend: false,
      yaw: 0,
      active: false,
    });
  }
}
