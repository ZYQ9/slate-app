/**
 * Folders and Tag Folders.
 *
 * Two kinds of container, deliberately different in nature:
 *
 *  - A **folder** is a real directory in the vault. Notes live in exactly one.
 *    Folders are normally implied by the paths of the notes inside them, which
 *    is what keeps the vault a plain folder of files; the one thing that needs
 *    recording is an *empty* folder you just created and haven't filled yet, so
 *    those are listed in `backstage/folders.json` until a note lands in them.
 *
 *  - A **Tag Folder** is a saved boolean rule. It owns no notes; it is a live
 *    view. Deleting one never deletes a note.
 *
 * Both definitions live in `backstage/`, so they sync to every device.
 */

import { computed, signal } from '@preact/signals'
import {
  contentNotes,
  deleteNote,
  getRaw,
  isHidden,
  listAll,
  movePath,
  notes,
  readBackstage,
  revision,
  tasks,
  writeBackstage,
} from './vault'
import { basename, dirname, joinPath, normPath, safeSegment, startOfDay, uid } from './util'
import {
  evaluateQuery,
  parseQuery,
  type QueryContext,
  type QueryNode,
} from './tagquery'
import type { NoteIndexEntry, TaskItem } from './types'
import { forgetFolder, forgetTagFolders, renameOpenFolder } from './disclosure'
import { clearTemplateFolders, repointTemplateFolders } from './templates'
import { mediaClass } from './util'
import { resolveEmbed } from './vault'

/* ------------------------------------------------------------ real folders */

/** Folders created by hand that don't contain a note yet. */
const explicitFolders = signal<string[]>([])

export async function loadFolders(): Promise<void> {
  const list = await readBackstage<string[]>('folders.json')
  if (Array.isArray(list)) explicitFolders.value = list.map(normPath).filter(Boolean)
}

async function persistFolders() {
  // Only empty ones need recording; the rest are implied by their notes and
  // would just be a second source of truth to drift out of sync.
  const implied = impliedFolders()
  const keep = explicitFolders.value.filter((f) => !implied.has(f))
  explicitFolders.value = keep
  await writeBackstage('folders.json', keep)
}

function impliedFolders(): Set<string> {
  const s = new Set<string>()
  for (const n of notes.value) {
    let p = n.folder
    while (p) {
      s.add(p)
      p = dirname(p)
    }
  }
  return s
}

export interface FolderNode {
  path: string
  name: string
  /** Notes directly in this folder and every descendant. */
  count: number
  children: FolderNode[]
}

export const folderTree = computed<FolderNode>(() => {
  revision.value
  const root: FolderNode = { path: '', name: 'All Notes', count: 0, children: [] }
  const byPath = new Map<string, FolderNode>([['', root]])

  const ensure = (p: string): FolderNode => {
    const hit = byPath.get(p)
    if (hit) return hit
    const parent = ensure(dirname(p))
    const node: FolderNode = { path: p, name: basename(p), count: 0, children: [] }
    parent.children.push(node)
    byPath.set(p, node)
    return node
  }

  for (const p of impliedFolders()) ensure(p)
  for (const p of explicitFolders.value) ensure(p)

  for (const n of notes.value) {
    root.count++
    let p = n.folder
    while (p) {
      byPath.get(p)!.count++
      p = dirname(p)
    }
  }

  const sortRec = (n: FolderNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    n.children.forEach(sortRec)
  }
  sortRec(root)
  return root
})

/** Flat list of every folder path, for "move to…" pickers. */
export const allFolderPaths = computed<string[]>(() => {
  const out: string[] = []
  const walk = (n: FolderNode) => {
    if (n.path) out.push(n.path)
    n.children.forEach(walk)
  }
  walk(folderTree.value)
  return out
})

export function folderExists(path: string): boolean {
  return allFolderPaths.value.includes(normPath(path))
}

/**
 * Create a folder, nested arbitrarily deep. `parent` may itself be nested;
 * every missing level in between is created too.
 */
