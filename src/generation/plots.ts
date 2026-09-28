import type {
  GroundPlotEntity,
  Point,
  PolygonGeometry,
  SettlementEntity,
  VegetationEntity,
  WaterRegion,
} from '../map/GameMap.js';
import { circleIntersectsPolygon, pointInPolygon } from '../map/geometry.js';
import { distance } from './ribbon.js';
import type { SettlementSite } from './settlements.js';

/** What a plot is worked as. The two differ only in what stands on the ground. */
export type PlotKind = 'field' | 'orchard';

/**
 * How far from a settlement centre a plot is offered, in world units.
 *
 * The inner bound clears the settlement's own green, which reaches 28 units, and the outer bound stops
 * just inside the settlement's 260-unit radius, so a plot is ground the place reaches rather than the
 * next place's. A field further out than that is not this settlement's field; it is a farmstead the
 * caller should place themselves, with a building of their own.
 *
 * The outer bound is the limit on how many plots a map can hold, and it was set by measurement rather
 * than by taste. The ring holds about 200,000 square units around a centre, and two plots cannot be
 * closer than the sum of their half-diagonals, so at these sizes twenty plots need roughly three
 * quarters of it packed. Widening the ring past the settlement's own reach was tried first and bought
 * a further twelve percent, which is not worth a field that belongs to somewhere else.
 */
const RING_INNER = 46;
const RING_OUTER = 255;

/**
 * How large a plot is, in world units across and along its rows.
 *
 * A field has to read as a field at fit zoom and has to be big enough to work, and it has to be small
 * enough that several of them fit around a village. At 44 to 96 across and 32 to 64 along, a field is a
 * median 3,200 square units — about 57 by 57, which reads at fit zoom on a 2048 map and is a walk of a
 * few seconds from the settlement's edge.
 *
 * These numbers were halved from a first attempt at 64 to 128 by 44 to 88, and the yield is the reason:
 * a plot excludes a circle of its own half-diagonal, so at the larger size twenty of them needed more
 * ground than a settlement has and the count was routinely half honoured. A count is a ceiling, but a
 * ceiling met two times in three is not a useful knob.
 */
const WIDTH = { min: 44, max: 96 };
const DEPTH = { min: 32, max: 64 };

/**
 * How far apart an orchard's trees stand, in world units.
 *
 * Across the row the trees are near enough to read as one planted line and far enough that the
 * canopies do not merge into a single blob, which is the whole difference between an orchard and a
 * copse. Along it they are far enough apart to be counted. At the first attempt the trees were 9
 * apart with a canopy radius of 6 and the whole grid drew as one dark clump indistinguishable from
 * woodland; the gap is what the rows live in.
 *
 * The trunk is a blocker and the gap between trunks has to stay wider than a raster cell a consumer
 * is likely to bake at, or the whole row walls itself off.
 */
const TREE_ACROSS = 11;
const TREE_ALONG = 14;

/**
 * How far a row may wander off its grid, in world units.
 *
 * A perfectly regular grid is the tell of a procedural orchard, and at fit zoom the rows moire
 * against the field grid underneath. Two and a half units is enough to break the pattern and small
 * enough that the row is still a row.
 */
const JITTER = 2.5;

/**
 * The canopy an orchard tree is drawn with, which is smaller than a wood tree's.
 *
 * This is the drawing, not the collision: the trunk is a circle of 3 whatever the canopy is, and it is
 * the trunk that blocks. The number is set by the gap between trees rather than the other way round,
 * because a canopy that touches its neighbour's is a hedge and not a row.
 */
const CANOPY = 4.5;

/**
 * How many trees an orchard needs before it is one.
 *
 * Below this the grid has been eaten by water or rock, and what is left reads as scrub on a field
 * rather than as an orchard, so the site is not offered at all.
 */
const MIN_ORCHARD_TREES = 5;

/** How many candidates a settlement gets per plot it is asked for, before spacing rejects any. */
const ATTEMPTS = 20;

/** A plot chosen on the ground, before the trees and buildings that keep off it exist. */
export interface PlotSite {
  kind: PlotKind;
  position: Point;
  /** Radians, the heading of the long axis. The rows run across it. */
  rotation: number;
  /** Across the rows, in world units. */
  width: number;
  /** Along the rows, in world units. */
  depth: number;
  /** The distance from the centre to the furthest corner, kept so the next plot can keep off this one. */
  half: number;
  /** The worked ground itself, published so a consumer never reconstructs it. */
  geometry: PolygonGeometry;
  /** The centre of the settlement this plot belongs to, resolved to an id once that place exists. */
  settlement: Point;
  /** An orchard's rows. Empty on a field, which is worked ground and stands nothing. */
  trees: VegetationEntity[];
}

