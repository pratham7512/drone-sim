import { clamp, damp } from '../engine/math';

const MASTER_VOLUME = 0.55;

interface MotorVoice {
  oscillator: OscillatorNode;
  gain: GainNode;
  baseFrequency: number;
}

const AUDIO_ROOT = `${import.meta.env.BASE_URL}audio/`;

/**
 * FPV soundscape. The motor bed, firecracker pops and distant crackle tails are
 * synthesised. The only recording is the airframe crash one-shot, loaded from
 * `public/audio`; every other sound is generated from oscillators and shaped
 * noise so the mix stays original and licence-clean. The graph starts only
 * after a real user gesture so browsers allow playback.
 */
export class DroneAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private crashSample: AudioBuffer | null = null;
  private samplesPromise: Promise<void> | null = null;
  private motorGain: GainNode | null = null;
  private motorFilter: BiquadFilterNode | null = null;
  private propNoiseGain: GainNode | null = null;
  private propNoiseFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private whineOscillator: OscillatorNode | null = null;
  private whineGain: GainNode | null = null;
  private readonly motorVoices: MotorVoice[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private mutedState = false;
  private started = false;
  private updateTimer = 0;
  private elapsed = 0;
  private speedRatio = 0;
  private liftRatio = 0;
  private throttle = 0.5;

  get muted(): boolean {
    return this.mutedState;
  }

  /** True only when the graph exists and the context is actually running. */
  get running(): boolean {
    return this.started && this.context?.state === 'running';
  }

  /**
   * Idempotent. Safe to call on every gesture; resumes a suspended context and
   * creates the graph the first time. Must be called from an input handler.
   */
  async start(): Promise<void> {
    if (this.started) {
      if (this.context?.state === 'suspended') {
        await this.context.resume().catch(() => undefined);
      }
      return;
    }

    try {
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;

      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -8;
      compressor.knee.value = 10;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.28;

      const master = context.createGain();
      master.gain.value = 0;
      compressor.connect(master);
      master.connect(context.destination);
      this.master = master;

      const noiseBuffer = createNoiseBuffer(context);
      this.noiseBuffer = noiseBuffer;

      // The low, rough part of the sound: detuned saws through a soft filter.
      const motorFilter = context.createBiquadFilter();
      motorFilter.type = 'lowpass';
      motorFilter.frequency.value = 780;
      motorFilter.Q.value = 0.72;

      const motorGain = context.createGain();
      motorGain.gain.value = 0.1;
      motorFilter.connect(motorGain);
      motorGain.connect(compressor);
      this.motorFilter = motorFilter;
      this.motorGain = motorGain;

      const motorConfigs = [
        { type: 'sawtooth' as OscillatorType, base: 86, level: 0.42 },
        { type: 'sawtooth' as OscillatorType, base: 171, level: 0.18 },
        { type: 'square' as OscillatorType, base: 43, level: 0.14 },
      ];
      for (const config of motorConfigs) {
        const oscillator = context.createOscillator();
        oscillator.type = config.type;
        oscillator.frequency.value = config.base;
        oscillator.detune.value = this.motorVoices.length * 4 - 4;

        const gain = context.createGain();
        gain.gain.value = config.level;
        oscillator.connect(gain);
        gain.connect(motorFilter);
        oscillator.start();
        this.sources.push(oscillator);
        this.motorVoices.push({ oscillator, gain, baseFrequency: config.base });
      }

      // A narrow band of noise is the audible "prop wash" of a quad.
      const propNoise = context.createBufferSource();
      propNoise.buffer = noiseBuffer;
      propNoise.loop = true;
      const propNoiseFilter = context.createBiquadFilter();
      propNoiseFilter.type = 'bandpass';
      propNoiseFilter.frequency.value = 980;
      propNoiseFilter.Q.value = 0.62;
      const propNoiseGain = context.createGain();
      propNoiseGain.gain.value = 0;
      propNoise.connect(propNoiseFilter);
      propNoiseFilter.connect(propNoiseGain);
      propNoiseGain.connect(compressor);
      propNoise.start();
      this.sources.push(propNoise);
      this.propNoiseFilter = propNoiseFilter;
      this.propNoiseGain = propNoiseGain;

      // High, airy wind layer for speed.
      const wind = context.createBufferSource();
      wind.buffer = noiseBuffer;
      wind.loop = true;
      const windFilter = context.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 1200;
      windFilter.Q.value = 0.35;
      const windGain = context.createGain();
      windGain.gain.value = 0;
      wind.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(compressor);
      wind.start();
      this.sources.push(wind);
      this.windFilter = windFilter;
      this.windGain = windGain;

      // A faint motor whine that rises with RPM.
      const whine = context.createOscillator();
      whine.type = 'sine';
      whine.frequency.value = 1450;
      const whineGain = context.createGain();
      whineGain.gain.value = 0;
      whine.connect(whineGain);
      whineGain.connect(compressor);
      whine.start();
      this.sources.push(whine);
      this.whineOscillator = whine;
      this.whineGain = whineGain;

      this.started = true;
      await context.resume().catch(() => undefined);
      master.gain.setTargetAtTime(
        this.mutedState ? 0 : MASTER_VOLUME,
        context.currentTime,
        0.35,
      );
      void this.loadSamples(context);
    } catch {
      this.started = false;
      this.context = null;
    }
  }

  /**
   * The crash one-shot is the only recording. Kept best-effort: if the network
   * or decoder is unavailable, the synthesised layers still carry the effect.
   */
  private loadSamples(context: AudioContext): Promise<void> {
    if (this.samplesPromise) return this.samplesPromise;

    this.samplesPromise = (async () => {
      const load = async (file: string): Promise<AudioBuffer | null> => {
        try {
          const response = await fetch(`${AUDIO_ROOT}${file}`);
          if (!response.ok) return null;
          const data = await response.arrayBuffer();
          return await context.decodeAudioData(data);
        } catch {
          return null;
        }
      };

      this.crashSample = await load('drone-crash.mp3');
    })();

    return this.samplesPromise;
  }

  private playSample(
    buffer: AudioBuffer,
    start: number,
    level: number,
    playbackRate: number,
    destination: AudioNode,
    lowpass = 0,
  ): void {
    if (!this.context) return;
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;

    let node: AudioNode = source;
    if (lowpass > 0) {
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lowpass;
      filter.Q.value = 0.35;
      source.connect(filter);
      node = filter;
    }

    const gain = context.createGain();
    gain.gain.value = level;
    node.connect(gain);
    gain.connect(destination);
    source.start(start);
  }

  update(
    deltaSeconds: number,
    speedRatio: number,
    lift: number,
    active: boolean,
    crashed = false,
  ): void {
    if (!this.started || !this.context || !this.master) return;
    if (this.context.state !== 'running') return;

    this.elapsed += deltaSeconds;
    this.speedRatio = damp(this.speedRatio, clamp(speedRatio, 0, 1.25), 3.6, deltaSeconds);
    this.liftRatio = damp(this.liftRatio, clamp(lift, -1, 1), 5.2, deltaSeconds);

    const targetThrottle = clamp(
      0.5 + Math.abs(this.liftRatio) * 0.42 + this.speedRatio * 0.12 + (active ? 0.06 : 0),
      0.45,
      1.18,
    );
    this.throttle = damp(this.throttle, targetThrottle, 4.5, deltaSeconds);

    this.updateTimer += deltaSeconds;
    if (this.updateTimer < 0.05) return;
    this.updateTimer = 0;

    const now = this.context.currentTime;
    const speed = this.speedRatio;
    const throttle = this.throttle;
    const pulse = 0.94 + Math.sin(this.elapsed * 23.7) * 0.045;

    if (crashed) {
      // A broken quad has no spinning motors; only the crash one-shot and the
      // dead-camera static should remain.
      this.motorGain?.gain.setTargetAtTime(0, now, 0.04);
      this.propNoiseGain?.gain.setTargetAtTime(0, now, 0.04);
      this.windGain?.gain.setTargetAtTime(0, now, 0.04);
      this.whineGain?.gain.setTargetAtTime(0, now, 0.04);
      for (const voice of this.motorVoices) {
        voice.gain.gain.setTargetAtTime(0, now, 0.04);
      }
      return;
    }

    const pitch = 0.94 + throttle * 0.09 + speed * 0.07;
    for (let index = 0; index < this.motorVoices.length; index += 1) {
      const voice = this.motorVoices[index]!;
      voice.oscillator.frequency.setTargetAtTime(voice.baseFrequency * pitch, now, 0.08);
      voice.gain.gain.setTargetAtTime(
        (index === 0 ? 0.42 : index === 1 ? 0.17 : 0.13) * (0.75 + throttle * 0.45),
        now,
        0.1,
      );
    }

    this.motorFilter?.frequency.setTargetAtTime(
      520 + throttle * 620 + speed * 720,
      now,
      0.1,
    );
    this.motorGain?.gain.setTargetAtTime(
      (0.09 + throttle * 0.07 + speed * 0.025) * pulse,
      now,
      0.08,
    );
    this.propNoiseFilter?.frequency.setTargetAtTime(820 + speed * 1900 + throttle * 180, now, 0.1);
    this.propNoiseGain?.gain.setTargetAtTime(
      0.006 + speed * 0.085 + Math.abs(this.liftRatio) * 0.018,
      now,
      0.09,
    );
    this.windFilter?.frequency.setTargetAtTime(700 + speed * 2300, now, 0.12);
    this.windGain?.gain.setTargetAtTime(speed * speed * 0.15 + speed * 0.012, now, 0.12);
    this.whineOscillator?.frequency.setTargetAtTime(1350 + throttle * 300 + speed * 1150, now, 0.1);
    this.whineGain?.gain.setTargetAtTime(0.0025 + speed * 0.0075, now, 0.12);
  }

  /**
   * One-shot Diwali firecracker. The old recording was replaced by a fully
   * synthesised "phataka": a supersonic paper crack, a short chest thump, a
   * scatter of burning-paper snaps and two delayed street echoes. `pan` is the
   * horizontal offset relative to the pilot and the sound is delayed by the
   * real speed of sound.
   */
  playFirecracker(
    distance: number,
    pan: number,
    kind: 'launch' | 'burst' = 'burst',
  ): void {
    if (!this.started || !this.context || !this.master || !this.noiseBuffer) return;
    if (this.mutedState || this.context.state !== 'running') return;

    const context = this.context;
    const range = clamp(distance, 0, 200);
    // Real sound takes about 3 ms per metre. At rooftop distance this reads
    // as the natural lag between the flash and the report.
    const arrival = context.currentTime + 0.012 + Math.min(0.32, range / 343);
    // City crackers are sharp, not cinematic explosions. Keep them present but
    // noticeably quieter than the old sample-based burst.
    const level = kind === 'launch'
      ? clamp(0.32 / (1 + range * 0.03), 0.025, 0.32)
      : clamp(0.92 / (1 + range * 0.024), 0.1, 0.92);

    const panner = context.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);

    // Per-shot limiter: the crack can be genuinely loud without clipping the
    // drone bed or the destination.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.16;

    const bus = context.createGain();
    bus.gain.value = level;

    // Air absorption: distant crackers lose their high snap and become a dull
    // thump with a long tail.
    const air = context.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = clamp(19000 - range * 135, 2200, 19000);
    air.Q.value = 0.28;

    bus.connect(air);
    air.connect(limiter);
    limiter.connect(panner);
    panner.connect(this.master);

    if (kind === 'launch') {
      // A rocket is a paper hiss with a short rising whistle, not a boom.
      const pitch = 0.88 + Math.random() * 0.24;
      this.noiseBurst(arrival, 0.7, 'bandpass', 2300 * pitch, 0.7, 0.3, bus);
      this.toneSweep(arrival, 340 * pitch, 1180 * pitch, 0.52, 0.08, bus, 'sine');
      this.noiseBurst(arrival + 0.5, 0.16, 'highpass', 4200, 0.6, 0.05, bus);
    } else {
      const detune = 0.9 + Math.random() * 0.2;

      // The crack: a very short, bright paper snap. Two bands stop it reading
      // as a generic gunshot.
      this.noiseBurst(arrival, 0.014, 'highpass', 7600, 0.75, 0.8, bus);
      this.noiseBurst(arrival + 0.001, 0.028, 'bandpass', 3900 * detune, 1.1, 0.68, bus);

      // The body: compressed air and a low thump that survives phone speakers.
      this.noiseBurst(arrival + 0.002, 0.24, 'lowpass', 340 * detune, 0.8, 0.44, bus);
      this.toneSweep(arrival, 128 * detune, 34, 0.34, 0.4, bus, 'sine');

      // Paper tearing and the burning fuse tail. Short, dry, irregular.
      const snaps = 9 + Math.floor(Math.random() * 4);
      for (let index = 0; index < snaps; index += 1) {
        const start = arrival + 0.06 + Math.random() * 0.72;
        this.noiseBurst(
          start,
          0.012 + Math.random() * 0.028,
          index % 3 === 0 ? 'highpass' : 'bandpass',
          1800 + Math.random() * 5200,
          1.4,
          0.025 + Math.random() * 0.07,
          bus,
        );
      }

      // Two slaps back from the surrounding walls. This is what makes a
      // mohalla cracker feel like it happened between buildings.
      this.noiseBurst(arrival + 0.17, 0.09, 'lowpass', 1150, 0.5, 0.12, bus);
      this.noiseBurst(arrival + 0.34, 0.14, 'lowpass', 760, 0.45, 0.075, bus);
      this.toneSweep(arrival + 0.18, 72, 30, 0.3, 0.08, bus, 'sine');
    }

    // Let the one-shot graph disappear once its tail has decayed.
    window.setTimeout(() => {
      bus.disconnect();
      air.disconnect();
      limiter.disconnect();
      panner.disconnect();
    }, 2400);
  }

  /** Hard impact plus a dead analogue video feed. */
  playCrash(): void {
    if (!this.started || !this.context || !this.master || !this.noiseBuffer) return;
    if (this.mutedState || this.context.state !== 'running') return;

    const context = this.context;
    const now = context.currentTime + 0.008;

    const bus = context.createGain();
    bus.gain.value = 1.15;

    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 1;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0008;
    limiter.release.value = 0.2;

    bus.connect(limiter);
    limiter.connect(this.master);

    // Real quadcopter impact: plastic, props and loose debris. The synthetic
    // layers underneath add the heavy low thump the small speaker misses.
    if (this.crashSample) {
      this.playSample(this.crashSample, now, 1.55, 0.96 + Math.random() * 0.08, bus, 9000);
    }
    this.noiseBurst(now, 0.55, 'lowpass', 330, 0.9, 0.72, bus);
    this.toneSweep(now, 96, 23, 0.8, 0.85, bus, 'sine');
    this.noiseBurst(now, 0.045, 'highpass', 3000, 0.7, 0.5, bus);
    this.noiseBurst(now + 0.03, 0.12, 'bandpass', 900, 0.8, 0.28, bus);

    // Electronics shorting out as the feed dies.
    this.toneSweep(now + 0.015, 2200, 70, 0.24, 0.35, bus, 'sawtooth');
    this.noiseBurst(now + 0.04, 2.25, 'highpass', 1900, 0.5, 0.17, bus);
    for (let index = 0; index < 10; index += 1) {
      this.noiseBurst(
        now + 0.08 + Math.random() * 2.15,
        0.014 + Math.random() * 0.04,
        'bandpass',
        1200 + Math.random() * 6000,
        2,
        0.05 + Math.random() * 0.12,
        bus,
      );
    }

    window.setTimeout(() => {
      bus.disconnect();
      limiter.disconnect();
    }, 3400);
  }

  private noiseBurst(
    start: number,
    duration: number,
    type: BiquadFilterType,
    frequency: number,
    q: number,
    level: number,
    destination: AudioNode,
  ): void {
    if (!this.context || !this.noiseBuffer) return;
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;

    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  private toneSweep(
    start: number,
    fromFrequency: number,
    toFrequency: number,
    duration: number,
    level: number,
    destination: AudioNode,
    type: OscillatorType,
  ): void {
    if (!this.context) return;
    const context = this.context;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(fromFrequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(1, toFrequency),
      start + duration,
    );

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  toggleMute(): boolean {
    this.mutedState = !this.mutedState;
    if (this.context && this.master) {
      this.master.gain.setTargetAtTime(
        this.mutedState ? 0 : MASTER_VOLUME,
        this.context.currentTime,
        0.08,
      );
    }
    return this.mutedState;
  }

  dispose(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // The source may already have stopped with its context.
      }
    }
    this.sources.length = 0;
    this.motorVoices.length = 0;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.noiseBuffer = null;
    this.started = false;
  }
}

function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const seconds = 2;
  const length = context.sampleRate * seconds;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let smoothed = 0;
  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    smoothed = smoothed * 0.94 + white * 0.06;
    data[index] = clamp(white * 0.38 + smoothed * 2.1, -1, 1);
  }
  return buffer;
}
