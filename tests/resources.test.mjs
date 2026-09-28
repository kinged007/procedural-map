import assert from 'node:assert/strict';
import test from 'node:test';
import { exportMap, generateMap, importMap, validateMap } from '../dist/index.js';
import { pointInPolygon } from '../dist/map/geometry.js';

const SEEDS = [583921, 42, 777, 7, 1, 99999, 31415, 271828];
/** Every kind at its ceiling, which is where the invariants are under the most pressure. */
const PLENTY = { mine: 64, fishing: 64, hunting: 64 };
const of = (map, kind) => map.resourceSites.filter((site) => site.kind === kind);
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('a site is published as a typed entity, and the map is valid with one', () => {
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 2048, height: 1536, resources: PLENTY });
    const result = validateMap(map);
    assert.ok(result.valid, `seed ${seed}: ${result.errors.slice(0, 2).join('; ')}`);
    for (const site of map.resourceSites) {
      assert.equal(site.type, 'resource-site');
      assert.ok(['mine', 'fishing', 'hunting'].includes(site.kind));
      assert.equal(
        site.collision,
        undefined,
        `${site.id} is a mark on the ground, not an obstacle`,
      );
      assert.ok(site.asset, `${site.id} names an asset for the game to draw`);
    }
  }
});

test('a default map says nothing about where anything is gathered', () => {
  // The generator has no geology, so the honest default is silence. A map that arrived with sites
  // already on it would be a generator that had decided what the ground holds.
  const map = generateMap({ seed: 583921, width: 2048, height: 1536 });
  assert.equal(map.resourceSites.length, 0);
  assert.deepEqual(map.metadataLayers.generation.resources, {
    mine: 0,
    fishing: 0,
    hunting: 0,
  });
});

test('each count is honoured on its own, and a count is a ceiling rather than a promise', () => {
  // One kind at a time, so a change to one is not a change to the others.
  for (const kind of ['mine', 'fishing', 'hunting']) {
    const zero = generateMap({ seed: 583921, width: 2048, height: 1536, resources: { [kind]: 0 } });
    assert.equal(zero.resourceSites.length, 0, `${kind}: asked for none, published ${kind} sites`);

    const some = generateMap({ seed: 583921, width: 2048, height: 1536, resources: { [kind]: 3 } });
    assert.ok(
      of(some, kind).length > 0 && of(some, kind).length <= 3,
      `${kind}: asked for 3, published ${of(some, kind).length}`,
    );
    // Asking for one kind must not publish another, or the counts are not separate knobs.
    for (const other of ['mine', 'fishing', 'hunting'])
      if (other !== kind)
        assert.equal(of(some, other).length, 0, `${kind}: also published ${other} sites`);
  }
  // A count above what the ground will hold publishes everything there is rather than inventing any.
  const many = generateMap({
    seed: 583921,
    width: 2048,
    height: 1536,
    resources: { hunting: 64 },
  });
  const woods = generateMap({ seed: 583921, width: 2048, height: 1536 }).forests.filter(
    (forest) => forest.metadata.treeCount >= 20 && forest.metadata.walkableInside,
  );
  assert.equal(of(many, 'hunting').length, woods.length);
});

test('a mine is cut into a rock face, and its arrow points out of the rock', () => {
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 2048, height: 1536, resources: PLENTY });
    for (const site of of(map, 'mine')) {
      const rock = map.terrain.find((region) => region.id === site.metadata.rockId);
      assert.ok(rock, `${site.id} names rock ${site.metadata.rockId}, which is not on the map`);
      assert.equal(rock.kind, 'rock');
      // Inside the rock, not on the line of it: a marker on the boundary is ambiguous to the
      // point-in-polygon test a consumer runs on a raster it chose itself.
      assert.ok(
        pointInPolygon(site.position, rock.geometry),
        `${site.id} is not inside the rock it is cut into`,
      );
      // The overlap, and the arrow leaving it. Stepping 16 out along the facing must be clear of the
      // rock, or the entrance points into a cliff.
      assert.ok(Number.isFinite(site.rotation), `${site.id} has no entrance direction`);
      const ahead = {
        x: site.position.x + Math.cos(site.rotation) * 16,
        y: site.position.y + Math.sin(site.rotation) * 16,
      };
      assert.ok(
        !pointInPolygon(ahead, rock.geometry),
        `${site.id} faces into its own rock instead of out of it`,
      );
    }
  }
});

