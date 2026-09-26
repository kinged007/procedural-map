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

export interface WaterRegion extends MapEntity {
  type: 'water';
  kind: 'lake';
  geometry: PolygonGeometry;
  collision: { type: 'polygon' } & PolygonGeometry;
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

export interface RoadEntity extends MapEntity {
  type: 'road';
  kind: 'primary' | 'secondary' | 'path';
  /** Ordered centreline, from one end of the road to the other. */
  path: Point[];
  /** Full width of the road surface, in world units. */
  width: number;
  collision: { type: 'polygon' } & PolygonGeometry;
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
  version: '1.1';
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
