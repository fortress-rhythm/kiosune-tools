'use strict';

/**
 * A line-based parser for Kiosune plain-text scripts.
 *
 * Pure: no vscode import, so it runs under `node --test`. Everything the rest of
 * the extension shows — highlighting, the outline, the variables view, the flow
 * checks, the scene map — is read off the model this builds.
 */

const { DIRECTIVES, STAGE_DIRECTIVES, AUDIO_DIRECTIVES, ROW_DIRECTIVES } = require('./directives');

const CONDITION_KEYWORDS = new Set([
  'and', 'or', 'not', 'else', 'is', 'isnt', 'true', 'false', 'yes', 'no', 'on', 'off', 'none', 'then'
]);
const DECL_KEYS = { backgrounds: 'backgrounds', background: 'backgrounds', cast: 'cast', characters: 'cast', variables: 'variables', vars: 'variables', audio: 'audio', sounds: 'audio', references: 'references' };
const VAR_TYPES = new Set(['number', 'text', 'flag', 'yes/no', 'bool', 'boolean', 'string', 'num']);
/** `trust number 0..100` — a declaration entry, and nothing that merely looks like prose. */
const VAR_ENTRY = /^([A-Za-z_]\w*)(?:[ \t]+(number|text|flag|yes\/no|bool|boolean|string|num))?(?:[ \t]+(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?))?$/i;
const NAME_ENTRY = /^[^:;|]{1,48}$/;
// `REF_ANNA_PLATE = anna_plate`: the placeholder a converted script prints with {var=...}, and the
// variable it stands for until the studio's own reference replaces it
const REF_ENTRY = /^([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)$/;

/** Identifiers, calls, strings, numbers and colours inside a condition or value. */
const EXPR_TOKEN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?\b|([A-Za-z_][\w.]*)\s*\(([^)]*)\)|([A-Za-z_][\w.]*)/g;

function escapeRe(token) {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emptyScript(text, options = {}) {
  return {
    text,
    placeholderRe: options.placeholderToken && options.placeholderToken !== '___'
      ? new RegExp(escapeRe(options.placeholderToken), 'g')
      : /_{3,}/g,
    lines: [],
    chapters: [],
    labels: new Map(),
    labelRefs: [],
    variables: new Map(),
    speakers: new Map(),
    backgrounds: new Map(),
    cues: new Map(),
    endings: [],
    choices: [],
    placeholders: [],
    anchors: [],
    blocks: [],
    declared: { cast: new Map(), backgrounds: new Map(), variables: new Map(), audio: new Map(), references: new Map() },
    pragmas: {}
  };
}

function record(map, name, line, extra) {
  let entry = map.get(name);
  if (!entry) {
    entry = { name, lines: [], ...extra };
    map.set(name, entry);
  }
  entry.lines.push(line);
  return entry;
}

function variable(script, name) {
  let v = script.variables.get(name);
  if (!v) {
    v = { name, reads: [], writes: [], type: null };
    script.variables.set(name, v);
  }
  return v;
}

/**
 * Strip trailing `[tag …]` groups off a line and return them with their offsets. An empty
 * `[]` is stripped too but yields no tag, so it cannot hide an option's target.
 */
function scanTrailingTags(text, base) {
  const tags = [];
  let rest = text;
  for (;;) {
    const m = /\s*\[(?:([A-Za-z][\w-]*)([^\]]*)|\s*)\]\s*$/.exec(rest);
    if (!m) break;
    if (!m[1]) {
      rest = rest.slice(0, m.index);
      continue;
    }
    const start = base + m.index + rest.slice(m.index).indexOf('[');
    tags.unshift({
      name: m[1].toLowerCase(),
      raw: m[1],
      arg: (m[2] || '').trim(),
      argStart: start + 1 + m[1].length + (m[2] ? m[2].length - m[2].trimStart().length : 0),
      start,
      end: base + m.index + m[0].length
    });
    rest = rest.slice(0, m.index);
  }
  return { clean: rest, cleanEnd: base + rest.length, tags };
}

