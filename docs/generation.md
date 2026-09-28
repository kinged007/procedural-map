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

The scale knobs are named for the layer they were added for, and only one of them still works that way. `water.scale` is the scale of the **elevation** field, so it sets the size of the landforms and, with them, the size of the lakes and the extent of the rock. `terrain.scale` scales the terrain and vegetation fields, so it sets the size of the patches of meadow, scrub, and forest, and it does not move the coastline. `terrain.variation` is the amplitude of the terrain field, which is what decides where the classification boundaries fall; it does not change how much water there is.

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

## Rivers

A river is the channel of a course walked down the drainage of the elevation field, offset to a fixed
width of 12 units. It is published in the same `water` collection as a lake, with `kind: 'river'`, so
everything that treats water as water treats a river as water: the walkability raster blocks it and no
tree is planted in it. A road is the exception and goes over a channel rather than around it, which is
what the crossings below are about.

Rivers are a compromise between the two named things in a map: they are worth generating because a road
that has to go around a valley is a road that does not connect two places, and the channel gives a road
somewhere to bridge. `rivers.density` scales the count from 0 to 1 and `rivers.width` sets the channel
in world units, which also fixes the width of the marker at a mouth and the span recorded at a
crossing. `density: 0` publishes no river at all, for a map where water is only standing.

The drainage comes from a flood that starts at the map border, where water leaves the world, and works
inward. A cell is raised to the level its water would have to reach to get out, and the cell that
reached it becomes its parent. Those parents are the drainage: a course is a path through the tree
they form, so it cannot cross itself, cannot come back to a cell it has used, and ends where the water
does, which is in a lake or off the edge of the map. Ground the flood fills is raised a hair above the
cell that filled it rather than level with it, so a filled basin still slopes the way its water would
have gone. The flood also counts how many cells drain through each one, and that count is what says
where a channel belongs: a cell holds the whole catchment above it, so the most flow in the map is on
its main channel.

A course is the main channel of a catchment rather than the shortest way off a hill. From a source it
climbs the child with the most flow in it, to where the ground divides, and then follows parents down
to the water. Climbing the largest tributary is what makes a river long: the shortest path to the
border is direct and a few hundred units at most, which on a large map is a stub no road ever reaches.
Sources are ranked by flow and spread across the ranking, and there are more candidates than rivers
wanted, because most of them turn out to be a reach of a longer one. Courses are taken longest first,
and a course that would lie on a river already published is cut back to the junction and published as
the tributary it is, so the map has a river network rather than several rivers drawn over each other.
One river is drawn per 260 units of the map's shorter side, up to eight.

Every river runs to water. A course is one reach, from the divide above its source all the way down to
the lake it reaches or off the edge of the world, and the head and the tail are joined into that one
reach rather than published as the longer of the two: a river that stops part-way down a catchment is
a stripe, not a river. The one exception is a course that reaches a river already published, which is
cut back to the junction and published as the tributary it is, because below the junction the water
belongs to the river that is already there.

A course is cut where it first reaches standing water, and the site is published as a mouth:
`metadata.mouths` on the river names the water body, the point on the shore where the channel met it,
and a small square one channel wide there. A mouth is where a delta, a silt bank or an estuary asset
goes, and it is the one place a consumer is told that a river met something. The cut is where the
_channel_ reaches the water rather than where its centreline does, because a course running along a
shore arrives there half a channel before its centreline does, and the end is then slid onto the shore
itself, because an end left where the channel's edge merely touches leaves up to a whole step of
course between the two bodies of water, which reads as a river stopping in the field short of a lake.
The two overlap by half a channel at the join, which is what a mouth is: the channel widens where it
meets standing water.

Both a traced course and a walked road are staircases: one point per grid cell or per step, each joined
to the next by a straight line, so the surface offset from either reads as a chain of flat facets
however wide it is drawn. Both centrelines are curve-fitted before the channel or the ribbon is built,
by cutting the corners off twice, which rounds every joint and leaves the two ends exactly where they
were. A course is fitted before it is cut at the water, so the cut still lands on the shoreline. A road
is fitted once, because a second pass bows it further in than the margin it is held clear of the water,
and the curve is discarded where it would come closer to a shore or enter rock than the walk itself
went.

