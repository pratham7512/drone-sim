import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * A CC0 landmark building from Kenney's City Kit (Commercial). The kit gives
 * the high street a handful of authored, readable buildings with real doors,
 * awnings, roof geometry and window trim, while the bulk of the mohalla stays
 * procedural. Loading is best-effort: if the files are absent the city falls
 * back to the generated masses without failing to boot.
 */
export interface CityPrefab {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Native dimensions in metres after normalising the base to y = 0. */
  width: number;
  depth: number;
  height: number;
}

const PREFAB_ROOT = `${import.meta.env.BASE_URL}models/kenney-city/`;

const PREFAB_FILES = [
  'building-a.glb',
  'building-e.glb',
  'building-f.glb',
  'building-k.glb',
  'building-skyscraper-a.glb',
  'low-detail-building-wide-b.glb',
] as const;

export async function loadCityPrefabs(maxAnisotropy: number): Promise<CityPrefab[]> {
  const loader = new GLTFLoader();
  const results = await Promise.all(
    PREFAB_FILES.map((file) => loadPrefab(loader, file, maxAnisotropy)),
  );
  return results.filter((prefab): prefab is CityPrefab => prefab !== null);
}

async function loadPrefab(
  loader: GLTFLoader,
  file: string,
  maxAnisotropy: number,
): Promise<CityPrefab | null> {
  try {
    const gltf = await loader.loadAsync(`${PREFAB_ROOT}${file}`);
    gltf.scene.updateMatrixWorld(true);

    const parts: THREE.BufferGeometry[] = [];
    let material: THREE.Material | null = null;

    gltf.scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const geometry = child.geometry.clone();
      geometry.applyMatrix4(child.matrixWorld);
      parts.push(geometry);
      if (!material) {
        const source = Array.isArray(child.material) ? child.material[0] : child.material;
        if (source) material = source.clone();
      }
    });

    if (parts.length === 0 || !material) return null;

    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) return null;

    // The kit is authored on a small unit grid. Normalise the base to y = 0
    // and the footprint centre to the origin so the instancing matrix can be
    // placed exactly like a procedural building.
    merged.computeBoundingBox();
    const bounds = merged.boundingBox;
    if (!bounds) {
      merged.dispose();
      return null;
    }
    const width = bounds.max.x - bounds.min.x;
    const depth = bounds.max.z - bounds.min.z;
    const height = bounds.max.y - bounds.min.y;
    merged.translate(
      -(bounds.min.x + bounds.max.x) / 2,
      -bounds.min.y,
      -(bounds.min.z + bounds.max.z) / 2,
    );
    merged.computeBoundingSphere();

    const standard = material as THREE.MeshStandardMaterial;
    if (standard.map) {
      standard.map.anisotropy = Math.max(1, Math.min(8, maxAnisotropy));
      standard.map.needsUpdate = true;
    }
    standard.roughness = 0.9;
    standard.metalness = 0.02;
    standard.side = THREE.FrontSide;
    // A whisper of warmth keeps the prefabs from going pure black before the
    // street lights reach them.
    standard.emissive = new THREE.Color(0x120b06);
    standard.emissiveIntensity = 0.7;
    standard.needsUpdate = true;

    return {
      name: file.replace('.glb', ''),
      geometry: merged,
      material,
      width,
      depth,
      height,
    };
  } catch {
    return null;
  }
}