/** Walk an expression, recording variable reads and `seen()` / `visited()` label references. */
function scanExpression(script, lineNo, expr, base, via) {
  if (!expr) return;
  // a regex of its own: a call like `not (a = 1)` recurses, and a shared global regex would
  // restart the outer loop from the top forever
  const tokens = new RegExp(EXPR_TOKEN.source, EXPR_TOKEN.flags);
  let m;
  while ((m = tokens.exec(expr))) {
    const call = m[1];
    const bare = m[3];
    if (call) {
      const fn = call.toLowerCase();
      if (fn === 'seen' || fn === 'visited') {
        const argRaw = m[2] || '';
        const trimmed = argRaw.trim();
        if (/^[A-Za-z_][\w.-]*$/.test(trimmed)) {
          const argStart = base + m.index + m[0].indexOf('(') + 1 + argRaw.indexOf(trimmed);
          script.labelRefs.push({ name: trimmed, line: lineNo, start: argStart, end: argStart + trimmed.length, via: fn });
        }
      } else {
        scanExpression(script, lineNo, m[2] || '', base + m.index + m[0].indexOf('(') + 1, via);
      }
      continue;
    }
    if (!bare) continue;
    if (CONDITION_KEYWORDS.has(bare.toLowerCase())) continue;
    const start = base + m.index;
    const ref = { line: lineNo, start, end: start + bare.length, via };
    variable(script, bare).reads.push(ref);
  }
}

/** `a = 1; b += 2` — the body of `[set …]`, or the tail of `@set`. */
function scanAssignments(script, lineNo, text, base, via) {
  let offset = 0;
  for (const part of text.split(';')) {
    const m = /^(\s*)([A-Za-z_][\w.]*)\s*(%?(?:\+=|-=|\*=|\/=)|=)\s*(.*)$/.exec(part);
    if (m) {
      const nameStart = base + offset + m[1].length;
      variable(script, m[2]).writes.push({
        line: lineNo, start: nameStart, end: nameStart + m[2].length, op: m[3], value: m[4].trim(), via
      });
      scanExpression(script, lineNo, m[4], nameStart + m[2].length + m[0].length - (m[1].length + m[2].length + m[4].length), via);
    } else {
      const bare = /^(\s*)([A-Za-z_][\w.]*)\s*$/.exec(part);
      if (bare) {
        const nameStart = base + offset + bare[1].length;
        variable(script, bare[2]).writes.push({ line: lineNo, start: nameStart, end: nameStart + bare[2].length, op: 'toggle', value: '', via });
      }
    }
    offset += part.length + 1;
  }
}

/** `option text -> target`, splitting on the last arrow. */
function splitArrow(text, base) {
  const m = /->[ \t]*([^\s\]]*)[ \t]*$/.exec(text);
  if (!m) return { left: text, target: null };
  const arrowAt = base + m.index;
  const name = m[1] || '';
  return {
    left: text.slice(0, m.index).trimEnd(),
    target: name || null,
    targetStart: arrowAt + m[0].indexOf(name, 2),
    targetEnd: arrowAt + m[0].indexOf(name, 2) + name.length,
    arrowStart: arrowAt
  };
}

function addTagEffects(script, lineNo, tags, targetInfo) {
  for (const tag of tags) {
    if (tag.name === 'set') scanAssignments(script, lineNo, tag.arg, tag.argStart, 'tag');
    else if (tag.name === 'if') scanExpression(script, lineNo, tag.arg, tag.argStart, 'tag-if');
    else if (tag.name === 'key' && targetInfo) targetInfo.key = tag.arg;
    else if (tag.name === 'hidden' && targetInfo) targetInfo.hidden = true;
    else if (tag.name === 'then' && /^[A-Za-z_][\w.-]*$/.test(tag.arg)) {
      if (targetInfo) targetInfo.then = tag.arg;
      script.labelRefs.push({ name: tag.arg, line: lineNo, start: tag.argStart, end: tag.argStart + tag.arg.length, via: 'then' });
    }
  }
}

/** `field=$var` — the sigil form a `@grade` uses to follow a variable. */
function scanSigils(script, lineNo, text, base, via) {
  if (!text) return;
  const re = /\$([A-Za-z_][\w.]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const start = base + m.index + 1;
    variable(script, m[1]).reads.push({ line: lineNo, start, end: start + m[1].length, via });
  }
}

