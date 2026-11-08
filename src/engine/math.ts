import * as THREE from 'three';

export const UP = new THREE.Vector3(0, 1, 0);

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Frame-rate independent exponential damping factor. */
export function dampFactor(lambda: number, deltaSeconds: number): number {
  return 1 - Math.exp(-lambda * deltaSeconds);
}

export function damp(current: number, target: number, lambda: number, deltaSeconds: number): number {
  return current + (target - current) * dampFactor(lambda, deltaSeconds);
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic PRNG so the procedural world looks the same on every load. */
export class Random {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxExclusive: number): number {
    return Math.floor(this.range(min, maxExclusive));
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error('Cannot pick from an empty array');
    return values[Math.floor(this.next() * values.length)] as T;
  }
}

/** Compact axis-angle helper for the yaw-locked drone body. */
export function yawQuaternion(yaw: number, target = new THREE.Quaternion()): THREE.Quaternion {
  return target.setFromAxisAngle(UP, yaw);
}
