/**
 * Live preview: markdown that looks rendered but *is* still markdown.
 *
 * The document in the buffer is always the exact text that gets written to the
 * .md file — nothing here transforms content. All it does is hide syntax
 * characters and swap a few spans for widgets, and it reveals the real syntax
 * the moment the caret enters a construct, so nothing is ever uneditable.
 *
 * That is the whole reason this approach was chosen over a document-model
 * WYSIWYG: there is no serialization step that could quietly rewrite the user's
 * file, so a round-trip is lossless by construction.
 *
 * Two modes share all of this:
 *
 *   - `live` reveals the source of whatever the caret is inside. You see
 *     `**bold**` while you are editing that word, and bold text everywhere else.
 *   - `rich` never reveals *formatting* syntax — emphasis, headings, quotes,
 *     list markers, checkboxes — so the note reads as a word processor
 *     document. Since the marks are atomic, backspacing over a hidden `## `
 *     removes the whole thing and the line becomes body text, which is how a
 *     rich-text editor behaves anyway.
 *
 * Rich mode still reveals *structural* source — link URLs, wikilink targets,
 * tables, rules — because those carry data with nowhere else to be edited.
 * Hiding them permanently would make parts of a note unreachable, which is a
 * worse sin than showing a bracket.
 */

import { syntaxTree } from '@codemirror/language'
import {
  type EditorState,
  Facet,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import {
  BulletWidget,
  CalloutFoldWidget,
  CalloutWidget,
  CheckboxWidget,
  CopyCodeWidget,
  DueChipWidget,
  EmbedWidget,
  HrWidget,
  TableWidget,
  VarWidget,
  isDelimiterRow,
} from './widgets'
import { parseCallout } from './callout'
import { COLOR_CLOSE, COLOR_OPEN, cssColor } from './colors'
import { findDue, isTaskLine, resolveVars, scanVars, varText } from '../core/markdown'
import { frontmatterEnd, frontmatterLines, frontmatterOf } from './vars'
import { noteContext } from './context'
import { normalizeUri, scanUris } from './links'
import { resolveEmbed, resolveLink } from '../core/vault'
import { revision } from '../core/vault'

/** Which of the two rendering modes the preview extensions are running in. */
export type PreviewMode = 'live' | 'rich'

export const previewMode = Facet.define<PreviewMode, PreviewMode>({
  combine: (values) => values[0] ?? 'live',
})

const hidden = Decoration.replace({})
const underlined = Decoration.mark({ class: 'cm-underline' })
const highlighted = Decoration.mark({ class: 'cm-highlight' })

const lineDeco = (cls: string) => Decoration.line({ class: cls })

const H = [1, 2, 3, 4, 5, 6].map((n) => lineDeco(`cm-h${n}`))
const quoteLine = lineDeco('cm-quote')
const calloutTitle = Decoration.mark({ class: 'cm-callout-title' })
const codeLine = lineDeco('cm-codeblock')
const codeFirst = lineDeco('cm-codeblock cm-codeblock-first')
const codeLast = lineDeco('cm-codeblock cm-codeblock-last')
const tableLine = lineDeco('cm-table')
const taskDone = Decoration.mark({ class: 'cm-task-done' })

/** Marks whose only job is syntax; hidden unless the caret is in range. */
const MARK_NODES = new Set([
  'EmphasisMark',
  'StrongEmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'HeaderMark',
  'QuoteMark',
  'LinkMark',
  'WikiLinkMark',
  'SuperscriptMark',
  'SubscriptMark',
])

/**
 * Whether the editor has focus.
 *
 * Live preview reveals raw syntax wherever the caret is, which is right while
 * you're typing and wrong the moment you look away: a note whose first line is
 * a table would sit there showing pipes, because the caret starts at position 0
 * and never moved. Tracking focus lets an unfocused editor render everything.
 */
const setFocused = StateEffect.define<boolean>()

export const focusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value
    return value
  },
})

export const focusWatcher = EditorView.focusChangeEffect.of((_state, focusing) =>
  setFocused.of(focusing),
)

/**
 * Seed that flag when the extensions are installed.
 *
 * `focusChangeEffect` only fires on a *change*, so switching editor mode while
 * the caret is in the note leaves a freshly configured field believing the
 * editor is unfocused — and an unfocused editor never reveals anything. The
 * dispatch is deferred because a plugin may not update the view it is being
 * constructed for.
 */
export const focusSeeder = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      if (!view.hasFocus) return
      queueMicrotask(() => {
        if (view.dom.isConnected && view.hasFocus) view.dispatch({ effects: setFocused.of(true) })
      })
    }
  },
)

/**
 * Has the user actually done anything in this editor yet?
 *
 * Opening a note focuses it with the caret at position 0. That position is
 * legitimately "inside" a table or a bold span that starts the note, so reveal
 * on caret position alone would show raw pipes the instant a note whose first
 * line is a table is opened — never having been touched. Only a real user
 * event (a click, an arrow key, a keystroke) counts as editing.
 *
 * The table widget's own click-to-edit dispatch tags itself `select.pointer`
 * for exactly this reason.
 */
export const interactedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (value) return true
    return (
      tr.isUserEvent('select') ||
      tr.isUserEvent('input') ||
      tr.isUserEvent('delete') ||
      tr.isUserEvent('move') ||
      tr.isUserEvent('undo') ||
      tr.isUserEvent('redo')
    )
  },
})

