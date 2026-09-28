# Settlement plan

The v0.5 line in `PRD.md` §29, plus the settlement note the PRD now carries: a settlement may be a
player base or spawn point; a caller wants a parameter for how many settlements a map has; and mixed
with the housing parameters that may produce a dead settlement, with no buildings or all in ruins.

A settlement is a place: a centre, a boundary, and the buildings inside it. v0.4 placed buildings
against roads one at a time, so a map has houses but no village — `seed 583921` at 2048x1536 gives 48
buildings on 14 roads and nothing that says these belong together.

Ordered by what unblocks the most, not by what is most fun to build.

## Status

| Item                                    | State      | Gate                                                                                                        |
| --------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| S1 centre, membership, and a count knob | done       | `tests/settlement.test.mjs`, count, membership, empties                                                     |
| S2 settlement boundaries                | not needed | a radius and a membership list already answer it, and a polygon would contradict the no-collision decision  |
| S3 central square                       | done       | `clearing`, a keep-out the tree and building placers honour, decided before both                            |
| S4 settlement kind from density         | done       | `kind` is read off the membership, and there is no knob for it                                              |
| S5 which categories a settlement places | done       | `buildings.categories`, relative weights the caller supplies; no category weight per kind                   |
| S6 shoreline settlement and a pier      | done       | a `docks` collection of walkable decks, rooted on a waterline a road reaches and running out over the water |
| S7 ruins, from the PRD settlement note  | done       | `state` on a building, no collision on a ruin, and `kind` counts only what stands                           |
| S8 a settlement as a player base        | done       | `spawnCandidates({ preferSettlements: true })` offers every settlement, on open ground                      |

## S1 — centre, membership, and a count knob

A settlement is a centre point, a radius, and the buildings inside it, and a map has as many as the
caller asks for.

**Settlement entity.** `SettlementEntity`, published in a new `settlements` collection beside
`structures` and `roads`. It carries `id`, `type: 'settlement'`, `position` (the centre), `radius`,
and `metadata.buildingIds` naming the buildings inside it. Membership is a list of ids on the
settlement rather than a back-reference on each building, because a consumer reading one settlement
wants its buildings in one read, and the same reasoning the forest hull uses. The list may be empty:
a settlement nobody built in is still a place, and the PRD asks for exactly that.

**Count is a parameter, not a consequence.** `settlements.count` is how many settlements a map has.
The first draft of this plan made a settlement out of each road component, which reads well until a
caller wants four settlements on a map whose road network has two components. Quantity is the thing
the PRD asks to control, so it is a knob and the road network only supplies the sites. Roads are
scattered over, and each centre claims the buildings around it.

**A centre wants a road and company.** A settlement centre is placed on a road, because that is where
frontage is, and centres are kept a minimum distance apart so a caller asking for four gets four
distinct places rather than one place counted four times. Both distances are module constants for now;
they become knobs when a caller needs to tune them, not before.

**A centre wants a main road, not a lane.** Candidates are taken tier by tier, `primary` before
`secondary` before `path`. Shuffling every centreline together meant a third of settlements landed on
a 7-unit footpath, which is not where a village goes; taking the tiers in order puts four in five
centres on a main road, measured over 852 centres, and the rest on a lane rather than a path. The
preference is not a requirement, because a map whose network is all lanes still publishes its
settlements, on lanes.

**A dead settlement falls out of this.** Membership is by proximity to the nearest centre, so a centre
that ends up with no buildings in range is a settlement with an empty `buildingIds`. A high settlement count against a low
`buildings.density` produces them without any separate switch, which is what the PRD describes as
mixing the parameters. Ruins are a different thing and are S7, because a ruin is a property of a
building, not of the absence of one.

**What is deliberately not here.** A settlement publishes no collision. A boundary is a description
of where a place ends, not a wall, and the same argument the forest hull makes. It does not own its
ground beyond its membership list: plot and parcel boundaries are deferred, because a parcel only
means something once settlements divide land between owners, and an empty boundary now is a shape
S5 would have to unpick. And the generator does not designate a player base, because the PRD says a
settlement _may_ be one — a consumer choosing where to start is a consumer decision, and naming a
spawn is S8.

