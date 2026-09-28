import type {
  BuildingCategory,
  BuildingEntity,
  Point,
  PolygonGeometry,
  RoadEntity,
  TerrainRegion,
  VegetationEntity,
  WaterRegion,
} from '../map/GameMap.js';
import { circleIntersectsPolygon } from '../map/geometry.js';
import type { ResolvedGenerationConfig } from './GenerationConfig.js';
import { distance, roadRibbon } from './ribbon.js';

/**
 * What each category is, and how it stands relative to a road.
 *
 * A `farm` is the reason `setback` is per category rather than one number for the map: a farmyard is
 * both bigger and set further back than the house beside it, and it is that difference, not its name,
 * that earns the category. `setback: 0` means "use the configured setback".
 */
const CATEGORIES: Record<
  BuildingCategory,
  { width: number; depth: number; setback: number; weight: number }
> = {
  house: { width: 15, depth: 11, setback: 0, weight: 8 },
  farm: { width: 28, depth: 20, setback: 48, weight: 1 },
};

/** How close a footprint may come to the map edge, in world units. */
const EDGE_MARGIN = 6;

/** Total weight of every category, for the weighted draw. */
const TOTAL_WEIGHT = Object.values(CATEGORIES).reduce((sum, entry) => sum + entry.weight, 0);

/**
 * Places buildings along the road network, each standing back from its centreline and facing it.
 *
 * A road is the only thing that offers a site, which is what puts a building where a person would
 * have had a reason to put one. Nothing is scattered across open ground, so a map with no roads has
 * no buildings; a building that needs to stand away from a road entirely is a different placement
 * problem and does not belong here.
 *
 * Sites are offered every `spacing` units along each centreline, and each is built on with
 * probability `density`. Spacing is then re-checked as a global centre-to-centre minimum, so
 * buildings on two roads that run close together do not overlap, and one that would be refused for
 * sitting in the water, on rock, in another road, on a beach, or under a tree is dropped and the next
 * station is offered. Trees are generated first, so a tree is a reason to refuse a building and not
 * the other way round: the wood is worth more to a map than the house beside it, and the density
 * target that governs it stays untouched.
 */
export function generateBuildings(
  config: ResolvedGenerationConfig,
  roads: RoadEntity[],
  water: WaterRegion[],
  terrain: TerrainRegion[],
  vegetation: VegetationEntity[],
  /** Settlement clearings, kept clear so a place has open ground at its middle. */
  clearings: PolygonGeometry[],
  random: () => number,
): BuildingEntity[] {
  const { density, spacing, setback } = config.buildings;
  if (density <= 0 || roads.length === 0) return [];

  // Everything a building may not stand on, as one list, because the test is the same for all of it.
  // A beach is here even though it is walkable: a house on the sand is a house where nobody would
  // build one, and a shoreline is where a port, a pier, or a boat shed belongs, so keeping the band
  // clear is what leaves that ground for a later category to claim. A beach has no collision of its
  // own, since nothing refuses to walk on it, so its geometry is what a building is tested against.
  const blocked: PolygonGeometry[] = [
    ...water.map((body) => body.collision),
    ...terrain
      .filter((region) => region.collision !== undefined)
      .map((region) => region.collision as { type: 'polygon' } & PolygonGeometry),
    ...terrain.filter((region) => region.kind === 'beach').map((region) => region.geometry),
    ...roads.map((road) => road.collision),
    // A settlement clearing is the open ground a consumer builds the middle of the place on, so
    // nothing generated stands in it. A building centre sits `setback + depth / 2` off the road,
    // which is 23 units at the smallest legal setback and inside a 28-unit clearing.
    ...clearings,
  ];
  const buildings: BuildingEntity[] = [];

  for (const road of roads) {
    for (const station of stations(road.path, spacing)) {
      if (random() > density) continue;
      const category = drawCategory(random());
      const spec = CATEGORIES[category];
      const front = spec.setback > 0 ? spec.setback : setback;
      const { dx, dy } = heading(road.path, station.index);
      // One normal to the road; the side decides which bank the building stands on, and the facing
      // is the same vector back towards the road, so a building always looks at the way it is on.
      const side = random() < 0.5 ? 1 : -1;
      const offset = front + spec.depth / 2;
      const nx = -dy * side * offset;
      const ny = dx * side * offset;
      const position = { x: station.point.x + nx, y: station.point.y + ny };
      const facing = { x: -nx, y: -ny };
      const geometry = footprint(position, facing, spec.width, spec.depth);
      if (!geometry) continue;
      if (
        isClear(geometry, position, spec.depth / 2, config, blocked) &&
        !vegetation.some((tree) => circleIntersectsPolygon(tree.position, tree.radius, geometry))
      ) {
        if (buildings.some((built) => distance(built.position, position) < spacing)) continue;
        buildings.push({
          id: `building-${buildings.length + 1}`,
          type: 'building',
          category,
          position,
          rotation: Math.atan2(facing.y, facing.x),
          width: spec.width,
          depth: spec.depth,
          geometry,
          collision: { type: 'polygon', ...geometry },
          asset: { category: `structure.${category}`, variant: `${category}-1` },
          metadata: { roadId: road.id, setback: front },
        });
      }
    }
  }
  return buildings;
}

