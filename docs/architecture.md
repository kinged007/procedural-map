# Architecture

The canonical product boundary is `GameMap` v1.0. Generation, native JSON import, and future external import adapters produce this model. Consumers use the same geometry, semantic entities, and asset references regardless of source.

```
generation / import adapter -> GameMap -> validation -> export, renderer, game consumer
```

The library has no browser or DOM dependency. It ships as Node ESM in `dist/`. The browser studio is a separate Vite application in `dist-demo/` and uses the Canvas renderer.

## Modules

| Module                    | Responsibility                                                                 |
| ------------------------- | ------------------------------------------------------------------------------ |
| `generation`              | Resolves a seed and configuration into a deterministic, validated map.         |
| `map`                     | Defines `GameMap`, geometry types, and the JSON Schema.                        |
| `validation`              | Checks native data before it is imported, exported, or returned by generation. |
| `navigation`              | Bakes the walkability grid and answers where a character can walk and stand.   |
| `importers` / `exporters` | Round-trip canonical JSON without changing its semantic data.                  |
| `rendering`               | Draws a `GameMap` onto Canvas; it does not define map data.                    |
| `themes`                  | Provides visual values independently of map geometry.                          |

`NativeMapImporter` accepts a JSON string or object and returns a validated deep clone. `WatabouImporter` is present as an adapter boundary but is unsupported in this MVP: `canImport` returns `false` and `import` throws until a representative Watabou fixture schema is available. No game logic belongs in this library.

The MVP includes the `temperate` default theme. `MapTheme` lets a renderer substitute terrain, water, and vegetation colors without regenerating the map.

## Map guarantees

All geometry uses absolute world coordinates. Bounds define the valid rectangle from `(0, 0)` through `(width, height)`. The validator requires finite values, unique entity IDs, supported version `1.0`, valid geometry, and entity coordinates within the bounds. Generated trees do not overlap water.

Terrain classification is a separate stage over the generated fields. It contours the combined terrain and moisture score into `meadow` and `scrub` overlays using the same marching-squares module as water, kept in `generation/contours.ts`.

`metadataLayers` is optional canonical metadata. Generator output stores debug fields there so they survive native JSON export and import. Consumers may ignore these layers.

## Walkability

`navigation` is the only module that turns map geometry into something a game can read per frame. It
holds no state of its own and adds nothing to `GameMap`: `rasterizeWalkability` takes a map and
returns a grid, and `navigableRegions` and `spawnCandidates` take that grid and return positions. The
fill rule it uses, a cell is blocked if any part of it is covered by water or rock, is the same rule
the map already states about blocking features, so the grid and a consumer's own collision test cannot
drift apart.

Generation does not depend on `navigation`, and no map carries a baked grid. That keeps the canonical
format unchanged and keeps the grid a derived artefact a consumer can rebake at its own tile size.
