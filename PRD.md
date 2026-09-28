# Procedural Map Generator

## Product Requirements Document

**Status:** MVP / v0.1  
**Project:** `procedural-map-mvp`  
**Primary platform:** TypeScript / JavaScript, Node.js + browser compatible  
**Purpose:** Standalone procedural map generation and map-import service/library for a browser-based game  
**Inspiration / reference:** Watabou Village Generator and related procedural settlement generators

---

# 1. Executive Summary

The Procedural Map Generator is an isolated map-generation system responsible for producing structured, deterministic, machine-readable maps that can be consumed by an external game system.

The generator must not contain game-specific player, combat, objective, team, NPC, or gameplay logic.

Its responsibility ends at producing a valid **semantic world description** containing terrain, water, vegetation, roads, structures, environmental obstacles, asset assignments, and related spatial metadata.

The central architectural principle is:

> **The game consumes a canonical map format and does not need to know whether that map was procedurally generated, manually authored, or imported from an external tool.**

Therefore:

```
Procedural Generator ─────┐
                          │
External Map Importer ────┼──► Canonical Map ───► Game
                          │
Future Map Editor ────────┘
```

The initial MVP will demonstrate this architecture using a simple generated environment consisting primarily of:

- grass / land;
- terrain variation;
- lakes / water;
- forests;
- individual trees;
- environmental collision/obstruction metadata;
- basic visual assets;
- deterministic seeded generation;
- JSON import/export.

The architecture must deliberately support future expansion toward significantly richer Watabou-style generated environments containing roads, settlements, buildings, fields, rivers, bridges, walls, vegetation systems, biomes, and configurable visual themes.

---

# 2. Problem

The game requires maps that can be created in several different ways.

Some maps should be generated automatically and randomly.

Some maps should use predefined generation parameters or themes.

Some maps should be manually designed using external tools such as Watabou Village Generator.

Some maps may eventually be edited through a dedicated map editor.

These different sources must not require separate implementations inside the game.

Without a standardized map abstraction, generation logic, visual assets, collision geometry, imported maps, and game integration become tightly coupled.

The system therefore needs an intermediate representation:

# `GameMap`

Every map source is converted into this format.

The external game system consumes only this format.

---

# 3. Product Vision

The long-term system should allow a developer to request:

```
generateMap({
    seed: 583921,
    size: "large",

    generation: {
        settlementDensity: 0.6,
        forestDensity: 0.7,
        waterAmount: 0.25,
        terrainVariation: 0.4
    },

    theme: "temperate-medieval"
});
```

and receive a complete semantic map.

Alternatively:

```
importMap(watabouJson);
```

should ultimately produce the same canonical map representation.

The game should therefore not care whether the map came from:

```
Random generation
        │
        ▼
     GameMap

Watabou JSON
        │
        ▼
     GameMap

Custom editor
        │
        ▼
     GameMap

Static authored JSON
        │
        ▼
     GameMap
```

This abstraction is the core product.

---

# 4. Scope Boundary

This repository is specifically a **map/world generation system**.

It is NOT the game engine.

## This project owns

- seeded random generation;
- terrain generation;
- elevation/environmental fields;
- water generation;
- vegetation generation;
- forest distribution;
- environmental structures;
- future road generation;
- future building placement;
- future settlement generation;
- environmental collision geometry;
- map boundaries;
- semantic terrain classifications;
- asset references;
- visual map rendering;
- themes;
- external map importing;
- map normalization;
- map validation;
- JSON serialization;
- deterministic regeneration.

## This project does NOT own

- players;
- player bases;
- teams;
- NPCs;
- enemies;
- combat;
- objectives;
- quests;
- game resources;
- capture points;
- player spawn logic;
- match balancing;
- game modes;
- scoring;
- AI behaviour;
- inventory;
- networking;
- game state.

Those systems belong to the consuming game.

The map system provides sufficient spatial information for those systems to make their own decisions.

For example, this service may expose:

```
{
    type: "tree",
    collision: {
        type: "circle",
        radius: 8
    }
}
```

The game decides what collision means for its player/entity system.

---

# 5. Core Architectural Principle

Generation and rendering must remain separate.

The generator produces:

```
SEMANTIC WORLD
```

not:

```
IMAGE
```

For example:

```
{
    "id": "tree-184",
    "type": "tree",
    "species": "oak",
    "position": {
        "x": 812,
        "y": 441
    },
    "radius": 9,
    "collision": {
        "type": "circle",
        "radius": 7
    },
    "asset": {
        "category": "vegetation.tree",
        "variant": "oak-03"
    }
}
```

The renderer may display this as a stylized illustrated tree.

The external game may instead render it using:

- Canvas;
- WebGL;
- PixiJS;
- Phaser;
- Three.js;
- SVG;
- sprites;
- another rendering engine.

The underlying map remains unchanged.

---

# 6. System Architecture

The intended architecture is:

```
                   GENERATION CONFIG
                         +
                        SEED
                         │
                         ▼
                ┌─────────────────┐
                │ MAP GENERATOR   │
                └────────┬────────┘
                         │
                         ▼
                      RawMap
                         │
                         ▼
                ┌─────────────────┐
                │ MAP NORMALIZER  │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ CANONICAL MAP   │
                │    GameMap      │
                └────────┬────────┘
                         │
              ┌──────────┼───────────┐
              │          │           │
              ▼          ▼           ▼
           Renderer   Validator    Exporter
              │                      │
              ▼                      ▼
         Visual Map                JSON
```

External maps enter at the normalization layer:

