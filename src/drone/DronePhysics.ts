import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import { clamp, yawQuaternion } from '../engine/math';
import type { FlightCommand } from './InputController';

export interface DroneTelemetry {
  altitudeMeters: number;
  speedMetersPerSecond: number;
  /** Positive values climb. */
  verticalSpeed: number;
  headingRadians: number;
  hoverAssist: boolean;
  batteryPercent: number;
}

const MAX_HORIZONTAL_SPEED = 8.2;
const MAX_HORIZONTAL_ACCELERATION = 13.5;
const MAX_CLIMB_SPEED = 2.7;
const MAX_SINK_SPEED = 2.1;
const YAW_RATE = 1.8;
const HOVER_KP = 6.2;
const MASS_KG = 0.92;
const STARTING_BATTERY = 100;

/**
 * Arcade-real quadrotor controller around a real Rapier rigid body.
 *
 * The body stays upright (rotations are locked) and visual banking is applied
 * to the mesh. Horizontal response is velocity-driven, with acceleration
 * presented to the player as airframe tilt. This gives collision correctness
 * without the instability of tuning a full torque-based quad in a browser.
 */
export class DronePhysics {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly startPosition: THREE.Vector3;
  readonly startYaw: number;

  yaw = 0;
  hoverAssist = true;

  private readonly mass = MASS_KG;
  private readonly velocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly targetVelocity = new THREE.Vector3();
  private readonly acceleration = new THREE.Vector3();
  private readonly impulse = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly rapier: PhysicsWorld['rapier'];
  private batteryPercent = STARTING_BATTERY;

  constructor(
    physics: PhysicsWorld,
    spawnPosition: THREE.Vector3,
    initialYaw = 0,
  ) {
    this.rapier = physics.rapier;
    this.startPosition = spawnPosition.clone();
    this.startYaw = initialYaw;
    this.yaw = initialYaw;

    const bodyDescription = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z)
      .setLinearDamping(0.16)
      .setAngularDamping(4)
      .lockRotations()
      .setCanSleep(false)
      .setCcdEnabled(true);

    this.body = physics.raw.createRigidBody(bodyDescription);

    const colliderDescription = this.rapier.ColliderDesc.cuboid(0.36, 0.1, 0.36)
      .setMass(this.mass)
      .setFriction(0.18)
      .setRestitution(0.08)
      .setActiveEvents(this.rapier.ActiveEvents.COLLISION_EVENTS);

    this.collider = physics.raw.createCollider(colliderDescription, this.body);
    this.body.setRotation(yawQuaternion(initialYaw), true);
  }

  fixedUpdate(deltaSeconds: number, command: FlightCommand): void {
    // Yaw is authoritative in the controller; Rapier's rotation lock removes
    // coupling from collisions and keeps the collision hull predictable.
    this.yaw = wrapAngle(this.yaw + command.yaw * YAW_RATE * deltaSeconds);
    this.body.setRotation(yawQuaternion(this.yaw, this.rotation), true);

    const velocity = this.body.linvel();
    this.velocity.set(velocity.x, velocity.y, velocity.z);

    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    this.forward.set(-sinYaw, 0, -cosYaw);
    this.right.set(cosYaw, 0, -sinYaw);

    this.targetVelocity
      .copy(this.forward)
      .multiplyScalar(command.forward)
      .addScaledVector(this.right, command.strafe);

    if (this.targetVelocity.lengthSq() > 1) this.targetVelocity.normalize();
    this.targetVelocity.multiplyScalar(MAX_HORIZONTAL_SPEED);

    this.acceleration.set(
      this.targetVelocity.x - this.velocity.x,
      0,
      this.targetVelocity.z - this.velocity.z,
    );

    const horizontalResponse = command.forward !== 0 || command.strafe !== 0 ? 4.6 : 2.7;
    this.acceleration.multiplyScalar(horizontalResponse);
    const horizontalLength = Math.hypot(this.acceleration.x, this.acceleration.z);
    if (horizontalLength > MAX_HORIZONTAL_ACCELERATION) {
      const scale = MAX_HORIZONTAL_ACCELERATION / horizontalLength;
      this.acceleration.x *= scale;
      this.acceleration.z *= scale;
    }

    if (this.hoverAssist) {
      // Feed-forward gravity cancellation + a critically damped velocity hold.
      const targetVerticalSpeed =
        command.lift > 0 ? MAX_CLIMB_SPEED : command.lift < 0 ? -MAX_SINK_SPEED : 0;
      const verticalError = targetVerticalSpeed - this.velocity.y;
      this.acceleration.y = 9.81 + clamp(verticalError * HOVER_KP, -9, 7.5);
    } else {
      // Manual mode: gravity is real, throttle is raw. Re-enable H to recover.
      this.acceleration.y = command.lift > 0 ? 15.8 : command.lift < 0 ? -4.5 : 0;
    }

    this.impulse
      .copy(this.acceleration)
      .multiplyScalar(this.mass * deltaSeconds);
    this.body.applyImpulse(this.impulse, true);

    // Keep the simulation bounded even if a player dives off the terrace.
    if (this.velocity.y < -12) {
      this.body.setLinvel(
        { x: this.velocity.x, y: -12, z: this.velocity.z },
        true,
      );
    }

    // Battery is cosmetic in milestone one; it becomes part of the HUD warning
    // and flight state machine later.
    const drain = 0.005 + (command.active ? 0.03 : 0.01);
    this.batteryPercent = Math.max(0, this.batteryPercent - drain * deltaSeconds);
  }

  toggleHoverAssist(): boolean {
    this.hoverAssist = !this.hoverAssist;
    return this.hoverAssist;
  }

  reset(): void {
    this.yaw = this.startYaw;
    this.hoverAssist = true;
    this.batteryPercent = STARTING_BATTERY;
    this.body.setTranslation(this.startPosition, true);
    this.body.setRotation(yawQuaternion(this.startYaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  get position(): THREE.Vector3 {
    const translation = this.body.translation();
    return new THREE.Vector3(translation.x, translation.y, translation.z);
  }

  get speed(): number {
    const velocity = this.body.linvel();
    return Math.hypot(velocity.x, velocity.z);
  }

  get forwardSpeed(): number {
    const velocity = this.body.linvel();
    return velocity.x * this.forward.x + velocity.z * this.forward.z;
  }

  get sideSpeed(): number {
    const velocity = this.body.linvel();
    return velocity.x * this.right.x + velocity.z * this.right.z;
  }

  get telemetry(): DroneTelemetry {
    const translation = this.body.translation();
    const velocity = this.body.linvel();
    return {
      altitudeMeters: translation.y,
      speedMetersPerSecond: Math.hypot(velocity.x, velocity.z),
      verticalSpeed: velocity.y,
      headingRadians: this.yaw,
      hoverAssist: this.hoverAssist,
      batteryPercent: this.batteryPercent,
    };
  }
}

function wrapAngle(angle: number): number {
  return ((((angle + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}