/**
 * True when the caret is in [from, to] and the user is actually working there.
 *
 * `kind` says what would be revealed: `format` is styling the toolbar can apply
 * and remove on its own, so rich mode keeps it hidden; `structure` is source
 * with nowhere else to be edited, revealed in both modes.
 */
function touched(
  state: EditorState,
  from: number,
  to: number,
  kind: 'format' | 'structure' = 'structure',
): boolean {
  if (kind === 'format' && state.facet(previewMode) === 'rich') return false
  if (!state.field(focusedField, false)) return false
  if (!state.field(interactedField, false)) return false
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

/**
 * True while the caret is inside the part of an embed that gets typed — the
 * target between `![[` and `]]`, or the URL between `](` and `)`.
 *
 * Rich mode deliberately keeps a finished embed a picture whatever the caret
 * is doing beside it (see the WikiEmbed branch), but an embed is not a picture
 * while it is being written. `![[` leaves the caret between the brackets, and
 * replacing the markup with a widget at the first character typed there takes
 * the target out from under the autocomplete: the range goes atomic, one
 * letter goes in, and there is no way to finish the name — which is what
 * "I can only type one character" looked like.
 *
 * The range checked is the target alone, never the whole node, so a caret
 * merely beside a finished embed still leaves a picture where the picture is.
 */
function composingEmbed(state: EditorState, from: number, to: number): boolean {
  // An empty target is legitimate — `![[]]` is exactly where typing starts —
  // but a node too short to hold one has nothing to type into.
  if (to < from) return false
  return touched(state, from, to)
}

/**
 * True when a caret — an empty selection, not a range — sits in [from, to].
 *
 * The difference matters for anything rich text renders as a value rather than
 * as syntax. A caret in a `$(client)` is somebody editing the name and needs
 * the source; a selection merely *covering* it is somebody selecting a
 * paragraph, and revealing every token it crosses would mean the words you see
 * highlighted are not the words you are about to copy.
 */
function caretIn(state: EditorState, from: number, to: number): boolean {
  if (!state.field(focusedField, false)) return false
  if (!state.field(interactedField, false)) return false
  return state.selection.ranges.some((r) => r.empty && r.from >= from && r.to <= to)
}

/** True when a selection range is on any line the node spans. */
function lineTouched(
  state: EditorState,
  from: number,
  to: number,
  kind: 'format' | 'structure' = 'structure',
): boolean {
  const a = state.doc.lineAt(from).from
  const b = state.doc.lineAt(to).to
  return touched(state, a, b, kind)
}

const TAG_RE = /(^|[\s(>])(#[A-Za-z0-9_][A-Za-z0-9/_-]*)/g

/**
 * Inline styles the markdown parser has no node for: `<u>text</u>`, `==text==`,
 * and the coloured span (see editor/colors.ts).
 *
 * `inner` and `close` locate the text between the delimiters by measuring back
 * from the end of the match, for the reason spelled out on `InlineRule` in
 * format.ts: searching the match for its own inner text finds the `u` in `<u>`
 * and the digits in a colour's attribute.
 */
interface InlineExtra {
  id: 'underline' | 'highlight' | 'color'
  re: RegExp
  /** Capture group holding the text between the delimiters. */
  inner: number
  /** Length of the closing delimiter. */
  close: number
  /** The decoration for a match, or null to leave the markup as text. */
  deco: (m: RegExpExecArray) => Decoration | null
}

const INLINE_EXTRAS: InlineExtra[] = [
  { id: 'underline', re: /<u>(.+?)<\/u>/g, inner: 1, close: 4, deco: () => underlined },
  {
    id: 'highlight',
    re: /==(?!\s)(.+?)(?<!\s)==/g,
    inner: 1,
    close: 2,
    deco: () => highlighted,
  },
  {
    id: 'color',
    re: new RegExp(`${COLOR_OPEN}(.+?)${COLOR_CLOSE}`, 'g'),
    inner: 2,
    close: COLOR_CLOSE.length,
    deco: (m) => colored(m[1]),
  },
]

/**
 * The mark for one colour, built once per colour rather than per match.
 *
 * A note repeating the same red forty times is one decoration spec and forty
 * ranges; CodeMirror compares mark decorations by identity when it diffs, so
 * handing it a fresh object per match would redraw every coloured span on every
 * keystroke.
 *
 * The value is only ever a hex that `cssColor` recognised — anything else comes
 * back undefined and the markup is left on screen as the literal text it is,
 * which is the honest rendering of something this doesn't understand and the
 * reason no string from a note reaches a style attribute unchecked.
 */
const colorCache = new Map<string, Decoration>()

function colored(hex: string): Decoration | null {
  const key = hex.toLowerCase()
  const hit = colorCache.get(key)
  if (hit) return hit
  const css = cssColor(key)
  if (!css) return null
  const deco = Decoration.mark({ class: 'cm-color', attributes: { style: `color:${css}` } })
  colorCache.set(key, deco)
  return deco
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const out: Array<Range<Decoration>> = []
  const ctx = state.facet(noteContext)
  const tree = syntaxTree(state)
  // Lines already given a block decoration, so nested nodes don't double up.
  const seenLines = new Set<number>()
  /*
   * Character ranges holding a callout's `[!type]` marker.
   *
   * CommonMark reads `[!warning]` as a shortcut link reference, so the generic
   * mark handling below would hide its brackets as link syntax — leaving a bare
   * `!warning` where the raw marker was meant to be revealed, and, worse,
   * putting a replace decoration *inside* the one that swaps the marker for its
   * icon. The marker is claimed here and skipped there.
   */
  const calloutMarks: Array<[number, number]> = []
  const inCalloutMark = (at: number) => calloutMarks.some(([a, b]) => at >= a && at < b)

  /*
   * Frontmatter, before anything else.
   *
   * A leading `---` block is genuinely ambiguous markdown: `date: 2026-09-12`
   * followed by `---` parses as a setext H1, so left alone the metadata renders
   * as a huge heading at the top of every note. Claiming these lines first —
   * and marking them seen — gives them a quiet properties-block look instead,
   * still fully editable.
   */
  const fmLines = frontmatterLines(state)
  const fmEnd = frontmatterEnd(state, fmLines)
  /*
   * Parsed at most once per build, and only if a `$(...)` is actually found in
   * what is on screen — which in most notes is never.
   */
  let parsed: ReturnType<typeof frontmatterOf> | undefined
  const properties = () => (parsed ??= frontmatterOf(state, fmLines))
  /*
   * An address with `$(case)` in it is the same idea as one in a sentence, and
   * the one place it has to work even while the note is only being read: a
   * link is followed, not copied, so a token left in it goes nowhere.
   */
  const withProperties = (url: string) =>
    fmLines.length && url.includes('$(') ? resolveVars(url, properties()) : url
  for (const n of fmLines) {
    const line = state.doc.line(n)
    seenLines.add(line.from)
    const cls =
      n === fmLines[0]
        ? 'cm-frontmatter cm-frontmatter-first'
        : n === fmLines[fmLines.length - 1]
          ? 'cm-frontmatter cm-frontmatter-last'
          : 'cm-frontmatter'
    out.push(lineDeco(cls).range(line.from))
  }

  /*
   * Table source lines, from the same scan that drives the rendered widget.
   * Claiming them here keeps the tree walk from also styling them, and
   * monospaces the pipes while the caret is inside so columns line up.
   */
  const rich = state.facet(previewMode) === 'rich'
  for (const t of findTables(state)) {
    const first = state.doc.line(t.fromLine)
    const last = state.doc.line(t.toLine)
    const editing = !rich && touched(state, first.from, last.to)
    for (let n = t.fromLine; n <= t.toLine; n++) {
      const line = state.doc.line(n)
      seenLines.add(line.from)
      if (editing) out.push(tableLine.range(line.from))
    }
  }

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    tree.iterate({
      from: vFrom,
      to: vTo,
      enter: (node: SyntaxNodeRef) => {
        const name = node.name

        /* ---- headings ------------------------------------------------ */
        const atx = /^ATXHeading([1-6])$/.exec(name) ?? /^SetextHeading([1-2])$/.exec(name)
        if (atx) {
          const line = state.doc.lineAt(node.from)
          if (!seenLines.has(line.from)) {
            seenLines.add(line.from)
            out.push(H[Number(atx[1]) - 1].range(line.from))
          }
          return
        }

        /* ---- blockquote, and the callout it may be --------------------- */
        if (name === 'Blockquote') {
          const starts: number[] = []
          for (let p = node.from; p <= node.to; ) {
            const line = state.doc.lineAt(p)
            starts.push(line.from)
            if (line.to >= node.to) break
            p = line.to + 1
          }

          const first = state.doc.lineAt(node.from)
          const callout = parseCallout(first.text)

          if (!callout) {
            for (const at of starts) {
              if (seenLines.has(at)) continue
              seenLines.add(at)
              out.push(quoteLine.range(at))
            }
            return
          }

          /*
           * A callout is a blockquote wearing a colour, so it is decorated as
           * one — same line-by-line walk, a different class. Nothing about the
           * text changes, which is what keeps the file a plain blockquote that
           * any other renderer will still show.
           *
           * Folded, the head line is the whole of the box: the lines under it
           * are replaced by the field above and never drawn, so the head has to
           * carry both edges or the callout would end in an open corner.
           */
          const folded = calloutFolded(state, first.to)
          const base = `cm-callout cm-callout-${callout.spec.kind}`
          starts.forEach((at, i) => {
            if (seenLines.has(at)) return
            seenLines.add(at)
            if (folded && i > 0) return
            const edges =
              (i === 0 ? ' cm-callout-first' : '') +
              (folded || i === starts.length - 1 ? ' cm-callout-last' : '')
            out.push(lineDeco(base + edges).range(at))
          })

          /*
           * The marker becomes the icon — but only while the caret is
           * elsewhere. The type is structure, not formatting: it is data with
           * nowhere else to be edited (there is no picker for it), so both
           * modes hand back the raw `[!warning]` when you put the caret on its
           * line, exactly as they do for a link's URL.
           */
          const markFrom = first.from + callout.markerFrom
          const markTo = Math.min(first.from + callout.markerTo, first.to)
          calloutMarks.push([markFrom, markTo])

          if (!lineTouched(state, first.from, first.to)) {
            const from = markFrom
            const to = markTo
            out.push(
              Decoration.replace({
                widget: new CalloutWidget(
                  callout.spec.icon,
                  callout.title ? '' : callout.spec.label,
                  folded,
                  starts.length > 1,
                ),
              }).range(from, to),
            )
            if (callout.title && to < first.to) out.push(calloutTitle.range(to, first.to))
          }
          return
        }

        /* ---- fenced code --------------------------------------------- */
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const firstLine = state.doc.lineAt(node.from).number
          const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number
          let styledFirst = false
          for (let n = firstLine; n <= lastLine; n++) {
            const line = state.doc.line(n)
            if (seenLines.has(line.from)) continue
            seenLines.add(line.from)
            const deco = n === firstLine ? codeFirst : n === lastLine ? codeLast : codeLine
            if (n === firstLine) styledFirst = true
            out.push(deco.range(line.from))
          }
          /*
           * The copy button, at the end of the opening fence — which is where
           * the top right corner of the block is, since the fence itself is
           * hidden and the line is left holding only the language name.
           *
           * A point widget rather than a replacement, the same shape as the due
           * chip appended to a task line, so it adds nothing to the document
           * and CodeMirror's height map is untouched (the CSS floats it out of
           * flow). Only for a *fenced* block that got its own styling: an
           * indented code block has no fence line to hang it on, and a block
           * already claimed by an enclosing callout has no positioned corner
           * for it to sit in.
           */
          if (styledFirst && name === 'FencedCode' && lastLine > firstLine) {
            out.push(
              Decoration.widget({ widget: new CopyCodeWidget(rich), side: 1 }).range(
                state.doc.line(firstLine).to,
              ),
            )
          }
          return
        }

        /* ---- horizontal rule ------------------------------------------ */
        if (name === 'HorizontalRule') {
          if (!lineTouched(state, node.from, node.to))
            out.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to))
          return
        }

        /* ---- list markers ---------------------------------------------- */
        if (name === 'ListMark') {
          const line = state.doc.lineAt(node.from)
          if (lineTouched(state, node.from, node.to, 'format')) return
          const rest = line.text.slice(node.to - line.from)
          // A task's own checkbox is the marker; a literal dash beside it is
          // noise, so it goes entirely.
          if (/^\s*\[[ xX]\]/.test(rest)) {
            out.push(hidden.range(node.from, Math.min(node.to + 1, line.to)))
            return
          }
          // Ordered lists keep their numbers; unordered ones get a real bullet.
          if (/^[-*+]$/.test(state.doc.sliceString(node.from, node.to))) {
            out.push(
              Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
            )
          }
          return
        }

        /* ---- task checkboxes ------------------------------------------ */
        if (name === 'TaskMarker') {
          const raw = state.doc.sliceString(node.from, node.to)
          const checked = /x/i.test(raw)
          if (!touched(state, node.from - 1, node.to + 1, 'format')) {
            out.push(
              Decoration.replace({ widget: new CheckboxWidget(checked, state.readOnly) }).range(
                node.from,
                node.to,
              ),
            )
          }
          if (checked) {
            const line = state.doc.lineAt(node.from)
            if (node.to + 1 < line.to) out.push(taskDone.range(node.to + 1, line.to))
          }
          return
        }

        /* ---- wikilinks ------------------------------------------------ */
        if (name === 'WikiLink') {
          const raw = state.doc.sliceString(node.from, node.to)
          const inner = raw.slice(2, -2)
          const [targetPart, alias] = splitPipe(inner)
          const target = targetPart.split('#')[0].trim()
          const resolved = resolveLink(target)
          const open = node.from + 2
          const close = node.to - 2
          const active = touched(state, node.from, node.to)

          if (!active) {
            // Hide the brackets and, when there is an alias, the target too.
            out.push(hidden.range(node.from, open))
            out.push(hidden.range(close, node.to))
            if (alias !== undefined) {
              out.push(hidden.range(open, open + targetPart.length + 1))
            }
          }
          const textFrom = !active && alias !== undefined ? open + targetPart.length + 1 : open
          if (textFrom < close) {
            out.push(
              Decoration.mark({
                class: resolved ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-broken',
                attributes: {
                  'data-wikilink': target,
                  'data-exists': resolved ? '1' : '0',
                  title: resolved ?? `Create "${target}"`,
                },
              }).range(textFrom, close),
            )
          }
          return
        }

        /* ---- wikilink embeds ------------------------------------------ */
        if (name === 'WikiEmbed') {
          // 'format' so rich mode never swaps a picture for its markdown: a
          // caret landing beside an image is someone about to type next to it,
          // and there is nothing in `![[img.png|400]]` the rich editor cannot
          // do with the resize handle and the delete key. An embed being typed
          // is the exception, in every mode — see `composingEmbed`.
          if (touched(state, node.from, node.to, 'format')) return
          // `![[` … `]]`
          if (composingEmbed(state, node.from + 3, node.to - 2)) return
          const raw = state.doc.sliceString(node.from, node.to)
          const inner = raw.slice(3, -2)
          const [targetPart, sizePart] = splitPipe(inner)
          const target = targetPart.trim()
          const width = sizePart && /^\d+$/.test(sizePart.trim()) ? Number(sizePart) : undefined
          out.push(
            Decoration.replace({
              widget: new EmbedWidget({
                // An embed names a file the same way a link names an address,
                // so a property is as welcome in one as in the other.
                path: resolveEmbed(withProperties(target), ctx.path),
                label: target,
                width,
                alt: sizePart && !width ? sizePart : '',
              }),
              block: false,
            }).range(node.from, node.to),
          )
          return
        }

        /* ---- markdown images ------------------------------------------ */
        if (name === 'Image') {
          if (touched(state, node.from, node.to, 'format')) return
          const raw = state.doc.sliceString(node.from, node.to)
          // The address, between `](` and the closing paren — typed by hand,
          // so the same rule as a wikilink embed's target applies to it.
          const urlAt = raw.indexOf('](')
          if (urlAt >= 0 && composingEmbed(state, node.from + urlAt + 2, node.to - 1)) return
          const m = /^!\[([^\]]*)\]/.exec(raw)
          if (!m) return
          // From the parser, for the reason the link above takes it from there:
          // a `)` inside the address is the address's, not the end of it.
          const urlNode = node.node.getChild('URL')
          // No address yet — an embed still being typed out, `![[IMG` on its
          // way to being a picture. Nothing to draw, and drawing it would take
          // the half-written target out from under the autocomplete.
          if (!urlNode) return
          let url = state.doc.sliceString(urlNode.from, urlNode.to)
          if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1)
          const [rawClean, width] = splitWidth(url)
          const clean = withProperties(rawClean)
          const external = /^(https?|data):/i.test(clean)
          out.push(
            Decoration.replace({
              widget: new EmbedWidget({
                path: external ? undefined : resolveEmbed(decodeURI(clean), ctx.path),
                href: external ? clean : undefined,
                label: decodeURI(clean) || m[1],
                width,
                alt: m[1],
              }),
              block: false,
            }).range(node.from, node.to),
          )
          return
        }

        /* ---- markdown links: the label becomes the clickable thing ---- */
        if (name === 'Link') {
          const raw = state.doc.sliceString(node.from, node.to)
          const m = /^\[([^\]\n]*)\]/.exec(raw)
          if (!m) return
          /*
           * The address comes from the parser, not from a second regex over
           * the same text.
           *
           * The regex this replaced ended the URL at the first `)`, which is
           * wrong for every address holding balanced parentheses — a
           * `(disambiguation)` on Wikipedia, and `?TID=$(case)` here. It sent
           * clicks to a URL a character short of the truth while the note went
           * on showing the whole thing. CommonMark allows those parens and the
           * parser already gets them right.
           */
          const urlNode = node.node.getChild('URL')
          let url = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : ''
          if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1)
          const href = normalizeUri(withProperties(url))
          if (!href) return
          const from = node.from + 1
          const to = from + m[1].length
          if (to > from) {
            out.push(
              Decoration.mark({
                class: 'cm-uri',
                attributes: { 'data-href': href, title: href },
              }).range(from, to),
            )
          }
          return
        }

        /* ---- inline links: hide the URL machinery --------------------- */
        if (name === 'URL' || name === 'LinkTitle') {
          const parent = node.node.parent
          if (parent && (parent.name === 'Link' || parent.name === 'Image')) {
            if (!touched(state, parent.from, parent.to)) out.push(hidden.range(node.from, node.to))
            return
          }
          // A bare URL the markdown parser autolinked for us. It is the one
          // the textual scan below deliberately skips — that scan avoids
          // anything the parser has already claimed — so it gets its mark here.
          if (name === 'URL') {
            const href = normalizeUri(withProperties(state.doc.sliceString(node.from, node.to)))
            if (href) {
              out.push(
                Decoration.mark({
                  class: 'cm-uri',
                  attributes: { 'data-href': href, title: href },
                }).range(node.from, node.to),
              )
            }
          }
          return
        }

        /* ---- generic syntax marks -------------------------------------- */
        if (MARK_NODES.has(name)) {
          // A callout's marker is not link syntax, however much it looks it.
          if (inCalloutMark(node.from)) return
          const parent = node.node.parent
          const scopeFrom = parent ? parent.from : node.from
          const scopeTo = parent ? parent.to : node.to
          /*
           * Link brackets are structure: the URL they hide has to be reachable.
           *
           * So is a code fence, for the same reason. The language on it — the
           * whole of whether a block is syntax highlighted — is written into
           * the opening fence and nowhere else, and there is no picker for it.
           * A permanently hidden fence leaves a block you cannot label, cannot
           * see the ends of, and cannot get the caret past without counting
           * lines. Inline code's backticks stay formatting: they carry nothing.
           */
          const kind =
            name === 'LinkMark' ||
            name === 'WikiLinkMark' ||
            (name === 'CodeMark' && parent?.name === 'FencedCode')
              ? 'structure'
              : 'format'
          const reveal =
            name === 'HeaderMark' || name === 'QuoteMark'
              ? lineTouched(state, scopeFrom, scopeTo, kind)
              : touched(state, scopeFrom, scopeTo, kind)
          if (reveal) return
          // A HeaderMark swallows the space that follows it, so the heading
          // text doesn't start with a stray indent once the "#" is hidden.
          let to = node.to
          if (name === 'HeaderMark' && state.doc.sliceString(to, to + 1) === ' ') to += 1
          if (name === 'QuoteMark' && state.doc.sliceString(to, to + 1) === ' ') to += 1
          if (to > node.from) out.push(hidden.range(node.from, to))
        }
      },
    })

    /*
     * Underline, highlight and colour.
     *
     * None of the three is CommonMark, so the parser knows nothing about them
     * and they are matched textually, like hashtags below. Underline is the
     * `<u>` HTML markdown passes through — the only way to write one at all —
     * and it is what the toolbar's U button produces; colour is the same idea
     * carrying a value, and is the only one of the three whose decoration
     * depends on what was matched.
     */
    for (let p = vFrom; p <= vTo; ) {
      const line = state.doc.lineAt(p)
      // A setext underline (`====`) is a heading marker, not a highlight.
      const setext = /^[=]+$/.test(line.text.trim())
      for (const extra of INLINE_EXTRAS) {
        if (extra.id === 'highlight' && setext) continue
        extra.re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = extra.re.exec(line.text))) {
          const from = line.from + m.index
          const to = from + m[0].length
          if (isInsideCodeOrLink(tree.resolveInner(from + 1, 1))) continue
          if (touched(state, from, to, 'format')) continue
          const deco = extra.deco(m)
          if (!deco) continue
          const inner = m[extra.inner]
          const innerFrom = to - extra.close - inner.length
          out.push(hidden.range(from, innerFrom))
          out.push(deco.range(innerFrom, innerFrom + inner.length))
          out.push(hidden.range(innerFrom + inner.length, to))
        }
      }
      if (line.to >= vTo) break
      p = line.to + 1
    }

    /*
     * Bare URLs, mailto:, tel:, ssh: — anything the platform can open.
     *
     * Textual for the same reason hashtags are: the markdown parser autolinks
     * only a subset of what turns up in a note, and every one of them is worth
     * a tap.
     */
    for (let p = vFrom; p <= vTo; ) {
      const line = state.doc.lineAt(p)
      for (const u of scanUris(line.text, line.from)) {
        const node = tree.resolveInner(u.from + 1, 1)
        if (isInsideCodeOrLink(node)) continue
        const href = normalizeUri(withProperties(u.url))
        if (!href) continue
        out.push(
          Decoration.mark({
            class: 'cm-uri',
            attributes: { 'data-href': href, title: href },
          }).range(u.from, u.to),
        )
      }
      if (line.to >= vTo) break
      p = line.to + 1
    }

    /*
     * Task due dates.
     *
     * Textual, like the tags below: `📅 2026-09-04` is a convention, not
     * markdown, so the parser has no node for it.
     *
     * The marker reveals its source only when the caret is inside the marker
     * itself, rather than anywhere on the line. Line-level reveal is right for
     * syntax you edit by typing, and wrong here — it would take the chip away
     * the moment you put the caret in the task you wanted to date. The chip is
     * atomic, so getting the caret inside one takes deliberate aim, which is
     * the correct amount of effort for hand-editing a date that has a picker.
     */
    for (let p = vFrom; p <= vTo; ) {
      const line = state.doc.lineAt(p)
      if (isTaskLine(line.text)) {
        const due = findDue(line.text)
        if (due) {
          const from = line.from + due.from
          const to = line.from + due.to
          if (!touched(state, from, to)) {
            out.push(
              Decoration.replace({ widget: new DueChipWidget(due.date) }).range(from, to),
            )
          }
        } else if (lineTouched(state, line.from, line.to)) {
          out.push(
            Decoration.widget({ widget: new DueChipWidget(undefined), side: 1 }).range(line.to),
          )
        }
      }
      if (line.to >= vTo) break
      p = line.to + 1
    }

    /* ---- hashtags: not a markdown construct, so matched textually ---- */
    for (let p = vFrom; p <= vTo; ) {
      const line = state.doc.lineAt(p)
      TAG_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = TAG_RE.exec(line.text))) {
        const from = line.from + m.index + m[1].length
        const to = from + m[2].length
        // Skip anything the markdown parser already claimed (code, links, URLs).
        const node = tree.resolveInner(from + 1, 1)
        if (isInsideCodeOrLink(node, true)) continue
        out.push(Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': m[2].slice(1) } }).range(from, to))
      }
      if (line.to >= vTo) break
      p = line.to + 1
    }

    /*
     * `$(property)` — a value from the note's own frontmatter.
     *
     * Textual, like the hashtags above, and bounded the same way: only a key
     * this note actually declares is touched. `$(pwd)` in a note with no `pwd`
     * property stays the four characters somebody typed, because a shell
     * command in a sentence is not a variable — and a note with no frontmatter
     * at all has nothing here to do.
     *
     * The block itself is skipped: `greeting: Hello $(name)` is metadata being
     * written, not prose being read, and a property quoting another one is a
     * knot nobody asked for.
     */
    if (fmLines.length) {
      for (let p = Math.max(vFrom, fmEnd + 1); p <= vTo; ) {
        const line = state.doc.lineAt(p)
        for (const v of scanVars(line.text, line.from)) {
          const data = properties()
          if (!(v.key in data)) continue
          if (isLiteralHere(tree.resolveInner(v.from + 1, 1))) continue
          /*
           * Structure, not formatting: the key has to stay reachable, so the
           * caret reveals the token in rich text as well as in live preview.
           *
           * In rich text it takes a caret, though, not any selection that
           * happens to cross it. Selecting a paragraph to copy it is not
           * editing the names inside it, and a selection that showed tokens
           * where the page shows values would be highlighting one thing and
           * copying another. Live preview reveals on either, because there the
           * source is the thing being worked on.
           */
          if (rich ? caretIn(state, v.from, v.to) : touched(state, v.from, v.to)) continue
          out.push(
            Decoration.replace({
              widget: new VarWidget(v.key, varText(data[v.key]), rich),
            }).range(v.from, v.to),
          )
        }
        if (line.to >= vTo) break
        p = line.to + 1
      }
    }
  }

  return RangeSet.of(out, true)
}