```
Watabou JSON
     │
     ▼
WatabouImporter
     │
     ▼
RawMap / normalized entities
     │
     ▼
GameMap
```

---

# 7. MVP Objectives

Version 0.1 must prove six architectural assumptions.

## 7.1 Deterministic procedural generation

The same seed and configuration must always generate the same map.

Example:

```
Seed 583921
     +
Configuration A
     ↓
Map X
```

must always produce Map X.

This is essential for:

- multiplayer synchronization;
- debugging;
- reproducibility;
- saving maps;
- testing;
- sharing generated worlds.

---

# 8. MVP Environment

The first generated environment should intentionally be simple.

It should contain:

### Terrain

A rectangular world consisting primarily of traversable grass/land.

### Water

One or more irregular bodies of water.

Water should be generated using spatial fields/noise rather than simple randomly positioned circles.

Water entities must expose their geometry.

### Vegetation

Trees should occur in natural-looking clusters.

Tree placement should be influenced by a generated vegetation/forest-density field rather than uniform random scattering.

This should naturally create:

- forests;
- forest edges;
- sparse woodland;
- clearings;
- open grassland.

### Environmental obstructions

Trees, water, and impassable terrain must expose collision/obstruction information.

The generator itself does not perform player collision.

It simply describes the geometry.


| Feature       | Collision shape | Notes                                                                      |
| ------------- | --------------- | -------------------------------------------------------------------------- |
| Trees         | circle          | Radius is smaller than the canopy, so the trunk blocks and not the leaves. |
| Water         | polygon         | Same polygon as the region's geometry.                                     |
| Rock terrain  | polygon         | Same polygon as the region's geometry.                                     |
| Other terrain | none            | `grass`, `meadow`, `scrub`, and `beach` are passable.                      |


Impassable terrain is identified by the presence of a `collision` on a terrain region, not by a separate list. Collision is therefore uniform across every collection: each blocking feature carries its own geometry, so a consumer does not need to know which kind of feature it is looking at.

Trees do not spawn inside impassable terrain, for the same reason they do not spawn inside water.

---

# 9. Procedural Generation Model

The MVP should use seeded coherent noise such as Simplex/OpenSimplex-style noise combined with deterministic pseudorandom generation.

Conceptually:

```
Seed
 │
 ├── terrain noise
 │
 ├── moisture noise
 │
 ├── vegetation noise
 │
 └── water/elevation noise
```

Multiple spatial fields should influence generation.

For example:

```
Elevation
    +
Moisture
    +
Forest probability
        ↓
Environmental classification
```

This approach provides a foundation for later biome generation.

Future systems may classify regions using combinations such as:

```
low elevation
      ↓
water

high moisture + moderate elevation
      ↓
forest

low moisture
      ↓
grassland

high elevation
      ↓
rock / mountain
```

MVP implementation may use simpler thresholds while preserving this architecture.

---

# 10. Generation Configuration

Generation parameters must remain independent from visual themes.

Example:

```
interface GenerationConfig {
    seed: number;

    width: number;
    height: number;

    terrain: {
        variation: number;
        scale: number;
    };

    water: {
        amount: number;
        scale: number;
    };

    vegetation: {
        density: number;
        clustering: number;
    };
}
```

A configuration such as:

```
{
    seed: 583921,

    width: 2048,
    height: 2048,

    terrain: {
        variation: 0.35,
        scale: 0.004
    },

    water: {
        amount: 0.20,
        scale: 0.003
    },

    vegetation: {
        density: 0.65,
        clustering: 0.8
    }
}
```

must produce deterministic results.

---

# 11. Theme System

Visual theme and map geometry must remain separate.

For example:

```
MAP

tree
tree
lake
grass
tree
```

could be rendered as:

```
Temperate Theme
Oak / birch / green grass / blue water
```

or:

```
Autumn Theme
Orange foliage / brown grass / dark water
```

without regenerating the map.

A theme should eventually define:

```
interface MapTheme {
    id: string;

    terrain: TerrainAssetSet;
    vegetation: VegetationAssetSet;
    water: WaterAssetSet;
    structures: StructureAssetSet;
}
```

MVP requires only one default theme.

---

# 12. MVP Asset Strategy

The first visual layer should take inspiration from the illustrated procedural-map style demonstrated by Watabou without depending on Watabou's proprietary generator implementation.

Initial environmental assets should preferably be procedurally drawn vector-like graphics.

Examples:

- stylized tree canopy;
- tree trunk;
- shoreline;
- grass texture/details;
- water fill;
- rocks or small environmental details if time permits.

Assets may be implemented using:

- Canvas drawing primitives;
- generated paths;
- SVG-compatible geometry;
- lightweight reusable vector definitions.

The semantic entity must not depend upon the visual implementation.

Example:

```
Tree Entity
    │
    ├── semantic information
    │
    ├── collision geometry
    │
    └── asset reference
             │
             ▼
         Renderer
```

The architecture must allow later replacement with:

- SVG artwork;
- raster sprites;
- generated vector graphics;
- externally created asset packs.

## 12.1 Asset Delivery Format (renderer-side decision, not MVP scope)

This section records a decision for the eventual game renderer. It does not change the MVP and it is not a v0.1 acceptance criterion. It changes nothing in `GameMap`, generation, or the canonical schema.

**Author SVG, ship a texture atlas.** SVG is the authoring format because it is resolution-independent and diffable in source control. It is not a runtime format: per-element overhead makes one DOM path per tree far too expensive for realtime use, and thousands of loose textures forfeit GPU batching and exhaust video memory.

A realistic browser target, given the MVP's roughly 1,600 trees on one map:

