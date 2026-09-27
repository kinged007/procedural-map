export interface Point {
  x: number;
  y: number;
}

export interface PolygonGeometry {
  points: Point[];
  holes?: Point[][];
}

export type CollisionGeometry =
  | { type: 'circle'; center: Point; radius: number }
  | ({ type: 'polygon' } & PolygonGeometry)
  | { type: 'rectangle'; x: number; y: number; width: number; height: number };

export interface AssetReference {
  category: string;
  variant: string;
}

export interface MapEntity {
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

export interface TerrainRegion extends MapEntity {
  type: 'terrain';
  kind: 'grass' | 'meadow' | 'scrub' | 'rock' | 'beach';
  geometry: PolygonGeometry;
  /** Present on impassable terrain, where the region matches the visible ground exactly. */
  collision?: { type: 'polygon' } & PolygonGeometry;
}

/**
 * Where a river's water leaves its channel and becomes standing water.
 *
 * A river is cut at a water body's shore rather than drawn over it, so this is the site where a delta,
 * an estuary or a waterfall belongs, and where a consumer widens the channel or swaps the asset for
 * the mouth. `polygon` is a marker as wide as the channel there, carrying no collision and drawn by
 * nothing: it is a footprint to place an asset on, not surface.
 */
export interface RiverMouth {
  /** The `water` entity the river flows into. */
  waterId: string;
  /** Where the centreline meets that body's edge. */
  point: Point;
  polygon: PolygonGeometry;
}

export interface WaterRegion extends MapEntity {
  type: 'water';
  /**
   * `lake` is a body of standing water contoured from the elevation field. `river` is the channel of
   * a course walked downhill across the same field, and is narrow enough for a road to meet it.
   */
  kind: 'lake' | 'river';
  geometry: PolygonGeometry;
  collision: { type: 'polygon' } & PolygonGeometry;
  /** On a river, the sites where its channel reaches standing water. */
  metadata?: { mouths?: RiverMouth[] };
}

export interface VegetationEntity extends MapEntity {
  type: 'tree';
  species: string;
  position: Point;
  radius: number;
  collision: { type: 'circle'; center: Point; radius: number };
}

/** One tree inside a `ForestEntity`. The same entity also appears in `vegetation`. */
export type ForestTree = VegetationEntity;

export interface ForestEntity extends MapEntity {
  type: 'forest';
  species: 'mixed' | 'oak' | 'birch';
  /**
   * Convex hull of the grove, for a broadphase bounds test, rendering and a minimap. It is not a
   * collision shape: a grove's clearings have to stay walkable, so `collision` is deliberately absent
   * and the trunks in `trees` are what block movement.
   */
  geometry: PolygonGeometry;
  trees: ForestTree[];
  asset: AssetReference;
  metadata: {
    treeCount: number;
    /** Share of the hull's area covered by tree canopies, as a percentage. */
    densityPct: number;
    /** Whether the walkability raster still reports open ground inside the hull. */
    walkableInside: boolean;
  };
}

/** A river a road runs into, and the span a crossing there has to cover. */
export interface RoadCrossing {
  /** Id of the `river` water region the road meets. */
  riverId: string;
  /** Nearest point of the river's surface to where the road stopped. */
  point: Point;
  /** Full width of the river channel there, in world units. */
  span: number;
}

export interface RoadEntity extends MapEntity {
  type: 'road';
  kind: 'primary' | 'secondary' | 'path';
  /** Ordered centreline, from one end of the road to the other. */
  path: Point[];
  /** Full width of the road surface, in world units. */
  width: number;
  collision: { type: 'polygon' } & PolygonGeometry;
  metadata: {
    /** Centreline length, in world units. */
    length: number;
    /**
     * Rivers this road ends against, where the bridge goes. Absent when the road meets none: a road
     * that turns along a bank and carries on has not crossed anything.
     */
    crossings?: RoadCrossing[];
  };
}

export interface SpatialFields {
  columns: number;
  rows: number;
  terrain: number[];
  elevation: number[];
  moisture: number[];
  vegetation: number[];
}

export interface GameMap {
  version: '1.2';
  metadata: {
    id: string;
    seed?: number;
    generator?: string;
    generatedAt?: string;
  };
  bounds: { width: number; height: number };
  terrain: TerrainRegion[];
  water: WaterRegion[];
  vegetation: VegetationEntity[];
  forests: ForestEntity[];
  structures: MapEntity[];
  roads: RoadEntity[];
  barriers: MapEntity[];
  metadataLayers?: { fields?: SpatialFields; [key: string]: unknown };
}
