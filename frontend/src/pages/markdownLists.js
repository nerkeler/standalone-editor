import BulletList from '@tiptap/extension-bullet-list'
import OrderedList from '@tiptap/extension-ordered-list'

// The codec annotates each list with its source spacing (`data-md-loose`) so a
// tight list stays tight and a loose list keeps its blank lines after editing.
// ProseMirror drops unknown attributes, so the list nodes opt in explicitly.
const markdownLooseAttribute = {
  markdownLoose: {
    default: null,
    parseHTML: element => element.getAttribute('data-md-loose'),
    renderHTML: attributes => (attributes.markdownLoose ? { 'data-md-loose': attributes.markdownLoose } : {}),
  },
}

export const MarkdownBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...markdownLooseAttribute }
  },
})

export const MarkdownOrderedList = OrderedList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...markdownLooseAttribute }
  },
})