A course whose channel does not close on itself is eased with a moving average and retried, and dropped
if it still does not. Rivers are traced from the tile's own field grid, so on a tiled world a river is
traced per tile and the two sides of a seam do not join up, the same caveat that already applies to
lake contours.

## Vegetation

Trees are sampled from the `vegetation` field. `density: 0` creates no trees.

`density` and `clustering` control different things:

- `density` sets the tree count: one tree per 1250 square world units, times the density.
- `clustering` sets the arrangement. It raises the bar a tree must clear to be placed and sharpens how strongly strong groves are favoured, turning an even scatter into tight groves with real clearings between them. It does not change the count directly, though high values place fewer trees because the 9-unit spacing limit binds inside dense groves.

Per-cell tree concentration rises monotonically across the control, from a coefficient of variation near 0.55 at `clustering: 0` to about 1.36 at `clustering: 1`. The density target is reached for every value up to about 0.75; above that the woodland genuinely thins because the same number of trees is packed into fewer groves.

Species are chosen by moisture rather than at random. Birch is the wet-ground species and gains ground as local moisture rises, against a base share of 28%. Oak holds dry ground. Both species are present on every generated map.

Tree canopy radii are 10-18 world units. Collision circles are 3.5-5.5, so a trunk blocks and the leaves do not, and they never overlap water.

Trees are not planted on a road, nor where a canopy would overhang one, so a road is cut through the wood and leaves a clearing along its verges. Vegetation is generated after roads for that reason.

**A tree does not root in the beach band either.** A beach is walkable, so nothing refused a tree there, and the band is the lake's own ring offset outward with the lake punched out as a hole — it lies entirely on the landward side of the water, where the water test never looks. A tree standing on the sand was therefore standing on open ground that happened to be drawn yellow. The keep-out is on the canopy, the same rule as water, so the wood keeps its distance from the sand rather than standing on the edge of it. Over twelve 2048 by 1536 maps this removed every one of the 87 trunks and 410 canopies that were on a beach, and the nearest canopy to the sand across them is between 1 and 43 units: the wood still comes right up to the shore.

Rock is in the same keep-out list, because the test is identical and the two are the same question asked of different ground: ground a tree does not root in. There are about eight beach polygons on a default map, so the list is tested directly with no index.

The determinism pins are taken on a 640x480 map, which has no beach band at all, so none of this is covered by them and they do not move. The tests in `tests/generation.test.mjs` are the ones that hold it.

## Roads

Roads are grown in three tiers, widest and longest first: `primary` at width 22, `secondary` at 14, and `path` at 7. Primary and secondary roads start at the map edge and cross the map; paths branch off roads already placed, which is what makes the network connected rather than a set of parallel lines. A default map produces 12 to 16 roads.

`roads.density` scales the target count of every tier. It never drops a tier below one, so density controls how busy the network is rather than whether there is one at all: at 0 a map has three roads, at 1 it has 16 to 17, and all three tiers are populated throughout.

Routing is a greedy walk over a small fan of headings, each step taking the cheapest heading available, rather than a shortest-path search. That produces the meander and long detours of a surveyed road instead of a taut line between two endpoints. The cost is charged against a budget, so every road terminates on its own.

Lakes and impassable rock are refused outright rather than made expensive, and a step is refused 20 world units short of a lake's edge. A road therefore bends around an obstruction for as long as the fan of headings allows, then stops on open ground, and it never crosses a lake. A river is not refused, because a channel is narrow enough to bridge: a road goes over it. Where the road's surface reaches the channel, `metadata.crossings` names the river, the point on its surface closest to the road, and the span of the channel there, which is the channel's width from `rivers.width`. That is the site a bridge or a ford is built from. The renderer draws nothing there: a road is drawn over the water, so a road crossing a river already reads as one, and a marker laid on top of it only obscures the road it is meant to explain. A consumer sizes a bridge from the part of the road's centreline that is over the channel, with the road ribbon and the river polygon, which are both on the map. The key is absent when a road's surface reached no river.

