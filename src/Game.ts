import { Engine } from './engine/Engine';
import { Loop } from './engine/Loop';
import { PhysicsWorld } from './engine/PhysicsWorld';
import { Stats, type FrameStats } from './engine/Stats';
import { clamp, damp } from './engine/math';
import * as THREE from 'three';
import { DronePhysics } from './drone/DronePhysics';
import { DroneView } from './drone/DroneView';
import { FpvCamera } from './drone/FPVCamera';
import { FpvRig } from './drone/FpvRig';
import { InputController } from './drone/InputController';
import { DroneAudio } from './audio/DroneAudio';
import { Firecrackers } from './fx/Firecrackers';
import { HUD } from './ui/HUD';
import { loadCityPrefabs } from './world/cityKit';
import { loadPhotoTextures } from './world/textures';
import { World } from './world/World';

type FlightStatus = 'live' | 'landed' | 'crashed';

export interface GameDebugState {
  ready: boolean;
  fps: number;
  drawCalls: number;
  triangles: number;
  points: number;
  position: { x: number; y: number; z: number };
  speed: number;
  groundSpeed: number;
  altitudeLocked: boolean;
  altitudeTarget: number;
  flightMode: 'angle' | 'acro';
  flightState: 'flying' | 'crashed';
  throttle: number;
  crashCount: number;
  onPad: boolean;
  radar: boolean;
  webgl: string;
  muted: boolean;
  audio: string;
  cityBuildings: number;
  activeColliders: number;
  cityPeriod: number;
  infinite: boolean;
  postProcessing: boolean;
  frontProps: boolean;
  firecrackers: boolean;
  firecrackerParticles: number;
  preflight: boolean;
}

const QUALITY_LABEL = 'Medium';
const RESPAWN_SECONDS = 3;
/** Above this pre-impact speed any touchdown is fatal, even on a rooftop. */
const HARD_IMPACT_SPEED = 6.4;
/** A survivable touchdown also has to be level and mostly vertical. */
const LANDING_VERTICAL_LIMIT = 4.6;
const LANDING_HORIZONTAL_LIMIT = 5.2;
const LANDING_UP_COS = 0.55;
/** Anything lower than this is street level, not a terrace roof. */
const ROOF_MIN_HEIGHT = 0.75;
/** The pad is the only place a controlled touchdown is allowed. */
const PAD_LANDING_MARGIN = 0.22;
/** Clearance above the resting surface before a landed drone is airborne. */
const TAKEOFF_CLEARANCE = 0.34;

/**
 * Coordinates the simulation. Presentation is read-only from physics, which
 * keeps render rate independent from the fixed 60 Hz drone simulation.
 */
export class Game {
  private readonly viewport: HTMLElement;
  private readonly uiRoot: HTMLElement;
  private readonly stats = new Stats();
  private engine!: Engine;
  private physics!: PhysicsWorld;
  private world!: World;
  private drone!: DronePhysics;
  private droneView!: DroneView;
  private fpvCamera!: FpvCamera;
  private fpvRig!: FpvRig;
  private audio!: DroneAudio;
  private firecrackers!: Firecrackers;
  private input!: InputController;
  private hud!: HUD;
  private loop!: Loop;
  private ready = false;
  private debugRefreshTimer = 0;
  private crashTimer = 0;
  private crashCount = 0;
  private crashAmount = 0;
  private accelerationRatio = 0;
  private impactFlash = 0;
  private onPad = false;
  private hasTakenOff = false;
  private landedY = 0;
  private flightStatus: FlightStatus = 'live';
  private flightTimeSeconds = 0;
  private readonly onPointerDown = (): void => {
    void this.audio.start();
  };

  constructor(viewport: HTMLElement, uiRoot: HTMLElement) {
    this.viewport = viewport;
    this.uiRoot = uiRoot;
  }

