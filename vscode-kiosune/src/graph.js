'use strict';

/**
 * The threading model: blocks (a `@label` and the lines under it) and the edges
 * between them. Pure, so the scene map and the flow checks agree by construction.
 */

const { inferStage } = require('./stage');

const START = '«start»';

/** Does this line end the block's flow, so control does not run on into the next label? */
function terminalKind(line, block) {
  if (line.kind !== 'directive') return null;
  switch (line.directive) {
    case 'jump': return 'jump';
    case 'end': return 'end';
    case 'return': return 'return';
    // `@call sub return label` comes back at that label, not on the next line.
    case 'call': return line.returnTo ? 'call-return' : null;
    // `@stop music|ambience|sfx|voice [ms]` is the audio command; a bare `@stop` ends the chain.
    case 'stop': return /^\s*(music|ambience|sfx|voice)\b/.test(line.args || '') ? null : 'stop';
    case 'if': return line.branch && line.branch.else ? 'if' : null;
    case 'switch': return (line.cases || []).some((c) => c.isElse) ? 'switch' : null;
    case 'random': return (line.cases || []).length ? 'random' : null;
    case 'import': return line.branch && line.branch.else ? 'import' : null;
    case 'router': return (line.choice && line.choice.options.some((o) => o.isElse)) ? 'router' : null;
    default: return null;
  }
}