/**
 * Chooses where the fields and orchards are, before trees and buildings exist.
 *
 * Deciding them here is what lets a field be a keep-out rather than a hole punched later, and the
 * same argument the settlement sites make: the tree placer already refuses to plant in a road
 * corridor and in a settlement's green, so a field reaches it as one more ground that must stay
 * open. The orchard rows are made here too, because a tree is a tree — it goes into `vegetation`,
 * it blocks walking, and it is grouped into a grove like any other — and a tree that is planted after
 * the groves are built is a tree nothing else on the map knows about.
 *
 * A plot is a mark on worked ground rather than a collision shape, so the placement test samples the
 * rectangle's centre and corners instead of intersecting two polygons. A corner two units into a road
 * verge is a field that abuts a road, which is the normal case, and the exact test that matters is
 * the one the tree placer runs against the published rectangle.
 *
 * The rows are a grid, and a grid is the one thing here that is not random, so a plot's draw comes
 * from the stream of the plot it belongs to. Reweighting fields against orchards moves plots and
 * nothing else.
 */
export function plotSites(
  sites: SettlementSite[],
  water: WaterRegion[],
  /** Rock and the beach band: ground a tree does not root in, and which no field is cut into. */
  noTrees: PolygonGeometry[],
  /** Road surfaces, which a field is not ploughed across. */
  roads: PolygonGeometry[],
  counts: { field: number; orchard: number },
  width: number,
  height: number,
  random: () => number,
): PlotSite[] {
  if (sites.length === 0 || (counts.field <= 0 && counts.orchard <= 0)) return [];

  // Ground a plot may not be cut into. Rock and beach are one list because the test is the same for
  // both, the same way it is for a tree.
  const refused = (at: Point) =>
    water.some((body) => pointInPolygon(at, body.geometry)) ||
    noTrees.some((ground) => pointInPolygon(at, ground)) ||
    roads.some((road) => pointInPolygon(at, road)) ||
    sites.some((site) => pointInPolygon(at, site.clearing));

  // A tree is refused by its canopy rather than by its trunk, which is the rule the random tree
  // placer already follows and the one the validator enforces: a canopy that overhangs water is a
  // tree drawn in the lake. A plot is only a rectangle on the ground, so the centre test above is the
  // right one for it and this one is for what stands in it.
  const treeRefused = (at: Point) =>
    water.some((body) => circleIntersectsPolygon(at, CANOPY + 1, body.geometry)) ||
    noTrees.some((ground) => circleIntersectsPolygon(at, CANOPY + 1, ground)) ||
    roads.some((road) => pointInPolygon(at, road)) ||
    sites.some((site) => pointInPolygon(at, site.clearing));

  const chosen: PlotSite[] = [];
  const wanted: PlotKind[] = [
    ...Array.from({ length: Math.max(0, counts.field) }, () => 'field' as const),
    ...Array.from({ length: Math.max(0, counts.orchard) }, () => 'orchard' as const),
  ];

  for (const [index, kind] of wanted.entries()) {
    // Round-robin over the places, so one large settlement does not take every plot on the map and
    // leave the others with none. A map with more plots than places gives the first place the extras.
    const centre = sites[index % sites.length].position;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      // The ring is sampled in area rather than in angle, so a plot is as likely to land far out as
      // near, which a uniform angle would not give: it would crowd every plot against the green.
      const angle = random() * Math.PI * 2;
      const reach = Math.sqrt(
        RING_INNER * RING_INNER + random() * (RING_OUTER * RING_OUTER - RING_INNER * RING_INNER),
      );
      const position = {
        x: centre.x + Math.cos(angle) * reach,
        y: centre.y + Math.sin(angle) * reach,
      };
      // A field points back at the village it belongs to, which is both what a real grid does and
      // what makes the plots of one place read as a single holding rather than as four unrelated
      // rectangles. The jitter is a fifth of a turn, enough that two plots never line up.
      const rotation = angle + Math.PI + (random() - 0.5) * 0.7;
      const plotWidth = WIDTH.min + random() * (WIDTH.max - WIDTH.min);
      const plotDepth = DEPTH.min + random() * (DEPTH.max - DEPTH.min);
      const geometry = plotRectangle(position, rotation, plotWidth, plotDepth);
      const corners = geometry.points;

      // Two plots this far apart cannot overlap at all, whatever their headings, so one number
      // separates them. The half-diagonal is the distance from a centre to its furthest corner.
      const half = Math.hypot(plotWidth, plotDepth) / 2;
      if (chosen.some((other) => distance(other.position, position) < other.half + half)) continue;
      if (outOfBounds(position, corners, width, height)) continue;
      if ([position, ...corners].some(refused)) continue;

      const trees =
        kind === 'orchard'
          ? orchardTrees(
              `orchard-tree-${index + 1}`,
              position,
              rotation,
              plotWidth,
              plotDepth,
              treeRefused,
              random,
            )
          : [];
      // An orchard whose grid has been eaten by the river is not an orchard. Offering it as a field
      // instead of dropping it keeps the count the caller asked for, and a bare plot is a bare plot.
      // The trees it gave up are not published at all: nothing has added them to `vegetation` yet,
      // so dropping them here is the difference between a field and a field with a few strays in it
      // that a validator would then rightly refuse.
      const planted = trees.length >= MIN_ORCHARD_TREES ? trees : [];
      chosen.push({
        kind: planted.length > 0 ? 'orchard' : 'field',
        position,
        rotation,
        width: plotWidth,
        depth: plotDepth,
        half,
        geometry,
        settlement: centre,
        trees: planted,
      });
      break;
    }
  }
  return chosen;
}

