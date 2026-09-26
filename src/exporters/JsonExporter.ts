import type { GameMap } from '../map/GameMap.js';
import { assertValidMap } from '../validation/MapValidator.js';

export function exportMap(map: GameMap): string {
  assertValidMap(map);
  return JSON.stringify(map);
}
