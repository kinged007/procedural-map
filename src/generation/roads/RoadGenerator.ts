import type {
  Point,
  PolygonGeometry,
  RoadEntity,
  SpatialFields,
  TerrainRegion,
  WaterRegion,
} from '../../map/GameMap.js';
import { pointInPolygon, polygonArea } from '../../map/geometry.js';
import { ringIsSimple } from '../terrain/Shoreline.js';
import type { ResolvedGenerationConfig } from '../GenerationConfig.js';
import { sampleField } from '../sampleField.js';

/**
 * Road surface widths, in world units. A map drawn to fit a laptop viewport puts roughly 0.44 screen
 * pixels on one world unit, so anything under about 5 units reads as a hairline.
 */
const ROAD_WIDTHS = { primary: 11, secondary: 7, path: 3.5 } as const;

/** How far a road is kept from the map edge, so its ends do not dangle outside the world. */
const EDGE_MARGIN = 16;

/** Minimum road length, in world units. A shorter stub is dropped rather than published. */
const MIN_ROAD_LENGTH = 40;

/**
 * Cost added to water and impassable terrain when routing. Roads prefer open ground, and these values
 * make crossing expensive rather than forbidden: a road still reaches the far bank, but only where
 * there is no reasonable alternative. River crossings and bridges are v0.7 work.
 */
const WATER_COST = 9;
const ROCK_COST = 6;

/** Share of the map covered by water and rock at which road generation is skipped. */
const BLOCKED_SHARE = 0.55;

/**
 * Accumulated cost at which a road stops growing, and the per-step cost above which a step is refused.
 * Water alone costs more than a step allows, so a road cannot push through a lake even though crossing
 * is only expensive rather than forbidden.
 */
const ROAD_BUDGET = 2600;
const MAX_STEP_COST = 14;

/** Candidates tried per step, as an angle either side of straight ahead. */
const FAN = [-0.7, -0.42, -0.2, 0, 0.2, 0.42, 0.7];

/** Roads are grown from this many map-edge entries before new roads branch off existing ones. */
const SEED_ENTRIES = 4;

/** Target road counts per tier, before rejection. */
const TIER_COUNTS = { primary: 5, secondary: 9, path: 16 } as const;

/**
 * Step length as a share of the map's shorter side, per tier. Primary roads take longer strides so
 * they cross the map; paths take short ones so they read as trails.
 */
const TIER_STEPS = { primary: 0.016, secondary: 0.013, path: 0.01 } as const;

/** Minimum centre-to-centre separation from an existing road, per tier, as a share of the short side. */
const TIER_GAPS = { primary: 0.16, secondary: 0.12, path: 0.08 } as const;

/**
 * Longest path kept in the published centreline, as a share of the map's shorter side. A greedy walk
 * that is not trimmed produces a road with hundreds of near-collinear points, which is wasted data
 * for a consumer and inflates every distance query the map is asked to answer.
 */
const MAX_ROAD_POINTS = 120;

type RoadKind = RoadEntity['kind'];

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, a);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Uniform grid over the map used to answer "what is near this point" without scanning every polygon
 * and every existing road. Without it, routing cost per step is linear in the size of the water and
 * rock contours and in the number of roads already placed, which is slow enough to dominate the whole
 * map generation.
 */
class SpatialIndex<T> {
  private readonly cells = new Map<string, T[]>();
  private readonly columns: number;
  private readonly rows: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    targetPerCell: number,
  ) {
    this.columns = Math.max(1, Math.round(width / targetPerCell));
    this.rows = Math.max(1, Math.round(height / targetPerCell));
  }

  private key(column: number, row: number): string {
    return `${column},${row}`;
  }

  private *cellsFor(minX: number, minY: number, maxX: number, maxY: number): Generator<string> {
    const lowColumn = clamp(Math.floor((minX / this.width) * this.columns), 0, this.columns - 1);
    const highColumn = clamp(Math.floor((maxX / this.width) * this.columns), 0, this.columns - 1);
    const lowRow = clamp(Math.floor((minY / this.height) * this.rows), 0, this.rows - 1);
    const highRow = clamp(Math.floor((maxY / this.height) * this.rows), 0, this.rows - 1);
    for (let row = lowRow; row <= highRow; row += 1)
      for (let column = lowColumn; column <= highColumn; column += 1) yield this.key(column, row);
  }

  insert(bounds: { minX: number; minY: number; maxX: number; maxY: number }, value: T): void {
    for (const key of this.cellsFor(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY)) {
      const cell = this.cells.get(key);
      if (cell) cell.push(value);
      else this.cells.set(key, [value]);
    }
  }

  /** Every value whose bounds overlap the query box, without duplicates. */
  query(minX: number, minY: number, maxX: number, maxY: number): T[] {
    const found = new Set<T>();
    for (const key of this.cellsFor(minX, minY, maxX, maxY)) {
      const cell = this.cells.get(key);
      if (cell) for (const value of cell) found.add(value);
    }
    return [...found];
  }
}

