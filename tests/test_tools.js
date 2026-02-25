// ── Tool Tests ──

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import os from 'os'

import {
    createBash, createReadFile, createWriteFile, createListFiles,
    createCodingTools, discoverTools,
} from '../lib/tools/index.js'

const TEST_DIR = path.join(os.tmpdir(), `tools-test-${Date.now()}`)

before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
})

after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('bash tool', () => {
    it('executes a simple command', async () => {
        const bash = createBash({ workspaceDir: TEST_DIR })
        const result = await bash.execute('call-1', { command: 'echo hello' })
        assert.ok(result.content[0].text.includes('hello'))
        assert.strictEqual(result.details.exitCode, 0)
    })

    it('returns error on failure', async () => {
        const bash = createBash({ workspaceDir: TEST_DIR })
        const result = await bash.execute('call-2', { command: 'exit 1' })
        assert.ok(result.content[0].text.includes('Exit code'))
    })

    it('times out long commands', async () => {
        const bash = createBash({ workspaceDir: TEST_DIR })
        const result = await bash.execute('call-3', { command: 'sleep 10', timeout: 1 })
        assert.ok(result.content[0].text.includes('Exit code') || result.details.killed)
    })

    it('runs in workspace directory', async () => {
        const bash = createBash({ workspaceDir: TEST_DIR })
        const result = await bash.execute('call-4', { command: 'pwd' })
        assert.ok(result.content[0].text.includes(path.basename(TEST_DIR)) || result.content[0].text.includes(TEST_DIR))
    })

    it('has label and TypeBox parameters', () => {
        const bash = createBash({ workspaceDir: TEST_DIR })
        assert.strictEqual(bash.label, 'Bash')
        assert.ok(bash.parameters)
    })
})

describe('writeFile tool', () => {
    it('writes a file', async () => {
        const writeFile = createWriteFile({ workspaceDir: TEST_DIR })
        const result = await writeFile.execute('call-5', { filePath: 'test.txt', content: 'hello world' })
        assert.ok(result.content[0].text.includes('Written'))
        assert.strictEqual(fs.readFileSync(path.join(TEST_DIR, 'test.txt'), 'utf-8'), 'hello world')
    })

    it('creates parent directories', async () => {
        const writeFile = createWriteFile({ workspaceDir: TEST_DIR })
        await writeFile.execute('call-6', { filePath: 'sub/dir/file.txt', content: 'nested' })
        assert.ok(fs.existsSync(path.join(TEST_DIR, 'sub/dir/file.txt')))
    })
})

describe('readFile tool', () => {
    it('reads a file', async () => {
        fs.writeFileSync(path.join(TEST_DIR, 'read-test.txt'), 'read me')
        const readFile = createReadFile({ workspaceDir: TEST_DIR })
        const result = await readFile.execute('call-7', { filePath: 'read-test.txt' })
        assert.strictEqual(result.content[0].text, 'read me')
    })

    it('returns error for missing file', async () => {
        const readFile = createReadFile({ workspaceDir: TEST_DIR })
        const result = await readFile.execute('call-8', { filePath: 'nope.txt' })
        assert.ok(result.content[0].text.startsWith('Error'))
    })
})

describe('listFiles tool', () => {
    it('lists directory contents', async () => {
        const listFiles = createListFiles({ workspaceDir: TEST_DIR })
        const result = await listFiles.execute('call-9', { dirPath: '.' })
        assert.ok(result.content[0].text.includes('test.txt'))
    })
})

describe('tool composers', () => {
    it('createCodingTools returns 4 tools', () => {
        const tools = createCodingTools({ workspaceDir: TEST_DIR })
        assert.strictEqual(tools.length, 4)
        const names = tools.map(t => t.name)
        assert.ok(names.includes('bash'))
        assert.ok(names.includes('readFile'))
        assert.ok(names.includes('writeFile'))
        assert.ok(names.includes('listFiles'))
        // All should have labels
        tools.forEach(t => assert.ok(t.label, `${t.name} missing label`))
    })
})

describe('discoverTools', () => {
    it('returns human-readable tool summary', () => {
        const summary = discoverTools()
        assert.ok(summary.includes('[coding]'))
        assert.ok(summary.includes('bash'))
        assert.ok(summary.includes('[communication]'))
    })

    it('filters by category', () => {
        const summary = discoverTools(['coding'])
        assert.ok(summary.includes('[coding]'))
        assert.ok(!summary.includes('[communication]'))
    })
})