Two invariants keep the network readable. A road that branches from another is required to touch it, while every other pair of roads is held apart by a per-tier minimum gap, so a consumer can tell a junction from two roads running alongside each other. The gap is enforced in both directions, from the new road's points to the roads already placed and back again, because a point is only as far from a line as the nearest vertex of that line is. And a road whose centreline retraces itself is rejected before publication, because the offset ribbon around a fold crosses itself and produces geometry validation refuses.

Road generation is skipped entirely when water and rock together cover more than 55% of the map, since routing has no meaningful result there. A fully flooded map therefore has no roads at all.

## Buildings

Buildings are placed last, because a road is the only thing that offers them a site. Every
`spacing` world units along each road centreline is a site, each site is built on with probability
`buildings.density`, and a building that is built on stands `buildings.setback` off the centreline
with its front wall facing the road. On either side of a road, so a settlement grows from both banks.
A default map produces 45 to 55 buildings.

Two categories, and a category earns its place by changing the placement rather than only the name:
a `house` is 15 by 11 units and uses the configured setback, and a `farm` is 28 by 20 and stands 48
units back, which is what a farmyard is.

How often each is drawn is the caller's: `buildings.categories` is a set of relative weights, unset at
`{ house: 8, farm: 1 }`, and a weight of zero is a category that is never placed. The weights are
relative so they need not add to anything, and a name with no footprint is rejected rather than ignored,
because a weight that cannot be honoured is a setting that appears to do something and does not. A
category left out of the table keeps the default weight, so reweighting one does not silently drop the
other.

The weight governs the **draw**, and the finished map carries fewer farms than the draw asks for: at
the default, one site in nine is drawn as a farm and about six in a hundred buildings end up being one,
because a farm is four times the ground of a house and stands 48 back, so it refuses more sites than a
house does. That gap is the reason the weight is not a share, and it is measured rather than assumed: at
`{ house: 8, farm: 1 }` across twelve maps the draw is one in nine and the map comes out at 6.1% farms,
and at `{ house: 1, farm: 9 }` it comes out at 80.8%.

The category draw has a stream of its own, so reweighting the mix changes what stands on a site without
reshuffling which sites are offered. A farm-heavy map is still shorter than a house-only one, because a
farm refuses its neighbours, and that is a real consequence of the weight rather than an artefact of
the numbers. The settlements change with it, because a settlement is defined by the buildings it holds;
the roads, the water, the terrain, and the wood do not.

`buildings.ruin` is the share of buildings that have fallen down, drawn once a building is placed and
so leaving the sites exactly where they were. A ruin keeps its footprint and drops its collision,
because rubble is ground a character walks over rather than a wall around a shell, and the
walkability raster picks that up on its own. It is drawn from a stream of its own for the same reason
the settlement sites are: setting the share to `1` asks what the map would look like abandoned, and the
answer is the same map with the same buildings in the same places, which is checked rather than
assumed.

A ruin does not make a settlement bigger. `kind` counts what stands, so a village of twelve shells is a
hamlet, and the membership is unchanged: ruins are part of the place, just not part of its size. That
is what makes the second half of a dead settlement reachable, next to the first half, which is a
settlement nobody built in at all.

What a building looks like is a consumer's decision, not this one's. Whether a place is apocalyptic, a
row of sites for a player to build on, or a developed village is a game-side choice, and a game that
renders its own styles does not need `state` at all. The share is here so that an abandoned map is
expressible without a second placement pass, and because rubble and a wall are different things to the
walkability raster whether or not anyone reads the field. A caller who wants no opinion at all sets
`ruin: 0`.

`spacing` is re-checked as a global centre-to-centre minimum rather than only along one road, so
buildings on two roads that run close together do not end up inside each other. It is also what makes
`setback` behave oddly at the low end, which is worth knowing before reaching for it: pulling both
rows of buildings in towards a road also pulls them into each other, so below the spacing they cancel
out and the map gets _fewer_ buildings. On a 1024 by 768 map, a spacing of 20 gives 39 buildings, 34
gives 23, 80 gives 9, and 200 gives 2.

