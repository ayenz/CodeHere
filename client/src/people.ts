import { EditorView } from '@codemirror/view'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { $, anchorPopover } from './dom'
import { announce, notify } from './notify'

// Beyond this many avatars the rest collapse into a "+N" button.
const MAX_VISIBLE = 4

interface PeerUser {
  name: string
  color: string
  viewer?: boolean
}

interface PeerState {
  user?: PeerUser
  // Written by y-codemirror.next: relative positions of the peer's selection.
  cursor?: { anchor: unknown; head: unknown }
}

interface Peer extends PeerUser {
  clientId: number
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

function peerLabel(peer: Peer): string {
  return peer.viewer ? `${peer.name} (viewing)` : peer.name
}

export interface People {
  /** Re-renders after the local identity changed. */
  refresh(): void
  /** Starts announcing joins and leaves (skipped while the room first loads). */
  startAnnouncing(): void
}

export function createPeople(options: {
  awareness: Awareness
  doc: Y.Doc
  view: EditorView
  localUser: () => PeerUser
}): People {
  const { awareness, doc, view } = options
  const list = $<HTMLUListElement>('people')
  const overflowButton = $<HTMLButtonElement>('people-more')
  const popover = $('people-popover')
  const popoverList = $<HTMLUListElement>('people-popover-list')
  const youButton = $<HTMLButtonElement>('rename')
  const youInitial = $('you-initial')
  const youLabel = $('you-label')
  const following = $('following')
  const followingName = $('following-name')

  anchorPopover(popover, overflowButton)

  let announcing = false
  let known = new Map<number, string>()
  let followed: number | null = null

  function peers(): Peer[] {
    const result: Peer[] = []
    awareness.getStates().forEach((state: PeerState, clientId) => {
      if (clientId !== doc.clientID && state.user) result.push({ clientId, ...state.user })
    })
    return result
  }

  function cursorPosition(clientId: number): number | null {
    const state = awareness.getStates().get(clientId) as PeerState | undefined
    if (!state?.cursor) return null
    const relative = Y.createRelativePositionFromJSON(state.cursor.head)
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc)
    return absolute ? Math.min(absolute.index, view.state.doc.length) : null
  }

  function follow(clientId: number | null): void {
    followed = clientId
    const peer = clientId === null ? null : peers().find((item) => item.clientId === clientId)
    following.hidden = !peer
    if (peer) {
      followingName.textContent = peer.name
      notify(`Following ${peer.name}`)
      scrollToFollowed()
    }
    render()
  }

  function scrollToFollowed(): void {
    if (followed === null) return
    const pos = cursorPosition(followed)
    if (pos !== null) view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  }

  function avatarButton(peer: Peer, withName: boolean): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = withName ? 'person-row' : 'avatar person'
    button.style.setProperty('--person-color', peer.color)
    button.setAttribute('aria-pressed', String(followed === peer.clientId))
    const action = followed === peer.clientId ? 'stop following' : 'follow their cursor'
    button.title = `${peerLabel(peer)} — ${action}`
    if (peer.viewer) button.classList.add('viewer')

    const badge = document.createElement('span')
    badge.className = withName ? 'avatar small' : 'avatar-initial'
    badge.style.setProperty('--person-color', peer.color)
    badge.setAttribute('aria-hidden', 'true')
    badge.textContent = initial(peer.name)

    const label = document.createElement('span')
    if (withName) {
      label.className = 'person-name'
      label.textContent = peerLabel(peer)
    } else {
      label.className = 'sr-only'
      label.textContent = `${peerLabel(peer)}, ${action}`
    }
    button.append(badge, label)
    button.addEventListener('click', () => {
      follow(followed === peer.clientId ? null : peer.clientId)
      if (withName) popover.hidePopover()
    })
    return button
  }

  function render(): void {
    const all = peers()
    // Show the followed person first so they are never hidden in the overflow.
    all.sort((a, b) => Number(b.clientId === followed) - Number(a.clientId === followed))
    const visible = all.length > MAX_VISIBLE + 1 ? all.slice(0, MAX_VISIBLE) : all
    const hidden = all.length - visible.length

    list.replaceChildren(
      ...visible.map((peer) => {
        const item = document.createElement('li')
        item.append(avatarButton(peer, false))
        return item
      }),
    )
    overflowButton.hidden = hidden === 0
    overflowButton.textContent = `+${hidden}`
    overflowButton.setAttribute('aria-label', `Show all ${all.length} people`)
    popoverList.replaceChildren(
      ...all.map((peer) => {
        const item = document.createElement('li')
        item.append(avatarButton(peer, true))
        return item
      }),
    )

    if (announcing) {
      for (const peer of all) if (!known.has(peer.clientId)) notify(`${peer.name} joined`)
      for (const [clientId, name] of known) if (!all.some((peer) => peer.clientId === clientId)) notify(`${name} left`)
    }
    known = new Map(all.map((peer) => [peer.clientId, peer.name]))

    if (followed !== null && !known.has(followed)) {
      followed = null
      following.hidden = true
      announce('Stopped following: they left the room')
    }

    const me = options.localUser()
    youButton.style.setProperty('--person-color', me.color)
    youButton.title = `${me.name} (you) — change name`
    youInitial.textContent = initial(me.name)
    youLabel.textContent = `${me.name} (you), change name`
  }

  awareness.on('change', ({ updated }: { updated: number[] }) => {
    render()
    if (followed !== null && updated.includes(followed)) scrollToFollowed()
  })
  // Taking over the editor yourself ends following.
  view.dom.addEventListener('pointerdown', () => followed !== null && follow(null))
  view.dom.addEventListener('keydown', () => followed !== null && follow(null))
  $('stop-following').addEventListener('click', () => follow(null))
  render()

  return {
    refresh: render,
    startAnnouncing() {
      announcing = true
    },
  }
}
