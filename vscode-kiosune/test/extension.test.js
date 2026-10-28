'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const stub = require('./vscode-stub');

const restore = stub.install();
const { vscode, registry, fakeDocument } = stub;
const extension = require('../src/extension');

const EXAMPLE = fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'lamp-room.kio.txt'), 'utf8');
// What the editor surfaces has to agree with the model, however the example changes.
const model = (() => {
  const { parseScript } = require('../src/parser');
  const { buildGraph } = require('../src/graph');
  const script = parseScript(EXAMPLE);
  const graph = buildGraph(script);
  const busiest = [...graph.nodes.values()].sort((a, b) => b.incoming - a.incoming)[0];
  return { script, graph, placeholders: script.placeholders.length, blocks: graph.nodes.size, busiest };
})();
const document = fakeDocument(EXAMPLE, '/tmp/lamp-room.kio.txt');
const context = { subscriptions: [], extensionUri: stub.Uri.file('/ext') };

test.before(() => {
  vscode.window.activeTextEditor = { document, selection: { active: new stub.Position(0, 0) }, setDecorations() {} };
  vscode.window.visibleTextEditors = [vscode.window.activeTextEditor];
  vscode.workspace.textDocuments = [document];
  extension.activate(context);
});

test.after(() => { extension.deactivate(); restore(); });

const first = (name) => registry.providers[name][0].provider;
const lineOf = (needle) => EXAMPLE.split('\n').findIndex((l) => l.includes(needle));
const at = (needle, column) => new stub.Position(lineOf(needle), column);

test('activation registers every provider, view and command', () => {
  for (const name of ['symbols', 'folding', 'definition', 'references', 'rename', 'hover', 'completion', 'semantic', 'inlay']) {
    assert.ok(registry.providers[name] && registry.providers[name].length, `${name} provider registered`);
  }
  for (const id of ['kiosune.story', 'kiosune.variables', 'kiosune.assets', 'kiosune.todo']) {
    assert.ok(registry.trees.has(id), `${id} view registered`);
  }
  for (const id of ['kiosune.check', 'kiosune.showSceneMap', 'kiosune.exportSceneMap', 'kiosune.nextPlaceholder', 'kiosune.useKiosuneLanguage', 'kiosune.reveal', 'kiosune.refreshViews']) {
    assert.ok(registry.commands.has(id), `${id} command registered`);
  }
});

test('the status bar counts what is left to write', () => {
  assert.match(registry.statusBar.text, new RegExp(`${model.placeholders} to write`));
  assert.match(registry.statusBar.tooltip.value, new RegExp(`${model.blocks} blocks`));
});

test('a clean script publishes no problems', () => {
  const items = registry.diagnostics.get(document.uri.toString()) || [];
  const notHints = items.filter((d) => d.severity !== vscode.DiagnosticSeverity.Hint);
  assert.deepStrictEqual(notHints.map((d) => d.message), []);
  // Placeholders are reported as hints, and only hints; a finished script has none to report.
  assert.strictEqual(items.length, model.placeholders);
  assert.ok(items.every((d) => d.source === 'kiosune'));
});

test('the outline nests labels under chapters and endings under labels', () => {
  const symbols = first('symbols').provideDocumentSymbols(document);
  const names = symbols.map((s) => s.name);
  assert.deepStrictEqual(names, ['Evening', 'Night']);
  const night = symbols[1];
  assert.ok(night.children.some((c) => c.name === 'hub'));
  const endLit = night.children.find((c) => c.name === 'end_lit');
  assert.ok(endLit.children.some((c) => c.kind === vscode.SymbolKind.Constant), 'the ending shows under its label');
  for (const symbol of symbols) assert.ok(symbol.range.end.line >= symbol.range.start.line);
});

test('go to definition follows a jump to its label', () => {
  const line = lineOf('@jump hub');
  const target = first('definition').provideDefinition(document, new stub.Position(line, 8));
  assert.strictEqual(target.range.start.line, lineOf('@label hub'));
});

test('find references lists every way into a label', () => {
  const line = lineOf('@label hub');
  const locations = first('references').provideReferences(document, new stub.Position(line, 9), { includeDeclaration: true });
  assert.ok(locations.length > 4, `expected the hub to be busy, got ${locations.length}`);
});

test('rename a label rewrites its definition and every reference', () => {
  const line = lineOf('@label hub');
  const edit = first('rename').provideRenameEdits(document, new stub.Position(line, 9), 'stair_hub');
  assert.ok(edit.edits.length > 4);
  assert.ok(edit.edits.every((e) => e.text === 'stair_hub'));
  assert.ok(edit.edits.some((e) => e.range.start.line === line));
});

test('rename refuses anything that is not a label or a variable', () => {
  assert.throws(() => first('rename').prepareRename(document, at('Tobin (worried): The lamp', 2)), /labels and variables/);
});

test('hovering a label says how you get there and what is on screen', () => {
  const hover = first('hover').provideHover(document, new stub.Position(lineOf('@label hub'), 9));
  assert.match(hover.contents.value, /@label hub\*\*/);
  assert.match(hover.contents.value, /Lighthouse · stairs/);
  assert.match(hover.contents.value, /ways in/);
});

test('hovering a variable lists its writes', () => {
  const hover = first('hover').provideHover(document, new stub.Position(lineOf('@set trust = 20'), 6));
  assert.match(hover.contents.value, /\*\*trust\*\*/);
  assert.match(hover.contents.value, /number/);
  assert.match(hover.contents.value, /writes/);
});

