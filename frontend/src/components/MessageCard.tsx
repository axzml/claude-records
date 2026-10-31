import { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { api } from '../utils/api'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { Message } from '../types'

const ROLE_LABEL = {
  user: 'roleUser',
  assistant: 'roleAssistant',
  system: 'roleSystem',
  progress: 'roleProgress',
} as const

const MAX_COLLAPSED_LENGTH = 5000

interface ImageData {
  media_type: string
  data: string
}

interface Props {
  message: Message
  isVisible: boolean
  /** 1-based position among the session's prompts (user messages only) */
  promptIndex?: number
}

function openImageInNewTab(mediaType: string, base64Data: string, index: number) {
  const w = window.open('', '_blank')
  if (!w) return
  const img = w.document.createElement('img')
  img.src = `data:${mediaType};base64,${base64Data}`
  img.style.maxWidth = '100%'
  w.document.title = `Image ${index + 1}`
  w.document.body.style.margin = '0'
  w.document.body.style.display = 'flex'
  w.document.body.style.justifyContent = 'center'
  w.document.body.style.background = '#1a1a1a'
  w.document.body.appendChild(img)
}

export function MessageCard({ message, isVisible, promptIndex }: Props) {
  const { t, locale } = useI18n()
  const [starred, setStarred] = useState(!!message.starred)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const roleLabel = t[ROLE_LABEL[message.type] || 'roleSystem']
  const isLong = (message.content?.length || 0) > MAX_COLLAPSED_LENGTH
  const rawContent = message.content
    ?.replace(/<\/?local-command-stdout>/g, '')
    .replace(/<\/?local-command-caveat>/g, '')
  const displayContent = isLong && !expanded
    ? rawContent.slice(0, MAX_COLLAPSED_LENGTH)
    : rawContent

  const images = useMemo<ImageData[]>(() => {
    if (!message.images) return []
    try {
      return JSON.parse(message.images)
    } catch {
      return []
    }
  }, [message.images])

  const wordCount = useMemo(() => {
    if (!message.content || message.content_type === 'tool_use') return null
    let text = message.content
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    text = text.replace(/<[^>]+>/g, '')
    text = text.replace(/[*_~`#>|=\-]+/g, ' ')
    const chinese = (text.match(/[一-鿿]/g) || []).length
    const english = (text.match(/[a-zA-Z]+|[0-9]+/g) || []).length
    return chinese + english
  }, [message.content, message.content_type])

  // Completely hide: filtered-out messages, empty content (unless has images)
  if (!isVisible) return null
  if ((!message.content || !message.content.trim()) && images.length === 0) return null

  const handleStar = async () => {
    const result = await api.toggleStar(message.id)
    setStarred(result.starred)
  }

  const handleCopy = async () => {
    if (!message.content) return
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = message.content
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const formatTime = (ts: string) => {
    const d = new Date(ts)
    return d.toLocaleString(locale, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const markdownComponents = useMemo(() => ({
    img: ({ src, alt, ...rest }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      if (src && !src.startsWith('/api/') && /^([a-zA-Z]:[/\\]|\/)/.test(src)) {
        const proxyUrl = `/api/file/image?path=${encodeURIComponent(src)}`
        return <img src={proxyUrl} alt={alt || ''} className="message-image" loading="lazy"
          onClick={() => window.open(proxyUrl, '_blank')} {...rest} />
      }
      const imgSrc = src || ''
      return <img src={src} alt={alt || ''} className="message-image" loading="lazy"
        onClick={() => imgSrc && window.open(imgSrc, '_blank')} {...rest} />
    },
  }), [])

  return (
    <article className={`message message-${message.type}${message.content_type === 'thinking' ? ' message-thinking' : ''}`}>
      <div className="message-header">
        {(message.type === 'user' || message.type === 'assistant') && (
          <span className="message-avatar">
            {message.type === 'user' ? roleLabel.slice(0, 1) : <Icon name="sparkle" size={13} />}
          </span>
        )}
        <span className="message-role">{roleLabel}</span>
        {promptIndex !== undefined && (
          <span className="message-index">#{promptIndex}</span>
        )}
        {message.content_type === 'thinking' && <span className="message-tag">{t.thinking}</span>}
        {message.model && <span className="message-meta">{message.model}</span>}
        <span className="message-meta">{formatTime(message.timestamp)}</span>
        {wordCount !== null && (
          <span className="message-meta">{t.wordCount(wordCount.toLocaleString(locale))}</span>
        )}
        {images.length > 0 && (
          <span className="message-meta message-meta-icon"><Icon name="image" size={13} />{images.length}</span>
        )}
        <span className="message-actions">
          <button className="row-action" onClick={handleCopy} title={copied ? t.copied : t.copyContent}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </button>
          <button className={`row-action${starred ? ' starred' : ''}`} onClick={handleStar} title={starred ? t.unstar : t.star}>
            <Icon name="star" size={14} filled={starred} />
          </button>
        </span>
      </div>
      <div className="message-content">
        {message.content_type === 'tool_use' ? (
          <pre className="tool-use-content">{message.content}</pre>
        ) : (
          <ReactMarkdown rehypePlugins={[rehypeHighlight, [rehypeKatex, { strict: false }]]} remarkPlugins={[remarkBreaks, remarkMath, remarkGfm]} components={markdownComponents}>
            {displayContent || ''}
          </ReactMarkdown>
        )}
        {images.length > 0 && (
          <div className="message-images">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.media_type};base64,${img.data}`}
                alt={`image-${i + 1}`}
                className="message-image"
                loading="lazy"
                onClick={() => openImageInNewTab(img.media_type, img.data, i)}
              />
            ))}
          </div>
        )}
        {isLong && !expanded && (
          <button className="expand-button" onClick={() => setExpanded(true)}>
            {t.expandAll}<Icon name="chevronDown" size={14} />
          </button>
        )}
      </div>
    </article>
  )
}
