import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { chunkTile, generateMap, pointInPolygon, rasterizeWalkability } from '../dist/index.js';

/**
 * The worst-case corpus for the smoothness requirement: the largest map the generator supports, with
 * the tree count at its ceiling, measured on the code path the game actually calls.
 *
 * A single timing number is machine-dependent, so every bound here is set from a measured value on
 * one machine with roughly thirty times headroom. A regression that costs a hundred times more is
 * caught; a slower machine is not failed.
 */

const SEED = 583921;

const percentiles = (samples) => {
  const sorted = [...samples].sort((first, second) => first - second);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
  };
};

/** Runs `work` until the JIT has settled, then returns per-iteration timings. */
const measure = (work, iterations) => {
  for (let index = 0; index < 5; index += 1) work();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    work();
    samples.push(performance.now() - startedAt);
  }
  return percentiles(samples);
};

const blockersOf = (map) => [
  ...map.water.map((lake) => lake.collision),
  ...map.terrain.flatMap((region) => (region.collision ? [region.collision] : [])),
];

test('the raster never calls a covered cell open, at any cell size', () => {
  const cases = [
    { seed: SEED, width: 640, height: 480, water: { amount: 0.35 } },
    { seed: 4242, width: 480, height: 640, water: { amount: 0.25 } },
    { seed: 99, width: 512, height: 512, water: { amount: 0.45 }, vegetation: { density: 0 } },
  ];

  for (const config of cases) {
    const map = generateMap(config);
    const blockers = blockersOf(map);
    for (const cellSize of [1, 3, 8, 16, 32]) {
      const raster = rasterizeWalkability(map, { cellSize });
      let openCells = 0;
      let exactAgreements = 0;
      for (let row = 0; row < raster.rows; row += 1) {
        for (let column = 0; column < raster.columns; column += 1) {
          const centre = { x: (column + 0.5) * cellSize, y: (row + 0.5) * cellSize };
          const covered = blockers.some((blocker) => pointInPolygon(centre, blocker));
          const cell = raster.cells[row * raster.columns + column];
          // The one direction that must never fail. The fill rule is conservative, so a cell may be
          // blocked while its centre is open, but never the reverse.
          assert.ok(
            cell === 1 || !covered,
            `cell ${column},${row} at ${centre.x},${centre.y} reads open but is covered`,
          );
          if (cell === 0) openCells += 1;
          if ((cell === 1) === covered) exactAgreements += 1;
        }
      }
      assert.ok(openCells > 0, `${config.seed}@${cellSize} left no open ground`);
      // The residual disagreement is dilation: a cell the shoreline clips but does not cover at its
      // centre. It has to shrink as cells get finer, or the fill rule has stopped being local.
      const agreement = exactAgreements / raster.cells.length;
      assert.ok(
        agreement > 0.8,
        `cell size ${cellSize} agreed on only ${(agreement * 100).toFixed(1)}% of centres`,
      );
    }
  }
});

test('a whole-world bake stays in the scanline band', () => {
  const map = generateMap({ seed: SEED, width: 4096, height: 4096 });
  assert.equal(map.vegetation.length, 8000, 'the corpus should sit at the tree ceiling');

  for (const cellSize of [4, 32]) {
    const timing = measure(() => rasterizeWalkability(map, { cellSize }), 10);
    console.log(`      4096x4096 bake at cellSize ${cellSize}: p95 ${timing.p95.toFixed(1)}ms`);
    // 250ms against a measured p95 of about 8ms. The per-cell fill this replaces took 39171ms on the
    // same shape, so a hundredfold regression is still caught and a slow machine is not failed.
    assert.ok(timing.p95 < 250, `bake at cellSize ${cellSize} took ${timing.p95.toFixed(0)}ms`);
  }
});

