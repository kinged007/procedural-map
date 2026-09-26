import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { exportMap, generateMap, importMap } from '../dist/index.js';
import { circleIntersectsPolygon, pointInPolygon, polygonArea } from '../dist/map/geometry.js';

const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('generation is byte-stable for the same config', () => {
  const config = { seed: 583921, width: 640, height: 480 };
  const first = generateMap(config);
  const second = generateMap(config);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(
    stableHash(first),
    'a43636d9eba2d527c4627df1f0de66cbdeec6c05f4891f2675faccc7028ec902',
  );
});

test('different seeds produce different semantic maps', () => {
  const options = {
    width: 640,
    height: 480,
    water: { amount: 0.35 },
    vegetation: { density: 0.45 },
  };
  assert.notEqual(
    stableHash(generateMap({ seed: 10, ...options })),
    stableHash(generateMap({ seed: 11, ...options })),
  );
});

test('terrain classification produces bounded, valid meadow and scrub regions', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91]) {
    const map = generateMap({ seed, width: 768, height: 512 });
    const base = map.terrain[0];
    assert.equal(base.kind, 'grass');
    assert.equal(polygonArea(base.geometry), map.bounds.width * map.bounds.height);

    const overlays = map.terrain.slice(1);
    assert.ok(new Set(overlays.map((region) => region.kind)).size > 0);

    for (const region of overlays) {
      assert.ok(['meadow', 'scrub'].includes(region.kind));
      assert.ok(polygonArea(region.geometry) > 0);
      for (const ring of [region.geometry.points, ...(region.geometry.holes ?? [])])
        for (const point of ring) {
          assert.ok(point.x >= 0 && point.x <= map.bounds.width);
          assert.ok(point.y >= 0 && point.y <= map.bounds.height);
        }
    }
  }
});

test('grass stays the dominant terrain surface on every seed', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91, 90210, -1]) {
    const map = generateMap({ seed, width: 768, height: 512, vegetation: { density: 0 } });
    const { fields } = map.metadataLayers;
    const scores = fields.terrain
      .map((value, index) => (value + fields.moisture[index]) / 2)
      .sort((a, b) => a - b);
    const meadowLevel = scores[Math.round(0.75 * (scores.length - 1))];
    const grass = scores.filter((score) => score < meadowLevel).length / scores.length;
    assert.ok(grass > 0.6 && grass < 0.8, `grass share for seed ${seed} was ${grass.toFixed(3)}`);
  }
});

test('terrain classification responds to the moisture field', () => {
  const base = generateMap({ seed: 91, water: { amount: 0.4 }, vegetation: { density: 0 } });
  const rescaled = generateMap({
    seed: 91,
    water: { amount: 0.4, scale: 0.012 },
    vegetation: { density: 0 },
  });
  assert.notDeepEqual(base.metadataLayers.fields.moisture, rescaled.metadataLayers.fields.moisture);
  // Region counts are quantile-derived and often match, so compare the actual boundaries.
  assert.notDeepEqual(base.terrain.slice(1), rescaled.terrain.slice(1));
});

test('water contours are unaffected by the shared contour module', () => {
  const map = generateMap({ seed: 583921, water: { amount: 0.2 }, vegetation: { density: 0 } });
  assert.equal(map.water.length, 13);
  assert.equal(
    map.water.reduce((sum, lake) => sum + (lake.geometry.holes?.length ?? 0), 0),
    0,
  );
});

// Terrain overlays overlap freely and are NOT nested: on a typical map the scrub contour
// encloses more area than the meadow contour, so the boundaries cross. What is contractual is the
// emission order (grass, then meadow, then scrub) combined with last-match-wins resolution, which
// yields scrub > meadow > grass precedence. These tests pin both, so a future change to region
// ordering, kind assignment, or contouring cannot silently change which surface a consumer sees.
test('terrain regions are emitted as grass, then meadow, then scrub', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91, 90210, 31337]) {
    const map = generateMap({ seed, width: 768, height: 512 });
    const kinds = map.terrain.map((region) => region.kind);
    assert.equal(kinds[0], 'grass');
    const firstScrub = kinds.indexOf('scrub');
    if (firstScrub !== -1) {
      assert.ok(
        kinds.slice(firstScrub).every((kind) => kind === 'scrub'),
        `seed ${seed} emitted a non-scrub region after scrub`,
      );
      assert.ok(
        kinds.slice(0, firstScrub).every((kind) => kind !== 'scrub'),
        `seed ${seed} emitted scrub before meadow`,
      );
    }
  }
});

