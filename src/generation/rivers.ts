import type {
  Point,
  PolygonGeometry,
  RiverMouth,
  SpatialFields,
  WaterRegion,
} from '../map/GameMap.js';
import type { ResolvedGenerationConfig } from './GenerationConfig.js';
import { circleIntersectsPolygon, pointInPolygon } from '../map/geometry.js';
import { pathLength, roadRibbon, simplifyPath, smoothPath } from './ribbon.js';
import { ringIsSimple } from './terrain/Shoreline.js';

/** Rivers per stretch of the map's shorter side, and the ceiling on the total. */
const SOURCE_SPACING = 260;
const MAX_SOURCES = 8;

/** Field cells two sources have to be apart, so two rivers do not start on one hillside. */
const SOURCE_SEPARATION = 8;

/** How far down the ranked list of high ground the sources are spread over. */
const SOURCE_BAND = 8;

/**
 * Height the flood creeps upward by between two cells it has already covered. Without it, ground the
 * flood has just filled level is one queue key for every cell of it and the flood stalls instead of
 * crossing.
 */
const FLOOD_EPSILON = 1e-4;

/** Upper bound on the length of a course. A path through a flood tree cannot outrun the number of
 * cells, so this never fires: it is here so a change to the flood cannot leave a course unbounded. */
const MAX_STEPS = 600;

/**
 * How far past the shoreline a channel runs into standing water, in channel widths.
 *
 * Two is what puts the mouth inside the reach rather than at its end, and it is also the smallest
 * number that reads as a river arriving at a lake rather than a channel stopping at a bank. The
 * shoreline is a contour polyline, so the join is coarse: one width in and the channel's far corner
 * is still outside the water on a shallow shore.
 */
const MOUTH_REACH = 2;

/**
 * How far inside the map edge a river may be sourced, in world units.
 *
 * This is the band the water arrives over, and it is a band rather than a single ring so that a source
 * has a catchment behind it: a cell on the outermost ring has nothing draining into it and cannot
 * start a course. At 90 units on a 2048 by 1536 map the band holds about 45 cells, which is more
 * sources than the ten or so wanted and is what lets a source that cannot reach the edge be dropped.
 */
const SOURCE_BAND_UNITS = 90;

/**
 * How far into a rock a head may be carried past the face, in field cells.
 *
 * Three covers the widest channel the caller can ask for, so a head reaches inside the rock whatever
 * width the map is generated with. Past that the walk stops where it is, which is a spring at the edge
 * of a cliff with a wide river out of it rather than a river that starts in the grass.
 */
const ROCK_IN_WIDTHS = 3;

/** Shortest course published as a river, in world units. A shorter trace is a fold, not a river. */
/** Channel widths a course has to be at least for its reach to be a river rather than a fold. */
const MIN_LENGTH_IN_WIDTHS = 4;

/** Smoothing passes tried when a course still turns too sharply for its channel to close. */
const SMOOTHING_PASSES = 2;

/** Ring order of the eight neighbours. Fixed, so a tie between two equal neighbours resolves the same way every run. */
const NEIGHBOURS: [number, number][] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** World position of a field sample. The field grid spans the whole map, corner to corner. */
function cellCentre(index: number, config: ResolvedGenerationConfig, fields: SpatialFields): Point {
  const column = index % fields.columns;
  const row = (index - column) / fields.columns;
  return {
    x: (column * config.width) / (fields.columns - 1),
    y: (row * config.height) / (fields.rows - 1),
  };
}

/**
 * Carries a course's head on to the map edge, or as far as a rock face, whichever comes first.
 *
 * A course is traced from a divide, and a divide is the top of a catchment rather than the top of the
 * map, so on its own a head lands wherever the high ground happens to stop collecting water: in a
 * field, in the middle of the map, with the channel simply ceasing. That is a stripe rather than a
 * river. A river belongs to the country it drains, so on a map of a region its water arrives at the
 * edge of the region and leaves the other side — the whole course is inside this map's world
 * coordinates and the consumer tiles it, so a channel that runs off the edge is a channel that
 * continues in the next tile rather than one that stops.
 *
 * The head is carried uphill to the border, because the course descends from it and the source is
 * picked from a band inside the border, so the walk is short. Rock is the other place a river can
 * begin, a spring at the foot of a cliff, and the ascent stops there too.
 *
 * A head that reaches neither is dropped rather than published. Straight lines would satisfy the rule
 * and look wrong, and there is no need for them: the candidate list is eight times longer than the
 * number of rivers wanted, so a source that cannot reach the edge costs nothing.
 */
