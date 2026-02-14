'use client'

// Mock API Implementation for Vercel Deployment
// This module provides demo data when NEXT_PUBLIC_USE_MOCK=true

import type {
    ChatSession,
    ChatModelOption,
    SessionModelSelection,
    ActiveSessionStream,
    SessionWithMessages,
    StreamEvent,
    Run,
    RunStatus,
    CreateRunRequest,
    RunRerunRequest,
    RunUpdateRequest,
    LogResponse,
    Artifact,
    Alert,
    Sweep,
    CreateSweepRequest,
    UpdateSweepRequest,
    WildModeState,
    ClusterType,
    ClusterState,
    ClusterStatusResponse,
    ClusterUpdateRequest,
    ClusterDetectRequest,
    RepoDiffFileStatus,
    RepoDiffLine,
    RepoDiffFile,
    RepoDiffResponse,
    RepoFilesResponse,
    RepoFileResponse,
} from './api'

// Re-export types
export type { ChatSession, ChatModelOption, SessionModelSelection, ActiveSessionStream, SessionWithMessages, StreamEvent, Run, RunStatus, CreateRunRequest, RunRerunRequest, RunUpdateRequest, LogResponse, Artifact, Alert, Sweep, CreateSweepRequest, UpdateSweepRequest, WildModeState, ClusterType, ClusterState, ClusterStatusResponse, ClusterUpdateRequest, ClusterDetectRequest, RepoDiffFileStatus, RepoDiffLine, RepoDiffFile, RepoDiffResponse, RepoFilesResponse, RepoFileResponse }
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

const MOCK_MODEL_OPTIONS: ChatModelOption[] = [
    {
        provider_id: 'opencode',
        model_id: 'kimi-k2.5-free',
        name: 'Kimi K2.5 (Free)',
        context_limit: 200000,
        output_limit: 8192,
        is_default: true,
    },
    {
        provider_id: 'opencode',
        model_id: 'glm-4.7-free',
        name: 'glm-4.7-free',
        is_default: false,
    },
    {
        provider_id: 'opencode',
        model_id: 'trinity-large-preview-free',
        name: 'trinity-large-preview-free',
        is_default: false,
    },
    {
        provider_id: 'opencode',
        model_id: 'minimax-m2.1-free',
        name: 'minimax-m2.1-free',
        is_default: false,
    },
    {
        provider_id: 'opencode',
        model_id: 'minimax-m2.5-free',
        name: 'minimax-m2.5-free',
        is_default: false,
    },
    {
        provider_id: 'opencode',
        model_id: 'big-pickle',
        name: 'big-pickle',
        is_default: false,
    },
    {
        provider_id: 'research-agent',
        model_id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        context_limit: 200000,
        output_limit: 16384,
        is_default: false,
    },
    {
        provider_id: 'research-agent',
        model_id: 'claude-opus-4-6-20260205',
        name: 'Claude Opus 4.6',
        context_limit: 1000000,
        output_limit: 16384,
        is_default: false,
    },
]

const DEFAULT_MODEL_SELECTION: SessionModelSelection = {
    provider_id: 'opencode',
    model_id: 'kimi-k2.5-free',
}

