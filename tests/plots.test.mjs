import assert from 'node:assert/strict';
import test from 'node:test';
import { exportMap, generateMap, importMap, validateMap } from '../dist/index.js';
import { pointInPolygon } from '../dist/map/geometry.js';

const SEEDS = [583921, 42, 777, 7, 1, 99999, 31415, 271828];
/** Both kinds at a count a map can actually honour, which is where the rules are under pressure. */
const PLENTY = { field: 12, orchard: 8 };
const of = (map, kind) => map.plots.filter((plot) => plot.kind === kind);
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * One map per config, for the whole file.
 *
 * The library's first promise is that the same config gives the same map, so a test that asks for a
 * map some earlier test already built is asking for the same bytes and can have them. Generating the
 * eight `PLENTY` maps once per test instead of once per file is roughly fifty extra 2048x1536 maps,
 * and the runner executes this file alongside every other one on a machine that is already loaded —
 * enough extra pressure to push the timing gates in `worstcase.test.mjs` over for reasons that have
 * nothing to do with plots. Nothing here writes to a map, so sharing one is safe.
 */
const built = new Map();
function mapFor(config) {
  const key = JSON.stringify(config);
  let map = built.get(key);
  if (!map) {
    map = generateMap({ width: 2048, height: 1536, ...config });
    built.set(key, map);
  }
  return map;
}

/** The four corners a plot's `rotation`, `width` and `depth` say it has, worked out from scratch. */
function corners(plot) {
  const along = { x: Math.cos(plot.rotation), y: Math.sin(plot.rotation) };
  const across = { x: -along.y, y: along.x };
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([d, w]) => ({
    x: plot.position.x + along.x * d * (plot.depth / 2) + across.x * w * (plot.width / 2),
    y: plot.position.y + along.y * d * (plot.depth / 2) + across.y * w * (plot.width / 2),
  }));
}

test('a plot is published as a typed entity, and the map is valid with one', () => {
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    const result = validateMap(map);
    assert.ok(result.valid, `seed ${seed}: ${result.errors.slice(0, 2).join('; ')}`);
    assert.ok(map.plots.length > 0, `seed ${seed} published no plots at all`);
    for (const plot of map.plots) {
      assert.equal(plot.type, 'ground-plot');
      assert.ok(['field', 'orchard'].includes(plot.kind));
      assert.equal(
        plot.collision,
        undefined,
        `${plot.id} is ground a character walks over, not an obstacle`,
      );
      assert.ok(plot.asset, `${plot.id} names an asset for the game to draw`);
    }
  }
});

test('a default map has no worked ground, because a field is a square of dirt until a game decides', () => {
  // The generator does not know what a crop is. A default map that arrived with a ploughed square on
  // it would be claiming a harvest it has no way to justify, which is the same line the resource
  // sites hold: say where the ground is worth something, and let the game say what.
  for (const seed of [583921, 42, 777]) {
    const map = mapFor({ seed });
    assert.deepEqual(map.plots, [], `seed ${seed} worked ground nobody asked for`);
    assert.ok(validateMap(map).valid);
  }
});

test('each count is honoured on its own, and a count is a ceiling rather than a promise', () => {
  for (const seed of SEEDS) {
    const fields = mapFor({ seed, plots: { field: 12 } });
    const orchards = mapFor({ seed, plots: { orchard: 8 } });
    const both = mapFor({ seed, plots: PLENTY });

    // Asking for one kind publishes only that kind: the other is not quietly filled in.
    assert.ok(fields.plots.length > 0, `seed ${seed} published no fields`);
    assert.deepEqual(of(fields, 'orchard'), [], `seed ${seed} grew an orchard nobody asked for`);
    assert.ok(of(orchards, 'orchard').length > 0, `seed ${seed} published no orchards`);

    // Twelve and eight are a ceiling, not a promise: the ring around a settlement runs out of ground
    // before the count does, and that is the same bargain every other count in the library makes.
    // An orchard asked for on its own may still come back as a field, because a plot whose rows the
    // river has eaten through is published bare rather than dropped — see the degrade test below —
    // so what this checks is the ceiling, not the mix.
    assert.ok(fields.plots.length <= 12, `seed ${seed} published ${fields.plots.length} fields`);
    assert.ok(orchards.plots.length <= 8, `seed ${seed} published ${orchards.plots.length}`);
    assert.ok(both.plots.length <= 20, `seed ${seed} published ${both.plots.length} plots`);
    assert.ok(both.plots.length > 0, `seed ${seed} published no plots when asked for twenty`);
  }
});

