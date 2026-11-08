import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export interface SurfaceHit {
  point: THREE.Vector3;
  distance: number;
}

/**
 * Thin Rapier wrapper. Keeping it small makes the eventual wire, rooftop and
 * building colliders straightforward to add from the layout loader.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  private readonly eventQueue: RAPIER.EventQueue;
  private readonly down = new THREE.Vector3(0, -1, 0);

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.integrationParameters.numSolverIterations = 6;
    this.world.timestep = 1 / 60;
    this.eventQueue = new RAPIER.EventQueue(true);
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld();
  }

  /** Creates an immovable collider without the overhead of a rigid body. */
  addStaticBox(center: THREE.Vector3, halfExtents: THREE.Vector3, rotationY = 0): RAPIER.Collider {
    const rotation = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotationY);
    const description = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setTranslation(center.x, center.y, center.z)
      .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
      .setFriction(0.82)
      .setRestitution(0.02);
    return this.world.createCollider(description);
  }

  addStaticCylinder(center: THREE.Vector3, halfHeight: number, radius: number): RAPIER.Collider {
    const description = RAPIER.ColliderDesc.cylinder(halfHeight, radius)
      .setTranslation(center.x, center.y, center.z)
      .setFriction(0.7)
      .setRestitution(0.05);
    return this.world.createCollider(description);
  }

  step(deltaSeconds: number): void {
    this.world.timestep = deltaSeconds;
    this.world.step(this.eventQueue);
  }

  /** Contact events must be drained right after step(), before the next step. */
  drainCollisionEvents(
    listener: (handleA: number, handleB: number, started: boolean) => void,
  ): void {
    this.eventQueue.drainCollisionEvents(listener);
  }

  castDown(origin: THREE.Vector3, maxDistance: number, exclude?: RAPIER.Collider): SurfaceHit | null {
    const ray = new RAPIER.Ray(origin, this.down);
    const hit = this.world.castRay(ray, maxDistance, true, undefined, undefined, exclude);
    if (!hit) return null;

    return {
      point: new THREE.Vector3(origin.x, origin.y - hit.timeOfImpact, origin.z),
      distance: hit.timeOfImpact,
    };
  }

  get raw(): RAPIER.World {
    return this.world;
  }

  get rapier(): typeof RAPIER {
    return RAPIER;
  }

  dispose(): void {
    this.eventQueue.free();
    this.world.free();
  }
}
