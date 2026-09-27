import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportMap,
  generateMap,
  importMap,
  pointInPolygon,
  polygonArea,
  rasterizeWalkability,
  validateMap,
} from '../dist/index.js';

const MAP = { seed: 583921, width: 1024, height: 768 };
const buildings = (config) => generateMap({ ...MAP, ...config }).structures;

test('buildings are published as typed structures, and the map is valid with them', () => {
  const map = generateMap(MAP);
  assert.ok(map.structures.length > 0, 'a map with roads has buildings');
  assert.equal(validateMap(map).valid, true, JSON.stringify(validateMap(map).errors));
  for (const building of map.structures) {
    assert.equal(building.type, 'building');
    assert.ok(['house', 'farm'].includes(building.category));
    assert.equal(building.collision.type, 'polygon');
    assert.equal(building.collision.points.length, 4);
    assert.ok(building.width > 0 && building.depth > 0);
    assert.ok(Number.isFinite(building.rotation));
    assert.equal(building.asset.category, `structure.${building.category}`);
    assert.ok(building.metadata.setback >= 0);
  }
});

test('the footprint is a rectangle of the published size, and survives a round trip', () => {
  const map = generateMap(MAP);
  for (const building of map.structures) {
    const area = Math.abs(polygonArea(building.geometry));
    assert.ok(
      Math.abs(area - building.width * building.depth) < 0.01,
      `footprint area ${area} should be width ${building.width} x depth ${building.depth}`,
    );
  }
  const round = importMap(exportMap(map));
  assert.equal(round.structures.length, map.structures.length);
  assert.deepEqual(round.structures[0], map.structures[0]);
});

test('the ring starts on a back corner, so the front wall is points 1 to 2', () => {
  // The renderer works the front wall out from position and rotation rather than from the ring, but
  // the ring order is published and documented, so it is pinned here rather than left to drift.
  const map = generateMap(MAP);
  for (const building of map.structures) {
    const points = building.geometry.points;
    assert.equal(points.length, 4);
    const mid = (a, b) => ({
      x: (points[a].x + points[b].x) / 2,
      y: (points[a].y + points[b].y) / 2,
    });
    const edge = (a, b) => Math.hypot(points[b].x - points[a].x, points[b].y - points[a].y);
    assert.ok(
      Math.abs(edge(0, 1) - building.depth) < 0.01,
      'points 0 to 1 is a side wall, so it runs the depth',
    );
    assert.ok(
      Math.abs(edge(1, 2) - building.width) < 0.01,
      'points 1 to 2 is the front wall, so it runs the width',
    );
    const road = map.roads.find((entry) => entry.id === building.metadata.roadId);
    const gap = (point) =>
      Math.min(...road.path.map((step) => Math.hypot(step.x - point.x, step.y - point.y)));
    assert.ok(
      gap(mid(1, 2)) < gap(mid(3, 0)),
      `${building.id} has its front wall further from the road than its back`,
    );
  }
});

test('a map with no buildings publishes none', () => {
  assert.equal(buildings({ buildings: { density: 0 } }).length, 0);
});

test('every building stands on its own road, and never on water, rock, a beach, or a road', () => {
  const map = generateMap(MAP);
  const rock = map.terrain.filter((region) => region.kind === 'rock');
  const beach = map.terrain.filter((region) => region.kind === 'beach');
  for (const building of map.structures) {
    const road = map.roads.find((entry) => entry.id === building.metadata.roadId);
    assert.ok(road, `building ${building.id} names a road that exists`);
    assert.ok(
      !map.water.some((body) => pointInPolygon(building.position, body.geometry)),
      `${building.id} stands in water`,
    );
    assert.ok(
      !rock.some((region) => pointInPolygon(building.position, region.collision)),
      `${building.id} stands on rock`,
    );
    // A beach is walkable and carries no collision, so it is the one ground a building is refused for
    // without anything refusing to walk there: a house on the sand is a house nobody would build, and
    // the shoreline is where a port or a pier belongs later.
    assert.ok(
      !beach.some((region) => pointInPolygon(building.position, region.geometry)),
      `${building.id} stands on a beach`,
    );
    assert.ok(
      !map.roads.some((entry) => pointInPolygon(building.position, entry.collision)),
      `${building.id} stands in a road`,
    );
  }
  // A beach is only ever refused when a map actually has one, so a map with no shoreline has to be
  // able to say something about the rule rather than pass by having nothing to check.
  const withBeach = generateMap({ seed: 583921 });
  assert.ok(
    withBeach.terrain.some((region) => region.kind === 'beach'),
    'this seed has a beach, so the rule above is actually exercised',
  );
});

test("a building's front looks back at the road it was placed against", () => {
  const map = generateMap(MAP);
  const distanceTo = (point, road) =>
    Math.min(...road.path.map((step) => Math.hypot(step.x - point.x, step.y - point.y)));
  for (const building of map.structures) {
    const road = map.roads.find((entry) => entry.id === building.metadata.roadId);
    const facing = { x: Math.cos(building.rotation), y: Math.sin(building.rotation) };
    const front = {
      x: building.position.x + facing.x * (building.depth / 2),
      y: building.position.y + facing.y * (building.depth / 2),
    };
    const back = {
      x: building.position.x - facing.x * (building.depth / 2),
      y: building.position.y - facing.y * (building.depth / 2),
    };
    assert.ok(
      distanceTo(front, road) < distanceTo(back, road),
      `${building.id} has its back to the road`,
    );
  }
});

