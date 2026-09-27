import type { Point, PolygonGeometry } from '../map/GameMap.js';
import { pointInPolygon } from '../map/geometry.js';

export type GridPoint = { x: number; y: number };
export type Segment = [GridPoint, GridPoint];

/**
 * Marching-squares contour of every cell whose corner values are at or below `level`.
 * The outer ring of the grid counts as dry so that every contour closes on itself, because ring
 * tracing discards an open chain. A caller that wants water to reach the edge pads the grid first,
 * so this rule lands on the padding and the real border keeps its own values.
 */
export function contourSegments(
  columns: number,
  rows: number,
  values: number[],
  level: number,
): Segment[] {
  const segments: Segment[] = [];
  const edgePoint = (column: number, row: number, edge: number): GridPoint => {
    if (edge === 0) return { x: column * 2 + 1, y: row * 2 };
    if (edge === 1) return { x: column * 2 + 2, y: row * 2 + 1 };
    if (edge === 2) return { x: column * 2 + 1, y: row * 2 + 2 };
    return { x: column * 2, y: row * 2 + 1 };
  };
  const add = (column: number, row: number, a: number, b: number) =>
    segments.push([edgePoint(column, row, a), edgePoint(column, row, b)]);
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = values[row * columns + column];
      const topRight = values[row * columns + column + 1];
      const bottomRight = values[(row + 1) * columns + column + 1];
      const bottomLeft = values[(row + 1) * columns + column];
      let state = 0;
      if (row > 0 && column > 0 && topLeft <= level) state |= 1;
      if (row > 0 && column + 1 < columns - 1 && topRight <= level) state |= 2;
      if (row + 1 < rows - 1 && column + 1 < columns - 1 && bottomRight <= level) state |= 4;
      if (row + 1 < rows - 1 && column > 0 && bottomLeft <= level) state |= 8;
      const centerIsInside = (topLeft + topRight + bottomRight + bottomLeft) / 4 <= level;
      if (state === 1 || state === 14) add(column, row, 3, 0);
      else if (state === 2 || state === 13) add(column, row, 0, 1);
      else if (state === 3 || state === 12) add(column, row, 3, 1);
      else if (state === 4 || state === 11) add(column, row, 1, 2);
      else if (state === 6 || state === 9) add(column, row, 0, 2);
      else if (state === 7 || state === 8) add(column, row, 3, 2);
      else if (state === 5) {
        if (centerIsInside) {
          add(column, row, 0, 1);
          add(column, row, 2, 3);
        } else {
          add(column, row, 3, 0);
          add(column, row, 1, 2);
        }
      } else if (state === 10) {
        if (centerIsInside) {
          add(column, row, 3, 0);
          add(column, row, 1, 2);
        } else {
          add(column, row, 0, 1);
          add(column, row, 2, 3);
        }
      }
    }
  }
  return segments;
}

export function traceRings(segments: Segment[]): GridPoint[][] {
  const key = (point: GridPoint) => `${point.x},${point.y}`;
  const adjacency = new Map<string, GridPoint[]>();
  for (const [a, b] of segments) {
    adjacency.set(key(a), [...(adjacency.get(key(a)) ?? []), b]);
    adjacency.set(key(b), [...(adjacency.get(key(b)) ?? []), a]);
  }
  const used = new Set<string>();
  const edgeKey = (a: GridPoint, b: GridPoint) => [key(a), key(b)].sort().join('|');
  const rings: GridPoint[][] = [];
  for (const [start, first] of segments) {
    if (used.has(edgeKey(start, first))) continue;
    const ring = [start];
    let previous = start;
    let current = first;
    used.add(edgeKey(previous, current));
    while (key(current) !== key(start) && ring.length <= segments.length) {
      ring.push(current);
      const next = (adjacency.get(key(current)) ?? []).find(
        (candidate) => !used.has(edgeKey(current, candidate)),
      );
      if (!next) break;
      previous = current;
      current = next;
      used.add(edgeKey(previous, current));
    }
    if (key(current) === key(start) && ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Subdivides each ring edge so traced cell outlines read as organic coastline rather than stair-steps. */
export function smoothRing(points: Point[]): Point[] {
  const smoothed: Point[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    smoothed.push(
      { x: current.x * 0.75 + next.x * 0.25, y: current.y * 0.75 + next.y * 0.25 },
      { x: current.x * 0.25 + next.x * 0.75, y: current.y * 0.25 + next.y * 0.75 },
    );
  }
  return smoothed;
}

function ringArea(points: Point[]): number {
  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return area + point.x * next.y - next.x * point.y;
    }, 0) / 2
  );
}

