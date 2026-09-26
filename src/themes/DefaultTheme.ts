import type { MapTheme } from './MapTheme.js';

export const defaultTheme: MapTheme = {
  id: 'temperate',
  name: 'Temperate',
  terrain: { grass: '#e4e7c7', meadow: '#d3dcb3', scrub: '#c4cfa0', detail: '#99ac80' },
  water: { fill: '#a8cdcc', shore: '#ece8cc', line: '#729f99', ripple: '#d3e5d9' },
  vegetation: {
    canopy: ['#98b184', '#adc392', '#859e73', '#bdcda1', '#91aa80'],
    outline: '#596f50',
    trunk: '#796f50',
    shadow: '#596d4830',
  },
};
