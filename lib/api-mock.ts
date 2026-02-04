'use client'

// Mock API Implementation for Vercel Deployment
// This module provides demo data when NEXT_PUBLIC_USE_MOCK=true

import type {
    ChatSession,
    SessionWithMessages,
    StreamEvent,
    Run,
    RunStatus,
    CreateRunRequest,
    LogResponse,
    Artifact,
    Sweep,
    CreateSweepRequest,
} from './api'

// Re-export types
export type { ChatSession, SessionWithMessages, StreamEvent, Run, RunStatus, CreateRunRequest, LogResponse, Artifact, Sweep, CreateSweepRequest }
export type { ChatMessageData, StreamEventType } from './api'

// =============================================================================
// Mock Data Store
// =============================================================================

const mockSessions: Map<string, SessionWithMessages> = new Map([
    ['demo-session-1', {
        id: 'demo-session-1',
        title: 'Training MLP on MNIST',
        created_at: Date.now() / 1000 - 3600,
        message_count: 4,
        messages: [
            { role: 'user', content: 'Help me train an MLP on the MNIST dataset', timestamp: Date.now() / 1000 - 3500 },
            { role: 'assistant', content: 'I\'ll help you set up a Multi-Layer Perceptron for MNIST classification. Here\'s a basic PyTorch implementation:\n\n```python\nimport torch\nimport torch.nn as nn\n\nclass MLP(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.layers = nn.Sequential(\n            nn.Flatten(),\n            nn.Linear(784, 256),\n            nn.ReLU(),\n            nn.Linear(256, 10)\n        )\n    \n    def forward(self, x):\n        return self.layers(x)\n```\n\nWould you like me to add training code as well?', timestamp: Date.now() / 1000 - 3400 },
            { role: 'user', content: 'Yes, add the training loop', timestamp: Date.now() / 1000 - 3300 },
            { role: 'assistant', content: 'Here\'s the complete training setup:\n\n```python\nfrom torchvision import datasets, transforms\nfrom torch.utils.data import DataLoader\n\n# Data loading\ntransform = transforms.ToTensor()\ntrain_data = datasets.MNIST(root="data", train=True, download=True, transform=transform)\ntrain_loader = DataLoader(train_data, batch_size=64, shuffle=True)\n\n# Training\nmodel = MLP()\noptimizer = torch.optim.Adam(model.parameters(), lr=0.001)\ncriterion = nn.CrossEntropyLoss()\n\nfor epoch in range(10):\n    for batch, (X, y) in enumerate(train_loader):\n        pred = model(X)\n        loss = criterion(pred, y)\n        \n        optimizer.zero_grad()\n        loss.backward()\n        optimizer.step()\n```\n\nThis gives you a basic training loop. Want me to add validation metrics?', timestamp: Date.now() / 1000 - 3200 },
        ]
    }],
    ['demo-session-2', {
        id: 'demo-session-2',
        title: 'Hyperparameter Sweep Setup',
        created_at: Date.now() / 1000 - 7200,
        message_count: 2,
        messages: [
            { role: 'user', content: 'How do I set up a hyperparameter sweep?', timestamp: Date.now() / 1000 - 7100 },
            { role: 'assistant', content: 'You can use the Runs tab to create a sweep! Go to **Runs → Create Sweep** and specify:\n\n1. **Base Command**: Your training script\n2. **Parameters**: Define ranges like `{"lr": [0.001, 0.01, 0.1], "batch_size": [32, 64]}`\n\nThe system will automatically create runs for each parameter combination.', timestamp: Date.now() / 1000 - 7000 },
        ]
    }],
])

