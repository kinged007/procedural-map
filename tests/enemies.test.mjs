import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, validateMap, pointInPolygon } from '../dist/index.js';

const MAP = { seed: 583921, width: 2048, height: 1536 };
const camps = (extra = {}) =>
  generateMap({ ...MAP, settlements: { count: 4 }, enemies: { count: 12 }, ...extra });

const between = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The same clear-run test the generator uses, written out again so a change to either one shows up as
 * a failure rather than as both drifting together. `reach` is the full run, not the first clear
 * step, which is the case this is for.
 */
function clearRun(from, facing, blocked, reach) {
  for (let step = 4; step <= reach; step += 4) {
    const at = { x: from.x + Math.cos(facing) * step, y: from.y + Math.sin(facing) * step };
    if (blocked(at)) return false;
  }
  return true;
}

test('a map publishes no camps unless a caller asks', () => {
  const map = generateMap(MAP);
  assert.deepEqual(map.enemySettlements, []);
  // The default is the whole point: a map says where rock ends, not that anyone is in it.
  assert.equal(validateMap(map).valid, true);
});

test('camps are a site and nothing else', () => {
  const map = camps();
  assert.ok(map.enemySettlements.length > 0, 'the reference map should be able to seat some camps');
  for (const camp of map.enemySettlements) {
    assert.equal(camp.type, 'enemySettlement');
    assert.ok(camp.position, 'a camp has a centre');
    assert.ok(camp.geometry.points.length >= 3, 'a camp publishes a footprint');
    assert.ok(camp.radius > 0);
    // Nothing blocks until a consumer builds something inside the footprint it published. A camp
    // that carried a collision would be an obstacle the generator invented for a place it knows
    // nothing about.
    assert.equal(camp.collision, undefined);
    // It is a place, so there is nothing in it. A camp claiming a building is a village wearing a
    // different name.
    assert.equal(camp.metadata.buildingIds, undefined);
    assert.ok(['wood', 'rock', 'open'].includes(camp.metadata.ground));
  }
});

test('a camp is held from a settlement by the distance the caller set', () => {
  const near = generateMap({
    ...MAP,
    settlements: { count: 4 },
    enemies: { count: 8, minDistance: 400 },
  });
  const far = generateMap({
    ...MAP,
    settlements: { count: 4 },
    enemies: { count: 8, minDistance: 1100 },
  });
  const tightest = (map) => {
    assert.ok(
      map.enemySettlements.length > 0,
      `expected some camps, got ${map.enemySettlements.length}`,
    );
    return Math.min(
      ...map.enemySettlements.map((camp) =>
        between(camp.position, nearest(map, camp.position).position),
      ),
    );
  };
  // The setting has to actually move camps, or it is decoration.
  assert.ok(tightest(near) >= 400, `a 400 camp was ${tightest(near).toFixed(0)} from a town`);
  assert.ok(tightest(far) >= 1100, `an 1100 camp was ${tightest(far).toFixed(0)} from a town`);
  // Asking for a distance the map cannot reach gives fewer camps rather than closer ones, which is
  // the same contract every other upper bound in the generator keeps.
  assert.ok(far.enemySettlements.length <= near.enemySettlements.length);
  for (const camp of far.enemySettlements)
    assert.ok(
      camp.metadata.distanceToSettlement >= 1100,
      'the published distance matches the rule',
    );
  for (const camp of near.enemySettlements) assert.ok(camp.metadata.distanceToSettlement >= 400);
});

function nearest(map, point) {
  return map.settlements.reduce((best, settlement) =>
    between(settlement.position, point) < between(best.position, point) ? settlement : best,
  );
}

test('the default keeps a camp out of a town, and a map with no towns cannot refuse one', () => {
  const withTowns = camps();
  for (const camp of withTowns.enemySettlements)
    assert.ok(
      between(camp.position, nearest(withTowns, camp.position).position) >= 800,
      'the default distance is 800 and nothing may sit closer',
    );
  // A map with no settlements has nothing to be far from, and the distance rule has nothing to say
  // there. Refusing every camp would be a min-distance rule failing on the one map where it cannot
  // apply.
  const alone = generateMap({ ...MAP, settlements: { count: 0 }, enemies: { count: 6 } });
  assert.equal(alone.settlements.length, 0);
  assert.ok(alone.enemySettlements.length > 0, 'a camp may be sited on a map with no town');
  for (const camp of alone.enemySettlements) {
    // The distance is a measurement from the settlements the map publishes, and there are none. The
    // field is absent rather than a distance of infinity, which is not a number a map can carry.
    assert.equal(camp.metadata.distanceToSettlement, undefined);
    assert.equal(validateMap(alone).valid, true);
  }
});

