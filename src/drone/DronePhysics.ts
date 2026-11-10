import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import { clamp, dampFactor } from '../engine/math';
import type { FlightCommand } from './InputController';

export type FlightMode = 'angle' | 'acro';
export type FlightState = 'flying' | 'crashed';

export interface DroneTelemetry {
  altitudeMeters: number;
  /** Full 3D speed in metres per second. */
  speedMetersPerSecond: number;
  /** Horizontal speed, used by the radar and wind noise. */
  groundSpeed: number;
  /** Positive values climb. */
  verticalSpeed: number;
  headingRadians: number;
  /** World-space position, used by the landing map. */
  worldX: number;
  worldZ: number;
  /** True while the pilot has pinned the current altitude with H. */
  altitudeLocked: boolean;
  /** The pinned altitude in metres; only meaningful while locked. */
  altitudeTarget: number;
  flightMode: FlightMode;
  flightState: FlightState;
  throttle: number;
  batteryPercent: number;
  distanceToHome: number;
  /** Metres per second squared measured from the previous physics step. */
  acceleration: THREE.Vector3;
  gForce: number;
}

/** The blur/HUD scale is deliberately below the aerodynamic terminal velocity. */
export const MAX_HORIZONTAL_SPEED = 46;
export const MAX_ALTITUDE = 120;
export const HOME_PAD_RADIUS = 2.15;

/** Keyboard throttle is a demand stick: it springs back to zero on release. */
const MAX_THRUST_G = 5.4;
export const HOVER_THROTTLE = 1 / MAX_THRUST_G;

const MASS_KG = 0.92;
const STARTING_BATTERY = 100;
const THROTTLE_RATE = 0.9;
const THROTTLE_RELEASE_RATE = 3.4;
const THROTTLE_ASSIST_RESPONSE = 3.2;
/** Shift holds a powered descent rather than cutting the motors. */
const CONTROLLED_DESCENT_RATE = 2.1;
const DESCENT_TRIM_RESPONSE = 5.5;
const ACRO_MAX_RATE = 11.2;
const ANGLE_MAX_TILT = 0.8;
const ANGLE_RESPONSE = 9.2;
const YAW_ANGLE_RATE = 2.65;
const ANGULAR_RESPONSE = 15;
const DRAG_COEFFICIENT = 0.016;
const MAX_SPEED = 58;
const MAX_FALL_SPEED = 34;
const GRAVITY = 9.81;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Six-degree-of-freedom quadrotor around a Rapier rigid body.
 *
 * Rapier owns gravity and collisions. The controller adds thrust along the
 * airframe's local up, quadratic aerodynamic drag and rate-based attitude
 * control. Angle mode self-levels; acro mode is a true rate controller, so
 * cutting the throttle and pitching over produces an honest freefall dive.
 */
export class DronePhysics {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly startPosition: THREE.Vector3;
  readonly startYaw: number;

  private readonly mass = MASS_KG;
  private readonly rapier: PhysicsWorld['rapier'];
  private readonly quaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly previousVelocity = new THREE.Vector3();
  private readonly linearAcceleration = new THREE.Vector3();
  private readonly angularVelocity = new THREE.Vector3();
  private readonly targetAngularVelocity = new THREE.Vector3();
  private readonly bodyRates = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly targetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly targetQuaternion = new THREE.Quaternion();
  private readonly errorQuaternion = new THREE.Quaternion();
  private readonly inverseQuaternion = new THREE.Quaternion();
  private readonly thrustDirection = new THREE.Vector3();
  private readonly drag = new THREE.Vector3();

  private mode: FlightMode = 'angle';
  private state: FlightState = 'flying';
  private throttle = 0;
  private altitudeLocked = false;
  private lockedAltitude = 0;
  private batteryPercent = STARTING_BATTERY;
  private homeDistance = 0;

  constructor(
    physics: PhysicsWorld,
    spawnPosition: THREE.Vector3,
    initialYaw = 0,
  ) {
    this.rapier = physics.rapier;
    this.startPosition = spawnPosition.clone();
    this.startYaw = initialYaw;

    const bodyDescription = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z)
      .setLinearDamping(0.015)
      .setAngularDamping(0.9)
      .setCanSleep(false)
      .setCcdEnabled(true);

