import type { Point, PolygonGeometry } from '../map/GameMap.js';
import { polygonArea } from '../map/geometry.js';

/** Distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Drops points that lie on the straight line between their neighbours. Greedy routing emits a point
 * per step whether or not the heading changed, so an untrimmed centreline is mostly redundant.
 */
export function simplifyPath(path: Point[]): Point[] {
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
 * Curves a centreline by cutting the corners off it, twice over.
 *
 * Both a traced course and a greedy road are staircases: one point per grid cell or per step, each
 * joined to the next by a straight line, so the ribbon offset from them reads as a chain of flat
 * facets where a lake reads as a curve. Replacing every pair of segments with two shorter ones a
 * quarter and three-quarters along rounds each joint, and the two ends are left exactly where they
 * were, so a course cut at a shoreline is still cut at that shoreline and a road still starts and
 * ends on the ground the walk found.
 *
 * Chaikin shrinks a path slightly towards its own middle, which is what turns a staircase into a
 * curve. Two passes is the point where the joints are round and the shape is still the shape; more
 * passes only round what is already round.
 *
 * The pass count is a parameter because the two callers want different amounts of it. A course is cut
 * at a shoreline with no margin to keep, so it takes both passes. A road is held a fixed distance
 * clear of the water, and a second pass bows it further in than that margin allows, so it takes one:
 * a single pass still replaces every corner with a curve, which is what a staircase needs.
 */
export function smoothPath(path: Point[], passes = 2): Point[] {
  let points = path;
  for (let pass = 0; pass < passes && points.length > 2; pass += 1) {
    const cut: Point[] = [points[0]];
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1];
      const b = points[index];
      cut.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      cut.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    cut.push(points[points.length - 1]);
    points = cut;
  }
  return points;
}

/**
 * Builds the ribbon polygon around a centreline: the centreline offset to each side, closed at both
 * ends. Roads and river channels are both a centreline plus a width, so both are drawn this way.
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

/**
 * Walks a centreline, offering a point every `spacing` units of arc length, together with the index
 * of the segment it falls on.
 *
 * The first station is one spacing in, so nothing is built on a road's blunt end. Both the building
 * and the dock placers offer sites the same way, so a building and a dock can be compared by the
 * point that placed them.
 */
export function* stations(
  path: Point[],
  spacing: number,
): Generator<{ point: Point; index: number }> {
  if (path.length < 2) return;
  let travelled = spacing;
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    const length = distance(a, b);
    if (length === 0) continue;
    while (travelled <= length) {
      const t = travelled / length;
      yield { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, index };
      travelled += spacing;
    }
    travelled -= length;
  }
}
