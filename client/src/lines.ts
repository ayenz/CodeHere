import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view'

/** 1-based, inclusive line range, as used in #L3 or #L3-L8. */
export interface LineRange {
  from: number
  to: number
}

export function parseLineHash(hash: string): LineRange | null {
  const match = /^#L(\d+)(?:-L?(\d+))?$/.exec(hash)
  if (!match) return null
  const a = Number(match[1])
  const b = match[2] ? Number(match[2]) : a
  if (a < 1 || b < 1) return null
  return { from: Math.min(a, b), to: Math.max(a, b) }
}

export function formatLineHash({ from, to }: LineRange): string {
  return from === to ? `#L${from}` : `#L${from}-L${to}`
}

export function describeLines({ from, to }: LineRange): string {
  return from === to ? `line ${from}` : `lines ${from}–${to}`
}

const setLines = StateEffect.define<LineRange | null>()

const linkedLines = StateField.define<LineRange | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLines)) value = effect.value
    return value
  },
})

const lineMark = Decoration.line({ class: 'cm-linked-line' })

function decorations(state: EditorState): DecorationSet {
  const range = state.field(linkedLines)
  const builder = new RangeSetBuilder<Decoration>()
  if (range) {
    const last = Math.min(range.to, state.doc.lines)
    for (let n = Math.min(range.from, last); n <= last; n++) {
      const line = state.doc.line(n)
      builder.add(line.from, line.from, lineMark)
    }
  }
  return builder.finish()
}

/** Highlights linked lines and lets people pick them by clicking line numbers (shift-click extends). */
export function lineLinks(onPick: (range: LineRange) => void): Extension {
  return [
    linkedLines,
    EditorView.decorations.compute([linkedLines, 'doc'], decorations),
    EditorView.theme({
      '.cm-linked-line': { backgroundColor: 'rgb(250 204 21 / 0.16)', boxShadow: 'inset 2px 0 0 rgb(234 179 8)' },
      '.cm-lineNumbers .cm-gutterElement': { cursor: 'pointer' },
    }),
    lineNumbers({
      domEventHandlers: {
        mousedown(view, block, event) {
          const n = view.state.doc.lineAt(block.from).number
          const current = view.state.field(linkedLines)
          const shift = (event as MouseEvent).shiftKey
          onPick(shift && current ? { from: Math.min(current.from, n), to: Math.max(current.to, n) } : { from: n, to: n })
          return true
        },
      },
    }),
  ]
}

/** Highlights `range` (or clears it) and optionally scrolls it into view. */
export function showLines(view: EditorView, range: LineRange | null, scroll: boolean): void {
  if (!range || !scroll || view.state.doc.lines < range.from) {
    view.dispatch({ effects: setLines.of(range) })
    return
  }
  const start = view.state.doc.line(range.from).from
  view.dispatch({
    effects: [setLines.of(range), EditorView.scrollIntoView(start, { y: 'start', yMargin: 48 })],
    selection: { anchor: start },
  })
}

/** The lines covered by the main selection. */
export function selectedLines(view: EditorView): LineRange {
  const { from, to } = view.state.selection.main
  return { from: view.state.doc.lineAt(from).number, to: view.state.doc.lineAt(to).number }
}
