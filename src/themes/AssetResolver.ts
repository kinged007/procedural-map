import type { VegetationEntity } from '../map/GameMap.js';
import type { MapTheme } from './MapTheme.js';

export function resolveTreeAsset(tree: VegetationEntity, theme: MapTheme) {
  const key = tree.asset?.variant ?? tree.species;
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return {
    fill: theme.vegetation.canopy[hash % theme.vegetation.canopy.length],
    outline: theme.vegetation.outline,
    lobes: tree.species === 'birch' ? 7 : 9,
  };
}