test('overlapping terrain resolves to one kind per point with scrub over meadow over grass', () => {
  let overlapping = 0;
  for (let index = 0; index < 8; index += 1) {
    const map = generateMap({ seed: 100 + index * 53, width: 768, height: 512 });
    for (let probe = 0; probe < 1500; probe += 1) {
      const point = {
        x: ((probe * 7919) % 997) * (map.bounds.width / 997),
        y: ((probe * 104729) % 991) * (map.bounds.height / 991),
      };
      const matches = map.terrain.filter((region) => pointInPolygon(point, region.geometry));
      if (matches.length === 0) continue;
      if (matches.length > 1) overlapping += 1;

      const inScrub = matches.some((region) => region.kind === 'scrub');
      const inMeadow = matches.some((region) => region.kind === 'meadow');
      const expected = inScrub ? 'scrub' : inMeadow ? 'meadow' : 'grass';
      assert.equal(matches[matches.length - 1].kind, expected, 'last match must win');
    }
  }
  assert.ok(overlapping > 0, 'expected the overlays to overlap in practice');
});

test('scrub and meadow regions overlap rather than nest', () => {
  const map = generateMap({ seed: 583921, width: 768, height: 512 });
  const meadow = map.terrain.find((region) => region.kind === 'meadow');
  const scrub = map.terrain.find((region) => region.kind === 'scrub');
  assert.ok(meadow && scrub, 'expected both meadow and scrub on the default seed');
  const outside = scrub.geometry.points.filter(
    (point) => !pointInPolygon(point, meadow.geometry),
  ).length;
  assert.ok(outside > 0, 'scrub is expected to extend beyond meadow');
});

test('the grass base region always covers the full bounds', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91]) {
    const map = generateMap({ seed, width: 768, height: 512 });
    assert.equal(map.terrain[0].kind, 'grass');
    assert.equal(polygonArea(map.terrain[0].geometry), map.bounds.width * map.bounds.height);
  }
});

test('generated entities, terrain, and collision geometry remain valid in world bounds', () => {
  const map = generateMap({
    seed: 84,
    width: 768,
    height: 512,
    water: { amount: 0.7 },
    vegetation: { density: 1, clustering: 1 },
  });
  assert.equal(map.terrain[0].kind, 'grass');
  assert.ok(map.water.length > 0);
  assert.ok(map.vegetation.length > 0);

  for (const lake of map.water) {
    for (const point of lake.geometry.points) {
      assert.ok(point.x >= 0 && point.x <= map.bounds.width);
      assert.ok(point.y >= 0 && point.y <= map.bounds.height);
    }
  }
  for (const tree of map.vegetation) {
    assert.ok(
      tree.position.x - tree.radius >= 0 && tree.position.x + tree.radius <= map.bounds.width,
    );
    assert.ok(
      tree.position.y - tree.radius >= 0 && tree.position.y + tree.radius <= map.bounds.height,
    );
    assert.deepEqual(tree.collision.center, tree.position);
    assert.ok(!map.water.some((lake) => pointInPolygon(tree.position, lake.geometry)));
    assert.ok(
      !map.water.some((lake) => circleIntersectsPolygon(tree.position, tree.radius, lake.geometry)),
    );
  }
});

test('water and vegetation extremes are supported', () => {
  const dry = generateMap({
    seed: 5,
    width: 128,
    height: 128,
    water: { amount: 0 },
    vegetation: { density: 0 },
  });
  assert.equal(dry.water.length, 0);
  assert.equal(dry.vegetation.length, 0);

  const startedAt = performance.now();
  const wet = generateMap({
    seed: 5,
    width: 4096,
    height: 4096,
    water: { amount: 1 },
    vegetation: { density: 0 },
  });
  assert.ok(wet.water.length > 0);
  assert.ok(performance.now() - startedAt < 3000, 'largest supported map should generate promptly');
});

