import type { BuildingCategory } from '../map/GameMap.js';

export interface GenerationConfig {
  seed: number;
  width?: number;
  height?: number;
  /**
   * Where this tile sits in a larger world. The terrain is sampled in world space at
   * `origin + local`, so two adjacent tiles generated with the same seed share one continuous
   * landscape instead of two copies of it. Defaults to the top left of the world.
   */
  origin?: { x?: number; y?: number };
  /**
   * Size of the world this tile belongs to, measured from `(0, 0)`. Every threshold that decides
   * where water, rock, meadow and scrub begin is taken from a sample of the whole world rather than
   * of the tile, so a lake or a rock line does not stop at the tile edge. Defaults to the tile's own
   * bounds, which is the single-tile case.
   */
  world?: { width?: number; height?: number };
  terrain?: { variation?: number; scale?: number };
  water?: { amount?: number; scale?: number };
  vegetation?: { density?: number; clustering?: number };
  roads?: { density?: number };
  /**
   * The rivers traced down the drainage of the same field the water is contoured from.
   *
   * `density` scales the count, and zero publishes no rivers at all, which is a map of lakes and land
   * with no channels on it. `width` is the full width of a channel in world units, so it sets both how
   * much ground a river covers and the span a road has to bridge where it crosses one.
   */
  rivers?: { density?: number; width?: number };
  /**
   * The buildings placed along the road network.
   *
   * `density` is the chance a site offered by a road is built on, so `0` publishes no buildings at
   * all and the map is roads and open ground. `spacing` is the smallest gap between two buildings,
   * measured centre to centre across the whole map, so it decides how tightly a road is built up. The
   * `setback` is overwritten by a category that sets its own, which is how a farm ends up further
   * back from the road than a house.
   *
   * `ruin` is the share of buildings that have fallen down. A ruin keeps its footprint and stops
   * being a collider, so a character walks over the rubble. It is a share of buildings rather than a
   * flag on a settlement, so the other half of a dead settlement is reachable by mixing it with
   * `settlements.count`: at `1` every building is a ruin, and a settlement whose buildings are all
   * ruins is a dead one.
   */
  buildings?: {
    density?: number;
    spacing?: number;
    setback?: number;
    ruin?: number;
    /**
     * How often each category is drawn, as relative weights. `{ house: 8, farm: 1 }` is the
     * default, a farm-heavy world is `{ house: 2, farm: 1 }`, and a category left out keeps the
     * default rather than dropping out, so asking for houses on their own means
     * `{ house: 1, farm: 0 }`.
     *
     * The weights are the caller's because which buildings a map has is the caller's decision.
     * They are relative, so they do not have to add up to anything, and a name the generator has
     * no footprint for is rejected rather than ignored, since a weight on a building that cannot
     * exist is a setting that does nothing.
     */
    categories?: Partial<Record<BuildingCategory, number>>;
  };
  /**
   * The settlements on the map, each a centre with the buildings around it.
   *
   * `count` is how many settlements a map has. It is a count rather than something derived from the
   * road network, because a caller asking for four settlements should get four whether the network
   * happens to have four pieces or two. A settlement claims the buildings near its centre, so a count
   * well above what `buildings.density` supports leaves settlements with no buildings at all, which
   * is what a dead settlement is.
   */
  settlements?: { count?: number };
}

export interface ResolvedGenerationConfig {
  seed: number;
  width: number;
  height: number;
  origin: { x: number; y: number };
  world: { width: number; height: number };
  terrain: { variation: number; scale: number };
  water: { amount: number; scale: number };
  vegetation: { density: number; clustering: number };
  roads: { density: number };
  rivers: { density: number; width: number };
  buildings: {
    density: number;
    spacing: number;
    setback: number;
    ruin: number;
    categories: Record<BuildingCategory, number>;
  };
  settlements: { count: number };
}

export const DEFAULT_CONFIG: ResolvedGenerationConfig = {
  seed: 583921,
  width: 2048,
  height: 1536,
  origin: { x: 0, y: 0 },
  world: { width: 2048, height: 1536 },
  terrain: { variation: 0.35, scale: 0.004 },
  water: { amount: 0.2, scale: 0.003 },
  vegetation: { density: 0.65, clustering: 0.8 },
  roads: { density: 0.5 },
  rivers: { density: 1, width: 12 },
  buildings: {
    density: 0.5,
    spacing: 34,
    setback: 16,
    ruin: 0,
    categories: { house: 8, farm: 1 },
  },
  settlements: { count: 2 },
};
