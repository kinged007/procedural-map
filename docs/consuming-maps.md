# Consuming generated maps

What the generator gives you, and what it expects your game to do with it.

## The one rule

The map describes geometry. The generator also bakes a walkability grid from that geometry, so the
two can never quietly disagree, but it does not implement collision, navigation meshes, or rendering.

Every blocking feature carries its own geometry, and turning that into physics is your engine's job.
This is deliberate: it keeps the output independent of your physics system, so the same map can drive
a kinematic character controller, a rigid-body vehicle, and a server-authoritative movement check
without regenerating. `rasterizeWalkability` reads that same geometry, so the baked grid and your
engine's collision agree about what blocks, and the grid is one thing to keep in step rather than
three.

## Getting a map

```js
import { generateMap, exportMap, importMap, validateMap } from 'fieldwork-map';

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
import { generateMap, pointInPolygon } from 'fieldwork-map';

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
consumer does not know which kind of feature it is looking at:

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

## Walking on the map

For a per-frame movement check, do not walk the geometry. Bake it once and read a byte.

```js
import { generateMap, rasterizeWalkability, chunkTile } from 'fieldwork-map';

const map = generateMap({ seed: 583921, width: 2048, height: 1536 });
const raster = rasterizeWalkability(map, { cellSize: 32 });

raster.cells[row * raster.columns + column]; // 0 open, 1 blocked
```

`cellSize` is yours to pick, so bake at whatever your own tile size is. The raster covers the map in
`columns` by `rows` cells, row-major, one byte per cell.

### The fill rule, stated once

**A cell is blocked if any part of it is covered by a water polygon or a rock region.**

Three consequences follow, and all of them are deliberate:

- **Conservative.** A cell the shoreline merely clips is blocked, even where its centre is dry. The
  rule can mark a cell blocked whose centre is open; it can never mark a covered cell open, so a
  movement check driven by the raster cannot step into a lake.
- **A beach drawn over rock is still blocked.** The rock is still there, and obstruction is
  independent of what is drawn on top.
- **Feature size is measured against `cellSize`.** A lake 20 units across disappears at `cellSize`
  32, because the dilation around it swallows the whole thing. Pick a `cellSize` comfortably smaller
  than the smallest feature you need to keep walkable.

Trees are **not** in the raster. A tree blocks a small trunk circle inside a large canopy, and baking
the canopy would seal the clearings a player is meant to walk through between trees. Trunks are
resolved on top, per chunk, which is what keeps a grove walkable.

That has a consequence worth planning around: **`cellSize` is also the granularity of tree
collision.** A trunk marks every cell its circle touches, so a trunk 4 units across blocks a 32x32
square at `cellSize: 32`. On the default 2048x1536 map, adding trunks to a central chunk moves it
from 18% blocked to 62% at `cellSize: 32`, and from 18% to 18% at `cellSize: 4`. A dense wood reads
as solid at a coarse `cellSize` and as walkable at a fine one, so pick `cellSize` against your tree
density, not just against your tile size.

### The read path

`chunkTile` bakes one chunk: the raster cells the chunk covers, with the trunks that fall in it marked
on top. A chunk outside the map is entirely blocked, so a character cannot walk off the edge.

```js
const chunk = chunkTile(raster, map, chunkX, chunkY, { chunkSize: 32 });
chunk[y * chunkSize + x]; // 0 open, 1 blocked
```

The trunk step uses the grove hulls as a broadphase. A chunk tests each forest's bounds box and then walks only the trunks of the forests whose box it touches, so a bake costs what the wood near the chunk costs rather than what the whole map costs. Bake a chunk once, when the camera first reaches it, and keep the result. The bake is the expensive part; the lookup afterwards is an array read. That split is what keeps the per-frame cost independent of how much map you generated. On a 4096x4096 map at the 8,000 tree ceiling, a 32-world-unit chunk bakes in 0.045ms, against 0.29ms scanning every tree; a 1024-world-unit chunk takes 0.18ms, against 0.35ms.

What a bake still costs is one bounds test per grove, so it follows the grove count and not the tree
count. Index the grove bounds into a uniform grid if bakes ever land in a frame budget; nothing here
needs one at the generator's own ceilings.

### Forests

A forest is a grove of trees published as one entity, and it exists to serve the broadphase above. It
carries the trees inside it, a convex hull around them, and three fields worth reading.

```js
import { boundsOf, pointInPolygon } from 'fieldwork-map';