/**
 * Where a `$(key)` is left as the text somebody typed.
 *
 * Inline code, because that is how the syntax is written *about* — a note
 * explaining `$(client)` has to be able to say it — and an address, because
 * the address is resolved where it is followed rather than where it is shown.
 *
 * A fenced block is deliberately not on the list. A block is a thing you copy
 * out and run, and a command with the host and the case number already in it
 * is the whole reason for wanting a property in one.
 */
function isLiteralHere(node: { name: string; parent: unknown } | null): boolean {
  let n = node as { name: string; parent: unknown } | null
  let depth = 0
  while (n && depth++ < 12) {
    if (n.name === 'InlineCode' || n.name === 'URL' || n.name === 'Link' || n.name === 'WikiLink')
      return true
    n = n.parent as { name: string; parent: unknown } | null
  }
  return false
}

/**
 * Is this position inside something the markdown parser has already claimed?
 *
 * `orHeading` is what separates the two textual scanners that use this. A `#`
 * inside a heading is the heading's own marker, never a hashtag, so the tag
 * scan excludes headings — but a `<u>` or `==` inside a heading is ordinary
 * formatting and has to keep working, so the inline-extras scan does not.
 */
function isInsideCodeOrLink(
  node: { name: string; parent: unknown } | null,
  orHeading = false,
): boolean {
  let n = node as { name: string; parent: unknown } | null
  let depth = 0
  while (n && depth++ < 12) {
    if (
      n.name === 'InlineCode' ||
      n.name === 'FencedCode' ||
      n.name === 'CodeBlock' ||
      n.name === 'CodeText' ||
      n.name === 'URL' ||
      n.name === 'Link' ||
      n.name === 'WikiLink' ||
      n.name === 'WikiEmbed'
    )
      return true
    if (orHeading && /^ATXHeading[1-6]$/.test(n.name)) return true
    n = n.parent as { name: string; parent: unknown } | null
  }
  return false
}

