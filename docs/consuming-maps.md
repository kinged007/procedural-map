# Consuming generated maps

What the generator gives you, and what it expects your game to do with it.

## The one rule

The map describes geometry. It does not implement collision, navigation, or rendering.

There is no collision map, no rasterised walkability grid, and no baked navigation mesh. Every
blocking feature carries its own geometry, and turning that into physics is your engine's job. This is
deliberate: it keeps the output independent of your physics system, so the same map can drive a
kinematic character controller, a rigid-body vehicle, and a server-authoritative movement check without
regenerating.

## Getting a map

```js
import { generateMap, exportMap, importMap, validateMap } from '@fieldwork/procedural-map';

const map = generateMap({
  seed: 583921,
  width: 2048,
  height: 1536,
  water: { amount: 0.2 },
  vegetation: { density: 0.65, clustering: 0.8 },
  roads: { density: 0.5 },
});
```

`generateMap` returns a validated `GameMap` and throws rather than returning an invalid one, so a
successful call needs no further checking. Generation is synchronous and blocks the calling thread; on
the main thread of a browser, wrap it if the map is large enough to be noticeable.

To persist a world, write `exportMap(map)` to disk. To read it back, `importMap(json)` validates and
returns a `GameMap`. The map carries its own resolved configuration in `metadataLayers.generation`, so a
map saved as JSON can also be regenerated from the seed alone. Store the seed if you want the small
option.

## Coordinates

Origin top-left, x right, y down, in world units, all absolute. The map is a single flat rectangle
with no world offset, no cell grid, and no coordinate compression. Feed these straight into a 2D
physics or rendering system. If your engine is y-up, flip y on import and nothing else changes.

The generator has no fixed world scale. Its constants are tuned so a 2048x1536 map looks right, which
in practice means one world unit reads as roughly one metre in a top-down game. Pick a global scale
factor at import time if you need a different unit.

## Three things to build

### 1. Ground surface

Terrain regions overlap, so a point can be inside several. Regions are emitted in a fixed order:

```
grass, meadow, scrub, rock, beach
```

and the surface is the **last** region that contains the point, giving precedence
`beach > rock > scrub > meadow > grass`. Take the final match, or test kinds in that order. Testing
for the first match reports `grass` almost everywhere and is wrong.

```js
import { generateMap, pointInPolygon } from '@fieldwork/procedural-map';

const KIND_ORDER = ['grass', 'meadow', 'scrub', 'rock', 'beach'];

function surfaceAt(map, x, y) {
  let found = 'grass';
  for (const kind of KIND_ORDER)
    for (const region of map.terrain)
      if (region.kind === kind && pointInPolygon({ x, y }, region.geometry)) found = kind;
  return found;
}
```

`pointInPolygon` is exported by the library and handles `holes`, which is the part a hand-rolled ray
cast usually gets wrong on a beach. `circleIntersectsPolygon`, `polygonArea`, and `boundsOf` are
exported alongside it.

That is correct but linear in the number of regions, which is fine for a one-off lookup and wrong in a
per-frame movement check. For anything per-frame, bake the surface once into whatever your engine
already has for ground queries: a tile grid, a texture, or a lookup table. Bake it at load, not at
runtime.

### 2. Blockers

Every blocking feature carries a `collision` object. There is no separate impassable list, so a
consumer does not need to know which kind of feature it is looking at:

```js
const blockers = [
  ...map.water, // polygon, same ring as the visible surface
  ...map.terrain.filter((r) => r.collision), // polygon, present only on rock
  ...map.vegetation, // circle, trunk-sized
  ...map.structures, // whatever the producer attached
  ...map.barriers,
].filter((e) => e.collision);
```

| Feature       | Collision shape | Radius vs. visible       |
| ------------- | --------------- | ------------------------ |
| Lake          | polygon         | identical ring           |
| Rock          | polygon         | identical ring           |
| Tree          | circle          | 3.5-5.5 vs. 10-18 canopy |
| Other terrain | none            | passable                 |

Note what is **not** in that list: a tree's collision circle is much smaller than its canopy, so a
player walks under the leaves and into the trunk. Rock and water are impassable. Grass, meadow, scrub
and beach are passable regardless of what is drawn on top of them.

