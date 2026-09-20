/**
 * The formatting rules behind the Rich Text toolbar.
 *
 * These run against a bare EditorState — no DOM, no view — because that is
 * exactly what the commands are: text edits on markdown. `‸` marks the caret in
 * these fixtures and `«…»` marks a selection.
 */

import { describe, expect, it } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import {
  colorAt,
  expandToMarkup,
  indentList,
  inspect,
  parseLine,
  scanInline,
  setBlockStyle,
  setColor,
  toggleInline,
  toggleList,
  toggleQuote,
} from './format'

/** Build a state from a fixture, stripping the caret/selection markers. */
function st(fixture: string): EditorState {
  const caret = fixture.indexOf('‸')
  if (caret >= 0) {
    const doc = fixture.replace('‸', '')
    return EditorState.create({ doc, selection: { anchor: caret } })
  }
  const from = fixture.indexOf('«')
  const to = fixture.indexOf('»') - 1
  const doc = fixture.replace('«', '').replace('»', '')
  return EditorState.create({ doc, selection: { anchor: from, head: to } })
}

/** Apply a spec and render the result with the caret/selection marked. */
function out(state: EditorState, spec: TransactionSpec | null): string {
  if (!spec) return state.doc.toString()
  const tr = state.update(spec)
  const text = tr.state.doc.toString()
  const { from, to } = tr.state.selection.main
  return from === to
    ? `${text.slice(0, from)}‸${text.slice(from)}`
    : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
}

/** Result text only, for cases where the selection is not the point. */
function text(state: EditorState, spec: TransactionSpec | null): string {
  return spec ? state.update(spec).state.doc.toString() : state.doc.toString()
}

describe('parseLine', () => {
  it('splits every markdown prefix off the content', () => {
    expect(parseLine('  - [x] done')).toMatchObject({
      indent: '  ',
      marker: '- ',
      task: '[x] ',
      markerKind: 'check',
      content: 'done',
    })
    expect(parseLine('> ## Quoted heading')).toMatchObject({
      quote: '> ',
      level: 2,
      content: 'Quoted heading',
    })
    expect(parseLine('3) third')).toMatchObject({ markerKind: 'number', marker: '3) ' })
    expect(parseLine('plain text')).toMatchObject({ level: 0, markerKind: null, quote: '' })
  })

  it('does not mistake a horizontal rule for a bullet', () => {
    expect(parseLine('---').markerKind).toBe(null)
  })
})

describe('block styles', () => {
  it('applies and replaces heading levels', () => {
    expect(text(st('Groceries‸'), setBlockStyle(st('Groceries‸'), 'title'))).toBe('# Groceries')
    const h1 = st('# Groceries‸')
    expect(text(h1, setBlockStyle(h1, 'heading'))).toBe('## Groceries')
    const h3 = st('### Groceries‸')
    expect(text(h3, setBlockStyle(h3, 'body'))).toBe('Groceries')
  })

  it('keeps the caret in the text when the prefix changes', () => {
    const s = st('# Trip‸')
    expect(out(s, setBlockStyle(s, 'heading'))).toBe('## Trip‸')
  })

  it('keeps the caret in the text when the marker goes in front of it', () => {
    const s = st('‸Trip')
    expect(out(s, setBlockStyle(s, 'heading'))).toBe('## ‸Trip')
    const q = st('‸thought')
    expect(out(q, toggleQuote(q))).toBe('> ‸thought')
  })

  it('keeps indent and quote, and drops a list marker', () => {
    const q = st('> note‸')
    expect(text(q, setBlockStyle(q, 'heading'))).toBe('> ## note')
    const li = st('- item‸')
    expect(text(li, setBlockStyle(li, 'title'))).toBe('# item')
  })

  it('styles every line of a selection', () => {
    const s = st('«one\ntwo\nthree»')
    expect(text(s, setBlockStyle(s, 'subheading'))).toBe('### one\n### two\n### three')
  })

  it('reports nothing to do when the style is already set', () => {
    const s = st('## Heading‸')
    expect(setBlockStyle(s, 'heading')).toBe(null)
  })
})

