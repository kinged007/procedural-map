import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkTile,
  generateMap,
  navigableRegions,
  pointInPolygon,
  rasterizeWalkability,
  spawnCandidates,
} from '../dist/index.js';

const square = (x0, y0, x1, y1) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const fixture = (overrides) => ({
  version: '1.0',
  metadata: { id: 'navigation-fixture' },
  bounds: { width: 100, height: 100 },
  terrain: [
    {
      id: 'terrain-grass',
      type: 'terrain',
      kind: 'grass',
      geometry: { points: square(0, 0, 100, 100) },
    },
  ],
  water: [],
  vegetation: [],
  structures: [],
  docks: [],
  resourceSites: [],
  enemySettlements: [],
  roads: [],
  barriers: [],
  ...overrides,
});

const waterRegion = (id, points, holes) => ({
  id,
  type: 'water',
  kind: 'lake',
  geometry: holes ? { points, holes } : { points },
  collision: holes ? { type: 'polygon', points, holes } : { type: 'polygon', points },
});

const at = (raster, x, y) =>
  raster.cells[Math.floor(y / raster.cellSize) * raster.columns + Math.floor(x / raster.cellSize)];

test('an island in a lake stays open while the water around it is blocked', () => {
  const map = fixture({
    water: [waterRegion('lake-1', square(10, 10, 90, 90), [square(40, 40, 60, 60)])],
  });
  for (const cellSize of [1, 2, 4, 8]) {
    const raster = rasterizeWalkability(map, { cellSize });
    assert.equal(at(raster, 20, 20), 1, `lake at cellSize ${cellSize}`);
    assert.equal(at(raster, 50, 50), 0, `island at cellSize ${cellSize}`);
    assert.equal(at(raster, 5, 5), 0, `open ground at cellSize ${cellSize}`);
  }
});

test('a generated lake keeps its island open', () => {
  const map = generateMap({ seed: 583921, width: 640, height: 480, water: { amount: 0.35 } });
  const lake = map.water.find((region) => (region.collision.holes ?? []).length > 0);
  assert.ok(lake, 'expected a lake with an island on this seed');
  const cellSize = 4;
  const raster = rasterizeWalkability(map, { cellSize });
  let checked = 0;
  for (let column = 1; column < raster.columns; column += 1) {
    for (let row = 1; row < raster.rows; row += 1) {
      // Only cells lying wholly inside the island count. A cell that straddles the shoreline is
      // blocked by the fill rule, which is correct and not what this is measuring.
      const inside = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].every(([dx, dy]) =>
        pointInPolygon(
          { x: (column + dx) * cellSize, y: (row + dy) * cellSize },
          { points: lake.collision.holes[0] },
        ),
      );
      if (!inside) continue;
      checked += 1;
      assert.equal(raster.cells[row * raster.columns + column], 0, `island cell ${column},${row}`);
    }
  }
  assert.ok(checked > 50, `expected a usable island, only ${checked} cells`);
});

test('rock is blocked even where a beach is drawn over it', () => {
  const rock = square(20, 20, 80, 80);
  const map = fixture({
    terrain: [
      {
        id: 'terrain-grass',
        type: 'terrain',
        kind: 'grass',
        geometry: { points: square(0, 0, 100, 100) },
      },
      {
        id: 'terrain-rock-1',
        type: 'terrain',
        kind: 'rock',
        geometry: { points: rock },
        collision: { type: 'polygon', points: rock },
      },
      {
        id: 'terrain-beach-1',
        type: 'terrain',
        kind: 'beach',
        geometry: { points: square(40, 40, 60, 60) },
      },
    ],
  });
  for (const cellSize of [1, 8, 20]) {
    const raster = rasterizeWalkability(map, { cellSize });
    assert.equal(at(raster, 30, 30), 1, `rock at cellSize ${cellSize}`);
    assert.equal(at(raster, 50, 50), 1, `rock under a beach at cellSize ${cellSize}`);
    assert.equal(at(raster, 10, 10), 0, `grass at cellSize ${cellSize}`);
  }
});

