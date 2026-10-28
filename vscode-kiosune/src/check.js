'use strict';

/**
 * The flow checks — the static half of the studio's `✓ check`, plus the traps
 * that only bite when you author the text by hand.
 *
 * Every finding is `{ code, severity, line, start, end, message }` with
 * character offsets into that line. Pure, so the tests can assert on it.
 */

const { DIRECTIVES, SHADOWING, EFFECT_DIRECTIVES, VOCABULARY } = require('./directives');

const COORD = '-?\\d+(?:\\.\\d+)?\\s*,\\s*-?\\d+(?:\\.\\d+)?';
/** Where each actor directive names a place, and where it names a motion. */
const PLACE_AT = { show: new RegExp(`\\bat[ \\t]+(${COORD}|\\S+)`), move: new RegExp(`\\bto[ \\t]+(${COORD}|\\S+)`) };
const MOTION_AT = { show: /\benter[ \t]+(\S+)/, hide: /\bexit[ \t]+(\S+)/ };
/** `{pause=ms}` `{speed=x}` `{color=#hex}` `{var=id}`: the tag name must be followed by `=`. */
const MARKUP_TAG = /(?<!\\)\{\s*(pause|speed|color|var)\b(?!=)/gi;
/** A `#` after a space that does not start a #hex colour (`@flash #ffffff 200`) starts a comment. */
const TRAILING_COMMENT = /\s#(?![0-9A-Fa-f]{3,8}\b)/;
/** Directives whose arguments are free text or quoted, where a `#` is just a character. */
const FREE_TEXT = new Set(['caption', 'input', 'export', 'import', 'channel', 'end']);

const DEFAULTS = {
  placeholders: 'hint',
  unprefixedColon: 'warning',
  unknownDirective: 'warning',
  unusedVariables: true,
  extraDirectives: []
};

function checkScript(script, graph, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  /** @type {any[]} */
  const found = [];
  const add = (severity, line, start, end, code, message) => {
    if (severity === 'off') return;
    found.push({ severity, line, start, end, code, message });
  };
  const lineEnd = (n) => (script.lines[n] ? script.lines[n].raw.length : 0);
  const whole = (n) => ({ start: script.lines[n] ? script.lines[n].indent : 0, end: lineEnd(n) });

  checkChoices(script, add, whole);
  checkLabels(script, graph, add, whole);
  checkFlow(script, graph, add, whole);
  checkReturns(script, graph, add, whole);
  checkGuardsAndStageBlocks(script, add, whole);
  checkSpeakers(script, opts, add);
  checkVariables(script, opts, add);
  checkAssets(script, add);
  checkMarkup(script, add);
  checkDirectives(script, opts, add);
  checkVocabulary(script, add);
  checkPlaceholders(script, opts, add);

  found.sort((a, b) => a.line - b.line || a.start - b.start);
  return found;
}

function checkChoices(script, add, whole) {
  /** Options stranded by an interruption we have already reported. */
  const excused = new Set();
  for (const choice of script.choices) {
    const promptLine = choice.line;
    // Nothing may sit between a `?` and its options: a blank line or a comment
    // ends the choice on import and the options become narration.
    for (let n = promptLine + 1; n < script.lines.length; n++) {
      const line = script.lines[n];
      if (line.kind === 'option') break;
      if (line.kind === 'blank' || line.kind === 'comment' || line.kind === 'pragma') {
        add('error', n, whole(n).start, Math.max(whole(n).end, 1), 'choice-interrupted',
          `A ${line.kind === 'blank' ? 'blank line' : 'comment'} between the choice on line ${promptLine + 1} and its options ends the choice on import — the options below import as narration.`);
        choice.interrupted = line.kind;
        for (let k = n + 1; k < script.lines.length; k++) {
          const stranded = script.lines[k];
          if (stranded.kind === 'option') excused.add(k);
          else if (stranded.kind !== 'blank' && stranded.kind !== 'comment') break;
        }
        break;
      }
      break;
    }

    if (choice.options.length === 0) {
      if (choice.interrupted) continue;
      add('warning', promptLine, whole(promptLine).start, whole(promptLine).end, 'choice-empty',
        'This choice has no options under it.');
      continue;
    }

    const timer = choice.tags.find((t) => t.name === 'timer');
    if (timer) {
      const parts = timer.arg.split(/\s+/).filter(Boolean).filter((p) => !/^(fill|nobar|nopause)$/i.test(p));
      // `[timer ms]` with no index takes the default path, which is legal and needs no check.
      const index = parts.length > 1 ? Number(parts[1]) : null;
      if (index === null) {
        // nothing to check
      } else if (!Number.isInteger(index) || index < 1 || index > choice.options.length) {
        add('warning', promptLine, timer.start, timer.end, 'timer-index',
          `[timer] picks option ${parts[1]} by position, but this choice has ${choice.options.length} options.`);
      } else {
        const shifting = choice.options.slice(0, index - 1).filter((o) => o.conditional);
        if (shifting.length) {
          add('warning', promptLine, timer.start, timer.end, 'timer-index',
            `[timer] picks option ${index} by position, but ${shifting.length} conditional option${shifting.length > 1 ? 's sit' : ' sits'} above it (line${shifting.length > 1 ? 's' : ''} ${shifting.map((o) => o.line + 1).join(', ')}). When ${shifting.length > 1 ? 'those are' : 'it is'} hidden the timer picks a different option. Keep conditional options below the timer's target.`);
        }
      }
    }

    if (choice.kind === 'choice') {
      const always = choice.options.filter((o) => !o.conditional);
      if (!always.length) {
        add('warning', promptLine, whole(promptLine).start, whole(promptLine).end, 'choice-all-conditional',
          'Every option here is behind an [if], so this choice can come up empty and dead-end. Leave one option always available.');
      }
      // Two rows with the same text are fine when their [if]s are exact opposites (`x` and
      // `not x`): only one can ever show. That is the locked-option pattern without [grey].
      const condOf = (o) => {
        const tag = o.tags.find((t) => t.name === 'if');
        return tag ? tag.arg.trim().replace(/\s+/g, ' ') : null;
      };
      const negate = (c) => (/^not\s+/.test(c) ? c.replace(/^not\s+/, '') : `not ${c}`);
      const exclusive = (a, b) => {
        const ca = condOf(a);
        const cb = condOf(b);
        return !!ca && !!cb && (negate(ca) === cb || negate(cb) === ca);
      };
      const seen = new Map();
      for (const option of choice.options) {
        const text = option.text.trim();
        if (!text || /^_+$/.test(text)) continue;
        const earlier = seen.get(text) || [];
        const clash = earlier.find((o) => !exclusive(o, option));
        if (clash) {
          add('information', option.line, whole(option.line).start, whole(option.line).end, 'duplicate-option',
            `Same option text as line ${clash.line + 1}.`);
        }
        seen.set(text, [...earlier, option]);
      }
    } else if (choice.kind === 'router') {
      for (const option of choice.options) {
        if (!option.target) {
          add('error', option.line, whole(option.line).start, whole(option.line).end, 'row-no-target',
            'A `@router` row needs a `-> label`.');
        }
      }
      const elses = choice.options.filter((o) => o.isElse);
      if (choice.kind === 'router' && !elses.length) {
        add('information', choice.line, whole(choice.line).start, whole(choice.line).end, 'router-no-else',
          'This @router has no `else` row, so when nothing matches it runs on into the next block. Add one if that is not what you want.');
      }
      elses.forEach((option, i) => {
        if (option !== choice.options[choice.options.length - 1] && i === elses.length - 1) {
          add('warning', option.line, whole(option.line).start, whole(option.line).end, 'else-not-last',
            'Rows are tested in order, so rows below `else` can never win.');
        }
      });
    }
  }

  for (const line of script.lines) {
    if (line.kind === 'option' && line.orphanOption && !excused.has(line.n)) {
      add('warning', line.n, whole(line.n).start, whole(line.n).end, 'option-orphan',
        'This option is not under a `?` or `@router`, so it imports as narration.');
    }
  }
}

function checkLabels(script, graph, add, whole) {
  for (const [name, label] of script.labels) {
    for (const dup of label.duplicates || []) {
      add('error', dup.line, dup.start, dup.end, 'duplicate-label',
        `Label \`${name}\` is already defined on line ${label.line + 1}.`);
    }
  }
  for (const ref of script.labelRefs) {
    if (!script.labels.has(ref.name)) {
      add('error', ref.line, ref.start, ref.end, 'unknown-label',
        `No \`@label ${ref.name}\` in this script.`);
      continue;
    }
    if ((ref.via === 'seen' || ref.via === 'visited') && /^l_\d+$/.test(ref.name)) {
      add('warning', ref.line, ref.start, ref.end, 'generated-label-gate',
        `\`${ref.via}(${ref.name})\` gates on an auto-generated label. A re-export can renumber it and this unlock then breaks silently — rename it to something you chose.`);
    }
  }
}

function checkFlow(script, graph, add, whole) {
  for (const node of graph.nodes.values()) {
    if (!node.reachable) {
      add('warning', node.line, whole(node.line).start, whole(node.line).end, 'unreachable',
        `Nothing reaches \`${node.id}\`: no jump, option, branch or fall-through leads here.`);
    }
    if (node.fallsOffEnd) {
      add('warning', node.line, whole(node.line).start, whole(node.line).end, 'falls-off-end',
        `\`${node.id}\` runs off the end of the file without \`@end\`, \`@jump\` or \`@stop\`.`);
    }
    for (const n of node.unreachableLines || []) {
      add('information', n, whole(n).start, whole(n).end, 'after-terminal',
        `This line sits after the ${node.terminal.kind === 'choice' ? 'choice' : '`@' + (script.lines[node.terminal.line].directive || node.terminal.kind) + '`'} on line ${node.terminal.line + 1}, so it never runs.`);
    }
  }
  if (!graph.endings.length) {
    add('information', 0, 0, Math.max(1, script.lines[0] ? script.lines[0].raw.length : 1), 'no-endings',
      'No `@end` anywhere in this script.');
  }
  for (const ending of script.endings) {
    if (!ending.name) {
      add('information', ending.line, ending.start, Math.max(ending.end, ending.start + 4), 'ending-unnamed',
        'Name this ending. A bare `@end` gives up the Endings screen and the ending key.');
    }
  }
}

/**
 * A `@return` the story reaches without a `@call` has no caller. Walk the graph from the
 * start without stepping into calls: any block still reached that runs a `@return` was
 * entered by a jump, an option, a branch or a fall-through.
 */
function checkReturns(script, graph, add, whole) {
  const queue = graph.startId ? [graph.startId] : [];
  const seen = new Set(queue);
  while (queue.length) {
    const node = graph.nodes.get(queue.shift());
    if (!node) continue;
    const block = script.blocks[node.index];
    const dead = new Set(node.unreachableLines || []);
    const ret = block.lines.find((l) => l.kind === 'directive' && l.directive === 'return' && !dead.has(l.n));
    if (ret) {
      add('warning', ret.n, whole(ret.n).start, whole(ret.n).end, 'return-without-call',
        `\`${node.label || 'The start'}\` is entered by a jump, option, branch or fall-through, not a \`@call\`, so this \`@return\` has no caller. Reach it with \`@call\`, or end the block with \`@jump\`.`);
      continue;
    }
    for (const edge of node.out) {
      if (edge.kind === 'call' || seen.has(edge.to) || !graph.nodes.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
}

function checkGuardsAndStageBlocks(script, add, whole) {
  const significant = (line) => line && line.kind !== 'blank' && line.kind !== 'comment' && line.kind !== 'pragma';

  for (const line of script.lines) {
    if (line.kind !== 'directive') continue;

    if (line.guard) {
      let next = script.lines[line.n + 1];
      if (!next || !significant(next)) {
        add('warning', line.n, whole(line.n).start, whole(line.n).end, 'guard-orphan',
          '`@when` guards only the next line, and the next line here is blank or a comment.');
      } else if (next.kind === 'directive' && EFFECT_DIRECTIVES.has(next.directive)) {
        add('warning', next.n, whole(next.n).start, whole(next.n).end, 'guard-stolen',
          `\`@${next.directive}\` directly after \`@when\` steals the guard from the line below it. Move it above the \`@when\`.`);
      } else if (next.kind === 'directive' && next.guard) {
        add('warning', next.n, whole(next.n).start, whole(next.n).end, 'guard-chain',
          'Two `@when` lines in a row: the first guards the second, not the text below it.');
      }
    }

    // Stage lines and their `@transition` are one change; nothing may split them.
    if (line.isStage) {
      for (let n = line.n + 1; n < script.lines.length; n++) {
        const next = script.lines[n];
        if (!significant(next)) continue;
        if (next.kind === 'directive' && (next.isStage || next.directive === 'transition')) break;
        if (next.kind === 'directive' && EFFECT_DIRECTIVES.has(next.directive)) {
          const after = script.lines.slice(n + 1).find(significant);
          if (after && after.kind === 'directive' && after.directive === 'transition') {
            add('warning', n, whole(n).start, whole(n).end, 'fx-splits-stage',
              `\`@${next.directive}\` between the stage lines and their \`@transition\` splits one stage change into two.`);
          }
        }
        break;
      }
    }
  }
}

function checkSpeakers(script, opts, add) {
  const declared = script.declared.cast;
  for (const line of script.lines) {
    if (line.kind !== 'dialogue') continue;
    if (line.expressionFirst) {
      add('warning', line.n, line.speakerStart, line.speakerEnd, 'plate-order',
        `\`${line.speaker} (${line.expression}) as "${line.plate}"\` does not work in the studio: the plate comes first — \`${line.speaker} as "${line.plate}" (${line.expression}):\`.`);
    }
    const known = declared.size ? declared.has(line.speaker) : false;
    if (known) continue;
    const undeclared = declared.size > 0;
    if (line.suspiciousSpeaker || undeclared) {
      const severity = line.suspiciousSpeaker ? opts.unprefixedColon : (undeclared ? 'warning' : 'off');
      const why = line.suspiciousSpeaker
        ? `"${line.speaker}" reads like prose, not a name. Narration containing a colon must start with \`:\` — otherwise the importer makes a junk character out of the text before it.`
        : `"${line.speaker}" is not in the cast declared at the top of this file. An unknown speaker imports as a blank character.`;
      add(severity, line.n, line.speakerStart, line.speakerEnd, 'unprefixed-colon', why);
    }
  }
}

function checkVariables(script, opts, add) {
  const declared = script.declared.variables;
  for (const [name, v] of script.variables) {
    const first = v.writes[0] || v.reads[0];
    if (!first) continue;
    if (declared.size && !declared.has(name)) {
      add('warning', first.line, first.start, first.end, 'undeclared-variable',
        `\`${name}\` is not in the variables declared at the top of this file. Create it in the project before importing — unknown names import empty.`);
    }
    if (SHADOWING.has(name.toLowerCase())) {
      add('information', first.line, first.start, first.end, 'variable-shadows-directive',
        `\`${name}\` is also a directive name; it works, but \`@${name.toLowerCase()}\` next to it is confusing. Prefer something like \`stay${name[0].toUpperCase()}${name.slice(1)}\`.`);
    }
    if (!opts.unusedVariables) continue;
    if (v.writes.length && !v.reads.length) {
      add('information', v.writes[0].line, v.writes[0].start, v.writes[0].end, 'variable-never-read',
        `\`${name}\` is written but never read. Either it is vestigial, or something outside the script (a theme, a \`{var=}\`) reads it.`);
    }
    if (v.reads.length && !v.writes.length) {
      add('warning', v.reads[0].line, v.reads[0].start, v.reads[0].end, 'variable-never-written',
        `\`${name}\` is read but never written, so it always has its default value.`);
    }
  }
  for (const [name, decl] of declared) {
    if (!script.variables.has(name)) {
      add('information', decl.line, 0, Math.max(1, script.lines[decl.line] ? script.lines[decl.line].raw.length : 1), 'variable-unused',
        `\`${name}\` is declared here but never used in the script.`);
    }
  }
}

function checkAssets(script, add) {
  if (script.declared.backgrounds.size) {
    for (const line of script.lines) {
      // `@scene` and `@beat <Background>` both name one.
      if (line.kind === 'directive' && line.scene && line.scene.name && line.scene.name !== '-') {
        if (!script.declared.backgrounds.has(line.scene.name)) {
          add('warning', line.n, line.scene.start, line.scene.end, 'undeclared-background',
            `\`${line.scene.name}\` is not one of the backgrounds declared at the top of this file. Names are matched exactly, and an unknown one imports empty.`);
        }
      }
    }
  }
}

/** Markup only means something in text the player reads; a glob in an `@import` row is not italics. */
function carriesMarkup(line) {
  if (line.kind === 'dialogue' || line.kind === 'narration' || line.kind === 'text' || line.kind === 'choice') return true;
  if (line.kind === 'option') return !line.option || !line.option.choice || line.option.choice.kind === 'choice';
  if (line.kind === 'directive') return line.directive === 'caption' || line.directive === 'end';
  return false;
}

function checkMarkup(script, add) {
  for (const line of script.lines) {
    if (!carriesMarkup(line)) continue;
    const text = line.raw;
    const opens = (text.match(/\{color=/g) || []).length;
    const closes = (text.match(/\{\/color\}/g) || []).length;
    if (opens !== closes) {
      add('warning', line.n, line.indent, text.length, 'unbalanced-markup',
        `Unbalanced colour markup: ${opens} \`{color=…}\` against ${closes} \`{/color}\`.`);
    }
    const stripped = text.replace(/\*\*/g, '');
    const stars = (stripped.match(/\*/g) || []).length;
    if (stars % 2 === 1) {
      add('information', line.n, line.indent, text.length, 'unbalanced-markup',
        'Odd number of `*`: an italic run is left open.');
    }
    for (const m of text.matchAll(MARKUP_TAG)) {
      add('warning', line.n, m.index, m.index + m[0].length, 'markup-malformed',
        `\`{${m[1]}\` needs an \`=\`: write \`{${m[1].toLowerCase()}=…}\`.`);
    }
    const braces = (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;
    if (braces !== 0) {
      add('warning', line.n, line.indent, text.length, 'unbalanced-markup', 'Unbalanced `{` and `}`.');
    }
  }
}

function checkDirectives(script, opts, add) {
  const extra = new Set((opts.extraDirectives || []).map((d) => String(d).replace(/^@/, '').toLowerCase()));
  for (const line of script.lines) {
    if (line.kind !== 'directive' || line.known || extra.has(line.directive)) continue;
    add(opts.unknownDirective, line.n, line.indent, line.indent + 1 + line.rawDirective.length, 'unknown-directive',
      `\`@${line.rawDirective}\` is not a directive this extension knows. If your build has it, add it to \`kiosune.extraDirectives\`.`);
  }
}

function checkVocabulary(script, add) {
  for (const line of script.lines) {
    if (line.kind !== 'directive') continue;
    const args = line.args || '';
    const base = line.argsStart;
    const d = line.directive;
    if (!FREE_TEXT.has(d)) {
      const m = TRAILING_COMMENT.exec(args.replace(/"[^"]*"/g, (q) => '"' + ' '.repeat(q.length - 2) + '"'));
      if (m) {
        add('warning', line.n, base + m.index + 1, line.raw.length, 'directive-comment',
          'A `#` after the command is read as part of it, not as a comment. Move the comment to its own line.');
      }
    }
    if (PLACE_AT[d]) {
      const m = PLACE_AT[d].exec(args.split('#')[0]);
      if (m && !new RegExp(`^${COORD}$`).test(m[1]) && !VOCABULARY.places.includes(m[1])) {
        const start = base + m.index + m[0].length - m[1].length;
        const fix = VOCABULARY.places.includes(m[1].toLowerCase())
          ? `Places are lowercase keywords: write \`${m[1].toLowerCase()}\`.`
          : `Places are ${VOCABULARY.places.map((p) => '`' + p + '`').join(' ')} or \`x,y\`.`;
        add('warning', line.n, start, start + m[1].length, 'place-unknown', `\`${m[1]}\` is not a place. ${fix}`);
      }
    }
    if (MOTION_AT[d]) {
      const m = MOTION_AT[d].exec(args);
      if (m && !VOCABULARY.motions.includes(m[1])) {
        const start = base + m.index + m[0].length - m[1].length;
        add('warning', line.n, start, start + m[1].length, 'motion-unknown',
          `\`${m[1]}\` is not an entrance or exit motion: use ${VOCABULARY.motions.map((x) => '`' + x + '`').join(' ')}.${VOCABULARY.transitions.includes(m[1]) ? ` \`${m[1]}\` is a transition — put it on a \`@transition\` line.` : ''}`);
      }
    }
    if (d === 'adv' && args.trim()) {
      add('warning', line.n, base, base + args.length, 'adv-argument',
        '`@adv` takes no argument: the cheat sheet has `@nvl [clear]` but a bare `@adv`.');
    }
  }
}

function checkPlaceholders(script, opts, add) {
  if (opts.placeholders === 'off') return;
  /** @type {Map<number, any[]>} */
  const byLine = new Map();
  for (const ph of script.placeholders) {
    if (!byLine.has(ph.line)) byLine.set(ph.line, []);
    byLine.get(ph.line).push(ph);
  }
  for (const [n, list] of byLine) {
    add(opts.placeholders, n, list[0].start, list[list.length - 1].end, 'placeholder',
      list.length === 1 ? 'Not written yet.' : `${list.length} placeholders on this line.`);
  }
}

/** A one-paragraph summary for the output channel. */
function summarise(script, graph, findings) {
  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  const words = script.lines
    .filter((l) => l.kind === 'dialogue' || l.kind === 'narration' || l.kind === 'text')
    .reduce((n, l) => n + (l.text || '').replace(/_{3,}/g, ' ').split(/\s+/).filter(Boolean).length, 0);
  return {
    labels: script.labels.size,
    blocks: graph.nodes.size,
    edges: graph.edges.length,
    endings: script.endings.length,
    choices: script.choices.filter((c) => c.kind === 'choice').length,
    variables: script.variables.size,
    speakers: script.speakers.size,
    backgrounds: script.backgrounds.size,
    placeholders: script.placeholders.length,
    words,
    errors: counts.error || 0,
    warnings: counts.warning || 0,
    infos: counts.information || 0
  };
}

module.exports = { checkScript, summarise, DEFAULTS };
