import type {
  GameMap,
  Point,
  PolygonGeometry,
  ResourceSiteEntity,
  TerrainRegion,
  WaterRegion,
} from '../map/GameMap.js';
import { boundsOf, pointInPolygon, polygonArea } from '../map/geometry.js';
import { distance } from './ribbon.js';

/**
 * How far inside the boundary a marker sits, in world units.
 *
 * A site is asked for at the edge of a rock face or a wood and given a facing out of it, and this is
 * the overlap that makes that edge checkable rather than a matter of taste: the marker ends up
 * strictly inside the polygon it names, so a consumer can test `pointInPolygon(site.position,
 * forest.geometry)` or against a rock and get an answer that means something, where a marker sitting
 * exactly on the boundary is ambiguous to the point-in-polygon test the game will run on a raster it
 * chose itself. It is also why the face is sampled at the middle of each stretch of outline and never
 * at a vertex: at a sharp corner the two normals belong to the two edges meeting there, and stepping
 * back along one of them leaves the polygon instead of entering it.
 */
const INSIDE_BITE = 4;

/**
 * How far clear of the edge a site's approach has to be, in world units.
 *
 * The arrow points out of the rock or out of the wood, so what matters is that it points somewhere a
 * character can go, for the whole of its length rather than for its first step. That distinction is
 * the whole reason a hunting site is refused an edge facing a neighbouring grove: an edge with four
 * units of daylight and then more wood is an edge facing more wood, and a first-clear-step test
 * accepts it. Requiring all 16 cost no groves at all — over fifteen maps every wood that passed the
 * size test still had one fully clear edge.
 *
 * Only rock, water and other forests are tested. A single tree trunk near a mine mouth or a hunting
 * stand is a wood, and a character walks around one; refusing a face over one trunk would take whole
 * hillsides and whole groves out of the candidate pool for something that is not in the way.
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

/** A point on a polygon's outline, and a direction that leads out of it. */
interface Face {
  at: Point;
  outward: Point;
}

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
 * outward normal there: the direction that leaves the rock, which is the direction out. Every rock is
 * tested for the approach, not only the one the face belongs to: a mine driven into a seam between two
 * outcrops has rock on both sides and an entrance in a wall.
 */