- author each asset as SVG;
- bake all variants into a single texture atlas at build time;
- ship that atlas plus a small JSON manifest mapping `category` / `variant` to a frame rectangle;
- render with WebGL2 instanced quads, one draw call per atlas;
- use KTX2 / Basis for GPU-compressed texture delivery at scale.

Two alternatives earn their place conditionally:


| Condition                                              | Approach                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Large, stylised vector art viewed at a wide zoom range | SDF atlas — crisp vector-looking outlines at any zoom from one small texture |
| Tens of thousands of distinct, non-variant art         | WebGL2 `sampler2DArray` texture arrays instead of a single atlas             |


In-world text should stay vector or SDF regardless of the choice for everything else.

**Why procedural drawing is not the shipping format.** Canvas drawing is deterministic per engine but not guaranteed across engines: `Math.sin` and `Math.cos` are implementation-approximated in ECMA-262, so different JavaScript engines can differ in the final bits. The variation is not visible, but it means the visual result cannot be verified once for every client. Baking makes the asset pipeline verified once and identical on every machine, which is what a realtime multiplayer client needs.

**Where this plugs in.** The `AssetReference` (`category` + `variant`) on every entity is the seam, and `AssetResolver` is the function that resolves it. It currently returns colours and shape parameters; in a game engine it returns a texture, a frame rectangle, and a pivot. Only that resolver changes. The map stays JSON, assets stay content-hashable and CDN-cached, and no map is regenerated as a result.

---

# 13. Canonical Map Format — GameMap v1

A formal schema must be created early.

Illustrative structure:

```
interface GameMap {
    version: "1.0";

    metadata: {
        id: string;
        seed?: number;
        generator?: string;
        generatedAt?: string;
    };

    bounds: {
        width: number;
        height: number;
    };

    terrain: TerrainRegion[];

    water: WaterRegion[];

    vegetation: VegetationEntity[];

    structures: StructureEntity[];

    roads: RoadEntity[];

    barriers: BarrierEntity[];

    metadataLayers?: Record<string, unknown>;
}
```

Not every collection must contain entities in MVP.

Empty collections should nevertheless be supported to preserve schema stability.

---

# 14. Base Map Entity

Environmental objects should share a common structure.

Example:

```
interface MapEntity {
    id: string;

    type: string;

    position?: {
        x: number;
        y: number;
    };

    rotation?: number;

    tags?: string[];

    collision?: CollisionGeometry;

    asset?: AssetReference;

    metadata?: Record<string, unknown>;
}
```

---

# 15. Collision Geometry

The map must expose collision geometry without implementing game physics.

Supported MVP geometry:

```
type CollisionGeometry =
    | CircleCollision
    | PolygonCollision
    | RectangleCollision;
```

Examples:

```
tree
    ↓
circle collision
```

```
lake
    ↓
polygon collision
```

Future examples:

```
building
    ↓
polygon footprint
```

```
wall
    ↓
polyline / polygon
```

The consuming game can transform these definitions into its own physics or navigation system.

---

# 16. Renderer

The MVP must contain a browser visualization tool.

Its purpose is both demonstration and debugging.

The renderer is NOT the canonical representation of the map.

It consumes `GameMap`.

The UI should approximately provide:

```
┌─────────────────────────────────────────────┐
│ Procedural Map Generator                    │
├─────────────────────────────────────────────┤
│ Seed            [ 583921 ]                  │
│ Forest Density  [━━━━━━●━━]                 │
│ Water Amount    [━━━━●━━━━]                 │
│                                             │
│ [ Generate ] [ Random Seed ]                │
│ [ Export JSON ] [ Import JSON ]             │
├─────────────────────────────────────────────┤
│                                             │
│                 MAP                         │
│                                             │
│    trees           lake                     │
│     forest       ~~~~~~~~                   │
│                 ~~~~~~~~~                   │
│         grass      ~~~~                     │
│                                             │
└─────────────────────────────────────────────┘
```

---

# 17. Debug Visualization

Debugging procedural systems becomes increasingly difficult as algorithms become more sophisticated.

Therefore debug visualization should exist from MVP.

Possible layers:

```
Rendered Map
Terrain Field
Elevation Field
Water Mask
Vegetation Probability
Entity Locations
Collision Geometry
```

The user should be able to toggle these layers.

Example:

```
View:

● Styled
○ Terrain Noise
○ Water
○ Forest Probability
○ Collision
○ Entities
```

This becomes increasingly important when roads, buildings, plots, settlements and biomes are introduced.

---

# 18. JSON Export

Every generated map must be exportable as canonical JSON.

Example:

```
Generate
    ↓
GameMap
    ↓
Export
    ↓
map-583921.json
```

The exported file must contain sufficient information to reconstruct the map without rerunning procedural generation.

---

# 19. Native JSON Import

The MVP must support importing its own exported maps.

Therefore:

```
Generate
 ↓
Export JSON
 ↓
Import JSON
 ↓
Render
```

must reproduce the same world.

This validates the canonical schema.

---

# 20. External Import Architecture

External formats must use adapters.

Conceptually:

```
interface MapImporter<T> {
    canImport(data: unknown): boolean;

    import(data: T): GameMap;
}
```

Initial structure:

```
importers/

    NativeMapImporter.ts
    WatabouImporter.ts
```

`WatabouImporter` may initially be incomplete or experimental.

It must nevertheless exist as a first-class architectural concept.

---

# 21. Watabou Integration Goal

Watabou Village Generator supports JSON export containing generated settlement information.

The long-term objective is:

```
Watabou Village Generator
          ↓
       JSON export
          ↓
     WatabouImporter
          ↓
      normalization
          ↓
        GameMap
          ↓
          Game
```

The external game must not require special Watabou-specific handling.

Any information that can be reliably extracted should eventually be mapped into canonical entities such as:

- roads;
- buildings;
- vegetation;
- water;
- fields;
- walls;
- terrain;
- bridges;
- other structures.

Exact support depends on the available Watabou export schema and should be implemented incrementally after examining representative exports.

---

# 22. Validation

Maps must pass validation before being returned.

MVP validation should include:

- valid map dimensions;
- entity IDs unique;
- coordinates inside map bounds;
- valid polygons;
- no malformed collision geometry;
- no trees generated inside water;
- no invalid numeric values;
- supported schema version.

Later validation may include:

- roads remain connected;
- buildings do not overlap improperly;
- buildings are not underwater;
- bridges connect valid land regions;
- structures remain accessible;
- settlement geometry remains valid.

---

# 23. Proposed Repository Structure

```
procedural-map-mvp/

├── src/
│
│   ├── map/
│   │   ├── GameMap.ts
│   │   ├── MapEntity.ts
│   │   ├── CollisionGeometry.ts
│   │   └── schema.ts
│   │
│   ├── generation/
│   │   ├── MapGenerator.ts
│   │   ├── GenerationConfig.ts
│   │   ├── SeededRandom.ts
│   │   │
│   │   ├── terrain/
│   │   │   └── TerrainGenerator.ts
│   │   │
│   │   ├── water/
│   │   │   └── WaterGenerator.ts
│   │   │
│   │   └── vegetation/
│   │       └── VegetationGenerator.ts
│   │
│   ├── themes/
│   │   ├── MapTheme.ts
│   │   ├── AssetResolver.ts
│   │   └── default/
│   │       └── DefaultTheme.ts
│   │
│   ├── rendering/
│   │   ├── MapRenderer.ts
│   │   ├── CanvasRenderer.ts
│   │   └── DebugRenderer.ts
│   │
│   ├── importers/
│   │   ├── MapImporter.ts
│   │   ├── NativeMapImporter.ts
│   │   └── WatabouImporter.ts
│   │
│   ├── exporters/
│   │   └── JsonExporter.ts
│   │
│   ├── validation/
│   │   └── MapValidator.ts
│   │
│   └── index.ts
│
├── demo/
│   ├── index.html
│   ├── app.ts
│   └── styles.css
│
├── tests/
│
├── examples/
│   └── maps/
│
├── docs/
│   ├── architecture.md
│   ├── gamemap-schema.md
│   └── generation.md
│
├── PRD.md
├── README.md
├── package.json
└── tsconfig.json
```

Exact structure may evolve, but architectural boundaries should remain.

---

# 24. Public API

The generator should eventually be usable without its demo interface.

Example:

```
import {
    generateMap,
    importMap,
    validateMap
} from "@project/procedural-map";
```

Generation:

```
const map = generateMap({
    seed: 583921,
    width: 2048,
    height: 2048,

    water: {
        amount: 0.2
    },

    vegetation: {
        density: 0.7
    }
});
```

Import:

```
const map = importMap(json);
```

Validation:

```
const result = validateMap(map);
```

The consuming game should not need the demo UI or renderer.

---

# 25. Service/Library Independence

The project should be capable of operating as:

1. a TypeScript library;
2. a Node.js module;
3. a browser module;
4. potentially later, a standalone generation service/API.

The core generator must therefore not depend upon browser DOM APIs.

This separation should be maintained:

```
Core
    generation
    schemas
    import
    export
    validation

Browser-only
    demo UI
    canvas renderer
    debug visualization
```

This ensures server-side generation remains possible.

---

# 26. MVP Acceptance Criteria

Version 0.1 is considered successful when:

1. A developer can enter a numeric seed.
2. The generator produces a deterministic map.
3. Different seeds visibly produce different maps.
4. Maps contain grass/land.
5. Maps contain naturally shaped water areas.
6. Maps contain clustered forests/trees.
7. Trees do not spawn inside water.
8. Trees exist as semantic entities.
9. Water exists as semantic geometry.
10. Environmental obstacles expose collision metadata.
11. The map can be rendered using the default theme.
12. Debug layers can display generation information.
13. The map can be exported as JSON.
14. Exported JSON can be imported again.
15. Re-imported maps visually and semantically match the original.
16. Core generation works without the browser renderer.
17. Generation configuration is independent from visual theme configuration.
18. The architecture contains a defined external importer interface.

---

# 27. Testing Requirements

Deterministic generation requires automated testing.

Important tests include:

```
same seed + same config
        ↓
identical GameMap
```

and:

```
different seed
        ↓
different generated map
```

Additional tests:

- entities remain inside bounds;
- tree/water exclusion works;
- serialization round-trip preserves map;
- invalid JSON is rejected;
- invalid polygons are detected;
- duplicate IDs fail validation;
- unsupported schema versions fail cleanly.

Snapshot/hash-based deterministic tests should be considered.

---

# 28. Performance

MVP does not need extreme optimization.

However, the architecture should anticipate large maps.

Generation algorithms should avoid unnecessary object allocation in high-density spatial fields.

Potential future optimization techniques include:

- typed arrays for noise fields;
- spatial indexes;
- chunked generation;
- Web Workers;
- server-side generation;
- lazy rendering;
- deterministic chunk generation.

No premature optimization is required in v0.1.

### 12.2 Overlapping terrain regions

`terrain` regions are generated as independent contours of a shared field, so a point may belong to more than one region. This is intentional, but it needs a rule so a consumer always gets the same answer.