  async init(): Promise<void> {
    if (this.ready) return;

    this.engine = new Engine(this.viewport);
    this.hud = new HUD(this.uiRoot);
    this.physics = await PhysicsWorld.create();

    const maxAnisotropy = this.engine.renderer.capabilities.getMaxAnisotropy();
    // Photo scans replace the procedural plaster/roof when present. The loader
    // falls back to the procedural set if the assets are unavailable. The CC0
    // Kenney prefabs are best-effort too: without them the procedural mohalla
    // still boots and reads correctly.
    const [photos, prefabs] = await Promise.all([
      loadPhotoTextures(maxAnisotropy),
      loadCityPrefabs(maxAnisotropy),
    ]);
    this.world = new World(
      this.engine.scene,
      this.physics,
      maxAnisotropy,
      this.engine.pixelRatio,
      photos,
      prefabs,
    );
    this.world.enableImageBasedLighting(this.engine.renderer);

    this.hud.setMapWorld({
      buildings: this.world.radarBuildings,
      homeX: this.world.homePad.x,
      homeZ: this.world.homePad.z,
      period: this.world.cityPeriod,
    });

    this.drone = new DronePhysics(
      this.physics,
      this.world.spawnPoint,
      this.world.spawnHeading,
    );
    this.droneView = new DroneView(this.engine.scene, this.drone, this.physics);
    this.fpvCamera = new FpvCamera(this.engine.camera, this.drone);
    this.fpvRig = new FpvRig(this.engine.camera);
    this.audio = new DroneAudio();
    this.firecrackers = new Firecrackers(this.engine.scene);

    this.input = new InputController(window);
    this.bindInput();
    this.viewport.addEventListener('pointerdown', this.onPointerDown, { passive: true });

    this.loop = new Loop(
      (stepSeconds) => this.fixedUpdate(stepSeconds),
      (frameSeconds, elapsedSeconds) => this.renderUpdate(frameSeconds, elapsedSeconds),
    );

    this.fpvCamera.update(1 / 60, this.input.command);
    this.world.update(0, 0, this.engine.camera.position);
    this.droneView.update(0, 0);

    await this.engine.renderer.compileAsync(this.engine.scene, this.engine.camera);
    this.engine.render(0);
    this.ready = true;

    this.loop.start();
    this.hud.ready();
    this.hud.setPreflight(true, { onPad: true, landed: false });
    this.hideLoadingScreen();
  }

  start(): void {
    if (!this.ready) throw new Error('Game.init() must resolve before start()');
    this.loop.start();
  }

  getDebugState(): GameDebugState {
    const position = this.drone?.body.translation() ?? { x: 0, y: 0, z: 0 };
    const drawCalls = this.stats.current.drawCalls;
    const audioState = this.audio
      ? this.audio.muted
        ? 'muted'
        : this.audio.running
          ? 'on'
          : 'idle'
      : 'idle';
    return {
      ready: this.ready,
      fps: this.stats.current.fps,
      drawCalls,
      triangles: this.stats.current.triangles,
      points: this.stats.current.points,
      position: { x: position.x, y: position.y, z: position.z },
      speed: this.drone?.speed ?? 0,
      groundSpeed: this.drone?.groundSpeed ?? 0,
      altitudeLocked: this.drone?.altitudeLock ?? false,
      altitudeTarget: this.drone?.altitudeTarget ?? 0,
      flightMode: this.drone?.flightMode ?? 'angle',
      flightState: this.drone?.flightState ?? 'flying',
      throttle: this.drone?.throttleLevel ?? 0,
      crashCount: this.crashCount,
      onPad: this.onPad,
      radar: Boolean(this.world),
      webgl: this.engine?.renderer.getContext() instanceof WebGL2RenderingContext
        ? 'webgl2'
        : 'unknown',
      muted: this.audio?.muted ?? false,
      audio: audioState,
      cityBuildings: this.world?.cityBuildings ?? 0,
      activeColliders: this.world?.activeColliders ?? 0,
      cityPeriod: this.world?.cityPeriod ?? 0,
      infinite: true,
      postProcessing: Boolean(this.engine),
      frontProps: Boolean(this.fpvRig),
      firecrackers: Boolean(this.firecrackers),
      firecrackerParticles: this.firecrackers?.activeParticles ?? 0,
      preflight: this.hud?.preflightVisible ?? false,
    };
  }

  get frameStats(): FrameStats {
    return this.stats.current;
  }

  dispose(): void {
    this.loop?.stop();
    this.viewport.removeEventListener('pointerdown', this.onPointerDown);
    this.input?.dispose();
    this.hud?.dispose();
    this.audio?.dispose();
    this.firecrackers?.dispose();
    this.fpvRig?.dispose();
    this.world?.dispose();
    this.physics?.dispose();
    this.engine?.dispose();
    this.ready = false;
  }

