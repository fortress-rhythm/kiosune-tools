'use strict';

/**
 * Just enough of the VS Code API to load the extension in plain node and call
 * its providers. It is a stub, not an emulator: it records what was registered
 * so the tests can drive it, and implements only the shapes the extension uses.
 */

const Module = require('node:module');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(a, b, c, d) {
    this.start = a instanceof Position ? a : new Position(a, b);
    this.end = a instanceof Position ? b : new Position(c, d);
  }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}
class Selection extends Range {}
class Location {
  constructor(uri, range) { this.uri = uri; this.range = range; }
}
class Uri {
  constructor(value) { this.value = value; this.path = value.replace(/^file:\/\//, ''); this.fsPath = this.path; this.scheme = 'file'; }
  static parse(value) { return new Uri(value); }
  static file(value) { return new Uri(`file://${value}`); }
  static joinPath(base, ...parts) { return new Uri(`${base.value.replace(/\/$/, '')}/${parts.join('/')}`); }
  with(change) { return new Uri(`file://${change.path || this.path}`); }
  toString() { return this.value; }
}
class MarkdownString {
  constructor(value = '') { this.value = value; }
  appendMarkdown(text) { this.value += text; return this; }
  appendCodeblock(code, language) { this.value += `\n\`\`\`${language || ''}\n${code}\n\`\`\`\n`; return this; }
}
class EventEmitter {
  constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() {}
}
class TreeItem {
  constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
}
class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
  }
}
class FoldingRange {
  constructor(start, end, kind) { Object.assign(this, { start, end, kind }); }
}
class CompletionItem {
  constructor(label, kind) { this.label = label; this.kind = kind; }
}
class SnippetString {
  constructor(value) { this.value = value; }
}
class Diagnostic {
  constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
}
class Hover {
  constructor(contents, range) { this.contents = contents; this.range = range; }
}
class InlayHint {
  constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
}
class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers) { Object.assign(this, { tokenTypes, tokenModifiers }); }
}
class SemanticTokensBuilder {
  constructor(legend) { this.legend = legend; this.tokens = []; }
  push(range, type, modifiers) {
    if (!this.legend.tokenTypes.includes(type)) throw new Error(`unknown token type ${type}`);
    for (const modifier of modifiers || []) {
      if (!this.legend.tokenModifiers.includes(modifier)) throw new Error(`unknown token modifier ${modifier}`);
    }
    if (range.end.character <= range.start.character) throw new Error('empty token');
    this.tokens.push({ range, type, modifiers });
  }
  build() { return { tokens: this.tokens }; }
}
class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, text) { this.edits.push({ uri, range, text }); }
}
class ThemeIcon { constructor(id, colour) { this.id = id; this.colour = colour; } }
class ThemeColor { constructor(id) { this.id = id; } }

const registry = {
  providers: {},
  commands: new Map(),
  trees: new Map(),
  diagnostics: new Map(),
  listeners: {},
  statusBar: null,
  output: [],
  decorations: [],
  messages: [],
  config: {}
};

const listen = (name) => (listener) => {
  (registry.listeners[name] = registry.listeners[name] || []).push(listener);
  return { dispose() {} };
};

const registerProvider = (name) => (selector, provider, ...rest) => {
  (registry.providers[name] = registry.providers[name] || []).push({ provider, rest });
  return { dispose() {} };
};

const vscode = {
  Position, Range, Selection, Location, Uri, MarkdownString, EventEmitter, TreeItem, DocumentSymbol,
  FoldingRange, CompletionItem, SnippetString, Diagnostic, Hover, InlayHint, SemanticTokensLegend,
  SemanticTokensBuilder, WorkspaceEdit, ThemeIcon, ThemeColor,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  SymbolKind: { Namespace: 2, Function: 11, Event: 23, Constant: 13 },
  FoldingRangeKind: { Comment: 1, Region: 3 },
  CompletionItemKind: { Keyword: 13, Property: 9, Function: 2, Variable: 5, Class: 6, Color: 15, EnumMember: 19, File: 16, Snippet: 14 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  DiagnosticTag: { Unnecessary: 1 },
  InlayHintKind: { Parameter: 2 },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Beside: -2 },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  TextEditorRevealType: { InCenter: 2 },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri, items) => registry.diagnostics.set(uri.toString(), items),
      delete: (uri) => registry.diagnostics.delete(uri.toString()),
      dispose() {}
    }),
    registerDocumentSymbolProvider: registerProvider('symbols'),
    registerFoldingRangeProvider: registerProvider('folding'),
    registerDefinitionProvider: registerProvider('definition'),
    registerReferenceProvider: registerProvider('references'),
    registerRenameProvider: registerProvider('rename'),
    registerHoverProvider: registerProvider('hover'),
    registerCompletionItemProvider: registerProvider('completion'),
    registerDocumentSemanticTokensProvider: registerProvider('semantic'),
    registerInlayHintsProvider: registerProvider('inlay'),
    setTextDocumentLanguage: async (document) => document
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel: () => ({ clear: () => { registry.output = []; }, appendLine: (t) => registry.output.push(t), show() {}, dispose() {} }),
    createStatusBarItem: () => (registry.statusBar = { text: '', tooltip: null, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
    createTextEditorDecorationType: (options) => ({ options, dispose() {} }),
    createTreeView: (id, options) => { registry.trees.set(id, options.treeDataProvider); return { dispose() {} }; },
    createWebviewPanel: () => ({
      webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: () => true, onDidReceiveMessage: () => ({ dispose() {} }) },
      onDidDispose: () => ({ dispose() {} }),
      reveal() {}, dispose() {}, title: '', iconPath: null
    }),
    showInformationMessage: (message) => { registry.messages.push(message); return Promise.resolve(undefined); },
    showTextDocument: async (document) => ({ document, selection: null, revealRange() {} }),
    onDidChangeActiveTextEditor: listen('activeEditor'),
    onDidChangeTextEditorSelection: listen('selection')
  },
  workspace: {
    textDocuments: [],
    getConfiguration: () => ({ get: (key, fallback) => (key in registry.config ? registry.config[key] : fallback) }),
    onDidOpenTextDocument: listen('open'),
    onDidChangeTextDocument: listen('change'),
    onDidCloseTextDocument: listen('close'),
    onDidChangeConfiguration: listen('config'),
    openTextDocument: async (uri) => ({ uri }),
    fs: { writeFile: async () => undefined }
  },
  commands: {
    registerCommand: (id, handler) => { registry.commands.set(id, handler); return { dispose() {} }; },
    executeCommand: (id, ...args) => registry.commands.get(id)(...args)
  }
};

function install() {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return original.apply(this, arguments);
  };
  return () => { Module._load = original; };
}

function fakeDocument(text, path = '/tmp/test.kio.txt') {
  const lines = text.split('\n');
  return {
    uri: Uri.file(path),
    languageId: 'kiosune',
    version: 1,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (n) => ({ text: lines[n], range: new Range(n, 0, n, lines[n].length) })
  };
}

module.exports = { vscode, registry, install, fakeDocument, Position, Range, Uri };
