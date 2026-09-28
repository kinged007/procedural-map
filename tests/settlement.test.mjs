import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMap,
  pointInPolygon,
  rasterizeWalkability,
  spawnCandidates,
  validateMap,
} from '../dist/index.js';

const MAP = { seed: 583921, width: 2048, height: 1536 };
const settlements = (count) => generateMap({ ...MAP, settlements: { count } }).settlements;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** The shortest distance from a point to any road centreline. */
function distanceToRoad(map, point) {
  let best = Infinity;
  for (const road of map.roads)
    for (let index = 1; index < road.path.length; index += 1) {
      const a = road.path[index - 1];
      const b = road.path[index];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      let t = length ? ((point.x - a.x) * dx + (point.y - a.y) * dy) / length : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
    }
  return best;
}

test('settlements are published as typed entities, and the map is valid with them', () => {
  const map = generateMap({ ...MAP, settlements: { count: 4 } });
  assert.equal(settlements(4).length, 4, 'the count is a parameter, not a consequence');
  assert.equal(validateMap(map).valid, true, JSON.stringify(validateMap(map).errors));
  assert.equal(map.version, '1.4');
  for (const settlement of map.settlements) {
    assert.equal(settlement.type, 'settlement');
    assert.ok(['hamlet', 'village', 'town'].includes(settlement.kind));
    assert.ok(settlement.id.length > 0);
    assert.ok(Number.isFinite(settlement.position.x) && Number.isFinite(settlement.position.y));
    assert.ok(settlement.radius > 0, 'a settlement has to reach somewhere');
    assert.ok(Array.isArray(settlement.metadata.buildingIds));
    // A settlement describes where a place ends; it is not a wall, so it carries no collision.
    assert.equal(settlement.collision, undefined, 'a settlement is not a collider');
  }
});

test('the count parameter is honoured from zero upwards, and a map with no roads has none', () => {
  for (const count of [0, 1, 2, 5, 9])
    assert.equal(settlements(count).length, count, `asked for ${count}`);
  // A roadless map has no frontage, so it has nowhere to put a centre.
  const roadless = generateMap({ seed: 7, width: 1024, height: 768, settlements: { count: 4 } });
  assert.equal(roadless.roads.length, 0);
  assert.equal(roadless.settlements.length, 0);
});

test('every centre stands on a road, and centres keep their distance apart', () => {
  const map = generateMap({ ...MAP, settlements: { count: 6 } });
  for (const settlement of map.settlements)
    assert.ok(
      distanceToRoad(map, settlement.position) < 1e-6,
      'a settlement wants frontage, so its centre is on the road network',
    );
  for (let i = 0; i < map.settlements.length; i += 1)
    for (let j = i + 1; j < map.settlements.length; j += 1)
      assert.ok(
        distance(map.settlements[i].position, map.settlements[j].position) >= 260,
        'four settlements means four places, not one place counted four times',
      );
});

test('membership is the buildings in range, naming only buildings that exist', () => {
  const map = generateMap({ ...MAP, settlements: { count: 6 } });
  const byId = new Map(map.structures.map((building) => [building.id, building]));
  for (const settlement of map.settlements) {
    for (const id of settlement.metadata.buildingIds) {
      const building = byId.get(id);
      assert.ok(building, `membership names a real building: ${id}`);
      assert.ok(
        distance(settlement.position, building.position) <= settlement.radius,
        'a member is a building inside the settlement',
      );
    }
  }
  // Settlements are placed apart, so a building belongs to one of them, not to two.
  const claimed = map.settlements.flatMap((settlement) => settlement.metadata.buildingIds);
  assert.equal(new Set(claimed).size, claimed.length, 'no building is claimed twice');
});

test('a settlement with no buildings is valid, and mixing the counts produces one', () => {
  // The dead case the PRD asks for: settlements with nowhere to be built on. It comes from mixing
  // the two parameters, not from a switch.
  const dead = generateMap({ ...MAP, buildings: { density: 0 }, settlements: { count: 6 } });
  assert.equal(dead.structures.length, 0, 'no housing at all');
  assert.equal(dead.settlements.length, 6, 'the places are still there');
  assert.ok(
    dead.settlements.every((settlement) => settlement.metadata.buildingIds.length === 0),
    'every settlement is dead',
  );
  assert.equal(validateMap(dead).valid, true, 'an empty settlement is a settlement');
});