function boundsOf(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Drops points that lie on the straight line between their neighbours. Greedy routing emits a point
 * per step whether or not the heading changed, so an untrimmed centreline is mostly redundant.
 */
function simplifyPath(path: Point[]): Point[] {
  if (path.length < 3) return [...path];
  const kept: Point[] = [path[0]];
  for (let index = 1; index < path.length - 1; index += 1) {
    const previous = kept[kept.length - 1];
    const cross =
      (path[index].x - previous.x) * (path[index + 1].y - previous.y) -
      (path[index].y - previous.y) * (path[index + 1].x - previous.x);
    const span = distance(previous, path[index + 1]);
    // Skip the point when removing it displaces the line by less than a unit over the span.
    if (Math.abs(cross) / (span || 1) > 0.75) kept.push(path[index]);
  }
  kept.push(path[path.length - 1]);
  return kept;
}

/**
 * Keeps at most `limit` points by sampling the path evenly, endpoints included. Simplification alone
 * cannot bound the count on a long meandering road.
 */
function capPoints(path: Point[], limit: number): Point[] {
  if (path.length <= limit) return path;
  const capped: Point[] = [];
  const stride = (path.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1)
    capped.push(path[Math.min(path.length - 1, Math.round(index * stride))]);
  return capped;
}

/**
 * Removes points where the road reverses on itself.
 *
 * A greedy walk occasionally steps back along the line it came from, and a ribbon around such a point
 * has its two sides cross: the offset of the outbound leg meets the offset of the return leg. That is
 * a self-intersecting polygon, which is not a valid road surface. Moving the hinge point onto the new
 * step straightens the fold while keeping the turn.
 */
function dropReversals(path: Point[]): Point[] {
  if (path.length < 3) return [...path];
  const kept: Point[] = [path[0]];
  for (let index = 1; index < path.length; index += 1) {
    const step = path[index];
    const anchor = kept[kept.length - 1];
    if (distance(anchor, step) < 1e-6) continue;
    kept.push(step);
    if (kept.length < 3) continue;
    const before = kept[kept.length - 3];
    const forward = { x: anchor.x - before.x, y: anchor.y - before.y };
    const onward = { x: step.x - anchor.x, y: step.y - anchor.y };
    const forwardLength = Math.hypot(forward.x, forward.y) || 1;
    const onwardLength = Math.hypot(onward.x, onward.y) || 1;
    // A road turning back on itself has a dot product below zero.
    if ((forward.x * onward.x + forward.y * onward.y) / (forwardLength * onwardLength) < -0.2)
      kept[kept.length - 2] = step;
  }
  return kept;
}

/** Simplifies a walked path, then removes any retrace, so the ribbon cannot fold over itself. */
function cleanPath(path: Point[]): Point[] {
  return dropReversals(simplifyPath(path));
}

/**
 * Builds the ribbon polygon for a road: the centreline offset to each side, closed at both ends.
 * Returns null when the centreline is too short or degenerate to have an area.
 */
export function roadRibbon(path: Point[], width: number): PolygonGeometry | null {
  if (path.length < 2) return null;
  const half = width / 2;
  const left: Point[] = [];
  const right: Point[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const previous = path[Math.max(0, index - 1)];
    const next = path[Math.min(path.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    const point = path[index];
    left.push({ x: point.x + (-dy / length) * half, y: point.y + (dx / length) * half });
    right.push({ x: point.x + (dy / length) * half, y: point.y - (dx / length) * half });
  }
  const points = [...left, ...right.reverse()];
  const area = polygonArea({ points });
  if (!Number.isFinite(area) || area === 0) return null;
  return { points };
}

/** Total length of a centreline. */
export function pathLength(path: Point[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1)
    total += distance(path[index - 1], path[index]);
  return total;
}

interface RouteCost {
  /** Water polygons, which roads cross only at high cost. */
  water: SpatialIndex<PolygonGeometry>;
  /** Impassable terrain polygons, indexed the same way. */
  rock: SpatialIndex<PolygonGeometry>;
  fields: SpatialFields;
  width: number;
  height: number;
}

/**
 * Builds the polygon index. Water and rock rings are indexed by their bounding box, so a step near the
 * middle of the map only pays for contours that actually overlap that area.
 */
function buildRouteCost(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  water: WaterRegion[],
  rock: TerrainRegion[],
): RouteCost {
  const cell = Math.max(24, Math.round(Math.min(config.width, config.height) * 0.05));
  const waterIndex = new SpatialIndex<PolygonGeometry>(config.width, config.height, cell);
  const rockIndex = new SpatialIndex<PolygonGeometry>(config.width, config.height, cell);
  for (const lake of water) waterIndex.insert(boundsOf(lake.geometry.points), lake.geometry);
  for (const region of rock) rockIndex.insert(boundsOf(region.geometry.points), region.geometry);
  return { water: waterIndex, rock: rockIndex, fields, width: config.width, height: config.height };
}

function covered(index: SpatialIndex<PolygonGeometry>, point: Point): boolean {
  for (const geometry of index.query(point.x, point.y, point.x, point.y))
    if (pointInPolygon(point, geometry)) return true;
  return false;
}

/**
 * Cost of standing at a point, before the turn penalty. Water and rock dominate the value so a route
 * bends around them, while the terrain field adds a gentle preference so roads follow the land
 * instead of running dead straight.
 */
function terrainCost(point: Point, cost: RouteCost): number {
  let value =
    sampleField(cost.fields, cost.fields.terrain, point.x, point.y, cost.width, cost.height) * 1.2;
  if (covered(cost.water, point)) value += WATER_COST;
  if (covered(cost.rock, point)) value += ROCK_COST;
  return value;
}

function insideMap(config: ResolvedGenerationConfig, point: Point): boolean {
  return (
    point.x >= EDGE_MARGIN &&
    point.y >= EDGE_MARGIN &&
    point.x <= config.width - EDGE_MARGIN &&
    point.y <= config.height - EDGE_MARGIN
  );
}

/**
 * Grows one road from a start point, steering towards low cost.
 *
 * The walk is a greedy step over a small fan of headings, not a shortest-path search. Each step takes
 * the cheapest heading available, which produces the meander and long detours of a surveyed road
 * rather than a taut path between endpoints. Cost is charged against a budget so the road terminates,
 * and a step that is too expensive to justify aborts the branch rather than pushing through.
 */
function growRoad(
  start: Point,
  direction: Point,
  config: ResolvedGenerationConfig,
  cost: RouteCost,
  random: () => number,
  step: number,
  budget: number,
): Point[] {
  const path: Point[] = [start];
  let heading = Math.atan2(direction.y, direction.x);
  let spent = 0;

  while (spent < budget && path.length < MAX_ROAD_POINTS) {
    const here = path[path.length - 1];
    let bestHeading = heading;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const offset of FAN) {
      const candidate = heading + offset + (random() - 0.5) * 0.12;
      const probe = {
        x: clamp(here.x + Math.cos(candidate) * step, 0, config.width),
        y: clamp(here.y + Math.sin(candidate) * step, 0, config.height),
      };
      if (!insideMap(config, probe)) continue;
      // Turning sharply is discouraged, so a road bends rather than zigzags.
      const value = terrainCost(probe, cost) + Math.abs(offset) * 0.9 + random() * 0.25;
      if (value < bestCost) {
        bestCost = value;
        bestHeading = candidate;
      }
    }
    if (!Number.isFinite(bestCost)) break;
    if (bestCost > MAX_STEP_COST) break;
    const next = {
      x: clamp(here.x + Math.cos(bestHeading) * step, 0, config.width),
      y: clamp(here.y + Math.sin(bestHeading) * step, 0, config.height),
    };
    if (!insideMap(config, next)) break;
    path.push(next);
    spent += bestCost;
    heading = bestHeading;
  }
  return path;
}

/**
 * Distributes road entry points around the map edge. Each heading points inward, so a road started
 * here crosses the map rather than hugging the border.
 */
function entryPoints(
  config: ResolvedGenerationConfig,
  count: number,
  random: () => number,
): { point: Point; direction: Point }[] {
  const entries: { point: Point; direction: Point }[] = [];
  const perimeter = 2 * (config.width + config.height);
  for (let index = 0; index < count; index += 1) {
    const along = ((index + 0.25 + random() * 0.5) / count) * perimeter;
    const edge: Point =
      along < config.width
        ? { x: along, y: EDGE_MARGIN }
        : along < config.width + config.height
          ? { x: config.width - EDGE_MARGIN, y: along - config.width }
          : along < 2 * config.width + config.height
            ? {
                x: config.width - (along - config.width - config.height),
                y: config.height - EDGE_MARGIN,
              }
            : { x: EDGE_MARGIN, y: config.height - (along - 2 * config.width - config.height) };
    const direction = { x: config.width / 2 - edge.x, y: config.height / 2 - edge.y };
    const length = Math.hypot(direction.x, direction.y) || 1;
    entries.push({
      point: {
        x: edge.x + (direction.x / length) * EDGE_MARGIN,
        y: edge.y + (direction.y / length) * EDGE_MARGIN,
      },
      direction: { x: direction.x / length, y: direction.y / length },
    });
  }
  return entries;
}

/**
 * Tracks the placed network so a candidate road can be rejected when it runs too close to an existing
 * one. Segments are indexed by bounding box, and a road is skipped entirely once the candidate is
 * already clear of it, so a long road is not measured against every other road on the map.
 */
class NetworkIndex {
  private readonly index: SpatialIndex<{ road: RoadEntity; a: Point; b: Point }>;

  constructor(width: number, height: number) {
    this.index = new SpatialIndex(
      width,
      height,
      Math.max(24, Math.round(Math.min(width, height) * 0.05)),
    );
  }

  add(road: RoadEntity): void {
    for (let i = 1; i < road.path.length; i += 1) {
      const a = road.path[i - 1];
      const b = road.path[i];
      const bounds = boundsOf([a, b]);
      this.index.insert(
        { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX + 1, maxY: bounds.maxY + 1 },
        { road, a, b },
      );
    }
  }

  /**
   * True when no point of `path` lies within `gap` of any placed road's centreline. Only segments
   * the index reports for the query box are measured, so the cost scales with the neighbourhood of
   * the candidate rather than with the size of the network.
   */
  isClear(path: Point[], gap: number, parent?: RoadEntity): boolean {
    for (let i = 0; i < path.length; i += 1) {
      const point = path[i];
      const segments = this.index.query(point.x - gap, point.y - gap, point.x + gap, point.y + gap);
      for (const segment of segments) {
        // A branch is required to touch the road it grew from, so that pair is exempt. The exemption
        // ends as soon as the branch has cleared the parent, at which point the two separate like
        // any other pair of roads.
        if (parent && segment.road === parent) continue;
        if (distanceToSegment(point, segment.a, segment.b) <= gap) return false;
      }
    }
    return true;
  }
}

/**
 * Picks a point partway along an existing road, heading away from it, to grow the next road from.
 * Reports the road branched from, because a branch is required to touch that road and separation must
 * not count the shared junction as a conflict.
 */
function branchFrom(
  roads: RoadEntity[],
  random: () => number,
): { point: Point; direction: Point; parent: RoadEntity } | null {
  if (roads.length === 0) return null;
  const road = roads[Math.floor(random() * roads.length)];
  if (road.path.length < 2) return null;
  const index = 1 + Math.floor(random() * (road.path.length - 1));
  const previous = road.path[index - 1];
  const current = road.path[index];
  const length = distance(previous, current) || 1;
  const along = { x: (current.x - previous.x) / length, y: (current.y - previous.y) / length };
  // Turn away from the parent, alternating sides so branches spread across the map rather than
  // all leaving on the same one. A quarter turn leaves the road at a plausible junction angle.
  const side = random() < 0.5 ? 1 : -1;
  const quarter = (side * Math.PI) / 2;
  const cos = Math.cos(quarter);
  const sin = Math.sin(quarter);
  return {
    point: current,
    direction: { x: along.x * cos - along.y * sin, y: along.x * sin + along.y * cos },
    parent: road,
  };
}

function totalArea(geometries: PolygonGeometry[]): number {
  return geometries.reduce((sum, geometry) => sum + Math.abs(polygonArea(geometry)), 0);
}

/**
 * Generates the road network.
 *
 * Roads are grown in tiers, widest and longest first. Primary roads start at the map edge and cross
 * the map; secondary roads do the same with a shorter stride; paths branch off roads already placed,
 * which is what makes the network connected rather than a set of parallel lines. Separation is
 * enforced between roads, so a later road bends around an earlier one instead of overlapping it.
 *
 * Returns an empty array when water and rock together cover too much of the map for routing to be
 * meaningful.
 */
export function generateRoads(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  water: WaterRegion[],
  terrain: TerrainRegion[],
  random: () => number,
): RoadEntity[] {
  const rock = terrain.filter((region) => region.kind === 'rock');
  const blocked =
    (totalArea(water.map((lake) => lake.geometry)) + totalArea(rock.map((r) => r.geometry))) /
    (config.width * config.height);
  if (blocked > BLOCKED_SHARE) return [];

  const cost = buildRouteCost(config, fields, water, rock);
  const network = new NetworkIndex(config.width, config.height);
  const roads: RoadEntity[] = [];
  const shortSide = Math.min(config.width, config.height);
  const entries = entryPoints(config, SEED_ENTRIES, random);
  const tiers: RoadKind[] = ['primary', 'secondary', 'path'];
  // Density scales each tier's target. The floor of one keeps a sparse map connected rather than
  // dropping a tier, so density controls how busy the network is, not whether there is one at all.
  const targets: Record<RoadKind, number> = {
    primary: Math.max(1, Math.round(TIER_COUNTS.primary * config.roads.density)),
    secondary: Math.max(1, Math.round(TIER_COUNTS.secondary * config.roads.density)),
    path: Math.max(1, Math.round(TIER_COUNTS.path * config.roads.density)),
  };

  for (const kind of tiers) {
    const target = targets[kind];
    let made = 0;
    let entry = 0;
    // A tier uses the edge entries first, then branches from roads already placed. Attempts are
    // bounded so a tier that cannot satisfy its separation rule terminates instead of retrying
    // forever on a crowded map.
    const attempts = target * 12;
    for (let attempt = 0; attempt < attempts && made < target; attempt += 1) {
      const seed =
        entry < entries.length
          ? { point: entries[entry].point, direction: entries[entry].direction, parent: undefined }
          : branchFrom(roads, random);
      if (!seed) break;
      entry += 1;
      const step = Math.max(6, Math.round(shortSide * TIER_STEPS[kind]));
      const raw = growRoad(
        seed.point,
        seed.direction,
        config,
        cost,
        random,
        step,
        ROAD_BUDGET *
          (kind === 'primary' ? 1 : kind === 'secondary' ? 0.6 : 0.35) *
          (0.7 + random() * 0.6),
      );
      const path = capPoints(cleanPath(raw), MAX_ROAD_POINTS);
      if (path.length < 2 || pathLength(path) < MIN_ROAD_LENGTH) continue;
      if (!network.isClear(path, shortSide * TIER_GAPS[kind], seed.parent)) continue;
      const width = ROAD_WIDTHS[kind] * 2;
      const ribbon = roadRibbon(path, width);
      // A ribbon whose ring crosses itself is not a usable surface. Reject it here rather than
      // publishing a road that map validation would refuse.
      if (!ribbon || !ringIsSimple(ribbon.points)) continue;
      const road: RoadEntity = {
        id: `road-${roads.length + 1}`,
        type: 'road',
        kind,
        path,
        width,
        collision: { type: 'polygon', ...ribbon },
        asset: { category: `road.${kind}`, variant: `${kind}-1` },
        metadata: { length: pathLength(path) },
      };
      roads.push(road);
      network.add(road);
      made += 1;
    }
  }
  return roads;
}
