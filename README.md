# Procedural Map Generator

`@fieldwork/procedural-map` creates deterministic, semantic `GameMap` worlds. It is a Node ESM library with no DOM dependency. The repository also includes a browser map studio for generation, import/export, and debug views.

## Setup

Requires Node.js 22.12 or later.

```sh
npm install
npm run dev
```

`npm run dev` starts the browser studio. Run the full local quality gate with:

```sh
npm run check
```

It runs formatting, linting, type checking, tests, and the demo build.

The same gate runs automatically before every commit, via the hook in `.githooks/`. `core.hooksPath` is set in this repository's git config. Because that setting lives in `.git/config` rather than in a tracked file, a fresh clone needs it enabled once:

```sh
git config core.hooksPath .githooks
```

Build outputs are `dist/` for the library and `dist-demo/` for the browser studio:

```sh
npm run build
```

## Library

Build the library before running Node code against `dist/`.

```js
import { exportMap, generateMap, importMap, validateMap } from './dist/index.js';

const map = generateMap({
  seed: 583921,
  width: 2048,
  height: 1536,
  water: { amount: 0.2 },
  vegetation: { density: 0.65, clustering: 0.8 },
});

const json = exportMap(map);
const restored = importMap(json);
const result = validateMap(restored);

if (!result.valid) throw new Error(result.errors.join('; '));
```

`generateMap(config)` returns a validated, deterministic `GameMap`. `exportMap(map)` returns canonical JSON, `importMap(jsonOrObject)` validates and clones native canonical maps, and `validateMap(value)` returns `{ valid, errors }`.

The Canvas renderer is available from the `@fieldwork/procedural-map/rendering` subpath. Supply it with an HTML canvas and either the built-in `defaultTheme` or a custom `MapTheme`.

```js
import { CanvasRenderer } from '@fieldwork/procedural-map/rendering';
import { defaultTheme } from '@fieldwork/procedural-map';

const renderer = new CanvasRenderer(document.querySelector('canvas'));
renderer.render(map, { theme: defaultTheme, view: 'styled' });
```

See [the architecture](docs/architecture.md), [the GameMap schema](docs/gamemap-schema.md), and [generation](docs/generation.md).
