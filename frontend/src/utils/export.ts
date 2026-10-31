import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import { currentLocale, currentMessages } from '../i18n'
import type { Message } from '../types'

function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return text.replace(/[&<>"']/g, c => entities[c])
}

export interface SessionMeta {
  projectName: string
  sessionName: string | null
  path: string
  date: string
  messageCount: number
}

/**
 * 找到每个 turn 中最后一条 assistant text 消息的 uuid。
 * 复用 MessageList.tsx 中的 findLastAssistantPerTurn 逻辑。
 */
function findLastAssistantPerTurn(msgs: Message[]): Set<string> {
  const keep = new Set<string>()
  let lastAssistantUuid: string | null = null

  for (const msg of msgs) {
    if (msg.type === 'user' && msg.content?.trim()) {
      if (lastAssistantUuid) keep.add(lastAssistantUuid)
      lastAssistantUuid = null
    } else if (
      msg.type === 'assistant' &&
      msg.content_type === 'text' &&
      msg.content?.trim()
    ) {
      lastAssistantUuid = msg.uuid
    }
  }
  if (lastAssistantUuid) keep.add(lastAssistantUuid)
  return keep
}

/**
 * 过滤消息：仅保留用户提问和 assistant 最终回复。
 */
export function filterForExport(messages: Message[]): Message[] {
  const lastAssistantUuids = findLastAssistantPerTurn(messages)

  return messages.filter(msg => {
    const hasContent = msg.content && msg.content.trim()
    const hasImages = !!msg.images
    if (!hasContent && !hasImages) return false

    if (msg.type === 'user') return true
    if (msg.type === 'assistant') {
      if (msg.content_type !== 'text') return false
      return lastAssistantUuids.has(msg.uuid)
    }
    return false
  })
}

/**
 * 清理消息内容：去除内部标签。
 */
export function cleanContent(content: string): string {
  return content
    .replace(/<\/?local-command-stdout>/g, '')
    .replace(/<\/?local-command-caveat>/g, '')
}

/**
 * 生成文件名：{projectName}_{YYYYmmDDHHMMSS}.{ext}
 */
export function buildFilename(projectName: string, ext: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

  const safeName = projectName.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '-')
  return `${safeName}_${timestamp}.${ext}`
}

/**
 * 触发浏览器下载。
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * 格式化时间为简短显示。
 */
