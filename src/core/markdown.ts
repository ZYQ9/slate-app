/**
 * Markdown introspection: frontmatter, wikilinks, embeds, tags, tasks.
 *
 * These are deliberately regex-level rather than a full parse. The index is
 * rebuilt on every save, so this runs often and must stay cheap; and being
 * lenient here is safer than being strict — a link the parser misses is a
 * broken feature, but a note it refuses is lost work.
 */

import { normPath, parseYmd, startOfDay, titleFromPath, ymd } from './util'

/** What a single frontmatter key can hold, once parsed. */
export type FrontmatterValue = string | string[] | boolean | number

export interface Frontmatter {
  data: Record<string, FrontmatterValue>
  /** Character offset in the source where the body begins. */
  bodyStart: number
  raw: string
}

/** Parse a leading `---` YAML-ish block. Supports scalars and `[a, b]` / `- a` lists. */
export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---')) return { data: {}, bodyStart: 0, raw: '' }
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { data: {}, bodyStart: 0, raw: '' }
  const data: Record<string, FrontmatterValue> = {}
  let lastKey: string | undefined
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && lastKey) {
      const prev = data[lastKey]
      const arr = Array.isArray(prev) ? prev : prev === '' || prev === undefined ? [] : [String(prev)]
      arr.push(unquote(item[1]))
      data[lastKey] = arr
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    lastKey = kv[1]
    const rawVal = kv[2].trim()
    if (rawVal === '') {
      data[lastKey] = ''
    } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      data[lastKey] = rawVal
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean)
    } else if (rawVal === 'true' || rawVal === 'false') {
      data[lastKey] = rawVal === 'true'
    } else if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
      data[lastKey] = Number(rawVal)
    } else {
      data[lastKey] = unquote(rawVal)
    }
  }
  return { data, bodyStart: m[0].length, raw: m[0] }
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1)
  return s
}

/** Replace or insert a single frontmatter key, preserving everything else. */
export function setFrontmatterKey(text: string, key: string, value: string): string {
  const fm = parseFrontmatter(text)
  const line = `${key}: ${/[:#\-[\]{}]|^\s|\s$/.test(value) ? JSON.stringify(value) : value}`
  if (!fm.raw) return `---\n${line}\n---\n\n${text}`
  const inner = fm.raw.replace(/^---\r?\n/, '').replace(/\r?\n---[ \t]*\r?\n?$/, '')
  const lines = inner.split(/\r?\n/)
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (idx >= 0) lines[idx] = line
  else lines.push(line)
  return `---\n${lines.join('\n')}\n---\n${text.slice(fm.bodyStart)}`
}

/**
 * Replace or insert a frontmatter key holding a list of values.
 *
 * Written in the block form — `key:` then `  - "value"` — rather than the flow
 * form `key: [a, b]`, for one reason: the flow reader splits on commas, so a
 * value containing one comes back in two pieces. A note called
 * `Plan, revised` is an ordinary note name, and losing it to punctuation would
 * be the kind of silent failure this list format exists to avoid.
 *
 * Every value is quoted, because the values this was written for are wikilinks
 * and YAML reads a bare `[[A]]` as a nested sequence.
 *
 * An empty list removes the key rather than leaving `key: []` behind — a key
 * that holds nothing is a key somebody has to work out the meaning of later.
 */
export function setFrontmatterList(text: string, key: string, values: string[]): string {
  const clean = values.map((v) => v.trim()).filter(Boolean)
  const block = [`${key}:`, ...clean.map((v) => `  - ${JSON.stringify(v)}`)]
  const fm = parseFrontmatter(text)
  if (!fm.raw) return clean.length ? `---\n${block.join('\n')}\n---\n\n${text}` : text

  const inner = fm.raw.replace(/^---\r?\n/, '').replace(/\r?\n---[ \t]*\r?\n?$/, '')
  const lines = inner.split(/\r?\n/)
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (idx >= 0) {
    // A block list's `- item` lines belong to the key above them, so they are
    // replaced with it. Left behind, they would reattach to whichever key ended
    // up above them and quietly become part of a different list.
    let end = idx + 1
    while (end < lines.length && /^\s*-\s+/.test(lines[end])) end++
    lines.splice(idx, end - idx, ...(clean.length ? block : []))
  } else if (clean.length) {
    lines.push(...block)
  }
  // Removing the only key leaves an empty block, which is worse than no block.
  if (!lines.length) return text.slice(fm.bodyStart)
  return `---\n${lines.join('\n')}\n---\n${text.slice(fm.bodyStart)}`
}

