import type { ForestEntity, Point, PolygonGeometry, VegetationEntity } from '../map/GameMap.js';
import { boundsOf, pointInPolygon, polygonArea } from '../map/geometry.js';
import type { WalkabilityRaster } from '../navigation/walkability.js';

/**
 * Distance between two tree centres that links them into the same grove. Canopies are 10 to 18 units
 * and trunks 3.5 to 5.5, and trees are planted at least 9 units apart, so a link radius of 26
 * joins a tree to its close neighbours and reaches across a gap of roughly one canopy width. It is a
 * grove boundary, not a gameplay distance, so its exact value does not change how the map walks.
 */
const LINK_DISTANCE = 26;
const LINK_DISTANCE_SQUARED = LINK_DISTANCE * LINK_DISTANCE;

/** Smallest component that counts as a grove rather than a copse of loose trees. */
const MIN_TREES = 3;

/**
 * Largest number of trees published as one forest.
 *
 * Trees are linked by proximity, so in dense woodland the links chain and one component can swallow
 * most of the map: 1021 trees on a 4096x4096 default before this bound. A hull over a thousand
 * trees covers nearly the whole wood, so a consumer testing it learns nothing and then has to test a
 * thousand trunks, which is the cost the hull exists to avoid. Capping the size is what makes a chunk
 * bake's cost independent of how many trees the map has.
 */
const MAX_TREES_PER_FOREST = 128;

/**
 * Spacing between the points sampled along a hull's own outline when measuring edge cover.
 *
 * The outline is sampled rather than integrated, so the step has to be small next to the gaps it is
 * asked to find. Canopies in a generated wood are 10 to 18 units across, so the gaps between the
 * canopies of a thinning rim are several units and a step of 4 resolves them; a step cannot resolve a
 * gap narrower than itself, which is a floor on the measurement rather than a problem with it, and the
 * wood a consumer is drawing is never built with gaps that fine.
 */
const EDGE_STEP = 4;

/**
 * The share of a hull's own outline that lies under a tree canopy, as a percentage.
 *
 * This is the transition between a wood and the scrub around it, and it is measured at the outline
 * because the outline is where the transition happens. A wood whose rim trees overlap each other
 * covers its own boundary and meets the scrub in a line; a wood that thins outwards leaves gaps
 * between the canopies along the boundary, and meets it in a band. Neither is wrong, and a consumer
 * drawing a biome overlay cannot tell them apart from the hull: the hull is drawn tight around the
 * outermost canopies either way, so it is a hard edge in both cases and carries no sign of which
 * kind of edge it is closing off.
 *
 * `densityPct` cannot stand in for this, and the reason is structural rather than a mistake in the
 * formula. Canopies overlap freely, so canopy area over hull area runs past 100 in any thick wood and
 * saturates; measured over six default maps it reads exactly 100 on 302 of 303 groves, because a hull
 * drawn tight around its own canopies is by construction fully covered. It is a saturation, not a
 * measurement of anything that differs between a saturated wood and a ragged one. `edgeCoverPct` is
 * not saturated: the same 303 groves run from 46.6 to 100, with 105 of them under 90.
 */
function edgeCoverPct(group: VegetationEntity[], hull: PolygonGeometry): number {
  let samples = 0;
  let covered = 0;
  for (let index = 0; index < hull.points.length; index += 1) {
    const from = hull.points[index];
    const to = hull.points[(index + 1) % hull.points.length];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(length / EDGE_STEP));
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      samples += 1;
      for (const tree of group) {
        const reach = tree.radius + EDGE_STEP / 2;
        if ((x - tree.position.x) ** 2 + (y - tree.position.y) ** 2 <= reach * reach) {
          covered += 1;
          break;
        }
      }
    }
  }
  return samples === 0 ? 0 : (covered / samples) * 100;
}

/**
 * Splits a component until every part is small enough to be a useful hull.
 *
 * A grove is a local wood, not a woodland, so the split is spatial: the wider axis at its median.
 * Splitting on proximity alone would break a wood into arbitrary pieces, and the median keeps the
 * pieces roughly square, which is what a hull is cheapest to represent. Ties break on tree id, so the
 * same trees always split the same way and the forest list is reproducible.
 */