const mockRuns: Map<string, Run> = new Map([
    ['run-abc123', {
        id: 'run-abc123',
        name: 'MLP Training lr=0.001',
        command: 'python train.py --lr 0.001 --epochs 10',
        workdir: '/workspace/experiments',
        status: 'finished',
        is_archived: false,
        created_at: Date.now() / 1000 - 1800,
        started_at: Date.now() / 1000 - 1750,
        ended_at: Date.now() / 1000 - 1200,
        exit_code: 0,
        run_dir: '/data/runs/run-abc123',
    }],
    ['run-def456', {
        id: 'run-def456',
        name: 'MLP Training lr=0.01',
        command: 'python train.py --lr 0.01 --epochs 10',
        workdir: '/workspace/experiments',
        status: 'running',
        is_archived: false,
        created_at: Date.now() / 1000 - 900,
        started_at: Date.now() / 1000 - 850,
        run_dir: '/data/runs/run-def456',
    }],
    ['run-ghi789', {
        id: 'run-ghi789',
        name: 'MLP Training lr=0.1',
        command: 'python train.py --lr 0.1 --epochs 10',
        workdir: '/workspace/experiments',
        status: 'ready',
        is_archived: false,
        created_at: Date.now() / 1000 - 600,
    }],
])

const mockSweeps: Map<string, Sweep> = new Map([
    ['sweep-001', {
        id: 'sweep-001',
        name: 'Learning Rate Sweep',
        base_command: 'python train.py --epochs 10',
        workdir: '/workspace/experiments',
        parameters: { lr: [0.001, 0.01, 0.1] },
        run_ids: ['run-abc123', 'run-def456', 'run-ghi789'],
        status: 'running',
        created_at: Date.now() / 1000 - 1800,
        progress: { total: 3, completed: 1, failed: 0, running: 1, ready: 1, queued: 0 },
    }],
])

// =============================================================================
// Helper Functions
// =============================================================================

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function generateId(): string {
    return Math.random().toString(36).substring(2, 14)
}

// =============================================================================
// Chat Session Functions
// =============================================================================

export async function listSessions(): Promise<ChatSession[]> {
    await delay(200)
    return Array.from(mockSessions.values()).map(s => ({
        id: s.id,
        title: s.title,
        created_at: s.created_at,
        message_count: s.message_count,
    }))
}

export async function createSession(title?: string): Promise<ChatSession> {
    await delay(150)
    const id = `session-${generateId()}`
    const session: SessionWithMessages = {
        id,
        title: title || 'New Chat',
        created_at: Date.now() / 1000,
        message_count: 0,
        messages: [],
    }
    mockSessions.set(id, session)
    return { id, title: session.title, created_at: session.created_at, message_count: 0 }
}

export async function getSession(sessionId: string): Promise<SessionWithMessages> {
    await delay(100)
    const session = mockSessions.get(sessionId)
    if (!session) {
        throw new Error('Session not found')
    }
    return session
}

export async function deleteSession(sessionId: string): Promise<void> {
    await delay(100)
    mockSessions.delete(sessionId)
}

// Simulated streaming chat response
export async function* streamChat(
    sessionId: string,
    message: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _wildMode: boolean = false
): AsyncGenerator<StreamEvent, void, unknown> {
    const session = mockSessions.get(sessionId)
    if (!session) {
        throw new Error('Session not found')
    }

    // Add user message
    session.messages.push({ role: 'user', content: message, timestamp: Date.now() / 1000 })
    session.message_count++

    // Update title if first message
    if (session.title === 'New Chat' && session.messages.length === 1) {
        session.title = message.substring(0, 50) + (message.length > 50 ? '...' : '')
    }

    // Generate mock response
    const responses = [
        "I understand you're asking about ",
        message.split(' ').slice(0, 3).join(' '),
        ". Let me help you with that.\n\n",
        "Here's what I can tell you:\n\n",
        "1. **First point**: This is a demo response in mock mode.\n",
        "2. **Second point**: The backend server is not connected.\n",
        "3. **Third point**: Deploy with `NEXT_PUBLIC_USE_MOCK=true` for demos.\n\n",
        "Would you like me to elaborate on any of these points?",
    ]

    // Stream thinking first
    yield { type: 'part_delta', id: 'thinking-1', ptype: 'reasoning', delta: 'Analyzing the question... ' }
    await delay(100)
    yield { type: 'part_delta', id: 'thinking-1', ptype: 'reasoning', delta: 'formulating response...' }
    await delay(100)

    // Stream response chunks
    let fullText = ''
    for (const chunk of responses) {
        yield { type: 'part_delta', id: 'text-1', ptype: 'text', delta: chunk }
        fullText += chunk
        await delay(50)
    }

    // Add assistant message
    session.messages.push({
        role: 'assistant',
        content: fullText,
        thinking: 'Analyzing the question... formulating response...',
        timestamp: Date.now() / 1000,
    })
    session.message_count++

    yield { type: 'session_status', status: 'idle' }
}

