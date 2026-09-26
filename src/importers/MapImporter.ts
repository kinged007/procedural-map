import type { GameMap } from '../map/GameMap.js';

export interface MapImporter<T = unknown> {
  id: string;
  canImport(data: unknown): boolean;
  import(data: T): GameMap;
}