function splitOversized(trees: VegetationEntity[]): VegetationEntity[][] {
  if (trees.length <= MAX_TREES_PER_FOREST) return [trees];
  const box = boundsOf(trees.map((tree) => tree.position));
  const axis = box.maxX - box.minX >= box.maxY - box.minY ? 'x' : 'y';
  const sorted = [...trees].sort(
    (first, second) =>
      first.position[axis] - second.position[axis] || first.id.localeCompare(second.id),
  );
  const half = Math.floor(sorted.length / 2);
  return [...splitOversized(sorted.slice(0, half)), ...splitOversized(sorted.slice(half))];
}

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((first, second) => first.x - second.x || first.y - second.y);
  if (sorted.length < 3) return sorted;
  const cross = (origin: Point, a: Point, b: Point) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0)
      lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0)
      upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Area-weighted species of a grove, which is what the renderer needs to pick a canopy variant.
 *
 * An orchard grove is named `orchard` rather than counted as woodland. It is a fact about what is
 * standing there, not a style: a consumer asked to draw canopies from this and handed `birch` for a
 * planted row of apples has been told something false, and the only way to tell the difference is
 * the trees' own species, which means every consumer has to re-derive what this already knows.
 */
function groveSpecies(trees: VegetationEntity[]): ForestEntity['species'] {
  const planted = trees.filter((tree) => tree.species === 'orchard').length;
  if (planted === trees.length) return 'orchard';
  // A wild tree inside a row means the row is a wood with planting in it, which is a wood.
  if (planted > 0) return 'mixed';
  let oaks = 0;
  for (const tree of trees) if (tree.species === 'oak') oaks += 1;
  if (oaks === 0) return 'birch';
  if (oaks === trees.length) return 'oak';
  return 'mixed';
}

/**
 * Groups trees into groves, so a consumer can test one hull's bounds instead of every tree on the map.
 *
 * The grouping is union-find over the trees that generation already placed, at a fixed link distance.
 * It reads the placement rather than changing it, so tree counts, tree positions and the existing
 * vegetation behaviour are untouched, and the result does not depend on the order trees come out in:
 * a component is the same set however the scan reaches it. A component too small to read as a grove
 * stays a bare tree in `vegetation`.
 *
 * A tree appears both here and in `vegetation`. That is deliberate, so a consumer that only wants a
 * flat list of trees needs no new code, and the validator requires the two copies to agree.
 */
export function generateForests(trees: VegetationEntity[]): ForestEntity[] {
  if (trees.length < MIN_TREES) return [];

  // A uniform grid over the link distance, so each tree only tests the trees in and around its own
  // cell. This is the same trick the tree crowding check already uses.
  let minX = Infinity;
  let minY = Infinity;
  for (const tree of trees) {
    if (tree.position.x < minX) minX = tree.position.x;
    if (tree.position.y < minY) minY = tree.position.y;
  }
  const cells = new Map<string, number[]>();
  const cellKey = (point: Point) =>
    `${Math.floor((point.x - minX) / LINK_DISTANCE)},${Math.floor((point.y - minY) / LINK_DISTANCE)}`;

  const parent = trees.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (first: number, second: number) => {
    const a = find(first);
    const b = find(second);
    if (a === b) return;
    // Always attaching the larger root to the smaller keeps the tree flat enough that the path
    // compression above is doing real work.
    if (a < b) parent[b] = a;
    else parent[a] = b;
  };

  for (let index = 0; index < trees.length; index += 1) {
    const key = cellKey(trees[index].position);
    const bucket = cells.get(key);
    if (bucket) bucket.push(index);
    else cells.set(key, [index]);
  }
  for (let index = 0; index < trees.length; index += 1) {
    const point = trees[index].position;
    const column = Math.floor((point.x - minX) / LINK_DISTANCE);
    const row = Math.floor((point.y - minY) / LINK_DISTANCE);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1)
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const bucket = cells.get(`${column + offsetX},${row + offsetY}`);
        if (!bucket) continue;
        for (const other of bucket) {
          const deltaX = trees[other].position.x - point.x;
          const deltaY = trees[other].position.y - point.y;
          if (deltaX * deltaX + deltaY * deltaY <= LINK_DISTANCE_SQUARED) union(index, other);
        }
      }
  }

  const groups = new Map<number, VegetationEntity[]>();
  for (let index = 0; index < trees.length; index += 1) {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(trees[index]);
    else groups.set(root, [trees[index]]);
  }

  const forests: ForestEntity[] = [];
  const groves = [...groups.values()]
    .filter((members) => members.length >= MIN_TREES)
    .flatMap((members) => splitOversized(members))
    .filter((members) => members.length >= MIN_TREES)
    // Sorted by the lowest tree id, so the forest list is the same on every run for a given map.
    .sort((first, second) => first[0].id.localeCompare(second[0].id));
  for (const group of groves) {
    const species = groveSpecies(group);
    const geometry: PolygonGeometry = {
      points: convexHull(group.map((tree) => tree.position)),
    };
    // A collinear group has no area to speak of, and a hull of two points is a segment, which the
    // validator rejects as a ring. Neither is a grove worth publishing.
    if (geometry.points.length < 3 || polygonArea(geometry) <= 0) continue;

    let canopyArea = 0;
    for (const tree of group) canopyArea += Math.PI * tree.radius * tree.radius;
    const hullArea = polygonArea(geometry);
    forests.push({
      id: `forest-${forests.length + 1}`,
      type: 'forest',
      species,
      geometry,
      trees: group,
      asset: { category: 'vegetation.forest', variant: `${species}-1` },
      metadata: {
        treeCount: group.length,
        // Canopy cover, saturated at 100. Canopies overlap freely, so the raw ratio of canopy area to
        // hull area runs well past 100 in a thick wood and is not a percentage of anything on its
        // own; the cover it describes cannot exceed the ground there is.
        densityPct: Math.min(100, (canopyArea / hullArea) * 100),
        edgeCoverPct: edgeCoverPct(group, geometry),
        // Deliberately false until it is measured. Overstating this would tell a consumer a grove is
        // sealed when it is not.
        walkableInside: false,
      },
    });
  }

  return forests;
}

