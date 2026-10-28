'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseScript } = require('../src/parser');
const { buildGraph, layoutGraph } = require('../src/graph');

const EXAMPLE = path.join(__dirname, '..', '..', 'examples', 'lamp-room.kio.txt');
const graphOf = (text) => buildGraph(parseScript(text));
const edgeNames = (g) => g.edges.map((e) => `${e.from}-${e.kind}->${e.to}`);

test('a block runs on into the next label unless something ends it', () => {
  const g = graphOf(['@label a', ': a line', '@label b', '@jump a'].join('\n'));
  assert.ok(edgeNames(g).includes('a-fall->b'));
  assert.ok(edgeNames(g).includes('b-jump->a'));
});

test('a menu whose options all jump does not fall through', () => {
  const g = graphOf(['@label menu', '? pick', '- a -> x', '- b -> y', '@label x', '@end X', '@label y', '@end Y'].join('\n'));
  assert.ok(!edgeNames(g).some((e) => e.startsWith('menu-fall')));
  assert.ok(edgeNames(g).includes('menu-option->x'));
});

test('a menu with a no-arrow option falls through to the block below', () => {
  const g = graphOf(['@label menu', '? pick', '- stay here', '- go -> x', '@label x', '@end X'].join('\n'));
  assert.ok(edgeNames(g).includes('menu-fall->x'));
});

test('@if without else falls through; with else it does not', () => {
  const open = graphOf(['@label a', '@if flag -> b', '@label b', '@end B'].join('\n'));
  assert.ok(edgeNames(open).includes('a-fall->b'));
  const closed = graphOf(['@label a', '@if flag -> b else c', '@label b', '@end B', '@label c', '@end C'].join('\n'));
  assert.ok(!edgeNames(closed).some((e) => e.startsWith('a-fall')));
  assert.ok(edgeNames(closed).includes('a-else->c'));
});

test('a router with an else row is a full fan-out', () => {
  const g = graphOf(['@label hub', '@router', '- turns >= 14 -> late', '- else -> early', '@label late', '@end L', '@label early', '@end E'].join('\n'));
  assert.deepStrictEqual(edgeNames(g).filter((e) => e.startsWith('hub')), ['hub-router->late', 'hub-router->early']);
});

test('@call comes back, so the block keeps going', () => {
  const g = graphOf(['@label a', '@call sub', ': after the call', '@label b', '@end B', '@label sub', ': reaction', '@return'].join('\n'));
  assert.ok(edgeNames(g).includes('a-call->sub'));
  assert.ok(edgeNames(g).includes('a-fall->b'));
  assert.ok(!edgeNames(g).some((e) => e.startsWith('sub-fall')), '@return ends the subroutine');
});

test('a guarded jump does not end the block', () => {
  const g = graphOf(['@label a', '@when late', '@jump b', ': still here', '@label b', '@end B'].join('\n'));
  assert.ok(edgeNames(g).includes('a-fall->b'), 'the unguarded path runs on');
});

test('lines after a jump are flagged as never running', () => {
  const g = graphOf(['@label a', '@jump b', ': orphaned', '@label b', '@end B'].join('\n'));
  assert.deepStrictEqual(g.nodes.get('a').unreachableLines, [2]);
});

test('the background on screen is carried along the edges', () => {
  const g = graphOf([
    '@scene Library · now | fade 900',
    '@jump hub',
    '@label hub',
    '? pick',
    '- back room -> back',
    '- stay -> stay',
    '@label back',
    '@scene Library · back room | fade 900',
    '@end B',
    '@label stay',
    '@end S'
  ].join('\n'));
  assert.strictEqual(g.nodes.get('hub').sceneIn, 'Library · now');
  assert.strictEqual(g.nodes.get('back').sceneOut, 'Library · back room');
  assert.strictEqual(g.nodes.get('stay').sceneIn, 'Library · now');
});

test('a block reached under two backgrounds is marked as varying', () => {
  const g = graphOf([
    '? which way', '- here -> here', '- there -> there',
    '@label here', '@scene A | fade 1', '@jump both',
    '@label there', '@scene B | fade 1', '@jump both',
    '@label both', '@end E'
  ].join('\n'));
  assert.match(g.nodes.get('both').sceneIn, /varies/);
});

test('layout is deterministic, fits every node, and wraps wide ranks', () => {
  const g = buildGraph(parseScript(fs.readFileSync(EXAMPLE, 'utf8')));
  const a = layoutGraph(g);
  const b = layoutGraph(g);
  assert.deepStrictEqual(a.nodes.map((n) => [n.id, n.x, n.y]), b.nodes.map((n) => [n.id, n.x, n.y]));
  assert.strictEqual(a.nodes.length, g.nodes.size);
  for (const node of a.nodes) {
    assert.ok(node.x >= 0 && node.x + node.w <= a.width, `${node.id} inside the canvas`);
    assert.ok(node.y >= 0 && node.y + node.h <= a.height, `${node.id} inside the canvas`);
  }
  const perRow = new Map();
  for (const node of a.nodes) perRow.set(node.y, (perRow.get(node.y) || 0) + 1);
  assert.ok(Math.max(...perRow.values()) <= 7);
  assert.ok(a.edges.every((e) => e.fromNode && e.toNode));
});

test('hiding fall-through edges leaves every other edge alone', () => {
  const g = buildGraph(parseScript(fs.readFileSync(EXAMPLE, 'utf8')));
  const withFall = layoutGraph(g, { showFallthrough: true });
  const without = layoutGraph(g, { showFallthrough: false });
  assert.strictEqual(withFall.edges.length - without.edges.length, g.edges.filter((e) => e.kind === 'fall').length);
});

test('the example threads end to end: every block reachable, every ending live', () => {
  const g = buildGraph(parseScript(fs.readFileSync(EXAMPLE, 'utf8')));
  assert.deepStrictEqual([...g.nodes.values()].filter((n) => !n.reachable).map((n) => n.id), []);
  assert.deepStrictEqual(g.edges.filter((e) => !e.resolved), []);
  assert.deepStrictEqual(g.endings.map((n) => n.endingKey).sort(), ['dark', 'late', 'lit']);
  const stranded = [...g.nodes.values()]
    // A bare @stop ends the chain on purpose (the credits after every ending), so it counts too.
    .filter((n) => !n.out.length && !n.isEnding && !(n.terminal && ['return', 'stop'].includes(n.terminal.kind)));
  assert.deepStrictEqual(stranded.map((n) => n.id), [], 'every block either leads somewhere, ends, stops, or returns');
});
