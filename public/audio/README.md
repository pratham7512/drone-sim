# Audio assets

The drone soundtrack, firecracker pops, distant crackle tails and festival ambience are generated live with the Web Audio API in `src/audio/DroneAudio.ts`.

- `drone-crash.mp3` is the only recorded sample. It is an original recording made for this project and is used for the impact thump.
- The old recorded firecracker sample was removed. Firecrackers are now synthesised from filtered noise transients, so timing, pitch and level vary on every pop.
- Audio starts only after a user gesture, respects autoplay restrictions and can be muted with `M`.

Future ambience layers must follow the same policy: original synthesis, an original recording made for this project, or clearly licensed audio with a manifest and attribution. Never add scraped or copyrighted audio.