export async function createFolder(parent: string, name: string): Promise<string> {
  const clean = safeSegment(name)
  if (!clean) throw new Error('That folder name is empty once cleaned up.')
  let path = joinPath(normPath(parent), clean)
  let n = 2
  while (folderExists(path)) path = joinPath(normPath(parent), `${clean} ${n++}`)

  const next = new Set(explicitFolders.value)
  // Record every ancestor as well, so a deep create survives a reload before
  // any note is added to the intermediate levels.
  let p = path
  while (p) {
    next.add(p)
    p = dirname(p)
  }
  explicitFolders.value = [...next]
  await persistFolders()
  return path
}

/** Rename a folder, moving every note beneath it. Wikilinks are unaffected. */
export async function renameFolder(from: string, name: string): Promise<string> {
  const src = normPath(from)
  const clean = safeSegment(name)
  if (!src || !clean) return src
  const dest = joinPath(dirname(src), clean)
  if (dest === src) return src
  if (folderExists(dest)) throw new Error(`"${clean}" already exists here.`)

  // Deepest paths first so a parent move can't invalidate a child's source.
  const moving = listAll()
    .filter((f) => !f.deleted && (f.path.startsWith(`${src}/`) || dirname(f.path) === src))
    .sort((a, b) => b.path.length - a.path.length)

  for (const f of moving) {
    await movePath(f.path, `${dest}${f.path.slice(src.length)}`)
  }

  explicitFolders.value = explicitFolders.value.map((p) =>
    p === src || p.startsWith(`${src}/`) ? `${dest}${p.slice(src.length)}` : p,
  )
  await persistFolders()
  // A template assignment is keyed by folder path, so it has to come along
  // too — otherwise the folder is still there, still looks the same, and has
  // quietly stopped applying its template.
  await repointTemplateFolders(src, dest)
  // Same reasoning for which rows in the sidebar are unfolded: the folder is
  // the one you just had open, so it stays open under its new name.
  renameOpenFolder(src, dest)
  return dest
}

/**
 * Delete a folder. Notes inside go to the trash rather than vanishing, so this
 * is recoverable like every other delete in the app.
 */
export async function deleteFolder(path: string): Promise<number> {
  const src = normPath(path)
  if (!src) return 0
  const inside = listAll().filter(
    (f) => !f.deleted && !isHidden(f.path) && (f.path.startsWith(`${src}/`) || dirname(f.path) === src),
  )
  for (const f of inside) await deleteNote(f.path)

  explicitFolders.value = explicitFolders.value.filter(
    (p) => p !== src && !p.startsWith(`${src}/`),
  )
  await persistFolders()
  await clearTemplateFolders(src)
  forgetFolder(src)
  return inside.length
}

/** Move one note into a folder (`''` for the vault root). */
export async function moveNoteToFolder(notePath: string, folder: string): Promise<string> {
  const f = getRaw(notePath)
  if (!f) return notePath
  const dest = joinPath(normPath(folder), basename(notePath))
  if (dest === notePath) return notePath
  await movePath(notePath, dest)
  await persistFolders()
  return dest
}

/* ------------------------------------------------------------ tag folders */

export interface SmartFolder {
  id: string
  name: string
  /** The boolean rule, as typed. Empty means this is a pure grouping folder. */
  query: string
  /** Emoji shown in the sidebar, or an image of your own as a small `data:` URL. */
  icon?: string
  /** Parent Tag Folder, for nesting. Undefined means top level. */
  parentId?: string
  /**
   * Whether this folder's rule narrows its parent's.
   *
   * On (the default) makes a hierarchy behave the way a folder hierarchy reads:
   * a child is a subset of its parent, so a parent of `#work` with a child of
   * `#urgent` gives `#work AND #urgent`, and editing the parent re-narrows every
   * descendant at once. Off makes the nesting purely visual — useful for
   * grouping unrelated rules under one heading.
   */
  inherit?: boolean
  /**
   * What the folder gathers. Absent means notes, so every folder that existed
   * before this did carries on unchanged.
   *
   * One kind of folder with a switch on it rather than a second tree beside
   * the first: the rule language, the nesting, the narrowing and the editor
   * are all the same, and "a saved rule" stays one idea to learn instead of
   * two. A rule over tasks reaches `is:` and `due:`, which a rule over notes
   * can write but never matches — a note is neither open nor done.
   */
  shows?: 'notes' | 'tasks'
  createdAt: number
}

