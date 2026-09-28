import type {
  ForestEntity,
  GameMap,
  Point,
  ResourceSiteEntity,
  TerrainRegion,
  WaterRegion,
} from '../map/GameMap.js';
import { boundsOf, pointInPolygon, polygonArea } from '../map/geometry.js';
import { distance } from './ribbon.js';

/**
 * How far inside the rock a mine marker sits, in world units.
 *
 * The user asked for a mine on the rock's edge with some overlap, and a small inward bite is what
 * makes that overlap checkable rather than a matter of taste: the marker ends up strictly inside the
 * polygon it names, so a consumer can test `pointInPolygon(site.position, rock.geometry)` and get an
 * answer that means something, and a marker sitting on the boundary is ambiguous to a point-in-polygon
 * test that the game will run on a raster it chose itself.
 */
const ENTRANCE_BITE = 4;

/**
 * How far clear of the rock a mine's entrance has to be, in world units.
 *
 * The arrow points out of the rock, so what matters is that it points somewhere a character can go.
 * Measured over six maps at 2048 by 1536, 98.6% of rock-face samples have open ground within 16 units
 * along the outward arrow and 99.1% within 24, so 16 costs about one face in seventy and takes the
 * cliff-inside-a-cliff samples that the arrow would otherwise point at solid rock.
 *
 * Only rock and water are tested. A tree near a mine mouth is a wood, and a character walks around
 * one; a second rock face opposite the first is a wall. Trees are deliberately not in this test
 * because refusing a face for one trunk would take whole hillsides out of the candidate pool over a
 * thing that is not in the way.
 */
const ENTRANCE_REACH = 16;

/**
 * The smallest body of water worth fishing, in square world units.
 *
 * The water on a generated map is sharply bimodal: most of it is pond, and then there are a few
 * lakes. Over eight maps the median body is 5.5k square units, which is a puddle, and the body size
 * distribution jumps rather than tapers, so any floor at all lands in the same gap. At 20k there are
 * 4.5 bodies per map, with inradii of 36 to 187 units, which is both enough sites to place and
 * enough open water to put a spot out of reach of the bank.
 */
const MIN_WATER_AREA = 20_000;

/**
 * How close to the bank a fishing spot can be and still be walked to, in world units.
 *
 * This is the line between `access: 'land'` and `access: 'water'`, and it is the one number in this
 * file that is a judgement rather than a measurement, because how far a character is willing to wade
 * is the game's decision. It is published as `distanceToShore` alongside the verdict, so a game that
 * would rather its spots were 50 units out reads the number and ignores `access`. 32 is a good walk
 * from the bank: the median inradius of a body that passes the floor is around 100, so roughly half
 * of a lake's area falls inside this and half outside, and both modes are actually reachable.
 */
const SHORE_REACH = 32;

/**
 * How few trees a grove can have and still be worth hunting, in trees.
 *
 * A grove of four trees is a copse and not a wood, and `densityPct` cannot tell them apart: it reads
 * 100 on every hull on a default map, because a hull is drawn tight around its own canopies, so
 * canopy coverage is full by construction. `treeCount` is the signal that carries, and 20 is about
 * where a grove stops being a few trees and starts being somewhere with something in it.
 */
const MIN_WOOD_TREES = 20;

/** How close one site may come to another, centre to centre, in world units. */
const SPACING = 24;

/** How often a rock face is sampled along its outline, in world units. */
const SAMPLE_STEP = 8;

/** How often open water is sampled, in world units. Finer than `SPACING`, so a body is not skipped. */
const WATER_STEP = 16;

/**
 * Where something can be gathered, named by the ground that makes it worth gathering there.
 *
 * The generator is deliberately neutral about what a site yields. There is no geology here: the
 * fields are elevation, moisture and vegetation, and nothing in the map says where iron is as opposed
 * to copper or flint, so a map that declared its own ores would be a generator with a fantasy bolted
 * to it. What it can say is the affordance, which is a fact about the ground: this is a rock face
 * with open ground in front of it, this is open water a long way from any bank, this is a wood big
 * enough to hold game. The caller decides what a site is worth, and builds there or does not.
 *
 * Each count is an upper bound, like a settlement count and a dock count. A map with no rock
 * publishes no mines at any count, and asking for more hunting than the woods will hold publishes
 * every wood there is rather than inventing one.
 *
 * Mines and fishing spots draw on separate streams, so a caller tuning one count does not reshuffle
 * which spots the other draws. A huntable wood needs no stream: it takes the woods in the order the
 * map published them, which is already deterministic.
 *
 * `ponytail:` every rock face and every fishable body is walked in full, which is cheap at 4.7 rocks
 * and 4.5 fishable lakes per default map. Index the outlines into a uniform grid when a caller
 * raises the counts until this is the step that costs.
 */
