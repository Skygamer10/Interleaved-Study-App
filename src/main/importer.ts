// Document import: files or folders; .md/.txt natively, PDF (pdf.js) and DOCX (mammoth) best-effort.
// Unchanged files (same content hash) are never re-analyzed; changed files keep history where topics still match.
import fs from 'fs'
import path from 'path'
import type { Course, Doc, ImportResult, Job } from '../shared/types'
import { prepare } from './preprocess'
import { sha256 } from './organize'
import { uid, type Repo } from './repo'
import { courseCode } from '../shared/util'

export const TEXT_EXT = ['.md', '.markdown', '.txt']
export const BEST_EFFORT_EXT = ['.pdf', '.docx']
export const ALL_EXT = [...TEXT_EXT, ...BEST_EFFORT_EXT]
const BEST_EFFORT_NOTE = 'PDF and DOCX import is best effort. Markdown (.md) gives the cleanest topics.'

export function walk(paths: string[], maxDepth = 6): string[] {
  const out: string[] = []
  const visit = (p: string, depth: number): void => {
    let st: fs.Stats
    try { st = fs.statSync(p) } catch { return }
    if (st.isDirectory()) {
      if (depth > maxDepth) return
      for (const name of fs.readdirSync(p).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
        if (name.startsWith('.') || name === 'node_modules') continue
        visit(path.join(p, name), depth + 1)
      }
    } else if (ALL_EXT.includes(path.extname(p).toLowerCase())) out.push(p)
  }
  for (const p of paths) visit(p, 0)
  return [...new Set(out)]
}

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

