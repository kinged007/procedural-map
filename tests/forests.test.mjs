import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateMap,
  importMap,
  exportMap,
  rasterizeWalkability,
  validateMap,
} from '../dist/index.js';
import { boundsOf, pointInPolygon, polygonArea } from '../dist/map/geometry.js';
import { generateForests } from '../dist/generation/forests.js';

const SEED = 583921;
const wooded = () =>
  generateMap({
    seed: SEED,
    width: 2048,
    height: 1536,
    vegetation: { density: 0.65, clustering: 0.8 },
  });

test('vegetation is grouped into groves, and every tree is accounted for', () => {
  const map = wooded();
  assert.ok(map.forests.length > 0, 'expected groves on a wooded map');

  const grouped = new Map();
  for (const forest of map.forests)
    for (const tree of forest.trees) {
      assert.ok(!grouped.has(tree.id), `tree ${tree.id} is in two groves`);
      grouped.set(tree.id, tree);
    }

  // A tree is published twice on purpose, so that a consumer wanting a flat tree list needs no new
  // code. The two copies have to be the same tree, or the flat list and the groves disagree.
  for (const tree of map.vegetation)
    if (grouped.has(tree.id))
      assert.deepEqual(grouped.get(tree.id), tree, `tree ${tree.id} differs between the two lists`);

  for (const forest of map.forests) {
    assert.equal(forest.metadata.treeCount, forest.trees.length);
    assert.ok(forest.trees.length >= 3, 'a grove is more than a loose pair of trees');
    assert.equal(forest.collision, undefined, 'a forest hull is not a collision shape');
  }
});

test('a point near wood tests a bounded number of trunks, and the bound does not grow with the map', () => {
  // This is the property the hull exists for. A consumer resolves a point by testing the bounds box
  // of each forest whose hull covers it, then the trunks of those forests, instead of every tree on
  // the map. What matters is not that a hull is a small fraction of the map but how many trunks a
  // lookup actually reaches, so that is what is measured.
  //
  // Measured: 18.0 trunks per point on a 2048 map and 18.1 on a 4096 map, with 8000 trees. The mean is
  // what has to stay flat, and the worst case is a handful of overlapping groves.
  const measure = (size) => {
    const map = generateMap({ seed: SEED, width: size, height: size });
    const boxes = map.forests.map((forest) => ({
      trees: forest.trees.length,
      box: boundsOf(forest.geometry.points),
    }));
    let worst = 0;
    let total = 0;
    for (let index = 0; index < 2000; index += 1) {
      const point = { x: (index * 7919) % size, y: (index * 104729) % size };
      let reachable = 0;
      for (const { trees, box } of boxes)
        if (
          point.x >= box.minX &&
          point.x <= box.maxX &&
          point.y >= box.minY &&
          point.y <= box.maxY
        )
          reachable += trees;
      worst = Math.max(worst, reachable);
      total += reachable;
    }
    return { mean: total / 2000, worst, trees: map.vegetation.length };
  };

  const small = measure(2048);
  const large = measure(4096);
  assert.ok(
    large.mean < small.mean * 1.5,
    `mean trunks per point grew from ${small.mean.toFixed(1)} to ${large.mean.toFixed(1)}`,
  );
  assert.ok(large.worst <= 400, `a point reached ${large.worst} trunks`);
  assert.ok(
    large.worst < large.trees * 0.1,
    `a point still reached ${large.worst} of ${large.trees} trees`,
  );

  // The size cap is what keeps this bounded: without it, dense woodland chains into one component
  // holding over a thousand trees and the hull stops narrowing anything.
  const map = generateMap({ seed: SEED, width: 4096, height: 4096 });
  assert.ok(Math.max(...map.forests.map((forest) => forest.trees.length)) <= 128);
});

test('a grove hull encloses every one of its trees', () => {
  const map = wooded();
  for (const forest of map.forests) {
    for (const tree of forest.trees)
      assert.ok(
        pointInPolygon(tree.position, forest.geometry),
        `tree ${tree.id} sits outside the hull of ${forest.id}`,
      );
    assert.ok(polygonArea(forest.geometry) > 0, `grove ${forest.id} has no area`);
  }
});

