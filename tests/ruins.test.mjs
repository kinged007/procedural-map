import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, rasterizeWalkability, validateMap } from '../dist/index.js';

const MAP = { seed: 583921, width: 2048, height: 1536 };
const withRuins = (ruin, extra = {}) => generateMap({ ...MAP, buildings: { ruin }, ...extra });

test('a building says whether it is standing or fallen, and the map is valid either way', () => {
  for (const ruin of [0, 0.25, 0.5, 1]) {
    const map = withRuins(ruin);
    for (const building of map.structures)
      assert.ok(
        building.state === 'standing' || building.state === 'ruined',
        'every building states which it is',
      );
    const result = validateMap(map);
    assert.equal(result.valid, true, `a map at ruin ${ruin} validates`);
  }
});

test('collision follows the state, and a ruin cannot be walled in', () => {
  for (const ruin of [0, 0.3, 0.7, 1]) {
    for (const building of withRuins(ruin).structures) {
      if (building.state === 'standing')
        assert.ok(building.collision, 'a standing building is a wall');
      else assert.equal(building.collision, undefined, 'rubble is not a wall');
    }
  }
});

test('the ruin share is a share, from none to all', () => {
  const shares = [0, 0.25, 0.5, 0.75, 1];
  const counts = shares.map((ruin) => {
    const map = withRuins(ruin);
    return map.structures.filter((b) => b.state === 'ruined').length;
  });
  assert.equal(counts[0], 0, 'nothing is a ruin at 0');
  assert.equal(counts[counts.length - 1], withRuins(1).structures.length, 'all at 1');
  // Monotone in the share: more ruin asked for is never fewer ruins produced.
  for (let index = 1; index < counts.length; index += 1)
    assert.ok(counts[index] >= counts[index - 1], 'the share is monotone');
});

test('a ruin share does not move where anything is', () => {
  // The share is drawn after a building is placed, so asking for a ruined map must not move the
  // sites, renumber the buildings, or thin the wood. A caller setting this to 1 is asking what the
  // map would look like abandoned, not a different map.
  const standing = withRuins(0);
  const ruined = withRuins(1);
  assert.equal(standing.structures.length, ruined.structures.length, 'the same buildings');
  assert.deepEqual(
    standing.structures.map((b) => b.id),
    ruined.structures.map((b) => b.id),
    'the same ids, in the same order',
  );
  for (const [index, building] of standing.structures.entries())
    assert.deepEqual(building.position, ruined.structures[index].position, 'the same sites');
  assert.deepEqual(standing.vegetation, ruined.vegetation, 'the same wood');
  assert.deepEqual(standing.roads, ruined.roads, 'the same roads');
});

test('a ruin opens the ground it stood on', () => {
  const cellSize = 8;
  const standing = rasterizeWalkability(withRuins(0), { cellSize });
  const ruined = rasterizeWalkability(withRuins(1), { cellSize });
  const open = (raster, point) => {
    const column = Math.floor(point.x / cellSize);
    const row = Math.floor(point.y / cellSize);
    return raster.cells[row * raster.columns + column] === 0;
  };
  let opened = 0;
  let ruins = 0;
  for (const building of withRuins(1).structures) {
    ruins += 1;
    if (!open(standing, building.position) && open(ruined, building.position)) opened += 1;
  }
  assert.ok(ruins > 0, 'the map has ruins to check');
  assert.equal(opened, ruins, 'every ruin reads as walkable ground it did not before');
});

test('a ruin does not make a settlement bigger', () => {
  // Twelve shells is not a town, so `kind` counts standing buildings. Membership is unchanged:
  // ruins are part of the place, just not part of its size.
  for (const seed of [583921, 42, 99, 1234, 20250816]) {
    const alive = generateMap({ ...MAP, seed, settlements: { count: 6 } });
    const dead = generateMap({
      ...MAP,
      seed,
      settlements: { count: 6 },
      buildings: { ruin: 1 },
    });
    for (const settlement of alive.settlements) {
      const other = dead.settlements.find((s) => s.id === settlement.id);
      assert.equal(
        other.metadata.buildingIds.length,
        settlement.metadata.buildingIds.length,
        'membership does not change with the share',
      );
      assert.equal(other.kind, 'hamlet', 'a settlement of ruins is the smallest kind');
      const standing = settlement.metadata.buildingIds.filter((id) => {
        const building = alive.structures.find((b) => b.id === id);
        return building.state === 'standing';
      }).length;
      const expected = standing < 4 ? 'hamlet' : standing < 9 ? 'village' : 'town';
      assert.equal(settlement.kind, expected, 'a kind counts only what stands');
    }
  }
});

test('the ruin share is rejected outside a share', () => {
  assert.throws(() => withRuins(1.5), RangeError);
  assert.throws(() => withRuins(-0.1), RangeError);
  assert.throws(() => withRuins(Number.NaN), RangeError);
});

test('a building without a state is rejected, and so is a ruin carrying a collision', () => {
  const map = withRuins(0.5);
  const stateLess = structuredClone(map);
  delete stateLess.structures[0].state;
  assert.equal(validateMap(stateLess).valid, false, 'a building must say which it is');

  const walled = structuredClone(map);
  const ruin = walled.structures.find((b) => b.state === 'ruined');
  assert.ok(ruin, 'the map has a ruin to wall in, or this test proves nothing');
  ruin.collision = { type: 'polygon', points: ruin.geometry.points };
  assert.equal(validateMap(walled).valid, false, 'a ruin cannot be walled in');
});

test('ruins survive export and import unchanged', () => {
  const map = withRuins(0.5);
  const round = structuredClone(JSON.parse(JSON.stringify(map)));
  assert.equal(validateMap(round).valid, true);
  assert.deepEqual(round.structures, map.structures, 'a ruin is still a ruin on the way back');
  assert.equal(
    round.structures.filter((b) => b.state === 'ruined').length,
    map.structures.filter((b) => b.state === 'ruined').length,
  );
});
