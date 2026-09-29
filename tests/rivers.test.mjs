import assert from 'node:assert/strict';
import test from 'node:test';
import {
  circleIntersectsPolygon,
  generateMap,
  pointInPolygon,
  polygonArea,
} from '../dist/index.js';
import { ringIsSimple } from '../dist/generation/terrain/Shoreline.js';

const SEEDS = [583921, 42, 7, 99, 5, 12, 3, 21, 777, 0, -91, 88];

/**
 * The smallest map the generator takes. A channel is a fixed 12 world units wide, so on a map this
 * small it is a large share of the ground, and the highest ground is often a cell or two from the
 * border. A river here is a decoration, not a feature, so these are checked apart.
 */
const TINY = { width: 128, height: 128 };

const riversOf = (map) => map.water.filter((region) => region.kind === 'river');

/** Shortest distance from a point to a ring's nearest edge, which is the distance to the shore. */
const distanceToRing = (point, geometry) => {
  let closest = Infinity;
  const ring = geometry.points;
  for (let index = 1; index < ring.length; index += 1) {
    const a = ring[index - 1];
    const b = ring[index];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const along =
      squared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared));
    closest = Math.min(
      closest,
      Math.hypot(point.x - (a.x + along * dx), point.y - (a.y + along * dy)),
    );
  }
  return closest;
};

const crossingsOf = (map) =>
  map.roads.flatMap((road) =>
    (road.metadata.crossings ?? []).map((crossing) => ({ road, crossing })),
  );

test('rivers are published as water and hold a channel of their own', () => {
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 1024, height: 768 });
    const rivers = riversOf(map);
    assert.ok(rivers.length > 0, `seed ${seed} published no river`);
    for (const river of rivers) {
      assert.equal(river.type, 'water');
      assert.ok(river.geometry.points.length >= 4, 'a channel needs two points a side');
      // The channel is a ring a consumer can test, so it has to close on itself and be inside the map.
      assert.ok(ringIsSimple(river.geometry.points), `seed ${seed} published a folded channel`);
      assert.deepEqual(river.collision.points, river.geometry.points);
      for (const point of river.geometry.points) {
        assert.ok(point.x >= 0 && point.x <= map.bounds.width);
        assert.ok(point.y >= 0 && point.y <= map.bounds.height);
      }
    }
  }
});

test('a dry map and a flooded map have no rivers', () => {
  // Nothing to drain into, and nothing but the one lake.
  assert.equal(
    generateMap({ seed: 5, width: 1024, height: 768, water: { amount: 0 } }).water.length,
    0,
  );
  const flooded = generateMap({ seed: 5, width: 1024, height: 768, water: { amount: 1 } });
  assert.equal(riversOf(flooded).length, 0);
  assert.equal(flooded.water.length, 1);
});

test('the smallest map may have no river, and a river on it is still a channel', () => {
  // Recorded rather than asserted either way: at 128 units across the channel is a large share of the
  // map, so whether one is published depends on the ground. What has to hold is that what is published
  // is a river, not that there is one.
  for (const seed of [583921, 42, 7, 99, 5]) {
    const map = generateMap({ seed, ...TINY });
    for (const river of riversOf(map)) {
      assert.equal(river.kind, 'river');
      assert.ok(ringIsSimple(river.geometry.points));
      assert.ok(polygonArea(river.geometry) > 0);
    }
  }
});

test('a road records the river its surface reaches, and nothing else', () => {
  let recorded = 0;
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 2048, height: 1536 });
    const rivers = riversOf(map);
    for (const road of map.roads) {
      const crossings = road.metadata.crossings ?? [];
      assert.ok(crossings.length <= rivers.length, 'a road meets each river at most once');
      for (const river of rivers) {
        // A road goes over a river rather than stopping at the bank, and its surface is its centreline
        // a half-width either side. So this is whether the road reaches the channel, and the record
        // has to be exactly that: a road drawn over water with no crossing on it is a bridge site
        // nobody was told about, and a crossing on a road nowhere near the water is a bridge in the
        // wrong place.
        const reaches = road.path.some((point) =>
          circleIntersectsPolygon(point, road.width / 2, river.geometry),
        );
        const crossing = crossings.find((candidate) => candidate.riverId === river.id);
        assert.equal(
          Boolean(crossing),
          reaches,
          `seed ${seed}: ${road.id} and ${river.id} disagree about the crossing`,
        );
        if (!crossing) continue;
        recorded += 1;
        // The site is on the river, and the span is the channel the crossing has to cover.
        assert.ok(pointInPolygon(crossing.point, river.geometry));
        assert.ok(crossing.span > 0);
      }
    }
  }
  assert.ok(recorded > 0, 'no map in the sample recorded a crossing');
});

