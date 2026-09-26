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