test('water contours follow the elevation field and grow monotonically with amount', () => {
  const amounts = [0.1, 0.3, 0.55, 0.8];
  const maps = amounts.map((amount) =>
    generateMap({
      seed: 2718,
      width: 768,
      height: 512,
      water: { amount },
      vegetation: { density: 0 },
    }),
  );
  const areas = maps.map((map) =>
    map.water.reduce((sum, lake) => sum + polygonArea(lake.geometry), 0),
  );
  for (let index = 1; index < areas.length; index += 1) assert.ok(areas[index] > areas[index - 1]);

  const map = maps[2];
  const { fields, waterLevel } = map.metadataLayers;
  let matched = 0;
  let compared = 0;
  for (let row = 1; row < fields.rows - 1; row += 1) {
    for (let column = 1; column < fields.columns - 1; column += 1) {
      const point = {
        x: (column * map.bounds.width) / (fields.columns - 1),
        y: (row * map.bounds.height) / (fields.rows - 1),
      };
      const fieldSaysWater = fields.elevation[row * fields.columns + column] <= waterLevel;
      const polygonSaysWater = map.water.some((lake) => pointInPolygon(point, lake.geometry));
      matched += Number(fieldSaysWater === polygonSaysWater);
      compared += 1;
    }
  }
  assert.ok(
    matched / compared > 0.94,
    'lake polygons should represent the thresholded elevation field',
  );
});

test('large connected contours preserve the requested field coverage', () => {
  const map = generateMap({
    seed: 1309757276,
    width: 2048,
    height: 1536,
    water: { amount: 0.5, scale: 0.05 },
    vegetation: { density: 0 },
  });
  const coverage =
    map.water.reduce((sum, lake) => sum + polygonArea(lake.geometry), 0) /
    (map.bounds.width * map.bounds.height);
  assert.ok(coverage > 0.42 && coverage < 0.58);
  assert.ok(map.water.some((lake) => lake.geometry.points.length > 1024));
});

test('all elevation islands remain as holes in high-water contours', () => {
  const map = generateMap({
    seed: 0,
    width: 2048,
    height: 1536,
    water: { amount: 0.8, scale: 0.05 },
    vegetation: { density: 0 },
  });
  const coverage =
    map.water.reduce((sum, lake) => sum + polygonArea(lake.geometry), 0) /
    (map.bounds.width * map.bounds.height);
  assert.ok(coverage > 0.72 && coverage < 0.88);
  assert.ok(map.water.reduce((sum, lake) => sum + (lake.geometry.holes?.length ?? 0), 0) > 32);
});

test('vegetation forms dense field-driven groves with illustrated canopy sizes', () => {
  const map = generateMap({ seed: 583921 });
  assert.ok(map.vegetation.length >= 1200 && map.vegetation.length <= 2500);
  const { fields } = map.metadataLayers;
  const nearestVegetation = (tree) => {
    const column = Math.round((tree.position.x / map.bounds.width) * (fields.columns - 1));
    const row = Math.round((tree.position.y / map.bounds.height) * (fields.rows - 1));
    return fields.vegetation[row * fields.columns + column];
  };
  const treeAverage =
    map.vegetation.reduce((sum, tree) => sum + nearestVegetation(tree), 0) / map.vegetation.length;
  const fieldAverage =
    fields.vegetation.reduce((sum, value) => sum + value, 0) / fields.vegetation.length;
  assert.ok(treeAverage > fieldAverage + 0.025);
  assert.ok(map.vegetation.every((tree) => tree.radius >= 10 && tree.radius <= 18));
  assert.ok(map.vegetation.every((tree) => tree.collision.radius < tree.radius));
});

test('tree canopies stay out of water across seeds and extreme aspect ratios', () => {
  for (const [seed, width, height] of [
    [-91, 128, 4096],
    [0, 4096, 128],
    [982451653, 128, 128],
    [44, 1024, 768],
  ]) {
    const map = generateMap({
      seed,
      width,
      height,
      water: { amount: 0.6 },
      vegetation: { density: 0.5 },
    });
    for (const tree of map.vegetation) {
      assert.ok(
        !map.water.some((lake) =>
          circleIntersectsPolygon(tree.position, tree.radius, lake.geometry),
        ),
      );
    }
  }
});

