import assert from 'node:assert/strict';
import { defaultTheme } from '../dist/themes/DefaultTheme.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { exportMap, generateMap, importMap, validateMap } from '../dist/index.js';
import { circleIntersectsPolygon, pointInPolygon, polygonArea } from '../dist/map/geometry.js';

const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('generation is byte-stable for the same config', () => {
  const config = { seed: 583921, width: 640, height: 480 };
  const first = generateMap(config);
  const second = generateMap(config);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  // Pinned over the whole exported map, placement fields included, so a change to how a map is
  // serialised is caught here. This moved from the previous value when `origin` and `world` joined
  // the resolved config, again when water was allowed to reach the map edge, again when rivers
  // were published as water and the road separation gap was measured in both directions, again when a
  // river became the main channel of its catchment and roads crossed them, again when a course was
  // cut at a water body's shore and `rivers` joined the config, again when every course and road
  // centreline was curve-fitted so the channels are not staircases, and again when a course was
  // rejoined into one reach that runs to the water rather than one leg of it, and again when
  // buildings were published into `structures` and the format moved to 1.3, again when
  // settlements were published into `settlements` and the format moved to 1.4, and again when a
  // settlement gained the `kind` read off its membership, and again when a settlement opened a
  // `clearing`; 1.4 was never published, so the shape moved under the same version rather than
  // starting a 1.5 that no consumer had ever seen. The clearing moved this value for more than a new
  // field: it is a keep-out, so it took trees out of the wood and refused building sites, and
  // deleting the field afterwards does not put them back. The next move, when a building gained the
  // `state` that says whether it stands or has fallen down, was additive: deleting `state` and the
  // resolved `buildings.ruin` reproduced the previous map exactly, which is what drawing the ruin
  // from a stream of its own bought. The last move, moving the category weights out of the code and
  // into `buildings.categories`, is not additive, and the category draw being given a stream of its
  // own is why: a separate stream is a different sequence of numbers, so every building after the
  // first draws a different category. Reweighting now moves no building's site, which was the point,
  // and the default mix is unchanged at one site in nine. The last move published docks as a 1.4
  // collection, which moved the hash without moving the map: a `docks: []` is a key on the map and
  // the hash reads keys, and the default count of 0 is a map of no harbours.
  // `tests/tiling.test.mjs` holds the matching value for the map with the placement fields removed.
  assert.equal(
    stableHash(first),
    'a488aa4fdbed63a5f1ff20a2353782b3d65a4bd53e2d7d1b55bbdac1724094fb',
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

test('terrain classification produces bounded, valid regions for every kind', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91]) {
    const map = generateMap({ seed, width: 768, height: 512 });
    const base = map.terrain[0];
    assert.equal(base.kind, 'grass');
    assert.equal(polygonArea(base.geometry), map.bounds.width * map.bounds.height);

    const overlays = map.terrain.slice(1);
    assert.ok(new Set(overlays.map((region) => region.kind)).size > 0);

    for (const region of overlays) {
      assert.ok(['meadow', 'scrub', 'rock', 'beach'].includes(region.kind));
      assert.ok(polygonArea(region.geometry) > 0);
      for (const ring of [region.geometry.points, ...(region.geometry.holes ?? [])])
        for (const point of ring) {
          assert.ok(point.x >= 0 && point.x <= map.bounds.width);
          assert.ok(point.y >= 0 && point.y <= map.bounds.height);
        }
    }
  }
});

test('rock follows elevation and lands above the waterline', () => {
  for (const seed of [583921, 42, 777, 90210]) {
    const map = generateMap({ seed, width: 1024, height: 768, water: { amount: 0.25 } });
    const rock = map.terrain.filter((region) => region.kind === 'rock');
    assert.ok(rock.length > 0, `expected rock on seed ${seed}`);

    const { fields } = map.metadataLayers;
    const elevationAt = (point) => {
      const column = Math.round((point.x / map.bounds.width) * (fields.columns - 1));
      const row = Math.round((point.y / map.bounds.height) * (fields.rows - 1));
      return fields.elevation[row * fields.columns + column];
    };

    // Rock is the high ground, so its interior should sit above the water level.
    const level = map.metadataLayers.waterLevel;
    const interior = rock
      .map((region) => region.geometry.points)
      .flat()
      .map(elevationAt);
    const mean = interior.reduce((a, b) => a + b, 0) / interior.length;
    assert.ok(mean > level, `rock should sit above the waterline on seed ${seed}`);
  }
});

