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

`terrain` always begins with one full-bounds `grass` region, followed by `meadow` and `scrub` overlays contoured from the combined terrain and moisture fields. The regions overlap freely and are not nested: on a typical map the scrub contour encloses more area than the meadow contour, so the two boundaries cross and some scrub areas sit outside every meadow area.

Regions are emitted in a fixed order — all `meadow` first, then all `scrub` — and this ordering is part of the contract. A point matches every region containing it, and the surface is resolved by **last match wins**, which yields the precedence `scrub` over `meadow` over `grass`. A consumer that needs one surface per point should find the final matching region rather than the first, or test kinds in that order.

Levels are per-map quantiles of the score rather than fixed constants. The score is the mean of two fractal noise fields and clusters tightly around 0.5 (measured median 0.500, 90th percentile 0.596 across seeds), so a fixed threshold would give anywhere from 20% to 30% coverage depending on the seed. Taking each map's own 75th and 90th percentiles instead holds the split near 75% grass, 15% meadow, and 10% scrub on every seed. The result remains a pure function of the seed, so determinism is unaffected.

Regions below 0.25% of the map area are dropped. Each overlay's `asset.variant` names its kind, so `MapTheme.terrain` colours apply directly.

## Vegetation

Trees are sampled from the `vegetation` field. `density: 0` creates no trees.

`density` and `clustering` control different things:

- `density` sets the tree count: one tree per 1250 square world units, times the density.
- `clustering` sets the arrangement. It raises the bar a tree must clear to be placed and sharpens how strongly strong groves are favoured, turning an even scatter into tight groves with real clearings between them. It does not change the count directly, though high values place fewer trees because the 9-unit spacing limit binds inside dense groves.

Per-cell tree concentration rises monotonically across the control, from a coefficient of variation near 0.55 at `clustering: 0` to about 1.36 at `clustering: 1`. The density target is reached for every value up to about 0.75; above that the woodland genuinely thins because the same number of trees is packed into fewer groves.

Species are chosen by moisture rather than at random. Birch is the wet-ground species and gains ground as local moisture rises, against a base share of 28%. Oak holds dry ground. Both species are present on every generated map.

Tree canopy radii are 10-18 world units. Collision circles are smaller than the canopy and never overlap water.

The generator stores its complete resolved configuration and water threshold in `metadataLayers`, so exported native JSON preserves the debugging context as well as the semantic world.