for (const forest of map.forests) {
  const box = boundsOf(forest.geometry);
  if (!pointInPolygon(position, forest.geometry)) continue;
  if (
    forest.trees.some((tree) => distance(position, tree.collision.center) < tree.collision.radius)
  )
    blocked = true;
}
```

- `forest.metadata.walkableInside` is measured at 8-unit cells: `true` means there is clear ground
  inside the hull. This is the field to read before deciding a grove is sealed. Roughly a quarter of
  groves on a densely wooded map report `false`, which is a true statement about thick wood.
- `forest.metadata.densityPct` is canopy cover, saturated at 100. Useful for thinning distant wood.
- `forest.species` is `oak`, `birch`, or `mixed`, from the majority of trees inside.

A forest deliberately has **no** `collision`. A grove is not a wall, and the trunks block while the
clearings between them stay walkable. Adding `collision` to a forest is a validation error, because
the clearings are the point.

Trees appear twice in a map: once in `vegetation` as a flat list, and once inside the forest they
belong to. The copies are identical and validation fails if they drift. Use `vegetation` when you
want every tree, and a forest's `trees` when you already know which grove you are in.

### Where can a character actually go

`navigableRegions` splits the raster's open cells into the areas a character can walk between, and
`spawnCandidates` picks the roomiest points on the map.

```js
import { navigableRegions, spawnCandidates } from 'fieldwork-map';

const regions = navigableRegions(raster); // largest first
regions[0].area; // open ground, in world units squared
regions[0].clearance; // the roomiest ground in the region
regions[0].representativeOpenPoint; // where a base goes
regions[0].centroid; // geometric centre, can sit on blocked ground

spawnCandidates(raster, map, { count: 8, minSeparation: 200 });
```

Connectivity is four-way, which is the conservative reading: the raster already blocks any cell a
blocker touches, so a gap it leaves is at least a cell wide, and a character wider than a cell cannot
cross a diagonal pinch. Two open areas meeting at a corner stay two regions.

That is the answer to "is that base on an island". One region is one walkable landmass, so two points
in the same region are reachable from each other by construction, and the largest region is the main
continent. `clearance` is a real distance to the nearest blocked cell, so `representativeOpenPoint` is
the roomiest ground in the region rather than merely a point inside it. Spawn candidates come back in
descending clearance, at least `minSeparation` apart, and are fully deterministic: the same raster
gives the same list in the same order.

The map goes in alongside the raster so that a candidate is never placed inside a tree. Clearance is
measured against the raster, which holds water and rock but not trees, so on a wooded map the roomiest
ground is very often the inside of a trunk.

Two things to know about the ordering. Candidates are ranked by raster clearance, so a point next to a
grove is chosen on the ground's merits and then kept or dropped, which means the order does not
account for trees. And the roomiest ground on a map is often in a corner, because a corner is furthest
from anything. That is a correct answer to the question asked, so if you want bases inland, filter on
`centroid` or on `region.cells` yourself. For the same reason a large `minSeparation` can return every
candidate from the largest region: one base per landmass means walking `regions` and taking each
region's `representativeOpenPoint`.

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
- **No navigation mesh, and no pathfinding.** A* or whatever you use runs over the walkability grid.
- **No region naming.** Regions are numbered by size. No region has a name.
- **No chunking.** One map is one flat rectangle, bounded at 4096x4096. The walkability grid is baked
  in chunks for reading, but the map itself is not divided into tile-sized worlds.

## Debugging a map that looks wrong

`metadataLayers.fields` holds the four noise fields the map was contoured from, and the Canvas renderer
can draw them directly. Render the `elevation`, `moisture`, or `vegetation` view to see what the
generator saw before it classified anything, which is usually faster than reading the polygons.

If the geometry is the problem rather than the classification, the `collision` view draws every
blocking feature as its collision shape. A tree drawn as a small circle inside a large canopy is
correct behaviour, not a bug.

The studio in `demo/` exposes all of these as tabs, with sliders for every generation parameter.

## See also

- [GameMap v1.1 schema](gamemap-schema.md) — field-by-field structure
- [Generation](generation.md) — how the map is produced
- [Architecture](architecture.md) — where the boundary sits
