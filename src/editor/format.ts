/**
 * Formatting commands: what the Rich Text toolbar (and the keyboard shortcuts)
 * actually do to the markdown.
 *
 * The document is markdown at every instant — there is no rich-text model being
 * serialised. "Make this a heading" is a text edit that puts `## ` at the front
 * of a line; "bold" wraps a range in `**`. What makes it feel like a rich-text
 * editor is that rich mode never shows those characters back to you.
 *
 * Everything here is a pure function from EditorState to a transaction spec, so
 * the rules can be tested without a DOM. The thin `Command` wrappers at the
 * bottom are what the keymap and the toolbar call.
 */

import { signal } from '@preact/signals'
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { bareUriAt, linkAt } from './links'
import { COLOR_CLOSE, COLOR_OPEN, colorSpan } from './colors'
import { tableAt, type Align } from './table'

/** Paragraph styles, named as Apple Notes names them. */
export type BlockStyle = 'title' | 'heading' | 'subheading' | 'body'

/** Character-level styles that toggle: on, off, and nothing to say about it. */
export type InlineMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight'

/**
 * Everything the inline scanner recognises.
 *
 * Colour is not an `InlineMark` because it is not a toggle — it carries a
 * value, so there is no pair of delimiters to write it with and no single
 * "pressed" to report for it. It is scanned with the rest all the same, and
 * that is the point: the caret rules, the copy that takes hidden markup with
 * it, and the selection that grows over its own syntax are written once
 * against `scanInline` and cost colour nothing.
 */
export type SpanMark = InlineMark | 'color'

export type ListKind = 'bullet' | 'number' | 'check'

/** Heading level each paragraph style maps to. Body is "no heading". */
const BLOCK_LEVEL: Record<BlockStyle, number> = { title: 1, heading: 2, subheading: 3, body: 0 }

/**
 * Delimiters per mark.
 *
 * Underline is the one thing Apple Notes offers that markdown has no syntax
 * for, so it uses the HTML every markdown renderer already passes through.
 * Highlight uses the `==` convention Obsidian popularised.
 */
const DELIMS: Record<InlineMark, { open: string; close: string }> = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  underline: { open: '<u>', close: '</u>' },
  strike: { open: '~~', close: '~~' },
  code: { open: '`', close: '`' },
  highlight: { open: '==', close: '==' },
}

/* ------------------------------------------------------------- line parsing */

export interface LineParts {
  /** Leading whitespace. */
  indent: string
  /** Any `> ` quote markers, verbatim. */
  quote: string
  /** The list marker including its trailing space, e.g. `- ` or `2. `. */
  marker: string
  markerKind: ListKind | null
  /** The `[ ] ` / `[x] ` task box including its trailing space. */
  task: string
  /** Heading level, 0 when the line is body text. */
  level: number
  /** The `## ` heading marker including its trailing space. */
  headingMark: string
  /** Offset within the line where the content proper begins. */
  contentFrom: number
  content: string
}

/**
 * Split a line into its markdown prefixes and its content.
 *
 * Order matters and follows the grammar: indent, then quotes, then a list
 * marker, then a task box, then a heading marker.
 */
export function parseLine(text: string): LineParts {
  let i = 0
  const indent = /^[ \t]*/.exec(text)![0]
  i += indent.length

  const quote = /^(?:>[ \t]?)*/.exec(text.slice(i))![0]
  i += quote.length

  let marker = ''
  let markerKind: ListKind | null = null
  const bullet = /^([-*+])([ \t]+)/.exec(text.slice(i))
  const numbered = bullet ? null : /^(\d{1,9}[.)])([ \t]+)/.exec(text.slice(i))
  if (bullet) {
    marker = bullet[0]
    markerKind = 'bullet'
  } else if (numbered) {
    marker = numbered[0]
    markerKind = 'number'
  }
  i += marker.length

  let task = ''
  if (markerKind) {
    const box = /^(\[[ xX]\])([ \t]+)/.exec(text.slice(i))
    if (box) {
      task = box[0]
      markerKind = 'check'
      i += task.length
    }
  }

  let headingMark = ''
  let level = 0
  const h = /^(#{1,6})([ \t]+)/.exec(text.slice(i))
  if (h) {
    headingMark = h[0]
    level = h[1].length
    i += headingMark.length
  }

  return {
    indent,
    quote,
    marker,
    markerKind,
    task,
    level,
    headingMark,
    contentFrom: i,
    content: text.slice(i),
  }
}

