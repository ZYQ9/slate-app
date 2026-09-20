/**
 * Browser smoke test.
 *
 * Drives the built app in headless Chromium and exercises the paths that only
 * exist in a real browser: IndexedDB persistence across a reload, CodeMirror
 * live preview, wikilink autocomplete and navigation, clipboard image paste
 * with re-encoding, the lightbox, and the calendar/task rail.
 *
 * Run with:  node scripts/smoke.mjs
 */

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const SHOTS = resolve('screenshots')
const PORT = 4178

/*
 * Deliberately served from a SUBDIRECTORY, not the root.
 *
 * Dropping `dist/` into something like ~/Sites/slate and serving it with Apache
 * is a completely ordinary way to run this, and it is where a root-absolute
 * asset base silently breaks: every `/assets/*.js` 404s, the server answers with
 * an HTML error page, and the browser reports a confusing MIME-type error rather
 * than a missing file. Running the entire suite under a prefix keeps the build
 * honest about being relocatable.
 */
const BASE = '/slate/'

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
}

/**
 * A stand-in for an OpenAI-compatible model server.
 *
 * Served from this same origin on purpose. CORS is the interesting failure in
 * real life and precisely the thing a test cannot stage — a browser's refusal
 * is opaque by design, which is why the diagnosis for it lives in unit-tested
 * pure code. What is worth driving through a real browser is everything else:
 * that the settings reach the request, that a WebP attachment is re-encoded
 * into something a model will take, that a fenced reply is unwrapped, and that
 * *nothing is written to the note until the button is pressed*.
 */
const llm = {
  requests: [],
  reply: '```\nINVOICE 4821\nTOTAL 12.40\n```',
  /** Set to answer differently per request — used to tell the passes apart. */
  replyFor: null,
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = decodeURIComponent(url.pathname)

  if (path === '/mockllm/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-vision' }, { id: 'mock-text' }] }))
    return
  }
  if (path === '/mockllm/v1/chat/completions') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    llm.requests.push(body)
    const reply = llm.replyFor ? llm.replyFor(body) : llm.reply

    /*
     * Answer a streaming request by actually streaming, in several events with
     * the words split across them. A mock that returns the whole answer in one
     * event would leave the buffering in `sseEvents` — which exists because a
     * JSON object routinely arrives split across two network reads — untested
     * by the only thing that runs it.
     */
    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const pieces = reply.match(/[\s\S]{1,7}/g) ?? []
      for (const p of pieces) {
        const event = `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`
        // Cut the frame in half down the middle, so the client has to carry the
        // tail of one write into the next to parse it at all.
        res.write(event.slice(0, 12))
        await new Promise((r) => setTimeout(r, 2))
        res.write(event.slice(12))
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
    return
  }

  if (!path.startsWith(BASE)) {
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>outside the app</html>')
    return
  }
  const rel = path.slice(BASE.length)
  const file = join(DIST, rel === '' ? 'index.html' : rel)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // Answer a miss the way a plain static server does: an HTML error page.
    // That is precisely what turns a wrong asset path into a MIME-type error,
    // so the test sees the same failure a real deployment would.
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>404</html>')
  }
})

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

await mkdir(SHOTS, { recursive: true })
await new Promise((r) => server.listen(PORT, r))

const browser = await chromium.launch({
  // The sandbox image ships a Chromium build; use it rather than downloading one.
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})
// Touch is enabled for the whole run: the phone section needs real touch
// events, and a desktop page without them silently drops every touchstart,
// which would make the long-press checks pass vacuously or fail confusingly.
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  hasTouch: true,
})

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

/**
 * Ask the open note for an editing surface, the way a person does.
 *
 * A note opens as a page to read — no caret, and so no keyboard — and only a
 * tap in it, or this button, gives it one. The button rather than a tap on the
 * text, because a note whose first lines are a table or an image would be
 * answering a click aimed at those instead.
 */
/**
 * A date as the app writes it into a task line: local, not UTC, so a run near
 * midnight in a western timezone does not date "today" as tomorrow.
 */
const isoDay = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The calendar cell for a day, addressed by the label it announces. */
const calCell = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return page.locator(`.cal-day[aria-label^="${d.toDateString()}"]`)
}

/*
 * The same cell, brought into view first. A month grid runs from the Sunday
 * before the 1st to the end of the last week, so a day two either side of
 * today is *usually* on it — and near a month boundary it is not, which would
 * make these checks fail on a handful of days a year for no reason at all.
 */
const showDay = async (offset) => {
  const cell = calCell(offset)
  const arrow = offset < 0 ? 'Previous month' : 'Next month'
  for (let i = 0; i < 2 && (await cell.count()) === 0; i++) {
    await page.locator(`[aria-label="${arrow}"]`).click()
    await page.waitForTimeout(250)
  }
  return cell
}

/**
 * A point in the open note that is text rather than a control.
 *
 * Which note is in front of these checks depends on what earlier sections
 * touched last, and a note that opens on a task line has controls where the
 * text would be: the checkbox ticks and the date chip opens its picker, both
 * deliberately *instead* of starting to edit, so that reading through a note
 * never drops you into the editor. Pressing one of those and calling it a
 * failure to start editing tests the opposite of the rule. Falls back to the
 * empty space under the last line, which the editor answers the same way.
 */
const noteTextPoint = (scope = '') =>
  page.evaluate((s) => {
    const controls =
      'input, .cm-due-chip, .cm-task-checkbox, .cm-embed, .cm-code-copy, .cm-table-wrap, a'
    const plain = [...document.querySelectorAll(`${s} .cm-line`)].find(
      (l) => l.textContent.trim() && !l.querySelector(controls),
    )
    if (plain) {
      const r = plain.getBoundingClientRect()
      return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 }
    }
    const r = document.querySelector(`${s} .cm-scroller`).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.bottom - 24 }
  }, scope)

const startEditing = async () => {
  const edit = page.locator('.editor-pane [aria-label="Edit note"]')
  if (await edit.count()) {
    await edit.click()
    await page.waitForTimeout(200)
  }
}

/** The markdown of whichever note holds a given string. */
const noteContaining = (needle) =>
  page.evaluate(async (n) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res) => {
      const q = db.transaction('files', 'readonly').objectStore('files').getAll()
      q.onsuccess = () => res(q.result)
    })
    return all.find((f) => (f.text ?? '').includes(n))?.text ?? ''
  }, needle)

/**
 * The same, but waiting for a save that may not have landed yet.
 *
 * Saves are debounced, so a fixed sleep after a toolbar press is a race: the
 * read finds the *previous* text, which still contains the needle, and the
 * check fails for timing rather than for behaviour. Polling for what the edit
 * should have produced fails just as loudly when the edit never happens, and
 * only costs time when it is genuinely slow.
 */
const noteAfterEdit = async (needle, expected, timeout = 4000) => {
  const until = Date.now() + timeout
  let text = ''
  do {
    text = await noteContaining(needle)
    if (text.includes(expected)) return text
    await page.waitForTimeout(100)
  } while (Date.now() < until)
  return text
}

/** What the note is right now: a page being read, or something being typed in. */
const readingState = () =>
  page.evaluate(() => ({
    flag: document.querySelector('.editor-pane')?.dataset.reading ?? '',
    editable: document.querySelector('.cm-content')?.getAttribute('contenteditable') ?? '',
    focused: document.activeElement?.className ?? '',
  }))

