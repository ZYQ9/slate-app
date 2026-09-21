/** Smart lists, the folder tree, Tag Folders, and tags. */

import { allTags, attachments, contentNotes, tasks, trashItems, unresolvedLinks } from '../core/vault'
import {
  isFolderOpen,
  isTagFolderOpen,
  setFolderOpen,
  setTagFolderOpen,
} from '../core/disclosure'
import {
  canNudgeSmartFolder,
  createFolder,
  deleteFolder,
  deleteSmartFolder,
  deleteSmartFolderTree,
  folderTree,
  isGroupFolder,
  moveSmartFolder,
  nudgeSmartFolder,
  renameFolder,
  showsTasks,
  smartFolderAncestors,
  smartFolderCounts,
  smartFolderError,
  smartFolderList,
  smartFolders,
  smartFolderTree,
  type FolderNode,
  type SmartNode,
} from '../core/folders'
import { parseQuery, tagsInQuery, folderInQuery } from '../core/tagquery'
import { notify, scope, setScope, type Scope } from './state'
import { menuAnchor, openMenu, useLongPress, type MenuItem } from './Menu'
import { openTagFolderDialog } from './TagFolderDialog'
import { FolderIcon, folderIconText } from './FolderIcon'
import { openPrompt } from './PromptDialog'
import { folderDropProps } from './dragNote'
import { closeDrawer } from './layout'
import {
  IconCheck,
  IconChevron,
  IconFolder,
  IconLink,
  IconNotes,
  IconPaperclip,
  IconPlus,
  IconTag,
  IconTrash,
} from './Icons'
import { newNoteInFolder } from './EditorPane'
import { settings, update } from '../core/settings'
import {
  assignedTemplate,
  hasTemplates,
  resolvedTemplate,
  setFolderTemplate,
  templatableFolder,
  templateNotes,
} from '../core/templates'

function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'folder' && b.kind === 'folder') return a.path === b.path
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag === b.tag
  if (a.kind === 'smart' && b.kind === 'smart') return a.id === b.id
  return a.kind !== 'day'
}

/** Selecting anything in the sidebar dismisses it when it's a drawer. */
function select(s: Scope) {
  setScope(s)
  closeDrawer()
}

function Row({
  target,
  icon,
  name,
  count,
  indent = 0,
  drop,
  onContextMenu,
  longPress,
  children,
}: {
  target: Scope
  icon: preact.ComponentChildren
  name: preact.ComponentChildren
  count?: number
  indent?: number
  /** Folder path a dragged note lands in, for the rows that take one. */
  drop?: string
  onContextMenu?: (e: MouseEvent) => void
  longPress?: ReturnType<typeof useLongPress>
  children?: preact.ComponentChildren
}) {
  const current = sameScope(scope.value, target)
  return (
    <button
      class="side-row"
      aria-current={current}
      style={{ paddingLeft: `${10 + indent * 15}px` }}
      onClick={() => select(target)}
      onContextMenu={onContextMenu}
      {...(drop !== undefined ? folderDropProps(drop) : {})}
      {...(longPress ?? {})}
    >
      {children}
      <span class="side-icon">{icon}</span>
      <span class="side-name">{name}</span>
      {count !== undefined && count > 0 && <span class="side-count">{count}</span>}
    </button>
  )
}

/**
 * Choose the template a folder's new notes start from.
 *
 * Only offered when the vault actually has templates — a vault with no
 * `Templates/` folder never sees this item, which is the whole of what makes
 * the feature optional: there is nothing to turn off, and nothing to explain
 * to somebody who does not want it.
 */
function templateMenu(node: FolderNode) {
  const current = assignedTemplate(node.path)
  const items: MenuItem[] = [
    {
      label: current ? 'Stop using a template' : 'No template',
      checked: !current,
      onSelect: () => void setFolderTemplate(node.path, undefined),
    },
    ...templateNotes.value.map((t, i) => ({
      label: t.title,
      separated: i === 0,
      checked: current === t.path,
      onSelect: async () => {
        await setFolderTemplate(node.path, t.path)
        notify(`New notes in "${node.name}" start from "${t.title}"`)
      },
    })),
  ]
  return items
}

