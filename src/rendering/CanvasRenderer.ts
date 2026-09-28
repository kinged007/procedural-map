import type {
  BuildingEntity,
  CollisionGeometry,
  DockEntity,
  GameMap,
  Point,
  PolygonGeometry,
  ResourceSiteEntity,
  RoadEntity,
  SettlementEntity,
  WaterRegion,
} from '../map/GameMap.js';
import type { MapTheme } from '../themes/MapTheme.js';
import { defaultTheme } from '../themes/DefaultTheme.js';
import { resolveTreeAsset } from '../themes/AssetResolver.js';
import type { WalkabilityRaster } from '../navigation/walkability.js';
import type { NavigableRegion, SpawnCandidate } from '../navigation/regions.js';

export type MapView =
  | 'styled'
  | 'terrain'
  | 'elevation'
  | 'moisture'
  | 'vegetation'
  | 'water'
  | 'collision'
  | 'entities'
  | 'navigation'
  | 'forests'
  | 'settlements';

/**
 * The read path, as data. The renderer does not build it: the caller derives it with the library's own
 * `rasterizeWalkability`, `navigableRegions`, and `spawnCandidates`, which is the arrangement a real
 * consumer uses, where the work is done once per map and read per frame.
 */
export interface NavigationOverlay {
  raster: WalkabilityRaster;
  /** One entry per navigable area, largest first, from `navigableRegions`. */
  regions?: NavigableRegion[];
  /** Roomiest ground across the map, from `spawnCandidates`. */
  candidates?: SpawnCandidate[];
}

export interface RenderOptions {
  view?: MapView;
  theme?: MapTheme;
  zoom?: number;
  pan?: Point;
  navigation?: NavigationOverlay;
}

/**
 * Draws the plank decks reaching out over the water.
 *
 * A deck is a surface rather than a structure, so it is drawn as one: the published deck rectangle
 * filled as boards running its length, with a rail line down each side rather than walls, which is
 * what separates a pier from a building at the zoom a building reads at. The shape comes entirely
 * from `geometry` and `rotation`, so a game that swaps in its own asset has the same rectangle to fit
 * it into.
 */
function drawDocks(context: CanvasRenderingContext2D, docks: DockEntity[], theme: MapTheme): void {
  const palette = theme.docks ?? defaultTheme.docks!;
  for (const dock of docks) {
    polygonPath(context, dock.geometry);
    context.fillStyle = palette.deck;
    context.fill();
    context.strokeStyle = palette.outline;
    context.lineWidth = 1.1;
    context.stroke();
    // The boards, clipped to the deck so they stop at the rail rather than at the fill rule's edge.
    // Planks are laid across a pier rather than along it, so each is a segment along the deck's
    // width, stepped along its length: the drawing says decking, and the gap it leaves at each step
    // is what a consumer drawing its own asset will want to know the deck is made of.
    context.save();
    polygonPath(context, dock.geometry);
    context.clip();
    context.strokeStyle = palette.outline;
    context.globalAlpha = 0.4;
    context.lineWidth = 0.7;
    const { x, y } = dock.position;
    const forward = { x: Math.cos(dock.rotation), y: Math.sin(dock.rotation) };
    const across = { x: -forward.y, y: forward.x };
    for (let step = 0; step <= dock.depth; step += 4) {
      const cx = x + forward.x * step;
      const cy = y + forward.y * step;
      context.beginPath();
      context.moveTo(cx - (across.x * dock.width) / 2, cy - (across.y * dock.width) / 2);
      context.lineTo(cx + (across.x * dock.width) / 2, cy + (across.y * dock.width) / 2);
      context.stroke();
    }
    context.restore();
  }
}

/**
 * Resource sites, drawn as the three marks they are.
 *
 * A mine gets an arrow rather than a dot, because the arrow is the information: it is the direction
 * the entrance faces, so a reader can see at a glance which way is out of the rock. A fishing spot
 * gets a ring, and a huntable wood a cross, so the three are told apart at a zoom where a dot is a
 * few pixels across. None of it is a scale drawing: a consumer drawing its own mine replaces all of
 * it, and the geometry it needs is the position, the facing and the name in `metadata`.
 */