/** Walks a centreline, offering a point every `spacing` units of arc length. */
function* stations(path: Point[], spacing: number): Generator<{ point: Point; index: number }> {
  if (path.length < 2) return;
  // The first station is one spacing in, so nothing is built on a road's blunt end.
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

/** Unit heading of the segment `index` runs along. */
function heading(path: Point[], index: number): { dx: number; dy: number } {
  const a = path[index];
  const b = path[index + 1];
  const length = distance(a, b) || 1;
  return { dx: (b.x - a.x) / length, dy: (b.y - a.y) / length };
}

/** Weighted draw over the categories. */
function drawCategory(roll: number): BuildingCategory {
  let threshold = roll * TOTAL_WEIGHT;
  for (const [category, spec] of Object.entries(CATEGORIES) as [
    BuildingCategory,
    (typeof CATEGORIES)[BuildingCategory],
  ][]) {
    threshold -= spec.weight;
    if (threshold < 0) return category;
  }
  return 'house';
}

/**
 * The footprint: a rectangle `depth` deep along the facing and `width` wide across it.
 *
 * This is a two-point ribbon, which is the rectangle case of the road surface, so the same code
 * draws both and there is no second offset routine to keep in step with the first.
 */
function footprint(
  position: Point,
  facing: Point,
  width: number,
  depth: number,
): PolygonGeometry | null {
  const length = Math.hypot(facing.x, facing.y);
  if (length === 0) return null;
  const back = {
    x: position.x - (facing.x / length) * (depth / 2),
    y: position.y - (facing.y / length) * (depth / 2),
  };
  const front = {
    x: position.x + (facing.x / length) * (depth / 2),
    y: position.y + (facing.y / length) * (depth / 2),
  };
  return roadRibbon([back, front], width);
}

/**
 * Whether a building stands on ground it can stand on: inside the tile and clear of everything in
 * `blocked`.
 *
 * The tile test walks the footprint's own corners, because a large setback pushes a building bodily
 * towards the edge and a test on the centre alone lets a corner hang outside the map. The rest is a
 * circle of the building's depth centred on it, which is the circle that fits inside the footprint:
 * a building whose front wall grazes a shoreline is accepted while one standing in the river is not,
 * without testing four corners against every polygon on the map.
 */
function isClear(
  geometry: PolygonGeometry,
  centre: Point,
  reach: number,
  config: ResolvedGenerationConfig,
  blocked: PolygonGeometry[],
): boolean {
  for (const point of geometry.points)
    if (
      point.x < EDGE_MARGIN ||
      point.y < EDGE_MARGIN ||
      point.x > config.width - EDGE_MARGIN ||
      point.y > config.height - EDGE_MARGIN
    )
      return false;
  return !blocked.some((polygon) => circleIntersectsPolygon(centre, reach, polygon));
}
