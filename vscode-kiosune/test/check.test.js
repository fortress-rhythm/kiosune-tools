'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseScript } = require('../src/parser');
const { buildGraph } = require('../src/graph');
const { checkScript } = require('../src/check');

const EXAMPLE = path.join(__dirname, '..', '..', 'examples', 'lamp-room.kio.txt');

function check(text, options) {
  const script = parseScript(text);
  return checkScript(script, buildGraph(script), { placeholders: 'off', ...options });
}
const codes = (findings) => findings.map((f) => f.code);

test('a blank line between ? and its options is an error', () => {
  const found = check(['? which one', '', '- a -> x', '- b -> x', '@label x', '@end Done'].join('\n'));
  const hit = found.find((f) => f.code === 'choice-interrupted');
  assert.ok(hit, 'expected choice-interrupted');
  assert.strictEqual(hit.severity, 'error');
  assert.strictEqual(hit.line, 1);
});

test('a comment between ? and its options is an error too', () => {
  const found = check(['? which one', '# BEAT: think', '- a -> x', '@label x', '@end Done'].join('\n'));
  assert.ok(codes(found).includes('choice-interrupted'));
});

test('a timer target shifted by a conditional option above it', () => {
  const bad = check([
    '? say something  [timer 9000 3]',
    '- honest -> a [if trust > 0]',
    '- push -> a',
    '- silence -> a',
    '@label a', '@end Done'
  ].join('\n'));
  const hit = bad.find((f) => f.code === 'timer-index');
  assert.ok(hit, 'expected timer-index');
  assert.match(hit.message, /conditional option sits above it/);

  const good = check([
    '? say something  [timer 9000 3]',
    '- honest -> a',
    '- push -> a',
    '- silence -> a',
    '- verify -> a [if not proofOK]',
    '@label a', '@end Done'
  ].join('\n'));
  assert.ok(!codes(good).includes('timer-index'));
});

test('a timer pointing past the end of the menu', () => {
  const found = check(['? pick  [timer 5000 9]', '- a -> x', '@label x', '@end Done'].join('\n'));
  assert.ok(codes(found).includes('timer-index'));
});

test('seen() on an exported label name', () => {
  const found = check([
    '? pick', '- secret -> s [if seen(l_42)]', '- plain -> s',
    '@label l_42', '@label s', '@end Done'
  ].join('\n'));
  const hit = found.find((f) => f.code === 'generated-label-gate');
  assert.ok(hit);
  assert.match(hit.message, /renumber/);
});

test('unknown and duplicate labels', () => {
  const found = check(['@jump nowhere', '@label twice', '@label twice', '@end Done'].join('\n'));
  assert.ok(codes(found).includes('unknown-label'));
  assert.ok(codes(found).includes('duplicate-label'));
});

test('unreachable blocks and routes that run off the end', () => {
  const found = check(['@jump a', '@label a', '@end Done', '@label orphan', ': nobody comes here'].join('\n'));
  assert.ok(codes(found).includes('unreachable'));
  assert.ok(codes(found).includes('falls-off-end'));
});

test('@when guards only the next line', () => {
  const stolen = check(['@when late', '@grade cold 400', ': she is late'].join('\n'));
  assert.ok(codes(stolen).includes('guard-stolen'));
  const orphan = check(['@when late', '', ': she is late'].join('\n'));
  assert.ok(codes(orphan).includes('guard-orphan'));
  const chained = check(['@when late', '@when tookKey', ': both'].join('\n'));
  assert.ok(codes(chained).includes('guard-chain'));
});

test('an FX line inside a stage block splits the change', () => {
  const found = check(['@show Laila at left as neutral', '@fx dust_motes', '@transition dissolve 500', ': there'].join('\n'));
  assert.ok(codes(found).includes('fx-splits-stage'));
  const ok = check(['@show Laila at left as neutral', '@transition dissolve 500', '@fx dust_motes', ': there'].join('\n'));
  assert.ok(!codes(ok).includes('fx-splits-stage'));
});

test('narration whose text before a colon could import as a speaker', () => {
  const found = check('This is what their friendship sounds like: two people not talking.');
  const hit = found.find((f) => f.code === 'unprefixed-colon');
  assert.ok(hit);
  assert.strictEqual(hit.severity, 'warning');
  assert.ok(!codes(check(': Inside: a box.')).includes('unprefixed-colon'));
  assert.ok(!codes(check('Laila (neutral): hello')).includes('unprefixed-colon'));
});

test('a speaker outside the declared cast', () => {
  const found = check('#! cast: Laila, Daughter\nPorter: who let you in');
  const hit = found.find((f) => f.code === 'unprefixed-colon');
  assert.ok(hit);
  assert.match(hit.message, /not in the cast/);
});