describe('lists', () => {
  it('turns a line into a bullet and back', () => {
    const s = st('milk‸')
    expect(text(s, toggleList(s, 'bullet'))).toBe('- milk')
    const b = st('- milk‸')
    expect(text(b, toggleList(b, 'bullet'))).toBe('milk')
  })

  it('converts between list kinds', () => {
    const b = st('- milk‸')
    expect(text(b, toggleList(b, 'number'))).toBe('1. milk')
    const n = st('1. milk‸')
    expect(text(n, toggleList(n, 'check'))).toBe('- [ ] milk')
    const c = st('- [x] milk‸')
    expect(text(c, toggleList(c, 'bullet'))).toBe('- milk')
  })

  it('numbers a selection sequentially', () => {
    const s = st('«milk\neggs\nbread»')
    expect(text(s, toggleList(s, 'number'))).toBe('1. milk\n2. eggs\n3. bread')
  })

  it('continues the numbering of the list it joins', () => {
    const s = st('1. milk\n2. eggs\nbread‸')
    expect(text(s, toggleList(s, 'number'))).toBe('1. milk\n2. eggs\n3. bread')
  })

  it('leaves the caret after the marker, ready to type', () => {
    // The reason this matters: on an empty line the caret sits exactly where
    // the marker is inserted, and the default mapping would leave it in front
    // of the checkbox — so the first word typed lands before it.
    const empty = st('‸')
    expect(out(empty, toggleList(empty, 'check'))).toBe('- [ ] ‸')
    const start = st('‸milk')
    expect(out(start, toggleList(start, 'check'))).toBe('- [ ] ‸milk')
    const bullet = st('‸milk')
    expect(out(bullet, toggleList(bullet, 'bullet'))).toBe('- ‸milk')
    // And back out again, with the caret still against the text.
    const done = st('- [ ] ‸milk')
    expect(out(done, toggleList(done, 'check'))).toBe('‸milk')
  })

  it('quotes and unquotes', () => {
    const s = st('thought‸')
    expect(text(s, toggleQuote(s))).toBe('> thought')
    const q = st('> thought‸')
    expect(text(q, toggleQuote(q))).toBe('thought')
  })
})

describe('nesting', () => {
  it('indents and outdents list items', () => {
    const s = st('- item‸')
    expect(text(s, indentList(s, 1))).toBe('  - item')
    const nested = st('  - item‸')
    expect(text(nested, indentList(nested, -1))).toBe('- item')
  })

  it('leaves prose alone, where four spaces would mean a code block', () => {
    const s = st('just a paragraph‸')
    expect(indentList(s, 1)).toBe(null)
  })
})

describe('inline marks', () => {
  it('wraps a selection', () => {
    const s = st('make «this» bold')
    expect(out(s, toggleInline(s, 'bold'))).toBe('make **«this»** bold')
  })

  it('unwraps when the caret sits inside the span', () => {
    const s = st('make **th‸is** bold')
    expect(out(s, toggleInline(s, 'bold'))).toBe('make th‸is bold')
  })

  /*
   * The toggle has to be an exact round trip. It was not: unwrapping left the
   * anchor where it stood while the text moved back two characters under it,
   * so highlighting and unhighlighting the same phrase repeatedly ate it two
   * characters at a time, without the user touching the selection.
   */
  it('gives back exactly the selection it wrapped', () => {
    let s = st('«Some» sample words')
    for (let i = 0; i < 4; i++) {
      expect(out(s, toggleInline(s, 'highlight'))).toBe('==«Some»== sample words')
      s = s.update(toggleInline(s, 'highlight')).state
      expect(out(s, toggleInline(s, 'highlight'))).toBe('«Some» sample words')
      s = s.update(toggleInline(s, 'highlight')).state
    }
  })

  it('keeps a caret against the same character when the wrapper goes', () => {
    expect(out(st('a **bo‸ld** b'), toggleInline(st('a **bo‸ld** b'), 'bold'))).toBe('a bo‸ld b')
    expect(out(st('a **‸bold** b'), toggleInline(st('a **‸bold** b'), 'bold'))).toBe('a ‸bold b')
    expect(out(st('a **bold‸** b'), toggleInline(st('a **bold‸** b'), 'bold'))).toBe('a bold‸ b')
  })

  it('wraps the word under a bare caret', () => {
    const s = st('make thi‸s bold')
    expect(text(s, toggleInline(s, 'italic'))).toBe('make *this* bold')
  })

  it('leaves an empty pair to type into when there is no word', () => {
    const s = st('start ‸')
    expect(out(s, toggleInline(s, 'bold'))).toBe('start **‸**')
  })

  it('uses HTML for underline, which markdown has no syntax for', () => {
    const s = st('«note»')
    expect(text(s, toggleInline(s, 'underline'))).toBe('<u>note</u>')
    const u = st('<u>no‸te</u>')
    expect(text(u, toggleInline(u, 'underline'))).toBe('note')
  })

  it('does not read bold as an empty italic', () => {
    const spans = scanInline('a **bold** b')
    expect(spans.map((s) => s.mark)).toEqual(['bold'])
  })

  it('finds nested marks', () => {
    const spans = scanInline('**bold with *italic* inside**')
    expect(spans.map((s) => s.mark).sort()).toEqual(['bold', 'italic'])
  })

  it('treats code content as literal', () => {
    expect(scanInline('`a *b* c`').map((s) => s.mark)).toEqual(['code'])
  })
})

