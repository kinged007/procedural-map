import type {
  EnemyGround,
  EnemySettlementEntity,
  GameMap,
  Point,
  VegetationEntity,
} from '../map/GameMap.js';
import { clearRun, offsetPoint, outwardFaces, pointInPolygon } from '../map/geometry.js';
import { distance } from './ribbon.js';

/**
 * How far a camp reaches from its centre, in world units.
 *
 * Smaller than a settlement's 260 and larger than its 28-unit clearing. A camp has no buildings to
 * ring and no traffic to carry, so it does not need the room a settlement does, but it is a place a
 * character stands in rather than a dot on a map, and 40 is what fits a handful of tents with a path
 * between them.
 */
const SITE_RADIUS = 40;

/** How far apart two camps must be, in world units. Two radii, so their footprints never touch. */
const CAMP_SPACING = SITE_RADIUS * 2;

/** How often the ground is sampled for a camp, in world units. */
const SAMPLE_STEP = 48;

/** How often a hull or a cliff face is sampled along its outline, in world units. */
const OUTLINE_STEP = 8;

/** How many segments approximate the camp's footprint. */
const SITE_SEGMENTS = 20;

/**
 * How a camp sits relative to what it is set against, in world units.
 *
 * A camp is on the ground, never inside the thing it is set against: rock blocks, and a camp in a
 * cliff is a dot on a wall. Four units is the same offset a mine uses, far enough to clear the face
 * and near enough that the camp still reads as being at it.
 */
const OUTSIDE_BITE = 4;

/**
 * How far in from a grove's edge a wood camp sits, in world units.
 *
 * Just inside, so the camp is in the wood and the arrow is the way out of it. A camp placed on the
 * hull's boundary is as good as on open ground with trees drawn over it, and a camp placed deeper in
 * is a clearing the generator did not cut.
 */
const INSIDE_BITE = 12;

/**
 * The clear run a camp must have from whatever it is set against, in world units.
 *
 * The same reach a resource entrance is given, and for the same reason: a camp with four units of
 * daylight and then a wall is not a camp a character can leave, and the arrow on it would promise a
 * way out that is not there.
 */
const ENTRANCE_REACH = 16;

/**
 * How few trees a grove can have and still hold a camp, in trees.
 *
 * The same floor a hunting site uses. A grove of four trees is a copse; a camp in it is a camp in a
 * hedge, and a consumer that wants to clear the trees for it would be cutting down the whole map's
 * visible woodland one copse at a time.
 */
const MIN_WOOD_TREES = 20;

/**
 * How far a camp is held inside the map edge, in world units.
 *
 * The same inset a mine and a hunting site are given. A camp on the edge is half a camp: the
 * consumer's building footprint runs off the map, and the ground the generator measured as clear
 * behind it is not there.
 */
const EDGE_INSET = 80;

/** A place the map offers as ground for a camp, and what would be set against it. */
interface Candidate {
  position: Point;
  ground: EnemyGround;
  /** The direction a character approaches from, for the grounds that are set against something. */
  rotation?: number;
  forestId?: string;
  rockId?: string;
}

/**
 * Sits enemy camps on the ground.
 *
 * A camp is a site and nothing else: where it is, how far it reaches, and the ground under it. It
 * carries no buildings, so a consumer decides what stands in it, and no collision, so a camp is not
 * an obstacle until the consumer builds one. That is the whole of it, and the weight of the
 * generator is spent making sure the place is one a character can reach and leave.
 *
 * Three grounds, because the three the caller may weight are genuinely different placements and not
 * one placement with a label: a wood camp is inside a grove and faces out of it, a rock camp stands
 * off a cliff and faces away from it, and an open camp is on open ground with nothing set into and so
 * publishes no facing. All three are measured against the same published walkability, and a site that
 * cannot be entered is not published at all.
 */
