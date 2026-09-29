import type { MapTheme } from './MapTheme.js';

export const defaultTheme: MapTheme = {
  id: 'temperate',
  name: 'Temperate',
  terrain: {
    grass: '#e4e7c7',
    meadow: '#d3dcb3',
    scrub: '#c4cfa0',
    rock: '#b3ab99',
    beach: '#f3d9a0',
    detail: '#99ac80',
  },
  water: { fill: '#a8cdcc', shore: '#faf6e6', line: '#5d8f8c', ripple: '#d3e5d9' },
  riverMouths: '#4f7f7c',
  roads: { primary: '#c9b596', secondary: '#cfc0a6', path: '#d6cbb4', casing: '#8f7f63' },
  vegetation: {
    canopy: ['#98b184', '#adc392', '#859e73', '#bdcda1', '#91aa80'],
    outline: '#596f50',
    trunk: '#796f50',
    shadow: '#596d4830',
  },
  structures: {
    wall: '#e8dcc4',
    roof: '#b46a4c',
    roofFarm: '#8d7f66',
    ruin: '#a89c86',
    outline: '#5d4a3a',
  },
  docks: { deck: '#c2a276', outline: '#6b543a' },
  // A mine, a fishing spot and a huntable wood are marked rather than filled, so these are all
  // darker than the ground they sit on and none of them is a colour a player would mistake for
  // water. The fishing mark is the only one that could be confused with a wave, which is why it is a
  // ring with a stroke through it rather than a dot.
  resources: { mine: '#4a3b2c', fishing: '#2f6f7e', hunting: '#3d5a2e' },
  // A field is tilled ground, so it is a warmer and drier green than the grass it was cut from, and
  // the furrow lines are darker still. An orchard gets no colour here because its rows are trees: the
  // generator draws nothing over an orchard but the trees, so the two cannot disagree about it.
  plots: { field: '#c8bd7e', furrow: '#a2924f' },
  // A camp is a footprint and a mark on it, so each is a fill that a consumer can tell from the
  // ground behind it and a stroke that does not read as a wall. The wood and rock camps are darker
  // than the open one because they are sited against cover, and none of the three is a colour a
  // player would read as water.
  camps: { wood: '#5a4a6a', rock: '#6a5a4a', open: '#7a6a3a' },
};
