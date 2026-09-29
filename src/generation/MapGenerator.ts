import type {
  BuildingCategory,
  ForestEntity,
  GameMap,
  PolygonGeometry,
  RoadEntity,
  SpatialFields,
  VegetationEntity,
  WaterRegion,
} from '../map/GameMap.js';
import { boundsOf, circleIntersectsPolygon, polygonArea } from '../map/geometry.js';
import { rasterizeWalkability } from '../navigation/walkability.js';
import { assertValidMap } from '../validation/MapValidator.js';
import { generateBuildings, CATEGORIES } from './buildings.js';
import { gridToEdgePolygons } from './contours.js';
import { generateDocks } from './docks.js';
import { generateResourceSites } from './resources.js';
import { generateForests, markWalkableInside } from './forests.js';
import { generatePlots, plotSites } from './plots.js';
import { generateSettlements, settlementSites, type SettlementSite } from './settlements.js';
import { generateRoads } from './roads/RoadGenerator.js';
import { generateRivers } from './rivers.js';
import { generateTerrain } from './terrain/TerrainGenerator.js';
import { sampleField } from './sampleField.js';
import {
  DEFAULT_CONFIG,
  type GenerationConfig,
  type ResolvedGenerationConfig,
} from './GenerationConfig.js';

/**
 * Space kept between a tree canopy and the edge of a road, in world units. A road needs open ground
 * beside it, so a trunk is not placed where its canopy would hang over the verge.
 */
const ROAD_CLEARANCE = 3;

const MIN_DIMENSION = 128;
const MAX_DIMENSION = 4096;
// A world is a window that a tile sits inside, so it is only bounded by needing a finite integer
// coordinate, not by how much terrain one map can carry. The field grid samples it at up to 64
// points across, so this is a sanity limit rather than a quality one.
const MAX_WORLD = 1_000_000;
const MAX_TREES = 8000;

/**
 * Resolution the generator measures `walkableInside` at. A consumer bakes walkability at whatever
 * tile size it plays at, and the boolean it reads was measured here, so the number is published
 * alongside it rather than left to look universal.
 */
const FOREST_CLEARANCE_CELL = 8;

function mixSeed(seed: number): number {
  let mixed = 2166136261;
  for (const character of String(seed)) {
    mixed ^= character.charCodeAt(0);
    mixed = Math.imul(mixed, 16777619);
  }
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

class Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
}

function hash(x: number, y: number, seed: number): number {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ (seed | 0);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function fade(value: number): number {
  return value * value * (3 - 2 * value);
}

function coherentNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const top = hash(x0, y0, seed) * (1 - tx) + hash(x0 + 1, y0, seed) * tx;
  const bottom = hash(x0, y0 + 1, seed) * (1 - tx) + hash(x0 + 1, y0 + 1, seed) * tx;
  return top * (1 - ty) + bottom * ty;
}

function fractalNoise(x: number, y: number, seed: number): number {
  let total = 0;
  let amplitude = 0.55;
  let frequency = 1;
  let amplitudeTotal = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    total += coherentNoise(x * frequency, y * frequency, seed + octave * 1013) * amplitude;
    amplitudeTotal += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / amplitudeTotal;
}

function resolveNumber(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return result;
}

/**
 * A count, which is a whole number or nothing.
 *
 * `resolveNumber` bounds-checks, and every quantity that is a rate or a scale is legitimately
 * fractional, so it cannot do this itself. A count is different: `2.5` is not a number of
 * settlements, and the loops that read it test `length >= count`, so a float is silently rounded up
 * and the caller is handed a different number than the one they asked for, with nothing said. That
 * was already true of `settlements.count` and `docks.count`; it is checked here for every count
 * rather than only for the new ones, because a count that is sometimes validated and sometimes not
 * is worse than either.
 */
function resolveCount(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const result = resolveNumber(value, fallback, name, 0, maximum);
  if (!Number.isInteger(result))
    throw new RangeError(`${name} must be a whole number, not ${result}`);
  return result;
}

/**
 * The caller's category weights, filled in from the defaults and checked.
 *
 * A name with no footprint is rejected rather than dropped. A weight the generator cannot honour is
 * a setting that appears to do something and does not, and a caller who has misspelled `house` is
 * better served by a throw than by a map of farms. A category left out of the table keeps the default
 * weight, so asking to reweight one does not silently drop the other.
 */