test('grove species follows the trees inside it', () => {
  const map = wooded();
  const kinds = new Set(map.forests.map((forest) => forest.species));
  assert.ok(kinds.size > 0);
  for (const forest of map.forests) {
    const oaks = forest.trees.filter((tree) => tree.species === 'oak').length;
    if (oaks === 0) assert.equal(forest.species, 'birch');
    else if (oaks === forest.trees.length) assert.equal(forest.species, 'oak');
    else assert.equal(forest.species, 'mixed');
  }
});

test('canopy cover is a percentage of the ground the grove stands on', () => {
  const map = wooded();
  for (const forest of map.forests) {
    const { densityPct } = forest.metadata;
    assert.ok(densityPct > 0, `grove ${forest.id} reported no cover`);
    assert.ok(densityPct <= 100, `grove ${forest.id} reported ${densityPct.toFixed(1)}% cover`);
  }
});

test('walkableInside is measured, not assumed', () => {
  // The field exists to stop a consumer sealing a grove by its hull, so it has to be checked against
  // the ground rather than set to whatever the default is. The answer is a property of the
  // resolution it was measured at, which the generator publishes, so the check uses the same one
  // rather than a finer or coarser guess at what "walkable" means.
  const CELL = 8;
  const map = wooded();
  const raster = rasterizeWalkability(map, { cellSize: CELL });

  const walkable = (forest) => {
    const box = boundsOf(forest.geometry.points);
    const trunksBlocked = new Set();
    for (const tree of forest.trees) {
      const { center, radius } = tree.collision;
      for (
        let row = Math.max(0, Math.floor((center.y - radius) / CELL));
        row <= Math.min(raster.rows - 1, Math.ceil((center.y + radius) / CELL) - 1);
        row += 1
      )
        for (
          let column = Math.max(0, Math.floor((center.x - radius) / CELL));
          column <= Math.min(raster.columns - 1, Math.ceil((center.x + radius) / CELL) - 1);
          column += 1
        )
          trunksBlocked.add(row * raster.columns + column);
    }
    for (
      let row = Math.max(0, Math.floor(box.minY / CELL));
      row <= Math.min(raster.rows - 1, Math.floor(box.maxY / CELL));
      row += 1
    )
      for (
        let column = Math.max(0, Math.floor(box.minX / CELL));
        column <= Math.min(raster.columns - 1, Math.floor(box.maxX / CELL));
        column += 1
      ) {
        const index = row * raster.columns + column;
        if (raster.cells[index] === 1 || trunksBlocked.has(index)) continue;
        if (pointInPolygon({ x: (column + 0.5) * CELL, y: (row + 0.5) * CELL }, forest.geometry))
          return true;
      }
    return false;
  };

  let walkableCount = 0;
  for (const forest of map.forests) {
    assert.equal(
      forest.metadata.walkableInside,
      walkable(forest),
      `grove ${forest.id} is misreported`,
    );
    if (forest.metadata.walkableInside) walkableCount += 1;
  }
  // A woodland where every grove is sealed is not believable, and would mean the field carries no
  // information at all. Conversely, if every grove were open the field would carry none either.
  assert.ok(walkableCount > 0, 'expected at least one grove with walkable ground inside its hull');
  assert.ok(walkableCount < map.forests.length, 'expected at least one dense grove to be sealed');
});

test('grove generation is stable for the same config', () => {
  const config = { seed: SEED, width: 640, height: 480, vegetation: { density: 0.9 } };
  assert.deepEqual(generateMap(config).forests, generateMap(config).forests);
});

test('a map with no trees has no groves', () => {
  const map = generateMap({ seed: SEED, width: 640, height: 480, vegetation: { density: 0 } });
  assert.deepEqual(map.forests, []);
  assert.equal(validateMap(map).valid, true);
});