test('a plot is the rectangle its own four numbers describe', () => {
  // The consumer is handed `position`, `rotation`, `width`, `depth` and a polygon, and those have to
  // agree. A plot whose published geometry does not match its published size is a consumer picking a
  // crop pattern that does not land inside the field it was drawn on.
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    for (const plot of map.plots) {
      assert.ok(Number.isFinite(plot.rotation), `${plot.id} has no heading`);
      assert.ok(plot.width > 0 && plot.depth > 0, `${plot.id} has no size`);
      const want = corners(plot);
      want.forEach((point, index) => {
        const got = plot.geometry.points[index];
        assert.ok(got, `${plot.id} has ${plot.geometry.points.length} corners, not four`);
        assert.ok(
          gap(point, got) < 1e-9,
          `${plot.id} corner ${index} is ${gap(point, got).toFixed(3)} from where its numbers say`,
        );
      });
      // And the centre really is inside its own rectangle.
      assert.ok(pointInPolygon(plot.position, plot.geometry), `${plot.id} is not inside itself`);
    }
  }
});

test('a plot belongs to a settlement, stays on the map, and is not ploughed into a lake', () => {
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    const rocks = map.terrain.filter((region) => region.kind === 'rock');
    const beaches = map.terrain.filter((region) => region.kind === 'beach');
    for (const plot of map.plots) {
      assert.ok(
        map.settlements.some((place) => place.id === plot.metadata.settlementId),
        `${plot.id} names ${plot.metadata.settlementId}, which is not on the map`,
      );
      for (const point of [plot.position, ...plot.geometry.points])
        assert.ok(
          point.x >= 0 &&
            point.y >= 0 &&
            point.x <= map.bounds.width &&
            point.y <= map.bounds.height,
          `${plot.id} leaves the world at ${point.x.toFixed(1)},${point.y.toFixed(1)}`,
        );
      // A field is worked ground, so it is not cut into the lake or into the cliff. Its centre is
      // tested rather than its whole rectangle, because a field whose corner abuts the bank is a
      // field by a river, which is the normal case and not a reason to throw the plot away.
      assert.ok(
        !map.water.some((body) => pointInPolygon(plot.position, body.geometry)),
        `${plot.id} is worked in the water`,
      );
      assert.ok(
        !rocks.some((rock) => pointInPolygon(plot.position, rock.geometry)),
        `${plot.id} is cut into a rock`,
      );
      assert.ok(
        !beaches.some((beach) => pointInPolygon(plot.position, beach.geometry)),
        `${plot.id} is ploughed through the sand`,
      );
    }
  }
});

test('two plots never overlap, and no building is built in one', () => {
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    for (let i = 0; i < map.plots.length; i += 1)
      for (let j = i + 1; j < map.plots.length; j += 1)
        assert.ok(
          !map.plots[i].geometry.points.some((point) =>
            pointInPolygon(point, map.plots[j].geometry),
          ),
          `${map.plots[i].id} and ${map.plots[j].id} overlap`,
        );
    // A house in the middle of a wheat field is a house in the middle of a wheat field. A farm is the
    // one exception, and it is the exception for the only reason that makes sense: a farm works the
    // field it stands in, so the test below is for houses and this one is for everything else.
    for (const building of map.structures)
      for (const plot of map.plots)
        assert.ok(
          building.category === 'farm' || !pointInPolygon(building.position, plot.geometry),
          `${building.id} stands in ${plot.id}`,
        );
  }
});

test('a field is worked ground, so nothing wild is standing in it', () => {
  // The field's own rectangle reaches the tree placer as a keep-out, which is the one test here that
  // has to be exact rather than sampled: a tree is published in `vegetation`, drawn, and blocks a
  // raster cell, and a tree in a wheat field is wrong in all three ways at once.
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    for (const field of of(map, 'field')) {
      assert.deepEqual(field.metadata.treeIds, [], `${field.id} is a field, so it stands nothing`);
      for (const tree of map.vegetation)
        assert.ok(
          tree.species === 'orchard' || !pointInPolygon(tree.position, field.geometry),
          `${tree.id} is rooted in ${field.id}`,
        );
    }
  }
});

