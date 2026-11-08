# Photo texture atlas placeholder

Milestone 1 uses runtime-generated procedural textures (plaster, roof concrete, wood, glow and rangoli) as stand-ins for the eventual photo atlas.

The texture milestone will replace them with:

- an atlas built from **original photography only** — no Street View, map tiles or scraped images;
- KTX2/Basis-compressed textures where supported, with PNG or JPG fallbacks selected at boot;
- a manifest of atlas regions and physically based material parameters, so materials can be swapped without changing terrace or building geometry.

Keep this directory empty until the original photography and compression pipeline are ready.