function extendHead(
  course: Point[],
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  rock: PolygonGeometry[],
): { course: Point[]; headEndsWell: boolean } {
  if (course.length === 0) return { course, headEndsWell: false };
  let index = cellAt(course[0], config, fields);
  const seen = new Set<number>([index]);
  // Built from the far end of the walk back down to the course's own head, so the cell that ends it is
  // pushed before the test rather than after. Stopping on the cell before the border leaves the head a
  // cell short of it, which is the difference between a river that runs off the map and one that
  // stops just short of it.
  const climbed: Point[] = [];
  let headEndsWell = false;
  let rockSteps = 0;
  for (let step = 0; step <= MAX_STEPS; step += 1) {
    const point = cellCentre(index, config, fields);
    climbed.push(point);
    if (onBorder(index, fields)) {
      headEndsWell = true;
      break;
    }
    const face = rock.find((candidate) => pointInPolygon(point, candidate));
    if (face) {
      headEndsWell = true;
      // A channel is a ribbon half a width to either side of the head, so a head stopped on the face
      // hangs off the rock by that much and reads as water starting in the grass beside it. The head
      // is carried on into the rock until the whole channel is inside, which is a cell or two, and
      // stops there. It marches towards the middle of the rock rather than up the hill, because there
      // is no higher ground inside a cliff to climb to and the walk would stop on the face. A spring
      // at a rock is not trying to leave the map, so nothing is snapped after this.
      if (insideWithRoom(point, face, config.rivers.width / 2)) break;
      if (rockSteps >= ROCK_IN_WIDTHS) break;
      rockSteps += 1;
      const inward = stepToward(index, ringMiddle(face), config, fields);
      if (inward < 0 || seen.has(inward)) break;
      seen.add(inward);
      index = inward;
      continue;
    }
    const next = steepestRise(index, fields, seen);
    if (next < 0) break;
    seen.add(next);
    index = next;
  }
  if (!headEndsWell) {
    const escape = borderCell(index, fields);
    if (escape < 0) return { course, headEndsWell };
    climbed.push(cellCentre(escape, config, fields));
    headEndsWell = true;
  }
  // The walk starts on the course's own head and climbs away from it, so `climbed` runs in that order
  // and its last point is the one the head has to be. It is reversed to run back down into the course,
  // and the cell the course already carries is dropped where the two are joined.
  const head = climbed[climbed.length - 1];
  return {
    course: [
      onRock(head, rock) ? head : snapToEdge(head, config, fields),
      ...climbed.slice(0, -1).reverse(),
      ...course,
    ],
    headEndsWell,
  };
}

/** The neighbour of `index` one step nearer a world point, or -1 where it is already on its cell. */
function stepToward(
  index: number,
  target: Point,
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
): number {
  const column = index % fields.columns;
  const row = (index - column) / fields.columns;
  const at = cellAt(target, config, fields);
  const targetColumn = at % fields.columns;
  const targetRow = (at - targetColumn) / fields.columns;
  const columnStep = Math.sign(targetColumn - column);
  const rowStep = Math.sign(targetRow - row);
  if (columnStep === 0 && rowStep === 0) return -1;
  return (row + rowStep) * fields.columns + (column + columnStep);
}

/**
 * Whether a circle of `radius` centred on a point lies wholly inside a polygon.
 *
 * Sampled rather than solved for, because the ring is a contour and the exact answer wants the medial
 * axis. Twelve points around the rim is enough to tell a head that is well clear of the edge from one
 * hanging off it, which is the only distinction being drawn.
 */
function insideWithRoom(point: Point, geometry: PolygonGeometry, radius: number): boolean {
  for (let step = 0; step < 12; step += 1) {
    const angle = (step / 12) * Math.PI * 2;
    const onRim = {
      x: point.x + Math.cos(angle) * radius,
      y: point.y + Math.sin(angle) * radius,
    };
    if (!pointInPolygon(onRim, geometry)) return false;
  }
  return true;
}

