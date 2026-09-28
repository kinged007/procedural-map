import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const demo = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo');
const app = readFileSync(join(demo, 'app.ts'), 'utf8');
const html = readFileSync(join(demo, 'index.html'), 'utf8');

/** The ids the studio's range loop drives, as written in `demo/app.ts`. */
const ranges = (() => {
  const block = app.slice(app.indexOf('const ranges = ['));
  return [...block.slice(0, block.indexOf(']')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
})();

/** The value an id is shown with, read out of the markup. */
function controlOf(id) {
  const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
  return tag ? { tag, isRange: /type="range"/.test(tag) } : undefined;
}

test('the studio drives the sliders it declares, and every one of them exists', () => {
  assert.ok(ranges.length >= 8, 'the range list is the set of sliders, not a handful of them');
  for (const id of ranges) {
    const control = controlOf(id);
    assert.ok(control, `${id} is in the range list but has no input in the form`);
    assert.ok(
      control.isRange,
      `${id} is in the range list but is not a range input, so it has no badge to write to`,
    );
  }
});

test('every slider has the value badge the range loop writes to', () => {
  // The loop writes `<id>-value` for each id and throws on the first one that is missing, which
  // leaves every slider after it stale with nothing on screen to say so. The badge is not optional
  // decoration: it is the only place a slider's value is shown.
  for (const id of ranges)
    assert.ok(
      html.includes(`id="${id}-value"`),
      `${id} is a slider with no <output id="${id}-value">, so it and every slider after it go stale`,
    );
});

test('a control that shows its value in a box is not in the slider list', () => {
  // A number input already displays its own value. Adding one to the range list does not give it a
  // badge; it removes the badge of every slider below it.
  const valueBoxes = [...html.matchAll(/<input[^>]*class="number-input"[^>]*id="([a-z-]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(valueBoxes.length > 0, 'the studio has number inputs to keep out of the slider list');
  for (const id of valueBoxes)
    assert.ok(!ranges.includes(id), `${id} shows its own value and must not be driven as a slider`);
});
