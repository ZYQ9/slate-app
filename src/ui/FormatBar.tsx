/**
 * The formatting controls for Rich Text mode.
 *
 * One component, two presentations, the same as the context menu: a slim bar
 * under the editor head on a pointer device, and a bottom sheet on a phone,
 * where a toolbar of 14 small targets is unusable and the sheet is what the
 * platform's own notes app puts on screen.
 *
 * Every button reads its pressed state from `formatSnapshot`, which the editor
 * republishes on each selection change — so the bar always describes the text
 * the caret is actually in, rather than a mode the user has to remember.
 *
 * Both presentations are built from one list of groups, so a control is
 * described once and the bar and the sheet can never drift apart in what they
 * offer or what they call it.
 */

import { Fragment } from 'preact'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  type BlockStyle,
  applyBlockStyle,
  applyColor,
  applyIndent,
  applyInline,
  applyList,
  applyQuote,
  formatSnapshot,
} from '../editor/format'
import { cssColor, paletteColor } from '../editor/colors'
import { openColorMenu } from './ColorPicker'
import type { EditorView } from '@codemirror/view'
import { insertTable, tableContext } from '../editor/table'
import { editLinkAtCaret } from './linkActions'
import { openMenu, type MenuItem } from './Menu'
import { openTableMenu } from './tableMenu'
import { canTransform, openTransform } from './TransformDialog'
import {
  IconCode,
  IconHighlight,
  IconIndent,
  IconLink,
  IconListBullet,
  IconListCheck,
  IconListNumber,
  IconMore,
  IconSparkle,
  IconOutdent,
  IconQuote,
  IconTable,
  IconTextColor,
} from './Icons'

/** A point, for the things that open at one. */
type At = { clientX: number; clientY: number }

interface BarItem {
  id: string
  /** What the overflow menu calls it — the hint without its shortcut. */
  label: string
  /** Tooltip and accessible name, shortcut included. */
  hint: string
  /** What the bar shows. The style pills show their own text. */
  glyph: preact.ComponentChildren
  /** Set for the paragraph pills, which are text rather than icon buttons. */
  pill?: BlockStyle
  pressed?: boolean
  disabled?: boolean
  /**
   * True for the ones that open a dialog or a menu rather than acting at once.
   * Those have to run on the click; see `wire` below.
   */
  opens?: boolean
  run: (at: At) => void
}

interface BarGroup {
  id: string
  aria: string
  items: BarItem[]
}

export interface FormatBarProps {
  /** Read at click time: the view is rebuilt whenever the open note changes. */
  getView: () => EditorView | null
  variant: 'bar' | 'sheet'
}

