import type * as THREE from 'three';

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  textures: number;
  geometries: number;
}

/**
 * Small rolling frame counter. It is intentionally independent of the DOM so
 * the auto quality manager can consume the same numbers later.
 */
export class Stats {
  readonly current: FrameStats = {
    fps: 60,
    frameMs: 16.6,
    drawCalls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
    textures: 0,
    geometries: 0,
  };

  private frames = 0;
  private elapsed = 0;
  private frameTime = 0;

  update(deltaSeconds: number, renderer: THREE.WebGLRenderer): void {
    this.frames += 1;
    this.elapsed += deltaSeconds;
    this.frameTime += deltaSeconds;

    if (this.elapsed >= 0.5) {
      this.current.fps = this.frames / this.elapsed;
      this.current.frameMs = (this.frameTime / this.frames) * 1000;
      this.frames = 0;
      this.elapsed = 0;
      this.frameTime = 0;
    }

    const info = renderer.info;
    this.current.drawCalls = info.render.calls;
    this.current.triangles = info.render.triangles;
    this.current.points = info.render.points;
    this.current.lines = info.render.lines;
    this.current.textures = info.memory.textures;
    this.current.geometries = info.memory.geometries;
  }
}