export async function checkApiHealth(): Promise<boolean> {
    await delay(50)
    return true // Mock always healthy
}

// =============================================================================
// Run Management Functions
// =============================================================================

export async function listRuns(includeArchived: boolean = false): Promise<Run[]> {
    await delay(150)
    return Array.from(mockRuns.values())
        .filter(r => includeArchived || !r.is_archived)
        .sort((a, b) => b.created_at - a.created_at)
}

export async function createRun(request: CreateRunRequest): Promise<Run> {
    await delay(200)
    const id = `run-${generateId()}`
    const run: Run = {
        id,
        name: request.name,
        command: request.command,
        workdir: request.workdir || '/workspace',
        status: request.auto_start ? 'queued' : 'ready',
        is_archived: false,
        created_at: Date.now() / 1000,
        sweep_id: request.sweep_id,
    }
    mockRuns.set(id, run)
    return run
}

export async function getRun(runId: string): Promise<Run> {
    await delay(100)
    const run = mockRuns.get(runId)
    if (!run) {
        throw new Error('Run not found')
    }
    return run
}

export async function startRun(runId: string): Promise<{ message: string; tmux_window: string }> {
    await delay(300)
    const run = mockRuns.get(runId)
    if (!run) {
        throw new Error('Run not found')
    }
    run.status = 'running'
    run.started_at = Date.now() / 1000
    run.tmux_window = `ra-${runId.substring(0, 8)}`
    return { message: 'Run started (mock)', tmux_window: run.tmux_window }
}

export async function stopRun(runId: string): Promise<void> {
    await delay(200)
    const run = mockRuns.get(runId)
    if (!run) {
        throw new Error('Run not found')
    }
    run.status = 'stopped'
    run.stopped_at = Date.now() / 1000
}

export async function archiveRun(runId: string): Promise<void> {
    await delay(100)
    const run = mockRuns.get(runId)
    if (run) {
        run.is_archived = true
    }
}

export async function unarchiveRun(runId: string): Promise<void> {
    await delay(100)
    const run = mockRuns.get(runId)
    if (run) {
        run.is_archived = false
    }
}

export async function getRunLogs(
    runId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _offset: number = -10000,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _limit: number = 10000
): Promise<LogResponse> {
    await delay(100)
    const run = mockRuns.get(runId)
    if (!run) {
        throw new Error('Run not found')
    }

    const mockLog = `[${new Date().toISOString()}] Starting training...
[INFO] Loading dataset...
[INFO] Model initialized with 784 -> 256 -> 10 architecture
[INFO] Epoch 1/10 - Loss: 0.4523 - Acc: 87.2%
[INFO] Epoch 2/10 - Loss: 0.2891 - Acc: 91.5%
[INFO] Epoch 3/10 - Loss: 0.2134 - Acc: 93.8%
[INFO] Training complete!
`

    return {
        content: mockLog,
        offset: 0,
        total_size: mockLog.length,
        has_more_before: false,
        has_more_after: false,
    }
}

export async function* streamRunLogs(runId: string): AsyncGenerator<{
    type: 'initial' | 'delta' | 'done' | 'error'
    content?: string
    status?: string
    error?: string
}> {
    const run = mockRuns.get(runId)
    if (!run) {
        yield { type: 'error', error: 'Run not found' }
        return
    }

    // Send initial logs
    yield {
        type: 'initial',
        content: `[${new Date().toISOString()}] Starting ${run.name}...\n[INFO] Loading dataset...\n`,
    }

    await delay(500)

    // Simulate some log updates
    const updates = [
        '[INFO] Model initialized\n',
        '[INFO] Epoch 1/10 - Loss: 0.45\n',
        '[INFO] Epoch 2/10 - Loss: 0.29\n',
    ]

    for (const update of updates) {
        yield { type: 'delta', content: update }
        await delay(300)
    }

    yield { type: 'done', status: run.status }
}

