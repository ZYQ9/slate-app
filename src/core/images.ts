/**
 * Pasted-image optimization.
 *
 * A screenshot straight off the clipboard is a lossless PNG — a full-screen
 * macOS grab is routinely 4–8 MB. Left alone, a year of pasting screenshots
 * would make the vault slow to sync on every device. Re-encoding to WebP at a
 * sane maximum edge typically cuts that by 15–30x with no visible difference at
 * reading size.
 *
 * The rules that keep this safe:
 *   - Never re-encode something already small and already compressed.
 *   - Never re-encode an animated GIF, an SVG, or anything we can't decode.
 *   - If the "optimized" result comes out larger, keep the original.
 */

import { extname, safeSegment, ymd } from './util'

export interface OptimizeOptions {
  maxEdge: number
  quality: number
  format: 'image/webp' | 'image/jpeg' | 'original'
}

export interface OptimizedImage {
  blob: Blob
  width: number
  height: number
  originalSize: number
  /** True when the returned blob is the untouched input. */
  passthrough: boolean
}

const NEVER_TOUCH = new Set(['image/svg+xml', 'image/gif', 'image/avif'])

let webpSupport: boolean | undefined

function supportsWebp(): boolean {
  if (webpSupport === undefined) {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    webpSupport = c.toDataURL('image/webp').startsWith('data:image/webp')
  }
  return webpSupport
}

export async function optimizeImage(
  input: Blob,
  opts: OptimizeOptions,
): Promise<OptimizedImage> {
  const passthrough = (w = 0, h = 0): OptimizedImage => ({
    blob: input,
    width: w,
    height: h,
    originalSize: input.size,
    passthrough: true,
  })

  if (NEVER_TOUCH.has(input.type)) return passthrough()
  if (opts.format === 'original' && opts.maxEdge === 0) return passthrough()
  // Small already-compressed images gain nothing and lose a little to re-encoding.
  if (input.size < 48 * 1024 && input.type !== 'image/png' && input.type !== 'image/bmp')
    return passthrough()

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(input)
  } catch {
    // Undecodable (HEIC on a browser without support, corrupt data). Store as-is
    // rather than refusing the paste.
    return passthrough()
  }

  try {
    const { width: sw, height: sh } = bitmap
    const maxEdge = opts.maxEdge || Math.max(sw, sh)
    const scale = Math.min(1, maxEdge / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))

    let target: string =
      opts.format === 'original'
        ? input.type || 'image/png'
        : opts.format === 'image/webp' && !supportsWebp()
          ? 'image/jpeg'
          : opts.format
    // JPEG has no alpha; a screenshot with transparency would get a black
    // background, so promote those to WebP (or leave them as PNG).
    if (target === 'image/jpeg' && (await hasAlpha(bitmap))) {
      target = supportsWebp() ? 'image/webp' : 'image/png'
    }

    const out = await encode(bitmap, w, h, target, opts.quality)
    if (!out || out.size >= input.size) {
      // No win — keep the original bytes.
      return passthrough(sw, sh)
    }
    return { blob: out, width: w, height: h, originalSize: input.size, passthrough: false }
  } finally {
    bitmap.close?.()
  }
}

async function encode(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  type: string,
  quality: number,
): Promise<Blob | undefined> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')
    if (!ctx) return undefined
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    try {
      return await c.convertToBlob({ type, quality })
    } catch {
      return undefined
    }
  }
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return undefined
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  return new Promise((resolve) => c.toBlob((b) => resolve(b ?? undefined), type, quality))
}

/** Sample the alpha channel to decide whether flattening to JPEG would be lossy. */
async function hasAlpha(bitmap: ImageBitmap): Promise<boolean> {
  const size = 64
  const c =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement('canvas'), { width: size, height: size })
  const ctx = (c as HTMLCanvasElement).getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  ctx.drawImage(bitmap, 0, 0, size, size)
  const { data } = ctx.getImageData(0, 0, size, size)
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true
  return false
}

const EXT_FOR: Record<string, string> = {
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
}

/**
 * Build the vault path for a new attachment: `attachments/2026/08/name.webp`.
 * Dated subfolders keep any single directory small, which matters for both
 * WebDAV listing time and Drive's per-folder query cost.
 */
export function attachmentPath(
  folder: string,
  suggestedName: string,
  mime: string,
): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const ext = EXT_FOR[mime] ?? extname(suggestedName) ?? '.bin'
  const bare = suggestedName.replace(/\.[^.]+$/, '')
  /*
   * A live camera capture arrives as literally "image.jpg" on nearly every
   * device, so a folder of them would be image-2, image-3, … Those get a dated
   * name instead.
   *
   * Names from a photo library are left alone: "IMG_0421" is what the user sees
   * in Photos and "IMG_20260831_143340" already carries its date, so renaming
   * either would lose the thread back to the original.
   */
  const generic = !bare || /^(image|photo|img|unknown|capture)([-_ ]?\d{1,2})?$/i.test(bare)
  const stamp = `${ymd(d)}-${d.toTimeString().slice(0, 8).replace(/:/g, '')}`
  const stem = safeSegment(generic ? `photo-${stamp}` : bare)
  return `${folder}/${y}/${m}/${stem}${ext}`.replace(/\/+/g, '/')
}

