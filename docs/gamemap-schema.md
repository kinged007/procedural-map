# GameMap v1.4 schema

The canonical product boundary is `GameMap` v1.4. Generation, native JSON import, and future external
import adapters all produce this model, and a consumer uses the same geometry regardless of which one
produced it.

The exported JSON follows `gameMapSchema`, which the library exports as a plain object. `validateMap`
enforces the rules below; `assertValidMap` throws instead of returning.

Every example in this document is taken from a real map, generated with
`generateMap({ seed: 7, width: 900, height: 700, water: { amount: 0.15 } }`. Long coordinate arrays are
elided with a comment rather than truncated silently.

## What changed in 1.4

1.4 adds a `settlements` collection, a `docks` one and a `resourceSites` one. Before it a map had
houses but no village: buildings were placed one at a time against a road and nothing said which of
them belonged together, nothing said a place reached the water, and nothing said where the ground was
worth gathering on.

| Change                                | Kind                    | What a consumer does                                                                                                                |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `settlements` holds places            | new required collection | Iterate it. Each entry is a settlement with a `kind`, a `position`, a `radius`, a `clearing`, and the buildings inside it.          |
| `settlements` membership is by id     | new                     | `metadata.buildingIds` names the buildings, and may be empty: a settlement nobody built in is still one.                            |
| A settlement carries no collision     | new                     | Its `radius` says how far the place reaches. It is not a wall, so a consumer testing the ground it covers uses the distance itself. |
| Generation config gains `settlements` | new optional config     | `settlements: { count }`. Unset is `count: 2`, and a map with no roads publishes none.                                              |
| `docks` holds decks                   | new required collection | Iterate it. Each entry is a deck standing in water, with the place it serves and the water it stands in.                            |
| A dock carries no collision           | new                     | A deck is ground to walk on, and the walkability raster carves the water it covers back open.                                       |
| `resourceSites` holds sites           | new required collection | Iterate it. Each entry is a `mine`, a `fishing` spot or a `hunting` site, named for the ground it sits on.                          |
| A mine faces out of its rock          | new                     | `rotation` is the entrance direction. It is required on a `mine` and a `hunting` site, and forbidden on a `fishing` spot.           |
| A site carries no collision           | new                     | A site is a mark on the ground, not a thing in it.                                                                                  |
| Generation config gains `resources`   | new optional config     | `resources: { mine, fishing, hunting }`. All three unset is `0`: the generator has no geology and says nothing by default.          |
| A building says whether it stands     | new required field      | `state` is `standing` or `ruined`. A ruin carries no `collision`, so rubble is walkable.                                            |

A 1.3 map still validates as 1.3, and a 1.4 map does not validate as 1.3: the validator accepts
`"1.4"` only, `settlements`, `docks` and `resourceSites` are required, and all three are checked for
their shape. A 1.3 map read by a 1.4 consumer has none, so anything that renders or uses places has to
cope with none.

## What changed in 1.3

1.3 populates `structures` with buildings. In 1.2 that collection existed and was always empty, and is
the only change: a consumer written against 1.2 keeps working, and one that iterates `structures` to
find out what kind of world it has just been handed.

| Change                              | Kind                             | What a consumer does                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `structures` holds buildings        | was always `[]`                  | Iterate it. Every entry is a building, so `category` and `rotation` are always present.                                                                                                                                      |
| `structures` item shape is fixed    | narrower than the generic entity | `type` is `building`, and `category`, `state`, `width`, `depth`, `geometry`, `collision`, `asset` and `metadata` are required, except that `collision` is required of a `standing` building and forbidden on a `ruined` one. |
| Generation config gains `buildings` | new optional config              | `buildings: { density, spacing, setback, ruin, categories }`. Unset is `density: 0.5, spacing: 34, setback: 16, ruin: 0, categories: { house: 8, farm: 1 }`.                                                                 |

A 1.2 map still validates as 1.2, and a 1.3 map does not validate as 1.2: the validator accepts
`"1.3"` only, and `structures` is checked for the building shape rather than as a generic entity. A
consumer that hand-writes a map and put its own entity in `structures` has to move it to `barriers`,
which is the collection for an entity the generator did not produce.

## What changed in 1.2

1.2 adds rivers. A consumer written against 1.1 keeps working, because every 1.2 addition is either an
optional field or a new value on an existing enum, and a 1.1 reader that ignores both behaves exactly as
before. A consumer that wants the new features opts in.

