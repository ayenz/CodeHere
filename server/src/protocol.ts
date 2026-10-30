// Validation of what clients may send. The same file lives in cloudflare/src/protocol.ts;
// keep the two copies identical.
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'

/** The only shared types the editor uses: the code and a map of room settings. */
const ROOT_TYPES = new Set(['code', 'meta'])
const META_KEYS = new Set(['language'])
const MAX_META_VALUE_LENGTH = 64

/** Awareness: how many client IDs one connection may control, and how big a state may be. */
export const MAX_CLIENT_IDS_PER_CONNECTION = 4
const MAX_AWARENESS_STATE_BYTES = 4096
const MAX_NAME_LENGTH = 40
const COLOR = /^#[0-9a-fA-F]{6}$/
const COLOR_LIGHT = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

/**
 * Checks a Yjs update before it is applied. Clients may only add plain text to `code` and
 * short strings under known keys of `meta`. Anything else (other root types, nested types,
 * binary content…) would let a client store unlimited data that MAX_DOC_CHARS never sees.
 */
export function isAllowedUpdate(update: Uint8Array): boolean {
  let structs: Array<Y.Item | Y.GC>
  try {
    structs = Y.decodeUpdate(update).structs as Array<Y.Item | Y.GC>
  } catch {
    return false
  }
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue // GC and skipped ranges carry no content
    // The parent is only encoded when an item has no neighbours. Items placed next to
    // existing ones inherit their parent, which these rules keep to `code` or `meta`.
    if (typeof struct.parent === 'string' && !ROOT_TYPES.has(struct.parent)) return false
    if (struct.parent !== null && typeof struct.parent !== 'string') return false
    if (struct.parentSub !== null && (struct.parent !== 'meta' || !META_KEYS.has(struct.parentSub))) return false
    if (struct.parent === 'meta' && struct.parentSub === null) return false
    const content = struct.content
    if (content instanceof Y.ContentString || content instanceof Y.ContentDeleted) continue
    if (content instanceof Y.ContentAny) {
      const values = content.getContent()
      if (values.length === 1 && typeof values[0] === 'string' && values[0].length <= MAX_META_VALUE_LENGTH) continue
    }
    return false
  }
  return true
}

/** True when a document holds updates it could not integrate (they would be stored forever). */
export function hasPendingUpdates(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null
}

interface AwarenessUser {
  name: string
  color: string
  colorLight?: string
  viewer: boolean
}

function sanitizeState(state: unknown, viewer: boolean): Record<string, unknown> | null {
  if (state === null || typeof state !== 'object') return null
  const { user, cursor } = state as { user?: unknown; cursor?: unknown }
  const clean: Record<string, unknown> = {}
  if (user && typeof user === 'object') {
    const { name, color, colorLight } = user as Record<string, unknown>
    if (typeof name === 'string' && typeof color === 'string' && COLOR.test(color)) {
      const cleanUser: AwarenessUser = {
        name: name.trim().slice(0, MAX_NAME_LENGTH) || 'Anonymous',
        color,
        // The server knows whether a connection is read-only; clients don't get to say.
        viewer,
      }
      if (typeof colorLight === 'string' && COLOR_LIGHT.test(colorLight)) cleanUser.colorLight = colorLight
      clean.user = cleanUser
    }
  }
  // Cursor positions are Yjs relative positions; their shape is checked by Yjs itself, so only
  // the overall size matters here.
  if (cursor === null || (cursor && typeof cursor === 'object')) clean.cursor = cursor
  return clean
}

/**
 * Rewrites an awareness update from one connection: drops entries for client IDs owned by
 * another connection or beyond this connection's quota, strips unknown fields, validates
 * names and colours (they end up in other people's CSS) and forces the viewer flag.
 * Returns null when nothing is left to apply.
 */
export function sanitizeAwarenessUpdate(
  update: Uint8Array,
  options: { viewer: boolean; owned: Set<number>; ownedByOthers: (clientId: number) => boolean },
): Uint8Array | null {
  const decoder = decoding.createDecoder(update)
  const entries: Array<{ clientId: number; clock: number; state: string }> = []
  const owned = new Set(options.owned)
  const count = decoding.readVarUint(decoder)
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    const raw = decoding.readVarString(decoder)
    if (options.ownedByOthers(clientId)) continue
    if (!owned.has(clientId)) {
      if (owned.size >= MAX_CLIENT_IDS_PER_CONNECTION) continue
      owned.add(clientId)
    }
    if (raw.length > MAX_AWARENESS_STATE_BYTES) continue
    let state: unknown
    try {
      state = JSON.parse(raw)
    } catch {
      continue
    }
    const clean = state === null ? null : sanitizeState(state, options.viewer)
    entries.push({ clientId, clock, state: JSON.stringify(clean) })
  }
  if (entries.length === 0) return null
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, entries.length)
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId)
    encoding.writeVarUint(encoder, entry.clock)
    encoding.writeVarString(encoder, entry.state)
  }
  return encoding.toUint8Array(encoder)
}

/** decodeURIComponent that returns null instead of throwing on malformed input. */
export function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