test('a fishing spot is in the water, and says whether it is reached from land or from a boat', () => {
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 2048, height: 1536, resources: PLENTY });
    for (const site of of(map, 'fishing')) {
      const body = map.water.find((water) => water.id === site.metadata.waterId);
      assert.ok(body, `${site.id} names water ${site.metadata.waterId}, which is not on the map`);
      assert.ok(
        pointInPolygon(site.position, body.geometry),
        `${site.id} is not in the water it names`,
      );
      // The number and the verdict have to agree, because a consumer is entitled to read either one.
      const { distanceToShore, access } = site.metadata;
      assert.ok(distanceToShore >= 0, `${site.id} has no measured gap to the bank`);
      assert.equal(
        access,
        distanceToShore <= 32 ? 'land' : 'water',
        `${site.id} reports ${access} at ${distanceToShore.toFixed(1)} units`,
      );
    }
  }
});

test('a fishing spot far enough out to need a boat actually exists, and one near a bank does too', () => {
  // Both halves of the rule are worth holding, because a floor on the body size that is too generous
  // would leave a map with no water-accessed spot at all, and the access field would be a constant.
  let land = 0;
  let water = 0;
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 2048, height: 1536, resources: { fishing: 40 } });
    for (const site of of(map, 'fishing'))
      if (site.metadata.access === 'land') land += 1;
      else water += 1;
  }
  assert.ok(land > 0, 'no fishing spot can be walked to');
  assert.ok(water > 0, 'no fishing spot needs a boat, so `access` says only one thing');
});

test('a hunting site stands in a wood big enough to hold game, and enterable', () => {
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 2048, height: 1536, resources: PLENTY });
    for (const site of of(map, 'hunting')) {
      const forest = map.forests.find((grove) => grove.id === site.metadata.forestId);
      assert.ok(
        forest,
        `${site.id} names forest ${site.metadata.forestId}, which is not on the map`,
      );
      // A copse is not a wood, and a thicket a character cannot get out of is not somewhere to hunt.
      assert.ok(
        forest.metadata.treeCount >= 20,
        `${site.id} is in a grove of ${forest.metadata.treeCount}`,
      );
      assert.ok(forest.metadata.walkableInside, `${site.id} is in a wood with no way into it`);
      assert.ok(
        pointInPolygon(site.position, forest.geometry),
        `${site.id} is not inside the hull it names`,
      );
    }
  }
});

test('two sites of one kind keep their distance apart', () => {
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 2048, height: 1536, resources: PLENTY });
    for (const kind of ['mine', 'fishing', 'hunting']) {
      const sites = of(map, kind);
      for (let a = 0; a < sites.length; a += 1)
        for (let b = a + 1; b < sites.length; b += 1)
          assert.ok(
            gap(sites[a].position, sites[b].position) >= 24,
            `seed ${seed}: two ${kind} sites at ${gap(sites[a].position, sites[b].position).toFixed(1)}`,
          );
    }
  }
});

test('the counts are independent, so one does not reshuffle another', () => {
  // The same reason buildings and ruins draw from separate streams: a caller tuning the mine count
  // should get the fishing spots they asked for, not a different set because a number moved.
  const base = generateMap({
    seed: 583921,
    width: 2048,
    height: 1536,
    resources: { mine: 4, fishing: 4, hunting: 4 },
  });
  const moreMines = generateMap({
    seed: 583921,
    width: 2048,
    height: 1536,
    resources: { mine: 40, fishing: 4, hunting: 4 },
  });
  const positions = (map, kind) =>
    of(map, kind)
      .map((site) => `${site.position.x},${site.position.y}`)
      .join(';');
  for (const kind of ['fishing', 'hunting'])
    assert.equal(
      positions(moreMines, kind),
      positions(base, kind),
      `asking for more mines moved the ${kind} sites`,
    );
  // The first few mines are the same ones, too: a bigger ask takes more of the same offer rather
  // than a different draw of it.
  assert.equal(
    positions(moreMines, 'mine').split(';').slice(0, 4).join(';'),
    positions(base, 'mine'),
  );
});

test('a site is not the gate to everything else on the map', () => {
  // Sites are published after everything else and read it, so the risk is that placing them moves
  // something. Nothing else on the map may move.
  const plain = generateMap({ seed: 583921, width: 2048, height: 1536 });
  const loaded = generateMap({
    seed: 583921,
    width: 2048,
    height: 1536,
    resources: PLENTY,
  });
  assert.deepEqual(loaded.terrain, plain.terrain);
  assert.deepEqual(loaded.water, plain.water);
  assert.deepEqual(loaded.vegetation, plain.vegetation);
  assert.deepEqual(loaded.structures, plain.structures);
  assert.deepEqual(loaded.settlements, plain.settlements);
  assert.deepEqual(loaded.docks, plain.docks);
  assert.deepEqual(loaded.forests, plain.forests);
  assert.ok(loaded.resourceSites.length > 0, 'nothing to compare, the map published no sites');
});