export const smartFolders = signal<SmartFolder[]>([])

export async function loadSmartFolders(): Promise<void> {
  const list = await readBackstage<SmartFolder[]>('smart-folders.json')
  if (!Array.isArray(list)) return
  const clean = list.filter((s) => s && typeof s.query === 'string' && s.id)
  // Drop parent references that don't resolve, so a partly-synced or
  // hand-edited file can never strand a folder outside the tree.
  const ids = new Set(clean.map((s) => s.id))
  smartFolders.value = clean.map((s) =>
    s.parentId && !ids.has(s.parentId) ? { ...s, parentId: undefined } : s,
  )
}

async function persistSmartFolders() {
  await writeBackstage('smart-folders.json', smartFolders.value)
}

export async function saveSmartFolder(
  input: Omit<SmartFolder, 'id' | 'createdAt'> & { id?: string },
): Promise<SmartFolder> {
  const existing = input.id ? smartFolders.value.find((s) => s.id === input.id) : undefined
  let parentId = input.parentId || undefined
  // A folder can never be its own ancestor.
  if (existing && parentId && (parentId === existing.id || isDescendantOf(parentId, existing.id))) {
    parentId = undefined
  }
  const folder: SmartFolder = {
    id: existing?.id ?? uid(8),
    createdAt: existing?.createdAt ?? Date.now(),
    name: input.name.trim() || 'Untitled folder',
    query: input.query.trim(),
    icon: input.icon,
    parentId,
    inherit: input.inherit ?? true,
    // Absent rather than 'notes' when it gathers notes, so a folder written
    // before this existed round-trips through backstage/ unchanged.
    shows: input.shows === 'tasks' ? 'tasks' : undefined,
  }
  smartFolders.value = existing
    ? smartFolders.value.map((s) => (s.id === folder.id ? folder : s))
    : [...smartFolders.value, folder]
  await persistSmartFolders()
  return folder
}

/**
 * Delete one folder. Children are promoted to its parent rather than deleted
 * with it — a rule can represent real thought, and losing a subtree to one
 * mis-tap would be the wrong default. "Delete with children" is a separate call.
 */
export async function deleteSmartFolder(id: string): Promise<void> {
  const doomed = smartFolders.value.find((s) => s.id === id)
  smartFolders.value = smartFolders.value
    .filter((s) => s.id !== id)
    .map((s) => (s.parentId === id ? { ...s, parentId: doomed?.parentId } : s))
  await persistSmartFolders()
  forgetTagFolders([id])
}

/** Delete a folder and everything nested underneath it. */
export async function deleteSmartFolderTree(id: string): Promise<number> {
  const doomed = new Set<string>([id, ...descendantIds(id)])
  smartFolders.value = smartFolders.value.filter((s) => !doomed.has(s.id))
  await persistSmartFolders()
  forgetTagFolders(doomed)
  return doomed.size
}

export async function moveSmartFolder(id: string, parentId: string | undefined): Promise<void> {
  if (parentId && (parentId === id || isDescendantOf(parentId, id))) return
  smartFolders.value = smartFolders.value.map((s) =>
    s.id === id ? { ...s, parentId: parentId || undefined } : s,
  )
  await persistSmartFolders()
}

export async function reorderSmartFolders(ids: string[]): Promise<void> {
  const byId = new Map(smartFolders.value.map((s) => [s.id, s]))
  const next = ids.map((id) => byId.get(id)).filter(Boolean) as SmartFolder[]
  for (const s of smartFolders.value) if (!ids.includes(s.id)) next.push(s)
  smartFolders.value = next
  await persistSmartFolders()
}

/**
 * The folders sitting beside this one, in the order the sidebar draws them.
 *
 * The tree is built by filtering the flat list, so its sibling order *is* the
 * flat list's order — which is what makes reordering a swap of two entries
 * rather than a stored index on every folder.
 */
