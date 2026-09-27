# Navigation and packaging plan

The commission a game team codes against. Every item is a feature the generator owns, so nothing
here needs a workaround on the game side. Ordered by what unblocks the most.

Two things are explicitly **not** gaps: themes (the `asset.variant` vocabulary is already complete and
resolved game-side), and buildings, road collision, heightmap, navmesh, region naming.

## Status

| Item                                      | State           | Gate                                                         |
| ----------------------------------------- | --------------- | ------------------------------------------------------------ |
| P0 installable package                    | done, `6efdc30` | tarball installs and generates a map from a separate project |
| C1 walkability raster                     | done, `6efdc30` | `tests/worstcase.test.mjs`, raster vs `pointInPolygon`       |
| C2 navigable regions and spawn candidates | done, `6efdc30` | `tests/navigation.test.mjs`, 15 tests                        |
| C3 forest entity                          | done, `86dd475` | `tests/forests.test.mjs`, 13 tests                           |
| C4 world-space fields and tile origin     | done            | `tests/tiling.test.mjs`, 10 tests                            |

## Recorded baseline

4096x4096 at the 8,000 tree ceiling, printed on every run of `tests/worstcase.test.mjs`.

| Measurement                    | Measured                         | Bound in the gate |
| ------------------------------ | -------------------------------- | ----------------- |
| Whole-world bake, cellSize 4   | p95 5-20ms, load dependent       | < 250ms           |
| Per-chunk bake, 8,000 trees    | p50 0.10-0.31ms, p95 0.13-0.77ms | < 2ms             |
| 20,000 lookups, 1280² vs 4096² | 2.2ms vs 1.9ms                   | ratio < 2x        |

The per-chunk range is idle to loaded, measured on the same machine. It matters that the timing noise
band is wider than the regression the broadphase removed, so a wall-clock bound cannot be tightened to
the idle reading without becoming a gate against the machine's own load. The gate for the broadphase is
deterministic instead, in `tests/forests.test.mjs`: it counts the trunks a point reaches and asserts
the mean does not grow with map size.

A sweep of 144 map and cell-size combinations, 6.1M open cells, found zero cells that read open while
a blocker covered them. That is the one direction the fill rule must never fail.

## Decisions taken

- **Package name.** `@fieldwork` belongs to another account, so it can never be published from here.
  Bare `fieldwork` and `procedural-map` are both taken on npm. The name is `fieldwork-map`.
- **Connectivity is four-way.** The raster already blocks any cell a blocker touches, so the gaps it
  leaves are at least a cell wide, and a character wider than a cell cannot cross a diagonal pinch.
  Eight-way would join regions across a corner the character cannot pass, which is the exact failure
  navigable regions exist to prevent.
- **`spawnCandidates(raster, map, options)`** takes the map as well as the raster. Clearance is
  measured against a grid that holds no trees, so without a trunk check the roomiest ground on a
  wooded map is the inside of a trunk.
- **Trees stay out of the raster.** A trunk is a small circle inside a large canopy; baking the canopy
  would seal the clearings between trees.

## C3 — forest entity

Vegetation is a flat list of trees, so a grove is not an object. The game has to test every tree in
the map to learn whether a point is near wood, and the count of tests grows with the map.

```
ForestEntity extends MapEntity {
  type: 'forest'
  species: 'mixed' | 'oak' | 'birch'
  geometry: PolygonGeometry      // grove hull: broadphase, render, minimap
  trees: Array<{ position, radius, rotation, species, collision: { circle } }>
  asset: { category: 'vegetation.forest', variant: 'oak-1' }
  metadata: { treeCount, densityPct, walkableInside: boolean }
}
```

- Group the trees that are already placed with union-find at a link radius. Deterministic,
  order-independent, and it reuses the existing rejection sampling, so tree counts and the existing
  vegetation tests do not move. A component too small to be a grove stays a bare tree.
- The hull is a convex hull, for the broadphase test and the minimap.
- **`ForestEntity.collision` is absent on purpose.** The hull is not a collision shape, because the
  clearings inside a grove have to stay walkable. This is the one deliberate break from the rule that
  every blocking feature carries collision, so the schema states it rather than leaving it implied.
- `walkableInside` is measured from the walkability raster rather than assumed, so the claim about
  clearings is checked.
- `map.forests` is a new collection. The format version moves to **1.1** and `forests` joins
  `required`, matching `structures` and `barriers`. No 1.0 compatibility path: nothing persisted
  depends on the old version.
- A tree appears in both `vegetation` and `forests[].trees`, and the validator requires the two to
  agree, so the two copies cannot drift.

The property that justifies the work: a point-in-wood test becomes a hull bounds check plus the trunks
of the one forest that matched, instead of a scan over every tree on the map.

## What C3 turned out to need

Four things the design above did not say, all found by measuring rather than by reading the code.

- **A grove needs a size cap.** Trees link by proximity, so in dense woodland the links chain: on a
  4096x4096 default, one component held 1,021 trees. A hull over a thousand trees narrows nothing, and
  a consumer testing it has to test a thousand trunks next, which is the cost the hull exists to avoid.
  An oversized component is now split on its wider axis at the median until each part holds at most 128. Splitting on proximity alone would break a wood into arbitrary pieces; the median keeps the
  pieces roughly square, which is the shape a hull is cheapest to represent.
