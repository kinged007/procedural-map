import type { SpatialFields, TerrainRegion } from '../../map/GameMap.js';
import { polygonArea } from '../../map/geometry.js';
import type { ResolvedGenerationConfig } from '../GenerationConfig.js';
import { gridToPolygons } from '../contours.js';

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

/** Regions below this share of the map are dropped as noise. */
const MIN_REGION_FRACTION = 0.0025;

function scoreField(fields: SpatialFields): number[] {
  return fields.terrain.map((value, index) => (value + fields.moisture[index]) / 2);
}

function quantile(sorted: number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))];
}

function generateRegions(
  columns: number,
  rows: number,
  scores: number[],
  level: number,
  kind: TerrainKind,
  config: ResolvedGenerationConfig,
): TerrainRegion[] {
  const minimumArea = MIN_REGION_FRACTION * config.width * config.height;
  return gridToPolygons(columns, rows, scores, level, config.width, config.height)
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
 * Classifies the terrain field into `meadow` and `scrub` overlays. The caller keeps the full-bounds
 * `grass` base region, which is why only overlays are returned.
 */
export function generateTerrain(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
): TerrainRegion[] {
  const scores = scoreField(fields);
  const sorted = [...scores].sort((a, b) => a - b);
  return [
    ...generateRegions(
      fields.columns,
      fields.rows,
      scores,
      quantile(sorted, MEADOW_QUANTILE),
      'meadow',
      config,
    ),
    ...generateRegions(
      fields.columns,
      fields.rows,
      scores,
      quantile(sorted, SCRUB_QUANTILE),
      'scrub',
      config,
    ),
  ];
}
