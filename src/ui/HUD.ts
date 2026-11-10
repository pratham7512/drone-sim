import type { FrameStats } from '../engine/Stats';

export interface FlightTelemetry {
  altitudeMeters: number;
  speedMetersPerSecond: number;
  verticalSpeed: number;
  headingRadians: number;
  /** World-space position, used by the landing map. */
  worldX: number;
  worldZ: number;
  /** True while H has pinned the current altitude. */
  altitudeLocked: boolean;
  altitudeTarget: number;
  flightMode: 'angle' | 'acro';
  flightState: 'flying' | 'crashed';
  throttle: number;
  batteryPercent: number;
  linkDbm: number;
  linkQuality: number;
  /** Seconds since the current flight began. */
  flightTimeSeconds: number;
  /** Instantaneous pack current in amps. */
  currentAmps: number;
}

export interface CrashOverlayState {
  active: boolean;
}

export interface MapBuilding {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

export interface MapWorld {
  buildings: readonly MapBuilding[];
  homeX: number;
  homeZ: number;
  period: number;
}

export type FlightStatus = 'live' | 'landed' | 'crashed';

const HEADING_WIDTH = 900;
const HEADING_HEIGHT = 92;
const HEADING_SPAN = 128;
const MAP_RANGE_METERS = 62;
const MAP_CELL_METERS = 16;
const MAP_MAJOR_LANE_METERS = 56;
const MAP_MAJOR_LANE_OFFSET = -200;
const HUD_FONT = '"Barlow Condensed", "Avenir Next Condensed", "DIN Condensed", sans-serif';
const BATTERY_FULL_VOLTS = 25.2;
const BATTERY_EMPTY_VOLTS = 19.2;

/**
 * Minimal FPV camera OSD: mode, compass tape, link, pack, speed and altitude.
 * There is deliberately no radar, no stick reticles and no decorative chrome
 * between the pilot and the city. A crash cuts the feed to a dead analogue
 * camera and shows only CAMERA DISCONNECTED.
 */
export class HUD {
  private readonly root: HTMLDivElement;
  private readonly modeEl: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly linkEl: HTMLElement;
  private readonly linkBars: HTMLElement[] = [];
  private readonly qualityEl: HTMLElement;
  private readonly flightTimeEl: HTMLElement;
  private readonly voltageEl: HTMLElement;
  private readonly currentEl: HTMLElement;
  private readonly speedEl: HTMLElement;
  private readonly altitudeEl: HTMLElement;
  private readonly altitudeLockEl: HTMLElement;
  private readonly warningEl: HTMLElement;
  private readonly debugEl: HTMLElement;
  private readonly debugValues: Record<string, HTMLElement> = {};
  private readonly toastEl: HTMLElement;
  private readonly signalEl: HTMLElement;
  private readonly preflightEl: HTMLElement;
  private readonly preflightKickerEl: HTMLElement;
  private readonly preflightStatusEl: HTMLElement;
  private readonly preflightTitleEl: HTMLElement;
  private readonly headingCanvas: HTMLCanvasElement;
  private readonly headingContext: CanvasRenderingContext2D;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly mapContext: CanvasRenderingContext2D;
  private mapWorld: MapWorld | null = null;
  private mapPose = { x: 0, z: 0, heading: 0 };
  private lastHeadingDraw = 0;
  private lastMapDraw = 0;
  private toastTimer = 0;
  private crashed = false;