test('a blocker smaller than one cell still blocks that cell', () => {
  // A four by three pond vanishes under a per-cell fill rule that only looks at the cell centre,
  // which is the failure mode the scanline has to avoid.
  const map = fixture({ water: [waterRegion('lake-1', square(30, 30, 34, 33))] });
  for (const cellSize of [8, 16, 32]) {
    const raster = rasterizeWalkability(map, { cellSize });
    assert.equal(at(raster, 31, 31), 1, `tiny pond at cellSize ${cellSize}`);
    assert.equal(at(raster, 70, 70), 0, `open ground at cellSize ${cellSize}`);
  }
});

test('a cell the shoreline clips is blocked even where its centre is clear', () => {
  // The lake starts at x 38.5, so it covers the right sliver of the column spanning x[36, 40)
  // without reaching that cell's centre at 38. The fill rule blocks it anyway, because a cell the
  // blocker touches at all is blocked.
  const sliver = rasterizeWalkability(
    fixture({ water: [waterRegion('lake-1', square(38.5, 0, 60, 100))] }),
    { cellSize: 4 },
  );
  assert.equal(at(sliver, 38, 50), 1, 'the clipped cell is blocked');
  assert.equal(at(sliver, 34, 50), 0, 'the cell clear of the lake is open');
  assert.equal(at(sliver, 42, 50), 1, 'deeper water is blocked');

  // One unit of lake in a cell is still one unit of lake.
  const speck = rasterizeWalkability(
    fixture({ water: [waterRegion('lake-1', square(40, 40, 41, 41))] }),
    { cellSize: 8 },
  );
  assert.equal(at(speck, 40, 40), 1, 'a one-unit lake blocks the cell it lands in');
  assert.equal(at(speck, 24, 24), 0, 'the rest of the map is open');
});

