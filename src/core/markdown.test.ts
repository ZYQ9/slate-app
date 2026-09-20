import { describe, expect, it } from 'vitest'
import {
  calendarDateFor,
  excerptOf,
  findDue,
  isLocked,
  isTaskLine,
  parseDue,
  parseFrontmatter,
  scanTags,
  resolveVars,
  scanTasks,
  scanVars,
  scanWikiLinks,
  setFrontmatterKey,
  setFrontmatterList,
  splitSizeFragment,
  stripInline,
  varText,
  withDue,
} from './markdown'
import { safeSegment, startOfDay } from './util'

describe('frontmatter', () => {
  it('parses scalars, inline lists and block lists', () => {
    const fm = parseFrontmatter(
      ['---', 'title: Trip', 'pinned: true', 'tags: [travel, lisbon]', 'people:', '  - Ana', '  - Bo', '---', '', 'Body'].join('\n'),
    )
    expect(fm.data.title).toBe('Trip')
    expect(fm.data.pinned).toBe(true)
    expect(fm.data.tags).toEqual(['travel', 'lisbon'])
    expect(fm.data.people).toEqual(['Ana', 'Bo'])
    expect(fm.bodyStart).toBeGreaterThan(0)
  })

  it('ignores a --- that is not at the very start', () => {
    const fm = parseFrontmatter('Some text\n---\ntitle: no\n---\n')
    expect(fm.data.title).toBeUndefined()
    expect(fm.bodyStart).toBe(0)
  })

  it('round-trips a key without disturbing the body', () => {
    const doc = '---\ntitle: A\n---\n\nBody text\n'
    const out = setFrontmatterKey(doc, 'pinned', 'true')
    expect(out).toContain('pinned: true')
    expect(out).toContain('title: A')
    expect(out.endsWith('Body text\n')).toBe(true)
  })

  it('adds a block when the note has none', () => {
    const out = setFrontmatterKey('Just a body', 'pinned', 'true')
    expect(out.startsWith('---\npinned: true\n---')).toBe(true)
    expect(out).toContain('Just a body')
  })
})

/*
 * The block form is not a style preference. The flow reader splits on commas,
 * so `include: ["[[Plan, revised]]"]` comes back as two broken halves — and a
 * note name with a comma in it is an ordinary note name. Every case below is
 * really asking the same question: does a value survive a round trip intact?
 */
describe('a frontmatter key holding a list', () => {
  const read = (text: string, key: string) => parseFrontmatter(text).data[key]

  it('round-trips values with commas in them', () => {
    const out = setFrontmatterList('---\ntype: conversation\n---\n\nBody\n', 'include', [
      '[[Plan, revised]]',
      '[[Team charter]]',
    ])
    expect(read(out, 'include')).toEqual(['[[Plan, revised]]', '[[Team charter]]'])
    expect(read(out, 'type')).toBe('conversation')
    expect(out.endsWith('Body\n')).toBe(true)
  })

  it('replaces the old items rather than adding to them', () => {
    const first = setFrontmatterList('---\ntitle: A\n---\n\nBody\n', 'include', ['[[One]]', '[[Two]]'])
    const second = setFrontmatterList(first, 'include', ['[[Three]]'])
    expect(read(second, 'include')).toEqual(['[[Three]]'])
    expect(read(second, 'title')).toBe('A')
  })

  /*
   * The failure this guards: leaving `- "[[One]]"` behind after the key above
   * it is gone. The orphaned items do not vanish — they reattach to whichever
   * key now sits above them and quietly join a different list.
   */
  it('takes the whole list away with the key, leaving nothing orphaned', () => {
    const withList = setFrontmatterList('---\ntitle: A\nsource: all\n---\n\nBody\n', 'include', [
      '[[One]]',
      '[[Two]]',
    ])
    const empty = setFrontmatterList(withList, 'include', [])
    expect(empty).not.toContain('include')
    expect(empty).not.toContain('One')
    expect(read(empty, 'source')).toBe('all')
    expect(read(empty, 'title')).toBe('A')
  })

  it('replaces a hand-written flow list too', () => {
    const out = setFrontmatterList('---\ninclude: [A, B]\ntitle: T\n---\n\nBody\n', 'include', ['[[C]]'])
    expect(read(out, 'include')).toEqual(['[[C]]'])
    expect(read(out, 'title')).toBe('T')
  })

  it('adds a block when the note has none, and adds nothing for an empty list', () => {
    expect(setFrontmatterList('Just a body', 'include', ['[[A]]'])).toBe(
      '---\ninclude:\n  - "[[A]]"\n---\n\nJust a body',
    )
    expect(setFrontmatterList('Just a body', 'include', [])).toBe('Just a body')
  })

  it('drops the frontmatter entirely rather than leaving an empty block', () => {
    const only = '---\ninclude:\n  - "[[A]]"\n---\n\nBody\n'
    expect(setFrontmatterList(only, 'include', [])).toBe('\nBody\n')
  })

  /* Wikilinks in frontmatter are what makes a pin survive a rename. */
  it('writes links the rename pass can see', () => {
    const out = setFrontmatterList('---\ntype: conversation\n---\n\nBody\n', 'include', ['[[Migration plan]]'])
    expect(scanWikiLinks(out).map((l) => l.target)).toEqual(['Migration plan'])
  })
})