  constructor(uiRoot: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="osd-mode">
        <span class="osd-mode-value" data-mode>ANGLE</span>
        <span class="osd-mode-state" data-state></span>
      </div>

      <canvas class="heading-tape" width="${HEADING_WIDTH}" height="${HEADING_HEIGHT}" aria-hidden="true"></canvas>

      <div class="osd-link">
        <div class="link-line">
          <span class="link-bars" data-bars aria-hidden="true">
            <span></span><span></span><span></span><span></span>
          </span>
          <span data-dbm>-42dBm</span>
        </div>
        <div class="link-line link-quality"><span data-lq>100:100 LQ</span></div>
      </div>

      <div class="osd-pack">
        <span class="osd-clock" data-flight-time>00:00</span>
        <span class="osd-pack-line" data-voltage>25.20v</span>
        <span class="osd-pack-line osd-current" data-current>0.00A</span>
      </div>

      <div class="osd-map" aria-hidden="true">
        <canvas class="minimap" width="360" height="360"></canvas>
        <span class="map-frame"></span>
        <span class="map-caption">MOHALLA · 62 M</span>
      </div>

      <div class="osd-speed">
        <span data-speed>0</span><span class="osd-unit">km/h</span>
      </div>
      <div class="osd-altitude">
        <span data-altitude>10</span><span class="osd-unit">m</span>
        <span class="osd-alt-lock" data-alt-lock aria-hidden="true">ALT LOCK</span>
      </div>

      <div class="osd-warning" data-warning hidden>FREEFALL</div>

      <div class="toast" role="status" aria-live="polite"></div>

      <section class="preflight" aria-label="Flight controls">
        <div class="preflight-head">
          <span class="preflight-kicker" data-preflight-kicker>PRE-FLIGHT · TERRACE PAD</span>
          <span class="preflight-status"><span class="preflight-dot" aria-hidden="true"></span><span data-preflight-status>READY FOR TAKEOFF</span></span>
        </div>
        <p class="preflight-title">Hold <kbd>SPACE</kbd> to lift off</p>
        <div class="preflight-grid">
          <div class="preflight-item">
            <span class="preflight-keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span>
            <span class="preflight-label">Drift</span>
          </div>
          <div class="preflight-item">
            <span class="preflight-keys"><kbd>Q</kbd><kbd>E</kbd></span>
            <span class="preflight-label">Yaw</span>
          </div>
          <div class="preflight-item">
            <span class="preflight-keys"><kbd>SPACE</kbd><kbd>SHIFT</kbd></span>
            <span class="preflight-label">Climb / sink</span>
          </div>
          <div class="preflight-item">
            <span class="preflight-keys"><kbd>H</kbd></span>
            <span class="preflight-label">Lock altitude</span>
          </div>
          <div class="preflight-item">
            <span class="preflight-keys"><kbd>T</kbd></span>
            <span class="preflight-label">Acro mode</span>
          </div>
          <div class="preflight-item">
            <span class="preflight-keys"><kbd>R</kbd><kbd>M</kbd></span>
            <span class="preflight-label">Reset / mute</span>
          </div>
        </div>
        <p class="preflight-note"><kbd>H</kbd> pins the current altitude in angle mode. Press <kbd>H</kbd> or <kbd>SPACE</kbd> to release it. The city is alive after dark.</p>
      </section>

      <div class="debug" hidden aria-label="Performance diagnostics">
        <div class="debug-title">RENDER TELEMETRY</div>
        <div class="debug-grid">
          <span>fps</span><span data-debug="fps">—</span>
          <span>frame</span><span data-debug="frame">—</span>
          <span>draw calls</span><span data-debug="calls">—</span>
          <span>triangles</span><span data-debug="triangles">—</span>
          <span>points</span><span data-debug="points">—</span>
          <span>textures</span><span data-debug="textures">—</span>
          <span>city</span><span data-debug="city">—</span>
          <span>colliders</span><span data-debug="colliders">—</span>
          <span>audio</span><span data-debug="audio">—</span>
        </div>
        <div class="debug-footer">\` closes diagnostics</div>
      </div>

      <div class="signal-loss" role="alert" aria-live="assertive">
        <div class="signal-static" aria-hidden="true"></div>
        <div class="signal-tint" aria-hidden="true"></div>
        <div class="signal-scan" aria-hidden="true"></div>
        <p class="signal-message">CAMERA DISCONNECTED</p>
      </div>
    `;

    uiRoot.appendChild(this.root);

    this.modeEl = this.query('[data-mode]');
    this.stateEl = this.query('[data-state]');
    this.linkEl = this.query('[data-dbm]');
    this.qualityEl = this.query('[data-lq]');
    this.flightTimeEl = this.query('[data-flight-time]');
    this.voltageEl = this.query('[data-voltage]');
    this.currentEl = this.query('[data-current]');
    this.speedEl = this.query('[data-speed]');
    this.altitudeEl = this.query('[data-altitude]');
    this.altitudeLockEl = this.query('[data-alt-lock]');
    this.warningEl = this.query('[data-warning]');
    this.debugEl = this.query('.debug');
    this.toastEl = this.query('.toast');
    this.signalEl = this.query('.signal-loss');
    this.preflightEl = this.query('.preflight');
    this.preflightKickerEl = this.query('[data-preflight-kicker]');
    this.preflightStatusEl = this.query('[data-preflight-status]');
    this.preflightTitleEl = this.query('.preflight-title');
    this.headingCanvas = this.query<HTMLCanvasElement>('.heading-tape');
    this.mapCanvas = this.query<HTMLCanvasElement>('.minimap');

    const headingContext = this.headingCanvas.getContext('2d');
    if (!headingContext) throw new Error('Heading canvas 2D context unavailable');
    this.headingContext = headingContext;

    const mapContext = this.mapCanvas.getContext('2d');
    if (!mapContext) throw new Error('Minimap canvas 2D context unavailable');
    this.mapContext = mapContext;

    this.linkBars = Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-bars] span'),
    );