test('a camp is sited on the ground the caller weighted, and only that ground', () => {
  // A ground left out keeps the default weight rather than dropping out, the same as
  // `buildings.categories`, so asking for one ground on its own means zeroing the other two.
  for (const ground of ['wood', 'rock', 'open']) {
    const only = camps({
      enemies: {
        count: 10,
        grounds: {
          wood: ground === 'wood' ? 1 : 0,
          rock: ground === 'rock' ? 1 : 0,
          open: ground === 'open' ? 1 : 0,
        },
      },
    });
    assert.ok(only.enemySettlements.length > 0, `the reference map should have ${ground} to offer`);
    for (const camp of only.enemySettlements)
      assert.equal(
        camp.metadata.ground,
        ground,
        `a ${ground}-only caller got a ${camp.metadata.ground}`,
      );
  }
  // Unweighted, all three are equally likely, so a map that has all three should not hand out one kind
  // every time. This is a draw rate and not a finished share, so it is a smoke test rather than a
  // ratio.
  assert.ok(new Set(camps().enemySettlements.map((camp) => camp.metadata.ground)).size >= 2);
});

test('a camp is never in water, and never overlapping another camp', () => {
  const map = camps();
  for (const camp of map.enemySettlements)
    for (const body of map.water)
      assert.equal(
        pointInPolygon(camp.position, body.geometry),
        false,
        `a camp is in ${body.kind === 'river' ? 'a river' : 'water'}`,
      );
  for (let i = 0; i < map.enemySettlements.length; i += 1)
    for (let j = i + 1; j < map.enemySettlements.length; j += 1) {
      const gap = between(map.enemySettlements[i].position, map.enemySettlements[j].position);
      // Two radii, so their footprints never touch. Overlapping camps are one camp drawn twice.
      assert.ok(gap >= 80, `two camps are ${gap.toFixed(1)} apart and overlap`);
    }
});

test('a camp footprint is out of the water, not merely its centre', () => {
  const map = camps();
  for (const camp of map.enemySettlements) {
    for (const point of camp.geometry.points)
      for (const body of map.water)
        assert.equal(
          pointInPolygon(point, body.geometry),
          false,
          `a camp footprint is in ${body.kind === 'river' ? 'a river' : 'water'}; its centre being dry is not enough`,
        );
  }
  // The whole point of the rule: a centre-only test passed on this map while a third of the camps
  // still had a shore running through their own ground, so the published footprint was not buildable
  // over. Removing the footprint test reproduces those camps at the same positions.
  const centres = camps();
  assert.ok(centres.enemySettlements.length > 0);
  for (const camp of centres.enemySettlements)
    assert.ok(camp.geometry.points.length >= 3, 'a camp publishes the footprint it was tested on');
});

test('a wood camp is in a wood, names that wood, and has a way out of it', () => {
  const map = camps();
  const wood = map.enemySettlements.filter((camp) => camp.metadata.ground === 'wood');
  assert.ok(wood.length > 0, 'the reference map has a wood or two to camp in');
  for (const camp of wood) {
    const forest = map.forests.find((grove) => grove.id === camp.metadata.forestId);
    // A name that resolves is the whole of the check: a consumer clearing the trees for this camp
    // looks the grove up and finds one.
    assert.ok(
      forest,
      `a wood camp names a forest, and ${camp.metadata.forestId} is not on the map`,
    );
    assert.ok(
      pointInPolygon(camp.position, forest.geometry),
      'a wood camp is in the wood it names',
    );
    assert.equal(camp.metadata.rockId, undefined, 'a wood camp is not set against a cliff');
    assert.ok(
      forest.metadata.walkableInside,
      'a camp in a wood nobody can walk inside is a camp nobody can reach',
    );
    // The facing is the way out, and the whole run has to be clear. A wood camp with four units of
    // daylight and then a wall is not a camp a character can leave.
    const blocked = (at) =>
      map.forests.some((grove) => grove.id !== forest.id && pointInPolygon(at, grove.geometry)) ||
      map.water.some((body) => pointInPolygon(at, body.geometry)) ||
      map.structures.some(
        (building) => building.collision && pointInPolygon(at, building.collision),
      );
    assert.ok(
      clearRun(camp.position, camp.rotation, blocked, 16),
      'the facing has the full 16 units of clear run behind it',
    );
  }
});