describe('wikilinks', () => {
  it('finds plain links, aliases, anchors and embeds', () => {
    const links = scanWikiLinks('See [[Meeting Notes]] and [[Trip#Hotels|hotels]] plus ![[shot.png]]')
    expect(links).toHaveLength(3)
    expect(links[0].target).toBe('Meeting Notes')
    expect(links[1].target).toBe('Trip')
    expect(links[1].anchor).toBe('Hotels')
    expect(links[1].alias).toBe('hotels')
    expect(links[2].embed).toBe(true)
  })

  it('ignores links inside fenced and inline code', () => {
    const doc = ['Real [[One]]', '', '```', 'not [[Two]]', '```', '', 'also `[[Three]]` inline'].join('\n')
    const targets = scanWikiLinks(doc).map((l) => l.target)
    expect(targets).toEqual(['One'])
  })
})

describe('tags', () => {
  it('finds tags but not headings or code', () => {
    const doc = ['# Heading', 'Body with #travel and #work/active', '`#nope`', '', '```', '#alsonope', '```'].join('\n')
    const tags = scanTags(doc)
    expect(tags).toContain('travel')
    expect(tags).toContain('work/active')
    expect(tags).not.toContain('nope')
    expect(tags).not.toContain('alsonope')
    expect(tags).not.toContain('Heading')
  })
})

describe('$(property) references', () => {
  it('finds them with the positions the editor swaps', () => {
    const line = 'Dear $(first_name), about $(project.name):'
    expect(scanVars(line)).toEqual([
      { from: 5, to: 18, key: 'first_name' },
      { from: 26, to: 41, key: 'project.name' },
    ])
    expect(line.slice(5, 18)).toBe('$(first_name)')
    expect(line.slice(26, 41)).toBe('$(project.name)')
  })

  it('offsets into the document, so a line is scanned where it sits', () => {
    expect(scanVars('a $(x) b', 100)[0]).toEqual({ from: 102, to: 106, key: 'x' })
  })

  it('is not fooled by things that merely look like one', () => {
    // An unclosed token, a name with no characters a property could have, and
    // the money that shares its first character.
    expect(scanVars('$(unclosed and $() and $(a b) and costs $(5) or $5.00')).toEqual([
      { from: 40, to: 44, key: '5' },
    ])
  })

  it('fills a line in for the note list, leaving the unanswerable alone', () => {
    const data = { client: 'Acme Corp', rate: '' }
    expect(resolveVars('Prepared for $(client), at $(rate) — run $(pwd).', data)).toBe(
      'Prepared for Acme Corp, at $(rate) — run $(pwd).',
    )
  })

  it('is what the note list shows, so a row reads like the page it stands for', () => {
    const note = ['---', 'client: Acme Corp', '---', '', '# Job', '', 'Prepared for $(client).'].join('\n')
    const fm = parseFrontmatter(note)
    expect(excerptOf(note, fm.bodyStart, fm.data)).toBe('Prepared for Acme Corp.')
    // Without the properties there is nothing to resolve against, and the
    // line is left as written rather than guessed at.
    expect(excerptOf(note, fm.bodyStart)).toBe('Prepared for $(client).')
  })

  it('leaves what is in backticks as it was typed, so the syntax can be written about', () => {
    const data = { client: 'Acme Corp' }
    expect(resolveVars('Write `$(client)` and get $(client).', data)).toBe(
      'Write `$(client)` and get Acme Corp.',
    )
    // Three backticks are a fence, not a span: a block is a thing you copy out
    // with the values in it.
    expect(resolveVars('```sh\nssh $(client)\n```', data)).toBe('```sh\nssh Acme Corp\n```')
  })

  it('reads a value the way it would be written in a sentence', () => {
    expect(varText('Mike')).toBe('Mike')
    expect(varText(6)).toBe('6')
    expect(varText(false)).toBe('false')
    expect(varText(['travel', 'lisbon'])).toBe('travel, lisbon')
  })

  it('has nothing to show for a property nobody has filled in', () => {
    expect(varText('')).toBeUndefined()
    expect(varText('   ')).toBeUndefined()
    expect(varText([])).toBeUndefined()
    expect(varText(undefined)).toBeUndefined()
  })
})