- Regions are emitted in a fixed order: the full-bounds `grass` base, then all `meadow`, then all `scrub`, then all `rock`, then all `beach`.
- A point belongs to every region whose polygon contains it.
- The surface is the **last** matching region, giving precedence `beach` over `rock`, `rock` over `scrub`, `scrub` over `meadow`, and `meadow` over `grass`.
- The regions are **not** nested. Each kind is contoured from a different field, so the boundaries cross and regions overlap freely.

Consumers that need one surface per point must test the final match, or test kinds in `beach`, `rock`, `scrub`, `meadow`, `grass` order. Testing the first match will report `grass` almost everywhere and is incorrect.

Obstruction is **not** resolved by that ordering. A `rock` region blocks movement across its whole polygon even where a later `beach` region draws over part of it, so a consumer walking the surface and a consumer walking the collision polygons can disagree about a given point. That disagreement is intended: sand drawn over the edge of a rock face does not make the rock walkable.

A strict partition, in which every region is disjoint and covers the map exactly once, is a possible future alternative. It is not implemented, and changing to it would be a breaking change to how consumers read `terrain`.

---

# 12.3 Road geometry and connectivity

A road is a centreline plus a width. The centreline is an ordered polyline from one end of the road to the other, and the width is the full width of the surface. The collision polygon is the ribbon formed by offsetting the centreline to each side, so collision covers the visible road and nothing else.

- A road is one entity with one centreline. Junctions are not separate entities; two centrelines simply meet.
- Roads are published as `primary`, `secondary`, or `path`, in descending width.
- A road that branches from another is required to touch it. Every other pair of roads is kept a minimum distance apart, so a consumer can tell a junction from two roads running alongside each other.
- A road never enters a lake or impassable terrain. A step into either is refused, so a road bends around an obstruction for as long as it can and ends where the ground runs out. It does not cross a lake. Bridges and fords are v0.7 work.
- A river is the exception, because a channel is narrow enough to bridge. A road goes over it, and where its surface reaches the channel it records the crossing, so the site a bridge goes is published without the bridge being built. Roads follow the land and rivers run in the valleys, so a road that meets a river usually runs alongside it for a while before it goes over: the recorded site is the closest the two come.
- A road is kept a minimum distance from a lake's edge, measured from its centreline. A road that stops level with the shoreline reads as cut off rather than routed, so the refusal happens short of the water and the road turns along the bank instead of ending against it. The clearance is a fixed value in world units, not a share of the map, so it looks the same on a small map and a large one.
- Trees are not planted on a road or overhanging it. A road is cut through the wood, so its verges are left clear and the map carries a visible clearing along every road. Vegetation is generated after roads for this reason.
- A ribbon whose ring intersects itself is not a road. Reversals are removed from the centreline before the ribbon is built, and a candidate whose ribbon is still not simple is discarded rather than published.
- `roads.density` scales the target count per tier. It never drops a tier to zero, so a sparse map is a small network rather than no network.
- Road generation is skipped when water and impassable terrain together cover more than 55% of the map, since routing has no meaningful result there.

Routing is a greedy walk over a small fan of headings, not a shortest-path search. Each step takes the cheapest heading available, which produces the meander and long detours of a surveyed road rather than a taut path between endpoints. With lakes and rock treated as walls, the meander is a detour around an obstruction rather than a line drawn through it. A river is not a wall, so a road crossing one is a straight step over a channel rather than a detour, and the walk has no memory of how long it has been following a bank: a road that meets a river often runs alongside it before it commits to a crossing.

---

## 12.4 Rivers and crossings

A river is water, and it is published in the same `water` collection as a lake, distinguished by `kind`. A consumer that treats water as impassable treats a river as impassable without knowing which is which, and a consumer that draws water needs no second case.

- A river is the surface of a course, not a lake polygon. A course is walked down the drainage of the elevation field and offset to a channel width, so a river is a ribbon with no holes and a lake is a contour that may have them.
- A river is the main channel of a catchment, not the shortest way off a hill. The flood counts how many cells drain through each one, and a course is traced up the largest tributary to where the ground divides, then down to the water. The shortest path out of a hill is not a river, and tracing it puts rivers a few hundred units long wherever that happens to fall, which is short enough that a road network never meets one.
- A river is not a wall to a road, because a channel is narrow enough to bridge. A road's surface is its centreline a half-width either side, and a crossing is recorded wherever that surface reaches the channel. The record is a *site*, not a structure: a consumer places a bridge, a ford, or a ferry there, and the network becomes connected across the river. The record is a hint that the two surfaces touch, not proof the road spans the channel — a road running along a bank with its edge in the water carries a crossing too. The truth is in the geometry: the full road centreline and the full channel are both published, so the real overlap is a point-in-polygon test between them, and a bridge is sized from the part of the centreline over the channel. The record carries the channel's width, not a deck's length.
- A river never lies over standing water. A course is cut where it first reaches a water body's edge, and the site is published as a `mouth`: the water body's id, the point where the channel met it, and a small square one channel wide at that point for placing a delta, a silt bank, or an estuary.
- Every river runs to water. A course is one reach from the divide above its source down to the lake it reaches or off the edge of the world, and the head and the tail of that reach are published joined rather than as the longer of the two. A river that stops part-way down a catchment is a stripe, not a river. The one exception is a course reaching a river already published, which is cut back to the junction and published as the tributary it is, because below the junction the water belongs to the river already there.
- A river never lies across standing water, and a mouth is the one place the two overlap. The cut is where the channel's edge reaches the water rather than where its centreline does, because a course running along a shore arrives half a channel early, and the end is then slid onto the shore so the two bodies of water join instead of leaving a step of land between them. They overlap by half a channel at the join, which is what a mouth is: the channel widens where it meets standing water, and the delta marker sits over the join.
- The drainage is derived, not painted. A flood from the map border raises every pit to the level its water would have to reach to get out, and the cell that reached each cell becomes its parent. A course is a path through that tree, so it cannot cross itself. A course runs up the largest tributary and down to where the water is.
- The key on a road is absent when a road's surface reached no river, and present once per river it did, so a road running along a bank for a while is one crossing rather than one per step. The point recorded is the closest the road comes, which is the narrowest reach to cover.
- A river blocks the walkability raster like any other water, including where a road goes over it. A crossing is a fact about the road, not about the ground: a consumer that wants a character to walk over one makes the cells at the site walkable.
- `rivers.density` scales the count and `rivers.width` sets the channel, so a map whose water is only standing passes `density: 0` and publishes no river at all.
- Bridges and fords remain v0.7. v0.3 publishes where one goes, and draws nothing there: a road is rendered over the water, and the part of a road's centreline that lies over a channel is the bridge, in the data a consumer already has.