test('rasterizeWalkability rejects a cell size it cannot divide by', () => {
  const map = fixture({});
  for (const cellSize of [0, -4, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => rasterizeWalkability(map, { cellSize }), /cellSize/);
});

test('a chunk carries its slice of the raster, or is blocked outside it', () => {
  // No trees, so the chunk is the raster slice exactly. Trunks are chunkTile's own addition and
  // are covered separately.
  const map = generateMap({
    seed: 583921,
    width: 640,
    height: 480,
    water: { amount: 0.3 },
    vegetation: { density: 0 },
  });
  const cellSize = 8;
  const raster = rasterizeWalkability(map, { cellSize });
  const chunkSize = 32;

  for (const [chunkX, chunkY] of [
    [0, 0],
    [1, 1],
    [3, 2], // past the right edge of a 640x480 map at this cell size
  ]) {
    const chunk = chunkTile(raster, map, chunkX, chunkY, { chunkSize });
    for (let y = 0; y < chunkSize; y += 1)
      for (let x = 0; x < chunkSize; x += 1) {
        const column = chunkX * chunkSize + x;
        const row = chunkY * chunkSize + y;
        const expected =
          column < raster.columns && row < raster.rows
            ? raster.cells[row * raster.columns + column]
            : 1;
        assert.equal(
          chunk[y * chunkSize + x],
          expected,
          `chunk ${chunkX},${chunkY} cell ${x},${y} disagrees with the raster`,
        );
      }
  }

  assert.ok(chunkTile(raster, map, 99, 99, { chunkSize }).every((cell) => cell === 1));
  assert.ok(chunkTile(raster, map, -1, -1, { chunkSize }).every((cell) => cell === 1));
  assert.throws(() => chunkTile(raster, map, 0, 0, { chunkSize: 0 }), /chunkSize/);
});

test('a chunk blocks tree trunks without blocking the grove around them', () => {
  const map = generateMap({ seed: 583921, width: 640, height: 480, vegetation: { density: 0.8 } });
  const cellSize = 8;
  const raster = rasterizeWalkability(map, { cellSize });
  const chunkSize = 32;
  const tree = map.vegetation[0];
  const chunkX = Math.floor(tree.position.x / chunkSize);
  const chunkY = Math.floor(tree.position.y / chunkSize);
  const chunk = chunkTile(raster, map, chunkX, chunkY, { chunkSize });

  const localX = Math.floor((tree.position.x - chunkX * chunkSize) / cellSize);
  const localY = Math.floor((tree.position.y - chunkY * chunkSize) / cellSize);
  assert.equal(chunk[localY * chunkSize + localX], 1, 'the trunk cell is blocked');

  // The point the tree sits on is not in a lake, so the cell blocking it came from the trunk and not
  // from the raster, which is what keeps a grove walkable between its trees.
  const blockers = [
    ...map.water.map((lake) => lake.collision),
    ...map.terrain.flatMap((region) => (region.collision ? [region.collision] : [])),
  ];
  assert.ok(!blockers.some((blocker) => pointInPolygon(tree.position, blocker)));
  assert.equal(
    raster.cells[
      Math.floor(tree.position.y / cellSize) * raster.columns +
        Math.floor(tree.position.x / cellSize)
    ],
    0,
  );
});

test('regions cover the open ground and nothing else', () => {
  const map = generateMap({ seed: 583921, width: 640, height: 480, water: { amount: 0.3 } });
  const cellSize = 4;
  const raster = rasterizeWalkability(map, { cellSize });
  const regions = navigableRegions(raster);
  assert.ok(regions.length > 0);

  const openCells = raster.cells.reduce((total, cell) => total + (cell === 0 ? 1 : 0), 0);
  const totalCells = regions.reduce((total, region) => total + region.cells, 0);
  assert.equal(totalCells, openCells, 'every open cell belongs to exactly one region');
  assert.equal(
    regions.reduce((total, region) => total + region.area, 0),
    openCells * cellSize * cellSize,
  );

  for (const region of regions) {
    assert.equal(region.index, regions.indexOf(region), 'index points at its own slot');
    assert.ok(region.cells > 0);
    assert.ok(region.clearance > 0, 'every region holds open ground');
    // The representative point is the one a base goes on, so it has to be walkable.
    assert.equal(
      raster.cells[
        Math.floor(region.representativeOpenPoint.y / cellSize) * raster.columns +
          Math.floor(region.representativeOpenPoint.x / cellSize)
      ],
      0,
      `region ${region.index} put its base on blocked ground`,
    );
    assert.ok(
      region.representativeOpenPoint.x >= 0 && region.representativeOpenPoint.x < map.bounds.width,
    );
    assert.ok(
      region.representativeOpenPoint.y >= 0 && region.representativeOpenPoint.y < map.bounds.height,
    );
  }
});

test('a diagonal pinch does not join two regions', () => {
  // Two open squares meeting at the corner (50, 50), with rock everywhere else. A character wider
  // than a cell cannot cross that corner, so the two sides must stay separate regions.
  const openSouthWest = square(0, 0, 50, 50);
  const openNorthEast = square(50, 50, 100, 100);
  const map = fixture({
    terrain: [
      {
        id: 'terrain-grass',
        type: 'terrain',
        kind: 'grass',
        geometry: { points: square(0, 0, 100, 100) },
      },
      {
        id: 'terrain-rock-1',
        type: 'terrain',
        kind: 'rock',
        geometry: { points: square(0, 0, 100, 100), holes: [openSouthWest, openNorthEast] },
        collision: {
          type: 'polygon',
          points: square(0, 0, 100, 100),
          holes: [openSouthWest, openNorthEast],
        },
      },
    ],
  });
  const regions = navigableRegions(rasterizeWalkability(map, { cellSize: 2 }));
  assert.equal(regions.length, 2, 'open ground either side of a corner stays two regions');
});

test('regions and spawn candidates are deterministic and stay on open ground', () => {
  const map = generateMap({ seed: 583921, width: 640, height: 480, water: { amount: 0.3 } });
  const raster = rasterizeWalkability(map, { cellSize: 8 });
  const first = navigableRegions(raster);
  const second = navigableRegions(raster);
  assert.deepEqual(first, second);

  const options = { count: 5, minSeparation: 100 };
  const candidates = spawnCandidates(raster, map, options);
  assert.deepEqual(candidates, spawnCandidates(raster, map, options));
  assert.equal(candidates.length, 5);

  const cellAt = (point) =>
    raster.cells[Math.floor(point.y / 8) * raster.columns + Math.floor(point.x / 8)];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    assert.equal(cellAt(candidate.point), 0, `candidate ${index} is on blocked ground`);
    assert.ok(candidate.clearance > 0);
    assert.ok(candidate.region >= 0 && candidate.region < first.length);
    for (let other = index + 1; other < candidates.length; other += 1) {
      const distance = Math.hypot(
        candidate.point.x - candidates[other].point.x,
        candidate.point.y - candidates[other].point.y,
      );
      assert.ok(
        distance >= 100,
        `candidates ${index} and ${other} are ${distance.toFixed(1)} apart`,
      );
    }
  }

  // Clearances come back in descending order, so the list is the most open ground first.
  for (let index = 1; index < candidates.length; index += 1)
    assert.ok(candidates[index - 1].clearance >= candidates[index].clearance);
});