One case needs a decision. A beach band can be drawn over a rock region, because a beach is emitted
last and wins the surface. The rock is still impassable underneath it. Obstruction and surface are
independent, and emission order does not resolve one through the other.

### 3. Roads

A road is a centreline `path` plus a `width`, and its `collision` is the ribbon covering the surface.
Two uses:

- **Draw** the ribbon, or stroke the centreline with `lineWidth = width`. A darker casing under a
  lighter surface is what makes a road read as a road at map scale.
- **Drive on** the ribbon, or treat the centreline as a spline. `kind` gives the class directly:
  `primary` (width 22), `secondary` (14), `path` (7).

A junction is not an entity. Two centrelines meet and that is the whole model. If you need to know
that a point is on a road, test the ribbons; if you need to know which road, find the nearest
centreline.

Roads never cross water or rock, and are kept 20 world units clear of any shoreline. A road that runs
out of open ground simply ends. There are no bridges and no fords, so a road network is a connected
graph that never crosses a river, not a fully connected one.

## Size and cost

Measured on a single modern laptop core, single-threaded. The 900x700 row uses the smaller
`water.amount` from the example above, and seed 583921 for the other two:

| Map       | Time   | Terrain | Water | Trees | Roads | Vertices | JSON   |
| --------- | ------ | ------- | ----- | ----- | ----- | -------- | ------ |
| 900x700   | 318 ms | 10      | 3     | 328   | 16    | 1,664    | 267 KB |
| 2048x1536 | 611 ms | 22      | 13    | 1636  | 15    | 5,275    | 1.1 MB |
| 4096x4096 | 2.3 s  | 58      | 47    | 8000  | 14    | 10,065   | 3.5 MB |

Absolute times are machine dependent; the ratios are not.

The vertex count is the important number and it is small. A default map is a few thousand vertices
across every polygon and road in total, so a linear scan per query is affordable at load time and
marginal per frame. There is no need for a spatial index at this scale; bake instead.

The 4096x4096 case is the ceiling worth knowing about. Tree count saturates at 8,000 there, which
means the woodland visibly thins relative to its area, and generation takes over two seconds on the
calling thread. Above 4096 in either axis the config is rejected, so if you need a larger world,
generate tiles and place them side by side.

## Determinism

The same resolved configuration always produces a byte-identical map. Two consequences worth relying
on:

- A seed plus a config is a complete save file. Store `(seed, width, height, terrain, water,
vegetation, roads)` and you can rebuild the world exactly, which is a fraction of the JSON size.
- Generated maps are comparable. If two maps with the same config differ, something in the pipeline
  changed the data, and a diff of the exports will show it.

`metadataLayers.generation` holds the fully resolved config, defaults filled in. Read that rather than
the config you passed in, or the defaults will drift between versions.

## What is not produced yet

So the map is not mistaken for more than it is:

- **No structures or barriers.** Both collections are empty on a generated map.
- **No buildings, plots, settlements, or resources.** These are the v0.4 to v0.6 roadmap.
- **No rivers or bridges.** Water is lakes only, and roads stop at the bank.
- **No heightmap or 3D data.** The map is flat. Elevation is available as a debug field, not as
  geometry, and no region carries a height.
- **No navigation, spawn points, or region naming.** No region has a name or a unique identity beyond
  its `id`.
- **No chunking.** One map is one flat rectangle, bounded at 4096x4096.

## Debugging a map that looks wrong

`metadataLayers.fields` holds the four noise fields the map was contoured from, and the Canvas renderer
can draw them directly. Render the `elevation`, `moisture`, or `vegetation` view to see what the
generator saw before it classified anything, which is usually faster than reading the polygons.

If the geometry is the problem rather than the classification, the `collision` view draws every
blocking feature as its collision shape. A tree drawn as a small circle inside a large canopy is
correct behaviour, not a bug.

The studio in `demo/` exposes all of these as tabs, with sliders for every generation parameter.

## See also

- [GameMap v1.0 schema](gamemap-schema.md) — field-by-field structure
- [Generation](generation.md) — how the map is produced
- [Architecture](architecture.md) — where the boundary sits