/** Extract image files from a paste or drop, ignoring the text/html twin. */
export function imagesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue
    const f = item.getAsFile()
    if (f && f.type.startsWith('image/')) out.push(f)
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) out.push(f)
  return out
}

/** Any file from a drop, for the "drop a PDF into the vault" path. */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return []
  return Array.from(dt.files ?? [])
}

/* ------------------------------------------------------------ for the wire */

/**
 * How big a picture is worth sending to a model.
 *
 * Vision models work from a fixed grid of tiles and throw away the rest, so a
 * 4000px screenshot costs several times the tokens of a 1568px one and reads
 * exactly the same words out of it. This number is the largest edge any of the
 * common ones actually uses; above it you are paying for pixels that get
 * resampled away before the model sees them.
 */
export const WIRE_MAX_EDGE = 1568

/**
 * The two formats every vision endpoint accepts.
 *
 * Slate's own default is WebP, which is the right choice for storing a pasted
 * screenshot and the wrong one for sending: OpenAI and Gemini take it, but
 * plenty of OpenAI-compatible servers — llama.cpp's included — decode only PNG
 * and JPEG, and a refusal there is indistinguishable from a dozen other
 * refusals. Converting costs one canvas pass and removes the whole class of
 * problem, so a picture is always re-encoded rather than sent as it sits.
 */
const WIRE_TYPES = new Set(['image/jpeg', 'image/png'])

export interface WireImage {
  /** Base64 with no `data:` prefix — both wire formats want it bare. */
  base64: string
  mime: string
  width: number
  height: number
  bytes: number
}

/**
 * Re-encode an image into something a model will certainly accept.
 *
 * Alpha decides the format: JPEG is smaller and right for a photograph or a
 * screenshot, and wrong for anything transparent, which it would flatten onto
 * black. Quality is higher than the paste path uses — this picture is being
 * read rather than looked at, and JPEG artefacts land hardest on exactly the
 * thing being read, which is small text.
 */
export async function toWireImage(input: Blob, maxEdge = WIRE_MAX_EDGE): Promise<WireImage> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(input)
  } catch {
    throw new Error('This image could not be decoded in the browser, so there is nothing to send.')
  }
  try {
    const { width: sw, height: sh } = bitmap
    const scale = Math.min(1, maxEdge / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))
    const type = (await hasAlpha(bitmap)) ? 'image/png' : 'image/jpeg'
    const out = await encode(bitmap, w, h, type, 0.92)
    if (!out) throw new Error('This image could not be prepared for sending.')
    return {
      base64: await toBase64(out),
      mime: WIRE_TYPES.has(out.type) ? out.type : type,
      width: w,
      height: h,
      bytes: out.size,
    }
  } finally {
    bitmap.close?.()
  }
}

/**
 * Base64 for a blob, without building a megabyte-wide argument list.
 *
 * `btoa(String.fromCharCode(...bytes))` is the one-liner everybody writes and
 * it throws on a picture: spreading a few hundred thousand arguments overflows
 * the call stack. `FileReader` does the encoding itself and hands back a data
 * URL, so the only work here is cutting the prefix off.
 */
async function toBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Could not read the image'))
    r.readAsDataURL(blob)
  })
  const comma = url.indexOf(',')
  return comma === -1 ? '' : url.slice(comma + 1)
}

/** The edge a Tag Folder's own picture is kept at — twice the row's, for a sharp retina icon. */
export const ICON_EDGE = 64

/** An SVG small enough to carry inline as it is; anything larger is rasterized. */
const ICON_SVG_MAX = 16 * 1024

/**
 * Turn a picked image into an icon a Tag Folder can carry as a data URL.
 *
 * The icon lives inside `smart-folders.json`, which syncs with everything else
 * in backstage/, so it has to be small: a picture is shrunk to `ICON_EDGE` and
 * re-encoded, which lands a photo at a few kilobytes. A small SVG is kept as it
 * is — it is already tiny and scales cleanly — and it is only ever drawn by an
 * `<img>`, where a script inside it cannot run.
 */
export async function toIconDataUrl(input: Blob): Promise<string> {
  if (input.type === 'image/svg+xml' && input.size <= ICON_SVG_MAX) {
    return `data:image/svg+xml;base64,${await toBase64(input)}`
  }
  const img = await toWireImage(input, ICON_EDGE)
  return `data:${img.mime};base64,${img.base64}`
}