/* --------------------------------------------------------------- variables */

/**
 * `$(key)` — a frontmatter value, written into the body of the note.
 *
 * The note file keeps the token; only the rendered views swap it for the
 * value, which is what makes it safe: nothing rewrites the file, and a note
 * carrying these opens in any other markdown editor as the text that was
 * typed. That is the same bargain live preview makes everywhere else.
 *
 * `$(...)` rather than `{{...}}` on purpose. Templates already use `{{title}}`
 * and `{{date}}`, and those are expanded *once*, when the note is made; this
 * one is resolved every time the note is drawn. Two different things deserve
 * two different shapes.
 *
 * The key charset is the one `parseFrontmatter` accepts, so anything nameable
 * in the properties form is nameable here.
 */
const VAR = /\$\(([A-Za-z0-9_.-]+)\)/g

export interface VarRef {
  from: number
  to: number
  key: string
}

/** Every `$(key)` in `text`, with positions offset by `offset`. */
export function scanVars(text: string, offset = 0): VarRef[] {
  const out: VarRef[] = []
  VAR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = VAR.exec(text))) {
    out.push({ from: offset + m.index, to: offset + m.index + m[0].length, key: m[1] })
  }
  return out
}

/**
 * A single-backtick span: the one place a `$(key)` is left as it was typed.
 *
 * Which is what makes the syntax writable about — a note explaining
 * `$(client)` has to be able to say it — and it is single backticks alone, so
 * that a fenced block, whose fences are three, still fills itself in. A span
 * cannot cross a line, which is also what keeps a lone backtick in prose from
 * swallowing the rest of the paragraph.
 */
const INLINE_CODE = /(?<!`)`[^`\n]+`(?!`)/g

/**
 * Swap every `$(key)` this data can answer for. Anything else is left alone —
 * a name nobody declared, and a property still waiting to be filled in, both
 * stay as the text they are, because both are still questions. So is anything
 * in backticks.
 */
export function resolveVars(text: string, data: Record<string, FrontmatterValue>): string {
  const swap = (chunk: string) => {
    VAR.lastIndex = 0
    return chunk.replace(VAR, (raw, key: string) => (key in data ? (varText(data[key]) ?? raw) : raw))
  }
  let out = ''
  let at = 0
  INLINE_CODE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_CODE.exec(text))) {
    out += swap(text.slice(at, m.index)) + m[0]
    at = m.index + m[0].length
  }
  return out + swap(text.slice(at))
}

/**
 * How a value reads in a sentence, or `undefined` when there is nothing to
 * read — which the views draw as a blank to fill in rather than as nothing at
 * all, since a template's empty property is the whole point of it.
 *
 * A list joins with commas, because that is how `tags: [travel, lisbon]` is
 * typed into the properties form and how it reads back out. `false` is a
 * value, not a blank.
 */
export function varText(value: FrontmatterValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    const joined = value.filter((v) => String(v).trim()).join(', ')
    return joined || undefined
  }
  const s = String(value).trim()
  return s || undefined
}

/**
 * The property that makes a note's body read-only.
 *
 * A note carrying it is a form: the properties can be filled in, and nothing
 * else about it can be typed over — no caret, no checkbox to tick, no table
 * cell to edit. That is the point of pairing it with `$(name)`. A page whose
 * every changeable part is a labelled field cannot be knocked out of shape by
 * the person filling it in, and one built to be copied out of stays exactly as
 * it was written.
 *
 * Three spellings, because the hyphen is the one this documents and the other
 * two are what people type. The value is read the way a person means it rather
 * than the way YAML would: the properties form writes `true` for its checkbox,
 * and anyone writing the block by hand writes `yes`.
 */
const LOCK_KEYS = ['read-only', 'readonly', 'read_only']
const LOCK_YES = new Set(['true', 'yes', 'on', '1'])

export function isLocked(data: Record<string, FrontmatterValue>): boolean {
  return LOCK_KEYS.some((k) => {
    const v = data[k]
    if (v === undefined || Array.isArray(v)) return false
    return LOCK_YES.has(String(v).trim().toLowerCase())
  })
}

/* ----------------------------------------------------------------- regions */

/**
 * Byte ranges that must be ignored by link/tag/task scanning: fenced code
 * blocks and inline code. Without this, a `#hashtag` in a code sample becomes a
 * tag and a `[[foo]]` in a snippet becomes a phantom link.
 */
export function codeRegions(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const fence = /^(\s*)(```|~~~)[^\n]*$/gm
  let m: RegExpExecArray | null
  let openAt: number | null = null
  let openMark = ''
  while ((m = fence.exec(text))) {
    if (openAt === null) {
      openAt = m.index
      openMark = m[2]
    } else if (m[2][0] === openMark[0]) {
      out.push([openAt, m.index + m[0].length])
      openAt = null
    }
  }
  if (openAt !== null) out.push([openAt, text.length])

  const inline = /`+[^`\n]*`+/g
  while ((m = inline.exec(text))) {
    const s = m.index
    if (!out.some(([a, b]) => s >= a && s < b)) out.push([s, s + m[0].length])
  }
  return out
}

export function inRegions(regions: Array<[number, number]>, i: number): boolean {
  for (const [a, b] of regions) if (i >= a && i < b) return true
  return false
}

/* ------------------------------------------------------------------- links */

export interface WikiLink {
  /** Full match including brackets and any leading "!". */
  from: number
  to: number
  /** Target as written, before "#" or "|". */
  target: string
  /** Heading/block anchor after "#", if any. */
  anchor?: string
  /** Display text or, for embeds, a width like "400". */
  alias?: string
  embed: boolean
}

const WIKI = /(!?)\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]*))?\]\]/g

