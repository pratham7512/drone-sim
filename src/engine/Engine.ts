import * as THREE from 'three';

/**
 * Owns the WebGL2 context, renderer, scene and flight camera.
 * The scene graph is kept here so post-processing can be wrapped around
 * the same render pass in a later milestone without touching game systems.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x03050b, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(74, 1, 0.055, 1200);
    this.camera.rotation.order = 'YXZ';

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

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);
    // Medium quality for the first pass. The quality manager will own this value.
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('diwali:context-lost'));
  };

  dispose(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.dispose();
    this.scene.clear();
    this.renderer.domElement.remove();
  }
}
