# GameMap v1.2 schema

The canonical product boundary is `GameMap` v1.1. Generation, native JSON import, and future external
import adapters all produce this model, and a consumer uses the same geometry regardless of which one
produced it.

The exported JSON follows `gameMapSchema`, which the library exports as a plain object. `validateMap`
enforces the rules below; `assertValidMap` throws instead of returning.

Every example in this document is taken from a real map, generated with
`generateMap({ seed: 7, width: 900, height: 700, water: { amount: 0.15 } }`. Long coordinate arrays are
elided with a comment rather than truncated silently.

## Top level

```ts
interface GameMap {
  version: '1.2';
  metadata: { id: string; seed?: number; generator?: string; generatedAt?: string };
  bounds: { width: number; height: number };
  terrain: TerrainRegion[];
  water: WaterRegion[];
  vegetation: VegetationEntity[];
  forests: ForestEntity[];
  structures: MapEntity[];
  roads: RoadEntity[];
  barriers: MapEntity[];
  metadataLayers?: { fields?: SpatialFields; [key: string]: unknown };
}
```

All ten of `version`, `metadata`, `bounds`, `terrain`, `water`, `vegetation`, `forests`, `structures`,
`roads`, and `barriers` are required, even when the collection is empty. `metadataLayers` is optional.
A generated map sets `structures` and `barriers` to `[]`; they are reserved for buildings and walls.

`bounds` is the size of the world in world units. Every coordinate in the map is absolute and lies
inside it.

## Coordinates and geometry

A point is `{ x, y }` in world units, origin at the top-left of the map, x increasing to the right and
y increasing downward. There is no world scale or unit conversion: one world unit is whatever your
engine calls one metre, and the generator only guarantees that its constants look right at the sizes
it produces.

```ts
interface Point {
  x: number;
  y: number;
}

interface PolygonGeometry {
  points: Point[];
  holes?: Point[][];
}
```

A ring is a list of at least 3 and at most 32,768 points. Rings close implicitly: the last point
connects back to the first, so the first point is not repeated. A ring must be simple (no segment may
cross another) and must enclose a non-zero area. A polygon may carry up to 4,096 holes, each of which
must lie inside the outer ring, must not touch it, and must not overlap another hole.

## Entity shape

Every entity in every collection shares this base:

```ts
interface MapEntity {
  id: string;
  type: string;
  position?: Point;
  rotation?: number;
  tags?: string[];
  collision?: CollisionGeometry;
  geometry?: PolygonGeometry;
  asset?: AssetReference;
  metadata?: Record<string, unknown>;
}
```

`id` is non-empty and unique across the whole map, not just within a collection. `type` is the
collection's discriminator. `asset` is a `{ category, variant }` pair for looking up a sprite, and
`metadata` is free-form JSON used for debugging. Collision geometry is one of three shapes:

```ts
type CollisionGeometry =
  | { type: 'circle'; center: Point; radius: number }
  | ({ type: 'polygon' } & PolygonGeometry)
  | { type: 'rectangle'; x: number; y: number; width: number; height: number };
```

The generator uses circles for trees and polygons everywhere else. Rectangles are supported so an
importer can express axis-aligned walls without building a ring.

## terrain

`grass` is always a single full-bounds region, followed by the overlays. Regions are emitted in a
fixed order and are **not** nested: each is contoured from a different field, so boundaries cross and
regions overlap freely. A consumer that needs one surface per point takes the **last** match.

```ts
interface TerrainRegion extends MapEntity {
  type: 'terrain';
  kind: 'grass' | 'meadow' | 'scrub' | 'rock' | 'beach';
  geometry: PolygonGeometry;
  collision?: { type: 'polygon' } & PolygonGeometry;
}
```

`collision` is present on impassable terrain only, which today means `rock`. Its polygon is identical
to `geometry`. Its absence is what makes a region passable; there is no separate impassable list.

The base region, which is what fills the map before anything is drawn on top:

