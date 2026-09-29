# Enemy settlement plan

The v0.7 line in `PRD.md` §30: "enemy spawn locations, like settlements (for player), enemy
settlements basically. Games will decide how to render the asset, but lets call it enemy
settlements. a custom parameters to determine quantity and minimum distance from a settlement.
Preferred locations would be dense forests (with a way to get out), rocky areas, remote locations,
open locations, away from settlements."

That is a site generator, not a village generator. A player settlement is a place people built in:
roads reach it, fields ring it, farms work it, a pier may serve it, and the nav layer offers it as a
spawn point. None of that is true of a camp, and all of it is switched on by membership of
`map.settlements` rather than by anything the entity says about itself.

So the first decision is where these live, and the second is what one contains.

## Measured before building

Ground over 5 default maps at 2048x1536, sampled every 32 units, 13,200 samples, land only:

| Ground | Share |
| ------ | ----- |
| open   | 59.4% |
| wood   | 35.2% |
| rock   | 5.4%  |

Distance from the nearest player settlement, over that land:

|       | 10th | median | 90th | max  |
| ----- | ---- | ------ | ---- | ---- |
| units | 228  | 560    | 972  | 1580 |

Land still at least that far from any settlement: 400 units 71.6%, 600 units 45.0%, 800 units
23.9%, 1000 units 8.4%, 1200 units 2.5%.

Woods big enough to hold a camp (20+ trees, walkable inside): 97 across 5 maps, median 72 trees,
largest 126. Wood is not the scarce thing. Rock, at 5.4%, is.

Two things follow. A default `minDistance` of 800 is the point where a camp is unambiguously away
from town — three settlement radii — while still leaving a quarter of the land to choose from; 600
is barely distinguishable from a village approach. And the three grounds the PRD names are not
equally available, so a caller that wants three rock camps needs to be told when the map ran out of
cliff, the same way a caller asking for 9 buildings is told.

## Status

| Item                             | State | Gate                                                      |
| -------------------------------- | ----- | --------------------------------------------------------- |
| E1 where enemy settlements live  | done  | a second collection, so a camp is never read as a place   |
| E2 what one contains             | done  | a site on the ground, no buildings and no collision       |
| E3 ground preference             | done  | caller weights over `{ wood, rock, open }`, drawn not set |
| E4 getting in and out            | done  | the hunting-site 16-unit access test, reused              |
| E5 quantity and minimum distance | done  | `enemies.count`, `enemies.minDistance`, `enemies.grounds` |

All five were decided and are built. `tests/enemies.test.mjs` holds sixteen tests.

## E1 — a second table

Every existing consumer of `map.settlements` assumes people live there. `spawnCandidates` offers
them first under `preferSettlements`, plots choose one to ring with fields, farms work those
fields, docks attach to them, and the renderer draws a village. An enemy camp put in that
collection would be handed farms, a pier, and a player start.

That is not a set of conditions to write; it is a set of conditions to not trigger. A second
collection makes it automatic: enemy settlements have no `buildingIds`, so no plot or farm can
claim one, and nothing in the nav or render path needs to learn they exist.

The cost is honest and small: one more required array on `GameMap`, and a game that wants to treat
both uniformly reads two collections.

## E2 — a site, not a village

"Games will decide how to render the asset" is the PRD deciding this. A camp published as tents and
shacks would be a fantasy claim the rest of this package refuses to make, in the same way a mine is
a hole and not iron.

So a site: where it is, how far it reaches, the ground under it, and whether a character can walk
in and out. No collision, for the same reason a plot carries none — a camp is a mark on the ground
until the game builds something in it.

```ts
export interface EnemySettlementEntity extends MapEntity {
  type: 'enemySettlement';
  position: Point;
  radius: number;
  geometry: PolygonGeometry;
  metadata: {
    ground: 'wood' | 'rock' | 'open';
    distanceToSettlement: number;
    access: boolean;
    rotation: number;
  };
}
```

`ground` is read off the map, never configured, the same way `SettlementEntity.kind` is derived from
its membership. `distanceToSettlement` is a measured fact and `access` is the bounded judgement on
top of it, splitting the two the way a fishing site splits `distanceToShore` from `access`.

Rock needs a note: rock blocks, so a camp cannot be _in_ it. "Rocky areas" reads as ground at the
foot of a cliff, with the face giving cover and the approach exposed.

## E3 — who picks the ground

The PRD lists four preferences, which is a list of options rather than a recipe. Whether a game
camps in woods or in clearings is the same decision as `buildings.categories`: the generator draws,
the caller weights.

Caller weights over `{ wood, rock, open }` fit the existing S5 machinery, reuse `resolveCategories`,
and let a game say "caves only". The cost is a third weighting knob on a map that has no enemy
settlements by default.

Deriving the ground instead costs nothing to configure but fixes the mix at whatever the terrain
happens to offer, and a game whose camps are all in the woods because the map was mostly woods has
no way to say otherwise.

## E4 — a way to get out

"Dense forests (with a way to get out)" is the PRD already knowing that a wood is only a camp if it
can be left. `forests.ts` already publishes `walkableInside`, and `resources.ts` already implements
the 16-unit clear-run test for a hunting approach, including excluding every neighbouring grove and
both rock and water. That test is the one to reuse rather than a second version of it. `outwardFaces`
and `clearRun` moved out of `resources.ts` into `map/geometry.ts` so both callers share one
implementation rather than two that drift apart.

## E5 — quantity and distance

```ts
enemies?: { count?: number; minDistance?: number; grounds?: Partial<Record<EnemyGround, number>> };
```

`count` defaults to 0 and takes whole numbers, like every other count: a map says where rock ends
and where a river runs, not that anything lives there. `minDistance` defaults to 800, measured
above, and it turned out to be the setting most likely to be the reason a count comes up short. Camps
sit in the complement of the settlements by construction, so a map whose towns cluster puts them in the
other corner: seed 7 with four settlements leaves 5% of its land 800 units from all of them, asks for
14 camps and publishes 8, and the same map publishes all 14 at 300. Rock at 5.4% of the land is the
binding constraint for a rock-only caller, and the shortfall is visible in the count rather than
silent.

## What the build changed from this plan

Three things, each because the plan was wrong rather than because it was inconvenient.

**`access` was dropped.** The plan published an `access` flag and kept the sites that failed it. A
field that is always `true` because only passing sites are published carries nothing, and the short
count already tells a caller the ground ran out. Only reachable camps are published, with no flag.

**`distanceToSettlement` is optional.** The plan had it required, with `Infinity` for a map with no
settlements. `Infinity` is not a number a map can carry through JSON, and the validator was right to
refuse it — the first build did, on a map with no settlements. The field is now absent when there is
nothing to measure from, and required whenever the map publishes settlements, which is the only case
where it has an answer.

**The whole footprint is tested against water.** The plan tested the centre, as a resource site does.
That is the same trap a plot fell into with a river, and it showed up on the first measurement: over the
reference map a third of camps had a shore running through their own ground. The centre alone passed
and the published footprint was not buildable over. Rock is still not tested, because a camp at the
foot of a cliff is using it as cover.

## Still open

- Whether enemy settlements ever get roads, or are always reached cross-country. Nothing is carved
  for a camp and no road is routed to one, so a camp is currently reached over whatever ground is
  between it and the network.
- Whether a min-distance should be measured from the settlement centre or its clearing edge. 260 is
  the radius, and 800 from a centre is 540 from the edge. The difference has not mattered: at the
  default there are 500 units between the two and a camp that clears the distance cannot overlap a
  clearing.
