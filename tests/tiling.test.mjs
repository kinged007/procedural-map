import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { generateMap, validateMap } from '../dist/index.js';

const SEED = 583921;
const TILE = { width: 1024, height: 768 };
// Big enough for a 2x2 arrangement, so the same world serves the side-by-side pair, the stacked pair,
// and a tile at an arbitrary interior origin. Thresholds depend on the world extent, so one constant
// keeps every case in this file reading the same numbers.
const TILE_WORLD = { width: 2048, height: 1536 };
const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Drops the two placement fields, so a map can be compared against a hash taken before they existed. */
const withoutPlacement = (map) => {
  const copy = JSON.parse(JSON.stringify(map));
  delete copy.metadataLayers.generation.origin;
  delete copy.metadataLayers.generation.world;
  return copy;
};

test('a tile with no origin and no world is the map it always was', () => {
  // The point of defaulting `world` to the tile's own bounds is that a single-tile map is unchanged by
  // this work. The resolved config now carries origin and world, so the comparison strips those two
  // fields. The pinned value moved when water was allowed to reach the map edge, again when rivers
  // were published, again when a river became the main channel of its catchment, again when a
  // course was cut at a water body's shore, again when centreline curve-fitting changed the
  // channels, and again when a course was rejoined into one reach running to the water; this still
  // guards against `origin`/`world` leaking into the terrain.
  const map = generateMap({ seed: SEED, width: 640, height: 480 });
  assert.equal(
    stableHash(withoutPlacement(map)),
    'b9a28eddc43d07443ed4921fcfbeb63051dea331acf0351ca1648aa32233fe86',
  );
});

test('saying origin zero and the tile as its own world changes nothing', () => {
  const implicit = generateMap({ seed: SEED, width: 640, height: 480 });
  const explicit = generateMap({
    seed: SEED,
    width: 640,
    height: 480,
    origin: { x: 0, y: 0 },
    world: { width: 640, height: 480 },
  });
  assert.equal(JSON.stringify(implicit), JSON.stringify(explicit));
});

test('two tiles of one world agree exactly on every threshold', () => {
  // A threshold read off the tile would move with the window, so a lake would sit at a different
  // height in each tile and the waterline would step at every seam. Both tiles have to read the same
  // number, or the seam is back.
  for (const seed of [SEED, 7, 42, 2024, 8675309]) {
    const config = { seed, ...TILE, terrain: { variation: 0.8 } };
    const left = generateMap({ ...config, origin: { x: 0, y: 0 }, world: TILE_WORLD });
    const right = generateMap({ ...config, origin: { x: TILE.width, y: 0 }, world: TILE_WORLD });

    assert.equal(
      left.metadataLayers.waterLevel,
      right.metadataLayers.waterLevel,
      `seed ${seed}: water level differs across the seam`,
    );
    const level = (map) => map.terrain.find((region) => region.kind === 'rock')?.reportedLevel;
    assert.equal(level(left), level(right), `seed ${seed}: rock level differs across the seam`);
  }
});

test('the fields are one function of world position, not one copy per tile', () => {
  // Both tiles sample the same world coordinates on their shared edge, so the values there are not
  // merely close, they are the same numbers. A tolerance here would hide the actual failure, which is
  // a tile evaluating noise in its own local space.
  for (const seed of [SEED, 7, 42, 2024, 8675309]) {
    const config = { seed, ...TILE, terrain: { variation: 0.8 } };
    const left = generateMap({ ...config, origin: { x: 0, y: 0 }, world: TILE_WORLD })
      .metadataLayers.fields;
    const right = generateMap({ ...config, origin: { x: TILE.width, y: 0 }, world: TILE_WORLD })
      .metadataLayers.fields;

    assert.equal(left.rows, right.rows, 'side by side tiles should share their row samples');
    for (const key of ['terrain', 'elevation', 'moisture', 'vegetation']) {
      for (let row = 0; row < left.rows; row += 1)
        assert.equal(
          left[key][row * left.columns + left.columns - 1],
          right[key][row * right.columns],
          `seed ${seed}: ${key} is discontinuous at the seam on row ${row}`,
        );
    }
  }
});

test('the two sides of a seam agree on where the water is', () => {
  // The point set either side of the seam has to match, or a character standing on the line is in
  // two different places depending on which tile it loaded.
  const config = { seed: SEED, ...TILE, water: { amount: 0.25 } };
  const left = generateMap({ ...config, origin: { x: 0, y: 0 }, world: TILE_WORLD });
  const right = generateMap({ ...config, origin: { x: TILE.width, y: 0 }, world: TILE_WORLD });
  assert.notEqual(left.water.length + right.water.length, 0, 'expected some water to check');

  const waterBlocks = (map) =>
    map.water
      .map((lake) => lake.collision)
      .filter((blocker) => blocker.type === 'polygon')
      .map((blocker) => blocker.points);
  const inWater = (map, x, y) => waterBlocks(map).some((ring) => pointInside({ x, y }, ring));
  // Water is contoured per tile, so a shoreline passing near the seam is drawn independently from each
  // side and the two outlines can differ by up to a field-grid cell. A body that ends just short of
  // the seam is the clearest case: one tile shows its last sliver and the other shows none. Probes
  // that close to an outline are therefore not comparable. The field and the level those outlines
  // come from are already asserted to match exactly across the seam; this test catches the wider
  // failure of a broken field or an unshared level, which would disagree away from any shoreline.
  const fieldCell = TILE.width / (left.metadataLayers.fields.columns - 1);
  const nearOutline = (map, x, y) =>
    waterBlocks(map).some((ring) =>
      ring.some((point, index) => {
        const next = ring[(index + 1) % ring.length];
        const projection = Math.max(
          0,
          Math.min(
            1,
            ((x - point.x) * (next.x - point.x) + (y - point.y) * (next.y - point.y)) /
              ((next.x - point.x) ** 2 + (next.y - point.y) ** 2),
          ),
        );
        return (
          Math.hypot(
            x - (point.x + projection * (next.x - point.x)),
            y - (point.y + projection * (next.y - point.y)),
          ) < fieldCell
        );
      }),
    );
  for (let y = 0; y < TILE.height; y += 4) {
    if (nearOutline(left, TILE.width - 0.5, y) || nearOutline(right, TILE.width + 0.5, y)) continue;
    assert.equal(
      inWater(left, TILE.width - 0.5, y),
      inWater(right, TILE.width + 0.5, y),
      `the seam is wet on one side and dry on the other at y ${y}`,
    );
  }
});