/** True when a point is inside a rock face, which is a place a head may start. */
function onRock(point: Point, rock: PolygonGeometry[]): boolean {
  return rock.some((face) => pointInPolygon(point, face));
}

/**
 * A head that reached the edge is pulled onto it.
 *
 * The walk ends on a cell, and cells are over 30 units across on a 2048 unit map, so a head can sit
 * most of a cell short of the border. The channel then stops a visible strip before the screen edge,
 * which is the thing this is here to prevent. Clamping the coordinate to the edge puts the head on it,
 * and the ribbon drawn from a head on the border is cut off by the border, which is what a channel
 * leaving the map looks like. A head on a rock face is left alone: rock is the other place a river can
 * begin, and it is not trying to leave the map.
 */
function snapToEdge(point: Point, config: ResolvedGenerationConfig, fields: SpatialFields): Point {
  const cellWidth = config.width / (fields.columns - 1);
  const cellHeight = config.height / (fields.rows - 1);
  return {
    x: point.x <= cellWidth ? 0 : point.x >= config.width - cellWidth ? config.width : point.x,
    y: point.y <= cellHeight ? 0 : point.y >= config.height - cellHeight ? config.height : point.y,
  };
}

/** The field cell a world point falls in, which is the inverse of `cellCentre`. */
function cellAt(point: Point, config: ResolvedGenerationConfig, fields: SpatialFields): number {
  const column = Math.round((point.x * (fields.columns - 1)) / config.width);
  const row = Math.round((point.y * (fields.rows - 1)) / config.height);
  return clamp(row, 0, fields.rows - 1) * fields.columns + clamp(column, 0, fields.columns - 1);
}

/** True when a cell is within `SOURCE_BAND_UNITS` of the map edge, which is where a river enters. */
function nearBorder(index: number, config: ResolvedGenerationConfig, fields: SpatialFields) {
  const column = index % fields.columns;
  const row = (index - column) / fields.columns;
  const x = (column * config.width) / (fields.columns - 1);
  const y = (row * config.height) / (fields.rows - 1);
  return Math.min(x, y, config.width - x, config.height - y) <= SOURCE_BAND_UNITS;
}

/** True when a cell is in the outermost ring of the field, which is the map edge itself. */
function onBorder(index: number, fields: SpatialFields): boolean {
  const column = index % fields.columns;
  const row = (index - column) / fields.columns;
  return column === 0 || row === 0 || column === fields.columns - 1 || row === fields.rows - 1;
}

/**
 * The centre of the outermost ring cell nearest `index`, or -1 where the cell is not near an edge.
 *
 * The field is a fixed 64 cells on a side whatever the map's size, so a cell on a 2048 unit map is over
 * 30 units across and a head that stops when the ground stops rising is a third of a channel's worth of
 * water short of the border, reading as a channel that ends just short of the screen. Where the walk
 * stalls against an edge it is carried the rest of the way in a straight line, and that line is at most
 * one cell long, which is the length that does not show.
 */
function borderCell(index: number, fields: SpatialFields): number {
  const column = index % fields.columns;
  const row = (index - column) / fields.columns;
  if (column <= 1) return row * fields.columns;
  if (row <= 1) return column;
  if (column >= fields.columns - 2) return row * fields.columns + fields.columns - 1;
  if (row >= fields.rows - 2) return (fields.rows - 1) * fields.columns + column;
  return -1;
}

/** The neighbour of `index` on the highest ground, or -1 where none is higher and still unvisited. */
function steepestRise(index: number, fields: SpatialFields, seen: Set<number>): number {
  const column = index % fields.columns;
  const row = (index - column) / fields.columns;
  let best = -1;
  let high = -Infinity;
  for (const [offsetColumn, offsetRow] of NEIGHBOURS) {
    const nextColumn = column + offsetColumn;
    const nextRow = row + offsetRow;
    if (nextColumn < 0 || nextRow < 0 || nextColumn >= fields.columns || nextRow >= fields.rows)
      continue;
    const candidate = nextRow * fields.columns + nextColumn;
    if (seen.has(candidate)) continue;
    if (fields.elevation[candidate] <= high) continue;
    high = fields.elevation[candidate];
    best = candidate;
  }
  return best;
}

