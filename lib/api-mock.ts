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
    RunRerunRequest,
    LogResponse,
    Artifact,
    Alert,
    Sweep,
    CreateSweepRequest,
    WildModeState,
} from './api'

// Re-export types
export type { ChatSession, SessionWithMessages, StreamEvent, Run, RunStatus, CreateRunRequest, RunRerunRequest, LogResponse, Artifact, Alert, Sweep, CreateSweepRequest, WildModeState }
export type { ChatMessageData, StreamEventType } from './api'

// =============================================================================
// Mock Data Store
// =============================================================================

// Color palette for runs
const RUN_COLORS = [
    '#4ade80', // green
    '#60a5fa', // blue
    '#f472b6', // pink
    '#facc15', // yellow
    '#a78bfa', // purple
    '#fb923c', // orange
    '#2dd4bf', // teal
    '#f87171', // red
    '#818cf8', // indigo
    '#34d399', // emerald
]

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
    ['run-qwen-001', {
        id: 'run-qwen-001',
        name: 'Qwen8B lr=1e-5 bs=8',
        command: 'python train.py --model qwen-8b --lr 1e-5 --batch_size 8 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'finished',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        started_at: Date.now() / 1000 - 7100,
        ended_at: Date.now() / 1000 - 3600,
        exit_code: 0,
        run_dir: '/data/runs/run-qwen-001',
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '1e-5', batch_size: 8 },
        config: { learningRate: 0.00001, batchSize: 8, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        metrics: { loss: 0.234, accuracy: 92.1, epoch: 3 },
        lossHistory: [{ step: 1, trainLoss: 2.4 }, { step: 2, trainLoss: 1.8 }, { step: 3, trainLoss: 1.2 }, { step: 4, trainLoss: 0.85 }, { step: 5, trainLoss: 0.52 }, { step: 6, trainLoss: 0.34 }, { step: 7, trainLoss: 0.28 }, { step: 8, trainLoss: 0.24 }, { step: 9, trainLoss: 0.234 }],
        color: RUN_COLORS[0],
    }],
    ['run-qwen-002', {
        id: 'run-qwen-002',
        name: 'Qwen8B lr=1e-5 bs=16',
        command: 'python train.py --model qwen-8b --lr 1e-5 --batch_size 16 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'finished',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        started_at: Date.now() / 1000 - 7100,
        ended_at: Date.now() / 1000 - 3500,
        exit_code: 0,
        run_dir: '/data/runs/run-qwen-002',
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '1e-5', batch_size: 16 },
        config: { learningRate: 0.00001, batchSize: 16, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        metrics: { loss: 0.312, accuracy: 89.3, epoch: 3 },
        lossHistory: [{ step: 1, trainLoss: 2.5 }, { step: 2, trainLoss: 1.9 }, { step: 3, trainLoss: 1.4 }, { step: 4, trainLoss: 0.95 }, { step: 5, trainLoss: 0.62 }, { step: 6, trainLoss: 0.45 }, { step: 7, trainLoss: 0.38 }, { step: 8, trainLoss: 0.33 }, { step: 9, trainLoss: 0.312 }],
        color: RUN_COLORS[1],
    }],
    ['run-qwen-003', {
        id: 'run-qwen-003',
        name: 'Qwen8B lr=1e-5 bs=32',
        command: 'python train.py --model qwen-8b --lr 1e-5 --batch_size 32 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'finished',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        started_at: Date.now() / 1000 - 7100,
        ended_at: Date.now() / 1000 - 3400,
        exit_code: 0,
        run_dir: '/data/runs/run-qwen-003',
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '1e-5', batch_size: 32 },
        config: { learningRate: 0.00001, batchSize: 32, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        metrics: { loss: 0.421, accuracy: 86.8, epoch: 3 },
        lossHistory: [{ step: 1, trainLoss: 2.6 }, { step: 2, trainLoss: 2.1 }, { step: 3, trainLoss: 1.6 }, { step: 4, trainLoss: 1.2 }, { step: 5, trainLoss: 0.82 }, { step: 6, trainLoss: 0.58 }, { step: 7, trainLoss: 0.48 }, { step: 8, trainLoss: 0.44 }, { step: 9, trainLoss: 0.421 }],
        color: RUN_COLORS[2],
    }],
    ['run-qwen-004', {
        id: 'run-qwen-004',
        name: 'Qwen8B lr=5e-5 bs=8',
        command: 'python train.py --model qwen-8b --lr 5e-5 --batch_size 8 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'finished',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        started_at: Date.now() / 1000 - 7100,
        ended_at: Date.now() / 1000 - 3300,
        exit_code: 0,
        run_dir: '/data/runs/run-qwen-004',
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '5e-5', batch_size: 8 },
        config: { learningRate: 0.00005, batchSize: 8, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        metrics: { loss: 0.189, accuracy: 94.2, epoch: 3 },
        lossHistory: [{ step: 1, trainLoss: 2.3 }, { step: 2, trainLoss: 1.5 }, { step: 3, trainLoss: 0.9 }, { step: 4, trainLoss: 0.55 }, { step: 5, trainLoss: 0.35 }, { step: 6, trainLoss: 0.26 }, { step: 7, trainLoss: 0.21 }, { step: 8, trainLoss: 0.19 }, { step: 9, trainLoss: 0.189 }],
        color: RUN_COLORS[3],
    }],
    ['run-qwen-005', {
        id: 'run-qwen-005',
        name: 'Qwen8B lr=5e-5 bs=16',
        command: 'python train.py --model qwen-8b --lr 5e-5 --batch_size 16 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'running',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        started_at: Date.now() / 1000 - 1800,
        run_dir: '/data/runs/run-qwen-005',
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '5e-5', batch_size: 16 },
        config: { learningRate: 0.00005, batchSize: 16, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        progress: 65,
        tmux_window: 'ra-qwen005',
        metrics: { loss: 0.42, accuracy: 85.3, epoch: 2 },
        lossHistory: [{ step: 1, trainLoss: 2.4 }, { step: 2, trainLoss: 1.7 }, { step: 3, trainLoss: 1.1 }, { step: 4, trainLoss: 0.72 }, { step: 5, trainLoss: 0.52 }, { step: 6, trainLoss: 0.42 }],
        color: RUN_COLORS[4],
    }],
    ['run-qwen-006', {
        id: 'run-qwen-006',
        name: 'Qwen8B lr=5e-5 bs=32',
        command: 'python train.py --model qwen-8b --lr 5e-5 --batch_size 32 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'running',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        started_at: Date.now() / 1000 - 900,
        run_dir: '/data/runs/run-qwen-006',
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '5e-5', batch_size: 32 },
        config: { learningRate: 0.00005, batchSize: 32, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        progress: 32,
        tmux_window: 'ra-qwen006',
        metrics: { loss: 0.85, accuracy: 78.1, epoch: 1 },
        lossHistory: [{ step: 1, trainLoss: 2.5 }, { step: 2, trainLoss: 1.8 }, { step: 3, trainLoss: 0.85 }],
        color: RUN_COLORS[5],
    }],
    ['run-qwen-007', {
        id: 'run-qwen-007',
        name: 'Qwen8B lr=1e-4 bs=8',
        command: 'python train.py --model qwen-8b --lr 1e-4 --batch_size 8 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'queued',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        queued_at: Date.now() / 1000 - 300,
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '1e-4', batch_size: 8 },
        config: { learningRate: 0.0001, batchSize: 8, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        color: RUN_COLORS[6],
    }],
    ['run-qwen-008', {
        id: 'run-qwen-008',
        name: 'Qwen8B lr=1e-4 bs=16',
        command: 'python train.py --model qwen-8b --lr 1e-4 --batch_size 16 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'ready',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '1e-4', batch_size: 16 },
        config: { learningRate: 0.0001, batchSize: 16, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        color: RUN_COLORS[7],
    }],
    ['run-qwen-009', {
        id: 'run-qwen-009',
        name: 'Qwen8B lr=1e-4 bs=32',
        command: 'python train.py --model qwen-8b --lr 1e-4 --batch_size 32 --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        status: 'ready',
        is_archived: false,
        created_at: Date.now() / 1000 - 7200,
        sweep_id: 'sweep-qwen',
        sweep_params: { lr: '1e-4', batch_size: 32 },
        config: { learningRate: 0.0001, batchSize: 32, epochs: 3, warmupSteps: 100, model: 'qwen-8b' },
        color: RUN_COLORS[8],
    }],
])

