'use strict';

const vscode = require('vscode');
const { DIRECTIVES, TAGS, FUNCTIONS, VOCABULARY } = require('./directives');
const { resolveAt } = require('./locate');
const { longStage } = require('./stage');

const SELECTOR = { language: 'kiosune' };

const TOKEN_LEGEND = new vscode.SemanticTokensLegend(
  ['function', 'variable', 'class', 'enumMember', 'string', 'keyword'],
  ['declaration', 'definition']
);

const range = (line, start, end) => new vscode.Range(line, start, line, end);

function describeLabel(script, graph, name) {
  const label = script.labels.get(name);
  const node = graph.nodes.get(name);
  const lines = [`**@label ${name}**  — line ${label ? label.line + 1 : '?'}`];
  if (node) {
    const scene = node.sceneOut || node.sceneIn;
    lines.push('', `Background here: \`${scene || 'none'}\`${node.chapter ? ` · chapter *${node.chapter}*` : ''}`);
    lines.push(`${node.lines} text line${node.lines === 1 ? '' : 's'}${node.isEnding ? ' · ends the story' : ''}${node.reachable ? '' : ' · **nothing reaches it**'}`);
    const into = node.stageIn || [];
    if (into.length === 1) lines.push('', `On stage here: \`${longStage(into[0])}\``);
    else if (into.length > 1) {
      lines.push('', `**On stage varies by route** (${into.length}):`);
      for (const s of into) lines.push(`- \`${longStage(s)}\``);
    }
  }
  const incoming = script.labelRefs.filter((r) => r.name === name);
  if (incoming.length) {
    lines.push('', `**${incoming.length} way${incoming.length === 1 ? '' : 's'} in**`);
    for (const ref of incoming.slice(0, 8)) lines.push(`- line ${ref.line + 1} — \`${ref.via}\``);
    if (incoming.length > 8) lines.push(`- …and ${incoming.length - 8} more`);
  } else {
    lines.push('', '_Nothing jumps here._');
  }
  if (node && node.out && node.out.length) {
    lines.push('', `**Out:** ${[...new Set(node.out.map((e) => `\`${e.to}\``))].join(', ')}`);
  }
  return lines.join('\n');
}

function describeVariable(script, name) {
  const v = script.variables.get(name);
  const declared = script.declared.variables.get(name);
  const lines = [`**${name}**${declared && declared.type ? ` — ${declared.type}` : ''}${declared ? '' : ' — *not declared at the top of this file*'}`];
  if (!v) return lines.join('\n');
  lines.push('', `${v.writes.length} write${v.writes.length === 1 ? '' : 's'} · ${v.reads.length} read${v.reads.length === 1 ? '' : 's'}`);
  for (const w of v.writes.slice(0, 10)) {
    lines.push(`- line ${w.line + 1} — \`${w.op === 'toggle' ? 'toggle' : `${w.op} ${w.value}`.trim()}\`${w.via === 'tag' ? ' (on an option)' : ''}`);
  }
  if (v.writes.length > 10) lines.push(`- …and ${v.writes.length - 10} more`);
  if (!v.reads.length) lines.push('', '_Never read: nothing in this script branches on it._');
  if (!v.writes.length) lines.push('', '_Never written: it always has its default._');
  return lines.join('\n');
}