function drawResourceSites(
  context: CanvasRenderingContext2D,
  sites: ResourceSiteEntity[],
  scale: number,
  theme: MapTheme,
): void {
  const palette = theme.resources ?? defaultTheme.resources!;
  for (const site of sites) {
    const { x, y } = site.position;
    const size = 5 / scale;
    context.strokeStyle =
      site.kind === 'mine'
        ? palette.mine
        : site.kind === 'fishing'
          ? palette.fishing
          : palette.hunting;
    context.lineWidth = 1.2 / scale;
    context.beginPath();
    if (site.kind === 'mine') {
      const heading = site.rotation ?? 0;
      const forward = { x: Math.cos(heading), y: Math.sin(heading) };
      // A shaft driven into the face, with the head of the arrow where the ground opens up. It reads
      // as a direction rather than as a spike, which is the whole of what a mine marker is for.
      context.moveTo(x - forward.x * size, y - forward.y * size);
      context.lineTo(x + forward.x * size, y + forward.y * size);
      const barb = 0.45;
      for (const side of [1, -1]) {
        const angle = heading + side * barb * Math.PI;
        context.moveTo(x + forward.x * size, y + forward.y * size);
        context.lineTo(
          x + forward.x * size * 0.5 + Math.cos(angle) * size * 0.5,
          y + forward.y * size * 0.5 + Math.sin(angle) * size * 0.5,
        );
      }
    } else if (site.kind === 'fishing') {
      context.arc(x, y, size * 0.8, 0, Math.PI * 2);
      context.moveTo(x - size * 0.4, y);
      context.lineTo(x + size * 0.4, y);
    } else {
      context.moveTo(x - size * 0.7, y - size * 0.7);
      context.lineTo(x + size * 0.7, y + size * 0.7);
      context.moveTo(x + size * 0.7, y - size * 0.7);
      context.lineTo(x - size * 0.7, y + size * 0.7);
    }
    context.stroke();
  }
}

function polygonPath(context: CanvasRenderingContext2D, geometry: PolygonGeometry) {
  context.beginPath();
  for (const ring of [geometry.points, ...(geometry.holes ?? [])]) {
    ring.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
  }
}

