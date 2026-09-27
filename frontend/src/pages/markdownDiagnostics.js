import { marked } from 'marked'

const MESSAGES = {
  frontMatter: 'YAML 元数据不能无损进入富文本；请在源码模式编辑。',
  wikiLinks: 'WikiLink 目标和别名可能被改写；请保留源码。',
  footnotes: '脚注引用和定义暂不支持富文本往返；请保留源码。',
  referenceLinks: '引用式链接会改变源文件写法；请保留源码。',
  escapedSyntax: '转义符可能丢失；请保留源码。',
  tableAlignment: '表格列对齐信息可能丢失；请保留源码。',
  nestedLists: '嵌套列表的缩进可能改变；请保留源码。',
  rawHtml: '原始 HTML 可能被过滤或重排；请保留源码。',
  codeFenceMetadata: '代码围栏附加信息可能丢失；请保留源码。',
  unparseableMarkdown: 'Markdown 无法解析；请保留源码并检查内容。',
}

export function analyzeMarkdownSource(markdown) {
  const source = String(markdown || '')
  const items = []
  const add = (reason, from, to) => {
    if (to > from && !items.some(item => item.reason === reason && item.from === from)) {
      items.push({ reason, from, to, message: MESSAGES[reason] })
    }
  }
  const front = source.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  if (front) add('frontMatter', 0, front[0].length)
  try { marked.lexer(source) } catch {
    add('unparseableMarkdown', 0, Math.max(1, source.length))
    return items
  }
  let offset = 0
  let fence = null
  let fenceStart = -1
  const fencedRanges = []
  let listIndent = null
  for (const line of source.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue
    const raw = line.replace(/\r?\n$/, '')
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fencedRanges.push([fenceStart, offset + line.length])
        fence = null
      }
      offset += line.length
      continue
    }
    if (marker) {
      const info = marker[2].trim()
      if (info && !/^[\w.+#-]+$/.test(info)) add('codeFenceMetadata', offset + raw.indexOf(info), offset + raw.length)
      fence = marker[1]
      fenceStart = offset
      offset += line.length
      continue
    }
    if (offset < (front?.[0].length || 0)) { offset += line.length; continue }
    const list = raw.match(/^(\s*)(?:[-+*]|\d+[.)])\s/)
    if (list) {
      if (listIndent !== null && list[1].length > listIndent) add('nestedLists', offset + list[1].length, offset + raw.length)
      if (listIndent === null || list[1].length < listIndent) listIndent = list[1].length
    } else if (raw.trim() && !/^\s/.test(raw)) listIndent = null
    if (/^\s*\|?\s*:?-{3,}:?\s*\|/.test(raw) && /:/.test(raw)) add('tableAlignment', offset, offset + raw.length)
    const code = [...raw.matchAll(/(`+)(.*?)\1/g)].map(match => [match.index, match.index + match[0].length])
    const scan = (reason, regex) => {
      for (const match of raw.matchAll(regex)) {
        if (!code.some(([start, end]) => match.index >= start && match.index < end)) {
          add(reason, offset + match.index, offset + match.index + match[0].length)
        }
      }
    }
    scan('wikiLinks', /!?\[\[[^\]\n]+\]\]/g)
    scan('footnotes', /\[\^[^\]\n]+\]/g)
    scan('referenceLinks', /\[(?!\^)[^\]\n]+\]\[[^\]\n]+\]|^\s{0,3}\[(?!\^)[^\]\n]+\]:\s*\S+/g)
    scan('escapedSyntax', /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g)
    scan('rawHtml', /<!--(?!(?:[ \t]*zoom:\d+[ \t]*-->|[ \t]*se-image:width=(?:2[5-9]|[3-9]\d|100);align=(?:left|center)[ \t]*-->)).*?-->|<\/?[A-Za-z][^>]*>/g)
    offset += line.length
  }
  if (fence) fencedRanges.push([fenceStart, source.length])
  const inFence = index => fencedRanges.some(([start, end]) => index >= start && index < end)
  for (const match of source.matchAll(/<!--[\s\S]*?-->/g)) {
    if (inFence(match.index) || match.index < (front?.[0].length || 0)) continue
    if (/^<!--[ \t]*zoom:\d+[ \t]*-->$/.test(match[0])) continue
    if (/^<!--[ \t]*se-image:width=(?:2[5-9]|[3-9]\d|100);align=(?:left|center)[ \t]*-->$/.test(match[0])) continue
    add('rawHtml', match.index, match.index + match[0].length)
  }
  return items.sort((a, b) => a.from - b.from || a.to - b.to)
}
