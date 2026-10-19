// Installs markitdown into vendor/markitdown (a private Python virtual environment) so spreadsheets can be converted
// to Markdown without any global install. Runs automatically before `npm run build` (the "prebuild" script) and is
// safe to run again: once the pinned version is installed it exits immediately. `npm run dist` copies the folder
// into the app bundle.
//
// The venv uses --copies (no symlinks) so it still works after being copied into the .app. It needs Python 3.10+
// on the build machine; without one, it prints how to get it and the build continues (the app then uses its
// built-in converter). Set SKIP_MARKITDOWN=1 to skip, or PYTHON=/path/to/python3 to choose the interpreter.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKITDOWN_SPEC = 'markitdown[xlsx,xls]==0.1.8'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const venv = path.join(root, 'vendor', 'markitdown')
const python = path.join(venv, 'bin', 'python')
const stamp = path.join(venv, '.installed')

const log = (m) => console.log(`[markitdown] ${m}`)

function works(py) {
  try {
    execFileSync(py, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function findPython() {
  const names = ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10']
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/Library/Frameworks/Python.framework/Versions/Current/bin', '/usr/bin']
  const candidates = [process.env.PYTHON, ...dirs.flatMap((d) => names.map((n) => path.join(d, n)))].filter(Boolean)
  for (const c of [...new Set(candidates)]) if (fs.existsSync(c) && works(c)) return c
  return null
}

function main() {
  if (process.env.SKIP_MARKITDOWN) { log('SKIP_MARKITDOWN is set; skipping.'); return }
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === MARKITDOWN_SPEC && fs.existsSync(python) && works(python)) {
    log(`ready (${MARKITDOWN_SPEC}) in vendor/markitdown`)
    return
  }
  const base = findPython()
  if (!base) {
    log('Python 3.10 or newer was not found, so markitdown was not installed.')
    log('Install Python (for example `brew install python`), then run `npm run setup:markitdown`.')
    log('The build continues; the app will use its built-in spreadsheet converter until then.')
    return
  }
  log(`installing ${MARKITDOWN_SPEC} with ${base} (first build only; this downloads about 100 MB)…`)
  fs.rmSync(venv, { recursive: true, force: true })
  execFileSync(base, ['-m', 'venv', '--copies', venv], { stdio: 'inherit' })
  execFileSync(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', MARKITDOWN_SPEC], { stdio: 'inherit' })
  execFileSync(python, ['-c', 'import markitdown'], { stdio: 'inherit' })
  fs.writeFileSync(stamp, MARKITDOWN_SPEC + '\n')
  log('installed in vendor/markitdown')
}

try {
  main()
} catch (e) {
  // Never fail the build over markitdown: the app falls back to its built-in converter.
  log(`setup failed: ${e instanceof Error ? e.message : String(e)}`)
  log('The build continues. Run `npm run setup:markitdown` to try again.')
  fs.rmSync(stamp, { force: true })
}
