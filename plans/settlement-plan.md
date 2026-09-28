# Settlement plan

The v0.5 line in `PRD.md` §29, plus the settlement note the PRD now carries: a settlement may be a
player base or spawn point; a caller wants a parameter for how many settlements a map has; and mixed
with the housing parameters that may produce a dead settlement, with no buildings or all in ruins.

A settlement is a place: a centre, a boundary, and the buildings inside it. v0.4 placed buildings
against roads one at a time, so a map has houses but no village — `seed 583921` at 2048x1536 gives 48
buildings on 14 roads and nothing that says these belong together.

Ordered by what unblocks the most, not by what is most fun to build.

## Status

| Item                                    | State      | Gate                                                                                                       |
| --------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| S1 centre, membership, and a count knob | done       | `tests/settlement.test.mjs`, count, membership, empties                                                    |
| S2 settlement boundaries                | not needed | a radius and a membership list already answer it, and a polygon would contradict the no-collision decision |
| S3 central square                       | done       | `clearing`, a keep-out the tree and building placers honour, decided before both                           |
| S4 settlement kind from density         | done       | `kind` is read off the membership, and there is no knob for it                                             |
| S5 which categories a settlement places |            | two settlements of different kind draw different categories                                                |
| S6 shoreline settlement and a pier      |            | a pier stands in water, is attached to a settlement, and a building never does                             |
| S7 ruins, from the PRD settlement note  | done       | `state` on a building, no collision on a ruin, and `kind` counts only what stands                          |
| S8 a settlement as a player base        | done       | `spawnCandidates({ preferSettlements: true })` offers every settlement, on open ground                     |

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

## Still open

- S5 needs a category weight per kind, and it is circular as written: `kind` is read off the
  membership, and the membership is built from the buildings, so a building cannot choose its category
  from a kind that does not exist yet. It needs either a two-pass placer or a `kind` that is an input
  rather than derived, and the second would contradict S4. Content decision, held until someone wants
  a hamlet and a town to look different.
- S6 needs a shoreline site for a pier to stand on. The beach band is already kept clear of buildings,
  which is what leaves that ground free. Mechanics, not content, but nothing asks for a harbour yet.
