'use client'

import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import Prism from 'prismjs'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-docker'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-markup'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-yaml'
import { Button } from '@/components/ui/button'

interface CodeOutputBoxProps {
  code: string
  language?: string
}

function normalizeLanguageLabel(language?: string): string {
  const trimmed = (language || '').trim().toLowerCase()
  if (!trimmed) return 'code'
  if (trimmed === 'js') return 'javascript'
  if (trimmed === 'ts') return 'typescript'
  if (trimmed === 'py') return 'python'
  if (trimmed === 'sh') return 'bash'
  return trimmed
}

function normalizePrismLanguage(language: string): string {
  if (language === 'html' || language === 'xml') return 'markup'
  if (language === 'shell' || language === 'zsh' || language === 'sh') return 'bash'
  if (language === 'yml') return 'yaml'
  if (language === 'md') return 'markdown'
  if (language === 'tsx') return 'tsx'
  if (language === 'jsx') return 'jsx'
  if (language === 'frontend') return 'tsx'
  if (language === 'backend') return 'python'
  return language
}

export function CodeOutputBox({ code, language }: CodeOutputBoxProps) {
  const [copied, setCopied] = useState(false)
  const languageLabel = normalizeLanguageLabel(language)
  const prismLanguage = normalizePrismLanguage(languageLabel)
  const highlightedCode = useMemo(() => {
    const grammar = Prism.languages[prismLanguage]
    if (!grammar) return null
    try {
      return Prism.highlight(code, grammar, prismLanguage)
    } catch {
      return null
    }
  }, [code, prismLanguage])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch (error) {
      console.error('Failed to copy code block:', error)
    }
  }

  return (
    <div className="my-2 inline-flex max-w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-secondary/45 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <span className="text-xs lowercase tracking-wide text-muted-foreground">{languageLabel}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={handleCopy}
          aria-label={copied ? 'Code copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied ? 'Copied' : 'Copy code'}</span>
        </Button>
      </div>
      <div className="max-w-full overflow-hidden">
        <pre className="code-output-box m-0 w-full whitespace-pre-wrap break-words p-3 font-mono text-sm leading-relaxed [overflow-wrap:anywhere]">
          <code
            className={`language-${prismLanguage}`}
            dangerouslySetInnerHTML={highlightedCode ? { __html: highlightedCode } : undefined}
          >
            {!highlightedCode ? code : undefined}
          </code>
        </pre>
      </div>
    </div>
  )
}