test('a rock camp is off a cliff, names that cliff, and faces away from it', () => {
  const map = camps();
  const rock = map.enemySettlements.filter((camp) => camp.metadata.ground === 'rock');
  assert.ok(rock.length > 0, 'the reference map has a cliff to camp against');
  for (const camp of rock) {
    const region = map.terrain.find((entry) => entry.id === camp.metadata.rockId);
    assert.ok(region, `a rock camp names a region, and ${camp.metadata.rockId} is not on the map`);
    assert.equal(region.kind, 'rock');
    // A camp is on the ground, never in the cliff: rock blocks, and a camp inside it is a dot on a
    // wall with no way in.
    assert.equal(
      pointInPolygon(camp.position, region.collision),
      false,
      'a camp is not in the rock',
    );
    assert.equal(camp.metadata.forestId, undefined, 'a rock camp is not sited in a wood');
    const blocked = (at) =>
      map.water.some((body) => pointInPolygon(at, body.geometry)) ||
      map.terrain.some(
        (entry) => entry.kind === 'rock' && entry.collision && pointInPolygon(at, entry.collision),
      ) ||
      map.structures.some(
        (building) => building.collision && pointInPolygon(at, building.collision),
      );
    assert.ok(clearRun(camp.position, camp.rotation, blocked, 16), 'the facing is open ground');
  }
});

test('an open camp is open, and has no way out because it is set into nothing', () => {
  const map = camps();
  const open = map.enemySettlements.filter((camp) => camp.metadata.ground === 'open');
  assert.ok(open.length > 0);
  for (const camp of open) {
    // Nothing to face out of, so no facing. An arrow here would point somewhere the generator never
    // measured, which is the same reason a fishing spot carries none.
    assert.equal(camp.rotation, undefined, 'open ground is set into nothing');
    assert.equal(camp.metadata.forestId, undefined);
    assert.equal(camp.metadata.rockId, undefined);
    for (const grove of map.forests)
      assert.equal(
        pointInPolygon(camp.position, grove.geometry),
        false,
        'an open camp is not in a wood',
      );
    for (const tree of map.vegetation)
      assert.ok(
        between(camp.position, tree.position) > tree.radius + 1,
        'no canopy reaches an open camp, so a consumer is not building under branches',
      );
  }
});

test('camps stay off the map edge, so a footprint is never half a footprint', () => {
  const map = camps();
  for (const camp of map.enemySettlements) {
    const inside = camp.geometry.points.every(
      (point) =>
        point.x > 0 && point.y > 0 && point.x < map.bounds.width && point.y < map.bounds.height,
    );
    assert.ok(inside, 'a camp footprint is inside the map, not clipped by it');
  }
});

test('a count is a draw, and a map with too little ground publishes fewer rather than worse', () => {
  const few = camps({ enemies: { count: 3 } });
  const many = camps({ enemies: { count: 40 } });
  assert.equal(few.enemySettlements.length, 3);
  // Rock is 5% of the land, measured, so asking for forty and being refused the ones the map cannot
  // seat is the contract. What must not happen is a camp published somewhere it should not be.
  assert.ok(many.enemySettlements.length <= 40);
  for (const camp of many.enemySettlements)
    assert.ok(
      camp.metadata.distanceToSettlement >= 800,
      'a shortfall is a shortfall, not a rule change',
    );
});

test('the setting is checked, not quietly ignored', () => {
  for (const [config, message] of [
    [{ enemies: { count: 2.5 } }, 'whole number'],
    [{ enemies: { count: -1 } }, 'between 0 and 64'],
    [{ enemies: { count: 65 } }, 'between 0 and 64'],
    [{ enemies: { minDistance: Number.NaN } }, 'finite number'],
    [{ enemies: { minDistance: -1 } }, 'finite number'],
    [{ enemies: { grounds: { swamp: 1 } } }, 'is not ground'],
    [{ enemies: { grounds: { wood: -1 } } }, 'finite number'],
    [{ enemies: { grounds: { wood: 0, rock: 0, open: 0 } } }, 'at least one ground'],
    [{ enemies: { grounds: { wood: 0, rock: 0, open: 0.5 } } }, null],
  ]) {
    const thrown = (() => {
      try {
        generateMap({ ...MAP, ...config });
        return null;
      } catch (error) {
        return error;
      }
    })();
    if (message === null) {
      assert.equal(
        thrown,
        null,
        'a partly zeroed weight table is still a table with a weight in it',
      );
      continue;
    }
    assert.ok(thrown instanceof RangeError, `${JSON.stringify(config)} should throw a RangeError`);
    assert.match(thrown.message, new RegExp(message));
  }
});

