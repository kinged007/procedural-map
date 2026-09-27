import type { GameMap, Point, PolygonGeometry } from '../map/GameMap.js';
import { boundsOf } from '../map/geometry.js';

export interface WalkabilityRaster {
  /** Side length of one square cell, in world units. */
  cellSize: number;
  columns: number;
  rows: number;
  /** Row-major, one byte per cell. 0 is open, 1 is blocked. */
  cells: Uint8Array;
}

interface RingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function boxOf(ring: Point[]): RingBox {
  const box: RingBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const point of ring) {
    if (point.x < box.minX) box.minX = point.x;
    if (point.x > box.maxX) box.maxX = point.x;
    if (point.y < box.minY) box.minY = point.y;
    if (point.y > box.maxY) box.maxY = point.y;
  }
  return box;
}

const EPSILON = 1e-9;

/**
 * Rounds a coordinate that lands on a cell boundary to that boundary exactly.
 *
 * A crossing is interpolated along an edge, so one that should land on `320` can come out as
 * `320.00000000000006`. Under a fill rule that blocks a cell the blocker merely touches, that one
 * unit in the last place reaches into a cell on the far side and blocks it, which is a cell of
 * walkable island that the map says is lake. Snapping costs one comparison per crossing and leaves
 * every crossing more than EPSILON away from a boundary untouched.
 */
function snapToCellBoundary(value: number, cellSize: number): number {
  const boundary = Math.round(value / cellSize) * cellSize;
  return Math.abs(value - boundary) <= EPSILON ? boundary : value;
}

/**
 * Writes every cell the span crosses, clipped to the scratch row. The span is dilated to whole
 * cells so a cell the blocker only clips is still blocked.
 *
 * `toggle` applies the even-odd rule, which is how a hole cancels the outer ring around it. It is
 * only safe where the spans cannot overlap; where they can, the caller sets instead of toggling.
 */
function fillSpan(
  scratch: Uint8Array,
  span: number,
  minColumn: number,
  offset: number,
  fromX: number,
  toX: number,
  cellSize: number,
  toggle: boolean,
): void {
  const first = Math.floor(snapToCellBoundary(fromX, cellSize) / cellSize) - minColumn;
  const last = Math.ceil(snapToCellBoundary(toX, cellSize) / cellSize) - 1 - minColumn;
  if (last < 0 || first > span - 1) return;
  const start = first < 0 ? 0 : first;
  const end = last > span - 1 ? span - 1 : last;
  if (toggle) for (let column = start; column <= end; column += 1) scratch[offset + column] ^= 1;
  else for (let column = start; column <= end; column += 1) scratch[offset + column] = 1;
}

/** Pairs one scanline's sorted crossings into spans and writes them into the row. */
function fillScanline(
  bucket: number[],
  scratch: Uint8Array,
  span: number,
  minColumn: number,
  offset: number,
  cellSize: number,
  toggle: boolean,
): void {
  if (bucket.length < 2) return;
  bucket.sort((first, second) => first - second);
  for (let index = 0; index + 1 < bucket.length; index += 2)
    fillSpan(scratch, span, minColumn, offset, bucket[index], bucket[index + 1], cellSize, toggle);
}

/** Water and rock, by the same rule the map already states: a blocking feature carries collision. */
function blockersOf(map: GameMap): PolygonGeometry[] {
  return [
    ...map.water.map((lake) => lake.collision),
    ...map.terrain.flatMap((region) => (region.collision ? [region.collision] : [])),
  ];
}

/**
 * Rasterises the map's water and rock into an open/blocked grid.
 *
 * A cell is blocked if any part of it is covered by a water polygon or a rock region, so a cell the
 * blocker merely clips is blocked. That is deliberately conservative: it can mark a cell blocked
 * whose centre is open, and never the reverse, so a movement check driven by the raster can never
 * step into a lake. Two consequences follow from the same rule. A beach drawn over rock is still
 * blocked, because the rock is still there. And `cellSize` is the caller's choice, so a game can
 * bake at exactly its own tile size.
 *
 * Rings are paired per scanline rather than per cell, which is the whole cost model: the work is
 * proportional to the edge crossings, not to the area. Testing every cell against every polygon
 * instead is about a hundred times slower on a whole-world bake.
 *
 * A row is the union of its two boundary scanlines, which is exact while the ring's edges cross them.
 * An edge running horizontally through the middle of a row is the one case that is not, and it widens
 * the row across the edge, so the raster can block a cell whose centre is open but never the reverse.
 */