function splitPipe(s: string): [string, string | undefined] {
  const i = s.indexOf('|')
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)]
}

function splitWidth(url: string): [string, number | undefined] {
  const m = /^(.*?)#w=(\d+)$/.exec(url)
  return m ? [m[1], Number(m[2])] : [url, undefined]
}

/**
 * The plugin. Decorations rebuild on document/selection/viewport changes, and
 * additionally when the vault index changes — a link that was broken becomes
 * live the moment its target note is created in another pane.
 */
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private lastRevision = revision.value
    private dispose: () => void

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
      this.dispose = revision.subscribe(() => {
        if (revision.value === this.lastRevision) return
        this.lastRevision = revision.value
        // Defer: we may be inside another component's render pass.
        queueMicrotask(() => {
          if (view.dom.isConnected) this.decorations = buildDecorations(view)
        })
      })
    }

    update(u: ViewUpdate) {
      if (
        u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildDecorations(u.view)
      }
    }

    destroy() {
      this.dispose()
    }
  },
  {
    decorations: (v) => v.decorations,
    // Widgets behave as single units for cursor movement and selection.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
)

/* -------------------------------------------------------------- callouts */

/**
 * Callouts that are folded, and the body each one is hiding.
 *
 * A StateField rather than part of the plugin above, for the same reason the
 * table is one: replacing a range that spans line breaks is not something a
 * view plugin may do. It is also the right home for it — the fold is a property
 * of the *document*, since it lives in the `-` after the marker, so every view
 * onto that document folds the same way without being told.
 *
 * A whole-document line scan on each change, like the table scan below it. The
 * gate is a substring test that almost every line fails immediately.
 */