export function smartFolderSiblings(id: string): SmartFolder[] {
  const self = smartFolders.value.find((s) => s.id === id)
  if (!self) return []
  return childrenOf(self.parentId ?? undefined)
}

/**
 * Move a Tag Folder one place up or down among its siblings.
 *
 * Up and down rather than a drag: the sidebar is a tree on a phone as well, a
 * drag there is a scroll, and two menu items do the same job on every device
 * and from the keyboard. Whole subtrees travel with their parent for free —
 * children are found by parent, not by position, so only the two swapped rows
 * move at all.
 */
export async function nudgeSmartFolder(id: string, delta: -1 | 1): Promise<boolean> {
  const siblings = smartFolderSiblings(id)
  const at = siblings.findIndex((s) => s.id === id)
  const swap = siblings[at + delta]
  if (at < 0 || !swap) return false
  const order = smartFolders.value.map((s) => s.id)
  const i = order.indexOf(id)
  const j = order.indexOf(swap.id)
  order[i] = swap.id
  order[j] = id
  await reorderSmartFolders(order)
  return true
}

/** Whether that nudge would go anywhere, for the menu items that offer it. */
export function canNudgeSmartFolder(id: string, delta: -1 | 1): boolean {
  const siblings = smartFolderSiblings(id)
  const at = siblings.findIndex((s) => s.id === id)
  return at >= 0 && !!siblings[at + delta]
}

/* ---------------------------------------------------------- the hierarchy */

export interface SmartNode {
  folder: SmartFolder
  depth: number
  children: SmartNode[]
}

function childrenOf(id: string | undefined): SmartFolder[] {
  return smartFolders.value.filter((s) => (s.parentId ?? undefined) === id)
}

export function descendantIds(id: string, seen = new Set<string>()): string[] {
  if (seen.has(id)) return []
  seen.add(id)
  const out: string[] = []
  for (const c of childrenOf(id)) {
    out.push(c.id, ...descendantIds(c.id, seen))
  }
  return out
}

/** Is `id` somewhere beneath `ancestorId`? Guarded against corrupt cycles. */
export function isDescendantOf(id: string, ancestorId: string): boolean {
  const byId = new Map(smartFolders.value.map((s) => [s.id, s]))
  let cur = byId.get(id)
  let hops = 0
  while (cur?.parentId && hops++ < 64) {
    if (cur.parentId === ancestorId) return true
    cur = byId.get(cur.parentId)
  }
  return false
}

export const smartFolderTree = computed<SmartNode[]>(() => {
  const build = (parent: string | undefined, depth: number, seen: Set<string>): SmartNode[] =>
    childrenOf(parent)
      .filter((f) => !seen.has(f.id))
      .map((folder) => {
        seen.add(folder.id)
        return { folder, depth, children: build(folder.id, depth + 1, seen) }
      })
  return build(undefined, 0, new Set())
})