function formatTime(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleString(currentLocale(), {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/**
 * 将过滤后的消息生成 Markdown 文档。
 */
export function toMarkdown(messages: Message[], meta: SessionMeta): string {
  const title = meta.sessionName
    ? `${meta.projectName} / ${meta.sessionName}`
    : meta.projectName

  const t = currentMessages()
  let md = `# ${title}\n\n`
  md += `> ${meta.path} · ${meta.date} · ${t.messageCount(meta.messageCount)}\n\n`
  md += `---\n\n`

  for (const msg of messages) {
    const content = cleanContent(msg.content || '')
    const time = formatTime(msg.timestamp)
    const header = `## ${msg.type === 'user' ? t.roleUser : t.roleAssistant}`

    md += `${header}\n\n`
    md += `*${time}*\n\n`
    md += `${content}\n\n`

    // 内联 base64 图片
    if (msg.images) {
      try {
        const images = JSON.parse(msg.images)
        for (let i = 0; i < images.length; i++) {
          md += `![image-${i + 1}](data:${images[i].media_type};base64,${images[i].data})\n\n`
        }
      } catch { /* skip malformed images */ }
    }

    md += `---\n\n`
  }

  return md
}

/**
 * HTML 导出的内嵌 CSS 样式。基于 warm-minimal 主题。
 */
const EXPORT_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.7;
    color: #2d2d2d;
    background: #faf9f7;
    padding: 2rem;
    max-width: 900px;
    margin: 0 auto;
  }
  header { margin-bottom: 2rem; border-bottom: 1px solid #e8e4df; padding-bottom: 1rem; }
  header h1 { font-size: 1.5rem; font-weight: 600; color: #1a1a1a; }
  header .meta { font-size: 0.85rem; color: #888; margin-top: 0.5rem; }
  .message { margin-bottom: 1.5rem; padding: 1rem 1.25rem; border-radius: 8px; }
  .message-user { background: #f0f7ff; border-left: 3px solid #4a9eff; }
  .message-assistant { background: #f5f5f0; border-left: 3px solid #7c6f5b; }
  .message-header { font-size: 0.8rem; color: #666; margin-bottom: 0.75rem; font-weight: 500; }
  .message-body { font-size: 0.95rem; }
  .message-body p { margin-bottom: 0.75rem; }
  .message-body pre {
    background: #1e1e1e; color: #d4d4d4; padding: 1rem;
    border-radius: 6px; overflow-x: auto; margin: 0.75rem 0;
    font-size: 0.85rem; line-height: 1.5;
  }
  .message-body code {
    background: #e8e4df; padding: 0.15rem 0.4rem;
    border-radius: 3px; font-size: 0.85em;
  }
  .message-body pre code { background: none; padding: 0; }
  .message-body img { max-width: 100%; border-radius: 6px; border: 1px solid #e8e4df; margin: 0.5rem 0; }
  .message-body blockquote {
    border-left: 3px solid #e8e4df; padding-left: 1rem;
    color: #666; margin: 0.75rem 0;
  }
  .message-body ul, .message-body ol { padding-left: 1.5rem; margin: 0.5rem 0; }
  .message-body table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
  .message-body th, .message-body td { border: 1px solid #e8e4df; padding: 0.5rem; text-align: left; }
  .message-body th { background: #f5f5f0; }
  @media print {
    body { padding: 0; max-width: none; }
    .message { break-inside: avoid; }
  }
`

/**
 * 配置 marked 使用 highlight.js 进行代码高亮。
 */
function configureMarked(): void {
  marked.use(markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value
      }
      return hljs.highlightAuto(code).value
    }
  }))
}

/**
 * 将过滤后的消息生成自包含 HTML 文档。
 */
export async function toHTML(messages: Message[], meta: SessionMeta): Promise<string> {
  configureMarked()

  const title = escapeHtml(meta.sessionName
    ? `${meta.projectName} / ${meta.sessionName}`
    : meta.projectName)

  const t = currentMessages()
  let messagesHTML = ''

  for (const msg of messages) {
    const content = cleanContent(msg.content || '')
    const time = formatTime(msg.timestamp)
    const typeClass = msg.type === 'user' ? 'message-user' : 'message-assistant'
    const label = msg.type === 'user' ? t.roleUser : t.roleAssistant

    // Transcripts may contain arbitrary HTML (pasted or fetched web content)
    const htmlContent = DOMPurify.sanitize(await marked.parse(content))

    // 处理内联图片
    let imagesHTML = ''
    if (msg.images) {
      try {
        const images = JSON.parse(msg.images)
        for (let i = 0; i < images.length; i++) {
          const src = `data:${images[i].media_type};base64,${images[i].data}`
          imagesHTML += `<img src="${escapeHtml(src)}" alt="image-${i + 1}" />\n`
        }
      } catch { /* skip malformed images */ }
    }

    messagesHTML += `
    <article class="message ${typeClass}">
      <div class="message-header">${label} · ${time}</div>
      <div class="message-body">
        ${htmlContent}
        ${imagesHTML}
      </div>
    </article>\n`
  }

  return `<!DOCTYPE html>
<html lang="${currentLocale() === 'zh-CN' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <title>${title}</title>
  <style>${EXPORT_CSS}</style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <p class="meta">${escapeHtml(meta.path)} · ${escapeHtml(meta.date)} · ${t.messageCount(meta.messageCount)}</p>
  </header>
  <main>
    ${messagesHTML}
  </main>
</body>
</html>`
}