## Decisions taken

- **Count is a parameter, and the road network only offers sites.** Deriving the count from road
  components would cap a map at as many settlements as its network happens to have, which is the
  opposite of what the PRD asks for.
- **Membership by id on the settlement, and it may be empty.** One read per settlement, no second copy
  of a building to keep in step, and a dead settlement is a settlement rather than a special case.
- **A centre sits on a road and keeps its distance from the others.** A place needs frontage, and
  four settlements has to mean four places.
- **A settlement carries no collision.** Its radius is a hint for a consumer's own test, the same way
  `forests[].walkableInside` is, and not a substitute for one.
- **No `role` field on the settlement.** The PRD says a settlement may be a player base, not that the
  generator must name one. A consumer picks the settlement it starts from, so the field would be
  written by nobody and read by nobody until S8.

## Measured before building

Two of the planned items were measured rather than built, and both measurements said not to.

**The cliff question is already answered upstream.** S1 carried a note that a centre could land on a
switchback climbing a cliff, and that the site test should look at the ground under the road. Across
64 centres on 16 maps, none landed on rock, in water, or on a beach, and the steepest had an elevation
gradient of 0.005 against a threshold of 0.5; 99.4% of road candidates are clear of rock and water.
The reason is that the road generator already refuses to cross a lake or impassable rock and keeps a
minimum distance from a shoreline, so every point on a road is good ground by construction. A site
test would have re-checked an invariant the roads already hold. It is not in the code.

**A settlement's size is bounded by its reach.** Membership tops out at about a dozen buildings
because the 260-unit radius is what bounds it: p50 is 5, p90 is 11, and the largest measured is 12.
The `kind` thresholds are set to that range so all three values occur on a default map, and the limit
is stated rather than hidden. Raising the radius is what a caller who wants a real town needs first.

## S2 and S3 — one not needed, one built

**S2 asked for a boundary, and the radius already is one.** Its gate was "a building is inside or
outside, and the answer is stable", which the radius and `buildingIds` answer together, and they
answer it more cheaply than a polygon: a point-in-polygon test per building against a distance test.
Publishing a boundary polygon would also have contradicted the decision already written into the
schema, that a settlement is a distance and not a shape, so it would have had to be unpicked.

**S3 asked for a central square, and it is built as a `clearing`.** I first wrote S3 off as not
needed, on the grounds that a consumer can draw a plaza at `position` whenever it likes. That was true
of a plaza and wrong about the generator, because the reason to have one is not that a consumer can
draw it: it is that the ground is occupied. A centre on a road had a tree 12 units away at the tenth
percentile and a building 18 units away, so the middle of a place was whatever the placer left. A
consumer drawing a square over that gets a square drawn over a wood.

So the clearing is a keep-out, and the sites are decided before trees and buildings for that to be
possible. `clearing` is 28 units of reach, published as a polygon, and nothing is planted or built in
it. 28 comes from the two things it has to reconcile: trees come within 7 units of a road centreline,
and a building centre stands 23 units off one, so 28 clears the wood and still fits between the
nearest buildings, where 36 starts displacing them.

It is published on the settlement and validated as a polygon, and it carries no collision: the point
is to make the ground open, and a collider would make it closed. Over 852 settlements on 180 maps no
tree canopy and no building overlaps a clearing, and the nearest blocker to a centre is never closer
than 27 units. A centre near a map edge gets a smaller clearing, because a polygon outside the bounds
is not a valid one and a settlement is worth more than a full-width green.

Two things changed that the plan had not anticipated. Membership is now by nearest centre rather than
by "within reach", because 260-unit reaches on centres 260 units apart overlap and six buildings were
claimed by two settlements at once. And `settlements.count` now moves the trees and buildings, since
a clearing is a keep-out and the count decides where the clearings are; the old claim that changing the
count left the rest of the map identical no longer holds.

## S4 — settlement kind from density