const mockSessions: Map<string, SessionWithMessages> = new Map([
    ['demo-session-1', {
        id: 'demo-session-1',
        title: 'Training MLP on MNIST',
        created_at: Date.now() / 1000 - 3600,
        message_count: 4,
        model_provider: DEFAULT_MODEL_SELECTION.provider_id,
        model_id: DEFAULT_MODEL_SELECTION.model_id,
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
        model_provider: DEFAULT_MODEL_SELECTION.provider_id,
        model_id: DEFAULT_MODEL_SELECTION.model_id,
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
    ['run-qwen-010', {
        id: 'run-qwen-010',
        name: 'Status Demo Failed',
        command: 'python train.py --model qwen-8b --lr 2e-4 --batch_size 24 --epochs 2',
        workdir: '/workspace/qwen-finetune',
        status: 'failed',
        is_archived: false,
        created_at: Date.now() / 1000 - 240,
        started_at: Date.now() / 1000 - 220,
        ended_at: Date.now() / 1000 - 180,
        exit_code: 1,
        error: 'RuntimeError: CUDA out of memory',
        run_dir: '/data/runs/run-qwen-010',
        sweep_id: 'sweep-demo-failed',
        config: { learningRate: 0.0002, batchSize: 24, epochs: 2, model: 'qwen-8b' },
        metrics: { loss: 8.7, accuracy: 12.3, epoch: 1 },
        color: RUN_COLORS[9],
    }],
    ['run-qwen-011', {
        id: 'run-qwen-011',
        name: 'Status Demo Canceled',
        command: 'python train.py --model qwen-8b --lr 3e-5 --batch_size 8 --epochs 4',
        workdir: '/workspace/qwen-finetune',
        status: 'stopped',
        is_archived: false,
        created_at: Date.now() / 1000 - 210,
        started_at: Date.now() / 1000 - 190,
        stopped_at: Date.now() / 1000 - 120,
        ended_at: Date.now() / 1000 - 120,
        run_dir: '/data/runs/run-qwen-011',
        sweep_id: 'sweep-demo-canceled',
        config: { learningRate: 0.00003, batchSize: 8, epochs: 4, model: 'qwen-8b' },
        color: RUN_COLORS[0],
    }],
    ['run-qwen-012', {
        id: 'run-qwen-012',
        name: 'Status Demo Ready',
        command: 'python train.py --model qwen-8b --lr 2e-5 --batch_size 12 --epochs 3',
        workdir: '/workspace/qwen-finetune',
        status: 'ready',
        is_archived: false,
        created_at: Date.now() / 1000 - 170,
        sweep_id: 'sweep-demo-pending',
        config: { learningRate: 0.00002, batchSize: 12, epochs: 3, model: 'qwen-8b' },
        color: RUN_COLORS[1],
    }],
    ['run-qwen-013', {
        id: 'run-qwen-013',
        name: 'Status Demo Queued',
        command: 'python train.py --model qwen-8b --lr 6e-5 --batch_size 20 --epochs 3',
        workdir: '/workspace/qwen-finetune',
        status: 'queued',
        is_archived: false,
        created_at: Date.now() / 1000 - 150,
        queued_at: Date.now() / 1000 - 130,
        sweep_id: 'sweep-demo-pending',
        config: { learningRate: 0.00006, batchSize: 20, epochs: 3, model: 'qwen-8b' },
        color: RUN_COLORS[2],
    }],
    ['run-qwen-014', {
        id: 'run-qwen-014',
        name: 'Status Demo Running',
        command: 'python train.py --model qwen-8b --lr 4e-5 --batch_size 10 --epochs 3',
        workdir: '/workspace/qwen-finetune',
        status: 'running',
        is_archived: false,
        created_at: Date.now() / 1000 - 110,
        started_at: Date.now() / 1000 - 90,
        progress: 22,
        run_dir: '/data/runs/run-qwen-014',
        tmux_window: 'ra-qwen014',
        sweep_id: 'sweep-demo-running',
        config: { learningRate: 0.00004, batchSize: 10, epochs: 3, model: 'qwen-8b' },
        color: RUN_COLORS[3],
    }],
    ['run-qwen-015', {
        id: 'run-qwen-015',
        name: 'Status Demo Completed',
        command: 'python train.py --model qwen-8b --lr 1e-5 --batch_size 14 --epochs 2',
        workdir: '/workspace/qwen-finetune',
        status: 'finished',
        is_archived: false,
        created_at: Date.now() / 1000 - 80,
        started_at: Date.now() / 1000 - 70,
        ended_at: Date.now() / 1000 - 20,
        exit_code: 0,
        run_dir: '/data/runs/run-qwen-015',
        sweep_id: 'sweep-demo-completed',
        config: { learningRate: 0.00001, batchSize: 14, epochs: 2, model: 'qwen-8b' },
        metrics: { loss: 0.173, accuracy: 94.8, epoch: 2 },
        color: RUN_COLORS[4],
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
        creation_context: {
            name: 'Qwen8B Hyperparameter Search',
            goal: 'Find stable lr/batch_size settings for qwen-8b fine-tuning.',
            description: 'Initial sweep created from the run panel to explore 3x3 parameter combinations.',
            command: 'python train.py --model qwen-8b --epochs 3 --warmup_steps 100',
            notes: null,
            max_runs: 9,
            parallel_runs: 2,
            early_stopping_enabled: null,
            early_stopping_patience: null,
            hyperparameter_count: 2,
            metric_count: null,
            insight_count: null,
            created_at: Date.now() / 1000 - 7200,
            ui_config_snapshot: null,
        },
        progress: { total: 9, completed: 4, failed: 0, running: 2, ready: 2, queued: 1 },
    }],
    ['sweep-demo-draft', {
        id: 'sweep-demo-draft',
        name: 'Status Demo Draft',
        base_command: 'python train.py --model qwen-8b --epochs 2',
        workdir: '/workspace/qwen-finetune',
        parameters: { lr: ['1e-5', '3e-5'], batch_size: [8, 16] },
        run_ids: [],
        status: 'draft',
        created_at: Date.now() / 1000 - 300,
        creation_context: {
            name: 'Status Demo Draft',
            goal: 'Draft sweep to preview status styling.',
            description: 'No runs created yet.',
            command: 'python train.py --model qwen-8b --epochs 2',
            notes: null,
            max_runs: 4,
            parallel_runs: 1,
            created_at: Date.now() / 1000 - 300,
            ui_config_snapshot: null,
        },
        progress: { total: 0, completed: 0, failed: 0, running: 0, launching: 0, ready: 0, queued: 0, canceled: 0 },
    }],
    ['sweep-demo-pending', {
        id: 'sweep-demo-pending',
        name: 'Status Demo Pending',
        base_command: 'python train.py --model qwen-8b --epochs 3',
        workdir: '/workspace/qwen-finetune',
        parameters: { lr: ['2e-5', '6e-5'], batch_size: [12, 20] },
        run_ids: ['run-qwen-012', 'run-qwen-013'],
        status: 'pending',
        created_at: Date.now() / 1000 - 260,
        creation_context: {
            name: 'Status Demo Pending',
            goal: 'Pending/ready+queued run mix.',
            description: 'Includes one ready and one queued run.',
            command: 'python train.py --model qwen-8b --epochs 3',
            notes: null,
            max_runs: 2,
            parallel_runs: 1,
            created_at: Date.now() / 1000 - 260,
            ui_config_snapshot: null,
        },
        progress: { total: 2, completed: 0, failed: 0, running: 0, launching: 0, ready: 1, queued: 1, canceled: 0 },
    }],
    ['sweep-demo-running', {
        id: 'sweep-demo-running',
        name: 'Status Demo Running',
        base_command: 'python train.py --model qwen-8b --epochs 3',
        workdir: '/workspace/qwen-finetune',
        parameters: { lr: ['4e-5'], batch_size: [10] },
        run_ids: ['run-qwen-014'],
        status: 'running',
        created_at: Date.now() / 1000 - 220,
        started_at: Date.now() / 1000 - 210,
        creation_context: {
            name: 'Status Demo Running',
            goal: 'Single active run.',
            description: 'Used to showcase running status.',
            command: 'python train.py --model qwen-8b --epochs 3',
            notes: null,
            max_runs: 1,
            parallel_runs: 1,
            created_at: Date.now() / 1000 - 220,
            ui_config_snapshot: null,
        },
        progress: { total: 1, completed: 0, failed: 0, running: 1, launching: 0, ready: 0, queued: 0, canceled: 0 },
    }],
    ['sweep-demo-completed', {
        id: 'sweep-demo-completed',
        name: 'Status Demo Completed',
        base_command: 'python train.py --model qwen-8b --epochs 2',
        workdir: '/workspace/qwen-finetune',
        parameters: { lr: ['1e-5'], batch_size: [14] },
        run_ids: ['run-qwen-015'],
        status: 'completed',
        created_at: Date.now() / 1000 - 200,
        started_at: Date.now() / 1000 - 195,
        completed_at: Date.now() / 1000 - 60,
        creation_context: {
            name: 'Status Demo Completed',
            goal: 'Completed status demo.',
            description: 'Single completed run.',
            command: 'python train.py --model qwen-8b --epochs 2',
            notes: null,
            max_runs: 1,
            parallel_runs: 1,
            created_at: Date.now() / 1000 - 200,
            ui_config_snapshot: null,
        },
        progress: { total: 1, completed: 1, failed: 0, running: 0, launching: 0, ready: 0, queued: 0, canceled: 0 },
    }],
    ['sweep-demo-failed', {
        id: 'sweep-demo-failed',
        name: 'Status Demo Failed',
        base_command: 'python train.py --model qwen-8b --epochs 2',
        workdir: '/workspace/qwen-finetune',
        parameters: { lr: ['2e-4'], batch_size: [24] },
        run_ids: ['run-qwen-010'],
        status: 'failed',
        created_at: Date.now() / 1000 - 180,
        started_at: Date.now() / 1000 - 170,
        completed_at: Date.now() / 1000 - 110,
        creation_context: {
            name: 'Status Demo Failed',
            goal: 'Failed status demo.',
            description: 'Single failed run.',
            command: 'python train.py --model qwen-8b --epochs 2',
            notes: null,
            max_runs: 1,
            parallel_runs: 1,
            created_at: Date.now() / 1000 - 180,
            ui_config_snapshot: null,
        },
        progress: { total: 1, completed: 0, failed: 1, running: 0, launching: 0, ready: 0, queued: 0, canceled: 0 },
    }],
    ['sweep-demo-canceled', {
        id: 'sweep-demo-canceled',
        name: 'Status Demo Canceled',
        base_command: 'python train.py --model qwen-8b --epochs 4',
        workdir: '/workspace/qwen-finetune',
        parameters: { lr: ['3e-5'], batch_size: [8] },
        run_ids: ['run-qwen-011'],
        status: 'canceled',
        created_at: Date.now() / 1000 - 160,
        started_at: Date.now() / 1000 - 150,
        completed_at: Date.now() / 1000 - 100,
        creation_context: {
            name: 'Status Demo Canceled',
            goal: 'Canceled status demo.',
            description: 'Stopped run mapped to canceled in UI.',
            command: 'python train.py --model qwen-8b --epochs 4',
            notes: null,
            max_runs: 1,
            parallel_runs: 1,
            created_at: Date.now() / 1000 - 160,
            ui_config_snapshot: null,
        },
        progress: { total: 1, completed: 0, failed: 0, running: 0, launching: 0, ready: 0, queued: 0, canceled: 1 },
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

const CLUSTER_TYPE_LABELS: Record<ClusterType, string> = {
    unknown: 'Unknown',
    slurm: 'Slurm',
    local_gpu: 'Local GPU',
    kubernetes: 'Kubernetes',
    ray: 'Ray',
    shared_head_node: 'Shared GPU Head Node',
}

let mockCluster: ClusterState = {
    type: 'local_gpu',
    status: 'healthy',
    source: 'detected',
    label: CLUSTER_TYPE_LABELS.local_gpu,
    description: 'Single-host GPU workstation/cluster detected.',
    head_node: 'local-host',
    node_count: 1,
    gpu_count: 4,
    confidence: 0.84,
    details: {
        signals: ['nvidia-smi'],
    },
    last_detected_at: Date.now() / 1000 - 120,
    updated_at: Date.now() / 1000 - 120,
}

const mockRepoDiff: RepoDiffResponse = {
    repo_path: '/workspace/research-agent',
    head: 'mock-head',
    files: [
        {
            path: 'app/contextual/page.tsx',
            status: 'modified',
            additions: 8,
            deletions: 2,
            lines: [
                { type: 'hunk', text: '@@ -64,6 +64,7 @@', oldLine: null, newLine: null },
                { type: 'context', text: '  const [showOpsPanel, setShowOpsPanel] = useState(true)', oldLine: 64, newLine: 64 },
                { type: 'add', text: '  const [diffExplorerOpen, setDiffExplorerOpen] = useState(false)', oldLine: null, newLine: 65 },
            ],
        },
        {
            path: 'components/contextual-diff-explorer.tsx',
            status: 'added',
            additions: 36,
            deletions: 0,
            lines: [
                { type: 'hunk', text: '@@ -0,0 +1,36 @@', oldLine: null, newLine: null },
                { type: 'add', text: '\'use client\'', oldLine: null, newLine: 1 },
                { type: 'add', text: 'export function ContextualDiffExplorer() {', oldLine: null, newLine: 10 },
            ],
        },
    ],
}

const mockRepoFiles: RepoFilesResponse = {
    repo_path: '/workspace/research-agent',
    files: [
        'README.md',
        'app/contextual/page.tsx',
        'components/contextual-diff-explorer.tsx',
        'lib/api.ts',
        'lib/api-client.ts',
        'server/server.py',
    ],
}

const mockRepoFileContents: Record<string, string> = {
    'README.md': '# Research Agent\n\nMock file explorer content.\n',
    'app/contextual/page.tsx': '\'use client\'\n\nexport default function ContextualChatPage() {\n  return null\n}\n',
    'components/contextual-diff-explorer.tsx': '\'use client\'\n\nexport function ContextualDiffExplorer() {\n  return null\n}\n',
    'lib/api.ts': 'export async function getRepoDiff() {\n  return { files: [] }\n}\n',
    'lib/api-client.ts': 'export const getRepoDiff = () => Promise.resolve({ files: [] })\n',
    'server/server.py': 'def get_repo_diff():\n    return {"files": []}\n',
}

// =============================================================================
// Helper Functions
// =============================================================================

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function generateId(): string {
    return Math.random().toString(36).substring(2, 14)
}

function nowSeconds() {
    return Date.now() / 1000
}

function normalizeClusterType(input?: string | null): ClusterType {
    if (!input) return 'unknown'
    const normalized = input.trim().toLowerCase().replace('-', '_')
    if (normalized === 'k8s') return 'kubernetes'
    if (normalized === 'shared_gpu') return 'shared_head_node'
    if (normalized === 'head_node') return 'shared_head_node'
    if (
        normalized === 'unknown' ||
        normalized === 'slurm' ||
        normalized === 'local_gpu' ||
        normalized === 'kubernetes' ||
        normalized === 'ray' ||
        normalized === 'shared_head_node'
    ) {
        return normalized
    }
    return 'unknown'
}

function getRunSummary() {
    const activeRuns = Array.from(mockRuns.values()).filter((run) => !run.is_archived)
    return {
        total: activeRuns.length,
        running: activeRuns.filter((run) => run.status === 'running').length,
        launching: activeRuns.filter((run) => run.status === 'launching').length,
        queued: activeRuns.filter((run) => run.status === 'queued').length,
        ready: activeRuns.filter((run) => run.status === 'ready').length,
        failed: activeRuns.filter((run) => run.status === 'failed').length,
        finished: activeRuns.filter((run) => run.status === 'finished').length,
    }
}

function getClusterDescription(type: ClusterType): string {
    switch (type) {
        case 'slurm':
            return 'Slurm-managed cluster scheduler detected.'
        case 'local_gpu':
            return 'Single-host GPU workstation/cluster detected.'
        case 'kubernetes':
            return 'Kubernetes cluster control plane detected.'
        case 'ray':
            return 'Ray cluster runtime detected.'
        case 'shared_head_node':
            return 'Head node with SSH fan-out to worker nodes.'
        default:
            return 'Cluster has not been configured yet.'
    }
}

function buildClusterResponse(): ClusterStatusResponse {
    return {
        cluster: mockCluster,
        run_summary: getRunSummary(),
    }
}

// =============================================================================
// Chat Session Functions
// =============================================================================

export async function listSessions(): Promise<ChatSession[]> {
    await delay(200)
    const hasPendingAlertBySessionId = new Set(
        Array.from(mockAlerts.values())
            .filter((alert) => alert.status === 'pending' && typeof alert.session_id === 'string')
            .map((alert) => alert.session_id as string)
    )

    return Array.from(mockSessions.values()).map(s => ({
        id: s.id,
        title: s.title,
        created_at: s.created_at,
        message_count: s.message_count,
        model_provider: s.model_provider,
        model_id: s.model_id,
        status: hasPendingAlertBySessionId.has(s.id) ? 'awaiting_human' : (s.message_count > 0 ? 'completed' : 'idle'),
    }))
}

export async function createSession(title?: string, model?: SessionModelSelection): Promise<ChatSession> {
    await delay(150)
    const id = `session-${generateId()}`
    const selectedModel = model ?? DEFAULT_MODEL_SELECTION
    const session: SessionWithMessages = {
        id,
        title: title || 'New Chat',
        created_at: Date.now() / 1000,
        message_count: 0,
        model_provider: selectedModel.provider_id,
        model_id: selectedModel.model_id,
        messages: [],
    }
    mockSessions.set(id, session)
    return {
        id,
        title: session.title,
        created_at: session.created_at,
        message_count: 0,
        model_provider: session.model_provider,
        model_id: session.model_id,
        status: 'idle',
    }
}

export async function getSession(sessionId: string): Promise<SessionWithMessages> {
    await delay(100)
    const session = mockSessions.get(sessionId)
    if (!session) {
        throw new Error('Session not found')
    }
    return session
}

export async function renameSession(sessionId: string, title: string): Promise<ChatSession> {
    await delay(100)
    const session = mockSessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    session.title = title
    return {
        id: sessionId,
        title: session.title,
        created_at: session.created_at,
        message_count: session.messages.length,
        model_provider: session.model_provider,
        model_id: session.model_id,
        status: session.messages.length > 0 ? 'completed' : 'idle',
    }
}

export async function deleteSession(sessionId: string): Promise<void> {
    await delay(100)
    mockSessions.delete(sessionId)
}

export async function listModels(): Promise<ChatModelOption[]> {
    await delay(80)
    return MOCK_MODEL_OPTIONS
}

export async function getSessionModel(sessionId: string): Promise<SessionModelSelection> {
    await delay(80)
    const session = mockSessions.get(sessionId)
    if (!session) {
        throw new Error('Session not found')
    }
    return {
        provider_id: session.model_provider || DEFAULT_MODEL_SELECTION.provider_id,
        model_id: session.model_id || DEFAULT_MODEL_SELECTION.model_id,
    }
}

export async function setSessionModel(sessionId: string, model: SessionModelSelection): Promise<SessionModelSelection> {
    await delay(80)
    const session = mockSessions.get(sessionId)
    if (!session) {
        throw new Error('Session not found')
    }
    session.model_provider = model.provider_id
    session.model_id = model.model_id
    return model
}

// Simulated streaming chat response
export async function* streamChat(
    sessionId: string,
    message: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _mode: string = 'agent',
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

export async function* streamSession(
    _sessionId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _fromSeq: number = 1,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _signal?: AbortSignal,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _runId?: string
): AsyncGenerator<StreamEvent, void, unknown> {
    await delay(50)
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

export async function updateRun(runId: string, request: RunUpdateRequest): Promise<Run> {
    await delay(120)
    const run = mockRuns.get(runId)
    if (!run) {
        throw new Error('Run not found')
    }

    if (request.command !== undefined) {
        run.command = request.command
    }
    if (request.name !== undefined) {
        run.name = request.name
    }
    if (request.workdir !== undefined) {
        run.workdir = request.workdir
    }

    mockRuns.set(runId, run)
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

export async function getRepoDiff(): Promise<RepoDiffResponse> {
    await delay(80)
    return mockRepoDiff
}

export async function getRepoFiles(limit: number = 5000): Promise<RepoFilesResponse> {
    await delay(80)
    return {
        repo_path: mockRepoFiles.repo_path,
        files: mockRepoFiles.files.slice(0, limit),
    }
}

export async function getRepoFile(path: string, maxBytes: number = 120000): Promise<RepoFileResponse> {
    await delay(80)
    const content = mockRepoFileContents[path]
    if (content === undefined) {
        throw new Error('File not found')
    }
    const sliced = content.slice(0, maxBytes)
    return {
        path,
        content: sliced,
        binary: false,
        truncated: content.length > sliced.length,
    }
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
    const requestedStatus = request.status || (request.auto_start ? 'running' : 'pending')
    const shouldCreateDraft = requestedStatus === 'draft'
    const createdAt = Date.now() / 1000
    const uiConfig = request.ui_config || {}
    const creationContext = {
        name: typeof uiConfig.name === 'string' ? uiConfig.name : request.name,
        goal: typeof uiConfig.goal === 'string' ? uiConfig.goal : (request.goal || null),
        description: typeof uiConfig.description === 'string' ? uiConfig.description : null,
        command: typeof uiConfig.command === 'string' ? uiConfig.command : request.base_command,
        notes: typeof uiConfig.notes === 'string' ? uiConfig.notes : null,
        max_runs: typeof uiConfig.maxRuns === 'number' ? uiConfig.maxRuns : (request.max_runs ?? null),
        parallel_runs: typeof uiConfig.parallelRuns === 'number' ? uiConfig.parallelRuns : null,
        early_stopping_enabled: typeof uiConfig.earlyStoppingEnabled === 'boolean' ? uiConfig.earlyStoppingEnabled : null,
        early_stopping_patience: typeof uiConfig.earlyStoppingPatience === 'number' ? uiConfig.earlyStoppingPatience : null,
        hyperparameter_count: Array.isArray(uiConfig.hyperparameters)
            ? uiConfig.hyperparameters.length
            : Object.keys(request.parameters || {}).length,
        metric_count: Array.isArray(uiConfig.metrics) ? uiConfig.metrics.length : null,
        insight_count: Array.isArray(uiConfig.insights) ? uiConfig.insights.length : null,
        created_at: createdAt,
        ui_config_snapshot: uiConfig,
    }

    if (shouldCreateDraft) {
        const sweep: Sweep = {
            id: sweepId,
            name: request.name,
            base_command: request.base_command,
            workdir: request.workdir,
            parameters: request.parameters,
            run_ids: [],
            status: 'draft',
            created_at: createdAt,
            goal: request.goal,
            max_runs: request.max_runs,
            ui_config: request.ui_config,
            creation_context: creationContext,
            progress: {
                total: 0,
                completed: 0,
                failed: 0,
                running: 0,
                launching: 0,
                ready: 0,
                queued: 0,
                canceled: 0,
            },
        }
        mockSweeps.set(sweepId, sweep)
        return sweep
    }

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
            status: requestedStatus === 'running' ? 'queued' : 'ready',
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
        status: requestedStatus === 'running' ? 'running' : 'pending',
        created_at: createdAt,
        goal: request.goal,
        max_runs: request.max_runs,
        ui_config: request.ui_config,
        creation_context: creationContext,
        progress: {
            total: runIds.length,
            completed: 0,
            failed: 0,
            running: 0,
            launching: 0,
            ready: requestedStatus === 'running' ? 0 : runIds.length,
            queued: requestedStatus === 'running' ? runIds.length : 0,
            canceled: 0,
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

export async function updateSweep(sweepId: string, request: UpdateSweepRequest): Promise<Sweep> {
    await delay(150)
    const sweep = mockSweeps.get(sweepId)
    if (!sweep) {
        throw new Error('Sweep not found')
    }

    if (request.base_command !== undefined) {
        const baseCommand = request.base_command
        sweep.base_command = baseCommand

        if (sweep.creation_context) {
            sweep.creation_context.command = baseCommand
        }
        if (sweep.ui_config && typeof sweep.ui_config === 'object') {
            ;(sweep.ui_config as Record<string, unknown>).command = baseCommand
            ;(sweep.ui_config as Record<string, unknown>).updatedAt = Date.now()
        }

        sweep.run_ids.forEach((runId) => {
            const run = mockRuns.get(runId)
            if (!run) return
            const params = run.sweep_params && typeof run.sweep_params === 'object'
                ? run.sweep_params
                : {}
            const paramStr = Object.entries(params).map(([k, v]) => `--${k}=${v}`).join(' ')
            run.command = paramStr ? `${baseCommand} ${paramStr}` : baseCommand
            mockRuns.set(runId, run)
        })
    }
    if (request.workdir !== undefined) sweep.workdir = request.workdir
    if (request.parameters !== undefined) sweep.parameters = request.parameters
    if (request.max_runs !== undefined) sweep.max_runs = request.max_runs
    if (request.goal !== undefined) sweep.goal = request.goal
    if (request.status !== undefined) sweep.status = request.status
    if (request.name !== undefined) sweep.name = request.name
    if (request.ui_config !== undefined) sweep.ui_config = request.ui_config

    mockSweeps.set(sweepId, sweep)
    return sweep
}

export async function startSweep(sweepId: string, parallel: number = 1): Promise<{ message: string }> {
    await delay(200)
    const sweep = mockSweeps.get(sweepId)
    if (!sweep) {
        throw new Error('Sweep not found')
    }
    sweep.status = 'running'
    sweep.started_at = sweep.started_at || Date.now() / 1000
    if (sweep.progress) {
        sweep.progress.queued = Math.max(0, (sweep.progress.queued || 0) - Math.min(parallel, sweep.run_ids.length))
        sweep.progress.running = Math.min(parallel, sweep.run_ids.length)
    }
    return { message: `Started ${Math.min(parallel, sweep.run_ids.length)} runs (mock)` }
}

// =============================================================================
// Cluster Management Functions
// =============================================================================

export async function getClusterStatus(): Promise<ClusterStatusResponse> {
    await delay(120)
    return buildClusterResponse()
}

export async function detectCluster(request?: ClusterDetectRequest): Promise<ClusterStatusResponse> {
    await delay(180)
    const preferredType = normalizeClusterType(request?.preferred_type)
    const detectedType: ClusterType = preferredType !== 'unknown'
        ? preferredType
        : (mockCluster.type === 'unknown' ? 'local_gpu' : mockCluster.type)

    const now = nowSeconds()
    mockCluster = {
        ...mockCluster,
        type: detectedType,
        status: 'healthy',
        source: preferredType !== 'unknown' ? 'manual' : 'detected',
        label: CLUSTER_TYPE_LABELS[detectedType],
        description: getClusterDescription(detectedType),
        confidence: preferredType !== 'unknown' ? 1 : 0.85,
        head_node: detectedType === 'shared_head_node' ? 'gpu-head-01' : (detectedType === 'local_gpu' ? 'local-host' : mockCluster.head_node),
        node_count: detectedType === 'local_gpu' ? 1 : (detectedType === 'slurm' ? 6 : detectedType === 'kubernetes' ? 4 : detectedType === 'shared_head_node' ? 5 : mockCluster.node_count),
        gpu_count: detectedType === 'kubernetes' ? 16 : detectedType === 'shared_head_node' ? 12 : detectedType === 'slurm' ? 32 : 4,
        details: {
            detected_by: preferredType !== 'unknown' ? 'user-selection' : 'mock-auto-detect',
            ...(mockCluster.details || {}),
        },
        last_detected_at: now,
        updated_at: now,
    }

    return buildClusterResponse()
}

export async function updateCluster(request: ClusterUpdateRequest): Promise<ClusterStatusResponse> {
    await delay(150)
    const now = nowSeconds()
    const nextType = request.type ? normalizeClusterType(request.type) : mockCluster.type

    mockCluster = {
        ...mockCluster,
        ...request,
        type: nextType,
        label: CLUSTER_TYPE_LABELS[nextType],
        description: getClusterDescription(nextType),
        source: request.source || 'manual',
        updated_at: now,
    }

    return buildClusterResponse()
}
