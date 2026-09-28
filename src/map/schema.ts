const jsonValue = {
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: { $ref: '#/$defs/jsonValue' } },
    { type: 'object', additionalProperties: { $ref: '#/$defs/jsonValue' } },
  ],
} as const;

export const gameMapSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://procedural-map-mvp.dev/schemas/game-map-1.4.json',
  title: 'GameMap v1.4',
  description:
    'A forest carries no collision, and a settlement carries none either. A forest geometry is a hull for broadphase, rendering and a minimap, and it deliberately over-covers the clearings between trees so that a consumer can test one bounds box instead of every tree on the map. A settlement radius is a statement about where a place ends, not a wall: it claims buildings by proximity and a consumer wanting the ground it covers tests the distance itself. A settlement with no buildings is a settlement, which is what a dead one is. A dock carries no collision either, for the opposite reason to a building: a deck is ground a character walks on rather than a wall, and the walkability raster carves the water it covers back open. A resource site carries none for a third reason: it is a mark on the ground saying this is worth building on, and not a thing standing there.',
  type: 'object',
  required: [
    'version',
    'metadata',
    'bounds',
    'terrain',
    'water',
    'vegetation',
    'forests',
    'structures',
    'settlements',
    'docks',
    'resourceSites',
    'roads',
    'barriers',
  ],
  properties: {
    version: { const: '1.4' },
    metadata: { $ref: '#/$defs/mapMetadata' },
    bounds: { $ref: '#/$defs/bounds' },
    terrain: { type: 'array', items: { $ref: '#/$defs/terrain' } },
    water: { type: 'array', items: { $ref: '#/$defs/water' } },
    vegetation: { type: 'array', items: { $ref: '#/$defs/tree' } },
    forests: { type: 'array', items: { $ref: '#/$defs/forest' } },
    structures: { type: 'array', items: { $ref: '#/$defs/building' } },
    settlements: { type: 'array', items: { $ref: '#/$defs/settlement' } },
    docks: { type: 'array', items: { $ref: '#/$defs/dock' } },
    resourceSites: { type: 'array', items: { $ref: '#/$defs/resourceSite' } },
    roads: { type: 'array', items: { $ref: '#/$defs/road' } },
    barriers: { type: 'array', items: { $ref: '#/$defs/entity' } },
    metadataLayers: { $ref: '#/$defs/metadataLayers' },
  },
  additionalProperties: { $ref: '#/$defs/jsonValue' },
  $defs: {
    jsonValue,
    bounds: {
      type: 'object',
      required: ['width', 'height'],
      properties: {
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
      },
      additionalProperties: { $ref: '#/$defs/jsonValue' },
    },
    point: {
      type: 'object',
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      additionalProperties: { $ref: '#/$defs/jsonValue' },
    },
    ring: { type: 'array', minItems: 3, maxItems: 32768, items: { $ref: '#/$defs/point' } },
    polygon: {
      type: 'object',
      required: ['points'],
      properties: {
        points: { $ref: '#/$defs/ring' },
        holes: { type: 'array', maxItems: 4096, items: { $ref: '#/$defs/ring' } },
      },
      additionalProperties: { $ref: '#/$defs/jsonValue' },
    },
    asset: {
      type: 'object',
      required: ['category', 'variant'],
      properties: {
        category: { type: 'string', minLength: 1 },
        variant: { type: 'string', minLength: 1 },
      },
      additionalProperties: { $ref: '#/$defs/jsonValue' },
    },
    collision: {
      oneOf: [
        {
          type: 'object',
          required: ['type', 'center', 'radius'],
          properties: {
            type: { const: 'circle' },
            center: { $ref: '#/$defs/point' },
            radius: { type: 'number', exclusiveMinimum: 0 },
          },
          additionalProperties: { $ref: '#/$defs/jsonValue' },
        },
        {
          allOf: [
            { $ref: '#/$defs/polygon' },
            { type: 'object', required: ['type'], properties: { type: { const: 'polygon' } } },
          ],
        },
        {
          type: 'object',
          required: ['type', 'x', 'y', 'width', 'height'],
          properties: {
            type: { const: 'rectangle' },
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number', exclusiveMinimum: 0 },
            height: { type: 'number', exclusiveMinimum: 0 },
          },
          additionalProperties: { $ref: '#/$defs/jsonValue' },
        },
      ],
    },
    entity: {
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        position: { $ref: '#/$defs/point' },
        rotation: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        collision: { $ref: '#/$defs/collision' },
        geometry: { $ref: '#/$defs/polygon' },
        asset: { $ref: '#/$defs/asset' },
        metadata: { type: 'object', additionalProperties: { $ref: '#/$defs/jsonValue' } },
      },
      additionalProperties: { $ref: '#/$defs/jsonValue' },
    },
    terrain: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: ['kind', 'geometry'],
          properties: {
            type: { const: 'terrain' },
            kind: { enum: ['grass', 'meadow', 'scrub', 'rock', 'beach'] },
            geometry: { $ref: '#/$defs/polygon' },
            collision: {
              allOf: [
                { $ref: '#/$defs/polygon' },
                { type: 'object', required: ['type'], properties: { type: { const: 'polygon' } } },
              ],
            },
          },
        },
      ],
    },
    settlement: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: ['type', 'kind', 'position', 'radius', 'clearing', 'metadata'],
          properties: {
            type: { const: 'settlement' },
            kind: { enum: ['hamlet', 'village', 'town'] },
            radius: { type: 'number', exclusiveMinimum: 0 },
            // The open ground at the middle of the place, on which a consumer may build.
            clearing: { $ref: '#/$defs/polygon' },
            metadata: {
              type: 'object',
              required: ['buildingIds'],
              properties: {
                // Empty on purpose: a settlement nobody built in is still a settlement.
                buildingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
              },
              additionalProperties: { $ref: '#/$defs/jsonValue' },
            },
          },
        },
      ],
    },
    building: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: [
            'type',
            'category',
            'state',
            'position',
            'rotation',
            'width',
            'depth',
            'geometry',
            'asset',
            'metadata',
          ],
          properties: {
            type: { const: 'building' },
            category: { enum: ['house', 'farm'] },
            state: { enum: ['standing', 'ruined'] },
            width: { type: 'number', exclusiveMinimum: 0 },
            depth: { type: 'number', exclusiveMinimum: 0 },
            geometry: { $ref: '#/$defs/polygon' },
            collision: {
              allOf: [
                { $ref: '#/$defs/polygon' },
                { type: 'object', required: ['type'], properties: { type: { const: 'polygon' } } },
              ],
            },
            metadata: {
              type: 'object',
              required: ['setback'],
              properties: {
                roadId: { type: 'string', minLength: 1 },
                setback: { type: 'number', minimum: 0 },
              },
              additionalProperties: { $ref: '#/$defs/jsonValue' },
            },
          },
          // A standing building is a wall and a ruin is rubble you walk over, so collision is
          // required of the first and forbidden of the second. Making it conditional rather than
          // optional is what stops a map that omits it from reading as a field of walkable ruins.
          allOf: [
            {
              if: { properties: { state: { const: 'standing' } }, required: ['state'] },
              then: { required: ['collision'] },
              else: { not: { required: ['collision'] } },
            },
          ],
        },
      ],
    },
    dock: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: ['type', 'position', 'rotation', 'width', 'depth', 'geometry', 'metadata'],
          properties: {
            type: { const: 'dock' },
            width: { type: 'number', exclusiveMinimum: 0 },
            depth: { type: 'number', exclusiveMinimum: 0 },
            geometry: { $ref: '#/$defs/polygon' },
            metadata: {
              type: 'object',
              required: ['settlementId', 'waterId'],
              properties: {
                roadId: { type: 'string', minLength: 1 },
                settlementId: { type: 'string', minLength: 1 },
                waterId: { type: 'string', minLength: 1 },
              },
              additionalProperties: { $ref: '#/$defs/jsonValue' },
            },
          },
          // A deck is ground a character walks on, so it must not carry a collision. A dock that
          // blocked movement would be the opposite of what it is, which is the same reason a forest
          // hull carries none: both are surfaces, and neither is a wall.
          not: { required: ['collision'] },
        },
      ],
    },
    resourceSite: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: ['type', 'kind', 'position', 'metadata'],
          properties: {
            type: { const: 'resource-site' },
            kind: { enum: ['mine', 'fishing', 'hunting'] },
            rotation: { type: 'number' },
            metadata: {
              type: 'object',
              properties: {
                rockId: { type: 'string', minLength: 1 },
                waterId: { type: 'string', minLength: 1 },
                forestId: { type: 'string', minLength: 1 },
                distanceToShore: { type: 'number', minimum: 0 },
                access: { enum: ['land', 'water'] },
              },
              additionalProperties: { $ref: '#/$defs/jsonValue' },
            },
          },
          allOf: [
            {
              // A mine is a mouth in a rock face, so it names the rock and carries the direction the
              // entrance faces. `rotation` is absent on the other two kinds, which have no facing:
              // there is nothing to point out of a wood, and a fishing spot is in the water rather
              // than on a wall.
              if: { properties: { kind: { const: 'mine' } }, required: ['kind'] },
              then: { required: ['rotation'] },
            },
            {
              if: { properties: { kind: { const: 'mine' } }, required: ['kind'] },
              then: {
                properties: { metadata: { required: ['rockId'] } },
              },
              else: { properties: { not: { required: ['rotation'] } } },
            },
            {
              // A fishing spot is in water and says how far out it is, which is the number a
              // consumer that disagrees with `access` reads instead of taking the verdict on trust.
              if: { properties: { kind: { const: 'fishing' } }, required: ['kind'] },
              then: {
                properties: {
                  metadata: { required: ['waterId', 'distanceToShore', 'access'] },
                },
              },
            },
            {
              if: { properties: { kind: { const: 'hunting' } }, required: ['kind'] },
              then: { properties: { metadata: { required: ['forestId'] } } },
            },
          ],
          // A site is a mark on the ground, not an obstacle, so it carries no collision. The same
          // reason a forest hull, a settlement and a dock carry none.
          not: { required: ['collision'] },
        },
      ],
    },
    road: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: ['kind', 'path', 'width', 'collision'],
          properties: {
            type: { const: 'road' },
            kind: { enum: ['primary', 'secondary', 'path'] },
            path: { type: 'array', minItems: 2, items: { $ref: '#/$defs/point' } },
            width: { type: 'number', exclusiveMinimum: 0 },
            collision: {
              allOf: [
                { $ref: '#/$defs/polygon' },
                { type: 'object', required: ['type'], properties: { type: { const: 'polygon' } } },
              ],
            },
          },
        },
      ],
    },
    water: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: ['kind', 'geometry', 'collision'],
          properties: {
            type: { const: 'water' },
            kind: { enum: ['lake', 'river'] },
            geometry: { $ref: '#/$defs/polygon' },
            collision: {
              allOf: [
                { $ref: '#/$defs/polygon' },
                { type: 'object', required: ['type'], properties: { type: { const: 'polygon' } } },
              ],
            },
          },
        },
      ],
    },
    tree: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: ['species', 'position', 'radius', 'collision'],
          properties: {
            type: { const: 'tree' },
            species: { type: 'string', minLength: 1 },
            position: { $ref: '#/$defs/point' },
            radius: { type: 'number', exclusiveMinimum: 0 },
            collision: {
              type: 'object',
              required: ['type', 'center', 'radius'],
              properties: {
                type: { const: 'circle' },
                center: { $ref: '#/$defs/point' },
                radius: { type: 'number', exclusiveMinimum: 0 },
              },
            },
          },
        },
      ],
    },
    forest: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          // Collision is listed as forbidden rather than merely omitted, so a consumer that assumes
          // every blocking feature carries one fails loudly on a forest rather than treating a hull
          // as a wall. The circles in `trees` are what block.
          required: ['species', 'geometry', 'trees', 'asset', 'metadata'],
          not: { required: ['collision'] },
          properties: {
            type: { const: 'forest' },
            species: { enum: ['mixed', 'oak', 'birch'] },
            geometry: { $ref: '#/$defs/polygon' },
            trees: { type: 'array', minItems: 2, items: { $ref: '#/$defs/tree' } },
            asset: { $ref: '#/$defs/asset' },
            metadata: {
              type: 'object',
              required: ['treeCount', 'densityPct', 'walkableInside'],
              properties: {
                treeCount: { type: 'integer', minimum: 2 },
                densityPct: { type: 'number', minimum: 0 },
                walkableInside: { type: 'boolean' },
              },
              additionalProperties: { $ref: '#/$defs/jsonValue' },
            },
          },
        },
      ],
    },
    spatialFields: {
      type: 'object',
      required: ['columns', 'rows', 'terrain', 'elevation', 'moisture', 'vegetation'],
      properties: {
        columns: { type: 'integer', exclusiveMinimum: 0 },
        rows: { type: 'integer', exclusiveMinimum: 0 },
        terrain: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 } },
        elevation: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 } },
        moisture: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 } },
        vegetation: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 } },
      },
      additionalProperties: { $ref: '#/$defs/jsonValue' },
    },
    metadataLayers: {
      type: 'object',
      properties: { fields: { $ref: '#/$defs/spatialFields' } },
      additionalProperties: { $ref: '#/$defs/jsonValue' },
    },
    mapMetadata: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        seed: { type: 'number' },
        generator: { type: 'string' },
        generatedAt: { type: 'string' },
      },
      additionalProperties: { $ref: '#/$defs/jsonValue' },
    },
  },
} as const;