export async function getRunArtifacts(runId: string): Promise<Artifact[]> {
    await delay(100)
    const run = mockRuns.get(runId)
    if (!run) {
        throw new Error('Run not found')
    }

    if (run.status === 'finished') {
        return [
            { name: 'model.pt', path: `/data/runs/${runId}/model.pt`, type: 'checkpoint' },
            { name: 'metrics.json', path: `/data/runs/${runId}/metrics.json`, type: 'metrics' },
        ]
    }
    return []
}

export async function queueRun(runId: string): Promise<Run> {
    await delay(100)
    const run = mockRuns.get(runId)
    if (!run) {
        throw new Error('Run not found')
    }
    run.status = 'queued'
    run.queued_at = Date.now() / 1000
    return run
}

// =============================================================================
// Sweep Management Functions
// =============================================================================

export async function listSweeps(): Promise<Sweep[]> {
    await delay(150)
    return Array.from(mockSweeps.values()).sort((a, b) => b.created_at - a.created_at)
}

export async function createSweep(request: CreateSweepRequest): Promise<Sweep> {
    await delay(300)
    const sweepId = `sweep-${generateId()}`

    // Create runs for each parameter combination
    const runIds: string[] = []
    const paramKeys = Object.keys(request.parameters)
    const paramValues = Object.values(request.parameters)

    // Simple cartesian product for demo (limit to 5 runs)
    const combinations: Record<string, unknown>[] = []
    const maxRuns = request.max_runs || 10

    function generateCombinations(idx: number, current: Record<string, unknown>) {
        if (combinations.length >= maxRuns) return
        if (idx === paramKeys.length) {
            combinations.push({ ...current })
            return
        }
        for (const val of paramValues[idx] as unknown[]) {
            current[paramKeys[idx]] = val
            generateCombinations(idx + 1, current)
        }
    }
    generateCombinations(0, {})

    for (let i = 0; i < combinations.length; i++) {
        const runId = `run-${generateId()}`
        const params = combinations[i]
        const paramStr = Object.entries(params).map(([k, v]) => `--${k}=${v}`).join(' ')

        const run: Run = {
            id: runId,
            name: `${request.name} #${i + 1}`,
            command: `${request.base_command} ${paramStr}`,
            workdir: request.workdir || '/workspace',
            status: request.auto_start ? 'queued' : 'ready',
            is_archived: false,
            created_at: Date.now() / 1000,
            sweep_id: sweepId,
            sweep_params: params,
        }
        mockRuns.set(runId, run)
        runIds.push(runId)
    }

    const sweep: Sweep = {
        id: sweepId,
        name: request.name,
        base_command: request.base_command,
        workdir: request.workdir,
        parameters: request.parameters,
        run_ids: runIds,
        status: request.auto_start ? 'running' : 'ready',
        created_at: Date.now() / 1000,
        progress: {
            total: runIds.length,
            completed: 0,
            failed: 0,
            running: 0,
            ready: request.auto_start ? 0 : runIds.length,
            queued: request.auto_start ? runIds.length : 0,
        },
    }
    mockSweeps.set(sweepId, sweep)
    return sweep
}

export async function getSweep(sweepId: string): Promise<Sweep> {
    await delay(100)
    const sweep = mockSweeps.get(sweepId)
    if (!sweep) {
        throw new Error('Sweep not found')
    }
    return sweep
}

export async function startSweep(sweepId: string, parallel: number = 1): Promise<{ message: string }> {
    await delay(200)
    const sweep = mockSweeps.get(sweepId)
    if (!sweep) {
        throw new Error('Sweep not found')
    }
    sweep.status = 'running'
    return { message: `Started ${Math.min(parallel, sweep.run_ids.length)} runs (mock)` }
}
