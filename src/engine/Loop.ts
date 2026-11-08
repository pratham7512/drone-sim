/**
 * Fixed-step simulation loop with a bounded catch-up budget.
 * Physics and input forces run at a stable 60 Hz; rendering can run faster.
 */
export class Loop {
  private accumulator = 0;
  private lastTime = 0;
  private frameId = 0;
  private running = false;

  constructor(
    private readonly fixedUpdate: (stepSeconds: number) => void,
    private readonly renderUpdate: (frameSeconds: number, elapsedSeconds: number) => void,
    private readonly fixedStep = 1 / 60,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;

    const rawSeconds = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Avoid a physics Spiral of Death after a tab switch.
    const frameSeconds = Math.min(Math.max(rawSeconds, 0), 0.1);
    this.accumulator += frameSeconds;

    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < 6) {
      this.fixedUpdate(this.fixedStep);
      this.accumulator -= this.fixedStep;
      steps += 1;
    }

    this.renderUpdate(frameSeconds, now / 1000);
    this.frameId = requestAnimationFrame(this.tick);
  };
}