export function htmlToMarkdown(html: string): string {
  return decodeEntities(
    html
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${'#'.repeat(Number(l))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${t.replace(/<[^>]+>/g, '').trim()}`)
      .replace(/<\/(p|ul|ol|table|tr)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<[^>]+>/g, '')
  ).replace(/\n{3,}/g, '\n\n').trim()
}

async function readPdf(file: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(file))
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise
  const lines: { text: string; h: number; gap: number }[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let cur = '', curH = 0, lastY: number | null = null, lastH = 0
    for (const it of content.items as { str?: string; transform?: number[]; height?: number; hasEOL?: boolean }[]) {
      if (typeof it.str !== 'string') continue
      const y = it.transform ? it.transform[5] : 0
      const h = Math.abs(it.height || (it.transform ? it.transform[3] : 0) || 0)
      if (lastY !== null && Math.abs(y - lastY) > Math.max(2, h * 0.5) && cur.trim()) {
        lines.push({ text: cur.trim(), h: curH, gap: Math.abs(lastY - y) - lastH })
        cur = ''
        curH = 0
      }
      cur += it.str
      curH = Math.max(curH, h)
      lastY = y
      lastH = h || lastH
      if (it.hasEOL && cur.trim()) { lines.push({ text: cur.trim(), h: curH, gap: 0 }); cur = ''; curH = 0 }
    }
    if (cur.trim()) lines.push({ text: cur.trim(), h: curH, gap: 0 })
    lines.push({ text: '', h: 0, gap: 0 }) // page break
    page.cleanup()
  }
  await doc.destroy()
  const hs = lines.filter((l) => l.text).map((l) => l.h).sort((a, b) => a - b)
  const median = hs.length ? hs[Math.floor(hs.length / 2)] : 10
  const out: string[] = []
  for (const l of lines) {
    if (!l.text) { out.push(''); continue }
    if (l.h >= median * 1.25 && l.text.length < 90 && !/[.,;]$/.test(l.text)) { out.push('', `${l.h >= median * 1.6 ? '#' : '##'} ${l.text}`, ''); continue }
    if (l.gap > median * 0.9) out.push('')
    out.push(l.text)
  }
  // Re-flow: join wrapped lines inside paragraphs
  return out.join('\n').split(/\n\s*\n/).map((p) => (p.startsWith('#') ? p.trim() : p.replace(/\n/g, ' ').trim())).filter(Boolean).join('\n\n')
}

async function readDocx(file: string): Promise<string> {
  const mammoth = await import('mammoth')
  const m = (mammoth as unknown as { default?: typeof mammoth }).default ?? mammoth
  const res = await m.convertToHtml({ buffer: fs.readFileSync(file) })
  return htmlToMarkdown(res.value)
}

export async function readDocument(file: string): Promise<{ text: string; note: string | null }> {
  const ext = path.extname(file).toLowerCase()
  if (TEXT_EXT.includes(ext)) return { text: fs.readFileSync(file, 'utf8'), note: null }
  if (ext === '.pdf') return { text: await readPdf(file), note: BEST_EFFORT_NOTE }
  if (ext === '.docx') return { text: await readDocx(file), note: BEST_EFFORT_NOTE }
  throw new Error(`Unsupported file type ${ext}. Use .md or .txt (PDF and DOCX are best effort).`)
}

/**
 * Import files and folders as lessons. With `courseId`, every new lesson goes into that course (the student named
 * it); without, courses are inferred from the files. Lessons imported before stay in their course either way.
 */
export async function importPaths(repo: Repo, paths: string[], confirm = false, courseId?: string | null): Promise<ImportResult> {
  const store = repo.store
  const res: ImportResult = { added: 0, unchanged: 0, replaced: 0, needsConfirm: [], errors: [], notes: [], docIds: [] }
  const target = courseId ? store.get<Course>('courses', courseId) : null
  if (courseId && !target) throw new Error('That course no longer exists.')
  const files = walk(paths)
  if (!files.length) {
    res.errors.push({ path: paths.join(', '), error: 'No .md, .txt, .pdf or .docx files found' })
    return res
  }
  // A folder whose files share one course code ("CHM110 - …") becomes that course; otherwise the folder name is used.
  const codes = new Map<string, Set<string>>()
  for (const f of files) {
    const c = courseCode(path.basename(f))
    if (!c) continue
    const dir = path.dirname(f)
    codes.set(dir, (codes.get(dir) ?? new Set()).add(c))
  }
  const courseFor = (file: string): string => {
    const dir = codes.get(path.dirname(file))
    return courseCode(path.basename(file)) ?? (dir?.size === 1 ? [...dir][0] : path.basename(path.dirname(file)))
  }
  let bestEffort = false
  for (const file of files) {
    let text: string, note: string | null
    try {
      ({ text, note } = await readDocument(file))
    } catch (e) {
      res.errors.push({ path: file, error: e instanceof Error ? e.message : String(e) })
      continue
    }
    if (note) bestEffort = true
    const prep = prepare(text)
    if (!prep.paras.length || prep.words < 5) {
      res.errors.push({ path: file, error: 'No readable text found (a scanned PDF needs OCR first).' })
      continue
    }
    const hash = sha256(prep.text)
    const docs = store.all<Doc>('docs')
    const existing = docs.find((d) => d.path === file)
    if (!existing) {
      const same = docs.find((d) => d.hash === hash)
      if (same) { res.unchanged++; continue }
    } else if (existing.hash === hash) {
      // Older records may lack stored paragraphs: store them now without touching topics.
      if (!repo.docPrep(existing.id)) repo.saveDocPrep(existing.id, { paras: prep.paras, outline: prep.outline })
      res.unchanged++
      continue
    }
    const now = Date.now()
    if (existing) {
      const withHistory = repo.historyCount(existing.id)
      if (withHistory > 0 && !confirm) {
        res.needsConfirm.push({ path: file, docId: existing.id, title: existing.title, withHistory })
        continue
      }
      store.tx(() => {
        for (const j of store.byParent<Job>('jobs', existing.id)) if (j.status !== 'running') store.del('jobs', j.id)
        for (const w of store.byParent<{ id: string }>('wins', existing.id)) store.del('wins', w.id)
        const doc: Doc = {
          ...existing, hash, words: prep.words, paraCount: prep.paras.length, status: 'awaiting', windows: 0, winsDone: 0,
          error: null, importNote: note, updatedAt: now
        }
        store.put('docs', doc)
        repo.saveDocPrep(doc.id, { paras: prep.paras, outline: prep.outline })
        const r = repo.replaceDocTopics(doc.id, repo.provisionalItems(doc, prep))
        if (r.dropped) store.put('docs', { ...doc, importNote: `${r.dropped} earlier topic(s) with history had no match in the new version.` })
      })
      res.replaced++
      res.docIds.push(existing.id)
      continue
    }
    const course = target ?? repo.ensureCourse(courseFor(file))
    const fileName = path.basename(file)
    const doc: Doc = {
      id: uid(), courseId: course.id, title: fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim(), fileName, path: file,
      ext: path.extname(file).slice(1).toLowerCase(), hash, words: prep.words, paraCount: prep.paras.length, windows: 0, winsDone: 0,
      status: 'awaiting', error: null, importNote: note, createdAt: now, updatedAt: now
    }
    store.tx(() => {
      store.put('docs', doc)
      repo.saveDocPrep(doc.id, { paras: prep.paras, outline: prep.outline })
      repo.replaceDocTopics(doc.id, repo.provisionalItems(doc, prep))
    })
    res.added++
    res.docIds.push(doc.id)
  }
  if (bestEffort) res.notes.push(BEST_EFFORT_NOTE)
  return res
}
