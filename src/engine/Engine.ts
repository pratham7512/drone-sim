import * as THREE from 'three';
import { FpvPost, type FpvRenderState } from '../fx/FpvPost';

/**
 * Owns the WebGL2 context, renderer, scene, flight camera and the FPV
 * post-processing pipeline. Keeping the composer here means window resizes and
 * the final render path stay in one place.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly post: FpvPost;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly onWindowResize = () => this.resize();

  constructor(container: HTMLElement) {
    this.container = container;

    const canvas = document.createElement('canvas');
    canvas.tabIndex = -1;

    const context = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    if (!context) {
      throw new Error('WebGL 2 is not available in this browser.');
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping happens at the end of the post pipeline so that bloom and
    // depth of field work on a linear HDR image.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The composer renders the scene plus several fullscreen passes. Disable
    // per-render resets so the HUD sees the cost of the whole frame.
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x03050b, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(82, 1, 0.055, 1200);
    this.camera.rotation.order = 'YXZ';
    // Camera children (the front props and arms) need the camera in the scene
    // graph to receive world-matrix updates.
    this.scene.add(this.camera);

    this.post = new FpvPost(this.renderer, this.scene, this.camera);

    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'First-person view from a drone above a Diwali-night mohalla');
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.container.appendChild(canvas);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    window.addEventListener('resize', this.onWindowResize, { passive: true });
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  render(deltaSeconds = 0, state?: FpvRenderState): void {
    this.renderer.info.reset();
    this.post.render(deltaSeconds, state);
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);
    // Medium quality for the first pass. The quality manager will own this value.
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.post.setSize(width, height);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('diwali:context-lost'));
  };

  dispose(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.post.dispose();
    this.renderer.dispose();
    this.scene.clear();
    this.renderer.domElement.remove();
  }
}
