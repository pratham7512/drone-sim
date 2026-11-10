# Diwali Night — A Mohalla Flight

A cinematic, browser-based FPV drone flight over a small Indian mohalla on Diwali night. Built with TypeScript, Vite, Three.js, Rapier and the Web Audio API.

**Milestone 1 is complete, including the realism pass.** The experience boots into a terrace above a live, endless mohalla. You fly a quadrotor in first person with camera-mounted front props, depth of field, lens droplets, film grain and a fully synthesised motor/wind soundtrack. The surrounding city repeats on a 512 m period and streams colliders around the camera, so there is no hard flight boundary.

## Quick start

Requires Node.js 20+ and a browser with WebGL 2.

```bash
npm install
npm run dev          # http://localhost:5173
```

If port 5173 is already taken:

```bash
npm run dev -- --port 5199 --host 127.0.0.1   # http://127.0.0.1:5199
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
| `H` | Lock the current altitude (press `H` or `Space` again to unlock) |
| `T` | Toggle acro mode |
| `M` | Mute / unmute the synthesised audio |
| `R` | Reset to the terrace |
| `` ` `` | Toggle render diagnostics |

The HUD shows heading, altitude, ground speed and a persistent `ALT LOCK` badge while altitude hold is engaged. Pressing `H` pins the exact height; the quad holds it while you steer, and pressing `H` or tapping `Space` releases it. The pre-flight card dismisses on takeoff and returns on touchdown. Audio starts after the first click or key press because browsers require a user gesture.

## What is in this build

- Vite + TypeScript boot with WebGL 2 explicitly requested and a readable fatal-error screen.
- Rapier WASM physics world at a fixed 60 Hz step, decoupled from render cadence.
- One authored terrace: parapets, mumty, water tank, AC unit, plants, warm window, akash kandil, string lights, diyas and a procedural rangoli.
- Infinite, shader-wrapped mohalla: 325 instanced buildings, lit window grids, rooftop tanks, mumties, antennas, festival bulbs and street-lamp glow. The layout repeats every 512 m and the nearest buildings stream into Rapier as the drone moves.
- Yaw-locked dynamic drone body with velocity-driven horizontal flight, visual banking, gravity feed-forward and a PD altitude hold. Horizontal speed tops out at 18.5 m/s.
- Nose-mounted FPV camera with vibration, collision shake, speed FOV, bank and two camera-attached front propellers that stay sharp while the city falls into bokeh.
- HDR post-processing: depth of field focused on the front props, bloom, screen-space lens droplets with refraction/specular, radial speed smear, chromatic fringing, vignette, grain and ACES tone mapping.
- CC0 photo-scanned plaster and concrete textures on the terrace, with runtime procedural fallbacks.
- Synthesised FPV sound: three detuned motor voices, prop-wash noise, wind and a motor whine that follow speed and lift. No recorded or copyrighted audio.
- Sparse HUD, loading screen, diagnostic overlay and a Playwright smoke test.

## Performance

Measured on the smoke run at 1440 × 900 in headless Chrome with the Metal ANGLE backend:

| Metric | Value | Budget |
| --- | --- | --- |
| Frame rate | ~60 fps | 60 fps mid-range laptop |
| Draw calls | 96 | < 120 |
| Triangles | 50,120 | < 150,000 |
| Points | 1,034 | — |
| Textures | 38 | < 128 MB |
| Initial JS | 5.06 MB (1.84 MB gzip) | < 15 MB excluding audio |
| Photo textures | ~3.6 MiB on disk | included in the initial load |

The debug overlay is the source of truth during development. The city is drawn through a GPU wrap in the vertex shader, so extending the flight does not grow the draw-call count.

## Architecture

```
src/
  engine/       renderer, post composer ownership, fixed-step loop, Rapier wrapper, stats, math
  drone/        input, flight model, drone mesh, FPV camera, camera-mounted front props
  world/        scene assembly, terrace, infinite mohalla, sky, photo/procedural textures
  ui/           HUD, greeting and diagnostics
  audio/        synthesised Web Audio graph
  fx/           post-processing composer and custom lens effect
  tools/        reserved for layout import and asset conversion tools
```