/**
 * Pairs traced rings into polygons, nesting alternating rings as holes. Largest area first, so a
 * ring's depth depends only on larger rings and the result does not depend on discovery order.
 */
export function ringsToPolygons(rings: Point[][]): PolygonGeometry[] {
  const sorted = [...rings].sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  const depths = sorted.map(
    (ring, index) =>
      sorted.slice(0, index).filter((parent) => pointInPolygon(ring[0], { points: parent })).length,
  );
  return sorted
    .map((_, index) => index)
    .filter((index) => depths[index] % 2 === 0)
    .map((outerIndex) => {
      const points = sorted[outerIndex];
      const holes = sorted.filter(
        (ring, index) =>
          depths[index] === depths[outerIndex] + 1 && pointInPolygon(ring[0], { points }),
      );
      return holes.length > 0 ? { points, holes } : { points };
    });
}

/** Traces a scalar grid at a level and returns the resulting polygons in world coordinates. */
export function gridToPolygons(
  columns: number,
  rows: number,
  values: number[],
  level: number,
  width: number,
  height: number,
): PolygonGeometry[] {
  const scaleX = width / ((columns - 1) * 2);
  const scaleY = height / ((rows - 1) * 2);
  const rings = traceRings(contourSegments(columns, rows, values, level)).map((ring) =>
    smoothRing(ring.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }))),
  );
  return ringsToPolygons(rings);
}

function clipToAxis(
  points: Point[],
  keep: (point: Point) => boolean,
  cross: (inside: Point, outside: Point) => Point,
): Point[] {
  const clipped: Point[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[(index + points.length - 1) % points.length];
    const currentInside = keep(current);
    const previousInside = keep(previous);
    if (currentInside) {
      if (!previousInside) clipped.push(cross(previous, current));
      clipped.push(current);
    } else if (previousInside) {
      clipped.push(cross(previous, current));
    }
  }
  return clipped;
}

/** Cuts a ring to the map rectangle so shoreline that leaves the map is cut by the edge, not rounded off. */
function clipRingToBounds(points: Point[], width: number, height: number): Point[] {
  const atX = (x: number) => (a: Point, b: Point) => ({
    x,
    y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x),
  });
  const atY = (y: number) => (a: Point, b: Point) => ({
    y,
    x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y),
  });
  return clipToAxis(
    clipToAxis(
      clipToAxis(
        clipToAxis(points, (point) => point.x >= 0, atX(0)),
        (point) => point.x <= width,
        atX(width),
      ),
      (point) => point.y >= 0,
      atY(0),
    ),
    (point) => point.y <= height,
    atY(height),
  );
}

/**
 * Contours a grid whose water is allowed to reach the map edge.
 *
 * The grid is extended by one ring that replicates the outer row and column, which keeps every
 * contour closed inside the extension while the real border keeps its own values. Water therefore
 * runs to the edge and is cut by it, and a border that sits above the level stays dry land.
 */
export function gridToEdgePolygons(
  columns: number,
  rows: number,
  values: number[],
  level: number,
  width: number,
  height: number,
): PolygonGeometry[] {
  const paddedColumns = columns + 2;
  const paddedRows = rows + 2;
  const padded = new Array<number>(paddedColumns * paddedRows);
  for (let row = 0; row < paddedRows; row += 1) {
    for (let column = 0; column < paddedColumns; column += 1) {
      const sourceColumn = Math.min(columns - 1, Math.max(0, column - 1));
      const sourceRow = Math.min(rows - 1, Math.max(0, row - 1));
      padded[row * paddedColumns + column] = values[sourceRow * columns + sourceColumn];
    }
  }

  const scaleX = width / ((columns - 1) * 2);
  const scaleY = height / ((rows - 1) * 2);
  const rings = traceRings(contourSegments(paddedColumns, paddedRows, padded, level)).map((ring) =>
    smoothRing(ring.map((point) => ({ x: (point.x - 2) * scaleX, y: (point.y - 2) * scaleY }))),
  );

  return ringsToPolygons(rings)
    .map((geometry) => ({
      points: clipRingToBounds(geometry.points, width, height),
      ...(geometry.holes
        ? { holes: geometry.holes.map((hole) => clipRingToBounds(hole, width, height)) }
        : {}),
    }))
    .filter((geometry) => geometry.points.length >= 3 && Math.abs(ringArea(geometry.points)) > 0);
}