/** A save-code template: `{var}`, `{ending}`, `{cond ? 'A' : 'B'}`. */
const TEMPLATE_WORDS = new Set(['const', 'ending', 'series']);
function scanTemplate(script, lineNo, text, base) {
  const re = /\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const inner = m[1];
    const at = base + m.index + 1;
    const plain = inner.trim();
    if (/^[A-Za-z_][\w.]*$/.test(plain)) {
      if (TEMPLATE_WORDS.has(plain.toLowerCase())) continue;
      const start = at + inner.indexOf(plain);
      variable(script, plain).reads.push({ line: lineNo, start, end: start + plain.length, via: 'template' });
    } else {
      scanExpression(script, lineNo, inner, at, 'template');
    }
  }
}

function scanText(script, lineNo, text, base) {
  const ph = script.placeholderRe;
  ph.lastIndex = 0;
  let m;
  while ((m = ph.exec(text))) {
    script.placeholders.push({ line: lineNo, start: base + m.index, end: base + m.index + m[0].length });
  }
  const vars = /\{var=([A-Za-z_][\w.]*)\}/g;
  while ((m = vars.exec(text))) {
    const start = base + m.index + 5;
    variable(script, m[1]).reads.push({ line: lineNo, start, end: start + m[1].length, via: 'markup' });
  }
}

