# Typeless Web Prototype — Research, Architecture & Roadmap

## 1. Research Summary

### What Is Typeless?

Typeless is an AI-powered voice keyboard developed by **Simply CA LLC**, available on iOS, Android, macOS, and Windows. Launched in late 2025, it replaces the traditional keyboard with a voice-first input system. Rather than a grid of letter keys, Typeless presents a **single large microphone button** surrounded by minimal auxiliary controls.

**Core value proposition:** Speak naturally and get polished, well-formatted text — up to 6x faster than typing.

### How It Works

Typeless installs as a **system keyboard extension** (iOS Custom Keyboard / Android Input Method / macOS Input Source). When activated in any app, the traditional QWERTY layout is replaced with:

1. **A dominant microphone button** — tap to start/stop recording
2. **Minimal auxiliary keys** — @, spacebar, delete, return
3. **Mode switcher** — Dictate / Edit / Translate
4. **Visual recording indicator** — wave animation showing mic status

### Three Core Modes

| Mode | How It Works |
|------|-------------|
| **Dictate** | Speak naturally. AI removes filler words ("um", "uh"), handles self-corrections, converts spoken lists to bullet points, and polishes grammar in real-time. Up to 6-min continuous dictation. |
| **Edit** | Select existing text, then speak changes: "make it more formal", "fix the typo", "swap comma for period". AI interprets intent and applies edits. |
| **Translate** | Hold the mic button and swipe up. Select target language. Speak in any language; output appears in the target language with natural phrasing. Supports 100+ languages with auto-detection. |

### Key Features

- **Filler word removal** — Strips "um", "uh", "you know", etc.
- **Self-correction detection** — If you change your mind mid-sentence, keeps only final intent
- **Context-aware tone** — Adapts formality based on the app (email vs. chat)
- **Universal app compatibility** — Works in WhatsApp, Slack, Mail, Notes, code editors, etc.
- **Personal dictionary** — Add custom words/terms
- **Time-saved tracker** — Shows dictation speed stats and estimated time saved
- **Privacy-first** — Zero data retention, on-device processing, no cloud training

### Pricing

- **Free tier:** 4,000 words/week (~16,000/month)
- **Pro tier:** $12/month (billed annually) — unlimited words + new features

### Competitive Landscape

| App | Differentiator |
|-----|---------------|
| Apple Dictation | Built-in, but no AI cleanup or editing |
| Google Voice Typing | Good accuracy, no edit/translate modes |
| Whisper (OpenAI) | Excellent transcription, no keyboard integration |
| Otter.ai | Meeting transcription focus, not a keyboard replacement |
| **Typeless** | Full keyboard replacement with dictate + edit + translate |

---

## 2. Architecture Plan (Web Prototype)

### Approach

Build a **web-based simulation** of the Typeless keyboard experience within the existing Next.js codebase. This is a **functional prototype** — not a native keyboard extension — designed to validate the UX feel and interaction patterns.

### Route Structure

```
app/typeless/
├── page.tsx              # Entry point with phone frame
└── TYPELESS-PLAN.md      # This document

components/
├── typeless-keyboard.tsx # The core keyboard UI component
└── typeless-view.tsx     # Full-screen app container with text area + keyboard
```

### Component Architecture

```
TypelessPage (app/typeless/page.tsx)
└── TypelessView (components/typeless-view.tsx)
    ├── App Simulator (text area showing "active app")
    │   ├── App switcher (Notes / Email / Chat simulation)
    │   ├── Text display area (editable)
    │   └── Selected text highlight (for Edit mode)
    │
    └── TypelessKeyboard (components/typeless-keyboard.tsx)
        ├── Mode Tabs (Dictate | Edit | Translate)
        ├── Transcript Preview (shows what's being processed)
        ├── Central Mic Button (with wave animation)
        ├── Auxiliary Keys (@ | Space | ⌫ | ⏎)
        ├── Language Selector (Translate mode)
        └── Stats Bar (words dictated, time saved)
```

### Technology Choices

| Concern | Solution |
|---------|----------|
| Speech Recognition | Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) |
| AI Text Cleanup | Client-side regex for filler removal + simulated AI polish |
| Translation | Simulated with preset phrases (real API integration deferred) |
| Animation | CSS keyframes + Tailwind for wave/pulse on mic button |
| State Management | React useState/useReducer (local component state) |
| Styling | Tailwind CSS + existing OKLCH color system |
| UI Components | Existing shadcn/ui components (Button, Badge, Tabs, ScrollArea) |

