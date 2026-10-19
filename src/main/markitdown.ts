// Runs Microsoft's markitdown (a Python CLI) to turn spreadsheets into Markdown before the AI reads them.
// Order: the command set in Settings, then the copy that `npm run build` installs into vendor/markitdown (bundled
// into the packaged app), then a global install. Apps opened from Finder get a minimal PATH, so the usual pipx,
// Homebrew and pip --user locations are searched too.
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface MdCommand { cmd: string; args: string[]; label: string }

export const INSTALL_HINT = "run `npm run setup:markitdown` in the project folder, or `pipx install 'markitdown[xlsx,xls]'`"

function searchDirs(): string[] {
  const home = os.homedir()
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(home, '.local', 'bin'), // pipx, uv tool
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'
  ]
  // pip install --user puts scripts in ~/Library/Python/3.x/bin on macOS
  const userPy = path.join(home, 'Library', 'Python')
  try { for (const v of fs.readdirSync(userPy)) dirs.push(path.join(userPy, v, 'bin')) } catch { /* none */ }
  return [...new Set(dirs.filter(Boolean))]
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: searchDirs().join(path.delimiter), PYTHONIOENCODING: 'utf-8' }
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout, stderr })
    })
  })
}

// Only successful lookups are cached, so installing markitdown while the app runs is picked up on the next import.
let cached: { key: string; found: MdCommand } | null = null

/** A venv made by scripts/setup-markitdown.mjs: run through its own python so the script's shebang never matters. */
function bundled(dir: string): MdCommand | null {
  const py = path.join(dir, 'bin', 'python')
  return isExecutable(py) && fs.existsSync(path.join(dir, '.installed')) ? { cmd: py, args: ['-m', 'markitdown'], label: `bundled markitdown (${dir})` } : null
}

/**
 * Find markitdown. `configured` (from Settings) may be a path or command name; blank means search.
 * `bundledDirs` are where the build puts its private copy. Falls back to `python3 -m markitdown` when the package
 * is installed globally without its script on PATH.
 */
export async function findMarkitdown(configured = '', bundledDirs: string[] = []): Promise<MdCommand | null> {
  const key = [configured.trim(), ...bundledDirs].join('\n')
  if (cached && cached.key === key && isExecutable(cached.found.cmd)) return cached.found
  let found: MdCommand | null = null
  const resolveCmd = (c: string): string | null => {
    if (c.includes('/')) return isExecutable(c.replace(/^~(?=\/)/, os.homedir())) ? c.replace(/^~(?=\/)/, os.homedir()) : null
    for (const d of searchDirs()) if (isExecutable(path.join(d, c))) return path.join(d, c)
    return null
  }
  if (configured.trim()) {
    const p = resolveCmd(configured.trim())
    if (p) found = { cmd: p, args: [], label: p }
  } else {
    for (const d of bundledDirs) { found = bundled(d); if (found) break }
  }
  if (!found && !configured.trim()) {
    const p = resolveCmd('markitdown')
    if (p) found = { cmd: p, args: [], label: p }
    else {
      for (const py of ['python3', 'python']) {
        const pp = resolveCmd(py)
        if (!pp) continue
        try {
          await run(pp, ['-c', 'import markitdown'], 15000)
          found = { cmd: pp, args: ['-m', 'markitdown'], label: `${pp} -m markitdown` }
          break
        } catch { /* not installed for this python */ }
      }
    }
  }
  if (found) cached = { key, found }
  return found
}

/** Convert one file to Markdown with markitdown. Throws with markitdown's own error text on failure. */
export async function markitdownConvert(c: MdCommand, file: string): Promise<string> {
  try {
    const { stdout } = await run(c.cmd, [...c.args, file], 120000)
    return stdout
  } catch (e) {
    const err = e as Error & { stderr?: string; killed?: boolean }
    if (err.killed) throw new Error('markitdown took longer than 2 minutes')
    const lines = (err.stderr || err.message).trim().split('\n').filter(Boolean)
    throw new Error(lines[lines.length - 1]?.slice(0, 300) || 'markitdown failed')
  }
}