## 12.5 Buildings

A building is a solid rectangle standing on the ground, published in `structures`, and it is the only structure the generator produces so far.

- A road is the only thing that offers a site. A building is placed because a road was there, and a building that needs to stand away from a road entirely is a different placement problem belonging to settlements.
- A building faces its road. `rotation` points from the building towards the road rather than along it, so a building looks back down the way it stands and the front wall is the face nearest the centreline. Both sides of a road are built on, so a settlement grows from both banks.
- The footprint is the collision, exactly as water and roads are, so a consumer never reconciles two shapes. The renderer works the front wall out from `position` and `rotation` rather than from the order of the ring, so a hand-written map that wrote the ring the other way round still draws.
- A category earns its place by changing the placement, not only the name. A house is small and uses the configured setback; a farm is larger and stands well back from the road, which is what a farmyard is. Two categories are enough to carry that, and a third that only changed the asset would not be a category.
- Spacing is a global centre-to-centre minimum rather than a gap along one road, so buildings on two roads that run close together do not end up inside each other. It also makes `setback` behave oddly at the low end: pulling both rows in towards a road pulls them into each other, and below the spacing they cancel out and the map gets fewer buildings. A control that is not monotone is called out here rather than left to be discovered.
- A building is refused a site in the water, on rock, in a road, on a beach, or under a tree. A beach is the one of these that nothing refuses to walk on: a building is kept off it anyway, because a house standing on the sand is a house nobody would build, and because a shoreline is where a port, a pier, or a boat shed belongs. Keeping the band clear is what leaves that ground for a category able to claim it, which is v0.5 work; the v0.4 rule is only that nothing stands there yet. Trees are generated first, so a tree is the reason a building is dropped and not the other way round: the wood is worth more to a map than the house beside it.
- A building blocks the walkability raster, in the same list as water and rock. Nothing in the format says where a door is, so a consumer wanting a doorway finds it itself.
- A building is not a parcel. There is no plot, no boundary, and no ownership: it is a rectangle standing on ordinary ground, and the ground around it is ordinary terrain.

---

# 29. Roadmap

## v0.1 — Environmental Generator

Goal:

**Prove the architecture.**

Features:

- seeded PRNG;
- coherent noise;
- terrain field;
- water generation;
- grass;
- forest-density field;
- tree entities;
- collision metadata;
- canonical `GameMap`;
- basic illustrated renderer;
- debug layers;
- generation controls;
- JSON import/export;
- map validation;
- native importer.

---

## v0.2 — Terrain &amp; Biomes

Introduce richer environmental classification.

Potential additions:

- elevation;
- moisture;
- biome classification;
- beaches;
- rocky terrain;
- hills;
- multiple vegetation species;
- vegetation rules;
- improved lake generation;
- rivers.

Conceptually:

```
Elevation + Moisture + Temperature
                 ↓
               Biome
```

---

## v0.3 — Road Generation

Introduce generated path networks.

Potential work:

- primary roads;
- secondary roads;
- organic paths;
- road connectivity;
- terrain-aware routing;
- river crossing detection;
- road semantic entities.

This marks the beginning of settlement-oriented generation.

---

## v0.4 — Building Placement

Introduce structures.

Features:

- building footprints;
- road-facing placement;
- building spacing;
- collision polygons;
- building categories;
- orientation;
- asset assignment;
- plot/parcel concepts.

Delivered in v0.4:

- Building footprints, collision polygons, categories, orientation, and asset assignment are published
as a typed `BuildingEntity` in `structures`, and the format moved to 1.3 to say so.
- Road-facing placement, on both sides of a road, with a global spacing minimum.
- `buildings.density`, `buildings.spacing`, and `buildings.setback` place them.
- **Plot and parcel concepts are deferred to v0.5.** They are listed above as a v0.4 feature and are
deliberately not delivered in it. A building is a rectangle on the ground and nothing claims the
ground around it. A parcel only means something once there are settlements dividing land between
owners, so publishing an empty boundary now would be a shape with no meaning that v0.5 would have to
unpick rather than extend. v0.5 owns plots, and the building format does not have to change for one
to arrive: a plot is the ground around a building, and the field to add is on the building itself
once there is more than one way to place it.
- Which categories to place is a fixed weighted draw, not a configuration. A caller that wants to
choose is asking for the settlement phase, where placement and category become one problem.

---

