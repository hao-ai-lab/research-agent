'use client'

import React from 'react'
import { useState, useRef } from 'react'
import {
  Send,
  Plus,
  X,
  Paperclip,
  ImageIcon,
  FileText,
  Zap,
  Bug,
  Type,
  Smile,
  AtSign,
  Command,
  Mic,
  MicOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export type ChatMode = 'wild' | 'debug'

interface ChatInputProps {
  onSend: (message: string, attachments?: File[], mode?: ChatMode) => void
  disabled?: boolean
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
}

export function ChatInput({
  onSend,
  disabled,
  mode,
  onModeChange,
}: ChatInputProps) {
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [isAttachOpen, setIsAttachOpen] = useState(false)
  const [isModeOpen, setIsModeOpen] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isFormatOpen, setIsFormatOpen] = useState(false)
  const [isEmojiOpen, setIsEmojiOpen] = useState(false)
  const [isMentionOpen, setIsMentionOpen] = useState(false)
  const [isCommandOpen, setIsCommandOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = () => {
    if (message.trim() || attachments.length > 0) {
      onSend(message, attachments, mode)
      setMessage('')
      setAttachments([])
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachments((prev) => [...prev, ...Array.from(e.target.files!)])
    }
    setIsAttachOpen(false)
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  const toggleRecording = () => {
    setIsRecording(!isRecording)
    // In a real app, this would start/stop audio recording
  }

  const insertText = (text: string) => {
    setMessage((prev) => prev + text)
    textareaRef.current?.focus()
  }

  return (
    <div className="border-t border-border bg-background px-4 pb-6 pt-3">
      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {attachments.map((file, index) => (
            <div
              key={index}
              className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5 text-xs"
            >
              <FileText className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[100px] truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(index)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Status bar - top row */}
      <div className="mb-2 flex items-center gap-2 rounded-xl bg-secondary/50 px-3 py-2">
        <Popover open={isModeOpen} onOpenChange={setIsModeOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors ${
                mode === 'wild'
                  ? 'bg-accent/20 text-accent'
                  : 'bg-blue-500/20 text-blue-400'
              }`}
            >
              {mode === 'wild' ? (
                <Zap className="h-3 w-3" />
              ) : (
                <Bug className="h-3 w-3" />
              )}
              {mode === 'wild' ? 'Wild Mode' : 'Debug Mode'}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-64 p-2">
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => {
                  onModeChange('wild')
                  setIsModeOpen(false)
                }}
                className={`flex items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors ${
                  mode === 'wild'
                    ? 'bg-accent/10 border border-accent/30'
                    : 'hover:bg-secondary'
                }`}
              >
                <Zap
                  className={`h-5 w-5 mt-0.5 shrink-0 ${mode === 'wild' ? 'text-accent' : 'text-muted-foreground'}`}
                />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Wild Mode
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Agent autonomously launches experiments
                  </p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  onModeChange('debug')
                  setIsModeOpen(false)
                }}
                className={`flex items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors ${
                  mode === 'debug'
                    ? 'bg-blue-400/10 border border-blue-400/30'
                    : 'hover:bg-secondary'
                }`}
              >
                <Bug
                  className={`h-5 w-5 mt-0.5 shrink-0 ${mode === 'debug' ? 'text-blue-400' : 'text-muted-foreground'}`}
                />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Debug Mode
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Careful job launching, detailed messages
                  </p>
                </div>
              </button>
            </div>
          </PopoverContent>
        </Popover>

        {isRecording && (
          <span className="flex items-center gap-1.5 text-xs text-destructive animate-pulse">
            <span className="h-2 w-2 rounded-full bg-destructive" />
            Recording...
          </span>
        )}
      </div>

      {/* Text input - middle section */}
      <div className="relative mb-2">
        <div className="absolute left-3 top-3 w-0.5 h-5 bg-accent rounded-full" />
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder="Message Research Assistant..."
          disabled={disabled}
          rows={1}
          className="w-full resize-none rounded-xl border border-border bg-card pl-6 pr-4 py-3 text-base text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          style={{ minHeight: '48px', maxHeight: '120px' }}
        />
      </div>

      {/* Action buttons - bottom row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {/* Add attachment */}
          <Popover open={isAttachOpen} onOpenChange={setIsAttachOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-full"
              >
                <Plus className="h-5 w-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-48 p-2">
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <Paperclip className="h-4 w-4" />
                  <span>Upload file</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <ImageIcon className="h-4 w-4" />
                  <span>Upload image</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Format text */}
          <Popover open={isFormatOpen} onOpenChange={setIsFormatOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-full"
              >
                <Type className="h-5 w-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-48 p-2">
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => {
                    insertText('**bold**')
                    setIsFormatOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="font-bold">B</span>
                  <span>Bold</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('*italic*')
                    setIsFormatOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="italic">I</span>
                  <span>Italic</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('`code`')
                    setIsFormatOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="font-mono text-xs">{'<>'}</span>
                  <span>Code</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Emoji picker */}
          <Popover open={isEmojiOpen} onOpenChange={setIsEmojiOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-full"
              >
                <Smile className="h-5 w-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-64 p-3">
              <p className="text-xs text-muted-foreground mb-2">Quick reactions</p>
              <div className="grid grid-cols-8 gap-1">
                {['😀', '👍', '❤️', '🎉', '🚀', '💡', '⚡', '✅', '❌', '🔥', '💪', '🙏', '👀', '🤔', '😅', '😊'].map(
                  (emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        insertText(emoji)
                        setIsEmojiOpen(false)
                      }}
                      className="h-8 w-8 rounded hover:bg-secondary text-lg flex items-center justify-center"
                    >
                      {emoji}
                    </button>
                  )
                )}
              </div>
            </PopoverContent>
          </Popover>

          {/* Mention */}
          <Popover open={isMentionOpen} onOpenChange={setIsMentionOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-full"
              >
                <AtSign className="h-5 w-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-48 p-2">
              <p className="text-xs text-muted-foreground mb-2 px-2">Mention a run</p>
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => {
                    insertText('@run:gpt-4-finetune ')
                    setIsMentionOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="h-2 w-2 rounded-full bg-accent" />
                  <span>GPT-4 Fine-tune</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('@run:bert-classifier ')
                    setIsMentionOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="h-2 w-2 rounded-full bg-blue-400" />
                  <span>BERT Classifier</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Commands */}
          <Popover open={isCommandOpen} onOpenChange={setIsCommandOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-full"
              >
                <Command className="h-5 w-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-56 p-2">
              <p className="text-xs text-muted-foreground mb-2 px-2">Quick commands</p>
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => {
                    insertText('/launch ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/launch</span>
                  <span className="text-muted-foreground text-xs">Start a new run</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('/analyze ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/analyze</span>
                  <span className="text-muted-foreground text-xs">Analyze results</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('/compare ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/compare</span>
                  <span className="text-muted-foreground text-xs">Compare runs</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Microphone */}
          <Button
            variant="ghost"
            size="icon"
            className={`h-10 w-10 rounded-full ${isRecording ? 'text-destructive bg-destructive/10' : ''}`}
            onClick={toggleRecording}
          >
            {isRecording ? (
              <MicOff className="h-5 w-5" />
            ) : (
              <Mic className="h-5 w-5" />
            )}
          </Button>
        </div>

        {/* Send button */}
        <Button
          onClick={handleSubmit}
          disabled={disabled || (!message.trim() && attachments.length === 0)}
          size="icon"
          className="h-10 w-10 rounded-full bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
        >
          <Send className="h-5 w-5" />
          <span className="sr-only">Send message</span>
        </Button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>
  )
}
