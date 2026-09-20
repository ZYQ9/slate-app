// @vitest-environment jsdom
/**
 * Coloured text, on both surfaces that render a note.
 *
 * The editor's own decorations do it for text in the document flow, and
 * inline.ts does it again for text inside a widget — a table cell — which
 * those decorations cannot reach. The two have to agree, and the thing worth
 * pinning down in both is what happens to a colour the app does not recognise:
 * the markup stays on screen as text rather than being hidden around a value
 * the browser would ignore, and nothing from a note reaches a style attribute
 * without `cssColor` having said it is a colour.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditorState } from './setup'
import { renderInline } from './inline'
import { cssColor } from './colors'

let view: EditorView | undefined

afterEach(() => {
  view?.destroy()
  view = undefined
})

/** The note as rich text renders it, with the raw markup hidden. */
function render(doc: string): HTMLElement {
  view = new EditorView({
    state: createEditorState({ doc, path: 'note.md', mode: 'rich', fontSize: 16, onChange: () => {} }),
  })
  return view.contentDOM
}

const RED = '<span style="color:#cf222e">Friday</span>'

describe('in the note itself', () => {
  it('paints the text and hides the tags around it', () => {
    const dom = render(`Deadline ${RED} sharp`)
    const span = dom.querySelector('.cm-color')!
    expect(span.textContent).toBe('Friday')
    expect(span.getAttribute('style')).toContain('var(--mark-red')
    // The tags are replaced, not just styled: what is on screen is the words.
    expect(dom.textContent).toBe('Deadline Friday sharp')
  })

  /*
   * A palette colour goes through a variable so the note is legible in both
   * themes; anything else is drawn exactly as the note asked, since the app
   * has no second value to offer for it.
   */
  it('draws a colour from outside the palette as written', () => {
    const dom = render('a <span style="color:#123456">b</span> c')
    // jsdom re-serialises a colour it understands; #123456 is that colour.
    expect((dom.querySelector('.cm-color') as HTMLElement).style.color).toBe('rgb(18, 52, 86)')
    expect(dom.textContent).toBe('a b c')
  })

  it('leaves markup that is not a colour as the text it is', () => {
    const doc = 'a <span style="color:#12345">b</span> c'
    const dom = render(doc)
    expect(dom.querySelector('.cm-color')).toBeNull()
    expect(dom.textContent).toBe(doc)
  })
})

describe('in a table cell', () => {
  const cell = (text: string) => {
    const host = document.createElement('div')
    host.appendChild(renderInline(text, 'note.md'))
    return host
  }

  it('paints the text there too, with the markup gone', () => {
    const host = cell(`Deadline ${RED} sharp`)
    expect(host.querySelector('.cm-color')!.textContent).toBe('Friday')
    expect(host.textContent).toBe('Deadline Friday sharp')
  })

  it('renders marks inside a colour', () => {
    const host = cell('<span style="color:#cf222e">**Friday**</span>')
    expect(host.querySelector('.cm-color strong')!.textContent).toBe('Friday')
  })

  it('leaves an unrecognised colour as text', () => {
    const text = '<span style="color:red">Friday</span>'
    const host = cell(text)
    expect(host.querySelector('.cm-color')).toBeNull()
    expect(host.textContent).toBe(text)
  })

  /*
   * Underline and highlight in a cell, which is what the character gate in
   * `appendInline` used to drop on the floor: the rules were there, and no
   * `<` or `=` ever reached them.
   */
  it('renders the other two HTML-ish marks a cell can hold', () => {
    expect(cell('<u>note</u>').querySelector('u')!.textContent).toBe('note')
    expect(cell('==note==').querySelector('.cm-highlight')!.textContent).toBe('note')
  })
})

describe('cssColor', () => {
  it('maps the palette through a variable and passes other hexes through', () => {
    expect(cssColor('#CF222E')).toBe('var(--mark-red, #cf222e)')
    expect(cssColor('#123456')).toBe('#123456')
    expect(cssColor('#abc')).toBe('#abc')
  })

  it('refuses anything that is not a hex colour', () => {
    expect(cssColor('red')).toBeUndefined()
    expect(cssColor('#12345')).toBeUndefined()
    expect(cssColor('rgb(1,2,3)')).toBeUndefined()
    expect(cssColor('#cf222e;background:url(x)')).toBeUndefined()
  })
})
