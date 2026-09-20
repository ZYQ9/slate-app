/**
 * The colours text can be written in, and the one piece of syntax that carries
 * them.
 *
 * Markdown has no colour, so this follows underline: the HTML every renderer
 * passes through, written into the note as `<span style="color:#cf222e">…</span>`.
 * A coloured note opens coloured in Obsidian, on GitHub, in a browser — which
 * is the whole promise of the file being markdown, and the reason a tidier
 * `{red}…{/red}` was not worth inventing.
 *
 * Two things follow from putting a literal hex in the file.
 *
 * The first is that the hex has to be *checked* wherever it is read. It arrives
 * from a note, which is a file a person edits by hand and a sync pull can
 * rewrite, so it is never pasted into a style attribute unseen: `COLOR_HEX`
 * below is the only shape any of this accepts, and anything else is left as
 * literal text rather than rendered.
 *
 * The second is dark mode. A red picked against a white page is a red on a
 * black one too, and #cf222e on #1c1c1e is a colour you have to lean in to
 * read. So the palette's own values are mapped through a CSS variable with a
 * light and a dark side — the same trick, and the same eight-ish Primer hues,
 * the callouts already use — and only a colour from somewhere else is drawn
 * exactly as written. The file keeps the portable value; the screen gets the
 * legible one.
 */

export interface TextColor {
  /** Matches the CSS variable: `--mark-red`. */
  id: string
  label: string
  /** What goes in the file. The light-theme value, because files have no theme. */
  hex: string
}

/**
 * The palette, in spectrum order.
 *
 * Eight, for the reason the callouts stop at five: every colour here is a hue
 * that has to stay legible against both backgrounds forever, and a grid of
 * thirty swatches is a decision rather than a choice. These are GitHub's Primer
 * colours, which have already been through that argument — `--callout-note` and
 * friends in app.css are the same set.
 */
export const TEXT_COLORS: TextColor[] = [
  { id: 'red', label: 'Red', hex: '#cf222e' },
  { id: 'orange', label: 'Orange', hex: '#bc4c00' },
  { id: 'yellow', label: 'Yellow', hex: '#9a6700' },
  { id: 'green', label: 'Green', hex: '#1a7f37' },
  { id: 'blue', label: 'Blue', hex: '#0969da' },
  { id: 'purple', label: 'Purple', hex: '#8250df' },
  { id: 'pink', label: 'Pink', hex: '#bf3989' },
  { id: 'grey', label: 'Grey', hex: '#656d76' },
]

/**
 * A hex colour, and only a hex colour.
 *
 * Three, four, six or eight digits — the lengths CSS actually defines. Spelled
 * as an alternation rather than `{3,8}` because `#12345` is not a colour, and a
 * pattern that matched one would hide the markup around a value the browser
 * then ignores: text that has quietly lost its syntax and gained nothing.
 */
export const COLOR_HEX = String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})`

/**
 * The opening tag, with the colour as its one capture group.
 *
 * Shared as a source string rather than a RegExp because each of the three
 * places that reads it needs different flags and a different anchor — the
 * scanner anchors at `^`, live preview runs global over a line — and a single
 * RegExp object carrying `lastIndex` between them would be a bug waiting for a
 * quiet afternoon. `MD_URL` in links.ts is shared the same way.
 *
 * Whitespace is tolerated where a person or another editor would leave it, and
 * the trailing `;` because half of what writes this markup adds one.
 */
export const COLOR_OPEN = String.raw`<span style="color:\s*(${COLOR_HEX})\s*;?\s*">`

export const COLOR_CLOSE = '</span>'

/** The markup that puts `text` in `hex`. */
export function colorSpan(hex: string, text: string): string {
  return `<span style="color:${hex.toLowerCase()}">${text}${COLOR_CLOSE}`
}

/** The palette entry a note's hex names, if it names one. */
export function paletteColor(hex: string): TextColor | undefined {
  const want = hex.toLowerCase()
  return TEXT_COLORS.find((c) => c.hex === want)
}

/**
 * What to actually paint with: the palette's theme-aware variable when the note
 * asked for a palette colour, and the note's own value when it asked for
 * something else.
 *
 * Returns undefined for anything that is not a hex colour, which is the signal
 * to leave the markup alone rather than render it. Nothing downstream puts a
 * string from a note into a style attribute without coming through here.
 */
export function cssColor(hex: string): string | undefined {
  if (!new RegExp(`^${COLOR_HEX}$`).test(hex)) return undefined
  const known = paletteColor(hex)
  return known ? `var(--mark-${known.id}, ${known.hex})` : hex.toLowerCase()
}