- **A point reaches a bounded number of trunks, and that bound does not grow with the map.** This is
  the property to assert, not a hull share of map area, which is arbitrary. Measured over 2,000
  pseudo-random points: 18.0 trunks per point on a 2048 map and 18.1 on a 4096 map carrying 8,000
  trees. Worst case 243, under 4% of the tree count.
- **The broadphase pays 6x to 10x on a realistic chunk**, not on a large one. A 1024-world-unit chunk
  spans so much ground that it touches most groves regardless, and the gain there is 2x. The gain
  comes from the tight chunk a character actually occupies: at 32 world units, a 4096 map bakes in
  0.045ms against 0.29ms scanning every tree.
- **`densityPct` had to be defined, not just named.** The raw ratio of canopy area to hull area reached
  2,285% on a dense map, because canopies overlap freely. Cover cannot exceed the ground it stands on,
  so it is saturated at 100.

One thing deliberately not built: the grove bounds are still scanned as a flat list per chunk, so a
bake follows the grove count rather than the tree count. Indexing the bounds into a uniform grid is
the obvious next step and is not needed at 0.045ms per chunk. Add it when a bake shows up in a frame
budget.

## C4 — world-space fields and tile origin

`generateFields` normalises noise to the tile's own bounds, so two adjacent tiles have no relationship
to each other. Placed side by side they produce a discontinuous world with mismatched shorelines and
roads that dead-end at the seam.

```
generateMap({ ..., origin?: { x, y }, world?: { width, height } })
```

- Fields sampled at `origin + local` in world space, and every quantile taken from a world-wide
  sample rather than the tile's own. That covers the water level and the rock, meadow and scrub
  thresholds: rock is elevation at the 94th percentile, so it seams exactly as badly as the waterline
  if only the water level is fixed.
- With `origin` defaulting to the origin and `world` to the tile bounds, **existing configs produce a
  byte-identical map**, so this is a strict superset and the stability hash does not move.
- The walkability raster stays tile-local, because it derives from tile geometry. The chunk lookup
  subtracts `origin`.
- The world extent is bounded by field resolution rather than by a size check: the field grid stays
  capped at 64x64, so a very large world gets visibly blocky terrain. Raise the cap when that bites.

## What C4 turned out to need

Three things the design above did not say, all found by measuring rather than by reading the code.

- **The byte-identical claim needed a caveat, and the caveat turned out to be small.** The resolved
  config is exported in `metadataLayers.generation`, so adding `origin` and `world` to it moved the
  stability hash even though no geometry changed. The gate is now split in two:
  `tests/tiling.test.mjs` holds the pre-C4 hash of the map with those two fields deleted, which is
  the assertion that matters, and `tests/generation.test.mjs` pins the current full map. A tolerance
  would have hidden the real failure, so the seam test asserts exact equality instead: the field
  values on both sides of a seam are the same numbers, not close ones.
- **Tiling needed more than the fields, or a world repeated itself.** Placement was seeded from the
  map seed alone, so every tile of a world drew the identical random sequence and a tiled world showed
  the same grove in the same corner of every tile. The stream is now keyed on the tile's origin, and
  the map id carries the origin so assembling a world does not produce duplicate entity ids.
- **A tile that does not fit its world has to be rejected.** Otherwise the world-wide quantile sample
  describes a rectangle the tile is not inside, and the thresholds are measuring a landscape that is
  not there. This is a config error, not a tuning knob, so it throws.

One thing deliberately not built: the read path has no notion of a tile's position in the world, so a
consumer walking a character across a seam has to do that arithmetic itself. A map reports its own
`bounds` and its `metadataLayers.generation.origin`, and the raster stays tile-local, which is the
right default for a self-contained tile. Add a world-space lookup when a consumer actually assembles
a world and asks for it.

Contours are still extracted per tile from that tile's own grid, so a water body that straddles a seam
is published as two polygons meeting there. Both sides agree about the waterline, because the level is
shared and the field is continuous; the vertices along the seam come from each tile's own columns, so
they can sit up to one grid spacing apart, about 28 world units on a tile under 1792 wide. Joining the
two into one polygon is a stitching step for whoever owns the world.

## Open questions

- Duplication of trees into both `vegetation` and `forests[].trees` is not cheap: +0.47MB on the
  default 2048x1536 map (+43%) and +2.36MB on 4096x4096 (+69%), because 88% of trees belong to a
  grove. Kept, because a consumer wanting a flat tree list should need no new code and validation fails
  if the copies drift. Referencing by id instead is a small change if the size starts to matter, and it
  would also require dropping the validator rule that the copies must agree, which is the rule that
  makes duplication safe.
- `walkableInside` is measured at a fixed 8-unit cells, so it is a statement about that resolution and
  not about the map. A grove reported sealed at 8 units may be open at 4. The measurement resolution
  is fixed rather than published, which is a deliberate simplification: it is a hint for deciding
  whether to seal a grove, not a substitute for a consumer's own raster.
- The recorded room tick of 0.661ms comes from the game's profiler, not from this repository. The
  generator can only be held to bake cost and lookup cost, both of which it now asserts.