test('an orchard is its rows, and the rows are real trees that stand in the orchard', () => {
  // An orchard published as a rectangle and a count would leave the consumer adding its own collision,
  // which is the one thing the generator owns. So the trees are published in `vegetation`, they are
  // named in `treeIds`, and each one is inside the rectangle the plot claims.
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    const orchards = of(map, 'orchard');
    assert.ok(orchards.length > 0, `seed ${seed} published no orchards`);
    for (const orchard of orchards) {
      const ids = orchard.metadata.treeIds;
      assert.ok(ids.length > 0, `${orchard.id} is an orchard with no rows`);
      for (const id of ids) {
        const tree = map.vegetation.find((candidate) => candidate.id === id);
        assert.ok(tree, `${orchard.id} names ${id}, which is not a tree on the map`);
        assert.ok(
          pointInPolygon(tree.position, orchard.geometry),
          `${id} is outside ${orchard.id}, which claims to stand it`,
        );
        // A tree is a tree: it has a trunk, and that trunk is what blocks.
        assert.ok(
          tree.collision?.type === 'circle' && tree.collision.radius > 0,
          `${id} has no trunk`,
        );
      }
    }
    // Ids are unique across the whole map, not within one orchard: two orchards on one map must not
    // both publish an `orchard-tree-1`.
    const all = map.plots.flatMap((plot) => plot.metadata.treeIds);
    assert.equal(new Set(all).size, all.length, 'two orchards published the same tree id');
  }
});

test('an orchard names rows in a line, not a scatter', () => {
  // The one thing that makes an orchard read as an orchard rather than as scrub on a field is that
  // its trees are in rows. Projecting every tree onto the plot's own heading says whether the grid
  // survived: the projections land in a few tight bands rather than smearing along the axis.
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    for (const orchard of of(map, 'orchard')) {
      const trees = orchard.metadata.treeIds
        .map((id) => map.vegetation.find((tree) => tree.id === id))
        .map((tree) => tree.position);
      const along = { x: Math.cos(orchard.rotation), y: Math.sin(orchard.rotation) };
      const projections = trees.map(
        (tree) => (tree.x - orchard.position.x) * along.x + (tree.y - orchard.position.y) * along.y,
      );
      // The grid spans the plot, so nothing stands past its own ends, bar the jitter.
      for (const value of projections)
        assert.ok(
          Math.abs(value) <= orchard.depth / 2 + 3,
          `${orchard.id} has a tree ${value.toFixed(1)} from its middle, past its own half-depth`,
        );
      // And the rows are shared: consecutive trees along the heading are neighbours in the same row,
      // so a few bands between them account for the whole orchard. The bands are found by the gap
      // between neighbours rather than by a fixed bucket width, because a bucket narrow enough to be
      // sure of two trees in one row also splits a jittered row in two and counts it twice. A row is
      // laid out 14 apart and jittered by 2.5, so 6 separates rows and never splits one.
      const sorted = [...projections].sort((a, b) => a - b);
      let bands = trees.length > 0 ? 1 : 0;
      for (let i = 1; i < sorted.length; i += 1) if (sorted[i] - sorted[i - 1] > 6) bands += 1;
      assert.ok(
        bands * 2 <= trees.length,
        `${orchard.id} spread ${trees.length} trees over ${bands} rows, which is a scatter`,
      );
    }
  }
});

test('the two counts are independent, so tuning one does not move the other', () => {
  // A caller's two counts are two features. Asking for more of one must not re-draw the other, or a
  // caller tuning the field count is silently re-tuning the orchards too.
  const base = { seed: 4242, width: 2048, height: 1536 };
  const fields = generateMap({ ...base, plots: { field: 12 } });
  const both = generateMap({ ...base, plots: { field: 12, orchard: 8 } });
  const fieldsAgain = generateMap({ ...base, plots: { field: 12 } });

  // Same fields, same places: adding an orchard to the request leaves the fields alone.
  const onlyFields = (map) => map.plots.filter((plot) => plot.kind === 'field');
  assert.deepEqual(
    onlyFields(both).map((p) => p.position),
    onlyFields(fields).map((p) => p.position),
  );
  // And the request is reproducible, so a count is not a lottery.
  assert.deepEqual(
    onlyFields(fields).map((p) => p.position),
    onlyFields(fieldsAgain).map((p) => p.position),
  );
});

