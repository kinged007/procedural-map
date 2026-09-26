import type { Point, PolygonGeometry } from '../../map/GameMap.js';

const EPSILON = 1e-9;

function signedArea(points: Point[]): number {
  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return area + point.x * next.y - next.x * point.y;
    }, 0) / 2
  );
}

/** True when no two non-adjacent edges of the ring touch or cross. */
export function ringIsSimple(points: Point[]): boolean {
  const count = points.length;
  const cross = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSegment = (p: Point, a: Point, b: Point) =>
    Math.abs(cross(a, b, p)) < EPSILON &&
    p.x >= Math.min(a.x, b.x) - EPSILON &&
    p.x <= Math.max(a.x, b.x) + EPSILON &&
    p.y >= Math.min(a.y, b.y) - EPSILON &&
    p.y <= Math.max(a.y, b.y) + EPSILON;
  const intersects = (a: Point, b: Point, c: Point, d: Point) => {
    const abC = cross(a, b, c);
    const abD = cross(a, b, d);
    const cdA = cross(c, d, a);
    const cdB = cross(c, d, b);
    if (
      ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
      ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))
    )
      return true;
    return onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
  };

  const edges = points.map((a, index) => ({ a, b: points[(index + 1) % count] }));
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (j === i + 1 || (i === 0 && j === count - 1)) continue;
      if (intersects(edges[i].a, edges[i].b, edges[j].a, edges[j].b)) return false;
    }
  }
  return true;
}

/**
 * Pushes a closed ring outward along its vertex normals. `distance` must be small relative to the
 * ring's local curvature, otherwise a concave section can fold through itself; callers should check
 * the result with `ringIsSimple`.
 */
export function offsetRing(points: Point[], distance: number): Point[] {
  const count = points.length;
  // A clockwise ring has its outward normal on the other side, so normalise the direction first.
  const direction = signedArea(points) > 0 ? 1 : -1;
  return points.map((point, index) => {
    const previous = points[(index - 1 + count) % count];
    const next = points[(index + 1) % count];
    const inX = point.x - previous.x;
    const inY = point.y - previous.y;
    const outX = next.x - point.x;
    const outY = next.y - point.y;
    const inLength = Math.hypot(inX, inY) || 1;
    const outLength = Math.hypot(outX, outY) || 1;
    const normalX = inY / inLength + outY / outLength;
    const normalY = -inX / inLength - outX / outLength;
    const normalLength = Math.hypot(normalX, normalY) || 1;
    return {
      x: point.x + (normalX / normalLength) * distance * direction,
      y: point.y + (normalY / normalLength) * distance * direction,
    };
  });
}

/**
 * Builds a shoreline band that hugs a lake: the lake ring offset outward, with the lake itself
 * punched out as a hole. Returns null when the offset folds through itself or leaves the map, so
 * the caller can skip the beach rather than emit geometry that fails validation.
 */
export function shorelineBand(
  water: PolygonGeometry,
  distance: number,
  width: number,
  height: number,
): PolygonGeometry | null {
  const outer = offsetRing(water.points, distance);
  if (!ringIsSimple(outer)) return null;
  if (signedArea(outer) * signedArea(water.points) <= 0) return null;
  if (
    outer.some((p) => p.x < 0 || p.x > width || p.y < 0 || p.y > height) ||
    water.points.some((p) => p.x < 0 || p.x > width || p.y < 0 || p.y > height)
  )
    return null;
  return { points: outer, holes: [water.points] };
}
