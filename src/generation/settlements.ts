import type {
  BuildingEntity,
  Point,
  PolygonGeometry,
  RoadEntity,
  SettlementEntity,
} from '../map/GameMap.js';
import { distance } from './ribbon.js';

/** What a settlement is by size. Derived from how many buildings it holds, never configured. */
export type SettlementKind = 'hamlet' | 'village' | 'town';

/**
 * How many buildings make a village rather than a hamlet, and how many make a town.
 *
 * Membership is bounded by the radius below, so on a default map a settlement holds at most about a
 * dozen buildings and a town is a large village rather than a city. The thresholds are set to the
 * range the generator actually produces rather than to a real settlement's headcount, so every
 * value is reachable on a default map.
 *
 * `ponytail:` the size ceiling is the reach, not the kind. Raise `RADIUS` and a settlement can hold
 * more buildings and the thresholds follow; a caller who wants a real town needs a knob on the
 * radius before they need one on the kind.
 */
const VILLAGE_AT = 4;
const TOWN_AT = 9;

/**
 * How far a settlement reaches, in world units. A building further than this from a centre is not in
 * that settlement, which is what stops one wide-open map from being a single settlement with the
 * whole road network as its suburb.
 */
const RADIUS = 260;

/**
 * The smallest gap between two settlement centres, so a caller asking for four settlements gets four
 * places rather than one place counted four times. Roughly the width of a large village, so a centre
 * falls in a cluster of buildings rather than between two of them.
 */
const MIN_SEPARATION = RADIUS;

/**
 * How far a settlement's clearing reaches from its centre, in world units.
 *
 * A clearing is the open ground at the middle of a place: wide enough to be a green rather than a
 * widening of the road, and big enough for a building to stand in the middle of it. At 28 units it
 * is 56 across, which is two and a half times the width of a primary road and eight times a path.
 *
 * The number is set by the trees it has to clear and the buildings it must not swallow. Trees come to
 * within 7 units of a road, so anything larger than that is carving new ground, and a building centre
 * stands `setback + depth / 2` off the centreline, which is 23 units at the smallest legal setback.
 * 28 clears the trees and still fits between the nearest buildings; 36 starts displacing them.
 */
export const CLEARING_RADIUS = 28;

/** How many segments approximate the clearing's circle. Enough to read as round at any zoom. */
const CLEARING_SEGMENTS = 20;

/** Road tiers, in the order a settlement prefers them: a main road before a lane. */
const TIER_PREFERENCE: RoadEntity['kind'][] = ['primary', 'secondary', 'path'];

/** A place chosen on the road network, before anything is built on or around it. */
export interface SettlementSite {
  /** The centre, which stands on a road. */
  position: Point;
  /** How far this clearing reaches, which is less than the usual radius near a map edge. */
  radius: number;
  /** The open ground at the middle of the place, which nothing is planted in. */
  clearing: PolygonGeometry;
}

/**
 * Chooses where the settlements are, before trees and buildings exist.
 *
 * Deciding the sites first is what lets a clearing be a keep-out rather than a hole punched later: the
 * tree placer already refuses to plant inside a road corridor, and the building placer already has
 * to check the ground it is given, so a clearing reaches them as one more ground that must stay open.
 * Publishing the settlement itself still waits until the buildings exist, because a settlement is
 * defined by the buildings it holds.
 *
 * A centre is on a road, because that is where frontage is and it is the only thing on a map that
 * gives a building a reason to stand where it does. Main roads are preferred over lanes, so a town
 * grows where the traffic is rather than at the end of a footpath, and candidates are taken a
 * minimum distance apart so four settlements are four places rather than one place counted four
 * times.
 *
 * Tier preference is a preference and not a requirement: a map whose network is all lanes still
 * publishes its settlements, on lanes. A count of 16 fills on nine maps in ten, and the shortfall is
 * the separation, not the road tier.
 */