describe('the read-only property', () => {
  it('is the checkbox the properties form writes, and the words people type', () => {
    for (const raw of ['true', 'yes', 'on', '1', 'Yes', 'TRUE']) {
      expect(isLocked({ 'read-only': raw })).toBe(true)
    }
    expect(isLocked({ 'read-only': true })).toBe(true)
    expect(isLocked({ readonly: 'yes' })).toBe(true)
    expect(isLocked({ read_only: true })).toBe(true)
  })

  it('locks nothing until it says so', () => {
    expect(isLocked({})).toBe(false)
    expect(isLocked({ 'read-only': false })).toBe(false)
    expect(isLocked({ 'read-only': 'no' })).toBe(false)
    expect(isLocked({ 'read-only': '' })).toBe(false)
    // A note that merely mentions it in another property is not locked.
    expect(isLocked({ note: 'read-only', tags: ['read-only'] })).toBe(false)
  })
})

describe('tasks', () => {
  it('finds checked and unchecked items with due dates', () => {
    const doc = [
      '- [ ] Book flights 📅 2026-09-04',
      '- [x] Renew passport',
      '  - [ ] Nested @due(2026-10-01)',
      '1. [ ] Numbered item',
      '- not a task',
    ].join('\n')
    const tasks = scanTasks(doc)
    expect(tasks).toHaveLength(4)
    expect(tasks[0].done).toBe(false)
    expect(tasks[0].due).toBe(startOfDay(new Date(2026, 8, 4)))
    expect(tasks[1].done).toBe(true)
    expect(tasks[2].due).toBe(startOfDay(new Date(2026, 9, 1)))
    expect(tasks[3].text).toBe('Numbered item')
  })

  it('leaves an empty checkbox out, wherever the blank came from', () => {
    /*
     * The daily note's template opens with `- [ ] ` and keeps two more of them
     * under Habits and Tomorrow. They are blanks to type into; until somebody
     * does, they are nobody's work.
     */
    const doc = [
      '## Today',
      '',
      '- [ ] ',
      '- [ ]',
      '- [x]   ',
      '  - [ ]\t',
      '- [ ] Actually do something',
      '- [ ] 📅 2026-09-04',
    ].join('\n')
    const tasks = scanTasks(doc)
    expect(tasks.map((t) => t.text)).toEqual(['Actually do something', '📅 2026-09-04'])
    // The blanks are skipped, not removed: what is left still points at the
    // line it lives on, which is what toggling and navigation work from.
    expect(tasks[0].line).toBe(6)
    expect(tasks[1].line).toBe(7)
  })

  it('parses every supported due-date syntax', () => {
    expect(parseDue('do it 📅 2026-01-05')).toBeDefined()
    expect(parseDue('do it @due(2026-01-05)')).toBeDefined()
    expect(parseDue('do it due:2026-01-05')).toBeDefined()
    expect(parseDue('no date here')).toBeUndefined()
  })

  it('reads dates as local midnight, not UTC', () => {
    const t = parseDue('📅 2026-03-01')!
    expect(new Date(t).getDate()).toBe(1)
    expect(new Date(t).getMonth()).toBe(2)
  })

  it('reads the Dataview form too', () => {
    expect(parseDue('do it [due:: 2026-01-05]')).toBe(startOfDay(new Date(2026, 0, 5)))
  })

  it('reports where the marker sits, so the editor can replace just that', () => {
    const line = '- [ ] Book flights 📅 2026-09-04'
    const m = findDue(line)!
    expect(line.slice(m.from, m.to)).toBe('📅 2026-09-04')
    expect(m.date).toBe(startOfDay(new Date(2026, 8, 4)))
  })

  it('recognizes task lines and nothing else', () => {
    expect(isTaskLine('- [ ] a')).toBe(true)
    expect(isTaskLine('  1. [x] a')).toBe(true)
    expect(isTaskLine('- a')).toBe(false)
    expect(isTaskLine('[ ] a')).toBe(false)
  })
})

