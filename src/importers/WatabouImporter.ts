import type { GameMap } from '../map/GameMap.js';
import type { MapImporter } from './MapImporter.js';

export class WatabouImporter implements MapImporter<unknown> {
  readonly id = 'watabou';

  canImport(_data: unknown): boolean {
    return false;
  }

  import(_data: unknown): GameMap {
    throw new Error('Watabou import is not supported in this MVP');
  }
}

export default new WatabouImporter();