describe('colour', () => {
  const RED = '#cf222e'
  const BLUE = '#0969da'
  const red = (t: string) => `<span style="color:${RED}">${t}</span>`

  it('wraps a selection, and the word under a bare caret', () => {
    const s = st('«Friday» is the deadline')
    expect(text(s, setColor(s, RED))).toBe(`${red('Friday')} is the deadline`)
    const c = st('due Fri‸day now')
    expect(text(c, setColor(c, RED))).toBe(`due ${red('Friday')} now`)
  })

  /*
   * The same round trip `toggleInline` has to make, and for the same reason —
   * an off-by-one in the shift eats the selection two characters at a time —
   * but with an opening tag long enough that a wrong shift is not subtle.
   */
  it('gives back exactly the selection it coloured', () => {
    let s = st('«Friday» is the deadline')
    for (let i = 0; i < 4; i++) {
      expect(out(s, setColor(s, RED))).toBe(
        `<span style="color:${RED}">«Friday»</span> is the deadline`,
      )
      s = s.update(setColor(s, RED)).state
      expect(out(s, setColor(s, RED))).toBe('«Friday» is the deadline')
      s = s.update(setColor(s, RED)).state
    }
  })

  it('takes the colour off when the same one is picked again', () => {
    const s = st(`${red('Fri‸day')} is the deadline`)
    expect(text(s, setColor(s, RED))).toBe('Friday is the deadline')
    expect(text(s, setColor(s, RED.toUpperCase()))).toBe('Friday is the deadline')
  })

  it('and when Automatic is picked', () => {
    const s = st(`${red('Fri‸day')} soon`)
    expect(text(s, setColor(s, null))).toBe('Friday soon')
  })

  /*
   * Re-colouring rewrites the opening tag and nothing else. A second span
   * wrapped around the first would render the same today and read as two
   * colours the next time anything tried to answer "what colour is this".
   */
  it('re-colours rather than nesting a second span', () => {
    const s = st(`${red('Fri‸day')} soon`)
    expect(text(s, setColor(s, BLUE))).toBe(`<span style="color:${BLUE}">Friday</span> soon`)
  })

  it('leaves the caret on the same character when the tag changes length', () => {
    const s = st(`${red('Friday‸')} soon`)
    expect(out(s, setColor(s, BLUE))).toBe(`<span style="color:${BLUE}">Friday‸</span> soon`)
  })

  it('has nothing to do on uncoloured text', () => {
    const s = st('plain‸ words')
    expect(text(s, setColor(s, null))).toBe('plain words')
  })

  it('reads as a span the scanner and the toolbar both know about', () => {
    expect(scanInline(red('Friday')).map((s) => s.mark)).toEqual(['color'])
    const s = st(`${red('Fri‸day')} soon`)
    expect(colorAt(s, s.selection.main.from, s.selection.main.to)).toBe(RED)
    expect(inspect(s).color).toBe(RED)
    expect(inspect(st('plain‸')).color).toBe(null)
  })

  /*
   * The inner text is located by measuring back from `</span>`, not by
   * searching the match for it — a colour whose own digits appear in the text
   * would otherwise land the span on the attribute.
   */
  it('locates text that looks like its own markup', () => {
    const span = scanInline(`<span style="color:${RED}">cf222e</span>`)[0]
    expect(span.innerFrom).toBe(`<span style="color:${RED}">`.length)
    expect(span.arg).toBe(RED)
  })

  it('finds marks nested inside a colour, and a colour inside a mark', () => {
    expect(scanInline(red('**bold**')).map((s) => s.mark).sort()).toEqual(['bold', 'color'])
    expect(
      scanInline(`**${red('bold')}**`)
        .map((s) => s.mark)
        .sort(),
    ).toEqual(['bold', 'color'])
  })

  it('ignores a hex that is not one', () => {
    expect(scanInline('<span style="color:#12345">nope</span>')).toEqual([])
    expect(scanInline('<span style="color:red">nope</span>')).toEqual([])
  })
})

