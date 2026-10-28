'use strict';

/**
 * What the extension knows about the language.
 *
 * The signatures come from the official cheat sheet
 * (kiosune.com/tutorials/script-cheat-sheet, kept verbatim in
 * docs/kiosune-script-cheat-sheet.md). The notes around them come from the Kiosune
 * Studio guide and from docs/kiosune-scripting.md, which is where the working
 * practice and the traps live.
 *
 * `terminal` means a block that ends on this line does not run on into the next
 * `@label`; the scene map uses it to decide whether to draw a fall-through edge.
 * `rows` means the directive is followed by `-` rows rather than taking its
 * arguments inline.
 */

/** @typedef {{sig: string, doc: string, group: string, terminal?: boolean, guard?: boolean, rows?: boolean}} Directive */

/** @type {Record<string, Directive>} */
const DIRECTIVES = {
  // ── the stage ──────────────────────────────────────────────────────────────
  scene: {
    sig: '@scene <Name> [keep] [| <kind> <ms>]',
    group: 'stage',
    doc: 'Change the background. The name is matched to a background in the project, unquoted, spaces and `·` allowed. `-` is the no-background (black) scene. `keep` keeps the actors and effects on stage. Transition grammar in this project: `fade 900–1400` a time jump, `fade 1800–2600` weight, `pixellate 600` a montage, `flash 160` into and out of a vision, `none 0` a hard cut.'
  },
  show: {
    sig: '@show <Name> [at <place>] [as <expr>] [part G:O] [scale n] [flip] [dim] [z n] [enter <kind> <ms>]',
    group: 'stage',
    doc: 'Put an actor on stage. Places are `farleft left center right farright offscreen` or `x,y`, where **y is the feet row** — on a 480×270 canvas `y = 270` stands on the bottom edge. Consecutive stage lines merge into one change, so write the whole block and then one `@transition`.'
  },
  move: {
    sig: '@move <Name> to <place> [glide <ms>]   ·   @move <Name> as <expr> [part G:O]',
    group: 'stage',
    doc: 'Move an actor, or — with only `as`/`part` — swap its expression or parts in place. Restate the parts you want kept; whether they persist through an expression change is undocumented.'
  },
  hide: {
    sig: '@hide <Name> [exit <kind> <ms>]',
    group: 'stage',
    doc: 'Take an actor off stage. Pair it with a `@transition`, or give it its own exit motion: `fade slideleft slideright drop rise`.'
  },
  clear: { sig: '@clear', group: 'stage', doc: 'Clear the stage — every actor off at once.' },
  transition: {
    sig: '@transition <kind> <ms> [#color] [ease]',
    group: 'stage',
    doc: 'Closes a stage block: the lines above it become one change that plays over this transition. Kinds: `fade dissolve pixellate slideleft slideright wipe flash shake none`. Never insert anything between the stage lines and their `@transition`.'
  },
  overlay: { sig: '@overlay #rrggbb[aa] | off', group: 'stage', doc: 'Tint the whole screen. Alpha is the last byte: `#ff6fb522` is about 13%.' },
  caption: { sig: '@caption <text> | off', group: 'stage', doc: 'The HUD caption. A `@scene` appears to clear it, so re-issue it after every scene change. Doubles as a ticking clock.' },
  insert: {
    sig: '@insert <Image> [fit contain|cover|none] [at center|top|bottom|left|right] [scale n] [offset x,y] [dim n] [in <kind> <ms>] [out <kind> <ms>] [showui] click|timer <ms>|stay\n@insert close [out <kind> <ms>]',
    group: 'stage',
    doc: 'Show an image over the scene — a letter, a map, a photo — dimming what is behind it. It returns on a click or after a timer; `stay` keeps it up until `@insert close`. History lists it as "(image: …)".'
  },

  // ── effects ────────────────────────────────────────────────────────────────
  fx: {
    sig: '@fx show <effect> [as <name>] [at x,y] [size w,h] [layer <L>] [z n] [region rect|full|circle] [keep] [key=value…] [enter <kind> <ms>]\n@fx move <name> [to x,y] [size w,h] [over <ms>] [linear]\n@fx hide <name> [exit <kind> <ms>]\n@fx clear',
    group: 'effects',
    doc: 'A placed, addressable stage effect. Layers: `behind_bg behind_sprites above_sprites above_grade above_ui`. Built-in ids: `rain_light rain_heavy snow dust_motes embers fireflies bubbles petals leaves sparks stars candle_glow moonlight spotlight crt_scan film_grain fog_sheet vignette_obj heat_shimmer water_ripple glitch sheet_sparkle`, plus anything from the FX Lab. Name it with `as` if you want to move or hide it later. It probably ends at the next `@scene` unless it or the scene says `keep`.'
  },
  grade: {
    sig: '@grade <Preset> <ms> [field=$var from a..b to c..d]   ·   @grade off <ms>',
    group: 'effects',
    doc: 'A colour grade over the scene, never over the interface. A field can follow a variable, mapped from that variable\'s range onto the field\'s. It persists until `@grade off`, so every grade needs a planned exit.'
  },
  effect: { sig: '@effect <name> on | off', group: 'effects', doc: 'A full-screen engine effect, on or off: `rain snow dust vignette scanlines grayscale sepia`. These are built in, so they do not have to be baked into the art.' },
  shake: { sig: '@shake <px> <ms>', group: 'effects', doc: 'Screen shake.' },
  flash: { sig: '@flash #color <ms>', group: 'effects', doc: 'A full-screen colour flash.' },

  // ── audio ──────────────────────────────────────────────────────────────────
  music: { sig: '@music <Name> [loop] [fade|crossfade <ms>] [volume <v>]', group: 'audio', doc: 'Music persists across scenes until changed or stopped, so most scenes issue no music command at all. Quoting names with spaces is the safer habit.' },
  ambience: { sig: '@ambience <Name> [loop] [fade <ms>] [volume <v>]', group: 'audio', doc: 'The second tracked audio channel, with its own volume, saved and restored.' },
  sfx: { sig: '@sfx <Name>', group: 'audio', doc: 'Fire a sound effect.' },
  voice: { sig: '@voice <Name>', group: 'audio', doc: 'Play a voice clip.' },
  stop: {
    sig: '@stop   ·   @stop music|ambience|sfx|voice [<ms>]',
    group: 'flow',
    doc: '**Two commands in one word.** With a channel it fades that audio out over `ms` and the script carries on. On its own it *ends the chain*: the story stops there, without recording an ending, so prefer `@end` for anything the player should see on the Endings screen.'
  },

  // ── text ───────────────────────────────────────────────────────────────────
  nvl: { sig: '@nvl [clear]', group: 'text', doc: 'Switch to full-screen prose. Reserve it for text that is meant to feel like reading.' },
  adv: { sig: '@adv', group: 'text', doc: 'Back to the dialogue box. It takes no argument: the cheat sheet has `@nvl [clear]` but a bare `@adv`.' },
  channel: { sig: '@channel "<Name>" | off', group: 'text', doc: 'The lines that follow go in that text channel — a different box, styled by the theme.' },
  ui: { sig: '@ui textbox on|off nameplate on|off menu on|off <ms>', group: 'text', doc: 'Show or hide the textbox, the name plate and the quick menu. Hide the textbox for a silent sequence.' },
  beat: { sig: '@beat <Background> <ms> [nowait]   ·   @beat - <ms>', group: 'flow', doc: 'An empty advance step, optionally crossfading to a background. `nowait` runs straight on instead of waiting for a click. Eight in a row make a wordless montage.' },
  wait: { sig: '@wait <ms> | click', group: 'flow', doc: 'Pause for a time, or until the player clicks. `@wait 10000` on a black `@scene -` is a deliberate ten-second silence.' },

  // ── flow ───────────────────────────────────────────────────────────────────
  label: { sig: '@label <name>', group: 'flow', doc: 'A named place. Give every label you gate on with `seen()` a meaningful name — an exported `l_42` can be renumbered by a re-export and the gate then breaks silently.' },
  jump: { sig: '@jump <label>', group: 'flow', terminal: true, doc: 'Go to a label. File order is not play order: the exporter puts each branch after an unconditional `@jump`, and a block after one is reachable only through its `@label`.' },
  call: { sig: '@call <label> [return <label>]', group: 'flow', doc: 'Run a subroutine and come back to the next line, or to `return <label>`. Use one for any repeated reaction.' },
  return: { sig: '@return', group: 'flow', terminal: true, doc: 'End a subroutine and resume where it was called from.' },
  end: {
    sig: '@end <Name> [hidden] [key <k>] [card "<line>"] [notitle] [color #hex] [then <label>]',
    group: 'flow',
    terminal: true,
    doc: 'End the story and record the ending. Name it: the name feeds the Endings screen and `key` is what save codes print, both of which a bare `@end` gives up. `hidden` shows it as ??? until found, `card` gives the card its own line, and `then <label>` continues somewhere — credits, a save code — instead of returning to the title screen.'
  },
  if: {
    sig: '@if <condition> -> <label> [else <label>]',
    group: 'flow',
    doc: 'A two-way branch. **With `else`** control leaves down one arm or the other. **Without `else`** it only adds a way in: when the condition is false the script carries straight on, so an optional paragraph needs a `@jump` past it on the false path, or both paths read it. Three or more cases want a `@router`, and a single different line wants a `@when`.'
  },
  when: {
    sig: '@when <condition>',
    group: 'flow',
    guard: true,
    doc: '**The next line only plays when the condition is true — that line and no more.** So: a blank line or comment after it means it guards nothing; two `@when` lines in a row do not combine into an `and` (the first guards the second); and anything an FX pass inserts after it steals the guard. To guard a block you need `@if` and a label. Stacked one-line guards are how one passage reports several pieces of state without a branch anywhere.'
  },
  router: {
    sig: '@router\n- <condition> -> <label>\n- else -> <label>',
    group: 'flow',
    rows: true,
    doc: 'An ordered table in the rows underneath: the first row that is true wins, otherwise the default. Write them **tightest first** — put `turns >= 14` above `turns >= 10` or the loose row swallows the tight one, silently. `else` goes last, and without one a router that matches nothing falls through into the next block. The player never sees it: this is the engine choosing, which is what you want for a meter\'s register, a clock, or grading an `@input` answer.'
  },
  switch: {
    sig: '@switch <value>: <case> -> <label>, … , else -> <label>',
    group: 'flow',
    doc: 'Multi-way on a value, inline: the first case equal to it wins, otherwise the default. Equality only — ranges and multi-variable tests want a `@router`. Good for "which one did they pick", where an early consequence-free choice sets a text variable and a much later `@switch` gives one private line of recognition.'
  },
  random: {
    sig: '@random: <weight> -> <label>, <weight> -> <label>',
    group: 'flow',
    doc: 'Pick one of several targets by weight — **inline, after a colon**, unlike `@router`, which takes rows underneath. *Fixed seed* in the Play workspace makes it repeatable while you test, and a draw is replayed on rollback so a player cannot reroll it by stepping back.'
  },

  // ── state ──────────────────────────────────────────────────────────────────
  set: {
    sig: '@set <var> = <value>   ·   @set <var> += <n>   ·   @set <var> %+= <n>',
    group: 'state',
    doc: 'Write a variable: `=`, `+=`, `-=`, `*=`, `/=`. On a **text** variable `+=` appends. `%+=` and `%-=` are the fair add and subtract for 0–100 meters that never overshoot; every write is clamped to the variable\'s min and max anyway, so set those in the project first. Lines run top to bottom: a `@set` must come above the line that reads it.'
  },
  toggle: { sig: '@toggle <flag>', group: 'state', doc: 'Flip a yes/no variable.' },
  input: { sig: '@input <var> "<prompt>" [max <n>] [default "<x>"]', group: 'state', doc: 'The player types into a text variable. Show it anywhere with `{var=…}`. Grade it with a `@switch` or a `@router`, and give the `else` a real answer — a typed puzzle needs a good wrong-answer line.' },
  export: {
    sig: '@export "<template>" [name=value…] [title "…"] [note "…"]',
    group: 'state',
    doc: 'Render a save code from the story\'s state and show it with a copy button. The template takes `{var}`, `{const}`, `{ending}`, `{series}` and `{cond ? \'A\' : \'B\'}`; `\\{` is a literal brace. Pair it with `@import` in the sequel.'
  },
  import: {
    sig: '@import "<prompt>" -> <matched> else <unmatched> [case]\n- <PATTERN> : <var> = <v>; …\n- +<L> : <var> = <v>',
    group: 'state',
    rows: true,
    doc: 'Ask the player for a save code, match it against the glob patterns in the rows below, run the matching row\'s assignments, then continue on the matched or unmatched exit. A `+<L>` row matches a suffix letter. `case` makes matching case-sensitive.'
  }
};