A site is refused outright if the building would stand in the water, on rock, in a road, on a beach, or
under a tree. A beach is the only one of those that anything else is happy to walk on, and a building
is kept off it anyway: a house standing on the sand is a house nobody would have built, and the
shoreline is where a port, a pier, or a boat shed belongs. Clearing the whole band now is what leaves
that ground for a category that can claim it, which is settlement work. Trees are generated first, so a
tree is the reason a building is refused and not the other way round: the wood is worth more to a map
than the house beside it, and the density target that governs the tree count is untouched. Clearing a
site of trees instead would keep every building, at the cost of thinning the wood, and is the better
trade if a map ever needs buildings more than it needs trees.

No building stands apart from the road network. A farmstead set back from a lane is a farm; a farm in
the middle of a field with no lane at all is a different placement problem, and it belongs with
settlements rather than here.

## Settlements

A settlement is chosen in two halves, and the split is what lets its clearing be a keep-out rather
than a hole punched in a finished map.

**Where the places are** is decided right after the roads and before anything is planted or built.
Every point along every road centreline is a candidate for a centre, the candidates are shuffled by a
stream of their own so a seed scatters the centres over the network, and the first `settlements.count`
of them that clear a 260-unit gap from each other become sites. Each site carries the open ground at
its middle, described below. Publishing the settlement itself still waits for the buildings, because a
settlement is defined by the buildings it holds.

**What a place is** is published once the buildings exist. A centre claims the buildings within 260
units of it, and each building is claimed by exactly one settlement: the nearest. Centres are kept
260 units apart, which is the same as the reach, so two reaches do overlap, and a building between
them would be in both without that rule. A building in two places at once has no meaning for a
consumer resolving a name, and assigning to the nearest is the only rule that makes membership a
partition.

The count is a parameter rather than something derived from the road network, because a caller asking
for four settlements should get four whether the network has four pieces or two. The network supplies
the sites; the caller supplies the number. A centre with no buildings near it publishes an empty
membership rather than being dropped, which is what makes a dead settlement reachable by mixing a high
count against a low `buildings.density` instead of by a switch.

A centre prefers a main road to a lane: the candidates are taken tier by tier, `primary` before
`secondary` before `path`, so a place grows where the traffic is rather than at the end of a
footpath. The preference is a preference and not a requirement, because a map whose network is all
lanes still publishes its settlements, on lanes.

The 260 units is both the reach and the separation, so the two cannot drift apart: a settlement's
radius is exactly the distance within which it holds buildings and exactly the distance kept from the
next centre. Both become configuration when a caller needs to tune them, which is not yet.

### The clearing

Each settlement opens a clearing at its centre: 28 units of reach, 56 across. Nothing is planted in
it and nothing is built on it, and it is ground rather than a collider, so a consumer can put the
middle of the place on `position`, which is inside the polygon and on the road running through it.

The clearing reaches the tree and building placers as ground to keep clear, which is why the sites are
decided first. A road already keeps trees 7 units off its centreline, so a clearing is a second
keep-out rather than a wider version of the first, and a building centre stands `setback + depth / 2`
off the centreline, which is 23 units at the smallest legal setback and inside 28. A generated
building never stands in one and a tree never roots in one, so the middle of a place is open ground
rather than a gap between obstacles.

28 is set by those two numbers rather than by taste. It clears the trees that come to within 7 units
of a road, and it fits between the nearest buildings; at 36 it starts displacing them, and at 20 it is
barely wider than the road it sits on.

A centre close to the edge of the map gets a smaller clearing rather than being dropped, because a
polygon outside the map bounds is not a valid one and a village at the edge of the world is still a
village. The shrink is what `clearing` measures: a consumer reading the polygon reads the clearing
that was actually kept, rather than a radius the map did not honour.

Because a clearing is a keep-out, asking for a different number of settlements changes where the
clearings are and therefore which trees and buildings exist. The site stream is still its own, so the
same count always picks the same sites.

