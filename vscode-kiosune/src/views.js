'use strict';

const vscode = require('vscode');

class Item extends vscode.TreeItem {
  constructor(label, options = {}) {
    super(label, options.children ? (options.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.children = options.children;
    if (options.icon) this.iconPath = new vscode.ThemeIcon(options.icon, options.iconColour ? new vscode.ThemeColor(options.iconColour) : undefined);
    if (options.uri && options.line !== undefined) {
      this.command = { command: 'kiosune.reveal', title: 'Reveal', arguments: [options.uri, options.line] };
    }
  }
}

class KiosuneTree {
  /** @param {(model: any, uri: vscode.Uri) => Item[]} build */
  constructor(build) {
    this.build = build;
    this.roots = [];
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh(model, uri) {
    this.roots = model ? this.build(model, uri) : [new Item('Open a Kiosune script to see it here.', { icon: 'info' })];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) { return item; }
  getChildren(item) { return item ? item.children || [] : this.roots; }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

function storyTree({ graph }, uri) {
  const groups = new Map();
  for (const node of graph.nodes.values()) {
    const scene = node.sceneOut || node.sceneIn || 'no background';
    if (!groups.has(scene)) groups.set(scene, []);
    groups.get(scene).push(node);
  }
  const roots = [];
  for (const [scene, nodes] of groups) {
    nodes.sort((a, b) => a.line - b.line);
    roots.push(new Item(scene, {
      description: plural(nodes.length, 'block'),
      icon: 'symbol-color',
      expanded: groups.size <= 4,
      children: nodes.map((node) => new Item(node.label || 'start', {
        description: [
          node.isEnding ? 'ending' : null,
          node.incoming ? `←${node.incoming}` : null,
          node.reachable ? null : 'unreachable'
        ].filter(Boolean).join(' · '),
        tooltip: new vscode.MarkdownString(`Line ${node.line + 1} · ${plural(node.lines, 'text line')}${node.chapter ? `\n\nChapter: ${node.chapter}` : ''}`),
        icon: node.isEnding ? 'primitive-square' : node.isStart ? 'play' : 'symbol-function',
        iconColour: node.reachable ? undefined : 'problemsWarningIcon.foreground',
        uri,
        line: node.line,
        children: (node.out || []).map((edge) => new Item(`→ ${edge.to}`, {
          description: edge.kind + (edge.label ? `: ${String(edge.label).slice(0, 30)}` : ''),
          icon: 'arrow-right',
          uri,
          line: edge.line
        }))
      }))
    }));
  }
  return roots;
}

function variablesTree({ script }, uri) {
  const names = new Set([...script.declared.variables.keys(), ...script.variables.keys()]);
  const roots = [];
  for (const name of [...names].sort()) {
    const v = script.variables.get(name);
    const declared = script.declared.variables.get(name);
    const writes = v ? v.writes : [];
    const reads = v ? v.reads : [];
    const flags = [];
    if (!declared) flags.push('undeclared');
    if (writes.length && !reads.length) flags.push('never read');
    if (reads.length && !writes.length) flags.push('never written');
    if (!writes.length && !reads.length) flags.push('unused');
    roots.push(new Item(name, {
      description: `${declared && declared.type ? `${declared.type} · ` : ''}${writes.length}w ${reads.length}r${flags.length ? ` · ${flags.join(', ')}` : ''}`,
      icon: 'symbol-variable',
      iconColour: flags.length ? 'problemsWarningIcon.foreground' : undefined,
      children: [
        ...writes.map((w) => new Item(`${w.op === 'toggle' ? 'toggle' : `${w.op} ${w.value}`.trim()}`, {
          description: `line ${w.line + 1}${w.via === 'tag' ? ' · on an option' : ''}`, icon: 'edit', uri, line: w.line
        })),
        ...reads.map((r) => new Item(`read · ${r.via}`, { description: `line ${r.line + 1}`, icon: 'eye', uri, line: r.line }))
      ]
    }));
  }
  return roots.length ? roots : [new Item('No variables yet.', { icon: 'info' })];
}

function assetsTree({ script }, uri) {
  const castNames = new Set([...script.declared.cast.keys(), ...script.speakers.keys()]);
  const cast = [...castNames].map((name) => {
    const speaker = script.speakers.get(name);
    const declared = script.declared.cast.size === 0 || script.declared.cast.has(name);
    return new Item(name, {
      description: `${speaker ? plural(speaker.lines.length, 'line') : 'unused'}${declared ? '' : ' · not in cast'}`,
      icon: 'person',
      iconColour: declared ? undefined : 'problemsWarningIcon.foreground',
      uri,
      line: speaker ? speaker.lines[0] : 0,
      children: speaker ? [...speaker.expressions].map((expression) => new Item(expression, { icon: 'smiley', description: 'expression' })) : []
    });
  });

  const backgroundNames = new Set([...script.declared.backgrounds.keys(), ...script.backgrounds.keys()]);
  const backgrounds = [...backgroundNames].map((name) => {
    const used = script.backgrounds.get(name);
    return new Item(name, {
      description: used ? plural(used.lines.length, 'scene') : 'never used',
      icon: 'file-media',
      iconColour: used && script.declared.backgrounds.size && !script.declared.backgrounds.has(name) ? 'problemsWarningIcon.foreground' : undefined,
      uri,
      line: used ? used.lines[0] : 0
    });
  });

  const cues = [...script.cues.values()].map((cue) => new Item(cue.name, {
    description: `${cue.channel} · ${plural(cue.lines.length, 'cue')}`, icon: 'unmute', uri, line: cue.lines[0]
  }));

  const endings = script.endings.map((ending) => new Item(ending.name || '(unnamed)', {
    description: [ending.key ? `key ${ending.key}` : null, ending.hidden ? 'hidden' : null].filter(Boolean).join(' · '),
    icon: 'star', uri, line: ending.line
  }));

  return [
    new Item('Cast', { description: String(cast.length), icon: 'organization', expanded: true, children: cast }),
    new Item('Backgrounds', { description: String(backgrounds.length), icon: 'symbol-color', expanded: true, children: backgrounds }),
    new Item('Audio', { description: String(cues.length), icon: 'unmute', children: cues }),
    new Item('Endings', { description: String(endings.length), icon: 'star', expanded: true, children: endings })
  ];
}

function todoTree({ script, graph }, uri) {
  const blockName = (n) => {
    const line = script.lines[n];
    const block = line ? script.blocks[line.block] : null;
    return block && block.label ? block.label : 'start';
  };

  const byBlock = new Map();
  for (const ph of script.placeholders) {
    const key = blockName(ph.line);
    if (!byBlock.has(key)) byBlock.set(key, new Map());
    const lines = byBlock.get(key);
    lines.set(ph.line, (lines.get(ph.line) || 0) + 1);
  }
  const placeholders = [...byBlock].map(([name, lines]) => new Item(name, {
    description: plural([...lines.values()].reduce((a, b) => a + b, 0), 'placeholder'),
    icon: 'edit',
    children: [...lines].map(([line, count]) => new Item(script.lines[line].raw.trim().slice(0, 60) || '(blank)', {
      description: `line ${line + 1}${count > 1 ? ` · ×${count}` : ''}`, uri, line
    }))
  }));

  const byTag = new Map();
  for (const anchor of script.anchors) {
    if (!byTag.has(anchor.tag)) byTag.set(anchor.tag, []);
    byTag.get(anchor.tag).push(anchor);
  }
  const anchors = [...byTag].map(([tag, list]) => new Item(tag, {
    description: String(list.length),
    icon: tag === 'FX' || tag === 'SOUND' ? 'sparkle' : 'note',
    children: list.map((anchor) => new Item(anchor.text || '(no note)', { description: `line ${anchor.line + 1}`, uri, line: anchor.line }))
  }));

  const total = script.placeholders.length;
  return [
    new Item('Placeholders', { description: String(total), icon: 'edit', expanded: true, children: placeholders }),
    new Item('Notes to yourself', { description: String(script.anchors.length), icon: 'note', children: anchors })
  ];
}

function registerViews(context, getModelFor) {
  const trees = {
    'kiosune.story': new KiosuneTree(storyTree),
    'kiosune.variables': new KiosuneTree(variablesTree),
    'kiosune.assets': new KiosuneTree(assetsTree),
    'kiosune.todo': new KiosuneTree(todoTree)
  };
  for (const [id, tree] of Object.entries(trees)) {
    context.subscriptions.push(vscode.window.createTreeView(id, { treeDataProvider: tree, showCollapseAll: true }));
  }
  const refresh = (document) => {
    const model = document ? getModelFor(document) : null;
    for (const tree of Object.values(trees)) tree.refresh(model, document ? document.uri : null);
  };
  return refresh;
}

module.exports = { registerViews };
