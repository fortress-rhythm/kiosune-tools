'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseScript } = require('../src/parser');

const EXAMPLE = path.join(__dirname, '..', '..', 'examples', 'lamp-room.kio.txt');

test('line kinds', () => {
  const s = parseScript([
    '# a comment',
    '#! cast: Laila, Daughter',
    '== Then',
    '@scene Library · then | fade 1400',
    ': narration with a colon: like this',
    'Laila (neutral): hello',
    'Daughter as "???": who are you',
    '? pick one',
    '- stay -> here',
    '- go'
  ].join('\n'));
  const kinds = s.lines.map((l) => l.kind);
  assert.deepStrictEqual(kinds, ['comment', 'pragma', 'chapter', 'directive', 'narration', 'dialogue', 'dialogue', 'choice', 'option', 'option']);
  assert.strictEqual(s.lines[5].speaker, 'Laila');
  assert.strictEqual(s.lines[5].expression, 'neutral');
  assert.strictEqual(s.lines[6].plate, '???');
  assert.strictEqual(s.lines[6].speaker, 'Daughter');
  assert.deepStrictEqual([...s.declared.cast.keys()], ['Laila', 'Daughter']);
  assert.strictEqual(s.choices[0].options.length, 2);
  assert.strictEqual(s.choices[0].options[0].target, 'here');
  assert.strictEqual(s.choices[0].options[1].target, null);
});

test('narration keeps its colon out of the speaker list', () => {
  const s = parseScript(': 4:06 a.m. His phone lights the ceiling.');
  assert.strictEqual(s.speakers.size, 0);
  assert.strictEqual(s.lines[0].kind, 'narration');
});

test('a style prefix does not become part of the name', () => {
  const s = parseScript('~ Corin (calm): thinking out loud');
  assert.strictEqual(s.lines[0].kind, 'dialogue');
  assert.strictEqual(s.lines[0].speaker, 'Corin');
  assert.strictEqual(s.lines[0].style, '~');
});

test('variables: reads, writes and operators', () => {
  const s = parseScript([
    '@set trust = 30',
    '@set trust += 15',
    '@set meter %+= 10',
    '@toggle late',
    '@if trust >= 50 and not late -> yes_label else no_label',
    '@input callNo "type it" max 16',
    ': you have {var=trust} left',
    '- push -> shove [set trust -= 15; tookKey = yes] [if not hasKey]'
  ].join('\n'));
  const trust = s.variables.get('trust');
  assert.strictEqual(trust.writes.length, 3);
  assert.strictEqual(trust.reads.length, 2);
  assert.deepStrictEqual(trust.writes.map((w) => w.op), ['=', '+=', '-=']);
  assert.strictEqual(s.variables.get('meter').writes[0].op, '%+=');
  assert.strictEqual(s.variables.get('late').writes[0].op, 'toggle');
  assert.strictEqual(s.variables.get('callNo').writes[0].via, 'input');
  assert.strictEqual(s.variables.get('tookKey').writes.length, 1);
  assert.strictEqual(s.variables.get('hasKey').reads.length, 1);
  assert.ok(!s.variables.has('not'), 'keywords are not variables');
  assert.ok(!s.variables.has('yes_label'), 'jump targets are not variables');
});

test('offsets point at the name, not the line', () => {
  const s = parseScript('@set trust += 15');
  const write = s.variables.get('trust').writes[0];
  assert.strictEqual('@set trust += 15'.slice(write.start, write.end), 'trust');
});

test('label references from every construct', () => {
  const s = parseScript([
    '@label top',
    '@jump a',
    '@call sub return b',
    '@if flag -> c else d',
    '@switch pick: "one" -> e, else -> f',
    '@router',
    '- score >= 5 -> g',
    '- else -> h',
    '- take it -> i [if seen(j)]'
  ].join('\n'));
  const names = s.labelRefs.map((r) => r.name).sort();
  assert.deepStrictEqual(names, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'sub']);
  assert.strictEqual(s.labelRefs.find((r) => r.name === 'j').via, 'seen');
  assert.strictEqual(s.labelRefs.find((r) => r.name === 'b').via, 'return');
});

test('endings carry their name, key and hidden flag', () => {
  const s = parseScript('@end The Fire [key fire]\n@end Static [hidden]\n@end');
  assert.deepStrictEqual(s.endings.map((e) => [e.name, e.key, e.hidden]), [
    ['The Fire', 'fire', false],
    ['Static', null, true],
    ['', null, false]
  ]);
});

test('scene names survive spaces, middots and keep', () => {
  const s = parseScript('@scene Suds & Salt · 2 a.m. keep | flash 160\n@scene - | none 0');
  assert.strictEqual(s.lines[0].scene.name, 'Suds & Salt · 2 a.m.');
  assert.strictEqual(s.lines[0].scene.keep, true);
  assert.strictEqual(s.lines[0].scene.transition, 'flash 160');
  assert.strictEqual(s.lines[1].scene.name, '-');
  assert.deepStrictEqual([...s.backgrounds.keys()], ['Suds & Salt · 2 a.m.']);
});

