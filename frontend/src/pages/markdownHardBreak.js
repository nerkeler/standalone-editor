import HardBreak from '@tiptap/extension-hard-break'

// markdownToHtml marks a <br> that was followed by a source newline. The
// attribute survives the editor model and the serializer restores the newline.
export const MarkdownHardBreak = HardBreak.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownNewline: {
        default: null,
        parseHTML: element => element.getAttribute('data-md-newline'),
        renderHTML: attributes => (attributes.markdownNewline ? { 'data-md-newline': attributes.markdownNewline } : {}),
      },
    }
  },
})
