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

A map generated at a non-zero `origin` still reports its own `bounds` and carries tile-local
coordinates, so every number in it is measured from the tile's own top-left corner. The read path, the
walkability grid and the chunks all work in those coordinates and need no knowledge of the world. A
consumer placing the tile in a larger world adds `origin` itself.

The generator has no fixed world scale. Its constants are tuned so a 2048x1536 map looks right, which
in practice means one world unit reads as roughly one metre in a top-down game. Pick a global scale
factor at import time if you need a different unit.

## Six things to build

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
| River         | polygon         | identical ring           |
| Rock          | polygon         | identical ring           |
| Tree          | circle          | 3.5-5.5 vs. 10-18 canopy |
| Other terrain | none            | passable                 |

Note what is **not** in that list: a tree's collision circle is much smaller than its canopy, so a
player walks under the leaves and into the trunk. Rock and water are impassable, a river included, so
a character wades no further than the bank. Grass, meadow, scrub and beach are passable regardless of
what is drawn on top of them.

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

Roads never cross a lake or rock, and are kept 20 world units clear of any shoreline. A road that runs
out of open ground simply ends. There are no bridges and no fords, so a road network is connected
across a river only where something is built on the published site.

Where a road's surface reaches a river, `road.metadata.crossings` names the river, the point on its
surface closest to the road, and the span of the channel there. It is a _hint that the two surfaces
touch_, published so a consumer can find the site without scanning the whole map — not proof the road
spans the channel. A road running along a bank with its edge in the water also produces a record. For
the asset decision, derive the real overlap from the bundle rather than trusting the marker: `road.path`
is the full centreline, every river publishes its full channel as `geometry`, and `pointInPolygon` is
exported, so any contiguous run of centreline over channel is a bridge the road genuinely spans. That
is the footprint a deck, ford, or ferry asset goes on. The key is absent on a road whose surface
reached no river, so `road.metadata.crossings ?? []` is safe to iterate.

`span` is the channel's width, not the length of a bridge, and a road crossing a river at an angle
needs a deck longer than the channel is wide. A consumer that has to size a bridge takes the part of
the centreline that is over the channel, which is the length of the deck:

```js
import { pointInPolygon } from 'fieldwork-map';

// Every stretch of road a river runs under, which is where a bridge is built.
function bridgeSites(map) {
  const sites = [];
  for (const road of map.roads) {
    for (const river of map.water) {
      if (river.kind !== 'river') continue;
      let over = [];
      const runs = [];
      for (const point of road.path) {
        if (pointInPolygon(point, river.geometry)) over.push(point);
        else {
          if (over.length >= 2) runs.push(over);
          over = [];
        }
      }
      if (over.length >= 2) runs.push(over);
      // A run of two points or more is a road that genuinely goes across the channel. One point is
      // a graze, where the road's edge clips the water and it never gets to the far bank.
      for (const run of runs) {
        const deckLength = run
          .slice(1)
          .reduce(
            (total, point, index) =>
              total + Math.hypot(point.x - run[index].x, point.y - run[index].y),
            0,
          );
        sites.push({ road, river, centreline: run, deckLength });
      }
    }
  }
  return sites;
}
```

A run is a deck, not a point: place the asset along `centreline`, as wide as `road.width`. The
illustrated renderer draws no bridge and no marker at a crossing, because a road is drawn over the water
and a marker there only ever gets in the way of the road it is meant to explain.

Where a river meets standing water, `water.metadata.mouths` on the river names the water body, the point
where the channel met its edge, and a small square one channel wide at that point. That is where a
delta, a silt bank, an estuary, or a waterfall asset goes, and it is the only place a map says a river
met something: a channel runs from its source in the hills, which is the other end of the ring and is
not marked, to the water or off the edge of the map. Iterate `river.metadata?.mouths ?? []`.

### 4. Buildings

`map.structures` holds the buildings placed along the roads, each a typed `BuildingEntity`. A building
is a solid rectangle, so it is a footprint to fit an asset into and a wall to walk into:

- `position` is the centre at ground level, `width` the frontage and `depth` the depth.
- `geometry` is the footprint ring, and `collision` is the same polygon on a standing building.
- `rotation` is in radians and points **from the building towards its road**, so a building placed on
  a road looks back down it. To find a building's front wall, take `position` and step `depth / 2`
  along the direction `rotation` points.