/* ----------------------------------------------------------- inline scanning */

export interface InlineSpan {
  mark: SpanMark
  /** Range of the whole construct, delimiters included. */
  from: number
  to: number
  /** Range of the text between the delimiters. */
  innerFrom: number
  innerTo: number
  /** The value a mark carries, where it carries one: a colour's hex. */
  arg?: string
}

/**
 * Rules in precedence order: code first, because nothing inside it is markup,
 * then the two-character marks before the one-character one so `**bold**` is
 * never read as an empty italic wrapping `*bold*`. Colour goes near the front
 * with the other HTML, ahead of anything that could claim a character of its
 * tag.
 *
 * `inner` and `close` are what turn a match back into positions. The inner
 * text cannot be located by searching the match for it — `<u>u</u>` finds the
 * tag, and `<span style="color:#ff0000">ff0000</span>` finds the attribute —
 * so it is measured from the end instead, where every rule knows exactly how
 * many characters its closing delimiter took.
 */
interface InlineRule {
  mark: SpanMark
  re: RegExp
  /** Capture group holding the text between the delimiters. */
  inner: number
  /** Length of the closing delimiter for a given match. */
  close: (m: RegExpExecArray) => number
  /** Capture group holding the mark's value, for the ones that carry one. */
  arg?: number
}

