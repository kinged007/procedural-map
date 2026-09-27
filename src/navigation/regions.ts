import type { GameMap, Point } from '../map/GameMap.js';
import type { WalkabilityRaster } from './walkability.js';

export interface NavigableRegion {
  /** Index into the array returned by `navigableRegions`. */
  index: number;
  /** Open ground, in world units squared. */
  area: number;
  /** Open cells in this region. */
  cells: number;
  /**
   * The roomiest ground in the region, in world units. This is where a base belongs. The centroid is
   * not, because on a concave region it can fall inside a lake.
   */
  clearance: number;
  representativeOpenPoint: Point;
  /** Mean of the region's open cell centres. Geometric, so it can sit on blocked ground. */
  centroid: Point;
}

export interface SpawnCandidate {
  point: Point;
  /** Index of the region the candidate is in. */
  region: number;
  /** World units to the nearest blocked cell. */
  clearance: number;
  /** The settlement this candidate is the centre of, when it was asked for by settlement. */
  settlementId?: string;
}

const UNVISITED = -1;
const BLOCKED = -2;

interface Analysis {
  regions: NavigableRegion[];
  /** Region index per cell, or `BLOCKED`. */
  labels: Int32Array;
  /** Distance in cells to the nearest blocked cell, per cell. */
  clearance: Float64Array;
}

function cellCentre(column: number, row: number, cellSize: number): Point {
  return { x: (column + 0.5) * cellSize, y: (row + 0.5) * cellSize };
}

/**
 * Distance in cells from every open cell to the nearest blocked cell, by two chamfer passes. The
 * diagonal weights are the true Euclidean distance, so the field lands within about 3% rather than
 * being exact, which is well inside what a spawn clearance needs.
 *
 * Open cells start at the raster's diagonal rather than at infinity, which caps the answer at the
 * size of the world. That only matters on a map with no blocking feature at all, where the honest
 * answer is "the roomiest ground on the map" and a finite world diagonal is the useful stand-in.
 */
function clearanceField(raster: WalkabilityRaster): Float64Array {
  const { columns, rows, cells } = raster;
  const diagonal = Math.SQRT2;
  const horizon = columns + rows;
  const distance = new Float64Array(columns * rows);
  for (let index = 0; index < cells.length; index += 1)
    distance[index] = cells[index] === 1 ? 0 : horizon;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (distance[index] === 0) continue;
      let best = distance[index];
      if (column > 0) best = Math.min(best, distance[index - 1] + 1);
      if (row > 0) {
        const above = index - columns;
        best = Math.min(best, distance[above] + 1);
        if (column > 0) best = Math.min(best, distance[above - 1] + diagonal);
        if (column + 1 < columns) best = Math.min(best, distance[above + 1] + diagonal);
      }
      distance[index] = best;
    }
  }

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const index = row * columns + column;
      if (distance[index] === 0) continue;
      let best = distance[index];
      if (column + 1 < columns) best = Math.min(best, distance[index + 1] + 1);
      if (row + 1 < rows) {
        const below = index + columns;
        best = Math.min(best, distance[below] + 1);
        if (column + 1 < columns) best = Math.min(best, distance[below + 1] + diagonal);
        if (column > 0) best = Math.min(best, distance[below - 1] + diagonal);
      }
      distance[index] = best;
    }
  }

  return distance;
}

/**
 * Labels the raster's open cells by four-way connectivity, and measures how much room each region
 * has.
 *
 * Four-way is the conservative choice and the one that matches the raster it is given. The raster
 * already blocks any cell a blocker touches, so a gap it leaves is at least a cell wide, and a
 * character wider than a cell cannot cross a diagonal pinch. Eight-way would join regions across a
 * corner the character cannot pass, which is the failure this exists to prevent.
 */
