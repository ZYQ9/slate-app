# Slate

A local-first markdown notes PWA. Apple Notes' layout, Obsidian's linking, plain
`.md` files in a folder you own, and sync that is built to never lose a note.

Runs installed on Windows, macOS, Linux, Android and iOS from one codebase. No
server to run — the app is static files; your notes live on your WebDAV server or
in your Google Drive.

![Slate in dark mode](screenshots/app-dark.png)

---

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # typecheck + production build into dist/
npm run preview        # serve the production build
npm test               # 918 unit and two-device sync tests
node scripts/smoke.mjs # 612-check browser smoke test against dist/
```

The app works immediately with no configuration — it just stays on one device
until you set up a backend in Settings (⌘,).

---

## What it does

**Writing.** Three ways to look at the same file, switched in Settings or with
⌘⇧M, and the buffer is always the exact text of the `.md` file in all of them,
so nothing is ever silently rewritten:

- **Rich text** — a word processor. No `#`, no `**`, ever: a formatting bar
  (Title / Heading / Subheading / Body, **B** *I* <u>U</u> ~~S~~, highlight,
  text colour, monospace, lists, checklists, indent, quote) applies the markdown
  for you and lights up to show what the caret is sitting in. On a phone the same controls
  open as a Format sheet from the **Aa** button. Markdown still works while you
  type — `# ` at the start of a line is still a Title, and the marker vanishes
  the moment it becomes one. Applying a marker leaves the caret after it, so a
  new checklist item is ready to be typed into rather than in front of its own
  checkbox.

  **Every key is measured against what you can see**, rather than against the
  characters behind it. A checklist line has two caret positions on one stretch
  of screen — in front of the checkbox and behind it — and they do different
  things, which is the point of having both:

  |  | Enter | Backspace |
  | --- | --- | --- |
  | in front of the checkbox | the item moves down a line | the item moves back up |
  | behind it | another checkbox, above | the checkbox comes off |

  Click either side of the box to get the one you want; the arrow keys step
  over the whole marker rather than through it, and typing in front of a
  checkbox puts the words in the item rather than in front of its markup. A
  bullet works the same way. A heading has no marker drawn for it, so its two
  positions are one place: Enter there takes the heading down with its words and
  leaves blank space above, and Backspace takes that space back before it takes
  the style off — so it undoes the Enter that made it. Delete at the end of a
  line is the same rule facing the other way. Elsewhere on a line the same idea
  holds: Enter at the end of a highlighted phrase lands after the highlight
  rather than through it. And what you copy carries what you cannot see with it:
  a highlighted word arrives somewhere else still highlighted, a heading still a
  heading, and cutting one leaves an empty line rather than a stray `## `.

  The bar also inserts the two things markdown makes tedious by hand: a
  **link**, through a dialog with the words and the address as separate fields,
  and a **table**, which then offers add/remove row and column from the same
  button, along with *Copy table* for getting one into a spreadsheet. A table cell
  is typed into directly, and on a phone it stays outlined while the Format
  sheet is up — the sheet only opens once the keyboard is down, so the cell has
  necessarily lost its focus, and "add a row below" has to be beside a row you
  can still see. The table has handles of its own besides: a "⋯" over the column
  and beside the row you are in, which pick that band out, open its own menu on
  a second press, and drag to reorder.

  **The bar never runs off the edge of the pane.** The editor is the panel that
  never yields width, so with the calendar inline and both left panels open
  there can be less than half the bar's natural width to put it in. What does
  not fit collapses into a **…** at the right-hand end, which opens the rest as
  a menu — with each control's full name, whether it is currently on, and
  greyed out when it does not apply, the same as the button would be. Groups go
  whole rather than button by button, so the bar never strands one orphaned
  control from a group whose siblings are all in the menu, and they come back as
  soon as there is room. It is a bar-only affordance: the phone's Format sheet
  is as wide as the screen and lays the same controls out over three rows.
- **Live preview** — formatting renders as you type, and the raw syntax
  reappears the moment your caret enters it.
- **Markdown source** — the file, exactly as it is written.

Underline has no markdown syntax, so it is written as `<u>…</u>`, which every
renderer passes through; highlight uses `==text==`. **Colour** is the same idea
carrying a value — `<span style="color:#cf222e">…</span>`, so a coloured note
is still coloured in Obsidian or on GitHub. The picker offers eight, because a
colour has to stay legible on both backgrounds and a free-form wheel offers a
thousand ways to write a note you cannot read tonight; each is stored as its
light-theme hex and swapped for a lighter one when the app is dark, so the file
stays portable and the screen stays readable. A colour from somewhere else is
honoured as written. Everything else is ordinary CommonMark, and a note written
in rich text opens as plain markdown anywhere else.

**A note's properties are a form, not a wall of YAML.** The `---` block at the
top of a file — the `date:`, `tags:` and `pinned:` the rest of the app reads —
is hidden in rich text, and the date under the title is what opens it: click
that and the block becomes one row per property, with its name, its value, and
an icon saying what kind of value it is. Text, list, number, date or checkbox —
pick a different one from that icon and the value in the file is rewritten to
match, so a date gets a date field and a checkbox gets a checkbox. **Add
property** adds one, the name is edited in place, and the **×** takes it away.
Live preview and source still show the block exactly as it is written; they are
the modes for looking at the file.

**No note needs any of it.** Frontmatter is optional in a markdown file and
optional here: a note that has none opens the form empty, nothing is written
until a property is actually named, and deleting the last property takes the
`---` block away with it, leaving the file the way it started. Each edit
rewrites one line and nothing else — a property the form has no opinion about,
a comment somebody left in the block, whether a list was written as `[a, b]` or
one item per line, all come back out of the file exactly as they went in.

**A property can be written into the note as well as into the form.** `$(client)`
anywhere in the body reads as that property's value in rich text and live
preview:

````markdown
---
client: Acme Corp
contact: Dana Reyes
case: 124
rate:
---

# Job sheet

Prepared for **$(client)**, attention $(contact). The rate is $(rate) a day.