- `asset.category` is `structure.house` or `structure.farm`, and `category` says which. A ruin is
  `structure.ruin`, whatever it used to be.
- `metadata.roadId` is the road it was placed against, and `metadata.setback` is how far its front wall
  stands from that road's centreline.

**Which buildings a map has is your call.** `buildings.categories` is a set of relative weights over the
categories, so a village of houses is `{ house: 1, farm: 0 }` and a farming valley is `{ house: 2,
farm: 1 }`:

```js
generateMap({
  seed: 583921,
  width: 2048,
  height: 1536,
  buildings: { categories: { house: 1, farm: 0 } },
});
```

They are relative, so they need not add to anything, and a category you leave out keeps its default
weight rather than disappearing. A name the generator has no footprint for is rejected rather than
ignored, so a misspelt category fails loudly instead of quietly doing nothing.

One thing to expect: a weight is how often a category is **drawn**, not what share of the map it ends
up as. A farm is four times the ground of a house and stands further back, so it refuses more sites
than a house does and fewer of them survive. At the default one site in nine is drawn as a farm and
about 6% of the buildings are one.

**A standing building blocks the walkability raster.** It is in the same list as the water and the
rock, so a character cannot walk through a wall without you making those cells walkable. If you want
doorways, you find them yourself: nothing in the format says where a door is, and `metadata` has no room
for one until the format grows a field for it.

**A ruin does not block anything.** `state` is `standing` or `ruined`, and a ruin carries no
`collision`, so `rasterizeWalkability` leaves the ground it stood on open and a character walks over the
rubble. The footprint stays, so a ruin is the same building, fallen, and not a smaller one. The
validator enforces both halves: a standing building without collision and a ruin carrying one are both
rejected, because a map that simply omits the field would otherwise read as a field of walkable ruins.

**This field is yours to ignore.** What a building looks like is a game-side decision: whether a
settlement is apocalyptic, a set of sites for the player to build on, a ruin field, or a developed
village is yours to choose, and a game that renders its own styles does not need to read `state` at
all. Set `buildings.ruin` to `0` and the generator decides nothing about it. The field is here because
rubble and a wall are different things to the walkability raster, and a game that never reads it still
gets walkable ground where the ruins are.

If you want style variation per building rather than one share for the whole map, that is a different
field, and Watabou's per-building states are the reference for it rather than this. Nothing here stops
you deriving that yourself from `id`: `state` is a hint about the ground, not a catalogue.

Nothing about a building is a parcel. There is no plot, no boundary, and no ownership: a building is a
rectangle standing on the ground, and the ground around it is ordinary terrain. A farm is a building
that happens to stand 48 units back from a road rather than `buildings.setback`, not a field around it.

Buildings are kept off the beach, which is worth knowing because a beach is ordinary walkable terrain
and nothing else in the map refuses it. The reason is that a house on the sand is a house nobody would
have built, and because a shoreline is where a port, a pier, or a boat shed goes. So a consumer that
wants a harbour is building into ground the generator has deliberately left empty, and can pick its own
shoreline site the same way it picks a river mouth.

Trees are kept off it too, and the band is the reason that is not automatic: a beach is the lake's own
ring offset outward with the lake punched out as a hole, so it sits entirely on the landward side where
a water test never looks. Both trees and buildings keep out by canopy and footprint respectively, so
the strip of sand along every shore is clear ground.

### 5. Settlements

`map.settlements` holds the places. Each one is a centre standing on a road, a `radius` saying how far
it reaches, and `metadata.buildingIds` naming the buildings inside it.

```js
// Every building in a settlement, resolved in one read.
const byId = new Map(map.structures.map((building) => [building.id, building]));
for (const settlement of map.settlements) {
  const houses = settlement.metadata.buildingIds.map((id) => byId.get(id));
  console.log(settlement.id, houses.length, settlement.position);
}
```

A settlement carries no collision. Its `radius` says how far the place reaches, not where you cannot
walk, so test the ground yourself if you need it:

```js
const inSettlement = (settlement, point) =>
  Math.hypot(point.x - settlement.position.x, point.y - settlement.position.y) <= settlement.radius;
```