  private fixedUpdate(deltaSeconds: number): void {
    if (!this.ready) return;

    const command = this.input.command;

    if (this.drone.isCrashed) {
      // The wreck keeps tumbling under gravity and drag until it is recovered.
      this.drone.fixedUpdate(deltaSeconds, command);
      this.physics.step(deltaSeconds);
      this.physics.drainCollisionEvents(() => undefined);
      this.crashTimer += deltaSeconds;
      if (this.crashTimer >= RESPAWN_SECONDS) this.respawn(true);
      return;
    }

    const preStepVelocity = this.drone.body.linvel();
    const impactSpeed = Math.hypot(
      preStepVelocity.x,
      preStepVelocity.y,
      preStepVelocity.z,
    );

    this.flightTimeSeconds += deltaSeconds;
    this.drone.fixedUpdate(deltaSeconds, command);
    this.physics.step(deltaSeconds);

    const droneHandle = this.drone.collider.handle;
    let touched = false;
    let contactNormalY = 0;
    let contactY = 0;
    this.physics.drainCollisionEvents((handleA, handleB, started) => {
      if (!started) return;
      if (handleA !== droneHandle && handleB !== droneHandle) return;
      touched = true;

      const otherHandle = handleA === droneHandle ? handleB : handleA;
      const other = this.physics.world.getCollider(otherHandle);
      if (!other) return;

      // A rooftop is a contact whose surface normal points up. A wall has a
      // horizontal normal and a street contact sits far below the roof line,
      // so both still end the run even at low speed.
      this.physics.world.contactPair(this.drone.collider, other, (manifold) => {
        const normal = manifold.normal();
        if (Math.abs(normal.y) > Math.abs(contactNormalY)) {
          contactNormalY = normal.y;
        }
        const contactCount = manifold.numSolverContacts();
        for (let index = 0; index < contactCount; index += 1) {
          const point = manifold.solverContactPoint(index);
          if (point && point.y > contactY) contactY = point.y;
        }
      });
    });

    if (touched) {
      this.handleTouchdown(impactSpeed, contactNormalY, contactY);
      if (this.drone.isCrashed) return;
    }

    const translation = this.drone.body.translation();
    if (!this.hasTakenOff && translation.y > this.world.homePad.y + 0.4) {
      this.hasTakenOff = true;
      this.hud.setPreflight(false);
    }

    if (this.flightStatus === 'landed' && translation.y > this.landedY + TAKEOFF_CLEARANCE) {
      this.onPad = false;
      this.setFlightStatus('live');
      this.hud.setPreflight(false);
    }

    if (translation.y < -8) {
      this.triggerCrash(0);
    }
  }

  /**
   * Any contact is a landing attempt. A gentle, level touchdown on any terrace
   * roof is survivable; walls, street level and hard or inverted impacts end
   * the run. The starting pad is only special for its HUD message.
   */
  private handleTouchdown(impactSpeed: number, normalY: number, contactY: number): void {
    const pad = this.world.homePad;
    const translation = this.drone.body.translation();
    const distanceToPad = Math.hypot(translation.x - pad.x, translation.z - pad.z);
    const overPad = distanceToPad <= pad.radius + PAD_LANDING_MARGIN;
    const velocity = this.drone.body.linvel();
    const verticalSpeed = velocity.y;
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    const upright = this.drone.uprightness;
    const verticalSurface = Math.abs(normalY) > 0.5;

    let surfaceY = contactY;
    if (!verticalSurface || surfaceY <= ROOF_MIN_HEIGHT) {
      // Contact points are not exposed after events on every backend; a short
      // downward ray is a cheap, robust confirmation of the surface below.
      const hit = this.physics.castDown(
        new THREE.Vector3(translation.x, translation.y + 0.04, translation.z),
        0.75,
        this.drone.collider,
      );
      if (hit) surfaceY = Math.max(surfaceY, hit.point.y);
    }

    const onRoof =
      verticalSurface &&
      surfaceY > ROOF_MIN_HEIGHT &&
      surfaceY < translation.y + 0.1;

    if (!onRoof) {
      this.triggerCrash(impactSpeed);
      return;
    }

    if (upright < LANDING_UP_COS) {
      this.triggerCrash(impactSpeed);
      return;
    }

    if (
      impactSpeed > HARD_IMPACT_SPEED ||
      verticalSpeed < -LANDING_VERTICAL_LIMIT ||
      horizontalSpeed > LANDING_HORIZONTAL_LIMIT
    ) {
      this.triggerCrash(impactSpeed);
      return;
    }

    this.drone.settleOnLanding();
    this.landedY = translation.y;
    this.impactFlash = Math.max(this.impactFlash, clamp(impactSpeed / 9, 0.1, 0.55));
    this.fpvCamera.addCollisionShake(clamp((impactSpeed - 0.5) / 12, 0.02, 0.3));
    this.onPad = overPad;

    if (this.hasTakenOff) {
      this.setFlightStatus('landed');
      this.hud.toast(overPad ? 'Touchdown · home pad' : 'Touchdown · rooftop');
      this.hud.setPreflight(true, { onPad: overPad, landed: true });
    }
  }

