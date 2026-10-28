'use strict';

/** Works out what the cursor is on, from the parsed model rather than the text. */

function tagsOf(line) {
  if (!line) return [];
  if (line.tags) return line.tags;
  if (line.option && line.option.tags) return line.option.tags;
  return [];
}

function within(item, ch) {
  return ch >= item.start && ch <= item.end;
}

/**
 * @returns {{kind: string, name: string, start: number, end: number, ref?: any, line: number} | null}
 */
function resolveAt(script, lineNumber, ch) {
  const line = script.lines[lineNumber];
  if (!line) return null;
  const at = (kind, name, start, end, extra) => ({ kind, name, start, end, line: lineNumber, ...extra });

  for (const ref of script.labelRefs) {
    if (ref.line === lineNumber && within(ref, ch)) return at('label-ref', ref.name, ref.start, ref.end, { ref });
  }
  for (const label of script.labels.values()) {
    for (const def of [label, ...(label.duplicates || [])]) {
      if (def.line === lineNumber && within(def, ch)) return at('label-def', label.name, def.start, def.end);
    }
  }
  for (const [name, v] of script.variables) {
    for (const use of v.writes) if (use.line === lineNumber && within(use, ch)) return at('variable', name, use.start, use.end, { use, write: true });
    for (const use of v.reads) if (use.line === lineNumber && within(use, ch)) return at('variable', name, use.start, use.end, { use, write: false });
  }
  if (line.kind === 'dialogue' && line.speaker && ch >= line.speakerStart && ch <= line.speakerEnd) {
    return at('speaker', line.speaker, line.speakerStart, line.speakerEnd);
  }
  if (line.actor && within(line.actor, ch)) return at('speaker', line.actor.name, line.actor.start, line.actor.end);
  if (line.scene && line.scene.name && within(line.scene, ch)) return at('background', line.scene.name, line.scene.start, line.scene.end);
  for (const tag of tagsOf(line)) {
    if (ch >= tag.start && ch <= tag.start + 1 + tag.raw.length) {
      return at('tag', tag.name, tag.start + 1, tag.start + 1 + tag.raw.length);
    }
  }
  if (line.kind === 'directive') {
    const start = line.indent;
    const end = line.indent + 1 + line.rawDirective.length;
    if (ch >= start && ch <= end) return at('directive', line.directive, start, end);
  }
  const text = line.raw;
  const fn = /\b(seen|visited|random)\b(?=\s*\()/g;
  let m;
  while ((m = fn.exec(text))) {
    if (ch >= m.index && ch <= m.index + m[1].length) return at('function', m[1], m.index, m.index + m[1].length);
  }
  for (const ph of script.placeholders) {
    if (ph.line === lineNumber && within(ph, ch)) return at('placeholder', '', ph.start, ph.end);
  }
  return null;
}

module.exports = { resolveAt, tagsOf };
