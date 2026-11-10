import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import * as THREE from 'three';

export interface FpvRenderState {
  /** 0 at hover, ~1 at freestyle top speed. */
  speedRatio: number;
  /** 0 at rest, ~1 during a hard throttle punch or a collision. */
  accelerationRatio: number;
  /** 0 on the deck, 1 at the legal ceiling. */
  altitudeRatio: number;
  /** 0 normally, ramps to 1 while the crashed-feed overlay is up. */
  crashAmount: number;
}

const NEUTRAL_STATE: FpvRenderState = {
  speedRatio: 0,
  accelerationRatio: 0,
  altitudeRatio: 0,
  crashAmount: 0,
};

/**
 * A screen-space pass that sells the FPV-camera look:
 * - a wide-angle barrel curve and altitude-dependent horizon bow;
 * - acceleration-weighted radial smear that is strongest at the left/right
 *   edges while the centre stays readable;
 * - chromatic fringing, vignette, sensor grain and a cool/warm grade.
 *
 * This deliberately contains no lens-droplet simulation. An earlier droplet
 * shader sampled the HDR buffer through a dense hash grid and produced green
 * block artefacts on Apple GPUs; the feed is now clean at every speed.
 */
class FpvGlassEffect extends Effect {
  constructor() {
    super(
      'FpvGlassEffect',
      /* glsl */ `
        uniform float uSpeed;
        uniform float uAcceleration;
        uniform float uAltitude;
        uniform float uCrash;

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
          vec2 safeUv = clamp(uv, vec2(0.0005), vec2(0.9995));

          vec2 centered = (safeUv - 0.5) * vec2(aspect, 1.0);
          float radius = length(centered);
          vec2 radialDir = normalize(centered + vec2(0.00001));

          // Wide-angle barrel. At altitude the horizon also bows downward
          // towards the edges: a very slight, physically-inspired Earth curve.
          float barrel = 0.012 + uAltitude * 0.012;
          vec2 warped = centered * (1.0 + barrel * radius * radius);
          float earthBow = smoothstep(0.38, 1.0, uAltitude) * 0.006;
          vec2 lensUv = vec2(0.5) + vec2(warped.x / max(aspect, 0.001), warped.y);
          lensUv.y -= centered.x * centered.x * earthBow;
          lensUv = clamp(lensUv, vec2(0.001), vec2(0.999));

          float edge = smoothstep(0.17, 0.96, radius);
          float edgeWeight = pow(edge, 1.35);
          float speedBlur = uSpeed * uSpeed * 17.0;
          float accelBlur = uAcceleration * 9.0 + uSpeed * uAcceleration * 15.0;
          float blurPixels = (speedBlur + accelBlur) * edgeWeight;
          vec2 blurOffset = radialDir * texelSize * blurPixels;

          // Five taps, pulled inward so the scene streaks outward past the
          // centre. The 0.17 smoothstep keeps the forward view crisp.
          vec3 color = texture2D(inputBuffer, lensUv).rgb * 0.34;
          color += texture2D(
            inputBuffer,
            clamp(lensUv - blurOffset * 0.24, vec2(0.001), vec2(0.999))
          ).rgb * 0.26;
          color += texture2D(
            inputBuffer,
            clamp(lensUv - blurOffset * 0.5, vec2(0.001), vec2(0.999))
          ).rgb * 0.18;
          color += texture2D(
            inputBuffer,
            clamp(lensUv - blurOffset * 0.78, vec2(0.001), vec2(0.999))
          ).rgb * 0.13;
          color += texture2D(
            inputBuffer,
            clamp(lensUv - blurOffset * 1.08, vec2(0.001), vec2(0.999))
          ).rgb * 0.09;

          float fringing = (0.3 + uSpeed * 2.2 + uAcceleration * 0.9) * edge;
          vec2 fringeOffset = radialDir * texelSize.y * fringing;
          color.r = texture2D(
            inputBuffer,
            clamp(lensUv + fringeOffset, vec2(0.001), vec2(0.999))
          ).r;
          color.b = texture2D(
            inputBuffer,
            clamp(lensUv - fringeOffset, vec2(0.001), vec2(0.999))
          ).b;

          // A light unsharp mask keeps roof lines and window frames crisp after
          // bloom, the way an in-camera FPV feed still resolves hard edges.
          vec3 localBlur = (
            texture2D(inputBuffer, clamp(lensUv + vec2(texelSize.x, 0.0), vec2(0.001), vec2(0.999))).rgb +
            texture2D(inputBuffer, clamp(lensUv - vec2(texelSize.x, 0.0), vec2(0.001), vec2(0.999))).rgb +
            texture2D(inputBuffer, clamp(lensUv + vec2(0.0, texelSize.y), vec2(0.001), vec2(0.999))).rgb +
            texture2D(inputBuffer, clamp(lensUv - vec2(0.0, texelSize.y), vec2(0.001), vec2(0.999))).rgb
          ) * 0.25;
          color += (color - localBlur) * 0.16;

          // The camera exposes for the moonlit sky, not the street lamps.
          color *= 1.45;

          float vignette = smoothstep(0.44, 1.25, radius);
          color *= 1.0 - vignette * (0.22 + uCrash * 0.12);

          float grain = hash12(safeUv * resolution + vec2(time * 53.0, -time * 41.0)) - 0.5;
          color += grain * (0.012 + uCrash * 0.02);

          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color = mix(
            color,
            color * vec3(0.91, 0.98, 1.08),
            (1.0 - smoothstep(0.0, 0.2, luma)) * 0.18
          );
          color = mix(
            color,
            color * vec3(1.045, 1.01, 0.955),
            smoothstep(0.55, 1.45, luma) * 0.12
          );

          // Crash grade: drained colour and a hot red edge.
          color = mix(color, vec3(luma) * 0.62, uCrash * 0.5);
          color += vec3(0.26, 0.008, 0.004)
            * uCrash * smoothstep(0.16, 1.08, radius) * 0.55;

          outputColor = vec4(color, inputColor.a);
        }
      `,
      {
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map<string, THREE.Uniform>([
          ['uSpeed', new THREE.Uniform(0)],
          ['uAcceleration', new THREE.Uniform(0)],
          ['uAltitude', new THREE.Uniform(0)],
          ['uCrash', new THREE.Uniform(0)],
        ]),
      },
    );
  }