function foldedCallouts(state: EditorState): Array<{ from: number; to: number; lines: number }> {
  const out: Array<{ from: number; to: number; lines: number }> = []
  const total = state.doc.lines
  for (let n = 1; n <= total; n++) {
    const line = state.doc.line(n)
    if (!line.text.includes('[!')) continue
    if (parseCallout(line.text)?.fold !== '-') continue
    let end = n
    while (end + 1 <= total && /^[ \t]*>/.test(state.doc.line(end + 1).text)) end++
    // Nothing underneath is nothing to fold: a one-line callout keeps its
    // chevron off and its `-` does nothing until it has a body.
    if (end === n) continue
    n = end
    const to = state.doc.line(end).to
    /*
     * Never fold a selection out of sight. The caret cannot normally get in
     * here — the range is atomic — but Select All reaches everywhere, and a
     * fold that swallowed the caret would be text you could type into and not
     * see.
     */
    if (touched(state, line.to + 1, to)) continue
    out.push({ from: line.to, to, lines: end - line.number })
  }
  return out
}

function buildCalloutFolds(state: EditorState): DecorationSet {
  return RangeSet.of(
    foldedCallouts(state).map((f) =>
      Decoration.replace({ widget: new CalloutFoldWidget(f.lines) }).range(f.from, f.to),
    ),
    true,
  )
}

