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
| `beach`  | shoreline offset around each lake | 7-unit band     |

`meadow` and `scrub` share one score, the mean of the terrain and moisture fields, so `scrub` is a subset of the same land that reads as meadow. Both use per-map quantiles, because that score clusters tightly around 0.5 and a fixed threshold would swing coverage between 20% and 30% depending on the seed.

`rock` uses the elevation field directly, at the 94th percentile. It is the same field that places lakes, so highland sits above the waterline rather than being scattered independently of it. Rock regions may extend under a lake; the renderer draws water over terrain, so this reads as a lake bed and the validator permits it.

A `beach` is the lake outline offset 7 units outward, with the lake itself punched out as a hole, so it is a ring of land rather than a filled blob. `metadata.shorelineWidth` and `metadata.source` record the offset and the lake it came from. A lake whose offset would fold through itself or leave the map gets no beach — a 128-unit map and a fully flooded map both produce none, which is why beach count can be lower than lake count.

## Resolution rule

Regions are emitted as `grass`, then `meadow`, then `scrub`, then `rock`, then `beach`. A point matches every region containing it, and the surface is the **last** match, giving precedence:

```
beach > rock > scrub > meadow > grass
```

Consumers that need one surface per point must take the final match, or test kinds in that order. Testing the first match reports `grass` almost everywhere and is incorrect.

## Vegetation

Trees are sampled from the `vegetation` field. `density: 0` creates no trees.

`density` and `clustering` control different things:

- `density` sets the tree count: one tree per 1250 square world units, times the density.
- `clustering` sets the arrangement. It raises the bar a tree must clear to be placed and sharpens how strongly strong groves are favoured, turning an even scatter into tight groves with real clearings between them. It does not change the count directly, though high values place fewer trees because the 9-unit spacing limit binds inside dense groves.

Per-cell tree concentration rises monotonically across the control, from a coefficient of variation near 0.55 at `clustering: 0` to about 1.36 at `clustering: 1`. The density target is reached for every value up to about 0.75; above that the woodland genuinely thins because the same number of trees is packed into fewer groves.

Species are chosen by moisture rather than at random. Birch is the wet-ground species and gains ground as local moisture rises, against a base share of 28%. Oak holds dry ground. Both species are present on every generated map.

Tree canopy radii are 10-18 world units. Collision circles are smaller than the canopy and never overlap water.

The generator stores its complete resolved configuration and water threshold in `metadataLayers`, so exported native JSON preserves the debugging context as well as the semantic world.
