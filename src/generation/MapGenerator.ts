import type {
  GameMap,
  PolygonGeometry,
  SpatialFields,
  TerrainRegion,
  VegetationEntity,
  WaterRegion,
} from '../map/GameMap.js';
import { circleIntersectsPolygon, polygonArea } from '../map/geometry.js';
import { assertValidMap } from '../validation/MapValidator.js';
import { gridToPolygons } from './contours.js';
import { generateRoads } from './roads/RoadGenerator.js';
import { generateTerrain } from './terrain/TerrainGenerator.js';
import { sampleField } from './sampleField.js';
import {
  DEFAULT_CONFIG,
  type GenerationConfig,
  type ResolvedGenerationConfig,
} from './GenerationConfig.js';

const MIN_DIMENSION = 128;
const MAX_DIMENSION = 4096;
const MAX_TREES = 8000;

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
  return {
    seed: config.seed,
    width,
    height,
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
  };
}

function generateFields(config: ResolvedGenerationConfig): SpatialFields {
  const columns = Math.max(20, Math.min(64, Math.round(config.width / 28)));
  const rows = Math.max(20, Math.min(64, Math.round(config.height / 28)));
  const terrain: number[] = [];
  const elevation: number[] = [];
  const moisture: number[] = [];
  const vegetation: number[] = [];
  const seed = mixSeed(config.seed);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = (column * config.width) / (columns - 1);
      const y = (row * config.height) / (rows - 1);
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
    gridToPolygons(
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
): VegetationEntity[] {
  if (config.vegetation.density === 0 || config.water.amount === 1) return [];
  const target = Math.min(
    MAX_TREES,
    Math.max(1, Math.round((config.width * config.height * config.vegetation.density) / 1250)),
  );
  const trees: VegetationEntity[] = [];
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
  const level = waterLevel(fields, resolved.water.amount);
  const water = generateWater(resolved, fields, level);
  const terrain = generateTerrain(resolved, fields, water);
  const impassable = terrain.filter((region) => region.collision !== undefined);
  const random = new Random(mixSeed(resolved.seed) ^ 0x51f15e);
  const roadRandom = new Random(mixSeed(resolved.seed) ^ 0x2f1c93);
  const roads = generateRoads(resolved, fields, water, terrain, () => roadRandom.next());
  const map: GameMap = {
    version: '1.0',
    metadata: {
      id: `generated-${resolved.seed}-${resolved.width}x${resolved.height}`,
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
    vegetation: generateTrees(resolved, fields, water, random, impassable),
    structures: [],
    roads,
    barriers: [],
    metadataLayers: { fields, generation: resolved, waterLevel: level },
  };
  assertValidMap(map);
  return map;
}
