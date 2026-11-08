import * as THREE from 'three';
import { clamp, dampFactor } from '../engine/math';
import type { FlightCommand } from './InputController';
import type { DronePhysics } from './DronePhysics';

/**
 * Nose-mounted FPV camera. Orientation is smoothed slightly behind yaw so
 * quick turns feel like a camera on a gimbal, not a hard-cut first-person rig.
 * Translation stays rigid to avoid wall clipping during collisions.
 */
export class FpvCamera {
  private readonly targetQuaternion = new THREE.Quaternion();
  private readonly targetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly cameraOffset = new THREE.Vector3(0, 0.105, -0.27);
  private readonly rotatedOffset = new THREE.Vector3();
  private readonly prefs = window.matchMedia('(prefers-reduced-motion: reduce)');
  private initialized = false;
  private shake = 0;
  private vibrationTime = 0;
  private baseFov = 74;
  private currentFov = 74;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly drone: DronePhysics,
  ) {
    this.baseFov = camera.fov;
    this.currentFov = camera.fov;
    this.synchronize(false);
  }

  update(deltaSeconds: number, command: FlightCommand): void {
    const bodyPosition = this.drone.body.translation();
    const forwardRatio = clamp(this.drone.forwardSpeed / 8.2, -1, 1);
    const sideRatio = clamp(this.drone.sideSpeed / 8.2, -1, 1);
    const yawBank = command.yaw * 0.026;

    this.shake = Math.max(0, this.shake - deltaSeconds * 1.9);
    const trauma = this.shake * this.shake;

    this.vibrationTime += deltaSeconds * (58 + Math.abs(forwardRatio) * 18);
    const vibrationScale = this.prefs.matches ? 0.25 : 1;
    const vibrationX = Math.sin(this.vibrationTime * 1.7) * 0.0016 * vibrationScale;
    const vibrationY = Math.cos(this.vibrationTime * 2.3) * 0.0013 * vibrationScale;

    const shakeX = Math.sin(this.vibrationTime * 14.1 + 1.7) * trauma * 0.11;
    const shakeY = Math.cos(this.vibrationTime * 11.7) * trauma * 0.08;
    const shakeRoll = Math.sin(this.vibrationTime * 17.3) * trauma * 0.045;

    const swayX = Math.sin(this.vibrationTime * 2.1) * 0.0005;
    const swayY = Math.cos(this.vibrationTime * 1.6) * 0.0004;

    this.rotatedOffset
      .copy(this.cameraOffset)
      .applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.drone.yaw);

    this.camera.position.set(
      bodyPosition.x + this.rotatedOffset.x + vibrationX + swayX + shakeX,
      bodyPosition.y + this.rotatedOffset.y + vibrationY + swayY + shakeY,
      bodyPosition.z + this.rotatedOffset.z,
    );

    const targetPitch = 0.018 - forwardRatio * 0.09 + trauma * 0.02;
    const targetRoll = -sideRatio * 0.075 - yawBank + shakeRoll;
    this.targetEuler.set(targetPitch, this.drone.yaw, targetRoll, 'YXZ');
    this.targetQuaternion.setFromEuler(this.targetEuler);

    if (!this.initialized) {
      this.camera.quaternion.copy(this.targetQuaternion);
      this.initialized = true;
    } else {
      this.camera.quaternion.slerp(this.targetQuaternion, dampFactor(16, deltaSeconds));
    }

    // A whisker of FOV expansion communicates speed without a claustrophobic
    // zoom effect. The reset threshold avoids needless projection updates.
    const speedFov = this.baseFov + clamp(this.drone.speed / 8.2, 0, 1) * 2.2;
    const nextFov = this.currentFov + (speedFov - this.currentFov) * dampFactor(3, deltaSeconds);
    if (Math.abs(nextFov - this.currentFov) > 0.005) {
      this.currentFov = nextFov;
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
  }

  addCollisionShake(strength = 1): void {
    this.shake = Math.min(1, this.shake + strength);
  }

  synchronize(snap = true): void {
    if (snap) this.initialized = false;
    this.update(1 / 60, { forward: 0, strafe: 0, lift: 0, yaw: 0, active: false });
  }
}