test('hovering a directive explains the trap it carries', () => {
  const hover = first('hover').provideHover(document, new stub.Position(lineOf('@when oil < 3'), 2));
  assert.match(hover.contents.value, /next line only plays/i);
  assert.match(hover.contents.value, /steals the guard/i);
});

test('completion after -> offers the labels', () => {
  const line = lineOf('-> carry_oil');
  const doc = fakeDocument(EXAMPLE.split('\n').map((l, n) => (n === line ? '- talk -> ' : l)).join('\n'));
  const items = first('completion').provideCompletionItems(doc, new stub.Position(line, 10));
  assert.ok(items.some((i) => i.label === 'hub'));
  assert.ok(items.some((i) => i.label === 'end_lit'));
});

test('completion inside a condition offers variables and seen()', () => {
  const line = lineOf('@router');
  const doc = fakeDocument(EXAMPLE.split('\n').map((l, n) => (n === line ? '@if ' : l)).join('\n'));
  const items = first('completion').provideCompletionItems(doc, new stub.Position(line, 4));
  assert.ok(items.some((i) => i.label === 'trust'));
  assert.ok(items.some((i) => i.label === 'seen'));
});

test('completion after @ offers directives with their signatures', () => {
  const doc = fakeDocument('@');
  const items = first('completion').provideCompletionItems(doc, new stub.Position(0, 1));
  const router = items.find((i) => i.label === 'router');
  assert.ok(router);
  assert.match(router.detail, /@router/);
});

test('semantic tokens cover labels, variables, speakers and backgrounds', () => {
  const tokens = first('semantic').provideDocumentSemanticTokens(document);
  const types = new Set(tokens.tokens.map((t) => t.type));
  for (const type of ['function', 'variable', 'class', 'enumMember']) assert.ok(types.has(type), `${type} tokens`);
  assert.ok(tokens.tokens.length > 80);
});

test('folding covers chapters, labels, choices and the comment header', () => {
  const ranges = first('folding').provideFoldingRanges(document);
  assert.ok(ranges.some((r) => r.kind === vscode.FoldingRangeKind.Comment && r.start === 0));
  assert.ok(ranges.some((r) => r.kind === vscode.FoldingRangeKind.Region));
  assert.ok(ranges.length > 20);
  assert.ok(ranges.every((r) => r.end > r.start));
});

test('inlay hints say how busy each label is', () => {
  const hints = first('inlay').provideInlayHints(document, new stub.Range(0, 0, document.lineCount - 1, 0));
  const hub = hints.find((h) => h.label.includes(`${model.busiest.incoming} in`));
  assert.ok(hub, `the busiest block (${model.busiest.id}) has ${model.busiest.incoming} ways in`);
});

test('the trees show the story, the variables, the cast and the work left', () => {
  const story = registry.trees.get('kiosune.story').getChildren();
  assert.ok(story.some((item) => item.label === 'Lighthouse · stairs'));
  const variables = registry.trees.get('kiosune.variables').getChildren();
  const trust = variables.find((item) => item.label === 'trust');
  assert.match(trust.description, /number/);
  assert.ok(registry.trees.get('kiosune.variables').getChildren(trust).length > 3);
  const assets = registry.trees.get('kiosune.assets').getChildren();
  assert.deepStrictEqual(assets.map((a) => a.label), ['Cast', 'Backgrounds', 'Audio', 'Endings']);
  assert.strictEqual(assets[3].children.length, 3);
  const todo = registry.trees.get('kiosune.todo').getChildren();
  assert.strictEqual(todo[0].description, String(model.placeholders));
  // The work-left tree groups comment markers (BEAT, FX, ...) when the script still has any.
  const hasBeat = /^\s*# BEAT/m.test(EXAMPLE);
  assert.strictEqual(todo.some((t) => (t.children || []).some((group) => group.label === 'BEAT')), hasBeat);
});

test('the check command writes a readable report', async () => {
  await vscode.commands.executeCommand('kiosune.check');
  const report = registry.output.join('\n');
  assert.match(report, /blocks, .* links/);
  assert.match(report, new RegExp(`${model.placeholders} placeholders left`));
  assert.match(report, model.placeholders ? /0 errors · 0 warnings/ : /Nothing to report/);
});

test('go to next placeholder moves the cursor to one', async () => {
  // Its own document, so the test does not depend on what the example leaves unwritten.
  const document = fakeDocument('# draft\nLaila: hello\n: ___\n', '/tmp/draft.kio.txt');
  const editor = { document, selection: { active: new stub.Position(0, 0) }, revealRange() {}, setDecorations() {} };
  vscode.window.activeTextEditor = editor;
  await vscode.commands.executeCommand('kiosune.nextPlaceholder');
  assert.ok(editor.selection.start.line > 0);
  assert.strictEqual(document.lineAt(editor.selection.start.line).text.slice(editor.selection.start.character, editor.selection.end.character), '___');
});

test('editing the document republishes problems', () => {
  const broken = fakeDocument(['? pick', '', '- a -> x', '@label x', '@end Done'].join('\n'), '/tmp/broken.kio.txt');
  vscode.window.activeTextEditor = { document: broken, selection: { active: new stub.Position(0, 0) }, setDecorations() {} };
  vscode.window.visibleTextEditors = [vscode.window.activeTextEditor];
  for (const listener of registry.listeners.activeEditor) listener(vscode.window.activeTextEditor);
  const items = registry.diagnostics.get(broken.uri.toString());
  assert.ok(items.some((d) => d.code === 'choice-interrupted' && d.severity === vscode.DiagnosticSeverity.Error));
});