function parseDeclarationComments(script, commentLines) {
  let current = null;
  for (const { n, body, indent } of commentLines) {
    const keyed = /^([A-Za-z/]+)(?:\s{2,}|\s*:\s*)(.*)$/.exec(body.trim());
    const key = keyed && DECL_KEYS[keyed[1].toLowerCase()];
    let value = null;
    if (key) {
      current = key;
      value = keyed[2];
    } else if (current && indent >= 3 && body.trim() && !/^[([{—-]/.test(body.trim())) {
      value = body.trim();
    } else if (body.trim() === '') {
      current = null;
    } else if (!key && /^[A-Za-z/]+\s{2,}/.test(body.trim())) {
      current = null;
    }
    if (!current || value === null) continue;
    const parts = (current === 'backgrounds'
      ? value.split(/\s{2,}·\s{2,}|\s*\|\s*|\s*,\s*/)
      : value.split(/\s+·\s+|\s*,\s*/)).map((part) => part.trim()).filter(Boolean);

    // Declaration lines are homogeneous. A continuation line that is really prose
    // ("hideSpot takes exactly one of: stacks · returns · display") has at least one
    // entry that is not a declaration, and the whole line is then left alone.
    const valid = current === 'variables'
      ? parts.every((entry) => VAR_ENTRY.test(entry))
      : current === 'references'
        ? parts.every((entry) => REF_ENTRY.test(entry))
        : parts.every((entry) => NAME_ENTRY.test(entry));
    if (!parts.length || !valid) continue;

    for (const entry of parts) {
      if (current === 'variables') {
        const m = VAR_ENTRY.exec(entry);
        script.declared.variables.set(m[1], {
          name: m[1],
          type: VAR_TYPES.has((m[2] || '').toLowerCase()) ? m[2] : null,
          min: m[3] === undefined ? null : Number(m[3]),
          max: m[4] === undefined ? null : Number(m[4]),
          line: n
        });
      } else if (current === 'references') {
        const m = REF_ENTRY.exec(entry);
        script.declared.references.set(m[1], m[2]);
      } else if (current === 'cast') {
        script.declared.cast.set(entry, { name: entry, line: n });
      } else if (current === 'backgrounds') {
        script.declared.backgrounds.set(entry, { name: entry, line: n });
      } else {
        script.declared.audio.set(entry, { name: entry, line: n });
      }
    }
  }
}

function parsePragma(script, n, body) {
  const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(body.trim());
  if (!m) return;
  const key = m[1].toLowerCase();
  const value = m[2].trim();
  script.pragmas[key] = value;
  const target = DECL_KEYS[key];
  if (!target) return;
  const parts = value.includes('|') ? value.split('|') : value.split(',');
  for (const raw of parts) {
    const entry = raw.trim();
    if (!entry) continue;
    if (target === 'variables') {
      const [name, type] = entry.split(/\s+/);
      if (/^[A-Za-z_]\w*$/.test(name)) script.declared.variables.set(name, { name, type: type || null, line: n });
    } else {
      script.declared[target].set(entry, { name: entry, line: n });
    }
  }
}

/**
 * @param {string} text
 * @param {{placeholderToken?: string}} [options]
 * @returns {ReturnType<typeof emptyScript>}
 */
function parseScript(text, options = {}) {
  const script = emptyScript(text, options);
  const rawLines = text.split(/\r?\n/);
  const commentLines = [];
  /** the choice or router currently collecting `-` rows */
  let openChoice = null;

  for (let n = 0; n < rawLines.length; n++) {
    const raw = rawLines[n];
    const indent = raw.length - raw.trimStart().length;
    const body = raw.slice(indent);
    /** @type {any} */
    const line = { n, raw, indent, kind: 'text', text: body };
    script.lines.push(line);

    if (!body.trim()) {
      line.kind = 'blank';
      openChoice = null;
      continue;
    }

    if (body.startsWith('#')) {
      line.kind = 'comment';
      const isPragma = body.startsWith('#!');
      const inner = body.slice(isPragma ? 2 : 1);
      line.body = inner;
      if (isPragma) {
        line.kind = 'pragma';
        parsePragma(script, n, inner);
      } else {
        commentLines.push({ n, body: inner, indent: inner.length - inner.trimStart().length });
        const anchor = /^\s*(BEAT|STATE|FX|FX-NONE|SOUND|TODO|NOTE)\b\s*:?\s*(.*)$/.exec(inner);
        if (anchor) {
          line.anchor = anchor[1];
          script.anchors.push({ line: n, tag: anchor[1], text: anchor[2].trim() });
        }
      }
      // A comment between `?` and its options ends the choice on import.
      if (openChoice) openChoice.interrupted = openChoice.interrupted || (openChoice.options.length === 0 ? 'comment' : openChoice.interrupted);
      continue;
    }

    if (body.startsWith('==')) {
      line.kind = 'chapter';
      line.name = body.slice(2).trim();
      script.chapters.push({ name: line.name, line: n, start: indent + 2 });
      openChoice = null;
      continue;
    }

    const dir = /^@([A-Za-z][\w-]*)[ \t]*(.*)$/.exec(body);
    if (dir) {
      line.kind = 'directive';
      line.directive = dir[1].toLowerCase();
      line.rawDirective = dir[1];
      line.args = dir[2];
      line.argsStart = indent + 1 + dir[1].length + (dir[2] ? body.indexOf(dir[2], 1 + dir[1].length) - (1 + dir[1].length) : 0);
      line.known = Object.prototype.hasOwnProperty.call(DIRECTIVES, line.directive);
      parseDirective(script, line, indent);
      if (ROW_DIRECTIVES.has(line.directive)) {
        openChoice = { kind: line.directive, line: n, prompt: '', tags: [], options: [], interrupted: null };
        script.choices.push(openChoice);
        line.choice = openChoice;
      } else {
        openChoice = null;
      }
      continue;
    }

    if (body.startsWith('?')) {
      line.kind = 'choice';
      const after = body.slice(1);
      const base = indent + 1;
      const { clean, tags } = scanTrailingTags(after, base);
      line.prompt = clean.trim();
      line.tags = tags;
      addTagEffects(script, n, tags, null);
      scanText(script, n, clean, base);
      openChoice = { kind: 'choice', line: n, prompt: line.prompt, tags, options: [], interrupted: null };
      script.choices.push(openChoice);
      line.choice = openChoice;
      continue;
    }

    if (/^-[ \t]/.test(body) || body === '-') {
      line.kind = 'option';
      const after = body.slice(1);
      const base = indent + 1;
      const { clean, tags } = scanTrailingTags(after, base);
      const arrow = splitArrow(clean, base);
      const option = {
        line: n,
        text: arrow.left.trim(),
        target: arrow.target,
        targetStart: arrow.targetStart,
        targetEnd: arrow.targetEnd,
        tags,
        conditional: tags.some((t) => t.name === 'if'),
        greyed: tags.some((t) => t.name === 'grey'),
        choice: openChoice
      };
      line.option = option;
      if (arrow.target) {
        script.labelRefs.push({
          name: arrow.target, line: n, start: arrow.targetStart, end: arrow.targetEnd,
          via: openChoice ? openChoice.kind : 'option'
        });
      }
      addTagEffects(script, n, tags, null);
      if (openChoice && openChoice.kind === 'router') {
        option.condition = arrow.left.trim();
        option.isElse = /^else\b/i.test(option.condition);
        if (!option.isElse) scanExpression(script, n, arrow.left, base, openChoice.kind);
      } else if (openChoice && openChoice.kind === 'import') {
        // `- PATTERN : var = v; …` — a glob to match, then what it sets.
        const split = clean.indexOf(':');
        option.pattern = (split === -1 ? clean : clean.slice(0, split)).trim();
        option.isElse = false;
        if (split !== -1) scanAssignments(script, n, clean.slice(split + 1), base + split + 1, 'import');
      } else {
        scanText(script, n, arrow.left, base);
      }
      if (openChoice) openChoice.options.push(option);
      else line.orphanOption = true;
      continue;
    }

    if (body.startsWith(':')) {
      line.kind = 'narration';
      line.text = body.slice(1).replace(/^ /, '');
      scanText(script, n, body.slice(1), indent + 1);
      openChoice = null;
      continue;
    }

    // dialogue: `Name (expr) as "plate": text`, with an optional style prefix.
    let rest = body;
    let prefixLen = 0;
    if (/^[~!+^_][ \t]?\S/.test(body)) {
      line.style = body[0];
      prefixLen = /^[~!+^_][ \t]/.test(body) ? 2 : 1;
      rest = body.slice(prefixLen);
    }
    const speech = /^([^:]{1,60}):(?:[ \t](.*)|)$/.exec(rest);
    if (speech) {
      let name = speech[1];
      let nameStart = indent + prefixLen;
      // the plate and the expression in either order; the studio takes `Name as "plate" (expr)`
      for (let k = 0; k < 2; k++) {
        const plate = line.plate === undefined && /\s+as\s+"([^"]*)"\s*$/.exec(name);
        if (plate) { line.plate = plate[1]; name = name.slice(0, plate.index); continue; }
        const expr = line.expression === undefined && /\s*\(([^)]*)\)\s*$/.exec(name);
        if (expr) {
          line.expression = expr[1].trim(); name = name.slice(0, expr.index);
          // the plate came last, after the expression: the studio doesn't take that order
          if (line.plate !== undefined) line.expressionFirst = true;
        }
      }
      const trimmed = name.trim();
      nameStart += name.length - name.trimStart().length;
      line.kind = 'dialogue';
      line.speaker = trimmed;
      line.speakerStart = nameStart;
      line.speakerEnd = nameStart + trimmed.length;
      line.text = speech[2] || '';
      const words = trimmed.split(/\s+/).filter(Boolean);
      line.suspiciousSpeaker = words.length >= 4 || /[,;]/.test(trimmed) || trimmed.length > 28;
      const entry = record(script.speakers, trimmed, n, { expressions: new Set(), plates: new Set() });
      if (line.expression) entry.expressions.add(line.expression);
      if (line.plate) entry.plates.add(line.plate);
      // a plate can print a variable too: `Anna as "{var=REF}": ...`
      if (line.plate) scanText(script, n, line.plate, indent + prefixLen + rest.indexOf(`"${line.plate}"`) + 1);
      scanText(script, n, line.text, indent + body.length - line.text.length);
      openChoice = null;
      continue;
    }

    line.kind = 'text';
    scanText(script, n, body, indent);
    openChoice = null;
  }

  parseDeclarationComments(script, commentLines);
  // a {var=REF_...} placeholder reads the variable the References row names
  for (const [ref, name] of script.declared.references) {
    const v = script.variables.get(ref);
    if (!v) continue;
    variable(script, name).reads.push(...v.reads);
    script.variables.delete(ref);
  }
  buildBlocks(script);
  return script;
}