The ticket is [case $(case)](https://support.example/c.aspx?TID=$(case)).

```sh
ssh admin@$(client).example
```
````

reads as *Prepared for **Acme Corp**, attention Dana Reyes. The rate is ⟨rate⟩
a day.* — with `rate` drawn as a dashed blank, because it has been named and
not yet filled in. The link goes to `…?TID=124`, and the block says
`ssh admin@Acme Corp.example`. That is what makes a template a form: write the
note once with the properties it needs, and every note made from it fills
itself in as its properties are filled in. Typing `$(` offers the note's own
properties, with their values, so there is nothing to remember, and clicking a
value opens the properties form at the property it came from.

Where it resolves, and where it deliberately does not:

| Written in | What happens |
| --- | --- |
| a sentence, a heading, a list, a table cell | the value, styled as the text around it |
| a fenced code block | the value — a block is a thing you copy out and run. It takes the size of the code around it, and not its syntax colour, so a filled-in value is visible as one |
| a link or embed address | the value, wherever it is followed — reading included |
| `` `$(client)` `` in backticks | left as typed: this is how the syntax is written *about* |
| the `---` block itself | left as typed; a property quoting another is a knot |
| source mode | left as typed — that mode is the file |

Three rules keep it out of the way. **The file is never rewritten** — `$(client)`
is what is on disk and what every other markdown editor sees, exactly like the
rest of live preview. **Only a property the note declares is touched**, so
`$(pwd)` in a sentence about the shell is left alone, and a note with no
frontmatter has nothing to substitute. And **a caret** in one reveals the token,
so a name can be corrected without deleting anything — a caret, in rich text,
and not a selection that merely crosses it: selecting a paragraph to copy it is
not editing the names inside it. Live preview reveals on either, because there
the source is the thing being worked on.

**Copying out of rich text takes the values.** Select a paragraph there — or
press a code block's copy button — and what lands on the clipboard is what the
page says, so a note can be pasted into an email, or a command into a terminal,
without the reader seeing the wiring. Live preview and source copy the file, as
they show it. Cut and drag deliberately still carry the tokens: both are
usually a move from here to there in the same note, and a move that pasted
values back in would flatten its properties into fixed text without changing a
word on screen — damage nobody would notice until the day they changed a
property and half the note failed to follow. A property still waiting to be
filled in copies as its token too, which is easier to spot in an email than a
hole.

**`read-only: true` makes the note a form.** Add it as a checkbox in the
properties panel — or write it in the block by hand, where `readonly`,
`read_only` and `yes` are all understood — and the body stops accepting edits
in every mode: no caret, no keyboard, no checkbox to tick, no table cell to
type in, nothing pasted or dropped in, and the pencil in the header becomes a
lock. What still works is the properties form, which the lock itself opens, and
which is where the checkbox is unticked to hand the note back. Its tasks stay
in the Tasks view and say so rather than ticking if you try. That is the pairing
worth having: a page whose every changeable part is a labelled field cannot be
knocked out of shape by the person filling it in, and one built to be copied out
of stays exactly as it was written.

**A note opens as a page to read.** No caret anywhere in it, which on a phone is
the difference between opening a note and opening a note with a keyboard across
the bottom half of it before you have read a word. Tap the text and that is
where the caret lands — the tap that starts the edit is the tap that says where
— or press the pencil in the header, which starts you at the top of whatever is
on screen rather than scrolling the note out from under you. **The pencil's own
slot becomes the way back**: while you are writing it is a tick that hands the
note back to being read, which Escape does too and which a phone has no Escape
key for. Links, checkboxes, images and a task's date chip all still answer
a tap while reading, so you can work through a note without falling into the
editor, and a checkbox ticked or a date set in passing still saves: reading is
not read-only. A brand new note is the
one exception — there is nothing in it to read, so it opens with the caret
already in it, and so do the notes the app seeds for you, like a new daily note.
While a note is being read the formatting bar, the phone's **Aa** button and
Insert are not on screen; all three act on a caret, and there is not one yet.

Above every note, in all three modes, sits the date it was last edited — faint,
centred and out of the way, the way Apple Notes does it. Hover it for when the
note was created.

The body itself runs flush with the left edge of its pane and takes the full
width, so on a big monitor a wider window is wider text rather than wider
margins. Settings → Editor → **Body width** switches it to a centred 760px
reading column instead; the backlinks underneath follow whichever you pick.

**Links that leave the vault.** A `https://`, a `mailto:`, a `tel:`, an
`ssh://` to the box you keep notes about — written as markdown or left bare —
renders as a link and opens in whatever program handles it. With a pointer a
click opens and a right-click offers *Open · Copy · Edit*; on a phone, where
there is no right-click and the address is hidden behind the label, a tap
offers the same three. That tap is handled as a tap rather than as the mouse
events a phone invents from one afterwards — they arrive too late to keep the
caret out of the text, and the click trailing them would land on the menu the
tap just opened. Installed on an iOS Home Screen, a web link is handed to the
system rather than opened in a window of its own: there is no tab to put one in,
so `window.open` there opens an empty view inside the app and leaves it behind
for you to dismiss. `javascript:` and `data:` are never opened: a note that syncs
from a shared vault is untrusted input.

**Linking.** `[[Note Title]]` links notes to each other. Typing `[[` opens an
autocomplete over every note; picking one that doesn't exist yet offers to create
it. Clicking a broken link creates the note on the spot. Renaming a note rewrites
every link that pointed at it. Each note lists its own backlinks underneath.

**Images and files.** Paste, drop, or use the toolbar's insert button — **File
in Slate**, **Take Photo**, **Photo Library**, or **Upload a File**. File in
Slate opens a picker over everything already in the vault: type to filter it by
name or folder, arrow through the results, Enter to embed the one you meant — so
the image you attached last week goes into a second note without being uploaded
a second time. Take Photo and Photo Library only appear on the devices that have
them; on a desktop they were two names for the same file dialog. Every route
lands in the same place: images are re-encoded on the way in — a 1.4 MB
screenshot becomes 11 KB of WebP, a 122× reduction, with no visible difference
at reading size — and every image is resizable by dragging its right edge (the
width is written back into the markdown as `![[img.png|400]]`) and opens in the
lightbox on click.

**Four kinds of file draw themselves in the note**, and each of the four takes a
width the same way:

| In the note | Dragging its edge writes |
| --- | --- |
| a picture — PNG, JPEG, WebP, AVIF, GIF, SVG, BMP | `![[shot.png\|400]]` |
| a video with its controls — MP4, WebM, MOV | `![[clip.mp4\|520]]` |
| a player — MP3, M4A, WAV, OGG, FLAC, AAC | `![[take-1.mp3\|300]]` |
| a PDF's first page, drawn by pdf.js, with the page count under it | `![[spec.pdf\|360]]` |

Dragging one close to the full width of the pane drops the number again, so the
common case stays free of a hard-coded size. The same widths are understood in
plain-markdown form as a URL fragment other renderers ignore —
`![alt](spec.pdf#w=360)`.

**Everything else gets a card that says what it is**: the file's name, its
extension and its size, over a mark drawn for its kind — a spreadsheet, a
document, a presentation, an archive, a font, an ebook, code, plain text. That
mark is the point of them. A project note pointing at four attachments used to
be four identical grey rectangles that had to be read one at a time; now the
zip, the deck, the invoice and the font are told apart at a glance, and the
same marks name the same files in the Files browser and in the picker. A card
opens its file in the lightbox, which shows what it can and offers a download
for what it cannot. A picture in a format this browser has no decoder for — a
TIFF outside Safari, a HEIC outside Apple's — quietly becomes one of these
cards rather than a broken image, as does a video in a container it cannot
play.

In the lightbox a picture is handled rather than operated: pinch to zoom around
whatever is between your fingers, drag to move around it — it stops with its
edge at the edge of the screen rather than sliding off into the dark — and tap
to go from fitted to 2× and back. A pointer gets the same gestures (drag to pan,
click to zoom) plus the `−` / `1:1` / `+` buttons and the `-`, `0`, `+` keys;
those buttons are hidden on a phone, where fingers do the job better and the
space is worth more to the file name.

**PDFs are drawn by the app rather than by the browser**, in the note and in
the viewer alike, which is not a preference: pointing an `<iframe>` at a PDF —
the usual trick, and what this used to do — gives you page one as a still
picture on iOS, with no scrolling to page two and no pinch, and a blank
rectangle on Android Chrome, which has no PDF plugin for frames at all. So the app draws the pages itself, all of them, in one
column that scrolls. Pinch to zoom and the pages are *redrawn* at the new size
rather than magnified; on a desktop the `−` / `Fit` / `+` buttons and the `-`,
`0`, `+` keys do the same, as does ctrl-scroll or a trackpad pinch. The words stay real
text laid over the picture, so they can still be selected, copied and found with
the browser's own search. Only the pages near the screen hold a canvas, so a
three-hundred-page scan does not cost three hundred pages of memory. And it
works with the network off like the rest of the app: pdf.js, its worker and its
image decoders are precached — about two megabytes of a three-and-a-half
megabyte install, which is the honest price of a PDF that opens on a plane.

The page inside a note is the same machinery kept deliberately small: the first
page only, at the width the embed is shown at, and only once it has scrolled
near the screen — so a note listing a dozen invoices costs one document open,
not a dozen. Clicking it opens the real viewer, where the rest of the pages
are.

In rich text an image stays an image: putting the caret beside one never swaps
it back for `![[img.png]]`, and it takes no margin of its own, so a line of
text sits immediately above or below it unless you write a blank line. The one
exception is an embed being written — while the caret is between the brackets
the markup stays visible, because a widget that swallows the target at the
first character typed leaves `![[a]]` and no way to finish the name.

A capture that arrives as a bare `image.jpg` gets a dated name so a folder of
them stays browsable; a library filename you'd recognise — `IMG_0421`,
`Screenshot 2026-08-31` — is kept as-is.

**Renaming a file repoints every note that used it**, in the shape each
reference was written in: a bare `![[logo.png]]` stays bare, a path relative to
the note stays relative, a full vault path stays full. Right-click a file (or
swipe it on a phone) to rename or delete it; deleted files go to Recently
Deleted like anything else.

**Files that nothing points at are flagged.** The Files browser marks every
attachment no note references — embedded or plainly linked, by path, relative
path or bare filename — as **Orphaned**, and the count in the header filters the
list down to them. A file in the vault that no note uses is invisible dead
weight that still syncs to every device; this is how you find it before there
are two hundred of them.

**Tables render as tables**, including the formatting inside their cells: bold,
italics, `code`, strikethrough, links, wikilinks, tags and images all render in a
cell.

In rich text you type straight into the cells — the table never shows its pipes.
Tab moves along a row and Enter down a column, both adding a row when they run
off the end; Escape puts you back in the note. A pipe typed into a cell is
escaped rather than becoming a new column, and the file goes on holding an
ordinary GFM table, printed with its columns lined up so it still reads as text.
Live preview keeps its own contract: clicking a table there puts the caret in
the pipe source, the same way the caret reveals every other construct it sits
in.

**A cell being worked in grows handles**, a "⋯" over its column and one beside
its row, and they are how a table is rearranged without going to a menu at all:

- **press one once** and that row or column is outlined — which is also the only
  way to be sure, on a phone with the keyboard up over half the table, which row
  the next thing you press will act on;
- **press it again** for that band's menu: insert either side of it, move it,
  align it if it is a column, delete it. Narrower than the toolbar's, and aimed
  at the row you can see picked out rather than at wherever the caret is;
- **drag it** to reorder. The table rearranges as you go, so you are looking at
  the result rather than at a line between two rows, and only the drop is
  written — a reorder is one undoable edit, not one per row crossed.

The header stays put: nothing can be dragged above it, because a GFM table
without a header is not a table. Reordering is on the keyboard too — *Move row
up* and *Move column left* are in both menus — since a drag is a gesture nothing
else in the note requires.

On a touch screen the dots stay the size they are — they sit beside a table and
have to look it — and the gutter they live in grows instead, taking the area
that answers to them with it: 30×70 to the eye's 15×34. And the gesture is read
from the touch events rather than from pointer events, which is what makes it
work on an iPhone: a finger put down inside an editing host is iOS's caret,
selection or magnifier before it is anything the page asked for, and the only
way to say otherwise is to cancel the touch — which can only be done on a touch
event. It buys the rest for free, too, since a touch is captured by the element
it started on and the click iOS would synthesise afterwards never happens.

**Columns align from the same menu** that adds and removes them: *Align
column…* names what the one you are in does now and offers default, left,
centre and right. It writes GFM's own `:--`, `:--:` and `--:` into the
delimiter row — the row both rendered modes hide, which is why this needed a
menu item rather than the two characters it comes down to.

**A spreadsheet range pastes as a table.** Copy cells in Excel, Numbers, Sheets
or Calc and paste: you get a GFM table with the columns lined up, not a wall of
tabs. Excel puts *three* things on the clipboard — a `<table>` under
`text/html`, the same cells tab-separated under `text/plain`, and a **picture**
of the range as an ordinary PNG. The picture is the trap: an image-first paste
handler files that instead, and a spreadsheet paste becomes a screenshot of a
spreadsheet. So the table is looked for first, and nothing is lost by it —
finding a table needs a `<table>` in the html *and* text that parses as a grid
at least two columns wide, which a copied image matches neither of.

The two text flavours are both used, for different jobs. The HTML is only ever a *discriminator*: its presence is what
says this came out of a grid rather than out of a terminal, which nothing in the
plain text can tell you, so tab-separated text pasted from anywhere else stays
text. The cells themselves are read from the plain-text flavour, because Excel's
HTML is a wall of `mso-` styles and parsing it would mean trusting markup from
outside the app.

The two things a spreadsheet holds that a pipe table cannot are handled on the
way in rather than dropped: a cell containing a `|` is escaped so it can't end
its column, and a multi-line cell is flattened onto its row.

**And back out again.** Select rows of a table, copy, and they land in Excel as
cells. Only the HTML flavour is added, which is the whole trick: every
spreadsheet reads HTML in preference to plain text — it is how a table copied
from a web page lands in cells, and it is the same flavour Excel *emits*, which
is what the paste above keys off. So the plain-text flavour is left as the
markdown you selected, and the same copy pastes into another markdown editor as
the pipe table it was. Writing tab-separated text over the top would have
bought the first and lost the second.

There are two ways to ask. **Put the caret in the table and choose *Copy table*
from the table button** — the same ⊞ that adds and removes rows — which is the
reliable one, and the only practical one on a phone. Or **select the rows and
copy**, which works in all three modes but is a gesture with no edges: in rich
text and live preview the table is a single widget, and a drag that overshoots
it by a few pixels has taken in the paragraph underneath.

That is because the selection route is deliberately strict about what counts.
Selecting a word inside a cell is a request for that word, so a selection has to
cover a whole line or run across more than one; and every line it touches has to
belong to the same table, or a selection running from the last row into the
paragraph below would quietly drop the paragraph. Anything that doesn't qualify
copies exactly as it did before — which is safe, but silent, which is why the
menu item exists. Either way the `| --- |` row is left behind: it is markdown
bookkeeping, not data.

**Block quotes can say what kind of aside they are.**

```markdown
> [!WARNING] Friday deploys
> The window closes at 16:00.
```

renders as a titled, coloured callout with an icon. The syntax is **GitHub's**,
which is the reason to like it: GitHub renders these, every other markdown tool
falls back to an ordinary blockquote, and the file on disk stays plain
CommonMark — a note with callouts in it loses the tint somewhere else and
nothing more.

Five colours, because five is what GitHub defines — `note`, `tip`, `important`,
`warning`, `caution` — and every extra one is a hue that has to stay legible in
both themes forever. The longer vocabulary people actually type is aliased onto
those five and keeps its own glyph where the glyph says something the colour
does not: `[!bug]` is a bug in caution red, `[!question]` a question mark in
important purple, `[!success]` a tick in tip green. A name nobody defined is not
a broken callout — it stays the blockquote it is, exactly as GitHub treats an
unknown alert.

Type `> [!` and the list of types appears, with the colour family each alias
lands in beside it; there is no toolbar button, because the formatting bar
exists only in rich text while the syntax works in all three modes. Omit the
title and the callout announces its own type instead. Put the caret on that
line and the raw `[!warning]` comes back to be edited, the same way a link's URL
does.

**A callout folds** from the chevron beside its icon, leaving its title and a
count of the lines it is hiding. The fold is Obsidian's `-` written into the
marker — `> [!note]- Title` — rather than a state the editor holds, which is
the only place it could live and still be true: state in the editor would be
gone on reload, differ between two windows onto the same note, and never reach
another device. In the marker it survives everything the text survives, and a
note folded here opens folded in Obsidian. Unfolding takes the character back
out rather than leaving a `+` behind, so a callout nobody has folded and one
somebody has unfolded read the same.

**Code blocks have a copy button** in the top right corner — on hover with a
pointer, always visible on a touch screen, and it works while a note is being
read, which is where it is wanted most. It copies the code without its fences,
and without the indentation of a block nested in a list.

The fence itself comes back the moment the caret is in the block, in rich text
as well as live preview. The language written on it — ` ```js ` — is what turns
the syntax highlighting on, and it lives in that one place with no picker
anywhere else, so a permanently hidden fence would be a block you could not
label and could not find the ends of. Everything else about a code block stays
hidden in rich text; this is a fence, a link's URL and a callout's `[!type]`
being the same kind of thing.

**A note names itself, if you let it.** A note made with *New note here* — and
every note started from a template — is called `Untitled`, so typing a heading
into one leaves the file, the note list and any `[[wikilink]]` to it all saying
Untitled about a note that plainly is not. Pause after typing that heading and
a toast offers the name; taking it renames the file, and ignoring it costs
nothing. The offer is only ever made for a note that has **never been named** —
plenty of vaults keep `2026-09-04.md` headed `# Thursday` on purpose, and an
app that asked about that every time you paused would be a nuisance rather
than a help. Nothing renames a file in a synced vault without being asked.

**A note can leave.** Right-click one (or long-press it) for **Share…** on a
phone and **Export as Markdown** everywhere else; ⌘K has it too, for the note
you have open. Nothing is converted — the bytes that leave are the bytes on
disk, frontmatter and wikilinks included — because the file was already the
portable thing. Where the platform has a share sheet you get it, which is the
one route from here into Mail; where it hasn't, the file downloads.

**Pinned notes** sit in their own section at the top of the list — sorted the
same way everything else is, by date edited, date created or title — and stay
there while the rest of the list re-sorts around them. Pin from the note's
context menu, or by putting `pinned: true` in its frontmatter.

**Folders and Tag Folders.** Ordinary folders nest as deep as you like and are
real directories in the vault. Tag Folders are saved boolean rules that gather
notes automatically — `#work AND (#urgent OR #blocked) NOT #archived` — and own
nothing, so deleting one never touches a note. Rules also understand
`folder:Work` and `has:tasks`, tags match hierarchically (`#work` catches
`#work/active`), and two terms side by side mean AND.

**A Tag Folder can gather tasks instead of notes.** Same folder, same rule
language, one switch — *Gathers: Notes / Tasks* — because a second tree beside
the first would have meant learning "a saved rule" twice.

The reason it is worth having is **inheritance**: a task carries the tags on its
own line *and* the ones its note carries. Tag a note `#home`, write ten jobs on
it, and `#home` gathers all ten without any of them being tagged by hand — which
is how people actually keep notes, and the alternative is the same information
typed eleven times. A tag written on one task line is that task's own; it does
not leak to its siblings, though it does still count towards the note (the note
really does contain urgent work).

Rules over tasks reach two things a note cannot answer: `is:open` / `is:done`,
and `due:overdue`, `due:today`, `due:soon`, `due:none`, `due:any`. So

```
#home is:open              the jobs at home still to do
#work due:overdue          work that has slipped
#home AND NOT #urgent      everything at home that can wait
```

**A checkbox with nothing after it is not a task**, anywhere a task list is
drawn — Tasks, Due, the calendar, a Tag Folder over tasks, and the counts on
all of them. The daily note opens with `- [ ] ` under Today and keeps two more
under Habits and Tomorrow, which is the point of it: a blank to type into, one
keystroke to delete. What it is not is work anybody owes, and a week of daily
notes was otherwise seven "Untitled task" rows in every filtered list. A note
holding nothing but blank checkboxes does not answer to `has:tasks` either. The
note itself is untouched: the checkbox is drawn where it was written, ticks
when clicked, and becomes a task the moment it is given something to say.

**Finished tasks are out of the list by default**, with *Show completed* in the
same ⋮ menu to bring them back. A list whose top is what you owe and whose
bottom is a growing archive of what you don't is a list people stop reading —
and `is:done` already answers the archive question for anyone who wants it. The
heading still counts them (*4 open · 12 done*), so nothing is hidden without
saying so, and a group that runs past 200 rows says how many it left out rather
than dropping them quietly.

**Any task list can be arranged**, from the ⋮ beside its heading: *No
grouping*, *By due date* — Overdue, Today, This week, Later, No date, Done, in
that order — or *By note*. One setting for all three places a task list
appears, because it is a way of reading such a list rather than a property of
one of them, and grouping by note stops repeating the note's name down the side
of every row.

Not **by tag**, and that is a decision rather than an omission. A task carries
the tags on its own line *and* the ones its note carries, so a job that is both
`#home` and `#urgent` has no single group: it belongs in two, which means the
same task in the list twice, a tick that has to update both, and counts that no
longer sum. The inheritance that makes task tags worth having is exactly what
makes grouping by them ambiguous. Due date and note are one apiece.

The tasks appear in the note list's place, as the same rows the calendar rail
and the phone's Tasks tab use — so ticking one there writes to the note it lives
on, and it leaves the folder if the folder asked for open ones. The count beside
the folder counts tasks, not the notes they sit on, and a small tick on the row
says which kind of folder you are about to open: it sits in the same list as
folders that gather notes, with the same emoji and the same count beside it. A
tick is on offer as the icon as well, but the one on the row is drawn from what
the folder *does* — an icon anyone can put on anything cannot be trusted to say
so. Written into a rule over
*notes*, `is:` and `due:` match nothing and the folder's live count says so as
you type.

**Tag Folders nest too, and nesting means something.** By default a child
*narrows* its parent, so the hierarchy reads the way a folder tree does — a
child is always a subset. A parent of `#work` with a child `#active` and a
grandchild `#urgent` gives you `#work`, then `#work AND #active`, then
`#work AND #active AND #urgent`, and editing the parent re-narrows the whole
subtree at once.

```
💼 Work            #work                                   6
  ⚡️ Active        #work and #active                       1
    🔥 Urgent      #work and #active and #urgent           0
  🧾 Archived      #work and #archived                     1
🏠 Home            #home                                   2
```

Untick **Narrow** on any child and the nesting becomes purely visual — its rule
stands alone, useful for grouping unrelated rules under one heading. Leave a
folder's rule *empty* and it becomes a grouping folder: it shows the union of
everything nested beneath it. Deleting a parent promotes its children rather
than taking them with it; "delete with everything inside" is a separate item.

Both kinds of folder are defined in `backstage/`, so they follow you to every
device.

**Folder templates, if you want them.** A folder can start its new notes from
boilerplate — a meeting note with the fields you always fill in, a person note
with the same four headings, a daily note that already knows its date.

A template is **an ordinary note in an ordinary folder**. `Templates/` is a real
directory holding real `.md` files, so a template is written, edited, searched,
linked and synced exactly like everything else: there is no template format, no
template editor, and nothing to export. Open one, change it, and the next note
made from it picks the change up.

**And nothing about it happens until you ask.** `Templates/` is never created
for you — not at boot, not by the first note, not by looking at the feature.
A vault without one behaves in every respect as though none of this existed: no
folder in the sidebar, no item in any menu, nothing to turn off. Settings →
Editor offers to make it, and that button is the only thing in the app that
does; it writes a set of templates to start from, so there is something to look
at — and something to use — rather than an empty folder. Once templates exist,
a folder's context menu gains **Use a template…**, and names the one it is
using afterwards — or says *missing* if that note has since been deleted or
moved out of `Templates/`, rather than looking configured while quietly
applying nothing. Renaming either end — the folder or the template note — is
followed, so the assignment only breaks when the template genuinely stops being
one.

```
Templates/
├─ Daily Note.md       ← ordinary notes, edited like any other
├─ Meeting.md
├─ Person.md
├─ Project.md
├─ Decision.md
├─ Reading.md
└─ Weekly Review.md
```

**What that set is.** Seven notes, none of them special:

| template | for | what it carries |
| --- | --- | --- |
| **Daily Note** | `Daily/`, and the calendar's *Create daily note* | the day's date in `date:` and in the heading, today's tasks, a timestamped log, habits, tomorrow |
| **Meeting** | the folder your meetings live in | date, time, client, project, attendees, location; agenda, notes, a decisions callout, actions |
| **Person** | a folder of people, or the vault root, so a `[[Ana Ruiz]]` fills one in | the fields a vCard carries — name, nickname, org, department, role, emails, phones, website, the address split the way `ADR` is, timezone, birthday, anniversary, social, assistant, partner |
| **Project** | the note a folder of notes hangs off | status, owner, client, started, due, stakeholders; outcome, a milestone table, tasks, risks, a log |
| **Decision** | anywhere a choice is worth outliving the room it was made in | status, owner, supersedes; the question, the options with their fors and againsts, what was chosen, what it costs |
| **Reading** | books and articles | author, kind, source, status, started, finished, rating; the argument in one line, highlights, takeaways |
| **Weekly Review** | read back over seven daily notes | went well, did not, rolled over as tasks you can tick, next week |

Three conventions run through all seven, and they are the ones worth copying
into one of your own. `# {{title}}{{cursor}}` heads the note — filled in for a
note that is named already, empty with the caret in it for one that is not. An
empty `-`, `- [ ]` or table row is a blank to fill in rather than a task
anybody owes: none of them arrives ticked, and none of them arrives with a due
date, so a new note adds nothing to Due until you put it there. And the
frontmatter carries what the note *is* while the body carries what happened —
`attendees: []` is typed as "Ana, Bo" in the properties form, so an empty list
is an invitation rather than a puzzle.

The fields a template can fill in are deliberately few: `{{title}}`, `{{date}}`,
`{{time}}`, `{{year}}`, `{{month}}`, `{{day}}`, `{{weekday}}`, and `{{cursor}}`
for where writing should start. `{{date}}` and `{{time}}` take a pattern —
`{{date:DDDD, D MMMM YYYY}}` — built from `YYYY MM DD HH mm ss`, with `MMM` /
`MMMM` for the month by name and `DDD` / `DDDD` for the day. A field nobody
recognises is left exactly as written, so a typo looks like a typo in the note
rather than disappearing into it. The line between "a few fields filled in" and
"a template language with conditionals in it" is one that gets crossed a token
at a time, and this is the side of it the app stays on.

`{{title}}` is the note's name **at the moment it is created**, and it is empty
when the note has not got one yet — "Untitled" is the absence of a title rather
than a title, and a template that wrote that word into a heading would be worse
than one that left the heading blank. So `# {{title}}{{cursor}}`, which is what
the example template is, is right in every case: a daily note or one made from
a `[[wikilink]]` is named already and gets its heading filled in, and one made
with *New note here* gets an empty heading with the caret sitting in it.

A template applies to **the folder it is attached to and no other**: one on
`Work` does not reach `Work/Projects`. Inheritance would be a second rule to
hold in your head, and a template on the vault root would then silently apply to
every note anywhere — which is how an optional feature stops feeling optional.

The vault root can have one too, set in Settings rather than from a menu,
because it is the one folder with no row in the sidebar to right-click. It
covers ⌘N with no folder selected, and **a note created from a broken
`[[link]]`** — which always lands there, and is named for the link text. That
is the case `{{title}}` is really for.

**Text snippets, if you want those.** The addresses and phrases you type over
and over, behind a word you choose. Type `wiki` in any note and press Tab — or
tap the suggestion — and it becomes whatever you said it stands for.

They live in **one ordinary note**. `Snippets.md` at the vault root, where a
`##` heading is the trigger and everything under it is what the trigger expands
to, so a snippet is written, edited, searched and synced like anything else and
there is no snippet format to learn:

```markdown
## wiki
https://en.wikipedia.org/wiki/

## sig
Thanks,
{{cursor}}
```

One rule, so a multi-line snippet costs nothing and no character has to be
escaped — a `|` or an em dash in a phrase would break a table or a list.
Snippets fill in the same fields templates do (`{{date}}`, `{{time}}`,
`{{weekday}}`), and `{{cursor}}` says where to leave the caret afterwards.

**There is no sigil**, because a leading punctuation mark is a keyboard-layer
switch away on a phone — a strange toll on the feature whose whole purpose is
typing less. The trigger is whatever the heading says: name one `;sig` and you
type that instead. What keeps the list off ordinary prose is a single rule —
**what you have typed since the last space must be the start of a trigger you
wrote down.** Everything that would otherwise be a special case falls out of
it: `[[wik` and `#wik` are a note and a tag being named, no trigger begins with
a bracket or a hash, so snippets stay out of those lists; `design` is not
`sig`, because the run is the whole word rather than its tail.

Nothing happens until you ask, the same way: `Snippets.md` is never created for
you, and Settings → Editor offers to write it with a few in it to start from.

Tab accepts any suggestion, not just a snippet — it falls through to indenting
when no list is open. On a phone, where there is no Tab key, tapping the
suggestion is the same gesture it always was.

**Templates stay out of the roll-ups.** They are real notes, so without care
every view that adds your notes up would count them — and a template is
boilerplate for a note that does not exist yet. Its `- [ ]` is a blank to fill
in rather than a task you owe anybody; its `#work` describes the notes it will
make rather than itself. One meeting template was enough to put a permanent
empty task in the task list, invent a `#meeting` tag, count `#work` twice,
place a dot on the calendar, report a broken link only it mentioned, and land
in the Tag Folder that gathers everything tagged `#work`.

So the roll-ups — the note list, its count, tasks, tag counts, the calendar,
Tag Folder matches, backlinks and broken links — read your notes without the
templates. Everything that looks at one named thing still sees them: browsing
`Templates/` (which is the only way a template gets edited, so hiding the
folder the way `backstage/` is hidden was never an option), search, wikilink
targets, version history and sync. Two of those are not preferences but
correctness — **the orphan scan** has to see templates or a picture used only
by one is reported unused and invited to be deleted, and **rename repointing**
has to, or a template's links break when a note it mentions is renamed.

A vault with no `Templates/` folder gets the identical list back rather than a
filtered copy of it, so none of this costs anything to anyone who never made
one.

The **daily note** is the case this was built for. Point `Daily/` at a template
and every day's note starts from it, dated for *the day it is filed under* rather
than for today — so Thursday's note, started on Saturday, still says Thursday.

**Calendar and tasks.** An optional right column (⌘⇧R) shows a month calendar
with a dot per note, filed by frontmatter `date:`, a `YYYY-MM-DD` filename, or
creation time. Click a day to filter the list. Any day without a daily note
offers to make one — **Create daily note**, at the top of that day's list and
under the day in the rail — which writes `Daily/YYYY-MM-DD.md` and opens it, so
Thursday's note can be started on Saturday and still lands on Thursday. Below
it, **Due**: the tasks that are due today and the ones already late. Ticking a
box there edits the source note.

**A calendar you can write in.** Settings → Editor → **Clicking a day in the
calendar** switches the click from *shows what is filed on that day* to *opens
that day's daily note*, for anyone whose calendar is a journal rather than an
index. The setting exists for one guess about intent: somebody clicking a day
with nothing on it is usually starting to write about it, not looking for what
isn't there. So on an empty day the click asks — one dialog naming the file it
would write, `Daily/YYYY-MM-DD.md` — rather than creating it, because a note
written on a guess is a note somebody has to go and delete. The day is selected
and its notes are listed either way, in both modes, so the setting changes what
a click *adds* and never what it takes away; the difference is that only the
filtering mode lets a second click on the same day take the filter back off,
since where a click means "open this day's note" a second one means it again.

The rail's list is narrowed on purpose. Every `- [ ]` in the vault is rolled up
under **Tasks** in the sidebar, and repeating that list under a calendar made
the two columns compete for the same job. Dates are what the column beside it
is about, so a list scoped to them is the one thing the rail can say that the
sidebar cannot — and an undated job is a job for another day.

**The calendar reads both ways.** A day that owes you work carries a small pip
in its corner — red once the day has passed, the same red the date chip turns
when it is late. It is a channel of its own: the dots under the number mean
notes filed on that day, and making a dot mean two things would cost you both.
Click the day and its tasks appear under its notes, with no heading over them —
a row with a checkbox and a date on it is not going to be mistaken for a note,
and a rule across the panel made two lists out of one day.

Nothing is said twice in one column: the **Due** list below already holds
everything overdue and everything due today, so a day it has covered keeps its
notes and hands the tasks to it. The phone's calendar tab has no such list under
it, so there every selected day keeps its own.

**Due dates you don't have to type.** A task line has two controls, one at each
end: the checkbox that says whether it's done, and a chip that says when it's
for. The chip shows the date in words where there are words for it — *Today*,
*Tomorrow*, *Fri* — and turns red once it's past. Tapping one opens a picker
with four one-tap presets (today, tomorrow, this weekend, next week) over a
month grid; on a phone the same picker arrives as a bottom sheet with
thumb-sized day cells, rather than a popover pinned to a fingertip.

The chip is in both places a task appears. In the task list every row has one,
filled or a faint outline waiting to be given a date. In a note it replaces the
`📅 2026-09-04` in the source, so the line reads as a sentence with a date on
the end instead of a sentence with syntax in it — and a task with no date shows
the outline on the line the caret is in, so a twenty-item checklist doesn't
sprout twenty buttons. ⌘⌥D does the same from the keyboard.

Dates are still just markdown. Reading stays permissive — `📅 2026-09-04`,
`@due(...)`, `due:...` and Dataview's `[due:: ...]` all parse, so a vault
written by another tool works unchanged — and the picker only ever *writes* the
`📅` form.

**Quick capture.** Two taps from anywhere to a task on today's list. The middle
of the phone's pill bar is a **+**; it opens a sheet with one field, the caret
already in it and the keyboard already up, and *Add* writes the line. Nothing is
written before that — the sheet is text in memory, so one you open and think
better of costs the vault nothing.

The sheet opens on whatever the tab it was pressed from is about — a task from
Tasks, a note from Notes, a task dated for the day you are looking at from
Calendar — and the Task/Note toggle is one tap for when it guessed wrong. Long-
press the **+** for the other one directly, or for today's note. On a desktop
the same thing is *Quick add task* and *Quick add note* in the palette, and an
**Add task** row sits at the foot of every task list and under each day in the
calendar.

A captured task goes into **today's daily note, under `## Tasks`** — written if
the note hasn't got that heading, joined if it has, so the second capture of the
day lands under the first rather than starting another list. That is the default
because it costs nothing new: tasks are read out of note bodies, so the line is
in the Tasks tab, in the calendar's counts and in any Tag Folder that gathers
tasks the moment it lands. Settings → Editor → **Quick add** points it at one
`Inbox` note instead, or at a different heading, and the chip in the corner of
the sheet always names the file it is about to write to.

The date chips write the same `📅 2026-09-04` the picker does. `#tags` need no
support at all — the line is markdown, so a `#vet` typed into it is a tag like
any other. Paste three lines and you get three tasks, and a line that arrives
already wearing a `- [ ]` is not given a second one. A note captured this way is
**named after its first line**, which is the one thing *New note* could never
do: it wrote `Untitled.md` before you had typed a character, and left it behind
if you walked away.

**Capture without opening the app.** On Android, long-press Slate's icon on the
home screen for **New task**, **New note** and **Today's note**, and share text
or a link into Slate from any other app to land in the sheet with it already
filled in. Both work with no network — the URL is served from the precache and
the write is local, like every other write here. Both are the manifest rather
than the app, so see *Known limits* for what that costs.

**On an iPhone there is no equivalent, and the app is the answer.** Two
findings, both from a device. iOS launches an installed web app at the address
it was installed with and throws away anything added to the URL afterwards, so
nothing — a link, a Shortcut, the `webapp://` scheme — can ask an already
installed Slate to open a capture sheet; it opens the app, at its start page,
every time. The way round that would be an icon per entry point, each installed
from a page carrying its own `start_url` — and that is the second finding: iOS
gives every home-screen web app its own storage, separate from Safari and from
every other icon of the same site. A second Slate icon is a second Slate, with
an empty vault. It was built, tested on a phone, and taken back out, because a
task captured into a vault you cannot see is worse than one more tap.

So on an iPhone capture is two taps — the icon, then the **+** — and through the
app that is the whole of it.

**One tap, with Apple out of the way.** There is a route that never touches the
web app, and it is available because of what this vault is: plain markdown files
over HTTP. A Shortcut can write to one directly. That gets you capture from the
lock screen, from Siri and from the share sheet, and Slate picks it up on its
next sync. It needs a WebDAV backend — Google Drive's OAuth makes the same
thing impractical from a Shortcut — and it needs the network, which the app
itself never does.

Six actions:

| | Action | Set it to |
|---|---|---|
| 1 | **Ask for Input** | Text — *What needs doing?* |
| 2 | **Format Date** | Current Date, custom format `yyyy-MM-dd` |
| 3 | **Text** | `https://SERVER/DAV-PATH/Daily/`*Formatted Date*`.md` |
| 4 | **Get Contents of URL** | **GET**, header `Authorization` = `Basic TOKEN` |
| 5 | **Text** | *Contents of URL*, then a new line, then `- [ ] `*Provided Input* |
| 6 | **Get Contents of URL** | **PUT** to the URL from 3, same header, request body = the Text from 5 |

`SERVER/DAV-PATH` is the server URL and subfolder from Settings → Sync, joined —
the same address the app writes to. `TOKEN` is `username:password`
base64-encoded, which is the same `Authorization` header the app's own adapter
sends. Shortcuts is not a browser, so none of the CORS configuration WebDAV
needs for the *app* applies to it.

Append ` 📅 `*Formatted Date* in step 5 if you want the task due today; leave it
off and it arrives dateless, as it does from the app's own sheet. The line lands
at the end of the note rather than under `## Tasks` — a Shortcut has no reason
to know about headings, and a task is a task wherever it sits in the file.

Two things to know before relying on it. **The first capture of a day may have
nothing to read**: the daily note does not exist until something makes it, so
step 4 has no file to fetch. Point the shortcut at a fixed `Inbox.md` instead if
that bites: set Quick add to file into an Inbox note, capture once from the app,
and from then on there is always a file there to read. And
**it is a read-modify-write**: between step 4 and step 6 the app could push a
change of its own, which the PUT would then overwrite. The edit is not lost —
the app still holds its copy locally, and the next sync sees a remote that moved
and merges line by line, keeping a conflict copy if the two cannot be
reconciled — but it is the reason this is a convenience rather than the way the
app itself writes.

**One layout that doesn't jump.** Three modes — phone, mid-size, wide — chosen
explicitly rather than by CSS reacting to width on its own. The editor holds a
guaranteed minimum width in all of them, so when space runs short a side panel
is dropped rather than the writing surface squeezed. Crossing a breakpoint never
opens or closes anything by itself.

**Back and forward.** Two arrows to the left of the note's title, over the notes
this window has opened — a vault is a web of links, and three notes into
following one you want the one you started from, which a list sorted by date
cannot give you. Each arrow's tooltip names the note it would take you to, so
"back" is answerable without pressing it first, and a note that has since been
renamed or deleted is stepped over rather than offered. Desktop only: a phone's
editor header already has a back arrow in that spot and it means something
else — it returns to the note list, which is the right thing for it to do.

**Focus mode, and a note in a window of its own.** On a desktop the editor's
header carries one more button. Press it (or ⌘⇧F) and the note takes the whole
window — no sidebar, no list, no calendar, no status bar. The text is laid out
the way Settings → Editor → **Body width** says, the same as it is everywhere
else: full width, or a centred reading column if that is what you have chosen.
Escape gives the app back, after the Escape that puts the caret down.

Hold **Shift** over that same button and it becomes a popout, exactly the way
Gmail's compose window does it: click it and the note steps out into a small
window of its own, to sit beside whatever you are writing about. The pane it
came from shows a card saying where it went, with *Show me* and *Bring it
back* — one window owns a note at a time, so there is never a second caret in
the same file. Closing the popped-out window hands the note straight back, with
everything written in it. Both windows are the same vault: what you type in one
appears in the other's list, search and calendar as you type it, and the window
you started from is the one that syncs. Nothing about either feature exists on a
phone, where the editor is already the whole screen.

**Offline.** The whole app is precached. It opens, reads and writes with no
network at all, and syncs when connectivity returns.

**Never losing things.** Deletes are soft — notes move to `backstage/trash/` and
show up under Deleted, where opening one shows its contents read-only
so you can decide with the note in front of you rather than from its title.
Nothing in there expires: it stays until you restore it, delete that one for
good from its menu, or empty the whole list from the header. Every save, sync pull and delete writes a local
snapshot, and the history dialog restores any of them — each one labelled with
the device it came from, so a version pulled from the server says *which*
machine wrote it. Conflicting edits are merged when possible and kept as two
files when not.

---

## The optional model

Off, optional, and the only thing in Slate that sends anything anywhere other
than your own backend. With no provider configured in Settings → **AI**, none of
this exists: no buttons, no commands, no requests, nothing different about the
app at all.

Three things, and one rule they all keep: **you start it, and you see the result
before anything is written.**

| | Where to find it | What leaves the device |
| --- | --- | --- |
| **Transcribe** | the ⧉ button in the image viewer | one picture |
| **Change this passage** | the ✦ in the note's header, or on the formatting bar — or ⌘⇧U | the text you selected |
| **Summarise these notes** | the **⋯** above the note list | the notes in the list, after you confirm the count |
| **Ask your notes** | the same **⋯** | up to 6 notes per question: the ones you pinned, then the ones the search matched |
| **Ask about this note** | the same ✦ | the note itself, every question, plus what the search finds among the notes linked to it |

All of them are in the command palette too (**⌘K**), but none of them is *only*
there — a feature you can reach only by knowing its name is one most people
never find.

### Reading the text out of a picture

The image viewer gains a **Transcribe** button. It sends that
one picture — a receipt, a whiteboard, a page of a book, a screenshot of an
error nobody can copy out of — and shows you what came back **in a box you can
edit, before anything is written**. *Insert* puts it in the note under the
picture it came from, where it reads as a caption and needs no explaining.
*Cancel* writes nothing. A transcription is ordinary text in an ordinary `.md`
file: no sidecar, no marker, nothing that needs this feature to still exist in a
year for the note to make sense.

The write goes through the same path as every other edit, so it takes a
version-history snapshot and is undone from the same dialog — and a note with
`lock: true` refuses it, the same as it refuses quick capture.

### Changing a passage

Select something, then press the **✦** in the note's header — or **⌘⇧U**. (It is
on the formatting bar too, where rich text has one; the header is where it lives
in every mode.) Five presets — *Tighten*, *Proofread*,
*Make a table*, *Make a list*, *Make tasks* — or type what you want done to it.
The answer streams in as it is written, because a local model can take a minute
on a paragraph and a dialog that shows nothing for a minute is one you close.

