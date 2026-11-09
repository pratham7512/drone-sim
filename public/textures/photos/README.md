# CC0 photo textures

The terrace wall and roof use two 1K JPG surface scans from [Poly Haven](https://polyhaven.com/). Both assets are released under the [CC0 1.0 Universal licence](https://creativecommons.org/publicdomain/zero/1.0/); attribution is not required but is recorded here as good practice.

| Folder | Asset | Author | Source |
| --- | --- | --- | --- |
| `painted_plaster_wall/` | Painted Plaster Wall | Amal Kumar | https://polyhaven.com/a/painted_plaster_wall |
| `concrete_floor_worn_02/` | Concrete Floor Worn 02 | Dimitrios Savva | https://polyhaven.com/a/concrete_floor_worn_02 |

Each folder contains a diffuse (`diffuse.jpg`), tangent-space normal (`normal.jpg`) and roughness (`roughness.jpg`) map. The app loads them at boot and clones the wall map for the infinite city with its own UV repeat. If the files are missing or fail to load, `src/world/textures.ts` keeps the runtime procedural plaster and concrete textures so the scene still boots.

## Adding more photo surfaces

- Use original photography or a documented CC0/public-domain source. Do not add Street View, map tiles or scraped images.
- Keep a source URL, author and licence for every asset in this file.
- Prefer 1K or 2K JPG/PNG for now. The texture milestone will add KTX2/Basis compression with PNG/JPG fallback.
