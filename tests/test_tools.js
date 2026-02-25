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
        const result = await bash.execute({ command: 'echo hello' })
        assert.strictEqual(result, 'hello')
    })

    it('returns error on failure', async () => {
        const bash = createBash({ workspaceDir: TEST_DIR })
        const result = await bash.execute({ command: 'exit 1' })
        assert.ok(result.startsWith('Error'))
    })

    it('times out long commands', async () => {
        const bash = createBash({ workspaceDir: TEST_DIR })
        const result = await bash.execute({ command: 'sleep 10', timeout: 1 })
        assert.ok(result.startsWith('Error'), `Expected error message, got: ${result}`)
    })

    it('runs in workspace directory', async () => {
        const bash = createBash({ workspaceDir: TEST_DIR })
        const result = await bash.execute({ command: 'pwd' })
        assert.ok(result.includes(TEST_DIR) || result.includes(path.basename(TEST_DIR)))
    })
})

describe('writeFile tool', () => {
    it('writes a file', async () => {
        const writeFile = createWriteFile({ workspaceDir: TEST_DIR })
        const result = await writeFile.execute({ filePath: 'test.txt', content: 'hello world' })
        assert.ok(result.includes('Written'))
        assert.strictEqual(fs.readFileSync(path.join(TEST_DIR, 'test.txt'), 'utf-8'), 'hello world')
    })

    it('creates parent directories', async () => {
        const writeFile = createWriteFile({ workspaceDir: TEST_DIR })
        await writeFile.execute({ filePath: 'sub/dir/file.txt', content: 'nested' })
        assert.ok(fs.existsSync(path.join(TEST_DIR, 'sub/dir/file.txt')))
    })
})

describe('readFile tool', () => {
    it('reads a file', async () => {
        fs.writeFileSync(path.join(TEST_DIR, 'read-test.txt'), 'read me')
        const readFile = createReadFile({ workspaceDir: TEST_DIR })
        const result = await readFile.execute({ filePath: 'read-test.txt' })
        assert.strictEqual(result, 'read me')
    })

    it('returns error for missing file', async () => {
        const readFile = createReadFile({ workspaceDir: TEST_DIR })
        const result = await readFile.execute({ filePath: 'nope.txt' })
        assert.ok(result.startsWith('Error'))
    })
})

describe('listFiles tool', () => {
    it('lists directory contents', async () => {
        const listFiles = createListFiles({ workspaceDir: TEST_DIR })
        const result = await listFiles.execute({ dirPath: '.' })
        assert.ok(result.includes('test.txt'))
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