## Docks

A dock is a plank deck standing in the water off a shore, and it is a place's waterfront: a settlement
has to reach the deck's root, which is what keeps a harbour at a village rather than a jetty in the
middle of an empty shore.

The road decides _which_ shore. A shore no road can reach is a shore with nobody on it, and a deck
there would be a pier a cart could never get to. The deck itself is not laid from the road.

A deck is a rectangle standing in the water and touching the bank at one end, rooted at the point on
the shoreline nearest the road and running out from there away from the land. The first version laid it
from the road to the shore and a short way past, which drew a plank across the beach with a stub in the
water, and the whole area of a deck being water is the point of the shape. Over 110 decks the only
points on land are the two root corners where the deck meets the bank, the tip corners are in water
every time, and the median share of a deck's area over land is 0%.

How far it runs is what the water allows rather than a fixed number. The reach is measured along the
deck's own heading and clamped to the last point still inside the named body, and it is measured
across the deck's whole width rather than its centreline, so a deck whose centreline is over water and
whose corners are on the sand is not published. A pier in a narrow inlet is therefore a short pier and a
pier off a broad shore is a full-length one, and neither ever lands on the far bank. Depths run between
12 and 40: the narrowest dimension of a lake the generator draws that takes a road is 61 units, a
tenth of them are under 82, and the median is 211, so 40 fits inside the smallest of them. A candidate
whose water does not open up for 12 units is refused rather than published as a plank on the bank.

The bounds test is on the deck's own corners rather than the centreline, because at a map edge a deck
has a tip comfortably inside it and both far corners outside. A deck is also kept 30 from any other deck
and is refused where it would overlap a building, so two decks never share a shore and a pier is never
drawn through a wall. Over 180 maps at up to 4096 by 4096 and ten seeds, 1065 decks were published
with none invalid, none out of bounds, and every deck naming a place and a body of water that exist.

The count is an upper bound, and **what bounds it is the shore**. A map with no settlements publishes
no docks at any count, and a settlement standing nowhere near water has no waterfront — but it is not
bounded by the number of settlements, because one place on a long shore can carry several: two
settlements reach sixteen on a 2048 by 1536 map, eight of them to one place. The default is `0`, which
is a map of no harbours: a pier is a strong statement about a place, and the generator has no opinion
on whether any of them is a port.

**The deck is carved into the walkability raster after the blockers are filled.** A cell is blocked if
any part of it is covered by water, and a deck stands in water, so without a carve a pier would be a
picture of a walkway a character cannot stand on. The carve is a second pass of the same fill, written
as 0 instead of 1, which keeps the rule the map states intact and makes the carve auditable: a cell a
deck opened was blocked by water a moment earlier and the deck covered it. It opens water and nothing
else, and a deck never makes an island — every open cell under a deck is reachable on foot from the
deck's own anchor, at every cell size from 4 to 64.

The cost of that carve is resolution rather than time. A deck is 16 units across, so below a 32-unit
cell the raster can see none of it: at `cellSize: 32` a pier contributes one cell or none, and at 64
usually none. The bake itself is unchanged — 8ms on a 4096 by 4096 map at `cellSize: 4` with and
without docks, and the placement is under 1% of generation time.

## Resource sites

A resource site is a place worth gathering something at, and it is published in a new `resourceSites`
collection. The generator is deliberately neutral about what a site yields: there is no geology on the
map, because the fields are elevation, moisture and vegetation and nothing in a `GameMap` says where
iron is as opposed to copper or flint. A site is named for the affordance it sits on — a rock face,
open water, a wood — and the caller decides what that is worth and builds there. A map that placed its
own mines would be a generator with a fantasy bolted to it.

All three counts default to `0`, which is a map that says nothing. They are separate numbers rather
than one because the ground offers them wildly unevenly: a default map has 4.7 rock regions with about
4,000 units of face between them, but only 4.5 bodies of water big enough to fish and sixteen to
twenty-three woods big enough to hunt. A shared count would be tuned against the scarcest of the three
and would quietly cap the other two.

