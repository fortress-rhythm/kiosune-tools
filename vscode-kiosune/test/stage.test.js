'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseScript } = require('../src/parser');
const { buildGraph, layoutGraph } = require('../src/graph');
const { renderSceneMap } = require('../src/svg');
const { longStage, stageSummary } = require('../src/stage');

const EXAMPLE = path.join(__dirname, '..', '..', 'examples', 'lamp-room.kio.txt');
const HUB = [
  '@scene Room | fade 900', '@show Laila at left as neutral', '@transition dissolve 400', 'Line.',
  '@label hub', 'Line.', '? Where?', '- The desk -> desk', '- The floor -> floor', '- Leave -> leave',
  '@label desk', '@show Daughter at right as angry', '@transition dissolve 400', 'Line.', '@jump hub',
  '@label floor', '@hide Daughter', '@move Laila to center', '@transition dissolve 400', 'Line.', '@jump hub',
  '@label leave', '@scene Hall | fade 900', 'Line.', '@end Done'
].join('\n');

test('the stage is carried along routes, and a hub sees every combination', () => {
  const g = buildGraph(parseScript(HUB));
  const hub = g.nodes.get('hub');
  assert.deepStrictEqual(hub.stageIn.map(longStage).sort(), [
    'Room | Daughter right (angry) · Laila center (neutral)',
    'Room | Daughter right (angry) · Laila left (neutral)',
    'Room | Laila center (neutral)',
    'Room | Laila left (neutral)'
  ]);
  assert.strictEqual(stageSummary(hub), 'stage varies ×4');
  // a scene without keep clears everyone, whatever the route in
  assert.deepStrictEqual(g.nodes.get('leave').stageOut.map(longStage), ['Hall | nobody']);
  assert.strictEqual(stageSummary(g.nodes.get('«start»')), 'nobody');
});

test('keep holds the actors; @clear and @hide take them off', () => {
  const g = buildGraph(parseScript([
    '@scene A | fade 1', '@show Laila at left', '@show Daughter at 350,284 as sad', '@transition fade 1', 'x',
    '@label b', '@scene B keep | fade 1', 'x', '@label c', '@hide Laila', '@transition fade 1', 'x',
    '@label d', '@clear', '@transition fade 1', 'x', '@end E'
  ].join('\n')));
  assert.strictEqual(longStage(g.nodes.get('b').stageOut[0]), 'B | Daughter 350,284 (sad) · Laila left');
  assert.strictEqual(stageSummary(g.nodes.get('c')), 'Daughter 350,284 · Laila L');
  assert.strictEqual(longStage(g.nodes.get('d').stageIn[0]), 'B | Daughter 350,284 (sad)');
  assert.strictEqual(longStage(g.nodes.get('d').stageOut[0]), 'B | nobody');
});

test('the scene map carries a stage line per node and flags the ones that vary', () => {
  const g = buildGraph(parseScript(HUB));
  const svg = renderSceneMap(layoutGraph(g));
  assert.match(svg, /<text class="meta stage"[^>]*>stage varies ×4<\/text>/);
  assert.match(svg, /class="kio-node stage-varies" data-id="hub"/);
  assert.match(svg, /on stage VARIES by route \(4\)/);
});

test('the example: the scene change clears the stage, the lamp room is settled', () => {
  const g = buildGraph(parseScript(fs.readFileSync(EXAMPLE, 'utf8')));
  // `stairs` changes scene without `keep`, so Tobin leaves with the harbour. The `weather`
  // subroutine shakes the screen but stages nobody, and this tracer continues a plain @call
  // with the caller's stage (see the note at the top of stage.js), so the hub sees one state.
  assert.strictEqual(g.nodes.get('hub_menu').stageIn.length, 1);
  assert.strictEqual(stageSummary(g.nodes.get('hub_menu')), 'Mara L');
  assert.strictEqual(stageSummary(g.nodes.get('end_lit')), 'Mara C');
});