`kind` is `hamlet`, `village`, or `town`, read off the membership: under 4 buildings is a hamlet, under
9 a village, 9 or more a town. It is not a configuration value, because a settlement that could be
called a hamlet while holding a town's buildings is a name the map contradicts. A caller wanting
different names for a place of that size changes the names.

A dead settlement reads as a hamlet, because it holds nothing. That is a consequence of deriving the
kind rather than a rule stated for it, and it is the honest answer: there is no housing, so it is the
smallest thing a settlement can be.

1.4 was never published, so `kind` joined `settlements` under the same version rather than starting a
1.5 that no consumer had ever seen. The previous commit's map is reproduced exactly by deleting the
`kind` field, which is what shows the change was additive and nothing else moved.

## S8 — a settlement as a player base

`spawnCandidates` takes `preferSettlements`, which puts each settlement's centre first and tags the
candidate with `settlementId`. The count is still filled from the roomiest ground afterwards, so asking
for settlements never returns fewer points, and omitting the option changes nothing.

A centre is on a road, so it is open ground, but the raster's conservative fill blocks a cell that
water touches anywhere inside it, and a road running a shore is inside such a cell. Across 210 centres
on 40 maps at a cell size of 16, 94% were already open and the rest moved at most two cells, so the
nearest open cell is used. A settlement with no open ground at all is skipped rather than offered on
blocked ground, and the snap is capped at four cells.

## S7 — ruins

A ruin is a building that has fallen down, and the two things that make it one are that it stops
colliding and that it stops counting. Without the first it is a wall around rubble; without the second
a village of twelve shells calls itself a `town`, which is a label contradicting the ground. Those were
the two problems the item was written to solve, and they are the whole of it.

`buildings.ruin` is the share of buildings that are ruins, `0` to `1`. It is a share of buildings and
not a flag on a settlement, so both halves of a dead settlement are reachable by mixing two parameters:
raise `settlements.count` to get a place nobody built in, or set `ruin: 1` to get one whose buildings
all fell down. No new `kind` value is needed for the second, because `kind` already counts standing
buildings and a settlement of ruins lands at the bottom of the scale it already has.

The footprint stays and the collision goes. Keeping the geometry is what makes a ruin the same building,
fallen, rather than a smaller house: a consumer drawing rubble fits it to the same rectangle, and the
walkability raster leaves the ground open without being told to.

The share is drawn from a stream of its own. Drawn from the placement stream it would have moved every
building placed after the first ruin, so setting `ruin: 1` would have answered a different question
from the one asked. With its own stream the previous map is reproduced exactly by deleting the new
field, which is what shows the change was additive and nothing else moved.

**Whose decision a ruin is, and why the field exists anyway.** The consumer of this library decides what
a building looks like: whether the settlement is apocalyptic, all in ruins, a row of sites for a player
to build on, or a developed village is a game-side choice, and a game that renders its own styles has no
need to read this one. Watabou, which the PRD names as the reference, does publish a per-building state
and a ruin is one of its styles; that is a style catalogue rather than a placement decision, and the
generator has no styles to catalogue.

So the field is a convenience, not a contract, and a consumer may ignore `state` entirely and decide per
building. It stays for one reason: it is the only field that makes an abandoned map expressible without
a second placement pass. A ruin has to stop colliding, or it is a wall around rubble, and a settlement
of ruins has to stop counting, or it calls itself a `town`. Expressing that needs a flag on the building
whether the game reads it or not, and a share is a smaller way to ask for it than a per-building list.
A generator that wanted to publish styles as well would add a `style` field beside `state`, with a
catalogue the caller could extend; that is a different field and it is not this one.

## Still open

- **S5 is done, as a reframing.** The item as written — a category weight per settlement kind — is
  circular, and not politely: `kind` is read off the membership, and the membership is built from the
  buildings, so a building cannot choose its category from a kind that does not exist yet. It needed a
  two-pass placer or a `kind` that is an input rather than derived, and the second is the contradiction
  S4 exists to avoid. The PRD asks the smaller question, "which building categories a map places", and
  the caller supplying the weights answers it with no cycle. The section below says what it does,
  including the part the measurements turned up: a weight is a draw rate and not a share.