function resolveCategories(
  weights: Partial<Record<BuildingCategory, number>> | undefined,
): Record<BuildingCategory, number> {
  const resolved = { ...DEFAULT_CONFIG.buildings.categories };
  for (const [name, weight] of Object.entries(weights ?? {})) {
    if (!(name in CATEGORIES))
      throw new RangeError(
        `buildings.categories.${name} is not a building the generator can place: ${Object.keys(CATEGORIES).join(', ')}`,
      );
    resolved[name as BuildingCategory] = resolveNumber(
      weight,
      0,
      `buildings.categories.${name}`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (Object.values(resolved).every((weight) => weight <= 0))
    throw new RangeError(
      'buildings.categories must give at least one category a weight above zero',
    );
  return resolved;
}

export function resolveGenerationConfig(config: GenerationConfig): ResolvedGenerationConfig {
  if (!Number.isSafeInteger(config.seed)) throw new TypeError('seed must be a safe integer');
  const width = resolveNumber(
    config.width,
    DEFAULT_CONFIG.width,
    'width',
    MIN_DIMENSION,
    MAX_DIMENSION,
  );
  const height = resolveNumber(
    config.height,
    DEFAULT_CONFIG.height,
    'height',
    MIN_DIMENSION,
    MAX_DIMENSION,
  );
  if (!Number.isInteger(width) || !Number.isInteger(height))
    throw new TypeError('width and height must be integers');
  const origin = {
    x: resolveNumber(config.origin?.x, 0, 'origin.x', -MAX_WORLD, MAX_WORLD),
    y: resolveNumber(config.origin?.y, 0, 'origin.y', -MAX_WORLD, MAX_WORLD),
  };
  // The world defaults to the tile, which is the whole of what a single-tile map needs. A caller who
  // passes one is claiming the tile is a window onto it, and the window has to fit. The world is a
  // coordinate frame, not a map that gets generated in one piece, so it is not held to the tile's
  // own ceiling: a world the size of one maximum tile would fit exactly one tile and make the
  // feature pointless. Its real limit is the field grid, which samples at most 64 points across
  // whatever the extent is, so a very large world keeps working and simply grows blockier.
  const world = {
    width: resolveNumber(config.world?.width, width, 'world.width', MIN_DIMENSION, MAX_WORLD),
    height: resolveNumber(config.world?.height, height, 'world.height', MIN_DIMENSION, MAX_WORLD),
  };
  if (
    origin.x < 0 ||
    origin.y < 0 ||
    origin.x + width > world.width ||
    origin.y + height > world.height
  )
    throw new RangeError(
      `a ${width} by ${height} tile at origin ${origin.x},${origin.y} does not fit inside a ${world.width} by ${world.height} world`,
    );
  return {
    seed: config.seed,
    width,
    height,
    origin,
    world,
    terrain: {
      variation: resolveNumber(
        config.terrain?.variation,
        DEFAULT_CONFIG.terrain.variation,
        'terrain.variation',
        0,
        1,
      ),
      scale: resolveNumber(
        config.terrain?.scale,
        DEFAULT_CONFIG.terrain.scale,
        'terrain.scale',
        0.0001,
        0.05,
      ),
    },
    water: {
      amount: resolveNumber(
        config.water?.amount,
        DEFAULT_CONFIG.water.amount,
        'water.amount',
        0,
        1,
      ),
      scale: resolveNumber(
        config.water?.scale,
        DEFAULT_CONFIG.water.scale,
        'water.scale',
        0.0001,
        0.05,
      ),
    },
    vegetation: {
      density: resolveNumber(
        config.vegetation?.density,
        DEFAULT_CONFIG.vegetation.density,
        'vegetation.density',
        0,
        1,
      ),
      clustering: resolveNumber(
        config.vegetation?.clustering,
        DEFAULT_CONFIG.vegetation.clustering,
        'vegetation.clustering',
        0,
        1,
      ),
    },
    roads: {
      density: resolveNumber(
        config.roads?.density,
        DEFAULT_CONFIG.roads.density,
        'roads.density',
        0,
        1,
      ),
    },
    rivers: {
      density: resolveNumber(
        config.rivers?.density,
        DEFAULT_CONFIG.rivers.density,
        'rivers.density',
        0,
        1,
      ),
      // A channel has to stay narrower than a road is wide, or a road cannot span it and the water
      // stops being crossable at all. The ceiling is the widest road doubled.
      width: resolveNumber(
        config.rivers?.width,
        DEFAULT_CONFIG.rivers.width,
        'rivers.width',
        1,
        44,
      ),
    },
    buildings: {
      density: resolveNumber(
        config.buildings?.density,
        DEFAULT_CONFIG.buildings.density,
        'buildings.density',
        0,
        1,
      ),
      // A building's own depth is 11 to 20 units, so a spacing under that would refuse almost every
      // site and the map would come out empty rather than tight. The floor is the widest building.
      spacing: resolveNumber(
        config.buildings?.spacing,
        DEFAULT_CONFIG.buildings.spacing,
        'buildings.spacing',
        20,
        200,
      ),
      // A building's front wall has to clear the road surface it stands against, or the clearance
      // test refuses every site and the map comes out empty. The floor is half the width of the
      // widest road. A setback much above that is legal but does not add buildings: pulling both
      // rows in also pulls them into each other, and past the spacing they cancel out again.
      setback: resolveNumber(
        config.buildings?.setback,
        DEFAULT_CONFIG.buildings.setback,
        'buildings.setback',
        6,
        120,
      ),
      // A share, so `0` is a map of standing buildings and `1` is a map of ruins.
      ruin: resolveNumber(
        config.buildings?.ruin,
        DEFAULT_CONFIG.buildings.ruin,
        'buildings.ruin',
        0,
        1,
      ),
      categories: resolveCategories(config.buildings?.categories),
    },
    settlements: {
      // A count, not a density: a caller asking for four settlements wants four, and a map with no
      // roads has nowhere to put even one, so the ceiling is generous and the road network is what
      // actually limits it.
      count: resolveCount(
        config.settlements?.count,
        DEFAULT_CONFIG.settlements.count,
        'settlements.count',
        64,
      ),
    },
    docks: {
      // A count, and an upper bound rather than a promise for the same reason the settlement count is
      // one: a dock is a settlement's waterfront, so the settlements and the shorelines are what
      // actually limit it, and a map with no settlements has no harbours at any count.
      count: resolveCount(config.docks?.count, DEFAULT_CONFIG.docks.count, 'docks.count', 64),
    },
    resources: {
      // Three upper bounds rather than one, because the ground offers the three unevenly: a face to
      // mine is plentiful and a wood to hunt is scarce, so a shared count would be tuned against the
      // scarcest of them and would quietly cap the other two.
      mine: resolveCount(
        config.resources?.mine,
        DEFAULT_CONFIG.resources.mine,
        'resources.mine',
        64,
      ),
      fishing: resolveCount(
        config.resources?.fishing,
        DEFAULT_CONFIG.resources.fishing,
        'resources.fishing',
        64,
      ),
      hunting: resolveCount(
        config.resources?.hunting,
        DEFAULT_CONFIG.resources.hunting,
        'resources.hunting',
        64,
      ),
    },
    plots: {
      field: resolveCount(config.plots?.field, DEFAULT_CONFIG.plots.field, 'plots.field', 64),
      orchard: resolveCount(
        config.plots?.orchard,
        DEFAULT_CONFIG.plots.orchard,
        'plots.orchard',
        64,
      ),
    },
  };
}

function gridSize(extent: number) {
  return Math.max(20, Math.min(64, Math.round(extent / 28)));
}

/**
 * Samples the four fields over a rectangle of world space.
 *
 * `left` and `top` are the rectangle's position in the world, not its local origin. That is the whole
 * of the seam fix: a tile at `origin` reads the same noise the neighbouring tile reads at the same
 * world coordinate, so the two share one landscape. Sampling in local space instead would give every
 * tile its own private copy of the terrain, and adjacent tiles would be two worlds that happen to
 * abut.
 *
 * `ponytail:` the grid is capped at 64 samples across, whatever the extent. A world of 64,000 units
 * gets 1,000-unit samples and visibly blocky terrain. Raise the cap when a world that large is
 * actually generated; the cost is linear in samples, so the cap is the only thing standing between a
 * big world and a slow one.
 */
function fieldGrid(
  config: ResolvedGenerationConfig,
  left: number,
  top: number,
  extentWidth: number,
  extentHeight: number,
): SpatialFields {
  const columns = gridSize(extentWidth);
  const rows = gridSize(extentHeight);
  const terrain: number[] = [];
  const elevation: number[] = [];
  const moisture: number[] = [];
  const vegetation: number[] = [];
  const seed = mixSeed(config.seed);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = left + (column * extentWidth) / (columns - 1);
      const y = top + (row * extentHeight) / (rows - 1);
      const terrainRaw = fractalNoise(
        x * config.terrain.scale,
        y * config.terrain.scale,
        seed + 11,
      );
      terrain.push(
        Math.max(0, Math.min(1, 0.5 + (terrainRaw - 0.5) * config.terrain.variation * 2)),
      );
      elevation.push(fractalNoise(x * config.water.scale, y * config.water.scale, seed + 23));
      moisture.push(
        fractalNoise(x * config.water.scale * 0.7, y * config.water.scale * 0.7, seed + 37),
      );
      vegetation.push(
        fractalNoise(x * config.terrain.scale * 0.85, y * config.terrain.scale * 0.85, seed + 53),
      );
    }
  }
  return { columns, rows, terrain, elevation, moisture, vegetation };
}