function hash(index: number) {
  let value = Math.imul(index ^ 0x9e3779b9, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function fillField(
  context: CanvasRenderingContext2D,
  map: GameMap,
  view: 'terrain' | 'elevation' | 'moisture' | 'vegetation',
  styled: boolean,
) {
  const fields = map.metadataLayers?.fields;
  if (!fields) return;
  const texture = document.createElement('canvas');
  texture.width = fields.columns;
  texture.height = fields.rows;
  const textureContext = texture.getContext('2d');
  if (!textureContext) return;
  const pixels = textureContext.createImageData(fields.columns, fields.rows);
  const colors: Record<typeof view, [number[], number[]]> = {
    terrain: [
      [231, 227, 188],
      [136, 165, 114],
    ],
    elevation: [
      [46, 92, 90],
      [245, 231, 183],
    ],
    moisture: [
      [237, 228, 194],
      [49, 114, 126],
    ],
    vegetation: [
      [240, 237, 204],
      [44, 98, 66],
    ],
  };
  const [low, high] = colors[view];
  fields[view].forEach((value, index) => {
    for (let channel = 0; channel < 3; channel++) {
      pixels.data[index * 4 + channel] = low[channel] + (high[channel] - low[channel]) * value;
    }
    pixels.data[index * 4 + 3] = 255;
  });
  textureContext.putImageData(pixels, 0, 0);
  context.save();
  context.globalAlpha = styled ? 0.3 : 1;
  context.imageSmoothingEnabled = true;
  context.drawImage(
    texture,
    0.5,
    0.5,
    fields.columns - 1,
    fields.rows - 1,
    0,
    0,
    map.bounds.width,
    map.bounds.height,
  );
  context.restore();
}

/**
 * Draws roads as ribbons along their centrelines, each with a darker casing under a lighter surface.
 * The casing is what makes a road read as a road at map scale instead of a coloured stripe. The two
 * passes are separated because a single pass per road would draw a later road's casing over an
 * earlier road's surface at a junction.
 */
function drawRoads(context: CanvasRenderingContext2D, roads: RoadEntity[], theme: MapTheme): void {
  context.lineJoin = 'round';
  context.lineCap = 'round';
  for (const pass of ['casing', 'surface'] as const) {
    for (const road of roads) {
      if (road.path.length < 2) continue;
      context.beginPath();
      context.moveTo(road.path[0].x, road.path[0].y);
      for (let index = 1; index < road.path.length; index += 1)
        context.lineTo(road.path[index].x, road.path[index].y);
      context.lineWidth = pass === 'casing' ? road.width + 3 : road.width;
      context.strokeStyle = pass === 'casing' ? theme.roads.casing : theme.roads[road.kind];
      context.stroke();
    }
  }
}

/**
 * Draws each building as a gable seen from above: the footprint, a ridge line down the middle, and a
 * roof slope shaded to either side of it.
 *
 * The shape comes entirely from the published footprint and `rotation`, so a building draws the same
 * way whichever way it faces and a game that swaps in its own asset has the same rectangle to fit it
 * into. A farm is drawn with a different roof, since a farm is the category that earns a category.
 */
function drawBuildings(
  context: CanvasRenderingContext2D,
  buildings: BuildingEntity[],
  theme: MapTheme,
): void {
  const palette = theme.structures ?? defaultTheme.structures!;
  for (const building of buildings) {
    const points = building.geometry.points;
    if (points.length !== 4) continue;
    // A ruin is drawn as the footprint with a broken diagonal over it and no ridge, so it reads as
    // fallen at the same zoom a standing building reads as standing. It is not drawn as a smaller
    // house: a ruin is the same walls, collapsed, which is why the ground is the same size.
    if (building.state === 'ruined') {
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.fillStyle = palette.ruin;
      context.fill();
      context.strokeStyle = palette.outline;
      context.lineWidth = 0.8;
      context.stroke();
      // Two walls left standing at the corners, which is what makes it read as a shell rather than
      // as a footprint: the ends of the building that have not come down.
      context.strokeStyle = palette.wall;
      context.lineWidth = 2.4;
      context.globalAlpha = 0.75;
      for (const index of [0, 2]) {
        context.beginPath();
        context.moveTo(points[index].x, points[index].y);
        context.lineTo(
          points[index].x + (points[(index + 1) % 4].x - points[index].x) * 0.34,
          points[index].y + (points[(index + 1) % 4].y - points[index].y) * 0.34,
        );
        context.stroke();
      }
      context.globalAlpha = 1;
      continue;
    }
    // The ridge runs along the building's depth: it joins the middle of the front wall to the middle
    // of the back, and the two roof planes are the halves either side of it. Both are worked out from
    // `position`, `rotation` and the published size rather than from the order of the ring, so a
    // building draws the same way whichever way it was written into the ring.
    const facing = { x: Math.cos(building.rotation), y: Math.sin(building.rotation) };
    const along = { x: -facing.y, y: facing.x };
    const half = { x: facing.x * (building.depth / 2), y: facing.y * (building.depth / 2) };
    const front = {
      x: building.position.x + half.x,
      y: building.position.y + half.y,
    };
    const back = { x: building.position.x - half.x, y: building.position.y - half.y };

    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
    context.fillStyle = palette.wall;
    context.fill();
    context.strokeStyle = palette.outline;
    context.lineWidth = 0.8;
    context.stroke();

    // Both roof planes, the second shaded back, so the two slopes meet on a line and the far one
    // reads as further away.
    for (const side of [1, -1]) {
      context.beginPath();
      context.moveTo(front.x, front.y);
      context.lineTo(back.x, back.y);
      context.lineTo(
        back.x + (along.x * (side * building.width)) / 2,
        back.y + (along.y * (side * building.width)) / 2,
      );
      context.closePath();
      context.fillStyle = palette.roof;
      context.globalAlpha = side > 0 ? 1 : 0.82;
      context.fill();
    }
    context.globalAlpha = 1;
    context.beginPath();
    context.moveTo(front.x, front.y);
    context.lineTo(back.x, back.y);
    context.strokeStyle = palette.roofFarm;
    context.lineWidth = 1.4;
    context.stroke();
  }
}

/**
 * Draws where each river's channel becomes standing water, as a delta.
 *
 * The format publishes the site and nothing is built there. What a river does as it reaches a lake is
 * spread out and drop what it is carrying, so the marker is a fan of silt opening downstream from the
 * mouth with the channels that made it running through it. The fan is sized from the marker's own
 * width, which is the width of the channel, so a wide river makes a wide delta and a game that owns
 * the mouth asset can use the same footprint.
 *
 * The direction and the width both come out of the published marker: its first point is a channel
 * width across from its second, and a channel width downstream of its fourth.
 */
function drawMouths(
  context: CanvasRenderingContext2D,
  water: WaterRegion[],
  theme: MapTheme,
): void {
  for (const region of water) {
    for (const mouth of region.metadata?.mouths ?? []) {
      const corners = mouth.polygon.points;
      if (corners.length < 4) continue;
      const across = { x: corners[0].x - corners[1].x, y: corners[0].y - corners[1].y };
      const width = Math.hypot(across.x, across.y) || 1;
      const down = { x: corners[0].x - corners[3].x, y: corners[0].y - corners[3].y };
      const length = Math.hypot(down.x, down.y) || 1;
      const along = { x: (down.x / length) * 1, y: (down.y / length) * 1 };
      const side = { x: -along.y, y: along.x };
      // A delta is a small fan at the shore, a third of the channel-scaled size it was, and never
      // smaller than the narrowest channel makes today, so a thin river still gets a visible mouth.
      const reach = Math.max((width * 5.5) / 3, 5.5);
      const spread = Math.max((width * 3.2) / 3, 3.2);
      const at = (forward: number, acrossBy: number) => ({
        x: mouth.point.x + along.x * forward + side.x * acrossBy,
        y: mouth.point.y + along.y * forward + side.y * acrossBy,
      });

      // The silt fan, wider than the channel and shorter than the water it reaches into.
      context.beginPath();
      context.moveTo(mouth.point.x, mouth.point.y);
      context.quadraticCurveTo(
        at(reach * 0.35, spread * 0.8).x,
        at(reach * 0.35, spread * 0.8).y,
        at(reach, spread).x,
        at(reach, spread).y,
      );
      context.quadraticCurveTo(
        at(reach * 0.6, 0).x,
        at(reach * 0.6, 0).y,
        at(reach, -spread).x,
        at(reach, -spread).y,
      );
      context.quadraticCurveTo(
        at(reach * 0.35, -spread * 0.8).x,
        at(reach * 0.35, -spread * 0.8).y,
        mouth.point.x,
        mouth.point.y,
      );
      context.closePath();
      context.globalAlpha = 0.5;
      context.fillStyle = theme.terrain.beach;
      context.fill();

      // The channels the fan is built of, running out into it and fading as they go.
      context.globalAlpha = 0.8;
      context.strokeStyle = theme.riverMouths ?? theme.water.line;
      context.lineWidth = Math.max((width * 0.16) / 3, 0.6);
      context.lineCap = 'round';
      for (const share of [-0.66, -0.22, 0.22, 0.66]) {
        context.beginPath();
        context.moveTo(mouth.point.x, mouth.point.y);
        context.quadraticCurveTo(
          at(reach * 0.4, spread * share * 0.5).x,
          at(reach * 0.4, spread * share * 0.5).y,
          at(reach * 0.92, spread * share).x,
          at(reach * 0.92, spread * share).y,
        );
        context.stroke();
      }
    }
  }
  context.globalAlpha = 1;
}

function drawCollision(context: CanvasRenderingContext2D, collision: CollisionGeometry) {
  context.beginPath();
  if (collision.type === 'circle') {
    context.arc(collision.center.x, collision.center.y, collision.radius, 0, Math.PI * 2);
  } else if (collision.type === 'rectangle') {
    context.rect(collision.x, collision.y, collision.width, collision.height);
  } else polygonPath(context, collision);
  context.fill('evenodd');
  context.stroke();
}

/**
 * Draws the walkability grid, the roomiest ground in each navigable area, and the spawn candidates.
 *
 * The grid is stretched from one pixel per cell, so the blockiness is the map's own: a lake boundary
 * follows cell edges because a cell the shoreline merely clips is blocked, not because the polygon is
 * coarse. Markers are sized in screen space, so they stay legible when the whole map is in view.
 */
function drawNavigation(
  context: CanvasRenderingContext2D,
  map: GameMap,
  overlay: NavigationOverlay,
  scale: number,
  texture: HTMLCanvasElement | undefined,
) {
  if (texture) {
    context.imageSmoothingEnabled = false;
    context.drawImage(texture, 0, 0, map.bounds.width, map.bounds.height);
    context.imageSmoothingEnabled = true;
  } else {
    context.fillStyle = '#e7e0cb';
    context.fillRect(0, 0, map.bounds.width, map.bounds.height);
  }

  // Roomiest ground per navigable area, ringed at the clearance that earned it the ring. A wide ring is
  // a place a base fits; a hairline is a gap between two rocks.
  context.strokeStyle = '#2f6d4f';
  context.lineWidth = 1.6 / scale;
  context.setLineDash([6 / scale, 5 / scale]);
  for (const region of overlay.regions ?? []) {
    const { x, y } = region.representativeOpenPoint;
    context.beginPath();
    context.arc(x, y, Math.max(region.clearance, 5 / scale), 0, Math.PI * 2);
    context.stroke();
  }
  context.setLineDash([]);

  // Candidates get a fixed-size crosshair so they stay findable at any zoom. Their clearance is not
  // drawn: a candidate with 315 units of room is a circle across a sixth of the map, and six of those
  // read as boundaries rather than markers. The ring above already shows how much room the map has.
  context.strokeStyle = '#b8791f';
  context.fillStyle = '#b8791f';
  context.lineWidth = 1.6 / scale;
  for (const candidate of overlay.candidates ?? []) {
    const { x, y } = candidate.point;
    const arm = 5 / scale;
    context.beginPath();
    context.moveTo(x - arm, y);
    context.lineTo(x + arm, y);
    context.moveTo(x, y - arm);
    context.lineTo(x, y + arm);
    context.stroke();
    context.beginPath();
    context.arc(x, y, 1.8 / scale, 0, Math.PI * 2);
    context.fill();
  }
}

/**
 * Draws each grove's hull, tinted by whether there is walkable ground inside it.
 *
 * The tint is the point of the view. A grove whose hull is entirely blocked is not a contradiction, it
 * is thick wood, and reading `walkableInside` off the map is faster than walking into it.
 */
function drawForests(context: CanvasRenderingContext2D, map: GameMap, scale: number) {
  for (const forest of map.forests) {
    polygonPath(context, forest.geometry);
    context.fillStyle = forest.metadata.walkableInside ? '#6f9a6b4d' : '#b45f4533';
    context.fill();
    context.strokeStyle = forest.metadata.walkableInside ? '#3f6b46' : '#9c4c3d';
    context.lineWidth = 1.4 / scale;
    context.stroke();
  }
  // Trunks inside the hull, so the density that produced it is visible. A grove drawn as an empty
  // outline says nothing about whether the clearings inside it are real.
  context.fillStyle = '#2f4231';
  for (const tree of map.vegetation) {
    context.beginPath();
    context.arc(
      tree.position.x,
      tree.position.y,
      Math.max(tree.radius * 0.22, 1.1 / scale),
      0,
      Math.PI * 2,
    );
    context.fill();
  }
}

function drawClearings(
  context: CanvasRenderingContext2D,
  settlements: SettlementEntity[],
  scale: number,
) {
  for (const settlement of settlements) {
    polygonPath(context, settlement.clearing);
    context.fillStyle = '#e2e8c9';
    context.fill();
    context.strokeStyle = '#93a86a';
    context.lineWidth = 1 / scale;
    context.stroke();
  }
}

function drawSettlements(context: CanvasRenderingContext2D, map: GameMap, scale: number) {
  for (const settlement of map.settlements) {
    // The reach, filled. A settlement is a distance and not a wall, so this is a region a consumer
    // would test, drawn as one so its size is readable.
    context.beginPath();
    context.arc(settlement.position.x, settlement.position.y, settlement.radius, 0, Math.PI * 2);
    context.fillStyle = '#c9a2271f';
    context.fill();
    context.strokeStyle = '#a8861f';
    context.lineWidth = 1.4 / scale;
    context.setLineDash([7 / scale, 5 / scale]);
    context.stroke();
    context.setLineDash([]);
  }
  // The clearing each settlement opens for itself, which is the ground a consumer builds the middle
  // of the place on. Filled solid so it reads as open rather than as another boundary.
  for (const settlement of map.settlements) {
    polygonPath(context, settlement.clearing);
    context.fillStyle = '#dfe6c4';
    context.fill();
    context.strokeStyle = '#7d9350';
    context.lineWidth = 1.2 / scale;
    context.stroke();
  }
  // The members, in the settlement's own footprint colour, so a settlement holding houses and a
  // settlement holding nothing are told apart at a glance rather than by counting.
  const members = new Set(map.settlements.flatMap((s) => s.metadata.buildingIds));
  for (const building of map.structures) {
    if (!members.has(building.id)) continue;
    context.fillStyle = '#7a5c10';
    polygonPath(context, building.geometry);
    context.fill();
  }
  for (const settlement of map.settlements) {
    // The centre, and a ring scaled to the size so a hamlet and a town are not the same dot.
    const reach = Math.max(6, Math.min(26, 4 + settlement.metadata.buildingIds.length * 1.6));
    context.beginPath();
    context.arc(settlement.position.x, settlement.position.y, reach / scale, 0, Math.PI * 2);
    context.fillStyle = '#4a3805';
    context.fill();
    context.strokeStyle = '#ffe9a8';
    context.lineWidth = 2 / scale;
    context.stroke();
  }
  // A deck, drawn as the deck, so a place that is a port reads as one here as well as in the styled
  // view. Which place a deck belongs to is in its `settlementId`, and nothing is drawn twice for
  // that: a deck is in one place, which is the rule that makes membership a partition.
  for (const dock of map.docks) {
    polygonPath(context, dock.geometry);
    context.fillStyle = '#8a6a3d';
    context.fill();
    context.strokeStyle = '#4a3805';
    context.lineWidth = 1.4 / scale;
    context.stroke();
  }
}

export class CanvasRenderer {
  private context: CanvasRenderingContext2D;
  private transform = { scale: 1, x: 0, y: 0 };
  private raster: { source: WalkabilityRaster; canvas: HTMLCanvasElement } | undefined;

  /**
   * Builds the grid as one pixel per cell, once per raster.
   *
   * The grid runs to a million cells on a large map, so rebuilding it per frame would allocate four
   * megabytes of pixels on every pan and zoom to draw something that has not changed. The same split
   * the read path uses: bake once, read per frame.
   */
  private rasterTexture(source: WalkabilityRaster): HTMLCanvasElement | undefined {
    if (this.raster?.source === source) return this.raster.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = source.columns;
    canvas.height = source.rows;
    const textureContext = canvas.getContext('2d');
    if (!textureContext) return undefined;
    const pixels = textureContext.createImageData(source.columns, source.rows);
    for (let index = 0; index < source.cells.length; index += 1) {
      const at = index * 4;
      const blocked = source.cells[index] === 1;
      pixels.data[at] = blocked ? 57 : 231;
      pixels.data[at + 1] = blocked ? 68 : 224;
      pixels.data[at + 2] = blocked ? 60 : 203;
      pixels.data[at + 3] = 255;
    }
    textureContext.putImageData(pixels, 0, 0);
    this.raster = { source, canvas };
    return canvas;
  }

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser does not support Canvas 2D.');
    this.context = context;
  }

  worldPoint(x: number, y: number): Point {
    return {
      x: (x - this.transform.x) / this.transform.scale,
      y: (y - this.transform.y) / this.transform.scale,
    };
  }

  get scale() {
    return this.transform.scale;
  }

  render(map: GameMap, options: RenderOptions = {}) {
    const {
      view = 'styled',
      theme = defaultTheme,
      zoom = 1,
      pan = { x: 0, y: 0 },
      navigation,
    } = options;
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    const context = this.context;
    const scale =
      Math.min((width - 40) / map.bounds.width, (height - 40) / map.bounds.height) * zoom;
    const x = (width - map.bounds.width * scale) / 2 + pan.x;
    const y = (height - map.bounds.height * scale) / 2 + pan.y;
    this.transform = { scale, x, y };
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.translate(x, y);
    context.scale(scale, scale);
    context.save();
    context.beginPath();
    context.rect(0, 0, map.bounds.width, map.bounds.height);
    context.clip();
    context.fillStyle = theme.terrain.grass;
    context.fillRect(0, 0, map.bounds.width, map.bounds.height);

    if (['terrain', 'elevation', 'moisture', 'vegetation'].includes(view)) {
      fillField(context, map, view as 'terrain' | 'elevation' | 'moisture' | 'vegetation', false);
    } else {
      const styled = view === 'styled' || view === 'collision';
      if (styled) {
        for (const region of map.terrain) {
          polygonPath(context, region.geometry);
          context.fillStyle = theme.terrain[region.kind];
          context.fill('evenodd');
        }
        fillField(context, map, 'terrain', true);
        context.strokeStyle = theme.terrain.detail;
        context.lineWidth = 1.2;
        context.globalAlpha = 0.34;
        const detailCount = Math.min(3500, (map.bounds.width * map.bounds.height) / 1600);
        context.beginPath();
        for (let index = 0; index < detailCount; index++) {
          const dx = hash(index * 3) * map.bounds.width;
          const dy = hash(index * 3 + 1) * map.bounds.height;
          context.moveTo(dx - 3, dy);
          context.lineTo(dx, dy - 3);
          context.moveTo(dx + 2, dy + 1);
          context.lineTo(dx + 4, dy - 2);
        }
        context.stroke();
        context.globalAlpha = 1;
      } else {
        context.fillStyle = '#f0eedf';
        context.fillRect(0, 0, map.bounds.width, map.bounds.height);
      }

      for (const water of map.water) {
        polygonPath(context, water.geometry);
        context.lineJoin = 'round';
        // The shore margin is clipped inside the lake. Stroking it unclipped would paint half its
        // width onto the beach and erase narrow beaches entirely. It is a lake's margin: fourteen
        // units of it is a beach, and fourteen units of it on a twelve-unit channel is the whole
        // river, so a river keeps its own edge and gets none.
        if (styled && water.kind !== 'river') {
          context.save();
          context.clip('evenodd');
          context.lineWidth = 14;
          context.strokeStyle = theme.water.shore;
          context.stroke();
          context.restore();
        }
        polygonPath(context, water.geometry);
        context.fillStyle = view === 'water' ? '#559c9b' : theme.water.fill;
        context.fill('evenodd');
        context.lineWidth = 2;
        context.strokeStyle = theme.water.line;
        context.stroke();
        if (styled) {
          context.save();
          context.clip('evenodd');
          context.strokeStyle = theme.water.ripple;
          context.lineWidth = 1.7;
          context.beginPath();
          for (let row = 24; row < map.bounds.height; row += 33) {
            for (let column = 24; column < map.bounds.width; column += 63) {
              const offset = hash(row * 17 + column) * 32;
              context.moveTo(column + offset, row);
              context.lineTo(column + offset + 9 + hash(column + row) * 16, row);
            }
          }
          context.stroke();
          context.restore();
        }
      }

      // Roads are drawn over the water, so a road crossing a river reads as a road crossing a river.
      // Nothing marks the crossings: the road ribbon and the channel polygon are both on the map, and
      // a game that wants a bridge finds the part of one centreline that is over the other. A marker
      // here was a square of a deck in the wrong place, which is worse than no marker.
      if (styled && map.roads.length > 0) drawRoads(context, map.roads, theme);
      if (styled) drawMouths(context, map.water, theme);
      // A dock is drawn over the water, under the roads: a deck reaching out from a shore, with the
      // road it is reached along running to its root.
      if (styled && map.docks.length > 0) drawDocks(context, map.docks, theme);
      if (styled) drawMouths(context, map.water, theme);
      // A settlement's clearing, over the road it sits on. It is open ground, so it is drawn as
      // ground rather than as an object: a green at the middle of a place, with the road running
      // through it.
      if (styled && map.settlements.length > 0) drawClearings(context, map.settlements, scale);

      if (styled) {
        for (const tree of [...map.vegetation].sort((a, b) => a.position.y - b.position.y)) {
          const { x: tx, y: ty } = tree.position;
          const radius = tree.radius;
          const asset = resolveTreeAsset(tree, theme);
          context.fillStyle = theme.vegetation.shadow;
          context.beginPath();
          context.ellipse(
            tx + radius * 0.22,
            ty + radius * 0.45,
            radius,
            radius * 0.72,
            0,
            0,
            Math.PI * 2,
          );
          context.fill();
          context.strokeStyle = theme.vegetation.trunk;
          context.lineWidth = 1.8;
          context.beginPath();
          context.moveTo(tx, ty);
          context.lineTo(tx, ty + radius * 1.03);
          context.stroke();
          context.beginPath();
          for (let index = 0; index <= 48; index++) {
            const angle = (index / 48) * Math.PI * 2;
            const lobe =
              radius * (0.9 + Math.cos(angle * asset.lobes + (tree.rotation ?? 0)) * 0.1);
            const px = tx + Math.cos(angle) * lobe;
            const py = ty + Math.sin(angle) * lobe * 0.92;
            if (index === 0) context.moveTo(px, py);
            else context.lineTo(px, py);
          }
          context.closePath();
          context.fillStyle = asset.fill;
          context.fill();
          context.strokeStyle = asset.outline;
          context.lineWidth = 1.1;
          context.stroke();
          context.strokeStyle = '#ffffff48';
          context.lineWidth = 2.2;
          context.beginPath();
          context.arc(tx - radius * 0.06, ty - radius * 0.02, radius * 0.58, 3.5, 5.15);
          context.stroke();
        }
      }
      // Last of the map, over the canopies. A building is a solid thing standing on the ground, and
      // the trees are only ever cleared far enough away for a trunk not to be inside a wall, so a
      // canopy can still overhang a roof.
      if (styled && map.structures.length > 0) drawBuildings(context, map.structures, theme);
      // Over the canopies, like the buildings and for a stronger reason. A site is an annotation
      // rather than a thing in the scene, and a hunting site is by definition in the middle of a wood,
      // so a marker drawn under the trees is not occasionally hidden: it is never visible. A mine
      // drawn on top of a canopy is a mark over ground that is still there, which is what it is.
      if (styled && map.resourceSites.length > 0)
        drawResourceSites(context, map.resourceSites, scale, theme);

      if (view === 'collision') {
        context.fillStyle = '#b45f4533';
        context.strokeStyle = '#9c4c3d';
        context.lineWidth = 1.4 / scale;
        for (const entity of [
          ...map.terrain,
          ...map.water,
          ...map.vegetation,
          ...map.structures,
          ...map.roads,
          ...map.barriers,
        ]) {
          if (entity.collision) drawCollision(context, entity.collision);
        }
      }
      if (view === 'entities') {
        context.fillStyle = '#355b46';
        for (const entity of [
          ...map.vegetation,
          ...map.structures,
          ...map.settlements,
          ...map.docks,
          ...map.resourceSites,
          ...map.roads,
          ...map.barriers,
        ]) {
          if (!entity.position) continue;
          context.beginPath();
          context.arc(entity.position.x, entity.position.y, 2.4 / scale, 0, Math.PI * 2);
          context.fill();
        }
      }
      if (view === 'navigation' && navigation)
        drawNavigation(context, map, navigation, scale, this.rasterTexture(navigation.raster));
      if (view === 'forests') drawForests(context, map, scale);
      if (view === 'settlements') drawSettlements(context, map, scale);
    }
    context.restore();
    context.strokeStyle = '#435b4a35';
    context.lineWidth = 1 / scale;
    context.strokeRect(0, 0, map.bounds.width, map.bounds.height);
  }
}