test('variables written but never read, and read but never written', () => {
  const found = check(['@set keptCard = yes', '@if stayed -> a', '@label a', '@end Done'].join('\n'));
  assert.ok(codes(found).includes('variable-never-read'));
  assert.ok(codes(found).includes('variable-never-written'));
  assert.ok(!codes(check(['@set keptCard = yes', '@if stayed -> a', '@label a', '@end Done'].join('\n'), { unusedVariables: false })).includes('variable-never-read'));
});

test('a variable named after a directive', () => {
  const found = check('@set hide = yes\n@if hide -> a\n@label a\n@end Done');
  assert.ok(codes(found).includes('variable-shadows-directive'));
});

test('a background that is not declared', () => {
  const found = check('#! backgrounds: Library · now | Library · then\n@scene Library · nwo | fade 900');
  assert.ok(codes(found).includes('undeclared-background'));
  assert.ok(!codes(check('#! backgrounds: Library · now\n@scene Library · now | fade 900')).includes('undeclared-background'));
});

test('a choice where every option is behind an [if]', () => {
  const found = check(['? pick', '- a -> x [if one]', '- b -> x [if two]', '@label x', '@end Done'].join('\n'));
  assert.ok(codes(found).includes('choice-all-conditional'));
});

test('router rows: a missing arrow, a stranded row after else', () => {
  const found = check(['@router', '- trust >= 70 -> open', '- guarded', '@label open', '@end Done'].join('\n'));
  assert.ok(codes(found).includes('row-no-target'));
  const stranded = check(['@router', '- else -> a', '- trust >= 70 -> b', '@label a', '@end A', '@label b', '@end B'].join('\n'));
  assert.ok(codes(stranded).includes('else-not-last'));
});

test('unbalanced markup', () => {
  assert.ok(codes(check(': {color=#ff6fb5}pink words')).includes('unbalanced-markup'));
  assert.ok(codes(check(': *unclosed italics')).includes('unbalanced-markup'));
  assert.ok(!codes(check(': {color=#ff6fb5}pink{/color} and *italic* and **bold**')).includes('unbalanced-markup'));
});

test('unknown directives, and the escape hatch for them', () => {
  assert.ok(codes(check('@sparkle 3')).includes('unknown-directive'));
  assert.ok(!codes(check('@sparkle 3', { extraDirectives: ['sparkle'] })).includes('unknown-directive'));
  assert.ok(!codes(check('@sparkle 3', { unknownDirective: 'off' })).includes('unknown-directive'));
});

test('a bare @end loses the Endings screen', () => {
  assert.ok(codes(check('@end')).includes('ending-unnamed'));
  assert.ok(!codes(check('@end The Fire [key fire]')).includes('ending-unnamed'));
  assert.ok(!codes(check('@end ___ [key handed]')).includes('ending-unnamed'), 'a placeholder name is work in progress, not a mistake');
});

test('placeholders report once per line at the configured severity', () => {
  const found = check(': ___ and ___\nLaila: ___', { placeholders: 'hint' });
  const hits = found.filter((f) => f.code === 'placeholder');
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].severity, 'hint');
  assert.match(hits[0].message, /2 placeholders/);
});

test('the example passes every check', () => {
  const script = parseScript(fs.readFileSync(EXAMPLE, 'utf8'));
  const found = checkScript(script, buildGraph(script), { placeholders: 'off' });
  assert.deepStrictEqual(found.map((f) => `${f.line + 1}: ${f.code}`), []);
});

// ── conformance with the official cheat sheet ────────────────────────────────

test('[timer ms] with no index, and with its flags, is legal', () => {
  const menu = (tag) => ['? pick  ' + tag, '- a -> L', '- b -> L', '- c -> L', '@label L', '@end E'].join('\n');
  assert.ok(!codes(check(menu('[timer 9000]'))).includes('timer-index'));
  assert.ok(!codes(check(menu('[timer 9000 3 fill nobar nopause]'))).includes('timer-index'));
  assert.ok(codes(check(menu('[timer 9000 9]'))).includes('timer-index'), 'an out-of-range index still counts');
});

test('@random takes its weights inline, after a colon', () => {
  const found = check(['@label top', '@random: 3 -> a, 1 -> b', '@label a', '@end A', '@label b', '@end B'].join('\n'));
  assert.deepStrictEqual(codes(found), []);
});

test('@end [then label] continues somewhere, so that label is reachable', () => {
  const found = check(['@label a', '@end Done [key done] [then credits]', '@label credits', ': thanks', '@end Credits'].join('\n'));
  assert.ok(!codes(found).includes('unreachable'));
  assert.ok(codes(check('@end Done [then nowhere]')).includes('unknown-label'));
});

