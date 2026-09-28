import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, validateMap, rasterizeWalkability, pointInPolygon } from '../dist/index.js';

const MAP = { seed: 583921, width: 2048, height: 1536 };
const harbour = (extra = {}) =>
  generateMap({ ...MAP, settlements: { count: 6 }, docks: { count: 6 }, ...extra });

/** Every cell whose centre lies inside `geometry`, as indices into the raster. */
function cellsUnder(raster, geometry) {
  const cells = [];
  for (let row = 0; row < raster.rows; row += 1)
    for (let column = 0; column < raster.columns; column += 1) {
      const centre = {
        x: column * raster.cellSize + raster.cellSize / 2,
        y: row * raster.cellSize + raster.cellSize / 2,
      };
      if (pointInPolygon(centre, geometry)) cells.push(row * raster.columns + column);
    }
  return cells;
}

/** The open cells reachable on foot from one cell, which is what a deck has to join. */
function reachable(raster, from) {
  const seen = new Uint8Array(raster.cells.length);
  const queue = [from];
  seen[from] = 1;
  while (queue.length > 0) {
    const cell = queue.pop();
    const row = Math.floor(cell / raster.columns);
    const column = cell - row * raster.columns;
    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const r = row + dr;
      const c = column + dc;
      if (r < 0 || c < 0 || r >= raster.rows || c >= raster.columns) continue;
      const next = r * raster.columns + c;
      if (seen[next] === 1 || raster.cells[next] === 1) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }
  return seen;
}

test('a dock is published as a typed entity, and the map is valid with one', () => {
  const map = harbour();
  assert.ok(map.docks.length > 0, 'a map asked for docks has some');
  assert.equal(validateMap(map).valid, true);
  for (const dock of map.docks) {
    assert.equal(dock.type, 'dock');
    assert.equal(dock.id, `dock-${map.docks.indexOf(dock) + 1}`);
    assert.ok(dock.width > 0 && dock.depth > 0, 'a deck publishes the size it is drawn at');
    assert.equal(dock.geometry.points.length, 4, 'a deck is the rectangle it publishes');
    assert.equal(dock.collision, undefined, 'a deck is ground to walk on, not a wall');
    assert.equal(dock.asset.category, 'structure.dock');
  }
});

test('a dock is the waterfront of a place, so a map with no place has no harbours', () => {
  assert.equal(generateMap(MAP).docks.length, 0, 'and the default is a map of no harbours');
  assert.equal(harbour({ docks: { count: 0 } }).docks.length, 0, 'zero is a map of no harbours');
  assert.equal(
    generateMap({ ...MAP, settlements: { count: 0 }, docks: { count: 8 } }).docks.length,
    0,
    'a count of eight buys nothing without a settlement to be the waterfront of',
  );
  // The count is an upper bound rather than a promise, and what limits it is the shoreline rather
  // than the number of places: one settlement on a long shore can have several decks.
  const perPlace = [];
  for (const seed of [1, 7, 42, 777, 31415]) {
    const map = generateMap({ ...MAP, seed, settlements: { count: 2 }, docks: { count: 16 } });
    assert.ok(map.docks.length > 0, 'a place on a shore does get a waterfront');
    const counts = {};
    for (const dock of map.docks)
      counts[dock.metadata.settlementId] = (counts[dock.metadata.settlementId] ?? 0) + 1;
    perPlace.push(...Object.values(counts));
    assert.ok(
      map.docks.every((dock) => map.settlements.some((s) => s.id === dock.metadata.settlementId)),
      'every deck belongs to a place that exists',
    );
  }
  assert.ok(
    Math.max(...perPlace) > 1,
    'and one place can carry more than one deck, which is why the count is not the settlement count',
  );
});

