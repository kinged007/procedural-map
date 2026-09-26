import { DEFAULT_CONFIG, exportMap, generateMap, importMap } from '../src/index.js';
import type { GameMap, GenerationConfig, Point, ResolvedGenerationConfig } from '../src/index.js';
import { polygonArea } from '../src/map/geometry.js';
import { CanvasRenderer } from '../src/rendering/CanvasRenderer.js';
import type { MapView } from '../src/rendering/CanvasRenderer.js';
import { resolveGenerationConfig } from '../src/generation/MapGenerator.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}

const canvas = element<HTMLCanvasElement>('map-canvas');
const renderer = new CanvasRenderer(canvas);
const form = element<HTMLFormElement>('generation-form');
const fileInput = element<HTMLInputElement>('import-file');
const sizeInput = element<HTMLSelectElement>('map-size');
const seedInput = element<HTMLInputElement>('seed');
const generateButton = element<HTMLButtonElement>('generate-button');
const exportButton = element<HTMLButtonElement>('export-button');
const importButton = element<HTMLButtonElement>('import-button');
const ranges = ['density', 'water', 'variation', 'clustering', 'roads'] as const;
const numberFormat = new Intl.NumberFormat('en');
const descriptions: Record<MapView, string> = {
  styled: 'Grassland, open water & clustered woodland',
  terrain: 'Terrain variation · light to dark',
  elevation: 'Elevation · low teal to high cream',
  moisture: 'Moisture · dry cream to wet blue',
  vegetation: 'Forest probability · low cream to high green',
  water: 'Canonical water polygons, including islands',
  collision: 'Obstacle geometry · outlined in terracotta',
  entities: 'Individual entity positions in world coordinates',
};

let map: GameMap | undefined;
let view: MapView = 'styled';
let zoom = 1;
let pan: Point = { x: 0, y: 0 };
let busy = false;
let frame: number | undefined;
let dragging: { x: number; y: number; pan: Point; pointerId: number } | undefined;

function notify(message: string, error = false) {
  const notification = element('notification');
  notification.textContent = message;
  notification.classList.toggle('error', error);
  notification.hidden = false;
}

function setBusy(value: boolean) {
  busy = value;
  generateButton.disabled = value;
  importButton.disabled = value;
  exportButton.disabled = value || !map;
  element<HTMLButtonElement>('random-seed').disabled = value;
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    button.disabled = value;
  });
  generateButton.querySelector('span')!.textContent = value
    ? 'Preparing landscape…'
    : 'Generate landscape';
  element('map-viewport').setAttribute('aria-busy', String(value));
}

function refreshRanges() {
  for (const id of ranges) {
    const input = element<HTMLInputElement>(id);
    input.style.setProperty('--progress', `${input.value}%`);
    element<HTMLOutputElement>(`${id}-value`).value = `${input.value}%`;
  }
}

function configFromControls(): GenerationConfig {
  const [width, height] = sizeInput.value.split('x').map(Number);
  return {
    seed: seedInput.valueAsNumber,
    width,
    height,
    terrain: {
      variation: element<HTMLInputElement>('variation').valueAsNumber / 100,
      scale: element<HTMLInputElement>('terrain-scale').valueAsNumber,
    },
    water: {
      amount: element<HTMLInputElement>('water').valueAsNumber / 100,
      scale: element<HTMLInputElement>('water-scale').valueAsNumber,
    },
    vegetation: {
      density: element<HTMLInputElement>('density').valueAsNumber / 100,
      clustering: element<HTMLInputElement>('clustering').valueAsNumber / 100,
    },
    roads: { density: element<HTMLInputElement>('roads').valueAsNumber / 100 },
  };
}

function updateControls(config: ResolvedGenerationConfig) {
  seedInput.value = String(config.seed);
  const size = `${config.width}x${config.height}`;
  if (![...sizeInput.options].some((option) => option.value === size)) {
    sizeInput.add(new Option(`Custom · ${config.width} × ${config.height}`, size));
  }
  sizeInput.value = size;
  element<HTMLInputElement>('density').value = String(config.vegetation.density * 100);
  element<HTMLInputElement>('water').value = String(config.water.amount * 100);
  element<HTMLInputElement>('variation').value = String(config.terrain.variation * 100);
  element<HTMLInputElement>('clustering').value = String(config.vegetation.clustering * 100);
  element<HTMLInputElement>('roads').value = String(config.roads.density * 100);
  element<HTMLInputElement>('terrain-scale').value = String(config.terrain.scale);
  element<HTMLInputElement>('water-scale').value = String(config.water.scale);
  refreshRanges();
}