test('rock covers a small, stable share of the map', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91, 90210, 31337]) {
    const map = generateMap({ seed, width: 1024, height: 768, vegetation: { density: 0 } });
    const { fields } = map.metadataLayers;
    const level = map.terrain.find((region) => region.kind === 'rock').metadata.scoreLevel;
    const share =
      fields.elevation.filter((value) => value >= level).length / fields.elevation.length;
    assert.ok(share > 0.02 && share < 0.12, `rock share ${share.toFixed(3)} out of range`);
  }
});

test('the emitted rock polygon covers the high ground, not the low ground', () => {
  // Checking the field threshold alone is not enough: the polygon can be generated from the wrong
  // side of the contour and still report a correct scoreLevel. Compare the polygon area against the
  // share of the field above the level.
  for (const seed of [583921, 42, 777, 7, 0, -91]) {
    const map = generateMap({ seed, width: 1024, height: 768, vegetation: { density: 0 } });
    const { fields } = map.metadataLayers;
    const level = map.terrain.find((region) => region.kind === 'rock').metadata.scoreLevel;
    const expected =
      fields.elevation.filter((value) => value >= level).length / fields.elevation.length;
    const total = map.bounds.width * map.bounds.height;
    const actual =
      map.terrain
        .filter((region) => region.kind === 'rock')
        .reduce((sum, region) => sum + polygonArea(region.geometry), 0) / total;
    assert.ok(
      Math.abs(actual - expected) < 0.06,
      `seed ${seed}: rock polygon covers ${(actual * 100).toFixed(1)}% of the map, expected about ${(expected * 100).toFixed(1)}%`,
    );
  }
});

test('roads form a valid network on every seed and map size', () => {
  for (const config of [
    { seed: 583921 },
    { seed: 42, width: 1024, height: 768 },
    { seed: 7, width: 800, height: 600 },
    { seed: 0, width: 640, height: 480, water: { amount: 0.3 } },
    { seed: 12345, width: 512, height: 512 },
  ]) {
    const map = generateMap(config);
    assert.ok(map.roads.length > 0, `expected roads for seed ${config.seed}`);
    for (const road of map.roads) {
      assert.ok(['primary', 'secondary', 'path'].includes(road.kind));
      assert.equal(road.type, 'road');
      assert.ok(road.path.length >= 2, 'a road needs at least two points');
      assert.ok(road.width > 0, 'a road needs a positive width');
      assert.equal(road.collision.type, 'polygon');
      // The ribbon is built from the centreline, so it must have two points per centreline point.
      assert.equal(
        road.collision.points.length,
        road.path.length * 2,
        `road ${road.id} ribbon should match its centreline`,
      );
      for (const point of [...road.path, ...road.collision.points]) {
        assert.ok(point.x >= 0 && point.x <= map.bounds.width, `road ${road.id} leaves the map`);
        assert.ok(point.y >= 0 && point.y <= map.bounds.height, `road ${road.id} leaves the map`);
      }
    }
  }
});

test('a road never crosses a lake or impassable rock', () => {
  // Rivers are not in this set: a road goes over a channel rather than stopping at the bank, and the
  // crossing is recorded on the road's metadata. A lake is where a road cannot go at all.
  for (const config of [
    { seed: 583921 },
    { seed: 42, width: 1024, height: 768 },
    { seed: 7, width: 800, height: 600 },
    { seed: 12345, width: 640, height: 480 },
  ]) {
    const map = generateMap(config);
    const rock = map.terrain.filter((region) => region.kind === 'rock');
    const lakes = map.water.filter((region) => region.kind !== 'river');
    for (const road of map.roads) {
      for (const point of road.path) {
        for (const lake of lakes)
          assert.ok(
            !pointInPolygon(point, lake.geometry),
            `${road.id} runs through ${lake.id} on seed ${config.seed}`,
          );
        for (const region of rock)
          assert.ok(
            !pointInPolygon(point, region.geometry),
            `${road.id} runs through rock on seed ${config.seed}`,
          );
      }
    }
  }
});