const INLINE_RULES: InlineRule[] = [
  { mark: 'code', re: /^(`+)([^`]+?)\1(?!`)/, inner: 2, close: (m) => m[1].length },
  { mark: 'underline', re: /^<u>(.+?)<\/u>/, inner: 1, close: () => 4 },
  {
    mark: 'color',
    re: new RegExp(`^${COLOR_OPEN}(.+?)${COLOR_CLOSE}`),
    inner: 2,
    arg: 1,
    close: () => COLOR_CLOSE.length,
  },
  { mark: 'bold', re: /^\*\*(?!\s)(.+?)(?<!\s)\*\*/, inner: 1, close: () => 2 },
  { mark: 'strike', re: /^~~(?!\s)(.+?)(?<!\s)~~/, inner: 1, close: () => 2 },
  { mark: 'highlight', re: /^==(?!\s)(.+?)(?<!\s)==/, inner: 1, close: () => 2 },
  { mark: 'italic', re: /^\*(?!\s|\*)(.+?)(?<!\s)\*(?!\*)/, inner: 1, close: () => 1 },
]

/**
 * Every inline construct on one line, nested ones included.
 *
 * This is a scanner rather than a syntax-tree walk because it has to answer
 * "is the caret inside bold text" for text the parser may not have reached yet,
 * and because the same answer drives both the toolbar's pressed states and the
 * unwrap half of a toggle.
 */
export function scanInline(text: string, offset = 0, depth = 0): InlineSpan[] {
  const out: InlineSpan[] = []
  if (depth > 4) return out

  for (let i = 0; i < text.length; ) {
    let hit: { rule: InlineRule; m: RegExpExecArray } | undefined
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(text.slice(i))
      if (m) {
        hit = { rule, m }
        break
      }
    }
    if (!hit) {
      i++
      continue
    }
    const { rule, m } = hit
    const whole = m[0]
    const inner = m[rule.inner]
    // Measured back from the closing delimiter; see `InlineRule`.
    const innerFrom = i + whole.length - hit.rule.close(m) - inner.length
    out.push({
      mark: rule.mark,
      from: offset + i,
      to: offset + i + whole.length,
      innerFrom: offset + innerFrom,
      innerTo: offset + innerFrom + inner.length,
      arg: rule.arg === undefined ? undefined : m[rule.arg],
    })
    // Nested marks, except inside code where the content is literal.
    if (rule.mark !== 'code') out.push(...scanInline(inner, offset + innerFrom, depth + 1))
    i += whole.length
  }
  return out
}

/** The innermost span of `mark` whose inner text covers [from, to]. */
function spanAround(
  state: EditorState,
  mark: SpanMark,
  from: number,
  to: number,
): InlineSpan | undefined {
  const line = state.doc.lineAt(from)
  if (to > line.to) return undefined
  const spans = scanInline(line.text, line.from).filter(
    (s) => s.mark === mark && s.innerFrom <= from && s.innerTo >= to,
  )
  // Innermost wins: the shortest enclosing span.
  return spans.sort((a, b) => a.to - a.from - (b.to - b.from))[0]
}

/* ------------------------------------------------------------ block styles */

/**
 * Package prefix edits — the ones that rewrite the markers at the head of a
 * line — into a transaction that leaves the caret in the *content*.
 *
 * CodeMirror's default mapping keeps a position on the left of anything
 * inserted at that exact position, so turning an empty line into a checklist
 * item leaves the caret in front of `- [ ] ` and the first thing typed lands
 * before the checkbox. Mapping the selection forward instead puts the caret
 * where the text goes. It matters most in rich mode, where the marker is
 * hidden: a caret on the wrong side of it looks identical and behaves nothing
 * alike.
 */
function prefixEdit(
  state: EditorState,
  changes: Array<{ from: number; to: number; insert: string }>,
): TransactionSpec {
  const set = state.changes(changes)
  return { changes: set, selection: state.selection.map(set, 1), userEvent: 'input.format' }
}

/** Lines the selection touches, as line numbers. */
function selectedLines(state: EditorState): number[] {
  const out = new Set<number>()
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    const last = state.doc.lineAt(r.to).number
    for (let n = first; n <= last; n++) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Apply a paragraph style to every selected line.
 *
 * A heading replaces any heading already there, keeps the indent and any quote,
 * and drops a list marker: `- ## Groceries` is legal markdown but renders as a
 * heading buried in a bullet, which is never what picking "Heading" meant.
 */
export function setBlockStyle(state: EditorState, style: BlockStyle): TransactionSpec | null {
  const level = BLOCK_LEVEL[style]
  const changes: Array<{ from: number; to: number; insert: string }> = []

  for (const n of selectedLines(state)) {
    const line = state.doc.line(n)
    const p = parseLine(line.text)
    if (p.level === level && (level === 0 || !p.marker)) continue
    const keep = level === 0 ? p.marker + p.task : ''
    const prefix = p.indent + p.quote + keep + (level ? `${'#'.repeat(level)} ` : '')
    changes.push({ from: line.from, to: line.from + p.contentFrom, insert: prefix })
  }
  return changes.length ? prefixEdit(state, changes) : null
}

/* ------------------------------------------------------------------- lists */

const LIST_PREFIX: Record<ListKind, (n: number) => string> = {
  bullet: () => '- ',
  number: (n) => `${n}. `,
  check: () => '- [ ] ',
}

/**
 * The number a new ordered-list item should carry: one past the item above it
 * at the same indent, or 1 when it starts a list. Without this, turning one
 * line inside a numbered list into a list item would restart it at 1.
 */
function numberFor(state: EditorState, lineNumber: number, indent: string): number {
  for (let n = lineNumber - 1; n >= 1; n--) {
    const p = parseLine(state.doc.line(n).text)
    if (!p.content.trim() && !p.marker) break
    if (p.indent.length !== indent.length) continue
    if (p.markerKind !== 'number') break
    return Number.parseInt(p.marker, 10) + 1
  }
  return 1
}

/**
 * Toggle a list style across the selection. Applying the kind a line already
 * has removes it, which is what a pressed toolbar button should do.
 */
export function toggleList(state: EditorState, kind: ListKind): TransactionSpec | null {
  const lines = selectedLines(state)
  const parsed = lines.map((n) => parseLine(state.doc.line(n).text))
  const remove = parsed.every((p) => p.markerKind === kind)
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let counter = 0

  for (let i = 0; i < lines.length; i++) {
    const line = state.doc.line(lines[i])
    const p = parsed[i]
    // A blank line in the middle of a multi-line selection stays blank.
    if (!remove && !p.content.trim() && !p.marker && lines.length > 1) continue

    const head = p.indent + p.quote
    let insert: string
    if (remove) {
      insert = head
    } else if (kind === 'number') {
      counter = counter === 0 ? numberFor(state, lines[i], p.indent) : counter + 1
      insert = head + LIST_PREFIX.number(counter)
    } else {
      insert = head + LIST_PREFIX[kind](0)
    }
    const to = line.from + p.indent.length + p.quote.length + p.marker.length + p.task.length
    if (state.doc.sliceString(line.from, to) === insert) continue
    changes.push({ from: line.from, to, insert })
  }
  return changes.length ? prefixEdit(state, changes) : null
}

/** Toggle `> ` on the selected lines. */
export function toggleQuote(state: EditorState): TransactionSpec | null {
  const lines = selectedLines(state)
  const parsed = lines.map((n) => parseLine(state.doc.line(n).text))
  const remove = parsed.every((p) => p.quote.length > 0)
  const changes: Array<{ from: number; to: number; insert: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = state.doc.line(lines[i])
    const p = parsed[i]
    const from = line.from + p.indent.length
    if (remove) changes.push({ from, to: from + p.quote.length, insert: '' })
    else changes.push({ from, to: from, insert: '> ' })
  }
  return changes.length ? prefixEdit(state, changes) : null
}

/**
 * Nest or un-nest list items.
 *
 * Deliberately limited to list lines: four spaces in front of a paragraph is an
 * indented code block in markdown, so a general-purpose indent button would
 * silently turn prose into code.
 */
export function indentList(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  const changes: Array<{ from: number; to: number; insert: string }> = []
  for (const n of selectedLines(state)) {
    const line = state.doc.line(n)
    const p = parseLine(line.text)
    if (!p.markerKind) continue
    const at = line.from + p.indent.length + p.quote.length
    if (dir === 1) {
      changes.push({ from: at, to: at, insert: '  ' })
    } else {
      const drop = Math.min(2, p.indent.length)
      if (!drop) continue
      changes.push({ from: line.from, to: line.from + drop, insert: '' })
    }
  }
  return changes.length ? { changes, userEvent: 'input.format' } : null
}

export function canIndent(state: EditorState, dir: 1 | -1): boolean {
  return selectedLines(state).some((n) => {
    const p = parseLine(state.doc.line(n).text)
    return !!p.markerKind && (dir === 1 || p.indent.length > 0)
  })
}

/* ------------------------------------------------------------ inline marks */

/**
 * What a mark applied at `range` should end up around.
 *
 * With text selected, that text minus any whitespace at its edges; with a bare
 * caret, the word it sits in, or nothing at all when it sits in open space.
 * Shared by every inline mark and by colour, so "bold" and "make this red"
 * claim exactly the same characters from the same click.
 */
function wrapRange(
  state: EditorState,
  range: { from: number; to: number },
): { from: number; to: number } {
  let { from, to } = range
  if (from === to) {
    const line = state.doc.lineAt(from)
    const rel = from - line.from
    const left = /[\w'-]*$/.exec(line.text.slice(0, rel))?.[0].length ?? 0
    const right = /^[\w'-]*/.exec(line.text.slice(rel))?.[0].length ?? 0
    return { from: from - left, to: to + right }
  }
  // Leave whitespace outside the markers. `**word **` is not emphasis in
  // CommonMark — a closing run may not be preceded by a space — so a
  // selection that swept up a trailing space would render as literal
  // asterisks instead of bold text.
  const raw = state.doc.sliceString(from, to)
  from += raw.length - raw.trimStart().length
  to -= raw.length - raw.trimEnd().length
  return { from, to: to < from ? from : to }
}

/**
 * Toggle an inline mark.
 *
 * Three cases, in the order a person would expect them: inside an existing span
 * of that mark, unwrap it; with text selected, wrap it; with a bare caret, wrap
 * the word under the caret, or — if there is no word — leave an empty pair with
 * the caret inside it, so whatever gets typed next comes out styled.
 */
export function toggleInline(state: EditorState, mark: InlineMark): TransactionSpec {
  const { open, close } = DELIMS[mark]

  return state.changeByRange((range) => {
    const existing = spanAround(state, mark, range.from, range.to)
    if (existing) {
      /*
       * Both ends of the range sit within the span's inner text — that is what
       * `spanAround` matched on — so the only delimiter removed from in front
       * of them is the opening one, and both move back by exactly its length.
       *
       * Getting this wrong is not cosmetic. An off-by-one here left the anchor
       * where it was, so a highlight toggled off and on again came back two
       * characters shorter every time: the selection crept forward through its
       * own text while the user held still.
       */
      const shift = (pos: number) => pos - open.length
      return {
        changes: [
          { from: existing.from, to: existing.innerFrom, insert: '' },
          { from: existing.innerTo, to: existing.to, insert: '' },
        ],
        range: EditorSelection.range(shift(range.anchor), shift(range.head)),
      }
    }

    const { from, to } = wrapRange(state, range)
    const text = state.doc.sliceString(from, to)
    return {
      changes: { from, to, insert: `${open}${text}${close}` },
      range: text
        ? EditorSelection.range(from + open.length, to + open.length)
        : EditorSelection.cursor(from + open.length),
    }
  })
}

/**
 * The colour the selection is written in, or null for the note's own.
 *
 * The innermost one wins, the same as every other mark: text inside a red span
 * inside a blue one is red, and that is what the picker should show as chosen.
 */
export function colorAt(state: EditorState, from: number, to: number): string | null {
  return spanAround(state, 'color', from, to)?.arg?.toLowerCase() ?? null
}

/**
 * Put the selection in a colour, or take the colour off it with `null`.
 *
 * Not a toggle, because there is more than one "on": picking a second colour
 * for text that already has one *re-colours* it rather than nesting a span
 * inside a span. Only the opening tag is rewritten in that case — the text and
 * the closing tag are left exactly where they are, so a selection sitting in
 * the middle of the phrase stays on the same words while the colour changes
 * under it. Picking the colour it already has is what takes it off, matching
 * the way pressing B in bold text un-bolds it.
 */
export function setColor(state: EditorState, hex: string | null): TransactionSpec {
  return state.changeByRange((range) => {
    const existing = spanAround(state, 'color', range.from, range.to)

    if (existing) {
      const openLen = existing.innerFrom - existing.from
      const same = hex !== null && existing.arg?.toLowerCase() === hex.toLowerCase()

      if (hex === null || same) {
        // Both ends sit inside the span's text, so the only markup removed in
        // front of them is the opening tag — see `toggleInline`, where getting
        // this shift wrong quietly ate two characters per toggle.
        const shift = (pos: number) => pos - openLen
        return {
          changes: [
            { from: existing.from, to: existing.innerFrom, insert: '' },
            { from: existing.innerTo, to: existing.to, insert: '' },
          ],
          range: EditorSelection.range(shift(range.anchor), shift(range.head)),
        }
      }

      const open = colorSpan(hex, '').slice(0, -COLOR_CLOSE.length)
      const shift = (pos: number) => pos + open.length - openLen
      return {
        changes: { from: existing.from, to: existing.innerFrom, insert: open },
        range: EditorSelection.range(shift(range.anchor), shift(range.head)),
      }
    }

    if (hex === null) return { range }

    const { from, to } = wrapRange(state, range)
    const text = state.doc.sliceString(from, to)
    const openLen = colorSpan(hex, '').length - COLOR_CLOSE.length
    return {
      changes: { from, to, insert: colorSpan(hex, text) },
      range: text
        ? EditorSelection.range(from + openLen, to + openLen)
        : EditorSelection.cursor(from + openLen),
    }
  })
}

/**
 * Grow a range outward over the markup it covers the whole of but cannot see.
 *
 * In rich text the syntax is hidden, so a selection can only ever be made of
 * the visible text: double-clicking a highlighted word lands on `word` and not
 * `==word==`, and Home-then-Shift-End on a heading takes `Heading` and not
 * `## Heading` — the hidden characters are atomic, and CodeMirror pushes a
 * selection edge out of an atomic range it is *inside*, never off one it is
 * merely against. Both then leave on the clipboard as plain text, and a cut
 * leaves the orphaned `## ` or `====` behind in the note.
 *
 * Two widenings, in that order: inline delimiters the selection sits exactly
 * inside — one layer at a time, so `**==word==**` comes back whole — and then
 * the markers at the head of the line, when the selection covers all of that
 * line's text.
 *
 * Deliberately exact: a selection covering only part of a construct is left
 * alone, because there is no honest way to widen it — the user picked those
 * characters, and quietly adding markup around them would be worse than losing
 * it.
 */
export function expandToMarkup(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } {
  if (from === to) return { from, to }
  const line = state.doc.lineAt(from)

  if (to <= line.to) {
    const spans = scanInline(line.text, line.from)
    for (;;) {
      const hit = spans.find((s) => s.innerFrom === from && s.innerTo === to)
      if (!hit) break
      from = hit.from
      to = hit.to
    }
  }

  // `to >= line.to` rather than `===`: a selection running on into the lines
  // below still took the whole of this line's text with it.
  const p = parseLine(line.text)
  if (p.contentFrom && from === line.from + p.contentFrom && to >= line.to) from = line.from
  return { from, to }
}

/* -------------------------------------------------------------- inspection */

export interface FormatSnapshot {
  /** False when no editor has the caret; the toolbar renders inert. */
  active: boolean
  block: BlockStyle
  list: ListKind | null
  quote: boolean
  marks: Record<InlineMark, boolean>
  /** The colour the caret is writing in, as a hex, or null for the default. */
  color: string | null
  canIndent: boolean
  canOutdent: boolean
  /** True when the caret sits in a link — the Link button then edits it. */
  link: boolean
  /**
   * Whether anything is actually selected.
   *
   * Every other field here describes the line or the caret, and works the same
   * with a selection or without one. This exists for the controls that need a
   * *range* rather than a position — rewriting a passage is the first — so they
   * can be greyed out rather than pressed and then complaining.
   */
  hasSelection: boolean
  /** Where in a table the caret is, so the table controls know what to act on. */
  table: { row: number; col: number; rows: number; cols: number; align: Align } | null
}

const NO_MARKS: Record<InlineMark, boolean> = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  highlight: false,
}

export const EMPTY_SNAPSHOT: FormatSnapshot = {
  active: false,
  block: 'body',
  list: null,
  quote: false,
  marks: NO_MARKS,
  color: null,
  canIndent: false,
  canOutdent: false,
  hasSelection: false,
  link: false,
  table: null,
}

function styleForLevel(level: number): BlockStyle {
  return level === 1 ? 'title' : level === 2 ? 'heading' : level >= 3 ? 'subheading' : 'body'
}

/** What the toolbar should show as pressed for the current selection. */
export function inspect(state: EditorState): FormatSnapshot {
  const head = state.selection.main
  const line = state.doc.lineAt(head.from)
  const p = parseLine(line.text)
  const marks = { ...NO_MARKS }
  for (const m of Object.keys(DELIMS) as InlineMark[]) {
    marks[m] = !!spanAround(state, m, head.from, head.to)
  }
  const t = tableAt(state, head.head)
  return {
    active: true,
    block: styleForLevel(p.level),
    list: p.markerKind,
    quote: p.quote.length > 0,
    marks,
    color: colorAt(state, head.from, head.to),
    canIndent: canIndent(state, 1),
    canOutdent: canIndent(state, -1),
    link: !!(linkAt(state, head.head) ?? bareUriAt(state, head.head)),
    hasSelection: !head.empty,
    table: t
      ? {
          row: t.row,
          col: t.col,
          rows: t.model.rows.length,
          cols: t.model.align.length,
          align: t.model.align[t.col] ?? '',
        }
      : null,
  }
}

/**
 * What the toolbar renders from: the state of the editor that currently holds
 * the caret. Published by the rich-mode watcher in `setup.ts`, and reset when
 * that editor goes away so a stale note's formatting can't be shown as active.
 */
export const formatSnapshot = signal<FormatSnapshot>(EMPTY_SNAPSHOT)

/* ----------------------------------------------------------------- commands */

function run(view: EditorView, spec: TransactionSpec | null): boolean {
  if (!spec) return false
  view.dispatch(spec, { scrollIntoView: true })
  return true
}

export const applyBlockStyle = (style: BlockStyle) => (view: EditorView) =>
  run(view, setBlockStyle(view.state, style))

export const applyInline = (mark: InlineMark) => (view: EditorView) =>
  run(view, { ...toggleInline(view.state, mark), userEvent: 'input.format' })

export const applyColor = (hex: string | null) => (view: EditorView) =>
  run(view, { ...setColor(view.state, hex), userEvent: 'input.format' })

export const applyList = (kind: ListKind) => (view: EditorView) =>
  run(view, toggleList(view.state, kind))

export const applyQuote = (view: EditorView) => run(view, toggleQuote(view.state))

export const applyIndent = (dir: 1 | -1) => (view: EditorView) =>
  run(view, indentList(view.state, dir))