test('a plot carrying a collision is rejected, because a field is not a wall', () => {
  const map = mapFor({ seed: 4242, plots: PLENTY });
  const walled = structuredClone(map);
  walled.plots[0].collision = { type: 'rectangle', x: 0, y: 0, width: 10, height: 10 };
  assert.ok(!validateMap(walled).valid, 'a plot carrying a collision was accepted');
});

test('a plot is refused the things that would make it a different thing', () => {
  const map = mapFor({ seed: 4242, plots: PLENTY });
  const base = structuredClone(map);
  const first = (kind) => base.plots.findIndex((plot) => plot.kind === kind);

  // No heading is no plot: a rectangle with no heading does not say which way its rows run.
  const headingless = structuredClone(base);
  delete headingless.plots[0].rotation;
  assert.ok(!validateMap(headingless).valid, 'a plot with no heading was accepted');

  // A plot belonging to nowhere is a rectangle standing in a field.
  const homeless = structuredClone(base);
  homeless.plots[0].metadata.settlementId = 'settlement-nowhere';
  assert.ok(!validateMap(homeless).valid, 'a plot with no settlement was accepted');

  // The trees are named from `vegetation`, so a name resolving to nothing names a trunk that blocks
  // nothing and is drawn by nothing.
  const ghost = structuredClone(base);
  const orchard = ghost.plots[first('orchard')];
  if (orchard) {
    orchard.metadata.treeIds = [...orchard.metadata.treeIds, 'tree-not-on-the-map'];
    assert.ok(
      !validateMap(ghost).valid,
      'an orchard naming a tree that is not on the map was accepted',
    );
  }

  // A field with trees in it is a field with an orchard in it, and an orchard with none is a field
  // that has lost its rows. The two kinds cannot be published in a state that disagrees with itself.
  const swapping = structuredClone(base);
  const a = swapping.plots[first('field')];
  const b = first('orchard') >= 0 ? swapping.plots[first('orchard')] : undefined;
  if (a && b) {
    a.metadata.treeIds = b.metadata.treeIds;
    b.metadata.treeIds = [];
    assert.ok(
      !validateMap(swapping).valid,
      'a field with rows and an orchard without was accepted',
    );
  }
});

test('a count outside its range, or a fraction of one, is rejected', () => {
  const base = { seed: 4242, width: 2048, height: 1536 };
  for (const kind of ['field', 'orchard']) {
    assert.throws(
      () => generateMap({ ...base, plots: { [kind]: 65 } }),
      new RegExp(`plots\\.${kind}`),
      `a ${kind} count of 65 was accepted`,
    );
    // 2.5 is not a number of fields, and the loops that read it test `length >= count`, so a float is
    // silently rounded up and the caller is handed a different number than the one they asked for.
    assert.throws(
      () => generateMap({ ...base, plots: { [kind]: 2.5 } }),
      new RegExp(`whole number, not 2\\.5`),
      `a ${kind} count of 2.5 was accepted`,
    );
  }
});

test('a map with no settlement has no worked ground, because a field belongs to a place', () => {
  // Worked ground is ground a settlement reaches. With no place to reach it from there is nothing to
  // attach a plot to, and a plot naming no place is a rectangle a consumer cannot act on.
  const none = generateMap({
    seed: 583921,
    width: 2048,
    height: 1536,
    settlements: { count: 0 },
    plots: PLENTY,
  });
  assert.equal(none.settlements.length, 0);
  assert.deepEqual(none.plots, [], 'a map with no place still published worked ground');
  assert.ok(validateMap(none).valid);

  // One place is enough for both kinds, which is the point: a hamlet has fields.
  const one = generateMap({
    seed: 583921,
    width: 2048,
    height: 1536,
    settlements: { count: 1 },
    plots: PLENTY,
  });
  assert.ok(one.plots.length > 0, 'a hamlet asked for fields and had none');
  assert.ok(validateMap(one).valid);
});

test('the same seed gives the same plots, and they survive a round trip', () => {
  const config = { seed: 4242, width: 2048, height: 1536, plots: PLENTY };
  const first = generateMap(config);
  const second = generateMap(config);
  assert.deepEqual(first.plots, second.plots);
  assert.ok(first.plots.length > 0, 'nothing to round trip');

  const returned = importMap(exportMap(first));
  assert.ok(validateMap(returned).valid, JSON.stringify(validateMap(returned).errors.slice(0, 2)));
  assert.deepEqual(returned.plots, first.plots);
  // The rows travel with them: an orchard that lost its trees on the way out is an empty rectangle.
  for (const plot of returned.plots)
    for (const id of plot.metadata.treeIds)
      assert.ok(
        returned.vegetation.some((tree) => tree.id === id),
        `${plot.id} names ${id}, which did not survive the round trip`,
      );
});