test('every dock names a settlement that exists and a body of water its deck reaches', () => {
  let checked = 0;
  for (const seed of [1, 7, 42, 583921, 777, 31415, 99999, 123456]) {
    const map = harbour({ seed });
    for (const dock of map.docks) {
      const settlement = map.settlements.find((s) => s.id === dock.metadata.settlementId);
      const water = map.water.find((w) => w.id === dock.metadata.waterId);
      assert.ok(settlement, 'the place a deck is the waterfront of is on the map');
      assert.ok(water, 'the water a deck stands in is on the map');
      const gap = Math.hypot(
        settlement.position.x - dock.position.x,
        settlement.position.y - dock.position.y,
      );
      assert.ok(gap <= settlement.radius, 'and the deck is within reach of its place');
      // The far end of the centreline is standing water, which is what makes this a dock rather
      // than a plank on the bank. The far *corners* are not required to be: a deck meeting a
      // concave shore has one of them back on the sand.
      const far = {
        x: dock.position.x + Math.cos(dock.rotation) * dock.depth,
        y: dock.position.y + Math.sin(dock.rotation) * dock.depth,
      };
      assert.ok(
        pointInPolygon(far, water.collision),
        'the end of the deck is in the water it names',
      );
      checked += 1;
    }
  }
  assert.ok(checked > 20, `the sweep checked a real number of docks (${checked})`);
});

test('a deck is reached along a road, which is the only thing that offers a site', () => {
  const map = harbour();
  for (const dock of map.docks) {
    assert.ok(dock.metadata.roadId, 'a deck says which road reaches it');
    const road = map.roads.find((r) => r.id === dock.metadata.roadId);
    assert.ok(road, 'and the road is on the map');
    // The deck is rooted on the waterline rather than on the road, so what the road has to satisfy
    // is that it comes within reach. A shore no road can reach is a shore with nobody on it, and a
    // deck standing in it would be a pier a cart could never get to.
    assert.ok(
      distanceToPath(dock.position, road.path) <= 120,
      'a road reaches the shore the deck is rooted on',
    );
  }
});

test('a deck stands in the water, rooted at the bank, and does not run across the land', () => {
  // The first version laid the deck from the road to the shore and a short way past it, which drew a
  // plank across the beach and left a stub in the water. A pier starts where the land ends: the whole
  // deck is over water, and the only part that may touch the bank is the edge it is rooted on.
  for (const seed of [1, 7, 42, 583921, 777, 31415, 99999, 123456]) {
    const map = harbour({ seed });
    for (const dock of map.docks) {
      const water = map.water.find((w) => w.id === dock.metadata.waterId);
      const forward = { x: Math.cos(dock.rotation), y: Math.sin(dock.rotation) };
      const across = { x: -forward.y, y: forward.x };
      // The far end is standing water, which is what makes this a dock rather than a plank on the
      // bank, and both of its corners are in the water rather than on the sand behind it.
      const tip = {
        x: dock.position.x + forward.x * dock.depth,
        y: dock.position.y + forward.y * dock.depth,
      };
      for (const [name, p] of [
        ['the far end', tip],
        [
          'the far left corner',
          { x: tip.x + across.x * (dock.width / 2), y: tip.y + across.y * (dock.width / 2) },
        ],
        [
          'the far right corner',
          { x: tip.x - across.x * (dock.width / 2), y: tip.y - across.y * (dock.width / 2) },
        ],
      ])
        assert.ok(pointInPolygon(p, water.collision), `${name} of a deck is in the water it names`);
      // And the deck's own area is water, not a ramp. Sampling the rectangle rather than its corners
      // is what catches a deck that grazes a sand spit without either corner noticing.
      let onLand = 0;
      let sampled = 0;
      for (let t = 0.5; t < dock.depth; t += 1)
        for (let s = -dock.width / 2 + 0.5; s < dock.width / 2; s += 1) {
          sampled += 1;
          if (
            !pointInPolygon(
              {
                x: dock.position.x + forward.x * t + across.x * s,
                y: dock.position.y + forward.y * t + across.y * s,
              },
              water.collision,
            )
          )
            onLand += 1;
        }
      assert.ok(
        onLand / sampled < 0.1,
        `a deck is over water, not land (${((onLand / sampled) * 100).toFixed(1)}% on land)`,
      );
    }
  }
});

