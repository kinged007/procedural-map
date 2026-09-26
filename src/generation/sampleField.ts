import type { SpatialFields } from '../map/GameMap.js';

/**
 * Bilinear sample of a field at a world position. Field values are stored row-major on the
 * generation grid and this maps a world coordinate onto that grid.
 */
export function sampleField(
  fields: SpatialFields,
  values: number[],
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const gridX = (x / width) * (fields.columns - 1);
  const gridY = (y / height) * (fields.rows - 1);
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = Math.min(fields.columns - 1, x0 + 1);
  const y1 = Math.min(fields.rows - 1, y0 + 1);
  const tx = gridX - x0;
  const ty = gridY - y0;
  const top = values[y0 * fields.columns + x0] * (1 - tx) + values[y0 * fields.columns + x1] * tx;
  const bottom =
    values[y1 * fields.columns + x0] * (1 - tx) + values[y1 * fields.columns + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}