test('most maps cross a river, and a map with no water crosses none', () => {
  // The point of a river is that a road has to get over it, so a map with roads and rivers on it is
  // expected to show a crossing rather than happen to.
  let withCrossing = 0;
  let maps = 0;
  for (const seed of SEEDS) {
    const map = generateMap({ seed, width: 2048, height: 1536 });
    maps += 1;
    if (crossingsOf(map).length > 0) withCrossing += 1;
  }
  assert.ok(
    withCrossing >= Math.ceil(maps * 0.6),
    `only ${withCrossing} of ${maps} maps recorded a crossing`,
  );
  const dry = generateMap({ seed: 5, width: 2048, height: 1536, water: { amount: 0 } });
  assert.equal(riversOf(dry).length, 0);
  for (const road of dry.roads) assert.equal(road.metadata.crossings, undefined);
});

test('rivers and roads are curves, not staircases', () => {
  // A centreline walked one grid cell or one step at a time is a chain of short straight segments, and
  // a channel or a road offset from it reads as a folded ribbon however wide it is drawn. The measure
  // is the turn at each joint: a curve turns a little at every point over a long reach, a staircase
  // turns almost a right angle and does so at nearly every point, because a step that changes one axis
  // and then the other is a quarter turn twice. The threshold sits between the two — a real staircase
  // measures above 1.2 rad per joint, a curve measures under half that.
  const STAIRCASE = 0.7;
  /** Below this a side is too short to turn: three points is one joint, and one joint is a corner. */
  const MIN_JOINTS = 3;
  const meanTurn = (path) => {
    let total = 0;
    let joints = 0;
    for (let index = 2; index < path.length; index += 1) {
      const a = {
        x: path[index - 1].x - path[index - 2].x,
        y: path[index - 1].y - path[index - 2].y,
      };
      const b = { x: path[index].x - path[index - 1].x, y: path[index].y - path[index - 1].y };
      const cosine =
        (a.x * b.x + a.y * b.y) / ((Math.hypot(a.x, a.y) || 1) * (Math.hypot(b.x, b.y) || 1));
      total += Math.acos(Math.max(-1, Math.min(1, cosine)));
      joints += 1;
    }
    return joints ? total / joints : 0;
  };

  let rivers = 0;
  let measured = 0;
  let roadJoints = 0;
  let pooled = 0;
  for (const [width, height] of [
    [2048, 1536],
    [1024, 768],
  ]) {
    for (const seed of SEEDS) {
      const map = generateMap({ seed, width, height });
      for (const river of riversOf(map)) {
        // The ring runs up one side and back down the other, so the turn at the two caps is the
        // channel's own end and the rest is the curve. The halves are read separately.
        const along = river.geometry.points.slice(0, river.geometry.points.length / 2);
        rivers += 1;
        if (along.length - 2 < MIN_JOINTS) continue;
        const turn = meanTurn(along);
        measured += 1;
        pooled += turn;
        assert.ok(
          turn < STAIRCASE,
          `seed ${seed}: ${river.id} turns ${turn.toFixed(2)} rad per joint, which is a staircase`,
        );
      }
      for (const road of map.roads) {
        if (road.path.length - 2 < MIN_JOINTS) continue;
        const turn = meanTurn(road.path);
        roadJoints += 1;
        pooled += turn;
        assert.ok(
          turn < STAIRCASE,
          `seed ${seed}: ${road.id} turns ${turn.toFixed(2)} rad per joint, which is a staircase`,
        );
      }
    }
  }
  assert.ok(rivers > 0, 'no river in the sample to measure');
  assert.ok(roadJoints > 0, 'no road in the sample to measure');
  assert.ok(measured > 10, `only ${measured} reaches were long enough to measure`);
  // Pooled over everything, because one short channel should not decide the question: the map as a
  // whole is curves rather than a staircase, whatever any single reach does.
  assert.ok(pooled / (measured + roadJoints) < 0.4, 'the map as a whole is a staircase');
});

test('a river is cut at the shore, and says where it meets the water', () => {
  // A river drawn the whole way across a lake reads as a river floating on the sea, so a channel stops
  // at the water it reaches rather than running on. A mouth is the one place the two overlap, and the
  // channel is carried two widths in: a channel that ends on the bank's edge leaves the join a gap a
  // cart could be pulled across, and the water either side of the mouth is not visibly one body. Two
  // widths is enough to close the join and short enough that the channel is not a raft on the lake.
  const CHANNEL = 12;
  const REACH = 2;
  const DEEPEST = REACH * CHANNEL + CHANNEL / 2;
  let mouths = 0;
  for (const [width, height] of [
    [2048, 1536],
    [1024, 768],
    [640, 480],
  ]) {
    for (const seed of SEEDS) {
      const map = generateMap({ seed, width, height });
      const lakes = map.water.filter((region) => region.kind === 'lake');
      for (const river of riversOf(map)) {
        for (const point of river.geometry.points)
          for (const lake of lakes) {
            // Outside, or within the reach of its own mouth. Anything deeper is a channel running
            // across standing water rather than into it.
            const inside = pointInPolygon(point, lake.geometry);
            const depth = inside
              ? -distanceToRing(point, lake.geometry)
              : distanceToRing(point, lake.geometry);
            assert.ok(
              depth > -DEEPEST,
              `seed ${seed}: ${river.id} is drawn ${Math.abs(depth).toFixed(1)}u over ${lake.id}`,
            );
          }
        for (const mouth of river.metadata?.mouths ?? []) {
          mouths += 1;
          const lake = map.water.find((region) => region.id === mouth.waterId);
          assert.ok(lake, `seed ${seed}: ${mouth.waterId} is not on the map`);
          assert.equal(lake.kind, 'lake', 'a river does not flow into a river');
          // The site is the far end of the channel, so it is in the standing water rather than on its
          // edge, and no further in than the reach it was drawn with. The marker is as wide as the
          // channel the river was generated with.
          assert.ok(
            pointInPolygon(mouth.point, lake.geometry),
            `seed ${seed}: the mouth of ${river.id} is not in ${lake.id}`,
          );
          const reached = distanceToRing(mouth.point, lake.geometry);
          assert.ok(
            reached <= REACH * CHANNEL + 0.5,
            `seed ${seed}: ${mouth.waterId} mouth is ${reached.toFixed(1)} into the water, past the reach`,
          );
          const patch = mouth.polygon.points;
          const across = Math.hypot(patch[0].x - patch[1].x, patch[0].y - patch[1].y);
          assert.ok(
            Math.abs(across - 12) < 0.001,
            `seed ${seed}: the mouth marker is ${across} across a 12-unit channel`,
          );
        }
      }
    }
  }
  assert.ok(mouths > 0, 'no river in the sample reached standing water');
});

