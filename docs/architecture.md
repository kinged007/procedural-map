# Architecture

The canonical product boundary is `GameMap` v1.2. Generation, native JSON import, and future external import adapters produce this model. Consumers use the same geometry, semantic entities, and asset references regardless of source.

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

The MVP includes the `temperate` default theme. `MapTheme` lets a renderer substitute terrain, water, and vegetation colors without regenerating the map. The renderer draws what the format publishes and nothing more: a delta at each mouth, no shore margin on a river because a lake's beach margin is wider than a river is, and no marker at all where a road crosses a river, because roads are drawn over the water and a marker there was a square in the wrong place. A building is drawn as a gable from its own published `position`, `rotation`, and size rather than from the order of its ring, so a map that wrote the ring the other way round still draws correctly. Buildings draw last, over the canopies, because a roof is a solid thing standing on the ground.

## Map guarantees

All geometry uses absolute world coordinates. Bounds define the valid rectangle from `(0, 0)` through `(width, height)`. The validator requires finite values, unique entity IDs, supported version `1.3`, valid geometry, and entity coordinates within the bounds. Generated trees do not overlap water, and no tree trunk is inside a building.

Terrain classification is a separate stage over the generated fields. It contours the combined terrain and moisture score into `meadow` and `scrub` overlays using the same marching-squares module as water, kept in `generation/contours.ts`.

`metadataLayers` is optional canonical metadata. Generator output stores debug fields there so they survive native JSON export and import. Consumers may ignore these layers.

## Rivers and bridges

`generation/rivers.ts` traces each course on the priority-flood drainage, and `generation/ribbon.ts`
holds the offset code shared with roads, so a channel and a road are the same kind of surface. A course
is cut where it first reaches standing water, and the site becomes a published mouth rather than a
channel drawn over a lake.

A bridge is not a map entity, and the renderer does not draw one. The road's `metadata.crossings` names
the river, the site, and the channel's width, and the road ribbon and the channel polygon are both on
the map, so the part of one centreline that is over the other is the bridge. A bridge the game owns is
an entity a consumer adds, which is why the site is data and the deck is not.

## Forests

`generation/forests.ts` groups the generated trees into groves after they are placed. Trees link to
their nearest neighbour within 26 units, the links are walked as connected components through spatial
buckets, and a component of three or more trees becomes a `ForestEntity`: the convex hull of its
trees, the trees themselves, a species taken from the majority, canopy cover, and a measured answer to
whether there is walkable ground inside the hull.

The hull exists for the read path. `navigation`'s `chunkTile` tests each forest's bounds box and then
only walks the trunks of the forests a chunk touches, so a chunk bake costs what the wood next to it
costs rather than what the whole map costs.

Linking by proximity chains in dense woodland, so an oversized component is split on its wider axis at
the median until each part holds at most 128 trees. Generation does depend on `navigation` for one
internal 8-unit raster, used only to measure `walkableInside` and discarded; the generated map carries
no grid, because the canonical format should not pin a consumer to one tile size.

## Walkability

`navigation` is the only module that turns map geometry into something a game can read per frame. It
holds no state of its own and adds nothing to `GameMap`: `rasterizeWalkability` takes a map and
returns a grid, and `navigableRegions` and `spawnCandidates` take that grid and return positions. The
fill rule it uses, a cell is blocked if any part of it is covered by water or rock, is the same rule
the map already states about blocking features, so the grid and a consumer's own collision test cannot
drift apart. A row is the union of its two boundary scanlines, which is exact while a ring's edges
cross them; an edge lying inside a row is a step neither boundary sees, so the row is widened across it.
That costs at most one row of cells per edge and cannot report a covered cell as open, which is the one
direction the grid is allowed to be wrong in.

Generation does not depend on `navigation`, and no map carries a baked grid. That keeps the canonical
format unchanged and keeps the grid a derived artefact a consumer can rebake at its own tile size.