export function rasterizeWalkability(
  map: GameMap,
  options: { cellSize: number },
): WalkabilityRaster {
  const cellSize = options.cellSize;
  if (!Number.isFinite(cellSize) || cellSize <= 0)
    throw new RangeError('cellSize must be a positive finite number');

  const columns = Math.max(1, Math.ceil(map.bounds.width / cellSize));
  const rows = Math.max(1, Math.ceil(map.bounds.height / cellSize));
  const cells = new Uint8Array(columns * rows);
  // One bucket of edge crossings per scanline, and one scratch tile per polygon, both reused across
  // the map so a bake allocates in proportion to the raster rather than the geometry. There is one
  // more scanline than rows because the line at the map's bottom edge still bounds the last row.
  //
  // Buckets are indexed by scanline and not by row side on purpose. The line at a row's bottom edge
  // is the same line as the next row's top edge, so a row that owned its own copy would have to be
  // told about crossings twice, and getting that wrong leaves the row with an odd crossing count
  // that pairs into nothing. The row reads its two boundaries out of this one array instead.
  const scanlines: number[][] = Array.from({ length: rows + 1 }, () => []);
  // The x-spans of the ring's own horizontal edges, per row. An edge lying inside a row is a boundary
  // the row's two scanlines never see, so the row is widened across the edge to stay conservative.
  const across: number[][] = Array.from({ length: rows }, () => []);
  let scratch = new Uint8Array(0);

  for (const geometry of blockersOf(map)) {
    const rings = [geometry.points, ...(geometry.holes ?? [])];
    const boxes = rings.map(boxOf);
    const box = boxes.reduce(
      (total, current) => ({
        minX: Math.min(total.minX, current.minX),
        maxX: Math.max(total.maxX, current.maxX),
        minY: Math.min(total.minY, current.minY),
        maxY: Math.max(total.maxY, current.maxY),
      }),
      boxes[0],
    );
    const minColumn = Math.max(0, Math.floor(box.minX / cellSize));
    const maxColumn = Math.min(columns - 1, Math.floor(box.maxX / cellSize));
    const minRow = Math.max(0, Math.floor(box.minY / cellSize));
    const maxRow = Math.min(rows - 1, Math.floor(box.maxY / cellSize));
    if (maxColumn < minColumn || maxRow < minRow) continue;

    const span = maxColumn - minColumn + 1;
    const depth = maxRow - minRow + 1;
    const area = span * depth;
    if (scratch.length < area) scratch = new Uint8Array(area);
    else scratch.fill(0, 0, area);
    for (let row = minRow; row <= maxRow + 1; row += 1) scanlines[row].length = 0;
    for (let row = minRow; row <= maxRow; row += 1) across[row].length = 0;

    // Every edge is walked once, bucketing its intersection with each scanline boundary it reaches.
    for (let ring = 0; ring < rings.length; ring += 1) {
      const points = rings[ring];
      for (let index = 0; index < points.length; index += 1) {
        const a = points[index];
        const b = points[index + 1 === points.length ? 0 : index + 1];
        const low = a.y < b.y ? a.y : b.y;
        const high = a.y < b.y ? b.y : a.y;
        // An edge that lies inside one row is a step in the ring that no scanline crosses, because it
        // starts and ends between the same pair of boundaries. The shape is wider in the middle of the
        // row than at either edge of it, so the row is widened across the edge. This costs at most one
        // row of cells per edge and cannot leave a covered cell open, which is the one direction the
        // raster is allowed to be wrong in. An edge that reaches a row boundary needs nothing: it
        // crosses that boundary and is counted there.
        const acrossRow = Math.floor(low / cellSize);
        if (low > acrossRow * cellSize && high < (acrossRow + 1) * cellSize) {
          if (acrossRow >= minRow && acrossRow <= maxRow)
            across[acrossRow].push(Math.min(a.x, b.x), Math.max(a.x, b.x));
          continue;
        }
        const firstRow = Math.max(minRow, Math.floor(low / cellSize));
        const lastRow = Math.min(maxRow, Math.floor(high / cellSize));
        if (firstRow > lastRow) continue;
        const slope = (b.x - a.x) / (b.y - a.y);
        // Every scanline in [low, high) is crossed, half-open so a vertex shared by two edges is
        // counted once and each scanline of a closed ring gets an even number of crossings.
        const firstScan = Math.max(0, Math.ceil(low / cellSize));
        const lastScan = Math.min(rows, Math.ceil(high / cellSize) - 1);
        for (let scan = firstScan; scan <= lastScan; scan += 1)
          scanlines[scan].push(a.x + (scan * cellSize - a.y) * slope);
      }
    }

    for (let row = minRow; row <= maxRow; row += 1) {
      const offset = (row - minRow) * span;
      const top = row * cellSize;

      // A ring strictly inside the row is cut by neither boundary, so it contributes no crossings
      // and would vanish. It is filled from its own box instead, toggled so a hole sharing the row
      // still cancels, and done before the scanlines so the scanlines union over it. The test is
      // strict because a ring that touches a boundary is already counted by that scanline, and
      // filling it twice would toggle the cell back to open.
      for (let ring = 0; ring < rings.length; ring += 1) {
        if (boxes[ring].minY <= top || boxes[ring].maxY >= top + cellSize) continue;
        fillSpan(
          scratch,
          span,
          minColumn,
          offset,
          boxes[ring].minX,
          boxes[ring].maxX,
          cellSize,
          true,
        );
      }

      // The row's two boundaries are paired as two separate scanlines. Merging their crossings
      // first would pair a left edge from one against a right edge from the other and leave the
      // middle of the row unfilled, which is how a wide lake turns into a pair of thin slivers.
      // The first toggles so its own holes cancel; the second sets, because the two spans overlap
      // almost everywhere and the row needs their union.
      fillScanline(scanlines[row], scratch, span, minColumn, offset, cellSize, true);
      fillScanline(scanlines[row + 1], scratch, span, minColumn, offset, cellSize, false);
      for (let index = 0; index + 1 < across[row].length; index += 2)
        fillSpan(
          scratch,
          span,
          minColumn,
          offset,
          across[row][index],
          across[row][index + 1],
          cellSize,
          false,
        );
    }

    for (let row = 0; row < depth; row += 1) {
      const source = row * span;
      const target = (minRow + row) * columns + minColumn;
      for (let column = 0; column < span; column += 1)
        if (scratch[source + column]) cells[target + column] = 1;
    }
  }

  return { cellSize, columns, rows, cells };
}