/**
 * Publishes the plots, once the places they belong to exist.
 *
 * A plot names the settlement that owns it, and a settlement is only published once its buildings
 * are, so this waits like a dock does. The match is on the centre rather than on an index, because
 * the two functions are free to reorder their own lists and an index would make one of them a lie
 * rather than a mistake.
 */
export function generatePlots(
  plots: PlotSite[],
  settlements: SettlementEntity[],
): GroundPlotEntity[] {
  const entities: GroundPlotEntity[] = [];
  for (const [index, plot] of plots.entries()) {
    const owner = settlements.find((place) => distance(place.position, plot.settlement) < 0.001);
    // A plot with no place is not a plot: it is a rectangle standing in a field somewhere, and a
    // consumer following `settlementId` would be sent nowhere.
    if (!owner) continue;
    entities.push({
      id: `plot-${index + 1}`,
      type: 'ground-plot',
      kind: plot.kind,
      position: plot.position,
      rotation: plot.rotation,
      width: plot.width,
      depth: plot.depth,
      geometry: plot.geometry,
      asset: {
        category: plot.kind === 'orchard' ? 'ground.orchard' : 'ground.field',
        variant: `${plot.kind}-1`,
      },
      metadata: { settlementId: owner.id, treeIds: plot.trees.map((tree) => tree.id) },
    });
  }
  return entities;
}

/**
 * The rows of an orchard, as real trees.
 *
 * A tree is a tree: it goes into `vegetation`, its trunk is a blocker, and the grove builder groups
 * it like any other. An orchard published as a rectangle and a count would leave the consumer adding
 * its own collision, which is the one thing the generator owns.
 */
function orchardTrees(
  /**
   * The id prefix. Ids are unique across the whole map, not within one orchard, so a second orchard
   * on the same map does not publish a second `orchard-tree-1` and collide with the first.
   */
  prefix: string,
  centre: Point,
  rotation: number,
  plotWidth: number,
  plotDepth: number,
  refused: (at: Point) => boolean,
  random: () => number,
): VegetationEntity[] {
  const along = { x: Math.cos(rotation), y: Math.sin(rotation) };
  const across = { x: -along.y, y: along.x };
  const rows = Math.max(1, Math.floor(plotDepth / TREE_ALONG));
  const perRow = Math.max(1, Math.floor(plotWidth / TREE_ACROSS));
  const grid: VegetationEntity[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const line: VegetationEntity[] = [];
    const d = ((row + 0.5) / rows - 0.5) * plotDepth;
    for (let column = 0; column < perRow; column += 1) {
      const w = ((column + 0.5) / perRow - 0.5) * plotWidth;
      const position = {
        x: centre.x + along.x * d + across.x * w + (random() - 0.5) * JITTER,
        y: centre.y + along.y * d + across.y * w + (random() - 0.5) * JITTER,
      };
      // A row is not worth redrawing around one bad tree. The tree is dropped and the row runs on,
      // which is what a river through an orchard does at the edge of it.
      if (refused(position)) continue;
      line.push({
        id: '',
        type: 'tree',
        species: 'orchard',
        position,
        radius: CANOPY,
        rotation: random() * Math.PI * 2,
        collision: { type: 'circle', center: { ...position }, radius: 3 },
        asset: { category: 'vegetation.orchard', variant: `row-${(column % 2) + 1}` },
      });
    }
    grid.push(line);
  }
  // A row the river or the cliff has eaten down to one tree is not a row, it is a stray tree in a
  // field, and two of them make a scatter rather than a planting. A row has to have a line in it.
  // Dropping the whole line rather than the odd tree keeps the rows evenly spaced, which is the one
  // thing that makes the planting read as deliberate.
  return grid
    .filter((line) => line.length >= 2)
    .flat()
    .map((tree, index) => ({ ...tree, id: `${prefix}-${index + 1}` }));
}

/** The worked ground, as a rectangle laid on its heading. */
function plotRectangle(
  centre: Point,
  rotation: number,
  width: number,
  depth: number,
): PolygonGeometry {
  const along = { x: Math.cos(rotation), y: Math.sin(rotation) };
  const across = { x: -along.y, y: along.x };
  const corner = (d: number, w: number): Point => ({
    x: centre.x + along.x * d + across.x * w,
    y: centre.y + along.y * d + across.y * w,
  });
  return {
    points: [
      corner(-depth / 2, -width / 2),
      corner(depth / 2, -width / 2),
      corner(depth / 2, width / 2),
      corner(-depth / 2, width / 2),
    ],
  };
}

/** True when a plot would leave the world, which a polygon outside the bounds is not a valid one. */
function outOfBounds(centre: Point, corners: Point[], width: number, height: number): boolean {
  return [centre, ...corners].some(
    (point) => point.x < 0 || point.y < 0 || point.x > width || point.y > height,
  );
}
