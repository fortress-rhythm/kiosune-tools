'use strict';

/**
 * Who is on stage, where, at every block — carried along the graph's edges the way
 * inferScenes carries the background (scripting guide §4.4: the stage is state, not a
 * place in the file). Pure; the scene map's stage mode and the label hover read it.
 *
 * tools/stage_audit.py is the command-line twin. This is a view, not a check: nothing
 * here raises a diagnostic, so the two-checker rule (tests/fixtures/kio) does not apply.
 * One simplification the Python side does not make: a plain `@call` continues with the
 * stage the caller had, not the one the subroutine left at `@return`.
 */

const MAX_STATES = 12;
const KEYWORDS = /[ \t]+(?:at|to|as|part|scale|flip|dim|z|enter|exit|glide)\b/;
const SLOT_SHORT = { farleft: 'FL', left: 'L', center: 'C', right: 'R', farright: 'FR', offscreen: 'off' };

/** @typedef {{scene: string, actors: Array<[string, string, string]>}} Stage  name, place, expression */

const EMPTY = { scene: '', actors: [] };
const keyOf = (/** @type {Stage} */ s) => JSON.stringify([s.scene, s.actors]);

function actorArgs(args) {
  const text = String(args || '').replace(/[ \t]#(?![0-9A-Fa-f]{3,8}\b).*$/, '');
  const cut = KEYWORDS.exec(text);
  const name = (cut ? text.slice(0, cut.index) : text).trim();
  const rest = cut ? text.slice(cut.index) : '';
  const place = /\b(?:at|to)[ \t]+(-?\d+(?:\.\d+)?[ \t]*,[ \t]*-?\d+(?:\.\d+)?|\S+)/.exec(rest);
  const expr = /\bas[ \t]+(\S+)/.exec(rest);
  return { name, place: place ? place[1].replace(/\s+/g, '') : null, expr: expr ? expr[1] : null };
}

/** The stage after one parsed line (unchanged for anything that is not a stage line). */
function applyLine(/** @type {Stage} */ stage, line) {
  if (!line || line.kind !== 'directive') return stage;
  const d = line.directive;
  if (d === 'scene' && line.scene && !line.scene.beat) {
    return { scene: line.scene.name, actors: line.scene.keep ? stage.actors : [] };
  }
  if (d === 'clear') return { scene: stage.scene, actors: [] };
  if (d !== 'show' && d !== 'move' && d !== 'hide') return stage;
  const { name, place, expr } = actorArgs(line.args);
  if (!name) return stage;
  const cast = new Map(stage.actors.map((a) => [a[0], a]));
  const had = cast.get(name);
  if (d === 'hide') cast.delete(name);
  else if (d === 'show') cast.set(name, [name, place || '?', expr || '']);
  else if (had) cast.set(name, [name, place || had[1], expr || had[2]]);
  const actors = [...cast.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { scene: stage.scene, actors };
}

/** Walk the graph; give every node `stageIn` and `stageOut` (arrays of distinct stages). */
function inferStage(script, graph) {
  const blocks = new Map(script.blocks.map((b) => [b.label || '«start»', b]));
  const into = new Map();
  for (const id of graph.nodes.keys()) into.set(id, new Map());
  const queue = [];
  if (graph.startId && into.has(graph.startId)) {
    into.get(graph.startId).set(keyOf(EMPTY), EMPTY);
    queue.push(graph.startId);
  }
  const at = (block, stage, upTo) => {
    for (const line of block.lines) {
      if (line.n > upTo) break;
      stage = applyLine(stage, line);
    }
    return stage;
  };
  while (queue.length) {
    const id = queue.shift();
    const node = graph.nodes.get(id);
    const block = blocks.get(id);
    if (!node || !block) continue;
    for (const edge of node.out) {
      const target = into.get(edge.to);
      if (!target) continue;
      let grew = false;
      for (const stage of into.get(id).values()) {
        const next = at(block, stage, edge.line);
        const key = keyOf(next);
        if (!target.has(key) && target.size < MAX_STATES) { target.set(key, next); grew = true; }
      }
      if (grew && !queue.includes(edge.to)) queue.push(edge.to);
    }
  }
  for (const [id, states] of into) {
    const node = graph.nodes.get(id);
    const block = blocks.get(id);
    node.stageIn = [...states.values()];
    const out = new Map();
    for (const s of node.stageIn) {
      const o = at(block, s, Infinity);
      out.set(keyOf(o), o);
    }
    node.stageOut = [...out.values()];
    node.stageSets = block.lines.some((l) => l.kind === 'directive' && ['show', 'move', 'hide', 'clear'].includes(l.directive));
  }
}

/** "Mara L · Tobin R" — short enough for a map node. */
function shortStage(/** @type {Stage} */ s) {
  if (!s.actors.length) return 'nobody';
  return s.actors.map(([n, p]) => `${n} ${SLOT_SHORT[p] || p}`).join(' · ');
}

/** "Mara left (neutral) · Tobin right (angry)" */
function longStage(/** @type {Stage} */ s) {
  const who = s.actors.map(([n, p, e]) => `${n} ${p}${e ? ` (${e})` : ''}`).join(' · ') || 'nobody';
  return `${s.scene || 'no scene yet'} | ${who}`;
}

/** One line for a node: its entry stage, or how many it can have. */
function stageSummary(node) {
  const states = node.stageIn || [];
  if (!states.length) return 'unreached';
  if (states.length > 1) return `stage varies ×${states.length}${states.length >= MAX_STATES ? '+' : ''}`;
  return shortStage(states[0]);
}

module.exports = { inferStage, applyLine, actorArgs, shortStage, longStage, stageSummary, MAX_STATES };