```json
{
  "id": "terrain-grass",
  "type": "terrain",
  "kind": "grass",
  "geometry": {
    "points": [
      { "x": 0, "y": 0 },
      { "x": 900, "y": 0 },
      { "x": 900, "y": 700 },
      { "x": 0, "y": 700 }
    ]
  },
  "asset": { "category": "terrain.grass", "variant": "temperate-1" }
}
```

An impassable rock region. Note that `asset.category` is `terrain.grass` for every terrain kind, and
the `variant` carries the kind; see [Asset references](#asset-references).

```json
{
  "id": "terrain-rock-1",
  "type": "terrain",
  "kind": "rock",
  "geometry": { "points": [{ "x": 489.91935483870964, "y": 18.229166666666668 }, "..."] },
  "collision": {
    "type": "polygon",
    "points": [{ "x": 489.91935483870964, "y": 18.229166666666668 }, "..."]
  },
  "asset": { "category": "terrain.grass", "variant": "rock-1" },
  "metadata": { "scoreLevel": 0.7690003869518266 }
}
```

A beach. Its polygon is the lake outline offset outward, with the lake itself punched out as a hole,
so it is a ring of land rather than a filled blob. `metadata.shorelineWidth` records the width actually
realised by the geometry, which is why it is an object and not a single number: the width varies
around the shore.

```json
{
  "id": "terrain-beach-1",
  "type": "terrain",
  "kind": "beach",
  "geometry": {
    "points": [{ "x": 859.1795059546149, "y": 56.928596257354414 }, "..."],
    "holes": [[{ "x": 867.3387096774194, "y": 76.5625 }, "..."]]
  },
  "asset": { "category": "terrain.grass", "variant": "beach-1" },
  "metadata": {
    "shorelineWidth": {
      "min": 1.6396212938321924,
      "max": 26.879182489931136,
      "mean": 12.436732431358056
    },
    "source": "lake-1"
  }
}
```

`metadata.source` names the lake the band was built from. A lake whose band would fold through itself or
leave the map gets no beach at all, so a map can have fewer beaches than lakes.

## water

There are two water kinds. `lake` is a body of standing water contoured from the elevation field, and `river` is the channel of a course walked down the drainage of the same field, `rivers.width` world units wide, 12 by default. Collision is required on both and is the same polygon as the visible geometry, so a consumer never has to reconcile the two.

```ts
interface WaterRegion extends MapEntity {
  type: 'water';
  kind: 'lake' | 'river';
  geometry: PolygonGeometry;
  collision: { type: 'polygon' } & PolygonGeometry;
}
```

```json
{
  "id": "lake-1",
  "type": "water",
  "kind": "lake",
  "geometry": {
    "points": [{ "x": 867.3387096774194, "y": 76.5625 }, "... 160 more points"]
  },
  "collision": {
    "type": "polygon",
    "points": [{ "x": 867.3387096774194, "y": 76.5625 }, "... 160 more points"]
  },
  "asset": { "category": "water.lake", "variant": "lake-1" }
}
```

A lake may carry its own holes for islands, and generation preserves every high-ground ring it finds
inside a contour. A river has no holes: it is the surface of one course, and a ring. A course is cut at the first water its channel reaches, and the end is slid onto the shore so the
channel and the water body join rather than stopping a step apart. A river has no holes: it is the
surface of one course, and a ring. A course that would lie on a river already published is cut back to
the junction, so a map's rivers meet rather than overlap: two channels touching is a confluence, and
the ring of each ends inside the other's.

```json
{
  "id": "river-1",
  "type": "water",
  "kind": "river",
  "geometry": { "points": [{ "x": 1592.88, "y": 568.88 }, "... 14 points"] },
  "collision": { "type": "polygon", "points": [{ "x": 1592.88, "y": 568.88 }, "... same points"] },
  "asset": { "category": "water.river", "variant": "river-1" }
}
```

A course is cut where it first reaches standing water, so a channel never lies over a lake, and the
site is published on the river. `metadata.mouths` is present when the river met a water body, and each
entry names it:

```ts
interface RiverMouth {
  waterId: string;
  point: Point;
  polygon: PolygonGeometry;
}
```

`point` is where the channel met the water's edge, and `polygon` is a small square one channel wide at
that point, so an asset can be placed without re-deriving the direction. The channel and the water body
overlap by half a channel at a mouth, which is what a mouth is: the channel widens where it meets
standing water. There is one mouth per course that reaches standing water, and a mouth is the only
place a map says a river met something: a delta, a silt bank or an estuary goes here. Every river ends
at a mouth, at the edge of the world, or on a river already published, and never in open ground.

## vegetation

```ts
interface VegetationEntity extends MapEntity {
  type: 'tree';
  species: string;
  position: Point;
  radius: number;
  collision: { type: 'circle'; center: Point; radius: number };
}
```

`radius` is the visual canopy, 10 to 18 world units. `collision.radius` is deliberately smaller, 3.5
to 5.5, so a trunk blocks and the leaves do not. `collision.center` always equals `position`. `species`
is `oak` or `birch`, chosen by local moisture.

```json
{
  "id": "tree-1",
  "type": "tree",
  "species": "oak",
  "position": { "x": 189.69728986267, "y": 218.04313412867486 },
  "radius": 14.704159939661622,
  "rotation": 0.8442578267501126,
  "collision": {
    "type": "circle",
    "center": { "x": 189.69728986267, "y": 218.04313412867486 },
    "radius": 4.801081293728203
  },
  "asset": { "category": "vegetation.tree", "variant": "oak-1" }
}
```

## forests

A forest is a grove of trees published as one entity. It exists for the read path: a consumer
resolving a movement query tests each forest's bounds box and then only walks the trunks of the
forests near the query, instead of testing every tree on the map.

```ts
interface ForestEntity extends MapEntity {
  type: 'forest';
  species: string;
  geometry: PolygonGeometry; // convex hull around the trees, 3 to 24 points
  trees: VegetationEntity[]; // 2 to 128 trees; the generator emits 3 or more
  asset: { category: 'vegetation.forest'; variant: string };
  metadata: { treeCount: number; densityPct: number; walkableInside: boolean };
}
```

`species` is `oak`, `birch`, or `mixed`, taken from the majority of the trees inside. `geometry` is the
convex hull of the tree positions, counter-clockwise, and every tree lies inside it.

A forest **must not** carry `collision`, which is the one break from the rule that every blocking
feature has one. A grove is not a wall. The trunks block and the clearings between them stay walkable,
so treating the hull as a wall would seal ground the player is meant to cross. A map that puts
`collision` on a forest is rejected.

`trees` is a copy of the entries in `vegetation`, not a separate set of trees. At least two, and the
generator emits three or more. Every tree in a forest must also appear in `vegetation` with the same id
and identical fields, and no tree appears in two forests. This is duplication, not a second truth: a
consumer wanting a flat tree list uses `vegetation` and needs no new code, and validation fails if the
two copies ever disagree.

`metadata.densityPct` is canopy cover, 0 to 100, saturated at 100. Canopies overlap freely, so the raw
ratio of canopy area to hull area runs into the thousands in a thick wood; cover cannot exceed the
ground there is. `metadata.walkableInside` is measured, not assumed: the generator rasterises
walkability at 8-unit cells and records whether any cell inside the hull is clear of water, rock, and
trunks. Roughly a quarter of groves on a densely wooded map report `false`, which is a true statement
about thick wood at that resolution and not a defect.

Grove size is capped at 128 trees. Trees link by proximity, so in dense woodland the links chain and
one component can swallow the map: over a thousand trees on a 4096x4096 default. A hull over that
many trees narrows nothing, so an oversized component is split on its wider axis at the median until
each part fits. A grove is a local wood, not a woodland. Splitting by proximity instead would break a
wood into arbitrary pieces, and the median keeps the pieces roughly square.

```json
{
  "id": "forest-2",
  "type": "forest",
  "species": "oak",
  "geometry": {
    "points": [
      { "x": 467.10282624699175, "y": 243.23847617488354 },
      { "x": 488.7969619128853, "y": 244.91557502187788 },
      { "x": 497.31472798157483, "y": 264.06441053841263 },
      { "x": 477.7666717534885, "y": 261.40952289570123 }
    ]
  },
  "trees": [
    {
      "id": "tree-108",
      "type": "tree",
      "species": "oak",
      "position": { "x": 467.10282624699175, "y": 243.23847617488354 },
      "radius": 16.095158183947206,
      "rotation": 4.174596564451918,
      "collision": {
        "type": "circle",
        "center": { "x": 467.10282624699175, "y": 243.23847617488354 },
        "radius": 5.161063708830625
      },
      "asset": { "category": "vegetation.tree", "variant": "oak-3" }
    }
  ],
  "asset": { "category": "vegetation.forest", "variant": "oak-1" },
  "metadata": { "treeCount": 4, "densityPct": 100, "walkableInside": false }
}
```

The example grove holds four trees; only the first is shown.

## roads

A road is a centreline plus a width. `path` runs from one end of the road to the other. `collision` is
the ribbon formed by offsetting the centreline to each side, so it has exactly twice as many points as
`path`, and it covers the visible surface and nothing else.

```ts
interface RoadEntity extends MapEntity {
  type: 'road';
  kind: 'primary' | 'secondary' | 'path';
  path: Point[];
  width: number;
  collision: { type: 'polygon' } & PolygonGeometry;
  metadata: {
    length: number;
    crossings?: RoadCrossing[];
  };
}

interface RoadCrossing {
  riverId: string;
  point: Point;
  span: number;
}
```

`width` is the full width, not the half-width, and is a constant per kind: 22 for `primary`, 14 for
`secondary`, 7 for `path`. `metadata.length` is the centreline length.

`metadata.crossings` is where a road's surface reaches a river. A road goes over a channel rather than
stopping at the bank, so a crossing is a place on the road that a consumer has to build for:
`riverId` names the `water` entity, `point` is the point on the river's surface closest to the road,
and `span` is the width of the channel to cover, which is `rivers.width`. A road's surface is its
centreline a half-width either side, so a road running along a bank with its edge in the water has a
crossing as well as one going over. `span` is the channel's width, not the length of a bridge. The key
is absent when the road's surface reached no river, and a road that meets the same river twice has one
crossing rather than two.

A crossing is a hint that the two surfaces touch, not proof the road spans the channel: a road running
along a bank with its edge in the water carries a crossing too. The data a consumer needs to build
for it is all present — `road.path` is the full centreline and the river's `geometry` is the full
channel — so the actual overlap is a point-in-polygon test between them, and a consumer that wants to
place a bridge sizes it from the part of the centreline that is over the channel. `crossings` is a
shortcut for finding the site; `path` and `geometry` are the truth.

```json
{
  "id": "road-11",
  "type": "road",
  "kind": "path",
  "path": [
    { "x": 16.140293137166722, "y": 83.6800092879319 },
    { "x": 77.54069405882124, "y": 16.66489505882124 }
  ],
  "width": 7,
  "collision": {
    "type": "polygon",
    "points": [{ "x": 12.828375, "y": 82.35 }, "... 4 points total"]
  },
  "asset": { "category": "road.path", "variant": "path-1" },
  "metadata": { "length": 90.89023474207896 }
}
```

A junction is not an entity. Two centrelines simply meet, and a road that branches from another is
required to touch it. Every other pair of roads is kept a minimum distance apart, so a consumer can
tell a junction from two roads running alongside each other.

## structures and barriers

Both are `MapEntity[]` and both are empty on a generated map. They exist in the format so an importer
or a later generation stage can populate them without a version bump.

## Asset references

`asset` is a `{ category, variant }` pair, and the generator uses a fixed vocabulary:

| Collection   | `category`                   | `variant`                                                 |
| ------------ | ---------------------------- | --------------------------------------------------------- |
| `terrain`    | `terrain.grass`              | `temperate-1`, `meadow-1`, `scrub-1`, `rock-1`, `beach-1` |
| `water`      | `water.lake` / `water.river` | `lake-1`, `lake-2`, ... / `river-1`                       |
| `vegetation` | `vegetation.tree`            | `oak-1`..`oak-3`, `birch-1`..`birch-3`                    |
| `roads`      | `road.<kind>`                | `<kind>-1`                                                |

`asset.category` is `terrain.grass` for every terrain kind including rock and beach; the kind is
carried by `variant`. Switch on the semantic `kind` field, not on the asset, when behaviour depends
on the surface.

## metadataLayers

Optional, and never required to render or play a map. A generated map always includes it.

```json
{
  "metadataLayers": {
    "fields": {
      "columns": 32,
      "rows": 25,
      "terrain": ["... 800 values"],
      "elevation": ["... 800 values"],
      "moisture": ["... 800 values"],
      "vegetation": ["... 800 values"]
    },
    "generation": {
      "seed": 7,
      "width": 900,
      "height": 700,
      "origin": { "x": 0, "y": 0 },
      "world": { "width": 900, "height": 700 },
      "terrain": { "variation": 0.35, "scale": 0.004 },
      "water": { "amount": 0.15, "scale": 0.003 },
      "vegetation": { "density": 0.65, "clustering": 0.8 },
      "roads": { "density": 0.5 }
    },
    "waterLevel": 0.4388851979260837
  }
}
```

`fields` is the noise grid the map was contoured from: `columns` and `rows` are at most 64 each, and the
four arrays are row-major, normalised to `[0, 1]`, each of length `columns * rows`. `generation` is the
fully resolved configuration, which is why an imported map can be regenerated exactly. `waterLevel` is
the elevation threshold the lakes were cut at, and is `null` when the map has no water.

`generation.origin` and `generation.world` place the map in a larger landscape. `world` is measured
from `(0, 0)`; `origin` is where this tile sits inside it. The terrain is sampled at `origin + local`
and the thresholds are quantiles of a sample of the whole world, so tiles of one world agree at their
shared edges. Coordinates in the map itself stay tile-local and inside `bounds`, whatever `origin` says,
so nothing else in the document changes when a map is a tile. A map generated with neither an `origin`
nor a `world` has `origin` at `{ 0, 0 }` and `world` equal to its own `bounds`.

Sampling a field is a one-liner over the plain array, with the index clamped so an edge coordinate
cannot read past the end:

```js
const { columns, rows } = map.metadataLayers.fields;
const sample = (field, x, y) => {
  const column = Math.min(columns - 1, Math.max(0, Math.floor((x / map.bounds.width) * columns)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y / map.bounds.height) * rows)));
  return map.metadataLayers.fields[field][row * columns + column];
};
```

## Validation

`validateMap(value)` returns `{ valid, errors }` with every violation it found, rather than stopping at
the first. `assertValidMap(value)` throws on the first.

A map is rejected when:

- `version` is anything but `"1.2"`, or `bounds` has a non-positive dimension.
- Any number is not finite, or a point, polygon vertex, circle, or rectangle falls outside `bounds`.
- An `id` is empty or repeats anywhere in the map.
- A ring has fewer than 3 or more than 32,768 points, is self-intersecting, or encloses no area.
- A hole is not inside its outer ring, touches it, or overlaps another hole.
- A tree canopy overlaps a lake.
- A terrain, water, or road entity is missing a field its collection requires, or carries a `kind`
  outside the allowed set.
- Collision is present on a terrain region but is not a valid polygon.

Nothing is checked about whether the world makes sense. Two roads may run in parallel, a road may stop
short of anything, and a beach may be a few units wide. Those are design outcomes, not errors.

## See also

- [Consuming generated maps](consuming-maps.md) — how to use this in a game
- [Generation](generation.md) — how the map is produced
- [Architecture](architecture.md) — where the boundary sits
