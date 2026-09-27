import type { BuildingEntity, Point, RoadEntity, SettlementEntity } from '../map/GameMap.js';
import { distance } from './ribbon.js';

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
 * Places settlements on the road network, each claiming the buildings around it.
 *
 * A settlement is a place, so its centre is on a road: that is where frontage is, and a road is the
 * only thing on a map that gives a building a reason to stand where it does. Centres are chosen a
 * minimum distance apart and the buildings within `RADIUS` of each one join it, so the settlement is
 * something the buildings are in rather than a description of where they happened to land.
 *
 * A settlement claims buildings by proximity and nothing else, so a centre that ends up with no
 * buildings near it publishes an empty membership rather than being dropped. A map asking for more
 * settlements than its `buildings.density` can fill gets empty ones, which is a dead settlement, and
 * it is reached by mixing the two parameters rather than by a switch.
 *
 * `ponytail:` the centre is any point on any road, so a centre can land on a switchback that climbs
 * a cliff, which is frontage nobody settled on. Test the ground under the road when a settlement is
 * ever seen in the wrong place; it is a filter on the candidate list and nothing else changes.
 */
export function generateSettlements(
  roads: RoadEntity[],
  buildings: BuildingEntity[],
  count: number,
  random: () => number,
): SettlementEntity[] {
  if (count <= 0 || roads.length === 0) return [];

  // Every point along every centreline is a candidate. A settlement wants frontage rather than a
  // particular road, so the whole network is fair game and the separation is what keeps two centres
  // off the same stretch of tarmac.
  const candidates: Point[] = [];
  for (const road of roads) candidates.push(...road.path);
  if (candidates.length === 0) return [];

  // Walk the candidates in a shuffled order so a fixed seed still scatters the centres over the
  // network instead of always taking the first few roads, but the same seed always takes the same
  // ones. Shuffling the list and taking the first point that clears the separation is a rejection
  // sample, and costs nothing at the handful of candidates a map has.
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }

  const centres: Point[] = [];
  for (const candidate of candidates) {
    if (centres.length >= count) break;
    if (centres.some((centre) => distance(centre, candidate) < MIN_SEPARATION)) continue;
    centres.push(candidate);
  }

  return centres.map((centre, index) => ({
    id: `settlement-${index + 1}`,
    type: 'settlement',
    position: centre,
    radius: RADIUS,
    metadata: {
      buildingIds: buildings
        .filter((building) => distance(centre, building.position) <= RADIUS)
        .map((building) => building.id),
    },
  }));
}
