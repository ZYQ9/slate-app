/** Inline icons. Stroke-based, 1.6px, so they read at 16px in both themes. */

import type { JSX } from 'preact'

type P = { size?: number; class?: string } & JSX.SVGAttributes<SVGSVGElement>

const Svg = ({ size = 16, children, ...rest }: P & { children: preact.ComponentChildren }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
)

export const IconSidebar = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9.5 4v16" />
  </Svg>
)

export const IconRail = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M14.5 4v16" />
  </Svg>
)

export const IconNewNote = (p: P) => (
  <Svg {...p}>
    <path d="M12 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
    <path d="M18.4 2.6a2 2 0 0 1 2.8 2.8L13 13.6l-3.5.9.9-3.5z" />
  </Svg>
)

export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
)

export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)

export const IconNotes = (p: P) => (
  <Svg {...p}>
    <path d="M4 4.5h16v15H4z" />
    <path d="M8 9h8M8 13h8M8 17h5" />
  </Svg>
)

export const IconTag = (p: P) => (
  <Svg {...p}>
    <path d="M4 5.5h7.2a2 2 0 0 1 1.4.6l6.4 6.4a2 2 0 0 1 0 2.8l-4.7 4.7a2 2 0 0 1-2.8 0l-6.4-6.4A2 2 0 0 1 4 12.2z" />
    <circle cx="8.5" cy="10" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m4 12.5 5 5L20 6.5" />
  </Svg>
)

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M4 6.5h16M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
    <path d="M6.5 6.5 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.5" />
  </Svg>
)

export const IconPaperclip = (p: P) => (
  <Svg {...p}>
    <path d="M20 11.5 12 19.4a5 5 0 0 1-7-7l8.4-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.3a1.7 1.7 0 0 1-2.3-2.3l7.7-7.7" />
  </Svg>
)

export const IconChevron = (p: P) => (
  <Svg {...p} size={p.size ?? 12}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
)

export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
)

export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
)

export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </Svg>
)

export const IconSync = (p: P) => (
  <Svg {...p}>
    <path d="M20.5 12a8.5 8.5 0 0 1-14.6 6" />
    <path d="M3.5 12a8.5 8.5 0 0 1 14.6-6" />
    <path d="M18 3v3.5h-3.5M6 21v-3.5h3.5" />
  </Svg>
)

export const IconPin = (p: P) => (
  <Svg {...p} size={p.size ?? 13}>
    <path d="M9 3h6l-.7 5.3 3.2 3.2H6.5l3.2-3.2z" />
    <path d="M12 11.5V21" />
  </Svg>
)

export const IconImage = (p: P) => (
  <Svg {...p} size={p.size ?? 13}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="8.5" cy="10" r="1.6" />
    <path d="m4 17 4.7-4.2a2 2 0 0 1 2.7 0L20 20" />
  </Svg>
)

/** A four-pointed star: something a model did, rather than something you typed. */
export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5c0 3.6 1.9 5.5 5.5 5.5-3.6 0-5.5 1.9-5.5 5.5 0-3.6-1.9-5.5-5.5-5.5 3.6 0 5.5-1.9 5.5-5.5Z" />
    <path d="M17.5 14.5c0 1.9 1 2.9 2.9 2.9-1.9 0-2.9 1-2.9 2.9 0-1.9-1-2.9-2.9-2.9 1.9 0 2.9-1 2.9-2.9Z" />
  </Svg>
)

/** Lines of text inside a frame's corners: reading words out of a picture. */
export const IconTextScan = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8V6a2.5 2.5 0 0 1 2.5-2.5h2M16 3.5h2A2.5 2.5 0 0 1 20.5 6v2M20.5 16v2a2.5 2.5 0 0 1-2.5 2.5h-2M8 20.5H6A2.5 2.5 0 0 1 3.5 18v-2" />
    <path d="M7.5 9.5h9M7.5 12.5h9M7.5 15.5h5" />
  </Svg>
)

export const IconCalendar = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
  </Svg>
)

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
)

export const IconHistory = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v4h4" />
    <path d="M12 7.5V12l3 1.8" />
  </Svg>
)

export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5v12M7.5 11 12 15.5 16.5 11" />
    <path d="M4 17.5v1.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" />
  </Svg>
)

export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M12 15.5v-12M7.5 8 12 3.5 16.5 8" />
    <path d="M4 17.5v1.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" />
  </Svg>
)

export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
    <path d="M13.5 10.5a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1.6-1.6" />
  </Svg>
)

export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)

export const IconCode = (p: P) => (
  <Svg {...p}>
    <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />
  </Svg>
)

export const IconWarn = (p: P) => (
  <Svg {...p}>
    <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0" />
    <path d="M12 9v4.5M12 17h.01" />
  </Svg>
)

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconFolderPlus = (p: P) => (
  <Svg {...p}>
    <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11.5v5M9.5 14h5" />
  </Svg>
)