function generateFields(config: ResolvedGenerationConfig): SpatialFields {
  return fieldGrid(config, config.origin.x, config.origin.y, config.width, config.height);
}

/**
 * The field grid every threshold is measured against.
 *
 * A threshold taken from the tile's own grid is a threshold that moves with the window: a lake filled
 * to the tile's 20th percentile sits at a different height in every tile, so the waterline steps at
 * every seam. Measuring against the world instead puts every tile's waterline at the same height,
 * because they are all reading the same number.
 *
 * When the world is exactly the tile this returns the tile's own grid, unchanged, so a config with no
 * `origin` and no `world` generates the map it always did.
 */
function referenceFields(config: ResolvedGenerationConfig, fields: SpatialFields): SpatialFields {
  if (
    config.origin.x === 0 &&
    config.origin.y === 0 &&
    config.world.width === config.width &&
    config.world.height === config.height
  )
    return fields;
  return fieldGrid(config, 0, 0, config.world.width, config.world.height);
}

function waterLevel(fields: SpatialFields, amount: number): number | null {
  if (amount === 0) return null;
  if (amount === 1) return 1;
  const interior: number[] = [];
  for (let row = 1; row < fields.rows - 1; row += 1) {
    for (let column = 1; column < fields.columns - 1; column += 1)
      interior.push(fields.elevation[row * fields.columns + column]);
  }
  interior.sort((a, b) => a - b);
  const index = Math.min(interior.length - 1, Math.max(0, Math.ceil(amount * interior.length) - 1));
  return interior[index];
}

