import type { SpatialFields, TerrainRegion, WaterRegion } from '../../map/GameMap.js';
import { polygonArea } from '../../map/geometry.js';
import type { ResolvedGenerationConfig } from '../GenerationConfig.js';
import { gridToPolygons } from '../contours.js';
import { shorelineBand } from './Shoreline.js';

export type TerrainKind = TerrainRegion['kind'];

/**
 * Share of cells that become `meadow` and, within that, `scrub`.
 *
 * The classification score is the mean of two fractal noise fields, so it clusters tightly around
 * 0.5 (measured p50 0.500, p90 0.596 across seeds). A fixed absolute threshold would therefore make
 * coverage swing between roughly 20% and 30% depending on the seed. Selecting each map's own
 * quantiles keeps the surface split consistent across every seed.
 */
const MEADOW_QUANTILE = 0.75;
const SCRUB_QUANTILE = 0.9;

/**
 * Rock covers only the highest ground. This shares the elevation field that places lakes, so
 * highland sits above the waterline rather than being scattered independently of it. It is a fixed
 * quantile because the field is already the same one water thresholds, which keeps rock and water
 * consistent with one another.
 */
const ROCK_QUANTILE = 0.94;

/** Regions below this share of the map are dropped as noise. */
const MIN_REGION_FRACTION = 0.0025;

/** Width of the band drawn along each shoreline, in world units. */
const BEACH_WIDTH = 7;

/**
 * Builds a beach band along each lake. The band is the shoreline ring offset outward with the lake
 * punched out as a hole, so it is a ring of land rather than a filled blob. Lakes whose offset folds
 * through itself or would leave the map are skipped.
 */
function generateBeaches(config: ResolvedGenerationConfig, water: WaterRegion[]): TerrainRegion[] {
  const beaches: TerrainRegion[] = [];
  for (const lake of water) {
    const geometry = shorelineBand(lake.geometry, BEACH_WIDTH, config.width, config.height);
    if (!geometry) continue;
    beaches.push({
      id: `terrain-beach-${beaches.length + 1}`,
      type: 'terrain',
      kind: 'beach',
      geometry,
      asset: { category: 'terrain.grass', variant: 'beach-1' },
      metadata: { shorelineWidth: BEACH_WIDTH, source: lake.id },
    });
  }
  return beaches;
}

function scoreField(fields: SpatialFields): number[] {
  return fields.terrain.map((value, index) => (value + fields.moisture[index]) / 2);
}

function quantile(sorted: number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))];
}

function generateRegions(
  columns: number,
  rows: number,
  values: number[],
  level: number,
  kind: TerrainKind,
  config: ResolvedGenerationConfig,
): TerrainRegion[] {
  const minimumArea = MIN_REGION_FRACTION * config.width * config.height;
  return gridToPolygons(columns, rows, values, level, config.width, config.height)
    .filter((geometry) => polygonArea(geometry) > minimumArea)
    .map((geometry, index) => ({
      id: `terrain-${kind}-${index + 1}`,
      type: 'terrain',
      kind,
      geometry,
      asset: { category: 'terrain.grass', variant: `${kind}-1` },
      metadata: { scoreLevel: level },
    }));
}

/**
 * Classifies the generated fields into terrain overlays: `meadow` and `scrub` from the combined
 * terrain and moisture score, `rock` from elevation. The caller keeps the full-bounds `grass` base
 * region, which is why only overlays are returned.
 *
 * Emission order is a contract consumed by tests and the renderer: grass, then meadow, then scrub,
 * then rock, so later kinds take precedence over earlier ones.
 */
export function generateTerrain(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  water: WaterRegion[],
): TerrainRegion[] {
  const scores = scoreField(fields);
  const sortedScores = [...scores].sort((a, b) => a - b);
  const sortedElevation = [...fields.elevation].sort((a, b) => a - b);
  return [
    ...generateRegions(
      fields.columns,
      fields.rows,
      scores,
      quantile(sortedScores, MEADOW_QUANTILE),
      'meadow',
      config,
    ),
    ...generateRegions(
      fields.columns,
      fields.rows,
      scores,
      quantile(sortedScores, SCRUB_QUANTILE),
      'scrub',
      config,
    ),
    ...generateRegions(
      fields.columns,
      fields.rows,
      fields.elevation,
      quantile(sortedElevation, ROCK_QUANTILE),
      'rock',
      config,
    ),
    ...generateBeaches(config, water),
  ];
}