- `Game` owns orchestration, photo loading, the fixed-update/render split and debug state.
- `DronePhysics` is the simulation authority. Rapier keeps the body upright; the controller drives horizontal velocity and vertical hold, while the visible airframe tilt is presentation-only.
- `World` owns static collision and atmosphere. The terrace and streamed city buildings have real colliders; the ground collider follows the camera.
- `Backdrop` GPU-wraps every city instance to the copy nearest the camera. Buildings, windows, rooftop props and lights are each batched into instanced draws.
- `FpvPost` owns the HalfFloat composer. Depth of field runs first, then bloom, then a custom glass/lens effect and ACES tone mapping. The renderer itself uses `NoToneMapping`.
- `FpvRig` attaches two shader-driven three-blade props to the camera. They are near the focus plane, so they stay crisp while the city softens.
- `DroneAudio` builds its graph lazily after a gesture, then modulates pitch, filter cutoff and prop-wash level from speed and lift.
- Photo texture loads are optional: `loadPhotoTextures` falls back to the procedural wall and roof sets if the files are unavailable.

## Asset policy

- No Google Street View, map tiles, scraped imagery or third-party copyrighted audio.
- The two surface scans are CC0 from [Poly Haven](https://polyhaven.com/): `painted_plaster_wall` by Amal Kumar and `concrete_floor_worn_02` by Dimitrios Savva. Attribution and source links are recorded in [`public/textures/photos/README.md`](public/textures/photos/README.md).
- The drone bed, wind, firecracker pops and crackle tails are synthesised at runtime with the Web Audio API. `public/audio/drone-crash.mp3` is the only sample, an original recording made for this project.
- Kenney's [City Kit (Commercial)](https://kenney.nl/assets/city-kit-commercial) buildings are CC0. Six authored GLBs are used as arterial landmarks, while the rest of the mohalla is procedural. The licence is included at [`public/models/kenney-city/LICENSE.txt`](public/models/kenney-city/LICENSE.txt).
- Procedural wall, roof, wood, glow and rangoli textures remain available as fallbacks.

## Testing

The smoke test boots the app, verifies WebGL 2, climbs, flies forward, toggles diagnostics, checks that `H` locks the current altitude and that `H` or `Space` releases it, confirms the pre-flight card hides in flight, mutes and unmutes audio, takes screenshots and fails on console errors, warnings, failed requests or budget overruns.

```bash
# with the dev server running on a known port
SMOKE_URL=http://127.0.0.1:5199/ npm run smoke

# against a production preview
npm run build
npm run preview -- --port 4199
SMOKE_URL=http://127.0.0.1:4199/ npm run smoke
```

It uses the locally installed Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Override with `CHROME_PATH` if needed. Screenshots are written to `screenshots/` (ignored by git).

`window.__DIWALI_GAME__.getDebugState()` exposes readiness, position, speed, frame rate, draw calls, triangles, points, WebGL version, audio state, city building/collider counts, city period and feature flags for automation.

## Next systems

- Layout JSON and an OSM-derived mohalla massing with more varied architecture, balconies, shopfronts and lanes.
- KTX2/Basis compression for the photo textures with PNG/JPG fallback, plus material quality presets.
- Fireworks: all shell types, light flashes, smoke and pooled particle effects.
- Landing pads, landing state machine and a proper help screen.
- Touch and gamepad controls, input remapping and a quality selector.

## Known limitations

- Buildings are primitive masses dressed with window planes and rooftop props; close inspection still reveals the low-poly construction.
- Colliders stream within roughly 115 m of the camera. Flight beyond that is still possible, but distant buildings are scenery until the stream catches up.
- The infinite city repeats every 512 m. Fog and night lighting hide the seam, but the pattern is deliberately periodic.
- Lens droplets are a screen-space effect, not physical fluid on a lens mesh.
- Keyboard flight only; touch and gamepad controls are not wired up yet.
- No fireworks, landing state machine or quality selector yet.