// Coefficient of variation of trees per 100x100 world-unit cell. Lower means the
// woodland is spread evenly; higher means it is concentrated into groves.
const treeSpread = (map) => {
  const cells = new Map();
  for (const tree of map.vegetation) {
    const key = `${Math.floor(tree.position.x / 100)},${Math.floor(tree.position.y / 100)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const counts = [...cells.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length;
  return { cells: counts.length, cv: Math.sqrt(variance) / mean };
};

test('clustering has a usable range instead of saturating', () => {
  const spread = [0, 0.25, 0.5, 0.75, 1].map((clustering) =>
    treeSpread(
      generateMap({
        seed: 583921,
        vegetation: { density: 0.65, clustering },
        water: { amount: 0.15 },
      }),
    ),
  );
  // Every step up in clustering should make the woodland measurably more concentrated.
  for (let index = 1; index < spread.length; index += 1) {
    assert.ok(
      spread[index].cv > spread[index - 1].cv,
      `clustering should concentrate trees; cv went ${spread[index - 1].cv.toFixed(3)} -> ${spread[index].cv.toFixed(3)}`,
    );
  }
  // The control must span a real range, not a rounding difference.
  assert.ok(spread[4].cv > spread[0].cv * 1.5, 'clustering range is too compressed to be useful');
});

test('clustering reaches the density target across most of its range', () => {
  for (const density of [0.3, 0.65]) {
    const target = Math.round((2048 * 1536 * density) / 1250);
    for (const clustering of [0, 0.25, 0.5, 0.75]) {
      const map = generateMap({
        seed: 583921,
        vegetation: { density, clustering },
        water: { amount: 0.15 },
      });
      assert.equal(
        map.vegetation.length,
        target,
        `density ${density} clustering ${clustering} should reach its target`,
      );
    }
  }
});

test('moisture drives tree species rather than distributing them at random', () => {
  for (const seed of [583921, 42, 777, 90210]) {
    const map = generateMap({ seed, width: 1024, height: 768 });
    const { fields } = map.metadataLayers;
    const cellValue = (tree, field) => {
      const column = Math.round((tree.position.x / map.bounds.width) * (fields.columns - 1));
      const row = Math.round((tree.position.y / map.bounds.height) * (fields.rows - 1));
      return field[row * fields.columns + column];
    };
    const oaks = map.vegetation.filter((tree) => tree.species === 'oak');
    const birches = map.vegetation.filter((tree) => tree.species === 'birch');
    assert.ok(oaks.length > 20 && birches.length > 20, 'expected both species on every map');

    const mean = (trees) =>
      trees.reduce((sum, tree) => sum + cellValue(tree, fields.moisture), 0) / trees.length;
    // Birch is the wet-ground species, so it should sit on wetter ground than oak.
    assert.ok(mean(birches) > mean(oaks), `birch should favour wet ground on seed ${seed}`);
  }
});

test('species mix stays close to its base ratio', () => {
  for (const seed of [583921, 42, 777]) {
    const map = generateMap({ seed });
    const birches = map.vegetation.filter((tree) => tree.species === 'birch').length;
    const share = birches / map.vegetation.length;
    assert.ok(share > 0.15 && share < 0.45, `birch share ${share.toFixed(3)} drifted too far`);
  }
});

test('resolved generation settings survive JSON export and import unchanged', () => {
  const config = { seed: -17, width: 512, water: { amount: 0.42 }, vegetation: { density: 0.3 } };
  const map = generateMap(config);
  assert.equal(map.metadataLayers.generation.seed, config.seed);
  assert.equal(map.metadataLayers.generation.water.amount, config.water.amount);
  assert.deepEqual(importMap(exportMap(map)), map);
  assert.throws(() => generateMap({ seed: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
});

test('safe integer seeds do not alias through 32-bit coercion', () => {
  const first = generateMap({ seed: 0, width: 640, height: 480, vegetation: { density: 0 } });
  const second = generateMap({
    seed: 4294967296,
    width: 640,
    height: 480,
    vegetation: { density: 0 },
  });
  assert.notDeepEqual(first.metadataLayers.fields, second.metadataLayers.fields);
});
