import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'

// Colours come from CSS custom properties, so switching light/dark is a pure CSS change.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: 'var(--tok-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--tok-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--tok-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--tok-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--tok-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--tok-property)' },
  { tag: [t.tagName, t.heading], color: 'var(--tok-tag)', fontWeight: '600' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--tok-punct)' },
  { tag: t.invalid, color: 'var(--danger)' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
])

// Layout that applies to every theme.
const layout = EditorView.theme({
  '&': { height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0' },
  '.cm-gutters': { border: 'none' },
  '.cm-ySelectionInfo': {
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    fontWeight: '600',
    color: '#0b0f14',
    padding: '1px 5px',
    borderRadius: '4px 4px 4px 0',
    opacity: '1',
  },
})

// The default colours follow the app's light/dark tokens.
const defaultColors = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-subtle)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-activeLine': { backgroundColor: 'var(--line-active)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--selection)', outline: '1px solid var(--border-strong)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--fg)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px' },
})

const defaultTheme: Extension = [defaultColors, syntaxHighlighting(highlight)]

export interface Editor {
  view: EditorView
  setLanguage(extension: Extension): void
  /** Applies a colour theme, or the app-matching default when `null`. */
  setTheme(extension: Extension | null): void
}

export function createEditor(
  parent: HTMLElement,
  ytext: Y.Text,
  awareness: Awareness,
  onSelection: (view: EditorView) => void,
): Editor {
  const language = new Compartment()
  const colorTheme = new Compartment()
  const undoManager = new Y.UndoManager(ytext)

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        // Tab indents; Esc then Tab moves focus out (CodeMirror's built-in escape hatch).
        keymap.of([indentWithTab]),
        language.of([]),
        layout,
        colorTheme.of(defaultTheme),
        EditorView.contentAttributes.of({ 'aria-label': 'Code', 'aria-multiline': 'true' }),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) onSelection(update.view)
        }),
        yCollab(ytext, awareness, { undoManager }),
      ],
    }),
  })

  return {
    view,
    setLanguage(extension) {
      view.dispatch({ effects: language.reconfigure(extension) })
    },
    setTheme(extension) {
      view.dispatch({ effects: colorTheme.reconfigure(extension ?? defaultTheme) })
    },
  }
}
