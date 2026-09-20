/**
 * The text-colour picker.
 *
 * Eight swatches and a way back to the default, which is the whole of it. A
 * colour is one of a fixed set here for the same reason the callouts are: the
 * palette has to stay legible on both backgrounds, and a free-form colour
 * well — with its wheel, its field, and its six-digit box — offers a thousand
 * ways to write a note you cannot read tonight. Anything outside the set is
 * still honoured when a note arrives carrying it; it just isn't offered.
 *
 * Like the due-date picker, it rides on the context menu rather than being a
 * dialog: a popover under the pointer on a desktop, a sheet up from the bottom
 * of a phone, with that component's scrim, dismissal and off-screen flipping
 * inherited rather than grown again.
 */

import { TEXT_COLORS } from '../editor/colors'
import { openMenuWith } from './Menu'

interface Props {
  /** The colour the selection is already in, as a hex, or null for default. */
  current: string | null
  onPick: (hex: string | null) => void
  close: () => void
}

function ColorPicker({ current, onPick, close }: Props) {
  const choose = (hex: string | null) => {
    onPick(hex)
    close()
  }

  return (
    <div class="color-pick">
      {/*
        Plain buttons rather than `role="radiogroup"`, the same choice the
        calendar grid makes: a radio group promises arrow-key roving focus, and
        promising it without implementing it leaves a screen-reader user worse
        off than the buttons alone. Each swatch carries its own colour name, so
        the grid needs no label of its own.
      */}
      <div class="color-grid">
        {TEXT_COLORS.map((c) => (
          <button
            key={c.id}
            class="color-swatch"
            style={{ color: `var(--mark-${c.id}, ${c.hex})` }}
            aria-pressed={current === c.hex}
            aria-label={c.label}
            title={c.label}
            onClick={() => choose(c.hex)}
          >
            A
          </button>
        ))}
      </div>

      {/*
        Always offered, not only when something is coloured. It is the row that
        says what the colours are an alternative *to*, and a picker whose last
        row appears and disappears is one you have to look twice at.
      */}
      <button
        class="menu-item color-clear"
        aria-current={current === null}
        onClick={() => choose(null)}
      >
        Automatic
      </button>
    </div>
  )
}

/**
 * Open the picker at a point on screen.
 *
 * `current` both marks the swatch already chosen and decides what picking it
 * again means: the colour comes off, the way pressing B in bold text un-bolds
 * it. See `setColor` in editor/format.ts.
 */
export function openColorMenu(
  at: { clientX: number; clientY: number },
  current: string | null,
  onPick: (hex: string | null) => void,
) {
  openMenuWith(at, (close) => <ColorPicker current={current} onPick={onPick} close={close} />, {
    title: 'Text colour',
    cls: 'menu-color',
  })
}
