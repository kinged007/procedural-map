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

`terrain` always begins with one full-bounds `grass` region. It is followed by `meadow` and `scrub` overlays contoured from the combined terrain and moisture fields, so the regions may overlap: a point inside a `scrub` region is also inside a `meadow` region. Consumers that need one surface per point should test the last matching region in the array.

Levels are per-map quantiles of the score rather than fixed constants. The score is the mean of two fractal noise fields and clusters tightly around 0.5 (measured median 0.500, 90th percentile 0.596 across seeds), so a fixed threshold would give anywhere from 20% to 30% coverage depending on the seed. Taking each map's own 75th and 90th percentiles instead holds the split near 75% grass, 15% meadow, and 10% scrub on every seed. The result remains a pure function of the seed, so determinism is unaffected.

Regions below 0.25% of the map area are dropped. Each overlay's `asset.variant` names its kind, so `MapTheme.terrain` colours apply directly.

Vegetation samples the vegetation field to create groves, clearings, and sparse areas. `density: 0` creates no trees. Tree canopy radii are 10–18 world units; their collision circles are 3.5–5.5 world units and remain outside water.

The generator stores its complete resolved configuration and water threshold in `metadataLayers`, so exported native JSON preserves the debugging context as well as the semantic world.