export function scanWikiLinks(text: string, regions = codeRegions(text)): WikiLink[] {
  const out: WikiLink[] = []
  WIKI.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKI.exec(text))) {
    if (inRegions(regions, m.index)) continue
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      target: m[2].trim(),
      anchor: m[3]?.trim(),
      alias: m[4]?.trim(),
      embed: m[1] === '!',
    })
  }
  return out
}

export interface MdLink {
  from: number
  to: number
  alt: string
  url: string
  embed: boolean
  /** Offsets of just the URL, so a resize can rewrite it in place. */
  urlFrom: number
  urlTo: number
}

// ![alt](path "title")  /  [text](path)
const MDLINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]*)(\s+"[^"\n]*")?\s*\)/g

export function scanMdLinks(text: string, regions = codeRegions(text)): MdLink[] {
  const out: MdLink[] = []
  MDLINK.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MDLINK.exec(text))) {
    if (inRegions(regions, m.index)) continue
    const rawUrl = m[3]
    const bracketed = rawUrl.startsWith('<') && rawUrl.endsWith('>')
    const urlStart = m.index + m[0].indexOf(rawUrl, m[1].length + m[2].length + 2)
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      alt: m[2],
      url: bracketed ? rawUrl.slice(1, -1) : rawUrl,
      embed: m[1] === '!',
      urlFrom: urlStart + (bracketed ? 1 : 0),
      urlTo: urlStart + rawUrl.length - (bracketed ? 1 : 0),
    })
  }
  return out
}

/** Strip a `#w=400` sizing fragment from an embed URL. Returns [clean, width]. */
export function splitSizeFragment(url: string): [string, number | undefined] {
  const m = /^(.*?)#w=(\d+)$/.exec(url)
  if (!m) return [url, undefined]
  return [m[1], Number(m[2])]
}

/* -------------------------------------------------------------------- tags */

const TAG = /(^|[\s(>])#([A-Za-z0-9_][A-Za-z0-9/_-]*)/g

export function scanTags(text: string, regions = codeRegions(text)): string[] {
  const set = new Set<string>()
  TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG.exec(text))) {
    const at = m.index + m[1].length
    if (inRegions(regions, at)) continue
    // A "#" at the very start of a line followed by a space is a heading.
    set.add(m[2])
  }
  return [...set]
}

/* ------------------------------------------------------------------- tasks */

export interface RawTask {
  line: number
  /** Character offset of the "[" in "- [ ]". */
  markerAt: number
  done: boolean
  text: string
  due?: number
  /** Tags written on the task's own line. */
  tags: string[]
}

