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
  /**
   * Whether the building stands or has fallen down. A ruin keeps its footprint and loses its
   * `collision`, because rubble is ground a character walks over rather than a wall around a shell.
   */
  state: 'standing' | 'ruined';
  /** The footprint. The same polygon as `collision`, as with water and roads. */
  geometry: PolygonGeometry;
  /**
   * The solid footprint, and the wall a character cannot walk through. Present on a standing
   * building and absent on a ruin, which the validator enforces: a map cannot be read as a field of
   * walkable ruins by omitting it, and a ruin cannot be walled in by carrying one.
   */
  collision?: { type: 'polygon' } & PolygonGeometry;
  asset: AssetReference;
  metadata: {
    /** The road this building was placed against, absent for one placed off the network. */
    roadId?: string;
    /** How far the front wall stands from the road's centreline, in world units. */
    setback: number;
  };
}

/**
 * A plank deck reaching from the land out over the water, and the place it serves.
 *
 * A dock is not a building. A building stands on land, is a wall, and is placed against a road; a
 * dock stands in water, is ground a character walks on, and is placed where a settlement meets a
 * shore. It carries no `collision`, and the validator refuses one that does, for the same reason a
 * forest hull carries none: a deck that blocked movement would be the opposite of what it is.
 */
export interface DockEntity extends MapEntity {
  type: 'dock';
  /** Where the deck is rooted, on the waterline where it meets the land. */
  position: Point;
  /**
   * Radians, the heading the deck runs along, out from the bank over the water. This is the same
   * handedness as a building's, so a consumer that rotates an asset by `rotation` needs no second
   * convention.
   */
  rotation: number;
  /** Full width of the deck, in world units. */
  width: number;
  /**
   * How far the deck runs out from the bank, in world units. The whole of a deck is over water, and
   * this is measured to the last point the water allows rather than set to a fixed number, so a pier
   * in a narrow inlet is a short one and a pier off a broad shore is a full-length one.
   */
  depth: number;
  /**
   * The deck surface. The same rectangle the published `width` and `depth` describe, and the shape
   * the walkability raster carves back open, so the ground a character walks is the ground drawn.
   */
  geometry: PolygonGeometry;
  asset: AssetReference;
  metadata: {
    /**
     * The road that reaches this shore, absent for one reached over open ground. The deck is rooted on
     * the waterline rather than on the road, so this names which road serves the pier rather than
     * where it begins.
     */
    roadId?: string;
    /** The place this is the waterfront of. */
    settlementId: string;
    /** The body of water the deck stands in. */
    waterId: string;
  };
}

/**
 * A place where something can be gathered, and the ground that makes it worth gathering there.
 *
 * A resource site is a marker and not a thing. It publishes no ore, no fish and no game, because
 * what a mine yields is the game's business and the generator has no geology: it knows where a rock
 * ends, where water deepens and where a wood is big enough to hunt, and that is the whole of what it
 * says. A consumer decides a site is iron, or silver, or nothing at all, and builds whatever it
 * decides there. It carries no `collision`, and the validator refuses one that does, for the same
 * reason a forest hull and a dock carry none: a site is a mark on the ground, not an obstacle.
 *
 * The three kinds are the three affordances the terrain offers, and they are not interchangeable: a
 * mine is on a rock, a fishing spot is in water, a huntable wood is in trees.
 */
export interface ResourceSiteEntity extends MapEntity {
  type: 'resource-site';
  kind: 'mine' | 'fishing' | 'hunting';
  /**
   * The site itself. A mine is just inside the rock face it is cut into, a fishing spot is in the
   * water, and a huntable wood is at the middle of its grove.
   */
  position: Point;
  /**
   * Radians, and only meaningful for a `mine`: the direction the entrance faces, which points away
   * from the rock and so out into open ground. A mine without it would be a mark on a cliff with no
   * way in, and the validator refuses one. A fishing spot and a huntable wood have no facing and
   * publish none, the same way a building has a facing and a road does not.
   */
  rotation?: number;
  asset: AssetReference;
  metadata: {
    /** The rock a mine is cut into. */
    rockId?: string;
    /** The body of water a fishing spot lies in. */
    waterId?: string;
    /** The grove a hunting site stands in. */
    forestId?: string;
    /**
     * How far a fishing spot is from the nearest shoreline of its own body, in world units. Measured,
     * not configured, so a consumer that disagrees with `access` can read the number instead.
     */
    distanceToShore?: number;
    /**
     * How a fishing spot is reached: `land` when it stands close enough to the bank to walk out to,
     * and `water` when it stands off in open water and needs a boat. Every other kind of site is
     * reached over the ground and publishes neither field.
     */
    access?: 'land' | 'water';
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
  /**
   * What the settlement is by size, read off the number of buildings it holds. A consumer that wants
   * a different name for a place of this size changes the names, not the generator.
   */
  kind: 'hamlet' | 'village' | 'town';
  /** The settlement's centre, on the road network. */
  position: Point;
  /**
   * How far the settlement reaches from its centre, in world units. This is a description of where a
   * place ends, not a wall: a settlement carries no collision, and a consumer wanting the ground it
   * covers tests this itself rather than being handed a polygon it would have to trust.
   */
  radius: number;
  /**
   * The open ground at the middle of the place: nothing is planted in it and nothing is built on it.
   * A consumer placing the settlement's own building puts it on `position`, which is inside this
   * polygon and on the road running through it.
   */
  clearing: PolygonGeometry;
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
  docks: DockEntity[];
  resourceSites: ResourceSiteEntity[];
  roads: RoadEntity[];
  barriers: MapEntity[];
  metadataLayers?: { fields?: SpatialFields; [key: string]: unknown };
}