**What comes back is shown as a diff, never on its own.** A rewrite that is good
and a rewrite that quietly dropped your third sentence read identically in
isolation; the only way to tell them apart is against what was there. Removed
lines and added lines are marked with `−` and `+` as well as coloured, so the
distinction survives a greyscale screenshot. *Replace the passage* applies
exactly what the diff shows and nothing else — one undo puts it back. *Discard*
writes nothing.

Two replies are reported rather than offered: an empty one, because "delete this
paragraph" is not an edit worth a button, and one identical to what you sent,
which is a proofread finding nothing — a result, and a good one, but not a
change.

The passage goes as *material*, in its own message, never spliced into the
instruction. A note that happens to contain the words "ignore the above" is then
text that says something odd rather than a competing command. That is not
prompt-injection-proof — nothing is — but it is the difference between text that
must be misread as an instruction and text sitting in the instruction slot.

If a sync lands while the dialog is open, the note underneath it changes and the
offsets stop meaning what they meant. So the text at the range is checked
against what was sent before anything is written, and the rewrite is refused
with a message rather than pasted over the wrong paragraph.

### Summarising a set of notes

**The list is the query.** Rather than a button on tags, another on Tag Folders
and a third on folders, *Summarise these notes* — in the **⋯** menu above the
note list — acts on whatever that list is showing — a tag, a saved rule, a folder, a search, a
day on the calendar. Whatever you narrowed it to is what gets summarised.

