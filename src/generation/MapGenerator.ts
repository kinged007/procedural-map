import type {
  ForestEntity,
  GameMap,
  PolygonGeometry,
  RoadEntity,
  SpatialFields,
  TerrainRegion,
  VegetationEntity,
  WaterRegion,
} from '../map/GameMap.js';
import { boundsOf, circleIntersectsPolygon, polygonArea } from '../map/geometry.js';
import { rasterizeWalkability } from '../navigation/walkability.js';
import { assertValidMap } from '../validation/MapValidator.js';
import { generateBuildings } from './buildings.js';
import { gridToEdgePolygons } from './contours.js';
import { generateForests, markWalkableInside } from './forests.js';
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
    x: resolveNumber(config.origin?.x, 0, 'origin.x', -MAX_DIMENSION, MAX_DIMENSION),
    y: resolveNumber(config.origin?.y, 0, 'origin.y', -MAX_DIMENSION, MAX_DIMENSION),
  };
  // The world defaults to the tile, which is the whole of what a single-tile map needs. A caller who
  // passes one is claiming the tile is a window onto it, and the window has to fit.
  const world = {
    width: resolveNumber(config.world?.width, width, 'world.width', MIN_DIMENSION, MAX_DIMENSION),
    height: resolveNumber(
      config.world?.height,
      height,
      'world.height',
      MIN_DIMENSION,
      MAX_DIMENSION,
    ),
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
  /** Terrain that cannot be walked on, and so cannot hold a tree. */
  impassable: TerrainRegion[],
  /** Road surfaces, whose verges are kept clear of trees. */
  roads: RoadEntity[],
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
    // Trees cannot root in impassable ground. Rock is the only such terrain today, and terrain is
    // generated before vegetation, so the same test that keeps trees out of lakes keeps them off
    // rock.
    if (impassable.some((region) => circleIntersectsPolygon(position, radius + 1, region.geometry)))
      continue;
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
  const impassable = terrain.filter((region) => region.collision !== undefined);
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
  const vegetation = generateTrees(resolved, fields, water, random, impassable, roads);
  // Buildings come last, because a road is the only thing that offers them a site, and the roads, the
  // ground they must not stand on, and the trees they must not stand under all exist by now.
  const buildingRandom = new Random(placement ^ 0x6b8f21);
  const structures = generateBuildings(resolved, roads, water, terrain, vegetation, () =>
    buildingRandom.next(),
  );
  const forests: ForestEntity[] = generateForests(vegetation);
  // A tile at an origin needs to be distinguishable from the same tile at the origin, or assembling
  // a world puts duplicate entity ids in it. The single-tile id is left as it was.
  const placementTag =
    resolved.origin.x === 0 && resolved.origin.y === 0
      ? ''
      : `@${resolved.origin.x},${resolved.origin.y}`;
  const map: GameMap = {
    version: '1.3',
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
    roads,
    barriers: [],
    metadataLayers: { fields, generation: resolved, waterLevel: level },
  };
  // Forests do not block, so this grid is the same one a consumer would bake and does not depend on
  // them. Measuring the clearings against it is what stops the field being a guess.
  markWalkableInside(forests, rasterizeWalkability(map, { cellSize: FOREST_CLEARANCE_CELL }));
  assertValidMap(map);
  return map;
}
