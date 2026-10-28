'use strict';

/**
 * Tokenises with the same engine VS Code uses. Needs the two dev dependencies:
 *   npm install
 * Without them the suite skips rather than failing, so `node --test test/*.test.js`
 * works in a bare checkout.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let vsctm;
let oniguruma;
try {
  vsctm = require('vscode-textmate');
  oniguruma = require('vscode-oniguruma');
} catch {
  test('TextMate grammar', { skip: 'run `npm install` in vscode-kiosune/ to enable the grammar tests' }, () => {});
}

if (vsctm) {
  const grammarPath = path.join(__dirname, '..', 'syntaxes', 'kiosune.tmLanguage.json');
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  const onigLib = oniguruma.loadWASM(wasm.buffer).then(() => ({
    createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
    createOnigString: (text) => new oniguruma.OnigString(text)
  }));
  const registry = new vsctm.Registry({
    onigLib,
    loadGrammar: () => Promise.resolve(vsctm.parseRawGrammar(fs.readFileSync(grammarPath).toString(), grammarPath))
  });
  const grammarPromise = registry.loadGrammar('source.kiosune');

  /** @returns {Promise<Array<{text: string, scopes: string[]}>>} */
  async function tokenise(text) {
    const grammar = await grammarPromise;
    let stack = vsctm.INITIAL;
    const out = [];
    for (const line of text.split('\n')) {
      const result = grammar.tokenizeLine(line, stack);
      stack = result.ruleStack;
      for (const token of result.tokens) {
        const slice = line.substring(token.startIndex, token.endIndex);
        if (slice.trim()) out.push({ text: slice, scopes: token.scopes });
      }
    }
    return out;
  }

  const scopeOf = (tokens, text) => {
    const token = tokens.find((t) => t.text.trim() === text);
    return token ? token.scopes.join(' ') : '';
  };

  test('the grammar loads and every rule compiles', async () => {
    const tokens = await tokenise('@scene Library · then keep | fade 1400');
    assert.ok(tokens.length > 1);
  });

  test('scene, stage and transition lines', async () => {
    const tokens = await tokenise([
      '@scene Suds & Salt · 2 a.m. keep | flash 160',
      '@show Det. Quist at 350,268 as skeptical scale 1',
      '@transition dissolve 600'
    ].join('\n'));
    assert.match(scopeOf(tokens, 'Suds & Salt · 2 a.m.'), /entity\.name\.type\.background/);
    assert.match(scopeOf(tokens, 'keep'), /keyword\.other/);
    assert.match(scopeOf(tokens, 'Det. Quist'), /entity\.name\.type\.character/);
    assert.match(scopeOf(tokens, 'skeptical'), /variable\.parameter\.expression/);
    assert.match(scopeOf(tokens, 'dissolve'), /support\.function\.transition/);
  });

  test('dialogue, narration and their markup', async () => {
    const tokens = await tokenise([
      'Laila (neutral): back {color=#ff6fb5}after{/color} my shift. ___',
      'Daughter as "???": who are you',
      ': 4:06 a.m. {pause=600}*wrong*'
    ].join('\n'));
    assert.match(scopeOf(tokens, 'Laila'), /entity\.name\.type\.character/);
    assert.match(scopeOf(tokens, 'neutral'), /variable\.parameter\.expression/);
    assert.match(scopeOf(tokens, '#ff6fb5'), /constant\.other\.color/);
    assert.match(scopeOf(tokens, '___'), /placeholder/);
    assert.match(scopeOf(tokens, '"???"'), /string\.quoted\.double/);
    assert.match(scopeOf(tokens, '*wrong*'), /markup\.italic/);
    assert.match(scopeOf(tokens, '600'), /constant\.numeric/);
    // the timestamp is narration, not a speaker
    assert.ok(!tokens.some((t) => t.text.includes('4:06') && t.scopes.join(' ').includes('entity.name.type.character')));
  });

  test('choices, options and their tags', async () => {
    const tokens = await tokenise([
      '? What do you say  [timer 9000 3]',
      '- Tell the truth -> desk_honest [set trust += 15; late = no]',
      '- Push -> desk_push [if not late] [grey "she is closing up"]'
    ].join('\n'));
    assert.match(scopeOf(tokens, '?'), /keyword\.control\.choice/);
    assert.match(scopeOf(tokens, 'timer'), /support\.function\.tag/);
    assert.match(scopeOf(tokens, 'desk_honest'), /entity\.name\.function/);
    assert.match(scopeOf(tokens, 'trust'), /variable\.other/);
    assert.match(scopeOf(tokens, '+='), /keyword\.operator/);
    assert.match(scopeOf(tokens, 'not'), /keyword\.operator\.logical/);
    assert.match(scopeOf(tokens, '"she is closing up"'), /string\.quoted\.double/);
  });

  test('branches: labels after -> and after else are both targets', async () => {
    const tokens = await tokenise([
      '@if trust >= 50 -> key_given else key_refused',
      '@switch hideSpot: "stacks" -> shelf_mine, else -> shelf_other',
      '@router',
      '- trust >= 70 -> desk_open',
      '- else -> desk_guarded'
    ].join('\n'));
    assert.match(scopeOf(tokens, 'key_given'), /entity\.name\.function/);
    assert.match(scopeOf(tokens, 'key_refused'), /entity\.name\.function/);
    assert.match(scopeOf(tokens, 'shelf_mine'), /entity\.name\.function/);
    assert.match(scopeOf(tokens, 'hideSpot'), /variable\.other/);
    assert.match(scopeOf(tokens, 'desk_guarded'), /entity\.name\.function/);
  });

  test('comments, anchors and pragmas', async () => {
    const tokens = await tokenise(['# BEAT: she hides it', '#! cast: Laila, Daughter', '# FX: dust in the beam'].join('\n'));
    assert.match(scopeOf(tokens, 'BEAT'), /keyword\.other\.anchor/);
    assert.match(scopeOf(tokens, 'FX'), /keyword\.other\.anchor/);
    assert.match(scopeOf(tokens, 'cast'), /keyword\.control\.pragma/);
  });

  test('every line of the example is tokenised, and nothing lands in an error scope', async () => {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'lamp-room.kio.txt'), 'utf8');
    const tokens = await tokenise(text);
    assert.ok(tokens.length > 300);
    assert.deepStrictEqual(tokens.filter((t) => t.scopes.some((s) => s.startsWith('invalid'))), []);
    const labels = tokens.filter((t) => t.scopes.join(' ').includes('entity.name.function.label'));
    const { parseScript } = require('../src/parser');
    assert.strictEqual(labels.length, parseScript(text).labels.size, 'the grammar finds every label the parser does');
  });
}