Nothing is sent until you have seen the size of it: the dialog opens on how many
notes, roughly how many tokens, how many requests, and which model at which
provider. Then a button that has to be pressed.

**A set too big for one request is summarised in passes, not truncated.** A tag
with two hundred notes is exactly the tag worth summarising, and quietly sending
the first thirty would produce a summary that reads as complete and is not —
which is the worst of the available behaviours. So it goes in batches that fit
your **context budget**, and a final pass merges them. Past twenty passes it
refuses and says so, because a summary distilled from that many is thinner than
one of a set you actually meant. Empty notes are left out and counted; a single
note too long for one request is cut rather than dropped, and the dialog says
that too. Frontmatter never goes — the block at the top is metadata for the app
and the likeliest place for something you would not have chosen to send.

**Ask it again, searching for something else.** The callout tells you what was
searched for, which is usually enough to see that a wrong answer came from a
wrong *search* rather than a wrong model — and **Redo** beside the composer acts
on that: it opens the terms it used, lets you replace them, and re-answers the
same question, putting the new exchange where the old one was. It skips the
first request entirely, because asking the same model for terms a second time is
the one thing that cannot help.

It is absent when there is no search to change — a conversation scoped to
`note:` its one pinned note has nothing else to look in, and a control whose
whole offer is "searching for something else" should not be there when there is
nothing else.

