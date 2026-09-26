# GameMap v1.0 schema

The exported canonical JSON follows `gameMapSchema`, also exported by the library. Every map contains `version`, `metadata`, `bounds`, `terrain`, `water`, `vegetation`, `structures`, `roads`, and `barriers`. The last three collections may be empty.

```ts
interface GameMap {
  version: '1.0';
  metadata: { id: string; seed?: number; generator?: string; generatedAt?: string };
  bounds: { width: number; height: number };
  terrain: TerrainRegion[];
  water: WaterRegion[];
  vegetation: VegetationEntity[];
  structures: MapEntity[];
  roads: MapEntity[];
  barriers: MapEntity[];
  metadataLayers?: { fields?: SpatialFields; [key: string]: unknown };
}
```

## Geometry and entities

Points are absolute `{ x, y }` world coordinates. Polygon `points` and every ring in `holes` have at least three points. A ring may contain at most 32,768 points, and a polygon may contain at most 4,096 holes. Rings use implicit closure: the final point is connected to the first, so callers do not repeat the first point.

Collision geometry is a circle, polygon, or rectangle. Water lakes use their polygon for both visible geometry and collision. A tree has a visual canopy `radius` and a circle collision with `center` equal to the tree’s absolute `position`; its collision radius is smaller than the canopy radius.

Terrain region kinds are `grass`, `meadow`, and `scrub`. The MVP water kind is `lake`. Entities include stable IDs, types, optional rotation/tags/assets/metadata, and the specialized fields required by their collection.

## Bounds and validation

Bounds dimensions must be positive. Points, polygon vertices, circles, and rectangles must fit inside them. Entity IDs are globally unique. Numeric values must be finite. Trees must fit inside bounds and their canopy must not overlap water. `validateMap` reports all detected violations as strings; `assertValidMap` throws for invalid input.

## Debug fields

`metadataLayers.fields` is optional. When present it includes positive integer `columns` and `rows`, plus row-major, normalized `[0, 1]` arrays named `terrain`, `elevation`, `moisture`, and `vegetation`. Each array length is `columns * rows`.

Generated maps also retain their resolved generation configuration and selected water level in `metadataLayers`. This JSON-compatible metadata is intended for debugging and round-trips with the map; it is not required for a consumer to render or use the semantic map.