    this.body = physics.raw.createRigidBody(bodyDescription);

    const colliderDescription = this.rapier.ColliderDesc.cuboid(0.34, 0.1, 0.34)
      .setMass(this.mass)
      .setFriction(0.42)
      .setRestitution(0.05)
      .setActiveEvents(this.rapier.ActiveEvents.COLLISION_EVENTS);

    this.collider = physics.raw.createCollider(colliderDescription, this.body);
    this.body.setRotation(
      { x: 0, y: Math.sin(initialYaw / 2), z: 0, w: Math.cos(initialYaw / 2) },
      true,
    );
  }

  get position(): THREE.Vector3 {
    const translation = this.body.translation();
    return new THREE.Vector3(translation.x, translation.y, translation.z);
  }

  get flightMode(): FlightMode {
    return this.mode;
  }

  get flightState(): FlightState {
    return this.state;
  }

  get isCrashed(): boolean {
    return this.state === 'crashed';
  }

  get altitudeLock(): boolean {
    return this.altitudeLocked;
  }

  get altitudeTarget(): number {
    return this.altitudeLocked ? this.lockedAltitude : this.body.translation().y;
  }

  get throttleLevel(): number {
    return this.throttle;
  }

  get horizontalSpeed(): number {
    const velocity = this.body.linvel();
    return Math.hypot(velocity.x, velocity.z);
  }

  /** Full speed, including a vertical dive. */
  get speed(): number {
    const velocity = this.body.linvel();
    return Math.hypot(velocity.x, velocity.y, velocity.z);
  }

  get groundSpeed(): number {
    return this.horizontalSpeed;
  }

  get forwardSpeed(): number {
    const velocity = this.body.linvel();
    this.forward.set(0, 0, -1).applyQuaternion(this.readQuaternion());
    return velocity.x * this.forward.x + velocity.y * this.forward.y + velocity.z * this.forward.z;
  }

  get sideSpeed(): number {
    const velocity = this.body.linvel();
    this.right.set(1, 0, 0).applyQuaternion(this.readQuaternion());
    return velocity.x * this.right.x + velocity.y * this.right.y + velocity.z * this.right.z;
  }

  get headingRadians(): number {
    this.euler.setFromQuaternion(this.readQuaternion(), 'YXZ');
    return this.euler.y;
  }

  get radarPosition(): { x: number; z: number } {
    const translation = this.body.translation();
    return { x: translation.x, z: translation.z };
  }

  get speedRatio(): number {
    return clamp(this.speed / MAX_HORIZONTAL_SPEED, 0, 1.35);
  }

  /** How close the airframe is to level: 1 upright, 0 on its side, -1 inverted. */
  get uprightness(): number {
    this.readQuaternion();
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    return this.up.y;
  }

  get verticalSpeed(): number {
    return this.body.linvel().y;
  }

  get altitudeRatio(): number {
    const translation = this.body.translation();
    return clamp(translation.y / MAX_ALTITUDE, 0, 1);
  }

  fixedUpdate(deltaSeconds: number, command: FlightCommand): void {
    const velocity = this.body.linvel();
    this.velocity.set(velocity.x, velocity.y, velocity.z);

    // Measured acceleration includes collisions and gravity, so the post
    // effect can react to a hard stop just as strongly as a throttle punch.
    if (deltaSeconds > 0) {
      this.linearAcceleration.set(
        (this.velocity.x - this.previousVelocity.x) / deltaSeconds,
        (this.velocity.y - this.previousVelocity.y) / deltaSeconds,
        (this.velocity.z - this.previousVelocity.z) / deltaSeconds,
      );
    }
    this.previousVelocity.copy(this.velocity);

    const translation = this.body.translation();
    this.homeDistance = Math.hypot(
      translation.x - this.startPosition.x,
      translation.z - this.startPosition.z,
    );

    this.readQuaternion();
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);

    if (this.state === 'crashed') {
      this.applyAerodynamicDrag(deltaSeconds);
      return;
    }

    this.updateThrottle(deltaSeconds, command);
    this.applyThrust(deltaSeconds);
    this.applyAerodynamicDrag(deltaSeconds);
    this.limitVelocity();
    this.updateAttitude(deltaSeconds, command);

    const drain = 0.012 + this.throttle * 0.085;
    this.batteryPercent = Math.max(0, this.batteryPercent - drain * deltaSeconds);
  }

  toggleMode(): FlightMode {
    if (this.state === 'crashed') return this.mode;
    this.mode = this.mode === 'angle' ? 'acro' : 'angle';
    // Altitude hold is an angle-mode convenience. Entering acro always hands
    // vertical control back to the pilot.
    if (this.mode === 'acro') this.altitudeLocked = false;
    return this.mode;
  }

  /**
   * Pins the current altitude. A second call (or a Space keypress) releases it.
   * Returns true while the lock is engaged.
   */
  toggleAltitudeLock(): boolean {
    if (this.state === 'crashed') return false;
    if (this.altitudeLocked) {
      this.altitudeLocked = false;
      return false;
    }
    const translation = this.body.translation();
    this.lockedAltitude = clamp(translation.y, 0.2, MAX_ALTITUDE - 4);
    this.altitudeLocked = true;
    return true;
  }

  /** Releases the altitude lock without changing the current throttle. */
  unlockAltitude(): boolean {
    const wasLocked = this.altitudeLocked;
    this.altitudeLocked = false;
    return wasLocked;
  }

  /** No quadcopter gets to keep flying after an abrupt stop. */
  crash(): void {
    if (this.state === 'crashed') return;
    this.state = 'crashed';
    this.throttle = 0;
    this.altitudeLocked = false;
    this.body.setAngvel(
      {
        x: (Math.random() - 0.5) * 9,
        y: (Math.random() - 0.5) * 7,
        z: (Math.random() - 0.5) * 9,
      },
      true,
    );
  }

  /**
   * A gentle touchdown settles the airframe instead of making it skitter
   * across the roof. The player can spin the motors back up immediately.
   */
  settleOnLanding(): void {
    this.throttle = 0;
    this.altitudeLocked = false;
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.previousVelocity.set(0, 0, 0);
    this.linearAcceleration.set(0, 0, 0);
  }

  reset(): void {
    this.state = 'flying';
    this.mode = 'angle';
    this.throttle = 0;
    this.altitudeLocked = false;
    this.lockedAltitude = this.startPosition.y;
    this.batteryPercent = STARTING_BATTERY;
    this.homeDistance = 0;
    this.previousVelocity.set(0, 0, 0);
    this.linearAcceleration.set(0, 0, 0);

    this.body.setTranslation(this.startPosition, true);
    this.body.setRotation(
      {
        x: 0,
        y: Math.sin(this.startYaw / 2),
        z: 0,
        w: Math.cos(this.startYaw / 2),
      },
      true,
    );
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  get telemetry(): DroneTelemetry {
    const translation = this.body.translation();
    const velocity = this.body.linvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    const groundSpeed = Math.hypot(velocity.x, velocity.z);
    const gForce = this.linearAcceleration.length() / GRAVITY;

    return {
      altitudeMeters: translation.y,
      speedMetersPerSecond: speed,
      groundSpeed,
      verticalSpeed: velocity.y,
      headingRadians: this.headingRadians,
      worldX: translation.x,
      worldZ: translation.z,
      altitudeLocked: this.altitudeLocked,
      altitudeTarget: this.altitudeLocked ? this.lockedAltitude : translation.y,
      flightMode: this.mode,
      flightState: this.state,
      throttle: this.throttle,
      batteryPercent: this.batteryPercent,
      distanceToHome: this.homeDistance,
      acceleration: this.linearAcceleration.clone(),
      gForce,
    };
  }

  private readQuaternion(): THREE.Quaternion {
    const rotation = this.body.rotation();
    return this.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
  }

  private updateThrottle(deltaSeconds: number, command: FlightCommand): void {
    // H pins the altitude the pilot is currently at. A small velocity-target
    // loop trims the throttle around hover: it asks for a gentle climb or sink
    // proportional to the remaining altitude error, then damps the vertical
    // speed. There is no hidden teleport force, so turbulence, tilt and drag
    // still affect the airframe.
    if (this.altitudeLocked && this.mode === 'angle') {
      const translation = this.body.translation();
      const verticalSpeed = this.body.linvel().y;
      const altitudeError = this.lockedAltitude - translation.y;
      const targetVerticalSpeed = clamp(altitudeError * 0.9, -2.6, 2.6);
      const verticalAlignment = Math.max(0.32, this.up.y);
      const hoverThrottle = clamp(HOVER_THROTTLE / verticalAlignment, 0, 1);
      const targetThrottle = clamp(
        hoverThrottle + (targetVerticalSpeed - verticalSpeed) * 0.06,
        0,
        0.55,
      );
      this.throttle += (targetThrottle - this.throttle) * dampFactor(7, deltaSeconds);
      return;
    }

    // Shift (or Ctrl) is a powered descent, not a throttle cut: the motors
    // trim around a ~2.1 m/s sink rate, which is well below free fall and
    // gentle enough to land on a terrace. Space+Shift is the same command, so
    // the usual "climb + descend" chord reads as a deliberate slow drop.
    if (command.descend && this.mode === 'angle') {
      const verticalAlignment = Math.max(0.32, this.up.y);
      const hoverThrottle = clamp(HOVER_THROTTLE / verticalAlignment, 0, 1);
      const verticalSpeed = this.body.linvel().y;
      const trim = clamp(
        (-CONTROLLED_DESCENT_RATE - verticalSpeed) * 0.075,
        -0.26,
        0.3,
      );
      const targetThrottle = clamp(hoverThrottle + trim, 0, 1);
      this.throttle += (targetThrottle - this.throttle) * dampFactor(
        DESCENT_TRIM_RESPONSE,
        deltaSeconds,
      );
      return;
    }

    this.throttle = clamp(
      this.throttle + command.lift * THROTTLE_RATE * deltaSeconds,
      0,
      1,
    );

    // Keyboard throttle is a demand stick, not a friction-held lever. With a
    // direction held, angle mode trims the throttle toward a stable hover; the
    // pilot does not have to feather Space. Release every key and the motors
    // spool down, exactly as before. H is the explicit "hold this height" tool.
    if (Math.abs(command.lift) < 0.001) {
      if (this.mode === 'angle' && command.active) {
        // Angle mode's altitude hold only trims the throttle. It never adds a
        // hidden force: gravity, thrust and drag remain the only vertical terms.
        const verticalAlignment = Math.max(0.32, this.up.y);
        const hoverThrottle = clamp(HOVER_THROTTLE / verticalAlignment, 0, 1);
        const verticalSpeed = this.body.linvel().y;
        const speedTrim = clamp(-verticalSpeed * 0.026, -0.1, 0.18);
        const targetThrottle = clamp(hoverThrottle + speedTrim, 0, 1);
        this.throttle += (targetThrottle - this.throttle) * dampFactor(
          THROTTLE_ASSIST_RESPONSE,
          deltaSeconds,
        );
      } else {
        this.throttle = Math.max(
          0,
          this.throttle - THROTTLE_RELEASE_RATE * deltaSeconds,
        );
      }
    }
  }

  private applyThrust(deltaSeconds: number): void {
    if (this.throttle <= 0.0001) return;

    const translation = this.body.translation();
    let ceilingFactor = 1;
    if (translation.y > MAX_ALTITUDE - 8) {
      ceilingFactor = 1 - clamp((translation.y - (MAX_ALTITUDE - 8)) / 18, 0, 1);
    }

    const thrust = this.throttle * MAX_THRUST_G * this.mass * GRAVITY * ceilingFactor;
    this.thrustDirection.copy(this.up).multiplyScalar(thrust * deltaSeconds);
    this.body.applyImpulse(this.thrustDirection, true);
  }

  private applyAerodynamicDrag(deltaSeconds: number): void {
    const velocity = this.body.linvel();
    this.velocity.set(velocity.x, velocity.y, velocity.z);
    const speed = this.velocity.length();
    if (speed < 0.0001) return;

    // F = -k |v| v. At full tilt this settles around 39 m/s; a vertical dive
    // can pass 45 m/s before drag catches it.
    const dragMagnitude = DRAG_COEFFICIENT * speed * speed;
    this.drag
      .copy(this.velocity)
      .multiplyScalar(-dragMagnitude * deltaSeconds / speed);
    this.body.applyImpulse(this.drag, true);
  }

  private limitVelocity(): void {
    const velocity = this.body.linvel();
    let x = velocity.x;
    let y = velocity.y;
    let z = velocity.z;
    let changed = false;
    const horizontal = Math.hypot(x, z);

    if (horizontal > MAX_SPEED) {
      const scale = MAX_SPEED / horizontal;
      x *= scale;
      z *= scale;
      changed = true;
    }
    if (y < -MAX_FALL_SPEED) {
      y = -MAX_FALL_SPEED;
      changed = true;
    }
    if (y > MAX_SPEED) {
      y = MAX_SPEED;
      changed = true;
    }

    if (changed) this.body.setLinvel({ x, y, z }, true);
  }

  private updateAttitude(deltaSeconds: number, command: FlightCommand): void {
    const rotation = this.body.rotation();
    this.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

    if (this.mode === 'angle') {
      this.updateAngleMode(deltaSeconds, command);
    } else {
      this.updateAcroMode(command);
    }

    const current = this.body.angvel();
    this.angularVelocity.set(current.x, current.y, current.z);
    const blend = dampFactor(ANGULAR_RESPONSE, deltaSeconds);
    this.angularVelocity.lerp(this.targetAngularVelocity, blend);
    this.body.setAngvel(this.angularVelocity, true);
  }

  private updateAngleMode(deltaSeconds: number, command: FlightCommand): void {
    this.euler.setFromQuaternion(this.quaternion, 'YXZ');
    const heading = this.euler.y;

    let tiltForward = -command.forward;
    let tiltRight = -command.strafe;
    const tiltLength = Math.hypot(tiltForward, tiltRight);
    if (tiltLength > 1) {
      tiltForward /= tiltLength;
      tiltRight /= tiltLength;
    }

    this.targetEuler.set(
      tiltForward * ANGLE_MAX_TILT,
      heading,
      tiltRight * ANGLE_MAX_TILT,
      'YXZ',
    );
    this.targetQuaternion.setFromEuler(this.targetEuler);

    this.inverseQuaternion.copy(this.quaternion).invert();
    this.errorQuaternion.copy(this.targetQuaternion).multiply(this.inverseQuaternion);
    if (this.errorQuaternion.w < 0) {
      this.errorQuaternion.set(
        -this.errorQuaternion.x,
        -this.errorQuaternion.y,
        -this.errorQuaternion.z,
        -this.errorQuaternion.w,
      );
    }

    const w = clamp(this.errorQuaternion.w, -1, 1);
    const angle = 2 * Math.acos(w);
    const sinHalf = Math.sqrt(Math.max(0, 1 - w * w));
    if (sinHalf > 1e-5) {
      this.axis.set(
        this.errorQuaternion.x / sinHalf,
        this.errorQuaternion.y / sinHalf,
        this.errorQuaternion.z / sinHalf,
      );
    } else {
      this.axis.set(0, 0, 0);
    }

    const correctionRate = Math.min(angle * ANGLE_RESPONSE, ACRO_MAX_RATE * 0.92);
    this.targetAngularVelocity.copy(this.axis).multiplyScalar(correctionRate);
    this.targetAngularVelocity.addScaledVector(WORLD_UP, command.yaw * YAW_ANGLE_RATE);
    if (this.targetAngularVelocity.length() > ACRO_MAX_RATE) {
      this.targetAngularVelocity.setLength(ACRO_MAX_RATE);
    }

    void deltaSeconds;
  }

  private updateAcroMode(command: FlightCommand): void {
    // Body axes: X pitch, Y yaw, Z roll. Positive pitch rate raises the nose,
    // so forward stick is negative; positive roll rate banks left, so right
    // stick is negative.
    this.bodyRates.set(
      -command.forward * ACRO_MAX_RATE,
      command.yaw * ACRO_MAX_RATE * 0.62,
      -command.strafe * ACRO_MAX_RATE,
    );
    this.targetAngularVelocity
      .copy(this.bodyRates)
      .applyQuaternion(this.quaternion);
  }
}