The result is **a new note**, not a panel: it syncs, it versions, you can edit
it, and deleting it is the same keystroke as deleting anything else. Its
frontmatter says what made it — `generated: true`, the model, the query, the
date, how many notes — so it can never be mistaken for something you wrote. The
summary cites notes as `[[wikilinks]]`, so it is navigable; a model that invents
a title produces a broken link, which shows up as a broken link rather than
passing unnoticed.

### Asking your notes

**A conversation is a note.** Questions are `##` headings, answers are prose
citing `[[the notes they came from]]`, and what produced each answer is a folded
callout underneath it:

```markdown
---
date: 2026-09-12
type: conversation
source: "#work"
include:
  - "[[Migration plan]]"
---

# Ask — What went wrong with the Q3 migration

## What went wrong with the Q3 migration?

It ran cleanly on the Thursday night, but two indexes had to be rebuilt
afterwards and that took longer than the migration itself — see
[[Migration plan]] and [[Postmortem 2026-08-14]].

> [!note]- Searched “migrat”, “index”, “rollback” · read [[Migration plan]] (pinned), [[Postmortem 2026-08-14]]
> 6 notes matched; 2 sent, about 3100 tokens.
```

Which means there is almost no new interface: it opens in the editor like any
note, it syncs, it versions, it is searchable, and its citations are real
wikilinks — so opening [[Migration plan]] shows you the conversations that
referenced it. Edit an answer you disagree with. Delete a question. It is a
file.

The one new piece of chrome is a **composer** at the bottom of the editor, on
notes whose frontmatter says `type: conversation` and nowhere else. Type, press
Enter, and the answer streams into the note while you watch.

It is one box: the question on its own row, and the controls that qualify it —
scope, pins, Redo, Ask — on the row beneath. The two used to share a line, which
put the field in the middle of a row of chips and left Ask as a 40px square at
the end of it: the control pressed most often was the smallest target, and the
field was the thing that got squeezed whenever a scope rule ran long. Ask now
takes whatever the chips leave, so the default action is also the widest one.

**The scope is a rule in the note.** `source:` holds a Tag Folder rule — `#work`,
`folder:Projects`, or `all` — re-read on every question, so the note is honest
about what it could see, and you can change it by editing the frontmatter or
from the chip beside the composer. Starting a conversation from a narrowed list
scopes it to that list, which is worth doing: a smaller haystack gives a small
local model a much better chance.

Two rules the Tag Folder language has no way to express live here too, because
they are about the graph rather than about tags and folders:

| Rule | What may be read |
| --- | --- |
| `note:Migration plan` | that note, and nothing else at all |
| `links:Migration plan` | that note, everything it links to, and everything that links to it |

A hop counts **both directions** on purpose. What a note links out to is its
references; what links in to it is everything written since about the thing it
describes — a postmortem naming the migration plan is as much about the plan as
anything the plan itself cites.

**Pinning is the opposite of scope.** `source:` is a filter — it says what may be
*searched*, and a note inside it still has to win the keyword search to be read.
`include:` is a guarantee: those notes are sent with every question, whatever it
is, and they go first. That is the difference between "answer from my work
notes" and "always have the migration plan in front of you".

Pin from the chip next to the scope chip, which opens a picker — nowhere does
Slate ask you to *type* a note's name, because a typo'd reference is a silent
nothing that looks exactly like a working one. The frontmatter stays
hand-editable all the same; the picker is just the way that cannot go wrong.

Pins are stored as wikilinks, which buys two things: renaming a pinned note
repoints the pin, because the rename pass scans whole files and frontmatter is
not exempt from it; and the pinned note lists the conversation in its own
backlinks, so *what is standing on this note* is answerable from the note.

They **count against Notes per question**, so four pins against a limit of four
leave the search nothing — and the callout says so when that happens, along with
any pin that no longer resolves to anything. A pin that quietly stopped pinning
is the worst failure this feature has: every answer afterwards looks exactly as
normal as one that had read the note.

**"Ask about this note"** is the shortest road to both: the ✦ in a note's header
starts a conversation with that note pinned *and* scoped to `links:` it — the
note is guaranteed, and the search may reach only as far as the notes it is
actually connected to. Answering from the whole vault would read as a bug: you
name a note, and back comes an answer citing four others that merely shared a
word with your question. The starter offers `note:` (that note and nothing
else) and `All notes` alongside it, and the composer's scope chip moves between
the three afterwards.

Scoped to `note:` alone there is **no search to run** — the note is pinned, so
the searchable set is one note already being sent. The turn skips the
terms request entirely and costs one round trip instead of two, and the callout
says `No search terms` rather than reporting a search that had nowhere to look.

**How a question is answered.** Two requests. First the model is asked what to
*search for* — not to answer — because your phrasing is rarely your notes'
phrasing, and a question about "what went wrong" wants a search for "rollback"
and "index rebuild". Then Slate runs those terms through its own index, and the
notes that matched go to the model with an instruction to answer only from them
and to say so when they do not.

Letting the model search for itself with tool calls would be better at
multi-step questions, and it is the obvious next step — but it needs a model
that is good at tool use, which small local ones are not, and it turns one
question into an unpredictable number of requests. This works on everything.

**The citations are checked, not trusted.** The instruction says never to invent
a note title, and every answer is read back to find out whether it was obeyed:
each `[[citation]]` is compared against the notes actually sent, and anything
else is named in the callout — linked if a note by that name exists, quoted as
*invented* if none does. This costs no extra request; it is a scan of text
already in hand. It matters because a fabricated citation renders identically to
a real one — same brackets, same colour — until somebody clicks it, which is
long after the answer has been read and believed.

**What it will not read.** Conversations and summaries are excluded from
retrieval. A conversation is the strongest keyword match for its own questions,
so left in it reads itself back and gets more confident every turn; a summary is
a paraphrase of notes that are already in scope, and citing it launders a copy
into a source. Your notes are the ground truth — the things the app wrote are
derivatives of them.

**The one rule this bends.** Every other AI feature shows you the cost before it
sends: Transcribe names the bytes, Summarise makes you confirm a count. A
conversation cannot — retrieval happens *after* you ask, so a confirmation per
question would be two clicks per message. So the consent moves: starting the
conversation is the consent, the composer states the policy standing under it,
and every turn writes down exactly what it read.

### Setting it up

| Provider | Address |
| --- | --- |
| **Ollama** | `http://localhost:11434/v1` |
| **LM Studio** | `http://localhost:1234/v1` |
| **OpenAI** | `https://api.openai.com/v1` |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta` |
| **Custom** | anything OpenAI-compatible — vLLM, OpenRouter, your own gateway |

Pick one, press **Test connection** — it lists what the server can run, which is
also how the model fields get filled in — and put a model in **either** field.

**Text model** is the one most of this uses: rewriting, summarising and asking
questions are all text. **Vision model** is only for *Transcribe*, and it has to
be a model that can actually see — a text-only one will take the picture, ignore
it, and answer about nothing. The list cannot tell you which is which, so that
is the one part you have to know. Either field falls back to the other, so one
model is enough; leaving Vision blank costs you transcription and nothing else.

Under them, the panel says which of the four features your settings switch on
right now, and why any of them is off.

**Context budget** is how much the model can read at once, in tokens. There is
no defensible default: a local 8B model is often 8k and a hosted one 128k or
more, and the number decides whether summarising thirty notes is one request or
six. Guessing high gets a refusal from the server; guessing low only makes more
passes than it needed, so the default (16k) errs low.

**Notes per question** is how many notes get sent with a question — six by
default, and usually the limit that actually binds. Notes pinned to the
conversation come out of the same allowance. Every answer's callout says how
many matched, how many were sent, which of the two limits cut the rest, and
whether the pins took the lot, so you can tell a question that found nothing
from one that found thirty things and could only read six.

**All four of these are per device** — provider, address, key and model alike.
They live in this browser's local database, beside the WebDAV password and for
the same reason: nothing here is written into the vault, so nothing here syncs.
A key in `backstage/config.json` would be a key on every machine you sync to and
in every backup of the vault, with nothing on screen to say so.

That is a deliberate feature rather than a limitation, and it is what makes the
sensible arrangement possible: Ollama on the desktop that has the GPU, a hosted
provider on the laptop, and nothing at all on the phone or on a machine you do
not want this on. Turning it off on one device leaves the others as they were.
The cost is that each device is set up by hand once — four fields.

### The one thing that will go wrong: http

A page served over HTTPS cannot call `http://`. Not with a flag, not with a
permission, not on retry — so Slate installed from `https://notes.example.com`
cannot reach Ollama on your desktop at `http://192.168.1.10:11434`, and that is
the setup nearly everyone tries first. Settings says so before you press
anything rather than after, because the browser's own error for it is the same
unhelpful `TypeError` as four other problems.