    for (const key of ['fps', 'frame', 'calls', 'triangles', 'points', 'textures', 'city', 'colliders', 'audio']) {
      this.debugValues[key] = this.query(`[data-debug="${key}"]`);
    }

    this.drawHeading(0);
  }

  ready(): void {
    this.root.classList.add('is-ready');
  }

  /**
   * The pre-flight card is only shown while the quad is sitting on a surface.
   * It disappears the moment the drone climbs and returns after a touchdown or
   * a reset, so the controls are always available without covering the city
   * during flight.
   */
  setPreflight(visible: boolean, options: { onPad?: boolean; landed?: boolean } = {}): void {
    const onPad = options.onPad ?? true;
    const landed = options.landed ?? false;
    this.preflightEl.classList.toggle('is-visible', visible);
    this.preflightEl.setAttribute('aria-hidden', visible ? 'false' : 'true');

    if (landed) {
      this.preflightKickerEl.textContent = onPad
        ? 'TOUCHDOWN · HOME PAD'
        : 'TOUCHDOWN · ROOFTOP';
      this.preflightStatusEl.textContent = 'LANDED';
      this.preflightTitleEl.innerHTML = 'Hold <kbd>SPACE</kbd> to lift off again';
    } else {
      this.preflightKickerEl.textContent = 'PRE-FLIGHT · TERRACE PAD';
      this.preflightStatusEl.textContent = 'READY FOR TAKEOFF';
      this.preflightTitleEl.innerHTML = 'Hold <kbd>SPACE</kbd> to lift off';
    }
  }

  get preflightVisible(): boolean {
    return this.preflightEl.classList.contains('is-visible');
  }

  /** Buildings and the home pad used by the rotating landing map. */
  setMapWorld(world: MapWorld): void {
    this.mapWorld = world;
    this.drawMap();
  }

  setFlightStatus(status: FlightStatus): void {
    this.root.classList.toggle('is-landed', status === 'landed');
    this.stateEl.textContent = status === 'landed' ? 'LANDED' : '';
  }

  setTelemetry(telemetry: FlightTelemetry): void {
    const headingDegrees = ((-telemetry.headingRadians * 180) / Math.PI + 360) % 360;
    const acro = telemetry.flightMode === 'acro';

    this.modeEl.textContent = acro ? 'ACRO' : 'ANGLE';
    this.modeEl.classList.toggle('is-acro', acro);

    this.speedEl.textContent = String(Math.round(telemetry.speedMetersPerSecond * 3.6));
    this.altitudeEl.textContent = Math.round(telemetry.altitudeMeters).toString();
    this.altitudeLockEl.classList.toggle('is-visible', telemetry.altitudeLocked);
    this.altitudeLockEl.setAttribute('aria-hidden', telemetry.altitudeLocked ? 'false' : 'true');
    if (telemetry.altitudeLocked) {
      this.altitudeLockEl.textContent = `ALT LOCK · ${Math.round(telemetry.altitudeTarget)} M`;
    }

    this.flightTimeEl.textContent = formatClock(telemetry.flightTimeSeconds);
    const voltage = BATTERY_EMPTY_VOLTS
      + (Math.max(0, Math.min(100, telemetry.batteryPercent)) / 100)
      * (BATTERY_FULL_VOLTS - BATTERY_EMPTY_VOLTS);
    this.voltageEl.textContent = `${voltage.toFixed(2)}v`;
    this.currentEl.textContent = `${Math.max(0, telemetry.currentAmps).toFixed(2)}A`;

    this.linkEl.textContent = `${Math.round(telemetry.linkDbm)}dBm`;
    this.qualityEl.textContent = `${Math.round(telemetry.linkQuality)}:100 LQ`;
    const activeBars = telemetry.linkQuality > 78
      ? 4
      : telemetry.linkQuality > 52
        ? 3
        : telemetry.linkQuality > 24
          ? 2
          : 1;
    this.linkBars.forEach((bar, index) => {
      bar.classList.toggle('is-on', index < activeBars);
    });

    this.updateWarning(telemetry);

    const now = performance.now();
    if (now - this.lastHeadingDraw > 33) {
      this.lastHeadingDraw = now;
      this.drawHeading(headingDegrees);
    }

    this.mapPose.x = telemetry.worldX;
    this.mapPose.z = telemetry.worldZ;
    this.mapPose.heading = telemetry.headingRadians;
    if (now - this.lastMapDraw > 90) {
      this.lastMapDraw = now;
      this.drawMap();
    }
  }

  setCrashState(state: CrashOverlayState): void {
    const wasActive = this.crashed;
    this.root.classList.toggle('is-crashed', state.active);
    this.signalEl.classList.toggle('is-visible', state.active);
    this.crashed = state.active;

    if (!state.active) return;
    this.hideToast();
    if (!wasActive) {
      this.signalEl.classList.remove('is-hit');
      // Restart the feed-collapse animation for each new crash.
      void this.signalEl.offsetWidth;
      this.signalEl.classList.add('is-hit');
    }
  }

  toggleDebug(): boolean {
    const visible = this.debugEl.hidden;
    this.debugEl.hidden = !visible;
    return visible;
  }

  setDebug(
    stats: FrameStats,
    qualityLabel: string,
    world?: { cityBuildings: number; activeColliders: number; audio: string },
  ): void {
    if (this.debugEl.hidden) return;
    this.debugValues.fps!.textContent = stats.fps.toFixed(0);
    this.debugValues.frame!.textContent = `${stats.frameMs.toFixed(1)} ms`;
    this.debugValues.calls!.textContent = String(stats.drawCalls);
    this.debugValues.triangles!.textContent = stats.triangles.toLocaleString('en-US');
    this.debugValues.points!.textContent = stats.points.toLocaleString('en-US');
    this.debugValues.textures!.textContent = String(stats.textures);
    if (world) {
      this.debugValues.city!.textContent = String(world.cityBuildings);
      this.debugValues.colliders!.textContent = String(world.activeColliders);
      this.debugValues.audio!.textContent = world.audio;
    }

    const footer = this.debugEl.querySelector<HTMLElement>('.debug-footer');
    if (footer) footer.textContent = `${qualityLabel} · \` closes diagnostics`;
  }

  toast(message: string, durationMs = 1800): void {
    if (this.crashed) return;
    window.clearTimeout(this.toastTimer);
    this.toastEl.textContent = message;
    this.toastEl.classList.add('is-visible');
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('is-visible');
    }, durationMs);
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer);
    this.root.remove();
  }

  private hideToast(): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl.classList.remove('is-visible');
  }

  private updateWarning(telemetry: FlightTelemetry): void {
    let warning = '';
    if (!this.crashed) {
      if (telemetry.linkQuality < 26) {
        warning = 'RX LOST';
      } else if (telemetry.throttle < 0.015 && telemetry.verticalSpeed < -6) {
        warning = 'FREEFALL';
      } else if (telemetry.altitudeMeters > 112) {
        warning = 'CEILING 120M';
      } else if (telemetry.batteryPercent < 20) {
        warning = 'BATTERY LOW';
      } else if (telemetry.flightMode === 'acro') {
        warning = 'ACRO · MANUAL ATTITUDE';
      }
    }

    this.warningEl.hidden = warning === '';
    if (warning) this.warningEl.textContent = warning;
    this.warningEl.classList.toggle('is-acro', telemetry.flightMode === 'acro');
  }

  private drawHeading(headingDegrees: number): void {
    const context = this.headingContext;
    const width = HEADING_WIDTH;
    const height = HEADING_HEIGHT;
    const center = width / 2;
    const pxPerDegree = width / HEADING_SPAN;

    context.clearRect(0, 0, width, height);
    context.save();
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';
    context.shadowColor = 'rgba(0, 0, 0, 0.85)';
    context.shadowBlur = 4;

    const start = Math.floor((headingDegrees - HEADING_SPAN / 2) / 5) * 5;
    const end = headingDegrees + HEADING_SPAN / 2;

    for (let angle = start; angle <= end; angle += 5) {
      const normalized = ((angle % 360) + 360) % 360;
      const delta = wrapDegrees(angle - headingDegrees);
      const x = center + delta * pxPerDegree;
      if (x < 12 || x > width - 12) continue;

      const major = normalized % 15 === 0;
      const cardinal = normalized % 90 === 0;
      const distance = Math.abs(delta) / (HEADING_SPAN / 2);
      const alpha = 0.35 + (1 - distance) * 0.55;

      context.strokeStyle = `rgba(255, 255, 255, ${major ? alpha : alpha * 0.55})`;
      context.lineWidth = major ? 2 : 1.1;
      context.beginPath();
      context.moveTo(x, major ? 52 : 59);
      context.lineTo(x, 70);
      context.stroke();

      if (major) {
        context.font = `${cardinal ? 700 : 600} ${cardinal ? 27 : 23}px ${HUD_FONT}`;
        context.fillStyle = `rgba(255, 255, 255, ${0.62 + alpha * 0.35})`;
        context.fillText(String(normalized).padStart(3, '0'), x, 42);
      }
    }

    context.fillStyle = 'rgba(255, 255, 255, 0.96)';
    context.beginPath();
    context.moveTo(center - 5, 73);
    context.lineTo(center + 5, 73);
    context.lineTo(center, 82);
    context.closePath();
    context.fill();

    context.strokeStyle = 'rgba(255, 255, 255, 0.88)';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(center, 15);
    context.lineTo(center, 23);
    context.stroke();
    context.restore();
  }

  /**
   * GTA-style rotating landing map. The nose always points up, building
   * footprints are shaded by height so tall terraces stand out, and the home
   * pad is a house waypoint that clamps to the rim when it is out of range.
   */
  private drawMap(): void {
    const world = this.mapWorld;
    if (!world) return;

    const context = this.mapContext;
    const size = this.mapCanvas.width;
    const center = size / 2;
    const radius = center - 3;
    const scale = (radius - 10) / MAP_RANGE_METERS;
    const pose = this.mapPose;
    const cos = Math.cos(pose.heading);
    const sin = Math.sin(pose.heading);

    context.clearRect(0, 0, size, size);
    context.save();
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.clip();

    const backdrop = context.createRadialGradient(center, center, 0, center, center, radius);
    backdrop.addColorStop(0, '#1b242b');
    backdrop.addColorStop(0.7, '#121a20');
    backdrop.addColorStop(1, '#080d12');
    context.fillStyle = backdrop;
    context.fillRect(0, 0, size, size);

    const reach = MAP_RANGE_METERS + 18;
    const minX = pose.x - reach;
    const maxX = pose.x + reach;
    const minZ = pose.z - reach;
    const maxZ = pose.z + reach;

    // World space, rotated so the drone's heading points up the screen.
    context.save();
    context.translate(center, center);
    context.rotate(pose.heading);
    context.scale(scale, scale);

    // Fine lanes on the 16 m city grid, then the wide arterials the generator
    // leaves open every seventh cell.
    context.lineCap = 'butt';
    context.strokeStyle = 'rgba(176, 199, 208, 0.085)';
    context.lineWidth = 0.5;
    context.beginPath();
    const firstX = Math.floor(minX / MAP_CELL_METERS) * MAP_CELL_METERS;
    for (let x = firstX; x <= maxX; x += MAP_CELL_METERS) {
      context.moveTo(x, minZ);
      context.lineTo(x, maxZ);
    }
    const firstZ = Math.floor(minZ / MAP_CELL_METERS) * MAP_CELL_METERS;
    for (let z = firstZ; z <= maxZ; z += MAP_CELL_METERS) {
      context.moveTo(minX, z);
      context.lineTo(maxX, z);
    }
    context.stroke();

    context.strokeStyle = 'rgba(192, 216, 224, 0.1)';
    context.lineWidth = MAP_CELL_METERS;
    context.beginPath();
    const firstMajorX = MAP_MAJOR_LANE_OFFSET
      + Math.floor((minX - MAP_MAJOR_LANE_OFFSET) / MAP_MAJOR_LANE_METERS)
        * MAP_MAJOR_LANE_METERS;
    for (let x = firstMajorX; x <= maxX; x += MAP_MAJOR_LANE_METERS) {
      context.moveTo(x, minZ);
      context.lineTo(x, maxZ);
    }
    const firstMajorZ = MAP_MAJOR_LANE_OFFSET
      + Math.floor((minZ - MAP_MAJOR_LANE_OFFSET) / MAP_MAJOR_LANE_METERS)
        * MAP_MAJOR_LANE_METERS;
    for (let z = firstMajorZ; z <= maxZ; z += MAP_MAJOR_LANE_METERS) {
      context.moveTo(minX, z);
      context.lineTo(maxX, z);
    }
    context.stroke();

    // Footprints are the actual roof rectangles the drone can land on; taller
    // buildings read brighter, so a promising terrace is obvious from the air.
    const period = world.period > 0 ? world.period : 512;
    for (const offsetX of [-period, 0, period]) {
      for (const offsetZ of [-period, 0, period]) {
        for (const building of world.buildings) {
          const x = building.x + offsetX;
          const z = building.z + offsetZ;
          if (
            x < minX - 10 ||
            x > maxX + 10 ||
            z < minZ - 10 ||
            z > maxZ + 10
          ) {
            continue;
          }

          const height = clamp01((building.height - 3.5) / 14);
          const left = x - building.width / 2;
          const top = z - building.depth / 2;

          // A short offset shadow lifts the block off the street grid.
          context.fillStyle = 'rgba(2, 5, 8, 0.34)';
          context.fillRect(left + 0.7, top + 0.9, building.width, building.depth);

          context.fillStyle = `rgba(${Math.round(104 + height * 52)}, ${Math.round(122 + height * 54)}, ${Math.round(132 + height * 56)}, ${0.42 + height * 0.34})`;
          context.fillRect(left, top, building.width, building.depth);
          context.strokeStyle = `rgba(224, 238, 244, ${0.16 + height * 0.34})`;
          context.lineWidth = 0.34;
          context.strokeRect(left, top, building.width, building.depth);
        }
      }
    }

    context.restore();

    // Half-range ring: a quick distance cue while lining up a terrace.
    context.strokeStyle = 'rgba(210, 228, 235, 0.1)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(center, center, 30 * scale, 0, Math.PI * 2);
    context.stroke();

    // Home waypoint, wrapped to the nearest copy and clamped to the rim.
    let homeDx = wrapToPeriod(world.homeX - pose.x, period);
    let homeDz = wrapToPeriod(world.homeZ - pose.z, period);
    const homeDistance = Math.hypot(homeDx, homeDz);
    const markerLimit = MAP_RANGE_METERS - 8;
    if (homeDistance > markerLimit) {
      const limit = markerLimit / homeDistance;
      homeDx *= limit;
      homeDz *= limit;
    }
    const homeScreenX = center + scale * (homeDx * cos - homeDz * sin);
    const homeScreenY = center + scale * (homeDx * sin + homeDz * cos);
    this.drawHomeMarker(homeScreenX, homeScreenY);

    // North indicator tracks the rotating map.
    const northX = center + (radius - 18) * sin;
    const northY = center - (radius - 18) * cos;
    context.save();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `700 23px ${HUD_FONT}`;
    context.fillStyle = 'rgba(255, 201, 138, 0.94)';
    context.shadowColor = 'rgba(0, 0, 0, 0.9)';
    context.shadowBlur = 4;
    context.fillText('N', northX, northY);
    context.restore();

    // Fixed drone arrow at the centre of the rotating map.
    context.save();
    context.translate(center, center);
    context.shadowColor = 'rgba(0, 0, 0, 0.9)';
    context.shadowBlur = 5;
    context.beginPath();
    context.moveTo(0, -15);
    context.lineTo(9.5, 11);
    context.lineTo(0, 5.5);
    context.lineTo(-9.5, 11);
    context.closePath();
    context.fillStyle = '#f4f7f7';
    context.strokeStyle = 'rgba(8, 12, 15, 0.94)';
    context.lineWidth = 3.5;
    context.stroke();
    context.fill();
    context.restore();

    // Soft bezel fade so streets dissolve into the instrument instead of
    // ending on a hard circle.
    const fade = context.createRadialGradient(
      center,
      center,
      radius * 0.56,
      center,
      center,
      radius,
    );
    fade.addColorStop(0, 'rgba(4, 7, 10, 0)');
    fade.addColorStop(1, 'rgba(4, 7, 10, 0.62)');
    context.fillStyle = fade;
    context.fillRect(0, 0, size, size);

    context.restore();
  }

  private drawHomeMarker(x: number, y: number): void {
    const context = this.mapContext;
    context.save();
    context.translate(x, y);
    context.shadowColor = 'rgba(0, 0, 0, 0.85)';
    context.shadowBlur = 4;
    context.fillStyle = 'rgba(255, 192, 116, 0.97)';
    context.strokeStyle = 'rgba(10, 14, 17, 0.92)';
    context.lineWidth = 1.6;
    context.beginPath();
    context.moveTo(0, -7.5);
    context.lineTo(7, -1.5);
    context.lineTo(4.6, -1.5);
    context.lineTo(4.6, 6.8);
    context.lineTo(-4.6, 6.8);
    context.lineTo(-4.6, -1.5);
    context.lineTo(-7, -1.5);
    context.closePath();
    context.stroke();
    context.fill();
    context.restore();
  }

  private query<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`HUD element not found: ${selector}`);
    return element;
  }
}

function wrapDegrees(value: number): number {
  return value - 360 * Math.round(value / 360);
}

function wrapToPeriod(value: number, period: number): number {
  return value - period * Math.round(value / period);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60).toString().padStart(2, '0');
  const remaining = (total % 60).toString().padStart(2, '0');
  return `${minutes}:${remaining}`;
}
