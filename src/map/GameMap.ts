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

/**
 * What a building is, which fixes its footprint and how far back it stands from the road.
 *
 * The set is deliberately two. A category earns its place by changing the placement or the
 * footprint, so a name that only changes the asset is not a category. `farm` stands well back from
 * the road because a farmyard is bigger than the house beside it; a category that needs to stand
 * apart from a road entirely is a placement problem of its own, not a new category.
 */
export type BuildingCategory = 'house' | 'farm';

export interface BuildingEntity extends MapEntity {
  type: 'building';
  category: BuildingCategory;
  /** The building's centre, at ground level. */
  position: Point;
  /**
   * Radians, in the same handedness as the rest of the map: the compass direction the building's
   * front looks. A building placed on a road faces back down it, so this is the heading from the
   * building to the road rather than the road's own heading.
   */
  rotation: number;
  /** Frontage along the road, in world units. */
  width: number;
  /** Depth away from the road, in world units. */
  depth: number;
  /** The footprint. The same polygon as `collision`, as with water and roads. */
  geometry: PolygonGeometry;
  collision: { type: 'polygon' } & PolygonGeometry;
  asset: AssetReference;
  metadata: {
    /** The road this building was placed against, absent for one placed off the network. */
    roadId?: string;
    /** How far the front wall stands from the road's centreline, in world units. */
    setback: number;
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

export interface SettlementEntity extends MapEntity {
  type: 'settlement';
  /** The settlement's centre, on the road network. */
  position: Point;
  /**
   * How far the settlement reaches from its centre, in world units. This is a description of where a
   * place ends, not a wall: a settlement carries no collision, and a consumer wanting the ground it
   * covers tests this itself rather than being handed a polygon it would have to trust.
   */
  radius: number;
  metadata: {
    /** The buildings inside the settlement, which may be none at all. */
    buildingIds: string[];
  };
}

export interface GameMap {
  version: '1.4';
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
  structures: BuildingEntity[];
  settlements: SettlementEntity[];
  roads: RoadEntity[];
  barriers: MapEntity[];
  metadataLayers?: { fields?: SpatialFields; [key: string]: unknown };
}