Three ways out, in the order they are worth trying:

1. **Run the model on the machine you are reading notes on.**
   `http://localhost` is exempt from the rule, so this simply works. Chrome now
   asks permission the first time a page calls your local network, and Safari is
   stricter than either — if it works in `curl` and not here, that is what it is.
2. **Put the model behind TLS**, which is the only answer that works from a
   phone. The Caddy block from the WebDAV section above does it; point it at
   `localhost:11434` instead and use the https address.
3. **Serve Slate itself over http** on the same machine, which trades the PWA
   install for the convenience and is rarely what you want.

CORS is the other half, and it is per provider: Ollama answers a browser only
from origins it was started with (`OLLAMA_ORIGINS=https://notes.example.com`),
and LM Studio refuses every browser until *Developer → Server settings → Enable
CORS* is switched on. Both are named in the failure when it happens, with your
origin already filled in.

### What it does not do

Nothing runs in the background, nothing is indexed, nothing is sent on a timer,
and no note is read by any of it that you did not point at. Every request is one
you started, and the three of them between them send a picture you pressed a
button on, a passage you selected, or notes you confirmed by count — and each
says what went.

A conversation is the exception to "confirm before sending", for the reason
given above, and the only one. Nothing else here relaxes it.

A picture is re-encoded to JPEG or PNG on the way out. Most providers take WebP
quite happily; plenty of OpenAI-compatible servers — llama.cpp's among them —
decode only these two, and a refusal there is indistinguishable from every other
refusal. The same pass caps it at 1568px, which is where vision models resample
to anyway, so it costs one canvas operation and saves tokens.

---

## Layout

| | Shows | Side panels |
|---|---|---|
| **Phone** (< 760px) | One tab at a time, bottom pill bar: Notes · Tasks · **+** · Calendar · More | Everything else lives in More |
| **Mid-size** (760–1180px) | Note list + editor | Sidebar and calendar open as dismissable drawers |
| **Wide** (≥ 1180px) | Sidebar + list + editor | Calendar sits inline from 1400px, a drawer below that |

Drag the divider on the right of the sidebar or the note list to resize it, or
double-click the divider to put it back; ⌘\ hides the sidebar entirely and the
button in the note list's header brings it back. The editor never gives up its
space: drag the panels wider than the window can afford and they are the ones
that yield.

**⌘⇧F clears the rest of the screen away** — every panel and the status bar with
them — and gives the whole window to the note, laid out however **Body width**
says. The panels are hidden rather than torn down, so the list comes back with
its scroll position and its search exactly as you left them. Shift held over the same
button pops the note into a window of its own instead; see *What it does*.

The sidebar's three sections — **Folders**, **Tag Folders** and **Tags** — each
fold away from their header, and a folded one carries the count of what is
inside it. Which are folded is a preference like any other, so it survives a
reload and follows the vault to your other devices.

Folders inside those sections keep their own shape. A folder is unfolded
because you unfolded it, so unfolding a section — or a folder — never unfolds
everything beneath it, and folding one and opening it again brings back exactly
the tree you left rather than a fresh default. That shape is about the window in
front of you rather than the vault, so it stays on this device and survives a
reload here.

**Search is exact substring matching**, on titles and bodies, in whatever case
you type. It is not fuzzy on purpose: a word you know is in a note is a word
that finds it, and nothing else turns up beside it.

Behind that, a **large** vault gets an index over its vocabulary so that not
every note is read on every keystroke. It decides which notes are worth scoring
and nothing else — what you get back is what the plain scan would have found,
in the same order — and it is allowed to be loose rather than exact in one
direction only: it may hand the scan a note the scan then rejects, and it may
decline to narrow at all, but a note that matches is never left out.

Three things keep it from costing more than it saves. It is only built past a
thousand notes (or four megabytes), because below that reading everything is a
millisecond or two and an index would be pure overhead. It builds in the app's
idle time a few milliseconds at a time rather than inside your first keystroke,
and searching reads everything until it is ready — nothing waits for it. And a
word that is in a quarter of your notes is abandoned rather than indexed
against, because enumerating half the vault to say "look at half the vault" is
the scan's work done twice. The word you wrote once is what an index is for.

**Search filters the list in front of you.** In Files it searches files, in
Deleted it searches deleted things, in Tasks it searches tasks — the header and
the placeholder both name which, so a screen of five results never goes on
claiming to be All Notes. Anything showing notes searches notes across the whole
vault, folder or no folder, which is the convention every notes app follows and
means a search is never quietly limited to whatever you happened to have open.
Changing scope clears the query, so the box is always about the list under it.

**A result shows the line the match is on**, cleaned of its markdown and cut
around the word, with every term marked in the title and the snippet alike —
because the one thing a result row has to answer is why it is in the list, and
a note's opening line usually says nothing about it. A word that appears only
in the title keeps its ordinary excerpt: there is nothing in the body to point
at, and the marked title has already said why the note is there.

**A folder is made from the + on the Folders header**, or from *New
subfolder…* on any folder, and renamed from its own menu — each of them a
one-field dialog in the app rather than a browser `prompt()`, which on a phone
is a system alert thrown over the whole screen. Renaming moves every note
underneath and says so before you commit to it; wikilinks are unaffected,
because they point at a note's name rather than its path.

Long-press or right-click a Tag Folder for *New folder inside…*, *Move up* and
*Move down*, *Move…*, and the two delete variants. Siblings sit in the order
they were made until you move one, and the order lives in `backstage/` with the
folders themselves, so it follows you to your other devices. Up and down rather
than a drag: the sidebar is a tree on a phone as well, where a drag is a scroll,
and a subtree travels with its parent either way.

**A note can be dragged onto a folder** to move it there, *All Notes* included
for the vault root — the pointer shorthand for *Move to…* in the note's own
menu, which is still what touch uses and still what a keyboard reaches. A folder
lights up only for a note it does not already hold.

On a phone the editor opens full-screen over whichever tab you came from, so
tapping a note in Tasks and pressing back returns you to Tasks. Android's back
button closes the editor before it leaves the app. Long-press any note, folder
or Tag Folder for an action sheet; right-click does the same on a desktop.
Swipe a note, a file or a deleted note to the left for its actions, the way a
mail app does. A Tag Folder's rule is editable from the phone too — its scope
bar above the list carries an **Edit** next to the **Close**.

## Keyboard