test('a chunk bake stays under a millisecond with the tree count at its ceiling', () => {
  const map = generateMap({ seed: SEED, width: 4096, height: 4096 });
  const raster = rasterizeWalkability(map, { cellSize: 32 });
  const chunkSize = 32;
  const chunksX = Math.ceil(raster.columns / chunkSize);
  const chunksY = Math.ceil(raster.rows / chunkSize);
  const coordinates = [];
  for (let y = 0; y < chunksY; y += 1)
    for (let x = 0; x < chunksX; x += 1) coordinates.push([x, y]);

  const timing = measure(() => {
    for (const [x, y] of coordinates) chunkTile(raster, map, x, y, { chunkSize });
  }, 10);
  console.log(
    `      ${chunksX * chunksY} chunk bakes over ${map.vegetation.length} trees: p50 ${(timing.p50 / coordinates.length).toFixed(3)}ms, p95 ${(timing.p95 / coordinates.length).toFixed(3)}ms per chunk`,
  );
  // This gate is a smoke test for something going quadratic, not the gate for the broadphase. Timing
  // on a shared machine ranges from 0.10ms to 0.77ms p95 for identical code, which is a wider band
  // than the regression the broadphase removed, so no wall-clock bound here can reliably catch that
  // regression. The gate that does catch it is deterministic and lives in tests/forests.test.mjs: it
  // counts the trunks a point reaches and asserts the mean does not grow with map size. The bound
  // below only needs to separate "quadratic in tree count" from "not".
  assert.ok(
    timing.p95 / coordinates.length < 2,
    `per-chunk bake took ${(timing.p95 / coordinates.length).toFixed(2)}ms`,
  );
});

test('blocked() is an array read, so map size does not change it', () => {
  const cellSize = 32;
  const chunkSize = 32;
  const worldPerChunk = cellSize * chunkSize;
  const lookups = (map) => {
    const raster = rasterizeWalkability(map, { cellSize });
    // Every chunk is baked up front, as a client does when a room is created. Measuring with a cold
    // cache would measure the bake, which is the previous test's job, and the bake depends on tree
    // count rather than on map size, so it swamps the thing this is checking.
    const cache = new Map();
    for (let y = 0; y < Math.ceil(raster.rows / chunkSize); y += 1)
      for (let x = 0; x < Math.ceil(raster.columns / chunkSize); x += 1)
        cache.set(`${x},${y}`, chunkTile(raster, map, x, y, { chunkSize }));
    return () => {
      let sum = 0;
      for (let index = 0; index < 20000; index += 1) {
        // Walked in world units, the way a caller would, and resolved to a chunk the same way.
        const x = (index * 7919) % map.bounds.width;
        const y = (index * 104729) % map.bounds.height;
        const chunkX = Math.floor(x / worldPerChunk);
        const chunkY = Math.floor(y / worldPerChunk);
        const baked = cache.get(`${chunkX},${chunkY}`);
        const column = Math.floor(x / cellSize) - chunkX * chunkSize;
        const row = Math.floor(y / cellSize) - chunkY * chunkSize;
        sum += baked[row * chunkSize + column];
      }
      return sum;
    };
  };

  const small = generateMap({ seed: SEED, width: 1280, height: 1280 });
  const large = generateMap({ seed: SEED, width: 4096, height: 4096 });
  const smallTiming = measure(lookups(small), 6);
  const largeTiming = measure(lookups(large), 6);
  console.log(
    `      20000 cached lookups: 1280x1280 p95 ${smallTiming.p95.toFixed(3)}ms, 4096x4096 p95 ${largeTiming.p95.toFixed(3)}ms`,
  );

  // Sixteen times the area, and the same cost per lookup. The allowance covers timing noise on a
  // shared machine and nothing else.
  assert.ok(
    largeTiming.p95 < smallTiming.p95 * 2 + 0.25,
    `4096 blocked() p95 ${largeTiming.p95.toFixed(3)}ms against 1280 at ${smallTiming.p95.toFixed(3)}ms`,
  );
});
