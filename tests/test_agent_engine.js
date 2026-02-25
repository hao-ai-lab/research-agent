// ── Agent Engine Tests ──

import { describe, it } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import { fileURLToPath } from 'url'

// We need to set cwd context for the tests
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')
process.chdir(PROJECT_ROOT)

import { loadSoul, loadSeed, listSeeds, createAgentFromSeed } from '../lib/agent-engine.js'

describe('loadSoul', () => {
    it('loads built-in soul template', () => {
        const soul = loadSoul('master', { agentId: 'test-master' })
        assert.ok(soul.includes('test-master'))
        assert.ok(soul.includes('Inbox Protocol'))
    })

    it('interpolates variables', () => {
        const soul = loadSoul('worker', { agentId: 'worker-42' })
        assert.ok(soul.includes('worker-42'))
        assert.ok(!soul.includes('{{agentId}}'))
    })

    it('removes unmatched placeholders', () => {
        const soul = loadSoul('master', {})
        assert.ok(!soul.includes('{{'))
    })

    it('throws on missing soul', () => {
        assert.throws(() => loadSoul('nonexistent'), /Soul not found/)
    })
})

describe('loadSeed', () => {
    it('loads researcher seed', () => {
        const seed = loadSeed('researcher')
        assert.ok(seed.soul.includes('researcher'))
        assert.ok(Array.isArray(seed.tools))
        assert.ok(seed.tools.includes('bash'))
        assert.strictEqual(seed.defaults.provider, 'anthropic')
    })

    it('loads debugger seed', () => {
        const seed = loadSeed('debugger')
        assert.ok(seed.soul.includes('debugging'))
        assert.ok(seed.tools.includes('readFile'))
        assert.strictEqual(seed.defaults.maxTurns, 20)
    })

    it('throws on missing seed', () => {
        assert.throws(() => loadSeed('nonexistent'), /Agent seed not found/)
    })
})

describe('listSeeds', () => {
    it('lists all available seeds', () => {
        const seeds = listSeeds()
        assert.ok(seeds.length >= 2)
        const names = seeds.map(s => s.name)
        assert.ok(names.includes('researcher'))
        assert.ok(names.includes('debugger'))
    })
})

describe('createAgentFromSeed', () => {
    it('creates an agent from researcher seed', () => {
        const { agent, seed, agentId } = createAgentFromSeed('researcher', {
            agentId: 'amy-1',
            context: 'Training DiT on A100',
        })
        assert.ok(agent)
        assert.strictEqual(agentId, 'amy-1')
        assert.ok(seed.tools.includes('bash'))
    })

    it('creates an agent from debugger seed with overrides', () => {
        const { agent, agentId } = createAgentFromSeed('debugger', {
            agentId: 'ken-debug-1',
        })
        assert.ok(agent)
        assert.strictEqual(agentId, 'ken-debug-1')
    })
})
