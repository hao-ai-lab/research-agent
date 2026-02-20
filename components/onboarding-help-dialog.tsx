'use client'

import { useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
    MessageSquare,
    LayoutDashboard,
    BarChart3,
    Terminal,
    Lightbulb,
    Sparkles,
} from 'lucide-react'

const HELP_TOPICS = [
    {
        id: 'chat',
        icon: MessageSquare,
        title: 'Chat & Sessions',
        content: (
            <div className="space-y-4">
                <p>The Chat is your primary interface for interacting with the Research Agent.</p>
                <ul className="list-disc pl-5 space-y-2">
                    <li><strong>New Chat:</strong> Start a fresh session to isolate context.</li>
                    <li><strong>References (@):</strong> Type <kbd>@</kbd> in the chat to seamlessly reference past runs, sweeps, or other chat sessions.</li>
                    <li><strong>Agent vs Wild Mode:</strong> Toggle modes. Agent mode runs a single iteration; Wild mode runs autonomously until a goal is reached.</li>
                </ul>
            </div>
        ),
    },
    {
        id: 'runs',
        icon: LayoutDashboard,
        title: 'Experiment Runs',
        content: (
            <div className="space-y-4">
                <p>Manage and monitor your machine learning experiments.</p>
                <ul className="list-disc pl-5 space-y-2">
                    <li><strong>Live Tracking:</strong> View real-time logs, metrics, and statuses of your active experiments.</li>
                    <li><strong>Sweeps:</strong> Group multiple runs under a unified hyperparameter sweep configuration.</li>
                    <li><strong>Actions:</strong> Clone, restart, or terminate runs directly from the dashboard.</li>
                </ul>
            </div>
        ),
    },
    {
        id: 'charts',
        icon: BarChart3,
        title: 'Charts & Metrics',
        content: (
            <div className="space-y-4">
                <p>Visualize the performance of your models.</p>
                <ul className="list-disc pl-5 space-y-2">
                    <li><strong>Custom Charts:</strong> Pin your most important metrics to the overview dashboard.</li>
                    <li><strong>Comparisons:</strong> Overlay metrics from multiple runs to identify the best configurations.</li>
                </ul>
            </div>
        ),
    },
    {
        id: 'insights',
        icon: Lightbulb,
        title: 'Insights & Memory',
        content: (
            <div className="space-y-4">
                <p>The system learns from past experiments to give you better advice.</p>
                <ul className="list-disc pl-5 space-y-2">
                    <li><strong>Heuristics:</strong> Discovered rules and best practices are stored here.</li>
                    <li><strong>Contextual Awareness:</strong> These insights are automatically retrieved when you ask related questions in Chat.</li>
                </ul>
            </div>
        ),
    },
    {
        id: 'terminal',
        icon: Terminal,
        title: 'Terminal Integration',
        content: (
            <div className="space-y-4">
                <p>A built-in terminal for running custom scripts or managing the environment.</p>
                <p>The assistant can also read terminal outputs to help debug issues if you ask it to.</p>
            </div>
        ),
    },
    {
        id: 'journey',
        icon: Sparkles,
        title: 'Our Journey',
        content: (
            <div className="space-y-4">
                <p>A high-level overview of your research progress and milestone achievements.</p>
                <p>You can use this to quickly catch up on where the project stands and what was tried recently.</p>
            </div>
        ),
    },
]

interface OnboardingHelpDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
}

export function OnboardingHelpDialog({ open, onOpenChange }: OnboardingHelpDialogProps) {
    const [activeTopicId, setActiveTopicId] = useState(HELP_TOPICS[0].id)

    const activeTopic = HELP_TOPICS.find((t) => t.id === activeTopicId)

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-4xl p-0 h-[80vh] flex flex-col overflow-hidden gap-0">
                <DialogHeader className="px-6 py-4 border-b border-border/60 shrink-0">
                    <DialogTitle className="text-xl">Help & Documentation</DialogTitle>
                    <DialogDescription>
                        Learn how to use the Research Agent functionalities.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-1 min-h-0 bg-background">
                    {/* Left Panel: Navigation */}
                    <div className="w-64 border-r border-border/60 bg-muted/20 shrink-0 flex flex-col">
                        <ScrollArea className="flex-1">
                            <div className="p-4 space-y-1">
                                {HELP_TOPICS.map((topic) => {
                                    const Icon = topic.icon
                                    const isActive = activeTopicId === topic.id
                                    return (
                                        <button
                                            key={topic.id}
                                            onClick={() => setActiveTopicId(topic.id)}
                                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors text-left ${isActive
                                                    ? 'bg-primary/10 text-primary font-medium'
                                                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                                                }`}
                                        >
                                            <Icon className="h-4 w-4 shrink-0" />
                                            <span className="truncate">{topic.title}</span>
                                        </button>
                                    )
                                })}
                            </div>
                        </ScrollArea>
                    </div>

                    {/* Right Panel: Content */}
                    <div className="flex-1 flex flex-col min-w-0 bg-card">
                        <ScrollArea className="flex-1">
                            <div className="p-8">
                                {activeTopic ? (
                                    <div className="max-w-2xl">
                                        <div className="flex items-center gap-3 mb-6 pb-4 border-b border-border/40">
                                            <div className="p-2 bg-primary/10 rounded-md text-primary shrink-0">
                                                <activeTopic.icon className="h-6 w-6" />
                                            </div>
                                            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                                                {activeTopic.title}
                                            </h2>
                                        </div>
                                        <div className="text-muted-foreground leading-relaxed">
                                            {activeTopic.content}
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        </ScrollArea>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