  private triggerCrash(impactSpeed: number): void {
    if (this.drone.isCrashed) return;

    this.drone.crash();
    this.crashCount += 1;
    this.crashTimer = 0;
    this.onPad = false;
    this.impactFlash = Math.max(this.impactFlash, clamp(impactSpeed / 7, 0.4, 1));
    this.fpvCamera.addCollisionShake(clamp(impactSpeed / 7, 0.35, 1));
    this.audio.playCrash();
    this.setFlightStatus('crashed');
    this.hud.setPreflight(false);
    this.hud.setCrashState({ active: true });
  }

  private renderUpdate(frameSeconds: number, elapsedSeconds: number): void {
    if (!this.ready) return;

    const command = this.input.command;
    this.droneView.update(frameSeconds, elapsedSeconds);
    this.fpvCamera.update(frameSeconds, command);

    const cameraPosition = this.engine.camera.position;
    this.world.update(frameSeconds, elapsedSeconds, cameraPosition);
    this.firecrackers.update(
      frameSeconds,
      this.engine.camera,
      this.drone.position,
      this.engine.renderer.domElement.height,
      (distance, pan, kind) => {
        this.audio.playFirecracker(distance, pan, kind);
      },
    );

    const telemetry = this.drone.telemetry;
    const speedRatio = this.drone.speedRatio;
    const acceleration = clamp(telemetry.acceleration.length() / 26, 0, 1);
    this.accelerationRatio = damp(this.accelerationRatio, acceleration, 7, frameSeconds);
    this.impactFlash = damp(this.impactFlash, 0, 5.5, frameSeconds);
    this.crashAmount = damp(
      this.crashAmount,
      this.drone.isCrashed ? 1 : 0,
      this.drone.isCrashed ? 7 : 3,
      frameSeconds,
    );

    this.fpvRig.update(
      frameSeconds,
      elapsedSeconds,
      telemetry.throttle,
      clamp(speedRatio, 0, 1),
      this.drone.isCrashed,
    );
    this.audio.update(
      frameSeconds,
      clamp(speedRatio, 0, 1.25),
      this.drone.isCrashed ? 0 : command.lift,
      command.active && !this.drone.isCrashed,
      this.drone.isCrashed,
    );

    const distanceToHome = telemetry.distanceToHome;
    const altitude = telemetry.altitudeMeters;
    const linkDbm = this.drone.isCrashed
      ? -100
      : clamp(-42 - distanceToHome * 0.24 - Math.max(0, altitude - 25) * 0.09, -100, -40);
    const linkQuality = this.drone.isCrashed
      ? 0
      : clamp(100 - distanceToHome * 0.2 - Math.max(0, altitude - 50) * 0.35, 0, 100);
    const currentAmps = clamp(
      5 + telemetry.throttle * 92 + telemetry.speedMetersPerSecond * 0.5
        + Math.abs(telemetry.acceleration.y) * 1.1,
      0,
      190,
    );

    this.hud.setTelemetry({
      altitudeMeters: telemetry.altitudeMeters,
      speedMetersPerSecond: telemetry.speedMetersPerSecond,
      verticalSpeed: telemetry.verticalSpeed,
      headingRadians: telemetry.headingRadians,
      worldX: telemetry.worldX,
      worldZ: telemetry.worldZ,
      altitudeLocked: telemetry.altitudeLocked,
      altitudeTarget: telemetry.altitudeTarget,
      flightMode: telemetry.flightMode,
      flightState: telemetry.flightState,
      throttle: telemetry.throttle,
      batteryPercent: telemetry.batteryPercent,
      linkDbm,
      linkQuality,
      flightTimeSeconds: this.flightTimeSeconds,
      currentAmps,
    });

    if (this.drone.isCrashed) {
      this.hud.setCrashState({ active: true });
    }

    this.engine.render(frameSeconds, {
      speedRatio,
      accelerationRatio: clamp(this.accelerationRatio + this.impactFlash, 0, 1),
      altitudeRatio: this.drone.altitudeRatio,
      crashAmount: this.crashAmount,
    });
    this.stats.update(frameSeconds, this.engine.renderer);

    this.debugRefreshTimer += frameSeconds;
    if (this.debugRefreshTimer >= 0.25) {
      this.debugRefreshTimer = 0;
      this.refreshDebug();
    }
  }

