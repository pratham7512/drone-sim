import { Engine } from './engine/Engine';
import { Loop } from './engine/Loop';
import { PhysicsWorld } from './engine/PhysicsWorld';
import { Stats, type FrameStats } from './engine/Stats';
import { DronePhysics } from './drone/DronePhysics';
import { DroneView } from './drone/DroneView';
import { FpvCamera } from './drone/FPVCamera';
import { InputController } from './drone/InputController';
import { HUD } from './ui/HUD';
import { World } from './world/World';

export interface GameDebugState {
  ready: boolean;
  fps: number;
  drawCalls: number;
  triangles: number;
  points: number;
  position: { x: number; y: number; z: number };
  speed: number;
  hoverAssist: boolean;
  webgl: string;
}

const QUALITY_LABEL = 'Medium';

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
  private input!: InputController;
  private hud!: HUD;
  private loop!: Loop;
  private ready = false;
  private debugRefreshTimer = 0;
  private collisionImpact = 0;
  private startedAt = performance.now();

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
    this.world = new World(
      this.engine.scene,
      this.physics,
      maxAnisotropy,
      this.engine.pixelRatio,
    );

    this.drone = new DronePhysics(
      this.physics,
      this.world.spawnPoint,
      this.world.spawnHeading,
    );
    this.droneView = new DroneView(this.engine.scene, this.drone, this.physics);
    this.fpvCamera = new FpvCamera(this.engine.camera, this.drone);

    this.input = new InputController(window);
    this.bindInput();

    this.loop = new Loop(
      (stepSeconds) => this.fixedUpdate(stepSeconds),
      (frameSeconds, elapsedSeconds) => this.renderUpdate(frameSeconds, elapsedSeconds),
    );

    this.world.update(0, 0);
    this.droneView.update(0, 0);
    this.fpvCamera.update(1 / 60, this.input.command);

    await this.engine.renderer.compileAsync(this.engine.scene, this.engine.camera);
    this.engine.render();
    this.ready = true;
    this.startedAt = performance.now();

    this.loop.start();
    this.hud.ready();
    this.hideLoadingScreen();
  }

  start(): void {
    if (!this.ready) throw new Error('Game.init() must resolve before start()');
    this.loop.start();
  }

  getDebugState(): GameDebugState {
    const position = this.drone?.body.translation() ?? { x: 0, y: 0, z: 0 };
    const drawCalls = this.stats.current.drawCalls;
    return {
      ready: this.ready,
      fps: this.stats.current.fps,
      drawCalls,
      triangles: this.stats.current.triangles,
      points: this.stats.current.points,
      position: { x: position.x, y: position.y, z: position.z },
      speed: this.drone?.speed ?? 0,
      hoverAssist: this.drone?.hoverAssist ?? true,
      webgl: this.engine?.renderer.getContext() instanceof WebGL2RenderingContext
        ? 'webgl2'
        : 'unknown',
    };
  }

  get frameStats(): FrameStats {
    return this.stats.current;
  }

  dispose(): void {
    this.loop?.stop();
    this.input?.dispose();
    this.hud?.dispose();
    this.world?.dispose();
    this.physics?.dispose();
    this.engine?.dispose();
    this.ready = false;
  }

  private fixedUpdate(deltaSeconds: number): void {
    if (!this.ready) return;

    const command = this.input.command;
    const preStepVelocity = this.drone.body.linvel();
    const impactSpeed = Math.hypot(
      preStepVelocity.x,
      preStepVelocity.y,
      preStepVelocity.z,
    );

    this.drone.fixedUpdate(deltaSeconds, command);
    this.physics.step(deltaSeconds);

    this.collisionImpact = 0;
    this.physics.drainCollisionEvents((handleA, handleB, started) => {
      if (!started) return;
      if (handleA !== this.drone.collider.handle && handleB !== this.drone.collider.handle) {
        return;
      }
      if (impactSpeed > 2.8) {
        this.collisionImpact = Math.max(this.collisionImpact, impactSpeed);
      }
    });

    if (this.collisionImpact > 0) {
      this.fpvCamera.addCollisionShake(
        Math.min(0.8, (this.collisionImpact - 2.8) / 7.5),
      );
    }

    const translation = this.drone.body.translation();
    if (translation.y < -12 || Math.abs(translation.x) > 240 || Math.abs(translation.z) > 240) {
      this.respawn();
    }
  }

  private renderUpdate(frameSeconds: number, _elapsedSeconds: number): void {
    if (!this.ready) return;

    const command = this.input.command;
    this.world.update(frameSeconds, (performance.now() - this.startedAt) / 1000);
    this.droneView.update(frameSeconds, (performance.now() - this.startedAt) / 1000);
    this.fpvCamera.update(frameSeconds, command);

    const telemetry = this.drone.telemetry;
    this.hud.setTelemetry({
      altitudeMeters: telemetry.altitudeMeters,
      speedMetersPerSecond: telemetry.speedMetersPerSecond,
      verticalSpeed: telemetry.verticalSpeed,
      headingRadians: telemetry.headingRadians,
      hoverAssist: telemetry.hoverAssist,
      batteryPercent: telemetry.batteryPercent,
    });

    this.engine.render();
    this.stats.update(frameSeconds, this.engine.renderer);

    this.debugRefreshTimer += frameSeconds;
    if (this.debugRefreshTimer >= 0.25) {
      this.debugRefreshTimer = 0;
      this.hud.setDebug(this.stats.current, QUALITY_LABEL);
    }
  }

  private bindInput(): void {
    this.input.onInteraction(() => {
      this.hud.noteFlightInput();
    });

    this.input.onAction((action) => {
      if (action === 'toggle-hover') {
        const assist = this.drone.toggleHoverAssist();
        this.hud.toast(assist ? 'Hover assist engaged' : 'Hover assist off · gravity is live');
      } else if (action === 'toggle-debug') {
        this.hud.toggleDebug();
        this.debugRefreshTimer = 1;
        this.hud.setDebug(this.stats.current, QUALITY_LABEL);
      } else if (action === 'reset') {
        this.respawn();
      }
    });
  }

  private respawn(): void {
    this.drone.reset();
    this.fpvCamera.synchronize(true);
    this.hud.toast('Returned to the terrace');
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