  setState(state: FpvRenderState): void {
    const speed = this.uniforms.get('uSpeed');
    const acceleration = this.uniforms.get('uAcceleration');
    const altitude = this.uniforms.get('uAltitude');
    const crash = this.uniforms.get('uCrash');
    if (speed) speed.value = THREE.MathUtils.clamp(state.speedRatio, 0, 1.2);
    if (acceleration) acceleration.value = THREE.MathUtils.clamp(state.accelerationRatio, 0, 1);
    if (altitude) altitude.value = THREE.MathUtils.clamp(state.altitudeRatio, 0, 1);
    if (crash) crash.value = THREE.MathUtils.clamp(state.crashAmount, 0, 1);
  }
}

export class FpvPost {
  private readonly composer: EffectComposer;
  private readonly glass: FpvGlassEffect;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.composer.addPass(new RenderPass(scene, camera));

    const bloom = new BloomEffect({
      intensity: 0.92,
      luminanceThreshold: 0.62,
      luminanceSmoothing: 0.24,
      mipmapBlur: true,
      levels: 6,
      radius: 0.72,
    });
    this.composer.addPass(new EffectPass(camera, bloom));

    this.glass = new FpvGlassEffect();
    const toneMapping = new ToneMappingEffect({
      mode: ToneMappingMode.ACES_FILMIC,
    });
    // SMAA runs on the final LDR image, cleaning up roof edges, cables and
    // window frames the way a good temporal upscaler would.
    const smaa = new SMAAEffect();
    this.composer.addPass(new EffectPass(camera, this.glass, toneMapping, smaa));
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  render(deltaSeconds: number, state: FpvRenderState = NEUTRAL_STATE): void {
    this.glass.setState(state);
    this.composer.render(deltaSeconds);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