function pointInside(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

test('a world changes where the thresholds fall, not what the terrain looks like', () => {
  // Two separate claims, and the second is the one that would be wrong if the fields were sampled
  // from the world rectangle instead of the tile at its own origin.
  const config = { seed: SEED, ...TILE, water: { amount: 0.25 } };
  const alone = generateMap(config);
  const inWorld = generateMap({ ...config, world: { width: 4096, height: 3072 } });

  assert.equal(
    JSON.stringify(alone.metadataLayers.fields),
    JSON.stringify(inWorld.metadataLayers.fields),
    'the terrain of a tile should not depend on how big the world around it is',
  );
  assert.notEqual(
    alone.metadataLayers.waterLevel,
    inWorld.metadataLayers.waterLevel,
    'a threshold should be measured against the world, not the tile',
  );
});

test('tiles of one world do not repeat each other', () => {
  // Placement used to be seeded from the map seed alone, so every tile of a world drew the same
  // sequence and a tiled world showed the same grove in the same corner of every tile.
  const config = { seed: SEED, ...TILE };
  const left = generateMap({ ...config, origin: { x: 0, y: 0 }, world: TILE_WORLD });
  const right = generateMap({ ...config, origin: { x: TILE.width, y: 0 }, world: TILE_WORLD });
  const below = generateMap({ ...config, origin: { x: 0, y: TILE.height }, world: TILE_WORLD });

  assert.notEqual(
    JSON.stringify(left.vegetation.map((tree) => tree.position)),
    JSON.stringify(right.vegetation.map((tree) => tree.position)),
  );
  assert.notEqual(
    JSON.stringify(left.vegetation.map((tree) => tree.position)),
    JSON.stringify(below.vegetation.map((tree) => tree.position)),
  );
  // A world assembled from tiles would otherwise carry the same entity ids in every one of them.
  const ids = new Set([left.metadata.id, right.metadata.id, below.metadata.id]);
  assert.equal(ids.size, 3);
});

test('a tile stays self-contained, in its own coordinates', () => {
  // The raster, the chunks and the walkability read path all work off the tile, so a tile reports its
  // own bounds and every entity inside them. A consumer places the tile at its origin.
  const map = generateMap({
    seed: SEED,
    ...TILE,
    origin: { x: 3072, y: 0 },
    world: { width: 4096, height: 3072 },
  });
  assert.equal(validateMap(map).valid, true);
  assert.deepEqual(map.bounds, { width: TILE.width, height: TILE.height });
  for (const entity of [...map.water, ...map.vegetation, ...map.forests])
    for (const point of entity.geometry ? entity.geometry.points : [entity.position])
      assert.ok(
        point.x >= 0 && point.x <= TILE.width && point.y >= 0 && point.y <= TILE.height,
        'a tile must not carry coordinates from outside itself',
      );
});

test('a tile that does not fit its world is rejected', () => {
  const base = { seed: SEED, ...TILE };
  for (const options of [
    { origin: { x: TILE.width, y: 0 }, world: { width: 1024, height: 1536 } },
    { origin: { x: -1, y: 0 } },
    { origin: { x: 0, y: -1 } },
    { world: { width: 1023, height: 1536 }, origin: { x: 0, y: 0 } },
    { world: { width: 2048, height: 767 } },
  ])
    assert.throws(
      () => generateMap({ ...base, ...options }),
      /does not fit inside/,
      JSON.stringify(options),
    );

  // The far corner of a world is still inside it.
  assert.equal(
    validateMap(
      generateMap({
        ...base,
        origin: { x: 3072, y: 2304 },
        world: { width: 4096, height: 3072 },
      }),
    ).valid,
    true,
  );
});

test('a world is not capped at the size of one tile', () => {
  // A world is the frame a tile is a window onto, not a map generated in one piece, so it must be
  // able to be larger than the largest single tile. The documented example is 8192x6144, and it has
  // to generate, or the docs promise an API that throws. A single tile is still capped at 4096.
  const map = generateMap({
    seed: SEED,
    ...TILE,
    origin: { x: 4096, y: 3072 },
    world: { width: 8192, height: 6144 },
  });
  assert.equal(validateMap(map).valid, true);
  assert.deepEqual(map.metadataLayers.generation.world, { width: 8192, height: 6144 });

  // The tile's own ceiling is unchanged.
  assert.throws(() => generateMap({ seed: SEED, width: 4097, height: 480 }), /width must be/);
});

test('a map records the placement it was generated with', () => {
  const { generation } = generateMap({
    seed: SEED,
    ...TILE,
    origin: { x: 512, y: 256 },
    world: TILE_WORLD,
  }).metadataLayers;
  assert.deepEqual(generation.origin, { x: 512, y: 256 });
  assert.deepEqual(generation.world, TILE_WORLD);
});
