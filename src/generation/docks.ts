import type {
  BuildingEntity,
  DockEntity,
  Point,
  PolygonGeometry,
  RoadEntity,
  SettlementEntity,
  WaterRegion,
} from '../map/GameMap.js';
import { boundsOf, pointInPolygon } from '../map/geometry.js';
import { distance, roadRibbon, stations } from './ribbon.js';

/**
 * How far from a road a shore may be and still take a dock.
 *
 * A road never crosses water and keeps a margin from the shore, so a deck is a short walk from the
 * road rather than a road of its own. Measured over six maps at 2048 by 1536, a road comes within 2 to
 * 8 units of water at its closest point and 62 to 74% of all road points sit within 120 units of it,
 * so 120 is where most of the shoreline becomes reachable and the rest of the map is landlocked.
 */
const REACH = 120;

/** How far a site is offered along a centreline, in world units. A pier is a long object. */
const SPACING = 26;

/**
 * The full width of a deck, in world units: 16 across, which is a cart wide and most of a primary
 * road's width, so a hand cart can get onto one and the raster carves a stripe rather than a line.
 */
const DECK_WIDTH = 16;

/**
 * How far past the water's edge the deck reaches, in world units.
 *
 * This is the part of a dock that is over water, and it is what the walkability carve opens. It has
 * to be a few cells at any sane cell size or the deck is a line the raster never sees, and it is not
 * much more than that, because a pier is a landing stage and not a jetty long enough to walk out of
 * sight of the shore.
 */
const OVERHANG = 18;

/**
 * How close one deck may come to another, centre to centre, in world units.
 *
 * A deck is 16 wide and reaches 18 to 138, so two within 20 of each other share their shore and read
 * as one wide pier with a gap in it. 30 keeps two decks apart and still lets a shore take several.
 */
const MIN_SEPARATION = 30;

/**
 * Places plank decks where a settlement meets a shore, reached along the road network.
 *
 * A dock is the waterfront of a place, so a deck is placed for a settlement and not on its own: a
 * settlement is required within reach of the anchor, which is what keeps a harbour at a village rather
 * than a jetty in the middle of an empty shore. That makes the count an upper bound rather than a
 * promise, in the same way a settlement count is: a map with no settlements publishes no docks at any
 * count, and a place that stands nowhere near water has no waterfront to publish. It is not bounded
 * by the number of places, because one place on a long shore can have several decks: two settlements
 * reach sixteen on a 2048 by 1536 map, eight to one of them.
 *
 * The road is the anchor for the same reason it is for a building. Nothing is scattered across open
 * ground, and a deck that starts on a road is a deck a cart can reach. The deck runs from the anchor
 * towards the nearest shore, crossing however much land lies between and reaching `OVERHANG` past the
 * water's edge. The land part is ground that was already open, and the water part is the part the
 * walkability raster carves back open, so a character can walk the length of the deck and step off it
 * into a boat.
 *
 * `ponytail:` the shore is found by walking the edges of every water polygon, which costs the
 * contour length of the water within `REACH` of a station. Index the water's edges into a uniform
 * grid when a map with hundreds of water bodies makes a dock bake feel heavy; at the counts this
 * reaches it is not the step that costs.
 */