function requestRender() {
  if (frame !== undefined) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    if (!map) return;
    renderer.render(map, { view, zoom, pan });
    element<HTMLOutputElement>('zoom-value').value = `${Math.round(zoom * 100)}%`;
    element('empty-field').hidden =
      !!map.metadataLayers?.fields ||
      !['terrain', 'elevation', 'moisture', 'vegetation'].includes(view);
  });
}

function fit() {
  zoom = 1;
  pan = { x: 0, y: 0 };
  requestRender();
}

function showMap(nextMap: GameMap, source: string, elapsed?: number) {
  map = nextMap;
  const { width, height } = map.bounds;
  element('tree-count').textContent = numberFormat.format(map.vegetation.length);
  element('lake-count').textContent = numberFormat.format(map.water.length);
  const coverage =
    (map.water.reduce((total, lake) => total + polygonArea(lake.geometry), 0) / (width * height)) *
    100;
  element('water-coverage').textContent = `${coverage.toFixed(1)}%`;
  element('dimensions-display').textContent =
    `${numberFormat.format(width)} × ${numberFormat.format(height)} units`;
  element('seed-display').textContent =
    map.metadata.seed !== undefined ? `SEED ${map.metadata.seed}` : 'AUTHORED MAP';
  element('map-source').textContent = source;
  element('map-status-text').textContent =
    elapsed === undefined ? 'Imported · validated' : `Generated in ${Math.round(elapsed)} ms`;
  canvas.setAttribute(
    'aria-label',
    `Landscape with ${map.vegetation.length} trees and ${map.water.length} water bodies. ${width} by ${height} world units. Drag to pan; use plus and minus to zoom.`,
  );
  element('generation-note').textContent =
    elapsed === undefined
      ? 'Imported map is ready to export.'
      : 'Landscape generated and validated.';
  exportButton.disabled = false;
  fit();
}

async function generate() {
  if (busy || !form.reportValidity()) return;
  const config = configFromControls();
  setBusy(true);
  element('notification').hidden = true;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    }),
  );
  try {
    const start = performance.now();
    const nextMap = generateMap(config);
    showMap(nextMap, 'PROCEDURAL', performance.now() - start);
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Unable to generate this map.', true);
    element('generation-note').textContent = 'Check your settings and try again.';
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void generate();
});
form.addEventListener('input', () => {
  refreshRanges();
  element('generation-note').textContent = 'Settings changed. Generate to apply.';
});

element('random-seed').addEventListener('click', () => {
  seedInput.value = String(crypto.getRandomValues(new Uint32Array(1))[0]);
  void generate();
});

const presets = {
  woodland: { density: 0.85, water: 0.12, variation: 0.5, clustering: 0.85 },
  wetlands: { density: 0.45, water: 0.48, variation: 0.3, clustering: 0.7 },
  grassland: { density: 0.15, water: 0.06, variation: 0.25, clustering: 0.55 },
};
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const preset = presets[button.dataset.preset as keyof typeof presets];
    updateControls({
      ...DEFAULT_CONFIG,
      seed: Number.isInteger(seedInput.valueAsNumber)
        ? seedInput.valueAsNumber
        : DEFAULT_CONFIG.seed,
      width: Number(sizeInput.value.split('x')[0]),
      height: Number(sizeInput.value.split('x')[1]),
      vegetation: { density: preset.density, clustering: preset.clustering },
      water: { ...DEFAULT_CONFIG.water, amount: preset.water },
      terrain: { ...DEFAULT_CONFIG.terrain, variation: preset.variation },
    });
    void generate();
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    view = button.dataset.view as MapView;
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
    element('view-description').textContent = descriptions[view];
    requestRender();
  });
});

