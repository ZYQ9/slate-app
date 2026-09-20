/**
 * A small inline-markdown renderer, for places where CodeMirror's own
 * decorations can't reach: text that lives inside a widget.
 *
 * Table cells are the reason this exists. A cell's content is rendered by us
 * into widget DOM, so the live-preview decorations — which only apply to text
 * still in the document flow — never touch it, and `**bold**` would show up
 * literally. This walks the cell text and builds the same set of elements the
 * editor uses elsewhere, including `data-wikilink` and `data-tag` hooks so the
 * existing click handlers keep working unchanged.
 *
 * Everything is built with createElement/createTextNode. No innerHTML is used
 * with note content anywhere in here.
 */

import { attachmentUrl, resolveEmbed, resolveLink } from '../core/vault'
import { resolveVars, varText, type FrontmatterValue } from '../core/markdown'
import { mediaClass } from '../core/util'
import { requestLightbox } from './context'
import { COLOR_CLOSE, COLOR_OPEN, cssColor } from './colors'
import { MD_URL } from './links'

interface Ctx {
  /** Path of the note the text came from, for resolving relative embeds. */
  notePath: string
  /**
   * The note's properties, so `$(client)` in a table cell reads as the value
   * it does everywhere else. A cell is text in a widget, which the editor's
   * own decorations cannot reach — the same reason `**bold**` is handled here.
   */
  vars?: Record<string, FrontmatterValue>
  /** Rich text: a value is a way in to the form that owns it. */
  varsClickable?: boolean
}

/** Ordered by precedence: earlier patterns win at the same position. */
const RULES: Array<{
  re: RegExp
  build: (m: RegExpExecArray, ctx: Ctx) => Node
}> = [
  // Inline code first — its contents are literal, so nothing inside is parsed.
  {
    re: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
    build: (m) => {
      const el = document.createElement('code')
      el.textContent = m[2]
      return el
    },
  },
  // Embeds before links, so "![[x]]" isn't read as "!" + "[[x]]".
  {
    re: /^!\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/,
    build: (m, ctx) => embedNode(m[1].trim(), m[2], ctx),
  },
  {
    re: /^!\[([^\]\n]*)\]\(\s*([^)\s]*)\s*\)/,
    build: (m, ctx) => embedNode(m[2], undefined, ctx, m[1]),
  },
  {
    re: /^\[\[([^\]\n|#]+)(?:#[^\]\n|]+)?(?:\|([^\]\n]*))?\]\]/,
    build: (m) => {
      const target = m[1].trim()
      const el = document.createElement('span')
      const resolved = resolveLink(target)
      el.className = resolved ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-broken'
      el.dataset.wikilink = target
      el.dataset.exists = resolved ? '1' : '0'
      el.title = resolved ?? `Create "${target}"`
      el.textContent = m[2] ?? target
      return el
    },
  },
  {
    // Balanced parentheses are part of the address — see `MD_URL`.
    re: new RegExp(String.raw`^\[([^\]\n]*)\]\(\s*(${MD_URL})\s*\)`),
    build: (m, ctx) => {
      const el = document.createElement('a')
      // A `$(case)` in the address resolves like one in a sentence: a link is
      // followed rather than read, so a token left in it goes nowhere.
      el.href = ctx.vars ? resolveVars(m[2], ctx.vars) : m[2]
      el.target = '_blank'
      el.rel = 'noopener noreferrer'
      appendInline(el, m[1], { notePath: '' })
      return el
    },
  },
  {
    re: /^\*\*([\s\S]+?)\*\*(?!\*)/,
    build: (m, ctx) => wrap('strong', m[1], ctx),
  },
  {
    re: /^__([\s\S]+?)__(?!_)/,
    build: (m, ctx) => wrap('strong', m[1], ctx),
  },
  {
    re: /^~~([\s\S]+?)~~/,
    build: (m, ctx) => wrap('del', m[1], ctx),
  },
  // Underline has no markdown syntax; the editor writes the HTML for it.
  {
    re: /^<u>([\s\S]+?)<\/u>/,
    build: (m, ctx) => wrap('u', m[1], ctx),
  },
  // Colour, the same way and for the same reason — see editor/colors.ts. The
  // hex is checked rather than trusted: this is note content on its way into a
  // style attribute, and `cssColor` is the only thing that decides it is one.
  {
    re: new RegExp(`^${COLOR_OPEN}([\\s\\S]+?)${COLOR_CLOSE}`),
    build: (m, ctx) => {
      const css = cssColor(m[1])
      if (!css) return document.createTextNode(m[0])
      const el = document.createElement('span')
      el.className = 'cm-color'
      el.style.color = css
      appendInline(el, m[2], ctx)
      return el
    },
  },
  {
    re: /^==([^\s][\s\S]*?)==/,
    build: (m, ctx) => {
      const el = document.createElement('span')
      el.className = 'cm-highlight'
      appendInline(el, m[1], ctx)
      return el
    },
  },
  {
    re: /^\*([^*\s][\s\S]*?)\*(?!\*)/,
    build: (m, ctx) => wrap('em', m[1], ctx),
  },
  // "_" only italicises at a word boundary, so snake_case_names survive.
  {
    re: /^_([^_\s][\s\S]*?)_(?![\w_])/,
    build: (m, ctx) => wrap('em', m[1], ctx),
  },
  // `$(key)` — a property of the note, read into the cell.
  {
    re: /^\$\(([A-Za-z0-9_.-]+)\)/,
    build: (m, ctx) => {
      const key = m[1]
      const known = ctx.vars && key in ctx.vars
      if (!known) return document.createTextNode(m[0])
      const value = varText(ctx.vars![key])
      const el = document.createElement('span')
      el.className = value === undefined ? 'cm-var cm-var-blank' : 'cm-var'
      el.textContent = value ?? key
      el.title =
        value === undefined ? `${key} has no value yet` : `${key} — from this note's properties`
      if (ctx.varsClickable) el.dataset.var = key
      return el
    },
  },
  {
    re: /^#([A-Za-z0-9_][A-Za-z0-9/_-]*)/,
    build: (m) => {
      const el = document.createElement('span')
      el.className = 'cm-tag'
      el.dataset.tag = m[1]
      el.textContent = `#${m[1]}`
      return el
    },
  },
  // A bare URL becomes a link, matching the editor's autolink behaviour.
  {
    re: /^(https?:\/\/[^\s<>()]+)/,
    build: (m) => {
      const el = document.createElement('a')
      el.href = m[1]
      el.target = '_blank'
      el.rel = 'noopener noreferrer'
      el.textContent = m[1]
      return el
    },
  },
]

function wrap(tag: string, inner: string, ctx: Ctx): Node {
  const el = document.createElement(tag)
  appendInline(el, inner, ctx)
  return el
}

function embedNode(ref: string, size: string | undefined, ctx: Ctx, alt = ''): Node {
  const external = /^(https?|data):/i.test(ref)
  const path = external ? undefined : resolveEmbed(decodeURI(ref), ctx.notePath)
  const src = external ? ref : path ? attachmentUrl(path) : undefined

  if (!src || (path && mediaClass(path) !== 'image')) {
    const el = document.createElement('span')
    el.className = 'cm-embed-missing'
    el.textContent = alt || ref
    return el
  }

  const img = document.createElement('img')
  img.src = src
  img.alt = alt || ref
  img.className = 'cm-inline-img'
  img.loading = 'lazy'
  const width = size && /^\d+$/.test(size.trim()) ? Number(size) : undefined
  if (width) img.style.width = `${width}px`
  if (path) {
    img.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      requestLightbox(path)
    })
  }
  return img
}

