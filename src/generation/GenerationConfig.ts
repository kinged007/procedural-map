import type { BuildingCategory, EnemyGround } from '../map/GameMap.js';

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
  /**
   * The plank decks reaching from the land out over the water.
   *
   * `count` is how many docks a map has, and it is an upper bound rather than a promise: a dock is
   * the waterfront of a settlement, so a map with no settlements publishes none however many are
   * asked for, and a place that stands nowhere near water has no waterfront. It is not bounded by the
   * number of places, because one place on a long shore can have several decks.
   *
   * `0` is the default, which is a map of no harbours: a pier is a strong statement about a place,
   * and the generator has no opinion on whether any of them is a port.
   */
  docks?: { count?: number };
  /**
   * The places worth gathering something at: mines on rock faces, fishing spots in water, and
   * huntable woods.
   *
   * Each is an upper bound, and they are separate because the ground offers them unevenly. A default
   * map has 4.7 rock regions with about 4,000 units of face between them, but only 4.5 bodies of
   * water big enough to fish and sixteen woods big enough to hunt, so a single shared count would
   * have to be tuned against whichever of the three is scarcest.
   *
   * `0` across the board is the default, and the generator's default says something deliberate: it
   * has no geology. The map says where a rock ends and where water deepens, not that one is iron and
   * the next is flint, so a map that placed its own mines would be a generator with a fantasy bolted
   * to it. Ask for sites, get ground worth building on, and decide what a site is worth yourself.
   */
  resources?: { mine?: number; fishing?: number; hunting?: number };
  /**
   * Worked ground around a settlement: bare fields, and orchards of planted rows.
   *
   * Two counts rather than one because the two are not interchangeable and a caller asking for eight
   * plots may want all eight bare or half of each. A field is ground kept open, and an orchard is
   * ground filled on purpose, so a single count would have to be tuned against whichever the caller
   * happened to want more of.
   *
   * `0` across the board is the default. A field is a square of dirt until a game decides what grows
   * in it, and a default map that ploughed one would be claiming a crop it knows nothing about.
   */
  plots?: { field?: number; orchard?: number };
  /**
   * Enemy camps: sites the map says nothing lives in.
   *
   * `count` of 0 is the default, because a map says where rock ends and where a river runs, not that
   * anyone is in either. As with every other count, a caller may ask for more than the ground
   * supports and take what the map has, so a rock-only caller on a flat map is short rather than
   * refused.
   *
   * `minDistance` is how far a camp is held from the nearest player settlement's centre, in world
   * units. The default of 800 is three settlement radii and leaves about a quarter of the land to
   * choose from, measured over five default maps; 600 is barely distinguishable from the approach to
   * a village, and 1000 leaves too little for a map that has settlements of its own.
   *
   * It is also the setting most likely to be the reason a count comes up short, and on a map whose
   * settlements happen to cluster it is the only one that is. Seed 7 with four settlements leaves 5%
   * of its land 800 units from all of them, and asks for 14 camps there and gets 8; the same map
   * publishes all 14 at a `minDistance` of 300. Camps sit in the complement of the settlements by
   * construction, so a map with towns in one corner puts them in the other.
   *
   * `grounds` is how often each ground is drawn, as relative weights, and not a finished share. A
   * camp needs ground the map actually offers, so `{ rock: 1 }` on a map with no cliff publishes
   * none rather than putting a cave camp on a meadow. Weights tune in one place without moving the
   * other two, the same way `buildings.categories` does.
   */
  enemies?: {
    count?: number;
    minDistance?: number;
    grounds?: Partial<Record<EnemyGround, number>>;
  };
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
  docks: { count: number };
  resources: { mine: number; fishing: number; hunting: number };
  plots: { field: number; orchard: number };
  enemies: {
    count: number;
    minDistance: number;
    grounds: Record<EnemyGround, number>;
  };
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
  docks: { count: 0 },
  resources: { mine: 0, fishing: 0, hunting: 0 },
  plots: { field: 0, orchard: 0 },
  enemies: { count: 0, minDistance: 800, grounds: { wood: 1, rock: 1, open: 1 } },
};