export const calloutFoldField = StateField.define<DecorationSet>({
  create: buildCalloutFolds,
  update(value, tr) {
    const focusChanged = tr.effects.some((e) => e.is(setFocused))
    if (!tr.docChanged && !tr.selection && !tr.reconfigured && !focusChanged)
      return value.map(tr.changes)
    return buildCalloutFolds(tr.state)
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // Folded means folded: the caret does not stop inside lines nobody can see.
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
})

/** Whether the callout whose head line ends here has its body folded away. */
function calloutFolded(state: EditorState, headTo: number): boolean {
  const set = state.field(calloutFoldField, false)
  if (!set) return false
  let hit = false
  set.between(headTo, headTo, (from) => {
    if (from === headTo) hit = true
  })
  return hit
}

/**
 * Rendered tables.
 *
 * This has to be a StateField rather than part of the plugin above: replacing a
 * range that spans line breaks is a block decoration, and CodeMirror only
 * accepts those from state, never from a view plugin. (Getting that wrong
 * doesn't degrade — it throws and takes the whole editor down.)
 *
 * Scanning the full document is fine here: tables are found from the syntax
 * tree, which is incremental, and notes are small. On a document large enough
 * that the parser hasn't finished, the unparsed tail simply shows its source
 * until parsing catches up.
 */
interface TableBlock {
  fromLine: number
  toLine: number
}

/**
 * Find GFM pipe tables by scanning lines.
 *
 * This deliberately does not use the syntax tree. @lezer/markdown drops a table
 * whose delimiter row has any trailing whitespace — a single trailing space is
 * enough — and silently reparses the whole thing as paragraph text. Trailing
 * spaces are legal GFM and turn up constantly in real files, so detection is
 * done here against the actual rules: a header row, a delimiter row with a
 * matching cell count, then any following rows that contain a pipe.
 */
function findTables(state: EditorState): TableBlock[] {
  const out: TableBlock[] = []
  const total = state.doc.lines
  let inFence = false

  for (let n = 1; n <= total; n++) {
    const line = state.doc.line(n).text

    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // A table needs a header row with a pipe and a delimiter row beneath it.
    if (!line.includes('|') || isDelimiterRow(line)) continue
    if (n + 1 > total) break
    const delim = state.doc.line(n + 1).text
    if (!isDelimiterRow(delim)) continue
    if (countCells(delim) !== countCells(line)) continue

    let end = n + 1
    while (end + 1 <= total) {
      const next = state.doc.line(end + 1).text
      if (!next.trim() || !next.includes('|')) break
      if (/^\s{0,3}(```|~~~)/.test(next)) break
      end++
    }
    out.push({ fromLine: n, toLine: end })
    n = end
  }
  return out
}

function countCells(line: string): number {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  let count = 1
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\') {
      i++
      continue
    }
    if (t[i] === '|') count++
  }
  return count
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const out: Array<Range<Decoration>> = []
  const notePath = state.facet(noteContext).path
  const rich = state.facet(previewMode) === 'rich'
  /*
   * A cell is typed into directly in rich text — but only once the note has an
   * editing surface at all. A cell is its own editing host, so it would happily
   * take a tap and raise the keyboard in a note that is only being read, which
   * is the one thing reading mode promises will not happen.
   */
  // A locked note's cells are read like the rest of it: a cell is its own
  // editing host, so `readOnly` has to be asked here rather than left to
  // CodeMirror's own input handling.
  const typeable = rich && state.facet(EditorView.editable) && !state.readOnly

  for (const t of findTables(state)) {
    const first = state.doc.line(t.fromLine)
    const last = state.doc.line(t.toLine)
    /*
     * In live preview the caret inside a table means the user is editing it,
     * and the source is what they came for. Rich text never shows the pipes at
     * all: the rendered cells are the editor there, so the table stays a table
     * and typing happens inside it.
     */
    if (!rich && touched(state, first.from, last.to)) continue
    out.push(
      Decoration.replace({
        widget: new TableWidget(
          state.doc.sliceString(first.from, last.to),
          first.from,
          notePath,
          typeable,
          frontmatterOf(state),
        ),
        block: true,
      }).range(first.from, last.to),
    )
  }
  return RangeSet.of(out, true)
}

export const tableField = StateField.define<DecorationSet>({
  create: buildTableDecorations,
  update(value, tr) {
    const focusChanged = tr.effects.some((e) => e.is(setFocused))
    if (!tr.docChanged && !tr.selection && !tr.reconfigured && !focusChanged)
      return value.map(tr.changes)
    return buildTableDecorations(tr.state)
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
})

/**
 * Frontmatter, in rich text: not shown at all.
 *
 * The other two modes show the block because they are modes for looking at the
 * file — live preview keeps the syntax of whatever you are editing, and source
 * *is* the file. Rich text is the mode where a note is a page, and a page does
 * not open on eight lines of YAML. The properties are still there and still
 * editable: the date under the title opens a form over them (see
 * ui/Properties.tsx), which is a better editor for a key and a value than a
 * text buffer that will accept anything.
 *
 * A block decoration again, and again a StateField for it: a plugin may not
 * supply one, and hiding whole lines is exactly what a block replacement is.
 */
const hiddenBlock = Decoration.replace({ block: true })

function buildFrontmatterDecorations(state: EditorState): DecorationSet {
  if (state.facet(previewMode) !== 'rich') return Decoration.none
  const lines = frontmatterLines(state)
  if (lines.length === 0) return Decoration.none
  const first = state.doc.line(lines[0])
  const last = state.doc.line(lines[lines.length - 1])
  /*
   * A note that is *only* frontmatter keeps it. Hiding every line a document
   * has would leave an editor with nothing in it to click on and no line to
   * put a caret in — an empty note with no way to start writing in it. One
   * blank line under the block is enough: that line is somewhere to type.
   */
  if (lines[lines.length - 1] >= state.doc.lines) return Decoration.none
  return RangeSet.of([hiddenBlock.range(first.from, last.to)])
}

export const frontmatterField = StateField.define<DecorationSet>({
  create: buildFrontmatterDecorations,
  update(value, tr) {
    if (!tr.docChanged && !tr.reconfigured) return value
    return buildFrontmatterDecorations(tr.state)
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // Hidden means hidden: the caret does not stop inside a block nobody can
    // see, and Backspace at the top of the body does not eat the closing fence.
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
})