test('a road keeps a minimum distance from the shoreline', () => {
  // The clearance the generator uses, restated here so a change to one without the other is caught.
  // It applies to a lake, which the road is kept out of; a river is crossed, not kept away from.
  const CLEARANCE = 20;
  const distanceToSegment = (point, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  };
  for (const config of [
    { seed: 583921 },
    { seed: 42, width: 1024, height: 768 },
    { seed: 7, water: { amount: 0.3 } },
  ]) {
    const map = generateMap(config);
    for (const road of map.roads) {
      // Both ends are checked separately: a road that runs along a bank still has to clear it where
      // it stops, which is where a setback is easiest to lose.
      for (const point of [road.path[0], road.path[road.path.length - 1], ...road.path]) {
        for (const lake of map.water.filter((region) => region.kind !== 'river')) {
          const ring = lake.geometry.points;
          let closest = Infinity;
          for (let k = 0; k < ring.length; k += 1)
            closest = Math.min(
              closest,
              distanceToSegment(point, ring[k], ring[(k + 1) % ring.length]),
            );
          assert.ok(
            closest >= CLEARANCE - 0.5,
            `${road.id} ends ${closest.toFixed(1)} units from ${lake.id} on seed ${config.seed}`,
          );
        }
      }
    }
  }
});

test('no tree is planted on or overhanging a road', () => {
  for (const config of [
    { seed: 583921 },
    { seed: 42, width: 1024, height: 768 },
    { seed: 7, vegetation: { density: 0.9, clustering: 0.2 } },
  ]) {
    const map = generateMap(config);
    if (map.roads.length === 0) continue;
    for (const tree of map.vegetation)
      for (const road of map.roads)
        assert.ok(
          !circleIntersectsPolygon(tree.position, tree.radius + 3, road.collision),
          `${tree.id} overhangs ${road.id}`,
        );
  }
});

test('road density scales the network', () => {
  const counts = [0, 0.25, 0.5, 0.75, 1].map(
    (density) => generateMap({ seed: 583921, roads: { density } }).roads.length,
  );
  for (let i = 1; i < counts.length; i += 1)
    assert.ok(
      counts[i] >= counts[i - 1],
      `density should not reduce the network: ${counts.join(', ')}`,
    );
  assert.ok(
    counts[counts.length - 1] > counts[0] * 2,
    `density should have a real effect: ${counts.join(', ')}`,
  );
});

test('road tiers are distinct and each has a sensible width', () => {
  const map = generateMap({ seed: 583921, roads: { density: 1 } });
  const widths = new Map();
  for (const road of map.roads) widths.set(road.kind, road.width);
  assert.ok(widths.has('primary') && widths.has('secondary') && widths.has('path'));
  // A primary must be wider than a secondary, which must be wider than a path.
  assert.ok(widths.get('primary') > widths.get('secondary'), 'primary should be widest');
  assert.ok(widths.get('secondary') > widths.get('path'), 'secondary should be wider than a path');
  // Restated from docs/gamemap-schema.md, so a width change has to land in the docs too.
  assert.deepEqual([...widths].sort(), [
    ['path', 7],
    ['primary', 22],
    ['secondary', 14],
  ]);
});

test('roads stay apart from each other except where they branch', () => {
  // Parallel roads that overlap read as a single smeared stripe. A branch is expected to touch the
  // road it grew from, so only that pair is allowed to be close.
  const map = generateMap({ seed: 583921, roads: { density: 1 } });
  const shortSide = Math.min(map.bounds.width, map.bounds.height);
  const separation = shortSide * 0.08;
  const distanceToSegment = (point, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  };
  for (let i = 0; i < map.roads.length; i += 1)
    for (let j = i + 1; j < map.roads.length; j += 1) {
      const a = map.roads[i];
      const b = map.roads[j];
      // A branch is required to touch its parent, so the shared junction is skipped.
      const touching = a.path.some((p) => b.path.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1));
      if (touching) continue;
      for (const point of a.path)
        for (let k = 1; k < b.path.length; k += 1)
          assert.ok(
            distanceToSegment(point, b.path[k - 1], b.path[k]) > separation,
            `${a.id} and ${b.id} overlap where they are not joined`,
          );
    }
});

test('road generation is skipped when the map is mostly water', () => {
  // With almost no dry ground, a network would be meaningless, and routing every candidate would be
  // wasted work.
  const map = generateMap({ seed: 4, width: 512, height: 512, water: { amount: 1 } });
  assert.equal(map.roads.length, 0, 'a fully flooded map has no roads');
});

