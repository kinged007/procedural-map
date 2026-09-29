import type { Point, PolygonGeometry } from './GameMap.js';

const EPSILON = 1e-9;

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
  if (Math.abs(cross) > EPSILON) return false;

  const dot = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
  if (dot < -EPSILON) return false;

  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  return dot <= lengthSquared + EPSILON;
}

function pointInRing(point: Point, ring: Point[]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;

    const crosses = currentPoint.y > point.y !== previousPoint.y > point.y;
    if (crosses) {
      const intersectionX =
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
        currentPoint.x;
      if (point.x < intersectionX) inside = !inside;
    }
  }
  return inside;
}

function distanceToSegmentSquared(point: Point, start: Point, end: Point): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  if (lengthSquared === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;

  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared),
  );
  const nearestX = start.x + projection * deltaX;
  const nearestY = start.y + projection * deltaY;
  return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2;
}

function ringArea(points: Point[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    total += points[index].x * next.y - next.x * points[index].y;
  }
  return total / 2;
}

export function pointInPolygon(point: Point, geometry: PolygonGeometry): boolean {
  if (!pointInRing(point, geometry.points)) return false;
  return !(geometry.holes ?? []).some((hole) => pointInRing(point, hole));
}

export function circleIntersectsPolygon(
  center: Point,
  radius: number,
  geometry: PolygonGeometry,
): boolean {
  if (radius < 0 || !Number.isFinite(radius)) return false;
  if (pointInPolygon(center, geometry)) return true;

  const rings = [geometry.points, ...(geometry.holes ?? [])];
  return rings.some((ring) =>
    ring.some(
      (point, index) =>
        distanceToSegmentSquared(center, point, ring[(index + 1) % ring.length]) <=
        radius ** 2 + EPSILON,
    ),
  );
}

/** Axis-aligned bounds of a point list, as `{minX, minY, maxX, maxY}`. */
export function boundsOf(points: Point[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
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

export function polygonArea(geometry: PolygonGeometry): number {
  return (
    Math.abs(ringArea(geometry.points)) -
    (geometry.holes ?? []).reduce((area, hole) => area + Math.abs(ringArea(hole)), 0)
  );
}

export function offsetPoint(point: Point, direction: Point, distance: number): Point {
  return { x: point.x + direction.x * distance, y: point.y + direction.y * distance };
}

/**
 * A polygon's outline, as one sample per `step` units with the outward normal of each.
 *
 * The direction out is a perpendicular to the outline there, which is the normal. A polygon's own
 * vertices are too coarse to aim at: a contour vertex can be a hundred units from its neighbours, and
 * the stretch between two of them is the edge a character would stand at.
 *
 * Samples sit in the interior of each segment, never on a vertex. A sample on a vertex is on the
 * boundary of two segments rather than inside one, the two normals there belong to the two edges
 * meeting at it, and stepping back along one at a sharp angle leaves the polygon instead of entering
 * it. The outward direction is confirmed against the polygon rather than taken from the winding
 * order, so a ring wound either way reports the same way out.
 *
 * A sample yields one face where only one perpendicular leaves the polygon, which is every sample of
 * a convex hull, and two where the outline is concave enough that both do. Both are real directions
 * out and the caller takes whichever clears, so neither is guessed at. A notch, where the polygon
 * wraps round three sides and neither perpendicular leads anywhere, yields nothing.
 */
export function* outwardFaces(
  geometry: PolygonGeometry,
  step: number,
): Generator<{ at: Point; outward: Point }> {
  for (const ring of [geometry.points, ...(geometry.holes ?? [])])
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[index + 1 === ring.length ? 0 : index + 1];
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span < step) continue;
      const count = Math.floor(span / step);
      const tangent = { x: (b.x - a.x) / span, y: (b.y - a.y) / span };
      for (let n = 0; n < count; n += 1) {
        const t = (n + 0.5) / count;
        const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        for (const outward of [
          { x: -tangent.y, y: tangent.x },
          { x: tangent.y, y: -tangent.x },
        ])
          if (!pointInPolygon(offsetPoint(at, outward, 3), geometry)) yield { at, outward };
      }
    }
}

/**
 * How far a character can walk from `at` along `normal` before `blocked` stops them, measured in
 * 4-unit steps.
 *
 * The whole run is measured, not the first step. A first-step test accepts a face with four units of
 * daylight and then a wall, so an arrow points out of a grove and into the wood next door, and a
 * caller that is told the site is reachable sends a character somewhere they cannot leave. The
 * comparison is `reach === wanted`; a run that stops short is a different answer from a clear one.
 */
export function clearRun(
  at: Point,
  normal: Point,
  blocked: (at: Point) => boolean,
  reach: number,
): number {
  let clear = 0;
  for (let step = 4; step <= reach; step += 4) {
    if (blocked(offsetPoint(at, normal, step))) break;
    clear = step;
  }
  return clear;
}