test('@import rows carry a glob and assignments, not an arrow', () => {
  const found = check([
    '@import "Save code" -> resumed else fresh case',
    '- HONEY-A* : trust = 70; late = no',
    '- +L : bonus = yes',
    '@label resumed', '@if trust >= 50 -> fresh', '@label fresh', '@end E'
  ].join('\n'));
  assert.ok(!codes(found).includes('row-no-target'), 'an @import row needs no target');
  assert.ok(!codes(found).includes('option-orphan'));
  assert.ok(!codes(found).includes('unbalanced-markup'), 'a glob is not italics');
  assert.ok(!codes(found).includes('unreachable'));
});

test('a bare @stop ends the chain; @stop with a channel is audio', () => {
  const chain = check(['@label a', '@stop', '@label b', ': never reached', '@end E'].join('\n'));
  assert.ok(codes(chain).includes('unreachable'), 'nothing runs on past a bare @stop');
  const audio = check(['@label a', '@stop music 1500', ': this still plays', '@end E'].join('\n'));
  assert.ok(!codes(audio).includes('unreachable'));
  assert.ok(!codes(audio).includes('falls-off-end'));
});

test('the directives the cheat sheet lists are all known', () => {
  const sheet = [
    '@scene A | fade 1', '@label l', '@jump l', '@call l return l', '@return', '@end E', '@stop',
    '@set a = 1', '@toggle a', '@if a -> l', '@switch a: "x" -> l, else -> l', '@random: 1 -> l',
    '@when a', '@input v "p" max 4 default "x"', '@router', '- else -> l',
    '@show N at left', '@move N to right glide 200', '@hide N exit fade 100', '@clear',
    '@overlay #ff000022', '@caption hi', '@effect rain on', '@transition fade 400',
    '@fx show dust_motes', '@fx move dust_motes to 1,1', '@fx hide dust_motes', '@fx clear',
    '@channel "Aside"', '@grade Cold 400', '@ui textbox off 200', '@beat A 400 nowait',
    '@insert Letter stay', '@insert close', '@export "K-{ending}"', '@import "code" -> l else l',
    '@music M loop fade 200', '@ambience A', '@sfx S', '@voice V', '@wait click',
    '@shake 4 200', '@flash #fff 100', '@nvl clear', '@adv'
  ].join('\n');
  assert.deepStrictEqual(codes(check(sheet)).filter((c) => c === 'unknown-directive'), []);
});

test('a @switch case can be a number', () => {
  const found = check([
    '@set turns = 1', '@label hub', '@switch turns: 1 -> one, 2 -> two, else -> other',
    '@label one', '@end A', '@label two', '@end B', '@label other', '@end C'
  ].join('\n'));
  assert.deepStrictEqual(codes(found), [], 'every numeric case is an edge, so nothing is unreachable');
});

test('a @grade field following a variable counts as a read', () => {
  const found = check(['@set dread = 0', '@grade Cold 400 saturation=$dread from 0..100 to 0.2..1'].join('\n'));
  assert.ok(!codes(found).includes('variable-never-read'));
});

test('a save-code template reads the variables it prints', () => {
  const found = check(['@set trust = 30', '@set run = "x"', '@export "HONEY-{ending}-{run}-{trust >= 50 ? \'A\' : \'B\'}"'].join('\n'));
  assert.ok(!codes(found).includes('variable-never-read'));
  assert.ok(!codes(found).includes('variable-never-written'), '{ending} is a template word, not a variable');
});

test('@beat names a background, and `-` names none', () => {
  const declared = '#! backgrounds: Library · now\n';
  assert.ok(!codes(check(declared + '@beat Library · now 600 nowait')).includes('undeclared-background'));
  assert.ok(codes(check(declared + '@beat Library · nwo 600')).includes('undeclared-background'));
  assert.ok(!codes(check(declared + '@beat - 600')).includes('undeclared-background'));
});

test('the same option text twice is flagged, unless the two [if]s are exact opposites', () => {
  const locked = check('? Where\n- The back stacks -> a [if hasKey]\n- The back stacks -> b [if not hasKey]\n- Leave -> a\n\n@label a\n@end A\n@label b\n@end B\n');
  assert.ok(!codes(locked).includes('duplicate-option'));
  const clash = check('? Where\n- The back stacks -> a [if hasKey]\n- The back stacks -> b [if late]\n- Leave -> a\n\n@label a\n@end A\n@label b\n@end B\n');
  assert.ok(codes(clash).includes('duplicate-option'));
  const plain = check('? Where\n- Leave -> a\n- Leave -> b\n\n@label a\n@end A\n@label b\n@end B\n');
  assert.ok(codes(plain).includes('duplicate-option'));
});