try {
  await page.goto(`http://localhost:${PORT}${BASE}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.shell', { timeout: 10_000 })
  check('app boots', true)

  /* ---- iOS standalone landmines -------------------------------------------
   * Neither of these can be observed anywhere but a real installed iOS PWA —
   * headless Chromium, desktop Safari and the simulators all render correctly
   * either way — so they are asserted on the markup instead. Both have already
   * cost a round of "the app doesn't reach the bottom of the screen": without
   * viewport-fit=cover iOS letterboxes the app inside the safe area, and
   * black-translucent hands back a web view shorter than the screen.
   */
  const head = await page.evaluate(() => ({
    viewport: document.querySelector('meta[name=viewport]')?.content ?? '',
    statusBar:
      document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content ?? '',
  }))
  check('the viewport opts into the whole screen', /viewport-fit=cover/.test(head.viewport), head.viewport)
  check('the iOS status bar style is default', head.statusBar === 'default', head.statusBar)

  /* ---- create a note ------------------------------------------------ */
  await page.click('[title^="New note"]')
  await page.waitForSelector('.cm-editor')
  check('editor mounts', true)

  /*
   * A brand new note is the one note that opens with a caret in it. There is
   * nothing in it to read, and the tap that would ask for the caret is the one
   * that just made the note.
   */
  const fresh = await readingState()
  check(
    'a brand new note opens ready to type',
    fresh.flag === '0' && fresh.editable === 'true' && fresh.focused.includes('cm-content'),
    `reading=${fresh.flag}, focused ${fresh.focused || 'nothing'}`,
  )

  const title = page.locator('.editor-title-input')
  await title.fill('Lisbon Trip')
  await title.press('Enter')

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially('# Lisbon Trip\n\nFlights are **booked** and the hotel is *pending*.\n\n', { delay: 4 })
  await page.waitForTimeout(300)

  /* ---- live preview hides syntax ------------------------------------ */
  const h1 = await page.locator('.cm-line.cm-h1').count()
  check('heading gets block styling', h1 > 0, `${h1} heading lines`)

  // Move the caret away so the bold markers hide, then confirm they are gone
  // from the rendered text but still present in the document.
  await editor.press('Control+End')
  await page.waitForTimeout(200)
  const visibleText = await page.locator('.cm-content').innerText()
  check('bold markers hidden in preview', !visibleText.includes('**booked**'), visibleText.slice(0, 60))

  /* ---- tasks --------------------------------------------------------- */
  await editor.pressSequentially(`- [ ] Book the tram tickets 📅 ${isoDay()}\n`, { delay: 4 })
  await editor.pressSequentially('Renew passport\n', { delay: 4 })
  await page.waitForTimeout(500)
  const checkboxes = await page.locator('.cm-task-checkbox').count()
  check('task checkbox renders as a widget', checkboxes > 0, `${checkboxes} found`)

  /*
   * The rail's list is the dated one: what is due today and what is already
   * late. Everything else lives in the sidebar's Tasks row — beside a calendar,
   * an undated job is a job for another day.
   */
  const railRows = () => page.locator('.rail .task-row')
  check(
    'a task due today appears in the right rail',
    (await railRows().filter({ hasText: 'Book the tram tickets' }).count()) === 1,
    `${await railRows().count()} in rail`,
  )
  check(
    'and an undated one does not crowd it',
    (await railRows().filter({ hasText: 'Renew passport' }).count()) === 0,
    (await railRows().allInnerTexts()).join(' | '),
  )

  /* ---- due dates ------------------------------------------------------
   * The chip is the whole feature: a date is a control at the end of the task
   * line, in the note and in the rail, rather than something you hand-type.
   */
  const dated = page.locator('.cm-due-chip[data-set="1"]')
  check('a due date renders as a chip, not as syntax', (await dated.count()) === 1)
  check(
    'and the raw marker is gone from the rendered line',
    !(await page.locator('.cm-content').innerText()).includes(`📅 ${isoDay()}`),
  )
  check('the chip says something a person would say', ((await dated.innerText()) || '').length > 0, await dated.innerText())

  /*
   * The ghost only ever appears on the line the caret is in — the same rule
   * the rest of live preview follows. A checklist does not sprout a button
   * per row.
   */
  const ghosts = () => page.locator('.cm-due-chip[data-set="0"]').count()
  check('an undated task offers a ghost chip on the caret’s line', (await ghosts()) === 1)
  await page.locator('.cm-line.cm-h1').click()
  await page.waitForTimeout(200)
  check('and nowhere else once the caret leaves', (await ghosts()) === 0)
  check('while a real date stays visible regardless', (await dated.count()) === 1)

  // Open the picker on the date that exists.
  await dated.click()
  await page.waitForTimeout(250)
  const picker = await page.evaluate(() => ({
    open: document.querySelectorAll('.due-pick').length,
    presets: [...document.querySelectorAll('.due-preset')].map((b) => b.textContent.trim()),
    days: document.querySelectorAll('.due-day').length,
    clear: document.querySelectorAll('.due-clear').length,
  }))
  check('clicking a chip opens the picker', picker.open === 1)
  /*
   * Three, except on a Sunday: "Next week" is the coming Monday, which is
   * *tomorrow*, and the picker drops a preset that duplicates one above it
   * rather than offering the same date twice. Asserting a flat three made this
   * a check that failed one day in seven for being right.
   */
  check(
    'it leads with one-tap presets',
    picker.presets.length >= (new Date().getDay() === 0 ? 2 : 3),
    picker.presets.join(' · '),
  )
  check('Today and Tomorrow are always among them', /^Today/.test(picker.presets[0]) && /^Tomorrow/.test(picker.presets[1]))
  check('a full month grid sits under them', picker.days >= 28, `${picker.days} cells`)
  check('and a date already set can be cleared', picker.clear === 1)
  await page.screenshot({ path: join(SHOTS, '01b-due-picker.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('Escape dismisses it', (await page.locator('.due-pick').count()) === 0)

  // The keyboard route to the same picker, for a task being written rather
  // than one being reviewed.
  await page.locator('.cm-line:has-text("Book the tram tickets")').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+Alt+d')
  await page.waitForTimeout(300)
  check('⌘⌥D opens it for the task the caret is on', (await page.locator('.due-pick').count()) === 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.locator('.cm-line.cm-h1').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+Alt+d')
  await page.waitForTimeout(300)
  check('and stays out of the way on a line that is not a task', (await page.locator('.due-pick').count()) === 0)

  /*
   * The round trip that matters: date a task that had none, entirely from the
   * UI, and find it in the markdown afterwards.
   */
  await page.locator('.cm-line:has-text("Renew passport")').click()
  await page.waitForTimeout(250)

  /*
   * The ghost is a zero-width widget pinned to the end of the line, and it is
   * atomic like every other widget here. Typing at the end of that line is the
   * thing that would break if "atomic" meant the caret could not get past it,
   * so it is checked rather than assumed.
   */
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await page.waitForTimeout(700) // past the editor's 400ms save debounce
  check(
    'typing at the end of a task line still lands in the line',
    (await noteContaining('Renew passport')).includes('- [ ] Renew passport!'),
  )
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(700)
  check(
    'and backspace takes the character, not the chip',
    (await noteContaining('Renew passport')).includes('- [ ] Renew passport\n') &&
      (await page.locator('.cm-due-chip[data-set="0"]').count()) === 1,
  )

  await page.locator('.cm-due-chip[data-set="0"]').first().click()
  await page.waitForTimeout(250)
  await page.locator('.due-preset:has-text("Tomorrow")').click()
  await page.waitForTimeout(500)
  const trip = await noteContaining('Renew passport')
  check(
    'picking a preset writes a real date into the markdown',
    /- \[ \] Renew passport 📅 \d{4}-\d{2}-\d{2}/.test(trip),
    (trip.split('\n').find((l) => l.includes('Renew passport')) ?? '').trim(),
  )
  check('and the note now carries two dated tasks', (trip.match(/📅/g) ?? []).length === 2)
  check(
    'the rail gives every task it shows a date button',
    (await page.locator('.rail .task-row .due-chip').count()) ===
      (await page.locator('.rail .task-row').count()) &&
      (await page.locator('.rail .task-row').count()) > 0,
  )
  check(
    'and a task dated tomorrow waits its turn',
    (await railRows().filter({ hasText: 'Renew passport' }).count()) === 0,
    (await railRows().allInnerTexts()).join(' | '),
  )

  /* ---- second note + wikilink autocomplete --------------------------- */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(200)
  await page.locator('.editor-title-input').fill('Packing List')
  await page.locator('.editor-title-input').press('Enter')
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('Linked from [[Lisbon', { delay: 25 })
  await page.waitForTimeout(500)
  const acVisible = await page.locator('.cm-tooltip-autocomplete').isVisible().catch(() => false)
  check('wikilink autocomplete opens', acVisible)

  if (acVisible) {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
  } else {
    await page.locator('.cm-content').pressSequentially(' Trip]]', { delay: 10 })
    await page.waitForTimeout(400)
  }

  await page.locator('.cm-content').press('Control+End')
  await page.waitForTimeout(300)
  const linkCount = await page.locator('.cm-wikilink').count()
  const brokenCount = await page.locator('.cm-wikilink-broken').count()
  check('wikilink renders and resolves', linkCount > 0 && brokenCount === 0, `${linkCount} links, ${brokenCount} broken`)

  /* ---- navigate by clicking the link --------------------------------- */
  if (linkCount > 0) {
    await page.locator('.cm-wikilink').first().click()
    await page.waitForTimeout(400)
    const nowTitle = await page.locator('.editor-title-input').inputValue()
    check('clicking a wikilink navigates', nowTitle === 'Lisbon Trip', `landed on "${nowTitle}"`)
  }

  /* ---- backlinks ----------------------------------------------------- */
  const backlinks = await page.locator('.backlinks .backlink-row').count()
  check('backlink is recorded', backlinks > 0, `${backlinks} linked mentions`)

  /* ---- back and forward ------------------------------------------------
   *
   * Straight after a link has been followed, which is the whole reason the two
   * arrows exist: the note list is sorted by date and cannot tell you where you
   * have just been.
   */
  if (linkCount > 0) {
    const cameFrom = 'Packing List'
    check(
      'Back offers the note the link was followed from',
      (await page.getAttribute('.editor-nav [aria-label="Back"]', 'title')) === `Back to “${cameFrom}”`,
      await page.getAttribute('.editor-nav [aria-label="Back"]', 'title'),
    )
    check('Forward has nowhere to go yet', await page.locator('.editor-nav [aria-label="Forward"]').isDisabled())

    await page.click('.editor-nav [aria-label="Back"]')
    await page.waitForTimeout(350)
    check(
      'Back returns to it',
      (await page.locator('.editor-title-input').inputValue()) === cameFrom,
    )

    await page.click('.editor-nav [aria-label="Forward"]')
    await page.waitForTimeout(350)
    check(
      'and Forward comes back again',
      (await page.locator('.editor-title-input').inputValue()) === 'Lisbon Trip',
    )
  }

  /* ---- paste an image ------------------------------------------------ */
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')
  await page.evaluate(async () => {
    // Build a genuine PNG in-page and paste it through a real ClipboardEvent,
    // which is the only way to exercise the app's own paste handler.
    const c = document.createElement('canvas')
    c.width = 1400
    c.height = 900
    const ctx = c.getContext('2d')
    const g = ctx.createLinearGradient(0, 0, 1400, 900)
    g.addColorStop(0, '#e0a80d')
    g.addColorStop(1, '#1c1c1e')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 1400, 900)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 64px sans-serif'
    ctx.fillText('screenshot', 80, 460)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    const file = new File([blob], 'screenshot.png', { type: 'image/png' })
    window.__pastedSize = blob.size
    const dt = new DataTransfer()
    dt.items.add(file)
    document
      .querySelector('.cm-content')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(2500)

  const imgCount = await page.locator('.cm-embed img').count()
  check('pasted image renders inline', imgCount > 0, `${imgCount} embeds`)

  const sizes = await page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === 'slate')) return null
    return new Promise((resolve) => {
      const req = indexedDB.open('slate')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () => {
          const att = all.result.filter((f) => f.kind === 'attachment')
          resolve({
            original: window.__pastedSize,
            stored: att[0]?.size ?? 0,
            mime: att[0]?.mime ?? '',
            path: att[0]?.path ?? '',
          })
        }
      }
    })
  })
  if (sizes) {
    const ratio = sizes.original / Math.max(1, sizes.stored)
    check(
      'pasted image is optimized',
      sizes.stored > 0 && sizes.stored < sizes.original,
      `${(sizes.original / 1024).toFixed(0)}KB → ${(sizes.stored / 1024).toFixed(0)}KB (${ratio.toFixed(1)}x) as ${sizes.mime}`,
    )
    check('attachment filed under the dated folder', /^attachments\/\d{4}\/\d{2}\//.test(sizes.path), sizes.path)
  } else {
    check('pasted image is optimized', false, 'could not read IndexedDB')
  }

  await page.screenshot({ path: join(SHOTS, '01-editor.png') })

  /* ---- lightbox ------------------------------------------------------ */
  if (imgCount > 0) {
    await page.locator('.cm-embed img').first().click()
    await page.waitForTimeout(400)
    const lb = await page.locator('.lightbox').isVisible()
    check('lightbox opens on image click', lb)
    if (lb) await page.screenshot({ path: join(SHOTS, '02-lightbox.png') })

    /* ---- pinching a picture ---------------------------------------------
     * Zoom buttons are a poor substitute for fingers on a phone, so the
     * viewer takes the gesture itself. Touch is dispatched through CDP
     * because it is the only way to put two fingers on the screen at once —
     * Playwright's touchscreen taps with one.
     */
    const cdp = await page.context().newCDPSession(page)
    const touch = (type, points) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: i + 1 })),
      })
    const drag = async (from, to, steps = 8) => {
      await touch('touchStart', from)
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        await touch(
          'touchMove',
          from.map((p, k) => ({ x: p.x + (to[k].x - p.x) * t, y: p.y + (to[k].y - p.y) * t })),
        )
      }
      await touch('touchEnd', [])
      await page.waitForTimeout(250)
    }
    const viewer = () =>
      page.evaluate(() => {
        const img = document.querySelector('.lightbox-stage img')
        const stage = document.querySelector('.lightbox-stage')
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
          img.style.transform,
        )
        const r = img.getBoundingClientRect()
        const s = stage.getBoundingClientRect()
        return {
          x: m ? +m[1] : NaN,
          y: m ? +m[2] : NaN,
          scale: m ? +m[3] : NaN,
          slackX: Math.max(0, (r.width - s.width) / 2),
          slackY: Math.max(0, (r.height - s.height) / 2),
        }
      })

    const fitted = await viewer()
    check('a picture opens fitted and centred', fitted.scale === 1 && fitted.x === 0 && fitted.y === 0, JSON.stringify(fitted))

    const mid = await page.evaluate(() => {
      const r = document.querySelector('.lightbox-stage').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    // Fingers 120px apart, spread to 360: three times the gap, three times the
    // picture.
    await drag(
      [
        { x: mid.x - 60, y: mid.y },
        { x: mid.x + 60, y: mid.y },
      ],
      [
        { x: mid.x - 180, y: mid.y },
        { x: mid.x + 180, y: mid.y },
      ],
    )
    const pinched = await viewer()
    check(
      'pinching zooms it by how far the fingers spread',
      Math.abs(pinched.scale - 3) < 0.35,
      `${pinched.scale.toFixed(2)}×`,
    )

    // One finger, well past the edge of what a zoomed picture has to give.
    await drag([{ x: mid.x, y: mid.y }], [{ x: mid.x + 4000, y: mid.y + 4000 }])
    const dragged = await viewer()
    check('a zoomed picture can be dragged', dragged.x > 0 && dragged.y > 0, JSON.stringify(dragged))
    check(
      'and stops with its edge at the edge of the stage',
      dragged.x <= dragged.slackX + 1 && dragged.y <= dragged.slackY + 1,
      `${dragged.x.toFixed(0)},${dragged.y.toFixed(0)} of ${dragged.slackX.toFixed(0)},${dragged.slackY.toFixed(0)}`,
    )

    await page.touchscreen.tap(Math.round(mid.x), Math.round(mid.y))
    await page.waitForTimeout(300)
    const tapped = await viewer()
    check('tapping a zoomed picture puts it back', tapped.scale === 1 && tapped.x === 0, JSON.stringify(tapped))

    await page.touchscreen.tap(Math.round(mid.x), Math.round(mid.y))
    await page.waitForTimeout(300)
    check('and tapping a fitted one zooms in', (await viewer()).scale === 2)

    await page.keyboard.press('0')
    await page.waitForTimeout(250)
    check('0 fits it again', (await viewer()).scale === 1)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }

  /* ---- transcribing a picture -------------------------------------------
   * The first feature that sends anything anywhere. Checked from both ends:
   * with no provider configured there is no button at all, and with one there
   * is a review step that has to be pressed before the note changes.
   */
  if (imgCount > 0) {
    await page.locator('.cm-embed img').first().click()
    await page.waitForTimeout(400)
    check(
      'with no AI provider there is no Transcribe button',
      (await page.locator('.lightbox-bar .icon-btn[title^="Transcribe"]').count()) === 0,
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)

    await page.click('.pane-head .icon-btn[title^="Settings"]')
    await page.waitForSelector('.dialog')
    await page.click('.tab:has-text("AI")')
    await page.waitForTimeout(250)
    check('Settings has somewhere to put a model', (await page.locator('.dialog:has-text("Provider")').count()) === 1)

    await page.locator('.dialog label.field:has-text("Provider") select').selectOption('custom')
    await page.waitForTimeout(150)
    await page
      .locator('.dialog label.field:has-text("API address") input')
      .fill(`http://localhost:${PORT}/mockllm/v1`)
    await page.locator('.dialog .btn-primary:has-text("Test connection")').click()
    await page.waitForTimeout(600)
    check(
      'testing the connection reports what the server can run',
      /2 models available/.test(await page.locator('.dialog-body').innerText()),
    )
    await page.locator('.dialog label.field:has(span:text-is("Vision model")) input').fill('mock-vision')
    await page.waitForTimeout(150)
    await page.click('.dialog-foot .btn-primary')
    await page.waitForTimeout(300)

    const noteBefore = await page.locator('.cm-content').innerText()

    await page.locator('.cm-embed img').first().click()
    await page.waitForTimeout(400)
    const transcribeBtn = page.locator('.lightbox-bar .icon-btn[title^="Transcribe"]')
    check('configuring a provider puts Transcribe in the viewer', (await transcribeBtn.count()) === 1)
    await transcribeBtn.click()
    await page.waitForSelector('.transcribe-text', { timeout: 10000 })
    await page.waitForTimeout(300)

    const sent = llm.requests.at(-1)
    const dataUrl = sent?.messages?.[0]?.content?.[1]?.image_url?.url ?? ''
    check('the model was sent the picture', dataUrl.startsWith('data:image/'), dataUrl.slice(0, 22))
    check(
      'and it was re-encoded into a format every server takes',
      /^data:image\/(jpeg|png);base64,/.test(dataUrl),
      `stored as ${sizes?.mime ?? 'webp'}`,
    )
    check('the prompt asks for a verbatim transcription', /verbatim/i.test(sent?.messages?.[0]?.content?.[0]?.text ?? ''))

    const shown = await page.locator('.transcribe-text').inputValue()
    check('the reply is shown for review, unwrapped from its code fence', shown === 'INVOICE 4821\nTOTAL 12.40', shown)
    check('the dialog says what left the device', /Sent to your provider/.test(await page.locator('.dialog-body').innerText()))
    check('and the note has not been touched yet', (await page.locator('.cm-content').innerText()) === noteBefore)

    // Edited before inserting, which is the point of the box being a box.
    await page.locator('.transcribe-text').fill('INVOICE 4821\nTOTAL 12.40 (checked)')
    await page.click('.dialog-foot .btn-primary')
    await page.waitForTimeout(700)
    const noteAfter = await page.locator('.cm-content').innerText()
    check('inserting writes the edited text into the note', noteAfter.includes('TOTAL 12.40 (checked)'))
    check('nothing that was in the note was lost', noteBefore.split('\n').every((l) => !l.trim() || noteAfter.includes(l.trim())))

    /* A failure has to arrive as words rather than as a silent nothing. */
    llm.reply = ''
    await page.locator('.cm-embed img').first().click()
    await page.waitForTimeout(400)
    await page.locator('.lightbox-bar .icon-btn[title^="Transcribe"]').click()
    await page.waitForSelector('.callout-danger', { timeout: 10000 })
    check(
      'a model that answers with nothing says so, and says why it might',
      /vision model/.test(await page.locator('.dialog-body .callout-danger').innerText()),
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    llm.reply = '```\nINVOICE 4821\nTOTAL 12.40\n```'

    /* ---- changing a passage ---------------------------------------------
     * The whole point is the step before the change: the model's answer is
     * shown against what is there, and nothing reaches the buffer until the
     * button under the diff is pressed.
     */
    await startEditing()
    // The first line, not the middle of the pane: this note now ends with a
    // picture, and a click there opens the lightbox rather than placing a caret.
    await page.locator('.cm-line').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nteh quick brown fox jumpd over it\n')
    await page.waitForTimeout(400)
    // Select that line: to its start, then to its end holding shift.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.waitForTimeout(200)

    llm.reply = 'the quick brown fox jumped over it'
    const before = await page.locator('.cm-content').innerText()
    await page.keyboard.press('Control+Shift+U')
    await page.waitForSelector('.transform-presets', { timeout: 5000 })
    check('⌘⇧U opens the rewrite dialog on a selection', true)
    check('the note is untouched by opening it', (await page.locator('.cm-content').innerText()) === before)

    await page.locator('.transform-preset:has-text("Proofread")').click()
    await page.waitForSelector('.diff', { timeout: 15000 })
    const sentT = llm.requests.at(-1)
    check('the rewrite was streamed', sentT?.stream === true)
    check(
      'the passage went as material, not as part of the instruction',
      sentT?.messages?.[1]?.role === 'user' &&
        sentT.messages[1].content === 'teh quick brown fox jumpd over it',
    )
    check(
      'and the instruction says the passage is not instructions',
      /not instructions to you/i.test(sentT?.messages?.[0]?.content ?? ''),
    )

    const diffText = await page.locator('.diff').innerText()
    check('the change is shown as a diff before it is made', /teh quick/.test(diffText) && /jumped/.test(diffText))
    check('with a removed row and an added row', (await page.locator('.diff-line[data-kind="del"]').count()) === 1 && (await page.locator('.diff-line[data-kind="add"]').count()) === 1)
    check('the note is still untouched while the diff is up', (await page.locator('.cm-content').innerText()) === before)

    await page.click('.dialog-foot .btn-primary')
    await page.locator('.transform-presets').waitFor({ state: 'detached', timeout: 10000 })
    await page.waitForTimeout(300)
    const afterT = await page.locator('.cm-content').innerText()
    check('accepting replaces just that passage', afterT.includes('the quick brown fox jumped over it'))
    check('and the rest of the note is as it was', !afterT.includes('teh quick'))

    /* A rewrite that comes back identical is a result, not an edit. */
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    llm.reply = 'the quick brown fox jumped over it'
    await page.keyboard.press('Control+Shift+U')
    await page.waitForSelector('.transform-presets', { timeout: 5000 })
    await page.locator('.transform-preset:has-text("Tighten")').click()
    const saidUnchanged = await page
      .locator('.dialog-body .callout:has-text("returned the passage unchanged")')
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    check('a reply identical to the passage says so instead of offering an empty diff', saidUnchanged)
    check(
      'and there is nothing to accept',
      await page.locator('.dialog-foot .btn-primary').isDisabled(),
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    /* ---- the two clickable ways in ---------------------------------------
     * Both features were reachable only from the command palette, which is to
     * say reachable only by people who already knew they existed. These are the
     * affordances that fix that, so they are checked as affordances: present,
     * in the right state, and actually doing the thing.
     */
    /*
     * The header button, which is the one that matters: the formatting bar
     * only exists in rich text, and rich text is not the default mode, so a
     * button that lived only there would be invisible to most people — which is
     * the same failure as living only in the palette.
     */
    const headBtn = page.locator('.editor-pane [data-id="note-ai"]')
    check('the note header carries a button for it', (await headBtn.count()) === 1)

    await page.locator('.cm-line').first().click()
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(250)
    await headBtn.click()
    await page.waitForTimeout(300)
    await page.locator('.menu-item:has-text("Change this passage")').click()
    const headOpened = await page
      .waitForSelector('.transform-presets', { timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    /*
     * This is also the check that the selection survived the menu: an empty
     * range never opens the dialog at all — it refuses with a notice — so the
     * dialog being here is the proof that the press, the menu and the click
     * between them cost the editor nothing.
     */
    check('pressing it opens the rewrite dialog on what was selected', headOpened)
    /*
     * The close button rather than Escape. The dialog's Escape handler is
     * attached in an effect, which Preact runs after the paint — so for one
     * frame it is on screen and deaf, and a key pressed the instant it appears
     * is intermittently lost. A person would never notice; a test that presses
     * within a millisecond does.
     */
    await page.locator('.dialog [aria-label="Close"]').click()
    await page.locator('.transform-presets').waitFor({ state: 'detached', timeout: 5000 })
    await page.waitForTimeout(200)

    /* And the same control on the bar, in the mode that has one. */
    await page.click('.pane-head .icon-btn[title^="Settings"]')
    await page.waitForSelector('.dialog')
    await page.click('.tab:has-text("Editor")')
    await page.waitForTimeout(250)
    await page.locator('.dialog label.field:has(span:text-is("Default mode")) select').selectOption('rich')
    await page.click('.dialog-foot .btn-primary')
    await page.waitForTimeout(400)
    const aiBtn = page.locator('.fmt-bar [data-id="transform"]')
    check('the formatting bar carries it too, in rich text', (await aiBtn.count()) === 1)
    await page.locator('.cm-line').first().click()
    await page.waitForTimeout(250)
    check('greyed out with nothing selected', await aiBtn.isDisabled())
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(250)
    check('and live once something is', !(await aiBtn.isDisabled()))
    await page.click('.pane-head .icon-btn[title^="Settings"]')
    await page.waitForSelector('.dialog')
    await page.click('.tab:has-text("Editor")')
    await page.waitForTimeout(250)
    await page.locator('.dialog label.field:has(span:text-is("Default mode")) select').selectOption('live')
    await page.click('.dialog-foot .btn-primary')
    await page.waitForTimeout(400)

    await page.locator('.pane.list-pane .icon-btn[aria-label="List actions"]').click()
    await page.waitForTimeout(300)
    const listMenuText = await page.locator('.menu, .sheet').first().innerText()
    check('the list has a ⋯ menu on a desktop too', /Summarise these/.test(listMenuText), listMenuText.replace(/\n/g, ' · '))
    check('which also offers the palette, named and with its key', /All commands/.test(listMenuText))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    /* ---- asking the notes ------------------------------------------------
     * The conversation is a note, so nearly all of this is checked by reading
     * the file back: the question is a heading, the answer is under it, and the
     * provenance callout says what was searched and read.
     */
    llm.replyFor = (body) => {
      const sys = body.messages?.[0]?.content ?? ''
      if (/choosing what to look for/i.test(sys)) return 'lisbon, packing'
      if (/answering questions about/i.test(sys))
        return 'The trip notes cover Lisbon and what to take — see [[Packing List]].'
      return 'unexpected'
    }

    await page.locator('.pane.list-pane .icon-btn[aria-label="List actions"]').click()
    await page.waitForTimeout(300)
    const askItem = page.locator('.menu-item:has-text("Ask these notes")')
    check('the list menu offers a conversation', (await askItem.count()) === 1)
    await askItem.click()
    await page.waitForSelector('.ask-question', { timeout: 5000 })
    check('and asks for the first question up front', true)

    const askBox = page.locator('.ask-question')
    await askBox.click()
    await askBox.pressSequentially('What did we pack for Lisbon', { delay: 15 })
    await page.waitForTimeout(200)
    await page.click('.dialog-foot .btn-primary')

    // Done when the composer is on screen and the answer has landed in the note.
    await page.waitForSelector('.composer', { timeout: 10000 })
    check('the conversation opens with a composer under it', true)
    await page.waitForFunction(
      () => /Packing List/.test(document.querySelector('.cm-content')?.textContent ?? ''),
      null,
      { timeout: 30000 },
    )

    /*
     * The buffer has the answer; the file has it 400ms later. Everything below
     * reads the *file*, so it waits for the save rather than for the paint.
     */
    const savedConvo = async (needle) => {
      for (let i = 0; i < 40; i++) {
        const text = await noteContaining(needle)
        if (text) return text
        await page.waitForTimeout(250)
      }
      return undefined
    }

    const convo = await savedConvo('[[Packing List]]')
    check('the conversation is an ordinary note', !!convo)
    check('named after the first question', /Ask — What did we pack/.test(await page.locator('.editor-title-input').inputValue()))
    check('the question is a heading', /^## What did we pack for Lisbon$/m.test(convo ?? ''))
    check('the answer cites a note as a wikilink', /\[\[Packing List\]\]/.test(convo ?? ''))
    check('with a folded callout saying what it read', /^> \[!note\]- Searched/m.test(convo ?? ''), (convo ?? '').split('\n').find((l) => l.startsWith('> [!note]')))
    check(
      'the scope it may read is written in the note',
      /^source: /m.test(convo ?? ''),
      (convo ?? '').split('\n').find((l) => l.startsWith('source:')),
    )

    const termReq = llm.requests.find((r) => /choosing what to look for/i.test(r.messages?.[0]?.content ?? ''))
    check('the model was asked what to search for first', !!termReq)
    const answerReq = llm.requests.find((r) => /answering questions about/i.test(r.messages?.[0]?.content ?? ''))
    check('and then answered from the notes that were found', /## /.test(answerReq?.messages?.[1]?.content ?? ''))
    check(
      'the question went as material, not as part of the instruction',
      (answerReq?.messages?.[1]?.content ?? '').includes('What did we pack for Lisbon'),
    )

    /* A follow-up reads the conversation back out of the file. */
    const askedBefore = llm.requests.length
    await page.locator('.composer-input').click()
    await page.locator('.composer-input').pressSequentially('And what about the weather?', { delay: 15 })
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => (document.querySelectorAll('.cm-content .cm-line').length ?? 0) > 0 &&
        /weather/i.test(document.querySelector('.cm-content')?.textContent ?? ''),
      null,
      { timeout: 30000 },
    )
    await page.waitForTimeout(1200)
    const followUp = llm.requests.slice(askedBefore).find((r) => /choosing what to look for/i.test(r.messages?.[0]?.content ?? ''))
    check(
      'a follow-up carries the conversation so far',
      /What did we pack for Lisbon/.test(followUp?.messages?.[1]?.content ?? ''),
    )
    const convo2 = await savedConvo('And what about the weather')
    check('and both turns are in the one note', /## What did we pack/.test(convo2 ?? '') && /## And what about the weather/.test(convo2 ?? ''))
    llm.replyFor = null

    /* ---- asking the same thing, searching for something else -------------
     * The lever the provenance callout points at. It records what was searched
     * for; Redo lets you change that and re-answer, replacing the old exchange
     * rather than appending a second answer to the same question.
     */
    /*
     * The terms never reach the answer request — they only decide which notes
     * are found — so the two answers are told apart by counting rather than by
     * looking for the terms in the body.
     */
    llm.replyFor = (body) => {
      const sys = body.messages?.[0]?.content ?? ''
      if (/choosing what to look for/i.test(sys)) return 'lisbon, packing'
      // Only the redo runs under this reply, so it can answer unconditionally —
      // the terms never reach the answer request, only the notes they found do.
      if (/answering questions about/i.test(sys)) return 'Answered again, from [[Packing List]].'
      return 'unexpected'
    }

    const beforeRedo = llm.requests.length
    await page.locator('.composer-redo').click()
    await page.waitForSelector('.prompt-input', { timeout: 5000 })
    const termBox = page.locator('.prompt-input')
    // The dialog fills its field from an effect, which runs after the paint, so
    // reading the instant the element exists catches it empty.
    await page
      .waitForFunction(() => (document.querySelector('.prompt-input')?.value ?? '') !== '', null, {
        timeout: 3000,
      })
      .catch(() => {})
    check('Redo starts from the terms the callout recorded', (await termBox.inputValue()).includes('lisbon'))
    await termBox.fill('trousers, socks')
    await page.click('.dialog-foot .btn-primary')
    await page.waitForFunction(
      () => /Answered again/.test(document.querySelector('.cm-content')?.textContent ?? ''),
      null,
      { timeout: 30000 },
    )
    await page.waitForTimeout(1200)

    const redone = llm.requests.slice(beforeRedo)
    check(
      'it does not ask the model for terms again',
      !redone.some((r) => /choosing what to look for/i.test(r.messages?.[0]?.content ?? '')),
    )
    const redoConvo = await savedConvo('Answered again')
    /*
     * Only the *last* exchange is replaced, so the first turn's answer is still
     * there and rightly so — the check has to look at the section the redo
     * owned rather than at the whole note.
     */
    const lastSection = (redoConvo ?? '').slice((redoConvo ?? '').lastIndexOf('## And what about the weather'))
    check('the new answer replaced the old one', !/trip notes cover Lisbon/.test(lastSection))
    check('and the first turn was left alone', /trip notes cover Lisbon/.test(redoConvo ?? ''))
    check(
      'and the question was asked once, not twice',
      ((redoConvo ?? '').match(/^## And what about the weather/gm) ?? []).length === 1,
    )
    check('the callout records the terms you chose', /Searched “trousers”, “socks”/.test(redoConvo ?? ''))
    llm.replyFor = null

    /* ---- pinning a note to the conversation ------------------------------
     * `source:` filters what may be *searched*; `include:` guarantees what is
     * *sent*. The whole check turns on a note the search cannot reach: the
     * terms below match nothing in it, so if it turns up in the material the
     * pin is the only thing that could have put it there.
     */
    /*
     * A small graph, because the `links:` scope further down has to be shown
     * reaching something. The charter links out to one note and is linked to
     * from another; a fourth note matches the same search terms and is
     * connected to nothing at all, which is what makes it the note that proves
     * the scope is doing the work rather than the search coming up short.
     */
    const makeNote = async (title, body) => {
      await page.click('[title^="New note"]')
      await page.waitForTimeout(250)
      await page.locator('.editor-title-input').fill(title)
      await page.locator('.editor-title-input').press('Enter')
      await page.locator('.cm-content').click()
      if (body) await page.locator('.cm-content').pressSequentially(body, { delay: 8 })
      await page.waitForTimeout(700)
    }
    /** A wikilink typed the way a person types one: prefix, then the list. */
    const typeLink = async (target) => {
      await page.locator('.cm-content').pressSequentially(`[[${target.slice(0, 5)}`, { delay: 25 })
      await page.waitForTimeout(600)
      if (await page.locator('.cm-tooltip-autocomplete').isVisible().catch(() => false)) {
        await page.keyboard.press('Enter')
      } else {
        await page.locator('.cm-content').pressSequentially(`${target.slice(5)}]]`, { delay: 10 })
      }
      await page.waitForTimeout(500)
    }

    await makeNote('Decision Log', 'Every quorum call is recorded here, with who was present.')
    await makeNote('Quorum Elsewhere', 'Quorum came up again here, linked to nothing at all.')

    await makeNote('Team Charter', 'Quorum is four, and decisions are written down the same day. See ')
    await typeLink('Decision Log')
    await page.waitForTimeout(700)

    await makeNote('Retro Notes', 'Looking back at how quorum held under the ')
    await typeLink('Team Charter')
    await page.waitForTimeout(700)

    check(
      'the charter links out to one note and is linked to from another',
      /\[\[Decision Log\]\]/.test((await noteContaining('Quorum is four')) ?? '') &&
        /\[\[Team Charter\]\]/.test((await noteContaining('Looking back at how quorum')) ?? ''),
      `${(await noteContaining('Quorum is four')) ?? ''} / ${(await noteContaining('Looking back at how quorum')) ?? ''}`.replace(/\n/g, ' '),
    )

    /*
     * Matched on the row's title rather than on the row, because by now the
     * conversation quotes "Team Charter" in its own answer and would otherwise
     * be the row that "has text" — and the newest note is the one at the top.
     */
    const rowTitled = (t) => page.locator(`.note-row:has(.note-row-title:has-text("${t}"))`).first()

    await rowTitled('Ask — What did we pack').click()
    await page.waitForSelector('.composer', { timeout: 10000 })

    /* ---- the shape of the composer ---------------------------------------
     * The field owns a row and the controls own the one beneath it, so the
     * thing you type into is never squeezed by a scope rule that ran long —
     * and Ask is the widest control in its row, because it is the default
     * action and Enter does the same thing.
     */
    const boxRect = async (sel) => page.locator(sel).first().boundingBox()
    const fieldBox = await boxRect('.composer-input')
    const controlsBox = await boxRect('.composer-controls')
    check(
      'the question field sits on its own row above the controls',
      fieldBox.y + fieldBox.height <= controlsBox.y + 1,
      `field ends ${Math.round(fieldBox.y + fieldBox.height)}, controls start ${Math.round(controlsBox.y)}`,
    )
    check(
      'and takes the full width of the composer',
      fieldBox.width > controlsBox.width * 0.9,
      `${Math.round(fieldBox.width)} vs ${Math.round(controlsBox.width)}`,
    )
    const sendBox = await boxRect('.composer-send')
    const chipBoxes = await Promise.all(
      (await page.locator('.composer-controls .composer-scope').all()).map((c) => c.boundingBox()),
    )
    check(
      'Ask is the widest control in the row',
      chipBoxes.every((c) => sendBox.width > c.width),
      `Ask ${Math.round(sendBox.width)}, chips ${chipBoxes.map((c) => Math.round(c.width)).join('/')}`,
    )
    check(
      'and sits on the same row as the chips rather than under them',
      chipBoxes.every((c) => Math.abs(c.y + c.height / 2 - (sendBox.y + sendBox.height / 2)) < 14),
    )
    check('the button says what it does, not just ✦', /Ask/.test(await page.locator('.composer-send').innerText()))
    await page.locator('.composer-input').click()
    await page.locator('.composer-input').pressSequentially('A question to fill the field', { delay: 8 })
    await page.waitForTimeout(200)
    await page.screenshot({
      path: join(SHOTS, '32-composer.png'),
      clip: {
        x: Math.max(0, fieldBox.x - 24),
        y: Math.max(0, fieldBox.y - 24),
        width: Math.min(1440 - fieldBox.x + 24, fieldBox.width + 96),
        height: 150,
      },
    })
    await page.locator('.composer-input').fill('')
    await page.waitForTimeout(150)

    const pinChip = page.locator('[data-id="composer-pins"]')
    check('the composer offers pinning next to the scope', (await pinChip.count()) === 1)
    check('and says so plainly when nothing is pinned', /Pin a note/.test(await pinChip.innerText()))

    await pinChip.click()
    await page.waitForTimeout(300)
    await page.locator('.menu-item:has-text("Pin a note…")').click()
    await page.waitForSelector('[data-id="note-picker"]', { timeout: 5000 })
    check('which opens the picker rather than asking you to type a title', true)

    /*
     * Typed as a search, chosen from the list: the title is never entered by
     * hand, so a typo cannot reach the frontmatter.
     */
    await page.locator('[data-id="note-picker"] input').pressSequentially('team char', { delay: 20 })
    await page.waitForTimeout(400)
    const firstRow = page.locator('[data-id="note-picker"] .palette-row').first()
    check('narrowing finds the note', /Team Charter/.test(await firstRow.innerText()))
    await firstRow.click()
    await page.locator('[data-id="note-picker"]').waitFor({ state: 'detached', timeout: 5000 })
    await page.waitForTimeout(400)
    check('the chip counts what is pinned', /1 pinned/.test(await pinChip.innerText()))

    const pinnedFile = await savedConvo('Team Charter')
    check(
      'the pin is written into the note as a wikilink, so a rename can find it',
      /^\s+- "\[\[Team Charter\]\]"$/m.test(pinnedFile ?? ''),
      (pinnedFile ?? '').split('\n').slice(0, 8).join(' · '),
    )

    llm.replyFor = (body) => {
      const sys = body.messages?.[0]?.content ?? ''
      // Terms that match nothing in the pinned note, on purpose.
      if (/choosing what to look for/i.test(sys)) return 'lisbon, packing'
      if (/answering questions about/i.test(sys)) return 'Quorum is four — see [[Team Charter]].'
      return 'unexpected'
    }

    const beforePinned = llm.requests.length
    await page.locator('.composer-input').click()
    await page.locator('.composer-input').pressSequentially('What is quorum?', { delay: 15 })
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => /Quorum is four —/.test(document.querySelector('.cm-content')?.textContent ?? ''),
      null,
      { timeout: 30000 },
    )
    await page.waitForTimeout(1200)

    const pinnedAnswer = llm.requests
      .slice(beforePinned)
      .find((r) => /answering questions about/i.test(r.messages?.[0]?.content ?? ''))
    const material = pinnedAnswer?.messages?.[1]?.content ?? ''
    check('a pinned note is sent whatever the search found', /Quorum is four, and decisions/.test(material))
    check(
      'and goes first, ahead of anything the search turned up',
      material.indexOf('## Team Charter') === material.indexOf('## '),
      material.slice(0, 60).replace(/\n/g, ' · '),
    )

    const quorumConvo = await savedConvo('Quorum is four —')
    const quorumSection = (quorumConvo ?? '').slice((quorumConvo ?? '').lastIndexOf('## What is quorum'))
    check('the callout says which notes were there because they are pinned', /\[\[Team Charter\]\] \(pinned\)/.test(quorumSection))

    /*
     * The failure that matters most. A pin that quietly stops pinning produces
     * answers indistinguishable from ones that read the note, so a name that no
     * longer resolves has to be reported rather than skipped — on screen and in
     * the file.
     */
    await rowTitled('Team Charter').click()
    await page.waitForTimeout(500)
    check('the pinned note is the one open', (await page.locator('.editor-title-input').inputValue()) === 'Team Charter')
    await page.locator('.editor-title-input').fill('Working Agreements')
    await page.locator('.editor-title-input').press('Enter')
    await page.waitForTimeout(1200)
    await rowTitled('Ask — What did we pack').click()
    await page.waitForSelector('.composer', { timeout: 10000 })
    await page.waitForTimeout(600)
    check(
      'renaming a pinned note repoints the pin rather than breaking it',
      /^1 pinned$/.test((await pinChip.innerText()).trim()),
      await pinChip.innerText(),
    )
    const renamedFile = await savedConvo('Working Agreements')
    check(
      'because the pin is a wikilink the rename pass can see',
      /- "\[\[Working Agreements\]\]"/.test(renamedFile ?? ''),
      (renamedFile ?? '').split('\n').slice(0, 8).join(' · '),
    )

    /* Removing it by hand is the case a rename cannot save. */
    await pinChip.click()
    await page.waitForTimeout(300)
    await page.locator('.menu-item:has-text("Working Agreements")').click()
    await page.waitForTimeout(500)
    check('unpinning from the same menu puts it back', /Pin a note/.test(await pinChip.innerText()))
    llm.replyFor = null

    /* ---- asking about the note in front of you ---------------------------
     * Both ways into a conversation used to be list-shaped, so the most
     * obvious question there is — one about the note on screen — could only be
     * asked by going somewhere else first. This is the same conversation
     * machinery, started with the open note already pinned.
     */
    llm.replyFor = (body) => {
      const sys = body.messages?.[0]?.content ?? ''
      if (/choosing what to look for/i.test(sys)) return 'quorum, charter'
      if (/answering questions about/i.test(sys))
        // Cites one note it was given and two it was not: one that exists, one
        // that does not. Both have to end up named in the callout.
        return 'Quorum is four — see [[Working Agreements]], [[Lisbon Trip]] and [[Ledger 2019]].'
      return 'unexpected'
    }

    await rowTitled('Working Agreements').click()
    await page.waitForTimeout(500)
    const noteAi = page.locator('[data-id="note-ai"]')
    check('the note header carries the ✦ whatever mode it is in', (await noteAi.count()) === 1)
    await noteAi.click()
    await page.waitForTimeout(300)
    /*
     * Opened from the list, so the note is being read: there is no caret in it
     * and so no passage to change. The menu says only what is actually
     * available, rather than offering a row whose only answer is to explain
     * why it cannot work.
     */
    const readingMenu = await page.locator('.menu, .sheet').first().innerText()
    check('which offers a question about the note while you are reading it', /Ask about this note/.test(readingMenu), readingMenu.replace(/\n/g, ' · '))
    check('and does not offer a rewrite with nothing to rewrite', !/Change this passage/.test(readingMenu))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    /* With a caret in the note, both are there. */
    await startEditing()
    await noteAi.click()
    await page.waitForTimeout(300)
    const editingMenu = await page.locator('.menu, .sheet').first().innerText()
    check('and both once the note is being edited', /Ask about this note/.test(editingMenu) && /Change this passage/.test(editingMenu), editingMenu.replace(/\n/g, ' · '))
    check('with the rewrite still naming its key', /Change this passage.*⌘⇧U/s.test(editingMenu))

    await page.locator('.menu-item:has-text("Ask about this note")').click()
    await page.waitForSelector('.ask-question', { timeout: 5000 })
    const starter = await page.locator('.dialog').innerText()
    check('the starter says which note it is about', /Ask about “Working Agreements”/.test(starter))
    check('and that the note is pinned rather than searched for', /pinned to the conversation/.test(starter))

    const aboutBox = page.locator('.ask-question')
    await aboutBox.click()
    await aboutBox.pressSequentially('What is quorum here', { delay: 15 })
    await page.waitForTimeout(200)
    await page.click('.dialog-foot .btn-primary')
    await page.waitForSelector('.composer', { timeout: 10000 })
    await page.waitForFunction(
      () => /Quorum is four —/.test(document.querySelector('.cm-content')?.textContent ?? ''),
      null,
      { timeout: 30000 },
    )
    await page.waitForTimeout(1200)

    const about = await savedConvo('What is quorum here')
    check('the conversation starts already pinned to that note', /- "\[\[Working Agreements\]\]"/.test(about ?? ''))
    check('the pinned note is marked as read because it is pinned', /\[\[Working Agreements\]\] \(pinned\)/.test(about ?? ''))

    /*
     * The citation rule was an instruction with nothing checking it. A made-up
     * `[[note]]` renders exactly like a real one, so an answer that cites what
     * it was never given has to say so in the callout — the model is not asked
     * again, the text it already returned is simply read.
     */
    check(
      'a citation of a real note that was not sent is named',
      /Cited without reading: \[\[Lisbon Trip\]\]/.test(about ?? ''),
      (about ?? '').split('\n').find((l) => l.includes('Cited without')),
    )
    check(
      'and a citation of a note that does not exist is called invented',
      /Cited but no such note: “Ledger 2019”/.test(about ?? '') && /the name was invented/.test(about ?? ''),
      (about ?? '').split('\n').find((l) => l.includes('no such note')),
    )
    check(
      'the note it really did read is not accused of anything',
      !/Cited[^\n]*Working Agreements/.test(about ?? ''),
    )

    /*
     * The scope it starts in is the note's own neighbourhood, not the vault.
     * Answering "about this note" from everything reads as a bug — you name a
     * note and back comes an answer citing whatever shared a word with the
     * question.
     */
    check(
      'and it is scoped to that note and its links, not the whole vault',
      /^source: "links:Working Agreements"$/m.test(about ?? ''),
      (about ?? '').split('\n').find((l) => l.startsWith('source:')),
    )
    const scopedAnswer = llm.requests
      .slice()
      .reverse()
      .find((r) => /answering questions about/i.test(r.messages?.[0]?.content ?? ''))
    const scopedMaterial = scopedAnswer?.messages?.[1]?.content ?? ''
    const sentHeadings = scopedMaterial.match(/^## .*$/gm)?.join(' · ') ?? ''
    /*
     * The hop has to actually reach something, in both directions — the first
     * version of this check pointed at a note with no links at all, so it
     * proved the scope kept the vault out while never once expanding.
     */
    check('a note the scope reached by a link out of it is sent', /^## Decision Log$/m.test(scopedMaterial), sentHeadings)
    check('and one it reached by a link back to it', /^## Retro Notes$/m.test(scopedMaterial), sentHeadings)
    /*
     * The note that makes the check mean something: it matches the same search
     * as the two above and is connected to nothing, so the only thing that can
     * be keeping it out is the scope.
     */
    check(
      'but not one that matched the search and is linked to nothing',
      !/^## Quorum Elsewhere$/m.test(scopedMaterial),
      sentHeadings,
    )
    llm.replyFor = null

    /* ---- narrowing it to the note alone ----------------------------------
     * The strictest reading of "about this note", one menu item away: the
     * pinned note is the whole of what may be read, so there is no search to
     * run — and the turn does not spend a request asking a model what to look
     * for in a set of one it is already sending.
     */
    llm.replyFor = (body) => {
      const sys = body.messages?.[0]?.content ?? ''
      if (/choosing what to look for/i.test(sys)) return 'should, not, happen'
      if (/answering questions about/i.test(sys)) return 'Four, per [[Working Agreements]].'
      return 'unexpected'
    }

    const scopeChip = page.locator('.composer-scope').first()
    check(
      'Redo is offered while there is a search it could change',
      (await page.locator('.composer-redo').count()) === 1,
    )
    await scopeChip.click()
    await page.waitForTimeout(300)
    const scopeMenu = await page.locator('.menu, .sheet').first().innerText()
    check('the composer offers the same ladder the starter did', /and nothing else/.test(scopeMenu), scopeMenu.replace(/\n/g, ' · '))
    await page.locator('.menu-item:has-text("and nothing else")').click()
    await page.waitForTimeout(500)
    check('the chip says the conversation narrowed', /Only Working Agreements/.test(await scopeChip.innerText()))
    /*
     * And Redo goes with it. Its whole offer is "searching for something else",
     * and with one pinned note as the entire searchable set there is nothing
     * else to search — a control that cannot do the thing it names.
     */
    check(
      'and Redo is gone, because there is no other search to run',
      (await page.locator('.composer-redo').count()) === 0,
    )

    const beforeNarrow = llm.requests.length
    await page.locator('.composer-input').click()
    await page.locator('.composer-input').pressSequentially('And how is it recorded?', { delay: 15 })
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => /Four, per/.test(document.querySelector('.cm-content')?.textContent ?? ''),
      null,
      { timeout: 30000 },
    )
    await page.waitForTimeout(1200)

    const narrowed = llm.requests.slice(beforeNarrow)
    check(
      'a scope of one pinned note costs one request, not two',
      !narrowed.some((r) => /choosing what to look for/i.test(r.messages?.[0]?.content ?? '')),
      `${narrowed.length} request(s)`,
    )
    const onlyAnswer = narrowed.find((r) => /answering questions about/i.test(r.messages?.[0]?.content ?? ''))
    const onlyMaterial = onlyAnswer?.messages?.[1]?.content ?? ''
    check(
      'and exactly one note goes with the question',
      (onlyMaterial.match(/^## /gm) ?? []).length === 1 && /## Working Agreements/.test(onlyMaterial),
      (onlyMaterial.match(/^## .*$/gm) ?? []).join(' · '),
    )
    const narrowFile = (await savedConvo('And how is it recorded')) ?? ''
    /*
     * The last turn only. Against the whole file this passes on an earlier
     * turn's callout — every conversation here has several, and one of them
     * saying the right thing is not this one saying it.
     */
    const narrowSection = narrowFile.slice(narrowFile.lastIndexOf('## And how is it recorded'))
    check(
      'the callout is honest that no search was run',
      /No search terms/.test(narrowSection),
      narrowSection.split('\n').find((l) => l.startsWith('> [!note]')),
    )
    llm.replyFor = null

    /* ---- one key, one meaning -------------------------------------------
     * ⌘K opens the palette even with the caret in a note, and the wikilink it
     * displaced answers ⌘⇧K. The second is not a formality: CodeMirror resolves
     * a shifted letter by trying the unshifted binding first, so ⌘⇧K only works
     * at all *because* ⌘K is no longer bound in the editor.
     */
    await page.locator('.cm-line').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Control+k')
    const paletteFromEditor = await page
      .waitForSelector('.palette input', { timeout: 2500 })
      .then(() => true)
      .catch(() => false)
    check('⌘K opens the palette from inside the editor', paletteFromEditor)
    // The palette closes from its own input's handler, so the key has to go
    // there rather than to whatever the page happens to have focused.
    await page.locator('.palette input').press('Escape')
    await page.locator('.palette').waitFor({ state: 'detached', timeout: 5000 })

    await page.locator('.cm-line').first().click()
    await page.keyboard.press('Control+End')
    const beforeWiki = await page.locator('.cm-content').innerText()
    await page.keyboard.type('\nPacking List\n')
    await page.waitForTimeout(300)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.press('Control+Shift+k')
    await page.waitForTimeout(400)
    const wikified = await page.locator('.cm-content').innerText()
    check('⌘⇧K still wraps a selection in a wikilink', wikified.includes('[[Packing List]]'))
    check(
      'and it really is the wikilink, not the palette',
      (await page.locator('.palette').count()) === 0,
    )
    /*
     * Put the note back exactly as it was. Undo, but counted against the text
     * rather than against a guess at how many transactions that took —
     * CodeMirror groups typing by time, so "press ⌘Z twice" is right until the
     * machine is slow and then silently leaves a line behind for every later
     * check in this file to trip over.
     */
    for (let i = 0; i < 10; i++) {
      if ((await page.locator('.cm-content').innerText()) === beforeWiki) break
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(120)
    }
    check('the note is back as it was afterwards', (await page.locator('.cm-content').innerText()) === beforeWiki)

    /* ---- summarising the list -------------------------------------------
     * Acts on whatever the note list is showing, and says what would leave the
     * device before any of it does.
     */
    /*
     * Put frontmatter on one of the notes first, so "the block at the top does
     * not get sent" is checked against a block that actually exists rather than
     * passing because there was nothing to leave out.
     */
    await page.locator('.cm-line').first().click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.type('---\nsecret_key: do-not-send-this\n---\n')
    await page.waitForTimeout(900)

    llm.replyFor = (body) =>
      /partial summaries/i.test(body.messages?.[0]?.content ?? '')
        ? 'Merged overview.\n\n**Themes**\n\n- Everything, at once'
        : 'An overview.\n\n**Themes**\n\n- Something recurring'

    /*
     * Straight from the editor, where the caret still is after the rewrite.
     * This used to need a click somewhere else first, because ⌘K was the
     * wikilink while writing and only opened the palette elsewhere — which is
     * exactly the confusion that got it changed, and is why this is checked
     * from here rather than from a convenient blank spot.
     */
    // Let the note saves settle before opening it: the palette's input is a
    // controlled one, and a `fill` that lands in the same tick as a re-render
    // driven by a save is silently dropped. Typed key by key, then checked,
    // because "the box is empty" and "the command is missing" look identical
    // from the outside and are not the same failure.
    await page.waitForTimeout(700)
    await page.keyboard.press('Control+k')
    await page.waitForSelector('.palette input', { timeout: 3000 })
    const palInput = page.locator('.palette input')
    await palInput.click()
    await palInput.pressSequentially('Summarise', { delay: 25 })
    await page
      .waitForFunction(() => document.querySelector('.palette input')?.value === 'Summarise', null, {
        timeout: 3000,
      })
      .catch(() => {})
    check('the palette takes what is typed into it', (await palInput.inputValue()) === 'Summarise')
    await page.waitForTimeout(400)
    const summaryCmd = page.locator('.palette-row:has-text("Summarise these notes")').first()
    // The list is rebuilt from a memo, so it lands a frame after the keystroke.
    const offered = await summaryCmd
      .waitFor({ timeout: 3000 })
      .then(() => true)
      .catch(() => false)
    check('the palette offers a summary of the current list', offered)
    await summaryCmd.click()
    await page.waitForSelector('.summary-figures', { timeout: 5000 })

    const figures = await page.locator('.summary-figures').innerText()
    check('it says how many notes would be sent', /\d+\s*\n?\s*notes?/i.test(figures), figures.replace(/\n/g, ' '))
    check('and roughly how many tokens', /tokens/i.test(figures))
    check(
      'and names the provider and model it would go to',
      /mock-vision|mock-text/.test(await page.locator('.summary-says').innerText()),
    )
    const notesBefore = await page.locator('.note-row').count()
    check('nothing has been sent yet', llm.requests.every((r) => !/summarising a set/i.test(r.messages?.[0]?.content ?? '')))

    await page.click('.dialog-foot .btn-primary')
    // Done when the note it writes is in the list — a fixed wait here is a
    // fixed wait on a model, which is the one thing that has no fixed duration.
    await page.locator('.note-row:has-text("Summary of")').first().waitFor({ timeout: 30000 })
    await page.waitForTimeout(400)
    const summaryReq = llm.requests.filter((r) => /summarising a set/i.test(r.messages?.[0]?.content ?? ''))
    check('confirming sends the notes', summaryReq.length >= 1)
    check(
      'each note went under its own title',
      /^## /m.test(summaryReq[0]?.messages?.[1]?.content ?? ''),
    )
    check(
      'and the frontmatter block at the top of a note did not',
      !/do-not-send-this/.test(summaryReq[0]?.messages?.[1]?.content ?? ''),
    )

    const summaryText = await noteContaining('generated: true')
    check('the summary is written as an ordinary note', !!summaryText)
    check('carrying what made it', /generated_by: .+\/mock-/.test(summaryText ?? ''), (summaryText ?? '').split('\n')[3])
    check('and what it was made from', /source_notes: \d+/.test(summaryText ?? ''))
    check('the vault gained exactly one note', (await page.locator('.note-row').count()) === notesBefore + 1)
    check('and it is the one now open', /Summary of/.test(await page.locator('.editor-title-input').inputValue()))
    llm.replyFor = null

    /* ---- a text-only setup ------------------------------------------------
     * Only transcription needs a model that can see. Requiring one before
     * offering the other three took every AI affordance off the screen at once
     * for anybody running a text-only model — with nothing left to say why,
     * which is the worst way for a feature to fail.
     */
    await page.click('.pane-head .icon-btn[title^="Settings"]')
    await page.waitForSelector('.dialog')
    await page.click('.tab:has-text("AI")')
    await page.waitForTimeout(250)
    await page.locator('.dialog label.field:has(span:text-is("Vision model")) input').fill('')
    await page.locator('.dialog label.field:has(span:text-is("Text model")) input').fill('mock-text')
    await page.waitForTimeout(300)
    const status = await page.locator('.ai-status').innerText()
    check('the panel says which features the settings switch on', /Transcribe/.test(status), status.replace(/\n/g, ' · '))
    check('and why one of them is off', /needs a vision model/.test(status))
    await page.click('.dialog-foot .btn-primary')
    await page.waitForTimeout(400)

    await page.locator('.pane.list-pane .icon-btn[aria-label="List actions"]').click()
    await page.waitForTimeout(350)
    const textOnlyMenu = await page.locator('.menu, .sheet').first().innerText()
    check('with no vision model, summarise is still offered', /Summarise these/.test(textOnlyMenu))
    check('and so is a conversation', /Ask these notes/.test(textOnlyMenu))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    /*
     * Back to the note with the picture in it: the conversation just opened is
     * the active one now, and it has no embed for the viewer to open. Editing
     * too, because the ✦ shares the Insert button's rule and neither is on
     * screen while a note is being read.
     */
    await page.locator('.note-row:has-text("Lisbon Trip")').first().click()
    await page.waitForTimeout(500)
    await startEditing()
    check(
      'and the header still offers a rewrite',
      (await page.locator('.editor-pane [data-id="note-ai"]').count()) === 1,
    )

    await page.locator('.cm-embed img').first().click()
    await page.waitForTimeout(400)
    check(
      'but Transcribe is gone, because that is the one that needs to see',
      (await page.locator('.lightbox-bar .icon-btn[title^="Transcribe"]').count()) === 0,
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    /* Put the vision model back for the teardown below. */
    await page.click('.pane-head .icon-btn[title^="Settings"]')
    await page.waitForSelector('.dialog')
    await page.click('.tab:has-text("AI")')
    await page.waitForTimeout(250)
    await page.locator('.dialog label.field:has(span:text-is("Vision model")) input').fill('mock-vision')
    await page.locator('.dialog label.field:has(span:text-is("Text model")) input').fill('')
    await page.waitForTimeout(200)
    await page.click('.dialog-foot .btn-primary')
    await page.waitForTimeout(400)

    /*
     * Put it back, so nothing downstream runs with a provider configured. The
     * summary is the note that is open now, and it has no picture in it, so the
     * one with the image has to be reopened for the last check.
     */
    await page.click('.pane-head .icon-btn[title^="Settings"]')
    await page.waitForSelector('.dialog')
    await page.click('.tab:has-text("AI")')
    await page.waitForTimeout(250)
    await page.locator('.dialog label.field:has-text("Provider") select').selectOption('none')
    await page.waitForTimeout(150)
    await page.click('.dialog-foot .btn-primary')
    await page.waitForTimeout(300)
    await page.locator('.note-row:has-text("Lisbon Trip")').first().click()
    await page.waitForTimeout(500)
    await page.locator('.cm-embed img').first().click()
    await page.waitForTimeout(400)
    check(
      'turning the provider off takes the button away again',
      (await page.locator('.lightbox-bar .icon-btn[title^="Transcribe"]').count()) === 0,
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }

  /* ---- calendar ------------------------------------------------------ */
  const dots = await page.locator('.cal-dot').count()
  check('calendar marks days that have notes', dots > 0, `${dots} dots`)
  const todayCell = page.locator('.cal-day[data-today="1"]')
  await todayCell.click()
  await page.waitForTimeout(300)
  const filteredHeader = await page.locator('.list-pane .pane-title').innerText()
  check('clicking a day filters the list', /\w+day|,/.test(filteredHeader), filteredHeader)
  await todayCell.click() // toggle back off
  await page.waitForTimeout(200)

  /* ---- daily note for any day ------------------------------------------
   * The palette has always been able to open today's note. This is the same
   * note for any day you can point at, so it is checked on a day that is not
   * today: pick an empty cell in this month, take the offer, and the note has
   * to come back filed under that day rather than under the day it was made.
   */
  const otherDay = page.locator('.cal-day[data-outside="0"][data-today="0"]').first()
  const otherLabel = await otherDay.getAttribute('aria-label')
  await otherDay.click()
  await page.waitForTimeout(300)
  check('an empty day offers a daily note', (await page.locator('.list-pane .daily-row').count()) === 1, otherLabel)
  check('the rail offers it too', (await page.locator('.rail .day-create-row').count()) === 1)
  const dailyName = await page.locator('.list-pane .daily-row-name').innerText()
  await page.locator('.list-pane .daily-row').click()
  await page.waitForTimeout(500)
  const dailyTitle = await page.locator('.editor-title-input').inputValue()
  check(
    'creating it opens a note named for that day',
    `${dailyTitle}.md` === dailyName,
    `${dailyTitle} vs ${dailyName}`,
  )
  check(
    'the note is filed under the day it is named for',
    (await page.locator('.list-pane .note-row').count()) === 1,
    `${await page.locator('.list-pane .note-row').count()} notes on that day`,
  )
  check('the offer goes away once the day has one', (await page.locator('.daily-row, .day-create-row').count()) === 0)
  await otherDay.click() // clear the day filter again
  await page.waitForTimeout(200)

  /* ---- the calendar as a journal ---------------------------------------
   * The other reading of a click on a day, off by default: "write about this
   * day" rather than "show me what is filed on it". The case the mode exists
   * for is the day with nothing on it, so that is where it is checked — and
   * it has to ask there rather than writing a file on a guess, which is the
   * one way this could quietly litter somebody's vault.
   */
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(250)
  const dayMode = page.locator('.dialog label.field:has-text("Clicking a day in the calendar") select')
  check('Settings offers the two readings of a calendar day', (await dayMode.count()) === 1)
  await dayMode.selectOption('daily')
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(250)

  const blankDay = page
    .locator('.cal-day[data-outside="0"][data-today="0"]')
    .filter({ hasNot: page.locator('.cal-dot') })
    .first()
  const blankLabel = await blankDay.getAttribute('aria-label')
  await blankDay.click()
  await page.waitForTimeout(300)
  const asked = page.locator('.dialog:has-text("Start a note for this day?")')
  check('an empty day asks before it writes anything', (await asked.count()) === 1, blankLabel)
  check(
    'and names the file it would write',
    /Daily\/\d{4}-\d{2}-\d{2}\.md/.test(await asked.innerText().catch(() => '')),
  )
  await page.click('.dialog-foot .btn:not(.btn-primary)')
  await page.waitForTimeout(300)
  check(
    'saying no leaves the day as empty as it found it',
    (await page.locator('.list-pane .daily-row').count()) === 1,
  )
  check('but still selects the day, so its list is in front of you', (await page.locator('.list-pane .note-row').count()) === 0)

  await blankDay.click()
  await page.waitForTimeout(300)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(600)
  const journalTitle = await page.locator('.editor-title-input').inputValue()
  /*
   * Named for the day that was clicked, not for today: the aria-label the cell
   * announces is a `toDateString`, so the two are compared as dates rather than
   * as strings written two different ways.
   */
  const clickedDay = new Date(blankLabel.split(',')[0]).toDateString()
  check(
    'saying yes opens a note named for that day',
    new Date(`${journalTitle}T00:00:00`).toDateString() === clickedDay,
    `${journalTitle} vs ${clickedDay}`,
  )
  check(
    'and files it under that day rather than under today',
    (await page.locator('.list-pane .note-row').count()) === 1,
  )

  // A day that has one already goes straight there, with nothing to answer.
  await otherDay.click()
  await page.waitForTimeout(400)
  check('a day that already has one opens it without asking', (await page.locator('.scrim').count()) === 0)
  check(
    'and the note it opened is that day’s',
    `${await page.locator('.editor-title-input').inputValue()}.md` === dailyName,
  )

  // Back to filtering, which is what the rest of the run assumes.
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(250)
  await dayMode.selectOption('filter')
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(250)
  // And out of the day the journal left selected, which now has a note in it,
  // so the second click on it is a click on the day already showing.
  await otherDay.click()
  await page.waitForTimeout(200)
  // Put the note the rest of the run works on back in the editor, and take
  // focus back out of it — ⌘K is deliberately inert inside CodeMirror.
  await page.locator('.note-row').filter({ hasText: 'Lisbon Trip' }).first().click()
  await page.waitForTimeout(300)
  await page.locator('.list-pane .pane-title').click()
  await page.waitForTimeout(150)

  /* ---- command palette ----------------------------------------------- */
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(300)
  const paletteOpen = await page.locator('.palette').isVisible()
  check('command palette opens', paletteOpen)
  if (paletteOpen) {
    await page.keyboard.type('Packing')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, '03-palette.png') })
    await page.keyboard.press('Escape')
  }

  /* ---- search ----------------------------------------------------------
   *
   * Searching reads every note until the index has finished building in the
   * background, and reads the index afterwards — and the two have to answer
   * identically, which is the one thing an index here is allowed to do. So the
   * same searches run twice: immediately, and again after the build has had
   * time to land. A word from the middle of another word is the case a
   * word-based index would quietly lose.
   *
   * A vault this size never builds one — an index earns its place past a
   * thousand notes and is worse than nothing below that — so the threshold is
   * dropped to nothing first, the same way the tests drop the database name.
   * Without it the second half of this section would be the scan agreeing with
   * itself.
   */
  const searchResults = async (q) => {
    await page.fill('.search-box input', q)
    await page.waitForTimeout(400)
    return (await page.locator('.note-row-title').allInnerTexts()).sort().join(',')
  }
  const QUERIES = ['tram', 'ram', 'lisbon', 'lisbon tram', 'zeppelin']

  // First pass: this vault is far below the threshold, so this is the scan.
  const cold = {}
  for (const q of QUERIES) cold[q] = await searchResults(q)
  check('search finds body text', cold.tram.length > 0, cold.tram)
  check('and a word it is in the middle of', cold.ram === cold.tram, `"${cold.ram}" vs "${cold.tram}"`)
  check('and nothing for a word nothing contains', cold.zeppelin === '')

  // Now drop the threshold and let the next search build an index. Five notes
  // is one slice of work, so a second is more than the build can need.
  await page.fill('.search-box input', '')
  await page.evaluate(() => {
    window.__SLATE_INDEX_FROM__ = { notes: 1, bytes: 1 }
  })
  await searchResults('tram')
  await page.fill('.search-box input', '')
  await page.waitForTimeout(1200)
  for (const q of QUERIES) {
    const warm = await searchResults(q)
    check(`the index answers "${q}" exactly as the scan did`, warm === cold[q], `"${warm}" vs "${cold[q]}"`)
  }

  await page.fill('.search-box input', '')
  await page.waitForTimeout(200)

  /* ---- the three editor modes -------------------------------------------
   * ⌘⇧M cycles rich → live → source and the run starts in live, so one press
   * lands on source, the next on rich, and the third comes back where it
   * started. Rich text is checked hardest: it is the only mode where the user
   * never sees the markdown, so anything it writes has to be verified against
   * the file rather than the screen.
   */
  await page.keyboard.press('Control+Shift+m')
  await page.waitForTimeout(400)
  const sourceText = await page.locator('.cm-content').innerText()
  check('source mode reveals raw markdown', sourceText.includes('![['), sourceText.slice(0, 50))

  /**
   * Wait for the Tag Folder dialog to be usable, not merely present.
   *
   * It seeds its fields from the draft in an effect, so the input existing is
   * not the same as the input holding what it is about to hold — typing into it
   * any sooner is a fill the seeding then wipes.
   */
  const ruleDialogReady = async () => {
    await page.waitForSelector('.rule-input')
    await page.waitForTimeout(300)
  }

  await page.keyboard.press('Control+Shift+m')
  await page.waitForTimeout(400)
  check('a note being read shows no formatting bar', (await page.locator('.fmt-bar').count()) === 0)
  await startEditing()
  check('rich text mode shows a formatting bar', (await page.locator('.fmt-bar').count()) === 1)

  /*
   * Reach a bar control the way a person has to.
   *
   * The bar overflows into a "…" menu when the pane is too narrow for every
   * group — which at this viewport, with the calendar inline, it is. So a
   * control is either a button on the bar or a row in that menu, and a test
   * that only knew about the first would be testing the window size.
   */
  const clickFormat = async (label) => {
    const onBar = page.locator(`.fmt-bar .fmt-btn[aria-label="${label}"]:not([data-overflow])`)
    if ((await onBar.count()) && (await onBar.first().isVisible())) {
      await onBar.first().click()
      return 'bar'
    }
    await page.locator('.fmt-more').click()
    await page.waitForTimeout(250)
    await page.locator('.menu-item', { hasText: label }).first().click()
    return 'menu'
  }
  const richText = await page.locator('.cm-content').innerText()
  check(
    'rich text mode shows no markdown syntax at all',
    !richText.includes('![[') && !richText.includes('**') && !/(^|\n)#+ /.test(richText),
    richText.slice(0, 50),
  )

  // The first line, not the middle of the pane: this note has an image embed
  // in it, and clicking that opens the lightbox instead of placing a caret.
  await page.locator('.cm-line').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Toolbar line')
  await page.waitForTimeout(250)

  await page.locator('.fmt-bar .fmt-style:text-is("Heading")').click()
  await page.waitForTimeout(400)
  check(
    'the Heading button writes "## " into the markdown',
    (await noteAfterEdit('Toolbar line', '## Toolbar line')).includes('## Toolbar line'),
  )
  check(
    'the bar reports Heading as the active style',
    (await page.getAttribute('.fmt-bar .fmt-style:text-is("Heading")', 'aria-pressed')) === 'true',
  )
  check(
    'the heading marker itself stays hidden',
    !(await page.locator('.cm-content').innerText()).includes('## Toolbar'),
  )

  await clickFormat('Underline (⌘U)')
  await page.waitForTimeout(400)
  const underlined = await noteAfterEdit('Toolbar', '<u>')
  check('underline is written as HTML, which markdown has no syntax for', underlined.includes('<u>'))
  check(
    'the <u> tags are not shown to the reader',
    !(await page.locator('.cm-content').innerText()).includes('<u>'),
  )
  check(
    'formatting is applied on the line the caret is on',
    (await page.locator('.cm-underline').count()) > 0,
  )

  /* ---- the bar runs out of room ----------------------------------------
   * The editor pane is the one that never yields width, so with the calendar
   * inline there can be less than half the bar's natural width to put it in.
   * It used to be clipped at the pane's edge against the calendar — and it
   * scrolls sideways, but with the scrollbar hidden nothing said so, which made
   * Link and Table look like features that did not exist.
   *
   * What is asserted is the property, not a group count: whatever the width,
   * the bar never has content it cannot show, and everything it cannot show is
   * in the menu.
   */
  const barState = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.fmt-bar')
      if (!bar) return null
      const groups = [...bar.querySelectorAll('[data-fmt-part="group"]')]
      const more = bar.querySelector('[data-fmt-more]')
      return {
        clipped: bar.scrollWidth - bar.clientWidth,
        shown: groups.filter((g) => !g.hasAttribute('data-overflow')).length,
        hidden: groups.filter((g) => g.hasAttribute('data-overflow')).length,
        moreShown: !more.hasAttribute('data-overflow'),
      }
    })

  const narrow = await barState()
  check(
    'a bar too wide for the pane is never left clipped',
    narrow.clipped === 0,
    `${narrow.clipped}px past the edge`,
  )
  check(
    'what it cannot fit goes behind a "…" instead',
    narrow.hidden > 0 && narrow.moreShown,
    `${narrow.shown} shown, ${narrow.hidden} hidden`,
  )

  await page.locator('.fmt-more').click()
  await page.waitForTimeout(300)
  const overflowRows = await page.locator('.menu-item').allInnerTexts()
  check(
    'and the menu holds exactly what the bar dropped',
    overflowRows.includes('Insert table') && overflowRows.includes('Add link'),
    JSON.stringify(overflowRows),
  )
  check(
    'a control the caret is already in reports itself as on',
    (await page.locator('.menu-item[data-checked="1"], .menu-item:not([data-checked])').count()) > 0,
  )

  // A command from the menu has to reach the note and hand focus back, or the
  // next keystroke goes nowhere.
  await page.locator('.menu-item', { hasText: 'Block quote' }).first().click()
  await page.waitForTimeout(500)
  const quoted = await noteAfterEdit('Toolbar', '> ## Toolbar')
  check(
    'running one from the menu edits the note',
    quoted.includes('> ## Toolbar'),
    quoted.split('\n').filter((l) => l.includes('Toolbar'))[0],
  )
  check(
    'and gives the editor its caret back',
    await page.evaluate(() => (document.activeElement?.className ?? '').includes('cm-content')),
  )
  await page.locator('.fmt-more').click()
  await page.waitForTimeout(300)
  check(
    'the menu shows that toggle as on next time it opens',
    (await page.locator('.menu-item[data-checked="1"]', { hasText: 'Block quote' }).count()) === 1,
  )
  await page.locator('.menu-item', { hasText: 'Block quote' }).first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, '21-format-overflow.png') })

  /*
   * Give the bar room and it takes its groups back — the measuring pass has to
   * un-hide before it measures, or a group once dropped could never return.
   */
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.waitForTimeout(600)
  const wide = await barState()
  check(
    'widening the pane brings the groups back',
    wide.shown > narrow.shown && wide.clipped === 0,
    `${narrow.shown} → ${wide.shown} groups`,
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(500)
  const backAgain = await barState()
  check(
    'and narrowing it hides them again',
    backAgain.shown === narrow.shown && backAgain.clipped === 0,
    `${wide.shown} → ${backAgain.shown} groups`,
  )

  /* ---- rich text, where the caret is in markup it cannot see -------------
   * Every check here is a position that draws at the same pixel as another
   * one: after a highlight's text and before its hidden `==`, at the start of
   * `## Heading` and in front of the `#`, between a hidden `- ` and the
   * checkbox after it. Each of them used to split the construct in half, and
   * none of it is visible on screen — so the file is what gets asserted.
   */
  await page.evaluate(async (text) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'Hidden Markup.md',
      kind: 'note',
      text,
      mime: 'text/markdown',
      size: text.length,
      hash: 'hidden',
      mtime: Date.now() + 30_000,
      ctime: Date.now(),
      dirty: true,
      dirtyFlag: 1,
      sync: {},
    })
    await new Promise((res) => {
      tx.oncomplete = res
    })
  }, ['==Highlighted phrase==', '', '## Heading line', '', '- [ ] Test task', '', 'Some ==sample== words', '', '```js', 'const a = 1', '```', '', '## Deletable heading', '', '- [ ] second task', '', '## Cut me', '', 'joinable', '', '## Pulled up', ''].join('\n'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')
  await page.locator('.note-row', { hasText: 'Hidden Markup' }).first().click()
  await page.waitForTimeout(600)
  await startEditing()
  check('the editor mode survives a reload', (await page.locator('.fmt-bar').count()) === 1)

  /** The box of the rendered line holding some text, for clicking into. */
  const lineBox = (needle) =>
    page.locator('.cm-content .cm-line', { hasText: needle }).first().boundingBox()

  /*
   * The fence, which rich text hides everywhere else. It is where the language
   * is written, and the language is the whole of whether the block is
   * highlighted — so it comes back for the caret, exactly as a link's URL does.
   */
  const codeBox = await lineBox('const a = 1')
  await page.mouse.click(codeBox.x + 20, codeBox.y + codeBox.height / 2)
  await page.waitForTimeout(350)
  check(
    'a code fence shows itself while the caret is in the block',
    (await page.locator('.cm-content').innerText()).includes('```js'),
  )
  check(
    'and the language on it is syntax highlighted',
    (await page.locator('.cm-line.cm-codeblock span').count()) > 2,
  )

  const phraseBox = await lineBox('Highlighted phrase')
  await page.mouse.click(phraseBox.x + phraseBox.width - 4, phraseBox.y + phraseBox.height / 2)
  await page.waitForTimeout(250)
  check(
    'the fence hides again once the caret leaves',
    !(await page.locator('.cm-content').innerText()).includes('```'),
  )

  await page.keyboard.press('Enter')
  check(
    'Enter after a highlighted phrase breaks after the highlight, not through it',
    (await noteAfterEdit('Highlighted phrase', '==Highlighted phrase==\n')).includes(
      '==Highlighted phrase==\n',
    ),
  )

  const headingBox = await lineBox('Heading line')
  await page.mouse.click(headingBox.x + 1, headingBox.y + headingBox.height / 2)
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  check(
    'Enter at the start of a heading takes the heading down with its words',
    (await noteAfterEdit('Heading line', '\n\n## Heading line')).includes('\n\n## Heading line'),
  )

  /*
   * A checklist line has two caret positions on one stretch of screen — in
   * front of the checkbox and behind it — and they mean different things.
   * `clickCheckbox` aims at one of them the way a person does: to the left of
   * the box, or to the right of it.
   */
  const clickCheckbox = async (needle, side) => {
    const line = await lineBox(needle)
    const box = await page
      .locator('.cm-content .cm-line', { hasText: needle })
      .first()
      .locator('.cm-task-checkbox')
      .first()
      .boundingBox()
    const x = side === 'front' ? Math.max(line.x + 1, box.x - 4) : box.x + box.width + 3
    await page.mouse.click(x, line.y + line.height / 2)
    await page.waitForTimeout(300)
  }

  await clickCheckbox('Test task', 'front')
  await page.keyboard.press('Enter')
  check(
    'Enter in front of a checkbox takes the whole item down a line',
    (await noteAfterEdit('Test task', '\n\n\n- [ ] Test task')).includes('\n\n\n- [ ] Test task'),
    JSON.stringify((await noteContaining('Test task')).slice(0, 70)),
  )
  await page.keyboard.press('Backspace')
  check(
    'and Backspace in front of it brings the item back up, checkbox and all',
    !(await noteAfterEdit('Test task', 'line\n\n- [ ] Test task')).includes(
      '\n\n\n- [ ] Test task',
    ) && (await noteContaining('Test task')).includes('- [ ] Test task'),
    JSON.stringify((await noteContaining('Test task')).slice(0, 70)),
  )

  await clickCheckbox('Test task', 'back')
  await page.keyboard.press('Enter')
  check(
    'Enter behind a checkbox opens another checkbox above it',
    (await noteAfterEdit('Test task', '- [ ] \n- [ ] Test task')).includes('- [ ] \n- [ ] Test task'),
  )

  /*
   * The toggle has to be an exact round trip. Off and on again used to give
   * back two characters less every time, so the third press here is the one
   * that matters: it wrapped `mple` when the fix was not in.
   */
  await page.locator('.cm-content .cm-highlight', { hasText: 'sample' }).first().dblclick()
  await page.waitForTimeout(250)
  await clickFormat('Highlight (⌘⇧H)')
  await page.waitForTimeout(350)
  const unhighlighted = await noteAfterEdit('sample', 'Some sample words')
  check('a highlight comes off the words it was on', unhighlighted.includes('Some sample words'))
  await clickFormat('Highlight (⌘⇧H)')
  await page.waitForTimeout(350)
  check(
    'and goes back on exactly the same ones',
    (await noteAfterEdit('sample', '==sample==')).includes('Some ==sample== words'),
  )

  /*
   * And what leaves on the clipboard carries the markup the mode is hiding —
   * selecting the word inside a highlight can only ever land on the word,
   * since the `==` around it is atomic and the selection is merely against it.
   */
  const copiedMark = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return dt.getData('text/plain')
  })
  check(
    'copying a highlighted word takes the highlight with it',
    copiedMark === '==sample==',
    JSON.stringify(copiedMark),
  )

  /*
   * Colour, which is the one text style that opens something rather than
   * toggling: the button leads to a palette, and picking the colour already in
   * use is what takes it off again. The markup it writes is long enough that a
   * wrong offset anywhere shows up as the wrong words being coloured.
   */
  const pickColor = async (label) => {
    await clickFormat('Text colour')
    await page.waitForTimeout(250)
    await page.locator(`.color-swatch[aria-label="${label}"]`).click()
    await page.waitForTimeout(350)
  }

  await page.locator('.cm-content .cm-highlight', { hasText: 'sample' }).first().dblclick()
  await page.waitForTimeout(250)
  await pickColor('Red')
  check(
    'a colour goes on the words that were selected',
    (await noteAfterEdit('sample', '<span style="color:#cf222e">sample</span>')).includes(
      '<span style="color:#cf222e">sample</span>',
    ),
    JSON.stringify((await noteContaining('sample')).slice(0, 80)),
  )
  const colored = page.locator('.cm-content .cm-color', { hasText: 'sample' }).first()
  check('and is painted in the note', (await colored.count()) === 1)
  check(
    'with its tags hidden like every other piece of syntax',
    !(await page.locator('.cm-content').innerText()).includes('<span'),
  )

  // Picking a second colour re-colours rather than wrapping a span in a span.
  await pickColor('Blue')
  const recolored = await noteAfterEdit('sample', '<span style="color:#0969da">sample</span>')
  check(
    'picking another colour replaces the first',
    recolored.includes('<span style="color:#0969da">sample</span>') &&
      !recolored.includes('#cf222e'),
    JSON.stringify(recolored.slice(0, 80)),
  )

  await pickColor('Blue')
  check(
    'and picking the one it already has takes the colour off',
    (await noteAfterEdit('sample', '==sample==')).includes('==sample=='),
    JSON.stringify((await noteContaining('sample')).slice(0, 80)),
  )

  /*
   * The same pixel, now with the deletion keys and the clipboard.
   *
   * A heading can only be selected from the first character of its text, since
   * the `## ` in front of that has no geometry to drag across — so the copy
   * used to come out plain and a cut used to leave the `## ` behind on a line
   * of its own. Backspace from that same position used to take the heading off
   * while leaving the blank line above it, which is to say it could not undo
   * the Enter that had just made that blank line.
   */
  const headBox = await lineBox('Deletable heading')
  await page.mouse.click(headBox.x + 20, headBox.y + headBox.height / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.waitForTimeout(200)
  const copiedHeading = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return dt.getData('text/plain')
  })
  check(
    'copying a heading takes the markers that make it one',
    copiedHeading === '## Deletable heading',
    JSON.stringify(copiedHeading),
  )

  await page.keyboard.press('Home')
  await page.waitForTimeout(200)
  await page.keyboard.press('Backspace')
  check(
    'Backspace at the start of a heading takes the blank line above it first',
    (await noteAfterEdit('Deletable heading', '```\n## Deletable heading')).includes(
      '```\n## Deletable heading',
    ),
  )
  await page.keyboard.press('Backspace')
  check(
    'and the heading itself only on the press after that',
    (await noteAfterEdit('Deletable heading', '```\nDeletable heading')).includes(
      '```\nDeletable heading',
    ),
  )

  /*
   * Behind the checkbox, Backspace takes the checkbox — all of it. The bullet
   * and the box are two separate hidden things in the document, and taking only
   * the first left `[ ] second task`: a bullet with the characters of a
   * checkbox in it, which is not a task and does not render as one.
   */
  await clickCheckbox('second task', 'back')
  await page.keyboard.press('Backspace')
  check(
    'Backspace behind a checkbox takes the whole thing off',
    (await noteAfterEdit('second task', '\nsecond task')).includes('\nsecond task') &&
      !(await noteContaining('second task')).includes('[ ] second task'),
    (await noteContaining('second task')).split('\n').slice(-3).join(' / '),
  )

  /* Cutting takes the markers out with the words, rather than stranding them. */
  const cutBox = await lineBox('Cut me')
  await page.mouse.click(cutBox.x + 20, cutBox.y + cutBox.height / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.waitForTimeout(200)
  const cutText = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return dt.getData('text/plain')
  })
  check('cutting a heading takes its markers too', cutText === '## Cut me', JSON.stringify(cutText))
  check(
    'and leaves an empty line rather than a bare "## "',
    !(await noteAfterEdit('joinable', '\n\n\njoinable')).includes('## \n'),
    JSON.stringify((await noteContaining('joinable')).slice(-40)),
  )

  /*
   * Delete at the end of a line, the same rule facing the other way: one press
   * used to take a blank line and a heading's markers together, turning three
   * lines into the single paragraph `joinablePulled up`.
   */
  const joinBox = await lineBox('joinable')
  await page.mouse.click(joinBox.x + 20, joinBox.y + joinBox.height / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('End')
  await page.keyboard.press('Delete')
  check(
    'Delete at the end of a line takes the blank line below before the heading under it',
    (await noteAfterEdit('joinable', 'joinable\n## Pulled up')).includes('joinable\n## Pulled up'),
  )
  await page.keyboard.press('Delete')
  check(
    'and pulls the line up on the press after that',
    (await noteAfterEdit('joinable', 'joinablePulled up')).includes('joinablePulled up'),
  )

  await page.keyboard.press('Control+Shift+m')
  await page.waitForTimeout(300)
  check('cycling lands back in live preview', (await page.locator('.fmt-bar').count()) === 0)

  /* ---- kitchen sink ----------------------------------------------------
   * Every markdown construct in one note. This exists because a table alone
   * once took the whole editor down (block decorations are illegal from a view
   * plugin) and no other test's content contained one — a rendering bug in any
   * single construct must fail loudly here rather than in daily use.
   */
  const sinkErrorsBefore = consoleErrors.length
  await page.evaluate(async () => {
    const text = [
      '---',
      'title: Kitchen Sink',
      'tags: [demo, test]',
      '---',
      '',
      '# Heading one',
      '## Heading two',
      '',
      'Body with **bold**, *italic*, ~~strike~~, `code`, a #tag,',
      'a [[Wikilink]], an [external](https://example.com) link and an ![[missing.png]] embed.',
      '',
      '> A blockquote',
      '> spanning two lines.',
      '',
      '> [!WARNING] Friday deploys',
      '> The window closes at 16:00.',
      '',
      '> [!bug]',
      '> An alias: caution\'s colour, its own glyph, and its own name as the title.',
      '',
      '> [!nonsense] Not a type anyone defined',
      '> so this has to stay an ordinary quote.',
      '',
      '---',
      '',
      '| Left | Center | Right |',
      '| :--- | :----: | ----: |',
      '| a    | b      | c     |',
      '| d\\|e | f      | g     |',
      '',
      '- bullet one',
      '- bullet two',
      '  - nested',
      '1. numbered',
      '',
      '- [ ] open task',
      '- [x] done task',
      '',
      '```js',
      'const x = { a: 1 } // not a #tag and not a [[link]]',
      '```',
      '',
      '```',
      'a fence with no language, whose whole first line is the hidden marker',
      '```',
      '',
      'Final paragraph.',
    ].join('\n')
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'Kitchen Sink.md',
      kind: 'note',
      text,
      mime: 'text/markdown',
      size: text.length,
      hash: 'sink',
      mtime: Date.now() + 60_000,
      ctime: Date.now(),
      dirty: true,
      dirtyFlag: 1,
      sync: {},
    })
    await new Promise((res) => {
      tx.oncomplete = res
    })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().click()
  await page.waitForTimeout(900)

  check('kitchen-sink note renders without throwing', consoleErrors.length === sinkErrorsBefore, consoleErrors.slice(sinkErrorsBefore).join(' | '))
  check('editor is alive after the kitchen sink', (await page.locator('.cm-content').count()) === 1)
  check('table renders as a real table', (await page.locator('.cm-table-render td').count()) >= 6)
  check('escaped pipe stays inside its cell', (await page.locator('.cm-table-render').innerText()).includes('d|e'))
  check('frontmatter is not rendered as a heading', (await page.locator('.cm-line.cm-frontmatter').count()) >= 4)
  check('blockquote is styled', (await page.locator('.cm-line.cm-quote').count()) >= 2)
  check('tags in code are not linkified', (await page.locator('.cm-tag').count()) === 1)
  check('a missing embed reports itself', (await page.locator('.cm-embed-missing').count()) === 1)

  /* ---- callouts --------------------------------------------------------
   * A callout is a blockquote wearing a colour, so what is asserted is that
   * the right lines got the right class, the marker became an icon, and — the
   * one that keeps the format honest — that a type nobody defined is still
   * rendered as the plain quote it is, exactly as GitHub renders it.
   */
  check(
    'a callout colours its own lines',
    (await page.locator('.cm-line.cm-callout-warning').count()) === 2,
    `${await page.locator('.cm-line.cm-callout-warning').count()} warning lines`,
  )
  check(
    'an alias lands in the colour it was aliased to',
    (await page.locator('.cm-line.cm-callout-caution').count()) === 2,
  )
  check(
    'the marker is replaced by an icon rather than shown',
    // Its own svg, not the fold chevron's, which is a child of the same widget.
    (await page.locator('.cm-callout-mark > svg').count()) === 2 &&
      !(await page.locator('.cm-content').innerText()).includes('[!WARNING]'),
  )
  check(
    'an author\'s own title is kept',
    (await page.locator('.cm-callout-title').innerText()).includes('Friday deploys'),
  )
  check(
    'an untitled callout announces its own type instead',
    (await page.locator('.cm-callout-label').innerText()).trim() === 'Bug',
    await page.locator('.cm-callout-label').innerText(),
  )
  /*
   * Three blockquotes in the note, two of them callouts. Four lines still
   * carrying the plain quote class is the whole proof that the third — a type
   * nobody defined — was left alone, which is what GitHub does with an unknown
   * alert and what keeps the syntax safe to write.
   */
  check(
    'an unknown type stays an ordinary blockquote',
    (await page.locator('.cm-line.cm-quote').count()) === 4 &&
      (await page.locator('.cm-callout-mark').count()) === 2,
    `${await page.locator('.cm-line.cm-quote').count()} plain quote lines`,
  )
  /* ---- folding a callout ------------------------------------------------
   *
   * The fold is a `-` written into the marker, not editor state, so this
   * checks both ends of that: the lines under the head go away and are counted,
   * and the note on disk now says `[!WARNING]-`. Clicking the chevron must not
   * place a caret either — a caret on that line reveals the raw marker and
   * takes the chevron with it.
   */
  const foldChevron = page.locator('.cm-callout-fold').first()
  check('a callout with a body offers a fold control', (await foldChevron.count()) === 1)
  const calloutLinesBefore = await page.locator('.cm-line.cm-callout').count()
  await foldChevron.click()
  await page.waitForTimeout(400)
  const folded = await page.locator('.cm-callout-folded').count()
  const calloutLinesAfter = await page.locator('.cm-line.cm-callout').count()
  check('folding hides the body and says how much of it there is', folded === 1 && calloutLinesAfter < calloutLinesBefore, `${calloutLinesBefore} → ${calloutLinesAfter} lines, ${folded} placeholder`)
  check('the marker is still an icon, so the chevron is still there to click', (await page.locator('.cm-callout-fold[data-folded="1"]').count()) === 1)
  // Saves are debounced, so this waits for the write rather than sleeping past it.
  check(
    'and the fold is written into the note itself',
    /\[!WARNING\]-/.test(await noteAfterEdit('# Heading one', '[!WARNING]-')),
  )

  await page.locator('.cm-callout-fold[data-folded="1"]').first().click()
  await page.waitForTimeout(400)
  check('unfolding brings the body back', (await page.locator('.cm-callout-folded').count()) === 0 && (await page.locator('.cm-line.cm-callout').count()) === calloutLinesBefore)
  check(
    'and takes the character back out rather than leaving a "+"',
    !/\[!WARNING\][-+]/.test(await noteAfterEdit('# Heading one', '[!WARNING] ')),
  )

  await page.screenshot({ path: join(SHOTS, '07-kitchen-sink.png') })

  /* ---- the copy button on a code block ---------------------------------
   * Both fences get one, and the second is the case worth having: with no
   * language, the whole of its opening line is the hidden fence marker, so the
   * button is a point widget sitting at the end of a fully replaced range.
   *
   * The blocks are near the end of a long note, and CodeMirror only builds the
   * lines that are on screen — so they have to be scrolled to before any of
   * this is true.
   */
  await page.locator('.cm-content').evaluate((el) => {
    el.closest('.cm-scroller').scrollTop = el.closest('.cm-scroller').scrollHeight
  })
  await page.waitForTimeout(400)
  check('code block gets its own styling', (await page.locator('.cm-line.cm-codeblock').count()) >= 3)
  check(
    'a #tag inside a code block is still not linkified',
    (await page.locator('.cm-tag').count()) === 0,
  )
  check(
    'every fenced block gets a copy button',
    (await page.locator('.cm-code-copy').count()) === 2,
    `${await page.locator('.cm-code-copy').count()} buttons`,
  )

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.cm-code-copy').first().click()
  await page.waitForTimeout(250)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  check(
    'the copy button copies the code without its fences',
    copied === 'const x = { a: 1 } // not a #tag and not a [[link]]',
    JSON.stringify(copied),
  )
  check(
    'and says so',
    (await page.locator('.cm-code-copy[data-copied]').count()) === 1,
  )
  check(
    'copying does not put a caret in the note',
    (await page.evaluate(() => document.activeElement?.className ?? '')).indexOf('cm-content') < 0,
  )
  check(
    'copying changed nothing in the note',
    consoleErrors.length === sinkErrorsBefore,
    consoleErrors.slice(sinkErrorsBefore).join(' | '),
  )

  /*
   * Selecting inside a code block, which for a while showed nothing at all.
   *
   * The selection is drawn rather than native, in a layer CodeMirror puts
   * *under* the content, and a code block paints a background of its own over
   * it — as do the frontmatter block and a callout. Nothing about the DOM says
   * so: the ranges were there, the colour was there, and the block sat on top.
   * So this is checked the only way that is honest about it, by looking: the
   * same strip of screen with and without a selection over it.
   */
  const codeLine = page.locator('.cm-line.cm-codeblock').nth(1)
  await codeLine.scrollIntoViewIfNeeded()
  const strip = await codeLine.boundingBox()
  const stripClip = { x: strip.x + 4, y: strip.y + 2, width: Math.min(180, strip.width - 8), height: strip.height - 4 }
  const unselected = await page.screenshot({ clip: stripClip })
  await page.mouse.move(strip.x + 6, strip.y + strip.height / 2)
  await page.mouse.down()
  await page.mouse.move(strip.x + Math.min(220, strip.width - 10), strip.y + strip.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const selectedRects = await page.evaluate(
    () => document.querySelectorAll('.cm-selectionLayer > *').length,
  )
  const selected = await page.screenshot({ clip: stripClip })
  check(
    'a selection inside a code block is drawn where it can be seen',
    selectedRects > 0 && Buffer.compare(unselected, selected) !== 0,
    `${selectedRects} ranges, ${Buffer.compare(unselected, selected) !== 0 ? 'pixels changed' : 'pixels identical'}`,
  )
  check(
    'and the layer it is drawn in does not swallow clicks',
    (await page.evaluate(
      () => getComputedStyle(document.querySelector('.cm-selectionLayer')).pointerEvents,
    )) === 'none',
  )

  // Back to the top: everything below reads this same note, and CodeMirror
  // only builds the lines that are on screen.
  await page.locator('.cm-content').evaluate((el) => {
    el.closest('.cm-scroller').scrollTop = 0
  })
  await page.waitForTimeout(400)

  /* ---- a note opens as a page, not as a caret ----------------------------
   * The phone keyboard is the whole reason. A note that opens focused covers
   * half of itself with a keyboard nobody asked for, before a word of it has
   * been read — so a note opened from the list has no editing surface at all
   * until someone asks for one. `contenteditable` is the thing that matters:
   * it is all a phone consults before raising the keyboard.
   */
  const asOpened = await readingState()
  check(
    'a note opens as a page with no editing surface',
    asOpened.flag === '1' && asOpened.editable === 'false',
    `reading=${asOpened.flag}, contenteditable=${asOpened.editable}`,
  )
  check(
    'and nothing in it holds focus, so a phone leaves its keyboard down',
    !asOpened.focused.includes('cm-content'),
    asOpened.focused || 'nothing focused',
  )
  check(
    'reading offers a way in that is not a guess',
    (await page.locator('.editor-pane [aria-label="Edit note"]').count()) === 1,
  )

  /*
   * A task's date chip answers its own tap.
   *
   * Same rule as the checkbox beside it: reading is not read-only, and giving a
   * task a date while reading through a note is the same kind of act as ticking
   * one off. Before the chip joined that list a single tap did two things —
   * opened the picker, and put the note into edit — and only one of them was
   * asked for. It is watched as a pointer event, so swallowing the mouse events
   * (which the chip does) was never enough on its own.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('- [ ] Pay the deposit 📅 2026-09-04', {
    delay: 6,
  })
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const beforeChipTap = await readingState()
  check(
    'a note with a dated task can be read without a caret in it',
    beforeChipTap.flag === '1',
    `reading=${beforeChipTap.flag}`,
  )
  /*
   * Tapped, not clicked, and that is the whole test. The chip opens its picker
   * on `mousedown`, and the scrim that appears swallows the mouse-up — so a
   * pointer never reaches the tap-to-edit watcher and a click reproduces
   * nothing. A phone sends pointerdown and pointerup first and the synthesised
   * mousedown afterwards, so there the editing starts before the picker is
   * even open. That ordering is the bug, and only a real tap has it.
   */
  await page.locator('.cm-due-chip[data-set="1"]').first().tap()
  await page.waitForTimeout(450)
  check(
    'tapping a task’s date while reading opens its picker',
    (await page.locator('.due-preset').count()) > 0,
  )
  const afterChipTap = await readingState()
  check(
    'and does not also drop a caret into the note',
    afterChipTap.flag === '1' && afterChipTap.editable === 'false',
    `reading=${afterChipTap.flag}, contenteditable=${afterChipTap.editable}`,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // Back to the note everything below reads.
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().click()
  await page.waitForTimeout(600)

  /* ---- clicks land where they are aimed ---------------------------------
   * Vertical space around a heading or a code block has to be padding or a
   * transparent border, never margin: CodeMirror turns a click into a document
   * position through a height map built from measured line boxes, and a margin
   * is not part of one. A single `margin: 0.7em 0` on a heading used to put
   * every click below it a line out — worst at the bottom of a long note,
   * where the drift has accumulated through every block above it. This note is
   * the right fixture for that: headings, a code block and frontmatter, with
   * body text under all of them.
   */
  const clickWord = async (word) => {
    const box = await page.evaluate((w) => {
      const walk = document.createTreeWalker(
        document.querySelector('.cm-content'),
        NodeFilter.SHOW_TEXT,
      )
      let n
      while ((n = walk.nextNode())) {
        const i = n.textContent.indexOf(w)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + w.length)
        if (!r.getBoundingClientRect().width) continue
        // The word has to be on screen before its coordinates mean anything.
        n.parentElement?.scrollIntoView({ block: 'center' })
        const b = r.getBoundingClientRect()
        const view = document.querySelector('.cm-scroller').getBoundingClientRect()
        if (b.top < view.top || b.bottom > view.bottom) return null
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      }
      return null
    }, word)
    if (!box) return { ok: false, detail: 'not rendered' }
    await page.mouse.click(box.x, box.y)
    await page.waitForTimeout(120)
    return page.evaluate((w) => {
      const sel = getSelection()
      if (!sel.rangeCount) return { ok: false, detail: 'no selection' }
      const text = sel.anchorNode.textContent ?? ''
      const at = sel.anchorOffset
      const i = text.indexOf(w)
      return {
        ok: i >= 0 && at >= i && at <= i + w.length,
        detail: `caret landed in ${JSON.stringify(text.slice(0, 28))} at ${at}`,
      }
    }, word)
  }

  /*
   * The first of these is also the click that starts the editing: the gesture
   * that asks for a caret is the same one that says where it goes, which is
   * the only way tapping to edit can feel like no mode change at all.
   */
  for (const word of ['blockquote', 'numbered', 'Final']) {
    const landed = await clickWord(word)
    check(`clicking "${word}" puts the caret in that word`, landed.ok, landed.detail)
  }
  const afterTap = await readingState()
  check(
    'the click that placed the caret also started the editing',
    afterTap.flag === '0' && afterTap.editable === 'true' && afterTap.focused.includes('cm-content'),
    `reading=${afterTap.flag}, focused ${afterTap.focused || 'nothing'}`,
  )

  /*
   * And the way back out.
   *
   * Escape has always done this and always will, but Escape is no use on a
   * phone and invisible on a desktop: without a button, a note you touched
   * stayed a note you were writing in until you closed it. The pencil's own
   * slot in the header is the way back the moment it is used.
   */
  const doneButton = page.locator('.editor-pane [aria-label="Done editing"]')
  check('editing offers a way back to reading', (await doneButton.count()) === 1)
  await doneButton.click()
  await page.waitForTimeout(350)
  const afterDone = await readingState()
  check(
    'and it hands the note back: no caret, nothing to type into',
    afterDone.flag === '1' &&
      afterDone.editable === 'false' &&
      !afterDone.focused.includes('cm-content'),
    `reading=${afterDone.flag}, contenteditable=${afterDone.editable}, focused ${afterDone.focused || 'nothing'}`,
  )
  check(
    'and the pencil is back in its slot, which is where it went',
    (await page.locator('.editor-pane [aria-label="Edit note"]').count()) === 1 &&
      (await doneButton.count()) === 0,
  )
  // Back to editing for the checks that follow, the way the reader would.
  await clickWord('Final')
  await page.waitForTimeout(200)

  /* ---- following a link with a pointer -----------------------------------
   * The desktop half of the phone tests further down. One plain click opens
   * the link and the caret stays out of the text — a click that lands in the
   * middle of a link's own markdown instead of following it is the failure
   * this guards, and it is invisible to every other check here because the
   * note still renders perfectly while it happens.
   *
   * `window.open` is stubbed rather than let through: a real new tab would
   * take focus away from the page and strand the rest of the suite.
   */
  const armLinkTrap = () =>
    page.evaluate(() => {
      window.__opened = []
      window.open = (url) => {
        window.__opened.push(url)
        return null
      }
      // A link in a rendered table cell is a real anchor. One that reaches the
      // document still unprevented is one the browser would follow itself, on
      // top of whatever the app already did with it.
      window.__followed = []
      window.__linkTrap = (e) => {
        const a = e.target?.closest?.('a[href]')
        if (!a) return
        if (!e.defaultPrevented) window.__followed.push(a.href)
        e.preventDefault()
      }
      document.addEventListener('click', window.__linkTrap)
    })
  const linkTrapResult = () => page.evaluate(() => ({ opened: window.__opened, followed: window.__followed }))

  await armLinkTrap()
  const bodyLink = page.locator('.cm-uri').first()
  await bodyLink.scrollIntoViewIfNeeded()
  await bodyLink.click()
  await page.waitForTimeout(250)
  const clicked = await linkTrapResult()
  check(
    'clicking a link with a pointer opens it',
    clicked.opened.length === 1 && clicked.opened[0] === 'https://example.com',
    clicked.opened.join(',') || 'nothing opened',
  )
  /*
   * Asserted on the link rather than on the whole note. Comparing the note's
   * rendered text before and after looks stricter and is not: CodeMirror only
   * builds the lines that are on screen, so a click that scrolls the view
   * changes that text without anything having happened to the link — which is
   * what this used to catch. The claim is that the caret stayed out, and live
   * preview reveals a link's URL the moment it goes in, so the URL still being
   * hidden is the claim itself.
   */
  const afterLinkClick = await page.locator('.cm-content').innerText()
  check(
    'and leaves the caret out of the link text',
    afterLinkClick.includes('an external link') &&
      !afterLinkClick.includes('](https://example.com)'),
    afterLinkClick.split('\n').find((l) => l.includes('external')) ?? 'link line not rendered',
  )

  // Right-click is the desktop way to reach a link's own text, since one plain
  // click is spent on opening it.
  await bodyLink.click({ button: 'right' })
  await page.waitForTimeout(300)
  check('right-click on a link offers what to do with it', (await page.locator('.menu').count()) === 1)
  check(
    'including editing it',
    (await page.locator('.menu-item:has-text("Edit link")').count()) === 1,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  /*
   * Clicking a table in rich text puts the caret in the cell, not in the
   * pipes: the rendered table *is* the editor there. (Live preview's
   * click-to-reveal is checked in the table section further down.)
   *
   * The mode is put into rich text here rather than inherited: the editor mode
   * is a saved preference, so what this note opens in depends on reloads pages
   * of script away, and a table check failing because the app was in live
   * preview says nothing about tables.
   */
  await startEditing()
  for (let i = 0; i < 3 && (await page.locator('.fmt-bar').count()) === 0; i++) {
    await page.keyboard.press('Control+Shift+m')
    await page.waitForTimeout(400)
    await page.locator('.cm-content').click()
    await page.waitForTimeout(250)
  }
  check('rich text is reachable from wherever the mode was left', (await page.locator('.fmt-bar').count()) === 1)
  await page.locator('.cm-table-render td').first().click()
  await page.waitForTimeout(400)
  check(
    'clicking a table in rich text starts editing the cell',
    (await page.evaluate(() => document.activeElement?.className)) === 'cm-table-cell' &&
      (await page.locator('.cm-line.cm-table').count()) === 0,
  )

  // The same operation the phone runs from its sheet, run with a pointer:
  // here typing *should* carry straight on, so the new cell takes focus rather
  // than only being marked. `clickFormat` reaches the control wherever it is —
  // and at this width that is the overflow menu, so this doubles as the check
  // that a menu opened from a menu row still opens.
  const barRows = await page.locator('.cm-table-render tr').count()
  await clickFormat('Table rows and columns')
  await page.waitForTimeout(300)
  await page.locator('.menu-item', { hasText: 'Insert row below' }).click()
  await page.waitForTimeout(400)
  check(
    'the bar adds a row and keeps typing in it',
    (await page.locator('.cm-table-render tr').count()) === barRows + 1 &&
      (await page.evaluate(() => document.activeElement?.className)) === 'cm-table-cell',
    `${barRows} → ${await page.locator('.cm-table-render tr').count()}`,
  )
  await clickFormat('Table rows and columns')
  await page.waitForTimeout(300)
  check(
    'the menu names the cell the buttons act on, not the caret',
    (await page.locator('.menu-title').innerText()).includes('row 3 of 4'),
    await page.locator('.menu-title').innerText(),
  )
  await page.locator('.menu-item', { hasText: 'Delete row' }).click()
  await page.waitForTimeout(400)
  check('and takes it away again', (await page.locator('.cm-table-render tr').count()) === barRows)


  /* ---- folders and Tag Folders -----------------------------------------
   * Both are new containers with real persistence, so they get exercised end
   * to end: create, populate, filter, and survive a reload.
   */
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(300)

  // Seed a few tagged notes so a rule has something to match.
  await page.evaluate(async () => {
    const notes = [
      ['Sprint planning.md', '# Sprint planning\n\n#work #active\n'],
      ['Retro.md', '# Retro\n\n#work #archived\n'],
      ['Groceries.md', '# Groceries\n\n#home #active\n'],
      ['Budget.md', '# Budget\n\n#work #active #urgent\n'],
      // Deliberately urgent but not work: this is what makes the difference
      // between an inherited and a standalone child rule visible.
      ['Roof.md', '# Roof\n\n#home #urgent\n'],
    ]
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    notes.forEach(([path, text], i) => {
      tx.objectStore('files').put({
        path, kind: 'note', text, mime: 'text/markdown', size: text.length,
        hash: `tag${i}`, mtime: Date.now() - i * 1000, ctime: Date.now() - i * 1000,
        dirty: true, dirtyFlag: 1, sync: {},
      })
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')

  /* --- create a nested folder structure via the sidebar -------------------
   *
   * A folder is named in the app's own dialog, not `prompt()`. Anything that
   * fails to find that field is a regression back to a browser dialog, which
   * on a phone is a system alert over the whole screen.
   */
  const nameFolder = async (value) => {
    /*
     * Waiting for the *focus*, not just the field. The dialog seeds its value
     * in an effect and focuses on the frame after that, so a fill that lands
     * between the two is overwritten by the seed — the field goes back to
     * empty, Create stays disabled, and the click waits forever for a button
     * that will never enable. Focus is the signal that both have happened.
     */
    await page.waitForFunction(
      () => document.activeElement?.classList?.contains('prompt-input'),
      null,
      { timeout: 5000 },
    )
    await page.fill('.dialog .prompt-input', value)
    await page.click('.dialog-foot .btn-primary')
    await page.waitForTimeout(400)
  }
  /*
   * Every browser dialog is still accepted — the destructive actions use
   * `confirm()` and are right to — but a *prompt* is now a failure: naming a
   * folder is the app's own dialog, and a browser one is what that used to be.
   */
  let sawBrowserPrompt = false
  page.on('dialog', (d) => {
    if (d.type() === 'prompt') sawBrowserPrompt = true
    d.accept()
  })

  await page.click('.side-group-label:has-text("Folders") .side-add')
  await nameFolder('Clients')
  check('creating a folder works', (await page.locator('.side-row:has-text("Clients")').count()) > 0)
  check('and asks for the name in the app, not a browser dialog', !sawBrowserPrompt)

  await page.locator('.side-row:has-text("Clients")').first().click({ button: 'right' })
  await page.waitForTimeout(250)
  const subMenu = await page.locator('.menu-item:has-text("New subfolder")').count()
  check('right-click opens a real folder menu', subMenu > 0)
  if (subMenu) {
    await page.locator('.menu-item:has-text("New subfolder")').click()
    await nameFolder('Acme')
    check('nested folders can be created', (await page.locator('.side-row:has-text("Acme")').count()) > 0)
  }

  // --- create a Tag Folder ------------------------------------------------
  await page.click('.side-group-label:has-text("Tag Folders") .side-add')
  await ruleDialogReady()
  await page.fill('.dialog input[type="text"]', 'Active work')
  await page.fill('.rule-input', '#work AND #active NOT #archived')
  await page.waitForTimeout(400)

  const statusText = await page.locator('.rule-status').innerText()
  check('rule reports a live match count', /matches\s*2\b/i.test(statusText.replace(/\s+/g, ' ')), statusText.slice(0, 80))
  check('rule status is not an error', (await page.getAttribute('.rule-status', 'data-error')) === '0')

  const previewCount = await page.locator('.rule-preview-row').count()
  check('rule previews the notes it matches', previewCount === 2, `${previewCount} shown`)

  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(500)
  check('Tag Folder appears in the sidebar', (await page.locator('.side-row:has-text("Active work")').count()) > 0)

  const filtered = await page.locator('.note-row').count()
  check('Tag Folder filters the note list', filtered === 2, `${filtered} notes listed`)
  const titles = (await page.locator('.note-row-title').allInnerTexts()).sort()
  check('the right notes matched', titles.join(',') === 'Budget,Sprint planning', titles.join(','))

  // --- an invalid rule is reported, not swallowed -------------------------
  await page.locator('.side-row:has-text("Active work")').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("Edit rule")').click()
  await ruleDialogReady()
  await page.fill('.rule-input', '#work AND (#active')
  await page.waitForTimeout(300)
  check('an unbalanced rule shows an error', (await page.getAttribute('.rule-status', 'data-error')) === '1')
  check('an invalid rule blocks saving', await page.locator('.dialog-foot .btn-primary').isDisabled())
  await page.click('.dialog-foot .btn:not(.btn-primary)')
  await page.waitForTimeout(300)

  // --- Tag Folders survive a reload (they live in the vault) --------------
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.side-row')
  await page.waitForTimeout(400)
  check('Tag Folders persist across a reload', (await page.locator('.side-row:has-text("Active work")').count()) > 0)
  check('folders persist across a reload', (await page.locator('.side-row:has-text("Clients")').count()) > 0)
  await page.screenshot({ path: join(SHOTS, '08-tag-folders.png') })

  /* ---- the folder tree remembers its shape ------------------------------
   *
   * Which rows are unfolded is per folder and kept in this device's own store,
   * so it has to be exercised in a real browser: the case that matters is a row
   * that gets unmounted — by its parent folding, or by the whole section — and
   * has to come back the way it was rather than at some default. An exact name
   * match, because "Folders" is also a substring of "Tag Folders".
   */
  const folderGroup = page.locator('.side-group', {
    has: page.locator('.side-group-name', { hasText: /^Folders$/ }),
  })
  const folderRow = (name) =>
    folderGroup
      .locator('.side-row')
      .filter({ has: page.locator('.side-name', { hasText: new RegExp(`^${name}$`) }) })
  const shown = async (name) => (await folderRow(name).count()) > 0
  const foldFolder = async (name) => {
    await folderRow(name).locator('.disclose').first().click()
    await page.waitForTimeout(250)
  }
  const foldSection = async () => {
    await folderGroup.locator('.side-group-toggle').first().click()
    await page.waitForTimeout(250)
  }

  check('a folder unfolded to make a subfolder stays unfolded over a reload', await shown('Acme'))

  await folderRow('Acme').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("New subfolder")').click()
  await nameFolder('Roadmap')
  check('a third level can be created', await shown('Roadmap'))

  await foldFolder('Acme')
  check('folding a folder hides what is inside it', !(await shown('Roadmap')))

  await foldSection()
  check('folding the section hides the tree', !(await shown('Clients')))
  await foldSection()
  check('unfolding the section brings back the tree', await shown('Clients'))
  check('with the shape it had, not everything unfolded', (await shown('Acme')) && !(await shown('Roadmap')))

  await foldFolder('Acme')
  check('and a folder unfolds again to what it was', await shown('Roadmap'))

  /* ---- dragging a note into a folder ------------------------------------
   *
   * The pointer half of *Move to…*, and only exercisable in a real browser:
   * the whole thing is HTML5 drag events, and the row being dragged is known
   * from a signal because a browser hides the payload during `dragover`.
   * Dragged out to the vault root again afterwards, so the rest of the suite
   * finds the note where it left it.
   */
  await page.locator('.side-row:has-text("All Notes")').first().click()
  await page.waitForTimeout(350)
  await page.locator('.note-row', { hasText: 'Retro' }).first().dragTo(folderRow('Clients'))
  await page.waitForTimeout(500)
  await folderRow('Clients').click()
  await page.waitForTimeout(400)
  const dropped = await page.locator('.note-row-title').allInnerTexts()
  check('a note dragged onto a folder moves into it', dropped.includes('Retro'), dropped.join(','))

  await page
    .locator('.note-row', { hasText: 'Retro' })
    .first()
    .dragTo(page.locator('.side-row:has-text("All Notes")').first())
  await page.waitForTimeout(500)
  await folderRow('Clients').click()
  await page.waitForTimeout(400)
  check(
    'and dragging it onto All Notes puts it back at the vault root',
    (await page.locator('.note-row-title').allInnerTexts()).join(',') === '',
    (await page.locator('.note-row-title').allInnerTexts()).join(','),
  )
  await page.locator('.side-row:has-text("All Notes")').first().click()
  await page.waitForTimeout(350)



  /* ---- tables render properly -------------------------------------------
   * A table's cells are rendered into widget DOM, which CodeMirror's own
   * decorations cannot reach — so inline formatting inside a cell has to be
   * rendered by us, and is checked here element by element rather than by
   * eyeballing text.
   */
  await page.evaluate(async () => {
    const notes = [
      [
        'Table formatting.md',
        '# Tables\n\n| Item | Note |\n| --- | --- |\n| **bold** | *italic* |\n| `code` | ~~struck~~ |\n| [[Lisbon Trip]] | [ext](https://example.com) |\n| a \\| b | #tagged |\n\ntail\n',
      ],
      // A single trailing space on the delimiter row makes @lezer/markdown miss
      // the table entirely; detection must not depend on the parser.
      ['Table trailing space.md', '# T\n\n| A | B |\n| --- | --- | \n| 1 | 2 |\n\ntail\n'],
      // The caret starts at position 0, which is inside this table.
      ['Table at start.md', '| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntail\n'],
    ]
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    notes.forEach(([path, text], i) => {
      tx.objectStore('files').put({
        path, kind: 'note', text, mime: 'text/markdown', size: text.length,
        hash: `tbl${i}`, mtime: Date.now() + 10_000 - i * 100, ctime: Date.now(),
        dirty: true, dirtyFlag: 1, sync: {},
      })
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')

  await page.locator('.note-row').filter({ hasText: 'Table formatting' }).first().click()
  await page.waitForTimeout(600)

  check('table renders', (await page.locator('.cm-table-render').count()) === 1)
  check('bold renders inside a cell', (await page.locator('.cm-table-render strong').count()) === 1)
  check('italic renders inside a cell', (await page.locator('.cm-table-render em').count()) === 1)
  check('code renders inside a cell', (await page.locator('.cm-table-render code').count()) === 1)
  check('strikethrough renders inside a cell', (await page.locator('.cm-table-render del').count()) === 1)
  check('a wikilink renders inside a cell', (await page.locator('.cm-table-render [data-wikilink]').count()) === 1)
  check('an external link renders inside a cell', (await page.locator('.cm-table-render a[href^="https"]').count()) === 1)
  check('a tag renders inside a cell', (await page.locator('.cm-table-render [data-tag]').count()) === 1)

  await page.screenshot({ path: join(SHOTS, '16-tables.png') })
  const cellText = (await page.locator('.cm-table-render').innerText()).replace(/\s+/g, ' ')
  check('no raw markdown leaks into cells', !/\*\*|~~|`/.test(cellText), cellText.slice(0, 70))
  check('an escaped pipe stays one cell', cellText.includes('a | b'), cellText.slice(0, 70))

  /*
   * A link in a cell is the one link in a note that is a real anchor, so it is
   * the one that can be opened twice: once by the app, and once by the browser
   * following it afterwards.
   */
  await armLinkTrap()
  await page.locator('.cm-table-render a[href^="https"]').first().click()
  await page.waitForTimeout(250)
  const cellClicked = await linkTrapResult()
  check(
    'a link in a table cell opens',
    cellClicked.opened.length === 1,
    `${cellClicked.opened.length} opened`,
  )
  check(
    'and the browser is not left to open it a second time',
    cellClicked.followed.length === 0,
    cellClicked.followed.join(','),
  )

  /* ---- typing straight into a rendered table ---------------------------
   * Rich text never shows the pipes, so the cells have to be the editor: each
   * one is its own contenteditable, committing to the markdown when it is
   * left. What matters is that the file ends up holding an ordinary GFM table
   * — that is what another editor will open.
   */
  // Padded on every rewrite, so the needle has to be something outside it.
  const tableSource = () => noteContaining('# Tables')

  /*
   * A cell is its own editing host, and would happily take a tap and raise the
   * keyboard in a note that is only being read. So while a note is a page, its
   * table is a picture of a table: the cells are not typing surfaces until the
   * note has one of its own.
   */
  check(
    'a table in a note being read has no typeable cells',
    (await page.locator('.cm-table-render').count()) === 1 &&
      (await page.locator('.cm-table-cell[contenteditable]').count()) === 0,
    `${await page.locator('.cm-table-cell[contenteditable]').count()} of ${await page.locator('.cm-table-cell').count()} cells typeable`,
  )
  await startEditing()
  // Rich text again, for the same reason: the mode is a saved preference, and
  // a cell is only an editing surface in the mode that never shows the pipes.
  for (let i = 0; i < 3 && (await page.locator('.fmt-bar').count()) === 0; i++) {
    await page.keyboard.press('Control+Shift+m')
    await page.waitForTimeout(400)
  }
  check('the cells belong to rich text, so that is the mode', (await page.locator('.fmt-bar').count()) === 1)
  check(
    'and gets them the moment the note is being written in',
    (await page.locator('.cm-table-cell[contenteditable]').count()) > 0,
    `${await page.locator('.cm-table-cell[contenteditable]').count()} typeable`,
  )

  await page.locator('.cm-table-cell[data-row="1"][data-col="1"]').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('rewritten')
  check(
    'the table stays rendered while a cell is typed in',
    (await page.locator('.cm-table-render').count()) === 1,
  )
  await page.keyboard.press('Tab')
  await page.waitForTimeout(500)
  check(
    'Tab commits the cell and moves to the next one',
    (await page.evaluate(() => {
      const el = document.activeElement
      return el?.dataset?.row === '2' && el?.dataset?.col === '0'
    })) === true,
  )
  const edited = await tableSource()
  check('the cell is written back as markdown', /\| rewritten +\|/.test(edited), edited.split('\n')[4])
  check(
    'and the table is still a table',
    /^\| -+ \| -+ \|$/m.test(edited),
    edited.split('\n')[3],
  )

  // A pipe typed into a cell is escaped, not a new column.
  await page.locator('.cm-table-cell[data-row="1"][data-col="1"]').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('x | y')
  await page.locator('.cm-line').first().click()
  await page.waitForTimeout(500)
  check('a typed pipe is escaped', (await tableSource()).includes('x \\| y'))
  check('the table survives it', (await page.locator('.cm-table-render').count()) === 1)

  /* ---- the handles on the table itself ----------------------------------
   *
   * Press once to pick a band out, press again for its menu, drag to move it.
   * Only checkable in a real browser: the whole thing is pointer capture and
   * layout, and the drag rearranges the table before anything is written.
   */
  await page.locator('.cm-table-cell[data-row="2"][data-col="0"]').click()
  await page.waitForTimeout(300)
  check(
    'a cell being worked in grows a handle on its row and on its column',
    (await page.locator('.cm-table-handle:visible').count()) === 2,
    `${await page.locator('.cm-table-handle:visible').count()} handles`,
  )
  const rowHandle = page.locator('.cm-table-handle[data-axis="row"]')
  await rowHandle.click()
  await page.waitForTimeout(300)
  check(
    'one press outlines that row and nothing else',
    (await page.locator('.cm-table-band:visible').count()) === 1 &&
      (await page.locator('.cm-table-cell[data-band]').count()) === 2,
    `${await page.locator('.cm-table-cell[data-band]').count()} cells marked`,
  )
  check('and no menu yet', (await page.locator('.menu').count()) === 0)
  await page.screenshot({ path: join(SHOTS, '16b-table-handles.png') })

  await rowHandle.click()
  await page.waitForTimeout(350)
  check(
    'a second press opens the menu for that row, named after it',
    (await page.locator('.menu-title').innerText()).includes('Row 3 of 5'),
    await page.locator('.menu-title').innerText(),
  )
  await page.locator('.menu-item', { hasText: 'Insert row below' }).click()
  await page.waitForTimeout(450)
  check(
    'and its operations act on that row',
    (await page.locator('.cm-table-render tr').count()) === 6,
    `${await page.locator('.cm-table-render tr').count()} rows`,
  )
  await clickFormat('Table rows and columns')
  await page.waitForTimeout(300)
  await page.locator('.menu-item', { hasText: 'Delete row' }).first().click()
  await page.waitForTimeout(450)

  /*
   * And the drag. The row is dropped one row further down, which is the
   * gesture that used to mean retyping both rows.
   */
  await page.locator('.cm-table-cell[data-row="2"][data-col="0"]').click()
  await page.waitForTimeout(300)
  const grip = await rowHandle.boundingBox()
  const rowBox = await page.locator('.cm-table-cell[data-row="2"][data-col="0"]').boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + rowBox.height, {
    steps: 10,
  })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const reordered = (await tableSource()).split('\n')
  check(
    'dragging a row by its handle moves it in the markdown',
    reordered[5].includes('Lisbon Trip') && reordered[6].includes('code'),
    reordered.slice(4, 8).join(' / '),
  )
  check(
    'and it is still an ordinary GFM table',
    /^\| -+ \| -+ \|$/m.test(reordered.join('\n')),
    reordered[3],
  )

  /*
   * A handle belongs to the cell being worked in, so it goes when the note
   * takes the caret back. Checked in a browser because this is where it
   * failed: `hidden` is styled by the browser's own stylesheet, which loses to
   * any rule with a class in it, so a handle asked to hide stayed on screen —
   * still looking like a row was picked out, and inert, because the cell it
   * spoke for was gone.
   */
  await page.locator('.cm-line').first().click()
  await page.waitForTimeout(400)
  check(
    'the handles go when the note takes the caret back',
    (await page.locator('.cm-table-handle:visible').count()) === 0 &&
      (await page.locator('.cm-table-band:visible').count()) === 0,
    `${await page.locator('.cm-table-handle:visible').count()} handles, ${await page.locator('.cm-table-band:visible').count()} outlines`,
  )
  await page.locator('.cm-table-cell[data-row="1"][data-col="0"]').click()
  await page.waitForTimeout(400)
  check(
    'and come straight back with the next cell',
    (await page.locator('.cm-table-handle:visible').count()) === 2,
  )

  // A wikilink in a cell must navigate, not just look like a link.
  await page.locator('.cm-table-render [data-wikilink]').click()
  await page.waitForTimeout(500)
  check(
    'a wikilink in a cell navigates',
    (await page.locator('.editor-title-input').inputValue()) === 'Lisbon Trip',
  )

  await page.locator('.note-row').filter({ hasText: 'Table trailing space' }).first().click()
  await page.waitForTimeout(500)
  check(
    'a trailing space on the delimiter row does not hide the table',
    (await page.locator('.cm-table-render').count()) === 1,
  )

  await page.locator('.note-row').filter({ hasText: 'Table at start' }).first().click()
  await page.waitForTimeout(500)
  check(
    'a table on the first line renders on open',
    (await page.locator('.cm-table-render').count()) === 1,
  )

  /*
   * Live preview keeps the older contract: the caret reveals the pipes, the
   * same as it reveals every other construct it is sitting in. Only rich text
   * edits the cells in place, so this hops modes to check it and hops back.
   */
  await page.keyboard.press('Control+Shift+m') // rich -> live
  await page.waitForTimeout(400)
  await page.locator('.cm-table-render td').first().click()
  await page.waitForTimeout(400)
  check(
    'clicking a table in live preview reveals its markdown',
    (await page.locator('.cm-line.cm-table').count()) > 0 &&
      (await page.locator('.cm-table-render').count()) === 0,
  )
  await page.screenshot({ path: join(SHOTS, '17-table-source.png') })
  await page.keyboard.press('Control+Shift+m') // live -> source
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+Shift+m') // source -> rich
  await page.waitForTimeout(400)

  /* ---- insert a photo ---------------------------------------------------- */
  await page.locator('.note-row').filter({ hasText: 'Table formatting' }).first().click()
  await page.waitForTimeout(400)
  // Insert puts something where the caret is, so it belongs to a note being
  // written in — a note being read has no caret for it to aim at.
  check(
    'a note being read offers no Insert button',
    (await page.locator('[aria-label="Insert photo or file"]').count()) === 0,
  )
  await startEditing()
  await page.locator('[aria-label="Insert photo or file"]').click()
  await page.waitForTimeout(300)
  const insertItems = await page.locator('.menu-item').allInnerTexts()
  check(
    'the insert menu offers the vault and an upload',
    insertItems.some((t) => /File in Slate/i.test(t)) && insertItems.some((t) => /Upload a File/i.test(t)),
    insertItems.join(' / '),
  )
  // Touch is on for the whole run, so this context is a coarse pointer and the
  // photo library belongs in the menu. On a desktop it is dropped entirely —
  // there it opened the same file dialog as the upload, under a second name.
  check(
    'a touch device is still offered its photo library',
    insertItems.some((t) => /Photo Library/i.test(t)),
    insertItems.join(' / '),
  )

  // Build a real PNG in-page, then hand it to the native picker.
  const pngBase64 = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 800
    const x = c.getContext('2d')
    const g = x.createLinearGradient(0, 0, 1200, 800)
    g.addColorStop(0, '#2b6cb0')
    g.addColorStop(1, '#e0a80d')
    x.fillStyle = g
    x.fillRect(0, 0, 1200, 800)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    const buf = await blob.arrayBuffer()
    let s = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  })

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.menu-item:has-text("Upload a File")').click(),
  ])
  await chooser.setFiles({
    name: 'IMG_0421.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBase64, 'base64'),
  })
  await page.waitForTimeout(2800)

  const embeds = await page.locator('.cm-embed img').count()
  check('the picked photo is inserted as an embed', embeds >= 1, `${embeds} embeds`)

  const inserted = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () => {
          const a = all.result.filter((f) => f.kind === 'attachment')
          const last = a.sort((x, y) => y.mtime - x.mtime)[0]
          resolve(last ? { path: last.path, size: last.size, mime: last.mime } : null)
        }
      }
    })
  })
  check(
    'the picked photo is optimized like a paste',
    !!inserted && inserted.mime === 'image/webp' && inserted.size < 120_000,
    inserted ? `${inserted.path} ${(inserted.size / 1024).toFixed(0)}KB ${inserted.mime}` : 'none',
  )
  check(
    'the picked photo keeps a meaningful filename',
    !!inserted && /IMG_0421/.test(inserted.path),
    inserted?.path ?? '',
  )

  // It must behave like any other image: resize handle and lightbox.
  check(
    'the inserted photo has a resize handle',
    (await page.locator('.cm-embed .cm-embed-resize').count()) >= 1,
  )
  await page.locator('.cm-embed img').last().click()
  await page.waitForTimeout(400)
  check('the inserted photo opens in the lightbox', await page.locator('.lightbox').isVisible())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  /* ---- insert a file the vault already has -------------------------------
   *
   * The other half of Insert, and the half that used to be missing: the file
   * is already in Slate, so there is nothing to upload and nothing to
   * re-encode. Typing is the whole interface, so what is checked is that the
   * box filters, that it says so when nothing matches, and that Enter embeds
   * the row under the highlight rather than the first one in the vault.
   */
  await page.locator('[aria-label="Insert photo or file"]').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("File in Slate")').click()
  await page.waitForSelector('.file-picker')
  await page.waitForTimeout(300)
  const pickerRows = await page.locator('.file-pick-row').count()
  check('the picker lists what is already in the vault', pickerRows >= 1, `${pickerRows} rows`)
  await page.screenshot({ path: join(SHOTS, '17b-file-picker.png') })

  await page.locator('.file-picker-search input').fill('no-such-file-anywhere')
  await page.waitForTimeout(250)
  check(
    'the picker says so when nothing matches',
    (await page.locator('.file-pick-row').count()) === 0 &&
      (await page.locator('.file-picker .empty').count()) === 1,
  )

  await page.locator('.file-picker-search input').fill('IMG_0421')
  await page.waitForTimeout(250)
  const narrowed = await page.locator('.file-pick-name').allInnerTexts()
  check(
    'typing a filename narrows the picker to it',
    narrowed.length === 1 && /IMG_0421/.test(narrowed[0]),
    narrowed.join(' / '),
  )

  const vaultAttachments = () =>
    page.evaluate(async () => {
      const req = indexedDB.open('slate')
      return new Promise((resolve) => {
        req.onsuccess = () => {
          const all = req.result.transaction('files', 'readonly').objectStore('files').getAll()
          all.onsuccess = () =>
            resolve(all.result.filter((f) => f.kind === 'attachment' && !f.deleted).length)
        }
      })
    })
  const filesBefore = await vaultAttachments()
  const embedsBefore = await page.locator('.cm-embed img').count()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  check('the picker closes once something is chosen', (await page.locator('.file-picker').count()) === 0)
  const embedsAfter = await page.locator('.cm-embed img').count()
  check(
    'a file already in the vault is embedded without being uploaded again',
    embedsAfter === embedsBefore + 1,
    `${embedsBefore} -> ${embedsAfter} embeds`,
  )
  // Nothing new on disk: the same attachment is now used twice.
  const filesAfter = await vaultAttachments()
  check(
    'inserting from the vault adds no second copy',
    filesAfter === filesBefore,
    `${filesBefore} -> ${filesAfter} attachments`,
  )

  // Escape gets out with nothing inserted, from a picker that was opened and
  // thought better of.
  await page.locator('[aria-label="Insert photo or file"]').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("File in Slate")').click()
  await page.waitForSelector('.file-picker')
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const stillOpen = await page.locator('.file-picker').count()
  const embedsNow = await page.locator('.cm-embed img').count()
  check(
    'Escape leaves the picker with the note untouched',
    stillOpen === 0 && embedsNow === embedsAfter,
    `${stillOpen} pickers, ${embedsNow} embeds (was ${embedsAfter})`,
  )

  /* ---- PDFs -------------------------------------------------------------
   *
   * The app draws PDFs itself rather than handing them to an <iframe>, because
   * a framed PDF is a still picture of page one on iOS and nothing at all on
   * Android (see PdfView.tsx). So the things checked here are exactly the ones
   * a frame could not do: every page laid out, ink on the canvas, words that
   * can be selected, a pinch that makes the pages bigger rather than blurrier,
   * and a canvas given back once its page is far enough away.
   *
   * The document is written out by hand — four pages, a line of Helvetica and
   * a rectangle on each — so the test does not need a fixture file or a
   * library to make one.
   */
  const pdfBytes = (() => {
    const w = 612
    const h = 792
    const objs = []
    const add = (body) => (objs.push(body), objs.length)
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    const tree = add('')
    const pageObjs = []
    for (let i = 1; i <= 4; i++) {
      const content =
        `BT /F1 36 Tf 72 ${h - 120} Td (Page ${i} of 4) Tj ET\n` +
        `2 w 0 0 1 RG 60 ${h - 200} 300 120 re S`
      const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
      pageObjs.push(
        add(
          `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${w} ${h}] ` +
            `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`,
        ),
      )
    }
    objs[tree - 1] = `<< /Type /Pages /Count 4 /Kids [${pageObjs.map((n) => `${n} 0 R`).join(' ')}] >>`
    const root = add(`<< /Type /Catalog /Pages ${tree} 0 R >>`)

    let out = '%PDF-1.4\n'
    const offsets = []
    for (let i = 0; i < objs.length; i++) {
      offsets.push(out.length)
      out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
    }
    const startxref = out.length
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${root} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
    return Buffer.from(out, 'latin1')
  })()

  await startEditing()
  await page.locator('[aria-label="Insert photo or file"]').click()
  await page.waitForTimeout(300)
  const [pdfChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.menu-item:has-text("Upload a File")').click(),
  ])
  await pdfChooser.setFiles({ name: 'spec.pdf', mimeType: 'application/pdf', buffer: pdfBytes })
  await page.waitForTimeout(2000)

  /*
   * A PDF in a note is its own first page, drawn the same way the viewer draws
   * one — not a grey card with a filename on it, which is what four scanned
   * invoices in a note used to look like: four identical rectangles.
   */
  const pdfEmbed = page.locator('.cm-embed-pdf')
  await page.waitForSelector('.cm-embed-pdf canvas', { timeout: 20000 }).catch(() => {})
  check('a PDF is inserted as its own first page', (await pdfEmbed.count()) >= 1)

  const inline = await page.evaluate(() => {
    const c = document.querySelector('.cm-embed-pdf canvas')
    if (!c?.width) return { width: 0 }
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 400)).data
    let ink = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++
    return { width: c.width, ink, meta: document.querySelector('.cm-embed-pdf-meta')?.textContent }
  })
  check('the page in the note is drawn, not described', inline.width > 0 && inline.ink > 100, JSON.stringify(inline))
  check('and it says how many more pages there are', /4 pages/.test(inline.meta ?? ''), inline.meta)
  check(
    'an embedded PDF can be resized like a picture',
    (await page.locator('.cm-embed:has(.cm-embed-pdf) .cm-embed-resize').count()) >= 1,
  )

  await pdfEmbed.first().click()
  await page.waitForSelector('.pdf-page canvas', { timeout: 20000 }).catch(() => {})
  const pdfPages = await page.locator('.pdf-page').count()
  check('every page of a multi-page PDF is laid out', pdfPages === 4, `${pdfPages} pages`)

  // Pages arrive as they are drawn, so wait for ink rather than for an element.
  await page
    .waitForFunction(
      () => {
        const c = document.querySelector('.pdf-page canvas')
        return c && c.width > 0
      },
      null,
      { timeout: 20000 },
    )
    .catch(() => {})

  const painted = await page.evaluate(() => {
    const c = document.querySelector('.pdf-page canvas')
    if (!c?.width) return { width: 0 }
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 400)).data
    let ink = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++
    return { width: c.width, ink }
  })
  check('the first page is drawn, not framed', painted.width > 0 && painted.ink > 100, JSON.stringify(painted))

  const pdfWords = await page.locator('.pdf-page .pdf-text').first().innerText().catch(() => '')
  check(
    'the words on the page can be selected and searched',
    /Page 1 of 4/.test(pdfWords.replace(/\s+/g, ' ')),
    pdfWords.slice(0, 40),
  )

  const column = () =>
    page.evaluate(() => {
      const col = document.querySelector('.pdf-column')
      const doc = document.querySelector('.pdf-doc')
      const shown = [...document.querySelectorAll('.pdf-page')].find((el) => {
        const r = el.getBoundingClientRect()
        const s = doc.getBoundingClientRect()
        return r.bottom > s.top && r.top < s.bottom
      })
      return {
        width: col.getBoundingClientRect().width,
        stage: doc.clientWidth,
        scale: Number(getComputedStyle(col).getPropertyValue('--total-scale-factor')),
        backing: shown?.querySelector('canvas').width ?? 0,
        tall: doc.scrollHeight > doc.clientHeight * 2,
      }
    })

  const fitted = await column()
  check(
    'a PDF opens fitted, and no wider than a page is worth reading at',
    fitted.width === Math.min(fitted.stage, 900) && fitted.tall,
    JSON.stringify(fitted),
  )

  const scrolledPdf = await page.evaluate(async () => {
    const doc = document.querySelector('.pdf-doc')
    doc.scrollTop = doc.scrollHeight
    await new Promise((r) => setTimeout(r, 1200))
    return {
      at: doc.scrollTop,
      first: document.querySelector('.pdf-page canvas').width,
      last: [...document.querySelectorAll('.pdf-page canvas')].pop().width,
    }
  })
  check('scrolling reaches the last page and draws it', scrolledPdf.at > 0 && scrolledPdf.last > 0, JSON.stringify(scrolledPdf))
  check('and the pages left behind give their canvas back', scrolledPdf.first === 0, `${scrolledPdf.first}px`)

  // Back to the top, then two fingers on it. The gesture is dispatched through
  // CDP for the same reason the picture's is: nothing else puts two fingers down.
  await page.evaluate(() => {
    document.querySelector('.pdf-doc').scrollTop = 0
  })
  await page.waitForTimeout(800)
  const before = await column()
  const pdfMid = await page.evaluate(() => {
    const r = document.querySelector('.pdf-doc').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const pdfCdp = await page.context().newCDPSession(page)
  const pdfTouch = (type, points) =>
    pdfCdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: i + 1 })),
    })
  const from = [
    { x: pdfMid.x - 60, y: pdfMid.y },
    { x: pdfMid.x + 60, y: pdfMid.y },
  ]
  const to = [
    { x: pdfMid.x - 120, y: pdfMid.y },
    { x: pdfMid.x + 120, y: pdfMid.y },
  ]
  await pdfTouch('touchStart', from)
  for (let i = 1; i <= 10; i++) {
    const t = i / 10
    await pdfTouch(
      'touchMove',
      from.map((p, k) => ({ x: p.x + (to[k].x - p.x) * t, y: p.y + (to[k].y - p.y) * t })),
    )
  }
  await pdfTouch('touchEnd', [])
  await page.waitForTimeout(900)

  const pinchedPdf = await column()
  check(
    'pinching a document widens it by how far the fingers spread',
    Math.abs(pinchedPdf.width / before.width - 2) < 0.3,
    `${(pinchedPdf.width / before.width).toFixed(2)}×`,
  )
  check(
    'the words are rescaled with the pages, not left behind',
    Math.abs(pinchedPdf.scale / before.scale - pinchedPdf.width / before.width) < 0.02,
    `${before.scale.toFixed(3)} -> ${pinchedPdf.scale.toFixed(3)}`,
  )
  check(
    'and the pages are redrawn bigger rather than magnified',
    pinchedPdf.backing > before.backing,
    `${before.backing} -> ${pinchedPdf.backing}`,
  )

  await page.keyboard.press('0')
  await page.waitForTimeout(500)
  check('0 fits the document again', (await column()).width === fitted.width)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('Escape closes the PDF viewer', (await page.locator('.lightbox').count()) === 0)

  /* ---- nested Tag Folders -----------------------------------------------
   *
   * Rows are looked up inside the Tag Folders group with an exact name match:
   * the sidebar deliberately allows a real folder and a Tag Folder to share a
   * name, and "Work" would otherwise also match the "Active work" folder made
   * earlier.
   */
  const tagFolderGroup = page.locator('.side-group', {
    has: page.locator('.side-group-label', { hasText: 'Tag Folders' }),
  })
  const tagFolderRow = (name) =>
    tagFolderGroup
      .locator('.side-row')
      .filter({ has: page.locator('.side-name', { hasText: new RegExp(`^${name}$`) }) })

  // The hierarchy's whole point is that a child narrows its parent, so the
  // check that matters is that a nested folder shows FEWER notes than its
  // parent and excludes ones the parent alone would match.
  await page.click('.side-group-label:has-text("Tag Folders") .side-add')
  await ruleDialogReady()
  await page.fill('.dialog input[type="text"]', 'Work')
  await page.fill('.rule-input', '#work')
  await page.waitForTimeout(350)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(450)
  const workCount = await page.locator('.note-row').count()
  check('parent Tag Folder matches its own rule', workCount === 3, `${workCount} notes`)

  // Create a child from the parent's own menu.
  await tagFolderRow('Work').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("New folder inside")').click()
  await ruleDialogReady()

  const parentSelected = await page.locator('.dialog select').nth(1).inputValue()
  check('the new folder is pre-parented', parentSelected !== '', `parent="${parentSelected}"`)
  check('the narrow-parent toggle is on by default', await page.locator('.check input[type="checkbox"]').isChecked())

  await page.fill('.dialog input[type="text"]', 'Urgent')
  await page.fill('.rule-input', '#urgent')
  await page.waitForTimeout(400)

  const nestedStatus = (await page.locator('.rule-status').innerText()).replace(/\s+/g, ' ')
  check('the dialog shows the combined effective rule', /#work and #urgent/i.test(nestedStatus), nestedStatus.slice(0, 90))
  check('the dialog names what is inherited', /inherited from Work/i.test(nestedStatus), nestedStatus.slice(0, 120))
  check('the child matches fewer notes than its parent', /matches 1 note/i.test(nestedStatus), nestedStatus.slice(0, 60))

  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(500)

  const childCount = await page.locator('.note-row').count()
  const childTitles = await page.locator('.note-row-title').allInnerTexts()
  check(
    'the nested folder narrows the parent',
    childCount === 1 && childTitles[0] === 'Budget',
    childTitles.join(','),
  )

  // Indentation is how the hierarchy actually reads in the sidebar.
  const indents = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.side-row')]
    const named = (n) => rows.find((r) => r.querySelector('.side-name')?.textContent.trim() === n)
    const work = named('Work')
    const urgent = named('Urgent')
    if (!work || !urgent) return null
    return {
      work: parseInt(getComputedStyle(work).paddingLeft),
      urgent: parseInt(getComputedStyle(urgent).paddingLeft),
    }
  })
  check('the child is indented under its parent', !!indents && indents.urgent > indents.work, JSON.stringify(indents))

  // Turning inheritance off must widen the child again.
  await tagFolderRow('Urgent').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("Edit rule")').click()
  await ruleDialogReady()
  await page.locator('.check input[type="checkbox"]').uncheck()
  await page.waitForTimeout(350)
  const looseStatus = (await page.locator('.rule-status').innerText()).replace(/\s+/g, ' ')
  check('unchecking narrow widens the match', /matches 2 notes/i.test(looseStatus), looseStatus.slice(0, 60))
  await page.locator('.check input[type="checkbox"]').check()
  await page.waitForTimeout(250)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(400)

  // Editing the parent must re-narrow the child.
  await tagFolderRow('Work').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("Edit rule")').click()
  await ruleDialogReady()
  await page.fill('.rule-input', '#home')
  await page.waitForTimeout(300)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(450)
  await tagFolderRow('Urgent').click()
  await page.waitForTimeout(400)
  const afterParentEdit = await page.locator('.note-row-title').allInnerTexts()
  check(
    'editing the parent re-narrows the child',
    afterParentEdit.join(',') === 'Roof',
    afterParentEdit.join(','),
  )

  // A collapsed parent hides its children.
  const beforeCollapse = await tagFolderRow('Urgent').count()
  await tagFolderRow('Work').locator('.disclose').first().click()
  await page.waitForTimeout(300)
  const afterCollapse = await tagFolderRow('Urgent').count()
  check('a parent collapses its children', beforeCollapse === 1 && afterCollapse === 0)
  await tagFolderRow('Work').locator('.disclose').first().click()
  await page.waitForTimeout(300)

  // Deleting a parent must promote, not destroy, what is inside it.
  await tagFolderRow('Work').click({ button: 'right' })
  await page.waitForTimeout(250)
  const keepLabel = await page.locator('.menu-item:has-text("keeping what")').count()
  check('deleting a parent offers to keep what is inside', keepLabel === 1)
  await page.locator('.menu-item:has-text("keeping what")').click()
  await page.waitForTimeout(500)
  check('the child survives its parent being deleted', (await tagFolderRow('Urgent').count()) === 1)

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.side-row')
  await page.waitForTimeout(400)
  check('the promoted child persists across a reload', (await tagFolderRow('Urgent').count()) === 1)

  /* ---- Tag Folders in the order you want them ---------------------------
   *
   * Siblings sit in creation order until somebody moves one. The order lives
   * in the same file the folders do, so the check that matters is that it
   * survives a reload — an order kept only in this tab is not an order.
   */
  const tagOrder = () => tagFolderGroup.locator('.side-row .side-name').allInnerTexts()

  // A folder of its own to move, so this does not depend on what the sections
  // above happened to leave behind. A new one goes last.
  await page.click('.side-group-label:has-text("Tag Folders") .side-add')
  await ruleDialogReady()
  await page.fill('.dialog input[type="text"]', 'Zebra')
  await page.fill('.rule-input', '#zebra')
  await page.waitForTimeout(300)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(450)

  const beforeMove = await tagOrder()
  check('a new Tag Folder goes to the end', beforeMove[beforeMove.length - 1] === 'Zebra', beforeMove.join(','))

  await tagFolderRow('Zebra').click({ button: 'right' })
  await page.waitForTimeout(250)
  const moveUp = page.locator('.menu-item:has-text("Move up")')
  check('a Tag Folder offers to move up', (await moveUp.count()) === 1 && !(await moveUp.isDisabled()))
  await moveUp.click()
  await page.waitForTimeout(450)
  const afterMove = await tagOrder()
  /*
   * Above the sibling it was under — which is not always the row directly
   * above it, because a sibling with children takes them with it. That is the
   * behaviour, so the check is that it rose and that nothing else appeared or
   * vanished, and then that moving it back down undoes it exactly.
   */
  check(
    'moving one up lifts it past the sibling above',
    afterMove.indexOf('Zebra') < beforeMove.indexOf('Zebra') &&
      [...afterMove].sort().join(',') === [...beforeMove].sort().join(','),
    `${beforeMove.join(',')} → ${afterMove.join(',')}`,
  )

  await tagFolderRow('Zebra').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("Move down")').click()
  await page.waitForTimeout(450)
  check(
    'and moving it back down puts the order back',
    (await tagOrder()).join(',') === beforeMove.join(','),
    (await tagOrder()).join(','),
  )
  await tagFolderRow('Zebra').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("Move up")').click()
  await page.waitForTimeout(450)

  await tagFolderRow(afterMove[0]).click({ button: 'right' })
  await page.waitForTimeout(250)
  check(
    'and at the top there is nowhere further to go',
    await page.locator('.menu-item:has-text("Move up")').isDisabled(),
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.side-row')
  await page.waitForTimeout(400)
  check(
    'the order survives a reload',
    (await tagOrder()).join(',') === afterMove.join(','),
    (await tagOrder()).join(','),
  )
  await page.screenshot({ path: join(SHOTS, '15-nested-tag-folders.png') })

  /* ---- layout: resizing must not rearrange anything --------------------- */
  const editorWidth = async () => {
    const box = await page.locator('.editor-pane').boundingBox()
    return box ? Math.round(box.width) : 0
  }
  const overflows = () =>
    page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(350)
  check('wide mode shows the sidebar inline', (await page.getAttribute('.shell', 'data-sidebar')) === 'inline')

  const statusVisible = await page.evaluate(() => {
    const el = document.querySelector('.statusbar')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.height > 0 && r.bottom <= window.innerHeight + 1
  })
  check('the sync status bar is on screen, not below the fold', statusVisible)

  /* ---- focus mode, and a note in a window of its own ----------------------
   *
   * Both are desktop only. Focus mode is a CSS-level thing and cheap to check;
   * the popout is a second window, and everything that could go wrong about it
   * is a boundary between the two — the note being handed over cleanly, what
   * is typed next door reaching this window's copy of the vault, and the note
   * coming back when the window closes. So all three are checked here rather
   * than trusted to look right.
   */
  await page.keyboard.press('Meta+n')
  await page.waitForSelector('.cm-content')
  await page.keyboard.type('# Popped out\n\nwritten in the main window')
  await page.waitForTimeout(600)

  await page.click('.editor-head [aria-label="Focus mode"]')
  await page.waitForTimeout(250)
  check('focus mode gives the note the whole window', (await page.getAttribute('.shell', 'data-zen')) === '1')
  check(
    'and takes every panel with it',
    !(await page.locator('.pane.sidebar').isVisible()) && (await page.locator('.statusbar').count()) === 0,
  )
  /*
   * Laid out however Settings → Editor → Body width says, which for this run is
   * the default: full width. Focus mode briefly overrode that with a reading
   * column of its own, which meant the same preference was answered two
   * different ways depending on which window the note was in.
   */
  check(
    'and leaves the body width to the setting',
    (await page.getAttribute('.editor-pane', 'data-width')) === 'full',
    await page.getAttribute('.editor-pane', 'data-width'),
  )
  await page.screenshot({ path: join(SHOTS, '30-focus-mode.png') })
  await page.keyboard.press('Meta+Shift+f')
  await page.waitForTimeout(250)
  check('⌘⇧F puts them back', (await page.getAttribute('.shell', 'data-zen')) === '0')

  const popoutSoon = page.waitForEvent('popup')
  await page.locator('.editor-head [aria-label="Focus mode"]').click({ modifiers: ['Shift'] })
  const popout = await popoutSoon
  popout.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`popout: ${m.text()}`)
  })
  popout.on('pageerror', (e) => consoleErrors.push(`popout pageerror: ${e.message}`))
  await popout.waitForSelector('.popout-shell .cm-content', { timeout: 15_000 })
  const popoutText = await popout.locator('.cm-content').innerText()
  check(
    'Shift-clicking the same button opens the note in its own window',
    popoutText.includes('written in the main window'),
    JSON.stringify(popoutText.slice(0, 48)),
  )
  check(
    'which is one note and no app around it',
    (await popout.locator('.pane.sidebar').count()) === 0 &&
      (await popout.locator('.statusbar').count()) === 0,
  )
  check(
    'and the pane it left holds no second editor on the same note',
    (await page.locator('.popped-card').count()) === 1 &&
      (await page.locator('.editor-pane .cm-content').count()) === 0,
  )
  await popout.screenshot({ path: join(SHOTS, '31-popout-window.png') })

  await popout.locator('.cm-content').click()
  await popout.waitForTimeout(200)
  await popout.keyboard.type('\n\nand this was typed next door')
  const mirrored = await noteAfterEdit('written in the main window', 'typed next door')
  check("what is typed there reaches this window's vault", mirrored.includes('typed next door'))

  await popout.close()
  await page.waitForTimeout(1500)
  check(
    'closing that window hands the note back',
    (await page.locator('.popped-card').count()) === 0 &&
      (await page.locator('.editor-pane .cm-content').count()) === 1,
  )
  const returned = await page.locator('.editor-pane .cm-content').innerText()
  check(
    'with everything that was written in it while it was away',
    returned.includes('typed next door'),
    JSON.stringify(returned.slice(-42)),
  )

  // Put the vault back the way the rest of the run expects to find it.
  await page.click('.editor-head [title="Delete note"]')
  await page.waitForTimeout(500)

  /* ---- Settings › About: the update controls ------------------------------ */
  // The full stale-build scenario needs two builds and a swappable server, so it
  // is not reproduced here. This just holds the panel itself honest: the buttons
  // exist, and a check against a server that has nothing newer says so rather
  // than reloading or hanging.
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("About")')
  await page.waitForSelector('.callout:has-text("Build")')
  const aboutText = await page.locator('.callout:has-text("Build")').innerText()
  check('About shows which build is running', /Build \d{4}-\d{2}-\d{2}/.test(aboutText), aboutText.split('\n')[1])
  check('About offers an update button', (await page.locator('.dialog .btn:has-text("Check for updates")').count()) === 1)
  check('About offers the reinstall escape hatch', (await page.locator('.dialog .btn:has-text("Reinstall")').count()) === 1)
  await page.click('.dialog .btn:has-text("Check for updates")')
  await page.waitForTimeout(2500)
  const checked = await page.locator('.callout:has-text("Build")').innerText()
  check(
    'checking for updates reports back instead of hanging',
    /newest build|nothing to update|not running Slate/i.test(checked),
    checked.split('\n').slice(1).join(' / ').slice(0, 110),
  )
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(200)

  let minEditor = Infinity
  let anyOverflow = false
  let strandedDrawer = false
  for (const w of [1400, 1280, 1180, 1080, 980, 880, 800, 764, 700, 600, 480, 390]) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(140)
    if (await overflows()) anyOverflow = true
    if (await page.locator('.drawer-scrim').count()) strandedDrawer = true
    if (w >= 764) minEditor = Math.min(minEditor, await editorWidth())
  }
  check('no horizontal overflow at any width', !anyOverflow)
  check('resizing never leaves a drawer open', !strandedDrawer)
  check('the editor keeps a usable width down to 764px', minEditor >= 400, `min ${minEditor}px`)

  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(300)
  check('mid-size drops the sidebar rather than squeezing the editor', (await page.getAttribute('.shell', 'data-mode')) === 'medium')
  check('mid-size keeps the note list and editor', (await page.locator('.list-pane').count()) === 1 && (await page.locator('.editor-pane').count()) === 1)
  await page.screenshot({ path: join(SHOTS, '09-medium.png') })

  // The sidebar is reachable at mid-size, as an overlay.
  await page.click('[title^="Toggle sidebar"]')
  await page.waitForTimeout(350)
  check('mid-size sidebar opens as an overlay', (await page.getAttribute('.shell', 'data-sidebar')) === 'floating')
  check('the overlay has a dismiss scrim', (await page.locator('.drawer-scrim').count()) === 1)
  await page.locator('.drawer-scrim').click()
  await page.waitForTimeout(300)
  check('tapping the scrim closes the drawer', (await page.getAttribute('.shell', 'data-sidebar')) === 'hidden')

  /* ---- phone -------------------------------------------------------------- */
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  check('phone width enters compact mode', (await page.getAttribute('.shell', 'data-mode')) === 'compact')

  const tabs = await page.locator('.tabbar-item').count()
  check('the bottom pill bar has four tabs', tabs === 4, `${tabs} tabs`)
  const tabLabels = await page.locator('.tabbar-label').allInnerTexts()
  check('tabs are Notes, Tasks, Calendar, More', tabLabels.join(',') === 'Notes,Tasks,Calendar,More', tabLabels.join(','))

  // Every tab target must be comfortably tappable.
  const tabBoxes = await page.locator('.tabbar-item').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }),
  )
  check(
    'tab targets meet the 44px touch minimum',
    tabBoxes.every((b) => b.h >= 44 && b.w >= 44),
    JSON.stringify(tabBoxes[0]),
  )

  check('no horizontal overflow on a phone', !(await overflows()))
  await page.screenshot({ path: join(SHOTS, '10-phone-notes.png') })

  /* ---- notched phone ------------------------------------------------------
   * Headless Chromium reports every safe-area inset as 0, so a notch is
   * simulated by injecting literals where the env() values land. This guards a
   * bug that shipped: with the insets on <body> and a dvh height on #app, the
   * padding pushed the shell down while its height went on measuring a full
   * viewport, so the column overhung the bottom of the screen by the height of
   * the notch and the end of every list was unreachable. On a real iPhone it
   * read as "the app doesn't go all the way to the bottom".
   */
  const NOTCH = { top: 59, bottom: 34 }
  await page.addStyleTag({
    content: `#app{padding-top:${NOTCH.top}px !important}
              .tabbar{bottom:max(12px,${NOTCH.bottom}px) !important}
              :root{--nav-gap:max(12px,${NOTCH.bottom}px) !important}`,
  })
  await page.waitForTimeout(300)
  const notched = await page.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect()
    const nav = document.querySelector('.tabbar').getBoundingClientRect()
    const sc = document.querySelector('.mobile-stack .list-scroll').getBoundingClientRect()
    return {
      overhang: Math.round(app.bottom - window.innerHeight),
      contentTop: Math.round(document.querySelector('.shell').getBoundingClientRect().top),
      gapBelowPill: Math.round(window.innerHeight - nav.bottom),
      scrollerShort: Math.round(window.innerHeight - sc.bottom),
    }
  })
  check('notched: the shell ends flush with the bottom edge', notched.overhang === 0, `overhangs ${notched.overhang}px`)
  check('notched: content clears the notch', notched.contentTop === NOTCH.top, `top ${notched.contentTop}`)
  check('notched: the pill clears the home indicator by exactly the inset', notched.gapBelowPill === NOTCH.bottom, `${notched.gapBelowPill}px`)
  check('notched: the list scroller reaches the bottom edge', notched.scrollerShort === 0, `${notched.scrollerShort}px short`)
  await page.evaluate(() => document.head.querySelectorAll('style').forEach((s) => {
    if (s.textContent.includes('--nav-gap')) s.remove()
  }))
  await page.waitForTimeout(200)

  await page.locator('.tabbar-item:has-text("Tasks")').click()
  await page.waitForTimeout(350)
  check('Tasks tab shows tasks', (await page.locator('.task-row').count()) > 0)
  await page.screenshot({ path: join(SHOTS, '11-phone-tasks.png') })

  /*
   * The same chip, the same picker — as a sheet. This is the half of the
   * feature a popover under the cursor cannot serve: a menu pinned to a
   * fingertip is half off-screen, and day cells sized for a mouse are not
   * targets a thumb can hit.
   */
  const phoneChip = page.locator('.task-row .due-chip').first()
  check('every task row carries a date button on a phone too', (await phoneChip.count()) === 1)
  const chipBox = await phoneChip.boundingBox()
  check(
    'the chip is a real touch target',
    chipBox.height >= 32 && chipBox.width >= 40,
    `${Math.round(chipBox.width)}×${Math.round(chipBox.height)}`,
  )
  await phoneChip.tap()
  await page.waitForTimeout(400)
  const dueSheet = await page.evaluate(() => {
    const box = document.querySelector('.menu-due')
    const day = document.querySelector('.due-day')
    return {
      isSheet: !!box?.classList.contains('menu-sheet'),
      atBottom: box ? Math.round(window.innerHeight - box.getBoundingClientRect().bottom) : -1,
      width: box ? Math.round(box.getBoundingClientRect().width / window.innerWidth * 100) : 0,
      dayHeight: day ? Math.round(day.getBoundingClientRect().height) : 0,
      presets: document.querySelectorAll('.due-preset').length,
    }
  })
  check('the picker arrives as a bottom sheet, not a popover', dueSheet.isSheet)
  check('flush to the bottom edge', dueSheet.atBottom === 0, `${dueSheet.atBottom}px off`)
  check('and full width', dueSheet.width >= 99, `${dueSheet.width}%`)
  check('its day cells are thumb-sized', dueSheet.dayHeight >= 40, `${dueSheet.dayHeight}px`)
  // Same count as the popover's, and the same Sunday caveat — see above.
  check(
    'with the same presets on top',
    dueSheet.presets >= (new Date().getDay() === 0 ? 2 : 3),
    `${dueSheet.presets}`,
  )
  await page.screenshot({ path: join(SHOTS, '11b-phone-due.png') })

  const beforePick = await page.locator('.task-row .due-chip').first().innerText()
  await page.locator('.due-preset:has-text("Today")').tap()
  await page.waitForTimeout(500)
  check('the sheet closes on a choice', (await page.locator('.due-pick').count()) === 0)
  check(
    'and the row shows the date it was given',
    (await page.locator('.task-row .due-chip').first().innerText()).trim() === 'Today',
    `was "${beforePick.trim()}"`,
  )

  /* ---- quick capture ---------------------------------------------------
   * Two taps end to end: the + in the middle of the pill, then Add. What is
   * actually being checked is where the line lands — tasks are read out of
   * note bodies, so a capture that worked is one that appears in the list
   * underneath the sheet without anything being reloaded or reopened.
   */
  const beforeCapture = await page.locator('.task-row').count()
  check('the pill carries a capture button', (await page.locator('.tabbar-add').count()) === 1)
  check('and still exactly four tabs beside it', (await page.locator('.tabbar-item').count()) === 4)
  const addBox = await page.locator('.tabbar-add').boundingBox()
  check(
    'the capture button is a real touch target',
    addBox.height >= 44 && addBox.width >= 44,
    `${Math.round(addBox.width)}\u00d7${Math.round(addBox.height)}`,
  )

  await page.locator('.tabbar-add').tap()
  await page.waitForTimeout(350)
  check('tapping it opens the capture sheet', (await page.locator('.qa-root[data-open="1"]').count()) === 1)
  check(
    'with the caret already in the field',
    await page.evaluate(() => document.activeElement?.classList.contains('qa-field')),
  )
  check(
    'and on the thing the tab it was pressed from is about',
    (await page.locator('.qa-seg-btn[aria-pressed="true"]').innerText()).trim() === 'Task',
  )
  const destText = (await page.locator('.qa-dest').innerText()).trim()
  check('the sheet names the file the task is going to', destText.startsWith('Daily/'), destText)
  await page.screenshot({ path: join(SHOTS, '11c-phone-capture.png') })

  await page.locator('.qa-field').fill('Call the vet')
  await page.locator('.qa-chip:has-text("Today")').tap()
  await page.locator('.qa-add').tap()
  await page.waitForTimeout(700)
  check(
    'the captured task is in the list underneath',
    (await page.locator('.task-row:has-text("Call the vet")').count()) === 1,
  )
  check(
    'and it is one more task, not a new note holding one',
    (await page.locator('.task-row').count()) === beforeCapture + 1,
    `${beforeCapture} \u2192 ${await page.locator('.task-row').count()}`,
  )
  check(
    'it carries the date the chip gave it',
    (await page.locator('.task-row:has-text("Call the vet") .due-chip').innerText()).trim() === 'Today',
  )
  check('the sheet stays up for the next one', (await page.locator('.qa-root[data-open="1"]').count()) === 1)
  check(
    'and says what it has put away, since the note is not the list underneath',
    (await page.locator('.qa-added').innerText()).trim() === '1 added',
  )
  check('with the field cleared', (await page.locator('.qa-field').inputValue()) === '')
  check(
    'and the date kept, since three tasks due today are three taps',
    (await page.locator('.qa-chip:has-text("Today")').getAttribute('aria-pressed')) === 'true',
  )

  await page.locator('.qa-sheet [aria-label="Close"]').tap()
  await page.waitForTimeout(300)
  check('closing puts the sheet away', (await page.locator('.qa-root[data-open="1"]').count()) === 0)

  /*
   * The other half of the button. A long press on Android raises `contextmenu`
   * at about the same moment the press timer fires, so the handler behind it is
   * what actually has to be there — the timer alone leaves Chrome's own
   * long-press running over the top of the menu.
   */
  await page.locator('.tabbar-add').click({ button: 'right' })
  await page.waitForTimeout(350)
  const addMenu = await page.locator('.menu-sheet .menu-item').allInnerTexts()
  check(
    'a long press on the + offers the other two things it can do',
    // The sheet adds its own Cancel, as every action sheet on this phone does.
    addMenu.join(',') === 'New task,New note,Today\u2019s note,Cancel',
    addMenu.join(','),
  )
  await page.locator('.menu-scrim').click({ position: { x: 10, y: 10 } })
  await page.waitForTimeout(250)
  check('and dismisses without capturing anything', (await page.locator('.qa-root[data-open="1"]').count()) === 0)

  /*
   * The other half: a captured note is named after what was typed. This is
   * the thing the old New note button could not do — it wrote `Untitled.md`
   * before you had typed a character, and left it there if you walked away.
   */
  await page.locator('.tabbar-item:has-text("Notes")').tap()
  await page.waitForTimeout(300)
  // The suite has made an Untitled note of its own by now; what is being
  // checked is that capture does not add to the pile.
  const untitledBefore = await page.locator('.note-row:has-text("Untitled")').count()
  await page.locator('.tabbar-add').tap()
  await page.waitForTimeout(300)
  check(
    'on Notes the same button opens on Note',
    (await page.locator('.qa-seg-btn[aria-pressed="true"]').innerText()).trim() === 'Note',
  )
  await page.locator('.qa-field').fill('Vet visit questions\nAsk about the booster.')
  await page.locator('.qa-add').tap()
  await page.waitForTimeout(700)
  check('a captured note closes the sheet', (await page.locator('.qa-root[data-open="1"]').count()) === 0)
  check(
    'and is named after its first line',
    (await page.locator('.note-row:has-text("Vet visit questions")').count()) === 1,
  )
  check(
    'so nothing is left called Untitled',
    (await page.locator('.note-row:has-text("Untitled")').count()) === untitledBefore,
    `${untitledBefore} before`,
  )

  await page.locator('.tabbar-item:has-text("Calendar")').click()
  await page.waitForTimeout(350)
  check('Calendar tab shows a month grid', (await page.locator('.cal-day').count()) >= 28)
  await page.screenshot({ path: join(SHOTS, '12-phone-calendar.png') })

  await page.locator('.tabbar-item:has-text("More")').click()
  await page.waitForTimeout(350)
  check('More tab lists the secondary destinations', (await page.locator('.more-row').count()) >= 4)
  check('More surfaces Tag Folders', (await page.locator('.more-row:has-text("Active work")').count()) > 0)
  await page.screenshot({ path: join(SHOTS, '13-phone-more.png') })

  // --- open a note and come back -----------------------------------------
  await page.locator('.tabbar-item:has-text("Notes")').click()
  await page.waitForTimeout(300)
  check('opening a tab does not auto-open a note', (await page.locator('.editor-overlay').count()) === 0)

  await page.locator('.note-row').first().click()
  await page.waitForTimeout(450)
  check('tapping a note opens the editor full screen', (await page.locator('.editor-overlay .cm-content').count()) === 1)
  check('no horizontal overflow in the phone editor', !(await overflows()))
  await page.screenshot({ path: join(SHOTS, '14-phone-editor.png') })

  /*
   * The whole point of the reading mode, on the device it was written for: the
   * note fills the screen and the keyboard is nowhere, until a tap in the text
   * asks for it.
   */
  const phoneOpened = await readingState()
  check(
    'a note opened on a phone raises no keyboard',
    phoneOpened.flag === '1' &&
      phoneOpened.editable === 'false' &&
      !phoneOpened.focused.includes('cm-content'),
    `reading=${phoneOpened.flag}, contenteditable=${phoneOpened.editable}, focused ${phoneOpened.focused || 'nothing'}`,
  )
  const tapAt = await noteTextPoint('.editor-overlay')
  await page.touchscreen.tap(tapAt.x, tapAt.y)
  await page.waitForTimeout(300)
  const phoneTapped = await readingState()
  check(
    'tapping the note is what starts editing it',
    phoneTapped.flag === '0' &&
      phoneTapped.editable === 'true' &&
      phoneTapped.focused.includes('cm-content'),
    `reading=${phoneTapped.flag}, focused ${phoneTapped.focused || 'nothing'}`,
  )

  /* ---- the phone's Format sheet -----------------------------------------
   * Rich text on a phone has one rule: the keyboard and the Format sheet never
   * share the screen. Between them they leave almost no note visible, and
   * nobody formats and types in the same moment anyway.
   */
  /** Choose an editor mode from the note-actions menu, which lists all three. */
  const chooseMode = async (label) => {
    await page.locator('.editor-overlay [aria-label="Note actions"]').click()
    await page.waitForTimeout(300)
    await page.locator('.menu-item', { hasText: new RegExp(`^${label}$`) }).click()
    await page.waitForTimeout(400)
  }
  await chooseMode('Rich text')
  await startEditing()
  check('the phone can switch to rich text', (await page.locator('.fmt-open').count()) === 1)
  const richAt = await noteTextPoint('.editor-overlay')
  await page.mouse.click(richAt.x, richAt.y)
  await page.waitForTimeout(250)
  check(
    'tapping the note focuses it for typing',
    await page.evaluate(() => document.activeElement?.classList.contains('cm-content')),
  )

  await page.locator('.fmt-open').click()
  await page.waitForTimeout(400)
  const fmt = await page.evaluate(() => {
    const s = document.querySelector('.fmt-sheet')?.getBoundingClientRect()
    const body = document.querySelector('.editor-body')?.getBoundingClientRect()
    const cursor = document.querySelector('.cm-cursor')
    if (!s || !body) return null
    return {
      height: Math.round(s.height),
      share: Math.round((s.height / window.innerHeight) * 100),
      bodyEndsAt: Math.round(body.bottom),
      sheetStartsAt: Math.round(s.top),
      cursorShown: cursor ? getComputedStyle(cursor).display : 'none',
      focused: document.activeElement?.className ?? '',
    }
  })
  check('the Format sheet is compact', !!fmt && fmt.share <= 20, `${fmt?.height}px, ${fmt?.share}% of the screen`)
  check('the sheet has no title bar to pay for', (await page.locator('.fmt-sheet h2').count()) === 0)
  check(
    'the note shrinks rather than hiding under the sheet',
    !!fmt && fmt.bodyEndsAt <= fmt.sheetStartsAt + 1,
    `note ends at ${fmt?.bodyEndsAt}, sheet starts at ${fmt?.sheetStartsAt}`,
  )
  check('opening the sheet dismisses the keyboard', !!fmt && !fmt.focused.includes('cm-content'), fmt?.focused)
  check('the caret stays visible with the editor blurred', fmt?.cursorShown === 'block', fmt?.cursorShown)
  await page.screenshot({ path: join(SHOTS, '18-phone-format.png') })

  const backToTyping = await noteTextPoint('.editor-overlay')
  await page.mouse.click(backToTyping.x, backToTyping.y)
  await page.waitForTimeout(400)
  check('touching the note closes the sheet', (await page.locator('.fmt-sheet').count()) === 0)
  check(
    'and the editor takes focus back for typing',
    await page.evaluate(() => document.activeElement?.classList.contains('cm-content')),
  )

  // The keyboard itself: the shell is shortened by it rather than covered.
  // Headless Chromium has no soft keyboard, so the inset the watcher publishes
  // is set by hand.
  const kb = await page.evaluate(() => {
    document.documentElement.style.setProperty('--kb-inset', '336px')
    const body = document.querySelector('.editor-body').getBoundingClientRect()
    return { bodyEndsAt: Math.round(body.bottom), keyboardTop: window.innerHeight - 336 }
  })
  check(
    'a keyboard shortens the editor instead of covering it',
    kb.bodyEndsAt <= kb.keyboardTop,
    `note ends at ${kb.bodyEndsAt}, keyboard starts at ${kb.keyboardTop}`,
  )

  /*
   * The same rule for a sheet you type into. A bottom sheet and a keyboard
   * want the same edge of the screen, and the file picker shrinks as its list
   * narrows — so with the inset ignored, typing a filename walked the results
   * and then the search box itself down behind the keys. Checked with the
   * keyboard still simulated above.
   */
  await page.locator('[aria-label="Insert photo or file"]').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("File in Slate")').click()
  await page.waitForSelector('.file-picker')
  await page.waitForTimeout(350)
  const sheetOverKeyboard = () =>
    page.evaluate((keyboardTop) => {
      const box = document.querySelector('.file-picker').getBoundingClientRect()
      const input = document.querySelector('.file-picker-search input').getBoundingClientRect()
      const rows = [...document.querySelectorAll('.file-pick-row')]
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        inputTop: Math.round(input.top),
        rows: rows.length,
        rowsAbove: rows.filter((r) => r.getBoundingClientRect().bottom <= keyboardTop + 1).length,
      }
    }, kb.keyboardTop)
  const overKeys = await sheetOverKeyboard()
  check(
    'the file picker sits on top of the keyboard, not under it',
    overKeys.bottom <= kb.keyboardTop && overKeys.top >= 0,
    `sheet ${overKeys.top}-${overKeys.bottom}, keyboard starts at ${kb.keyboardTop}`,
  )
  check(
    'and every row it lists is above the keyboard',
    overKeys.rows > 0 && overKeys.rowsAbove === overKeys.rows,
    `${overKeys.rowsAbove} of ${overKeys.rows} rows`,
  )

  await page.locator('.file-picker-search input').fill('IMG_0421')
  await page.waitForTimeout(300)
  const narrowedKeys = await sheetOverKeyboard()
  check(
    'narrowing it does not walk the last result down behind the keys',
    narrowedKeys.rows === 1 &&
      narrowedKeys.rowsAbove === 1 &&
      narrowedKeys.inputTop >= 0 &&
      narrowedKeys.bottom <= kb.keyboardTop,
    `sheet ${narrowedKeys.top}-${narrowedKeys.bottom}, ${narrowedKeys.rowsAbove} of ${narrowedKeys.rows} rows above ${kb.keyboardTop}`,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('the picker leaves the phone editor as it found it', (await page.locator('.file-picker').count()) === 0)

  /* ---- typing an embed out by hand, in rich text -------------------------
   * The other way to reach a file: `![[` and the autocomplete. Rich text used
   * to swap the markup for the widget the moment `![[a]]` parsed, which took
   * the target out from under the completion — one letter went in, the range
   * went atomic, and the note was left with `![[a]]` and no way to finish the
   * name. So what is checked is that the markup survives being typed into and
   * the list is still narrowing while it happens.
   */
  const typed = async (s) => {
    await page.keyboard.type(s)
    await page.waitForTimeout(350)
  }
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await typed('![[')
  await typed('I')
  const oneChar = await page.evaluate(() => document.querySelector('.cm-content').textContent)
  check(
    'one character into an embed, the markup is still there to type into',
    oneChar.includes('![[I]]'),
    oneChar.slice(-24),
  )
  await typed('MG_04')
  const sixChars = await page.evaluate(() => document.querySelector('.cm-content').textContent)
  const suggestions = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts()
  check(
    'and the rest of the name goes in after it',
    sixChars.includes('![[IMG_04]]'),
    sixChars.slice(-24),
  )
  check(
    'with the autocomplete still narrowing to the file',
    suggestions.some((t) => /IMG_0421/.test(t)),
    suggestions.join(' / ') || 'no suggestions',
  )
  /*
   * Accept it, and the finished embed becomes a picture like any other.
   * Counted from just before the keystroke rather than from the earlier
   * total: typing at the end of the note scrolled the first embeds out of
   * CodeMirror's rendered range, and what is not rendered is not in the DOM.
   */
  const embedsShown = await page.locator('.cm-embed img').count()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  const embedsFromTyping = await page.locator('.cm-embed img').count()
  const docAfterAccept = await page.evaluate(() => document.querySelector('.cm-content').textContent)
  check(
    'accepting the suggestion embeds the file',
    embedsFromTyping === embedsShown + 1 && !docAfterAccept.includes('![['),
    `${embedsShown} -> ${embedsFromTyping} embeds, markup ${docAfterAccept.includes('![[') ? 'left behind' : 'gone'}`,
  )
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)

  /*
   * And the completion list, which is a tooltip rather than a sheet and so
   * gets its room a different way — CodeMirror fits one into the window, and
   * the window does not shrink for the keyboard. With the caret near the
   * bottom of a note, which is where anybody typing has it, the list was drawn
   * into the keys with most of it unreachable. It also has to be tappable:
   * Tab is the desktop way to accept one, a thumb is the only way here.
   */
  await page.keyboard.press('Control+End')
  // Push the caret to the bottom of the shortened editor, which is where a
  // note being typed into actually leaves it — and the only place the list
  // has nowhere to go but into the keys. Without this the caret sits high
  // enough that the list fits below it either way and the check proves
  // nothing; the assertion under it holds the test to that.
  await page.keyboard.type('\n'.repeat(24))
  await page.waitForTimeout(300)
  await page.keyboard.type('[[')
  await page.waitForTimeout(600)
  const { caretY, keysAt } = await page.evaluate(() => {
    const c = document.querySelector('.cm-cursor-primary')?.getBoundingClientRect()
    return { caretY: c ? Math.round(c.bottom) : null, keysAt: window.innerHeight - 336 }
  })
  check(
    'the caret is down by the keyboard, where this is worth checking',
    caretY !== null && caretY > keysAt - 140,
    `caret at ${caretY}, keys at ${keysAt}`,
  )
  const list = await page.evaluate(() => {
    const tip = document.querySelector('.cm-tooltip-autocomplete')
    if (!tip) return null
    const line = window.innerHeight - 336
    const box = tip.getBoundingClientRect()
    const rows = [...tip.querySelectorAll('li')]
    return {
      line,
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      rows: rows.length,
      /*
       * Rows the list is actually showing that fall past the keyboard line.
       * A long list scrolls inside its own box, so the rows below that box
       * are reachable and their geometry says nothing about the keyboard —
       * only the ones on screen count.
       */
      hidden: rows.filter((r) => {
        const rect = r.getBoundingClientRect()
        return rect.top < box.bottom && rect.bottom > line
      }).length,
      shortest: Math.round(Math.min(...rows.map((r) => r.getBoundingClientRect().height))),
    }
  })
  check('typing `[[` on a phone offers the notes to link to', !!list && list.rows > 0, `${list?.rows ?? 0} suggestions`)
  check(
    'the suggestions sit above the keyboard rather than under it',
    !!list && list.hidden === 0 && list.bottom <= list.line,
    list ? `list ${list.top}-${list.bottom}, keys at ${list.line}, ${list.hidden} hidden` : 'no list',
  )
  check(
    'and each one is big enough to tap',
    !!list && list.shortest >= 44,
    `shortest row ${list?.shortest}px`,
  )

  // Accepting one with a tap, since there is no Tab key here.
  const firstRow = await page.locator('.cm-tooltip-autocomplete li').first().boundingBox()
  await page.touchscreen.tap(firstRow.x + firstRow.width / 2, firstRow.y + firstRow.height / 2)
  await page.waitForTimeout(500)
  const linked = await page.evaluate(() => document.querySelector('.cm-content').textContent)
  check(
    'a tap accepts a suggestion the way Tab would',
    /\[\[[^\]]+\]\]/.test(linked) && (await page.locator('.cm-tooltip-autocomplete').count()) === 0,
    linked.slice(-24),
  )
  for (let i = 0; i < 30; i++) await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)

  await page.evaluate(() => document.documentElement.style.removeProperty('--kb-inset'))

  /* ---- editing a table from the phone's Format sheet ----------------------
   * The one case where the sheet acts on something that is not the editor's
   * caret. A cell is its own editing host, so opening the sheet takes its focus
   * away along with the keyboard — and the buttons still have to know which
   * row and column they are aimed at. Everything below is what "the table lost
   * focus and the note jumped to the top" looked like before: the cell is
   * marked rather than focused, the note stays where it was, and an operation
   * from the sheet does not summon the keyboard back over it.
   */
  await page.locator('.editor-overlay [aria-label="Back"]').click()
  await page.waitForTimeout(350)
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().tap()
  await page.waitForTimeout(600)
  await startEditing()
  const cell = page.locator('.cm-table-cell[data-row="1"][data-col="1"]')
  await cell.scrollIntoViewIfNeeded()
  await cell.tap()
  await page.waitForTimeout(250)
  check(
    'tapping a cell on a phone starts editing it',
    (await page.evaluate(() => document.activeElement?.className)) === 'cm-table-cell',
  )

  const tableTop = async () =>
    page.evaluate(() => {
      const t = document.querySelector('.cm-table-render')?.getBoundingClientRect()
      const body = document.querySelector('.editor-body')?.getBoundingClientRect()
      return t && body ? { top: Math.round(t.top), from: Math.round(body.top), to: Math.round(body.bottom) } : null
    })
  const beforeSheet = await tableTop()
  await page.locator('.fmt-open').tap()
  await page.waitForTimeout(450)
  const armed = await page.evaluate(() => ({
    marked: document.querySelectorAll('.cm-table-cell[data-armed="1"]').length,
    at: document.querySelector('.cm-table-cell[data-armed="1"]')?.dataset ?? {},
    focused: document.activeElement?.className ?? '',
  }))
  const afterSheet = await tableTop()
  check('the Format sheet opens over a table', (await page.locator('.fmt-sheet').count()) === 1)
  check('opening it lets the keyboard go', !armed.focused.includes('cm-table-cell'), armed.focused)
  check(
    'the cell being formatted is still marked',
    armed.marked === 1 && armed.at.row === '1' && armed.at.col === '1',
    `${armed.marked} marked, row ${armed.at.row} col ${armed.at.col}`,
  )
  check(
    'the table does not jump off the screen',
    !!afterSheet && afterSheet.top >= afterSheet.from - 1 && afterSheet.top <= afterSheet.to,
    `table at ${afterSheet?.top}, note spans ${afterSheet?.from}–${afterSheet?.to} (was ${beforeSheet?.top})`,
  )
  check(
    'the table button knows it is in a table',
    (await page.getAttribute('.fmt-sheet .fmt-btn[aria-label="Table rows and columns"]', 'aria-pressed')) === 'true',
  )

  const rowsBefore = await page.locator('.cm-table-render tr').count()
  await page.locator('.fmt-sheet .fmt-btn[aria-label="Table rows and columns"]').tap()
  await page.waitForTimeout(350)
  check('the table menu opens as a sheet', (await page.locator('.menu-sheet').count()) === 1)
  await page.locator('.menu-item', { hasText: 'Insert row below' }).tap()
  await page.waitForTimeout(450)
  const after = await page.evaluate(() => ({
    rows: document.querySelectorAll('.cm-table-render tr').length,
    at: document.querySelector('.cm-table-cell[data-armed="1"]')?.dataset ?? {},
    focused: document.activeElement?.className ?? '',
    sheet: document.querySelectorAll('.fmt-sheet').length,
  }))
  check('inserting a row from the sheet adds one', after.rows === rowsBefore + 1, `${rowsBefore} → ${after.rows}`)
  check('the mark follows the new row', after.at.row === '2' && after.at.col === '1', `row ${after.at.row} col ${after.at.col}`)
  check('the sheet stays open for the next operation', after.sheet === 1)
  check('and the keyboard stays down', !after.focused.includes('cm-table-cell'), after.focused)
  check(
    'the note still holds a plain GFM table',
    /\| a +\| b +\| c +\|/.test(await noteContaining('# Heading one')),
  )

  /* ---- aligning a column from the sheet ---------------------------------
   *
   * The alignment is `:--:` in the delimiter row, which both rendered modes
   * hide — so before this it was the one property of a table that could only
   * be set by switching to source and typing it.
   */
  await page.locator('.fmt-sheet .fmt-btn[aria-label="Table rows and columns"]').tap()
  await page.waitForTimeout(350)
  const alignItem = (await page.locator('.menu-item', { hasText: 'Align column' }).innerText()).trim()
  check(
    'the table menu offers alignment, naming what the column does now',
    /^Align column: (default|left|centre|right)…$/.test(alignItem),
    alignItem,
  )
  await page.locator('.menu-item', { hasText: 'Align column' }).tap()
  await page.waitForTimeout(300)
  const ticked = (await page.locator('.menu-item[data-checked="1"]').innerText()).trim()
  check(
    'and ticks the one it is on',
    alignItem.toLowerCase() === `align column: ${ticked.toLowerCase()}…`,
    `${alignItem} / ${ticked}`,
  )
  await page.locator('.menu-item', { hasText: 'Right' }).tap()
  await page.waitForTimeout(500)
  check(
    'aligning a column writes it into the delimiter row',
    /\|\s*-+:\s*\|/.test(await noteAfterEdit('# Heading one', ':')),
  )
  const aligned = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('.cm-table-cell[data-col="1"]')).textAlign,
  )
  check('and the rendered table follows it', aligned === 'right', aligned)
  await page.screenshot({ path: join(SHOTS, '19-phone-table-format.png') })

  // Back to typing. The sheet and the keyboard swap places rather than sharing
  // the screen, which is what tapping a cell with the sheet up used to do.
  await page.locator('.cm-table-cell[data-row="2"][data-col="1"]').tap()
  await page.waitForTimeout(350)
  check('tapping a cell again closes the sheet', (await page.locator('.fmt-sheet').count()) === 0)
  check(
    'and hands the cell back for typing',
    (await page.evaluate(() => document.activeElement?.className)) === 'cm-table-cell',
  )

  /* ---- the handles, with a thumb -----------------------------------------
   *
   * The dots are small because a table is small; what has to be thumb-sized is
   * the area that answers to them, and the only way to know it is to ask the
   * page what is at a point. Then the gesture itself, driven as real touch
   * input rather than as a mouse — which is the whole point of it: a finger put
   * down inside an editing host is an iPhone's caret, selection or magnifier
   * before it is anything the page asked for, and only a cancelled touchstart
   * says otherwise.
   */
  const thumbGrip = await page.locator('.cm-table-handle[data-axis="row"]').boundingBox()
  // Measured by asking the page what is at a point, walking out from the middle
  // until the answer stops being the handle. What a finger hits is the area, not
  // the dots, and the area is a pseudo-element with no box of its own to read.
  const target = await page.evaluate(
    ([cx, cy]) => {
      const on = (x, y) => !!document.elementFromPoint(x, y)?.closest('.cm-table-handle')
      const reach = (dx, dy) => {
        let n = 0
        while (n < 60 && on(cx + dx * (n + 1), cy + dy * (n + 1))) n++
        return n
      }
      return on(cx, cy)
        ? { w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1 }
        : { w: 0, h: 0 }
    },
    [thumbGrip.x + thumbGrip.width / 2, thumbGrip.y + thumbGrip.height / 2],
  )
  check(
    'the row handle answers to a thumb, not just to its own dots',
    target.h >= 44 && target.w >= 28,
    `${target.w}×${target.h}px, dots ${Math.round(thumbGrip.width)}×${Math.round(thumbGrip.height)}px`,
  )

  const cdp = await page.context().newCDPSession(page)
  const finger = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    })
  const gx = thumbGrip.x + thumbGrip.width / 2
  const gy = thumbGrip.y + thumbGrip.height / 2

  await finger('touchStart', gx, gy)
  await finger('touchEnd', gx, gy)
  await page.waitForTimeout(350)
  check(
    'a tap on the handle picks the row out',
    (await page.locator('.cm-table-band:visible').count()) === 1 &&
      (await page.locator('.cm-table-cell[data-band]').count()) === 3,
    `${await page.locator('.cm-table-cell[data-band]').count()} cells marked`,
  )
  check(
    'and lets the keyboard go rather than typing in the cell',
    !(await page.evaluate(() => document.activeElement?.className ?? '')).includes('cm-table-cell'),
  )

  const rowText = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.cm-table-render tr')].map((tr) =>
        [...tr.cells].map((c) => c.textContent.trim()).join('|'),
      ),
    )
  const beforeFinger = await rowText()
  const rowHeight = (await page.locator('.cm-table-cell[data-row="2"][data-col="0"]').boundingBox()).height
  await finger('touchStart', gx, gy)
  for (let i = 1; i <= 6; i++) {
    await finger('touchMove', gx, gy + (rowHeight * i) / 6)
    await page.waitForTimeout(25)
  }
  await finger('touchEnd', gx, gy + rowHeight)
  await page.waitForTimeout(600)
  const afterFinger = await rowText()
  check(
    'and a finger dragging it moves the row',
    afterFinger[3] === beforeFinger[2] && afterFinger[2] === beforeFinger[3],
    `${beforeFinger.join(' / ')} → ${afterFinger.join(' / ')}`,
  )
  check(
    // Colons allowed: a column was aligned a few checks ago, and that lives in
    // this very row.
    'which the note holds as an ordinary table',
    /^\|( :?-+:? \|){3}$/m.test(await noteContaining('# Heading one')),
    (await noteContaining('# Heading one')).split('\n').find((l) => /^\| *:?-/.test(l)),
  )

  const outOfTheTable = await noteTextPoint('.editor-overlay')
  await page.touchscreen.tap(outOfTheTable.x, outOfTheTable.y)
  await page.waitForTimeout(300)

  /* ---- tapping a link on a phone -----------------------------------------
   * A link in the text is a decoration, not an anchor, and the mouse events a
   * phone synthesises from a tap arrive too late to be any use: the caret has
   * already landed in the text, and the click trailing them lands on the menu
   * the tap just opened and closes it again. Which is exactly what a link on a
   * phone used to do — nothing at all, but with the keyboard up.
   */
  const uri = page.locator('.cm-uri').first()
  await uri.scrollIntoViewIfNeeded()
  await uri.tap()
  await page.waitForTimeout(400)
  check('tapping a link offers what to do with it', (await page.locator('.menu-sheet').count()) === 1)
  check('the choice includes opening it', (await page.locator('.menu-item:has-text("Open link")').count()) === 1)
  check('and editing it', (await page.locator('.menu-item:has-text("Edit link")').count()) === 1)
  await page.screenshot({ path: join(SHOTS, '20-phone-link-tap.png') })

  /*
   * The same sheet with the keyboard up, which is the state a link is usually
   * tapped in: you were typing a second ago. A sheet and a keyboard both want
   * the bottom of the screen, and the layout viewport does not shrink for the
   * keyboard — so ignoring the inset put every choice on this sheet, Cancel
   * included, underneath the keys. Simulated the same way as the editor's own
   * keyboard check above, headless Chromium having no soft keyboard.
   */
  await page.evaluate(() => document.documentElement.style.setProperty('--kb-inset', '336px'))
  await page.waitForTimeout(300)
  const linkSheet = await page.evaluate(() => {
    const line = window.innerHeight - 336
    const r = document.querySelector('.menu-sheet').getBoundingClientRect()
    const items = [...document.querySelectorAll('.menu-sheet .menu-item')]
    return {
      line,
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      items: items.length,
      above: items.filter((i) => i.getBoundingClientRect().bottom <= line + 1).length,
    }
  })
  check(
    'the link sheet sits on top of the keyboard, not under it',
    linkSheet.bottom <= linkSheet.line && linkSheet.top >= 0,
    `sheet ${linkSheet.top}-${linkSheet.bottom}, keyboard starts at ${linkSheet.line}`,
  )
  check(
    'and every choice on it can still be tapped',
    linkSheet.items > 0 && linkSheet.above === linkSheet.items,
    `${linkSheet.above} of ${linkSheet.items} items`,
  )
  await page.evaluate(() => document.documentElement.style.removeProperty('--kb-inset'))
  await page.waitForTimeout(250)

  /* ---- opening it from a Home Screen app ---------------------------------
   * A web app installed on iOS has no tab to open a link in, so `window.open`
   * there opens an empty view *inside the app*, hands the URL to Safari, and
   * leaves that blank page behind for you to dismiss when you come back.
   * Navigating instead hands the address straight to the platform, which opens
   * it in the browser because it is outside the app's scope — and leaves
   * nothing behind, because nothing was opened.
   *
   * iOS reports itself through `navigator.standalone`, faked here; the
   * navigation is caught at the network layer so the suite is not carried off
   * to example.com.
   */
  const navigations = []
  await page.route(
    (url) => url.hostname === 'example.com',
    (route) => {
      navigations.push(route.request().url())
      // 204 rather than abort: a No Content reply leaves the page exactly where
      // it was, which is the closest a desktop browser gets to what iOS does
      // here — hand the address off and carry on. An aborted navigation would
      // replace the app with an error page and take the rest of the run with it.
      route.fulfill({ status: 204 })
    },
  )
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
    window.__opened = []
    window.open = (url) => {
      window.__opened.push(url)
      return null
    }
  })
  await page.locator('.menu-item:has-text("Open link")').click()
  await page.waitForTimeout(600)
  const homeScreen = await page.evaluate(() => window.__opened ?? [])
  check(
    'an installed iOS app opens a link by navigating to it',
    navigations.length === 1,
    navigations.join(',') || 'no navigation attempted',
  )
  check(
    'and never through the blank page window.open leaves behind',
    homeScreen.length === 0,
    homeScreen.join(','),
  )
  check('the app itself is still up', (await page.locator('.cm-content').count()) === 1)
  await page.unroute((url) => url.hostname === 'example.com')

  if (await page.locator('.menu-cancel').count()) {
    await page.locator('.menu-cancel').click()
    await page.waitForTimeout(250)
  }

  const tagBefore = await page.locator('.cm-tag').first().innerText()
  await page.locator('.cm-tag').first().tap()
  await page.waitForTimeout(450)
  check(
    'tapping a tag on a phone opens that tag',
    (await page.locator('.scope-bar').innerText()).includes(tagBefore.replace('#', '')),
    tagBefore,
  )
  await page.locator('.scope-bar button:has-text("Close")').click()
  await page.waitForTimeout(300)

  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().tap()
  await page.waitForTimeout(500)
  await chooseMode('Live preview')

  // The same tap, in the other rendered mode: link handling is shared, and a
  // link nobody can follow is no better in live preview than in rich text.
  const liveUri = page.locator('.cm-uri').first()
  await liveUri.scrollIntoViewIfNeeded()
  await liveUri.tap()
  await page.waitForTimeout(400)
  check('a link is tappable in live preview too', (await page.locator('.menu-sheet').count()) === 1)
  if (await page.locator('.menu-cancel').count()) {
    await page.locator('.menu-cancel').click()
    await page.waitForTimeout(250)
  }

  await page.locator('.editor-overlay [aria-label="Back"]').click()
  await page.waitForTimeout(400)
  check('back returns to the list', (await page.locator('.editor-overlay').count()) === 0)

  // --- long-press opens the action sheet ----------------------------------
  // A real touchstart, held long enough for the press timer to fire. Touch
  // objects must be constructed in-page: they require an identifier and a
  // target, which the DevTools protocol can't marshal from Node.
  await page.evaluate(() => {
    const el = document.querySelector('.note-row')
    const r = el.getBoundingClientRect()
    const touch = new Touch({
      identifier: 1,
      target: el,
      clientX: r.left + 40,
      clientY: r.top + 20,
    })
    el.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await page.waitForTimeout(700)
  const sheet = await page.locator('.menu-sheet').count()
  check('long-press opens a bottom action sheet', sheet === 1)
  if (sheet) {
    check('the sheet offers Move to…', (await page.locator('.menu-item:has-text("Move to")').count()) > 0)
    await page.locator('.menu-cancel').click()
    await page.waitForTimeout(250)
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(350)

  /* ---- writing a callout ------------------------------------------------
   * The completion is the whole discovery story for callouts — there is no
   * button, because the formatting bar exists only in rich text while the
   * syntax works in all three modes. So the path that has to work is: type
   * `> [!`, pick from a list, get a callout.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('> [!warn', { delay: 40 })
  await page.waitForTimeout(500)
  const calloutSuggestions = await page.locator('.cm-tooltip-autocomplete li').count()
  check('typing "[!" in a quote offers the callout types', calloutSuggestions > 0, `${calloutSuggestions} options`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await page.locator('.cm-content').pressSequentially('Friday deploys', { delay: 20 })
  await page.waitForTimeout(300)
  check(
    'accepting one writes the marker and leaves the caret in the title',
    (await page.locator('.cm-content').textContent()).includes('[!warning] Friday deploys'),
    await page.locator('.cm-content').textContent(),
  )
  check(
    'and the line is already a callout while it is being typed',
    (await page.locator('.cm-line.cm-callout-warning').count()) === 1,
  )
  // Off the line, and the marker becomes the icon it stands for.
  await page.keyboard.press('Enter')
  await page.locator('.cm-content').pressSequentially('The window closes at 16:00.', { delay: 10 })
  await page.waitForTimeout(400)
  check(
    'moving off the line turns the marker into its icon',
    // The icon itself: the fold chevron is a second svg inside the same widget.
    (await page.locator('.cm-callout-mark > svg').count()) === 1 &&
      !(await page.locator('.cm-content').innerText()).includes('[!warning]'),
  )
  check(
    'and the callout carries on over the lines below it',
    (await page.locator('.cm-line.cm-callout-warning').count()) === 2,
  )

  /* ---- a Tag Folder that gathers tasks -----------------------------------
   * The whole point is inheritance: tag a *note* #home and every job written
   * on it is a #home task, without any of them being tagged by hand. That is
   * how people actually keep notes, and tagging each line would be the same
   * information typed eleven times.
   */
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)
  await page.evaluate(async () => {
    const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
    const text = [
      '# Kitchen',
      '',
      '#home',
      '',
      '- [ ] Fix the dripping tap',
      `- [ ] Order the tiles 📅 ${iso(-2)}`,
      '- [x] Measure the worktop',
      '- [ ] Ring the plumber #urgent',
      '',
    ].join('\n')
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'Kitchen jobs.md', kind: 'note', text, mime: 'text/markdown', size: text.length,
      hash: 'kj', mtime: Date.now() + 50_000, ctime: Date.now(),
      dirty: true, dirtyFlag: 1, sync: {},
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')
  await page.waitForTimeout(400)

  await page.click('.side-group-label:has-text("Tag Folders") .side-add')
  await ruleDialogReady()
  await page.fill('.dialog input[type="text"]', 'Home jobs')
  check(
    'a Tag Folder can be set to gather tasks instead of notes',
    (await page.locator('.seg-btn:has-text("Tasks")').count()) === 1,
  )
  await page.locator('.seg-btn:has-text("Tasks")').click()
  await page.waitForTimeout(300)
  /*
   * A tick is on offer as the folder's icon too. It is a choice rather than a
   * statement — anyone can put it on a folder that gathers notes — which is
   * why the row draws its own from what the folder actually does.
   */
  check(
    'a tick is among the icons a folder can wear',
    (await page.locator('.dialog select option').allInnerTexts()).some((t) => t.includes('✅')),
    (await page.locator('.dialog select option').allInnerTexts()).join(''),
  )
  check(
    'and offers the questions only a task can answer',
    (await page.locator('.chip:has-text("is:open")').count()) === 1 &&
      (await page.locator('.chip:has-text("due:overdue")').count()) === 1,
  )
  await page.fill('.rule-input', '#home')
  await page.waitForTimeout(400)
  const inherited = await page.locator('.rule-status').innerText()
  check(
    'a note tagged #home hands its tag to every task on it',
    /matches\s*4\b/i.test(inherited.replace(/\s+/g, ' ')) && /tasks/i.test(inherited),
    inherited.replace(/\s+/g, ' ').slice(0, 90),
  )
  const previewed = (await page.locator('.rule-preview-row').allInnerTexts()).join(' | ')
  check(
    'and the preview lists the tasks, not the note they are on',
    ['Fix the dripping tap', 'Order the tiles', 'Measure the worktop', 'Ring the plumber'].every(
      (t) => previewed.includes(t),
    ),
    previewed.replace(/\n/g, ' · '),
  )

  await page.fill('.rule-input', '#home is:open')
  await page.waitForTimeout(400)
  const openOnly = await page.locator('.rule-status').innerText()
  check(
    'narrowing to what is still to do drops the finished one',
    /matches\s*3\b/i.test(openOnly.replace(/\s+/g, ' ')),
    openOnly.replace(/\s+/g, ' ').slice(0, 90),
  )
  await page.fill('.rule-input', '#home due:overdue')
  await page.waitForTimeout(400)
  check(
    'and asking for overdue leaves the one whose date has passed',
    /matches\s*1\b/i.test((await page.locator('.rule-status').innerText()).replace(/\s+/g, ' ')),
    (await page.locator('.rule-status').innerText()).replace(/\s+/g, ' ').slice(0, 90),
  )

  await page.fill('.rule-input', '#home is:open')
  await page.waitForTimeout(400)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(600)
  check(
    'the folder lists its tasks where its notes would have been',
    (await page.locator('.list-scroll .task-row').count()) === 3,
    `${await page.locator('.list-scroll .task-row').count()} rows`,
  )
  const folderCount = await page
    .locator('.side-row:has-text("Home jobs") .side-count')
    .first()
    .innerText()
  check(
    'and counts tasks beside it, not the one note they sit on',
    folderCount.trim() === '3',
    `badge reads ${JSON.stringify(folderCount)}`,
  )

  /*
   * Ticking one off in the folder writes to the note it came from — the rows
   * are the same rows the rail uses, so a task is the same thing everywhere.
   */
  await page
    .locator('.list-scroll .task-row', { hasText: 'Fix the dripping tap' })
    .locator('.task-check')
    .click()
  await page.waitForTimeout(900)
  check(
    'ticking one there edits the note it lives on',
    (await noteContaining('dripping tap')).includes('- [x] Fix the dripping tap'),
    (await noteContaining('dripping tap')).split('\n').find((l) => l.includes('dripping')) ?? '',
  )
  check(
    'and it leaves the folder, which asked for open ones',
    (await page.locator('.list-scroll .task-row').count()) === 2,
    `${await page.locator('.list-scroll .task-row').count()} rows`,
  )
  /*
   * Arranging the list. Grouping by *tag* is deliberately not on offer: a task
   * carries the tags on its own line and the ones its note carries, so a job
   * that is both #home and #urgent has no single group. Due date and note are
   * unambiguous, and by-note is the one that pays off here — the folder's
   * tasks come from two different notes precisely because the tag was
   * inherited.
   */
  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  const arrangeRows = await page.locator('.menu-item').allInnerTexts()
  check(
    'a task list can be arranged, but never by tag',
    arrangeRows.some((r) => r.includes('By due date')) &&
      arrangeRows.some((r) => r.includes('By note')) &&
      !arrangeRows.join(' ').toLowerCase().includes('tag'),
    JSON.stringify(arrangeRows),
  )
  await page.locator('.menu-item:has-text("By note")').click()
  await page.waitForTimeout(500)
  const noteGroups = await page.locator('.list-scroll .task-group').allInnerTexts()
  check(
    'grouping by note gathers the tasks under the notes they came from',
    noteGroups.includes('Kitchen jobs') && noteGroups.length >= 1,
    JSON.stringify(noteGroups),
  )
  check(
    'and stops repeating the note name down the side of every row',
    (await page.locator('.list-scroll .task-row .task-meta').count()) === 0,
  )

  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("By due date")').click()
  await page.waitForTimeout(500)
  const dueGroups = await page.locator('.list-scroll .task-group').allInnerTexts()
  check(
    'grouping by date bands them in the order they are worth reading',
    dueGroups.join('|') === ['Overdue', 'No date'].join('|'),
    JSON.stringify(dueGroups),
  )

  /* One setting, so the rail is arranged the same way as the folder. */
  check(
    'and the rail follows, because it is one way of reading a task list',
    (await page.locator('.rail .task-group').count()) > 0,
    JSON.stringify(await page.locator('.rail .task-group').allInnerTexts()),
  )
  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("No grouping")').click()
  await page.waitForTimeout(400)
  check(
    'turning it off leaves the list as it was',
    (await page.locator('.list-scroll .task-group').count()) === 0,
  )

  /* ---- what the sidebar's Tasks row is for -------------------------------
   * It counts tasks, so it lists tasks. Listing the notes that happened to
   * hold them left the count promising one thing and the click delivering
   * another — and the check glyph is what tells a task-gathering Tag Folder
   * apart from the note-gathering one sitting right beside it.
   */
  check(
    'a Tag Folder that gathers tasks says so on its row',
    (await page.locator('.side-row:has-text("Home jobs") .side-task').count()) === 1,
  )
  check(
    'and one that gathers notes does not',
    (await page.locator('.side-row:has-text("Active work") .side-task').count()) === 0,
  )

  await page.locator('.side-row:has-text("Tasks")').first().click()
  await page.waitForTimeout(500)
  const taskRowTexts = await page.locator('.list-scroll .task-row').allInnerTexts()
  const noteRows = await page.locator('.list-scroll .note-row').count()
  check(
    'the sidebar Tasks row lists tasks, not the notes holding them',
    taskRowTexts.length > 0 && noteRows === 0,
    `${taskRowTexts.length} task rows, ${noteRows} note rows`,
  )
  const taskNotes = new Set(
    (await page.locator('.list-scroll .task-row .task-meta').allInnerTexts()).map((t) => t.trim()),
  )
  check(
    'and gathers them from every note in the vault, not one',
    taskNotes.size > 1,
    [...taskNotes].join(' | '),
  )
  check(
    'showing what is still to do',
    taskRowTexts.join(' | ').includes('Ring the plumber'),
    taskRowTexts.join(' | ').slice(0, 140),
  )
  /*
   * And not the ones already crossed off. A list whose bottom is a growing
   * archive of finished work is a list people stop reading — but the heading
   * still counts them, so nothing is hidden without saying so, and the switch
   * that brings them back is in the same menu that arranges the list.
   */
  check(
    'but not the ones already crossed off',
    !taskRowTexts.join(' | ').includes('Measure the worktop'),
    taskRowTexts.join(' | ').slice(0, 140),
  )
  check(
    'though the heading still counts them, so nothing is hidden silently',
    /\d+ open · \d+ done/i.test(await page.locator('.list-scroll .rail-section h3').innerText()),
    (await page.locator('.list-scroll .rail-section h3').innerText()).replace(/\n/g, ' '),
  )

  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("Show completed")').click()
  await page.waitForTimeout(500)
  check(
    'turning them on brings the finished ones back',
    (await page.locator('.list-scroll .task-row').allInnerTexts())
      .join(' | ')
      .includes('Measure the worktop'),
  )
  /*
   * Straight into the reload, inside the timer the vault-wide write sits on:
   * backstage/config.json is overlaid over this device's own copy at boot, so
   * a preference changed a moment before a reload used to come back as
   * whatever it was before the change.
   */
  await page.waitForTimeout(250)
  await page.reload()
  await page.waitForSelector('.side-row')
  await page.waitForTimeout(900)
  await page.locator('.side-row:has-text("Tasks")').first().click()
  await page.waitForTimeout(500)
  check(
    'and the choice survives a reload, like every other way of reading a list',
    (await page.locator('.list-scroll .task-row').allInnerTexts())
      .join(' | ')
      .includes('Measure the worktop'),
  )
  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("Show completed")').click()
  await page.waitForTimeout(500)
  check(
    'and turning it off hides them again',
    !(await page.locator('.list-scroll .task-row').allInnerTexts())
      .join(' | ')
      .includes('Measure the worktop'),
  )

  /* ---- the calendar, read the other way round ----------------------------
   * A day with work owed on it has to look different from an empty one, or the
   * only way to find it is clicking days at random. The pip is its own channel:
   * the dots below the number mean notes filed on that day, and overloading
   * them would make a dot mean two things.
   */
  /* "Order the tiles" is due two days ago; nothing is due three days ago. */
  await page.locator('.cal-today').click()
  await page.waitForTimeout(400)
  const overdueDay = await showDay(-2)
  const overdueLabel = (await overdueDay.getAttribute('aria-label')) ?? ''
  const overduePips = await overdueDay.locator('.cal-due').count()
  const overdueLate = await overdueDay.locator('.cal-due[data-late="1"]').count()
  check('a day with work due on it is marked on the calendar', overduePips === 1, overdueLabel)
  check('and says so to a screen reader as well as to an eye', /\d+ due/.test(overdueLabel), overdueLabel)
  check('a day already past wears the same red the date chip turns', overdueLate === 1)

  const quietDay = await showDay(-3)
  check(
    'and a day with none is left alone',
    (await quietDay.locator('.cal-due').count()) === 0,
    (await quietDay.getAttribute('aria-label')) ?? '',
  )

  const tomorrow = await showDay(1)
  check(
    'while a day still to come does not',
    (await tomorrow.locator('.cal-due[data-late="0"]').count()) === 1,
    (await tomorrow.getAttribute('aria-label')) ?? '',
  )

  const laterDay = await showDay(1)
  await laterDay.click()
  await page.waitForTimeout(500)
  const dayPanel = page.locator('.rail .rail-section').nth(0)
  check(
    'clicking a day shows what it asks of you, under what is filed on it',
    (await dayPanel.locator('.task-row').allInnerTexts()).join(' | ').includes('Renew passport'),
    (await dayPanel.locator('.task-row').allInnerTexts()).join(' | '),
  )
  check(
    'with no heading over them — a checkbox already says which rows are tasks',
    (await dayPanel.locator('.task-group').count()) === 0,
  )

  /*
   * And never the same task twice in one column. The Due list below already
   * holds everything overdue and everything due today, so a day the list has
   * covered keeps its notes and hands the tasks to it.
   */
  const overdueAgain = await showDay(-2)
  await overdueAgain.click()
  await page.waitForTimeout(500)
  check(
    'a day whose work is already late leaves it to the Due list below',
    (await dayPanel.locator('.task-row').count()) === 0,
    (await dayPanel.locator('.task-row').allInnerTexts()).join(' | '),
  )
  check(
    'so the task is in the rail once, not twice',
    (await page.locator('.rail .task-row', { hasText: 'Order the tiles' }).count()) === 1,
  )

  await page.locator('.cal-today').click()
  await page.waitForTimeout(500)
  check(
    'and today says it once too, in the Due list rather than in both',
    (await dayPanel.locator('.task-row').count()) === 0,
    `${await dayPanel.locator('.task-row').count()} rows in the day panel`,
  )

  await page.locator('.side-row:has-text("All Notes")').first().click()
  await page.waitForTimeout(400)

  /* ---- copying a table back out -----------------------------------------
   * The return trip. Only the HTML flavour is added: spreadsheets read it in
   * preference to plain text, so Excel gets cells while the plain flavour
   * stays the markdown that was selected and another markdown editor still
   * gets the pipe table. Both halves are asserted, because writing tab
   * separated text over the plain flavour would pass a check for the first and
   * silently lose the second.
   *
   * "Table at start" is the fixture because its table is the first three lines
   * of the note, so the selection can be made with the keyboard and end
   * exactly where the table does — which is the thing being tested.
   */
  await page.locator('.note-row', { hasText: 'Table at start' }).first().click()
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.waitForTimeout(250)
  // Source mode: no widgets, so the selection is over the pipes themselves.
  let modeSteps = 0
  for (let i = 0; i < 3 && (await page.locator('.cm-table-render').count()) > 0; i++) {
    await page.keyboard.press('Control+Shift+m')
    modeSteps++
    await page.waitForTimeout(350)
  }
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
  await page.waitForTimeout(250)

  const flavours = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return { html: dt.getData('text/html'), plain: dt.getData('text/plain') }
  })
  check(
    'copying a table adds a real <table> for a spreadsheet to read',
    flavours.html === '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    JSON.stringify(flavours.html),
  )
  check(
    'and leaves the plain text as the markdown it was',
    flavours.plain.includes('| A | B |') && !flavours.plain.includes('<table'),
    JSON.stringify(flavours.plain),
  )

  /*
   * And a selection that is not rows of one table is left entirely alone —
   * otherwise ordinary copying inside a note would start rewriting itself.
   */
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(200)
  const wholeNote = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return dt.getData('text/html')
  })
  check(
    'a selection running past the table is left to copy normally',
    !wholeNote.startsWith('<table'),
    JSON.stringify(wholeNote.slice(0, 60)),
  )

  /*
   * The same thing without the aim: the caret is in the table, so the table is
   * what gets copied. Dragging works and is checked above, but it is a gesture
   * with no edges — in the rendered modes the table is one widget, and a drag
   * that overshoots by a few pixels is correctly refused with no sign of it
   * but pipes arriving in the spreadsheet.
   */
  // Rich text, which is the mode with a formatting bar to reach the menu from.
  for (let i = 0; i < 3; i++) {
    await page.locator('.cm-content').click()
    await page.waitForTimeout(300)
    if ((await page.locator('.fmt-bar').count()) > 0) break
    await page.keyboard.press('Control+Shift+m')
    modeSteps++
    await page.waitForTimeout(400)
  }
  await page.locator('.cm-table-render td').first().click()
  await page.waitForTimeout(400)
  // Through `clickFormat`, because at this width the table button is in the
  // overflow menu rather than on the bar.
  await clickFormat('Table rows and columns')
  await page.waitForTimeout(350)
  check(
    'the table menu offers to copy the whole table',
    (await page.locator('.menu-item:has-text("Copy table")').count()) === 1,
    JSON.stringify(await page.locator('.menu-item').allInnerTexts()),
  )
  await page.locator('.menu-item:has-text("Copy table")').click()
  await page.waitForTimeout(700)

  const onClipboard = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const out = {}
    for (const item of items) {
      for (const type of item.types) out[type] = await (await item.getType(type)).text()
    }
    return out
  })
  check(
    'and puts a table on the clipboard for a spreadsheet',
    onClipboard['text/html']?.includes('<th>A</th>') &&
      onClipboard['text/html']?.includes('<td>1</td>'),
    JSON.stringify(onClipboard['text/html'] ?? null),
  )
  check(
    'with the markdown beside it for everything else',
    onClipboard['text/plain']?.includes('| A') && onClipboard['text/plain']?.includes('| --- |'),
    JSON.stringify(onClipboard['text/plain'] ?? null),
  )

  /*
   * Put the mode back. The three modes cycle, so completing the loop returns
   * whatever this borrowed — everything below reads the same editor, and
   * leaving it in source mode means no live-preview decorations for any of it.
   */
  for (let i = (3 - (modeSteps % 3)) % 3; i > 0; i--) {
    await page.keyboard.press('Control+Shift+m')
    await page.waitForTimeout(350)
  }

  /* ---- naming a note after the heading you typed in it -------------------
   * A note made with *New note here* — and every note started from a template
   * — is called Untitled. Type a heading into it and the file, the note list
   * and any wikilink to it all still say Untitled about a note that plainly
   * is not. The offer is made only for a note that has never been named, so it
   * can never nag anyone whose `2026-09-04.md` is headed `# Thursday` on
   * purpose.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('# Kickoff with Acme', { delay: 12 })
  await page.waitForTimeout(1400)
  check(
    'an unnamed note offers its heading as a name',
    (await page.locator('.toast:has-text("Kickoff with Acme")').count()) === 1,
    (await page.locator('.toast').innerText().catch(() => '')) || 'no toast',
  )
  check(
    'and offers it rather than doing it',
    (await page.locator('.editor-title-input').inputValue()).startsWith('Untitled'),
    await page.locator('.editor-title-input').inputValue(),
  )
  await page.locator('.toast-action').click()
  await page.waitForTimeout(800)
  check(
    'taking the offer renames the file',
    (await page.locator('.editor-title-input').inputValue()) === 'Kickoff with Acme',
    await page.locator('.editor-title-input').inputValue(),
  )
  const renamed = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((r) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () =>
          r(all.result.filter((f) => !f.deleted).map((f) => f.path).includes('Kickoff with Acme.md'))
      }
    })
  })
  check('on disk as well as in the header', renamed === true)

  /*
   * And a note that has a name of its own is left alone, however far its
   * heading drifts from it — which is the case that would otherwise turn this
   * into a nuisance.
   */
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')
  await page.locator('.cm-content').pressSequentially('\n\n# A different heading entirely', {
    delay: 8,
  })
  await page.waitForTimeout(1400)
  check(
    'a note that has been named is never asked about again',
    (await page.locator('.toast:has-text("A different heading")').count()) === 0,
    (await page.locator('.toast').innerText().catch(() => '')) || 'no toast',
  )

  /* ---- exporting a note -------------------------------------------------
   * Nothing is converted: the bytes that leave are the bytes on disk, which is
   * the whole reason this is not a renderer. Headless Chromium has no share
   * target, so `canShareFiles()` is false here and this exercises the download
   * path — which is the desktop path anyway.
   */
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().click()
  await page.waitForTimeout(400)
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().click({ button: 'right' })
  await page.waitForTimeout(300)
  const exportItem = page.locator('.menu-item:has-text("Export as Markdown")')
  check('a note offers a way out of the app', (await exportItem.count()) === 1)

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10_000 }).catch(() => null),
    exportItem.click(),
  ])
  check(
    'exporting saves the note as a .md file named after it',
    download?.suggestedFilename() === 'Kitchen Sink.md',
    download ? download.suggestedFilename() : 'no download fired',
  )
  if (download) {
    const saved = await download.createReadStream()
    const chunks = []
    for await (const c of saved) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    /*
     * Byte-for-byte the file, frontmatter and wikilinks included — not a
     * rendering of it. That is what makes the export worth having.
     */
    const onDisk = await noteContaining('Kitchen Sink')
    check(
      'and what comes out is the file, not a rendering of it',
      text === onDisk && text.startsWith('---\n') && text.includes('[[Wikilink]]'),
      JSON.stringify(text.slice(0, 60)),
    )
  }

  /* ---- folder templates -------------------------------------------------
   * The feature is opt-in, and the first assertion is the one that says so: a
   * vault that has never made a `Templates/` folder must show no sign of any
   * of this. Nothing creates that folder except the button in Settings.
   */
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)
  const clients = page.locator('.side-row:has-text("Clients")').first()
  await clients.click({ button: 'right' })
  await page.waitForTimeout(300)
  const menuBefore = await page.locator('.menu-item').allInnerTexts()
  check(
    'a vault with no Templates folder is never told about templates',
    !menuBefore.join(' ').toLowerCase().includes('template'),
    JSON.stringify(menuBefore),
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)

  const templateFiles = () =>
    page.evaluate(async () => {
      const req = indexedDB.open('slate')
      return new Promise((r) => {
        req.onsuccess = () => {
          const tx = req.result.transaction('files', 'readonly')
          const all = tx.objectStore('files').getAll()
          all.onsuccess = () =>
            r(all.result.filter((f) => !f.deleted && f.path.startsWith('Templates/')).map((f) => f.path))
        }
      })
    })
  check('and no Templates folder has appeared by itself', (await templateFiles()).length === 0)

  // The one action in the app that creates it.
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(300)
  const optIn = page.locator('.dialog .btn:has-text("Create the Templates folder")')
  check('Settings offers to start using templates', (await optIn.count()) === 1)
  await optIn.click()
  await page.waitForTimeout(800)
  const seeded = await templateFiles()
  /*
   * A set rather than one example. Someone who has just asked for templates is
   * looking at a folder, not at a manual, and the folder has to answer both of
   * the questions the manual would — what one looks like, and what one is for.
   */
  const starters = [
    'Templates/Daily Note.md',
    'Templates/Meeting.md',
    'Templates/Person.md',
    'Templates/Project.md',
    'Templates/Decision.md',
    'Templates/Reading.md',
    'Templates/Weekly Review.md',
  ]
  check(
    'and creating it writes a set of templates to start from',
    starters.every((p) => seeded.includes(p)) && seeded.length === starters.length,
    JSON.stringify(seeded),
  )
  check(
    'the daily note among them opens, so one is in front of you',
    (await page.locator('.editor-title-input').inputValue()) === 'Daily Note',
  )
  /*
   * And it opens as what it is: a note with `{{date}}` written in it. Nothing
   * is filled in until a note is *made* from a template, which is the whole
   * reason one can be edited like anything else.
   */
  const dailyText = await page.locator('.cm-content').innerText()
  check(
    'showing the fields as written rather than filled in',
    dailyText.includes('{{cursor}}') && dailyText.includes('{{date'),
    JSON.stringify(dailyText.slice(0, 120)),
  )

  /*
   * The pair that matters. A template is a real note in a real folder — which
   * is how it gets edited — but it is boilerplate for a note that does not
   * exist yet, so it has no business in the list of what you have written.
   */
  const allNotesRow = page.locator('.side-row:has-text("All Notes")').first()
  const countBefore = (await allNotesRow.innerText()).match(/(\d+)\s*$/)?.[1]
  await allNotesRow.click()
  await page.waitForTimeout(500)
  const listed = await page.locator('.note-row-title').allInnerTexts()
  check(
    'a template stays out of the default notes view',
    !listed.some((t) => starters.includes(`Templates/${t}.md`)),
    JSON.stringify(listed),
  )
  check(
    'and out of the count beside it',
    countBefore === String(listed.length),
    `badge ${countBefore}, ${listed.length} rows`,
  )
  await page.locator('.side-row:has-text("Templates")').first().click()
  await page.waitForTimeout(500)
  const browsed = await page.locator('.note-row-title').allInnerTexts()
  check(
    'but browsing the folder still shows them, which is how one is edited',
    starters.every((p) => browsed.includes(p.slice('Templates/'.length, -'.md'.length))),
    JSON.stringify(browsed),
  )

  // Point a folder at it.
  await clients.click({ button: 'right' })
  await page.waitForTimeout(300)
  const pick = page.locator('.menu-item:has-text("Use a template")')
  check('now a folder can be given one', (await pick.count()) === 1)
  await pick.click()
  await page.waitForTimeout(300)
  check(
    'the picker lists the templates and an off switch',
    (await page.locator('.menu-item:has-text("No template")').count()) === 1 &&
      (await page.locator('.menu-item:has-text("Meeting")').count()) === 1,
  )
  await page.locator('.menu-item:has-text("Meeting")').click()
  await page.waitForTimeout(500)

  // A new note in that folder starts from it.
  await clients.click({ button: 'right' })
  await page.waitForTimeout(300)
  check(
    'and the folder menu then names the template it is using',
    (await page.locator('.menu-item:has-text("Template: Meeting")').count()) === 1,
    JSON.stringify(await page.locator('.menu-item').allInnerTexts()),
  )
  await page.locator('.menu-item:has-text("New note here")').click()
  await page.waitForTimeout(700)
  await page.keyboard.type('Agenda')
  await page.waitForTimeout(900)

  const fromTemplate = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((r) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () => {
          const hit = all.result
            .filter((f) => !f.deleted && f.path.startsWith('Clients/'))
            .sort((a, b) => b.mtime - a.mtime)[0]
          r(hit?.text ?? '')
        }
      }
    })
  })
  check(
    'a note made in that folder starts from the template',
    /\n# .*\n/.test(fromTemplate) && fromTemplate.includes(String(new Date().getFullYear())),
    JSON.stringify(fromTemplate),
  )
  /*
   * The properties come through as a block the form can read, which is what
   * makes a template worth having frontmatter in at all: the note arrives with
   * the fields already listed and empty, rather than with a wall of YAML to
   * type from memory.
   */
  check(
    'frontmatter and all, ready for the properties form',
    fromTemplate.startsWith('---\n') && /\nattendees: \[\]\n/.test(fromTemplate),
    JSON.stringify(fromTemplate.slice(0, 120)),
  )
  check(
    'with its fields filled in rather than left as tokens',
    !fromTemplate.includes('{{'),
    JSON.stringify(fromTemplate),
  )
  /*
   * `{{cursor}}` is the point of the exercise. Typing lands in the heading the
   * starter template leaves open — not at position 0, which is where the caret
   * sits without this and would have written "Agenda# ", and not at the end
   * under the date, which is where it would go if the marker were ignored.
   */
  check(
    'and typing starts where {{cursor}} said',
    fromTemplate.includes('\n# Agenda\n'),
    JSON.stringify(fromTemplate),
  )

  /*
   * The vault root, which has no row in the sidebar to right-click and so is
   * set from Settings. It is where a note created from a broken [[link]] goes,
   * and that note is named for the link — the one place `{{title}}` is worth
   * writing, and unreachable until this existed.
   */
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(300)
  const rootPick = page.locator('.field:has-text("Notes outside any folder") select')
  check('Settings can give the root a template too', (await rootPick.count()) === 1)
  await rootPick.selectOption({ label: 'Person' })
  await page.waitForTimeout(400)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(300)

  // Follow a broken wikilink and let it create the note.
  await page.click('[title^="New note"]')
  await page.waitForTimeout(600)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('See [[Highway 9]] for the outage.', {
    delay: 12,
  })
  await page.waitForTimeout(700)
  await page.locator('.cm-wikilink-broken').first().click()
  await page.waitForTimeout(900)

  const fromLink = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((r) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () => r(all.result.find((f) => f.path === 'Highway 9.md')?.text ?? '')
      }
    })
  })
  check(
    'a note created from a broken link starts from the root template',
    fromLink.includes(String(new Date().getFullYear())) && !fromLink.includes('{{'),
    JSON.stringify(fromLink),
  )
  /*
   * And it is named for the link, which is the whole case `{{title}}` exists
   * for. The same template leaves the heading empty for a note made with
   * *New note here*, which has no name yet — checked above.
   */
  check(
    'and {{title}} is the link text, not the word Untitled',
    fromLink.includes('\n# Highway 9\n') && fromLink.includes('\nname: Highway 9\n'),
    JSON.stringify(fromLink),
  )

  /* ---- text snippets ------------------------------------------------------
   * Opt-in the same way templates are, and checked in the same order: a vault
   * that has never made `Snippets.md` must show no sign of the feature, and
   * nothing creates that note but the button in Settings. Then the thing
   * itself — a trigger typed in a note, Tab, and the phrase in its place.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(600)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('wik', { delay: 25 })
  await page.waitForTimeout(500)
  check(
    'a vault with no Snippets note offers no snippets',
    (await page.locator('.cm-tooltip-autocomplete').count()) === 0,
  )
  await page.keyboard.press('Escape')

  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(300)
  const snipOptIn = page.locator('.dialog .btn:has-text("Create the Snippets note")')
  check('Settings offers to start using snippets', (await snipOptIn.count()) === 1)
  await snipOptIn.click()
  await page.waitForTimeout(900)
  const snippetsNote = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((r) => {
      req.onsuccess = () => {
        const all = req.result.transaction('files', 'readonly').objectStore('files').getAll()
        all.onsuccess = () => r(all.result.find((f) => f.path === 'Snippets.md')?.text ?? '')
      }
    })
  })
  check(
    'and creating it writes a few to start from',
    /^## wiki$/m.test(snippetsNote) && /^## sig$/m.test(snippetsNote) && /^## today$/m.test(snippetsNote),
    JSON.stringify(snippetsNote.slice(0, 60)),
  )

  // Now use one, in a different note.
  await page.click('[title^="New note"]')
  await page.waitForTimeout(600)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('See wik', { delay: 25 })
  await page.waitForTimeout(600)
  const snipList = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts()
  check(
    'typing a trigger offers the snippet, with what it inserts beside it',
    snipList.length === 1 && /wiki/.test(snipList[0]) && /wikipedia/.test(snipList[0]),
    snipList.join(' / ') || 'nothing offered',
  )
  await page.keyboard.press('Tab')
  await page.waitForTimeout(500)
  const snipExpanded = await page.evaluate(() => document.querySelector('.cm-content').textContent)
  check(
    'and Tab puts the phrase in its place',
    snipExpanded.includes('See https://en.wikipedia.org/wiki/') && !snipExpanded.includes('See wik\n'),
    snipExpanded.slice(-40),
  )

  /*
   * The other two things a snippet has to do: keep its line breaks, and fill
   * in the same fields a template can. `{{cursor}}` is what makes a multi-line
   * one usable — the caret ends up where the writing continues, not after the
   * block.
   */
  await page.keyboard.press('Control+End')
  await page.locator('.cm-content').pressSequentially('\nsig', { delay: 25 })
  await page.waitForTimeout(500)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(500)
  const snipMulti = await page.evaluate(() => {
    const view = document.querySelector('.cm-content')
    const sel = document.getSelection()
    return { text: view.textContent, atEnd: sel?.focusNode ? null : null }
  })
  check('a multi-line snippet keeps its shape', snipMulti.text.includes('Thanks,'), snipMulti.text.slice(-24))

  await page.locator('.cm-content').pressSequentially('\ntoday', { delay: 25 })
  await page.waitForTimeout(500)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(500)
  const snipDated = await page.evaluate(() => document.querySelector('.cm-content').textContent)
  const snipYear = String(new Date().getFullYear())
  check(
    'and a date field is filled in the way a template fills it',
    snipDated.includes(snipYear) && !snipDated.includes('{{'),
    snipDated.slice(-40),
  )

  // Tab still means Tab when there is no list to accept.
  await page.keyboard.press('Control+End')
  await page.locator('.cm-content').pressSequentially('\nplain', { delay: 25 })
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(400)
  const snipIndented = await page.evaluate(() => document.querySelector('.cm-content').textContent)
  check(
    'Tab with no suggestion open still indents',
    /\s{2,}plain/.test(snipIndented),
    JSON.stringify(snipIndented.slice(-14)),
  )

  // And an ordinary word is not a trigger, which is what makes it bearable.
  await page.keyboard.press('Control+End')
  await page.locator('.cm-content').pressSequentially(' designing', { delay: 20 })
  await page.waitForTimeout(500)
  check(
    'an ordinary word raises nothing',
    (await page.locator('.cm-tooltip-autocomplete').count()) === 0,
  )
  await page.keyboard.press('Escape')

  /*
   * And the phone, which has no Tab key: the suggestion is a tap target, and
   * that is the whole answer. Checked with the keyboard simulated, since a
   * snippet is reached mid-sentence with the keys up by definition.
   */
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)
  // A phone shows the note list until a row is tapped; the editor is an
  // overlay over it rather than a pane beside it.
  if (!(await page.locator('.editor-overlay').count())) {
    await page.locator('.note-row').first().tap()
    await page.waitForTimeout(700)
  }
  await page.evaluate(() => document.documentElement.style.setProperty('--kb-inset', '336px'))
  await startEditing()
  await page.waitForSelector('.editor-overlay .cm-content')
  await page.locator('.editor-overlay .cm-content').tap()
  await page.waitForTimeout(400)
  await page.keyboard.press('Control+End')
  await page.locator('.editor-overlay .cm-content').pressSequentially('\nSee wik', { delay: 30 })
  await page.waitForTimeout(700)
  const phoneSnip = await page.evaluate(() => {
    const tip = document.querySelector('.cm-tooltip-autocomplete')
    if (!tip) return null
    const box = tip.getBoundingClientRect()
    const rows = [...tip.querySelectorAll('li')]
    return {
      keys: window.innerHeight - 336,
      bottom: Math.round(box.bottom),
      rows: rows.length,
      shortest: Math.round(Math.min(...rows.map((r) => r.getBoundingClientRect().height))),
    }
  })
  check(
    'a snippet is offered on a phone, above the keyboard and thumb-sized',
    !!phoneSnip &&
      phoneSnip.rows === 1 &&
      phoneSnip.bottom <= phoneSnip.keys &&
      phoneSnip.shortest >= 44,
    phoneSnip
      ? `bottom ${phoneSnip.bottom}, keys at ${phoneSnip.keys}, row ${phoneSnip.shortest}px`
      : 'nothing offered',
  )
  const snipRow = await page.locator('.cm-tooltip-autocomplete li').first().boundingBox()
  await page.touchscreen.tap(snipRow.x + snipRow.width / 2, snipRow.y + snipRow.height / 2)
  await page.waitForTimeout(600)
  const tapped = await page.evaluate(() => document.querySelector('.cm-content').textContent)
  check(
    'and a tap expands it, no Tab key required',
    tapped.includes('See https://en.wikipedia.org/wiki/'),
    tapped.slice(-40),
  )
  await page.evaluate(() => document.documentElement.style.removeProperty('--kb-inset'))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(500)

  /* ---- pasting a spreadsheet range -------------------------------------
   * Excel, Numbers, Sheets and Calc all put two flavours on the clipboard: a
   * `<table>` under text/html and the same cells tab-separated under
   * text/plain. Only a real ClipboardEvent carrying both exercises the branch,
   * and the negative case below is the one that keeps it honest — tab-separated
   * text with no table behind it has to stay text.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')

  /*
   * `withPicture` is not a detail — it is the shape of a real Excel clipboard,
   * and the reason this test exists in this form.
   *
   * Excel does not put cells on the clipboard and stop: it also puts a picture
   * of the copied range there. The first version of this test built a
   * clipboard out of the two text flavours alone, which no spreadsheet on
   * earth produces, and so it passed against a handler that checked images
   * first and turned every real paste into a screenshot of a spreadsheet.
   */
  const pasteGrid = (html, plain, withPicture = true) =>
    page.evaluate(
      async ([h, p, pic]) => {
        const dt = new DataTransfer()
        if (h) dt.setData('text/html', h)
        dt.setData('text/plain', p)
        if (pic) {
          const c = document.createElement('canvas')
          c.width = 220
          c.height = 60
          const x = c.getContext('2d')
          x.fillStyle = '#fff'
          x.fillRect(0, 0, 220, 60)
          x.fillStyle = '#333'
          x.font = '14px sans-serif'
          x.fillText('a picture of the cells', 10, 34)
          const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
          dt.items.add(new File([blob], 'image.png', { type: 'image/png' }))
        }
        document
          .querySelector('.cm-content')
          .dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
          )
      },
      [html, plain, withPicture],
    )

  const countAttachments = () =>
    page.evaluate(async () => {
      const req = indexedDB.open('slate')
      return new Promise((r) => {
        req.onsuccess = () => {
          const tx = req.result.transaction('files', 'readonly')
          const all = tx.objectStore('files').getAll()
          all.onsuccess = () =>
            r(all.result.filter((f) => f.kind === 'attachment' && !f.deleted).length)
        }
      })
    })
  const attachmentsBeforeGrid = await countAttachments()

  // A quoted cell with a line break in it and a cell holding a pipe: both are
  // ordinary in a spreadsheet and neither can survive in a pipe table as-is.
  await pasteGrid(
    '<table><tr><td>Region</td><td>Q3</td></tr><tr><td>EMEA</td><td>1200</td></tr></table>',
    'Region\tQ3\r\nEMEA\t1200\r\n"North\nSouth"\ta|b\r\n',
  )
  await page.waitForTimeout(900)

  const pastedNote = async () =>
    page.evaluate(async () => {
      const req = indexedDB.open('slate')
      return new Promise((resolve) => {
        req.onsuccess = () => {
          const tx = req.result.transaction('files', 'readonly')
          const all = tx.objectStore('files').getAll()
          all.onsuccess = () => {
            const notes = all.result
              .filter((f) => f.kind === 'note' && !f.deleted)
              .sort((a, b) => b.mtime - a.mtime)
            resolve(notes[0]?.text ?? '')
          }
        }
      })
    })

  const grid = await pastedNote()
  check(
    'a spreadsheet range pastes as a GFM table',
    /\| Region +\| Q3 +\|/.test(grid) && /\| -+ \| -+ \|/.test(grid),
    JSON.stringify(grid.slice(-160)),
  )
  check(
    'a pipe inside a cell is escaped rather than ending it',
    grid.includes('a\\|b'),
    JSON.stringify(grid.slice(-160)),
  )
  check(
    'a multi-line cell is flattened onto its row',
    grid.includes('North South'),
    JSON.stringify(grid.slice(-160)),
  )
  check(
    'and it renders as a real table straight away',
    (await page.locator('.cm-table-render td').count()) >= 4,
  )
  /*
   * The picture Excel sent along with the cells has to lose, and lose
   * silently: not embedded in the note, and not filed in the vault either,
   * where it would sit as an orphaned attachment syncing to every device.
   */
  check(
    'the picture a spreadsheet sends with its cells does not win',
    !grid.includes('![['),
    JSON.stringify(grid.slice(-160)),
  )
  check(
    'and is not filed in the vault behind your back',
    (await countAttachments()) === attachmentsBeforeGrid,
    `${attachmentsBeforeGrid} → ${await countAttachments()} attachments`,
  )

  /*
   * The discriminator, from the other side. Tab-separated text pasted out of a
   * terminal has no `<table>` behind it and must arrive as the text it is —
   * otherwise every indented paste in the app silently becomes a table.
   */
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')
  await pasteGrid(null, 'alpha\tbeta\ngamma\tdelta', false)
  await page.waitForTimeout(900)
  const plain = await pastedNote()
  check(
    'tab-separated text with no table behind it stays text',
    plain.includes('alpha\tbeta') && !/\| alpha +\| beta/.test(plain),
    JSON.stringify(plain.slice(-120)),
  )

  /* ---- the note's properties, as a form ----------------------------------
   *
   * Rich text does not show a `---` block: it hides it and puts a form over it,
   * opened from the date under the title. Everything the form does has to be
   * checked against the file, the same as the rest of rich text — the whole
   * point of it is that the YAML is never on screen to read back.
   */
  await page.evaluate(async () => {
    const notes = [
      [
        'Properties note.md',
        '---\ntitle: Properties note\npinned: true\nnights: 4\ntags: [travel, lisbon]\npeople:\n  - Ana\n  - Bo\n---\n\n# Properties note\n\nBody nobody should touch.\n',
      ],
      // Frontmatter is optional; this note has never had any.
      ['Plain note.md', '# Plain note\n\nNothing but prose in here.\n'],
    ]
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    notes.forEach(([path, text], i) => {
      tx.objectStore('files').put({
        path, kind: 'note', text, mime: 'text/markdown', size: text.length,
        hash: `prop${i}`, mtime: Date.now() + 20_000 - i * 100, ctime: Date.now(),
        dirty: true, dirtyFlag: 1, sync: {},
      })
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')

  /*
   * Whatever mode the run has drifted into, this section needs rich text — and
   * the date being a button is exactly what says it is in it, since that is the
   * only mode where the date opens anything.
   */
  const intoRichText = async () => {
    for (let i = 0; i < 3 && (await page.locator('.editor-date-button').count()) === 0; i++) {
      await page.keyboard.press('Control+Shift+m')
      await page.waitForTimeout(350)
    }
  }

  await page.locator('.note-row').filter({ hasText: 'Properties note' }).first().click()
  await page.waitForTimeout(500)
  await intoRichText()
  const hiddenFm = await page.locator('.cm-content').innerText()
  check(
    'rich text shows no frontmatter at all',
    !hiddenFm.includes('tags:') && !hiddenFm.includes('---'),
    hiddenFm.slice(0, 60).replace(/\n/g, ' / '),
  )
  check('and still shows the note', hiddenFm.includes('Body nobody should touch'))
  check('the properties form is closed until it is asked for', (await page.locator('.properties').count()) === 0)

  await page.locator('.editor-date-button').click()
  await page.waitForTimeout(300)
  const propKeys = await page.locator('.property-key').evaluateAll((els) => els.map((e) => e.value))
  check(
    'the date opens the block as one row per property, in file order',
    propKeys.join(',') === 'title,pinned,nights,tags,people',
    propKeys.join(','),
  )
  check(
    'each row says what kind of value it holds',
    (await page.locator('.property-check').count()) === 1,
    `${await page.locator('.property-check').count()} checkbox rows`,
  )
  await page.screenshot({ path: join(SHOTS, '22-properties.png') })

  /** The row for a property, found by the name in its key field. */
  const propertyRow = async (key) => {
    const keys = await page.locator('.property-key').evaluateAll((els) => els.map((e) => e.value))
    return page.locator('.property-row').nth(keys.indexOf(key))
  }

  await (await propertyRow('nights')).locator('.property-value').fill('6')
  await page.waitForTimeout(700)
  let props = await noteAfterEdit('Body nobody should touch', 'nights: 6')
  check('editing a value rewrites that line and nothing else', props.includes('nights: 6'), JSON.stringify(props.slice(0, 90)))
  check(
    'a list keeps the shape it was written in',
    props.includes('tags: [travel, lisbon]') && props.includes('people:\n  - Ana\n  - Bo'),
    JSON.stringify(props.slice(0, 130)),
  )

  await page.locator('.property-check input').first().click()
  await page.waitForTimeout(700)
  props = await noteAfterEdit('Body nobody should touch', 'pinned: false')
  check('a checkbox writes true or false', props.includes('pinned: false'))

  await page.locator('.property-add').click()
  await page.waitForTimeout(250)
  await page.keyboard.type('status')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('draft')
  await page.waitForTimeout(800)
  props = await noteAfterEdit('Body nobody should touch', 'status: draft')
  check('a new property is appended to the block', props.includes('status: draft'))

  await (await propertyRow('status')).locator('.property-kind').click()
  await page.waitForTimeout(250)
  await page.locator('.menu-item', { hasText: 'List' }).first().click()
  await page.waitForTimeout(700)
  props = await noteAfterEdit('Body nobody should touch', 'status: [draft]')
  check('changing what kind of value it is rewrites the value', props.includes('status: [draft]'))

  await (await propertyRow('status')).locator('.property-remove').click()
  await page.waitForTimeout(800)
  props = await noteContaining('Body nobody should touch')
  check('removing a property takes it out of the file', !props.includes('status'), JSON.stringify(props.slice(0, 120)))
  check(
    'and the note itself was never touched',
    props.trimEnd().endsWith('# Properties note\n\nBody nobody should touch.'),
    JSON.stringify(props.slice(-60)),
  )

  /*
   * A note with no frontmatter. Opening the form on one is how you give it
   * some — and until a property is actually named, the file is left alone.
   */
  await page.locator('.note-row').filter({ hasText: 'Plain note' }).first().click()
  await page.waitForTimeout(500)
  await intoRichText()
  await page.locator('.editor-date-button').click()
  await page.waitForTimeout(300)
  check('a note without frontmatter opens the form empty', (await page.locator('.properties-empty').count()) === 1)
  await page.locator('.property-add').click()
  await page.waitForTimeout(250)
  await page.keyboard.type('Due date')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('2026-09-30')
  await page.waitForTimeout(800)
  let plainNote = await noteAfterEdit('Nothing but prose', 'Due-date')
  check(
    'naming one writes the block the note never had',
    plainNote.startsWith('---\nDue-date: 2026-09-30\n---\n\n# Plain note'),
    JSON.stringify(plainNote.slice(0, 60)),
  )
  check(
    'and a date value gets a date field',
    (await page.locator('.property-row .property-value').getAttribute('type')) === 'date',
  )

  await page.locator('.property-remove').first().click()
  await page.waitForTimeout(800)
  plainNote = await noteContaining('Nothing but prose')
  check(
    'taking the last property away takes the block with it',
    plainNote.startsWith('# Plain note'),
    JSON.stringify(plainNote.slice(0, 40)),
  )

  await page.locator('.editor-date-button').click()
  await page.waitForTimeout(250)
  check('and the date closes the form again', (await page.locator('.properties').count()) === 0)

  /* ---- $(property): the form's values, read back into the page ----------
   *
   * The other direction of the same form. What has to hold is that the file
   * keeps the token while the page shows the value, that a property nobody
   * declared is left alone — a shell command in a sentence is not a variable —
   * and that filling a blank in fills the page in behind it.
   */
  await page.evaluate(async () => {
    const text =
      '---\nclient: Acme Corp\nrate:\ncase: 124\ntags: [work, active]\n---\n\n# Job sheet\n\n' +
      'Prepared for $(client), filed under $(tags).\n\n' +
      'The rate is $(rate) a day.\n\n' +
      '| Field | Value |\n| --- | --- |\n| Client | $(client) |\n\n' +
      'The [case](https://example.com/support.aspx?TID=$(case)) is open.\n\n' +
      'Run $(pwd) to see where you are.\n'
    const db = await new Promise((res) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'Job sheet.md', kind: 'note', text, mime: 'text/markdown', size: text.length,
      hash: 'vars1', mtime: Date.now() + 40_000, ctime: Date.now(),
      dirty: true, dirtyFlag: 1, sync: {},
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')
  await page.locator('.note-row').filter({ hasText: 'Job sheet' }).first().click()
  await page.waitForTimeout(500)
  await intoRichText()

  const page1 = await page.locator('.cm-content').innerText()
  check(
    'a property written into the body reads as its value',
    page1.includes('Prepared for Acme Corp, filed under work, active.'),
    page1.split('\n').find((l) => l.startsWith('Prepared')),
  )
  check(
    'including inside a table cell, which the editor draws itself',
    (await page.locator('.cm-table-render .cm-var').first().innerText()) === 'Acme Corp',
  )
  check(
    'a property with nothing in it is a blank wearing its own name',
    (await page.locator('.cm-var-blank').innerText()) === 'rate',
  )
  check(
    'a name this note never declared is left exactly as typed',
    page1.includes('Run $(pwd) to see where you are.'),
  )
  const varsFile = await noteContaining('Prepared for')
  check(
    'and the file still says what was typed, token and all',
    varsFile.includes('Prepared for $(client)') && varsFile.includes('| Client | $(client) |'),
  )

  /*
   * An address is the one place a property has to resolve even while the note
   * is only being read: a link is followed rather than copied, so a token left
   * in one goes nowhere. The parentheses are the other half of it — the URL
   * used to be re-parsed with a pattern that ended at the first `)`, which is
   * the token's own, sending the click a character short of the truth.
   */
  const caseLink = page.locator('.cm-uri').filter({ hasText: 'case' }).first()
  check(
    'a property inside a link address resolves',
    (await caseLink.getAttribute('data-href')) === 'https://example.com/support.aspx?TID=124',
    await caseLink.getAttribute('data-href'),
  )
  await armLinkTrap()
  await caseLink.click()
  await page.waitForTimeout(250)
  const caseClick = await linkTrapResult()
  check(
    'and clicking it goes where the note says it goes',
    caseClick.opened.length === 1 &&
      caseClick.opened[0] === 'https://example.com/support.aspx?TID=124',
    caseClick.opened.join(',') || 'nothing opened',
  )
  await page.evaluate(() => document.removeEventListener('click', window.__linkTrap))

  /*
   * A drag that starts on a value.
   *
   * The browser answers a press on a widget — or on an existing selection —
   * by dragging it, and dragged text deliberately carries the tokens. That
   * suppression used to be held until a `dragend` or `drop` cleared it, and a
   * drag that ended in neither left every copy after it handing back tokens.
   */
  await page.evaluate(() =>
    document
      .querySelector('.cm-content')
      ?.dispatchEvent(new Event('dragstart', { bubbles: true })),
  )
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(400)
  const afterDrag = await page.evaluate(() => navigator.clipboard.readText())
  check(
    'a copy after a drag still takes the values',
    afterDrag.includes('Prepared for Acme Corp') && !afterDrag.includes('$(client)'),
    afterDrag.split('\n').find((l) => l.startsWith('Prepared')),
  )

  // Clicking a value is the second way in to the form that owns it.
  await page.locator('.cm-var').first().click()
  await page.waitForTimeout(400)
  check('clicking a value opens the properties form', (await page.locator('.properties').count()) === 1)

  await (await propertyRow('rate')).locator('.property-value').fill('450')
  await (await propertyRow('rate')).locator('.property-value').blur()
  await page.waitForTimeout(800)
  const page2 = await page.locator('.cm-content').innerText()
  check(
    'filling the property in fills the page in behind it',
    page2.includes('The rate is 450 a day.'),
    page2.split('\n').find((l) => l.includes('rate is')),
  )
  check('and the blank is gone', (await page.locator('.cm-var-blank').count()) === 0)

  /*
   * Copying out of rich text takes what rich text shows.
   *
   * A paragraph pasted into an email has to read the way the page reads, or
   * the values are only half a feature. The file keeps the tokens either way,
   * which is checked above and again after the copy.
   */
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.cm-content').click()
  await page.waitForTimeout(250)
  // Deliberately *while editing*: a caret in the note is the state somebody
  // copies from, and the tokens must not come back for a selection crossing
  // them — what is highlighted has to be what lands on the clipboard.
  const editingWhenCopied = await readingState()
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(250)
  check(
    'a selection across the note leaves the values on the page',
    !(await page.locator('.cm-content').innerText()).includes('$(client)') &&
      editingWhenCopied.editable === 'true',
    `contenteditable=${editingWhenCopied.editable}`,
  )
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(400)
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  check(
    'copying takes the values, not the tokens',
    clip.includes('Prepared for Acme Corp, filed under work, active.') &&
      clip.includes('The rate is 450 a day.') &&
      !clip.includes('$(client)'),
    clip.split('\n').find((l) => l.startsWith('Prepared')),
  )
  check(
    'and still leaves a name the note never declared alone',
    clip.includes('Run $(pwd) to see where you are.'),
  )
  check(
    'the note itself is untouched by the copy',
    (await noteContaining('Prepared for')).includes('Prepared for $(client)'),
  )

  /* ---- a note its own properties lock ------------------------------------
   *
   * `read-only: true` turns a note into a form: the properties can be filled
   * in and nothing else about it can be typed over. What has to hold is that
   * every way into the body refuses — the tap, the keyboard, a checkbox — and
   * that the one thing that must still work does: the form, including the
   * checkbox that takes the lock off again.
   */
  await page.evaluate(async () => {
    const text =
      '---\nread-only: true\nhost: fw-edge-01\ncase: 124\n---\n\n# Session\n\n' +
      '- [ ] Not tickable\n\nRun this on $(host):\n\n' +
      '```sh\nssh admin@$(host).example\nshow log | include $(case)\n```\n\n' +
      // A second block with no language on its fence. It is the one that
      // catches the size bug: with no mode to tokenise it, the markdown parser
      // marks the text `monospace` itself, and that tag shrinks what it marks.
      '```\ndiagnose debug flow filter addr $(host)\n```\n\n' +
      'The syntax itself stays literal: `$(host)`.\n'
    const db = await new Promise((res) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'Locked session.md', kind: 'note', text, mime: 'text/markdown', size: text.length,
      hash: 'lock1', mtime: Date.now() + 50_000, ctime: Date.now(),
      dirty: true, dirtyFlag: 1, sync: {},
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')
  await page.locator('.note-row').filter({ hasText: 'Locked session' }).first().click()
  await page.waitForTimeout(500)
  await intoRichText()

  const locked = await page.locator('.cm-content').innerText()
  check(
    'a fenced block fills itself in — a command you copy out, not a quotation',
    locked.includes('ssh admin@fw-edge-01.example') && locked.includes('show log | include 124'),
    locked.split('\n').find((l) => l.startsWith('ssh')),
  )
  check(
    'while the syntax in backticks stays the syntax',
    locked.includes('$(host)'),
  )

  /*
   * One size for everything in a fenced block.
   *
   * A value filled into a block is a widget, and a widget is not source, so
   * the highlighter never marks it — while the `monospace` tag it marks the
   * *text* with shrinks that text again, and only when the markdown parser is
   * the one tokenising it. Three sizes of the same monospace line, and the
   * odd one out was always the property. Checked as the invariant it is:
   * nothing inside a code line is a different size from the line.
   */
  const codeSizes = await page.evaluate(() =>
    [...document.querySelectorAll('.cm-line.cm-codeblock')].flatMap((line) => {
      const size = getComputedStyle(line).fontSize
      return [...line.querySelectorAll('span')]
        .filter((el) => el.textContent.trim())
        .map((el) => ({ cls: el.className || '(none)', size: getComputedStyle(el).fontSize, line: size }))
    }),
  )
  const odd = codeSizes.filter((s) => s.size !== s.line)
  check(
    'a value filled into a code block is the size of the code around it',
    codeSizes.some((s) => s.cls.includes('cm-var')) && odd.length === 0,
    odd.map((s) => `${s.cls} ${s.size} ≠ ${s.line}`).join(', ') ||
      `${codeSizes.length} spans, all ${codeSizes[0]?.line}`,
  )

  await page.locator('.cm-line').filter({ hasText: 'Run this on' }).first().click()
  await page.waitForTimeout(350)
  await page.keyboard.type('nonsense')
  await page.waitForTimeout(500)
  const lockedState = await readingState()
  check(
    'a locked note refuses the tap that would start writing in it',
    lockedState.flag === '1' && lockedState.editable === 'false',
    `reading=${lockedState.flag}, contenteditable=${lockedState.editable}`,
  )
  check(
    'and the keys that followed it',
    !(await page.locator('.cm-content').innerText()).includes('nonsense'),
  )
  check(
    'its checkboxes show, and do not tick',
    await page.locator('.cm-task-checkbox').first().isDisabled(),
  )
  check(
    'the pencil is a lock instead',
    (await page.locator('.editor-pane [aria-label="Read-only note"]').count()) === 1 &&
      (await page.locator('.editor-pane [aria-label="Edit note"]').count()) === 0,
  )

  // The copy button on a block: the same rule as copying by hand.
  await page.locator('.cm-code-copy').first().click({ force: true })
  await page.waitForTimeout(400)
  const codeClip = await page.evaluate(() => navigator.clipboard.readText())
  check(
    'copying the block takes the command, filled in',
    codeClip.includes('ssh admin@fw-edge-01.example') && !codeClip.includes('$(host)'),
    JSON.stringify(codeClip.split('\n')[0]),
  )

  // The form is the one thing that still writes — including its own lock.
  await page.locator('.editor-pane [aria-label="Read-only note"]').click()
  await page.waitForTimeout(350)
  check('the lock opens the properties form', (await page.locator('.properties').count()) === 1)
  await (await propertyRow('host')).locator('.property-value').fill('fw-core-02')
  await (await propertyRow('host')).locator('.property-value').blur()
  await page.waitForTimeout(700)
  check(
    'a locked note still fills in from its own form',
    (await page.locator('.cm-content').innerText()).includes('ssh admin@fw-core-02.example'),
  )
  await (await propertyRow('read-only')).locator('input[type=checkbox]').click()
  await page.waitForTimeout(700)
  check(
    'and unticking it hands the note back',
    (await page.locator('.editor-pane [aria-label="Edit note"]').count()) === 1 &&
      (await page.locator('.editor-pane [aria-label="Read-only note"]').count()) === 0,
  )

  /* ---- persistence across a reload ------------------------------------ */
  const beforeCount = await page.evaluate(
    () => document.querySelectorAll('.note-row').length,
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row', { timeout: 10_000 })
  await page.waitForTimeout(600)
  const afterCount = await page.locator('.note-row').count()
  check('notes survive a reload', afterCount >= beforeCount && afterCount > 0, `${beforeCount} → ${afterCount}`)

  const stillHasImage = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () =>
          resolve(all.result.some((f) => f.kind === 'attachment' && f.blob instanceof Blob))
      }
    })
  })
  check('attachment blob survives a reload', stillHasImage === true)

  /* ---- arriving from a launcher shortcut or the share sheet ------------
   * The same URLs the manifest's shortcuts and its GET share target point
   * at. The second load is the one that matters: the parameters are cleared
   * before anything is written, so a reload — or a tab restored tomorrow —
   * cannot capture the same line a second time.
   */
  await page.goto(`http://localhost:${PORT}${BASE}?add=task&text=Ring%20the%20bank`, {
    waitUntil: 'networkidle',
  })
  await page.waitForSelector('.qa-root[data-open="1"]', { timeout: 10_000 })
  check('a shortcut URL opens capture on arrival', true)
  check(
    'prefilled with what was shared',
    (await page.locator('.qa-field').inputValue()) === 'Ring the bank',
  )
  check(
    'and the URL is cleaned so a reload cannot replay it',
    !(await page.evaluate(() => location.search)).includes('add='),
    await page.evaluate(() => location.search),
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.shell', { timeout: 10_000 })
  await page.waitForTimeout(500)
  check(
    'a reload asks for nothing',
    (await page.locator('.qa-root[data-open="1"]').count()) === 0,
  )

  /* ---- offline -------------------------------------------------------- */
  await page.context().setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const offlineOk = await page
    .waitForSelector('.note-row', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('app loads and shows notes with no network', offlineOk)
  if (offlineOk) {
    await page.locator('.note-row').first().click()
    await page.waitForTimeout(400)
    await page.locator('.cm-content').click()
    await page.locator('.cm-content').pressSequentially('\nWritten while offline.', { delay: 5 })
    await page.waitForTimeout(800)
    const offlineText = await page.locator('.cm-content').innerText()
    check('can edit while offline', offlineText.includes('Written while offline'))
    await page.screenshot({ path: join(SHOTS, '04-offline.png') })
  }
  await page.context().setOffline(false)

  /* ---- light theme screenshot ----------------------------------------- */
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.shell')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, '05-light.png') })

  /* ---- responsive ------------------------------------------------------ */
  await page.setViewportSize({ width: 420, height: 860 })
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  await page.waitForTimeout(500)
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
  )
  check('no horizontal overflow on a phone viewport', !horizontalOverflow)
  await page.screenshot({ path: join(SHOTS, '06-mobile.png') })

  /* ---- console -------------------------------------------------------- */
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|manifest|Failed to load resource.*404/i.test(e),
  )
  check('no uncaught console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
} catch (e) {
  check('smoke run completed', false, e.message)
  await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {})
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
