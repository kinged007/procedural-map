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
 * How far a deck runs out over the water, in world units.
 *
 * A deck is a rectangle standing in the water and touching the bank at one end, so this is the whole
 * of it rather than the part that happens to be past a shoreline. A pier is a landing stage and not
 * a jetty long enough to walk out of sight of the shore, and 40 fits inside the smallest lake the
 * generator draws: over six maps the narrowest dimension of a lake that takes a road is 61 units,
 * a tenth of them are under 82, and the median is 211.
 */
const REACH_OUT = 40;

/**
 * The shortest a deck may be and still be a deck, in world units.
 *
 * Below this the water does not open up behind the pier and the deck is a plank on the bank, so a
 * candidate is refused rather than published at a length no character could tell from the shore.
 */
const MIN_DECK = 12;

/**
 * How close one deck may come to another, centre to centre, in world units.
 *
 * Two decks within 20 of each other share their shore and read as one wide pier with a gap in it.
 * 30 keeps two decks apart and still lets a shore take several.
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
 * ground, and a shore a road cannot reach is a shore with nobody on it. The road decides *which*
 * shore; the deck itself is not laid from the road. A deck is a rectangle standing in the water and
 * touching the bank at one end, rooted at the point on the shoreline nearest the road and running
 * out from there away from the land. Laying it from the road instead would draw a plank across the
 * beach, which is not a pier and is what the first version of this did.
 *
 * How far it runs is what the water allows rather than a fixed number: the reach is measured along
 * the deck's own heading and clamped to the last point still inside the named water, so a pier in a
 * narrow inlet is a short pier and a pier off a broad shore is a full-length one, and neither ever
 * lands on the far bank.
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

    const shore = nearestShore(station, water);
    if (!shore || shore.gap === 0 || shore.gap > REACH) continue;
    // A deck is a place's waterfront, so the place has to be there. Nearest wins, which is the same
    // rule the settlement membership uses, so a shore between two centres is not in two harbours.
    // The test is against the deck's own root rather than the road station it was found from: a
    // consumer can only check membership against what the map publishes, and the deck is published
    // rooted on the waterline, which is up to `REACH` further out than the station.
    let settlement: SettlementEntity | undefined;
    let settlementGap = Number.POSITIVE_INFINITY;
    for (const place of settlements) {
      const gap = distance(place.position, shore.point);
      if (gap <= place.radius && gap < settlementGap) {
        settlement = place;
        settlementGap = gap;
      }
    }
    if (!settlement) continue;

    // The deck is rooted on the shoreline and runs out from there, away from the land the road is
    // on. The heading is the same line the road approaches along, continued past the bank, so the
    // deck is perpendicular-ish to the shore it stands on rather than lying along it.
    const heading = {
      x: (shore.point.x - station.x) / shore.gap,
      y: (shore.point.y - station.y) / shore.gap,
    };
    // How far the water runs out along that heading, measured to the last point still inside the
    // named body. Measuring rather than assuming is what keeps a pier in a narrow inlet short
    // instead of laying it across to the far bank.
    const depth = openReach(shore.point, heading, shore.body);
    if (depth < MIN_DECK) continue;
    const tip = {
      x: shore.point.x + heading.x * depth,
      y: shore.point.y + heading.y * depth,
    };
    const geometry = roadRibbon([shore.point, tip], DECK_WIDTH);
    if (!geometry) continue;
    // The bounds test is on the deck's own corners rather than on the centreline, because the two
    // are not the same at a map edge: a deck running along a shore near the border has a tip
    // comfortably inside it and both far corners outside. A polygon outside the map is not a valid
    // one, so the corner is what has to fit.
    if (geometry.points.some((p) => p.x < 0 || p.y < 0 || p.x > width || p.y > height)) continue;
    // Two decks sharing a shore read as one wide pier with a gap in it, and a deck laid through a
    // building is a deck through a wall, so both are refused at the same distance. A deck now stands
    // in the water rather than across the land, so the building test is a formality; it is kept
    // because a pier drawn over a building is a pier nobody can read either way.
    if (
      docks.some(
        (dock) =>
          distance(dock.position, shore.point) < MIN_SEPARATION ||
          overlaps(dock.geometry, geometry) ||
          buildings.some((building) => overlaps(building.geometry, geometry)),
      )
    )
      continue;

    docks.push({
      id: `dock-${docks.length + 1}`,
      type: 'dock',
      position: shore.point,
      rotation: Math.atan2(heading.y, heading.x),
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

/**
 * How far the water runs out from `root` along `heading`, capped at `REACH_OUT`.
 *
 * The whole rectangle has to fit, not just its centreline: a deck whose centreline is over water and
 * whose far corners are on the sand is a plank half laid. So the test is the deck's two tip corners
 * and its far edge as well as its own centre, which is what stops a pier running along a curving
 * shore from ending with a corner ashore.
 */
function openReach(root: Point, heading: Point, body: WaterRegion): number {
  const across = { x: -heading.y, y: heading.x };
  const inWater = (p: Point) => pointInPolygon(p, body.collision);
  let last = 0;
  for (let step = 1; step <= REACH_OUT; step += 1) {
    const distance = step;
    const centre = { x: root.x + heading.x * distance, y: root.y + heading.y * distance };
    if (!inWater(centre)) break;
    const left = {
      x: centre.x + across.x * (DECK_WIDTH / 2),
      y: centre.y + across.y * (DECK_WIDTH / 2),
    };
    const right = {
      x: centre.x - across.x * (DECK_WIDTH / 2),
      y: centre.y - across.y * (DECK_WIDTH / 2),
    };
    if (!inWater(left) || !inWater(right)) break;
    last = distance;
  }
  return last;
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
