/**
 * A Tag Folder's icon: an emoji, or a small picture somebody brought.
 *
 * Both live in the same `icon` string, so a folder written before pictures
 * existed carries on unchanged. A picture is an inline `data:` URL, and only
 * the image types a browser draws safely in an `<img>` count as one — anything
 * else in that field is shown as text, the way an emoji always was.
 */

export const DEFAULT_FOLDER_ICON = '🏷️'

const IMAGE_ICON = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/

export function isImageIcon(icon: string | undefined): icon is string {
  return !!icon && IMAGE_ICON.test(icon)
}

/**
 * The icon for places that can only hold text — a `<select>` option, a menu
 * label — where a picture falls back to the default tag.
 */
export function folderIconText(icon: string | undefined): string {
  return !icon || isImageIcon(icon) ? DEFAULT_FOLDER_ICON : icon
}

export function FolderIcon({ icon }: { icon: string | undefined }) {
  return isImageIcon(icon) ? (
    <img class="side-emoji side-icon-img" src={icon} alt="" draggable={false} />
  ) : (
    <span class="side-emoji">{icon || DEFAULT_FOLDER_ICON}</span>
  )
}