test('a settlement names its size by the buildings it holds, and it is not a knob', () => {
  const sizes = new Map();
  for (const seed of [583921, 42, 99, 1234, 20250816, 31337, 5, 777, 8, 61])
    for (const count of [1, 2, 4, 6, 9, 12]) {
      const map = generateMap({ seed, width: 2048, height: 1536, settlements: { count } });
      for (const settlement of map.settlements)
        sizes.set(`${seed}/${count}/${settlement.id}`, [
          settlement.kind,
          settlement.metadata.buildingIds.length,
        ]);
    }

  // The kind is read off the membership, so the two cannot disagree.
  for (const [kind, count] of sizes.values()) {
    const expected = count < 4 ? 'hamlet' : count < 9 ? 'village' : 'town';
    assert.equal(kind, expected, `${count} buildings is a ${expected}`);
  }
  // Every kind is reachable on a default map, or the field would be decoration.
  const kinds = new Set([...sizes.values()].map(([kind]) => kind));
  assert.deepEqual([...kinds].sort(), ['hamlet', 'town', 'village'], 'all three kinds occur');
  // There is no config to set it with, so the only way to change it is to change the housing.
  const kinded = generateMap({ ...MAP, buildings: { density: 0 }, settlements: { count: 6 } });
  assert.ok(
    kinded.settlements.every((settlement) => settlement.kind === 'hamlet'),
    'a dead settlement is a hamlet, because it holds nothing',
  );
});

test('a settlement is offered as a spawn point when one is asked for', () => {
  const map = generateMap({ ...MAP, settlements: { count: 6 } });
  const raster = rasterizeWalkability(map, { cellSize: 16 });
  const wanted = Math.max(map.settlements.length, 4);
  const candidates = spawnCandidates(raster, map, {
    count: wanted,
    minSeparation: 200,
    preferSettlements: true,
  });

  assert.equal(candidates.length, wanted, 'asking for settlements never returns fewer points');
  const offered = new Set(
    candidates
      .filter((candidate) => candidate.settlementId)
      .map((candidate) => candidate.settlementId),
  );
  for (const settlement of map.settlements)
    assert.ok(offered.has(settlement.id), `a settlement is always offered: ${settlement.id}`);

  // A candidate is a place a character can stand, so it is on open ground, clear of trees, and in a
  // region the walkability analysis actually found.
  for (const candidate of candidates) {
    const column = Math.floor(candidate.point.x / raster.cellSize);
    const row = Math.floor(candidate.point.y / raster.cellSize);
    assert.equal(raster.cells[row * raster.columns + column], 0, 'on open ground');
    assert.ok(candidate.region >= 0, 'in a navigable region');
    assert.ok(
      !map.vegetation.some(
        (tree) =>
          (tree.position.x - candidate.point.x) ** 2 + (tree.position.y - candidate.point.y) ** 2 <=
          tree.collision.radius ** 2,
      ),
      'not inside a tree',
    );
  }
});

test('spawn candidates are unchanged unless a settlement is asked for', () => {
  const map = generateMap({ ...MAP, settlements: { count: 6 } });
  const raster = rasterizeWalkability(map, { cellSize: 16 });
  const plain = spawnCandidates(raster, map, { count: 4, minSeparation: 200 });
  assert.ok(
    plain.every((candidate) => candidate.settlementId === undefined),
    'the roomiest ground is still the roomiest ground',
  );
  const once = spawnCandidates(raster, map, {
    count: 6,
    minSeparation: 200,
    preferSettlements: true,
  });
  const twice = spawnCandidates(raster, map, {
    count: 6,
    minSeparation: 200,
    preferSettlements: true,
  });
  assert.deepEqual(once, twice, 'deterministic');
});

