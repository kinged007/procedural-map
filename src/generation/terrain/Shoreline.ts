import type { Point, PolygonGeometry } from '../../map/GameMap.js';

const EPSILON = 1e-9;

/**
 * Minimum gap between the lake outline and the band, in world units. The map validator rejects a
 * hole that intersects its outer ring. This margin only needs to be large enough to prove the two
 * rings are separate, because a band is already allowed to be as narrow as the requested minimum.
 */
const MIN_HOLE_CLEARANCE = 0.05;

/**
 * Scale factors tried when a band is too wide for the shoreline it wraps. Starting at 1 keeps the
 * requested width when it is valid; each fallback narrows the band uniformly, which preserves the
 * width variation around the shore.
 */
const SHRINK_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];

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
 * Pushes a closed ring outward along its vertex normals. `distances` gives one offset per vertex, so
 * the band width can vary around the shore. Offsets must stay small relative to the ring's local
 * curvature, otherwise a concave section can fold through itself; callers should check the result
 * with `ringIsSimple`.
 */
export function offsetRing(points: Point[], distances: number[]): Point[] {
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
    const distance = distances[index % distances.length];
    return {
      x: point.x + (normalX / normalLength) * distance * direction,
      y: point.y + (normalY / normalLength) * distance * direction,
    };
  });
}

/**
 * True when every hole vertex lies strictly inside the outer ring, with clearance greater than
 * `margin`. A simple outer ring is not enough on its own: a band narrowed until the two rings touch
 * is still simple but produces geometry the map validator rejects, because a hole may not intersect
 * its outer ring.
 */
function holeStaysInside(outer: Point[], hole: Point[], margin: number): boolean {
  return hole.every((point) => pointInRing(point, outer) && distanceToRing(point, outer) > margin);
}

/** Winding test for a closed ring. */
function pointInRing(point: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const straddles = a.y > point.y !== b.y > point.y;
    if (straddles && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/** Shortest distance from a point to any ring edge. */
function distanceToRing(point: Point, ring: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    const closestX = a.x + t * dx;
    const closestY = a.y + t * dy;
    best = Math.min(best, Math.hypot(point.x - closestX, point.y - closestY));
  }
  return best;
}

export interface ShorelineBandOptions {
  /** Offset per lake vertex, in world units. */
  distances: number[];
  width: number;
  height: number;
}

/**
 * Builds a shoreline band that hugs a lake: the lake ring offset outward, with the lake itself
 * punched out as a hole. Returns null when the offset folds through itself or leaves the map, so
 * the caller can skip the beach rather than emit geometry that fails validation.
 */
export function shorelineBand(
  water: PolygonGeometry,
  options: ShorelineBandOptions,
): PolygonGeometry | null {
  const { distances, width, height } = options;
  if (distances.length === 0) return null;
  if (water.points.some((p) => p.x < 0 || p.x > width || p.y < 0 || p.y > height)) return null;

  // Each vertex is shortened only as far as that vertex needs to stay on the map. Water is
  // generated with a margin from the edge, so a uniform width pushes edge lakes off the map;
  // clamping per vertex keeps the rest of the shoreline at its intended width.
  const fitted = distances.map((_, index) => {
    const wanted = distances[index % distances.length];
    const isolated = offsetRing(
      water.points,
      water.points.map((__, i) => (i === index ? wanted : 0)),
    );
    const point = isolated[index];
    if (point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height) return wanted;
    for (let step = 0.9; step > 0; step -= 0.1) {
      const scaled = offsetRing(
        water.points,
        water.points.map((__, i) => (i === index ? wanted * step : 0)),
      )[index];
      if (scaled.x >= 0 && scaled.x <= width && scaled.y >= 0 && scaled.y <= height)
        return wanted * step;
    }
    return 0;
  });

  // A wide offset can still fold through a concave section, and a narrow one can pull the band
  // in until the hole touches the outer ring. Shrink the band until both hold rather than dropping
  // the beach, so a lake is never left bare for want of a valid offset.
  for (const scale of SHRINK_STEPS) {
    const outer = offsetRing(
      water.points,
      fitted.map((d) => d * scale),
    );
    if (!ringIsSimple(outer)) continue;
    if (signedArea(outer) * signedArea(water.points) <= 0) continue;
    if (!holeStaysInside(outer, water.points, MIN_HOLE_CLEARANCE)) continue;
    return { points: outer, holes: [water.points] };
  }
  return null;
}