test('two trees are one grove only when they are within the link distance', () => {
  // The grove is a broadphase, so a group that spans much more ground than the link distance makes
  // its hull useless for the job. The spatial index buckets trees on a grid of exactly the link
  // distance, so two trees can share a bucket while being almost a bucket diagonal apart, and only
  // a bucket that holds more than one tree ever gets that pair compared at all. Grouping on bucket
  // membership rather than on distance merges exactly those pairs, which is what this pins.
  const LINK_DISTANCE = 26;
  const tree = (id, x, y) => ({
    id: `t${id}`,
    type: 'tree',
    kind: 'tree',
    position: { x, y },
    radius: 4,
    collision: { type: 'circle', center: { x, y }, radius: 4 },
    metadata: { species: 'oak', canopy: { radius: 8 } },
  });

  // Three neighbours, each within the link distance of the others, are one grove.
  const near = generateForests([
    tree(0, 1, 1),
    tree(1, 1 + LINK_DISTANCE * 0.9, 1),
    tree(2, 1, 1 + LINK_DISTANCE * 0.9),
  ]);
  assert.equal(near.length, 1, 'three neighbours within the link distance are one grove');

  // These three all land in the same 26-unit bucket, but only the first two are within the link
  // distance of each other; the third is further from both than the link distance. A grove needs
  // three trees, so nothing is published. Grouping on the bucket instead would report a grove of
  // three, spanning a diagonal of about 1.3 link distances.
  const mixed = generateForests([
    tree(0, 1, 1),
    tree(1, 1 + LINK_DISTANCE * 0.92, 1),
    tree(2, 1 + LINK_DISTANCE * 0.46, 1 + LINK_DISTANCE * 0.92),
  ]);
  assert.equal(
    mixed.length,
    0,
    'a tree outside the link distance of the pair is not merged by sharing their bucket',
  );
});

test('forests survive export and import unchanged', () => {
  const map = wooded();
  const restored = importMap(exportMap(map));
  assert.deepEqual(restored.forests, map.forests);
  assert.equal(validateMap(restored).valid, true);
});

const forestFixture = (overrides) => {
  const trees = [
    {
      id: 'tree-1',
      type: 'tree',
      species: 'oak',
      position: { x: 40, y: 40 },
      radius: 12,
      collision: { type: 'circle', center: { x: 40, y: 40 }, radius: 4 },
    },
    {
      id: 'tree-2',
      type: 'tree',
      species: 'oak',
      position: { x: 60, y: 60 },
      radius: 12,
      collision: { type: 'circle', center: { x: 60, y: 60 }, radius: 4 },
    },
  ];
  return {
    version: '1.4',
    metadata: { id: 'forest-fixture' },
    bounds: { width: 100, height: 100 },
    terrain: [
      {
        id: 'terrain-grass',
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
    vegetation: trees,
    // A separate copy, as a map that has been through export and import carries. Sharing one array
    // between the two collections would hide exactly the drift this validator rule exists to catch.
    forests: [
      {
        id: 'forest-1',
        type: 'forest',
        species: 'oak',
        geometry: {
          points: [
            { x: 35, y: 35 },
            { x: 65, y: 35 },
            { x: 65, y: 65 },
            { x: 35, y: 65 },
          ],
        },
        trees: JSON.parse(JSON.stringify(trees)),
        asset: { category: 'vegetation.forest', variant: 'oak-1' },
        metadata: { treeCount: 2, densityPct: 4, edgeCoverPct: 4, walkableInside: true },
      },
    ],
    structures: [],
    settlements: [],
    docks: [],
    resourceSites: [],
    plots: [],
    roads: [],
    barriers: [],
    ...overrides,
  };
};

test('a forest carrying collision is rejected, because a hull is not a wall', () => {
  // The one deliberate break from the rule that every blocking feature carries collision. A consumer
  // that reads a hull as a wall would seal the clearings the trees leave walkable, so the data has
  // to fail loudly rather than be quietly believed.
  const withCollision = forestFixture();
  withCollision.forests[0].collision = {
    type: 'polygon',
    points: withCollision.forests[0].geometry.points,
  };
  const result = validateMap(withCollision);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.includes('forests[0].collision') && error.includes('broadphase'),
    ),
    result.errors.join('; '),
  );
});