**Mines are cut into rock faces, and their arrow points out.** The face is walked at 8-unit steps and
the outward normal taken at each sample, which is the direction that leaves the rock, so it is the
direction out. Where a concave section leaves both perpendiculars outside the polygon the normal is not
unique, and the one with the clearer approach wins, which is the one a character would dig towards. A
notch, where the rock wraps around three sides, has no such side and is not a face anyone can dig into.

The marker sits 4 units _inside_ the boundary. That is the overlap that makes it checkable rather than a
matter of taste: a consumer can run `pointInPolygon` against the rock it names and get an answer that
means something, where a marker sitting exactly on the boundary is ambiguous to the same test. The face
is sampled at the middle of each stretch of outline and never at a vertex, because at a sharp corner
the two normals belong to the two edges meeting there and stepping back along one leaves the polygon
rather than entering it.

The entrance is then required to have 16 units of clear ground along the arrow, and every rock is
tested for it rather than only the named one, so a mine in a seam between two outcrops is refused for
having rock on both sides. Only rock, water and other forests are tested for that approach. A tree near
a mine mouth is a wood, and a character walks around one; trees are deliberately not in this test,
because refusing a face over a single trunk would take whole hillsides out of the candidate pool
for something that is not in the way.

**Fishing spots are in the water, and say how far out they are.** The distance is measured to the
nearest shore of the spot's _own_ body, islands included, and `access` is derived from it: `land` within
32 units, `water` beyond. Both are published because they answer different questions — `access` is the
verdict, `distanceToShore` is the measurement behind it, so a caller that would rather its spots were 50
units out reads the number and ignores the verdict. 32 is the one judgement in the file rather than a
measurement, because how far a character will wade is the game's decision; over eight maps the split it
produces is 49% land and 51% water, so neither mode is decorative.

A spot is not refused for being unreachable from land, because a spot out of reach of a bank is the
whole point of one. But a body has to be worth fishing first. The water on a generated map is sharply
bimodal: over eight maps the median body is 5.5k square units, which is a puddle, and the size
distribution jumps rather than tapers, so any floor at all lands in the same gap. At 20,000 there are
4.5 bodies per map, with inradii of 36 to 187 units — enough open water to put a spot genuinely out of
reach of a bank, which the largest reaches by 180 units.

**Hunting sites are at the edge of a wood, facing out of it.** A stand in the middle of a grove is a
stand nobody can walk to — the trunks are the obstacle — so the site sits on the hull's own outline
with the arrow pointing out, and the ground it points at has to be clear. "Clear" excludes the
neighbouring grove specifically, and that is the rule's whole reason for existing: two groves of one
wood are separate hulls because their trees are more than the link distance apart, but their hulls can
be a stride of each other, and an edge facing a neighbour is an edge that faces more wood. Rock and
water are in the same test, because a stand against a cliff is the same problem. One site per grove,
taking the first edge on the outline that faces somewhere open.

The approach has to be clear for the whole 16 units, not merely for its first step. A first-clear-step
test accepts an edge with four units of daylight and then the neighbouring wood, which is precisely
what this rule is meant to stop. Requiring all of it cost nothing: over fifteen maps every grove that
passed the size test still had at least one fully clear edge, so the pool is unchanged at nineteen to
twenty-three woods per default map.

A grove needs at least 20 trees and `walkableInside` before it is offered at all. The 20 is a floor
because `densityPct` cannot tell a copse from a wood: it reads 100 on every hull on a default map,
since a hull is drawn tight around its own canopies, so canopy coverage is full by construction and
the field carries no information. `walkableInside` is the field that earns its place — it is the
measured answer to whether a character can get into a grove and back out, which is what separates a
wood from a thicket.

This is also why the sites are placed after the map is built. A mine's approach and a wood's
enterability are both questions about finished ground, and `walkableInside` in particular is measured on
the raster once every other collection exists. Asking earlier would see every grove as unenterable and
publish no hunting at all.