test('a camp count does not move anything else on the map', () => {
  const config = { ...MAP, settlements: { count: 4 } };
  const without = generateMap(config);
  const with_ = generateMap({ ...config, enemies: { count: 12 } });
  // The camp stream is keyed apart from every other, so asking for camps cannot move a tree, a road
  // or a building. This is the property the independent streams exist for, and it is the reason a
  // caller can add camps to a map they have already tuned.
  for (const collection of [
    'terrain',
    'water',
    'vegetation',
    'forests',
    'structures',
    'settlements',
    'roads',
    'plots',
    'resourceSites',
  ])
    assert.equal(
      JSON.stringify(without[collection]),
      JSON.stringify(with_[collection]),
      `${collection} moved when only the camp count changed`,
    );
  // Camps are not settlements: nothing in the map may treat one as a place people live, which is why
  // it is a separate collection rather than a flag on `settlements`. A player spawn is offered a
  // settlement and never a camp.
  assert.equal(with_.settlements.length, 4);
  assert.deepEqual(without.enemySettlements, []);
});

test('the same seed gives the same camps, and a tile at an origin seats its own', () => {
  const a = camps();
  const b = camps();
  assert.equal(JSON.stringify(a.enemySettlements), JSON.stringify(b.enemySettlements));
  // A camp is placed on the finished ground, which is sampled in world space, so a tile at an origin
  // gets the camps its own ground offers rather than a copy of the tile at zero.
  const world = { width: 4096, height: 1536 };
  const elsewhere = generateMap({
    ...MAP,
    world,
    origin: { x: 2048, y: 0 },
    settlements: { count: 4 },
    enemies: { count: 12 },
  });
  assert.equal(elsewhere.enemySettlements.length, 12);
  const first = a.enemySettlements[0];
  const moved = elsewhere.enemySettlements[0];
  assert.ok(
    first && moved && first.position.x !== moved.position.x,
    'the second tile is not a copy',
  );
});

test('a published map validates, and a malformed camp is refused', () => {
  const map = camps();
  assert.equal(validateMap(map).valid, true, 'generated camps must pass their own validator');
  for (const [mutate, message] of [
    [(m) => delete m.enemySettlements, /enemySettlements/],
    [
      (m) =>
        (m.enemySettlements.find((c) => c.metadata.ground === 'wood').metadata.forestId =
          'nowhere'),
      /must name a forest/,
    ],
    [
      (m) =>
        (m.enemySettlements.find((c) => c.metadata.ground === 'rock').metadata.rockId = 'nowhere'),
      /must name a rock region/,
    ],
    [
      (m) =>
        (m.enemySettlements.find((c) => c.metadata.ground === 'rock').metadata.forestId =
          'somewhere'),
      /must not name a forest/,
    ],
    [
      (m) =>
        (m.enemySettlements.find((c) => c.metadata.ground === 'open').metadata.rockId = 'nowhere'),
      /must name nothing/,
    ],
    [(m) => delete m.enemySettlements[0].metadata.distanceToSettlement, /distanceToSettlement/],
    [(m) => (m.enemySettlements[0].metadata.ground = 'swamp'), /must be a camp with a ground/],
    [
      (m) => {
        const wood = m.enemySettlements.find((c) => c.metadata.ground === 'wood');
        delete wood.rotation;
      },
      /must face out/,
    ],
    [
      (m) => {
        const open = m.enemySettlements.find((c) => c.metadata.ground === 'open');
        open.rotation = 1;
      },
      /must publish no facing/,
    ],
  ]) {
    const broken = JSON.parse(JSON.stringify(map));
    mutate(broken);
    const result = validateMap(broken);
    assert.equal(result.valid, false, `expected a refusal for ${mutate.toString().slice(0, 40)}`);
    assert.match(result.errors.map(String).join('\n'), message);
  }
});