describe('withDue', () => {
  const sep = startOfDay(new Date(2026, 8, 4))

  it('appends a date to a task that has none', () => {
    expect(withDue('- [ ] Book flights', sep)).toBe('- [ ] Book flights 📅 2026-09-04')
  })

  it('replaces a date rather than accumulating one', () => {
    expect(withDue('- [ ] Book flights 📅 2026-01-01', sep)).toBe(
      '- [ ] Book flights 📅 2026-09-04',
    )
  })

  it('replaces a date written in any of the other syntaxes', () => {
    expect(withDue('- [ ] Renew @due(2026-01-01)', sep)).toBe('- [ ] Renew 📅 2026-09-04')
    expect(withDue('- [ ] Renew due:2026-01-01', sep)).toBe('- [ ] Renew 📅 2026-09-04')
    expect(withDue('- [ ] Renew [due:: 2026-01-01]', sep)).toBe('- [ ] Renew 📅 2026-09-04')
  })

  it('clears a date, and the space it was sitting on', () => {
    expect(withDue('- [ ] Book flights 📅 2026-09-04', undefined)).toBe('- [ ] Book flights')
    expect(withDue('- [ ] Book flights', undefined)).toBe('- [ ] Book flights')
  })

  it('leaves the rest of the line — indent, marker, tags — alone', () => {
    expect(withDue('  - [x] Ship it #work', sep)).toBe('  - [x] Ship it #work 📅 2026-09-04')
  })

  it('collapses a second stray marker instead of leaving it behind', () => {
    expect(withDue('- [ ] Odd 📅 2026-01-01 @due(2026-02-02)', sep)).toBe(
      '- [ ] Odd 📅 2026-09-04',
    )
  })

  it('handles a task with no text at all', () => {
    expect(withDue('- [ ] ', sep)).toBe('- [ ] 📅 2026-09-04')
    expect(withDue('- [ ]', sep)).toBe('- [ ] 📅 2026-09-04')
  })

  it('round-trips: what it writes, parseDue reads back', () => {
    expect(parseDue(withDue('- [ ] Anything', sep))).toBe(sep)
  })
})

describe('stripInline', () => {
  it('drops every due syntax from display text', () => {
    expect(stripInline('Book flights 📅 2026-09-04')).toBe('Book flights')
    expect(stripInline('Book flights [due:: 2026-09-04]')).toBe('Book flights')
  })

  /*
   * The two styles written as HTML. A task row reading
   * `<span style="color:#cf222e">Friday` is the syntax showing through in the
   * one place the app promises it never does.
   */
  it('drops the markup around coloured and underlined text', () => {
    expect(stripInline('Freeze starts <span style="color:#cf222e">Friday</span>')).toBe(
      'Freeze starts Friday',
    )
    expect(stripInline('An <u>underlined</u> and ==highlighted== word')).toBe(
      'An underlined and highlighted word',
    )
  })
})

describe('excerpt', () => {
  it('skips headings and rules, and strips markup', () => {
    const doc = '# Title\n\n---\n\n**Bold** start with [[Link|alias]] here.'
    expect(excerptOf(doc)).toBe('Bold start with alias here.')
  })

  it('returns empty for a note with only a heading', () => {
    expect(excerptOf('# Only a title')).toBe('')
  })

  /* The tags go before the `>` strip, or the attributes become the excerpt. */
  it('reads coloured text as its words', () => {
    expect(excerptOf('# Plan\n\nThe freeze starts <span style="color:#cf222e">Friday</span>.')).toBe(
      'The freeze starts Friday.',
    )
  })

  /*
   * A note that opens with a callout — which is how several of the starter
   * templates open — otherwise reads out its own punctuation in the list:
   * "[!NOTE] In one line".
   */
  it('reads a callout for what it says, not for its marker', () => {
    expect(excerptOf('# Ana Ruiz\n\n> [!NOTE] In one line\n> How you would introduce them.')).toBe(
      'In one line',
    )
    // A callout with no title of its own falls through to its first words.
    expect(excerptOf('# Ana Ruiz\n\n> [!NOTE]\n> How you would introduce them.')).toBe(
      'How you would introduce them.',
    )
  })
})

describe('calendar date', () => {
  it('prefers frontmatter, then a dated filename, then ctime', () => {
    const ct = startOfDay(new Date(2026, 0, 15))
    expect(calendarDateFor('a.md', { date: '2026-05-02' }, ct)).toBe(startOfDay(new Date(2026, 4, 2)))
    expect(calendarDateFor('Daily/2026-06-09.md', {}, ct)).toBe(startOfDay(new Date(2026, 5, 9)))
    expect(calendarDateFor('a.md', {}, ct)).toBe(ct)
  })
})

describe('paths and sizing', () => {
  it('strips characters that break on Windows or WebDAV', () => {
    expect(safeSegment('Q1: profit/loss?')).not.toMatch(/[:/?]/)
    expect(safeSegment('  ')).toBe('Untitled')
    expect(safeSegment('trailing.')).toBe('trailing')
    expect(safeSegment('CON')).toBe('_CON')
  })

  it('splits a width fragment off an embed URL', () => {
    expect(splitSizeFragment('a/b.png#w=420')).toEqual(['a/b.png', 420])
    expect(splitSizeFragment('a/b.png')).toEqual(['a/b.png', undefined])
  })
})