const TAGS = {
  if: { sig: '[if <condition>]', doc: 'Hide this option unless the condition holds.' },
  grey: { sig: '[grey "<hint>"]', doc: 'Show the option greyed out with a reason instead of hiding it. This is your hint system: it teaches the player what they are missing.' },
  set: { sig: '[set <var> = <value>; <var> += <n>]', doc: 'Write variables when this option is taken. Several at once, separated by `;`.' },
  mark: { sig: '[mark]', doc: 'Tick options the player has already picked. On a hub menu it is what stops the player re-reading the same spoke by accident.' },
  timer: {
    sig: '[timer <ms> [n] [fill] [nobar] [nopause]]',
    doc: 'Pick option **n by position** when the time runs out — a hidden `[if]` option above it shifts that index, so keep every conditional option below the target. Without `n` it takes the default path. `fill` makes the bar fill instead of drain, `nobar` hides it, `nopause` keeps the clock running while the history or settings screens are open.'
  },
  icon: { sig: '[icon <Name>]', doc: 'An icon on the option; names may contain spaces and parentheses.' },
  hidden: { sig: '[hidden]', doc: 'On `@end`: the ending shows as ??? on the Endings screen until it is found.' },
  key: { sig: '[key <k>]', doc: 'On `@end`: the ending key, which is what save codes print.' },
  card: { sig: '[card "<line>"]', doc: 'On `@end`: a line of its own on the ending card ("Fin.").' },
  notitle: { sig: '[notitle]', doc: 'On `@end`: do not return to the title screen.' },
  color: { sig: '[color #hex]', doc: 'On `@end`: the colour of the ending card.' },
  then: { sig: '[then <label>]', doc: 'On `@end`: continue at that label — credits, or a save code — instead of the title screen.' }
};