export function generateDocks(
  roads: RoadEntity[],
  water: WaterRegion[],
  settlements: SettlementEntity[],
  buildings: BuildingEntity[],
  count: number,
  width: number,
  height: number,
  random: () => number,
): DockEntity[] {
  if (count <= 0 || roads.length === 0 || settlements.length === 0 || water.length === 0) return [];

  // Shuffled so a fixed seed does not fill the shoreline of the first road, and takes the same
  // stations for the same seed every time.
  const candidates: { station: Point; road: RoadEntity }[] = [];
  for (const road of roads)
    for (const { point } of stations(road.path, SPACING)) candidates.push({ station: point, road });
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }

  const docks: DockEntity[] = [];
  for (const { station, road } of candidates) {
    if (docks.length >= count) break;
    // A deck is a place's waterfront, so the place has to be there. Nearest wins, which is the same
    // rule the settlement membership uses, so a shore between two centres is not in two harbours.
    let settlement: SettlementEntity | undefined;
    let settlementGap = Number.POSITIVE_INFINITY;
    for (const place of settlements) {
      const gap = distance(place.position, station);
      if (gap <= place.radius && gap < settlementGap) {
        settlement = place;
        settlementGap = gap;
      }
    }
    if (!settlement) continue;

    const shore = nearestShore(station, water);
    if (!shore || shore.gap === 0 || shore.gap > REACH) continue;
    // The deck runs from the anchor at the nearest point on the shore, and reaches `OVERHANG` past
    // it, so the far end is standing water however far the road is from the edge.
    const depth = shore.gap + OVERHANG;
    const tip = {
      x: station.x + ((shore.point.x - station.x) / shore.gap) * depth,
      y: station.y + ((shore.point.y - station.y) / shore.gap) * depth,
    };
    const geometry = roadRibbon([station, tip], DECK_WIDTH);
    if (!geometry) continue;
    // The bounds test is on the deck's own corners rather than on the centreline, because the two
    // are not the same at a map edge: a deck running along a shore near the border has a tip
    // comfortably inside it and both far corners outside. A polygon outside the map is not a valid
    // one, so the corner is what has to fit.
    if (geometry.points.some((p) => p.x < 0 || p.y < 0 || p.x > width || p.y > height)) continue;
    // The tip is what makes this a dock rather than a plank on the bank: if it is not in the water it
    // was found by, the "shore" was a river 18 units away and the deck stops short of everything.
    if (!pointInPolygon(tip, shore.body.collision)) continue;
    // Two decks sharing a shore read as one wide pier with a gap in it, and a deck laid through a
    // building is a deck through a wall, so both are refused at the same distance.
    if (
      docks.some(
        (dock) =>
          distance(dock.position, station) < MIN_SEPARATION ||
          overlaps(dock.geometry, geometry) ||
          buildings.some((building) => overlaps(building.geometry, geometry)),
      )
    )
      continue;

    docks.push({
      id: `dock-${docks.length + 1}`,
      type: 'dock',
      position: station,
      rotation: Math.atan2(tip.y - station.y, tip.x - station.x),
      width: DECK_WIDTH,
      depth,
      geometry,
      asset: { category: 'structure.dock', variant: 'plank-1' },
      metadata: {
        roadId: road.id,
        settlementId: settlement.id,
        waterId: shore.body.id,
      },
    });
  }
  return docks;
}

interface Shore {
  body: WaterRegion;
  /** The point on the body's edge, which is where the deck crosses into it. */
  point: Point;
  gap: number;
}

/**
 * The water body closest to `point`, and the point on its edge.
 *
 * The body's bounds box is the broadphase, because a contour of a large lake has a great many edges
 * and most of them are nowhere near a road. Only the bodies whose box is within `REACH` are walked
 * edge by edge, and of those the nearest edge point is the one a deck would cross.
 */
function nearestShore(point: Point, water: WaterRegion[]): Shore | undefined {
  let best: Shore | undefined;
  for (const body of water) {
    const box = boundsOf(body.collision.points);
    const gap = distanceToBox(point, box);
    if (gap > REACH || (best && gap > best.gap)) continue;
    const edge = closestPointOnRing(point, body.collision);
    if (!edge) continue;
    if (!best || edge.gap < best.gap) best = { body, point: edge.point, gap: edge.gap };
  }
  return best;
}

/** Distance from a point to a box, which is zero inside it. */
function distanceToBox(
  point: Point,
  box: { minX: number; maxX: number; minY: number; maxY: number },
) {
  return Math.hypot(
    Math.max(box.minX - point.x, 0, point.x - box.maxX),
    Math.max(box.minY - point.y, 0, point.y - box.maxY),
  );
}

/** The point on a ring's edges nearest to `point`, as the closest point on the closest segment. */
function closestPointOnRing(
  point: Point,
  geometry: PolygonGeometry,
): { point: Point; gap: number } | undefined {
  let best: { point: Point; gap: number } | undefined;
  for (const points of [geometry.points, ...(geometry.holes ?? [])])
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[index + 1 === points.length ? 0 : index + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const span = dx * dx + dy * dy;
      const t =
        span === 0
          ? 0
          : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / span));
      const gap = distance(point, { x: a.x + dx * t, y: a.y + dy * t });
      if (!best || gap < best.gap) best = { point: { x: a.x + dx * t, y: a.y + dy * t }, gap };
    }
  return best;
}

/** Whether two rectangles overlap on all four sides, which is the test a deck needs against a wall. */
function overlaps(a: PolygonGeometry, b: PolygonGeometry): boolean {
  const left = boundsOf(a.points);
  const right = boundsOf(b.points);
  return !(
    left.maxX <= right.minX ||
    right.maxX <= left.minX ||
    left.maxY <= right.minY ||
    right.maxY <= left.minY
  );
}
