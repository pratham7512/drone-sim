import type { FrameStats } from '../engine/Stats';

export interface FlightTelemetry {
  altitudeMeters: number;
  speedMetersPerSecond: number;
  verticalSpeed: number;
  headingRadians: number;
  hoverAssist: boolean;
  batteryPercent: number;
}

const ORDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Deliberately sparse HUD: heading and two live numbers, with key hints tucked
 * into the corners. The world should be the hero, not the interface.
 */
export class HUD {
  private readonly root: HTMLDivElement;
  private readonly greeting: HTMLDivElement;
  private readonly altitudeEl: HTMLElement;
  private readonly speedEl: HTMLElement;
  private readonly headingEl: HTMLElement;
  private readonly assistEl: HTMLElement;
  private readonly debugEl: HTMLElement;
  private readonly debugValues: Record<string, HTMLElement> = {};
  private readonly toastEl: HTMLElement;
  private toastTimer = 0;
  private greetingTimer = 0;
  private greetingDismissed = false;

  constructor(uiRoot: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="brand">
        <div class="brand-ornament" aria-hidden="true"></div>
        <div>
          <p class="brand-title">Diwali Night</p>
          <p class="brand-sub">A flight over the mohalla</p>
        </div>
      </div>

      <div class="flight-strip">
        <span class="status-dot" aria-hidden="true"></span>
        <span>FPV</span>
        <span class="status-value">Live</span>
      </div>

      <div class="greeting" role="status">
        <p class="eyebrow greeting-kicker">A small mohalla, one night of light</p>
        <h1>Happy Diwali</h1>
        <div class="greeting-rule" aria-hidden="true"><span></span></div>
        <p class="greeting-copy">Drift above the rooftops.<br />The city is still awake.</p>
        <p class="greeting-hint">Space to rise &nbsp;·&nbsp; WASD to drift &nbsp;·&nbsp; H for hover assist</p>
      </div>

      <div class="toast" role="status" aria-live="polite"></div>

      <div class="debug" hidden aria-label="Performance diagnostics">
        <div class="debug-title">RENDER TELEMETRY</div>
        <div class="debug-grid">
          <span>fps</span><span data-debug="fps">—</span>
          <span>frame</span><span data-debug="frame">—</span>
          <span>draw calls</span><span data-debug="calls">—</span>
          <span>triangles</span><span data-debug="triangles">—</span>
          <span>points</span><span data-debug="points">—</span>
          <span>textures</span><span data-debug="textures">—</span>
        </div>
        <div class="debug-footer">\` opens diagnostics</div>
      </div>

      <div class="controls">
        <div class="control-group">
          <span class="control-caption">Drift</span>
          <div class="key-row">
            <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
            <span class="key-desc">Move</span>
          </div>
        </div>
        <div class="control-group">
          <span class="control-caption">Yaw</span>
          <div class="key-row">
            <kbd>Q</kbd><kbd>E</kbd>
            <span class="key-desc">Turn</span>
          </div>
        </div>
        <div class="control-separator" aria-hidden="true"></div>
        <div class="control-group">
          <span class="control-caption">Altitude</span>
          <div class="key-row">
            <kbd>Space</kbd><kbd>Shift</kbd>
            <span class="key-desc">Climb / sink</span>
          </div>
        </div>
        <div class="control-group">
          <span class="control-caption">Flight</span>
          <div class="key-row">
            <kbd>H</kbd><kbd>R</kbd>
            <span class="key-desc">Hover / reset</span>
          </div>
        </div>
      </div>

      <div class="telemetry" aria-label="Flight telemetry">
        <div class="telemetry-head">
          <span class="telemetry-label">Heading</span>
          <div class="telemetry-heading">
            <strong data-heading-cardinal>N</strong>
            <span data-heading-degrees>000°</span>
          </div>
        </div>
        <div class="metrics">
          <div class="metric">
            <div class="metric-label">Altitude</div>
            <div class="metric-value">
              <strong data-altitude>10.8</strong><span>m</span>
            </div>
          </div>
          <div class="metric">
            <div class="metric-label">Ground speed</div>
            <div class="metric-value">
              <strong data-speed>0.0</strong><span>m/s</span>
            </div>
          </div>
        </div>
        <div class="assist-row">
          <span>Hover assist</span>
          <span class="assist-state" data-assist>On</span>
        </div>
      </div>
    `;

    uiRoot.appendChild(this.root);

    this.greeting = this.query<HTMLDivElement>('.greeting');
    this.altitudeEl = this.query('[data-altitude]');
    this.speedEl = this.query('[data-speed]');
    this.headingEl = this.query('[data-heading-cardinal]');
    this.assistEl = this.query('[data-assist]');
    this.debugEl = this.query('.debug');
    this.toastEl = this.query('.toast');

    for (const key of ['fps', 'frame', 'calls', 'triangles', 'points', 'textures']) {
      this.debugValues[key] = this.query(`[data-debug="${key}"]`);
    }

    this.greetingTimer = window.setTimeout(() => this.dismissGreeting(), 10_000);
  }

  ready(): void {
    this.root.classList.add('is-ready');
  }

  noteFlightInput(): void {
    this.dismissGreeting();
  }

  dismissGreeting(): void {
    if (this.greetingDismissed) return;
    this.greetingDismissed = true;
    window.clearTimeout(this.greetingTimer);
    this.greeting.classList.add('is-hidden');
  }

  setTelemetry(telemetry: FlightTelemetry): void {
    const headingDegrees = ((-telemetry.headingRadians * 180) / Math.PI + 360) % 360;
    const ordinalIndex = Math.round(headingDegrees / 45) % ORDINALS.length;

    this.altitudeEl.textContent = telemetry.altitudeMeters.toFixed(1);
    this.speedEl.textContent = telemetry.speedMetersPerSecond.toFixed(1);
    this.headingEl.textContent = ORDINALS[ordinalIndex] ?? 'N';
    const degreesEl = this.query('[data-heading-degrees]');
    degreesEl.textContent = `${Math.round(headingDegrees).toString().padStart(3, '0')}°`;

    this.assistEl.textContent = telemetry.hoverAssist ? 'On' : 'Off';
    this.assistEl.classList.toggle('is-off', !telemetry.hoverAssist);
  }

  toggleDebug(): boolean {
    const visible = this.debugEl.hidden;
    this.debugEl.hidden = !visible;
    return visible;
  }

  setDebug(stats: FrameStats, qualityLabel: string): void {
    if (this.debugEl.hidden) return;
    this.debugValues.fps!.textContent = stats.fps.toFixed(0);
    this.debugValues.frame!.textContent = `${stats.frameMs.toFixed(1)} ms`;
    this.debugValues.calls!.textContent = String(stats.drawCalls);
    this.debugValues.triangles!.textContent = stats.triangles.toLocaleString('en-US');
    this.debugValues.points!.textContent = stats.points.toLocaleString('en-US');
    this.debugValues.textures!.textContent = String(stats.textures);

    const footer = this.debugEl.querySelector<HTMLElement>('.debug-footer');
    if (footer) footer.textContent = `${qualityLabel} · \` closes diagnostics`;
  }

  toast(message: string, durationMs = 1800): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl.textContent = message;
    this.toastEl.classList.add('is-visible');
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('is-visible');
    }, durationMs);
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer);
    window.clearTimeout(this.greetingTimer);
    this.root.remove();
  }

  private query<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`HUD element not found: ${selector}`);
    return element;
  }
}