const mockSweeps: Map<string, Sweep> = new Map([
    ['sweep-qwen', {
        id: 'sweep-qwen',
        name: 'Qwen8B Hyperparameter Search',
        base_command: 'python train.py --model qwen-8b --epochs 3 --warmup_steps 100',
        workdir: '/workspace/qwen-finetune',
        parameters: { lr: ['1e-5', '5e-5', '1e-4'], batch_size: [8, 16, 32] },
        run_ids: ['run-qwen-001', 'run-qwen-002', 'run-qwen-003', 'run-qwen-004', 'run-qwen-005', 'run-qwen-006', 'run-qwen-007', 'run-qwen-008', 'run-qwen-009'],
        status: 'running',
        created_at: Date.now() / 1000 - 7200,
        progress: { total: 9, completed: 4, failed: 0, running: 2, ready: 2, queued: 1 },
    }],
])

const mockAlerts: Map<string, Alert> = new Map([
    ['alert-qwen-1', {
        id: 'alert-qwen-1',
        run_id: 'run-qwen-006',
        timestamp: Date.now() / 1000 - 180,
        severity: 'warning',
        message: 'Loss spike detected (loss=0.8500, rolling_avg=0.5200).',
        choices: ['Ignore', 'Stop Job'],
        status: 'pending',
        response: null,
        responded_at: null,
        session_id: null,
        auto_session: false,
    }],
    ['alert-qwen-2', {
        id: 'alert-qwen-2',
        run_id: 'run-qwen-005',
        timestamp: Date.now() / 1000 - 1200,
        severity: 'critical',
        message: 'High loss detected (loss=8.7000, threshold=8.0).',
        choices: ['Ignore', 'Stop Job'],
        status: 'resolved',
        response: 'Ignore',
        responded_at: Date.now() / 1000 - 1100,
        session_id: null,
        auto_session: false,
    }],
])