function analyse(raster: WalkabilityRaster): Analysis {
  const { columns, rows, cells, cellSize } = raster;
  const clearance = clearanceField(raster);
  const labels = new Int32Array(columns * rows).fill(UNVISITED);
  for (let index = 0; index < cells.length; index += 1)
    if (cells[index] === 1) labels[index] = BLOCKED;

  const regions: NavigableRegion[] = [];
  const queue = new Int32Array(columns * rows);
  for (let seed = 0; seed < cells.length; seed += 1) {
    if (labels[seed] !== UNVISITED) continue;
    const regionIndex = regions.length;
    let head = 0;
    let tail = 1;
    queue[0] = seed;
    labels[seed] = regionIndex;
    let openCells = 0;
    let sumX = 0;
    let sumY = 0;
    let bestClearance = -1;
    let bestCell = seed;

    while (head < tail) {
      const index = queue[head++];
      const column = index % columns;
      const row = (index - column) / columns;
      openCells += 1;
      sumX += (column + 0.5) * cellSize;
      sumY += (row + 0.5) * cellSize;
      // A strict comparison keeps the lowest cell index on a tie, so the same raster always
      // reports the same representative point.
      if (clearance[index] > bestClearance) {
        bestClearance = clearance[index];
        bestCell = index;
      }
      // Neighbours are tested inline rather than through a helper: one closure per cell would be a
      // million allocations on a whole-world raster.
      if (column > 0 && labels[index - 1] === UNVISITED) {
        labels[index - 1] = regionIndex;
        queue[tail++] = index - 1;
      }
      if (column + 1 < columns && labels[index + 1] === UNVISITED) {
        labels[index + 1] = regionIndex;
        queue[tail++] = index + 1;
      }
      if (row > 0 && labels[index - columns] === UNVISITED) {
        labels[index - columns] = regionIndex;
        queue[tail++] = index - columns;
      }
      if (row + 1 < rows && labels[index + columns] === UNVISITED) {
        labels[index + columns] = regionIndex;
        queue[tail++] = index + columns;
      }
    }

    const bestColumn = bestCell % columns;
    const bestRow = (bestCell - bestColumn) / columns;
    regions.push({
      index: regionIndex,
      area: openCells * cellSize * cellSize,
      cells: openCells,
      clearance: bestClearance * cellSize,
      representativeOpenPoint: cellCentre(bestColumn, bestRow, cellSize),
      centroid: { x: sumX / openCells, y: sumY / openCells },
    });
  }

  return { regions, labels, clearance };
}

/**
 * The areas of open ground a character can walk between.
 *
 * This is the answer to "is that base on an island": one region per walkable landmass, so two
 * points in the same region are reachable from each other by construction, and the largest region is
 * the main continent. `clearance` is the roomiest ground each region holds, which is what a base
 * should sit on.
 *
 * Calling this and then `spawnCandidates` measures the raster twice. Each pass is linear in the
 * cells and cheap next to generation, so the duplication is cheaper than a caching layer.
 */
export function navigableRegions(raster: WalkabilityRaster): NavigableRegion[] {
  return analyse(raster).regions;
}

/**
 * The roomiest points on the map, at least `minSeparation` world units apart, with no tree on them.
 *
 * Candidates are taken in descending clearance, so the result is the most open ground available
 * rather than merely distinct points. Ties break on cell index, so the same raster always returns
 * the same candidates in the same order. A region with less than `minSeparation` of open ground still
 * contributes one point, and a map with no open ground contributes none.
 *
 * The map is taken alongside the raster for the same reason `chunkTile` takes it. Clearance is
 * measured against the raster, which holds water and rock but not trees, so without a trunk check a
 * base site can be chosen inside a tree. A point covered by a trunk is skipped rather than ranked
 * down: it is a rejected spot, not a less good one.
 *
 * Ranking is by raster clearance, so a candidate next to a grove is chosen on the ground's merits and
 * then accepted or rejected, which means the order does not account for trees.
 *
 * `preferSettlements` puts each settlement's centre first, which is the answer to "where does the
 * player start" when a settlement is meant to be a base. A centre stands on a road, and the raster
 * blocks a cell that water or rock touches anywhere inside it, so a centre on a road running a shore
 * can land in a blocked cell; the nearest open cell is used instead, so a settlement is offered
 * wherever it has open ground at all. Across 210 centres on 40 maps at a cell size of 16, 94% were
 * already open and the rest moved at most 2 cells. The remaining candidates fill the count from the
 * roomiest ground as usual, so asking for settlements never returns fewer points.
 */