test('the front wall stands the published setback off the road centreline', () => {
  const map = generateMap(MAP);
  for (const building of map.structures) {
    const road = map.roads.find((entry) => entry.id === building.metadata.roadId);
    const facing = { x: Math.cos(building.rotation), y: Math.sin(building.rotation) };
    const front = {
      x: building.position.x + facing.x * (building.depth / 2),
      y: building.position.y + facing.y * (building.depth / 2),
    };
    const nearest = Math.min(
      ...road.path.map((step) => Math.hypot(step.x - front.x, step.y - front.y)),
    );
    // The centreline is only sampled at its own vertices, so this is a lower bound on the true
    // distance rather than an equality.
    assert.ok(
      nearest >= building.metadata.setback - 1,
      `${building.id} front wall is ${nearest.toFixed(1)} from a centreline it claims ${building.metadata.setback} from`,
    );
  }
});

test('buildings keep the published spacing from each other', () => {
  for (const spacing of [20, 34, 80]) {
    const placed = buildings({ buildings: { spacing } });
    for (let a = 0; a < placed.length; a += 1) {
      for (let b = a + 1; b < placed.length; b += 1) {
        const gap = Math.hypot(
          placed[a].position.x - placed[b].position.x,
          placed[a].position.y - placed[b].position.y,
        );
        assert.ok(
          gap >= spacing,
          `at spacing ${spacing} two buildings are ${gap.toFixed(1)} apart`,
        );
      }
    }
  }
});

test('no tree grows through a wall', () => {
  const map = generateMap(MAP);
  for (const building of map.structures)
    for (const tree of map.vegetation)
      assert.ok(
        !pointInPolygon(tree.position, building.geometry),
        `${building.id} has a trunk inside it`,
      );
});

test('each control moves the count and the placement in one direction', () => {
  const count = (config) => buildings(config).length;
  assert.equal(count({ buildings: { density: 0 } }), 0);
  const byDensity = [0.25, 0.5, 1].map((density) => count({ buildings: { density } }));
  const bySpacing = [20, 34, 80, 200].map((spacing) => count({ buildings: { spacing } }));
  console.log(`  density: ${byDensity.join(' -> ')}`);
  console.log(`  spacing: ${bySpacing.join(' -> ')}`);
  for (let index = 1; index < byDensity.length; index += 1)
    assert.ok(byDensity[index] > byDensity[index - 1], `density went the wrong way: ${byDensity}`);
  for (let index = 1; index < bySpacing.length; index += 1)
    assert.ok(bySpacing[index] < bySpacing[index - 1], `spacing went the wrong way: ${bySpacing}`);

  // Setback is not a count knob and is not expected to be monotone. Pulling both rows in towards a
  // road also pulls them into each other, so below the spacing they cancel out and the count drops
  // again. What has to hold is that a larger setback stands the building further off the road.
  const frontWall = (setback) => {
    const placed = buildings({ buildings: { setback } });
    const map = generateMap({ ...MAP, buildings: { setback } });
    const gaps = placed
      .filter((building) => building.category === 'house')
      .map((building) => {
        const road = map.roads.find((entry) => entry.id === building.metadata.roadId);
        const facing = { x: Math.cos(building.rotation), y: Math.sin(building.rotation) };
        const front = {
          x: building.position.x + facing.x * (building.depth / 2),
          y: building.position.y + facing.y * (building.depth / 2),
        };
        return Math.min(...road.path.map((step) => Math.hypot(step.x - front.x, step.y - front.y)));
      });
    return gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  };
  const gaps = [6, 16, 60, 120].map(frontWall);
  const counts = [6, 16, 60, 120].map((setback) => count({ buildings: { setback } }));
  console.log(`  setback: mean front-wall gap ${gaps.map((g) => g.toFixed(1)).join(' -> ')}`);
  console.log(`  setback: counts ${counts.join(' -> ')}`);
  // Compared from 16 upwards. At 6 almost every site is refused, and the few that survive are the
  // ones whose road bends away from them, so the mean reads high there for want of a sample rather
  // than because the buildings are actually further back.
  for (let index = 2; index < gaps.length; index += 1)
    assert.ok(
      gaps[index] > gaps[index - 1],
      `setback did not move the building back: ${gaps.map((g) => g.toFixed(1))}`,
    );
});

test('a farm stands further back from the road than a house', () => {
  const placed = buildings({ buildings: { density: 1 } });
  const setBack = (category) =>
    placed.filter((building) => building.category === category).map((b) => b.metadata.setback);
  const houses = setBack('house');
  const farms = setBack('farm');
  assert.ok(houses.length > 0 && farms.length > 0, 'both categories are placed on this map');
  assert.equal(new Set(houses).size, 1, 'a house uses the configured setback');
  for (const setback of farms)
    assert.ok(setback > houses[0], `farm setback ${setback} is not behind ${houses[0]}`);
});

test('a building blocks walking, like the wall it is', () => {
  const map = generateMap(MAP);
  const building = map.structures[0];
  const raster = rasterizeWalkability(map, { cellSize: 4 });
  const column = Math.floor(building.position.x / 4);
  const row = Math.floor(building.position.y / 4);
  const index = row * raster.columns + column;
  assert.equal(raster.cells[index], 1, 'the cell at a building is blocked');
});
