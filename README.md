# Procedural Map Generator

![The Fieldwork map studio showing an illustrated temperate landscape with lakes, roads, and woodland](docs/images/studio.png)

A procedural map generator for games and other projects. It started as a way to get good-looking maps generated from a seed for a game I was building, and it is general enough for any project that needs a world. The work is inspired by [Watabou](https://watabou.github.io), which showed what this kind of tool can do. Thanks.

`fieldwork-map` creates deterministic, semantic `GameMap` worlds. It is a Node ESM library with no DOM dependency and no runtime dependencies. The repository also includes a browser map studio for generation, import/export, and debug views.

## Install

From a git checkout, which builds the library on install:

```sh
npm install github:kinged007/procedural-map
```

From a published tarball:

```sh
npm install fieldwork-map
```

A git install runs the `prepare` script, so `dist/` is built for you and you do not need a global
TypeScript. Only `dist/` ships in the tarball, about 55KB.

## Setup

Requires Node.js 22.12 or later.

```sh
npm install
npm run dev
```

`npm run dev` starts the browser studio. Run the full local quality gate with:

```sh
npm run check
```

It runs formatting, linting, type checking, tests, and the demo build.

The same gate runs automatically before every commit, via the hook in `.githooks/`. `core.hooksPath` is set in this repository's git config. Because that setting lives in `.git/config` rather than in a tracked file, a fresh clone needs it enabled once:

```sh
git config core.hooksPath .githooks
```

Build outputs are `dist/` for the library and `dist-demo/` for the browser studio:

```sh
npm run build
```

## Library

Build the library before running Node code against `dist/`.

```js
import { exportMap, generateMap, importMap, validateMap } from './dist/index.js';

const map = generateMap({
  seed: 583921,
  width: 2048,
  height: 1536,
  water: { amount: 0.2 },
  vegetation: { density: 0.65, clustering: 0.8 },
  roads: { density: 0.5 },
  rivers: { density: 1, width: 12 },
});

const json = exportMap(map);
const restored = importMap(json);
const result = validateMap(restored);

if (!result.valid) throw new Error(result.errors.join('; '));
```

`generateMap(config)` returns a validated, deterministic `GameMap`. `exportMap(map)` returns canonical JSON, `importMap(jsonOrObject)` validates and clones native canonical maps, and `validateMap(value)` returns `{ valid, errors }`.

A map is one tile, bounded at 4096 by 4096. For a larger world, pass `origin` and `world`: the tile
becomes a window onto one landscape, sharing its neighbours' terrain at the edges and the same
waterline and rock line throughout, instead of a world of its own.

```js
const world = { width: 8192, height: 6144 };
const tiles = [];
for (let y = 0; y < world.height; y += 2048)
  for (let x = 0; x < world.width; x += 2048)
    tiles.push(generateMap({ seed: 583921, width: 2048, height: 1536, origin: { x, y }, world }));
```

A map still reports its own bounds and carries tile-local coordinates, so the read path and the
walkability grid need no knowledge of the world. Left alone, `origin` is zero and `world` is the tile's
own size, and a single-tile map is unchanged.

### Configuration

Every knob, with the value used when it is left out:

| Option                  | Default          | What it changes                                                                                                                                                                                          |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed`                  | `583921`         | The whole map. The same seed and the same config always produce the same map.                                                                                                                            |
| `width`, `height`       | `2048`, `1536`   | Tile size, up to 4096 by 4096.                                                                                                                                                                           |
| `origin`                | `{ x: 0, y: 0 }` | Where this tile sits in its world.                                                                                                                                                                       |
| `world`                 | tile size        | The world's size. Defaults to the tile, which is a world of one.                                                                                                                                         |
| `terrain.variation`     | `0.35`           | How strongly the terrain field swings between its highs and lows, which is what decides where the meadow, scrub, and rock boundaries fall. It does not change how much water there is.                   |
| `terrain.scale`         | `0.004`          | How large the patches of meadow, scrub, and forest are. Smaller is broader country, and far fewer trees. It does not move the coastline or the rock.                                                     |
| `water.amount`          | `0.2`            | How much of the map is below the waterline. `1` is all water, `0` none.                                                                                                                                  |
| `water.scale`           | `0.003`          | Despite the name, this is the scale of the **elevation** field, so it sets the size of the landforms and, with them, the size of the lakes and the extent of the rock. Larger is more, smaller features. |
| `vegetation.density`    | `0.65`           | How many trees. `0` is bare ground.                                                                                                                                                                      |
| `vegetation.clustering` | `0.8`            | How much the trees clump into groves rather than spreading evenly.                                                                                                                                       |
| `roads.density`         | `0.5`            | How many roads, and how far a tier reaches.                                                                                                                                                              |
| `rivers.density`        | `1`              | How many rivers. `0` publishes none at all, for a map whose water is only standing.                                                                                                                      |
| `rivers.width`          | `12`             | Channel width in world units, which also sets the span recorded at a road crossing.                                                                                                                      |
| `buildings.density`     | `0.5`            | The chance a site offered by a road is built on. `0` publishes no buildings.                                                                                                                             |
| `buildings.spacing`     | `34`             | Smallest gap between two buildings, centre to centre, measured across the whole map.                                                                                                                     |
| `buildings.setback`     | `16`             | How far a building's front wall stands off the road centreline. A farm sets its own.                                                                                                                     |
| `buildings.ruin`        | `0`              | Share of buildings that have fallen down, `0` to `1`. A ruin keeps its footprint and stops being a wall. `0` is no opinion on how a building looks.                                                      |
| `settlements.count`     | `2`              | How many settlements the map has. A map with no roads publishes none, whatever this is set to.                                                                                                           |

Values outside a knob's range are rejected at the boundary rather than clamped silently.

### Rivers, and roads going over them

A river is published in the same `water` collection as a lake, with `kind: 'river'`, so anything that
treats water as water treats a river as water. It is the main channel of a catchment, walked down the
drainage of the elevation field, and every river runs to the water it drains into: a lake it reaches,
the edge of the world, or a river already there that it joins. Where one reaches a lake, the site is
published as `water.metadata.mouths` on the river, which is where a delta or an estuary asset goes.

**A road goes over a river rather than around it**, because a channel is narrow enough to bridge. In
format 1.1 only lakes and rock refused a road; if you asserted that a road never touches water, that
assertion now fails. The assertion you want is that a road never enters a _lake_. Each crossing is
recorded on `road.metadata.crossings` with the river, the site, and the channel width, and a river
blocks the walkability raster under the road just like any other water, so a character cannot walk the
crossing until you make those cells walkable.

Both surfaces are on the map, so you do not need the record to find a bridge: any contiguous run of a
road's centreline inside a river's `geometry` is a road genuinely crossing that river. The recipe is in
[Consuming generated maps](docs/consuming-maps.md#3-roads).

### Buildings along the roads

`map.structures` holds buildings placed along the road network: each one a rectangle standing back
from a road with its front wall facing it, publishing its footprint, a matching collision polygon, a
`rotation`, a `category`, a `state` that says whether it stands or has fallen down, and the road it
belongs to. A standing building is a solid thing, so it blocks the walkability raster like the water
and the rock do; a ruin carries no collision, so a character walks over the rubble. What a building
looks like is the game's decision, so `state` is there to be ignored as much as read. `buildings.density`,
`buildings.spacing`, `buildings.setback`, and `buildings.ruin` place them; the details and the fields
are in [Consuming generated maps](docs/consuming-maps.md#4-buildings).

`map.settlements` holds the places: each one a centre standing on a road, a radius saying how far it
reaches, a `clearing` of open ground at its middle where nothing is planted or built, the ids of the
buildings inside it, and a `kind` of `hamlet`, `village`, or `town` read off how many buildings it
holds. A settlement carries no collision, because its radius says where a place ends rather than where
you cannot walk. A settlement with no buildings is a dead settlement, and mixing a high
`settlements.count` against a low `buildings.density` produces them. To start a character in one rather
than in the middle of a field, pass `preferSettlements: true` to `spawnCandidates`; to put the middle
of the place, build at `settlement.position`, which is inside its clearing and on the road.

For a per-frame movement check, bake the walkability grid once and read a byte per cell:

```js
import {
  generateMap,
  rasterizeWalkability,
  chunkTile,
  navigableRegions,
  spawnCandidates,
} from 'fieldwork-map';

const raster = rasterizeWalkability(map, { cellSize: 32 });
const chunk = chunkTile(raster, map, chunkX, chunkY, { chunkSize: 32 });
chunk[y * chunkSize + x]; // 0 open, 1 blocked

navigableRegions(raster); // the areas a character can walk between
spawnCandidates(raster, map, { count: 8, minSeparation: 200 });
```

A cell is blocked if any part of it is covered by water or rock. The rule is stated, with its
consequences, in [Consuming generated maps](docs/consuming-maps.md).

Trees are not in that grid, because a trunk blocks a small circle inside a large canopy and baking the
canopy would seal the clearings between trees. Each map also carries `forests`, the groves its trees
belong to, as a convex hull plus the trees inside. A chunk bake uses the hulls as a broadphase, so it
costs what the wood next to it costs rather than what the whole map costs, and `metadata
.walkableInside` on a forest tells you whether there is clear ground inside its hull before you decide
to seal it. A forest has no `collision`, on purpose: a grove is not a wall.

The Canvas renderer is available from the `fieldwork-map/rendering` subpath. Supply it with an HTML canvas and either the built-in `defaultTheme` or a custom `MapTheme`.

```js
import { CanvasRenderer } from 'fieldwork-map/rendering';
import { defaultTheme } from 'fieldwork-map';

const renderer = new CanvasRenderer(document.querySelector('canvas'));
renderer.render(map, { theme: defaultTheme, view: 'styled' });
```

## Documentation

| Document                                           | What it covers                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Consuming generated maps](docs/consuming-maps.md) | **Start here if you are consuming a map in a game.** What the generator produces, what it expects your engine to do, cost and limits, and what is not produced yet. |
| [GameMap v1.4 schema](docs/gamemap-schema.md)      | Field-by-field structure of the exported JSON, with worked examples taken from a real generated map, and every validation rule.                                     |
| [Generation](docs/generation.md)                   | How each layer is produced: fields, water, terrain classification, vegetation, and roads, and how the controls affect the result.                                   |
| [Architecture](docs/architecture.md)               | Where the product boundary sits and how the modules divide up.                                                                                                      |
| [PRD](../PRD.md)                                   | Requirements, design principles, and the roadmap.                                                                                                                   |

## License

MIT. See [LICENSE](LICENSE).