function ringsToWater(polygons: PolygonGeometry[]): WaterRegion[] {
  return polygons
    .filter((geometry) => polygonArea(geometry) > 0)
    .map((geometry, index) => ({
      id: `lake-${index + 1}`,
      type: 'water',
      kind: 'lake',
      geometry,
      collision: { type: 'polygon', ...geometry },
      asset: { category: 'water.lake', variant: `lake-${(index % 3) + 1}` },
    }));
}

function generateWater(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  level: number | null,
): WaterRegion[] {
  if (level === null) return [];
  if (config.water.amount === 1) {
    const points = [
      { x: 0, y: 0 },
      { x: config.width, y: 0 },
      { x: config.width, y: config.height },
      { x: 0, y: config.height },
    ];
    return [
      {
        id: 'lake-1',
        type: 'water',
        kind: 'lake',
        geometry: { points },
        collision: { type: 'polygon', points },
        asset: { category: 'water.lake', variant: 'lake-1' },
      },
    ];
  }
  return ringsToWater(
    gridToEdgePolygons(
      fields.columns,
      fields.rows,
      fields.elevation,
      level,
      config.width,
      config.height,
    ),
  );
}

/**
 * Birch tolerates wetter ground, so its share of a woodland rises with local moisture. The bias is
 * applied as an odds multiplier around the base ratio rather than by resampling, so it cannot
 * silently drop below the base share in dry country.
 */
const BASE_BIRCH_SHARE = 0.28;
const SPECIES_MOISTURE_BIAS = 1.4;

