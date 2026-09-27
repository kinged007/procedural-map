# Generation

`generateMap(config)` produces a validated `GameMap` from a resolved configuration. The same resolved configuration always produces the same map.

```ts
generateMap({
  seed: 583921,
  width: 2048,
  height: 1536,
  terrain: { variation: 0.35, scale: 0.004 },
  water: { amount: 0.2, scale: 0.003 },
  vegetation: { density: 0.65, clustering: 0.8 },
  roads: { density: 0.5 },
});
```

Defaults are the values shown above. `seed` must be a JavaScript safe integer. Width and height are integers from 128 through 4096. `variation`, `amount`, `density`, and `clustering` range from 0 through 1. Terrain and water scales range from `0.0001` through `0.05`.

Generation creates normalized terrain, elevation, moisture, and vegetation fields, retained in `metadataLayers.fields` for debugging. The noise grid is at most 64 by 64 samples. Water contours follow elevation at a threshold selected from `water.amount`; lakes are connected and smoothed polygons that can contain holes. Generation preserves all resulting shoreline rings and holes. `water.amount: 0` creates no lakes and `water.amount: 1` covers the full bounds.

## Terrain classification

`terrain` always begins with one full-bounds `grass` region, followed by four overlay kinds. They are emitted in a fixed order and are **not** nested: because each kind is contoured from a different field, the boundaries cross and regions freely overlap.

| Kind     | Driven by                         | Coverage        |
| -------- | --------------------------------- | --------------- |
| `meadow` | terrain + moisture score          | top 25% of land |
| `scrub`  | terrain + moisture score          | top 10% of land |
| `rock`   | elevation                         | top 6% of land  |
| `beach`  | shoreline offset around each lake | 1.5 to 30 units |

`meadow` and `scrub` share one score, the mean of the terrain and moisture fields, so `scrub` is a subset of the same land that reads as meadow. Both use per-map quantiles, because that score clusters tightly around 0.5 and a fixed threshold would swing coverage between 20% and 30% depending on the seed.

`rock` uses the elevation field directly, at the 94th percentile. It is the same field that places lakes, so highland sits above the waterline rather than being scattered independently of it. Rock regions may extend under a lake; the renderer draws water over terrain, so this reads as a lake bed and the validator permits it.

A `beach` is the lake outline offset outward, with the lake itself punched out as a hole, so it is a ring of land rather than a filled blob. The width is **not** constant: it varies around the shore, driven by the moisture field, and the resulting shape is smoothed so it reads as graded sand rather than a noisy ribbon.

Two details make the variance work. The width is normalised per lake, because moisture varies more between lakes than it does along any one shoreline, and a map-wide normalisation produced the same width everywhere. And the band is shrunk until it stays inside the map, since lakes sit close to the edge; a per-vertex clamp on the band bounds is what makes that safe without flattening the shape.

`metadata.shorelineWidth` records the `{ min, max, mean }` actually realised by the geometry rather than the widths that were requested, because the shrink step scales the band. `metadata.source` names the lake it came from. A lake whose band would fold through itself or leave the map gets no beach — a 128-unit map and a fully flooded map both produce none, which is why beach count can be lower than lake count.

## Resolution rule

Regions are emitted as `grass`, then `meadow`, then `scrub`, then `rock`, then `beach`. A point matches every region containing it, and the surface is the **last** match, giving precedence:

```
beach > rock > scrub > meadow > grass
```

Consumers that need one surface per point must take the final match, or test kinds in that order. Testing the first match reports `grass` almost everywhere and is incorrect.

Surface and obstruction are independent. A `beach` is emitted last and so is drawn over a `rock` region that lies beneath a lake, but the rock is still impassable there. Emission order resolves which surface is visible, not whether the ground can be walked on.

## Vegetation

Trees are sampled from the `vegetation` field. `density: 0` creates no trees.

`density` and `clustering` control different things:

- `density` sets the tree count: one tree per 1250 square world units, times the density.
- `clustering` sets the arrangement. It raises the bar a tree must clear to be placed and sharpens how strongly strong groves are favoured, turning an even scatter into tight groves with real clearings between them. It does not change the count directly, though high values place fewer trees because the 9-unit spacing limit binds inside dense groves.

Per-cell tree concentration rises monotonically across the control, from a coefficient of variation near 0.55 at `clustering: 0` to about 1.36 at `clustering: 1`. The density target is reached for every value up to about 0.75; above that the woodland genuinely thins because the same number of trees is packed into fewer groves.

Species are chosen by moisture rather than at random. Birch is the wet-ground species and gains ground as local moisture rises, against a base share of 28%. Oak holds dry ground. Both species are present on every generated map.

Tree canopy radii are 10-18 world units. Collision circles are 3.5-5.5, so a trunk blocks and the leaves do not, and they never overlap water.

Trees are not planted on a road, nor where a canopy would overhang one, so a road is cut through the wood and leaves a clearing along its verges. Vegetation is generated after roads for that reason.

## Roads

Roads are grown in three tiers, widest and longest first: `primary` at width 22, `secondary` at 14, and `path` at 7. Primary and secondary roads start at the map edge and cross the map; paths branch off roads already placed, which is what makes the network connected rather than a set of parallel lines. A default map produces 12 to 16 roads.

`roads.density` scales the target count of every tier. It never drops a tier below one, so density controls how busy the network is rather than whether there is one at all: at 0 a map has three roads, at 1 it has 16 to 17, and all three tiers are populated throughout.

Routing is a greedy walk over a small fan of headings, each step taking the cheapest heading available, rather than a shortest-path search. That produces the meander and long detours of a surveyed road instead of a taut line between two endpoints. The cost is charged against a budget, so every road terminates on its own.

Water and impassable rock are refused outright rather than made expensive, and a step is refused 20 world units short of a water edge. A road therefore bends around an obstruction for as long as the fan of headings allows, then stops on open ground, and it never crosses a lake. Bridges and fords are v0.7 work.

Two invariants keep the network readable. A road that branches from another is required to touch it, while every other pair of roads is held apart by a per-tier minimum gap, so a consumer can tell a junction from two roads running alongside each other. And a road whose centreline retraces itself is rejected before publication, because the offset ribbon around a fold crosses itself and produces geometry validation refuses.

Road generation is skipped entirely when water and rock together cover more than 55% of the map, since routing has no meaningful result there. A fully flooded map therefore has no roads at all.

## Tiles

The four fields are sampled at `origin + local`, so a tile is a window onto one landscape rather than
its own world, and every threshold that decides where water, rock, meadow and scrub begin is a quantile
of a sample of the whole `world` rather than of the tile. Two tiles of one world therefore agree on
their shared edge exactly, and agree on the height of the waterline exactly.

The field grid is capped at 64 samples across whatever the world measures. A tile 2048 wide gets 64
samples, about 32 units apart, and a world 64,000 wide gets the same 64, about 1,000 units apart. The
cost is linear in samples, so the cap is the only thing standing between a large world and a slow one;
raise it when a world that large is actually generated.

Placement draws from a stream keyed on the tile's origin as well as the seed, so tiles of one world do
not repeat each other's groves, and a tile's id carries its origin so a world assembled from tiles has
no duplicate entity ids.

With no `origin` and no `world`, a tile is its own world and the map is unchanged.

## Debug metadata

The generator stores its complete resolved configuration, the tile's placement, and the water threshold
in `metadataLayers`, so exported native JSON preserves the debugging context as well as the semantic
world.