Sites draw from two separate streams, so a caller tuning the mine count gets the fishing spots they
asked for rather than a different set because a number moved, and neither draws from the placement
stream, so nothing else on the map moves. The cost is a flat array walk and nothing more at the default
of zero; at 64 of each on a 2048 by 1536 map it is about 7% of generation time.

## Plots

A plot is a piece of ground a settlement works, published in a `plots` collection as a `field` or an
`orchard`. Both are `0` by default, and for the same reason the resource sites are: a field is a square
of dirt until a game says what grows in it, and a default map that ploughed one would be claiming a
harvest it has no way to justify.

A field is a rectangle with a heading, a width across and a depth along. The heading points back at the
settlement it belongs to, so one place's plots read as a single holding rather than as four unrelated
rectangles, and it is what a consumer runs its furrows along. An orchard is the same rectangle with the
trees already standing in it, named in `metadata.treeIds`. The geometry is published rather than left to
be reconstructed from the four numbers, and a test checks the two agree.

Neither carries collision. A field is ground a character walks across, and the validator refuses a plot
that does, for the same reason a dock, a forest hull and a resource site carry none.

### Where they go, and what limits them

Plots are offered on a ring from 46 to 255 units of a settlement centre: the inner bound clears the
settlement's own 28-unit green, and the outer bound stops just inside its 260-unit radius, so a plot is
ground the place reaches rather than the next place's. The ring is sampled in area, so a plot is as
likely to land far out as near. Plots are offered to the places round-robin, so one large settlement
does not take every plot on the map.

That ring is the limit on how many plots a map can hold, and it was set by measurement. Two plots cannot
be closer than the sum of their half-diagonals, so at these sizes twenty plots need roughly three
quarters of the ring packed. Widening the ring past the settlement's own reach was tried first and bought
a further twelve percent, which is not worth a field that belongs to somewhere else. The counts are
ceilings, and a default map asked for twelve fields and eight orchards publishes about ten and five.

Plot sizes were halved once for the same reason. A plot excludes a circle of its own half-diagonal, so at
64 to 128 by 44 to 88 twenty of them needed more ground than a settlement has and the count was routinely
half honoured. At 44 to 96 by 32 to 64 a field is a median 3,200 square units — about 57 by 57, which
reads at fit zoom and is a walk of a few seconds from the settlement's edge.

### A field is a keep-out, and that is decided before the trees

The plot sites are chosen before anything is planted, for the same reason the settlement clearings are: a
field is ground that stays open, so it has to reach the tree placer and the building placer as a keep-out
rather than as a hole punched into a finished map. Only a field is kept clear. An orchard's rectangle is
already full of the trees it asked for, and refusing more inside it would leave bare gaps down every row.

### An orchard's rows are real trees

A tree is a tree: an orchard's rows are published in `vegetation`, each with a trunk that blocks, and the
grove builder groups them like any other. An orchard published as a rectangle and a count would leave the
consumer adding its own collision, which is the one thing the generator owns. Measured over five maps,
575 of 578 orchard trees block their own raster cell — the three that do not are single-tree components,
which block nothing on any map, because `chunkTile` marks trunks from `forests` and a component of one is
not a grove.

The rows are 11 apart across and 14 along, with two and a half units of jitter. The jitter is what breaks
a perfectly regular grid, which is the tell of a procedural orchard and moires against the field grid
underneath. The spacing is what makes the rows legible: at the first attempt the trees were 9 apart with a
canopy radius of 6 and the whole grid drew as one dark clump indistinguishable from woodland. A canopy that
touches its neighbour's is a hedge and not a row.

An orchard's trees usually end up inside a neighbouring wood's grove rather than one of their own, because
the ring around a settlement is where the woods are and the grove builder links trees 26 units apart. A
grove is named `orchard` only where every tree in it is a planted row, which is the honest answer: a wood
with planting in it is a wood. The orchard's own trees are always reachable through `treeIds`, which is
the authoritative link.

An orchard whose grid has been eaten by the river or the cliff is published as a field instead of dropped.
It is not an orchard any more, and a caller who asked for eight orchards would rather have five orchards
and three fields than five orchards and nothing.

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