- **S6 is done, as a new collection.** A pier stands in water, is walkable, and is attached to a
  settlement. A building does the opposite of all three: it stands on land, it is a wall, and it is
  placed against a road. Making a pier a building category would put an exception in the one
  placement path that is currently uniform, and a ruin of a pier is not a thing, so the field S7 added
  would have to be forbidden on one branch of the category union.

  So a dock is its own entity in a new `docks` collection. That keeps `structures` about buildings and
  leaves every building invariant intact, and it gives a dock the fields it actually has: where it is
  anchored on land, the deck it covers, the settlement it serves, and how wide it is.

  The one mechanical part that is genuinely new: **a pier is walkable, and the ground under it is water
  that blocks.** The raster fills water as blocked, so a deck has to be carved back out afterwards.
  That is a paving pass over the filled cells rather than a change to what counts as a blocker, which
  keeps the rule the raster already states intact and makes the carve auditable: a cell a pier opens
  was blocked by water and is now a deck.

**What the measurements say about where a dock goes.** Across six maps at 2048 by 1536, a settlement
centre comes within 13 to 53 units of water at its closest and its median gap is 65 to 143, so a place
is usually near a shore without being on it. Roads are the better anchor: a road comes within 2 to 8
units of water at its closest point and 62 to 74% of all road points sit within 120 units of it. A dock
is therefore placed on a road point near a shore, reaches from the land across the water, and names the
nearest settlement as the place it serves. Rivers already record `metadata.mouths`, which is a free
jetty site on any map with a river reaching standing water, and a lake shore is the other.

What the build turned up, and it is worth having written down because it changed the documentation
rather than the code. The count is bounded by the **shore**, not by the number of places. One
settlement on a long shoreline can carry eight decks, so the claim that a map with two settlements
cannot publish four docks is false, and it was corrected everywhere it had been written. The other
thing the build found was a real bug: the bounds test was on the centreline tip, and a deck running
along a shore near a map border has a tip comfortably inside the map and both far corners outside it.
The test is now on the deck's own corners, and it was `assertValidMap` inside `generateMap` that
caught it.

The third thing was found by looking at a picture rather than by a test. The deck was rooted on the
road and ran to the shore and a short way past, which is a plank across the beach with a stub in the
water rather than a pier. A deck is a rectangle standing in the water and touching the bank at one
end: the road decides _which_ shore, and the deck is rooted on the waterline there. How long it runs is
measured to the last point the water allows, across the deck's whole width rather than its centreline,
so a pier in a narrow inlet is short and one off a broad shore is full length. Over 110 decks the only
points on land are the two root corners where the deck meets the bank, and the median share of a deck's
area over land is 0%. The test that catches it samples the deck's rectangle rather than its corners,
because a deck grazing a sand spit shows up in neither corner.

## S5 — which buildings a map has

The weight is a **draw rate and not a share**, and that is the part worth writing down. A farm is four
times the ground of a house and stands 48 back, so a farm drawn at a site is refused more often than a
house is. The default draws one site in nine and the map comes out at 6.1% farms across twelve maps; at
`{ house: 1, farm: 9 }` it comes out at 80.8%. Both numbers are measured rather than assumed, and read as
a share of the finished map they would have looked broken.

`buildings.categories` is relative weights, unset at `{ house: 8, farm: 1 }`. Three rules earn their
place: a weight of zero is a category that is never placed, a category left out keeps the default weight
so reweighting one does not silently drop the other, and a name the generator has no footprint for is
rejected rather than ignored, because a weight that cannot be honoured is a setting that appears to do
something and does not.

The category draw gets a stream of its own, for the same reason the ruin and settlement draws do. A
farm-heavy map is shorter than a house-only one because farms refuse neighbours, and that is a real
consequence of the weight; it should not also reshuffle which sites were offered, which is what sharing
the placement stream would have done. This is the one change in the settlement line that is not
additive, and the pin moved with it. The default mix is unchanged at one site in nine.
