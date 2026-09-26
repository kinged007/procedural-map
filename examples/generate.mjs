import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { exportMap, generateMap } from '../dist/index.js';

const output = resolve(process.argv[2] ?? 'artifacts/example-map.json');
const map = generateMap({ seed: 583921 });

await mkdir(dirname(output), { recursive: true });
await writeFile(output, exportMap(map));
console.log(`Wrote ${output}`);