function buildGraph(script) {
  /** @type {Map<string, any>} */
  const nodes = new Map();
  const edges = [];

  for (const block of script.blocks) {
    const id = block.label || START;
    if (block.index === 0 && !block.label && !block.lines.some((l) => l.kind !== 'blank' && l.kind !== 'comment' && l.kind !== 'pragma')) {
      // An all-comment preamble is a header, not a scene.
      continue;
    }
    nodes.set(id, {
      id,
      label: block.label,
      index: block.index,
      line: block.line,
      endLine: block.endLine,
      chapter: block.chapter,
      isStart: block.index === 0,
      isEnding: false,
      endingName: null,
      terminal: null,
      lines: 0,
      placeholders: 0,
      sceneIn: null,
      sceneOut: null,
      scenes: [],
      reachable: false,
      incoming: 0,
      out: []
    });
  }

  for (const block of script.blocks) {
    const id = block.label || START;
    const node = nodes.get(id);
    if (!node) continue;
    let guarded = false;
    let terminal = null;
    let openRows = null;
    const unreachableLines = [];

    for (const line of block.lines) {
      if (line.kind === 'blank' || line.kind === 'comment' || line.kind === 'pragma') continue;
      // The rows of a choice or router belong to their header line, which has
      // already been dealt with; they are not code sitting after a jump.
      if (line.kind === 'option' && openRows && line.option && line.option.choice === openRows) continue;
      if (terminal) { unreachableLines.push(line.n); continue; }
      if (line.kind === 'dialogue' || line.kind === 'narration' || line.kind === 'text') node.lines++;
      if (line.kind === 'directive' && line.directive === 'scene' && line.scene) node.scenes.push(line.scene.name);

      const add = (to, kind, label) => {
        if (!to) return;
        const edge = { from: id, to, kind, label: label || null, line: line.n, conditional: guarded || kind === 'if' || kind === 'router' || kind === 'switch' || kind === 'option-if' };
        edges.push(edge);
        node.out.push(edge);
      };

      if (line.kind === 'directive') {
        if (line.directive === 'import' && line.choice) openRows = line.choice;
        switch (line.directive) {
          case 'jump': add(line.target, 'jump'); break;
          case 'call':
            add(line.target, 'call');
            if (line.returnTo) add(line.returnTo, 'return', 'return');
            break;
          case 'if':
          case 'import':
            if (line.branch) {
              add(line.branch.then, 'if', line.branch.condition);
              if (line.branch.else) add(line.branch.else, 'else', 'else');
            }
            break;
          case 'switch':
            for (const c of line.cases || []) add(c.target, 'switch', c.isElse ? 'else' : String(c.value));
            break;
          case 'random':
            for (const c of line.cases || []) add(c.target, 'random', `weight ${c.value}`);
            break;
          case 'router':
            if (line.choice) {
              openRows = line.choice;
              for (const option of line.choice.options) {
                add(option.target, 'router', option.isElse ? 'else' : option.condition || null);
              }
            }
            break;
          case 'end':
            // `[then label]` carries on at that label instead of the title screen.
            if (line.ending && line.ending.then) add(line.ending.then, 'then', 'then');
            node.isEnding = true;
            node.endingName = line.ending ? line.ending.name : null;
            node.endingKey = line.ending ? line.ending.key : null;
            node.endingHidden = Boolean(line.ending && line.ending.hidden);
            break;
          default: break;
        }
      } else if (line.kind === 'choice' && line.choice) {
        openRows = line.choice;
        for (const option of line.choice.options) {
          if (option.target) add(option.target, option.conditional ? 'option-if' : 'option', option.text || null);
        }
        // Every option jumps somewhere, so the block cannot run on past the menu.
        if (line.choice.options.length && line.choice.options.every((o) => o.target)) {
          terminal = { kind: 'choice', line: line.n };
          continue;
        }
      }

      const t = guarded ? null : terminalKind(line, block);
      if (t) terminal = { kind: t, line: line.n };
      guarded = line.kind === 'directive' && Boolean(line.guard);
    }

    node.terminal = terminal;
    node.unreachableLines = unreachableLines;

    if (!terminal) {
      const next = script.blocks[block.index + 1];
      if (next && next.label) {
        const edge = { from: id, to: next.label, kind: 'fall', label: null, line: block.endLine, conditional: false };
        edges.push(edge);
        node.out.push(edge);
      } else if (!next) {
        node.fallsOffEnd = true;
      }
    }
  }

  for (const edge of edges) {
    const target = nodes.get(edge.to);
    edge.resolved = Boolean(target);
    if (target) target.incoming++;
  }

  // Reachability from the first block.
  const startId = nodes.has(START) ? START : (script.blocks.find((b) => b.label) || {}).label;
  const queue = startId ? [startId] : [];
  const seen = new Set(queue);
  while (queue.length) {
    const node = nodes.get(queue.shift());
    if (!node) continue;
    node.reachable = true;
    for (const edge of node.out) {
      if (!seen.has(edge.to) && nodes.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
    }
  }

  inferScenes(nodes, startId);
  inferStage(script, { nodes, startId });

  return { nodes, edges, startId, endings: [...nodes.values()].filter((n) => n.isEnding) };
}

/** Walk the graph carrying the current background, so every block knows what is on screen. */
function inferScenes(nodes, startId) {
  const VARIES = '—varies—';
  const queue = startId ? [startId] : [];
  const rounds = new Map();
  while (queue.length) {
    const id = queue.shift();
    const node = nodes.get(id);
    if (!node) continue;
    const count = (rounds.get(id) || 0) + 1;
    rounds.set(id, count);
    if (count > 4) continue;
    const out = node.scenes.length ? node.scenes[node.scenes.length - 1] : node.sceneIn;
    node.sceneOut = out;
    for (const edge of node.out) {
      const next = nodes.get(edge.to);
      if (!next) continue;
      const incoming = edge.kind === 'call' ? next.sceneIn || out : out;
      if (next.sceneIn === null || next.sceneIn === undefined) { next.sceneIn = incoming; queue.push(edge.to); }
      else if (next.sceneIn !== incoming && next.sceneIn !== VARIES) { next.sceneIn = VARIES; queue.push(edge.to); }
    }
  }
}

/**
 * Layered layout: rank by distance from the start, then order each rank by the
 * average position of the nodes pointing into it (two barycentre sweeps).
 */
function layoutGraph(graph, options = {}) {
  const nodeWidth = options.nodeWidth || 188;
  const nodeHeight = options.nodeHeight || 58;
  const gapX = options.gapX || 28;
  const gapY = options.gapY || 78;
  const includeFall = options.showFallthrough !== false;

  const nodes = [...graph.nodes.values()];
  const edges = graph.edges.filter((e) => e.resolved && (includeFall || e.kind !== 'fall'));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outOf = new Map(nodes.map((n) => [n.id, []]));
  const intoOf = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    outOf.get(e.from).push(e.to);
    intoOf.get(e.to).push(e.from);
  }

  const rank = new Map();
  const queue = [];
  if (graph.startId && byId.has(graph.startId)) { rank.set(graph.startId, 0); queue.push(graph.startId); }
  while (queue.length) {
    const id = queue.shift();
    for (const next of outOf.get(id) || []) {
      if (!rank.has(next)) { rank.set(next, rank.get(id) + 1); queue.push(next); }
    }
  }
  let maxRank = 0;
  for (const r of rank.values()) maxRank = Math.max(maxRank, r);
  // Endings sink to the bottom; orphans get a band of their own below everything.
  for (const node of nodes) {
    if (!rank.has(node.id)) rank.set(node.id, maxRank + 2);
  }
  for (const node of nodes) {
    if (node.isEnding && rank.get(node.id) < maxRank) rank.set(node.id, maxRank);
  }

  const ranks = new Map();
  for (const node of nodes) {
    const r = rank.get(node.id);
    if (!ranks.has(r)) ranks.set(r, []);
    ranks.get(r).push(node);
  }
  for (const list of ranks.values()) list.sort((a, b) => a.index - b.index);

  const order = new Map();
  const setOrder = () => {
    for (const list of ranks.values()) list.forEach((n, i) => order.set(n.id, i));
  };
  setOrder();
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const [, list] of [...ranks.entries()].sort((a, b) => a[0] - b[0])) {
      const bary = new Map();
      for (const node of list) {
        const parents = (intoOf.get(node.id) || []).filter((p) => rank.get(p) < rank.get(node.id));
        const values = parents.map((p) => order.get(p)).filter((v) => v !== undefined);
        bary.set(node.id, values.length ? values.reduce((a, b) => a + b, 0) / values.length : order.get(node.id));
      }
      list.sort((a, b) => (bary.get(a.id) - bary.get(b.id)) || (a.index - b.index));
      setOrder();
    }
  }

  // A hub puts dozens of blocks on one rank; wrap those into sub-rows so the map
  // stays a shape you can read rather than one very long line.
  const perRow = Math.max(3, options.maxPerRow || 7);
  const widest = Math.max(1, ...[...ranks.values()].map((l) => Math.min(l.length, perRow)));
  const width = widest * (nodeWidth + gapX) + gapX;
  const positioned = [];
  let row = 0;
  for (const [r, list] of [...ranks.entries()].sort((a, b) => a[0] - b[0])) {
    const rows = [];
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
    for (const chunk of rows) {
      const rowWidth = chunk.length * (nodeWidth + gapX) - gapX;
      const left = (width - rowWidth) / 2;
      const y = gapY / 2 + row * (nodeHeight + gapY * 0.72);
      chunk.forEach((node, i) => {
        positioned.push({
          ...node,
          scenes: undefined,
          out: undefined,
          rank: r,
          x: left + i * (nodeWidth + gapX),
          y,
          w: nodeWidth,
          h: nodeHeight
        });
      });
      row++;
    }
  }
  const height = row * (nodeHeight + gapY * 0.72) + gapY;
  const laidOut = new Map(positioned.map((n) => [n.id, n]));
  const drawnEdges = edges.map((e) => ({
    ...e,
    fromNode: laidOut.get(e.from),
    toNode: laidOut.get(e.to),
    back: laidOut.get(e.to) && laidOut.get(e.from) ? laidOut.get(e.to).y <= laidOut.get(e.from).y : false
  })).filter((e) => e.fromNode && e.toNode);

  return { nodes: positioned, edges: drawnEdges, width, height, nodeWidth, nodeHeight };
}

module.exports = { buildGraph, layoutGraph, terminalKind, START };