| Change                           | Kind                | What a consumer does                                                                                                        |
| -------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `water.kind` gains `"river"`     | new enum value      | A water body that is a channel rather than a body. It has the same shape as a lake: a `geometry` and a `collision` polygon. |
| `water.metadata.mouths`          | new optional field  | Where a river's channel becomes standing water. `[{ waterId, point, polygon }]`, absent on a river that reached no water.   |
| `road.metadata.crossings`        | new optional field  | `[{ riverId, point, span }]`, absent on a road whose surface reached no river. See [roads](#roads).                         |
| Generation config gains `rivers` | new optional config | `rivers: { density, width }`. Unset is `density: 1, width: 12`.                                                             |

Two changes are not additive, and a 1.1 reader that assumed them will notice:

- **A river is a `water` entity, so a count of water bodies is now a count of lakes plus rivers.** The
  split them on `kind`. Generation skips river generation entirely when `rivers.density` is `0`.
- **A road now goes over a river instead of treating it as an obstruction.** In 1.1 only lakes and
  impassable rock refused a road. A 1.1 consumer that asserted a road never touches water will fail on a
  1.2 map; the assertion it wants is that a road never enters a _lake_.

The `version` string is the only place the two are distinguishable: a 1.1 map validates as neither 1.1
nor 1.2 under the current validator, which accepts the newest version only.

## Top level

```ts
interface GameMap {
  version: '1.4';
  metadata: { id: string; seed?: number; generator?: string; generatedAt?: string };
  bounds: { width: number; height: number };
  terrain: TerrainRegion[];
  water: WaterRegion[];
  vegetation: VegetationEntity[];
  forests: ForestEntity[];
  structures: BuildingEntity[];
  settlements: SettlementEntity[];
  docks: DockEntity[];
  resourceSites: ResourceSiteEntity[];
  roads: RoadEntity[];
  barriers: MapEntity[];
  metadataLayers?: { fields?: SpatialFields; [key: string]: unknown };
}
```

All thirteen of `version`, `metadata`, `bounds`, `terrain`, `water`, `vegetation`, `forests`,
`structures`, `settlements`, `docks`, `resourceSites`, `roads`, and `barriers` are required, even when
the collection is empty. `metadataLayers` is optional.
A generated map fills `structures` with buildings, `settlements` with places, `docks` with decks and
`resourceSites` with sites to gather at — though the last two are empty unless asked for — and leaves
`barriers` empty.

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

A beach is a keep-out, not a collider. It carries no `collision`, so it is walkable, and it is kept
clear of both trees and buildings: nothing is planted in the sand and nothing is built on it, which
leaves a consumer free to put its own harbour on any shoreline it likes. Because the band is the
lake's ring offset **outward**, it lies entirely on the landward side of the water, so a consumer
testing "is this point in a beach" gets the sand and never a duplicate of the lake.

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

`structures` is a `BuildingEntity[]`: the buildings the generator placed along the road network. Every
entry has the same shape, and validation rejects anything else.

```ts
interface BuildingEntity {
  id: string;
  type: 'building';
  /** What it is, which fixes its footprint and how far back it stands. */
  category: 'house' | 'farm';
  /** Whether it stands or has fallen down. A game that renders its own styles may ignore this. */
  state: 'standing' | 'ruined';
  position: Point;
  /** Radians: the compass direction the front of the building looks. */
  rotation: number;
  /** Frontage along the road. */
  width: number;
  /** Depth away from the road. */
  depth: number;
  /** The footprint. The same polygon as `collision` on a standing building. */
  geometry: PolygonGeometry;
  /** Present on a standing building, absent on a ruin. */
  collision?: { type: 'polygon' } & PolygonGeometry;
  asset: AssetReference;
  metadata: {
    /** The road it was placed against, or absent if it stands off the network. */
    roadId?: string;
    /** How far the front wall stands from that road's centreline. */
    setback: number;
  };
}
```

Two conventions are worth stating outright. `rotation` points from the building **towards the road**,
so a building placed on a road looks back down it; it is not the road's own heading. And `geometry` is
a rectangle `width` across and `depth` deep, written ring-wise starting on a back corner, so the front
wall — the edge nearest the road — is the one from `points[1]` to `points[2]`, and `points[0]` to
`points[1]` is a side wall. A consumer that needs the front wall can work it out from `position` and
`rotation` instead, which is what the renderer does, and is the safer route if a hand-written map ever
wrote the ring the other way round.

The footprint is a ring of exactly four points and is a solid rectangle, which is what a consumer
places its own asset into.

`barriers` is a `MapEntity[]` and is empty on a generated map. It is where a wall, a gate, or anything
else the generator did not produce belongs, and it is validated as a generic entity rather than as a
building.

## settlements

`settlements` is a `SettlementEntity[]`: the places on the map, each a centre with the buildings
around it. A settlement answers "where is the village", which `structures` on its own cannot, because
`structures` is a list of buildings rather than of places.

```ts
interface SettlementEntity {
  id: string;
  type: 'settlement';
  /** What the settlement is by size, read off `metadata.buildingIds.length`. */
  kind: 'hamlet' | 'village' | 'town';
  /** The centre, which stands on the road network. */
  position: Point;
  /** How far the settlement reaches from its centre, in world units. */
  radius: number;
  /** The open ground at the middle of the place, which nothing is planted in or built on. */
  clearing: PolygonGeometry;
  metadata: {
    /** The buildings inside the settlement, which may be none at all. */
    buildingIds: string[];
  };
}
```

Three things follow from this shape, and a consumer that assumes otherwise will be wrong.

**A settlement carries no collision.** `radius` says how far the place reaches; it is not a wall. A
consumer wanting the ground a settlement covers tests `distance(position, point) <= radius` itself,
the same way it tests a forest hull rather than treating one as movement blocking. There is no
boundary polygon, because a settlement is a distance and not a shape: a circle of 260 units around a
centre in a square world either overflows the map or leaves corners of the map unreachable from it,
and neither is a thing a consumer should have to reconcile.

**`clearing` is the one polygon, and it is open ground.** It is where nothing is planted and nothing
is built, roughly 28 units of reach around `position`, and a consumer placing the middle of the place
puts it at `position` rather than anywhere inside. It is not a collider either. Read the polygon
rather than assuming the usual radius: a centre within 28 units of a map edge gets a smaller clearing,
because a polygon outside the bounds is not a valid one and the settlement is worth more than the
full-width green.

**`kind` is derived, not configured.** It is read off the membership: under 4 buildings is a
`hamlet`, under 9 a `village`, and 9 or more a `town`. There is no knob for it, because a settlement
that could be called a hamlet while holding a town's buildings would be a name the map contradicts,
and a caller who wants different names for a place of a given size changes the names rather than the
generator. A dead settlement therefore reads as a `hamlet`, since it holds nothing. The thresholds are
set to the range the generator actually reaches rather than to a real settlement's headcount: on a
default map a settlement holds at most about a dozen buildings, so a `town` here is a large village
and not a city.

**Membership is by id, and is on the settlement.** `metadata.buildingIds` names the buildings inside it,
and each id resolves to a `structures` entry. Validation rejects an id that does not, so a consumer can
resolve every one without a guard. Membership is on the settlement rather than a `settlementId` back
reference on each building, so reading one settlement takes one read.

**An empty membership is valid.** A settlement with no buildings is a dead settlement, and the PRD
asks for maps that have one: mixing a high `settlements.count` against a low `buildings.density`
produces them without a separate switch. A consumer that assumes every settlement is inhabited will
render an empty place, which is the correct result and not a data error.

A map with no roads publishes no settlements, because a centre is placed on a road and a map with
nothing but open ground has nowhere to put one.

## docks

`docks` is a `DockEntity[]`: the plank decks standing in the water off a shore. A dock answers "where
does this place reach the water", which neither `structures` nor `settlements` can: a building stands
on land and a settlement is a place.

```ts
interface DockEntity {
  id: string;
  type: 'dock';
  /** Where the deck is rooted, on the waterline where it meets the land. */
  position: Point;
  /** The heading the deck runs along, out from the bank over the water. */
  rotation: number;
  /** Full width of the deck, in world units. 16. */
  width: number;
  /**
   * How far the deck runs out from the bank, in world units. The whole of a deck is over water, and
   * this is measured to the last point the water allows rather than set to a fixed number.
   */
  depth: number;
  /** The deck surface, and the shape the walkability raster carves back open. */
  geometry: PolygonGeometry;
  asset: AssetReference;
  metadata: {
    /** The road that reaches this shore. The deck is rooted on the waterline, not on the road. */
    roadId?: string;
    /** The place this is the waterfront of. */
    settlementId: string;
    /** The body of water the deck stands in. */
    waterId: string;
  };
}
```

Five things follow from this shape, and a consumer that assumes otherwise will be wrong.

**A dock is a rectangle standing in the water, touching the bank at one end.** `position` is its root
on the waterline, and the deck runs out from there along `rotation` for `depth`. A consumer drawing a
pier anchors it at `position` and runs it along that heading. The whole rectangle is over water: the
only part that may touch the bank is the root edge, and the median deck is measured at 0% of its area
on land. A deck is never laid across the ground between a road and a lake.

**A dock carries no collision, and a map that gives it one is rejected.** A deck is ground a character
walks on rather than a wall, which is the opposite of a building. The raster is the other half of the
same statement: a deck's cells are carved back open _after_ the blockers are filled, so a character can
walk the length of the deck and step off the end of it. See
[walking on the map](consuming-maps.md#walking-on-the-map).

**`depth` is measured, not a constant.** It is the distance from the root to the last point still
inside `waterId`, measured across the deck's whole width rather than its centreline, so a pier in a
narrow inlet is a short one and a pier off a broad shore is a full-length one, and neither ever lands
on the far bank. It is between 12 and 40 units, and both ends are numbers a consumer can rely on: a
deck shorter than 12 would not read as a deck, and a longer one is a jetty rather than a landing
stage.

**`settlementId` is required, and it is required at the deck's own root.** A deck is a place's
waterfront, so the place is required, validation rejects a deck naming a settlement that is not on the
map or a `waterId` that is not either, and the generator places a deck only where its root falls
inside some settlement's `radius`. `roadId` is optional for the same reason it is on a building: a deck
can be reached over open ground rather than along a road, and it names the road that serves the shore
rather than a point on the deck.

**The count is bounded by the shore and not by anything else.** `docks: { count }` is unset at `0`,
which is a map of no harbours: a pier is a strong statement about a place and the generator has no
opinion on whether any of them is a port. A map with no settlements publishes no docks at any count,
and a settlement that stands nowhere near water has no waterfront to publish. It is _not_ bounded by
the number of settlements, because one place on a long shore can carry several decks: two settlements
reach sixteen on a 2048 by 1536 map, eight of them to one place.

## resourceSites

`resourceSites` is a `ResourceSiteEntity[]`: the places worth gathering something at. It answers
"where is the ground that makes gathering make sense", which nothing else on the map can — `terrain`
says what the ground _is_, and a rock region is a thousand square units of face a consumer has to
reduce to a site on its own.

**The generator is neutral about what a site yields.** There is no geology on the map: the fields are
elevation, moisture and vegetation, and nothing in a `GameMap` says where iron is as opposed to copper
or flint. A site is therefore named for the affordance it sits on — a rock face, open water, a wood —
and the consumer decides whether that is iron or flint or nothing, and builds there. A map that
declared its own ores would be a generator with a fantasy bolted to it.

```ts
interface ResourceSiteEntity {
  id: string;
  type: 'resource-site';
  kind: 'mine' | 'fishing' | 'hunting';
  /**
   * A mine is just inside the rock face it is cut into, a fishing spot is in the water, and a hunting
   * site is just inside the edge of its grove, where a character can walk to it.
   */
  position: Point;
  /**
   * Radians. A `mine` and a `hunting` site only, and required on both: each is set at the edge of
   * something and has to say which way is out. A mine without it is a dot on a cliff with no way in,
   * and a hunting site without it is a stand in the trees nobody can walk to. It is the outward normal
   * at the edge, so it points at open ground by construction.
   */
  rotation?: number;
  asset: AssetReference;
  metadata: {
    /** A mine: the rock it is cut into. */
    rockId?: string;
    /** A fishing spot: the body of water it lies in. */
    waterId?: string;
    /** A hunting site: the grove it stands in. */
    forestId?: string;
    /** A fishing spot: the measured distance to the nearest shore of `waterId`. */
    distanceToShore?: number;
    /** A fishing spot: how it is reached. */
    access?: 'land' | 'water';
  };
}
```

Four things follow from this shape, and a consumer that assumes otherwise will be wrong.

**The three kinds are not interchangeable, and each names the one thing it stands on.** Validation
rejects a `mine` with no `rockId`, a `fishing` spot with no `waterId`, and a `hunting` site with no
`forestId`, and rejects any of them naming something not published. A `rockId` has to resolve to a
region whose `kind` is `rock` and not to terrain at large, because a mine is cut into a face and a
mine cut into a meadow is a hole in a field. `rotation` is required on a `mine` and a `hunting` site
and forbidden on a `fishing` spot.

**A mine is inside the rock and its arrow points out of it.** `position` is the boundary pushed 4
units in, which is the overlap that makes it checkable: a consumer can run `pointInPolygon` against
the rock it names and get an answer that means something, where a marker sitting exactly on the
boundary is ambiguous to the same test. `rotation` is the outward normal at that point, so
`position + 16 * (cos, sin)` is clear of the rock by construction — the generator only publishes faces
where it is, and a test holds that over every site on every seed.

**A fishing spot is in the water and says how far out it is.** `distanceToShore` is measured to the
nearest shore of _its own_ body, islands included, and `access` is derived from it: `land` within 32
units, `water` beyond. Both numbers are published because they answer different questions — `access` is
the verdict the generator gives, and the distance is the measurement behind it, so a consumer that
would rather its spots were 50 units out reads the number and ignores the verdict. Nothing needs
walking to reach a `water` spot, which is the whole point of it, so a spot is not refused for being
unreachable from land.

**A hunting site is at the edge of a wood that faces open ground.** It names a grove with at least 20
trees and `metadata.walkableInside` set, and sits just inside that grove's hull with `rotation` pointing
out of it. It is not in the middle of the wood: the trunks are the obstacle, and a stand in the middle
of a grove is a stand nobody can walk to. The ground it faces has to be clear of every **other** grove,
and of rock and water. The neighbouring-grove test is the one that matters, because two groves of one
wood are separate hulls — their trees are more than the link distance apart — yet their hulls can be a
stride of each other, so an edge facing a neighbour is an edge facing more wood. The 20-tree floor is
needed because `densityPct` cannot tell a copse from a wood: it reads 100 on every hull on a default
map, since a hull is drawn tight around its own canopies, so canopy coverage is full by construction.

**All three counts are upper bounds, and all three default to `0`.** `resources: { mine, fishing,
hunting }` is unset at zero across the board, which is a map that says nothing about where anything is
gathered. They are three numbers rather than one because the ground offers them wildly unevenly: a
default map has 4.7 rock regions with about 4,000 units of face between them, but only 4.5 bodies of
water big enough to fish and sixteen to twenty-three woods big enough to hunt, so a shared count would
be tuned against the scarcest of the three and would quietly cap the other two. Asking for 64 mines
and 64 fishing spots gets both; asking for 64 hunting sites gets every wood there is, which is fewer.
A map with no rock publishes no mines at any count.

A site carries no `collision`, and validation rejects one that does. A site is a mark on the ground,
not a thing standing in it — the third reason in this format for a surface to carry no collision,
after a forest hull and a deck.

## Asset references

`asset` is a `{ category, variant }` pair, and the generator uses a fixed vocabulary:

| Collection   | `category`                   | `variant`                                                 |
| ------------ | ---------------------------- | --------------------------------------------------------- |
| `terrain`    | `terrain.grass`              | `temperate-1`, `meadow-1`, `scrub-1`, `rock-1`, `beach-1` |
| `water`      | `water.lake` / `water.river` | `lake-1`, `lake-2`, ... / `river-1`                       |
| `vegetation` | `vegetation.tree`            | `oak-1`..`oak-3`, `birch-1`..`birch-3`                    |
| `roads`      | `road.<kind>`                | `<kind>-1`                                                |
| `structures` | `structure.house` / `.farm`  | `<category>-1`, or `<category>-ruin` for a ruin           |
| `docks`      | `structure.dock`             | `plank-1`                                                 |

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

- `version` is anything but `"1.4"`, or `bounds` has a non-positive dimension.
- Any number is not finite, or a point, polygon vertex, circle, or rectangle falls outside `bounds`.
- An `id` is empty or repeats anywhere in the map.
- A ring has fewer than 3 or more than 32,768 points, is self-intersecting, or encloses no area.
- A hole is not inside its outer ring, touches it, or overlaps another hole.
- A tree canopy overlaps a lake.
- A terrain, water, or road entity is missing a field its collection requires, or carries a `kind`
  outside the allowed set.
- Collision is present on a terrain region but is not a valid polygon.
- A settlement is missing a `kind` outside the allowed set, a positive `radius`, or a
  `metadata.buildingIds` list, or carries an id that names no building in `structures`. An empty list
  is valid.

Nothing is checked about whether the world makes sense. Two roads may run in parallel, a road may stop
short of anything, and a beach may be a few units wide. Those are design outcomes, not errors.

## See also

- [Consuming generated maps](consuming-maps.md) — how to use this in a game
- [Generation](generation.md) — how the map is produced
- [Architecture](architecture.md) — where the boundary sits