export function generateResourceSites(
  map: GameMap,
  counts: { mine: number; fishing: number; hunting: number },
  streams: { mine: () => number; fishing: () => number },
): ResourceSiteEntity[] {
  const sites = [
    ...mines(map, counts.mine, streams.mine),
    ...fishing(map, counts.fishing, streams.fishing),
    ...hunting(map, counts.hunting),
  ];
  return sites.map((site, index) => ({ ...site, id: `resource-site-${index + 1}` }));
}

/**
 * Mines on the rock faces that have open ground in front of them.
 *
 * A mine is cut into a face, so the site is on the outline of a rock region and the arrow is the
 * outward normal there: the direction that leaves the rock, which is the direction out. At a concave
 * section both perpendiculars lead out of the polygon and the normal is not unique, so the one with
 * the clearer approach wins, which is also the one a character would dig towards.
 */
function mines(map: GameMap, count: number, random: () => number): ResourceSiteEntity[] {
  if (count <= 0) return [];
  const rocks = map.terrain.filter((region) => region.kind === 'rock');
  if (rocks.length === 0) return [];
  const water = map.water;

  // Shuffled so a fixed seed does not take every face from the first rock, and so the same faces are
  // offered for the same seed at every count.
  const faces: { rock: TerrainRegion; at: Point; outward: Point }[] = [];
  for (const rock of rocks)
    for (const { at, tangent } of walkOutline(rock, SAMPLE_STEP)) {
      const left = { x: -tangent.y, y: tangent.x };
      const right = { x: tangent.y, y: -tangent.x };
      // The outward normal is the perpendicular that leaves the rock. A notch, where the rock wraps
      // around three sides, has no such side and is not a face anyone can dig into.
      const options = [left, right].filter((n) => !pointInPolygon(offset(at, n, 3), rock.geometry));
      if (options.length === 0) continue;
      const outward = options.reduce((best, n) =>
        approach(rock, at, n, water) > approach(rock, at, best, water) ? n : best,
      );
      faces.push({ rock, at, outward });
    }
  for (let index = faces.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [faces[index], faces[swap]] = [faces[swap], faces[index]];
  }

  const sites: ResourceSiteEntity[] = [];
  for (const face of faces) {
    if (sites.length >= count) break;
    if (approach(face.rock, face.at, face.outward, water) > ENTRANCE_REACH) continue;
    const position = offset(face.at, face.outward, -ENTRANCE_BITE);
    if (sites.some((site) => distance(site.position, position) < SPACING)) continue;
    sites.push({
      id: '',
      type: 'resource-site',
      kind: 'mine',
      position,
      rotation: Math.atan2(face.outward.y, face.outward.x),
      asset: { category: 'structure.mine', variant: 'adit-1' },
      metadata: { rockId: face.rock.id },
    });
  }
  return sites;
}

/**
 * How far out along `normal` a face has to reach before it is out in the open, capped at a long way.
 *
 * Returns a distance beyond `ENTRANCE_REACH` for a face that never gets there, so one number answers
 * both "is this face usable" and "which of these two normals is the better one".
 */
function approach(rock: TerrainRegion, at: Point, normal: Point, water: WaterRegion[]): number {
  for (let step = 4; step <= ENTRANCE_REACH * 2; step += 4) {
    const reached = offset(at, normal, step);
    if (!pointInPolygon(reached, rock.geometry) && !inWater(reached, water)) return step;
  }
  return ENTRANCE_REACH * 2 + 1;
}

/**
 * Fishing spots in the water, close to a bank or out in the open.
 *
 * The spot is in the water, never on it, and `access` says whether a character walks out to it or
 * rows. The split is a consequence of the map rather than a choice: a spot in a pond is always within
 * wading distance of a bank, and only a body big enough to pass `MIN_WATER_AREA` has water far enough
 * out to be worth boating to.
 */