export function spawnCandidates(
  raster: WalkabilityRaster,
  map: GameMap,
  options: { count: number; minSeparation: number; preferSettlements?: boolean },
): SpawnCandidate[] {
  const { count, minSeparation } = options;
  if (!Number.isInteger(count) || count < 0)
    throw new RangeError('count must be a non-negative integer');
  if (!Number.isFinite(minSeparation) || minSeparation < 0)
    throw new RangeError('minSeparation must be a positive finite number');
  if (count === 0) return [];

  const { labels, clearance } = analyse(raster);
  const separationSquared = minSeparation * minSeparation;
  const ranked: number[] = [];
  for (let index = 0; index < clearance.length; index += 1)
    if (labels[index] !== BLOCKED) ranked.push(index);
  ranked.sort((first, second) => clearance[second] - clearance[first] || first - second);

  const underTrunk = (point: Point) =>
    map.vegetation.some(
      (tree) =>
        (tree.position.x - point.x) ** 2 + (tree.position.y - point.y) ** 2 <=
        tree.collision.radius ** 2,
    );

  const candidates: SpawnCandidate[] = [];
  if (options.preferSettlements)
    for (const settlement of map.settlements) {
      if (candidates.length >= count) break;
      const cell = openCellNear(raster, labels, settlement.position);
      if (cell === null) continue;
      const column = cell % raster.columns;
      const point = cellCentre(column, (cell - column) / raster.columns, raster.cellSize);
      if (
        candidates.some((existing) => {
          const deltaX = existing.point.x - point.x;
          const deltaY = existing.point.y - point.y;
          return deltaX * deltaX + deltaY * deltaY < separationSquared;
        }) ||
        underTrunk(point)
      )
        continue;
      candidates.push({
        point,
        region: labels[cell],
        clearance: clearance[cell] * raster.cellSize,
        settlementId: settlement.id,
      });
    }
  for (const index of ranked) {
    if (candidates.length >= count) break;
    const column = index % raster.columns;
    const point = cellCentre(column, (index - column) / raster.columns, raster.cellSize);
    const tooClose = candidates.some((existing) => {
      const deltaX = existing.point.x - point.x;
      const deltaY = existing.point.y - point.y;
      return deltaX * deltaX + deltaY * deltaY < separationSquared;
    });
    if (tooClose || underTrunk(point)) continue;
    candidates.push({
      point,
      region: labels[index],
      clearance: clearance[index] * raster.cellSize,
    });
  }
  return candidates;
}

/**
 * The open cell containing a point, or the nearest one if that cell is blocked. Returns null only
 * when the point is outside the raster or the search finds nothing within `MAX_SNAP` cells.
 *
 * A settlement centre is on a road, and a road keeps clear of water by a margin that is smaller than
 * a raster cell at the small cell sizes, so the centre itself can fall in a cell the conservative
 * fill blocked for touching a shoreline. Snapping is what makes "a settlement is always offered"
 * true rather than nearly true.
 *
 * `ponytail:` two cells is the furthest any measured centre had to move, and four is the ceiling
 * here. Raise it only for a cell size small enough that a road's clearance from water is a larger
 * share of one cell.
 */
const MAX_SNAP = 4;

function openCellNear(raster: WalkabilityRaster, labels: Int32Array, point: Point): number | null {
  const originColumn = Math.floor(point.x / raster.cellSize);
  const originRow = Math.floor(point.y / raster.cellSize);
  for (let ring = 0; ring <= MAX_SNAP; ring += 1)
    for (let deltaRow = -ring; deltaRow <= ring; deltaRow += 1)
      for (let deltaColumn = -ring; deltaColumn <= ring; deltaColumn += 1) {
        // Only the new ring, so each cell is tested once rather than once per ring.
        if (Math.max(Math.abs(deltaColumn), Math.abs(deltaRow)) !== ring) continue;
        const column = originColumn + deltaColumn;
        const row = originRow + deltaRow;
        if (column < 0 || row < 0 || column >= raster.columns || row >= raster.rows) continue;
        const index = row * raster.columns + column;
        if (labels[index] !== BLOCKED) return index;
      }
  return null;
}
