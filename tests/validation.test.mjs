import assert from 'node:assert/strict';
import test from 'node:test';
import { exportMap, importMap, validateMap } from '../dist/index.js';

const makeMap = () => ({
  version: '1.0',
  metadata: { id: 'validation-fixture', seed: 42 },
  bounds: { width: 100, height: 100 },
  terrain: [
    {
      id: 'terrain-1',
      type: 'terrain',
      kind: 'grass',
      geometry: {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
      },
    },
  ],
  water: [],
  vegetation: [
    {
      id: 'tree-1',
      type: 'tree',
      species: 'oak',
      position: { x: 20, y: 20 },
      radius: 8,
      collision: { type: 'circle', center: { x: 20, y: 20 }, radius: 5 },
    },
  ],
  structures: [],
  roads: [],
  barriers: [],
  metadataLayers: {
    fields: {
      columns: 2,
      rows: 2,
      terrain: [0, 0.5, 1, 0.5],
      elevation: [0, 0, 0, 0],
      moisture: [1, 1, 1, 1],
      vegetation: [0.5, 0.5, 0.5, 0.5],
    },
  },
});

test('validates and round-trips a native canonical map', () => {
  const map = makeMap();
  assert.deepEqual(validateMap(map), { valid: true, errors: [] });
  const restored = importMap(exportMap(map));
  assert.deepEqual(restored, map);
  assert.notEqual(restored, map);
});

test('rejects invalid JSON and unsupported versions', () => {
  assert.throws(() => importMap('{broken'), /Invalid native map JSON/);
  const map = makeMap();
  map.version = '2.0';
  assert.equal(validateMap(map).valid, false);
});

test('reports malformed numeric values, geometry, collisions, and duplicate IDs', () => {
  const map = makeMap();
  map.metadata.seed = Number.POSITIVE_INFINITY;
  map.terrain[0].geometry.points = [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 100, y: 0 },
  ];
  map.vegetation[0].collision.radius = 80;
  map.structures.push({
    id: 'tree-1',
    type: 'rock',
    collision: { type: 'rectangle', x: 90, y: 90, width: 20, height: 20 },
  });
  const result = validateMap(map);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('metadata.seed')));
  assert.ok(result.errors.some((error) => error.includes('terrain[0].geometry.points')));
  assert.ok(
    result.errors.some((error) => error.includes('tree-1') || error.includes('structures[0].id')),
  );
});

test('rejects trees whose canopy or collision overlaps water', () => {
  const map = makeMap();
  map.water.push({
    id: 'water-1',
    type: 'water',
    kind: 'lake',
    geometry: {
      points: [
        { x: 25, y: 10 },
        { x: 45, y: 10 },
        { x: 45, y: 35 },
        { x: 25, y: 35 },
      ],
    },
    collision: {
      type: 'polygon',
      points: [
        { x: 25, y: 10 },
        { x: 45, y: 10 },
        { x: 45, y: 35 },
        { x: 25, y: 35 },
      ],
    },
  });
  assert.equal(validateMap(map).valid, false);
});

test('rejects non-JSON extension values and scalar entity metadata', () => {
  const map = makeMap();
  map.structures.push({
    id: 'rock-1',
    type: 'rock',
    custom: { callback: () => {} },
    metadata: ['not-an-object'],
  });
  map.metadata.extra = Number.NaN;

  const result = validateMap(map);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('custom.callback')));
  assert.ok(result.errors.some((error) => error.includes('metadata: must be a plain JSON object')));
  assert.ok(result.errors.some((error) => error.includes('metadata.extra')));
  assert.throws(() => exportMap(map), /Invalid GameMap/);
});

test('preserves JSON extension data through a native round trip', () => {
  const map = makeMap();
  map.metadata.label = 'fixture';
  map.structures.push({
    id: 'rock-1',
    type: 'rock',
    metadata: { loot: { items: ['coin', 2, null] } },
    custom: { hardness: 3 },
  });

  assert.deepEqual(importMap(exportMap(map)), map);
});

test('reports malformed water geometry without a generic validation failure', () => {
  const map = makeMap();
  map.water.push({
    id: 'water-1',
    type: 'water',
    kind: 'lake',
    geometry: {
      points: [
        { x: 25, y: 10 },
        { x: 45, y: 10 },
        { x: 45, y: 35 },
      ],
      holes: [[{ x: 'bad', y: 15 }]],
    },
    collision: {
      type: 'polygon',
      points: [
        { x: 25, y: 10 },
        { x: 45, y: 10 },
        { x: 45, y: 35 },
      ],
    },
  });

  const result = validateMap(map);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('water[0].geometry.holes[0]')));
  assert.ok(!result.errors.includes('map: validation failed for malformed input'));
});
