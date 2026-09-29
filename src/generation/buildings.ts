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
import type { PlotSite } from './plots.js';
import { distance, roadRibbon, stations } from './ribbon.js';

/**
 * What each category is, and how it stands relative to a road.
 *
 * A `farm` is the reason `setback` is per category rather than one number for the map: a farmyard is
 * both bigger and set further back than the house beside it, and it is that difference, not its name,
 * that earns the category. `setback: 0` means "use the configured setback". A farm is also the one
 * category placed in worked ground: a farm works a field, so it stands in one rather than along a
 * road. That is decided in the placement loop rather than in this table, because it needs the fields
 * the map actually has.
 *
 * How often a category is drawn is not here: the weights are the caller's, in
 * `buildings.categories`, because which buildings a map has is the caller's decision and this table
 * only says what a category is once it has been chosen.
 */
export const CATEGORIES: Record<
  BuildingCategory,
  { width: number; depth: number; setback: number }
> = {
  house: { width: 15, depth: 11, setback: 0 },
  farm: { width: 28, depth: 20, setback: 48 },
};

/** How close a footprint may come to the map edge, in world units. */
const EDGE_MARGIN = 6;

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
  /**
   * The worked ground, so a farm can be put in a field. A field is what a farm works, which makes this
   * the one building the generator allows inside one.
   */
  plots: PlotSite[],
  random: () => number,
  /**
   * A stream of its own for the ruin draw, so setting the share moves no building's placement.
   */
  ruinRandom: () => number,
  /**
   * A stream of its own for the category draw, so reweighting the mix moves no building's site
   * either. A farm covers more ground than a house, so changing the mix legitimately refuses
   * neighbours and changes the count; it should not shuffle which sites were offered at all.
   */
  categoryRandom: () => number,
): BuildingEntity[] {
  const { density, spacing, setback, ruin } = config.buildings;
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
  // The weighted draw is set up once, from the caller's weights, rather than per station. A category
  // with a weight of zero is never drawn, which is how a caller asks for a map of houses.
  const weighted = (Object.keys(CATEGORIES) as BuildingCategory[])
    .map((category) => ({ category, weight: config.buildings.categories[category] }))
    .filter((entry) => entry.weight > 0);
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  // The fields a farm has already taken. One farm per field: a field with two farmsteads on it is not
  // a field with a farm on it.
  const worked = new Set<PlotSite>();

  for (const road of roads) {
    for (const station of stations(road.path, spacing)) {
      if (random() > density) continue;
      const category = drawCategory(categoryRandom(), weighted, totalWeight);
      const spec = CATEGORIES[category];
      // The half-diagonal, which is the radius of the smallest circle holding the whole footprint.
      const reach = Math.hypot(spec.width, spec.depth) / 2;

      // A farm works a field, so a farm is put in one. The site the road offered is only a reason the
      // farm was drawn at all; the field is where it stands. A farm is offered the field nearest the
      // station that drew it, so the two stay associated without the farm being dragged across the
      // map, and one field holds one farm. A map with no fields has no farm standing in a field, and
      // such a farm stands off the road as it always did, which is what keeps a default map — one
      // with no plots at all — exactly the map it was before fields existed.
      const field = category === 'farm' ? nearestField(plots, station.point, worked) : undefined;
      let position: Point;
      let facing: Point;
      let roadId: string | undefined;
      let front: number;
      if (field) {
        // At the end of its field nearest the settlement that works it, looking out over the worked
        // ground, because that is the way round a farm is: the house is at the gate and the field
        // runs away in front of it. A field's heading already points back at its settlement, so the
        // near end is the positive one and the farm faces the opposite way, out over the field — the
        // same convention a house uses, a building's front looking at what it is for.
        //
        // The sign is fixed rather than drawn, so the same field always gets the same farm; drawing it
        // would put half the farms at the far gate, facing away from their own field, which is the one
        // direction a farm should never face. `facing` turns the building about rather than moving it,
        // since the footprint is a rectangle centred on `position` and is the same either way.
        //
        // The centre is half the farm's own depth in from the field's near edge, so the building sits
        // hard against the boundary with no ground wasted behind it and the whole rest of the field
        // ahead of it. The margin here is zero on purpose: a farm is 20 deep, and a field runs 32 to
        // 64, so leaving even a 6-unit gap on both sides left only 6 units of worked ground in front
        // of the building — measured at 9 to 15 per cent of the field, which read as a house standing
        // in a small paddock rather than a farm at the edge of its own field.
        const along = { x: Math.cos(field.rotation), y: Math.sin(field.rotation) };
        const end = field.depth / 2 - spec.depth / 2;
        position = { x: field.position.x + along.x * end, y: field.position.y + along.y * end };
        facing = { x: -along.x, y: -along.y };
        front = 0;
      } else {
        front = spec.setback > 0 ? spec.setback : setback;
        const { dx, dy } = heading(road.path, station.index);
        // One normal to the road; the side decides which bank the building stands on, and the facing
        // is the same vector back towards the road, so a building always looks at the way it is on.
        const side = random() < 0.5 ? 1 : -1;
        const offset = front + spec.depth / 2;
        const nx = -dy * side * offset;
        const ny = dx * side * offset;
        position = { x: station.point.x + nx, y: station.point.y + ny };
        facing = { x: -nx, y: -ny };
        roadId = road.id;
      }
      const geometry = footprint(position, facing, spec.width, spec.depth);
      if (!geometry) continue;
      // A field is worked ground, so nothing is built in one — except the farm that works it, which
      // is exempt from its own field and from nothing else. Orchards are in the same list and are
      // exempt from nothing: a farm is not planted into rows.
      const refused = field ? plots.filter((plot) => plot !== field) : plots;
      if (
        isClear(
          geometry,
          position,
          reach,
          config,
          blocked,
          refused.map((plot) => plot.geometry),
        ) &&
        !vegetation.some((tree) => circleIntersectsPolygon(tree.position, tree.radius, geometry))
      ) {
        if (buildings.some((built) => distance(built.position, position) < spacing)) continue;
        // Whether a building has fallen down is drawn after it is placed, and from a stream of its
        // own, so the share does not change which sites are built on or how any of them stands:
        // turning every building into a ruin should leave the same map, not a different set of
        // houses. A ruin keeps its footprint and loses its collision, because rubble is ground a
        // character walks over.
        // The field is claimed here, once the farm is actually standing in it: a farm refused above
        // for a neighbour or a tree leaves its field free for the next one, rather than taking a
        // field with nothing on it.
        const state = ruinRandom() < ruin ? 'ruined' : 'standing';
        if (field) worked.add(field);
        buildings.push({
          id: `building-${buildings.length + 1}`,
          type: 'building',
          category,
          state,
          position,
          rotation: Math.atan2(facing.y, facing.x),
          width: spec.width,
          depth: spec.depth,
          geometry,
          ...(state === 'standing' ? { collision: { type: 'polygon' as const, ...geometry } } : {}),
          asset: {
            category: state === 'standing' ? `structure.${category}` : 'structure.ruin',
            variant: `${category}-${state === 'standing' ? '1' : 'ruin'}`,
          },
          // A farm in a field names the field and claims no road, because it is on neither. `setback`
          // is a distance from a road, and there is no road, so it is zero rather than a number that
          // would look like a measurement of something.
          metadata: {
            ...(roadId ? { roadId } : {}),
            setback: front,
            ...(field ? { plotId: field.id } : {}),
          },
        });
      }
    }
  }
  return buildings;
}