/** Append the rendering of `text` to `parent`. */
export function appendInline(parent: Node, text: string, ctx: Ctx): void {
  let buf = ''
  let i = 0

  const flush = () => {
    if (buf) {
      parent.appendChild(document.createTextNode(buf))
      buf = ''
    }
  }

  while (i < text.length) {
    // A backslash escape passes the next character through literally, which is
    // how "\|" survives inside a pipe table cell.
    if (text[i] === '\\' && i + 1 < text.length) {
      buf += text[i + 1]
      i += 2
      continue
    }

    let matched = false
    /*
     * Only try rules at characters that could start one; scanning every rule at
     * every position would be needlessly quadratic on long cells.
     *
     * Every rule's first character has to be in here or the rule is dead code.
     * `<` and `=` were missing, which is why a `<u>` or an `==` in a table cell
     * used to come out as the literal characters while the same markup a line
     * above it rendered.
     */
    if (/[`!\[*_~#h$<=]/.test(text[i])) {
      const rest = text.slice(i)
      for (const rule of RULES) {
        const m = rule.re.exec(rest)
        if (!m || !m[0]) continue
        flush()
        parent.appendChild(rule.build(m, ctx))
        i += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      buf += text[i]
      i++
    }
  }
  flush()
}

/** Convenience: render into a fresh fragment. */
export function renderInline(
  text: string,
  notePath: string,
  vars?: Record<string, FrontmatterValue>,
  varsClickable = false,
): DocumentFragment {
  const frag = document.createDocumentFragment()
  appendInline(frag, text, { notePath, vars, varsClickable })
  return frag
}