Two things to expect. Membership may be empty: a settlement with no buildings is a dead settlement,
and a high `settlements.count` against a low `buildings.density` produces them on purpose, so do not
assume every settlement is inhabited. And a map with no roads has no settlements at all, because a
centre is placed on a road.

Every building is in exactly one settlement, the one whose centre is nearest, so resolving a name
never turns up in two places.

### The clearing: ground to build the middle of a place on

Each settlement opens a clearing at its centre, and it is the one piece of a settlement that tells you
where to put something. No tree roots in it, no generated building stands in it, and it carries no
collision, so it is walkable ground rather than a reservation.

```js
// The middle of the place, and the open ground around it.
const centre = settlement.position; // on the road, inside the clearing
const open = settlement.clearing; // a polygon, about 28 units of reach
```

Put a building, a well, or a plaza at `position`. It lands on the road with the clearing around it,
and the walkability raster already reads the whole clearing as open, so a character spawned there has
room. Measured over 852 settlements on 180 maps, no tree canopy and no building overlaps a clearing,
and the nearest blocker to a centre is never closer than 27 units.

Read the polygon rather than assuming 28: a centre within 28 units of a map edge gets a smaller
clearing so the polygon stays inside the bounds.

### 6. Docks

`map.docks` holds the plank decks standing in the water off a shore. There are none unless you ask for
them: `docks: { count }` is unset at `0`.

```js
const map = generateMap({ seed: 583921, width: 2048, height: 1536, docks: { count: 4 } });
for (const dock of map.docks) {
  console.log(dock.metadata.settlementId, dock.metadata.waterId, dock.width, dock.depth);
}
```

A dock is a place's waterfront, so it names the settlement it serves and the water it stands in, and
both ids resolve. That is the whole join: to know which places are ports, read `docks` and collect the
`settlementId`s. One place can have several decks if its shore is long, and a place with no deck is a
place that does not stand on a shore.

```js
const ports = new Set(map.docks.map((dock) => dock.metadata.settlementId));
```

Two things to plan around. A dock carries no collision and is **walkable**: the walkability raster
carves the water it covers back open, so a character can walk the length of a pier and stand at the
end. And the count is bounded by the shore rather than by anything you set: a map with no settlements
publishes no docks however many you ask for, and `count: 16` on a map with two settlements on one long
shore fills.

The deck's own `geometry` is the rectangle it is drawn and carved as: 16 units across, rooted at
`position` on the waterline, running out over the water for `depth`. The whole of it is water, so
there is no land crossing for a consumer to reason about — a pier is anchored at `position` and drawn
along `rotation`. `depth` is measured rather than fixed and runs from 12 to 40, so a pier in a narrow
inlet is a short one and a pier off a broad shore is a full-length one.

### 7. Resource sites

`map.resourceSites` holds the places worth gathering something at. They are all `0` by default, and
that is the honest default rather than a missing feature: **the generator has no geology and will not
tell you where iron is.** It tells you where the ground is worth building on.

```js
const map = generateMap({
  seed: 583921,
  width: 2048,
  height: 1536,
  resources: { mine: 6, fishing: 6, hunting: 4 },
});
for (const site of map.resourceSites) console.log(site.kind, site.position, site.metadata);
```

Each entry is a `mine`, a `fishing` spot or a `hunting` site, and each names the one thing it stands
on — a `rockId`, a `waterId` or a `forestId` — so all three ids resolve against collections you
already have. You decide what a site is worth: a mine is iron, or silver, or a hand-dug hole, and the
map has no opinion.

**A mine is inside the rock and its `rotation` points out of it.** The position is the rock face
pushed 4 units in, so `pointInPolygon` against the rock it names is unambiguous, and the generator only
picks faces that have open ground within 16 units along the arrow. Place a mine mouth at `position` and
run its door along `rotation`.

**A fishing spot is in the water, and `access` says how you get there.** `land` means close enough to
the bank to walk out to it; `water` means you need a boat. `distanceToShore` is published beside it and
is a measurement rather than a verdict — read the number instead if you would rather your spots were
further out than the generator's 32-unit line. A `water` spot is deliberately not reachable from land;
nothing is wrong with it.