  private refreshDebug(): void {
    this.hud.setDebug(this.stats.current, QUALITY_LABEL, {
      cityBuildings: this.world.cityBuildings,
      activeColliders: this.world.activeColliders,
      audio: this.audio.muted ? 'muted' : this.audio.running ? 'on' : 'idle',
    });
  }

  private bindInput(): void {
    this.input.onInteraction(() => {
      void this.audio.start();
    });

    this.input.onAction((action) => {
      if (action === 'toggle-altitude-lock') {
        if (!this.hasTakenOff || this.flightStatus === 'landed') {
          this.hud.toast('Take off first · altitude lock is available in flight');
          return;
        }
        if (this.drone.isCrashed) return;
        if (this.drone.flightMode !== 'angle') {
          this.hud.toast('Altitude lock is only available in angle mode');
          return;
        }
        const locked = this.drone.toggleAltitudeLock();
        this.hud.toast(
          locked
            ? `Altitude locked · ${Math.round(this.drone.altitudeTarget)} m`
            : 'Altitude unlocked',
        );
      } else if (action === 'release-altitude-lock') {
        // Space is both the climb key and the second way to release the lock.
        // The keydown action fires before the next fixed step, so the same
        // press also starts climbing normally.
        if (this.drone.unlockAltitude()) {
          this.hud.toast('Altitude unlocked');
        }
      } else if (action === 'toggle-mode') {
        const mode = this.drone.toggleMode();
        this.hud.toast(
          mode === 'acro'
            ? 'Acro mode · full rates, no self-levelling'
            : 'Angle mode · self-levelling',
        );
      } else if (action === 'toggle-debug') {
        this.hud.toggleDebug();
        this.debugRefreshTimer = 1;
        this.refreshDebug();
      } else if (action === 'toggle-mute') {
        const muted = this.audio.toggleMute();
        this.hud.toast(muted ? 'Audio muted' : 'Audio on');
      } else if (action === 'reset') {
        this.respawn(false);
      }
    });
  }

  private respawn(automatic: boolean): void {
    const wasCrashed = this.drone.isCrashed;
    this.drone.reset();
    this.fpvCamera.synchronize(true);
    this.crashTimer = 0;
    this.crashAmount = 0;
    this.accelerationRatio = 0;
    this.impactFlash = 0;
    this.onPad = false;
    this.hasTakenOff = false;
    this.landedY = 0;
    this.flightTimeSeconds = 0;
    this.hud.setCrashState({ active: false });
    this.setFlightStatus('live');
    this.hud.setPreflight(true, { onPad: true, landed: false });
    this.hud.toast(
      automatic
        ? 'Airframe recovered · back on the pad'
        : wasCrashed
          ? 'Retry · back on the pad'
          : 'Returned to the terrace',
    );
  }

  private setFlightStatus(status: FlightStatus): void {
    if (this.flightStatus === status) return;
    this.flightStatus = status;
    this.hud.setFlightStatus(status);
  }

  private hideLoadingScreen(): void {
    const loading = document.getElementById('loading');
    if (!loading) return;
    window.setTimeout(() => {
      loading.classList.add('is-hidden');
      window.setTimeout(() => loading.remove(), 1300);
    }, 260);
  }
}