/** Chebyshev distance between two cells, in cells. */
function cellDistance(a: number, b: number, columns: number): number {
  const columnA = a % columns;
  const rowA = (a - columnA) / columns;
  const columnB = b % columns;
  const rowB = (b - columnB) / columns;
  return Math.max(Math.abs(columnA - columnB), Math.abs(rowA - rowB));
}

/** The drainage of a field: where every cell's water goes, and in what order the flood reached it. */
interface Drainage {
  /** Ground with every pit raised to the level its water would have to reach to get out. */
  filled: Float64Array;
  /** The cell each one was reached from, or -1 for a cell on the map border, where water leaves. */
  parent: Int32Array;
  /** Cells in the order the flood reached them, so a parent always comes before its child. */
  order: number[];
  /** How many cells drain through each one, itself included. A child holds the whole catchment above
   * it, so the cell with the most flow in it is on the main channel of the map. */
  flow: Int32Array;
}

/**
 * Works out where the water of every cell goes, by flooding the map from its border.
 *
 * A descent over raw ground runs into the first hollow on a hillside and stops there, and a river that
 * ends in a bowl is a puddle. The flood starts at the border, where water leaves the world, and works
 * inward: a cell is raised to the lowest level already reached that touches it, which is the level its
 * water would have to reach to get out, and the cell that reached it becomes its parent.
 *
 * The parents form a tree pointing at the border, and that tree is the drainage. Following it needs no
 * search and no memory of where a course has been: a tree path cannot cross itself, cannot return to a
 * cell it has used, and always ends at the border. Ground the flood fills is raised a little above the
 * cell that filled it rather than level with it, so the flood keeps moving across a basin it has just
 * levelled.
 *
 * Each cell also counts what drains into it, which is what says where the main channel runs: a child
 * holds the entire catchment above it, and a parent holds everything its children hold. The count is
 * accumulated over the flood order in reverse, so a cell is only counted once its children are.
 *
 * The field grid is at most 64 by 64, so a flat array used as a binary heap is enough and a flood is
 * a few thousand pushes.
 */
function drainMap(elevation: number[], fields: SpatialFields): Drainage {
  const { columns, rows } = fields;
  const filled = Float64Array.from(elevation);
  const parent = new Int32Array(elevation.length).fill(-1);
  const closed = new Uint8Array(elevation.length);
  const order: number[] = [];
  const heap: { index: number; priority: number }[] = [];

  const push = (index: number, priority: number) => {
    heap.push({ index, priority });
    for (let child = heap.length - 1; child > 0;) {
      const above = (child - 1) >> 1;
      if (heap[above].priority <= heap[child].priority) break;
      [heap[above], heap[child]] = [heap[child], heap[above]];
      child = above;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let parentIndex = 0; ;) {
        const left = parentIndex * 2 + 1;
        const right = left + 1;
        let smaller = parentIndex;
        if (left < heap.length && heap[left].priority < heap[smaller].priority) smaller = left;
        if (right < heap.length && heap[right].priority < heap[smaller].priority) smaller = right;
        if (smaller === parentIndex) break;
        [heap[parentIndex], heap[smaller]] = [heap[smaller], heap[parentIndex]];
        parentIndex = smaller;
      }
    }
    return top;
  };

  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (row > 0 && row < rows - 1 && column > 0 && column < columns - 1) continue;
      closed[index] = 1;
      order.push(index);
      push(index, filled[index]);
    }

  while (heap.length > 0) {
    const { index, priority } = pop();
    const column = index % columns;
    const row = (index - column) / columns;
    for (const [offsetColumn, offsetRow] of NEIGHBOURS) {
      const candidateColumn = column + offsetColumn;
      const candidateRow = row + offsetRow;
      if (
        candidateColumn < 0 ||
        candidateRow < 0 ||
        candidateColumn >= columns ||
        candidateRow >= rows
      )
        continue;
      const candidate = candidateRow * columns + candidateColumn;
      if (closed[candidate]) continue;
      closed[candidate] = 1;
      order.push(candidate);
      parent[candidate] = index;
      if (filled[candidate] < priority) filled[candidate] = priority + FLOOD_EPSILON;
      push(candidate, filled[candidate] + FLOOD_EPSILON);
    }
  }
  const flow = new Int32Array(elevation.length).fill(1);
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const cell = order[index];
    if (parent[cell] >= 0) flow[parent[cell]] += flow[cell];
  }
  return { filled, parent, order, flow };
}