function mines(map: GameMap, count: number, random: () => number): ResourceSiteEntity[] {
  if (count <= 0) return [];
  const rocks = map.terrain.filter((region) => region.kind === 'rock');
  if (rocks.length === 0) return [];
  const water = map.water;
  // Every rock, not only the one the face belongs to. A mine driven into a seam between two
  // outcrops has rock on both sides and an entrance in a wall, and testing only the named region
  // would have called that a face.
  const blocked = (at: Point) =>
    rocks.some((rock) => pointInPolygon(at, rock.geometry)) || inWater(at, water);

  // Shuffled so a fixed seed does not fill the first rock, and so the same faces are offered for the
  // same seed at every count.
  const faces: { rock: TerrainRegion; at: Point; outward: Point }[] = [];
  for (const rock of rocks)
    for (const face of outwardFaces(rock.geometry, SAMPLE_STEP)) faces.push({ rock, ...face });
  for (let index = faces.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [faces[index], faces[swap]] = [faces[swap], faces[index]];
  }

  const sites: ResourceSiteEntity[] = [];
  for (const face of faces) {
    if (sites.length >= count) break;
    if (clearRun(face.at, face.outward, blocked, ENTRANCE_REACH) !== ENTRANCE_REACH) continue;
    const position = offset(face.at, face.outward, -INSIDE_BITE);
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
 * Huntable woods, on the edge of the wood and facing out of it.
 *
 * A hunting ground is somewhere a character walks to and then has room to hunt, so the site cannot
 * be in the middle of a grove: the trunks are the obstacle, and a stand in the middle of a wood is a
 * stand nobody can reach. It sits on the hull's own outline with the arrow pointing out, and the
 * ground it points at has to be clear.
 *
 * "Clear" excludes the neighbouring grove specifically, and that is the case this rule exists for. Two
 * groves of one wood are separate hulls because their trees are more than the link distance apart, but
 * their hulls can be within a stride of each other, and an edge facing a neighbour is an edge that
 * faces more wood. Rock and water are in the same test because a stand against a cliff is the same
 * problem.
 *
 * One site per grove, taking the first edge on the outline that faces somewhere open. There is no
 * shuffle, because there is nothing to choose between: every grove gets exactly one stand, so which
 * of its several open edges it gets is a matter of no consequence, and not drawing a stream keeps
 * the count from reshuffling the mining and the fishing.
 */
function hunting(map: GameMap, count: number): ResourceSiteEntity[] {
  if (count <= 0) return [];
  const rocks = map.terrain.filter((region) => region.kind === 'rock');
  const blocked = (at: Point) =>
    map.forests.some((forest) => pointInPolygon(at, forest.geometry)) ||
    rocks.some((rock) => pointInPolygon(at, rock.geometry)) ||
    inWater(at, map.water);

  const sites: ResourceSiteEntity[] = [];
  for (const forest of map.forests) {
    if (sites.length >= count) break;
    if (forest.metadata.treeCount < MIN_WOOD_TREES || !forest.metadata.walkableInside) continue;
    const face = firstClearFace(forest.geometry, blocked);
    if (!face) continue;
    const position = offset(face.at, face.outward, -INSIDE_BITE);
    if (sites.some((site) => distance(site.position, position) < SPACING)) continue;
    sites.push({
      id: '',
      type: 'resource-site',
      kind: 'hunting',
      position,
      rotation: Math.atan2(face.outward.y, face.outward.x),
      asset: { category: 'vegetation.hunt', variant: 'stand-1' },
      metadata: { forestId: forest.id },
    });
  }
  return sites;
}

/** The first edge on a hull's outline that faces clear ground, or nothing if the wood is hemmed in. */
function firstClearFace(
  geometry: PolygonGeometry,
  blocked: (at: Point) => boolean,
): { at: Point; outward: Point } | undefined {
  for (const face of outwardFaces(geometry, SAMPLE_STEP))
    if (clearRun(face.at, face.outward, blocked, ENTRANCE_REACH) === ENTRANCE_REACH) return face;
  return undefined;
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
 * How far out along `normal` the ground stays clear of `blocked`, capped at `reach`.
 *
 * This is the length of the clear run, not the first clear step, and the difference is the whole
 * point. A first-clear-step test accepts a face with four units of daylight and then a wall, so the
 * arrow points out of a grove and into the wood next door, which is the case this was written to
 * stop. A caller that needs the full reach asks for it by comparing the result with `reach`.
 */
function clearRun(
  at: Point,
  normal: Point,
  blocked: (at: Point) => boolean,
  reach: number,
): number {
  let clear = 0;
  for (let step = 4; step <= reach; step += 4)
    if (blocked(offset(at, normal, step))) break;
    else clear = step;
  return clear;
}

/**
 * Points along a polygon's outline, each with a direction that leads out of it.
 *
 * The direction out is a perpendicular to the outline there, which is the normal. A polygon's own
 * vertices are too coarse to aim at: a contour vertex can be a hundred units from its neighbours, and
 * the stretch between two of them is the edge a character would stand at.
 *
 * A sample yields one face where only one perpendicular leaves the polygon, which is every sample of a
 * convex hull, and two where the outline is concave enough that both do. Both are real directions out
 * and the caller takes whichever clears, so neither is guessed at. A notch, where the polygon wraps
 * round three sides and neither perpendicular leads anywhere, yields nothing.
 */
function* outwardFaces(geometry: PolygonGeometry, step: number): Generator<Face> {
  for (const ring of [geometry.points, ...(geometry.holes ?? [])])
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[index + 1 === ring.length ? 0 : index + 1];
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span < step) continue;
      const count = Math.floor(span / step);
      const tangent = { x: (b.x - a.x) / span, y: (b.y - a.y) / span };
      for (let n = 0; n < count; n += 1) {
        // The middle of the sub-segment, never its start. A sample on a vertex is not on an edge in
        // any useful sense: the two normals there belong to the two edges meeting at it, and stepping
        // back along one of them at a sharp angle leaves the polygon instead of entering it, which
        // put a mark outside the very hull it named.
        const t = (n + 0.5) / count;
        const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        for (const outward of [
          { x: -tangent.y, y: tangent.x },
          { x: tangent.y, y: -tangent.x },
        ])
          if (!pointInPolygon(offset(at, outward, 3), geometry)) yield { at, outward };
      }
    }
}