function fishing(map: GameMap, count: number, random: () => number): ResourceSiteEntity[] {
  if (count <= 0) return [];
  const bodies = map.water.filter((body) => polygonArea(body.geometry) >= MIN_WATER_AREA);
  if (bodies.length === 0) return [];

  const candidates: { body: WaterRegion; at: Point; gap: number }[] = [];
  for (const body of bodies) {
    const box = boundsOf(body.geometry.points);
    // Sampled on a grid over the body's own box and kept where the water is, so the spots are spread
    // across the body rather than clustered on the bank the sampling happened to catch first.
    for (let x = box.minX + WATER_STEP; x < box.maxX; x += WATER_STEP)
      for (let y = box.minY + WATER_STEP; y < box.maxY; y += WATER_STEP) {
        const at = { x, y };
        if (!pointInPolygon(at, body.geometry)) continue;
        candidates.push({ body, at, gap: gapToShore(at, body) });
      }
  }
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }

  const sites: ResourceSiteEntity[] = [];
  for (const candidate of candidates) {
    if (sites.length >= count) break;
    if (sites.some((site) => distance(site.position, candidate.at) < SPACING)) continue;
    sites.push({
      id: '',
      type: 'resource-site',
      kind: 'fishing',
      position: candidate.at,
      asset: { category: 'structure.fishing', variant: 'shore-1' },
      metadata: {
        waterId: candidate.body.id,
        distanceToShore: candidate.gap,
        access: candidate.gap <= SHORE_REACH ? 'land' : 'water',
      },
    });
  }
  return sites;
}

/**
 * Huntable woods, at the middle of the grove.
 *
 * `walkableInside` is the field that earns its place here: it is the measured answer to whether a
 * character can get into a grove and back out, which is what separates a wood from a thicket, and
 * forest hulls are measured after the map is built for exactly this sort of question. A site at the
 * middle of a hull is inside it by construction, because a hull is convex.
 */
function hunting(map: GameMap, count: number): ResourceSiteEntity[] {
  if (count <= 0) return [];
  const woods = map.forests.filter(
    (forest) => forest.metadata.treeCount >= MIN_WOOD_TREES && forest.metadata.walkableInside,
  );
  return woods.slice(0, count).map((forest) => siteInWood(forest));
}

function siteInWood(forest: ForestEntity): ResourceSiteEntity {
  const box = boundsOf(forest.geometry.points);
  return {
    id: '',
    type: 'resource-site',
    kind: 'hunting',
    position: { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 },
    asset: { category: 'vegetation.hunt', variant: 'ground-1' },
    metadata: { forestId: forest.id },
  };
}

/** How far `point` is from the nearest shoreline of `body`, in world units, its islands included. */
function gapToShore(point: Point, body: WaterRegion): number {
  let best = Number.POSITIVE_INFINITY;
  for (const ring of [body.geometry.points, ...(body.geometry.holes ?? [])])
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[index + 1 === ring.length ? 0 : index + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const span = dx * dx + dy * dy;
      const t =
        span === 0
          ? 0
          : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / span));
      best = Math.min(best, distance(point, { x: a.x + dx * t, y: a.y + dy * t }));
    }
  return best;
}

/** Whether a point is in any body of water. */
function inWater(point: Point, water: WaterRegion[]): boolean {
  return water.some((body) => pointInPolygon(point, body.geometry));
}

function offset(point: Point, direction: Point, by: number): Point {
  return { x: point.x + direction.x * by, y: point.y + direction.y * by };
}

/**
 * Points along a region's outline and the tangent at each, spaced `step` apart.
 *
 * A region's own vertices are too coarse to aim a mine at: a contour vertex can be a hundred units
 * from its neighbours, and the face between two of them is the face a character would dig into.
 */
function* walkOutline(
  region: TerrainRegion,
  step: number,
): Generator<{ at: Point; tangent: Point }> {
  for (const ring of [region.geometry.points, ...(region.geometry.holes ?? [])])
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[index + 1 === ring.length ? 0 : index + 1];
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span < step) continue;
      const count = Math.floor(span / step);
      for (let n = 0; n < count; n += 1) {
        const t = n / count;
        yield {
          at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
          tangent: { x: (b.x - a.x) / span, y: (b.y - a.y) / span },
        };
      }
    }
}
