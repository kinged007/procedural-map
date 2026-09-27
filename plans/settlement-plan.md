# Settlement plan

The v0.5 line in `PRD.md` §29, plus the settlement note the PRD now carries: a settlement may be a
player base or spawn point; a caller wants a parameter for how many settlements a map has; and mixed
with the housing parameters that may produce a dead settlement, with no buildings or all in ruins.

A settlement is a place: a centre, a boundary, and the buildings inside it. v0.4 placed buildings
against roads one at a time, so a map has houses but no village — `seed 583921` at 2048x1536 gives 48
buildings on 14 roads and nothing that says these belong together.

Ordered by what unblocks the most, not by what is most fun to build.

## Status

| Item                                    | State | Gate                                                                                |
| --------------------------------------- | ----- | ----------------------------------------------------------------------------------- |
| S1 centre, membership, and a count knob | done  | `tests/settlement.test.mjs`, count, membership, empties                             |
| S2 settlement boundaries                |       | a building is inside or outside, and the answer is stable                           |
| S3 central square                       |       | a square is walkable, central, and not on a road                                    |
| S4 settlement kind from density         |       | kind tracks the building count, and is not a config knob                            |
| S5 which categories a settlement places |       | two settlements of different kind draw different categories                         |
| S6 shoreline settlement and a pier      |       | a pier stands in water, is attached to a settlement, and a building never does      |
| S7 ruins, from the PRD settlement note  |       | a ruined building is a building that a building never was, and ruins do not collide |
| S8 a settlement as a player base        |       | `spawnCandidates` can prefer a settlement centre, and one is always offered         |

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

**A dead settlement falls out of this.** Membership is by proximity, so a centre that ends up with no
buildings in range is a settlement with an empty `buildingIds`. A high settlement count against a low
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

## Open questions

- A centre on a road is a good place and not always the right one: a long switchback climbing a cliff
  is frontage nobody settled on. Whether the site test has to consider the terrain under the road is
  untested and is the first thing to measure in S2.
- Ruins change what a building is: a ruined building should stop colliding, or it is a wall around
  rubble, but it also changes the density a caller asked for. S7 has to decide whether a ruin is a
  building that no longer counts, because the count is what a settlement's kind and a dead
  settlement are both read from.
