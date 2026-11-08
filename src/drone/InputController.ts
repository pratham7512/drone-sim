export interface FlightCommand {
  /** -1 backward, +1 forward. */
  forward: number;
  /** -1 left, +1 right. */
  strafe: number;
  /** -1 descend, +1 climb. */
  lift: number;
  /** -1 yaw right, +1 yaw left. */
  yaw: number;
  /** True whenever a flight input is held. */
  active: boolean;
}

export type InputAction = 'toggle-hover' | 'toggle-debug' | 'reset';

const FLIGHT_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
]);

/**
 * Keyboard flight controls. Keeps raw key state separate from physics and
 * exposes edge-triggered actions for non-flight systems.
 */
export class InputController {
  private readonly held = new Set<string>();
  private readonly actionListeners = new Set<(action: InputAction) => void>();
  private readonly interactionListeners = new Set<() => void>();

  constructor(private readonly target: Window = window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.clear);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  get command(): FlightCommand {
    return {
      forward: Number(this.isHeld('KeyW')) - Number(this.isHeld('KeyS')),
      strafe: Number(this.isHeld('KeyD')) - Number(this.isHeld('KeyA')),
      lift:
        Number(this.isHeld('Space')) -
        Number(this.isHeld('ShiftLeft') || this.isHeld('ShiftRight') || this.isHeld('ControlLeft') || this.isHeld('ControlRight')),
      yaw: Number(this.isHeld('KeyQ')) - Number(this.isHeld('KeyE')),
      active: [...FLIGHT_KEYS].some((code) => this.held.has(code)),
    };
  }

  onAction(listener: (action: InputAction) => void): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  /** Fires on the first key of each burst, useful for dismissing the greeting. */
  onInteraction(listener: () => void): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.clear);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.clear();
    this.actionListeners.clear();
    this.interactionListeners.clear();
  }

  private isHeld(code: string): boolean {
    return this.held.has(code);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const isShortcut = event.metaKey || event.altKey;
    if (isShortcut) return;

    if (FLIGHT_KEYS.has(event.code) || event.code === 'Backquote') {
      event.preventDefault();
    }

    if (this.held.has(event.code)) return;
    this.held.add(event.code);

    if (!event.repeat) {
      for (const listener of this.interactionListeners) listener();

      let action: InputAction | null = null;
      if (event.code === 'KeyH') action = 'toggle-hover';
      else if (event.code === 'Backquote') action = 'toggle-debug';
      else if (event.code === 'KeyR') action = 'reset';

      if (action) {
        for (const listener of this.actionListeners) listener(action);
      }
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private readonly clear = (): void => {
    this.held.clear();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.clear();
  };
}
