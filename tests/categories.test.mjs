import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, validateMap } from '../dist/index.js';

const MAP = { seed: 583921, width: 2048, height: 1536 };
const withWeights = (categories, extra = {}) =>
  generateMap({ ...MAP, buildings: { categories, ...extra } });
const share = (map) => {
  const farms = map.structures.filter((b) => b.category === 'farm').length;
  return { farms, total: map.structures.length };
};

test('the weights decide the mix, and the default is one site in nine', () => {
  // A farm is four times the ground of a house and stands 48 back, so a farm drawn at a site is
  // refused more often than a house is. The weight governs the draw and the finished map carries
  // fewer farms than the draw asks for, which is why these are compared against each other.
  const mix = [undefined, { house: 2, farm: 1 }, { house: 1, farm: 1 }, { house: 1, farm: 4 }].map(
    (categories) => {
      const map = categories ? withWeights(categories) : generateMap(MAP);
      return { categories, ...share(map) };
    },
  );
  for (let index = 1; index < mix.length; index += 1) {
    const shareOf = (entry) => entry.farms / entry.total;
    assert.ok(
      shareOf(mix[index]) > shareOf(mix[index - 1]),
      `a heavier farm weight gives more farms (${JSON.stringify(mix[index].categories)})`,
    );
  }
});

test('a category at zero is never placed, and one left out keeps the default', () => {
  const housesOnly = withWeights({ house: 1, farm: 0 });
  assert.equal(
    housesOnly.structures.every((b) => b.category === 'house'),
    true,
    'a weight of zero is a category that is not placed',
  );
  // Leaving a category out is not the same as zeroing it: a caller reweighting one category should
  // not silently remove the other.
  const reweighted = withWeights({ house: 2 });
  assert.equal(
    reweighted.metadataLayers.generation.buildings.categories.farm,
    1,
    'an omitted category keeps the default weight',
  );
  assert.ok(
    reweighted.structures.some((b) => b.category === 'farm'),
    'and is still placed',
  );
});

test('the weights are relative, so scaling them changes nothing', () => {
  assert.deepEqual(
    withWeights({ house: 2, farm: 1 }).structures,
    withWeights({ house: 200, farm: 100 }).structures,
    'the same ratio is the same map',
  );
});

test('reweighting moves the buildings and nothing else', () => {
  // A farm covers more ground and stands further back, so a farm-heavy map legitimately refuses
  // neighbours and comes out shorter. What must not move is everything the category does not touch:
  // the roads the buildings stand against, the wood, the water, and the places. If any of those
  // changed, a weight would be reaching further into the map than it should.
  const houses = withWeights({ house: 1, farm: 0 });
  const farms = withWeights({ house: 1, farm: 9 });
  for (const collection of ['roads', 'vegetation', 'water', 'terrain'])
    assert.deepEqual(
      farms[collection],
      houses[collection],
      `${collection} is not touched by a building category`,
    );
  // Settlements are the exception, and deliberately: a settlement is defined by the buildings it
  // holds, so reweighting the mix changes what a place holds and therefore what it is. That is the
  // membership rule working, not a category reaching into the roads.
  assert.notDeepEqual(
    farms.settlements.map((s) => s.metadata.buildingIds.length),
    houses.settlements.map((s) => s.metadata.buildingIds.length),
    'what a place holds is a function of what was built in it',
  );
  assert.deepEqual(
    farms.settlements.map((s) => s.position),
    houses.settlements.map((s) => s.position),
    'while where the places are is not',
  );
  assert.ok(
    farms.structures.length < houses.structures.length,
    'a wider building refuses neighbours, so the farm-heavy map is the shorter one',
  );
  // And the buildings are genuinely different things: a farm is bigger and stands further back, so
  // the weight is changing a placement and not only a label.
  const farm = farms.structures.find((b) => b.category === 'farm');
  assert.ok(farm.width > 15 && farm.depth > 11, 'a farm covers more ground than a house');
  assert.ok(
    farm.metadata.setback >= 48,
    'and stands further back, which is what refuses the neighbours',
  );
});

test('a weight on a building the generator cannot place is rejected', () => {
  // A weight that cannot be honoured is a setting that appears to do something and does not, and a
  // misspelt `house` is better served by a throw than by a map of farms.
  assert.throws(() => withWeights({ barn: 1 }), /not a building the generator can place/);
  assert.throws(() => withWeights({ house: -1 }), RangeError);
  assert.throws(() => withWeights({ house: 0, farm: 0 }), /at least one category/);
  assert.throws(() => withWeights({ house: Number.NaN }), RangeError);
});

test('every category mix publishes a valid map', () => {
  for (const categories of [
    { house: 1, farm: 0 },
    { house: 0, farm: 1 },
    { house: 1, farm: 9 },
  ]) {
    const map = withWeights(categories);
    const result = validateMap(map);
    assert.equal(result.valid, true, `${JSON.stringify(categories)} validates`);
    // Whatever the mix, a building still stands on land, still faces a road, and still keeps its
    // published size: the weights choose a category, they do not invent one.
    for (const building of map.structures) {
      assert.ok(
        ['house', 'farm'].includes(building.category),
        'only a known category is published',
      );
      assert.equal(building.geometry.points.length, 4, 'a footprint is still a rectangle');
      if (building.state === 'standing')
        assert.ok(building.collision, 'and a wall is still a wall');
    }
  }
});

test('the resolved weights survive export and import', () => {
  const map = withWeights({ house: 3, farm: 1 });
  const round = structuredClone(JSON.parse(JSON.stringify(map)));
  assert.equal(validateMap(round).valid, true);
  assert.deepEqual(
    round.metadataLayers.generation.buildings.categories,
    { house: 3, farm: 1 },
    'what was asked for is what the map records',
  );
});