/** Flattened tree, for the phone's More list and parent pickers. */
export const smartFolderList = computed<SmartNode[]>(() => {
  const out: SmartNode[] = []
  const walk = (nodes: SmartNode[]) => {
    for (const n of nodes) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(smartFolderTree.value)
  return out
})

export function smartFolderAncestors(id: string): SmartFolder[] {
  const byId = new Map(smartFolders.value.map((s) => [s.id, s]))
  const out: SmartFolder[] = []
  let cur = byId.get(id)
  let hops = 0
  while (cur?.parentId && hops++ < 64) {
    const parent = byId.get(cur.parentId)
    if (!parent) break
    out.unshift(parent)
    cur = parent
  }
  return out
}

/** Notes matching a parsed rule. */
export function notesMatching(node: QueryNode): NoteIndexEntry[] {
  return contentNotes.value.filter((n) => evaluateQuery(node, contextFor(n)))
}

/**
 * The same rule, run over tasks instead of notes.
 *
 * A task carries the tags on its own line *and* the ones its note carries, so
 * `#home` gathers every task on every note about home without any of them
 * having been tagged by hand — which is how people actually keep notes, and
 * the whole reason this is worth having.
 */
export function tasksMatching(node: QueryNode): TaskItem[] {
  const today = startOfDay(Date.now())
  return tasks.value.filter((t) => evaluateQuery(node, taskContextFor(t, today)))
}

export function taskContextFor(task: TaskItem, today = startOfDay(Date.now())): QueryContext {
  return {
    tags: task.tags,
    folder: task.folder,
    // A task is not a note; the note-shaped questions are all false for one.
    hasTasks: false,
    hasImages: false,
    hasAttachments: false,
    hasLinks: false,
    done: task.done,
    due: task.due,
    today,
  }
}

/* ------------------------------------------------------- effective rules */

/**
 * The rule actually applied to a folder, after inheritance.
 *
 * Returns undefined for a folder with no rule of its own and nothing inherited
 * — a pure grouping folder, which shows the union of its descendants instead.
 * Ancestors are walked iteratively from the top so a cycle can't recurse away.
 */
export function effectiveNode(id: string): QueryNode | undefined {
  const byId = new Map(smartFolders.value.map((s) => [s.id, s]))
  const chain: SmartFolder[] = []
  let cur = byId.get(id)
  let hops = 0
  while (cur && hops++ < 64) {
    chain.unshift(cur)
    // Stop climbing as soon as a link opts out of inheriting.
    if (!cur.parentId || cur.inherit === false) break
    cur = byId.get(cur.parentId)
  }

  let node: QueryNode | undefined
  for (const f of chain) {
    if (!f.query.trim()) continue
    const parsed = parseQuery(f.query)
    if (!parsed.node) continue
    // An empty rule parses to "everything"; ANDing that in would be a no-op
    // but also hides genuine mistakes, so skip it explicitly.
    if (parsed.node.t === 'all') continue
    node = node ? { t: 'and', l: node, r: parsed.node } : parsed.node
  }
  return node
}

/** True when the folder groups other folders rather than matching notes itself. */
export function isGroupFolder(id: string): boolean {
  return effectiveNode(id) === undefined
}

/**
 * Notes shown for a Tag Folder: its own matches, or — for a pure grouping
 * folder — the union of everything nested beneath it, so a parent always
 * contains at least what its children do.
 */
/** True when this folder gathers tasks rather than notes. */
export function showsTasks(f: SmartFolder | undefined): boolean {
  return f?.shows === 'tasks'
}

export function tasksForSmartFolder(id: string): TaskItem[] {
  const node = effectiveNode(id)
  return node ? tasksMatching(node) : []
}

export function notesForSmartFolder(id: string): NoteIndexEntry[] {
  const node = effectiveNode(id)
  if (node) return notesMatching(node)

  const seen = new Set<string>()
  const out: NoteIndexEntry[] = []
  for (const childId of descendantIds(id)) {
    for (const n of notesForSmartFolder(childId)) {
      if (seen.has(n.path)) continue
      seen.add(n.path)
      out.push(n)
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Rules that don't parse, so the sidebar can flag them. */
export function smartFolderError(f: SmartFolder): string | undefined {
  if (!f.query.trim()) return undefined
  return parseQuery(f.query).error
}

/** Live match counts per Tag Folder, for the sidebar badges. */
export const smartFolderCounts = computed<Map<string, number>>(() => {
  const out = new Map<string, number>()
  // A folder that gathers tasks counts tasks; counting the notes they sit on
  // would put a number beside it that matches nothing it shows.
  for (const s of smartFolders.value) {
    out.set(s.id, showsTasks(s) ? tasksForSmartFolder(s.id).length : notesForSmartFolder(s.id).length)
  }
  return out
})

export function smartFolderById(id: string): SmartFolder | undefined {
  return smartFolders.value.find((s) => s.id === id)
}

/** Build the evaluation context for one note. */
export function contextFor(entry: NoteIndexEntry): QueryContext {
  let hasImages = false
  for (const ref of entry.embeds) {
    const p = resolveEmbed(ref, entry.path)
    if (p && mediaClass(p) === 'image') {
      hasImages = true
      break
    }
  }
  return {
    tags: entry.tags,
    folder: entry.folder,
    hasTasks: entry.hasTasks,
    hasImages,
    hasAttachments: entry.embeds.length > 0,
    hasLinks: entry.links.length > 0,
  }
}