function folderMenu(node: FolderNode): MenuItem[] {
  return [
    {
      label: 'New note here',
      onSelect: async () => {
        await newNoteInFolder(node.path)
      },
    },
    ...(hasTemplates.value && templatableFolder(node.path)
      ? [
          {
            /*
             * Names the template rather than just saying there is one, and
             * says so when the note it points at has been renamed or deleted
             * — otherwise the folder looks configured and quietly applies
             * nothing.
             */
            label: assignedTemplate(node.path)
              ? `Template: ${resolvedTemplate(node.path)?.title ?? 'missing'}…`
              : 'Use a template…',
            onSelect: () =>
              openMenu(menuAnchor(), templateMenu(node), `Template for "${node.name}"`),
          } as MenuItem,
        ]
      : []),
    {
      label: 'New subfolder…',
      onSelect: () =>
        openPrompt({
          title: `New folder inside "${node.name}"`,
          label: 'Name',
          value: '',
          placeholder: 'Folder name',
          confirm: 'Create',
          onSubmit: async (name) => {
            const path = await createFolder(node.path, name)
            // A subfolder of a folded folder would be created out of sight, the
            // same way one inside a folded section would be.
            setFolderOpen(node.path, true)
            select({ kind: 'folder', path })
            notify(`Created ${path}`)
          },
        }),
    },
    {
      label: 'Rename…',
      separated: true,
      onSelect: () =>
        openPrompt({
          title: 'Rename folder',
          label: 'Name',
          value: node.name,
          confirm: 'Rename',
          hint: 'Every note inside moves with it. Wikilinks are unaffected.',
          onSubmit: async (name) => {
            if (name === node.name) return
            try {
              const dest = await renameFolder(node.path, name)
              select({ kind: 'folder', path: dest })
              notify('Folder renamed')
            } catch (e) {
              notify((e as Error).message, 'error')
            }
          },
        }),
    },
    {
      label: 'Delete folder',
      danger: true,
      onSelect: async () => {
        const n = node.count
        const msg = n
          ? `Move "${node.name}" and its ${n} note${n === 1 ? '' : 's'} to Deleted?`
          : `Delete the empty folder "${node.name}"?`
        if (!confirm(msg)) return
        await deleteFolder(node.path)
        select({ kind: 'all' })
        notify(n ? `${n} note${n === 1 ? '' : 's'} moved to Deleted` : 'Folder deleted')
      },
    },
  ]
}

/**
 * Whether the row is unfolded is kept per folder rather than in this component:
 * a row is unmounted whenever its parent or its whole section folds away, and
 * `useState` would die with it — which is what made unfolding a section look
 * like it unfolded everything inside it. See core/disclosure.
 */
function FolderRow({ node, depth }: { node: FolderNode; depth: number }) {
  const open = isFolderOpen(node.path)
  const setOpen = (want: boolean) => setFolderOpen(node.path, want)
  const hasKids = node.children.length > 0
  const longPress = useLongPress(() => folderMenu(node), () => node.name)

  return (
    <>
      <Row
        target={{ kind: 'folder', path: node.path }}
        icon={<IconFolder size={15} />}
        name={node.name}
        count={node.count}
        indent={depth}
        drop={node.path}
        longPress={longPress}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu(e, folderMenu(node), node.name)
        }}
      >
        {hasKids ? (
          <span
            class="disclose"
            data-open={open}
            role="button"
            tabIndex={0}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                e.preventDefault()
                setOpen(!open)
              }
            }}
          >
            <IconChevron size={11} />
          </span>
        ) : (
          <span class="disclose" />
        )}
      </Row>
      {open && node.children.map((c) => <FolderRow key={c.path} node={c} depth={depth + 1} />)}
    </>
  )
}

/**
 * Its own component so `useLongPress` is called at a stable position — hooks
 * inside a `.map()` over a list that changes length would desync.
 */
