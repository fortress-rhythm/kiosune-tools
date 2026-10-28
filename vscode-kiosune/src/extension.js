'use strict';

const vscode = require('vscode');
const { parseScript } = require('./parser');
const { buildGraph } = require('./graph');
const { checkScript, summarise } = require('./check');
const { registerProviders } = require('./providers');
const { registerViews } = require('./views');
const { createSceneMap } = require('./scenemap');

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint
};

/** @type {Map<string, {version: number, script: any, graph: any, findings: any[], summary: any}>} */
const cache = new Map();
let configStamp = 0;

function settings() {
  const config = vscode.workspace.getConfiguration('kiosune');
  return {
    enabled: config.get('diagnostics.enabled', true),
    placeholders: config.get('diagnostics.placeholders', 'hint'),
    unprefixedColon: config.get('diagnostics.unprefixedColon', 'warning'),
    unknownDirective: config.get('diagnostics.unknownDirective', 'warning'),
    unusedVariables: config.get('diagnostics.unusedVariables', true),
    extraDirectives: config.get('extraDirectives', []),
    placeholderToken: config.get('placeholderToken', '___')
  };
}

function getModel(document) {
  const key = document.uri.toString();
  const cached = cache.get(key);
  if (cached && cached.version === document.version && cached.stamp === configStamp) return cached;
  const options = settings();
  const script = parseScript(document.getText(), options);
  const graph = buildGraph(script);
  const findings = checkScript(script, graph, options);
  const model = { version: document.version, stamp: configStamp, script, graph, findings, summary: summarise(script, graph, findings) };
  cache.set(key, model);
  return model;
}