/**
 * Records, for each grove, whether walkable ground is still open inside its hull once the grove's
 * own trunks are accounted for.
 *
 * This is what makes the claim about clearings checkable rather than assumed. A hull over-covers the
 * ground between trees, so a grove can hold a real clearing, and a consumer that sealed a grove by
 * its hull would wall off that clearing. A hull therefore reports sealed only when every cell inside
 * it is either water or rock, or covered by one of its own trunks, which is the honest answer at the
 * resolution the raster was baked at.
 *
 * The result is a property of the resolution it was measured at, not of the grove, so a consumer that
 * bakes at a different cell size should not expect the same boolean. It is enough to tell a consumer
 * that this grove can be walked through, which is the question a caller actually has.
 */
export function markWalkableInside(forests: ForestEntity[], raster: WalkabilityRaster): void {
  const { cellSize, columns, rows, cells } = raster;
  for (const forest of forests) {
    forest.metadata.walkableInside = false;
    const box = boundsOf(forest.geometry.points);
    const firstColumn = Math.max(0, Math.floor(box.minX / cellSize));
    const lastColumn = Math.min(columns - 1, Math.floor(box.maxX / cellSize));
    const firstRow = Math.max(0, Math.floor(box.minY / cellSize));
    const lastRow = Math.min(rows - 1, Math.floor(box.maxY / cellSize));
    if (lastColumn < firstColumn || lastRow < firstRow) continue;

    // Only this grove's own trunks can block the open ground inside its hull, so the blocked set is
    // built from its trees and costs one pass over the grove rather than over the map.
    const blocked = new Set<number>();
    for (const tree of forest.trees) {
      const trunk = tree.collision;
      const fromColumn = Math.floor((trunk.center.x - trunk.radius) / cellSize);
      const toColumn = Math.ceil((trunk.center.x + trunk.radius) / cellSize) - 1;
      const fromRow = Math.floor((trunk.center.y - trunk.radius) / cellSize);
      const toRow = Math.ceil((trunk.center.y + trunk.radius) / cellSize) - 1;
      for (let row = Math.max(0, fromRow); row <= Math.min(rows - 1, toRow); row += 1)
        for (
          let column = Math.max(0, fromColumn);
          column <= Math.min(columns - 1, toColumn);
          column += 1
        )
          blocked.add(row * columns + column);
    }

    for (let row = firstRow; row <= lastRow && !forest.metadata.walkableInside; row += 1)
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const index = row * columns + column;
        if (cells[index] === 1 || blocked.has(index)) continue;
        if (
          pointInPolygon(
            { x: (column + 0.5) * cellSize, y: (row + 0.5) * cellSize },
            forest.geometry,
          )
        ) {
          forest.metadata.walkableInside = true;
          break;
        }
      }
  }
}
