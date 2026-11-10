# Mohalla asset plan

The city is not one large mesh. It is a set of small, independently built asset
families that share a scale, a palette and a placement rule. Every family is
instanced or merged into a single draw so that detail scales without tanking
the frame rate.

## Scale rules

| Thing | Real size we build to |
| --- | --- |
| Gali asphalt | 3.4 m |
| Arterial asphalt | 11.2 m |
| Pavement | 2.4 m |
| Floor-to-floor | 3.05 m |
| Parapet | 0.54 m high, 0.18 m thick |
| Shop opening | 2.4–3.4 m wide, 2.4 m high |
| Water tank | 1.1 m diameter, 1.4 m tall on a 0.6 m stand |
| Scooter | 1.8 m long |
| Auto-rickshaw | 2.6 m long |
| Street lamp | 3.4 m pole |

## Batch 1 — sky and horizon

This is the largest read at drone altitude, so it goes first.

- Deep cobalt zenith, warm sodium horizon, subtle airglow.
- Stars with magnitudes, colours and slow twinkle; a faint Milky Way band.
- Thin crescent moon with earthshine, craters and a hazy halo.
- Two layers of drifting smoke/cloud: low smog banks and higher cirrus, both
  under-lit warm by the city.
- Distant skyline ring beyond the streamed city: apartment towers, water tanks,
  temple shikhara, minarets and cell towers, with thousands of tiny windows and
  a few red aviation lamps.
- Horizon glow that reacts to the azimuth of the settlements.

Placement: attached to the camera, rendered before the city, no fog.

## Batch 2 — facade language

The box mass stays, but every box gets a readable street face.

- Plaster and paint: stronger mottling, rain streaks, patched brick, plinth
  grime, faded painted bands.
- Window modules: recessed dark glass, lit variants, concrete sills, grilles.
- Chajjas (sunshades) above selected windows, with drip stains underneath.
- Balconies with railings, brackets and laundry.
- Drainpipes, meter boxes, cable runs, AC condensers and brackets.
- Shopfronts: rolling shutters, lit counters, doorways, signboards, awnings.
- Street-facing paint ads and hand-painted number plates.

Placement: only on the street face plus occasional side/back faces, never on
all four faces of every building. Ground floor is the busiest.

## Batch 3 — roofline

From 30 m the roof is half of the visible city, so it cannot be a gray slab.

- Concrete slabs with patch tints, moss, water stains and parapet coping.
- Mumties (stair rooms) with doors, slumped roofs and a lit bulb.
- Sintex-style black water tanks on steel stands; a few pale older tanks.
- Solar water heaters (angled collector + horizontal tank).
- Clotheslines with individual garments, picket railings and rooftop gardens.
- Satellite dishes, TV antennas, pigeon coops, tyres, bricks and ladders.
- Festival layer: diyas along parapets, string lights, marigold garlands,
  rangoli near doorways.

Placement: structures live inside the parapet, never overhang the street.
Rooftop density increases on 2–3 storey buildings.

## Batch 4 — street life

The gali is the room between buildings; it needs the things people leave there.

- Utility poles with sagging cable bundles, transformers and meters.
- Open drains with gratings, kerb ramps, manholes and potholes.
- Parked scooters, cycles, cycle-rickshaws, autos, cars, mini-trucks.
- Vendor carts: fruit, chaat, chai, flowers, with umbrellas and hanging bulbs.
- Shrine niches, tulsi pots, door garlands, rangoli, diyas.
- Bins, sacks, crates, gas cylinders, tyres, bricks and construction rubble.
- Street dogs and pigeons as sparse silhouette accents, not a zoo.
- Trees: neem, peepal, palm and bougainvillea, with roots and tree guards.

Placement: pavement edge and gali walls first, then intersections, then empty
lots. Keep a 2.2 m walking line clear on arterials and a 1.4 m line in galis.

## Batch 5 — light and atmosphere

- Sodium pools on asphalt, warm spill on the first 3 m of every facade.
- Shop light, tube light, festival bulb and firework colour kept separate.
- Smoke density tied to the horizon; stars hidden near the glow.
- Ground haze and roof haze so the city dissolves into the skyline instead of
  ending at a hard black line.

## Build order and checks

1. Sky + skyline. Screenshot from 30 m.
2. Facade batch. Screenshot at 8 m and 30 m.
3. Roof batch. Screenshot looking down at 35 m.
4. Street batch. Screenshot at 4 m in a gali.
5. Lighting pass and budget check (`npm run build`, `npm run smoke`).

Budgets: ≤ 170 draw calls at spawn, ≤ 400 k triangles after climb, 60 fps on
the reference machine. New families are added one at a time and measured before
the next one lands.