export function settlementSites(
  roads: RoadEntity[],
  count: number,
  width: number,
  height: number,
  random: () => number,
): SettlementSite[] {
  if (count <= 0 || roads.length === 0) return [];

  // Every point along every centreline is a candidate, kept per tier so the main roads can be
  // exhausted before a lane is considered.
  const byTier = new Map<RoadEntity['kind'], Point[]>();
  for (const tier of TIER_PREFERENCE) byTier.set(tier, []);
  for (const road of roads) byTier.get(road.kind)?.push(...road.path);

  // Shuffled per tier so a fixed seed still scatters the centres along a road instead of always
  // taking the first few points of the first road, and the same seed always takes the same ones.
  for (const candidates of byTier.values())
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
    }

  const centres: Point[] = [];
  for (const tier of TIER_PREFERENCE)
    for (const candidate of byTier.get(tier) ?? []) {
      if (centres.length >= count) break;
      if (centres.some((centre) => distance(centre, candidate) < MIN_SEPARATION)) continue;
      centres.push(candidate);
    }

  return centres.map((position) => {
    // A road runs to the edge of the map, so a centre can stand close enough that a full-radius
    // clearing would leave the bounds, and a polygon outside the map is not a valid one. The
    // clearing shrinks to fit rather than the site being dropped: a village at the edge of the world
    // is a village, it just has a smaller green.
    const radius = Math.min(
      CLEARING_RADIUS,
      position.x,
      position.y,
      width - position.x,
      height - position.y,
    );
    return { position, radius, clearing: clearingPolygon(position, radius) };
  });
}

/**
 * The clearing at a centre: a ring approximating a circle of `CLEARING_RADIUS`.
 *
 * A polygon rather than a bare radius because a consumer draws it and a road may one day be routed
 * around it, and a ring is what both want. The centre is still the practical test, because the
 * radius is the same for every settlement.
 */
function clearingPolygon(centre: Point, radius: number): PolygonGeometry {
  const points: Point[] = [];
  for (let index = 0; index < CLEARING_SEGMENTS; index += 1) {
    const angle = (index / CLEARING_SEGMENTS) * Math.PI * 2;
    points.push({
      x: centre.x + Math.cos(angle) * radius,
      y: centre.y + Math.sin(angle) * radius,
    });
  }
  return { points };
}

/**
 * Publishes the settlements around the sites already chosen.
 *
 * A settlement claims the buildings within `RADIUS` of its centre, and each building is claimed by
 * exactly one settlement: the nearest. Centres are kept `MIN_SEPARATION` apart, which is the same as
 * the radius, so two reaches do overlap and a building between them is in both unless it is assigned
 * once. Assigning to the nearest is the only rule that makes membership a partition, and a building
 * in two places at once has no meaning for a consumer resolving a name.
 *
 * A centre with no buildings near it publishes an empty membership rather than being dropped. A map
 * asking for more settlements than its `buildings.density` can fill gets empty ones, which is a dead
 * settlement, and it is reached by mixing the two parameters rather than by a switch.
 */
export function generateSettlements(
  sites: SettlementSite[],
  buildings: BuildingEntity[],
): SettlementEntity[] {
  const members = new Map<string, string[]>();
  for (const site of sites) members.set(siteKey(site), []);
  for (const building of buildings) {
    let nearest: SettlementSite | undefined;
    let nearestDistance = RADIUS;
    for (const site of sites) {
      const gap = distance(site.position, building.position);
      if (gap <= nearestDistance) {
        nearest = site;
        nearestDistance = gap;
      }
    }
    // Nothing within reach, or every site is farther than the radius: the building is in no place.
    if (nearest) members.get(siteKey(nearest))!.push(building.id);
  }

  return sites.map((site, index) => {
    const buildingIds = members.get(siteKey(site))!;
    return {
      id: `settlement-${index + 1}`,
      type: 'settlement',
      kind: kindFor(buildingIds.length),
      position: site.position,
      radius: RADIUS,
      clearing: site.clearing,
      metadata: { buildingIds },
    };
  });
}

/** Two sites are distinguished by their clearing, which is unique per site. */
function siteKey(site: SettlementSite): string {
  return `${site.position.x},${site.position.y}`;
}

function kindFor(buildingCount: number): SettlementKind {
  if (buildingCount < VILLAGE_AT) return 'hamlet';
  if (buildingCount < TOWN_AT) return 'village';
  return 'town';
}