test('a settlement opens a clearing at its centre, and nothing stands in it', () => {
  const map = generateMap({ ...MAP, settlements: { count: 6 } });
  for (const settlement of map.settlements) {
    // A consumer places the middle of the place on the centre, so the centre must be inside its own
    // clearing and the clearing must be a real polygon.
    assert.ok(settlement.clearing.points.length >= 8, 'the clearing is a ring, not a point');
    assert.ok(
      pointInPolygon(settlement.position, settlement.clearing),
      'the centre is in the clearing',
    );
    // Walkable ground, not a wall: the same argument a settlement radius makes.
    assert.equal(settlement.collision, undefined, 'a clearing is ground, not a collider');
  }
});

test('no tree roots in a clearing and no building stands in one', () => {
  for (const seed of [583921, 42, 99, 1234, 20250816, 31337, 5, 777])
    for (const count of [2, 6, 12]) {
      const map = generateMap({ seed, width: 2048, height: 1536, settlements: { count } });
      for (const settlement of map.settlements) {
        const inside = (geometry) =>
          pointInPolygon({ x: geometry.x, y: geometry.y }, settlement.clearing);
        for (const tree of map.vegetation) {
          const gap = Math.hypot(
            tree.position.x - settlement.position.x,
            tree.position.y - settlement.position.y,
          );
          const clearingReach = Math.hypot(
            settlement.clearing.points[0].x - settlement.position.x,
            settlement.clearing.points[0].y - settlement.position.y,
          );
          assert.ok(
            gap - tree.radius > clearingReach,
            `a canopy does not reach into a clearing (seed ${seed}, ${settlement.id})`,
          );
        }
        for (const building of map.structures)
          assert.ok(
            !inside(building.position),
            `nothing is built in a clearing (seed ${seed}, ${settlement.id})`,
          );
      }
    }
});

test('a clearing stays inside the map, shrinking rather than leaving the world', () => {
  for (const seed of [583921, 42, 99, 1234, 20250816, 31337, 5, 777])
    for (const [width, height] of [
      [1024, 768],
      [2048, 1536],
      [4096, 4096],
    ]) {
      const map = generateMap({ seed, width, height, settlements: { count: 8 } });
      for (const settlement of map.settlements)
        for (const point of settlement.clearing.points) {
          assert.ok(
            point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height,
            'a polygon outside the bounds is not a valid one',
          );
        }
      // A settlement at the edge keeps a smaller green rather than being dropped.
      assert.equal(validateMap(map).valid, true, 'the map is valid at every size');
    }
});

test('a membership naming a building that is not on the map is rejected', () => {
  // A consumer resolves buildingIds without a guard, so a name that resolves to nothing would be a
  // membership it cannot act on.
  const map = generateMap({ ...MAP, settlements: { count: 3 } });
  const dangling = JSON.parse(JSON.stringify(map));
  dangling.settlements[0].metadata.buildingIds = ['building-does-not-exist'];
  const result = validateMap(dangling);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes('settlements[0].metadata.buildingIds[0]') && error.includes('structures'),
    ),
    result.errors.join('; '),
  );
});

test('the same seed gives the same settlements, and a count moves the buildings on purpose', () => {
  const once = settlements(5);
  const twice = settlements(5);
  assert.deepEqual(once, twice, 'generation is deterministic');

  // A clearing is ground no building may stand on, so asking for a different number of settlements
  // changes where those clearings are and therefore which buildings can exist. The trees move with
  // them for the same reason. What must not happen is the same count rolling differently.
  const few = generateMap({ ...MAP, settlements: { count: 1 } });
  const many = generateMap({ ...MAP, settlements: { count: 9 } });
  assert.notDeepEqual(
    few.structures,
    many.structures,
    'a clearing is a keep-out, so the count is allowed to move the buildings',
  );
  assert.notDeepEqual(few.vegetation, many.vegetation, 'and the trees, which cannot root in one');
  // At a fixed count the same clearings come out, so the site stream is still its own.
  assert.deepEqual(
    generateMap({ ...MAP, settlements: { count: 9 } }).settlements,
    many.settlements,
    'the same count always picks the same sites',
  );
});
