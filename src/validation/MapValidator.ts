import type { CollisionGeometry, GameMap, Point, PolygonGeometry } from '../map/GameMap.js';
import { circleIntersectsPolygon } from '../map/geometry.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const MAX_RING_POINTS = 32768;
const MAX_HOLES = 4096;
const EPSILON = 1e-9;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural equality that does not depend on key order. Two trees that were written by hand, or
 * that arrived from a JSON parser that reorders keys, are the same tree whichever way their keys
 * are listed, and a validator must not report a difference that is only ordering.
 */
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => structurallyEqual(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => structurallyEqual(left[key], right[key]));
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pointEquals(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: Point, a: Point, b: Point): boolean {
  return (
    Math.abs(cross(a, b, point)) < EPSILON &&
    point.x >= Math.min(a.x, b.x) - EPSILON &&
    point.x <= Math.max(a.x, b.x) + EPSILON &&
    point.y >= Math.min(a.y, b.y) - EPSILON &&
    point.y <= Math.max(a.y, b.y) + EPSILON
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (
    ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
    ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))
  )
    return true;
  return (
    pointOnSegment(c, a, b) ||
    pointOnSegment(d, a, b) ||
    pointOnSegment(a, c, d) ||
    pointOnSegment(b, c, d)
  );
}

function ringArea(points: Point[]): number {
  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return area + point.x * next.y - next.x * point.y;
    }, 0) / 2
  );
}

function ringIsSimple(points: Point[]): boolean {
  const segments = points.map((a, index) => {
    const b = points[(index + 1) % points.length];
    return {
      a,
      b,
      index,
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxY: Math.max(a.y, b.y),
    };
  });
  if (segments.some(({ a, b }) => pointEquals(a, b))) return false;
  segments.sort((a, b) => a.minX - b.minX);
  for (let index = 0; index < segments.length; index++) {
    const current = segments[index];
    for (let other = index + 1; other < segments.length; other++) {
      const candidate = segments[other];
      if (candidate.minX > current.maxX + EPSILON) break;
      if (candidate.minY > current.maxY + EPSILON || candidate.maxY < current.minY - EPSILON)
        continue;
      const distance = Math.abs(current.index - candidate.index);
      if (distance === 1 || distance === points.length - 1) continue;
      if (segmentsIntersect(current.a, current.b, candidate.a, candidate.b)) return false;
    }
  }
  return Math.abs(ringArea(points)) > EPSILON;
}