### Key Interactions

1. **Tap mic → Start recording** — Wave animation begins, transcript appears live
2. **Tap mic again → Stop** — AI "polishes" the text, inserts into text area
3. **Swipe up on mic (or button) → Translate mode** — Language picker appears
4. **Select text + tap edit → Edit mode** — Speak changes, AI applies them
5. **Mode tabs** — Switch between Dictate/Edit/Translate explicitly

### State Model

```typescript
interface TypelessState {
  mode: 'dictate' | 'edit' | 'translate'
  isRecording: boolean
  rawTranscript: string        // Live speech-to-text
  polishedText: string         // AI-cleaned output
  documentText: string         // The "app" text content
  selectedText: string         // For edit mode
  selectionRange: [number, number] | null
  targetLanguage: string       // For translate mode
  stats: {
    wordsToday: number
    timeSavedSeconds: number
    sessionsToday: number
  }
}
```

---

## 3. Roadmap

### Phase 1: Core Prototype (Current Sprint)
- [x] Research & documentation
- [ ] Phone-frame container with app simulator
- [ ] Typeless keyboard component with mic button
- [ ] Web Speech API integration (Dictate mode)
- [ ] Filler word removal & basic text polish
- [ ] Wave animation on recording
- [ ] Mode tabs (Dictate/Edit/Translate)
- [ ] Basic stats tracking

### Phase 2: Edit & Translate Modes
- [ ] Text selection in the app simulator
- [ ] Edit mode — speak to modify selected text
- [ ] Translate mode — language picker + simulated translation
- [ ] Context-aware tone hints (formal/casual)

### Phase 3: Polish & Features
- [ ] Personal dictionary management
- [ ] Time-saved analytics dashboard
- [ ] Dark/light theme support
- [ ] Onboarding flow (like Typeless setup wizard)
- [ ] Sound effects and haptic simulation

### Phase 4: Real AI Integration
- [ ] LLM API for genuine text polishing (OpenAI/Anthropic)
- [ ] Real translation API (Google Translate / DeepL)
- [ ] Streaming transcription with Whisper API
- [ ] Voice profile calibration

---

## 4. Potential Difficulties & Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Web Speech API browser support** | High | Only Chrome/Edge/Safari have reliable support. Show fallback message for Firefox. |
| **Microphone permissions** | Medium | Clear permission prompts. Graceful degradation if denied. |
| **Speech-to-text accuracy** | Medium | Web Speech API is less accurate than Whisper. Accept limitations in prototype. |
| **Filler word removal quality** | Low | Regex-based approach works for common fillers. AI polish is simulated. |
| **No real translation** | Low | Prototype uses simulated translations. Real API deferred to Phase 4. |
| **Mobile web vs native feel** | High | CSS animations, touch events, and careful sizing can approximate native feel but won't be identical. |
| **Edit mode complexity** | Medium | Text selection + speech-based editing is complex. Start with simple replace-selection. |
| **Continuous dictation limits** | Medium | Web Speech API may timeout. Implement auto-restart logic. |

---

## 5. Sources

- [Typeless Official Site](https://www.typeless.com/)
- [App Store - Typeless AI Voice Keyboard](https://apps.apple.com/us/app/typeless-ai-voice-keyboard/id6749257650)
- [Google Play - Typeless](https://play.google.com/store/apps/details?id=com.typeless.mobile)
- [Product Hunt - Typeless](https://www.producthunt.com/products/typeless-2)
- [SuperGok - Typeless for iOS Review](https://supergok.com/typeless-for-ios-ai-voice-keyboard/)
- [MakeUseOf - Android Voice Keyboard Review](https://www.makeuseof.com/typeless-ai-voice-typing-android/)
- [TechCrunch - Best AI Dictation Apps 2025](https://techcrunch.com/2025/12/30/the-best-ai-powered-dictation-apps-of-2025/)
- [FunBlocks AI - Typeless iOS Review](https://www.funblocks.net/aitools/reviews/typeless-for-ios)
- [Apiyi - Typeless Beginner Guide](https://help.apiyi.com/en/typeless-voice-dictation-beginner-guide-en.html)
- [Computerworld - Android Voice Typing Supertool](https://www.computerworld.com/article/4122901/android-voice-typing-supertool.html)