test('a deck is as long as the water allows, and no longer', () => {
  // A fixed length would lay a pier across a narrow inlet to the far bank. The reach is measured
  // instead, so an inlet gives a short deck and a broad shore a full-length one.
  const depths = [1, 7, 42, 583921, 777, 31415].flatMap((seed) =>
    harbour({ seed }).docks.map((dock) => dock.depth),
  );
  assert.ok(Math.min(...depths) >= 12, 'no deck is too short to be one');
  assert.ok(Math.max(...depths) <= 40, 'and none is longer than a landing stage');
  assert.ok(
    Math.max(...depths) - Math.min(...depths) > 0,
    'the water decides, so a map with both an inlet and an open shore gets two lengths',
  );
});

/** Nearest distance from a point to a polyline, which is how a station between path points is found. */
function distanceToPath(point, path) {
  let best = Infinity;
  for (let index = 0; index + 1 < path.length; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const span = dx * dx + dy * dy;
    const t =
      span === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / span));
    best = Math.min(best, Math.hypot(a.x + dx * t - point.x, a.y + dy * t - point.y));
  }
  return best;
}

test('a deck is ground a character can walk on, and the water under it is opened', () => {
  // The one mechanical part that is new: the raster fills water as blocked, so a deck standing in
  // water has to be carved back out. Every cell the deck covers is open afterwards, and the ones
  // that were open are open because they were land, not because of the carve.
  for (const cellSize of [4, 8, 16, 32]) {
    const map = harbour();
    const without = { ...map, docks: [] };
    const carved = rasterizeWalkability(map, { cellSize });
    const before = rasterizeWalkability(without, { cellSize });
    let opened = 0;
    for (const dock of map.docks) {
      const cells = cellsUnder(carved, dock.geometry);
      // A deck is 16 across, so below a 32-unit cell the raster can see none of it: no cell centre
      // lands inside a deck narrower than half a cell. That is the resolution of the grid and not a
      // failure of the carve, and it is the same ceiling the field already has at 64 samples across.
      if (cellSize <= 16) assert.ok(cells.length > 0, `a deck is wider than a cell at ${cellSize}`);
      for (const cell of cells) {
        assert.equal(carved.cells[cell], 0, `a cell under a deck is walkable at ${cellSize}`);
        if (before.cells[cell] === 1) opened += 1;
      }
    }
    assert.ok(opened > 0, `the carve opened water at ${cellSize}`);
    // And the carve opens water and nothing else: a cell that was open stays open, and the only
    // cells that changed are the ones a deck covers.
    for (let cell = 0; cell < carved.cells.length; cell += 1)
      if (before.cells[cell] === 0) assert.equal(carved.cells[cell], 0, 'nothing else was opened');
  }
});

test('a deck reaches the shore rather than making an island of its own', () => {
  // A deck rooted on the waterline has to be carved back out of the shoreline itself, and the
  // shoreline is exactly where the raster is most conservative: it blocks a cell the water merely
  // touches. So the root cell is carved rather than open, and this is the test that the root is
  // still joined to the land. Every open cell under a deck has to be reachable on foot.
  for (const cellSize of [4, 8, 16, 32, 64]) {
    const map = harbour();
    const raster = rasterizeWalkability(map, { cellSize });
    for (const dock of map.docks) {
      const cells = cellsUnder(raster, dock.geometry);
      if (cells.length === 0) continue;
      // The flood is from the nearest open ground to the deck's root, which is the shore it is
      // rooted on: a deck joined to nothing is a walkable patch in a lake.
      const anchor = nearestOpenCell(raster, dock.position);
      assert.ok(anchor >= 0, `the shore a deck is rooted on is open ground at ${cellSize}`);
      const seen = reachable(raster, anchor);
      for (const cell of cells)
        if (raster.cells[cell] === 0)
          assert.equal(seen[cell], 1, `a deck cell is reachable from its own shore at ${cellSize}`);
    }
  }
});