export function FormatBar({ getView, variant }: FormatBarProps) {
  const f = formatSnapshot.value
  /*
   * Where the table buttons would act: the cell being worked in, and only
   * otherwise the caret's table.
   *
   * The cell comes first for the same reason the commands themselves prefer it.
   * Rich text never shows a table's source, so once an operation has run the
   * caret is sitting wherever that rewrite parked it — inside the table, which
   * would have this describing the header while the buttons act on row four.
   */
  const table = tableContext.value ?? f.table

  /**
   * Run a command against the live view.
   *
   * The bar takes focus back afterwards; the sheet deliberately does not,
   * because it runs with the editor blurred so the phone keyboard stays down
   * and focusing here would bring it straight back up.
   */
  const run = (cmd: (view: EditorView) => unknown) => () => {
    const view = getView()
    if (!view) return
    cmd(view)
    if (variant === 'bar') view.focus()
  }

  /**
   * Table controls.
   *
   * Outside a table the button inserts one. Inside, it opens the operations as
   * a menu — which is a popover with a pointer and a bottom sheet on a phone,
   * so "add a column" is the same two taps on either, and the bar does not have
   * to find room for seven more targets it only sometimes needs.
   *
   * The menu itself is shared with the handles on the table (see tableMenu.ts),
   * which open the same operations narrowed to one row or column.
   */
  /**
   * What the colour button is called in the overflow menu, colour included.
   *
   * The name rather than the hex wherever there is one: "Text colour — Blue"
   * is what a person picked, and `#0969da` is what the file happens to say.
   *
   * Only the menu row says it. The button's own accessible name stays "Text
   * colour" whatever is applied, because that is what the control *is* — a
   * name that changed with the selection would read as a different button
   * every time the caret moved, and the colour in use is already announced by
   * the pressed swatch once the palette is open.
   */
  const colorLabel = f.color
    ? `Text colour — ${paletteColor(f.color)?.label ?? f.color}`
    : 'Text colour'

  const tableMenu = (at: At) => {
    const view = getView()
    if (!view) return
    /*
     * The sheet runs with the keyboard down, and every one of these edits
     * rebuilds the table's DOM. Focusing a cell in the new one would bring the
     * keyboard back up over the sheet, so on a phone the cell is marked instead
     * and the next operation still lands on it.
     */
    if (!table) {
      insertTable(view, { refocus: variant === 'bar' })
      return
    }
    openTableMenu(at, getView, table)
  }

  const groups: BarGroup[] = [
    {
      id: 'styles',
      aria: 'Paragraph style',
      items: (
        [
          ['title', 'Title', 'Title (⌘⌥1)'],
          ['heading', 'Heading', 'Heading (⌘⌥2)'],
          ['subheading', 'Subheading', 'Subheading (⌘⌥3)'],
          ['body', 'Body', 'Body (⌘⌥0)'],
        ] as Array<[BlockStyle, string, string]>
      ).map(([id, label, hint]) => ({
        id,
        label,
        hint,
        glyph: label,
        pill: id,
        pressed: f.block === id,
        run: run(applyBlockStyle(id)),
      })),
    },
    {
      id: 'marks',
      aria: 'Text style',
      items: [
        ...[
          { id: 'bold', label: 'Bold', hint: 'Bold (⌘B)', glyph: <b>B</b> },
          { id: 'italic', label: 'Italic', hint: 'Italic (⌘I)', glyph: <i>I</i> },
          { id: 'underline', label: 'Underline', hint: 'Underline (⌘U)', glyph: <u>U</u> },
          { id: 'strike', label: 'Strikethrough', hint: 'Strikethrough (⌘⇧X)', glyph: <s>S</s> },
          {
            id: 'highlight',
            label: 'Highlight',
            hint: 'Highlight (⌘⇧H)',
            glyph: <IconHighlight size={17} />,
          },
          {
            id: 'code',
            label: 'Monospaced',
            hint: 'Monospaced (⌘E)',
            glyph: <IconCode size={17} />,
          },
        ].map((m) => ({
          ...m,
          pressed: f.marks[m.id as keyof typeof f.marks],
          run: run(applyInline(m.id as Parameters<typeof applyInline>[0])),
        })),
        /*
         * Colour is the one text style that is not a toggle, so it opens the
         * palette rather than applying something — and the button wears the
         * colour it would come back to, since a control that hides its value
         * behind a menu can say nothing about it otherwise.
         */
        {
          id: 'color',
          label: colorLabel,
          hint: 'Text colour',
          glyph: <IconTextColor size={18} bar={f.color ? cssColor(f.color) : undefined} />,
          pressed: !!f.color,
          opens: true,
          run: (at: At) =>
            openColorMenu(at, f.color, (hex) => run(applyColor(hex))()),
        },
      ],
    },
    /*
     * Lists, indentation and the quote are three groups rather than the one
     * row they read as. They are already drawn with separators between them,
     * so the bar looks no different — but the bar overflows a group at a time,
     * and as a single group of six they went to the menu together and left a
     * third of the bar empty. The sheet merges them back into one row.
     */
    {
      id: 'lists',
      aria: 'Lists',
      items: [
        {
          id: 'bullet',
          label: 'Bulleted list',
          hint: 'Bulleted list (⌘⇧8)',
          glyph: <IconListBullet size={18} />,
          pressed: f.list === 'bullet',
          run: run(applyList('bullet')),
        },
        {
          id: 'number',
          label: 'Numbered list',
          hint: 'Numbered list (⌘⇧0)',
          glyph: <IconListNumber size={18} />,
          pressed: f.list === 'number',
          run: run(applyList('number')),
        },
        {
          id: 'check',
          label: 'Checklist',
          hint: 'Checklist (⌘⇧7)',
          glyph: <IconListCheck size={18} />,
          pressed: f.list === 'check',
          run: run(applyList('check')),
        },
      ],
    },
    {
      id: 'indent',
      aria: 'Indentation',
      items: [
        {
          id: 'outdent',
          label: 'Decrease indent',
          hint: 'Decrease indent (⌘[)',
          glyph: <IconOutdent size={18} />,
          disabled: !f.canOutdent,
          run: run(applyIndent(-1)),
        },
        {
          id: 'indent',
          label: 'Increase indent',
          hint: 'Increase indent (⌘])',
          glyph: <IconIndent size={18} />,
          disabled: !f.canIndent,
          run: run(applyIndent(1)),
        },
      ],
    },
    {
      id: 'quote',
      aria: 'Block quote',
      items: [
        {
          id: 'quote',
          label: 'Block quote',
          hint: 'Block quote (⌘⇧9)',
          glyph: <IconQuote size={18} />,
          pressed: f.quote,
          run: run(applyQuote),
        },
      ],
    },
    /*
     * Link and table sit together: both are things you *insert* rather than
     * styling you toggle, and both open something rather than acting at once.
     * They keep the editor's selection the same way every other button does.
     */
    {
      id: 'insert',
      aria: 'Insert',
      items: [
        {
          id: 'link',
          label: f.link ? 'Edit link' : 'Add link',
          hint: 'Link (⌘⇧L)',
          glyph: <IconLink size={18} />,
          pressed: f.link,
          opens: true,
          run: () => editLinkAtCaret(getView()),
        },
        {
          id: 'table',
          label: table ? 'Table rows and columns' : 'Insert table',
          hint: table ? 'Table rows and columns' : 'Insert table',
          glyph: <IconTable size={18} />,
          pressed: !!table,
          opens: true,
          run: tableMenu,
        },
      ],
    },
  ]

  /*
   * The model, where the model applies: on a selection.
   *
   * Here rather than only in the command palette, which is where it started and
   * where nobody found it. The bar is already the thing that acts on selected
   * text, so a control that rewrites selected text belongs beside the ones that
   * embolden it — and being a group like any other, it collapses into the ⋯
   * overflow when the pane is narrow and appears in the phone's Format sheet
   * without another line of code.
   *
   * Absent rather than disabled when no provider is configured, the same as
   * every other AI affordance; greyed out when there is nothing selected, since
   * that is a thing you fix by selecting something rather than by going to
   * Settings.
   */
  if (canTransform()) {
    groups.push({
      id: 'ai',
      aria: 'Change with a model',
      items: [
        {
          id: 'transform',
          label: 'Change this passage…',
          hint: f.hasSelection
            ? 'Change this passage (⌘⇧U)'
            : 'Select some text to change it (⌘⇧U)',
          glyph: <IconSparkle size={18} />,
          disabled: !f.hasSelection,
          opens: true,
          run: () => openTransform(),
        },
      ],
    })
  }

  /**
   * Wire a button to its command without stealing the selection.
   *
   * Pressing a button is what moves focus out of the editor, and an editor
   * without focus has no selection to format — so the press default is
   * suppressed and the command runs from the down event instead. Preventing
   * `touchstart` also stops the browser synthesising the mouse events after it,
   * which is what keeps a single tap from running the command twice.
   *
   * The ones that *open* something are the exception, and have to run on the
   * click. These overlays put a scrim over the screen the moment they open, and
   * a scrim that appears between a mousedown and its click swallows that click
   * and closes itself again. The press is still cancelled, so the editor keeps
   * its selection and a table cell keeps its focus while the menu decides what
   * it is acting on.
   */
  const wire = (it: Pick<BarItem, 'opens' | 'run'>) =>
    it.opens
      ? {
          onMouseDown: (e: MouseEvent) => e.preventDefault(),
          onClick: (e: MouseEvent) => it.run(e),
          onTouchStart: (e: TouchEvent) => {
            // Cancelling touchstart also cancels the click the browser would
            // synthesise from it, so this is the only handler that runs on touch.
            e.preventDefault()
            const t = e.touches[0]
            it.run({ clientX: t?.clientX ?? 0, clientY: t?.clientY ?? 0 })
          },
        }
      : {
          onMouseDown: (e: Event) => {
            e.preventDefault()
            it.run(ORIGIN)
          },
          onTouchStart: (e: Event) => {
            e.preventDefault()
            it.run(ORIGIN)
          },
        }

  const button = (it: BarItem) => (
    <button
      key={it.id}
      data-id={it.id}
      class={it.pill ? `fmt-style fmt-style-${it.pill}` : 'fmt-btn'}
      title={it.hint}
      aria-label={it.hint}
      aria-pressed={it.pressed}
      disabled={it.disabled}
      {...wire(it)}
    >
      {it.glyph}
    </button>
  )

  const groupBody = (g: BarGroup) => g.items.map(button)

  const byId = (id: string) => groups.find((g) => g.id === id)!

  /**
   * Several groups drawn as one row, separators between them.
   *
   * The sheet uses this to put lists, indentation and the quote back in the
   * single row they have always been on a phone — where nothing overflows, so
   * the finer grouping the bar needs would only cost a row of the note.
   */
  const mergedRow = (ids: string[], aria: string) => (
    <div class="fmt-row" role="group" aria-label={aria}>
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && <span class="fmt-sep" />}
          {groupBody(byId(id))}
        </Fragment>
      ))}
    </div>
  )

  const groupRow = (g: BarGroup, extra = '') => (
    <div key={g.id} class={`fmt-row${extra}`} role="group" aria-label={g.aria}>
      {groupBody(g)}
    </div>
  )

  if (variant === 'sheet') {
    /*
     * No title bar: the sheet is three rows of controls that explain
     * themselves, and on a phone every row it does not have is a row of the
     * note you can still see. It is a flex child of the pane rather than an
     * overlay, so the editor above it shrinks and the caret stays visible.
     *
     * Nothing here overflows: the sheet is as wide as the phone and lays its
     * groups out over three rows, which is the whole reason the bar needs an
     * overflow menu and this does not.
     */
    return (
      <div class="fmt-sheet" role="group" aria-label="Format">
        {groupRow(byId('styles'), ' fmt-styles')}
        {groupRow(byId('marks'))}
        <div class="fmt-row fmt-row-split">
          {mergedRow(['lists', 'indent', 'quote'], 'Lists and indentation')}
          {/*
            * The sheet lists its groups by name rather than walking `groups`,
            * so anything added to the bar has to be named here too or the phone
            * quietly never gets it. The model button rides with Insert: both
            * open something rather than toggling it, and the sheet's three rows
            * are worth more than a fourth for one control.
            */}
          {groups.some((g) => g.id === 'ai')
            ? mergedRow(['insert', 'ai'], 'Insert and change')
            : groupRow(byId('insert'))}
        </div>
      </div>
    )
  }

  return <Bar groups={groups} groupBody={groupBody} />
}