/** The neighbour of `index` with the most water draining into it, or -1 where the ground divides. */
function mainChild(index: number, fields: SpatialFields, drainage: Drainage): number {
  const column = index % fields.columns;
  const row = (index - column) / fields.columns;
  let best = -1;
  let most = 0;
  for (const [offsetColumn, offsetRow] of NEIGHBOURS) {
    const nextColumn = column + offsetColumn;
    const nextRow = row + offsetRow;
    if (nextColumn < 0 || nextRow < 0 || nextColumn >= fields.columns || nextRow >= fields.rows)
      continue;
    const candidate = nextRow * fields.columns + nextColumn;
    if (drainage.parent[candidate] !== index) continue;
    if (drainage.flow[candidate] <= most) continue;
    most = drainage.flow[candidate];
    best = candidate;
  }
  return best;
}

/**
 * Traces the main channel of the catchment a cell sits in.
 *
 * Upstream, the course follows the child with the most water draining into it, which is the head of
 * the channel and ends where the ground divides rather than in a bowl. Downstream it follows parents,
 * which lead to the water.
 *
 * Both legs walk the tree, so a course cannot cross itself and cannot return to a cell it has used.
 * The two legs are returned separately because a course is one reach: the head runs from the divide
 * down to the source, and the tail from the source down to the water, and a course is the two joined
 * in that order. Neither leg stops at the water itself: a test on the raw elevation would end a
 * course at a proxy the contoured shoreline does not agree with, which leaves a channel stopping in
 * the field short of the water. `cutAtWater` is the only place a course ends.
 */
function traceCourse(
  source: number,
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  drainage: Drainage,
): Point[] {
  const head: Point[] = [];
  for (let index = source, step = 0; step < MAX_STEPS; step += 1) {
    head.push(cellCentre(index, config, fields));
    const child = mainChild(index, fields, drainage);
    if (child < 0) break;
    index = child;
  }
  head.reverse();
  const tail: Point[] = [];
  for (let index = drainage.parent[source], step = 0; step < MAX_STEPS; step += 1) {
    if (index < 0) break;
    tail.push(cellCentre(index, config, fields));
    index = drainage.parent[index];
  }
  return [...head, ...tail];
}

/**
 * Cuts a course short where it runs into standing water, and reports the crossing as a mouth.
 *
 * A river does not run across a lake: its water is the lake's water from the shore onward. The flood
 * that builds the drainage fills every pit, and a course descending into a filled basin follows its
 * shore, so without this a channel is drawn along a lake and sometimes straight across one, which
 * reads as a river floating on the sea. The course is cut at the shore and the site is published, so
 * the reach where the water widens is a mouth a consumer can put its own asset on.
 *
 * The course is cut where the channel reaches the water, not where its centreline does: the channel is
 * the centreline offset to each side, so a course running along a shore reaches the water half a
 * channel before its centreline does, and a centreline test leaves that whole reach lying in the lake.
 *
 * The end is then slid onto the shore. The channel is the centreline offset to each side, so an end
 * left where the channel's edge merely touches the water leaves up to a whole step of the course
 * between the two bodies of it, which reads as a river that stops in the field short of the lake.
 * Ending on the shore overlaps them by half a channel, which is what a mouth is: the channel widens
 * where it meets standing water, and the delta marker sits over the join. A course that starts in the
 * water is not a river at all and is dropped.
 */