export function generateEnemySettlements(
  map: GameMap,
  resolved: { count: number; minDistance: number; grounds: Record<EnemyGround, number> },
  random: () => number,
): EnemySettlementEntity[] {
  if (resolved.count <= 0) return [];
  const woods = map.forests.filter(
    (forest) => forest.metadata.walkableInside && forest.metadata.treeCount >= MIN_WOOD_TREES,
  );
  // Only rock that collides. A rock region without a collision is a face a character walks through,
  // and a camp set against one of those is set against nothing.
  const rocks = map.terrain.filter((region) => region.kind === 'rock' && region.collision);
  const water = map.water;

  /**
   * How far a point is from the nearest player settlement's centre, which is what
   * `enemies.minDistance` measures from. A map with no settlements has nothing to be far from, so the
   * gap is infinite and every site passes, rather than the comparison against a fallback that would
   * silently refuse a camp on a map that has no town to keep it away from.
   */
  const gap = (at: Point): number =>
    map.settlements.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(...map.settlements.map((settlement) => distance(at, settlement.position)));

  /**
   * Everything a camp's own ground must not be: water, rock, and the buildings that stand on it.
   *
   * Trees are deliberately absent, and a trunk with a camp on it is not refused either: a character
   * walks round a trunk, and a single trunk in a camp's ground is the thing a consumer clears when
   * it builds there. What the ground must not have is a hole or a cliff in it.
   */
  const blocked = (at: Point): boolean =>
    water.some((body) => pointInPolygon(at, body.geometry)) ||
    rocks.some((rock) => rock.collision && pointInPolygon(at, rock.collision)) ||
    map.structures.some((building) => building.collision && pointInPolygon(at, building.collision));

  const clearOfEdge = (at: Point): boolean =>
    at.x >= EDGE_INSET &&
    at.y >= EDGE_INSET &&
    at.x <= map.bounds.width - EDGE_INSET &&
    at.y <= map.bounds.height - EDGE_INSET;

  /**
   * Whether the whole of a camp's footprint stands out of the water.
   *
   * The centre is not enough, and this is the same trap a plot fell into with a river: a centre on
   * dry ground says nothing about the 40-unit footprint around it, and over the reference map a
   * third of the camps had a shore running through the edge of their own ground. A consumer building
   * inside the footprint it was handed would have put a tent in a lake.
   *
   * Only water is tested. Rock deliberately is not: a camp is sited at the foot of a cliff with the
   * cliff behind it, so the footprint reaching back over the rock it shelters against is the point
   * rather than a failure, and a cliff is cover rather than a hole.
   */
  const footprintDry = (centre: Point): boolean => {
    const rim = footprint(centre, SITE_RADIUS);
    for (let index = 0; index < rim.length; index += 1) {
      const a = rim[index];
      const b = rim[(index + 1) % rim.length];
      // The vertex and the middle of the stretch between it and the next, so a shore running across
      // one 12-unit gap is still caught.
      for (const at of [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }])
        if (water.some((body) => pointInPolygon(at, body.geometry))) return false;
    }
    return true;
  };

  // The distance rule needs no second clause about the settlement's own radius: a settlement reaches
  // 260 units and a camp 40, so at the 800-unit default there are 500 units between the two and a
  // camp that clears the distance cannot overlap a clearing. The radius only starts to matter for a
  // caller who asks for a camp inside a town, and that is a count of zero, not a placement to argue
  // about.
  const farEnough = (at: Point): boolean => gap(at) >= resolved.minDistance;

  const tooClose = (at: Point, placed: Point[]): boolean =>
    placed.some((other) => distance(other, at) < CAMP_SPACING);

  /**
   * A camp in a grove: just inside the hull, facing a face that has the full reach of clear ground
   * behind it.
   *
   * Every neighbouring grove blocks the run, not just the one the camp is in. Two groves whose hulls
   * are a few units apart are one wood to a character standing between them, so a face that clears
   * the wood the camp is in while pointing straight at the next one is not a way out. The camp
   * itself is required to be outside every other hull for the same reason: a camp that is in two
   * groves at once has no single face to face out of.
   *
   * One camp per grove. There is nothing to choose between a grove's several clear faces, and taking
   * the first one means the count cannot be used to crowd a single wood with camps.
   */
  const woodCandidates = (placed: Point[]): Candidate[] => {
    const out: Candidate[] = [];
    for (const forest of woods) {
      const neighbourHulls = map.forests
        .filter((near) => near.id !== forest.id)
        .map((near) => near.geometry);
      const hemmedIn = (at: Point) =>
        blocked(at) || neighbourHulls.some((hull) => pointInPolygon(at, hull));
      for (const face of outwardFaces(forest.geometry, OUTLINE_STEP)) {
        if (clearRun(face.at, face.outward, hemmedIn, ENTRANCE_REACH) !== ENTRANCE_REACH) continue;
        const site = offsetPoint(face.at, face.outward, -INSIDE_BITE);
        if (!clearOfEdge(site) || !farEnough(site) || tooClose(site, placed)) continue;
        if (neighbourHulls.some((hull) => pointInPolygon(site, hull))) continue;
        if (!footprintDry(site)) continue;
        out.push({
          position: site,
          ground: 'wood',
          rotation: Math.atan2(face.outward.y, face.outward.x),
          forestId: forest.id,
        });
        break;
      }
    }
    return out;
  };

  /**
   * A camp at the foot of a cliff: off the face by `OUTSIDE_BITE`, on the side the face points to,
   * with the cliff behind it and the open ground in front. The face's own outward normal is the
   * direction the camp faces, which is the one the generator checked for a clear run.
   */
  const rockCandidates = (placed: Point[]): Candidate[] => {
    const out: Candidate[] = [];
    for (const rock of rocks) {
      if (!rock.collision) continue;
      for (const face of outwardFaces(rock.collision, OUTLINE_STEP)) {
        if (clearRun(face.at, face.outward, blocked, ENTRANCE_REACH) !== ENTRANCE_REACH) continue;
        const site = offsetPoint(face.at, face.outward, OUTSIDE_BITE);
        if (!clearOfEdge(site) || !farEnough(site) || tooClose(site, placed)) continue;
        if (!footprintDry(site)) continue;
        out.push({
          position: site,
          ground: 'rock',
          rotation: Math.atan2(face.outward.y, face.outward.x),
          rockId: rock.id,
        });
        break;
      }
    }
    return out;
  };

  /**
   * A camp on open ground.
   *
   * Open means open: not in water, not on rock, not inside a grove's hull, and not under a canopy
   * the consumer would have to push through. The canopy test is the one a tree is kept off a beach
   * with, a radius grown by one, so "no canopy reaches here" means the same thing everywhere in the
   * generator.
   */
  const openCandidates = (placed: Point[]): Candidate[] => {
    const out: Candidate[] = [];
    for (let x = EDGE_INSET; x <= map.bounds.width - EDGE_INSET; x += SAMPLE_STEP)
      for (let y = EDGE_INSET; y <= map.bounds.height - EDGE_INSET; y += SAMPLE_STEP) {
        const site = { x, y };
        if (!farEnough(site) || tooClose(site, placed)) continue;
        if (blocked(site)) continue;
        if (map.forests.some((forest) => pointInPolygon(site, forest.geometry))) continue;
        if (map.vegetation.some((tree) => underCanopy(site, tree))) continue;
        if (!footprintDry(site)) continue;
        out.push({ position: site, ground: 'open' });
      }
    return out;
  };

  const pools: Record<EnemyGround, Candidate[]> = {
    wood: woodCandidates([]),
    rock: rockCandidates([]),
    open: openCandidates([]),
  };

  const weights = (Object.keys(resolved.grounds) as EnemyGround[])
    .map((ground) => ({ ground, weight: resolved.grounds[ground] }))
    .filter((entry) => entry.weight > 0);
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);

  const sites: EnemySettlementEntity[] = [];
  const placed: Point[] = [];
  // Each pool is shuffled once and consumed from the front, and the ground is drawn per camp, so a
  // camp's position is decided by its own ground's list and its own draw. Drawing all the grounds up
  // front and interleaving afterwards would make one ground's count move another's sites, which is
  // the thing independent streams exist to prevent.
  for (const pool of Object.values(pools)) shuffle(pool, random);
  // A pool can run dry before the count is met, so the loop draws rather than counts: a caller who
  // asked for eight camps on a map with two cliff faces takes the two and the six, rather than
  // having the ground re-weighted to invent six more.
  for (let draw = 0; draw < resolved.count * 24 && sites.length < resolved.count; draw += 1) {
    const ground = pick(weights, total, random);
    const pool = pools[ground];
    const candidate = pool.shift();
    if (!candidate) continue;
    if (tooClose(candidate.position, placed)) continue;
    placed.push(candidate.position);
    sites.push({
      id: `enemy-settlement-${sites.length + 1}`,
      type: 'enemySettlement',
      position: candidate.position,
      radius: SITE_RADIUS,
      geometry: { points: footprint(candidate.position, SITE_RADIUS) },
      asset: { category: 'structure.camp', variant: `camp-${candidate.ground}` },
      ...(candidate.rotation === undefined ? {} : { rotation: candidate.rotation }),
      metadata: {
        ground: candidate.ground,
        // A map with no settlements has nothing to measure from, and publishing a distance of
        // infinity would be a number no JSON map can carry. The field is absent instead, and
        // `enemies.minDistance` has nothing to say on a map that has no town to keep camps away from.
        ...(gap(candidate.position) === Number.POSITIVE_INFINITY
          ? {}
          : { distanceToSettlement: gap(candidate.position) }),
        ...(candidate.forestId === undefined ? {} : { forestId: candidate.forestId }),
        ...(candidate.rockId === undefined ? {} : { rockId: candidate.rockId }),
      },
    });
  }
  return sites;
}

/** A camp's footprint: the same circle a settlement clearing is drawn with. */
function footprint(centre: Point, radius: number): Point[] {
  const points: Point[] = [];
  for (let index = 0; index < SITE_SEGMENTS; index += 1) {
    const angle = (index / SITE_SEGMENTS) * Math.PI * 2;
    points.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
  }
  return points;
}

/**
 * Whether a tree's canopy reaches `at`.
 *
 * The one unit of margin is the allowance a tree is kept off a beach and a road verge with, so
 * "no canopy reaches here" means the same thing here as everywhere else in the generator. A canopy
 * that exactly touches the ground is covering it as far as a consumer drawing one is concerned, so
 * the test is `<=` and not `<`.
 */
function underCanopy(at: Point, tree: VegetationEntity): boolean {
  return distance(at, tree.position) <= tree.radius + 1;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

/** One ground, drawn in proportion to its weight, or nothing when every weight is zero. */
function pick<T>(
  weighted: { ground: T; weight: number }[],
  total: number,
  random: () => number,
): T {
  let roll = random() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll < 0) return entry.ground;
  }
  return weighted[weighted.length - 1].ground;
}