/** A press that isn't aimed anywhere: the commands that act at once ignore it. */
const ORIGIN: At = { clientX: 0, clientY: 0 }

/**
 * The bar, and the "…" that appears when it runs out of room.
 *
 * The editor pane is the one that never yields width, so when the calendar is
 * inline and the sidebar and list are open there can be less than half the
 * bar's natural width to put it in — and it was simply clipped at the pane's
 * edge, against the calendar. It scrolls sideways, but with the scrollbar
 * hidden nothing said so, which made Link and Table look like features that
 * did not exist rather than controls just out of view.
 *
 * Groups overflow whole rather than button by button. It costs a little
 * packing efficiency — a group moves to the menu while its width would nearly
 * have fitted — and buys the two things that matter: the `role="group"`
 * labelling and the separators stay intact, and the bar never strands one
 * orphaned button from a group whose siblings are all in the menu.
 */
function Bar({
  groups,
  groupBody,
}: {
  groups: BarGroup[]
  groupBody: (g: BarGroup) => preact.ComponentChildren
}) {
  const ref = useRef<HTMLDivElement>(null)
  /** Index of the first group that did not fit; groups.length means all fit. */
  const [cut, setCut] = useState(groups.length)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const more = el.querySelector<HTMLElement>('[data-fmt-more]')
      const parts = Array.from(el.querySelectorAll<HTMLElement>('[data-fmt-part]'))
      if (!parts.length) return

      /*
       * Natural widths first, which means un-hiding everything before reading
       * anything: a group left hidden from the last pass measures zero and the
       * bar would then never grow back when the pane widens. Every part is
       * `flex: 0 0 auto`, so these widths are the same whether or not the bar
       * is currently too narrow to hold them.
       */
      for (const p of parts) p.removeAttribute('data-overflow')
      more?.removeAttribute('data-overflow')

      const css = getComputedStyle(el)
      const gap = parseFloat(css.columnGap) || 0
      const room =
        el.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0)
      /*
       * Margins included. `offsetWidth` leaves them out, and each separator
       * carries 5px of it either side — three of them was 30px the bar thought
       * it had and did not, which is exactly enough to still clip the last
       * group it decided would fit.
       */
      const widths = parts.map((p) => {
        const m = getComputedStyle(p)
        return p.offsetWidth + (parseFloat(m.marginLeft) || 0) + (parseFloat(m.marginRight) || 0)
      })
      const total = widths.reduce((a, w) => a + w, 0) + gap * (parts.length - 1)

      let next = groups.length
      if (total > room) {
        // Room for the "…" has to come out of the budget before deciding what
        // fits, or the last group in would be pushed straight back out by it.
        const budget = room - (more?.offsetWidth ?? 0) - gap
        let used = 0
        next = 0
        for (let i = 0; i < parts.length; i++) {
          const w = widths[i] + (i ? gap : 0)
          if (used + w > budget) break
          used += w
          // Separators are interleaved before every group but the first, so a
          // part index maps to a group only on the group's own element.
          if (parts[i].dataset.fmtPart === 'group') next++
        }
        /*
         * Applied here as well as through the state below. The state is what
         * fills the menu, but a Preact re-render lands a tick later and the
         * un-hiding above would flash the full-width bar until it did.
         */
        let group = 0
        for (const p of parts) {
          const isGroup = p.dataset.fmtPart === 'group'
          // A separator belongs to the group it precedes.
          if ((isGroup ? group : group + 1) >= next) p.setAttribute('data-overflow', '1')
          if (isGroup) group++
        }
      } else {
        more?.setAttribute('data-overflow', '1')
      }
      setCut(next)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    /*
     * Set up once, not on every render. The bar re-renders on every keystroke
     * — `formatSnapshot` republishes on each document and selection change —
     * and building a ResizeObserver per keystroke to answer a question only
     * the pane's width can change is pure waste. Nothing this measures depends
     * on the render that triggered it: `measure` reads the DOM, and pressed and
     * disabled states move no button by a pixel. `groups.length` is a constant
     * and is listed only so the default is not read from a stale closure.
     */
  }, [groups.length])

  const hidden = groups.slice(cut)

  const openOverflow = () => {
    const box = ref.current?.querySelector('[data-fmt-more]')?.getBoundingClientRect()
    const at = { clientX: box ? box.left : 0, clientY: box ? box.bottom + 4 : 0 }
    const items: MenuItem[] = []
    for (const g of hidden) {
      for (const [i, it] of g.items.entries()) {
        items.push({
          label: it.label,
          icon: it.glyph,
          disabled: it.disabled,
          checked: it.pressed,
          // A group boundary is worth a rule; the ones a group draws inside
          // itself are not, in a list where every row is already on its own.
          separated: i === 0 && items.length > 0,
          onSelect: () => it.run(at),
        })
      }
    }
    openMenu(at, items, 'More formatting')
  }

  return (
    <div class="fmt-bar" role="toolbar" aria-label="Formatting" ref={ref}>
      {groups.map((g, i) => (
        <Fragment key={g.id}>
          {i > 0 && (
            <span
              class="fmt-sep"
              data-fmt-part="sep"
              data-overflow={i >= cut ? '1' : undefined}
            />
          )}
          <div
            class={`fmt-row${g.id === 'styles' ? ' fmt-styles' : ''}`}
            role="group"
            aria-label={g.aria}
            data-fmt-part="group"
            data-overflow={i >= cut ? '1' : undefined}
          >
            {groupBody(g)}
          </div>
        </Fragment>
      ))}
      <button
        class="fmt-btn fmt-more"
        data-fmt-more="1"
        data-overflow={cut >= groups.length ? '1' : undefined}
        title="More formatting"
        aria-label="More formatting"
        aria-haspopup="menu"
        onMouseDown={(e: MouseEvent) => e.preventDefault()}
        onClick={openOverflow}
      >
        <IconMore size={18} />
      </button>
    </div>
  )
}