const TASK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s?(.*)$/

/** Is this line a `- [ ]` / `1. [x]` task? */
export function isTaskLine(line: string): boolean {
  return TASK.test(line)
}

/**
 * Every task in a note — which does not include an empty checkbox.
 *
 * `- [ ]` with nothing after it is a line waiting to be typed into, not a job
 * anybody has to do. The daily note's template opens with a few of them on
 * purpose, and a template's blank lines have no business turning up in the
 * Tasks view, in a Tag Folder, or in tomorrow's count of what is due. So they
 * are not indexed, by any of the lists that ask this function what a note
 * holds — `hasTasks` included, so a note holding nothing but blank checkboxes
 * does not answer to a `has:tasks` rule either.
 *
 * The editor draws its checkbox from `isTaskLine`, not from here, so an empty
 * one is still a checkbox in the note: tickable, and a task the moment it is
 * given something to say.
 */
export function scanTasks(text: string): RawTask[] {
  const out: RawTask[] = []
  const regions = codeRegions(text)
  let offset = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = TASK.exec(line)
    const body = m ? m[3].trim() : ''
    if (m && body && !inRegions(regions, offset)) {
      const markerAt = offset + line.indexOf('[', m[1].length)
      out.push({
        line: i,
        markerAt,
        done: m[2].toLowerCase() === 'x',
        text: body,
        due: parseDue(m[3]),
        tags: scanTags(m[3]),
      })
    }
    offset += line.length + 1
  }
  return out
}

/**
 * The tags the note itself carries, as opposed to the ones written on its
 * tasks.
 *
 * `scanTags` reads the whole file, so a `#urgent` written on one task line
 * makes the note tagged `#urgent` — which is right for the note (it does
 * contain urgent work) and wrong as something for *every other task on it* to
 * inherit. A task inherits what the note says about itself, not what its
 * siblings say about themselves.
 *
 * The task lines are blanked to spaces rather than removed, so every offset in
 * the text stays where it was and the code-fence regions still line up.
 */
export function noteLevelTags(text: string): string[] {
  const lines = text.split('\n')
  let blanked = false
  for (let i = 0; i < lines.length; i++) {
    if (!TASK.test(lines[i])) continue
    lines[i] = ' '.repeat(lines[i].length)
    blanked = true
  }
  return blanked ? scanTags(lines.join('\n')) : scanTags(text)
}

/* -------------------------------------------------------------- due dates */

/**
 * Every due-date syntax the app understands, in one pattern.
 *
 * Reading stays deliberately permissive — a vault may have been written by
 * Obsidian's Tasks plugin (`📅`), Dataview (`[due:: ]`), or by hand — while
 * `withDue` only ever *writes* the emoji form. That asymmetry is the point: a
 * date someone else's tool wrote keeps working, and a date this app writes
 * looks like the one the docs describe.
 */
// The \uFE0F is optional because a 📅 pasted from some keyboards carries a
// variation selector, and without it the marker parses but never fully strips.
const DUE_SRC = String.raw`(?:📅\uFE0F?|@due\(|due:)\s*(\d{4}-\d{2}-\d{2})\)?|\[due::\s*(\d{4}-\d{2}-\d{2})\]`
const DUE = new RegExp(DUE_SRC)
/** The same, plus any whitespace in front, for cutting a marker back out. */
const DUE_CUT = new RegExp(String.raw`[ \t]*(?:${DUE_SRC})`, 'g')

export interface DueMarker {
  /** Character offsets of the marker within the string it was found in. */
  from: number
  to: number
  /** ms epoch, local midnight. */
  date: number
}

/** Locate the due marker in a line, offsets included — the editor needs both. */
export function findDue(s: string): DueMarker | undefined {
  const m = DUE.exec(s)
  if (!m) return undefined
  const date = parseYmd(m[1] ?? m[2])
  if (date === undefined) return undefined
  return { from: m.index, to: m.index + m[0].length, date }
}

/** Recognizes `📅 2026-09-01`, `@due(2026-09-01)`, `due:2026-09-01`, `[due:: 2026-09-01]`. */
export function parseDue(s: string): number | undefined {
  return findDue(s)?.date
}