exportButton.addEventListener('click', () => {
  if (!map) return;
  try {
    const blob = new Blob([exportMap(map)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `map-${map.metadata.seed ?? 'imported'}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Map exported as GameMap 1.0 JSON. Import this file to restore the same landscape.');
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Unable to export this map.', true);
  }
});

importButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file || busy) return;
  setBusy(true);
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Choose a JSON map smaller than 20 MB.');
    const imported = importMap(await file.text());
    showMap(imported, 'IMPORTED');
    const savedConfig = imported.metadataLayers?.generation;
    if (savedConfig && typeof savedConfig === 'object') {
      try {
        const config = resolveGenerationConfig(savedConfig as GenerationConfig);
        if (
          config.width === imported.bounds.width &&
          config.height === imported.bounds.height &&
          config.seed === imported.metadata.seed
        )
          updateControls(config);
      } catch {
        element('generation-note').textContent =
          'Imported world. Controls apply to a new generation.';
      }
    }
    notify(`Imported ${file.name}. All map geometry and assets were preserved.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to import this file.';
    notify(message.length > 600 ? `${message.slice(0, 600)}…` : message, true);
  } finally {
    fileInput.value = '';
    setBusy(false);
  }
});

function changeZoom(factor: number, anchor?: Point) {
  const next = Math.max(0.5, Math.min(4, zoom * factor));
  const ratio = next / zoom;
  const rect = canvas.getBoundingClientRect();
  const relative = anchor
    ? { x: anchor.x - rect.width / 2, y: anchor.y - rect.height / 2 }
    : { x: 0, y: 0 };
  pan = {
    x: relative.x - (relative.x - pan.x) * ratio,
    y: relative.y - (relative.y - pan.y) * ratio,
  };
  zoom = next;
  requestRender();
}

element('zoom-in').addEventListener('click', () => changeZoom(1.25));
element('zoom-out').addEventListener('click', () => changeZoom(0.8));
const focusButton = element<HTMLButtonElement>('fit-map');
function setFocusMode(on: boolean) {
  document.body.classList.toggle('map-focus', on);
  focusButton.classList.toggle('active', on);
  focusButton.setAttribute('aria-pressed', String(on));
  const label = on ? 'Exit full screen map' : 'Full screen map';
  focusButton.title = label;
  focusButton.setAttribute('aria-label', label);
}
focusButton.addEventListener('click', () => {
  setFocusMode(!document.body.classList.contains('map-focus'));
  requestRender();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('map-focus')) {
    setFocusMode(false);
    focusButton.focus();
  }
});
canvas.addEventListener('dblclick', fit);
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    changeZoom(Math.exp(-event.deltaY * 0.001), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  },
  { passive: false },
);
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = { x: event.clientX, y: event.clientY, pan: { ...pan }, pointerId: event.pointerId };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (event) => {
  const rect = canvas.getBoundingClientRect();
  if (dragging && dragging.pointerId === event.pointerId) {
    pan = {
      x: dragging.pan.x + event.clientX - dragging.x,
      y: dragging.pan.y + event.clientY - dragging.y,
    };
    requestRender();
  }
  const point = renderer.worldPoint(event.clientX - rect.left, event.clientY - rect.top);
  const inside =
    map &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= map.bounds.width &&
    point.y <= map.bounds.height;
  element('coordinates').textContent = inside
    ? `X ${Math.round(point.x)}  Y ${Math.round(point.y)}`
    : 'X —  Y —';
});
function stopDragging() {
  dragging = undefined;
  canvas.classList.remove('dragging');
}
canvas.addEventListener('pointerup', stopDragging);
canvas.addEventListener('pointercancel', stopDragging);
canvas.addEventListener('lostpointercapture', stopDragging);
canvas.addEventListener('keydown', (event) => {
  if (event.key === '+' || event.key === '=') changeZoom(1.25);
  else if (event.key === '-') changeZoom(0.8);
  else if (event.key === '0' || event.key === 'Home') fit();
  else if (event.key.startsWith('Arrow')) {
    pan.x += event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0;
    pan.y += event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0;
    requestRender();
  } else return;
  event.preventDefault();
});

new ResizeObserver(requestRender).observe(element('map-viewport'));
refreshRanges();
void generate();