## v0.5 — Settlement Generation

Move toward the structural capabilities demonstrated by tools such as Watabou Village Generator.

Potential systems:

- settlement centres;
- organic road networks;
- building plots;
- village density;
- town density;
- central squares;
- neighbourhoods;
- settlement boundaries;
- which building categories a map places;
- shoreline categories, including a port or a pier that stands in the water.
- NEW - Settlements may be considered a player base or spawn point. we want parameters that can define the quantity of settlements to spawn, and mixed with the housing and other params, we may generate maps with a dead settlement (ie. no surrounding buildings, or its all in ruins.)

Delivered in v0.5 so far:

- Settlement centres, published as a `SettlementEntity` in a new `settlements` collection, and the
  format moved to 1.4 to say so. A centre stands on the road network and holds the buildings within
  260 units of it, naming them in `metadata.buildingIds`.
- **`settlements.count` sets how many settlements a map has.** It is a count and not something derived
  from the road network, so a caller asking for four gets four whether the network has four pieces or
  two. The network supplies the sites, the caller supplies the number.
- A settlement carries no collision: its `radius` says how far a place reaches, not where you cannot
  walk. A consumer testing the ground it covers uses the distance itself, the same way it treats a
  forest hull.
- **A dead settlement is reachable by mixing the parameters rather than by a switch.** Membership is by
  proximity, so a centre that ends up with nothing near it publishes an empty `buildingIds`, which
  validation accepts. A high `settlements.count` against `buildings.density: 0` publishes a map of
  places and no buildings at all.
- The generator does not designate a player base. The note above says a settlement *may* be one, which
  is a consumer's choice of where to start, so a settlement carries no `role` field until something
  writes one. A caller asks for one instead: `spawnCandidates(..., { preferSettlements: true })` puts
  each settlement centre first and tags it with `settlementId`, and the rest of the count is filled
  from the roomiest ground as usual.
- A settlement carries a `kind` of `hamlet`, `village`, or `town`, read off how many buildings it
  holds rather than configured, so a dead settlement reads as a hamlet. The thresholds match the range
  the generator actually reaches, which the settlement radius bounds: a settlement holds at most about
  a dozen buildings, so a `town` here is a large village, and a caller wanting a real town needs a
  knob on the radius first.
- **A central square, as a `clearing` rather than a drawn plaza.** The item is on the list above, and
  what a consumer can draw for itself is not the point: a consumer drawing a square over a wood still
  gets a square over a wood. Each settlement publishes a `clearing`, 28 units of reach around its
  centre, and the sites are chosen before the trees and the buildings so that nothing is planted or
  built in it. A consumer places the middle of a place at `position`, which is inside the clearing and
  on the road. It carries no collision, because the point is to make the ground open.
- Every building belongs to exactly one settlement, the one whose centre is nearest. Reaches on centres
  that are a radius apart do overlap, and a building claimed by two places has no meaning for a
  consumer resolving a name.
- A centre prefers a main road to a lane, `primary` before `secondary` before `path`, so a place
  grows where the traffic is. A map whose network is all lanes still publishes its settlements, on
  lanes.
- Because a clearing is a keep-out, `settlements.count` now decides which trees and buildings exist:
  the count fixes where the clearings are, and they are ground the placers must leave alone.
- **The second half of a dead settlement: ruins.** `buildings.ruin` is the share of buildings that have
  fallen down. A ruin keeps its footprint and drops its `collision`, so a character walks over the
  rubble, and `state` says which it is on every building. A ruin does not make a place bigger:
  `kind` counts what stands, so a village of shells is a hamlet. The two halves are reached by
  mixing parameters rather than by switches, so a dead settlement is either nobody built there or
  everything there fell down. This is a convenience and not a style system: what a building looks like
  is the game's decision, a game that renders its own styles can ignore `state` entirely, and `ruin: 0`
  gives the generator no opinion. Watabou's per-building states are a style catalogue, which is a
  different thing from a share and would be a different field.

Carried over from v0.4 and deferred here on purpose: plots and parcels. Choosing which categories get
placed rather than drawing from a fixed weighted set is v0.5 work, and it is worth doing as the caller
supplying the weights rather than as the plan originally framed it, which was a weight per settlement
kind. That framing is circular: `kind` is read off the membership and the membership is built from the
buildings, so a building cannot choose its category from a kind that does not exist yet. The PRD asks
which categories a map places, and a caller-supplied weight table answers that with no cycle, and also
makes a hamlet and a town look different without either being told what it is. A shoreline is v0.5
work too, because v0.4 keeps the whole beach band clear of buildings, which is what leaves a port or a
pier somewhere to stand.

Measured and deliberately not built, so the reasons are on the record rather than implied:

- A settlement needs no terrain site test. Across 64 centres on 16 maps, none landed on rock, in water,
  or on a beach, and none on steep ground, because the road generator already refuses to cross water
  or impassable rock and keeps a margin from a shoreline. Every point on a road is good ground by
  construction, so a site test would re-check an invariant the roads already hold.
- A settlement publishes no boundary polygon. The radius and the membership list already answer whether
  a building is inside a place, and a polygon would contradict the decision that a settlement is a
  distance and not a shape.
- There is no central square. A consumer draws one from `position`, `radius`, and `kind`. A plaza that
  reserves ground or blocks movement would be a different feature and is not planned.

Generation parameters might include:

```
settlement density
road density
building density
building spacing
centrality
organic/regular layout
```

---

## v0.6 — Rural Structures

Add environmental features surrounding settlements:

- fields;
- farms;
- orchards;
- fences;
- trails;
- clearings;
- isolated buildings;
- vegetation transitions.

