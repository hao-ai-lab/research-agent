// ── Agent Mailbox Tests ──

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import os from 'os'

import {
    createMailbox, sendMessage, sendSteer, queueTask,
    readInbox, writeOutbox, readOutbox,
    updateStatus, getStatus,
    registerAgent, unregisterAgent, loadRegistry,
    findAgentsByWorkspace, pollSignals,
    saveCursors, loadCursors,
} from '../lib/agent-mailbox.js'

const TEST_BASE = path.join(os.tmpdir(), `mailbox-test-${Date.now()}`)

before(() => {
    fs.mkdirSync(TEST_BASE, { recursive: true })
})

after(() => {
    fs.rmSync(TEST_BASE, { recursive: true, force: true })
})

describe('createMailbox', () => {
    it('creates inbox, outbox, and status files', () => {
        const result = createMailbox('test-agent', TEST_BASE)
        assert.ok(fs.existsSync(result.inbox))
        assert.ok(fs.existsSync(result.outbox))
        assert.ok(fs.existsSync(result.status))
    })
})

describe('sendMessage / readInbox', () => {
    before(() => createMailbox('msg-agent', TEST_BASE))

    it('sends a message and reads it back', () => {
        sendMessage('msg-agent', 'hello world', TEST_BASE)
        const { messages, totalLines } = readInbox('msg-agent', 0, TEST_BASE)
        assert.strictEqual(messages.length, 1)
        assert.strictEqual(messages[0].content, 'hello world')
        assert.strictEqual(totalLines, 1)
    })

    it('supports afterLine cursor for incremental reads', () => {
        sendMessage('msg-agent', 'second message', TEST_BASE)
        const { messages } = readInbox('msg-agent', 1, TEST_BASE)
        assert.strictEqual(messages.length, 1)
        assert.strictEqual(messages[0].content, 'second message')
    })
})

describe('sendSteer', () => {
    before(() => createMailbox('steer-agent', TEST_BASE))

    it('sends a [STEER]-tagged message', () => {
        sendSteer('steer-agent', 'change direction now', TEST_BASE)
        const { messages } = readInbox('steer-agent', 0, TEST_BASE)
        assert.strictEqual(messages.length, 1)
        assert.ok(messages[0].content.startsWith('[STEER]'))
        assert.ok(messages[0].content.includes('change direction now'))
    })
})

describe('queueTask', () => {
    before(() => createMailbox('queue-agent', TEST_BASE))

    it('queues an untagged task message', () => {
        queueTask('queue-agent', 'do this next', TEST_BASE)
        const { messages } = readInbox('queue-agent', 0, TEST_BASE)
        assert.strictEqual(messages.length, 1)
        assert.strictEqual(messages[0].content, 'do this next')
        assert.ok(!messages[0].content.startsWith('[STEER]'))
    })

    it('maintains FIFO order for queued tasks', () => {
        queueTask('queue-agent', 'task 2', TEST_BASE)
        queueTask('queue-agent', 'task 3', TEST_BASE)
        const { messages } = readInbox('queue-agent', 0, TEST_BASE)
        assert.strictEqual(messages.length, 3) // Includes the first one
        assert.strictEqual(messages[1].content, 'task 2')
        assert.strictEqual(messages[2].content, 'task 3')
    })
})

describe('writeOutbox / readOutbox', () => {
    before(() => createMailbox('outbox-agent', TEST_BASE))

    it('writes to outbox and reads back', () => {
        writeOutbox('outbox-agent', 'result data', TEST_BASE)
        const { messages, totalLines } = readOutbox('outbox-agent', 0, TEST_BASE)
        assert.strictEqual(messages.length, 1)
        assert.strictEqual(messages[0].content, 'result data')
        assert.strictEqual(messages[0].from, 'outbox-agent')
        assert.strictEqual(totalLines, 1)
    })
})

describe('status management', () => {
    before(() => createMailbox('status-agent', TEST_BASE))

    it('updates and reads status', () => {
        updateStatus('status-agent', { status: 'running', pid: 12345 }, TEST_BASE)
        const status = getStatus('status-agent', TEST_BASE)
        assert.strictEqual(status.status, 'running')
        assert.strictEqual(status.pid, 12345)
        assert.ok(status.updatedAt)
    })

    it('merges status updates', () => {
        updateStatus('status-agent', { turns: 5 }, TEST_BASE)
        const status = getStatus('status-agent', TEST_BASE)
        assert.strictEqual(status.status, 'running') // Preserved
        assert.strictEqual(status.turns, 5) // Added
    })
})

describe('registry', () => {
    it('registers and lists agents', () => {
        registerAgent('reg-1', { workspace: 'ws-a', task: 'task 1' }, TEST_BASE)
        registerAgent('reg-2', { workspace: 'ws-a', task: 'task 2' }, TEST_BASE)
        registerAgent('reg-3', { workspace: 'ws-b', task: 'task 3' }, TEST_BASE)

        const registry = loadRegistry(TEST_BASE)
        assert.strictEqual(Object.keys(registry.agents).length, 3)
    })

    it('finds agents by workspace', () => {
        const wsA = findAgentsByWorkspace('ws-a', TEST_BASE)
        assert.strictEqual(wsA.length, 2)
    })

    it('unregisters agents', () => {
        unregisterAgent('reg-3', TEST_BASE)
        const registry = loadRegistry(TEST_BASE)
        assert.strictEqual(Object.keys(registry.agents).length, 2)
    })
})

describe('pollSignals', () => {
    before(() => {
        createMailbox('signal-agent', TEST_BASE)
        registerAgent('signal-agent', { task: 'test' }, TEST_BASE)
    })

    it('detects outbox messages as signals', () => {
        writeOutbox('signal-agent', 'new output', TEST_BASE)
        const signals = pollSignals({}, TEST_BASE)
        const msgSignal = signals.find(s => s.type === 'agent_message')
        assert.ok(msgSignal)
        assert.strictEqual(msgSignal.agentId, 'signal-agent')
    })

    it('detects agent completion as signal', () => {
        updateStatus('signal-agent', { status: 'complete' }, TEST_BASE)
        const signals = pollSignals({ 'signal-agent': 1 }, TEST_BASE)
        const exitSignal = signals.find(s => s.type === 'agent_exit')
        assert.ok(exitSignal)
        assert.strictEqual(exitSignal.status, 'complete')
    })
})

describe('cursors', () => {
    it('saves and loads cursors', () => {
        saveCursors({ 'agent-1': 5, 'agent-2': 10 }, TEST_BASE)
        const loaded = loadCursors(TEST_BASE)
        assert.strictEqual(loaded['agent-1'], 5)
        assert.strictEqual(loaded['agent-2'], 10)
    })
})
