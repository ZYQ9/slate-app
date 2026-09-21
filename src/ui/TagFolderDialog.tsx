/**
 * Create or edit a Tag Folder.
 *
 * The rule is a text expression, with the vault's own tags offered as chips to
 * tap in — which is what makes it workable on a phone, where typing `#` and a
 * tag name is genuinely tedious. Everything validates live: an invalid rule
 * names the problem and points at it, and a valid one shows how many notes it
 * currently matches before you commit.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { allTags } from '../core/vault'
import {
  allFolderPaths,
  effectiveNode,
  notesForSmartFolder,
  notesMatching,
  tasksMatching,
  saveSmartFolder,
  smartFolderAncestors,
  smartFolderById,
  smartFolderList,
  type SmartFolder,
} from '../core/folders'
import { setTagFolderOpen } from '../core/disclosure'
import { describeQuery, parseQuery, type QueryNode } from '../core/tagquery'
import { toIconDataUrl } from '../core/images'
import { notify, setScope } from './state'
import { IconClose } from './Icons'
import { DEFAULT_FOLDER_ICON, FolderIcon, folderIconText, isImageIcon } from './FolderIcon'

const editing = signal<Partial<SmartFolder> | null>(null)

export function openTagFolderDialog(existing?: SmartFolder, parentId?: string) {
  editing.value = existing ?? {
    name: '',
    query: '',
    icon: DEFAULT_FOLDER_ICON,
    parentId,
    inherit: true,
  }
}

/*
 * The tick is here for a folder that gathers tasks. It is a choice, not a
 * statement — the row draws its own tick from what the folder actually does,
 * because an icon anyone can put on anything cannot be trusted to say so.
 */
const ICONS = [DEFAULT_FOLDER_ICON, '✅', '☑️', '⭐️', '🔥', '📌', '💼', '🏠', '🧠', '📚', '🧾', '🌱', '⚡️', '🎯']