const isKiosune = (document) => Boolean(document) && document.languageId === 'kiosune';

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('kiosune');
  const output = vscode.window.createOutputChannel('Kiosune');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'kiosune.check';
  context.subscriptions.push(diagnostics, output, status);

  const placeholderDecoration = vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 1px 0',
    borderStyle: 'dashed',
    borderColor: new vscode.ThemeColor('editorInfo.foreground'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  context.subscriptions.push(placeholderDecoration);

  const sceneMap = createSceneMap(context, getModel);
  const refreshViews = registerViews(context, getModel);
  registerProviders(context, getModel);

  function publish(document) {
    if (!isKiosune(document)) return;
    const model = getModel(document);
    const options = settings();
    if (!options.enabled) {
      diagnostics.delete(document.uri);
    } else {
      diagnostics.set(document.uri, model.findings.map((finding) => {
        const line = Math.min(finding.line, Math.max(0, document.lineCount - 1));
        const max = document.lineAt(line).text.length;
        const item = new vscode.Diagnostic(
          new vscode.Range(line, Math.min(finding.start, max), line, Math.min(Math.max(finding.end, finding.start + 1), Math.max(max, 1))),
          finding.message,
          finding.severity in SEVERITY ? SEVERITY[finding.severity] : vscode.DiagnosticSeverity.Information
        );
        item.source = 'kiosune';
        item.code = finding.code;
        if (finding.code === 'placeholder') item.tags = [vscode.DiagnosticTag.Unnecessary];
        return item;
      }));
    }
    return model;
  }

  function decorate(editor) {
    if (!editor || !isKiosune(editor.document)) return;
    const on = vscode.workspace.getConfiguration('kiosune').get('decorations.placeholders', true);
    const { script } = getModel(editor.document);
    editor.setDecorations(placeholderDecoration, on
      ? script.placeholders.map((ph) => new vscode.Range(ph.line, ph.start, ph.line, ph.end))
      : []);
  }

  function updateStatus(document) {
    if (!isKiosune(document)) { status.hide(); return; }
    const { summary } = getModel(document);
    const problems = summary.errors + summary.warnings;
    status.text = `$(edit) ${summary.placeholders} to write${problems ? `  $(warning) ${problems}` : ''}`;
    status.tooltip = new vscode.MarkdownString([
      '**Kiosune script**',
      '',
      `${summary.blocks} blocks · ${summary.edges} links · ${summary.choices} choices · ${summary.endings} endings`,
      `${summary.variables} variables · ${summary.speakers} speakers · ${summary.backgrounds} backgrounds`,
      `${summary.words} words written · ${summary.placeholders} placeholders left`,
      '',
      `${summary.errors} errors · ${summary.warnings} warnings · ${summary.infos} notes`,
      '',
      'Click to run the flow checks.'
    ].join('\n'));
    status.show();
  }

  let timer = null;
  function refresh(document, immediate = false) {
    if (!isKiosune(document)) {
      status.hide();
      refreshViews(null);
      return;
    }
    const run = () => {
      publish(document);
      updateStatus(document);
      refreshViews(document);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === document.uri.toString()) decorate(editor);
      }
      sceneMap.update(document);
    };
    if (immediate) { run(); return; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 250);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => refresh(document, true)),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cache.delete(document.uri.toString());
      diagnostics.delete(document.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => refresh(editor && editor.document, true)),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (isKiosune(event.textEditor.document)) sceneMap.highlight(event.textEditor.document, event.selections[0].active.line);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('kiosune')) return;
      configStamp++;
      cache.clear();
      refresh(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document, true);
    })
  );

  const activeKiosune = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isKiosune(editor.document)) return editor.document;
    vscode.window.showInformationMessage('Open a Kiosune script first (or run "Kiosune: Treat This File as a Kiosune Script").');
    return null;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('kiosune.check', () => {
      const document = activeKiosune();
      if (!document) return;
      const model = publish(document);
      const { summary } = model;
      output.clear();
      output.appendLine(`${document.uri.fsPath}`);
      output.appendLine('');
      output.appendLine(`  ${summary.blocks} blocks, ${summary.edges} links, ${summary.choices} choices, ${summary.endings} endings`);
      output.appendLine(`  ${summary.variables} variables, ${summary.speakers} speakers, ${summary.backgrounds} backgrounds`);
      output.appendLine(`  ${summary.words} words written, ${summary.placeholders} placeholders left`);
      output.appendLine('');
      if (!model.findings.length) {
        output.appendLine('  Nothing to report. Every jump resolves, every block is reachable, every route ends.');
      } else {
        for (const finding of model.findings) {
          output.appendLine(`  ${String(finding.line + 1).padStart(5)}  ${finding.severity.padEnd(12)} ${finding.code.padEnd(26)} ${finding.message}`);
        }
        output.appendLine('');
        output.appendLine(`  ${summary.errors} errors · ${summary.warnings} warnings · ${summary.infos} notes`);
      }
      output.appendLine('');
      output.appendLine('  These are the static checks. The studio\'s own ✓ check and a playtest of every route');
      output.appendLine('  with the debug overlay on are still the ones that catch what only runtime shows.');
      output.show(true);
    }),
    vscode.commands.registerCommand('kiosune.showSceneMap', () => {
      const document = activeKiosune();
      if (document) sceneMap.show(document);
    }),
    vscode.commands.registerCommand('kiosune.exportSceneMap', () => {
      const document = activeKiosune();
      if (document) return sceneMap.exportSvg(document);
    }),
    vscode.commands.registerCommand('kiosune.nextPlaceholder', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isKiosune(editor.document)) return;
      const { script } = getModel(editor.document);
      if (!script.placeholders.length) {
        vscode.window.showInformationMessage('No placeholders left in this script.');
        return;
      }
      const cursor = editor.selection.active;
      const next = script.placeholders.find((ph) => ph.line > cursor.line || (ph.line === cursor.line && ph.start > cursor.character)) || script.placeholders[0];
      const selection = new vscode.Selection(next.line, next.start, next.line, next.end);
      editor.selection = selection;
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    }),
    vscode.commands.registerCommand('kiosune.useKiosuneLanguage', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await vscode.languages.setTextDocumentLanguage(editor.document, 'kiosune');
      refresh(editor.document, true);
    }),
    vscode.commands.registerCommand('kiosune.refreshViews', () => {
      cache.clear();
      refresh(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document, true);
    }),
    vscode.commands.registerCommand('kiosune.reveal', async (uri, line) => {
      if (!uri) return;
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const position = new vscode.Position(Math.max(0, line || 0), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    })
  );

  for (const document of vscode.workspace.textDocuments) if (isKiosune(document)) publish(document);
  refresh(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document, true);
}

function deactivate() {
  cache.clear();
}

module.exports = { activate, deactivate };