test('stage lines name the actor, not its modifiers', () => {
  const s = parseScript('@show Det. Quist at 350,268 as skeptical scale 1\n@move Lumi as soft part outfit:o-1\n@hide Lumi');
  assert.strictEqual(s.lines[0].actor.name, 'Det. Quist');
  assert.ok(s.speakers.get('Det. Quist').expressions.has('skeptical'));
  assert.strictEqual(s.lines[1].actor.name, 'Lumi');
  assert.strictEqual(s.lines[2].actor.name, 'Lumi');
});

test('placeholders are counted, and the token is configurable', () => {
  const s = parseScript('Laila (neutral): ___\n: ___ and ___');
  assert.strictEqual(s.placeholders.length, 3);
  const t = parseScript('Laila: TKTK', { placeholderToken: 'TKTK' });
  assert.strictEqual(t.placeholders.length, 1);
});

test('the example script parses whole', () => {
  const s = parseScript(fs.readFileSync(EXAMPLE, 'utf8'));
  assert.ok(s.labels.size > 15, `expected a script full of labels, got ${s.labels.size}`);
  assert.strictEqual(s.endings.length, 3);
  assert.deepStrictEqual(
    [...s.speakers.keys()],
    // Radio is a voice only: it speaks, and is never shown.
    ['Mara', 'Tobin', 'Radio']
  );
  assert.deepStrictEqual([...s.backgrounds.keys()], ['Harbour · dusk', 'Lighthouse · stairs', 'Lighthouse · lamp room']);
  assert.deepStrictEqual(
    [...s.declared.variables.keys()].sort(),
    [...s.variables.keys()].sort(),
    'every variable used is declared in the header, and vice versa'
  );
  assert.deepStrictEqual(s.labelRefs.filter((r) => !s.labels.has(r.name)), []);
});

test('every recorded offset points at the text it claims', () => {
  const sample = [
    '# header',
    '  @label indented_label',
    '@if trust >= 50 and not late -> key_given else key_refused',
    '@switch hideSpot: "stacks" -> shelf_mine, else -> shelf_other',
    '@call that_s_new return merge',
    '  - option text -> target  [set trust += 15; late = no]  [if seen(end_found)]',
    '@scene Library · back room keep | fade 900',
    '@show Det. Quist at 350,268 as skeptical',
    '  Laila (neutral): ___ and {var=trust}',
    '@end The Fire [key fire]'
  ];
  for (const text of [sample.join('\n'), fs.readFileSync(EXAMPLE, 'utf8')]) {
    const s = parseScript(text);
    const lines = text.split('\n');
    const slice = (item, line) => lines[line !== undefined ? line : item.line].slice(item.start, item.end);
    for (const ref of s.labelRefs) assert.strictEqual(slice(ref), ref.name, `label ref on line ${ref.line + 1}`);
    for (const label of s.labels.values()) assert.strictEqual(slice(label), label.name);
    for (const [name, v] of s.variables) {
      for (const use of [...v.reads, ...v.writes]) assert.strictEqual(slice(use), name, `${name} on line ${use.line + 1}`);
    }
    for (const ph of s.placeholders) assert.match(slice(ph), /^_+$/);
    for (const line of s.lines) {
      if (line.kind === 'dialogue') assert.strictEqual(lines[line.n].slice(line.speakerStart, line.speakerEnd), line.speaker);
      if (line.actor) assert.strictEqual(slice(line.actor, line.n), line.actor.name);
      if (line.scene && line.scene.name) assert.strictEqual(slice(line.scene, line.n).trim(), line.scene.name);
      for (const tag of line.tags || []) assert.match(lines[line.n].slice(tag.start, tag.end), /^\[.*\]$/);
    }
  }
});

test('a prose line inside the declaration block is not a declaration', () => {
  const s = parseScript([
    '#   Variables    turns number 0..30 · late flag · trust number 0..100',
    '#                proofOK flag · callNo text',
    '#   hideSpot takes exactly one of: stacks · returns · display · sill · grate',
    '@set turns += 1'
  ].join('\n'));
  assert.deepStrictEqual([...s.declared.variables.keys()], ['turns', 'late', 'trust', 'proofOK', 'callNo']);
  for (const prose of ['stacks', 'returns', 'display', 'sill', 'grate']) {
    assert.ok(!s.declared.variables.has(prose), `${prose} is prose, not a declaration`);
  }
});

test('a declaration carries its type and range', () => {
  const s = parseScript('#   Variables    trust number 0..100 · late flag');
  assert.deepStrictEqual(s.declared.variables.get('trust'), { name: 'trust', type: 'number', min: 0, max: 100, line: 0 });
  assert.deepStrictEqual(s.declared.variables.get('late'), { name: 'late', type: 'flag', min: null, max: null, line: 0 });
});
