# Diwali Night — A Mohalla Flight

A cinematic, browser-based FPV drone flight over a small Indian mohalla on Diwali night. Built with TypeScript, Vite, Three.js, Rapier and the Web Audio API.

**Milestone 1 is complete.** The experience boots into a dark, hand-built terrace above a placeholder mohalla skyline. You can fly a quadrotor in first person, hold altitude with hover assist, and inspect live render telemetry.

## Quick start

Requires Node.js 20+ and a browser with WebGL 2.

```bash
npm install
npm run dev          # http://localhost:5173
```

Production build and local preview:

```bash
npm run build
npm run preview      # http://localhost:4173
```

## Controls

| Input | Action |
| --- | --- |
| `W` / `S` | Fly forward / backward |
| `A` / `D` | Strafe left / right |
| `Q` / `E` | Yaw left / right |
| `Space` / `Shift` | Climb / sink (hold `Ctrl` to sink as well) |
| `H` | Toggle hover assist |
| `R` | Reset to the terrace |
| `` ` `` | Toggle render diagnostics |

The HUD shows heading, altitude, ground speed and hover-assist state. The greeting card dismisses on the first flight input or after ten seconds.

## Milestone 1 scope

- Vite + TypeScript boot with WebGL 2 explicitly requested and a readable fatal-error screen.
- Rapier WASM physics world at a fixed 60 Hz step, decoupled from render cadence.
- One authored terrace: parapets, mumty, water tank, AC unit, plants, warm window, akash kandil, string lights, diyas and a procedural rangoli.
- A non-collidable placeholder skyline with instanced building masses, lit window grids and rooftop clutter.
- Yaw-locked dynamic drone body with velocity-driven horizontal flight, visual banking, gravity feed-forward and a PD altitude hold.
- Nose-mounted FPV camera with subtle vibration, collision shake, speed FOV and a gentle bank.
- Sparse HUD, loading screen, procedural textures and diagnostic overlay.

Measured on the smoke run at 1440 × 900 in headless Chrome with the Metal ANGLE backend:

| Metric | Value | Budget |
| --- | --- | --- |
| Frame rate | ~60 fps | 60 fps mid-range laptop |
| Draw calls | 67 | < 120 |
| Triangles | 19,458 | < 150,000 |
| Points | 845 | — |
| Textures | 9 | < 128 MB |
| Initial JS | 4.95 MB (1.81 MB gzip) | < 15 MB excluding audio |

These numbers will move as the mohalla, effects and post-processing are added. The debug overlay is the source of truth during development.

## Architecture

```
src/
  engine/       renderer, fixed-step loop, Rapier wrapper, stats, math
  drone/        input, flight model, drone mesh, FPV camera
  world/        scene assembly, terrace, skyline, sky, procedural textures
  ui/           HUD, greeting and diagnostics
  audio/        reserved for the audio manifest and Web Audio graph
  fx/           reserved for fireworks, particles and post-processing
  tools/        reserved for layout import and asset conversion tools
```

- `Game` owns the orchestration and the fixed-update/render split.
- `DronePhysics` is the simulation authority. Rapier keeps the body upright; the controller drives horizontal velocity and vertical hold, while the visible airframe tilt is presentation-only.
- `World` owns static collision and atmosphere. The starting terrace has real colliders; the milestone-one skyline is deliberately non-collidable scenery.
- `Backdrop` batches its buildings, windows and rooftop props into instanced draws. Window halos and festive lights share custom point-sprite shaders so bloom-like warmth does not require post-processing yet.
- All textures are generated procedurally at runtime. The material interfaces are ready for a KTX2 photo atlas with PNG/JPG fallback.

## Asset policy

- No Google Street View, scraped imagery or third-party copyrighted audio.
- Current photoreal cues are procedural placeholders.
- Future photo atlases will be built from original photography, shipped as KTX2 where supported with PNG/JPG fallbacks.
- Audio will use an explicit manifest and will not embed copyrighted recordings.

See [`public/textures/photos/README.md`](public/textures/photos/README.md) and [`public/audio/README.md`](public/audio/README.md).

## Testing

The smoke test boots the app, verifies WebGL 2, climbs, flies forward, toggles diagnostics and hover assist, takes screenshots and fails on console errors or budget overruns.

```bash
# with the dev server running on a known port
SMOKE_URL=http://127.0.0.1:5199/ npm run smoke

# against a production preview
npm run build
npm run preview -- --port 4199
SMOKE_URL=http://127.0.0.1:4199/ npm run smoke
```

It uses the locally installed Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Override with `CHROME_PATH` if needed. Screenshots are written to `screenshots/` (ignored by git).

`window.__DIWALI_GAME__.getDebugState()` exposes readiness, position, speed, frame rate, draw calls, triangles, points and the active WebGL version for automation.

## Next systems

- Layout JSON and an OSM-derived mohalla massing, replacing the placeholder skyline with collidable lanes and rooftops.
- Original photo texture atlas with KTX2 + PNG/JPG fallback, shared materials and quality presets.
- Audio manifest, ambience beds, spatial firecracker bursts and a mute/volume setting.
- All firework shell types, light flashes, smoke and pooled particle effects.
- Altitude-blur/post-processing pass, landing pads and landing state machine.
- Help screen, input remapping, quality selector and expanded diagnostics.

## Known limitations

- Only the starting building is solid. The surrounding skyline is a painted backdrop.
- Keyboard flight only; touch and gamepad controls are not wired up yet.
- No audio, fireworks, post-processing, landing state machine or quality selector in milestone one.
- The greeting card is decorative and dismisses automatically; the full help screen comes later.