test('rock publishes a collision polygon covering the region', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91]) {
    const map = generateMap({ seed, width: 1024, height: 768 });
    const rock = map.terrain.filter((region) => region.kind === 'rock');
    assert.ok(rock.length > 0, `expected rock on seed ${seed}`);
    for (const region of rock) {
      assert.ok(region.collision, 'rock should block movement');
      assert.equal(region.collision.type, 'polygon');
      assert.deepEqual(
        region.collision.points,
        region.geometry.points,
        'rock collision should cover the same ground it draws',
      );
      assert.deepEqual(region.collision.holes, region.geometry.holes);
    }
  }
});

test('passable terrain carries no collision', () => {
  // Only rock is impassable. Water and trees already block movement, and grass, meadow, scrub, and
  // beach must stay walkable.
  const map = generateMap({ seed: 583921, width: 1024, height: 768 });
  for (const region of map.terrain) {
    if (region.kind === 'rock') continue;
    assert.equal(region.collision, undefined, `${region.kind} should be passable`);
  }
});

test('trees do not grow on impassable terrain', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91, 5, 100]) {
    const map = generateMap({ seed, width: 1024, height: 768 });
    const rock = map.terrain.filter((region) => region.kind === 'rock');
    for (const tree of map.vegetation)
      for (const region of rock)
        assert.ok(
          !circleIntersectsPolygon(tree.position, tree.radius, region.geometry),
          `seed ${seed}: tree ${tree.id} overlaps rock ${region.id}`,
        );
  }
});

test('the collision view has geometry for every blocking feature', () => {
  // The renderer draws the collision view from per-entity collision, so every impassable feature
  // has to carry it or it is silently walkable.
  const map = generateMap({ seed: 583921, width: 1024, height: 768 });
  for (const region of map.terrain)
    if (region.kind === 'rock') assert.ok(region.collision, 'rock must draw in the collision view');
  for (const lake of map.water) assert.ok(lake.collision, 'water must draw in the collision view');
  for (const tree of map.vegetation)
    assert.ok(tree.collision, 'trees must draw in the collision view');
});

/**
 * Lakes the beach pass is responsible for. Rivers are never given a band, and water cut by the map
 * edge has no outward room for one, so `shorelineBand` skips both.
 */
const enclosedLakes = (map) =>
  map.water.filter(
    (lake) =>
      lake.kind === 'lake' &&
      lake.geometry.points.every(
        (point) =>
          point.x > 0 && point.x < map.bounds.width && point.y > 0 && point.y < map.bounds.height,
      ),
  );

test('beaches form a band that hugs each shoreline and excludes the lake', () => {
  const map = generateMap({ seed: 583921, width: 1024, height: 768, water: { amount: 0.2 } });
  const beaches = map.terrain.filter((region) => region.kind === 'beach');
  assert.equal(beaches.length, enclosedLakes(map).length, 'each enclosed lake should get a beach');

  for (const beach of beaches) {
    const lake = map.water.find((candidate) => candidate.id === beach.metadata.source);
    assert.ok(lake, 'beach should reference its source lake');
    assert.equal(beach.geometry.holes.length, 1, 'the lake should be punched out of the band');

    // The band is the lake grown by a per-vertex offset, so each outer-ring point sits its own
    // distance from the matching lake vertex.
    const width = beach.metadata.shorelineWidth;
    assert.equal(
      beach.geometry.points.length,
      lake.geometry.points.length,
      'band ring should keep the lake ring vertex count',
    );
    const offsets = beach.geometry.points.map((point, index) => {
      const vertex = lake.geometry.points[index];
      return Math.hypot(point.x - vertex.x, point.y - vertex.y);
    });
    assert.ok(
      Math.max(...offsets) - Math.min(...offsets) > 1,
      'offsets should differ around the shore',
    );
    // The shrink fallback scales every offset by the same factor, so the band may be narrower than
    // requested but never wider.
    assert.ok(Math.max(...offsets) <= width.max + 0.5, 'band should not exceed the widest offset');
    assert.ok(Math.min(...offsets) <= width.min + 0.5, 'band should not go below the narrowest');
    // A band too wide for the shoreline is scaled down uniformly, so the realised widths track the
    // requested range without ever exceeding it.
    assert.ok(
      Math.min(...offsets) >= width.min - 0.5,
      'realised widths should not fall below the requested minimum',
    );
    assert.ok(polygonArea(beach.geometry) > 0, 'beach should enclose a positive area');

    // The lake interior is a hole, so a lake vertex must not be inside the beach polygon.
    assert.ok(
      !pointInPolygon(lake.geometry.points[0], beach.geometry),
      'the lake interior should be outside its own beach band',
    );
  }
});

