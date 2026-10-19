import fs from 'fs'
import os from 'os'
import path from 'path'
import { JsonStore } from '../src/main/store/json'
import { Repo } from '../src/main/repo'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { Settings } from '../src/shared/types'

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'istudy-'))
}

export function setup(over: Partial<Settings['ai']> = {}, dir = tmpDir()): { dir: string; store: JsonStore; repo: Repo; settings: Settings } {
  const store = new JsonStore(path.join(dir, 'store.json'), 5)
  const settings: Settings = structuredClone(DEFAULT_SETTINGS)
  Object.assign(settings.ai, { windowTokens: 1000 }, over)
  const repo = new Repo(store, () => settings)
  return { dir, store, repo, settings }
}

export function lessonMarkdown(sections = 6): string {
  const out: string[] = ['# Cell transport']
  for (let s = 0; s < sections; s++) {
    out.push(`## Topic heading ${String.fromCharCode(65 + s)} about membranes`)
    for (let p = 0; p < 4; p++) {
      out.push(`Membrane ${s}-${p} transport moves molecules across the lipid bilayer by diffusion, osmosis and pumps. ` + `Detail sentence ${p} about gradients and channels. `.repeat(8))
    }
  }
  return out.join('\n\n')
}

export function writeLesson(dir: string, course = 'Biology', name = 'Lesson 1.md', sections = 6): string {
  const d = path.join(dir, course)
  fs.mkdirSync(d, { recursive: true })
  const f = path.join(d, name)
  fs.writeFileSync(f, lessonMarkdown(sections))
  return f
}
