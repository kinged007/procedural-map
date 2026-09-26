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
  $id: 'https://procedural-map-mvp.dev/schemas/game-map-1.0.json',
  title: 'GameMap v1.0',
  type: 'object',
  required: [
    'version',
    'metadata',
    'bounds',
    'terrain',
    'water',
    'vegetation',
    'structures',
    'roads',
    'barriers',
  ],
  properties: {
    version: { const: '1.0' },
    metadata: { $ref: '#/$defs/mapMetadata' },
    bounds: { $ref: '#/$defs/bounds' },
    terrain: { type: 'array', items: { $ref: '#/$defs/terrain' } },
    water: { type: 'array', items: { $ref: '#/$defs/water' } },
    vegetation: { type: 'array', items: { $ref: '#/$defs/tree' } },
    structures: { type: 'array', items: { $ref: '#/$defs/entity' } },
    roads: { type: 'array', items: { $ref: '#/$defs/entity' } },
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
    water: {
      allOf: [
        { $ref: '#/$defs/entity' },
        {
          type: 'object',
          required: ['kind', 'geometry', 'collision'],
          properties: {
            type: { const: 'water' },
            kind: { const: 'lake' },
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