function registerProviders(context, getModel) {
  const push = (d) => context.subscriptions.push(d);

  push(vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
    provideDocumentSymbols(document) {
      const { script } = getModel(document);
      const symbols = [];
      /** @type {vscode.DocumentSymbol | null} */
      let chapter = null;
      /** @type {vscode.DocumentSymbol | null} */
      let label = null;
      const lastLine = document.lineCount - 1;
      const endOf = (n) => document.lineAt(Math.min(n, lastLine)).range.end;
      const close = (symbol, n) => { if (symbol) symbol.range = new vscode.Range(symbol.range.start, endOf(n)); };

      for (const line of script.lines) {
        if (line.kind === 'chapter') {
          close(label, line.n - 1); label = null;
          close(chapter, line.n - 1);
          chapter = new vscode.DocumentSymbol(line.name || 'chapter', '', vscode.SymbolKind.Namespace,
            new vscode.Range(line.n, 0, line.n, line.raw.length), range(line.n, line.indent, line.raw.length));
          symbols.push(chapter);
        } else if (line.kind === 'directive' && line.directive === 'label' && line.label) {
          close(label, line.n - 1);
          const node = getModel(document).graph.nodes.get(line.label);
          label = new vscode.DocumentSymbol(line.label,
            node ? (node.sceneOut || node.sceneIn || '') : '', vscode.SymbolKind.Function,
            new vscode.Range(line.n, 0, line.n, line.raw.length), range(line.n, line.argsStart, line.raw.length));
          (chapter ? chapter.children : symbols).push(label);
        } else if (line.kind === 'choice' && line.choice) {
          const detail = `${line.choice.options.length} option${line.choice.options.length === 1 ? '' : 's'}`;
          const symbol = new vscode.DocumentSymbol(line.prompt || 'choice', detail, vscode.SymbolKind.Event,
            new vscode.Range(line.n, 0, line.n, line.raw.length), range(line.n, line.indent, line.indent + 1));
          (label ? label.children : chapter ? chapter.children : symbols).push(symbol);
        } else if (line.kind === 'directive' && line.directive === 'end' && line.ending) {
          const symbol = new vscode.DocumentSymbol(line.ending.name || '(unnamed ending)',
            line.ending.key ? `key ${line.ending.key}` : '', vscode.SymbolKind.Constant,
            new vscode.Range(line.n, 0, line.n, line.raw.length), range(line.n, line.indent, line.raw.length));
          (label ? label.children : chapter ? chapter.children : symbols).push(symbol);
        }
      }
      close(label, lastLine);
      close(chapter, lastLine);
      return symbols;
    }
  }));

  push(vscode.languages.registerFoldingRangeProvider(SELECTOR, {
    provideFoldingRanges(document) {
      const { script } = getModel(document);
      const ranges = [];
      let chapterStart = null;
      let labelStart = null;
      let commentStart = null;
      const lastLine = script.lines.length - 1;
      for (const line of script.lines) {
        if (line.kind === 'comment' || line.kind === 'pragma') {
          if (commentStart === null) commentStart = line.n;
        } else {
          if (commentStart !== null && line.n - commentStart >= 3) {
            ranges.push(new vscode.FoldingRange(commentStart, line.n - 1, vscode.FoldingRangeKind.Comment));
          }
          commentStart = null;
        }
        if (line.kind === 'chapter') {
          if (labelStart !== null) { ranges.push(new vscode.FoldingRange(labelStart, line.n - 1)); labelStart = null; }
          if (chapterStart !== null) ranges.push(new vscode.FoldingRange(chapterStart, line.n - 1, vscode.FoldingRangeKind.Region));
          chapterStart = line.n;
        }
        if (line.kind === 'directive' && line.directive === 'label') {
          if (labelStart !== null) ranges.push(new vscode.FoldingRange(labelStart, line.n - 1));
          labelStart = line.n;
        }
        if (line.kind === 'choice' && line.choice && line.choice.options.length) {
          ranges.push(new vscode.FoldingRange(line.n, line.choice.options[line.choice.options.length - 1].line));
        }
      }
      if (labelStart !== null) ranges.push(new vscode.FoldingRange(labelStart, lastLine));
      if (chapterStart !== null) ranges.push(new vscode.FoldingRange(chapterStart, lastLine, vscode.FoldingRangeKind.Region));
      if (commentStart !== null && lastLine - commentStart >= 3) {
        ranges.push(new vscode.FoldingRange(commentStart, lastLine, vscode.FoldingRangeKind.Comment));
      }
      return ranges.filter((r) => r.end > r.start);
    }
  }));

  push(vscode.languages.registerDefinitionProvider(SELECTOR, {
    provideDefinition(document, position) {
      const { script } = getModel(document);
      const hit = resolveAt(script, position.line, position.character);
      if (!hit) return null;
      if (hit.kind === 'label-ref' || hit.kind === 'label-def') {
        const label = script.labels.get(hit.name);
        if (!label) return null;
        return new vscode.Location(document.uri, range(label.line, label.start, label.end));
      }
      if (hit.kind === 'variable') {
        const declared = script.declared.variables.get(hit.name);
        if (declared) {
          const text = document.lineAt(declared.line).text;
          const at = text.indexOf(hit.name);
          return new vscode.Location(document.uri, range(declared.line, Math.max(at, 0), Math.max(at, 0) + hit.name.length));
        }
        const v = script.variables.get(hit.name);
        const first = v && v.writes[0];
        return first ? new vscode.Location(document.uri, range(first.line, first.start, first.end)) : null;
      }
      return null;
    }
  }));

  push(vscode.languages.registerReferenceProvider(SELECTOR, {
    provideReferences(document, position, options) {
      const { script } = getModel(document);
      const hit = resolveAt(script, position.line, position.character);
      if (!hit) return [];
      const locations = [];
      if (hit.kind === 'label-ref' || hit.kind === 'label-def') {
        if (options.includeDeclaration) {
          const label = script.labels.get(hit.name);
          if (label) locations.push(new vscode.Location(document.uri, range(label.line, label.start, label.end)));
        }
        for (const ref of script.labelRefs) {
          if (ref.name === hit.name) locations.push(new vscode.Location(document.uri, range(ref.line, ref.start, ref.end)));
        }
      } else if (hit.kind === 'variable') {
        const v = script.variables.get(hit.name);
        if (v) for (const use of [...v.writes, ...v.reads]) locations.push(new vscode.Location(document.uri, range(use.line, use.start, use.end)));
      } else if (hit.kind === 'speaker') {
        const speaker = script.speakers.get(hit.name);
        if (speaker) {
          for (const n of speaker.lines) {
            const line = script.lines[n];
            if (line.kind === 'dialogue') locations.push(new vscode.Location(document.uri, range(n, line.speakerStart, line.speakerEnd)));
            else if (line.actor) locations.push(new vscode.Location(document.uri, range(n, line.actor.start, line.actor.end)));
          }
        }
      } else if (hit.kind === 'background') {
        for (const line of script.lines) {
          if (line.scene && line.scene.name === hit.name) locations.push(new vscode.Location(document.uri, range(line.n, line.scene.start, line.scene.end)));
        }
      }
      return locations;
    }
  }));

  push(vscode.languages.registerRenameProvider(SELECTOR, {
    prepareRename(document, position) {
      const { script } = getModel(document);
      const hit = resolveAt(script, position.line, position.character);
      if (!hit || !['label-ref', 'label-def', 'variable'].includes(hit.kind)) {
        throw new Error('Only labels and variables can be renamed from here.');
      }
      return range(hit.line, hit.start, hit.end);
    },
    provideRenameEdits(document, position, newName) {
      const { script } = getModel(document);
      const hit = resolveAt(script, position.line, position.character);
      if (!hit) return null;
      const edit = new vscode.WorkspaceEdit();
      const replace = (line, start, end) => edit.replace(document.uri, range(line, start, end), newName);
      if (hit.kind === 'label-ref' || hit.kind === 'label-def') {
        const label = script.labels.get(hit.name);
        if (label) {
          replace(label.line, label.start, label.end);
          for (const dup of label.duplicates || []) replace(dup.line, dup.start, dup.end);
        }
        for (const ref of script.labelRefs) if (ref.name === hit.name) replace(ref.line, ref.start, ref.end);
      } else if (hit.kind === 'variable') {
        const v = script.variables.get(hit.name);
        if (v) for (const use of [...v.writes, ...v.reads]) replace(use.line, use.start, use.end);
        const declared = script.declared.variables.get(hit.name);
        if (declared) {
          const text = document.lineAt(declared.line).text;
          const word = new RegExp(`\\b${hit.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          const m = word.exec(text);
          if (m) replace(declared.line, m.index, m.index + hit.name.length);
        }
      }
      return edit;
    }
  }));

  push(vscode.languages.registerHoverProvider(SELECTOR, {
    provideHover(document, position) {
      const { script, graph } = getModel(document);
      const hit = resolveAt(script, position.line, position.character);
      if (!hit) return null;
      const md = new vscode.MarkdownString();
      md.supportHtml = false;
      switch (hit.kind) {
        case 'directive': {
          const info = DIRECTIVES[hit.name];
          if (!info) return null;
          md.appendCodeblock(info.sig, 'kiosune');
          md.appendMarkdown(info.doc);
          break;
        }
        case 'tag': {
          const info = TAGS[hit.name];
          if (!info) return null;
          md.appendCodeblock(info.sig, 'kiosune');
          md.appendMarkdown(info.doc);
          break;
        }
        case 'function': {
          const info = FUNCTIONS[hit.name];
          if (!info) return null;
          md.appendCodeblock(info.sig, 'kiosune');
          md.appendMarkdown(info.doc);
          break;
        }
        case 'label-ref':
        case 'label-def':
          md.appendMarkdown(describeLabel(script, graph, hit.name));
          break;
        case 'variable':
          md.appendMarkdown(describeVariable(script, hit.name));
          break;
        case 'speaker': {
          const speaker = script.speakers.get(hit.name);
          if (!speaker) return null;
          const expressions = [...speaker.expressions];
          md.appendMarkdown(`**${hit.name}** — ${speaker.lines.length} line${speaker.lines.length === 1 ? '' : 's'}`);
          if (expressions.length) md.appendMarkdown(`\n\nExpressions used: ${expressions.map((e) => `\`${e}\``).join(', ')}`);
          if (speaker.plates.size) md.appendMarkdown(`\n\nName plates: ${[...speaker.plates].map((p) => `"${p}"`).join(', ')}`);
          if (script.declared.cast.size && !script.declared.cast.has(hit.name)) {
            md.appendMarkdown('\n\n⚠ Not in the cast declared at the top of this file — an unknown speaker imports as a blank character.');
          }
          break;
        }
        case 'background': {
          const background = script.backgrounds.get(hit.name);
          md.appendMarkdown(`**${hit.name}** — used on ${background ? background.lines.length : 1} scene line${background && background.lines.length === 1 ? '' : 's'}`);
          if (script.declared.backgrounds.size && !script.declared.backgrounds.has(hit.name)) {
            md.appendMarkdown('\n\n⚠ Not among the backgrounds declared at the top of this file. Names are matched exactly.');
          }
          break;
        }
        case 'placeholder':
          md.appendMarkdown('Not written yet.');
          break;
        default:
          return null;
      }
      return new vscode.Hover(md, range(hit.line, hit.start, hit.end));
    }
  }));

  push(vscode.languages.registerCompletionItemProvider(SELECTOR, {
    provideCompletionItems(document, position) {
      const { script } = getModel(document);
      const text = document.lineAt(position.line).text.slice(0, position.character);
      const items = [];
      const add = (label, kind, detail, doc, insert) => {
        const item = new vscode.CompletionItem(label, kind);
        if (detail) item.detail = detail;
        if (doc) item.documentation = new vscode.MarkdownString(doc);
        if (insert) item.insertText = insert;
        items.push(item);
        return item;
      };

      if (/(?:^|\s)@[\w-]*$/.test(text)) {
        for (const [name, info] of Object.entries(DIRECTIVES)) {
          add(name, vscode.CompletionItemKind.Keyword, info.sig, info.doc);
        }
        return items;
      }
      if (/\[[\w-]*$/.test(text)) {
        for (const [name, info] of Object.entries(TAGS)) {
          add(name, vscode.CompletionItemKind.Property, info.sig, info.doc);
        }
        return items;
      }
      if (/(?:->|@jump|@call|seen\(|visited\()\s*[\w.-]*$/.test(text)) {
        for (const [name, label] of script.labels) {
          add(name, vscode.CompletionItemKind.Function, `line ${label.line + 1}`, describeLabel(script, getModel(document).graph, name));
        }
        return items;
      }
      if (/@scene\s+[^|]*$/.test(text)) {
        const names = new Set([...script.declared.backgrounds.keys(), ...script.backgrounds.keys()]);
        for (const name of names) add(name, vscode.CompletionItemKind.Color, 'background');
        return items;
      }
      if (/@(?:show|move|hide)\s+[\w. ]*$/.test(text)) {
        const names = new Set([...script.declared.cast.keys(), ...script.speakers.keys()]);
        for (const name of names) add(name, vscode.CompletionItemKind.Class, 'character');
        return items;
      }
      if (/\bas\s+[\w-]*$/.test(text)) {
        const actor = /@(?:show|move)\s+(\S+(?:\s\S+)*?)\s+(?:at|as)/.exec(text);
        const speaker = actor && script.speakers.get(actor[1].trim());
        const expressions = speaker ? [...speaker.expressions] : [...new Set([...script.speakers.values()].flatMap((s) => [...s.expressions]))];
        for (const expression of expressions) add(expression, vscode.CompletionItemKind.EnumMember, 'expression');
        return items;
      }
      // The closed vocabularies from the official cheat sheet.
      if (/\b(?:at|to)\s+[\w]*$/.test(text) && /@(?:show|move|fx)\b/.test(text)) {
        for (const place of VOCABULARY.places) add(place, vscode.CompletionItemKind.EnumMember, 'place');
        return items;
      }
      if (/@transition\s+\w*$/.test(text) || /\|\s*\w*$/.test(text)) {
        for (const kind of VOCABULARY.transitions) add(kind, vscode.CompletionItemKind.EnumMember, 'transition');
        return items;
      }
      if (/\b(?:enter|exit)\s+\w*$/.test(text)) {
        for (const motion of VOCABULARY.motions) add(motion, vscode.CompletionItemKind.EnumMember, 'motion');
        return items;
      }
      if (/@fx\s+show\s+[\w]*$/.test(text)) {
        for (const id of VOCABULARY.fxIds) add(id, vscode.CompletionItemKind.EnumMember, 'built-in effect');
        return items;
      }
      if (/\blayer\s+\w*$/.test(text)) {
        for (const layer of VOCABULARY.fxLayers) add(layer, vscode.CompletionItemKind.EnumMember, 'fx layer');
        return items;
      }
      if (/@effect\s+\w*$/.test(text)) {
        for (const effect of VOCABULARY.effects) add(effect, vscode.CompletionItemKind.EnumMember, 'engine effect');
        return items;
      }
      if (/@stop\s+\w*$/.test(text)) {
        for (const channel of VOCABULARY.channels) add(channel, vscode.CompletionItemKind.EnumMember, 'audio channel');
        return items;
      }
      if (/@(?:music|ambience|sfx|voice)\s+[^\n]*$/.test(text)) {
        for (const [name, cue] of script.cues) add(name, vscode.CompletionItemKind.File, cue.channel);
        return items;
      }
      if (/(?:@set|@toggle|@if|@when|@switch|\[set|\[if|^\s*-\s)[^\]]*$/.test(text)) {
        const names = new Set([...script.declared.variables.keys(), ...script.variables.keys()]);
        for (const name of names) {
          const declared = script.declared.variables.get(name);
          add(name, vscode.CompletionItemKind.Variable, declared && declared.type ? declared.type : 'variable', describeVariable(script, name));
        }
        for (const [name, info] of Object.entries(FUNCTIONS)) {
          add(name, vscode.CompletionItemKind.Function, info.sig, info.doc, new vscode.SnippetString(`${name}(\${1:label})`));
        }
        return items;
      }
      if (!text.trim()) {
        for (const [name, speaker] of script.speakers) {
          const expression = [...speaker.expressions][0];
          add(name, vscode.CompletionItemKind.Class, 'speaker',
            undefined, new vscode.SnippetString(`${name}${expression ? ` (\${1|${[...speaker.expressions].join(',')}|})` : ''}: \${0}`));
        }
        add(':', vscode.CompletionItemKind.Snippet, 'narration', 'Narration. Always use the `:` prefix when the line contains a colon.', new vscode.SnippetString(': ${0}'));
      }
      return items;
    }
  }, '@', '[', '>', '(', ' '));

  push(vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, {
    provideDocumentSemanticTokens(document) {
      const { script } = getModel(document);
      const builder = new vscode.SemanticTokensBuilder(TOKEN_LEGEND);
      const safe = (line, start, end, type, modifiers) => {
        if (end <= start) return;
        try { builder.push(range(line, start, end), type, modifiers); } catch { /* a stale offset, never fatal */ }
      };
      for (const label of script.labels.values()) {
        safe(label.line, label.start, label.end, 'function', ['declaration']);
        for (const dup of label.duplicates || []) safe(dup.line, dup.start, dup.end, 'function', ['declaration']);
      }
      for (const ref of script.labelRefs) safe(ref.line, ref.start, ref.end, 'function', []);
      for (const v of script.variables.values()) {
        for (const use of v.writes) safe(use.line, use.start, use.end, 'variable', ['definition']);
        for (const use of v.reads) safe(use.line, use.start, use.end, 'variable', []);
      }
      for (const line of script.lines) {
        if (line.kind === 'dialogue' && line.speaker) safe(line.n, line.speakerStart, line.speakerEnd, 'class', []);
        if (line.actor) safe(line.n, line.actor.start, line.actor.end, 'class', []);
        if (line.scene && line.scene.name) safe(line.n, line.scene.start, line.scene.end, 'enumMember', []);
        if (line.cue) {
          const at = line.raw.indexOf(line.cue, line.argsStart);
          if (at >= 0) safe(line.n, at, at + line.cue.length, 'string', []);
        }
      }
      return builder.build();
    }
  }, TOKEN_LEGEND));

  push(vscode.languages.registerInlayHintsProvider(SELECTOR, {
    provideInlayHints(document, visible) {
      if (!vscode.workspace.getConfiguration('kiosune').get('inlayHints', true)) return [];
      const { script, graph } = getModel(document);
      const hints = [];
      for (const label of script.labels.values()) {
        if (label.line < visible.start.line || label.line > visible.end.line) continue;
        const node = graph.nodes.get(label.name);
        if (!node) continue;
        const bits = [`${node.incoming} in`];
        if (!node.reachable) bits.push('unreachable');
        if (node.isEnding) bits.push('ending');
        const hint = new vscode.InlayHint(new vscode.Position(label.line, document.lineAt(label.line).text.length),
          `  ${bits.join(' · ')}`, vscode.InlayHintKind.Parameter);
        hint.paddingLeft = true;
        hint.tooltip = new vscode.MarkdownString(describeLabel(script, graph, label.name));
        hints.push(hint);
      }
      return hints;
    }
  }));
}

module.exports = { registerProviders, SELECTOR, describeLabel, describeVariable };