function cutAtWater(
  course: Point[],
  lakes: WaterRegion[],
  width: number,
): { course: Point[]; mouth?: RiverMouth } {
  const reaches = (point: Point, lake: WaterRegion) =>
    circleIntersectsPolygon(point, width / 2, lake.geometry);
  const waterAt = (point: Point) => lakes.find((lake) => reaches(point, lake));
  if (waterAt(course[0])) return { course: [] };
  for (let index = 1; index < course.length; index += 1) {
    const lake = waterAt(course[index]);
    if (!lake) continue;
    const land = course[index - 1];
    const wet = course[index];
    const share = nearestShare(land, wet, lake, width / 2);
    const touch = { x: land.x + (wet.x - land.x) * share, y: land.y + (wet.y - land.y) * share };
    const shore = nearestOnRing(touch, lake.geometry);
    // The channel carries on past the shoreline instead of stopping on it, so the river arrives at the
    // water rather than being cut off at the bank. A mouth drawn on the shoreline sat at the very end
    // of the reach, which is the one place in the picture where the river is not yet in the river.
    // The reach is in channel widths because that is the scale the mouth is published at, and it stops
    // where the water stops, so a river entering a narrow bay does not run out the far side of it and
    // leave a channel in the field beyond.
    const flow = { x: shore.x - land.x, y: shore.y - land.y };
    const flowLength = Math.hypot(flow.x, flow.y) || 1;
    let end = shore;
    const extended = [...course.slice(0, index), shore];
    for (let step = 0; step < MOUTH_REACH; step += 1) {
      const next = {
        x: end.x + (flow.x / flowLength) * width,
        y: end.y + (flow.y / flowLength) * width,
      };
      // The step has to land in the water, not merely near it. The cut above tests a reach, because a
      // channel is a ribbon and a ribbon touches a lake before its centreline does, but a mouth is a
      // single point the consumer reads as being in the lake, and a course that arrives along a shore
      // keeps going along it past the bank. A reach test would walk that tangent out onto the grass
      // and publish the mouth there.
      if (!pointInPolygon(next, lake.geometry)) break;
      extended.push(next);
      end = next;
    }
    if (extended.length === course.slice(0, index).length + 1) {
      // The shore is too shallow for even one step this way in, so the mouth is set a quarter width
      // from the bank towards the middle of the lake, which is inside the water and still at its edge.
      const middle = ringMiddle(lake.geometry);
      const inward = { x: middle.x - shore.x, y: middle.y - shore.y };
      const inwardLength = Math.hypot(inward.x, inward.y) || 1;
      end = {
        x: shore.x + (inward.x / inwardLength) * (width / 4),
        y: shore.y + (inward.y / inwardLength) * (width / 4),
      };
      extended.push(end);
    }
    return {
      course: extended,
      mouth: {
        waterId: lake.id,
        point: end,
        polygon: mouthPatch(end, extended[extended.length - 2] ?? land, width),
      },
    };
  }
  return { course };
}

/** The mean of a ring's vertices, which on a contour is a point inside the water it bounds. */
function ringMiddle(geometry: PolygonGeometry): Point {
  let x = 0;
  let y = 0;
  for (const point of geometry.points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / geometry.points.length, y: y / geometry.points.length };
}

/** The point of a ring nearest a point, which on a dense contour is the shore itself. */
function nearestOnRing(point: Point, geometry: PolygonGeometry): Point {
  let nearest = geometry.points[0];
  let closest = Infinity;
  for (const vertex of geometry.points) {
    const squared = (vertex.x - point.x) ** 2 + (vertex.y - point.y) ** 2;
    if (squared < closest) {
      closest = squared;
      nearest = vertex;
    }
  }
  return nearest;
}

/**
 * How far along a step the water of `water` first reaches a channel of half-width `reach`, as a share
 * of the step.
 *
 * Found by bisection on the reach test rather than by intersecting the shoreline, because the reach
 * test is the one thing already known to agree with the polygons: a channel is in the water when the
 * ring of the water is within half a width of it. Twelve halvings put the point within a hundredth of
 * a world unit at map scale.
 */
function nearestShare(land: Point, wet: Point, water: WaterRegion, reach: number): number {
  let low = 0;
  let high = 1;
  for (let pass = 0; pass < 12; pass += 1) {
    const middle = (low + high) / 2;
    const inside = circleIntersectsPolygon(
      { x: land.x + (wet.x - land.x) * middle, y: land.y + (wet.y - land.y) * middle },
      reach,
      water.geometry,
    );
    if (inside) high = middle;
    else low = middle;
  }
  return high;
}

/**
 * A marker the size of the channel across at a mouth: as wide as the river, and as long again along
 * the flow, so an asset placed on it is scaled by the river it belongs to. It carries no collision and
 * nothing is drawn on it by the format; it is a site a consumer can hang an asset on.
 */