test('beaches are skipped rather than emitted outside the map or self-intersecting', () => {
  // Tiny maps and full water leave no room for a band; the generator must omit the beach rather
  // than emit geometry that fails validation.
  for (const config of [
    { seed: 1, water: { amount: 1 } },
    { seed: 2, water: { amount: 0 } },
    { seed: 4, width: 128, height: 128, water: { amount: 0.5 } },
  ]) {
    const map = generateMap(config);
    const result = validateMap(map);
    assert.ok(result.valid, result.errors.join('; '));
    for (const beach of map.terrain.filter((region) => region.kind === 'beach'))
      for (const ring of [beach.geometry.points, ...beach.geometry.holes])
        for (const point of ring) {
          assert.ok(point.x >= 0 && point.x <= map.bounds.width);
          assert.ok(point.y >= 0 && point.y <= map.bounds.height);
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
  // `water` also carries the rivers, which are traced rather than contoured, so the count here is the
  // lakes alone.
  const lakes = map.water.filter((region) => region.kind === 'lake');
  assert.equal(lakes.length, 14);
  assert.equal(
    lakes.reduce((sum, lake) => sum + (lake.geometry.holes?.length ?? 0), 0),
    0,
  );
});

test('water reaches the map edge where the terrain forms it, cut by the edge', () => {
  // A shoreline used to be forced to close inside the map, so every border was a strip of land no
  // matter how low the terrain ran. Water now runs to the edge and is cut by it, but only where the
  // border is genuinely below the level: a border that sits high still reads as land, so this is not
  // a ring of ocean around the whole map.
  const width = 1024;
  const height = 768;
  const lakes = (map) => map.water.filter((region) => region.kind === 'lake');
  const onEdge = (lake) =>
    lake.geometry.points.some(
      (point) =>
        point.x <= 1e-9 || point.x >= width - 1e-9 || point.y <= 1e-9 || point.y >= height - 1e-9,
    );

  let reachedTheEdge = 0;
  for (const amount of [0.2, 0.5, 0.8]) {
    const map = generateMap({ seed: 42, width, height, water: { amount } });
    for (const lake of lakes(map)) {
      for (const point of lake.geometry.points)
        assert.ok(
          point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height,
          'shoreline cut by the edge must stay inside the map',
        );
      if (onEdge(lake)) reachedTheEdge += 1;
    }
  }
  assert.ok(reachedTheEdge > 0, 'some water should run to the map edge');

  // And the converse: at a middling amount not every lake is cut, so high ground on a border is
  // still land rather than the whole map being flooded.
  const map = generateMap({ seed: 42, width, height, water: { amount: 0.3 } });
  const all = lakes(map);
  assert.ok(
    all.some((lake) => !onEdge(lake)),
    'a lake away from the border should remain fully enclosed',
  );
});

// Terrain overlays overlap freely and are NOT nested: on a typical map the scrub contour
// encloses more area than the meadow contour, so the boundaries cross. What is contractual is the
// emission order (grass, then meadow, then scrub) combined with last-match-wins resolution, which
// yields scrub > meadow > grass precedence. These tests pin both, so a future change to region
// ordering, kind assignment, or contouring cannot silently change which surface a consumer sees.
test('beach width varies around each shoreline', () => {
  // A single-width band reads as a line rather than ground. Widths must differ along the shore, not
  // just between maps.
  let sawVariation = false;
  for (const seed of [583921, 42, 777, 7, 0, -91, 100]) {
    const map = generateMap({ seed, width: 1024, height: 768, water: { amount: 0.2 } });
    for (const beach of map.terrain.filter((region) => region.kind === 'beach')) {
      const { max, min } = beach.metadata.shorelineWidth;
      if (max - min > 1) sawVariation = true;
      assert.ok(min >= 0, 'beach width must not be negative');
      assert.ok(max > 0, 'beach width must be positive');
    }
  }
  assert.ok(sawVariation, 'at least one shoreline should vary in width');
});

test('every lake gets a beach across seeds and map sizes', () => {
  // A wide band is rejected more often than a narrow one, so a regression here would silently strip
  // beaches from entire maps rather than fail loudly.
  for (const config of [
    { seed: 583921, width: 1024, height: 768, water: { amount: 0.2 } },
    { seed: 90210, width: 1024, height: 768, water: { amount: 0.2 } },
    { seed: 0, width: 1024, height: 768, water: { amount: 0.2 } },
    { seed: 5, width: 800, height: 600, water: { amount: 0.3 } },
    { seed: 100, width: 640, height: 480, water: { amount: 0.25 } },
  ]) {
    const map = generateMap(config);
    const beaches = map.terrain.filter((region) => region.kind === 'beach');
    if (map.water.length === 0) continue;
    assert.equal(
      beaches.length,
      enclosedLakes(map).length,
      `seed ${config.seed} should give every enclosed lake a beach`,
    );
  }
});

test('beach width is wide enough to be visible at fit zoom', () => {
  // A map drawn to fill a laptop viewport puts roughly 0.44 screen pixels on one world unit, so the
  // old fixed 7-unit band landed at about 3 pixels and read as a line. The median beach now has to
  // be several times wider than that, and roughly half must clear 10 units.
  const widths = [];
  for (const seed of [583921, 42, 777, 7, 0, -91, 5, 100, 12345]) {
    const map = generateMap({ seed, width: 1024, height: 768, water: { amount: 0.2 } });
    for (const beach of map.terrain.filter((region) => region.kind === 'beach'))
      widths.push(beach.metadata.shorelineWidth.max);
  }
  widths.sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  assert.ok(widths.length > 10, `expected many beaches, got ${widths.length}`);
  assert.ok(
    median > 10,
    `median widest beach section should clear 10 units, got ${median.toFixed(1)}`,
  );
  const wide = widths.filter((width) => width > 10).length;
  assert.ok(
    wide / widths.length > 0.5,
    `most beaches should exceed 10 units, got ${wide}/${widths.length}`,
  );
});

test('terrain colours are distinguishable in the default theme', () => {
  // Rock was previously 20 RGB units from meadow and invisible on screen.
  const channel = (hex, index) => parseInt(hex.slice(index, index + 2), 16);
  const distance = (a, b) =>
    Math.hypot(
      channel(a, 1) - channel(b, 1),
      channel(a, 3) - channel(b, 3),
      channel(a, 5) - channel(b, 5),
    );
  const { terrain } = defaultTheme;
  const pairs = [
    ['rock', 'meadow'],
    ['rock', 'grass'],
    ['rock', 'scrub'],
    ['beach', 'grass'],
    ['beach', 'scrub'],
  ];
  for (const [a, b] of pairs)
    assert.ok(
      distance(terrain[a], terrain[b]) > 25,
      `${a} and ${b} should be clearly distinguishable, got ${distance(terrain[a], terrain[b]).toFixed(0)}`,
    );
});

test('terrain regions are emitted grass, meadow, scrub, rock, beach', () => {
  for (const seed of [583921, 42, 777, 7, 0, -91, 90210, 31337]) {
    const map = generateMap({ seed, width: 768, height: 512 });
    const kinds = map.terrain.map((region) => region.kind);
    assert.equal(kinds[0], 'grass');
    // The array must stay grouped in precedence order, whatever mix of kinds a seed produces.
    const order = ['grass', 'meadow', 'scrub', 'rock', 'beach'];
    let previous = -1;
    for (const kind of kinds) {
      const position = order.indexOf(kind);
      assert.ok(position >= 0, `unexpected terrain kind ${kind}`);
      assert.ok(position >= previous, `seed ${seed} emitted ${kind} out of precedence order`);
      previous = position;
    }
  }
});

test('overlapping terrain resolves to one kind per point by emission order', () => {
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

      // Precedence follows emission order, so the last match decides: beach, then rock, then
      // scrub, then meadow, then grass.
      const kinds = ['beach', 'rock', 'scrub', 'meadow', 'grass'];
      const matched = kinds.filter((kind) => matches.some((region) => region.kind === kind));
      assert.equal(
        matches[matches.length - 1].kind,
        matched[0],
        'last match must equal the highest-precedence match',
      );
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
  // The coverage is the lakes alone. `water` also carries the rivers, which are traced down the
  // drainage rather than contoured from a level, and a river on a map this flooded is the last of the
  // water in a valley rather than part of the high-water surface the ceiling is about.
  const lakes = map.water.filter((region) => region.kind === 'lake');
  const coverage =
    lakes.reduce((sum, lake) => sum + polygonArea(lake.geometry), 0) /
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
