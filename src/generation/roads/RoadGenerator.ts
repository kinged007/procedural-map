import type {
  Point,
  PolygonGeometry,
  RoadCrossing,
  RoadEntity,
  SpatialFields,
  TerrainRegion,
  WaterRegion,
} from '../../map/GameMap.js';
import { boundsOf, circleIntersectsPolygon, polygonArea } from '../../map/geometry.js';
import { ringIsSimple } from '../terrain/Shoreline.js';
import type { ResolvedGenerationConfig } from '../GenerationConfig.js';
import { distance, pathLength, roadRibbon, simplifyPath, smoothPath } from '../ribbon.js';
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
 * Distance a road centreline is kept from a water edge, in world units. A road that stops level with
 * the shoreline reads as cut off rather than routed, so the last step is refused this far out and the
 * road turns along the bank instead.
 */
const SHORE_CLEARANCE = 20;

/** Share of the map covered by water and rock at which road generation is skipped. */
const BLOCKED_SHARE = 0.55;

/** Accumulated cost at which a road stops growing. */
const ROAD_BUDGET = 2600;

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

interface RouteCost {
  /** Standing water, which a road is kept clear of and never enters. */
  lakes: SpatialIndex<PolygonGeometry>;
  /** Rivers, indexed whole rather than as polygons so a crossing can name the one it crossed. A road is
   * not kept clear of these: a channel is narrow enough to bridge, and where a road meets one the
   * crossing is recorded. */
  rivers: SpatialIndex<WaterRegion>;
  /** Full width of a river channel, which is the span a crossing has to cover. */
  channelWidth: number;
  /** Impassable terrain polygons, indexed the same way. */
  rock: SpatialIndex<PolygonGeometry>;
  fields: SpatialFields;
  width: number;
  height: number;
}

/**
 * Builds the polygon index. Water and rock rings are indexed by their bounding box, so a step near the
 * middle of the map only pays for contours that actually overlap that area. Lake rings are inserted
 * over their bounds grown by the shore clearance, because a road is refused before it arrives. River
 * rings are inserted over their own bounds, because a road reaches them.
 */
function buildRouteCost(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  water: WaterRegion[],
  rock: TerrainRegion[],
): RouteCost {
  const cell = Math.max(24, Math.round(Math.min(config.width, config.height) * 0.05));
  const lakeIndex = new SpatialIndex<PolygonGeometry>(config.width, config.height, cell);
  const riverIndex = new SpatialIndex<WaterRegion>(config.width, config.height, cell);
  const rockIndex = new SpatialIndex<PolygonGeometry>(config.width, config.height, cell);
  for (const region of water) {
    const bounds = boundsOf(region.geometry.points);
    if (region.kind === 'river') {
      riverIndex.insert(bounds, region);
      continue;
    }
    lakeIndex.insert(
      {
        minX: bounds.minX - SHORE_CLEARANCE,
        minY: bounds.minY - SHORE_CLEARANCE,
        maxX: bounds.maxX + SHORE_CLEARANCE,
        maxY: bounds.maxY + SHORE_CLEARANCE,
      },
      region.geometry,
    );
  }
  for (const region of rock) rockIndex.insert(boundsOf(region.geometry.points), region.geometry);
  return {
    lakes: lakeIndex,
    rivers: riverIndex,
    rock: rockIndex,
    fields,
    width: config.width,
    height: config.height,
    channelWidth: config.rivers.width,
  };
}

/**
 * True when a point is within `clearance` of any indexed geometry, counting the polygon interior. A
 * clearance of zero reduces to "inside", which is what impassable terrain wants. Only the contours
 * overlapping the query box are measured, so a step in open country pays for a few rings.
 */
function nearAny<T>(
  index: SpatialIndex<T>,
  point: Point,
  clearance: number,
  geometryOf: (item: T) => PolygonGeometry,
): boolean {
  return index
    .query(point.x - clearance, point.y - clearance, point.x + clearance, point.y + clearance)
    .some((item) => circleIntersectsPolygon(point, clearance, geometryOf(item)));
}

/**
 * True where a road cannot stand: a lake or impassable terrain. A road that runs into either ends or
 * turns away, and it never crosses a lake. A river is not in this set: a road goes over a channel, and
 * `riverCrossings` records where.
 */
function blocked(point: Point, cost: RouteCost): boolean {
  return (
    nearAny(cost.lakes, point, SHORE_CLEARANCE, (geometry) => geometry) ||
    nearAny(cost.rock, point, 0, (geometry) => geometry)
  );
}

/**
 * The rivers this road's surface reaches, as published crossings.
 *
 * A road goes over a river rather than stopping at the bank, so a crossing is where the road reaches
 * the channel. The road's surface is its centreline a half-width either side, so a centreline point
 * within a half-width of the river is a point the surface covers: that catches a road crossing the
 * water and a road running along the bank with its edge in it, which are the two ways a road meets a
 * river. The site recorded is the closest the road comes, because that is the narrowest reach to
 * bridge and where a ford goes.
 */