/**
 * Bakes one chunk of the read path: the raster cells the chunk covers, with tree trunks marked on
 * top. A chunk outside the raster is entirely blocked, so a character cannot walk off the map.
 *
 * Trees are resolved here rather than baked into the raster because a trunk blocks one small circle
 * while a grove blocks a small circle inside a large hull. Baking the hull would seal the clearings a
 * player is meant to walk through.
 *
 * The grove hulls are the broadphase. A chunk tests each forest's bounds box and then only walks the
 * trunks of the forests that actually meet it, so the cost follows the wood near the chunk rather
 * than the number of trees on the map: on a 4096x4096 map at the 8,000 tree ceiling, a 32-world-unit
 * chunk bakes in 0.045ms against 0.29ms scanning every tree.
 *
 * `ponytail:` the grove bounds are scanned as a flat list, so a bake costs one bounds test per grove
 * and follows the grove count, 266 on that map, not the tree count. Index the bounds into a uniform
 * grid when a bake ever has to fit in a frame budget; at 0.045ms it does not.
 */
export function chunkTile(
  raster: WalkabilityRaster,
  map: GameMap,
  chunkX: number,
  chunkY: number,
  options: { chunkSize: number },
): Uint8Array {
  const chunkSize = options.chunkSize;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0)
    throw new RangeError('chunkSize must be a positive integer');
  const cells = new Uint8Array(chunkSize * chunkSize).fill(1);
  const baseX = chunkX * chunkSize;
  const baseY = chunkY * chunkSize;

  for (let y = 0; y < chunkSize; y += 1) {
    const sourceRow = baseY + y;
    if (sourceRow < 0 || sourceRow >= raster.rows) continue;
    for (let x = 0; x < chunkSize; x += 1) {
      const sourceColumn = baseX + x;
      if (sourceColumn < 0 || sourceColumn >= raster.columns) continue;
      cells[y * chunkSize + x] = raster.cells[sourceRow * raster.columns + sourceColumn];
    }
  }

  const chunkMinX = baseX * raster.cellSize;
  const chunkMinY = baseY * raster.cellSize;
  const chunkMaxX = chunkMinX + chunkSize * raster.cellSize;
  const chunkMaxY = chunkMinY + chunkSize * raster.cellSize;

  for (const forest of map.forests) {
    const box = boundsOf(forest.geometry.points);
    if (box.maxX < chunkMinX || box.minX > chunkMaxX) continue;
    if (box.maxY < chunkMinY || box.minY > chunkMaxY) continue;
    for (const tree of forest.trees) {
      const { center, radius } = tree.collision;
      const firstColumn = Math.floor((center.x - radius) / raster.cellSize) - baseX;
      const lastColumn = Math.ceil((center.x + radius) / raster.cellSize) - 1 - baseX;
      const firstRow = Math.floor((center.y - radius) / raster.cellSize) - baseY;
      const lastRow = Math.ceil((center.y + radius) / raster.cellSize) - 1 - baseY;
      for (let y = Math.max(0, firstRow); y <= Math.min(chunkSize - 1, lastRow); y += 1)
        for (let x = Math.max(0, firstColumn); x <= Math.min(chunkSize - 1, lastColumn); x += 1)
          cells[y * chunkSize + x] = 1;
    }
  }

  return cells;
}