/**
 * Rewrite a line to carry exactly one due date, or none.
 *
 * Every existing marker goes first — including one this app didn't write, and
 * including a second one someone left behind — so setting a date twice can't
 * accumulate. The new marker is appended at the end of the line rather than
 * inserted where the old one sat: end-of-line is where the parser, the chip and
 * every other tool expect it, and it keeps the sentence you wrote intact.
 */
export function withDue(line: string, date: number | undefined): string {
  const bare = line.replace(DUE_CUT, '').replace(/[ \t]+$/, '')
  if (date === undefined) return bare
  return `${bare} 📅 ${ymd(date)}`
}

/* ----------------------------------------------------------------- summary */

/**
 * Strip inline markup for display in UI chrome (task lists, palettes) where the
 * raw syntax would be noise. The source is never modified — this is only ever
 * used for what's shown, so nothing round-trips through it.
 */
export function stripInline(s: string): string {
  return s
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    /*
     * The two inline styles written as HTML: underline, and the coloured span
     * (see editor/colors.ts). Named here rather than imported, because a tag
     * left in a note-list row — `<span style="color:#cf222e">Friday` — is a
     * markdown-dialect fact like the rest of this file, and core does not
     * reach into the editor.
     */
    .replace(/<\/?(?:u|span)\b[^>]*>/g, '')
    .replace(/(\*\*|__|~~|==|\*|_|`)/g, '')
    .replace(DUE_CUT, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * First meaningful line of body text, for the note list subtitle.
 *
 * `vars` is the note's own properties, when the caller has them: a row reading
 * "Prepared for $(client)" beside a page reading "Prepared for Acme Corp" is
 * the same note described two ways, and the list is the one that is wrong.
 */
export function excerptOf(
  text: string,
  bodyStart = 0,
  vars?: Record<string, FrontmatterValue>,
): string {
  const body = text.slice(bodyStart)
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) continue
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    if (/^```/.test(line)) continue
    const clean = line
      /*
       * A callout's `[!NOTE]` is a marker, not the note's first words: the
       * app draws it as an icon, and a list row that led with "[!NOTE] In one
       * line" would be reading out the punctuation. Taken off before the
       * blockquote `>` goes, so the pattern can still see which line it is on.
       */
      .replace(/^>\s*\[![A-Za-z]+\][+-]?\s*/, '')
      .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      /*
       * Underline and colour, which are written as HTML — and which have to go
       * before the line below strips `>`, since that would take the end off
       * every tag and leave the attributes behind as the note's first words.
       */
      .replace(/<\/?(?:u|span)\b[^>]*>/g, '')
      .replace(/[*_~`>]/g, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '')
      .trim()
    if (clean) return (vars ? resolveVars(clean, vars) : clean).slice(0, 180)
  }
  return ''
}

/** The H1 or first heading, used to offer a rename when the title drifts. */
export function firstHeading(text: string, bodyStart = 0): string | undefined {
  const m = /^#{1,6}\s+(.+)$/m.exec(text.slice(bodyStart, bodyStart + 4000))
  return m?.[1].trim()
}

/**
 * The date a note is filed under in the calendar. Priority:
 *   1. `date:` or `created:` in frontmatter
 *   2. a YYYY-MM-DD prefix or suffix in the filename (daily notes)
 *   3. the file's creation time
 */
export function calendarDateFor(
  path: string,
  fm: Record<string, unknown>,
  ctime: number,
): number {
  for (const key of ['date', 'created']) {
    const v = fm[key]
    if (typeof v === 'string') {
      const t = parseYmd(v.slice(0, 10))
      if (t !== undefined) return t
    }
  }
  const name = titleFromPath(path)
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name)
  if (m) {
    const t = parseYmd(m[1])
    if (t !== undefined) return t
  }
  return startOfDay(ctime)
}

/** Resolve a wikilink target to a vault path, given a title -> path map. */
export function resolveTarget(
  target: string,
  byTitle: Map<string, string>,
  allPaths: Set<string>,
): string | undefined {
  const t = target.trim()
  if (!t) return undefined
  // Exact path (with or without extension) wins over title matching.
  const np = normPath(t)
  if (allPaths.has(np)) return np
  if (allPaths.has(`${np}.md`)) return `${np}.md`
  return byTitle.get(t.toLowerCase())
}
