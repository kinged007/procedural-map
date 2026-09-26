import type {
  PolygonGeometry,
  SpatialFields,
  TerrainRegion,
  WaterRegion,
} from '../../map/GameMap.js';
import { polygonArea } from '../../map/geometry.js';
import type { ResolvedGenerationConfig } from '../GenerationConfig.js';
import { gridToPolygons } from '../contours.js';
import { sampleField } from '../sampleField.js';
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

/**
 * How many vertices either side of each one share its width when the band is smoothed. Shorelines
 * carry tens to hundreds of vertices, so this is a fraction of the ring rather than a fixed span.
 */
const BEACH_SMOOTHING_RADIUS = 6;

/**
 * Beach width range, in world units.
 *
 * The upper end matters for legibility: a map drawn to fit a laptop viewport puts roughly 0.44
 * screen pixels on one world unit, so a 7-unit band lands at about 3 pixels and reads as a line
 * rather than ground. The lower end is near zero so sheltered inlets close to bare shoreline
 * instead of every shore carrying a visible rim.
 */
const BEACH_MIN_WIDTH = 1.5;
const BEACH_MAX_WIDTH = 30;

/**
 * How far a lake's own moisture spread is stretched when mapping it to width, as a multiplier on the
 * standard deviation. Moisture varies far more between lakes (measured mean 0.22 to 0.67 across
 * seeds) than along a single shoreline (standard deviation 0.01 to 0.13), so normalising against a
 * single map-wide value gives each lake one nearly constant width.
 *
 * The multiplier is deliberately below 1. Dividing by the raw standard deviation drives nearly every
 * vertex to the ends of the range, which renders as a bimodal shore that is either a hairline or the
 * full width. Half a spread puts the bulk of a lake's shoreline in the middle of the range with a
 * tapering tail, so width grades along the shore.
 */
const LAKE_SPREAD_MULTIPLIER = 0.5;

/**
 * Floor on a lake's own moisture spread, in moisture units. A lake sitting in near-uniform ground
 * would otherwise divide by a near-zero spread and produce a rim that is uniformly full width.
 */
const MIN_LAKE_SPREAD = 0.06;

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
  options: {
    /** Threshold published in metadata, in the units of the caller's own field. */
    reportedLevel?: number;
    /** True for terrain that cannot be walked on, which publishes a collision polygon. */
    impassable?: boolean;
  } = {},
): TerrainRegion[] {
  const { reportedLevel = level, impassable = false } = options;
  const minimumArea = MIN_REGION_FRACTION * config.width * config.height;
  return gridToPolygons(columns, rows, values, level, config.width, config.height)
    .filter((geometry) => polygonArea(geometry) > minimumArea)
    .map((geometry, index) => ({
      id: `terrain-${kind}-${index + 1}`,
      type: 'terrain',
      kind,
      geometry,
      // Rock is impassable, so it blocks movement over the same area it covers. The collision
      // polygon is the region itself rather than an inset, matching how water blocks movement.
      ...(impassable ? { collision: { type: 'polygon' as const, ...geometry } } : {}),
      asset: { category: 'terrain.grass', variant: `${kind}-1` },
      metadata: { scoreLevel: reportedLevel },
    }));
}

/**
 * Per-vertex beach offsets driven by the moisture field, so width varies continuously around every
 * shoreline instead of following a single ring. Coarse bays are narrow, sheltered stretches are
 * wide, which reads as sand building up in the lee of a bank.
 */
function beachWidths(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  water: PolygonGeometry,
): number[] {
  const moisture = water.points.map((point) =>
    sampleField(fields, fields.moisture, point.x, point.y, config.width, config.height),
  );
  const mean = moisture.reduce((a, b) => a + b, 0) / moisture.length;
  const deviation = Math.sqrt(moisture.reduce((a, v) => a + (v - mean) ** 2, 0) / moisture.length);
  const spread = Math.max(MIN_LAKE_SPREAD, deviation * LAKE_SPREAD_MULTIPLIER);
  return moisture.map((value) => {
    const unit = Math.max(0, Math.min(1, 0.5 + ((value - mean) / spread) * 0.5));
    return BEACH_MIN_WIDTH + (BEACH_MAX_WIDTH - BEACH_MIN_WIDTH) * unit;
  });
}

/**
 * Circular moving average over a closed ring, so neighbouring vertices share a width.
 *
 * Without this, adjacent vertices can jump from a hairline to the full width, and the offset ring
 * folds through itself at each sharp turn. Grading the width along the shore is both what a beach
 * does and what keeps the geometry simple.
 */
function smoothRing(values: number[], radius: number): number[] {
  const count = values.length;
  if (radius < 1 || count === 0) return [...values];
  return values.map((_, index) => {
    let total = 0;
    let weight = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const at = (((index + offset) % count) + count) % count;
      // A linear taper keeps the average local, so a wide bay is not flattened by narrow neighbours
      // on the far side of the ring.
      total += values[at] * (radius + 1 - Math.abs(offset));
      weight += radius + 1 - Math.abs(offset);
    }
    return total / weight;
  });
}

/**
 * Builds a beach band along each lake. The band is the shoreline ring offset outward with the lake
 * punched out as a hole, so it is a ring of land rather than a filled blob. Lakes whose offset folds
 * through itself or would leave the map are skipped.
 */
function generateBeaches(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  water: WaterRegion[],
): TerrainRegion[] {
  const beaches: TerrainRegion[] = [];
  for (const lake of water) {
    const distances = smoothRing(
      beachWidths(config, fields, lake.geometry),
      BEACH_SMOOTHING_RADIUS,
    );
    const geometry = shorelineBand(lake.geometry, {
      distances,
      width: config.width,
      height: config.height,
    });
    if (!geometry) continue;
    // Report the widths the band actually has. shorelineBand may scale the band down to keep the
    // ring simple, and a narrower band than requested is the correct thing to record.
    const realised = geometry.points.map((point, index) =>
      Math.hypot(point.x - lake.geometry.points[index].x, point.y - lake.geometry.points[index].y),
    );
    const min = Math.min(...realised);
    const max = Math.max(...realised);
    beaches.push({
      id: `terrain-beach-${beaches.length + 1}`,
      type: 'terrain',
      kind: 'beach',
      geometry,
      asset: { category: 'terrain.grass', variant: 'beach-1' },
      metadata: {
        shorelineWidth: {
          min,
          max,
          mean: realised.reduce((a, b) => a + b, 0) / realised.length,
        },
        source: lake.id,
      },
    });
  }
  return beaches;
}

/**
 * Classifies the generated fields into terrain overlays: `meadow` and `scrub` from the combined
 * terrain and moisture score, `rock` from elevation, and `beach` bands around lakes. The caller
 * keeps the full-bounds `grass` base region, which is why only overlays are returned.
 *
 * Emission order is a contract consumed by tests and the renderer: grass, then meadow, then scrub,
 * then rock, then beach, so later kinds take precedence over earlier ones.
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
    // contourSegments selects cells at or below the level, so a high quantile on raw elevation
    // would return the low ground. Negating the field asks for the high ground instead.
    ...generateRegions(
      fields.columns,
      fields.rows,
      fields.elevation.map((value) => -value),
      -quantile(sortedElevation, ROCK_QUANTILE),
      'rock',
      config,
      {
        // Publish the elevation threshold rather than the negated one the contour is traced against.
        reportedLevel: quantile(sortedElevation, ROCK_QUANTILE),
        impassable: true,
      },
    ),
    ...generateBeaches(config, fields, water),
  ];
}