const FUNCTIONS = {
  seen: { sig: 'seen(<label>)', doc: 'True once that label has been reached in **any** playthrough on this device. The replay-unlock technique: put a label at the moment that should count as seen, and gate on it.' },
  visited: { sig: 'visited(<label>)', doc: 'How many times that node has run in the current playthrough. Compare it (`visited(x) >= 1`) rather than leaning on a bare count.' },
  random: { sig: 'random(<min>, <max>)', doc: 'An integer in a range, drawn when evaluated and replayed on rollback so a player cannot reroll by stepping back.' }
};

/** The closed vocabularies the cheat sheet lists, for completion and for checking. */
const VOCABULARY = {
  places: ['farleft', 'left', 'center', 'right', 'farright', 'offscreen'],
  motions: ['fade', 'slideleft', 'slideright', 'drop', 'rise'],
  transitions: ['fade', 'dissolve', 'pixellate', 'slideleft', 'slideright', 'wipe', 'flash', 'shake', 'none'],
  effects: ['rain', 'snow', 'dust', 'vignette', 'scanlines', 'grayscale', 'sepia'],
  fxLayers: ['behind_bg', 'behind_sprites', 'above_sprites', 'above_grade', 'above_ui'],
  fxIds: [
    'rain_light', 'rain_heavy', 'snow', 'dust_motes', 'embers', 'fireflies', 'bubbles', 'petals',
    'leaves', 'sparks', 'stars', 'candle_glow', 'moonlight', 'spotlight', 'crt_scan', 'film_grain',
    'fog_sheet', 'vignette_obj', 'heat_shimmer', 'water_ripple', 'glitch', 'sheet_sparkle'
  ],
  channels: ['music', 'ambience', 'sfx', 'voice']
};

/** Names that read badly as variables because a directive already uses them. */
const SHADOWING = new Set(['hide', 'show', 'move', 'end', 'set', 'jump', 'label', 'scene', 'stop', 'wait', 'if', 'when', 'switch', 'input', 'call', 'return', 'clear', 'import', 'export']);

const EFFECT_DIRECTIVES = new Set(['fx', 'grade', 'effect', 'shake', 'flash', 'overlay', 'ambience']);
const STAGE_DIRECTIVES = new Set(['show', 'move', 'hide', 'clear']);
const AUDIO_DIRECTIVES = new Set(['music', 'ambience', 'sfx', 'voice', 'stop']);
/** Directives whose arguments are `-` rows on the lines below, not inline. */
const ROW_DIRECTIVES = new Set(Object.entries(DIRECTIVES).filter(([, d]) => d.rows).map(([name]) => name));

module.exports = { DIRECTIVES, TAGS, FUNCTIONS, VOCABULARY, SHADOWING, EFFECT_DIRECTIVES, STAGE_DIRECTIVES, AUDIO_DIRECTIVES, ROW_DIRECTIVES };