test('the largest region is the biggest, and candidates prefer it', () => {
  const map = generateMap({ seed: 583921, width: 640, height: 480, water: { amount: 0.3 } });
  const raster = rasterizeWalkability(map, { cellSize: 8 });
  const regions = navigableRegions(raster);
  const sorted = [...regions].sort((first, second) => second.cells - first.cells);
  assert.deepEqual(regions[0], sorted[0], 'regions are reported largest first');

  const candidates = spawnCandidates(raster, map, { count: 1, minSeparation: 0 });
  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0].clearance,
    regions[0].clearance,
    'the roomiest ground is in the biggest region',
  );
});

test('a spawn candidate is never placed inside a tree', () => {
  // Clearance is measured against the raster, which holds water and rock but not trees. Without the
  // trunk check the roomiest ground on a wooded map is very often the inside of a tree.
  const map = generateMap({ seed: 583921, width: 640, height: 480, vegetation: { density: 0.9 } });
  const raster = rasterizeWalkability(map, { cellSize: 8 });
  const candidates = spawnCandidates(raster, map, { count: 10, minSeparation: 30 });
  assert.equal(candidates.length, 10, 'expected ten candidates on a wooded map');

  for (const candidate of candidates) {
    for (const tree of map.vegetation) {
      const distance = Math.hypot(
        tree.position.x - candidate.point.x,
        tree.position.y - candidate.point.y,
      );
      assert.ok(
        distance > tree.collision.radius,
        `candidate at ${candidate.point.x},${candidate.point.y} is inside a trunk`,
      );
    }
  }
});

test('spawn candidates validate their options and cope with a sealed map', () => {
  const map = generateMap({ seed: 583921, width: 640, height: 480, water: { amount: 0.3 } });
  const raster = rasterizeWalkability(map, { cellSize: 8 });
  assert.throws(() => spawnCandidates(raster, map, { count: -1, minSeparation: 10 }), /count/);
  assert.throws(() => spawnCandidates(raster, map, { count: 1.5, minSeparation: 10 }), /count/);
  assert.throws(
    () => spawnCandidates(raster, map, { count: 1, minSeparation: -5 }),
    /minSeparation/,
  );
  assert.deepEqual(spawnCandidates(raster, map, { count: 0, minSeparation: 10 }), []);

  // Water everywhere: no open ground, so no regions and no candidates rather than a thrown error.
  const flooded = fixture({ water: [waterRegion('lake-1', square(0, 0, 100, 100))] });
  const floodedRaster = rasterizeWalkability(flooded, { cellSize: 8 });
  assert.deepEqual(navigableRegions(floodedRaster), []);
  assert.deepEqual(spawnCandidates(floodedRaster, flooded, { count: 4, minSeparation: 10 }), []);
});

test('a base on an island is caught by the region count', () => {
  // A lake with an island in it. The island is open ground but is ringed by water, so it cannot be
  // walked to from the mainland and has to be its own region rather than merged with it.
  const map = fixture({
    water: [waterRegion('lake-1', square(20, 20, 80, 80), [square(45, 45, 55, 55)])],
  });
  const cellSize = 2;
  const raster = rasterizeWalkability(map, { cellSize });
  const regions = navigableRegions(raster);
  assert.equal(regions.length, 2, 'the island is its own region');

  const mainland = [...regions].sort((first, second) => second.cells - first.cells)[0];
  const island = regions.find((region) => region !== mainland);
  assert.ok(island.area > 0);
  assert.ok(island.cells < mainland.cells, 'the island is the smaller region');
  // Both hold a roomy base site, which is the point: neither is an unusable sliver.
  assert.ok(island.clearance > 0);
  assert.equal(
    raster.cells[
      Math.floor(island.representativeOpenPoint.y / cellSize) * raster.columns +
        Math.floor(island.representativeOpenPoint.x / cellSize)
    ],
    0,
    'the island base site is on open ground',
  );
});
