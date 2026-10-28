'use strict';

/**
 * Draws a laid-out graph as SVG. One renderer for both the scene map webview and
 * `Kiosune: Export Scene Map as SVG`, so what you export is what you looked at.
 */

const { stageSummary, longStage } = require('./stage');

const SCENE_COLOURS = 6;

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function clip(text, max) {
  const value = String(text == null ? '' : text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Stable colour per background, so the same room is the same colour every redraw. */
function sceneIndex(name, order) {
  if (!name) return 0;
  const at = order.indexOf(name);
  return at === -1 ? 0 : (at % SCENE_COLOURS) + 1;
}

function edgePath(edge, laneOffset) {
  const a = edge.fromNode;
  const b = edge.toNode;
  const ax = a.x + a.w / 2 + laneOffset;
  const ay = a.y + a.h;
  const bx = b.x + b.w / 2 + laneOffset;
  const by = b.y;
  if (b.y > a.y) {
    const dy = Math.max(28, (by - ay) / 2);
    return `M ${ax} ${ay} C ${ax} ${ay + dy}, ${bx} ${by - dy}, ${bx} ${by - 4}`;
  }
  // A back edge — a hub return, a retry — loops out to the side and comes in at the top.
  const side = bx >= ax ? 1 : -1;
  const outX = a.x + (side > 0 ? a.w : 0);
  const outY = a.y + a.h / 2;
  const inX = b.x + b.w / 2;
  const inY = b.y + b.h + 4;
  const bulge = 70 + Math.abs(laneOffset) * 2;
  return `M ${outX} ${outY} C ${outX + side * bulge} ${outY}, ${inX + side * bulge} ${inY + 30}, ${inX} ${inY}`;
}

const STYLE = `
.kio-edge { fill: none; stroke: var(--kio-edge, #8a8f98); stroke-width: 1.4; }
.kio-edge.kind-fall { stroke-dasharray: 4 4; opacity: .75; }
.kio-edge.kind-call { stroke-dasharray: 1 3; }
.kio-edge.conditional { stroke: var(--kio-edge-conditional, #b08800); }
.kio-edge.back { opacity: .55; }
.kio-edge.dim { opacity: .12; }
.kio-edge.hot { stroke: var(--kio-accent, #3794ff); stroke-width: 2.4; opacity: 1; }
.kio-node rect.box { fill: var(--kio-node, #ffffff); stroke: var(--kio-node-border, #c8ccd2); stroke-width: 1.2; }
.kio-node.start rect.box { stroke: var(--kio-accent, #3794ff); stroke-width: 2; }
.kio-node.ending rect.box { fill: var(--kio-node-ending, #f6f2fb); stroke: var(--kio-ending, #8a63d2); stroke-width: 1.6; }
.kio-node.unreachable rect.box { stroke-dasharray: 5 3; stroke: var(--kio-warning, #c17d00); }
.kio-node.hot rect.box { stroke: var(--kio-accent, #3794ff); stroke-width: 2.4; }
.kio-node.dim { opacity: .25; }
.kio-node text.title { font: 600 12px var(--kio-font, ui-monospace, monospace); fill: var(--kio-fg, #1f2328); }
.kio-node text.meta { font: 11px var(--kio-font, ui-monospace, monospace); fill: var(--kio-fg-dim, #6a737d); }
.kio-node text.badge { font: 10px var(--kio-font, ui-monospace, monospace); fill: var(--kio-fg-dim, #6a737d); }
.kio-node { cursor: pointer; }
.kio-node text.stage { display: none; }
.show-stage .kio-node text.stage { display: inline; }
.show-stage .kio-node text.bg { display: none; }
.kio-node.stage-varies text.stage { fill: var(--kio-warning, #c17d00); font-weight: 600; }
.kio-scene-0 { fill: var(--kio-scene-0, #b9bec6); }
.kio-scene-1 { fill: var(--kio-scene-1, #3794ff); }
.kio-scene-2 { fill: var(--kio-scene-2, #2ea043); }
.kio-scene-3 { fill: var(--kio-scene-3, #d18616); }
.kio-scene-4 { fill: var(--kio-scene-4, #8a63d2); }
.kio-scene-5 { fill: var(--kio-scene-5, #cc5c8a); }
.kio-scene-6 { fill: var(--kio-scene-6, #2aa198); }
`;

/** The tooltip's stage lines: who is on at the block's start, and after it if it restages. */
function stageTip(node) {
  const into = node.stageIn || [];
  if (!into.length) return [];
  const lines = into.length === 1 ? [`on stage: ${longStage(into[0])}`]
    : [`on stage VARIES by route (${into.length}):`, ...into.map((s) => `  ${longStage(s)}`)];
  if (node.stageSets) {
    const out = node.stageOut || [];
    lines.push(...(out.length === 1 ? [`after its stage lines: ${longStage(out[0])}`]
      : [`after its stage lines (${out.length}):`, ...out.map((s) => `  ${longStage(s)}`)]));
  }
  return lines;
}

/**
 * @param {{nodes: any[], edges: any[], width: number, height: number}} layout
 * @param {{standalone?: boolean, title?: string, sceneOrder?: string[]}} [options]
 */
function renderSceneMap(layout, options = {}) {
  const sceneOrder = options.sceneOrder || [];
  const pad = 24;
  const width = Math.max(layout.width, 320) + pad * 2;
  const height = Math.max(layout.height, 200) + pad * 2;

  const lanes = new Map();
  const edges = layout.edges.map((edge) => {
    const key = `${edge.from}\u0000${edge.to}`;
    const lane = lanes.get(key) || 0;
    lanes.set(key, lane + 1);
    const offset = (lane % 2 === 0 ? 1 : -1) * Math.ceil(lane / 2) * 9;
    const classes = ['kio-edge', `kind-${edge.kind}`];
    if (edge.conditional) classes.push('conditional');
    if (edge.back) classes.push('back');
    return `    <path class="${classes.join(' ')}" d="${edgePath(edge, offset)}" marker-end="url(#kio-arrow${edge.conditional ? '-c' : ''})" data-from="${escapeXml(edge.from)}" data-to="${escapeXml(edge.to)}" data-line="${edge.line}"><title>${escapeXml(`${edge.from} → ${edge.to}  (${edge.kind}${edge.label ? `: ${clip(edge.label, 40)}` : ''})`)}</title></path>`;
  });

  const nodes = layout.nodes.map((node) => {
    const scene = node.sceneOut || node.sceneIn;
    const classes = ['kio-node'];
    if (node.isStart) classes.push('start');
    if (node.isEnding) classes.push('ending');
    if (!node.reachable) classes.push('unreachable');
    const name = node.label || 'start';
    const meta = node.isEnding
      ? `ending${node.endingKey ? ` · ${node.endingKey}` : ''}${node.endingHidden ? ' · hidden' : ''}`
      : (node.sceneOut || node.sceneIn || 'no background');
    const badges = [];
    if (node.lines) badges.push(`${node.lines} line${node.lines === 1 ? '' : 's'}`);
    if (node.incoming > 1) badges.push(`←${node.incoming}`);
    if (!node.reachable) badges.push('unreachable');
    const tip = [
      `${name}   (line ${node.line + 1})`,
      node.chapter ? `chapter: ${node.chapter}` : null,
      `background: ${node.sceneOut || node.sceneIn || 'none'}`,
      `${node.lines} text line${node.lines === 1 ? '' : 's'} · ${node.incoming} way${node.incoming === 1 ? '' : 's'} in · ${(node.out || []).length || node.outCount || 0} out`,
      node.terminal ? `ends on: ${node.terminal.kind}` : 'runs on into the next label',
      ...stageTip(node)
    ].filter(Boolean).join('\n');
    if ((node.stageIn || []).length > 1) classes.push('stage-varies');
    return `    <g class="${classes.join(' ')}" data-id="${escapeXml(node.id)}" data-line="${node.line}" data-scene="${escapeXml(node.sceneOut || node.sceneIn || '')}" data-incoming="${node.incoming}" data-stage="${escapeXml(stageSummary(node))}" transform="translate(${node.x}, ${node.y})">
      <title>${escapeXml(tip)}</title>
      <rect class="box" width="${node.w}" height="${node.h}" rx="8"/>
      <rect class="stripe kio-scene-${sceneIndex(scene, sceneOrder)}" x="1" y="1" width="4" height="${node.h - 2}" rx="2"/>
      <text class="title" x="14" y="23">${escapeXml(clip(name, 24))}</text>
      <text class="meta bg" x="14" y="39">${escapeXml(clip(meta, 26))}</text>
      <text class="meta stage" x="14" y="39">${escapeXml(clip(stageSummary(node), 26))}</text>
      <text class="badge" x="14" y="52">${escapeXml(badges.join(' · '))}</text>
    </g>`;
  });

  const body = `  <defs>
    <marker id="kio-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--kio-edge, #8a8f98)"/>
    </marker>
    <marker id="kio-arrow-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--kio-edge-conditional, #b08800)"/>
    </marker>
  </defs>
  <style>${STYLE}</style>
  <g id="kio-canvas" transform="translate(${pad}, ${pad})">
${edges.join('\n')}
${nodes.join('\n')}
  </g>`;

  const openTag = options.standalone
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" role="img" aria-label="${escapeXml(options.title || 'Kiosune scene map')}">
  <rect width="100%" height="100%" fill="#fbfbfc"/>`
    : `<svg id="kio-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" width="${Math.round(width)}" height="${Math.round(height)}">`;

  const svg = `${openTag}
${body}
</svg>`;
  // A standalone file is opened by things that do not resolve CSS variables
  // (Inkscape, cairosvg, an image tag in a wiki), so bake the fallbacks in.
  return options.standalone ? svg.replace(/var\(--[\w-]+,\s*([^)]+)\)/g, '$1') : svg;
}

module.exports = { renderSceneMap, escapeXml, clip };