function parseDirective(script, line, indent) {
  const { directive: d, args, n } = { directive: line.directive, args: line.args, n: line.n };
  const base = line.argsStart;

  const pushRef = (name, start, via) => {
    if (!name) return;
    script.labelRefs.push({ name, line: n, start, end: start + name.length, via });
  };

  switch (d) {
    case 'label': {
      const m = /^(\S+)/.exec(args);
      if (m) {
        line.label = m[1];
        const existing = script.labels.get(m[1]);
        const entry = { name: m[1], line: n, start: base, end: base + m[1].length, duplicate: Boolean(existing) };
        if (existing) (existing.duplicates = existing.duplicates || []).push(entry);
        else script.labels.set(m[1], entry);
      }
      break;
    }
    case 'jump':
    case 'call': {
      const m = /^(\S+)/.exec(args);
      if (m) {
        line.target = m[1];
        pushRef(m[1], base, d);
      }
      const ret = /\breturn[ \t]+(\S+)/.exec(args);
      if (ret) {
        line.returnTo = ret[1];
        pushRef(ret[1], base + ret.index + ret[0].length - ret[1].length, 'return');
      }
      line.isCall = d === 'call' || /\bcall\b/.test(args);
      break;
    }
    case 'if': {
      const m = /^(.*?)->[ \t]*(\S+)(?:[ \t]+else[ \t]+(\S+))?[ \t]*$/.exec(args);
      if (m) {
        scanExpression(script, n, m[1], base, 'if');
        const thenAt = base + args.indexOf('->') + args.slice(args.indexOf('->')).indexOf(m[2]);
        pushRef(m[2], thenAt, 'if');
        if (m[3]) pushRef(m[3], base + args.lastIndexOf(m[3]), 'else');
        line.branch = { then: m[2], else: m[3] || null, condition: m[1].trim() };
      } else {
        scanExpression(script, n, args, base, 'if');
      }
      break;
    }
    case 'when':
      scanExpression(script, n, args, base, 'when');
      line.guard = true;
      break;
    case 'switch': {
      const head = /^([A-Za-z_][\w.]*)\s*:/.exec(args);
      let body = args;
      let bodyBase = base;
      if (head) {
        variable(script, head[1]).reads.push({ line: n, start: base, end: base + head[1].length, via: 'switch' });
        line.switchVar = head[1];
        body = args.slice(head[0].length);
        bodyBase = base + head[0].length;
      }
      const cases = [];
      const caseRe = /(?:^|,)\s*(?:"([^"]*)"|([A-Za-z_][\w.]*|-?\d+(?:\.\d+)?))\s*->\s*([^\s,]+)/g;
      let m;
      while ((m = caseRe.exec(body))) {
        const target = m[3];
        const at = bodyBase + m.index + m[0].lastIndexOf(target);
        pushRef(target, at, 'switch');
        cases.push({ value: m[1] !== undefined ? m[1] : m[2], target, isElse: (m[2] || '').toLowerCase() === 'else' });
      }
      line.cases = cases;
      break;
    }
    case 'random': {
      const body = args.replace(/^:/, '');
      const bodyBase = base + (args.length - body.length);
      const rowRe = /(?:^|,)\s*([^\s,]+)\s*->\s*([^\s,]+)/g;
      const cases = [];
      let m;
      while ((m = rowRe.exec(body))) {
        const target = m[2];
        pushRef(target, bodyBase + m.index + m[0].lastIndexOf(target), 'random');
        cases.push({ value: m[1], target, isElse: false });
      }
      line.cases = cases;
      break;
    }
    case 'import': {
      const m = /->[ \t]*(\S+)(?:[ \t]+else[ \t]+(\S+))?/.exec(args);
      if (m) {
        const thenAt = base + m.index + m[0].indexOf(m[1]);
        pushRef(m[1], thenAt, 'import');
        if (m[2]) pushRef(m[2], base + args.lastIndexOf(m[2]), 'else');
        line.branch = { then: m[1], else: m[2] || null, condition: 'code matched' };
      }
      scanText(script, n, args, base);
      break;
    }
    case 'set':
      scanAssignments(script, n, args, base, 'set');
      break;
    case 'toggle': {
      const m = /^([A-Za-z_][\w.]*)/.exec(args);
      if (m) variable(script, m[1]).writes.push({ line: n, start: base, end: base + m[1].length, op: 'toggle', value: '', via: 'toggle' });
      break;
    }
    case 'input': {
      const m = /^([A-Za-z_][\w.]*)/.exec(args);
      if (m) {
        variable(script, m[1]).writes.push({ line: n, start: base, end: base + m[1].length, op: 'input', value: '', via: 'input' });
        variable(script, m[1]).type = variable(script, m[1]).type || 'text';
        line.inputVar = m[1];
      }
      scanText(script, n, args, base);
      break;
    }
    case 'end': {
      const { clean, tags } = scanTrailingTags(args, base);
      const info = { name: clean.trim(), key: null, hidden: false, line: n, start: base, end: base + clean.trimEnd().length };
      addTagEffects(script, n, tags, info);
      line.ending = info;
      line.tags = tags;
      script.endings.push(info);
      scanText(script, n, clean, base);
      break;
    }
    case 'scene': {
      const pipe = args.indexOf('|');
      let nameRaw = pipe === -1 ? args : args.slice(0, pipe);
      const transition = pipe === -1 ? '' : args.slice(pipe + 1).trim();
      let keep = false;
      const keepM = /\s+keep\s*$/.exec(nameRaw);
      if (keepM) { keep = true; nameRaw = nameRaw.slice(0, keepM.index); }
      const name = nameRaw.trim();
      line.scene = { name, keep, transition, start: base, end: base + nameRaw.trimEnd().length };
      if (name && name !== '-') record(script.backgrounds, name, n, {});
      break;
    }
    case 'beat': {
      const m = /^([^\d][^\n]*?)(?:[ \t]+\d+)?(?:[ \t]+nowait)?[ \t]*$/.exec(args);
      const name = m ? m[1].trim() : '';
      if (name && name !== '-') {
        line.scene = { name, keep: false, transition: '', start: base, end: base + name.length, beat: true };
        record(script.backgrounds, name, n, {});
      }
      break;
    }
    case 'export':
      scanTemplate(script, n, args, base);
      break;
    case 'show':
    case 'move':
    case 'hide': {
      const m = /^(\S+(?:[ \t]+\S+)*?)(?=[ \t]+(?:at|as|to|part|scale|z|glide|flip)\b|[ \t]*$)/.exec(args);
      const name = m ? m[1].trim() : args.trim();
      if (name) {
        line.actor = { name, start: base, end: base + name.length };
        const entry = record(script.speakers, name, n, { expressions: new Set(), plates: new Set() });
        const asM = /\bas[ \t]+([\w-]+)/.exec(args);
        if (asM) entry.expressions.add(asM[1]);
      }
      break;
    }
    case 'music':
    case 'ambience':
    case 'sfx':
    case 'voice': {
      const cue = args.replace(/\b(loop|once)\b/g, '').replace(/\bfade[ \t]+\d+/g, '').replace(/^"|"$/g, '').trim();
      if (cue) {
        line.cue = cue;
        record(script.cues, cue, n, { channel: d });
      }
      break;
    }
    default:
      scanText(script, n, args, base);
      break;
  }

  scanSigils(script, n, args, base, d);
  if (STAGE_DIRECTIVES.has(d)) line.isStage = true;
  if (AUDIO_DIRECTIVES.has(d)) line.isAudio = true;
}

/** Split the script into blocks: a block starts at a `@label` (or at the top of the file). */
function buildBlocks(script) {
  /** @type {any[]} */
  const blocks = [];
  let current = { index: 0, name: null, label: null, line: 0, endLine: script.lines.length - 1, lines: [], chapter: null };
  blocks.push(current);
  let chapter = null;
  for (const line of script.lines) {
    if (line.kind === 'chapter') chapter = line.name;
    if (line.kind === 'directive' && line.directive === 'label' && line.label) {
      current.endLine = line.n - 1;
      current = { index: blocks.length, name: line.label, label: line.label, line: line.n, endLine: script.lines.length - 1, lines: [], chapter };
      blocks.push(current);
    }
    current.lines.push(line);
    line.block = current.index;
    if (!current.chapter) current.chapter = chapter;
  }
  script.blocks = blocks;
}

function blockAt(script, lineNumber) {
  const line = script.lines[lineNumber];
  return line ? script.blocks[line.block] : script.blocks[0];
}

module.exports = { parseScript, blockAt, scanTrailingTags, splitArrow, CONDITION_KEYWORDS };