---

## v0.7 — Infrastructure

Add:

- bridges;
- walls;
- gates;
- docks;
- piers;
- paths;
- river crossing structures, on the sites v0.3 publishes;
- barriers.
- NEW - Enemy spawn locations. Games will decide how to render the asset, but lets call it enemy bases. a custom parameters to determine quantity and minimum distance from a settlement.

---

## v0.8 — Theme System Expansion

Separate generation completely from visual identity.

Example themes:

```
Temperate Medieval
Nordic
Autumn
Winter
Desert
Swamp
Fantasy
Ruined
```

Themes should primarily define:

- asset sets;
- palette;
- terrain rendering;
- vegetation rendering;
- architecture;
- decoration.

Themes should not fundamentally alter the canonical schema.

---

## v0.9 — Watabou Import

Develop robust support for representative Watabou Village Generator JSON exports.

Workflow:

```
Create/customize village in Watabou
             ↓
         Export JSON
             ↓
       Import into system
             ↓
      Convert to GameMap
             ↓
          Validate
             ↓
         Render / use
```

This provides a practical manual/custom map authoring workflow without requiring a custom editor immediately.

---

## v1.0 — Stable Map Platform

Target:

A stable map-generation/import platform capable of supplying production maps to the main game.

Expected capabilities:

- procedural terrain;
- water;
- biomes;
- forests;
- roads;
- settlements;
- buildings;
- environmental structures;
- multiple themes;
- canonical map schema;
- deterministic generation;
- import/export;
- external-map adapters;
- validation;
- stable TypeScript API.

---

# 30. Post-v1 Opportunities

Possible future capabilities include:

### Chunked worlds

Generate sections of extremely large maps deterministically as needed.

### Custom map editor

```
Generate
   ↓
Edit
   ↓
Validate
   ↓
Export
```

### Generation presets

For example:

```
Dense Forest Village
River Settlement
Open Farmland
Mountain Village
Lakeside Village
Walled Town
```

These should primarily be parameter presets rather than separate generators.

### Community maps

Because maps use a standardized JSON format, maps could eventually be shared independently from game code.

### Procedural asset generation

More sophisticated building/tree/environment illustrations could themselves be generated from parameters.

### Generation plugins

Independent generators could potentially contribute map layers:

```
TerrainGenerator
WaterGenerator
RoadGenerator
SettlementGenerator
VegetationGenerator
StructureGenerator
```

---

# 31. Design Principles

The project should follow the following principles throughout development.

### Semantic first

Generate meaningful world entities, not pixels.

### Deterministic

Seeds must reliably reproduce worlds.

### Renderer independent

Map structure must not depend upon Canvas, SVG, Phaser, PixiJS or another rendering technology.

### Theme independent

Generation determines **what exists and where**.

Themes determine **what it looks like**.

### Gameplay independent

The generator describes the environment.

The game determines what happens inside that environment.

### Import-source independent

The game should not care whether a map originated from procedural generation, Watabou, an editor or a static file.

### Extensible

New map layers should not require rewriting existing generators.

### Observable

Generation decisions should be inspectable through debug visualization.

### Validated

Generated maps should satisfy structural invariants before being returned.

---

# 32. Guiding Architecture

The complete long-term pipeline should remain conceptually:

```
                         MAP SOURCE
                             │
            ┌────────────────┼────────────────┐
            │                │                │
       Procedural         Watabou          Editor
       Generator           JSON            / Other
            │                │                │
            └────────────────┼────────────────┘
                             ▼
                       NORMALIZATION
                             │
                             ▼
                         GameMap
                             │
                 ┌───────────┼───────────┐
                 │           │           │
                 ▼           ▼           ▼
             Validation   Rendering    JSON Export
                 │
                 ▼
              Consumer
                 │
                 ▼
              MAIN GAME
```

The boundary between `GameMap` and the consuming game is the most important contract in the project.

The procedural generator may evolve substantially over time.

The renderer may evolve substantially over time.

Asset technology may change.

New importers may be introduced.

Generation algorithms may become considerably more sophisticated.

The external game should remain largely unaffected by those changes because it consumes the stable canonical map representation.

---

# 33. Immediate Development Plan

Implementation should begin in the following order:

**Phase 1 — Foundation**

Define:

- `GameMap v1`;
- entities;
- collision geometry;
- `GenerationConfig`;
- `MapTheme`;
- importer interface;
- validator interface.

**Phase 2 — Deterministic generation**

Implement:

- seeded PRNG;
- coherent noise;
- spatial fields;
- deterministic tests.

**Phase 3 — Environment**

Implement:

- land;
- water;
- forest probability;
- tree placement;
- exclusion rules.

**Phase 4 — Rendering**

Implement:

- browser canvas;
- grass;
- stylized water;
- stylized procedural trees;
- map bounds;
- zoom/fit if required.

**Phase 5 — Debugging**

Expose:

- noise fields;
- water mask;
- forest field;
- entity positions;
- collision geometry.

**Phase 6 — Persistence**

Implement:

- JSON export;
- native JSON import;
- schema validation;
- round-trip tests.

At completion, the project should provide the first genuinely usable version of the map platform:

```
          SEED + PARAMETERS
                  │
                  ▼
        PROCEDURAL GENERATOR
                  │
                  ▼
              GameMap
             /       \
            ▼         ▼
       Visualizer    JSON
                        │
                        ▼
                    Main Game
```

This MVP then becomes the foundation on which roads, buildings, settlements, richer themes and Watabou compatibility are progressively developed without replacing the underlying architecture.