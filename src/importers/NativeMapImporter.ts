import type { GameMap } from '../map/GameMap.js';
import type { MapImporter } from './MapImporter.js';
import { assertValidMap, validateMap } from '../validation/MapValidator.js';

function cloneMap(data: GameMap): GameMap {
  return JSON.parse(JSON.stringify(data)) as GameMap;
}

export class NativeMapImporter implements MapImporter<unknown> {
  readonly id = 'native-json';

  canImport(data: unknown): boolean {
    if (typeof data === 'string') {
      try {
        return validateMap(JSON.parse(data)).valid;
      } catch {
        return false;
      }
    }
    return validateMap(data).valid;
  }

  import(data: unknown): GameMap {
    let parsed: unknown = data;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new Error('Invalid native map JSON');
      }
    }
    assertValidMap(parsed);
    return cloneMap(parsed);
  }
}

const nativeMapImporter = new NativeMapImporter();

export function importMap(input: string | unknown): GameMap {
  return nativeMapImporter.import(input);
}

export default nativeMapImporter;