test('a farm works a field, so it stands in one rather than along a road', () => {
  // The complaint that produced this: farms were strung along the roads in the middle of a place, some
  // of them on the road itself. A farm is the building that works a field, so it belongs in one, and
  // the field is already out on the outskirts of the settlement that owns it.
  let inField = 0;
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    const fields = new Set(of(map, 'field').map((plot) => plot.id));
    const claimed = new Set();
    for (const building of map.structures.filter((entry) => entry.category === 'farm')) {
      if (!building.metadata.plotId) continue;
      inField += 1;
      const plot = map.plots.find((entry) => entry.id === building.metadata.plotId);
      assert.ok(plot, `${building.id} names ${building.metadata.plotId}, which is not a plot`);
      assert.equal(plot.kind, 'field', `${building.id} works an ${plot.kind}`);
      assert.ok(
        pointInPolygon(building.position, plot.geometry),
        `${building.id} names ${plot.id} but does not stand in it`,
      );
      // The whole footprint, not just the centre: a farmstead hanging off the edge of its own field
      // is on the road the caller was complaining about, just further out.
      for (const point of building.geometry.points)
        assert.ok(pointInPolygon(point, plot.geometry), `${building.id} overhangs ${plot.id}`);
      // One farmstead per field. Two on one field is a yard, not a farm.
      assert.ok(!claimed.has(plot.id), `${plot.id} has two farms on it`);
      claimed.add(plot.id);
      // And it claims no road, because it is on none. `setback` is a distance from a road.
      assert.equal(
        building.metadata.roadId,
        undefined,
        `${building.id} claims a road it is not on`,
      );
      assert.equal(building.metadata.setback, 0, `${building.id} reports a road setback`);
    }
    assert.ok(
      claimed.size <= fields.size,
      `seed ${seed} put ${claimed.size} farms on ${fields.size} fields`,
    );
    // A farm is on the outskirts because its field is, so the farm reaches at least as far from the
    // place as the field it works does.
    for (const building of map.structures.filter((entry) => entry.category === 'farm')) {
      const plot = map.plots.find((entry) => entry.id === building.metadata.plotId);
      if (!plot) continue;
      const place = map.settlements.find((entry) => entry.id === plot.metadata.settlementId);
      assert.ok(
        gap(building.position, place.position) >= 46,
        `${building.id} is ${Math.round(gap(building.position, place.position))} from its place`,
      );
    }
  }
  assert.ok(inField > 0, 'no farm anywhere stood in a field');
});

test('a building stands clear of what is around it, footprint and not centre', () => {
  // The clearance test is the half-diagonal, the smallest circle containing the whole footprint. It
  // used to be half the depth, which fits inside a rectangle but does not contain it: a 28-wide farm
  // overhung its own 10-unit circle by 4 units on each side, and a corner landing on a road, in a
  // lake, on rock or on the sand passed every check. This samples the footprint's own outline, so it
  // is the thing a consumer can see rather than the thing the placer believed.
  for (const seed of SEEDS) {
    const map = mapFor({ seed, plots: PLENTY });
    const rock = map.terrain.filter((region) => region.kind === 'rock').map((r) => r.geometry);
    const beach = map.terrain.filter((region) => region.kind === 'beach').map((r) => r.geometry);
    for (const building of map.structures) {
      const outline = [...building.geometry.points, building.position];
      for (let i = 0; i < building.geometry.points.length; i += 1) {
        const a = building.geometry.points[i];
        const b = building.geometry.points[(i + 1) % building.geometry.points.length];
        outline.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
      const inside = (polygon) => outline.some((point) => pointInPolygon(point, polygon));
      for (const road of map.roads)
        assert.ok(!inside(road.collision), `${building.id} is on ${road.id}`);
      for (const body of map.water)
        assert.ok(!inside(body.geometry), `${building.id} is in ${body.id}`);
      for (const region of rock) assert.ok(!inside(region), `${building.id} is on rock`);
      for (const region of beach) assert.ok(!inside(region), `${building.id} is on the sand`);
    }
  }
});