export function TagFolderDialog() {
  const draft = editing.value
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [icon, setIcon] = useState(DEFAULT_FOLDER_ICON)
  const [picking, setPicking] = useState(false)
  const [ownEmoji, setOwnEmoji] = useState('')
  const [parentId, setParentId] = useState<string>('')
  const [inherit, setInherit] = useState(true)
  const [shows, setShows] = useState<'notes' | 'tasks'>('notes')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!draft) return
    setName(draft.name ?? '')
    setQuery(draft.query ?? '')
    setIcon(draft.icon || DEFAULT_FOLDER_ICON)
    setPicking(false)
    setOwnEmoji('')
    setParentId(draft.parentId ?? '')
    setInherit(draft.inherit ?? true)
    setShows(draft.shows === 'tasks' ? 'tasks' : 'notes')
    requestAnimationFrame(() => (draft.id ? inputRef : nameRef).current?.focus())
  }, [draft])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') editing.value = null
    }
    if (draft) addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [draft])

  const parsed = useMemo(() => parseQuery(query), [query])

  /**
   * What the parent contributes, so the dialog can show the rule that will
   * actually be applied rather than only the part being typed. Computed from
   * the saved tree, which is why a folder can't be its own ancestor here.
   */
  const inheritedNode = useMemo<QueryNode | undefined>(() => {
    if (!parentId || !inherit) return undefined
    return effectiveNode(parentId)
  }, [parentId, inherit, draft])

  const combined = useMemo<QueryNode | undefined>(() => {
    const own = parsed.node && parsed.node.t !== 'all' ? parsed.node : undefined
    if (own && inheritedNode) return { t: 'and', l: inheritedNode, r: own }
    return own ?? inheritedNode
  }, [parsed.node, inheritedNode])

  const matches = useMemo(
    () => (combined ? notesMatching(combined) : []),
    [combined, query],
  )
  const taskMatches = useMemo(
    () => (combined && shows === 'tasks' ? tasksMatching(combined) : []),
    [combined, query, shows],
  )
  const hits = shows === 'tasks' ? taskMatches.length : matches.length

  if (!draft) return null

  // A folder can't be moved inside itself or anything nested beneath it.
  const parentOptions = smartFolderList.value.filter(
    (n) =>
      n.folder.id !== draft.id &&
      !(draft.id && smartFolderAncestors(n.folder.id).some((a) => a.id === draft.id)),
  )
  const parentName = parentId ? smartFolderById(parentId)?.name : undefined
  const isGroup = !query.trim() && !inheritedNode

  /**
   * Bring a picture of your own. The input is attached to the document because
   * iOS Safari ignores `click()` on a detached one — see `pickImage`.
   */
  const uploadIcon = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    input.style.opacity = '0'
    const cleanup = () => setTimeout(() => input.remove(), 0)
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      cleanup()
      if (!file) return
      try {
        setIcon(await toIconDataUrl(file))
        setPicking(false)
      } catch (e) {
        notify(e instanceof Error ? e.message : 'That image could not be used as an icon')
      }
    })
    input.addEventListener('cancel', cleanup)
    document.body.appendChild(input)
    input.click()
  }

  /** Any emoji at all — the first grapheme typed, so a stray space or letter after it is dropped. */
  const applyOwnEmoji = () => {
    const text = ownEmoji.trim()
    if (!text) return
    const [first] = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)
    const seg = first?.segment
    if (!seg) return
    setIcon(seg)
    setOwnEmoji('')
    setPicking(false)
  }

  // An icon that isn't one of the presets is shown alongside them, so it can be
  // picked back after trying another.
  const choices = ICONS.includes(icon) ? ICONS : [...ICONS, icon]

  /** Insert a token at the caret, keeping spacing sane. */
  const insert = (token: string) => {
    const el = inputRef.current
    const start = el?.selectionStart ?? query.length
    const end = el?.selectionEnd ?? query.length
    const before = query.slice(0, start)
    const after = query.slice(end)
    const needsSpace = before.length > 0 && !/\s$/.test(before)
    const text = `${before}${needsSpace ? ' ' : ''}${token}${after.startsWith(' ') || !after ? '' : ' '}${after}`
    setQuery(text)
    requestAnimationFrame(() => {
      el?.focus()
      const at = before.length + (needsSpace ? 1 : 0) + token.length
      el?.setSelectionRange(at, at)
    })
  }

  // A rule is optional: a folder with none is a grouping folder that gathers
  // whatever its children match. What can't be saved is a rule that is present
  // but doesn't parse.
  const canSave = !!parsed.node && name.trim().length > 0

  const submit = async () => {
    if (!canSave) return
    const saved = await saveSmartFolder({
      id: draft.id,
      name,
      query,
      icon,
      parentId: parentId || undefined,
      inherit,
      shows,
    })
    editing.value = null
    // Saved into a folded parent, it would land out of sight — so unfold the
    // chain above it, which is the one case where opening a folder is not
    // something the person did by hand.
    for (const a of smartFolderAncestors(saved.id)) setTagFolderOpen(a.id, true)
    setScope({ kind: 'smart', id: saved.id })
    notify(draft.id ? 'Tag Folder updated' : 'Tag Folder created')
  }

  return (
    <div class="scrim" onClick={() => (editing.value = null)}>
      <div class="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div class="dialog-head">
          <h2>{draft.id ? 'Edit Tag Folder' : 'New Tag Folder'}</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={() => (editing.value = null)} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div class="dialog-body">
          <div class="field-row">
            <div class="field" style={{ flex: '0 0 auto', width: 78 }}>
              <span>Icon</span>
              <button
                type="button"
                class="icon-pick-btn"
                aria-expanded={picking}
                aria-label="Choose icon"
                onClick={() => setPicking(!picking)}
              >
                <FolderIcon icon={icon} />
              </button>
            </div>
            <label class="field">
              <span>Name</span>
              <input
                ref={nameRef}
                type="text"
                placeholder="Active work"
                value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
            </label>
          </div>

          {picking && (
            <div class="icon-picker">
              <div class="chips" role="group" aria-label="Icon">
                {choices.map((i) => (
                  <button
                    key={i}
                    class="icon-choice"
                    aria-pressed={icon === i}
                    aria-label={isImageIcon(i) ? 'Your image' : i}
                    onClick={() => {
                      setIcon(i)
                      setPicking(false)
                    }}
                  >
                    <FolderIcon icon={i} />
                  </button>
                ))}
              </div>
              <div class="icon-picker-own">
                <input
                  type="text"
                  placeholder="Any emoji…"
                  aria-label="Any emoji"
                  value={ownEmoji}
                  onInput={(e) => setOwnEmoji((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      applyOwnEmoji()
                    }
                  }}
                />
                <button class="btn" disabled={!ownEmoji.trim()} onClick={applyOwnEmoji}>
                  Use
                </button>
                <button class="btn" onClick={uploadIcon}>
                  Upload image…
                </button>
              </div>
            </div>
          )}

          {parentOptions.length > 0 && (
            <label class="field">
              <span>Inside</span>
              <select
                value={parentId}
                onChange={(e) => setParentId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Top level</option>
                {parentOptions.map((n) => (
                  <option key={n.folder.id} value={n.folder.id}>
                    {'— '.repeat(n.depth)}
                    {folderIconText(n.folder.icon)} {n.folder.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {parentId && (
            <label class="check">
              <input
                type="checkbox"
                checked={inherit}
                onChange={(e) => setInherit((e.target as HTMLInputElement).checked)}
              />
              <span>
                Narrow “{parentName}”
                <small>
                  {inherit
                    ? 'This folder shows only notes that also match its parent, so the hierarchy reads like folders — a child is always a subset of its parent.'
                    : 'This folder is only grouped under its parent visually. Its rule stands on its own.'}
                </small>
              </span>
            </label>
          )}

          {/*
            * Notes or tasks, on the same rule language and the same folder.
            * A second tree beside the first would have meant learning "a saved
            * rule" twice; this way `#home` gathers the notes about home or the
            * jobs on them, and the only difference is what it hands back.
            */}
          <div class="field">
            <span>Gathers</span>
            <div class="seg" role="radiogroup" aria-label="What this folder gathers">
              {(['notes', 'tasks'] as const).map((k) => (
                <button
                  key={k}
                  class="seg-btn"
                  role="radio"
                  aria-checked={shows === k}
                  onClick={() => setShows(k)}
                >
                  {k === 'notes' ? 'Notes' : 'Tasks'}
                </button>
              ))}
            </div>
            <small>
              {shows === 'tasks'
                ? 'Every task on a matching note, plus any tagged on its own line — so tagging a note #home gathers the jobs on it without tagging each one.'
                : 'Notes matching the rule, the way Tag Folders have always worked.'}
            </small>
          </div>

          <label class="field">
            <span>Rule</span>
            <textarea
              ref={inputRef}
              class="rule-input"
              rows={3}
              spellcheck={false}
              autocapitalize="none"
              autocorrect="off"
              placeholder={
                parentId
                  ? 'Leave empty to group other folders, or narrow further…'
                  : '#work AND #active NOT #archived'
              }
              value={query}
              onInput={(e) => setQuery((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
              }}
            />
          </label>

          <div class="rule-status" data-error={parsed.error ? '1' : '0'}>
            {parsed.error ? (
              <>
                <strong>{parsed.error}</strong>
                {parsed.at !== undefined && query && (
                  <pre class="rule-caret">
                    {query.slice(0, parsed.at).replace(/[^\t]/g, ' ')}▲
                  </pre>
                )}
              </>
            ) : isGroup ? (
              <>
                No rule of its own — this will be a <strong>grouping folder</strong>, showing
                everything its nested folders match
                {draft.id ? ` (${notesForSmartFolder(draft.id).length} right now)` : ''}.
              </>
            ) : (
              <>
                Matches <strong>{hits}</strong>{' '}
                {shows === 'tasks' ? (hits === 1 ? 'task' : 'tasks') : hits === 1 ? 'note' : 'notes'} —{' '}
                {describeQuery(combined!)}
                {inheritedNode && (
                  <em class="rule-inherited">
                    inherited from {parentName}: {describeQuery(inheritedNode)}
                  </em>
                )}
              </>
            )}
          </div>

          {shows === 'tasks' && (
            <div class="chip-group">
              <div class="chip-group-label">Only these tasks</div>
              <div class="chips">
                {[
                  ['is:open', 'still to do'],
                  ['is:done', 'finished'],
                  ['due:overdue', 'past its date'],
                  ['due:today', 'today'],
                  ['due:soon', 'this week'],
                  ['due:none', 'no date'],
                ].map(([token, gloss]) => (
                  <button key={token} class="chip" onClick={() => insert(token)}>
                    {token}
                    <small>{gloss}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div class="chip-group">
            <div class="chip-group-label">Operators</div>
            <div class="chips">
              {['AND', 'OR', 'NOT', '(', ')'].map((op) => (
                <button key={op} class="chip chip-op" onClick={() => insert(op)}>
                  {op}
                </button>
              ))}
            </div>
          </div>

          {allTags.value.length > 0 && (
            <div class="chip-group">
              <div class="chip-group-label">Tags</div>
              <div class="chips">
                {allTags.value.map((t) => (
                  <button key={t.tag} class="chip" onClick={() => insert(`#${t.tag}`)}>
                    #{t.tag}
                    <small>{t.count}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {allFolderPaths.value.length > 0 && (
            <div class="chip-group">
              <div class="chip-group-label">Limit to a folder</div>
              <div class="chips">
                {allFolderPaths.value.slice(0, 30).map((f) => (
                  <button
                    key={f}
                    class="chip"
                    onClick={() => insert(f.includes(' ') ? `folder:"${f}"` : `folder:${f}`)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div class="callout">
            Tags nest: <code>#work</code> also matches <code>#work/active</code>. Two terms side by
            side mean AND, so <code>#work #urgent</code> and <code>#work AND #urgent</code> are the
            same rule. <code>-#tag</code> and <code>!#tag</code> are shorthand for NOT. You can also
            use <code>has:tasks</code>, <code>has:images</code>, <code>has:links</code> and{' '}
            <code>has:attachments</code>.
          </div>

          {matches.length > 0 && (
            <div class="chip-group">
              <div class="chip-group-label">Preview</div>
              <div class="rule-preview">
                {shows === 'tasks'
                  ? taskMatches.slice(0, 8).map((t) => (
                      <div key={t.id} class="rule-preview-row">
                        <strong>{t.text || 'Untitled task'}</strong>
                        <small>{t.noteTitle}</small>
                      </div>
                    ))
                  : matches.slice(0, 8).map((m) => (
                      <div key={m.path} class="rule-preview-row">
                        <strong>{m.title}</strong>
                        <small>{m.tags.map((t) => `#${t}`).join(' ')}</small>
                      </div>
                    ))}
                {hits > 8 && <div class="rule-preview-more">+{hits - 8} more</div>}
              </div>
            </div>
          )}
        </div>

        <div class="dialog-foot">
          <button class="btn" onClick={() => (editing.value = null)}>
            Cancel
          </button>
          <button class="btn btn-primary" disabled={!canSave} onClick={submit}>
            {draft.id ? 'Save changes' : 'Create folder'}
          </button>
        </div>
      </div>
    </div>
  )
}