test('a site naming ground that is not on the map is rejected', () => {
  const map = generateMap({
    seed: 583921,
    width: 2048,
    height: 1536,
    resources: { mine: 1, fishing: 1, hunting: 1 },
  });
  assert.ok(map.resourceSites.length >= 3, 'need a site of each kind to corrupt');
  for (const [kind, field] of [
    ['mine', 'rockId'],
    ['fishing', 'waterId'],
    ['hunting', 'forestId'],
  ]) {
    const broken = structuredClone(map);
    const index = broken.resourceSites.findIndex((entry) => entry.kind === kind);
    broken.resourceSites[index].metadata[field] = 'not-on-this-map';
    const result = validateMap(broken);
    assert.ok(!result.valid, `a ${kind} naming a missing ${field} was accepted`);
    // The error has to name the field, not merely fail: a validation pass that says a map is bad
    // without saying which site is bad is not much help to a consumer holding a thousand of them.
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes(`resourceSites[${index}].metadata.${field}`) &&
          error.includes(
            field === 'rockId' ? 'terrain' : field === 'waterId' ? 'water' : 'forests',
          ),
      ),
      result.errors.join('; '),
    );
  }
});

test('a site is refused the things that would make it a different thing', () => {
  const base = generateMap({
    seed: 583921,
    width: 2048,
    height: 1536,
    resources: { mine: 1, fishing: 1, hunting: 1 },
  });
  const firstOf = (kind) => base.resourceSites.findIndex((site) => site.kind === kind);

  // A collision: the site is a mark on the ground, not a thing in it.
  const walled = structuredClone(base);
  walled.resourceSites[firstOf('mine')].collision = {
    type: 'circle',
    center: { x: 10, y: 10 },
    radius: 4,
  };
  assert.ok(!validateMap(walled).valid, 'a site carrying a collision was accepted');

  // A mine with no facing is a dot on a cliff with no way in.
  const blind = structuredClone(base);
  delete blind.resourceSites[firstOf('mine')].rotation;
  assert.ok(!validateMap(blind).valid, 'a mine with no entrance direction was accepted');

  // The other two kinds have no facing to publish, and an arrow on a fishing spot in open water
  // points at nothing.
  for (const kind of ['fishing', 'hunting']) {
    const facing = structuredClone(base);
    facing.resourceSites[firstOf(kind)].rotation = 1;
    assert.ok(!validateMap(facing).valid, `a ${kind} site with a facing was accepted`);
  }

  // A fishing spot without the number is a spot whose access cannot be checked.
  const mute = structuredClone(base);
  delete mute.resourceSites[firstOf('fishing')].metadata.distanceToShore;
  assert.ok(!validateMap(mute).valid, 'a fishing spot with no distance to the bank was accepted');

  const mismatched = structuredClone(base);
  mismatched.resourceSites[firstOf('fishing')].metadata.access = 'teleport';
  assert.ok(!validateMap(mismatched).valid, 'an unknown access mode was accepted');
});

test('a count outside its range is rejected', () => {
  for (const value of [-1, 65, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        generateMap({
          seed: 1,
          width: 512,
          height: 512,
          resources: { mine: value, fishing: 0, hunting: 0 },
        }),
      `resources.mine of ${value} was accepted`,
    );
  }
});

test('a fractional count is rejected wherever there is a count', () => {
  // `2.5` is not a number of settlements, and the loops read it as `length >= count`, so a float was
  // silently rounded up and the caller got a number they had not asked for with nothing said. This
  // covers the two counts that could do it before this change as well as the three new ones, because
  // a count validated in one place and not another is worse than either.
  for (const [config, count] of [
    [{ settlements: { count: 2.5 } }, 2.5],
    [{ docks: { count: 2.5 } }, 2.5],
    [{ resources: { mine: 2.5 } }, 2.5],
    [{ resources: { fishing: 2.5 } }, 2.5],
    [{ resources: { hunting: 2.5 } }, 2.5],
  ])
    assert.throws(
      () => generateMap({ seed: 1, width: 512, height: 512, ...config }),
      new RegExp(`must be a whole number, not ${String(count).replace('.', '\\.')}`),
      `${JSON.stringify(config)} was accepted`,
    );
  // A count that is a whole number is still fine, including zero and the ceiling.
  for (const count of [0, 1, 64])
    assert.doesNotThrow(() =>
      generateMap({ seed: 1, width: 512, height: 512, resources: { mine: count } }),
    );
});

test('the same seed gives the same sites, and they survive a round trip', () => {
  const config = { seed: 4242, width: 2048, height: 1536, resources: PLENTY };
  const first = generateMap(config);
  const second = generateMap(config);
  assert.deepEqual(first.resourceSites, second.resourceSites);
  assert.ok(first.resourceSites.length > 0, 'nothing to round trip');

  const returned = importMap(exportMap(first));
  assert.ok(validateMap(returned).valid, JSON.stringify(validateMap(returned).errors.slice(0, 2)));
  assert.deepEqual(returned.resourceSites, first.resourceSites);
});