```js
const boatSpots = map.resourceSites.filter(
  (site) => site.kind === 'fishing' && site.metadata.access === 'water',
);
```

**A hunting site is at the edge of its wood, facing out of it.** It names a grove of 20 trees or more
with open ground inside it, and stands just inside the grove's own edge with `rotation` pointing out.
It is not in the middle of the wood: the trunks are the obstacle, so a stand in the middle of a grove
is a stand nobody can walk to. The ground it faces is clear for 16 units — of every _other_ grove, of
rock and of water — so you can put a camp at the far end of the arrow and walk to it.

```js
// Somewhere a hunter can stand, with open ground behind them.
for (const stand of map.resourceSites.filter((s) => s.kind === 'hunting')) {
  const camp = {
    x: stand.position.x + Math.cos(stand.rotation) * 8,
    y: stand.position.y + Math.sin(stand.rotation) * 8,
  };
}
```

Two groves of one wood are separate hulls — their trees are more than the link distance apart — yet
their hulls can be a stride of each other, which is why a stand is never published facing a
neighbouring wood. The stand marks a wood rather than a spot, so you can put your camp anywhere inside
`metadata.forestId`'s hull.

Three things to plan around. A site carries no collision and blocks nothing — a site is a mark on the
ground, not a thing standing in it, so put your own building there and it is yours to collide. The
counts are upper bounds, and bounded very unevenly: a default map has 4.7 rock regions and thousands of
units of face, but only 4.5 fishable bodies and 16 to 23 huntable woods, so `hunting: 64` gives you
every wood there is and no more. And a map with no rock publishes no mines at any count.

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

**A cell is blocked if any part of it is covered by a water polygon or a rock region.** A dock's deck
is the single exception, carved back open afterwards.

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

**A dock's deck is in the raster, written after the blockers.** This is the one thing that opens a cell
the fill rule would have blocked, and it is the reason a character can walk out along a pier and stand
at the end of it. It is a second pass of the same fill rather than an exception to the rule: a cell a
deck opens was blocked by water a moment earlier and the deck covered it, which is the one thing a
consumer has to know in order to draw a pier. A dock therefore never makes an island — every open cell
under a deck is reachable on foot from the deck's own anchor, because the deck starts on the road that
reached it.

What a deck does cost is resolution. A deck is 16 units across, so below a 32-unit cell the raster can
see none of it: no cell centre lands inside a deck narrower than half a cell. At `cellSize: 32` a pier
may contribute one cell or none, and at `cellSize: 64` usually none. That is the granularity of the
grid rather than a failure of the carve, and it is the same ceiling the whole field has.

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

To start a character in a settlement rather than in the middle of the widest field, ask for it. The
settlement centres come first, each carrying the id of the settlement it belongs to, and the rest of
the count is filled from the roomiest ground as usual:

```js
const [home, ...rest] = spawnCandidates(raster, map, {
  count: 8,
  minSeparation: 200,
  preferSettlements: true,
});
home.settlementId; // 'settlement-1', or undefined on a map with no settlements
```

A settlement centre stands on a road, so it is open ground, and its clearing widens that: the nearest
blocker to a centre is never closer than 27 units, so the snap below almost never has to move. The
raster blocks a cell that water or rock touches anywhere inside it, so a centre on a road running
along a shore can still fall in a cell the fill blocked for touching the water; the nearest open cell
is used instead. A cell size larger than the clearing radius also reports a centre as blocked, because
conservative rasterization blocks a cell on a trunk just outside the green.

Across 144 settlements at cell sizes from 8 to 32, 92 to 94% of centres already sat on an open cell
and every settlement was offered, landing 2 to 14 units from its centre. A settlement with no open
ground at all is skipped rather than offered on blocked ground.

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
calling thread. Above 4096 in either axis the config is rejected, so a larger world is built from
tiles.

## Building a world from tiles

Pass `origin` and `world` and the tile is a window onto a larger landscape rather than a world of its
own. The same seed, the same settings, the same `world`, and origins that tile the world without gaps
give tiles that join.

```js
const world = { width: 8192, height: 6144 };
const tiles = [];
for (let y = 0; y < world.height; y += 2048)
  for (let x = 0; x < world.width; x += 2048)
    tiles.push(generateMap({ seed: 583921, width: 2048, height: 1536, origin: { x, y }, world }));
```