| | |
|---|---|
| ⌘K | Command palette / jump to note — from anywhere, the editor included |
| ⌘N | New note |
| ⌘S | Sync now |
| ⌘F | Find in note |
| ⌘, | Settings |
| ⌘\ | Toggle sidebar |
| ⌘⇧R | Toggle calendar column |
| ⌘⇧F | Focus mode — the note takes the window |
| ⌘⇧M | Cycle rich text → live preview → source |
| ⌘B / ⌘I / ⌘U | Bold / italic / underline |
| ⌘⇧X / ⌘⇧H / ⌘E | Strikethrough / highlight / monospace |
| ⌘⌥1 / ⌘⌥2 / ⌘⌥3 / ⌘⌥0 | Title / Heading / Subheading / Body |
| ⌘⇧K *(with a selection)* | Wrap in a wikilink |
| ⌘⇧L | Add or edit an external link |
| ⌘⇧U *(with a selection)* | Change this passage with a model |
| ⌘⇧7 / ⌘⇧8 / ⌘⇧0 | Checklist / bullets / numbers |
| ⌘⌥D *(on a task line)* | Set a due date |
| ⌘⇧9 | Block quote |
| ⌘] / ⌘[ | Indent / outdent a list item |
| Tab | Accept a suggestion — a link, a tag, a snippet; indents when there is none |

---

## Setting up sync

### WebDAV — recommended

Works with Nextcloud, ownCloud, Synology, `rclone serve webdav`, Apache
`mod_dav`, and anything else that speaks the protocol. Nothing leaves your
browser except to your server.

In Settings → Sync, choose WebDAV and fill in the URL, username, password and a
vault folder. Nextcloud's URL looks like
`https://cloud.example.com/remote.php/dav/files/USERNAME`.

**Use an app password, not your account password.** Nextcloud: Settings →
Security → Devices & sessions → Create new app password.

#### The one thing that will go wrong: CORS

A browser will not talk to a WebDAV server that hasn't opted in. If "Connect and
test" fails with a network error while the server is plainly up, this is why.
The server must allow your app's origin, allow the WebDAV methods, allow the
headers the client sends, and **expose `ETag`** — that last one is what makes
conflict-safe writes possible.

<details>
<summary><b>Nextcloud / Apache</b></summary>

```apache
<IfModule mod_headers.c>
  SetEnvIf Origin "^https://notes\.example\.com$" ORIGIN_OK=$0
  Header always set Access-Control-Allow-Origin %{ORIGIN_OK}e env=ORIGIN_OK
  Header always set Access-Control-Allow-Credentials "true"
  Header always set Access-Control-Allow-Methods "GET, HEAD, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY"
  Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Depth, If-Match, If-None-Match, Overwrite, Destination"
  Header always set Access-Control-Expose-Headers "ETag, Last-Modified, Content-Length"
  Header always set Access-Control-Max-Age "86400"
  # Preflight must answer 200 without hitting the DAV backend.
  RewriteEngine On
  RewriteCond %{REQUEST_METHOD} OPTIONS
  RewriteRule ^(.*)$ $1 [R=200,L]
</IfModule>
```

Nextcloud also needs your origin whitelisted in `config/config.php`:

```php
'cors.allowed-domains' => ['https://notes.example.com'],
```
</details>

<details>
<summary><b>Caddy</b> (simplest if you're putting a reverse proxy in front)</summary>

```caddy
notes-dav.example.com {
  @cors header Origin https://notes.example.com
  header @cors {
    Access-Control-Allow-Origin "https://notes.example.com"
    Access-Control-Allow-Credentials "true"
    Access-Control-Allow-Methods "GET, HEAD, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY"
    Access-Control-Allow-Headers "Authorization, Content-Type, Depth, If-Match, If-None-Match, Overwrite, Destination"
    Access-Control-Expose-Headers "ETag, Last-Modified, Content-Length"
  }
  @preflight method OPTIONS
  respond @preflight 204

  reverse_proxy localhost:8080
}
```
</details>

<details>
<summary><b>rclone</b> (handy for a quick test)</summary>

```bash
rclone serve webdav /path/to/vault \
  --addr :8080 \
  --user mike --pass secret \
  --etag-hash MD5
```

`rclone serve` sends no CORS headers, so put it behind the Caddy block above, or
serve the app from the same origin.
</details>

**The bulletproof shortcut:** serve the app itself from the same origin as the
WebDAV endpoint (e.g. `https://cloud.example.com/notes/`). Same-origin requests
skip CORS entirely and nothing above applies.

### Google Drive

Free, durable, nothing to self-host. It needs a one-time OAuth client, which is
free and takes about ten minutes.

1. <https://console.cloud.google.com> → create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → External → add your own email as a test user.
   (Staying in "testing" mode is fine for personal use. Tokens expire weekly in
   that mode, so you'll re-authorize occasionally; publishing the app removes
   that but triggers a verification review.)
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Under *Authorized JavaScript origins*, add the exact origin you serve the app
   from, e.g. `https://notes.example.com` and `http://localhost:5173`.
5. Paste the client ID into Settings → Sync.

Slate requests only the `drive.file` scope, so it can see nothing in your Drive
except the files it created itself.

**One caveat, stated plainly:** Drive v3 removed ETag preconditions, so a
conditional write isn't available. Slate re-reads each file's revision
immediately before writing and refuses if it moved, which leaves a race window of
a few hundred milliseconds. Drive's own file version history is the backstop.
WebDAV has no such gap — if two devices are often edited within the same second,
prefer it.

### No backend

Perfectly usable. Notes stay in this browser's storage. In Settings → About,
"Request persistent storage" asks the browser not to evict them; installing the
app as a PWA makes that far more likely to be granted.

---

## Deploying

**There is a build step.** The source is TypeScript and JSX, which no browser
can execute. Serving the project folder directly from a static server — macOS
Apache's `~/Sites`, `python -m http.server`, anything — hands the browser
`src/main.tsx`, the server 404s it with an HTML error page, and you get:

> Failed to load module script: Expected a JavaScript-or-Wasm module script but
> the server responded with a MIME type of "text/html".

Run `npm install` once, then either `npm run dev` for development or
`npm run build` and serve `dist/`.

`dist/` uses **relative** asset paths, so it runs from anywhere — a domain root,
`~/Sites/slate/`, a GitHub Pages subpath — with no configuration. To serve it
from macOS's user web directory:

```bash
npm install && npm run build
cp -R dist/ ~/Sites/slate/      # then open http://localhost/~you/slate/
```

Only set `VITE_BASE=/subdir/` if you specifically need absolute paths.

HTTPS is required for service workers and PWA install (localhost is exempt), so
offline mode and installing won't engage over plain `http://` on a LAN address.

To put it on a static host:

```bash
npm run build

# Netlify
netlify deploy --prod --dir=dist

# Cloudflare Pages
wrangler pages deploy dist

# Vercel
vercel deploy --prod dist
```

**Installing it.** Desktop Chrome/Edge: the install icon in the address bar.
Android Chrome: menu → Install app. iOS Safari: Share → Add to Home Screen —
this is the only way to install on iOS, and it is what gets you offline support
and a real app icon there.

**Two lines in `index.html` are load-bearing on iOS**, and both fail the same
way: the installed app stops reaching the bottom of the screen, leaving a band
of dead space below it that no CSS can fill, because the page is never handed
those pixels.

- The `viewport` meta must keep `viewport-fit=cover`. Without it iOS letterboxes
  the app inside the safe area, and every `env(safe-area-inset-*)` reads `0`, so
  nothing in the stylesheet can even detect the situation. It is written on one
  line with no spaces, matching a configuration known to work; reformatting it
  is the kind of tidy-up that quietly brings the bands back.
- `apple-mobile-web-app-status-bar-style` must be `default`. `black-translucent`
  asks for an edge-to-edge web view and returns one shorter than the screen.

Neither is observable outside a real installed iOS PWA — simulators, desktop
Safari and headless Chromium all render correctly either way — so the smoke
suite asserts both on the markup, and Settings › About reports the view height
against the screen height, which is the fastest way to spot it on a device.

**Updating it.** Settings › About shows the running build and a **Check for
updates** button. Use it rather than reloading: a newly deployed build installs
in the background and then *waits*, because a service worker cannot take over
while the old one still controls an open page — and reloading does not release
it. Reloading therefore lands you on the same build no matter how many times you
try, which is why stale installs have a reputation for needing site data
cleared. The button tells the waiting build to take over and then reloads onto
it. Next to it, **Reinstall** unregisters the worker and empties the app's
caches before re-downloading — the same ground as clearing the browser cache,
scoped to the app. Neither touches your notes; those live in IndexedDB.

---

## How your notes are stored

Your vault is an ordinary folder of ordinary files. Open it in Obsidian, edit it
in vim, grep it, back it up with `rsync`. Nothing here is a lock-in format.

```
Vault/
├─ Start.md
├─ Lisbon Trip.md
├─ Work/
│  ├─ Call with TAC.md
│  └─ Highway 9.md
├─ attachments/
│  └─ 2026/08/pasted-a3f9.webp
└─ backstage/                 ← app's own files, hidden in the UI
   ├─ config.json             ← shared preferences
   ├─ devices/                ← one file per device: its name and recent writes
   └─ trash/                  ← soft-deleted notes
```

`backstage/` syncs like everything else but never appears in the note list,
search, calendar, tags or link autocomplete. Credentials are the one thing that
is deliberately *not* in there — a WebDAV password or a Drive client ID stays in
the browser's local database on each device, so secrets never enter the vault.

`config.json` is written on a 1.5-second timer, because a pane resizer would
otherwise write a vault file on every frame of a drag, and it is overlaid over
the device's own copy at boot. So a preference changed a moment before a reload
would come back as whatever it was before — which is why the pending write is
flushed when the tab goes away, and why the keys this device has changed but
not yet written are kept on disk beside the settings. A killed tab flushes
nothing; the next boot still knows which values were yours.

---

## How sync works

This is the part worth understanding, because it is where a notes app usually
loses your data.

Nothing ever waits on the network. Typing writes to memory and IndexedDB, marks
the file dirty, and returns. Sync happens later, on a timer, when the app becomes
visible, when the network returns, and a few seconds after edits settle.

Each file remembers three things from its last successful sync: a hash of the
content, the server's revision id, and — for notes — the full text. That third
one is the common ancestor, and it is what makes a real three-way merge possible.

When a file has changed on both sides:

- **Different regions edited** → line-wise merge; both sets of changes survive.
- **Both devices appended** → both blocks are kept, ordered deterministically so
  every device computes byte-identical output and the vault converges. This is
  the most common divergence in a notes app and treating it as a conflict would
  be needlessly destructive.
- **Same lines rewritten** → your version stays at the real path (so the editor
  buffer under your cursor is never yanked away) and the server's version is
  saved beside it as `Note (conflict — mac 2026-08-31 142033).md`, which then
  syncs everywhere so the divergence is visible on every device rather than
  quietly resolved on one. The name is made unique before it is used, so a
  second conflict on the same note moments later is a second copy rather than a
  replacement for the first.

Writes are conditional (`If-Match`), so a write is refused rather than
overwriting a change that arrived since the last listing; the refusal routes back
into the merge above. Deletes are conditional in the same way — replicating
another device's delete cannot destroy an edit that landed after the listing, and
a refused delete resurrects the file instead. (Google Drive has no conditional
request, so its adapter re-reads the file's revision immediately before writing
or trashing and refuses if it moved.) A pull that finds the file edited locally
while it was in flight merges rather than installs, so an edit made mid-sync is
not erased by the download it raced.

A run that cannot carry some of its files says so: those paths are named in the
app, the run is left in an error state rather than reported as "Synced", and
they are tried again on the next run.

A note open in the editor is folded in too. The editor holds its own copy of the
text, and that copy is what the next keystroke saves — so a version arriving from
another device is applied to the live buffer rather than only to the vault
underneath it. With no unsaved keystrokes the incoming text simply appears, at
the narrowest possible edit so the caret, selection and scroll position stay
put. If you were mid-sentence when it landed, the two are merged, and only genuinely
overlapping edits leave `<<<<<<<` markers in place for you to settle. Without
this, the same note open on two machines has each side saving its stale copy over
the other's on the next keypress, forever.

Deletes are the other classic way to lose work, so:

- A delete moves the file to `backstage/trash/` rather than removing it.
- A delete is only replicated once the tombstone is confirmed; it never bounces
  back and resurrects over newer content.
- **An edit beats a delete.** If a note was deleted here but edited elsewhere, it
  comes back rather than the edit vanishing.
- Locally-edited files that were deleted remotely are re-uploaded.

On top of all that, every save, sync pull and delete writes a local snapshot
(60 versions per note, 90 days). Sync faithfully replicates mistakes; version
history is what covers "I pasted over three paragraphs an hour ago". It is
device-local and deliberately not synced.

Each snapshot names the device the text came from. Nothing in a WebDAV or Drive
response says who wrote a file, so every device keeps one file of its own —
`backstage/devices/<id>.json`, listing its name and the paths it recently
pushed. Only its owner ever writes it, so the registry cannot conflict; a pull
credits whichever device last pushed that path, and says nothing at all when it
has not heard of one.

`src/core/sync.test.ts` runs two independent "devices" — separate module
instances with separate databases — against one in-memory server and asserts
every one of these behaviours.

---

## Architecture

```
src/
├─ core/          no DOM, no framework — testable in isolation
│  ├─ types.ts        data model + the RemoteAdapter contract
│  ├─ vault.ts        in-memory source of truth, derived indexes
│  ├─ db.ts           IndexedDB: cache, journal, version history
│  ├─ sync.ts         the reconcile engine
│  ├─ merge.ts        three-way merge (diff3), and the two-way diff a rewrite
│  │                  is shown as
│  ├─ rebase.ts       folding a synced change into the buffer being typed in
│  ├─ markdown.ts     frontmatter, links, tags, tasks, due dates
│  ├─ properties.ts   the same frontmatter as an ordered, editable list
│  ├─ tagquery.ts     the rule language behind Tag Folders, over notes or tasks
│  ├─ folders.ts      nested folders + the Tag Folder tree and inheritance
│  ├─ searchindex.ts  what stops a search from reading every note
│  ├─ templates.ts    folder templates: the fields, and which folder uses what
│  ├─ starters.ts     the seven templates `Templates/` is created with
│  ├─ snippets.ts     `Snippets.md`, parsed into triggers and what they expand to
│  ├─ devices.ts      per-device write registry, for version attribution
│  ├─ images.ts       paste- and capture-time re-encoding
│  ├─ filetypes.ts    what a file is when nothing can show what it holds:
│  │                  the families, and the mark each one wears
│  ├─ pdfjs.ts        pdf.js, loaded once for the viewer and for the first
│  │                  page drawn into a note
│  ├─ capture.ts      quick capture: where a line goes, what it looks like
│  │                  when it gets there, and what a launch URL is asking for
│  ├─ llm.ts         the optional model connection: two wire formats, and —
│  │                  mostly — why a browser could not reach it
│  ├─ ocr.ts         the transcription prompt, and where the text it produces
│  │                  lands in the note
│  ├─ transform.ts   rewriting a selection: what is asked, and the check that
│  │                  the range is still the range it was made from
│  ├─ summary.ts     how many passes a set of notes takes, what goes in each,
│  │                  and the frontmatter that says what made the result
│  ├─ ask.ts        a conversation as a markdown file: the turns, the scope
│  │                  rule, the notes it pins, what retrieval refuses to read,
│  │                  and the check that an answer cited only what it was given
│  └─ settings.ts     device-local vs vault-wide preferences
├─ adapters/      webdav.ts · gdrive.ts · llm.ts · memory.ts (tests)
├─ editor/        CodeMirror 6: live preview, widgets, completion, paste
│  ├─ format.ts     the formatting commands behind the rich-text bar
│  ├─ caret.ts      the two edges of a line whose markup is hidden, and what
│  │                 Enter, Backspace and Delete do on each of them
│  ├─ links.ts      external URI recognition, opening and editing
│  ├─ linkClicks.ts following a link from the text — clicks and taps alike
│  ├─ table.ts      the pipe-table grid: parse, edit rows/columns, print
│  ├─ tableChrome.ts the handles on a rendered table: press to pick a row or
│  │                 column out, press again for its menu, drag to reorder
│  ├─ tsv.ts       a spreadsheet range off the clipboard, as a table
│  ├─ callout.ts   the callout vocabulary: five colours, and what aliases to them
│  ├─ codeblock.ts reading a fenced block back out, for the copy button
│  ├─ due.ts        writing a task's due date into the buffer being typed in
│  ├─ vars.ts       `$(property)`: the note's own frontmatter, read into its
│  │                 body — the completion that offers it, what the clipboard
│  │                 does with it, and the `read-only` lock a note puts on
│  │                 itself
│  ├─ inline.ts      inline markdown for text inside widgets (table cells)
│  └─ pickImage.ts   camera / photo library / file insertion
└─ ui/            Preact components
   ├─ layout.ts      the three layout modes and panel visibility
   ├─ backForward.ts the trail behind the two arrows, kept by watching what
   │                 is open rather than by every caller remembering to say
   ├─ popout.ts      a note in a window of its own, and what the windows tell
   │                 each other so one vault stays one vault
   ├─ PopoutWindow.tsx  the one-note shell that window boots into
   ├─ Properties.tsx the frontmatter form the note's date opens
   ├─ Menu.tsx       popover on a pointer, bottom sheet on a phone
   ├─ tableMenu.ts   what a table offers, shared by the toolbar's ⊞ and by
   │                 the handles on the table itself
   ├─ dragNote.ts    dragging a note onto a folder, with a pointer
   ├─ DueMenu.tsx    the due-date picker that rides on it
   ├─ DueChip.tsx    a task's date, as a control rather than a caption
   ├─ FilePicker.tsx the vault's own files, as somewhere to insert one from
   ├─ pickFile.ts    what that picker matches on, and the order it answers in
   ├─ NotePicker.tsx the same palette over notes, so nowhere has to ask
   │                 anybody to type a note's name
   ├─ pickNote.ts    what it was opened for, and what to leave out of it
   ├─ QuickAdd.tsx   the capture sheet, kept mounted so the keyboard can be
   │                 raised inside the tap that asked for it
   └─ Mobile.tsx     phone tab bar and full-screen tab views
```

Two rules keep it comprehensible:

**The vault is the source of truth, not the database.** IndexedDB is a cache and
a journal. Wipe it and a sync repopulates it. Nothing lives only there except
version history.

**A backend is five methods.** `list`, `getText`/`getBlob`, `put`, `remove`,
`ensureDir`. All the difficult reasoning is in `sync.ts`. Adding S3, Dropbox or
the File System Access API is a couple hundred lines in `src/adapters/` and one
line in `src/app/backend.ts` — no changes to the engine.

**Bundle.** ~200 KB gzipped for the editor core, ~1.1 MB precached including the
16 lazily-loaded code-block language modes. CodeMirror's full language catalogue
(~120 chunks, +650 KB of precache) was deliberately dropped for a curated set.

---

## Known limits

Being honest about what isn't done, roughly in the order I'd tackle it:

- **A Tag Folder can't live inside a real folder.** The two hierarchies are
  separate — use `folder:Work` in the rule to pin one to a folder.
- **Dragging a note only works with a pointer.** A folder row takes a dropped
  note, but a drag with a finger is a scroll, so touch keeps long-press →
  *Move to…* — which is also still what a keyboard reaches.
- **A folded callout is folded everywhere.** The fold is a `-` in the marker
  rather than a per-window state, which is what makes it survive a reload and a
  sync — and also means folding one on the laptop folds it on the phone. That
  is the right trade for a note you keep, but it is a trade.
- **A popped-out note on its own doesn't sync.** The window that opened it is
  the one with the backend connected, and a popout deliberately doesn't run a
  second sync engine racing the first. It saves to the same local database
  regardless, so nothing is lost — but close the app and leave only the popout
  open, and what you write there goes up the next time the app itself is.
  Ordinary tabs are a different case and are handled: every window mirrors its
  writes to the others over a BroadcastChannel, and a run takes a Web Lock, so
  two tabs of the app share one picture of the vault and only one of them syncs
  at a time.
- **The search index is rebuilt from nothing each session** — it lives in
  memory, so a reload, or an installed app the OS has evicted, starts again. It
  is only built by vaults big enough to want one, it runs in idle slices and
  nothing waits for it, so the cost is invisible rather than free: roughly a
  third of a second of background CPU per cold start at three thousand notes.
  Persisting it in IndexedDB is the obvious answer and probably the wrong one —
  reading a few megabytes back and proving it still matches the vault is not
  clearly cheaper than rebuilding from text already in memory, and a stale
  index is a search that is quietly wrong. Making the *build* cheaper is the
  better lever if it ever matters.
- **Two kinds of PDF are shipped short.** A PDF whose text is encoded through a
  CJK character map needs pdf.js's `cmaps`, and a PDF with JavaScript in its
  form fields needs its `quickjs` runtime; neither is bundled — 1.7MB and 460KB
  respectively, against a viewer that is already the largest thing here, and the
  second is a JavaScript interpreter this app has no business carrying. Such a
  document opens and scrolls; some of its text may come out as boxes, and a form
  will not calculate. The three decoders that matter for ordinary and scanned
  documents — JBIG2, JPEG 2000 and colour profiles — *are* bundled.
- **The launcher shortcuts and the share target are Android's, and iOS has no
  substitute.** Safari implements neither, so on an iPhone the home-screen icon
  has no long-press menu and Slate is not in the share sheet. A URL cannot stand
  in: iOS launches an installed web app at its `start_url` and drops anything
  appended afterwards, so `?add=task` only ever reaches the app on a launch that
  *starts* there. And the obvious fix for that — an icon per entry point,
  installed from a page carrying the right `start_url` — founders on iOS
  partitioning storage per web clip: the second icon gets its own empty vault,
  which for a local-first app is a trap rather than a shortcut. Both were
  verified on a device. On Android there is a second cost, and it is the
  manifest's:
  Chrome bakes the manifest into the WebAPK at install time, so an app that was
  installed before this shipped shows neither until it is uninstalled and
  installed again. Nothing short of that does it — see the long note in
  `vite.config.ts`, which was written the hard way.

- **Quick capture writes where the setting says, not where you are looking.** A
  task captured from a note about something else still goes to the daily note or
  the Inbox; the sheet names the file, and changing it is a tap, but there is no
  "add this to the note I am reading". A note that is open is the one place the
  editor is already better at.

- **Nothing tells you whether your model can see.** The model list a server
  returns says nothing about which of its entries handle images, so picking a
  text-only one gets you a confident answer about nothing, and the only symptom
  is that the answer is wrong. Guessing from the model's name would be wrong
  often enough to be worse than saying nothing. The failure when a model returns
  empty does at least name the likely cause.
- **Transcription is one picture at a time.** There is no "transcribe every
  image in this note", and no alt text — a `![[wikilink]]` embed has nowhere to
  put any, since the pipe already means width.
- **A conversation finds notes by keyword, not by meaning.** The model chooses
  the words and Slate's own index does the matching, so a note that discusses
  the thing you asked about without ever naming it is not found. Semantic recall
  needs embeddings, which would be a store to keep current and to sync; this is
  the version that works with no such thing, and it says what it searched so you
  can see when the search was the problem. Pinning a note is the way round it
  for a note you already know you want read, and `links:` is the way round it
  when the connection you care about is one you drew yourself.
- **The graph goes one hop, and only as a scope.** `links:` narrows what may be
  searched to a note's immediate neighbours; it does not widen an ordinary
  conversation to follow citations outward, and it does not chase a second hop.
  Two hops from anything in a well-linked vault is most of the vault.
- **A pin is a whole note, and it is spent every question.** There is no way to
  pin a section, and a long pinned note eats the budget on questions it has
  nothing to do with. The callout tells you when it crowded the search out; the
  remedy is fewer pins, not a cleverer pin.
- **Notes go whole, or not at all.** There is no chunking and no ranking within
  a note, so one long note can crowd out three short ones — the callout says how
  many matched and which limit cut the rest, but the remedy is a bigger budget
  rather than a cleverer slice.
- **A summary is of the notes, not of the vault.** It reads what is in the list,
  so what it covers is exactly what you narrowed to and nothing else — there is
  no "and anything related". The token figure is an estimate from character
  count rather than a real tokeniser: near enough to decide how many passes to
  make, not a billing forecast.
- **No encryption at rest.** Notes are plain files on your server. Per-file
  encryption before upload would fit cleanly behind the adapter interface.
- **iOS PWA storage can be evicted** after ~7 days of not opening the app, which
  is a Safari policy, not something the app can override. With sync configured
  this costs a re-download, not data. It is the strongest argument for setting up
  a backend rather than staying local-only.

---

## Ideas worth considering next

- **A graph or "related notes" view**, built on the backlink map that already
  exists.
- **Publish a note** as a read-only shared link, straight from the adapter.
- **Encrypted vaults**, as above — a clean fit behind `RemoteAdapter`.
- **Multiple vaults**, which is nearly free: `db.ts` already reads its database
  name from a global so more than one can coexist in a profile.
- **Tag Folder rules over dates** — `created:<2026-01-01`, `due:overdue` — which
  the parser is already shaped to accept.

---

## Testing

```bash
npm test                # 918 unit + two-device sync tests
node scripts/smoke.mjs  # 654 checks in headless Chromium against dist/
node scripts/shots.mjs  # regenerate screenshots/
```

The smoke test covers what unit tests can't reach: live-preview rendering,
autocomplete, clipboard paste with real image re-encoding, IndexedDB persistence
across reloads, and a genuine offline load with the network cut. It runs from a
subdirectory so the build stays relocatable, sweeps twelve viewport widths
asserting the editor never drops below a usable size and no drawer is ever left
open by a resize, and drives the phone layout with real touch events. Its
kitchen-sink note exists because a table alone once crashed the editor and
nothing else's content contained one. The table section asserts inline elements
inside cells one by one — `strong`, `em`, `code`, `del`, a wikilink, a link, a
tag — rather than eyeballing text, and the photo-insert section drives the real
native file picker and checks the result was re-encoded, named and made
resizable exactly like a paste, then inserts that same file a second time from
the in-vault picker — filtered by typing, chosen with Enter — and checks the
note gained an embed while the vault gained no second copy. The phone section
formats a table from the Format sheet with real taps — the cell stays marked,
the note stays put, and the keyboard stays down — and taps a link in both
rendered modes, because a tap that only summons the keyboard is exactly what a
synthesised click looks like. It also holds the reading mode to its promise on
both layouts: a note opened from the list has no `contenteditable` anywhere in
it and nothing focused, a table in it has no typeable cells, and the tap that
ends that is the one that puts the caret in the word it landed on.

Four more sections exist because the answer is only true in a browser. A note
is *dragged* onto a folder with real drag events, which is the whole of that
feature. A callout is folded from its chevron and the note on disk is read back
to prove the `-` landed in the marker — and that the press left no caret on the
line, which would have revealed the marker and taken the chevron with it. A
column is aligned from the phone's Format sheet, because the delimiter row it
writes to is the one thing neither rendered mode shows. And the same searches
run twice, before and after the search index has finished building in the
background, asserting the two answer identically — including a term that starts
in the middle of a word, which is what an index over words rather than runs
would quietly stop finding. A browser dialog is now a *failure* in the folder
section: naming a folder is the app's own dialog, and `prompt()` is what that
used to be.

Three of its sections are there because the browser is the only place the answer
exists. The spreadsheet paste is driven through a real `ClipboardEvent` carrying every
flavour Excel sends, the picture of the range included — the first version of
that test built a clipboard from the two text flavours alone, which no
spreadsheet on earth produces, and so it passed against a handler that checked
images first and turned every real paste into a screenshot. It asserts the
negative case too: tab-separated text with no table behind it has to stay text,
or every indented paste in the app silently becomes a table. The copy button is clicked and the clipboard read back, which
is also what caught it starting an edit on the note it was pressed in: it swallows
the mouse events, but tap-to-edit watches pointer events, which arrive first.
And the callout section writes one the way a person would — type `> [!`, pick
from the list — because the marker doubles as a CommonMark shortcut link
reference, so the brackets get hidden as link syntax unless the callout claims
them first.

The templates section starts by asserting the *absence* of the feature — a
vault that has never made a `Templates/` folder must show no sign of it in any
menu, and no folder must appear on its own — then drives the whole opt-in from
the Settings button through to typing into a note that started from a template,
checking the caret landed where `{{cursor}}` said rather than at position 0.
The starter set is checked as the notes it is: written to `Templates/`, opened
with its `{{date}}` still written out — nothing is filled in until a note is
*made* from one — and then filled in, frontmatter and all, in the note that is.
The templates themselves are unit-tested in `core/starters.test.ts`, because a
typo in one is invisible in review and then appears verbatim in every note made
from it.

The formatting bar's overflow is asserted as a property rather than a button
count, because the count is a function of the window: at every width the bar
must have no content it cannot show, and everything it cannot show must be in
the **…** menu. It is checked in both directions — widening the pane has to
bring the groups back, which is the failure mode of measuring a bar whose parts
are already hidden and therefore measure zero.

If Chromium isn't on the default path:

```bash
CHROMIUM_PATH=/path/to/chrome node scripts/smoke.mjs
```