describe('expandToMarkup', () => {
  const range = (fixture: string) => {
    const s = st(fixture)
    const { from, to } = s.selection.main
    const g = expandToMarkup(s, from, to)
    const doc = s.doc.toString()
    return `${doc.slice(0, g.from)}«${doc.slice(g.from, g.to)}»${doc.slice(g.to)}`
  }

  it('takes in the delimiters a selection sits exactly inside', () => {
    expect(range('a ==«word»== b')).toBe('a «==word==» b')
    expect(range('a **«word»** b')).toBe('a «**word**» b')
  })

  it('unwraps nested marks one layer at a time', () => {
    expect(range('**==«word»==**')).toBe('«**==word==**»')
  })

  /* Copying a coloured word has to take the colour with it, like a highlight. */
  it('takes in the tags around a colour', () => {
    expect(range('<span style="color:#cf222e">«Friday»</span>')).toBe(
      '«<span style="color:#cf222e">Friday</span>»',
    )
  })

  it('leaves a selection that covers only part of a span', () => {
    expect(range('a ==w«or»d== b')).toBe('a ==w«or»d== b')
    expect(range('a «==word==» b')).toBe('a «==word==» b')
    expect(range('«a ==word== b»')).toBe('«a ==word== b»')
  })

  /*
   * The line's own markers, for the same reason: Home-then-Shift-End on a
   * heading can only ever select the words, so the copy came out plain and a
   * cut left the `## ` behind on a line of its own.
   */
  it('takes in the markers at the head of the line', () => {
    expect(range('## «Heading line»')).toBe('«## Heading line»')
    expect(range('- [ ] «a task»')).toBe('«- [ ] a task»')
    expect(range('> «quoted»')).toBe('«> quoted»')
    expect(range('## «Heading line\nand the line below»')).toBe(
      '«## Heading line\nand the line below»',
    )
  })

  it('and both at once, when the whole line is one highlight', () => {
    expect(range('## ==«Heading line»==')).toBe('«## ==Heading line==»')
  })

  it('leaves a selection that starts inside the line alone', () => {
    expect(range('## Heading «line»')).toBe('## Heading «line»')
    expect(range('## «Heading» line')).toBe('## «Heading» line')
  })
})

describe('inspect', () => {
  it('reports what is active at the caret', () => {
    const s = st('## Plans‸')
    expect(inspect(s)).toMatchObject({ block: 'heading', list: null, quote: false })

    const l = st('- [ ] buy **mi‸lk**')
    const snap = inspect(l)
    expect(snap.list).toBe('check')
    expect(snap.marks.bold).toBe(true)
    expect(snap.marks.italic).toBe(false)
    expect(snap.canIndent).toBe(true)
    expect(snap.canOutdent).toBe(false)
  })

  it('reports body for plain prose', () => {
    expect(inspect(st('just writing‸')).block).toBe('body')
  })
})