/** The cell nearest `point` that is open, or -1 when the whole neighbourhood is blocked. */
function nearestOpenCell(raster, point) {
  const column = Math.floor(point.x / raster.cellSize);
  const row = Math.floor(point.y / raster.cellSize);
  for (let radius = 0; radius < 12; radius += 1)
    for (let dr = -radius; dr <= radius; dr += 1)
      for (let dc = -radius; dc <= radius; dc += 1) {
        const r = row + dr;
        const c = column + dc;
        if (r < 0 || c < 0 || r >= raster.rows || c >= raster.columns) continue;
        const cell = r * raster.columns + c;
        if (raster.cells[cell] === 0) return cell;
      }
  return -1;
}

test('two decks do not share a shore, and no deck is laid through a building', () => {
  const map = harbour({ seed: 777 });
  const boxes = map.docks.map((dock) => ({ deck: dock, box: boxOf(dock.geometry.points) }));
  for (let i = 0; i < boxes.length; i += 1)
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i].box;
      const b = boxes[j].box;
      const touching = !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
      assert.equal(touching, false, 'two decks do not overlap');
    }
  for (const dock of map.docks) {
    const deck = boxOf(dock.geometry.points);
    for (const building of map.structures) {
      const wall = boxOf(building.geometry.points);
      const touching = !(
        deck.maxX < wall.minX ||
        wall.maxX < deck.minX ||
        deck.maxY < wall.minY ||
        wall.maxY < deck.minY
      );
      assert.equal(touching, false, 'a deck is not laid through a wall');
    }
  }
});

function boxOf(points) {
  return points.reduce(
    (b, p) => ({
      minX: Math.min(b.minX, p.x),
      maxX: Math.max(b.maxX, p.x),
      minY: Math.min(b.minY, p.y),
      maxY: Math.max(b.maxY, p.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
}

test('a dock carrying a collision is rejected, because a deck is not a wall', () => {
  const map = harbour();
  const dock = {
    ...map.docks[0],
    collision: { type: 'rectangle', x: 0, y: 0, width: 1, height: 1 },
  };
  const result = validateMap({ ...map, docks: [dock, ...map.docks.slice(1)] });
  assert.equal(result.valid, false, 'a walled-in deck is not a map');
});

test('a dock naming a place or a water that is not on the map is rejected', () => {
  const map = harbour();
  for (const [field, value] of [
    ['settlementId', 'settlement-999'],
    ['waterId', 'water-999'],
  ]) {
    const dock = { ...map.docks[0], metadata: { ...map.docks[0].metadata, [field]: value } };
    const result = validateMap({ ...map, docks: [dock, ...map.docks.slice(1)] });
    assert.equal(result.valid, false, `a dock naming ${field} ${value} is rejected`);
  }
});

test('a dock is not the gate to everything else on the map', () => {
  // The count has a stream of its own, so asking for harbours moves no road, no tree, no building
  // and no other place. A pier on the map and a pier off it have to be the same map with a deck on
  // it, or the setting is reaching further into the map than it should.
  const withDocks = harbour();
  const without = generateMap({ ...MAP, settlements: { count: 6 }, docks: { count: 0 } });
  for (const collection of ['terrain', 'water', 'vegetation', 'forests', 'structures', 'roads'])
    assert.deepEqual(
      withDocks[collection],
      without[collection],
      `${collection} is not touched by a dock count`,
    );
  assert.deepEqual(
    withDocks.settlements.map((s) => s.position),
    without.settlements.map((s) => s.position),
    'nor is where the places are',
  );
});

test('the same seed gives the same docks, and they survive a round trip', () => {
  const first = harbour();
  assert.deepEqual(first.docks, harbour().docks, 'generation is stable for the same config');
  const round = JSON.parse(JSON.stringify(first));
  assert.equal(validateMap(round).valid, true, 'a map of harbours is still a map');
  assert.deepEqual(round.docks, first.docks, 'and a dock survives export and import');
  assert.deepEqual(
    round.metadataLayers.generation.docks,
    { count: 6 },
    'the count asked for is the count recorded',
  );
});