function pointInRing(point: Point, ring: Point[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index, index += 1
  ) {
    const a = ring[previous];
    const b = ring[index];
    if (pointOnSegment(point, a, b)) return true;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

class Validator {
  readonly errors: string[] = [];
  private readonly ids = new Set<string>();

  error(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  finite(value: unknown, path: string): value is number {
    if (!isFiniteNumber(value)) this.error(path, 'must be a finite number');
    return isFiniteNumber(value);
  }

  point(
    value: unknown,
    path: string,
    bounds: { width: number; height: number },
    requireInBounds = true,
  ): value is Point {
    if (!isRecord(value)) {
      this.error(path, 'must be a point');
      return false;
    }
    const point = value as unknown as Point;
    const valid = this.finite(point.x, `${path}.x`) && this.finite(point.y, `${path}.y`);
    if (
      valid &&
      requireInBounds &&
      (point.x < 0 || point.x > bounds.width || point.y < 0 || point.y > bounds.height)
    ) {
      this.error(path, 'must be inside map bounds');
      return false;
    }
    return valid;
  }

  jsonValue(value: unknown, path: string, seen = new Set<object>()): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return this.finite(value, path);
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        this.error(path, 'must not contain circular references');
        return false;
      }
      seen.add(value);
      let valid = true;
      value.forEach((entry, index) => {
        if (!this.jsonValue(entry, `${path}[${index}]`, seen)) valid = false;
      });
      seen.delete(value);
      return valid;
    }
    if (isRecord(value)) {
      if (!isPlainRecord(value)) {
        this.error(path, 'must be a plain JSON object');
        return false;
      }
      if (seen.has(value)) {
        this.error(path, 'must not contain circular references');
        return false;
      }
      seen.add(value);
      let valid = true;
      Object.entries(value).forEach(([key, entry]) => {
        if (!this.jsonValue(entry, `${path}.${key}`, seen)) valid = false;
      });
      seen.delete(value);
      return valid;
    }
    this.error(path, 'must be JSON-compatible');
    return false;
  }

  ring(value: unknown, path: string, bounds: { width: number; height: number }): value is Point[] {
    if (!Array.isArray(value) || value.length < 3 || value.length > MAX_RING_POINTS) {
      this.error(path, `must contain between 3 and ${MAX_RING_POINTS} points`);
      return false;
    }
    const valid = value.every((point, index) => this.point(point, `${path}[${index}]`, bounds));
    const simple = valid && ringIsSimple(value as Point[]);
    if (valid && !simple) this.error(path, 'must be a simple, non-zero-area ring');
    return simple;
  }

  polygon(
    value: unknown,
    path: string,
    bounds: { width: number; height: number },
  ): value is PolygonGeometry {
    if (!isRecord(value)) {
      this.error(path, 'must be a polygon');
      return false;
    }
    const outerValid = this.ring(value.points, `${path}.points`, bounds);
    const holes = value.holes;
    if (holes !== undefined && (!Array.isArray(holes) || holes.length > MAX_HOLES)) {
      this.error(`${path}.holes`, `must contain at most ${MAX_HOLES} rings`);
      return false;
    }
    const holesValid =
      !holes || holes.every((hole, index) => this.ring(hole, `${path}.holes[${index}]`, bounds));
    if (!outerValid || !holesValid) return false;
    const typedHoles = (holes ?? []) as Point[][];
    const outer = value.points as Point[];
    for (let index = 0; index < typedHoles.length; index += 1) {
      const hole = typedHoles[index];
      if (!pointInRing(hole[0], outer))
        this.error(`${path}.holes[${index}]`, 'must be inside the outer ring');
      if (
        outer.some((point, pointIndex) =>
          hole.some((holePoint, holeIndex) =>
            segmentsIntersect(
              point,
              outer[(pointIndex + 1) % outer.length],
              holePoint,
              hole[(holeIndex + 1) % hole.length],
            ),
          ),
        )
      ) {
        this.error(`${path}.holes[${index}]`, 'must not intersect the outer ring');
      }
      for (let other = 0; other < index; other += 1) {
        const otherHole = typedHoles[other];
        if (
          pointInRing(hole[0], otherHole) ||
          pointInRing(otherHole[0], hole) ||
          hole.some((point, pointIndex) =>
            otherHole.some((otherPoint, otherIndex) =>
              segmentsIntersect(
                point,
                hole[(pointIndex + 1) % hole.length],
                otherPoint,
                otherHole[(otherIndex + 1) % otherHole.length],
              ),
            ),
          )
        ) {
          this.error(`${path}.holes[${index}]`, 'must not overlap another hole');
        }
      }
    }
    return true;
  }

  collision(
    value: unknown,
    path: string,
    bounds: { width: number; height: number },
  ): value is CollisionGeometry {
    if (!isRecord(value) || typeof value.type !== 'string') {
      this.error(path, 'must be collision geometry');
      return false;
    }
    if (value.type === 'circle') {
      const centerValid = this.point(value.center, `${path}.center`, bounds);
      const radiusValid = this.finite(value.radius, `${path}.radius`);
      const center = value.center as Point;
      const radius = value.radius as number;
      if (radiusValid && radius <= 0) this.error(`${path}.radius`, 'must be greater than zero');
      if (
        centerValid &&
        radiusValid &&
        (center.x - radius < 0 ||
          center.x + radius > bounds.width ||
          center.y - radius < 0 ||
          center.y + radius > bounds.height)
      )
        this.error(path, 'must fit inside map bounds');
      return centerValid && radiusValid && radius > 0;
    }
    if (value.type === 'polygon') return this.polygon(value, path, bounds);
    if (value.type === 'rectangle') {
      const valuesValid =
        this.finite(value.x, `${path}.x`) &&
        this.finite(value.y, `${path}.y`) &&
        this.finite(value.width, `${path}.width`) &&
        this.finite(value.height, `${path}.height`);
      const rectangle = value as { x: number; y: number; width: number; height: number };
      if (valuesValid && (rectangle.width <= 0 || rectangle.height <= 0))
        this.error(path, 'must have positive width and height');
      if (
        valuesValid &&
        (rectangle.x < 0 ||
          rectangle.y < 0 ||
          rectangle.x + rectangle.width > bounds.width ||
          rectangle.y + rectangle.height > bounds.height)
      )
        this.error(path, 'must fit inside map bounds');
      return valuesValid && rectangle.width > 0 && rectangle.height > 0;
    }
    this.error(`${path}.type`, 'must be circle, polygon, or rectangle');
    return false;
  }

  entity(
    value: unknown,
    path: string,
    bounds: { width: number; height: number },
    validateGeometry = true,
  ): value is RecordValue {
    if (!isRecord(value)) {
      this.error(path, 'must be an entity');
      return false;
    }
    if (typeof value.id !== 'string' || value.id.length === 0)
      this.error(`${path}.id`, 'must be a non-empty string');
    else if (this.ids.has(value.id)) this.error(`${path}.id`, 'must be globally unique');
    else this.ids.add(value.id);
    if (typeof value.type !== 'string' || value.type.length === 0)
      this.error(`${path}.type`, 'must be a non-empty string');
    if (value.position !== undefined) this.point(value.position, `${path}.position`, bounds);
    if (value.rotation !== undefined) this.finite(value.rotation, `${path}.rotation`);
    if (
      value.tags !== undefined &&
      (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string'))
    )
      this.error(`${path}.tags`, 'must be an array of strings');
    if (validateGeometry && value.collision !== undefined)
      this.collision(value.collision, `${path}.collision`, bounds);
    if (validateGeometry && value.geometry !== undefined)
      this.polygon(value.geometry, `${path}.geometry`, bounds);
    if (
      value.asset !== undefined &&
      (!isRecord(value.asset) ||
        typeof value.asset.category !== 'string' ||
        value.asset.category.length === 0 ||
        typeof value.asset.variant !== 'string' ||
        value.asset.variant.length === 0)
    )
      this.error(`${path}.asset`, 'must contain non-empty category and variant strings');
    if (value.metadata !== undefined) {
      if (!isRecord(value.metadata) || !isPlainRecord(value.metadata))
        this.error(`${path}.metadata`, 'must be a plain JSON object');
      else this.jsonValue(value.metadata, `${path}.metadata`);
    }
    return true;
  }
}

export function validateMap(data: unknown): ValidationResult {
  try {
    const validator = new Validator();
    if (!isRecord(data)) return { valid: false, errors: ['map: must be an object'] };
    validator.jsonValue(data, 'map');
    if (data.version !== '1.4') validator.error('version', 'must be supported version "1.4"');
    if (!isRecord(data.metadata)) validator.error('metadata', 'must be an object');
    else {
      if (typeof data.metadata.id !== 'string' || data.metadata.id.length === 0)
        validator.error('metadata.id', 'must be a non-empty string');
      if (data.metadata.seed !== undefined) validator.finite(data.metadata.seed, 'metadata.seed');
      if (data.metadata.generator !== undefined && typeof data.metadata.generator !== 'string')
        validator.error('metadata.generator', 'must be a string');
      if (data.metadata.generatedAt !== undefined && typeof data.metadata.generatedAt !== 'string')
        validator.error('metadata.generatedAt', 'must be a string');
      validator.jsonValue(data.metadata, 'metadata');
    }
    let bounds: { width: number; height: number } | undefined;
    if (!isRecord(data.bounds)) validator.error('bounds', 'must be an object');
    else if (
      validator.finite(data.bounds.width, 'bounds.width') &&
      validator.finite(data.bounds.height, 'bounds.height')
    ) {
      if (data.bounds.width <= 0 || data.bounds.height <= 0)
        validator.error('bounds', 'must have positive dimensions');
      else bounds = { width: data.bounds.width, height: data.bounds.height };
    }
    const collections = [
      'terrain',
      'water',
      'vegetation',
      'forests',
      'structures',
      'settlements',
      'roads',
      'barriers',
    ] as const;
    for (const collection of collections)
      if (!Array.isArray(data[collection])) validator.error(collection, 'must be an array');
    // Read before the loop below, so a settlement can be checked against the buildings that exist.
    const buildingIds = new Set<string>();
    if (Array.isArray(data.structures))
      for (const building of data.structures)
        if (isRecord(building) && typeof building.id === 'string') buildingIds.add(building.id);
    if (bounds) {
      for (const collection of collections) {
        const entities = data[collection];
        if (!Array.isArray(entities)) continue;
        entities.forEach((entity, index) => {
          const specialized =
            collection === 'terrain' ||
            collection === 'water' ||
            collection === 'vegetation' ||
            collection === 'forests' ||
            collection === 'structures' ||
            collection === 'settlements';
          validator.entity(entity, `${collection}[${index}]`, bounds!, !specialized);
          if (!isRecord(entity)) return;
          if (
            collection === 'structures' &&
            (entity.type !== 'building' ||
              !['house', 'farm'].includes(entity.category as string) ||
              !validator.finite(entity.width, `${collection}[${index}].width`) ||
              (entity.width as number) <= 0 ||
              !validator.finite(entity.depth, `${collection}[${index}].depth`) ||
              (entity.depth as number) <= 0 ||
              !validator.polygon(entity.geometry, `${collection}[${index}].geometry`, bounds!) ||
              !isRecord(entity.collision) ||
              entity.collision.type !== 'polygon' ||
              !validator.polygon(entity.collision, `${collection}[${index}].collision`, bounds!) ||
              !isRecord(entity.metadata) ||
              // `setback` is how far the front wall stands off the road, so a consumer cannot place
              // a doorstep without it. `roadId` is optional: a building can stand off the network.
              !validator.finite(
                entity.metadata.setback,
                `${collection}[${index}].metadata.setback`,
              ) ||
              (entity.metadata.setback as number) < 0 ||
              (entity.metadata.roadId !== undefined && typeof entity.metadata.roadId !== 'string'))
          )
            validator.error(
              `${collection}[${index}]`,
              'must be a building with a category, a footprint, and polygon collision',
            );
          if (
            collection === 'settlements' &&
            (entity.type !== 'settlement' ||
              !validator.finite(entity.radius, `${collection}[${index}].radius`) ||
              (entity.radius as number) <= 0 ||
              !isRecord(entity.metadata) ||
              !Array.isArray(entity.metadata.buildingIds) ||
              !entity.metadata.buildingIds.every((id) => typeof id === 'string' && id.length > 0))
          )
            validator.error(
              `${collection}[${index}]`,
              'must be a settlement with a radius and a list of building ids',
            );
          // A settlement names the buildings it holds, so a name that resolves to nothing is a
          // membership a consumer cannot act on. A settlement with no buildings is valid; one that
          // claims a building which is not on the map is not.
          if (collection === 'settlements' && isRecord(entity.metadata)) {
            const members = entity.metadata.buildingIds;
            if (Array.isArray(members))
              members.forEach((id, memberIndex) => {
                if (typeof id !== 'string' || !buildingIds.has(id))
                  validator.error(
                    `${collection}[${index}].metadata.buildingIds[${memberIndex}]`,
                    'must name a building published in structures',
                  );
              });
          }
          if (
            collection === 'terrain' &&
            (entity.type !== 'terrain' ||
              !['grass', 'meadow', 'scrub', 'rock', 'beach'].includes(entity.kind as string) ||
              !validator.polygon(entity.geometry, `${collection}[${index}].geometry`, bounds!) ||
              // Collision is optional on terrain, but where it is present it must be a polygon.
              (entity.collision !== undefined &&
                (!isRecord(entity.collision) ||
                  entity.collision.type !== 'polygon' ||
                  !validator.polygon(
                    entity.collision,
                    `${collection}[${index}].collision`,
                    bounds!,
                  ))))
          )
            validator.error(`${collection}[${index}]`, 'must be a terrain region');
          if (
            collection === 'roads' &&
            (entity.type !== 'road' ||
              !['primary', 'secondary', 'path'].includes(entity.kind as string) ||
              !Array.isArray(entity.path) ||
              entity.path.length < 2 ||
              !entity.path.every((point) =>
                validator.point(point, `${collection}[${index}].path`, bounds!),
              ) ||
              !validator.finite(entity.width, `${collection}[${index}].width`) ||
              (entity.width as number) <= 0 ||
              !isRecord(entity.collision) ||
              entity.collision.type !== 'polygon' ||
              !validator.polygon(entity.collision, `${collection}[${index}].collision`, bounds!))
          )
            validator.error(
              `${collection}[${index}]`,
              'must be a road with a polyline and polygon collision',
            );
          if (
            collection === 'water' &&
            (entity.type !== 'water' ||
              !['lake', 'river'].includes(entity.kind as string) ||
              !validator.polygon(entity.geometry, `${collection}[${index}].geometry`, bounds!) ||
              !isRecord(entity.collision) ||
              entity.collision.type !== 'polygon' ||
              !validator.polygon(entity.collision, `${collection}[${index}].collision`, bounds!))
          )
            validator.error(
              `${collection}[${index}]`,
              'must be a lake or river water region with polygon collision',
            );
          if (collection === 'vegetation') {
            const treeValid =
              entity.type === 'tree' &&
              typeof entity.species === 'string' &&
              entity.species.length > 0 &&
              validator.point(entity.position, `${collection}[${index}].position`, bounds!) &&
              validator.finite(entity.radius, `${collection}[${index}].radius`) &&
              entity.radius > 0 &&
              isRecord(entity.collision) &&
              entity.collision.type === 'circle' &&
              validator.collision(entity.collision, `${collection}[${index}].collision`, bounds!);
            if (!treeValid)
              validator.error(
                `${collection}[${index}]`,
                'must be a tree with position, positive radius, and circle collision',
              );
            else if (
              !pointEquals(entity.position as Point, (entity.collision as { center: Point }).center)
            )
              validator.error(
                `${collection}[${index}].collision.center`,
                'must match tree position',
              );
            else if (
              (entity.position as Point).x - (entity.radius as number) < 0 ||
              (entity.position as Point).x + (entity.radius as number) > bounds!.width ||
              (entity.position as Point).y - (entity.radius as number) < 0 ||
              (entity.position as Point).y + (entity.radius as number) > bounds!.height
            )
              validator.error(`${collection}[${index}].radius`, 'must fit inside map bounds');
          }
          if (collection === 'forests' && isRecord(entity)) {
            const label = `${collection}[${index}]`;
            // A forest is the one entity that must not carry collision. Its hull deliberately
            // over-covers the ground between its trees, so treating it as a shape to collide with
            // would seal the clearings the trees leave walkable. The circles in `trees` are what
            // block, and a consumer that reads a hull as a wall is a bug worth failing on.
            if (entity.collision !== undefined)
              validator.error(
                `${label}.collision`,
                'must be absent: a forest hull is a broadphase shape, not a collision shape',
              );
            if (
              entity.type !== 'forest' ||
              !['mixed', 'oak', 'birch'].includes(entity.species as string) ||
              !validator.polygon(entity.geometry, `${label}.geometry`, bounds!) ||
              !Array.isArray(entity.trees) ||
              entity.trees.length < 2
            )
              validator.error(
                label,
                'must be a forest with a species, a hull, and at least two trees',
              );
            if (Array.isArray(entity.trees))
              entity.trees.forEach((tree, treeIndex) => {
                if (
                  !isRecord(tree) ||
                  tree.type !== 'tree' ||
                  !validator.point(
                    tree.position,
                    `${label}.trees[${treeIndex}].position`,
                    bounds!,
                  ) ||
                  !validator.finite(tree.radius, `${label}.trees[${treeIndex}].radius`) ||
                  (tree.radius as number) <= 0 ||
                  !isRecord(tree.collision) ||
                  tree.collision.type !== 'circle' ||
                  !validator.collision(
                    tree.collision,
                    `${label}.trees[${treeIndex}].collision`,
                    bounds!,
                  )
                )
                  validator.error(
                    `${label}.trees[${treeIndex}]`,
                    'must be a tree with position, positive radius, and circle collision',
                  );
                else if (
                  !pointEquals(tree.position as Point, (tree.collision as { center: Point }).center)
                )
                  validator.error(
                    `${label}.trees[${treeIndex}].collision.center`,
                    'must match tree position',
                  );
              });
            if (!isRecord(entity.metadata) || !Number.isInteger(entity.metadata.treeCount))
              validator.error(`${label}.metadata.treeCount`, 'must be an integer');
            if (
              isRecord(entity.metadata) &&
              !validator.finite(entity.metadata.densityPct, `${label}.metadata.densityPct`)
            )
              validator.error(`${label}.metadata.densityPct`, 'must be a finite number');
            if (isRecord(entity.metadata) && typeof entity.metadata.walkableInside !== 'boolean')
              validator.error(`${label}.metadata.walkableInside`, 'must be a boolean');
          }
        });
      }
      if (
        validator.errors.length === 0 &&
        Array.isArray(data.vegetation) &&
        Array.isArray(data.water)
      )
        for (const [treeIndex, tree] of data.vegetation.entries())
          if (
            isRecord(tree) &&
            isRecord(tree.position) &&
            isFiniteNumber(tree.position.x) &&
            isFiniteNumber(tree.position.y) &&
            isFiniteNumber(tree.radius)
          )
            for (const [waterIndex, water] of data.water.entries())
              if (
                isRecord(water) &&
                isRecord(water.geometry) &&
                Array.isArray(water.geometry.points) &&
                water.geometry.points.every(isRecord)
              ) {
                const radius = Math.max(
                  tree.radius,
                  isRecord(tree.collision) && isFiniteNumber(tree.collision.radius)
                    ? tree.collision.radius
                    : 0,
                );
                if (
                  circleIntersectsPolygon(
                    tree.position as unknown as Point,
                    radius,
                    water.geometry as unknown as PolygonGeometry,
                  )
                )
                  validator.error(
                    `vegetation[${treeIndex}]`,
                    `must not overlap water[${waterIndex}]`,
                  );
              }
    }

    // A tree is published twice, once in `vegetation` and once inside the forest that groups it, so
    // that a consumer wanting a flat tree list needs no new code. Two copies of one fact drift unless
    // something checks them, so the forest's copy has to be the same tree.
    if (
      validator.errors.length === 0 &&
      Array.isArray(data.vegetation) &&
      Array.isArray(data.forests)
    ) {
      const byId = new Map<string, unknown>();
      for (const tree of data.vegetation)
        if (isRecord(tree) && typeof tree.id === 'string') byId.set(tree.id, tree);
      data.forests.forEach((forest, forestIndex) => {
        if (!isRecord(forest) || !Array.isArray(forest.trees)) return;
        const seen = new Set<string>();
        forest.trees.forEach((tree, treeIndex) => {
          const label = `forests[${forestIndex}].trees[${treeIndex}]`;
          if (!isRecord(tree) || typeof tree.id !== 'string') return;
          const original = byId.get(tree.id);
          if (!original) {
            validator.error(label, 'must be a tree that also appears in vegetation');
            return;
          }
          if (seen.has(tree.id)) validator.error(label, 'must not repeat a tree within its forest');
          seen.add(tree.id);
          if (!structurallyEqual(tree, original))
            validator.error(label, 'must match the tree of the same id in vegetation');
        });
      });
    }
    if (data.metadataLayers !== undefined) {
      if (!isRecord(data.metadataLayers)) validator.error('metadataLayers', 'must be an object');
      else {
        validator.jsonValue(data.metadataLayers, 'metadataLayers');
        if (data.metadataLayers.fields !== undefined) {
          const fields = data.metadataLayers.fields;
          if (
            !isRecord(fields) ||
            !Number.isInteger(fields.columns) ||
            !Number.isInteger(fields.rows) ||
            (fields.columns as number) <= 0 ||
            (fields.rows as number) <= 0
          )
            validator.error('metadataLayers.fields', 'must have positive integer columns and rows');
          else {
            const expectedLength = (fields.columns as number) * (fields.rows as number);
            for (const name of ['terrain', 'elevation', 'moisture', 'vegetation']) {
              const values = fields[name];
              if (
                !Array.isArray(values) ||
                values.length !== expectedLength ||
                !values.every((value) => isFiniteNumber(value) && value >= 0 && value <= 1)
              )
                validator.error(
                  `metadataLayers.fields.${name}`,
                  'must be a normalized array matching columns × rows',
                );
            }
          }
        }
      }
    }
    return { valid: validator.errors.length === 0, errors: validator.errors };
  } catch {
    return { valid: false, errors: ['map: validation failed for malformed input'] };
  }
}

export function assertValidMap(data: unknown): asserts data is GameMap {
  const result = validateMap(data);
  if (!result.valid) throw new Error(`Invalid GameMap: ${result.errors.join('; ')}`);
}