Two things happen that do not happen without them, and both are the reason this is worth two config
fields.

- **The fields are one function of world position.** A tile samples noise at `origin + local`, so its
  edge carries the same numbers as its neighbour's edge at the same world coordinate. The values are
  equal, not close.
- **Every threshold is measured against the world.** The water level, and the rock, meadow and scrub
  levels, are quantiles of a sample of the whole world rather than of the tile. That matters for all
  four and not just the water: rock is the high ground at the 94th percentile, so a tile measuring it
  locally seams exactly as badly as a tile measuring the waterline locally.

Placement is seeded from the tile's position as well as the map seed, so tiles do not repeat each
other's groves, and the map id carries the origin so a world assembled from tiles has no duplicate
entity ids.

Left alone, `origin` is zero and `world` is the tile's own size, and a single-tile map is unchanged
byte for byte. `world` and `origin` are recorded in `metadataLayers.generation`, so a tile saved as
JSON remembers where it came from.

Two limits worth knowing. The field grid is capped at 64 samples across whatever the world measures, so
a world of 64,000 units gets 1,000-unit samples and visibly blocky terrain. And contours are still
traced per tile from that tile's own grid, so a lake that straddles a seam is published as two
polygons meeting there: both sides agree where the waterline is, but the vertices along the seam can
sit up to one grid spacing apart, about 28 world units. Joining them into one polygon is a stitching
step for whoever owns the world.

## Determinism

The same resolved configuration always produces a byte-identical map. Two consequences worth relying
on:

- A seed plus a config is a complete save file. Store `(seed, width, height, terrain, water,
vegetation, roads, rivers, buildings)` and you can rebuild the world exactly, which is a fraction of
  the JSON size.
- Generated maps are comparable. If two maps with the same config differ, something in the pipeline
  changed the data, and a diff of the exports will show it.

`metadataLayers.generation` holds the fully resolved config, defaults filled in. Read that rather than
the config you passed in, or the defaults will drift between versions.

## What is not produced yet

So the map is not mistaken for more than it is:

- **No barriers.** `map.barriers` is empty on a generated map; it is where an imported wall, gate, or
  fence belongs.
- **No plots, parcels, or resources.** Buildings are published, but a building is a rectangle on the
  ground, not a parcel it sits in. Settlements are published — see below — but a settlement is a centre
  and a list of the buildings around it, not land divided between owners. `resourceSites` says where
  gathering would make sense and deliberately does not say what a site yields: there is no ore, no
  fish and no game in a `GameMap`, because the generator has no geology and a fantasy bolted to it is a
  different product.
- **No bridges or fords.** Rivers are published, and a road records the site of each crossing its
  surface reached, but nothing is built there. A river also blocks the walkability raster where a road
  goes over it, so a character cannot walk the crossing until you make those cells walkable. A river
  also meets a water body on a published site rather than running over it, and a river's channel is
  its geometry, so a bridge deck is drawn by you.
- **No heightmap or 3D data.** The map is flat. Elevation is available as a debug field, not as
  geometry, and no region carries a height.
- **No navigation mesh, and no pathfinding.** A* or whatever you use runs over the walkability grid.
- **No region naming.** Regions are numbered by size. No region has a name.
- **No stitched world.** A map is one tile. `origin` and `world` make a tile continuous with its
  neighbours, but nothing merges two tiles into one geometry: a lake across a seam stays two polygons,
  and joining them is the consumer's step.

## Debugging a map that looks wrong

`metadataLayers.fields` holds the four noise fields the map was contoured from, and the Canvas renderer
can draw them directly. Render the `elevation`, `moisture`, or `vegetation` view to see what the
generator saw before it classified anything, which is usually faster than reading the polygons.

If the geometry is the problem rather than the classification, the `collision` view draws every
blocking feature as its collision shape. A tree drawn as a small circle inside a large canopy is
correct behaviour, not a bug.

The studio in `demo/` exposes all of these as tabs, with sliders for every generation parameter.

## See also

- [GameMap v1.4 schema](gamemap-schema.md) — field-by-field structure
- [Generation](generation.md) — how the map is produced
- [Architecture](architecture.md) — where the boundary sits