test('every river ends at water, the map edge, or a rock', () => {
  // A river that stops in the middle of a hillside is a stripe, not a river. Water is where a course
  // runs out of ground to fall: a lake it reaches. Its head is where the water comes from, which is the
  // edge of the mapped country or a rock face, so the channel is cut by the map border or comes out of
  // the ground. Nothing else ends a river, so nothing else may be published.
  //
  // The head is the two corners the ribbon closes on, `points[0]` and the last point. Testing whether
  // *any* point is near the edge would pass for a river whose tail merely clips a corner, which is the
  // case that let heads standing in a field through.
  for (const [width, height] of [
    [2048, 1536],
    [1024, 768],
  ]) {
    for (const seed of SEEDS) {
      const map = generateMap({ seed, width, height });
      const rivers = riversOf(map);
      const rock = map.terrain.filter((region) => region.kind === 'rock' && region.collision);
      for (const river of rivers) {
        const reachesWater = (river.metadata?.mouths?.length ?? 0) > 0;
        const corners = [
          river.geometry.points[0],
          river.geometry.points[river.geometry.points.length - 1],
        ];
        const edgeOf = (point) =>
          Math.min(point.x, point.y, map.bounds.width - point.x, map.bounds.height - point.y);
        const reachesEdge = corners.some((point) => edgeOf(point) <= 12);
        const reachesRock = corners.some((point) =>
          rock.some((face) => pointInPolygon(point, face.geometry)),
        );
        assert.ok(
          reachesWater || reachesEdge || reachesRock,
          `seed ${seed}: ${river.id} ends in the middle of the land`,
        );
        // A river runs somewhere: a reach narrower than a few channels is a fold, not a river.
        const xs = river.geometry.points.map((point) => point.x);
        const ys = river.geometry.points.map((point) => point.y);
        const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        assert.ok(span > 24, `seed ${seed}: ${river.id} is ${span} across, which is a puddle`);
      }
    }
  }
});

test('river density and width are the caller\u2019s to set', () => {
  const base = { seed: 583921, width: 2048, height: 1536 };
  const full = generateMap(base);
  const none = generateMap({ ...base, rivers: { density: 0 } });
  assert.ok(riversOf(full).length > 0, 'the default map has rivers');
  assert.equal(none.water.filter((region) => region.kind === 'lake').length > 0, true);
  assert.equal(riversOf(none).length, 0, 'density 0 published a river anyway');
  for (const road of none.roads) assert.equal(road.metadata.crossings, undefined);

  // Half the density is fewer rivers, and never more than the default.
  const half = generateMap({ ...base, rivers: { density: 0.5 } });
  assert.ok(riversOf(half).length <= riversOf(full).length);

  // The width is the channel on the ground, the marker at a mouth, and the span a road bridges.
  const wide = generateMap({ ...base, rivers: { width: 30 } });
  const widest = Math.max(
    ...riversOf(wide).map((river) => {
      const xs = river.geometry.points.map((point) => point.x);
      const ys = river.geometry.points.map((point) => point.y);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }),
  );
  assert.ok(widest > 30, `a 30-unit channel spans only ${widest} units`);
  for (const river of riversOf(wide))
    for (const mouth of river.metadata?.mouths ?? []) {
      const patch = mouth.polygon.points;
      const across = Math.hypot(patch[0].x - patch[1].x, patch[0].y - patch[1].y);
      assert.equal(Math.round(across), 30);
    }
  const crossings = wide.roads.flatMap((road) => road.metadata.crossings ?? []);
  for (const crossing of crossings) {
    const river = wide.water.find((region) => region.id === crossing.riverId);
    assert.ok(river, 'a crossing names a river that is not on the map');
    assert.equal(crossing.span, 30, 'the span has to match the channel the road is over');
  }
});