let wildModeEnabled = false

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
    _wildMode: boolean = false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _signal?: AbortSignal
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
        parent_run_id: request.parent_run_id || null,
        origin_alert_id: request.origin_alert_id || null,
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

export async function rerunRun(runId: string, request: RunRerunRequest = {}): Promise<Run> {
    await delay(200)
    const run = mockRuns.get(runId)
    if (!run) {
        throw new Error('Run not found')
    }
    const id = `run-${generateId()}`
    const newRun: Run = {
        id,
        name: `${run.name} (Rerun)`,
        command: request.command || run.command,
        workdir: run.workdir || '/workspace',
        status: request.auto_start ? 'queued' : 'ready',
        is_archived: false,
        parent_run_id: runId,
        origin_alert_id: request.origin_alert_id || null,
        created_at: Date.now() / 1000,
        sweep_id: run.sweep_id,
    }
    mockRuns.set(id, newRun)
    return newRun
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

export async function listAlerts(): Promise<Alert[]> {
    await delay(120)
    return Array.from(mockAlerts.values()).sort((a, b) => b.timestamp - a.timestamp)
}

export async function respondToAlert(alertId: string, choice: string): Promise<{ message: string }> {
    await delay(120)
    const alert = mockAlerts.get(alertId)
    if (!alert) {
        throw new Error('Alert not found')
    }
    if (!alert.choices.includes(choice)) {
        throw new Error('Invalid alert choice')
    }

    alert.status = 'resolved'
    alert.response = choice
    alert.responded_at = Date.now() / 1000

    if (choice.toLowerCase().includes('stop')) {
        const run = mockRuns.get(alert.run_id)
        if (run && (run.status === 'running' || run.status === 'launching')) {
            run.status = 'stopped'
            run.stopped_at = Date.now() / 1000
        }
    }

    return { message: 'Response recorded (mock)' }
}

export async function stopSession(sessionId: string): Promise<{ message: string }> {
    await delay(50)
    if (!mockSessions.has(sessionId)) {
        throw new Error('Session not found')
    }
    return { message: 'Stop signal sent (mock)' }
}

export async function getWildMode(): Promise<WildModeState> {
    await delay(50)
    return { enabled: wildModeEnabled }
}

export async function setWildMode(enabled: boolean): Promise<WildModeState> {
    await delay(50)
    wildModeEnabled = enabled
    return { enabled: wildModeEnabled }
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