function generateTrees(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  water: WaterRegion[],
  random: Random,
  /**
   * Ground a tree does not root in: rock, which cannot be walked on, and the beach band, which can
   * be walked on and is still sand.
   */
  keepOut: PolygonGeometry[],
  /** Road surfaces, whose verges are kept clear of trees. */
  roads: RoadEntity[],
  /** Settlement clearings, which are kept clear of trees. */
  clearings: SettlementSite[],
): VegetationEntity[] {
  if (config.vegetation.density === 0 || config.water.amount === 1) return [];
  const target = Math.min(
    MAX_TREES,
    Math.max(1, Math.round((config.width * config.height * config.vegetation.density) / 1250)),
  );
  const trees: VegetationEntity[] = [];
  const corridors = roads.map((road) => ({
    road,
    bounds: boundsOf(road.collision.points),
  }));
  const spatial = new Map<string, VegetationEntity[]>();
  const cellSize = 18;
  // High clustering rejects most of the map, so the attempt budget has to grow with selectivity or
  // the loop runs dry before reaching the density target and the map silently thins out.
  const maxAttempts = Math.max(300, target * (10 + config.vegetation.clustering * 40));
  const cellKey = (x: number, y: number) =>
    `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  for (let attempt = 0; attempt < maxAttempts && trees.length < target; attempt += 1) {
    const position = { x: random.next() * config.width, y: random.next() * config.height };
    const fieldValue = sampleField(
      fields,
      fields.vegetation,
      position.x,
      position.y,
      config.width,
      config.height,
    );
    const moisture = sampleField(
      fields,
      fields.moisture,
      position.x,
      position.y,
      config.width,
      config.height,
    );
    // clustering is a single knob with two coupled effects. It raises the ground a tree needs to
    // survive (a higher bar in weak ground) and sharpens the response (strong groves are favoured
    // harder). Together these turn a full, even scatter into tight groves with real clearings
    // between them, while leaving the total tree count set by density.
    const bar = 0.34 + config.vegetation.clustering * 0.34;
    const sharpness = 2.2 + config.vegetation.clustering * 5.8;
    const groveStrength = Math.max(0, Math.min(1, (fieldValue - bar) * sharpness * 0.9 + 0.5));
    const acceptance = config.vegetation.density * (0.015 + groveStrength * 0.985);
    if (random.next() > acceptance) continue;
    const radius = 10 + random.next() * 8;
    if (
      position.x < radius ||
      position.y < radius ||
      position.x > config.width - radius ||
      position.y > config.height - radius
    )
      continue;
    if (water.some((lake) => circleIntersectsPolygon(position, radius + 1, lake.geometry)))
      continue;
    // A tree does not root in rock, which cannot be walked on, or in the beach band, which can be
    // walked on and is still sand. The band is the lake's own ring offset outward with the lake as a
    // hole, so it lies entirely on the landward side of the water and the lake test above cannot see
    // it: a tree standing on the sand is standing on open ground that happens to be drawn yellow.
    if (keepOut.some((region) => circleIntersectsPolygon(position, radius + 1, region))) continue;
    // A road is cut through the wood, so the trees it would pass through are not placed at all. The
    // corridor includes the clearance, so the canopy stays off the verge instead of overhanging it.
    const reach = radius + ROAD_CLEARANCE;
    if (
      corridors.some(
        ({ road, bounds }) =>
          position.x + reach >= bounds.minX &&
          position.x - reach <= bounds.maxX &&
          position.y + reach >= bounds.minY &&
          position.y - reach <= bounds.maxY &&
          circleIntersectsPolygon(position, reach, road.collision),
      )
    )
      continue;
    // A settlement clearing is the open ground at the middle of a place, so nothing roots in it. A
    // road already keeps trees 7 units off its centreline, which is narrower than a clearing, so this
    // is a second keep-out rather than a wider version of the first.
    if (
      clearings.some(
        ({ position: centre, radius: clearingRadius }) =>
          Math.hypot(centre.x - position.x, centre.y - position.y) <= radius + clearingRadius,
      )
    )
      continue;
    const gridX = Math.floor(position.x / cellSize);
    const gridY = Math.floor(position.y / cellSize);
    let crowded = false;
    for (let y = gridY - 1; y <= gridY + 1 && !crowded; y += 1) {
      for (let x = gridX - 1; x <= gridX + 1 && !crowded; x += 1) {
        crowded = (spatial.get(`${x},${y}`) ?? []).some(
          (tree) => Math.hypot(tree.position.x - position.x, tree.position.y - position.y) < 9,
        );
      }
    }
    if (crowded) continue;
    // Birch gains ground on wet ground, oak holds dry ground, from the same base ratio.
    const moistureOffset = (moisture - 0.5) * 2;
    const birchOdds =
      (BASE_BIRCH_SHARE / (1 - BASE_BIRCH_SHARE)) *
      (moistureOffset >= 0
        ? 1 + moistureOffset * SPECIES_MOISTURE_BIAS
        : 1 / (1 - moistureOffset * SPECIES_MOISTURE_BIAS));
    const species = random.next() < birchOdds / (1 + birchOdds) ? 'birch' : 'oak';
    const tree: VegetationEntity = {
      id: `tree-${trees.length + 1}`,
      type: 'tree',
      species,
      position,
      radius,
      rotation: random.next() * Math.PI * 2,
      collision: { type: 'circle', center: { ...position }, radius: 3.5 + random.next() * 2 },
      asset: { category: 'vegetation.tree', variant: `${species}-${(trees.length % 3) + 1}` },
    };
    trees.push(tree);
    const key = cellKey(position.x, position.y);
    spatial.set(key, [...(spatial.get(key) ?? []), tree]);
  }
  return trees;
}

export function generateMap(config: GenerationConfig): GameMap {
  const resolved = resolveGenerationConfig(config);
  const fields = generateFields(resolved);
  const reference = referenceFields(resolved, fields);
  const level = waterLevel(reference, resolved.water.amount);
  const lakes = generateWater(resolved, fields, level);
  const terrain = generateTerrain(resolved, fields, lakes, reference);
  // Ground a tree does not root in. Rock is here because it cannot be walked on, and the beach band
  // because it can be walked on and is still sand: a tree on a beach is a tree on open ground that
  // happens to be drawn yellow. Both are one list because the test is the same for both, and a
  // beach is the lake's own ring offset outward, so it lies on the landward side where the water
  // test never looks.
  const noTrees = terrain
    .filter((region) => region.collision !== undefined || region.kind === 'beach')
    .map((region) => region.geometry);
  // Rivers are traced after the terrain is classified, so a river cuts a channel through ground that
  // is already drawn rather than being given a beach band of its own. Both are published as water.
  // The lakes go in with them so a course can be cut where it reaches standing water.
  const water = [...lakes, ...generateRivers(resolved, fields, level, lakes)];
  // Placement draws from a stream keyed on the tile's position in the world, not just the seed. One
  // seed for the whole world would give every tile the identical draw sequence, and a tiled world
  // would show the same grove in the same corner of every tile.
  const placement =
    mixSeed(resolved.seed) ^
    (Math.round(resolved.origin.x) * 0x9e3779b1) ^
    (Math.round(resolved.origin.y) * 0x85ebca6b);
  const random = new Random(placement ^ 0x51f15e);
  const roadRandom = new Random(placement ^ 0x2f1c93);
  const roads = generateRoads(resolved, fields, water, terrain, () => roadRandom.next());
  // Where the settlements are is decided now, before anything is planted or built, so that a
  // settlement's clearing reaches the tree and building placers as ground to keep clear rather than
  // as a hole punched out of a finished map. Publishing the settlements still waits for the
  // buildings, because a settlement is defined by the buildings it holds.
  const settlementRandom = new Random(placement ^ 0x2c9d47);
  const sites = settlementSites(
    roads,
    resolved.settlements.count,
    resolved.width,
    resolved.height,
    () => settlementRandom.next(),
  );
  // Worked ground is chosen now, for the same reason the clearings were: a field is ground that stays
  // open, so it has to reach the tree and building placers as a keep-out rather than as a hole punched
  // into a finished map. An orchard's rows are made here too, because a tree is a tree — it goes into
  // `vegetation`, it blocks walking, and the grove builder groups it like any other.
  const plotRandom = new Random(placement ^ 0x6b1d3f);
  const plots = plotSites(
    sites,
    water,
    noTrees,
    roads.map((road) => ({ points: road.collision.points })),
    resolved.plots,
    resolved.width,
    resolved.height,
    () => plotRandom.next(),
  );
  // Only a field is kept clear: an orchard's rectangle is already full of the trees it asked for, and
  // refusing more inside it would leave bare gaps down every row.
  const vegetation = [
    ...generateTrees(
      resolved,
      fields,
      water,
      random,
      [...noTrees, ...plots.filter((plot) => plot.kind === 'field').map((plot) => plot.geometry)],
      roads,
      sites,
    ),
    ...plots.flatMap((plot) => plot.trees),
  ];
  // Buildings come last, because a road is the only thing that offers them a site, and the roads, the
  // ground they must not stand on, and the trees they must not stand under all exist by now.
  const buildingRandom = new Random(placement ^ 0x6b8f21);
  // Whether a building has fallen down is drawn from a stream of its own, so `buildings.ruin` moves
  // no building's placement and no other building's facing. Setting it to 1 asks what the map would
  // look like abandoned, not for a different map.
  const ruinRandom = new Random(placement ^ 0x8c4d6a);
  // The category draw gets a stream of its own for the same reason: a farm covers more ground than a
  // house, so reweighting the mix legitimately refuses neighbours and changes the count, but it
  // should not shuffle which sites were offered.
  const categoryRandom = new Random(placement ^ 0x3f9a52);
  const structures = generateBuildings(
    resolved,
    roads,
    water,
    terrain,
    vegetation,
    // The clearings only. A field is worked ground, so a house is not built in the middle of it, but
    // that is decided where the category is known rather than folded in here as one more keep-out: a
    // farm is put in a field, and a farm could not be if the field it works were on this list.
    sites.map((site) => site.clearing),
    plots,
    () => buildingRandom.next(),
    () => ruinRandom.next(),
    () => categoryRandom.next(),
  );
  const forests: ForestEntity[] = generateForests(vegetation);
  const settlements = generateSettlements(sites, structures);
  // The plots are published once the places they name exist, like a dock. A plot is a holding of a
  // settlement, and a settlement is only published once its buildings are.
  const groundPlots = generatePlots(plots, settlements);
  // Docks come last of all, because a deck is a settlement's waterfront: it needs the places to
  // exist before it can name the one it serves, and the buildings to exist before it can refuse to
  // run a deck through a wall.
  const dockRandom = new Random(placement ^ 0x4d1c05);
  const docks = generateDocks(
    roads,
    water,
    settlements,
    structures,
    resolved.docks.count,
    resolved.width,
    resolved.height,
    () => dockRandom.next(),
  );
  // A tile at an origin needs to be distinguishable from the same tile at the origin, or assembling
  // a world puts duplicate entity ids in it. The single-tile id is left as it was.
  const placementTag =
    resolved.origin.x === 0 && resolved.origin.y === 0
      ? ''
      : `@${resolved.origin.x},${resolved.origin.y}`;
  const map: GameMap = {
    version: '1.4',
    metadata: {
      id: `generated-${resolved.seed}-${resolved.width}x${resolved.height}${placementTag}`,
      seed: resolved.seed,
      generator: 'procedural-map-mvp',
    },
    bounds: { width: resolved.width, height: resolved.height },
    terrain: [
      {
        id: 'terrain-grass',
        type: 'terrain',
        kind: 'grass',
        geometry: {
          points: [
            { x: 0, y: 0 },
            { x: resolved.width, y: 0 },
            { x: resolved.width, y: resolved.height },
            { x: 0, y: resolved.height },
          ],
        },
        asset: { category: 'terrain.grass', variant: 'temperate-1' },
      },
      ...terrain,
    ],
    water,
    vegetation,
    forests,
    structures,
    settlements,
    docks,
    // Filled in below, once the map exists. A site is a question about the finished ground, so it is
    // asked of the finished map rather than of the collections as they are assembled.
    resourceSites: [],
    plots: groundPlots,
    roads,
    barriers: [],
    metadataLayers: { fields, generation: resolved, waterLevel: level },
  };
  // Forests do not block, so this grid is the same one a consumer would bake and does not depend on
  // them. Measuring the clearings against it is what stops the field being a guess.
  markWalkableInside(forests, rasterizeWalkability(map, { cellSize: FOREST_CLEARANCE_CELL }));
  // Resource sites come after that, and they depend on it: a huntable wood is one whose hull reports
  // open ground inside, which is exactly the field measured on the line above. Asking before it was
  // measured would see every grove as unenterable and publish no hunting at all.
  //
  // Two streams, so that asking for more mines does not reshuffle which fishing spots a caller also
  // asked for. Neither draws from `placement`, so none of this moves anything else on the map.
  const mineRandom = new Random(placement ^ 0x2f6d11);
  const fishRandom = new Random(placement ^ 0x71c4a9);
  map.resourceSites = generateResourceSites(map, resolved.resources, {
    mine: () => mineRandom.next(),
    fishing: () => fishRandom.next(),
  });
  assertValidMap(map);
  return map;
}
