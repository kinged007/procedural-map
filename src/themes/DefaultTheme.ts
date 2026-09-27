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
  structures: { wall: '#e8dcc4', roof: '#b46a4c', roofFarm: '#8d7f66', outline: '#5d4a3a' },
};
