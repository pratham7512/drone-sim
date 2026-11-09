# Synthesised audio only

This folder intentionally contains no audio files.

The drone soundtrack is generated live with the Web Audio API in `src/audio/DroneAudio.ts`:

- three detuned oscillator voices through a low-pass filter for the motors;
- band-limited noise for prop wash and wind;
- a sine whine tied to motor RPM;
- a compressor and master gain for level control.

Pitch, filter cutoff, prop-wash level and wind level follow commanded lift and actual ground speed. A tiny pulse adds roughness without masking conversation. Audio starts only after a user gesture, respects autoplay restrictions and can be muted with `M`.

Future firework and ambience layers must follow the same policy: original synthesis or clearly licensed recordings with a manifest and attribution. Never add scraped or copyrighted audio.