function SmartFolderRow({ node }: { node: SmartNode }) {
  const sf = node.folder
  const open = isTagFolderOpen(sf.id)
  const setOpen = (want: boolean) => setTagFolderOpen(sf.id, want)
  const hasKids = node.children.length > 0
  const error = smartFolderError(sf)
  const group = isGroupFolder(sf.id)
  const count = smartFolderCounts.value.get(sf.id)

  const items: MenuItem[] = [
    { label: 'Edit rule…', onSelect: () => openTagFolderDialog(sf) },
    {
      label: 'New folder inside…',
      onSelect: () => openTagFolderDialog(undefined, sf.id),
    },
    {
      label: 'New note with these tags',
      disabled: group,
      onSelect: async () => {
        const parsed = parseQuery(sf.query)
        if (!parsed.node) return
        // Seed with every tag the folder's own rule requires, plus anything
        // inherited from its parents, so the new note actually lands in it.
        const inherited = smartFolderAncestors(sf.id)
          .filter(() => sf.inherit !== false)
          .flatMap((a) => {
            const p = parseQuery(a.query)
            return p.node ? tagsInQuery(p.node) : []
          })
        const tags = [...new Set([...inherited, ...tagsInQuery(parsed.node)])]
        const body = tags.length ? `${tags.map((t) => `#${t}`).join(' ')}\n\n` : ''
        await newNoteInFolder(folderInQuery(parsed.node) ?? '', 'Untitled', { seed: body })
      },
    },
    /*
     * Siblings sit in the order they were made until somebody says otherwise,
     * and "otherwise" is these two items rather than a drag: the sidebar is a
     * tree on a phone as well, where a drag is a scroll. A subtree travels with
     * its parent, so moving a folder up moves everything under it.
     */
    {
      label: 'Move up',
      separated: true,
      disabled: !canNudgeSmartFolder(sf.id, -1),
      onSelect: () => void nudgeSmartFolder(sf.id, -1),
    },
    {
      label: 'Move down',
      disabled: !canNudgeSmartFolder(sf.id, 1),
      onSelect: () => void nudgeSmartFolder(sf.id, 1),
    },
    {
      label: sf.parentId ? 'Move…' : 'Move into…',
      onSelect: () => {
        // Every folder except this one and its own descendants is a legal home.
        const options = smartFolderList.value
          .map((n) => n.folder)
          .filter((f) => f.id !== sf.id && !isUnder(f.id, sf.id))
        openMenu(
          { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 },
          [
            {
              label: 'Top level',
              disabled: !sf.parentId,
              onSelect: async () => {
                await moveSmartFolder(sf.id, undefined)
                notify('Moved to the top level')
              },
            },
            ...options.map((f) => ({
              label: `${'　'.repeat(smartFolderAncestors(f.id).length)}${folderIconText(f.icon)} ${f.name}`,
              disabled: f.id === sf.parentId,
              onSelect: async () => {
                await moveSmartFolder(sf.id, f.id)
                notify(`Moved into "${f.name}"`)
              },
            })),
          ],
          `Move "${sf.name}" into`,
        )
      },
    },
    {
      label: hasKids ? 'Delete, keeping what’s inside' : 'Delete Tag Folder',
      danger: true,
      separated: true,
      onSelect: async () => {
        const msg = hasKids
          ? `Delete "${sf.name}"? The ${node.children.length} folder${node.children.length === 1 ? '' : 's'} inside move up a level. No notes are affected.`
          : `Delete "${sf.name}"? The notes it gathers are not affected.`
        if (!confirm(msg)) return
        await deleteSmartFolder(sf.id)
        if (scope.value.kind === 'smart' && scope.value.id === sf.id) setScope({ kind: 'all' })
      },
    },
  ]

  if (hasKids) {
    items.push({
      label: 'Delete with everything inside',
      danger: true,
      onSelect: async () => {
        if (!confirm(`Delete "${sf.name}" and every folder inside it? No notes are affected.`)) return
        const n = await deleteSmartFolderTree(sf.id)
        if (scope.value.kind === 'smart') setScope({ kind: 'all' })
        notify(`Deleted ${n} Tag Folders`)
      },
    })
  }

  const longPress = useLongPress(
    () => items,
    () => sf.name,
  )

  return (
    <>
      <Row
        target={{ kind: 'smart', id: sf.id }}
        icon={<FolderIcon icon={sf.icon} />}
        name={
          <>
            {sf.name}
            {showsTasks(sf) && (
              /*
               * A folder that gathers tasks sits in the same list as folders
               * that gather notes, and until this tick nothing on the row said
               * which one you were about to open — same emoji slot, same
               * count, different thing behind it.
               */
              <span class="side-task" title="Gathers tasks" aria-label="Gathers tasks">
                <IconCheck size={11} />
              </span>
            )}
            {error && (
              <span class="side-warn" title={error}>
                {' !'}
              </span>
            )}
          </>
        }
        count={count}
        indent={node.depth}
        longPress={longPress}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu(e, items, sf.name)
        }}
      >
        {hasKids ? (
          <span
            class="disclose"
            data-open={open}
            role="button"
            tabIndex={0}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                e.preventDefault()
                setOpen(!open)
              }
            }}
          >
            <IconChevron size={11} />
          </span>
        ) : (
          <span class="disclose" />
        )}
      </Row>
      {open && node.children.map((c) => <SmartFolderRow key={c.folder.id} node={c} />)}
    </>
  )
}

/** True when `id` sits anywhere beneath `ancestorId`. */
function isUnder(id: string, ancestorId: string): boolean {
  return smartFolderAncestors(id).some((a) => a.id === ancestorId)
}

/**
 * A named section of the sidebar that can be folded away.
 *
 * The three of them stack up: a vault with a deep folder tree, a dozen Tag
 * Folders and eighty tags is several screens of sidebar, and most of the time
 * you are only using one of the three. Which are folded is a preference rather
 * than component state, so it survives a reload and follows you between
 * devices, and the count on the header says what is behind a folded one — a
 * section that hides its contents without saying how many there are is a
 * section people open again just to check.
 */