export const IconDots = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconInbox = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 13.5h4l1.5 3h6l1.5-3h4" />
    <path d="M5.4 5.6 3.5 13.5v3.9a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3.9L18.6 5.6a2 2 0 0 0-1.8-1.1H7.2a2 2 0 0 0-1.8 1.1z" />
  </Svg>
)

export const IconCamera = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8.5A2 2 0 0 1 5.5 6.5h1.8a2 2 0 0 0 1.7-1l.6-1a2 2 0 0 1 1.7-1h2.4a2 2 0 0 1 1.7 1l.6 1a2 2 0 0 0 1.7 1h1.8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.4" />
  </Svg>
)

export const IconImagePlus = (p: P) => (
  <Svg {...p}>
    <path d="M20.5 12.5V6.5a2 2 0 0 0-2-2h-13a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 16.5 3.8-3.4a2 2 0 0 1 2.7 0l3.5 3.2" />
    <path d="M17.5 16v6M14.5 19h6" />
  </Svg>
)

/* ---- formatting -------------------------------------------------------- */

export const IconListBullet = (p: P) => (
  <Svg {...p}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconListNumber = (p: P) => (
  <Svg {...p}>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <path d="M3.2 4.6 4.6 4v3.6M3 17.2c0-.7.6-1.2 1.3-1.2.6 0 1.2.4 1.2 1s-.4 1-1 1.4L3 19.6h2.6" stroke-width="1.5" />
  </Svg>
)

export const IconListCheck = (p: P) => (
  <Svg {...p}>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <rect x="2.6" y="4" width="4.4" height="4.4" rx="1.2" stroke-width="1.5" />
    <rect x="2.6" y="15.6" width="4.4" height="4.4" rx="1.2" stroke-width="1.5" />
    <path d="M2.6 12.2h4.4" stroke-width="1.5" />
  </Svg>
)

export const IconIndent = (p: P) => (
  <Svg {...p}>
    <path d="M10 6h10M10 12h10M10 18h10M3 9l3 3-3 3" />
  </Svg>
)

export const IconOutdent = (p: P) => (
  <Svg {...p}>
    <path d="M10 6h10M10 12h10M10 18h10M6 9l-3 3 3 3" />
  </Svg>
)

export const IconQuote = (p: P) => (
  <Svg {...p}>
    <path d="M4 5v14" stroke-width="2.4" />
    <path d="M9 8h11M9 12h11M9 16h7" />
  </Svg>
)

export const IconHighlight = (p: P) => (
  <Svg {...p}>
    <path d="M14.5 4.5 19.5 9.5 11 18H6.5l-1-3.5z" />
    <path d="M4 21h16" stroke-width="2.2" />
  </Svg>
)

/**
 * Text colour: an A over a bar.
 *
 * The bar takes the colour currently in use rather than the icon's own, so the
 * button in the toolbar says which colour it is about to apply — the one thing
 * a picker behind a button cannot say for itself. `currentColor` when there is
 * none, which is exactly what "automatic" means.
 */
export const IconTextColor = ({ bar, ...p }: P & { bar?: string }) => (
  <Svg {...p}>
    <path d="M6 16.5 12 5l6 11.5M8.3 13h7.4" />
    <path d="M4 20.5h16" stroke={bar ?? 'currentColor'} stroke-width="2.8" />
  </Svg>
)

export const IconTable = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M3 9.5h18M3 14.5h18M9.5 9.5V19.5M15 9.5V19.5" />
  </Svg>
)

export const IconPencil = (p: P) => (
  <Svg {...p}>
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7.5 18.5l-4 1 1-4z" />
  </Svg>
)

/* ---- focus mode and the window it can step out into --------------------- */

export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.2" />
    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
  </Svg>
)

export const IconMaximize = (p: P) => (
  <Svg {...p}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </Svg>
)

export const IconMinimize = (p: P) => (
  <Svg {...p}>
    <path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20" />
  </Svg>
)

export const IconPopout = (p: P) => (
  <Svg {...p}>
    <path d="M13 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V11" />
    <path d="M13.5 10.5 20 4M15 3.5h5.5V9" />
  </Svg>
)

export const IconRichText = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h16M4 12h11M4 18h7" />
  </Svg>
)

/* ---- note properties ---------------------------------------------------
 *
 * The kind of value a frontmatter property holds, shown at the head of its row
 * in the properties form. Small — 14px there — so each one is a couple of
 * strokes and nothing else.
 */

export const IconText = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h12M4 17h8" />
  </Svg>
)

export const IconHash = (p: P) => (
  <Svg {...p}>
    <path d="M10 4 8 20M17 4l-2 16M4 9.5h16M3 14.5h16" />
  </Svg>
)

export const IconCheckbox = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <path d="m8 12.3 2.8 2.8L16.5 9" />
  </Svg>
)
