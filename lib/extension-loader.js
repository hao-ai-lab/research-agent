// ── Extension Loader — scan extensions/ and register tools ──

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const EXTENSIONS_DIR = path.join(path.resolve(__dirname, '..'), 'extensions')

/**
 * Load all extensions from extensions/ directory.
 * Each extension folder must have a manifest.json.
 * Optional: tools.js (exports createXTools function).
 */
export async function loadExtensions() {
    const extensions = []

    if (!fs.existsSync(EXTENSIONS_DIR)) return extensions

    for (const entry of fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue

        const extDir = path.join(EXTENSIONS_DIR, entry.name)
        const manifestPath = path.join(extDir, 'manifest.json')

        if (!fs.existsSync(manifestPath)) continue

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
            const ext = { name: manifest.name || entry.name, manifest, dir: extDir, tools: [] }

            // Load tools if available
            const toolsPath = path.join(extDir, 'tools.js')
            if (fs.existsSync(toolsPath)) {
                const mod = await import(toolsPath)
                // Convention: export a function named create{Name}Tools
                for (const [key, fn] of Object.entries(mod)) {
                    if (typeof fn === 'function' && key.startsWith('create')) {
                        ext.toolFactory = fn
                        break
                    }
                }
            }

            extensions.push(ext)
            console.log(`  📦 Extension loaded: ${ext.name} (${manifest.provides?.tools?.length || 0} tools)`)
        } catch (err) {
            console.warn(`  ⚠️  Failed to load extension ${entry.name}: ${err.message}`)
        }
    }

    return extensions
}

/**
 * Instantiate tools from loaded extensions.
 */
export function instantiateExtensionTools(extensions, ctx = {}) {
    const tools = []
    for (const ext of extensions) {
        if (ext.toolFactory) {
            const extTools = ext.toolFactory(ctx)
            tools.push(...(Array.isArray(extTools) ? extTools : [extTools]))
        }
    }
    return tools
}