test('a forest must agree with the tree list', () => {
  // A tree is published twice, so the two copies can drift unless something checks them.
  // The canopy radius is drifted rather than the position, because a position drift would be caught
  // earlier by the tree's own collision rule and this check would never be reached.
  const drifted = forestFixture();
  drifted.forests[0].trees[1] = { ...drifted.forests[0].trees[1], radius: 14 };
  let result = validateMap(drifted);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('must match the tree of the same id')));

  const invented = forestFixture();
  invented.forests[0].trees.push({ ...invented.vegetation[0], id: 'tree-99' });
  result = validateMap(invented);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => error.includes('must be a tree that also appears in vegetation')),
  );

  const repeated = forestFixture();
  repeated.forests[0].trees = [repeated.vegetation[0], repeated.vegetation[0]];
  result = validateMap(repeated);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('must not repeat a tree')));

  // The same tree with its keys written in another order is the same tree. Comparing the two as
  // serialised text would report a difference that is only ordering, which matters because a map
  // that arrived through a JSON parser can list the keys of a tree in any order.
  const reordered = forestFixture();
  reordered.forests[0].trees[1] = Object.fromEntries(
    Object.entries(reordered.forests[0].trees[1]).reverse(),
  );
  assert.equal(
    validateMap(reordered).valid,
    true,
    'reordering a tree’s keys must not read as a different tree',
  );
});

test('a forest needs a species, a hull, trees, and measured metadata', () => {
  for (const [patch, expected] of [
    [{ species: 'pine' }, 'must be a forest with a species'],
    [{ trees: [] }, 'must be a forest with a species'],
    [{ metadata: { treeCount: 2.5, densityPct: 4, walkableInside: true } }, 'metadata.treeCount'],
    [{ metadata: { treeCount: 2, densityPct: 4 } }, 'metadata.walkableInside'],
  ]) {
    const map = forestFixture();
    Object.assign(map.forests[0], patch);
    const result = validateMap(map);
    assert.equal(result.valid, false, JSON.stringify(patch));
    assert.ok(
      result.errors.some((error) => error.includes(expected)),
      `${JSON.stringify(patch)} -> ${result.errors.join('; ')}`,
    );
  }
});

test('a tree inside a forest still needs a valid trunk', () => {
  const map = forestFixture();
  map.forests[0].trees[0] = {
    ...map.forests[0].trees[0],
    collision: { type: 'circle', center: { x: 1, y: 1 }, radius: 4 },
  };
  const result = validateMap(map);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.includes('collision.center') || error.includes('must match the tree'),
    ),
    result.errors.join('; '),
  );
});

/**
 * A stand of trees, built rather than grown, so a test can control how closely the trunks sit.
 *
 * `canopy` is the canopy radius and `spacing` the distance between centres, so a spacing below the
 * canopy diameter overlaps and a spacing above it leaves gaps.
 */
function stand(spacing, canopy, side = 5) {
  const trees = [];
  let id = 0;
  for (let row = 0; row < side; row += 1)
    for (let column = 0; column < side; column += 1) {
      id += 1;
      const centre = { x: 500 + column * spacing, y: 500 + row * spacing };
      trees.push({
        id: `tree-${id}`,
        type: 'tree',
        species: 'oak',
        position: centre,
        radius: canopy,
        collision: { type: 'circle', center: centre, radius: 4 },
      });
    }
  return trees;
}