function mouthPatch(point: Point, upstream: Point, width: number): PolygonGeometry {
  const dx = point.x - upstream.x;
  const dy = point.y - upstream.y;
  const length = Math.hypot(dx, dy) || width;
  // Half the channel along the flow and the same again across it, so the marker is a square as wide
  // as the river is.
  const alongX = (dx / length) * (width / 2);
  const alongY = (dy / length) * (width / 2);
  const acrossX = -alongY;
  const acrossY = alongX;
  const corner = (along: number, across: number) => ({
    x: point.x + alongX * along + acrossX * across,
    y: point.y + alongY * along + acrossY * across,
  });
  return { points: [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)] };
}

/**
 * One pass of a three-point moving average along a course. The endpoints stay put, and a staircase of
 * grid steps becomes the meander a river draws, which also opens up the corners the descent turns too
 * sharply on.
 */
function smooth(course: Point[]): Point[] {
  if (course.length < 3) return [...course];
  const smoothed: Point[] = [course[0]];
  for (let index = 1; index < course.length - 1; index += 1)
    smoothed.push({
      x: (course[index - 1].x + course[index].x * 2 + course[index + 1].x) / 4,
      y: (course[index - 1].y + course[index].y * 2 + course[index + 1].y) / 4,
    });
  smoothed.push(course[course.length - 1]);
  return smoothed;
}

/**
 * The water surface of a course: the centreline offset to each side, held inside the map.
 *
 * A course is allowed to run to the map edge, so the offset can leave it. The overhanging points are
 * clamped back in, and points that land on top of each other are dropped, because a ring may not
 * repeat a point. Returns null when the channel does not close on itself, which a turn sharper than
 * the channel is wide produces.
 */
function channel(course: Point[], config: ResolvedGenerationConfig): PolygonGeometry | null {
  const ribbon = roadRibbon(course, config.rivers.width);
  if (!ribbon) return null;
  const points: Point[] = [];
  for (const point of ribbon.points) {
    const clamped = {
      x: clamp(point.x, 0, config.width),
      y: clamp(point.y, 0, config.height),
    };
    const previous = points[points.length - 1];
    if (previous && previous.x === clamped.x && previous.y === clamped.y) continue;
    points.push(clamped);
  }
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first.x === last.x && first.y === last.y) return null;
  if (!ringIsSimple(points)) return null;
  return { points };
}

/**
 * Turns a course into a channel surface, or returns null when it is not a river.
 *
 * A course shorter than a few channel widths is a fold on a hillside rather than a river, and one that
 * turns more sharply than the channel is wide gives a ring that does not close on itself, so it is
 * eased and retried before it is dropped.
 */
function buildChannel(course: Point[], config: ResolvedGenerationConfig): PolygonGeometry | null {
  let smoothed = simplifyPath(course);
  if (pathLength(smoothed) < config.rivers.width * MIN_LENGTH_IN_WIDTHS) return null;
  for (let pass = 0; pass < SMOOTHING_PASSES; pass += 1) {
    const geometry = channel(smoothed, config);
    if (geometry) return geometry;
    smoothed = smooth(smoothed);
  }
  return null;
}

/**
 * Cuts a course short where it runs into a river that is already on the map.
 *
 * Two courses in one catchment share their lower half, because the water in both ends up in the same
 * place. The longer course is published and the shorter joins it: the reach below the junction belongs
 * to the river that is already there. The cut keeps the point that is inside the junction, so the two
 * channels meet rather than stopping a cell apart.
 */
function joinedAt(course: Point[], rivers: WaterRegion[]): Point[] {
  for (let index = 0; index < course.length; index += 1)
    if (rivers.some((river) => pointInPolygon(course[index], river.geometry)))
      return course.slice(0, index + 1);
  return course;
}

/**
 * Traces the map's rivers.
 *
 * A river is the main channel of a catchment, which is the course through the cells with the most water
 * draining into them: up the largest tributary to where the ground divides, then down to the water. The
 * shortest path out of a hill is not a river, and tracing it gives rivers a few hundred units long
 * wherever that happens to fall, so the length comes from the flow instead. Lakes are contoured from
 * the same field, so a river ends where a lake begins and the two do not compete for the same ground.
 *
 * Courses are taken longest first, and a course that would lie on a river already published is cut at
 * the junction and published as the tributary it really is.
 *
 * `ponytail:` the flood reads the tile's own field grid, so a river on a tiled world is traced per tile
 * and the two sides of a seam do not join up. Stitch the courses across the seam when a consumer
 * assembles a world and wants one continuous river; the same caveat already applies to lake contours.
 */
