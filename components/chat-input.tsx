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
  AtSign,
  Command,
  Mic,
  MicOff,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export type ChatMode = 'wild' | 'debug' | 'sweep'

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

  // Removed format/emoji popovers for compact design - using insertText for @ mentions and commands

  return (
    <div className="border-t border-border bg-background px-3 pb-3 pt-2">
      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((file, index) => (
            <div
              key={index}
              className="flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs"
            >
              <FileText className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[80px] truncate">{file.name}</span>
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

      {/* Text input */}
      <div className="relative mb-1.5">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder="Message Research Assistant..."
          disabled={disabled}
          rows={1}
          className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          style={{ minHeight: '40px', maxHeight: '100px' }}
        />
      </div>

      {/* Action buttons - bottom row */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-0.5">
          {/* Mode toggle */}
          <Popover open={isModeOpen} onOpenChange={setIsModeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                  mode === 'wild'
                    ? 'bg-accent/20 text-accent'
                    : mode === 'debug'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-purple-500/20 text-purple-400'
                }`}
              >
                {mode === 'wild' ? (
                  <Zap className="h-3 w-3" />
                ) : mode === 'debug' ? (
                  <Bug className="h-3 w-3" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {mode === 'wild' ? 'Wild' : mode === 'debug' ? 'Debug' : 'Sweep'}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-56 p-1.5">
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    onModeChange('wild')
                    setIsModeOpen(false)
                  }}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    mode === 'wild'
                      ? 'bg-accent/10 border border-accent/30'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <Zap
                    className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'wild' ? 'text-accent' : 'text-muted-foreground'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-foreground">Wild Mode</p>
                    <p className="text-[10px] text-muted-foreground">Auto-launch experiments</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onModeChange('debug')
                    setIsModeOpen(false)
                  }}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    mode === 'debug'
                      ? 'bg-blue-400/10 border border-blue-400/30'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <Bug
                    className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'debug' ? 'text-blue-400' : 'text-muted-foreground'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-foreground">Debug Mode</p>
                    <p className="text-[10px] text-muted-foreground">Careful, detailed</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onModeChange('sweep')
                    setIsModeOpen(false)
                  }}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    mode === 'sweep'
                      ? 'bg-purple-400/10 border border-purple-400/30'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <Sparkles
                    className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'sweep' ? 'text-purple-400' : 'text-muted-foreground'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-foreground">Sweep Mode</p>
                    <p className="text-[10px] text-muted-foreground">Create experiment sweeps</p>
                  </div>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {isRecording && (
            <span className="flex items-center gap-1 text-[10px] text-destructive animate-pulse ml-1">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              Rec
            </span>
          )}
          {/* Add attachment */}
          <Popover open={isAttachOpen} onOpenChange={setIsAttachOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Plus className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-40 p-1.5">
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  <span>Upload file</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  <span>Upload image</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Mention */}
          <Popover open={isMentionOpen} onOpenChange={setIsMentionOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <AtSign className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-44 p-1.5">
              <p className="text-[10px] text-muted-foreground mb-1.5 px-2">Mention a run</p>
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    insertText('@run:gpt-4-finetune ')
                    setIsMentionOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span>GPT-4 Fine-tune</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('@run:bert-classifier ')
                    setIsMentionOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                  <span>BERT Classifier</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Commands */}
          <Popover open={isCommandOpen} onOpenChange={setIsCommandOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Command className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-48 p-1.5">
              <p className="text-[10px] text-muted-foreground mb-1.5 px-2">Quick commands</p>
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    insertText('/launch ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/launch</span>
                  <span className="text-muted-foreground text-[10px]">New run</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('/analyze ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/analyze</span>
                  <span className="text-muted-foreground text-[10px]">Analyze</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('/compare ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/compare</span>
                  <span className="text-muted-foreground text-[10px]">Compare</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('/sweep ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="text-purple-400">/sweep</span>
                  <span className="text-muted-foreground text-[10px]">Create sweep</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Microphone */}
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${isRecording ? 'text-destructive bg-destructive/10' : ''}`}
            onClick={toggleRecording}
          >
            {isRecording ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* Send button */}
        <Button
          onClick={handleSubmit}
          disabled={disabled || (!message.trim() && attachments.length === 0)}
          size="icon"
          className="h-7 w-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30"
        >
          <Send className="h-3.5 w-3.5" />
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