function SideGroup({
  title,
  collapsed,
  onToggle,
  count,
  add,
  children,
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  count?: number
  add?: { label: string; onSelect: () => void }
  children: preact.ComponentChildren
}) {
  return (
    <div class="side-group">
      <div class="side-group-label">
        <button
          class="side-group-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
          title={collapsed ? `Show ${title}` : `Hide ${title}`}
        >
          <span class="disclose" data-open={!collapsed}>
            <IconChevron size={11} />
          </span>
          <span class="side-group-name">{title}</span>
          {collapsed && count !== undefined && count > 0 && (
            <span class="side-group-count">{count}</span>
          )}
        </button>
        {add && (
          <button class="side-add" title={add.label} aria-label={add.label} onClick={add.onSelect}>
            <IconPlus size={13} />
          </button>
        )}
      </div>
      {!collapsed && children}
    </div>
  )
}

export function Sidebar() {
  const tree = folderTree.value
  const openTasks = tasks.value.filter((t) => !t.done).length
  const trash = trashItems().length
  const unlinked = unresolvedLinks.value.size

  return (
    <div class="sidebar-scroll">
      <div class="side-group">
        <Row
          target={{ kind: 'all' }}
          icon={<IconNotes size={15} />}
          name="All Notes"
          count={contentNotes.value.length}
          /* The vault root is a folder like any other as far as a drop goes. */
          drop=""
        />
        <Row target={{ kind: 'tasks' }} icon={<IconCheck size={15} />} name="Tasks" count={openTasks} />
        <Row
          target={{ kind: 'files' }}
          icon={<IconPaperclip size={15} />}
          name="Files"
          count={attachments.value.length}
        />
        {unlinked > 0 && (
          <Row
            target={{ kind: 'unlinked' }}
            icon={<IconLink size={15} />}
            name="Unlinked"
            count={unlinked}
          />
        )}
        <Row
          target={{ kind: 'trash' }}
          icon={<IconTrash size={15} />}
          name="Deleted"
          count={trash}
        />
      </div>

      <SideGroup
        title="Folders"
        collapsed={settings.value.collapseFolders}
        onToggle={() => update({ collapseFolders: !settings.value.collapseFolders })}
        count={tree.children.length}
        add={{
          label: 'New folder',
          onSelect: () =>
            openPrompt({
              title: 'New folder',
              label: 'Name',
              value: '',
              placeholder: 'Folder name',
              confirm: 'Create',
              onSubmit: async (name) => {
                const path = await createFolder('', name)
                // A new folder inside a folded section would be created out of
                // sight, so making one unfolds it.
                update({ collapseFolders: false })
                select({ kind: 'folder', path })
              },
            }),
        }}
      >
        {tree.children.length === 0 ? (
          <p class="side-hint">No folders yet.</p>
        ) : (
          tree.children.map((c) => <FolderRow key={c.path} node={c} depth={0} />)
        )}
      </SideGroup>

      <SideGroup
        title="Tag Folders"
        collapsed={settings.value.collapseTagFolders}
        onToggle={() => update({ collapseTagFolders: !settings.value.collapseTagFolders })}
        count={smartFolders.value.length}
        add={{
          label: 'New Tag Folder',
          onSelect: () => {
            update({ collapseTagFolders: false })
            openTagFolderDialog()
          },
        }}
      >
        {smartFolders.value.length === 0 ? (
          <p class="side-hint">
            Saved rules like <code>#work AND #active</code> that gather notes automatically.
          </p>
        ) : (
          smartFolderTree.value.map((n) => <SmartFolderRow key={n.folder.id} node={n} />)
        )}
      </SideGroup>

      {allTags.value.length > 0 && (
        <SideGroup
          title="Tags"
          collapsed={settings.value.collapseTags}
          onToggle={() => update({ collapseTags: !settings.value.collapseTags })}
          count={allTags.value.length}
        >
          <div class="tag-cloud">
            {allTags.value.slice(0, 80).map((t) => {
              const current = scope.value.kind === 'tag' && scope.value.tag === t.tag
              return (
                <button
                  key={t.tag}
                  class="tag-chip"
                  aria-current={current}
                  onClick={() => select({ kind: 'tag', tag: t.tag })}
                  title={`${t.count} note${t.count === 1 ? '' : 's'}`}
                >
                  <IconTag size={11} />
                  {t.tag}
                </button>
              )
            })}
          </div>
        </SideGroup>
      )}
    </div>
  )
}
