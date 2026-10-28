'use strict';

/**
 * The extension's half of the shared corpus — see tests/fixtures/kio/README.md.
 *
 * `tools/kio_check.py` and this extension implement the same rules twice, so both are
 * tested against the same fixtures and the same `expected.json`. If a change makes one
 * side disagree, one of these two suites fails.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseScript } = require('../src/parser');
const { buildGraph } = require('../src/graph');
const { checkScript } = require('../src/check');

const CORPUS = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'kio');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(CORPUS, 'expected.json'), 'utf8'));
const SHARED = new Set(EXPECTED.rules);

/** How a diagnostic code maps onto the shared vocabulary. */
const RULE_BY_CODE = {
  'duplicate-label': 'duplicate-label',
  'unknown-label': 'target-unresolved',
  'generated-label-gate': 'generated-label-gate',
  'choice-interrupted': 'choice-interrupted',
  'choice-empty': 'choice-empty',
  'choice-all-conditional': 'choice-all-conditional',
  'timer-index': 'timer-index',
  'guard-orphan': 'guard-orphan',
  'guard-chain': 'guard-chain',
  'unprefixed-colon': 'unprefixed-colon',
  'plate-order': 'plate-order',
  'variable-never-read': 'variable-never-read',
  'variable-never-written': 'variable-never-written',
  unreachable: 'unreachable',
  'falls-off-end': 'falls-off-end',
  'return-without-call': 'return-without-call',
  'markup-malformed': 'markup-malformed',
  'motion-unknown': 'motion-unknown',
  'place-unknown': 'place-unknown',
  'directive-comment': 'directive-comment',
  'adv-argument': 'adv-argument'
};

function sharedRules(name) {
  const script = parseScript(fs.readFileSync(path.join(CORPUS, name), 'utf8'));
  const found = checkScript(script, buildGraph(script), { placeholders: 'off' });
  const rules = new Set();
  for (const finding of found) {
    const rule = RULE_BY_CODE[finding.code];
    if (rule && SHARED.has(rule)) rules.add(rule);
  }
  return [...rules].sort();
}

test('the mapping and expected.json agree on the vocabulary', () => {
  assert.deepStrictEqual(new Set(Object.values(RULE_BY_CODE)), SHARED);
  const covered = new Set(Object.values(EXPECTED.fixtures).flat());
  assert.deepStrictEqual(covered, SHARED, 'every shared rule needs a fixture');
});

test('every fixture on disk has a row in expected.json', () => {
  const onDisk = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.kio.txt')).sort();
  assert.deepStrictEqual(onDisk, Object.keys(EXPECTED.fixtures).sort());
});

for (const name of Object.keys(EXPECTED.fixtures).sort()) {
  test(`corpus: ${name}`, () => {
    assert.deepStrictEqual(sharedRules(name), EXPECTED.fixtures[name]);
  });
}