function riverCrossings(path: Point[], width: number, cost: RouteCost): RoadCrossing[] {
  const reach = width / 2;
  const bounds = boundsOf(path);
  const crossings: RoadCrossing[] = [];
  for (const river of cost.rivers.query(
    bounds.minX - reach,
    bounds.minY - reach,
    bounds.maxX + reach,
    bounds.maxY + reach,
  )) {
    let site = river.geometry.points[0];
    let nearest = Infinity;
    for (const point of path) {
      if (!circleIntersectsPolygon(point, reach, river.geometry)) continue;
      for (const vertex of river.geometry.points) {
        const squared = (vertex.x - point.x) ** 2 + (vertex.y - point.y) ** 2;
        if (squared < nearest) {
          nearest = squared;
          site = vertex;
        }
      }
    }
    if (nearest < Infinity)
      crossings.push({ riverId: river.id, point: site, span: cost.channelWidth });
  }
  return crossings;
}

/**
 * Cost of standing at a point, before the turn penalty. The terrain field adds a gentle preference so
 * roads follow the land instead of running dead straight.
 */
function terrainCost(point: Point, cost: RouteCost): number {
  return (
    sampleField(cost.fields, cost.fields.terrain, point.x, point.y, cost.width, cost.height) * 1.2
  );
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
 * rather than a taut path between endpoints. Cost is charged against a budget so the road terminates.
 * Lakes and rock are refused outright, and a step is refused short of a lake rather than at it, so a
 * road bends around an obstruction for as long as it takes and stops with room to spare. A river is
 * neither refused nor cheap: a road goes over the channel, and the crossing is found from the ribbon
 * afterwards.
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
  // A seed inside a lake or on rock cannot be rescued by steering, so the road is abandoned there.
  if (blocked(start, cost)) return [];
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
      if (blocked(probe, cost)) continue;
      // Turning sharply is discouraged, so a road bends rather than zigzags.
      const value = terrainCost(probe, cost) + Math.abs(offset) * 0.9 + random() * 0.25;
      if (value < bestCost) {
        bestCost = value;
        bestHeading = candidate;
      }
    }
    // Every heading was refused, so the road ends here rather than pushing through the obstruction.
    if (!Number.isFinite(bestCost)) break;
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
   * True when `path` stays at least `gap` from every placed road's centreline, in both directions.
   *
   * The candidate is measured from its own points, and the roads it passes are measured back from
   * theirs. Both are needed because a point is only ever as far from a line as the nearest vertex of
   * that line is: a long road is a long way between vertices, so measuring only the candidate's side
   * lets a pair pass at two thirds of the gap the contract promises. Only segments the index reports
   * are measured, so the cost scales with the neighbourhood of the candidate rather than with the size
   * of the network.
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
    const bounds = boundsOf(path);
    for (const segment of this.index.query(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY)) {
      if (parent && segment.road === parent) continue;
      if (tooClose(segment.a, path, gap, bounds) || tooClose(segment.b, path, gap, bounds))
        return false;
    }
    return true;
  }
}

/** True when a point of a placed road is within `gap` of the candidate's own centreline. The bounds
 * test is the cheap reject: a point further than `gap` outside the candidate's box cannot be near it. */
function tooClose(
  point: Point,
  path: Point[],
  gap: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  if (
    point.x < bounds.minX - gap ||
    point.x > bounds.maxX + gap ||
    point.y < bounds.minY - gap ||
    point.y > bounds.maxY + gap
  )
    return false;
  for (let i = 1; i < path.length; i += 1)
    if (distanceToSegment(point, path[i - 1], path[i]) <= gap) return true;
  return false;
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
  // Share of the map no road can be laid across. Named for the ground, not the road: `blocked` is the
  // predicate that asks whether a single point is refused.
  const covered =
    (totalArea(water.map((lake) => lake.geometry)) + totalArea(rock.map((r) => r.geometry))) /
    (config.width * config.height);
  if (covered > BLOCKED_SHARE) return [];

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
      const straight = capPoints(cleanPath(raw), MAX_ROAD_POINTS);
      // A greedy walk is a staircase, and a staircase reads as a staircase whatever width it is drawn
      // at. The curve is only kept where it is still clear of the same things the walk refused: cutting
      // a corner rounds the joints but can bow the line towards a shore the walk turned along, and a
      // road that runs through a lake is worse than a road that runs straight. Re-simplifying after
      // thinning: corner cutting quadruples the points, and the result is straight wherever the curve
      // is, so the collinear ones drop straight back out and a smooth road stays a small road.
      const curved = capPoints(simplifyPath(smoothPath(straight, 1)), MAX_ROAD_POINTS);
      const path = curved.every((point) => !blocked(point, cost)) ? curved : straight;
      if (path.length < 2 || pathLength(path) < MIN_ROAD_LENGTH) continue;
      if (!network.isClear(path, shortSide * TIER_GAPS[kind], seed.parent)) continue;
      const width = ROAD_WIDTHS[kind] * 2;
      const ribbon = roadRibbon(path, width);
      // A ribbon whose ring crosses itself is not a usable surface. Reject it here rather than
      // publishing a road that map validation would refuse.
      if (!ribbon || !ringIsSimple(ribbon.points)) continue;
      // Where the road reaches a river, the crossing is recorded: the site a bridge or a ford is built
      // on, and the width of channel it has to cover.
      const crossings = riverCrossings(path, width, cost);
      const road: RoadEntity = {
        id: `road-${roads.length + 1}`,
        type: 'road',
        kind,
        path,
        width,
        collision: { type: 'polygon', ...ribbon },
        asset: { category: `road.${kind}`, variant: `${kind}-1` },
        metadata: { length: pathLength(path), ...(crossings.length ? { crossings } : {}) },
      };
      roads.push(road);
      network.add(road);
      made += 1;
    }
  }
  return roads;
}