/**
 * The field a farm should work: the one nearest `from` that no other farm has taken.
 *
 * Nearest rather than next, because the site that drew the farm is on a road and the field is out in
 * the worked ground, and taking whichever field happened to be published first would scatter farms
 * across the map with no relation to where they were offered. An orchard is not offered: a farm is
 * not planted into rows.
 */
function nearestField(plots: PlotSite[], from: Point, taken: Set<PlotSite>): PlotSite | undefined {
  let best: PlotSite | undefined;
  let bestDistance = Infinity;
  for (const plot of plots) {
    if (plot.kind !== 'field' || taken.has(plot)) continue;
    const reach = distance(plot.position, from);
    if (reach < bestDistance) {
      best = plot;
      bestDistance = reach;
    }
  }
  return best;
}

/** Unit heading of the segment `index` runs along. */ function heading(
  path: Point[],
  index: number,
): { dx: number; dy: number } {
  const a = path[index];
  const b = path[index + 1];
  const length = distance(a, b) || 1;
  return { dx: (b.x - a.x) / length, dy: (b.y - a.y) / length };
}

/**
 * The weighted draw over the categories, from the caller's weights.
 *
 * The weights are relative, so `{ house: 3, farm: 1 }` and `{ house: 30, farm: 10 }` are the same
 * map, and a category left at zero is simply never drawn.
 */
function drawCategory(
  roll: number,
  weighted: { category: BuildingCategory; weight: number }[],
  totalWeight: number,
): BuildingCategory {
  let threshold = roll * totalWeight;
  for (const entry of weighted) {
    threshold -= entry.weight;
    if (threshold < 0) return entry.category;
  }
  return weighted[0].category;
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
 * towards the edge and a test on the centre alone lets a corner hang outside the map. The rest is the
 * half-diagonal, the smallest circle that contains the whole footprint. A shallower circle is the
 * cheaper mistake to make and the expensive one to find: `depth / 2` fits inside a rectangle but does
 * not contain it, so the 4 units a 28-wide farm overhangs its own 10-unit circle went untested, and a
 * farm corner that landed on a road collision, in a lake, on rock, or on the sand passed every check.
 * The point of the test is that a building stands clear of what is around it, so it has to be the
 * circle that reaches its furthest corner. A front wall is now held a half-diagonal off a shoreline
 * rather than being allowed to graze it, which refuses more sites and is the same conservative
 * direction as every other rule in the library: the walkability raster closes a cell for a blocker
 * that touches any part of it, and a building that only half fitted inside its own test could not be
 * drawn honestly afterwards.
 */
function isClear(
  geometry: PolygonGeometry,
  centre: Point,
  reach: number,
  config: ResolvedGenerationConfig,
  blocked: PolygonGeometry[],
  /** The worked ground, which is cleared for everything but the farm working its own field. */
  avoid: PolygonGeometry[],
): boolean {
  for (const point of geometry.points)
    if (
      point.x < EDGE_MARGIN ||
      point.y < EDGE_MARGIN ||
      point.x > config.width - EDGE_MARGIN ||
      point.y > config.height - EDGE_MARGIN
    )
      return false;
  return ![...blocked, ...avoid].some((polygon) => circleIntersectsPolygon(centre, reach, polygon));
}