export function generateRivers(
  config: ResolvedGenerationConfig,
  fields: SpatialFields,
  level: number | null,
  lakes: WaterRegion[],
  rock: PolygonGeometry[],
): WaterRegion[] {
  // A fully flooded map is one lake, a dry map has no waterline to drain towards, and a map asked for
  // no rivers at all has none.
  if (level === null || config.water.amount === 1 || config.rivers.density === 0) return [];
  const { columns, elevation } = fields;
  const width = config.rivers.width;
  const drainage = drainMap(elevation, fields);
  // Sources are the cells with the most water draining through them, ranked by that flow and then by
  // cell order, so one field always gives the same ones. They are taken from a band inside the map edge
  // rather than from anywhere: a river on a map of a region drains through that region, so its water
  // arrives over the edge and `extendHead` carries the head out to it. Sourcing from the middle instead
  // left every head standing on a divide in a field, which is where the channel used to cease.
  const ranked = Array.from({ length: elevation.length }, (_, index) => index)
    .filter(
      (index) =>
        drainage.parent[index] >= 0 &&
        drainage.flow[index] > 1 &&
        nearBorder(index, config, fields),
    )
    .sort((first, second) => drainage.flow[second] - drainage.flow[first] || first - second);
  const wanted = Math.min(
    MAX_SOURCES,
    Math.round((Math.min(config.width, config.height) / SOURCE_SPACING) * config.rivers.density),
  );
  if (wanted < 1) return [];
  // Candidates are spread across the ranking by rank rather than by position, so two rivers start in
  // different parts of the map rather than on one channel. There are more candidates than rivers
  // wanted, because most of them turn out to be a reach of one that is longer.
  const candidateCount = Math.min(ranked.length, wanted * SOURCE_BAND);
  const candidates: number[] = [];
  for (let index = 0; index < candidateCount; index += 1) {
    const source = ranked[Math.floor((index * ranked.length) / candidateCount)];
    if (candidates.every((taken) => cellDistance(taken, source, columns) >= SOURCE_SEPARATION))
      candidates.push(source);
  }

  const traces = candidates
    .map((source) => traceCourse(source, config, fields, drainage))
    // The head is carried past the divide to the map edge or a rock before anything is curved, because
    // the ascent is a staircase of grid cells and it is the curve that turns it back into a channel.
    // A course whose head reaches neither is dropped: see `extendHead`.
    .map((course) => extendHead(course, config, fields, rock))
    .filter((head) => head.headEndsWell)
    .map((head) => head.course)
    // The course is curved before it is cut, not after: a course is a staircase of grid cells, and
    // cutting the water out of a staircase and then curving it would move the cut end off the
    // shoreline it was found on. Curving first leaves the end exactly where the shoreline is, and
    // `buildChannel` thins the curve back down when it offsets the channel. `smoothPath` pins both
    // ends, so the head still finishes on the border or the rock it was carried to.
    .map((course) => smoothPath(course))
    // A course is cut at the water it reaches, which is at its downstream end: the head is high
    // ground, so the cut is the tail's end, and everything beyond it is water the lake already covers.
    .map((course) => ({ ...cutAtWater(course, lakes, width), length: pathLength(course) }))
    // Longest first, so a course that would be a reach of a longer one is cut back to a tributary
    // rather than taking the channel away from the river it belongs to.
    .sort((first, second) => second.length - first.length);

  const rivers: WaterRegion[] = [];
  for (const { course, mouth } of traces) {
    if (rivers.length >= wanted) break;
    const geometry = buildChannel(joinedAt(course, rivers), config);
    if (!geometry) continue;
    rivers.push({
      id: `river-${rivers.length + 1}`,
      type: 'water',
      kind: 'river',
      geometry,
      collision: { type: 'polygon', ...geometry },
      asset: { category: 'water.river', variant: 'river-1' },
      ...(mouth ? { metadata: { mouths: [mouth] } } : {}),
    });
  }
  return rivers;
}