test('edge cover says how sharply a wood meets the scrub, and density cannot', () => {
  // The hull is drawn tight around the outermost canopies, so it is a hard edge whether the rim trees
  // overlap or stand apart, and `densityPct` saturates at 100 for a wood either way. The outline is
  // the only place the transition is visible, so that is where it is measured.
  const tight = generateForests(stand(11, 6));
  // 25, not 26 and not 20. 26 is exactly the link distance the grove is built on, so it is a
  // knife edge; and at 20 the gaps between the rim canopies are about as wide as the sampling step,
  // which saturates the measurement on a wood that plainly has one. 25 leaves a gap twice the step.
  const loose = generateForests(stand(25, 6));
  assert.equal(tight.length, 1, 'the tight stand should be one grove');
  assert.equal(loose.length, 1, 'the loose stand should be one grove');

  // Two groves of the same 25 trees, the same species, the same canopy, differing only in spacing.
  // Their hulls are the same square scaled up, so the hull a consumer draws a hard edge from is
  // identical in shape and carries nothing about which kind of edge it is closing off. That is what
  // the measurement is for, and this asserts it rather than asserting it in a comment.
  assert.equal(tight[0].metadata.treeCount, loose[0].metadata.treeCount);
  const side = (forest) => {
    const xs = forest.geometry.points.map((point) => point.x);
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.equal(tight[0].geometry.points.length, loose[0].geometry.points.length);
  assert.equal(
    side(loose[0]) / side(tight[0]),
    25 / 11,
    'the two hulls should be the same square at different scales, so shape cannot tell them apart',
  );
  assert.ok(
    tight[0].metadata.edgeCoverPct > loose[0].metadata.edgeCoverPct,
    `a rim of overlapping canopies (${tight[0].metadata.edgeCoverPct.toFixed(1)}%) should cover more of the outline than a rim of separated trees (${loose[0].metadata.edgeCoverPct.toFixed(1)}%)`,
  );
  // The tight one is a hard edge and the loose one is a band, which is the distinction itself.
  assert.ok(
    tight[0].metadata.edgeCoverPct > 95,
    `tight rim read ${tight[0].metadata.edgeCoverPct.toFixed(1)}%`,
  );
  assert.ok(
    loose[0].metadata.edgeCoverPct < 85,
    `loose rim read ${loose[0].metadata.edgeCoverPct.toFixed(1)}%`,
  );
});

test('edge cover is a measured percentage, and it is not the same number on every grove', () => {
  const cover = [];
  const density = [];
  for (const seed of [SEED, 42, 777, 7, 1, 99999]) {
    const map = generateMap({ seed, width: 2048, height: 1536 });
    for (const forest of map.forests) {
      const { edgeCoverPct } = forest.metadata;
      assert.ok(Number.isFinite(edgeCoverPct), `grove ${forest.id} reported no edge cover`);
      assert.ok(
        edgeCoverPct >= 0 && edgeCoverPct <= 100,
        `grove ${forest.id} reported ${edgeCoverPct}`,
      );
      cover.push(edgeCoverPct);
      density.push(forest.metadata.densityPct);
    }
  }
  // A measurement that saturates everywhere is the fault this was added to correct, so it is checked
  // directly. `densityPct` reads 100 on 302 of 303 groves over six default maps, because a hull drawn
  // tight around its own canopies is fully covered by construction. Edge cover has to separate them,
  // and the loosely linked mixed groves are where the ragged rims are.
  assert.ok(
    density.filter((value) => value === 100).length / density.length > 0.9,
    'densityPct no longer saturates, so this measurement may no longer be earning its place',
  );
  const ragged = cover.filter((value) => value < 90).length;
  assert.ok(
    ragged > 20,
    `only ${ragged} of ${cover.length} groves have a ragged rim, so edge cover is saturating too`,
  );
});

test('a forest without its measured edge cover is rejected', () => {
  // The measurement is required, because a consumer that draws a vegetation overlay needs to tell a
  // missing rim from a bare one, and an absent field is indistinguishable from a grove of one tree.
  const map = wooded();
  const forest = structuredClone(map.forests[0]);
  assert.equal(typeof forest.metadata.edgeCoverPct, 'number');
  delete forest.metadata.edgeCoverPct;
  const result = validateMap({ ...map, forests: [forest] });
  assert.ok(!result.valid, 'a forest with no edge cover was accepted');
  assert.match(result.errors.join(' '), /edgeCoverPct/);

  // And one that is not a percentage is a broken measurement rather than a ragged rim.
  const over = structuredClone(map.forests[0]);
  over.metadata.edgeCoverPct = 140;
  assert.match(validateMap({ ...map, forests: [over] }).errors.join(' '), /edgeCoverPct/);
});
