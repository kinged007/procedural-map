import type { CollisionGeometry, GameMap, Point, PolygonGeometry } from '../map/GameMap.js';
import type { MapTheme } from '../themes/MapTheme.js';
import { defaultTheme } from '../themes/DefaultTheme.js';
import { resolveTreeAsset } from '../themes/AssetResolver.js';

export type MapView =
  | 'styled'
  | 'terrain'
  | 'elevation'
  | 'moisture'
  | 'vegetation'
  | 'water'
  | 'collision'
  | 'entities';

export interface RenderOptions {
  view?: MapView;
  theme?: MapTheme;
  zoom?: number;
  pan?: Point;
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

export class CanvasRenderer {
  private context: CanvasRenderingContext2D;
  private transform = { scale: 1, x: 0, y: 0 };

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
    const { view = 'styled', theme = defaultTheme, zoom = 1, pan = { x: 0, y: 0 } } = options;
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
        context.lineWidth = 14;
        context.strokeStyle = theme.water.shore;
        if (styled) context.stroke();
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
          ...map.roads,
          ...map.barriers,
        ]) {
          if (!entity.position) continue;
          context.beginPath();
          context.arc(entity.position.x, entity.position.y, 2.4 / scale, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
    context.restore();
    context.strokeStyle = '#435b4a35';
    context.lineWidth = 1 / scale;
    context.strokeRect(0, 0, map.bounds.width, map.bounds.height);
  }
}
