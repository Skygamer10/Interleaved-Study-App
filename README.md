# Interleaved Study

A macOS desktop app for **interleaved practice with spaced repetition**, built from your own lesson documents.

Drop in your notes, slides exported to PDF, or Word documents. Interleaved Study uses the AI provider you choose to split them into study topics: **Google Gemini** (which has a free tier), **Anthropic Claude** or **OpenAI (ChatGPT)**. It then schedules timed or Pomodoro sessions that mix topics across courses. Each topic is rescheduled from your self-ratings and optional quizzes. Your data stays on your machine. The only network traffic goes to the provider you selected, using your own API key.

Built with Electron, React, TypeScript and SQLite.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Choosing an AI provider](#choosing-an-ai-provider)
- [Importing deadlines from a spreadsheet](#importing-deadlines-from-a-spreadsheet)
- [Scripts](#scripts)
- [Building the macOS app](#building-the-macos-app)
- [Testing without spending tokens](#testing-without-spending-tokens)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [Data, privacy and backups](#data-privacy-and-backups)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Features

**Import and organize**
- Import single files or whole folders: `.md`, `.markdown` and `.txt` are read natively. `.pdf` (via pdf.js) and `.docx` (via mammoth) are best-effort.
- Free local preprocessing: normalizes text, strips junk, numbers paragraphs, detects headings and creates provisional topics before any AI call.
- The AI organizes each lesson into named topics with a summary, key terms, prerequisites and difficulty. The model never rewrites your text; topic ranges point back to your original paragraphs.
- Re-importing a changed file keeps study history wherever the topics still match. Unchanged files (same content hash) are never re-analyzed.

**Study sessions**
- **Timed** and **Pomodoro** modes, with configurable work, break and long-break lengths and number of cycles.
- Interleaving: the next block is suggested from topics across courses, and you can accept it or override it.
- The main process keeps the timer, so hiding the window, sleep, a restart or a crash never loses a session.
- A countdown in the menu bar, native notifications with a choice of macOS sounds, and a dock bounce and badge.

**Spaced repetition and mastery**
- An FSRS-lite scheduler. Rate each block as *lost*, *shaky*, *okay* or *solid*. When you also take a quiz, its score counts double.
- On-demand quizzes per topic, built only from that topic's text and cached. Multiple choice is scored locally. Short answers are self-marked or graded by the AI.
- Manual overrides for each topic: mastery, "mark solid", rename, split and delete.

**Planning and progress**
- A flexible daily goal (minutes or topics) and a streak that allows rest days.
- Deadlines shown as an agenda and a month calendar in the style of Apple Calendar and Google Calendar:
  - Weeks start on the day your system locale uses. Weekends are shaded, today is circled, and the first of each month is labelled "Nov 1".
  - Deadlines appear as chips colored by course. Click a chip to edit it; "N more" opens a card with the whole day.
  - Double-click a day, or hover over it and click "+", to add a deadline on that date. Minutes studied show in each day's corner.
- **Spreadsheet import with AI:** pick an `.xlsx`, `.xls` or `.csv` file. [markitdown](https://github.com/microsoft/markitdown) converts it to Markdown, then the AI finds every dated item (title, date, course and notes) and puts it on the calendar after you review the list. See [Importing deadlines from a spreadsheet](#importing-deadlines-from-a-spreadsheet).
- If you prefer, **Map columns manually** imports the same file without AI, with a preview and row validation.
- Progress charts: time per course and topic, daily minutes, mastery over time, what's due today and recent reviews.

**Your choice of AI provider**
- A provider dropdown in Settings: **Google Gemini**, **Anthropic Claude** or **OpenAI (ChatGPT)**.
- Choosing a provider swaps in its own model list. The app also remembers the last model you used with each provider.
- Each provider keeps its own Keychain-encrypted key, so you can switch back and forth without pasting keys again.
- Gemini has a free API tier, so you can use the app without paying anything.

**A careful AI queue**
- One persisted queue that sends one request at a time, as fast as the provider allows. There are no rate-limit settings to configure.
- **When the provider's rate limit is reached, everything pauses at once.** You get a macOS notification and a banner on every page with the provider's message and, when the provider gives one, how long to wait. **Continue** picks up exactly where it stopped. See [When you hit a rate limit](#when-you-hit-a-rate-limit).
- Exponential backoff that honors `Retry-After` on 5xx and network errors, one repair retry for malformed JSON, and a result cache.
- An estimate before every run, live progress, pause/resume, and retry for failed jobs.
- "Test model" checks whether a model supports system instructions, JSON mode and minimal thinking (low effort on Claude and OpenAI), and remembers the result for that model. For Claude it also checks the server-side refusal fallback.

---

## Requirements

| Requirement | Version / notes |
|---|---|
| macOS | Apple Silicon (arm64). The packaging config targets `arm64` only. |
| Node.js | 20 or newer (developed on Node 22) |
| npm | 10 or newer |
| Xcode Command Line Tools | Needed only if `better-sqlite3` has to be compiled from source: `xcode-select --install` |
| Python 3.10+ (recommended) | Lets the first `npm run build` install [markitdown](https://github.com/microsoft/markitdown) into the project automatically. markitdown converts deadline spreadsheets to Markdown for the AI. macOS doesn't include a new enough Python, so install one with `brew install python`. Without it, the app uses a built-in converter. |
| An API key for one provider | Google Gemini (free tier available), Anthropic Claude, or OpenAI. See [Choosing an AI provider](#choosing-an-ai-provider). |

> The code is mostly cross-platform Electron, but the tray, dock, Keychain and notification features are designed for macOS. Other platforms are untested.

---

## Getting started

```bash
# 1. Clone
git clone https://github.com/Skygamer10/interleaved-study.git
cd interleaved-study

# 2. Install dependencies
#    (postinstall rebuilds better-sqlite3 for Electron's Node version automatically)
npm install

# 3. Build once: this also installs markitdown into vendor/markitdown (needs Python 3.10+)
npm run build

# 4. Run in development mode with hot reload
npm run dev
```

The first `npm run build` downloads markitdown and its dependencies (about 100 MB, roughly 250 MB on disk) into `vendor/markitdown`, a private Python environment inside the project. Later builds see it's already installed and skip this step. `vendor/` is git-ignored.

On first launch:

1. Open **Settings** (`⌘,`), choose a provider under **AI provider**, and paste that provider's API key. If you don't have a key yet, Gemini is free.
2. Pick a model from the list (it matches the provider you chose) and click **Test model**.
3. Go to **Board** (`⌘1`), then drag in a file or folder, or use **Import**.
4. Review the AI estimate and start organizing. You can follow progress on the **Queue** page (`⌘5`).
5. Start a session from **Session** (`⌘2`), or press `⌘⇧S` for the next suggested session.

---

## Choosing an AI provider

Open **Settings → AI provider** and pick one from the dropdown. The model list under **Model** changes to match. Each provider keeps its own key, so you can save keys for all three and switch whenever you like.

| Provider | Where to get a key | Cost | Default model | Other presets |
|---|---|---|---|---|
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | **Free tier available**, no credit card needed | `gemma-4-31b-it` | `gemma-4-26b-a4b-it`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-flash-latest` |
| **Anthropic Claude** | [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys) | Pay per token | `claude-opus-5-5` | `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1` |
| **OpenAI (ChatGPT)** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Pay per token | `gpt-6-luna` | `gpt-6.1-sol`, `gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-luna` |

You can also type any other model ID that your key can use.

### Gemini has a free tier

If you just want to try the app, start with Gemini. Create a key in Google AI Studio with a Google account; no billing setup is needed. The free tier has lower rate limits, and the Gemma models are free tier only. Settings shows the same note under the Gemini key field. On privacy, Google says content sent on the paid tier is not used to improve its products, which implies free-tier content may be.

### Claude and ChatGPT subscriptions are not API keys

A Claude.ai Pro/Max plan or a ChatGPT Plus/Pro plan does **not** include API access. Claude API keys come from the Claude Console and OpenAI keys from the OpenAI Platform. Both are billed per token, separately from any chat subscription.

- **Claude** is called through the official [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) (Messages API). Requests ask for low effort to save tokens. On `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1`, the app also turns on Anthropic's server-side refusal fallback, so a request one model declines is retried on another Claude model instead of failing. For organizing many lessons, `claude-haiku-5-5` costs much less than the default Opus model.
- **OpenAI** is called through the Responses API with JSON mode and low reasoning effort. Requests are sent with `store: false`, so OpenAI keeps no copy of the conversation.

### When you hit a rate limit

There are no rate-limit settings. The app sends one request at a time, as fast as the provider accepts them. When the provider answers that you've hit its limit (HTTP 429):

1. **Everything pauses immediately.** Nothing is retried in a loop, so no requests are wasted.
2. **You're told:** a macOS notification, a banner on every page, and a "rate limit · paused" badge in the title bar. The banner shows the provider's own message (per-minute limit, daily quota, billing problem) and, if the provider said how long to wait, a countdown.
3. **Click Continue** whenever you're ready. The queue picks up exactly where it stopped:
   - The request that hit the limit goes back in the queue unchanged, without counting as a failed attempt.
   - Finished work is kept: completed organizing windows are stored, and every finished request is cached, so nothing is sent twice.
   - A quiz, grading or deadline import you were waiting on finishes on its own after you click Continue.
   - The pause survives quitting the app. After a relaunch the banner is still there and Continue works the same way.

If the limit hasn't reset yet when you click Continue, the app pauses again and tells you. Nothing is lost either way. On Gemini's free tier, per-minute limits are low, so expect to click Continue now and then while organizing large lessons.

### Where keys are stored

Keys are encrypted with Electron `safeStorage` (backed by the macOS Keychain). Each provider has its own file in the app's data folder: `api-key.bin` (Gemini), `api-key-anthropic.bin` and `api-key-openai.bin`. Keys are never written to the repository, never sent to the renderer process, and never included in backups.

---

## Importing deadlines from a spreadsheet

On the **Plan** page (`⌘3`), click **Import .xlsx or .csv** and pick a file. From there:

1. **markitdown converts the file to Markdown.** Each sheet becomes a `## Sheet name` heading followed by a table.
2. **The AI reads the Markdown** and returns every dated item as a title, a `YYYY-MM-DD` date, a course and notes. Large sheets are split into parts of about 60 rows. Each part repeats its sheet name and column headers, so the model always knows what the columns mean. The prompt includes today's date, so a date without a year gets the closest matching year. It also includes your course names, so deadlines link to the right course.
3. **You review the list**, untick anything you don't want, and click **Import**. Deadlines you already have are unticked, and re-importing the same sheet never creates duplicates.

The request goes through the same queue and cache as everything else (including the rate-limit pause and Continue), using the provider and model selected in Settings. If the AI isn't available (no key, or an error), **Map columns manually** imports the same file without AI.

### How markitdown is installed

markitdown is Microsoft's open-source Python tool. You don't install it yourself: **the first `npm run build` does it**, via the `prebuild` step (`scripts/setup-markitdown.mjs`):

- It finds a Python 3.10+ on your machine (Homebrew, python.org or `PATH`; set `PYTHON=/path/to/python3` to choose one).
- It creates a private virtual environment in `vendor/markitdown` and installs the pinned `markitdown[xlsx,xls]==0.1.8` into it.
- Later builds check that it's still installed and skip the step. To install or repair it without building, run `npm run setup:markitdown`.
- If Python is missing or the install fails, the script prints what to do and the build **continues**. The app then uses its built-in converter.
- Set `SKIP_MARKITDOWN=1` to skip the step entirely (for example in CI).

`npm run dev` and `npm start` use `vendor/markitdown` from the project folder. `npm run dist` copies it into the app at `Interleaved Study.app/Contents/Resources/markitdown`, so the packaged app has markitdown built in.

The app picks markitdown in this order:
1. A command set in **Settings → Deadline spreadsheets → markitdown command**.
2. The bundled copy.
3. A global install: `PATH`, `~/.local/bin` (pipx), `/opt/homebrew/bin`, `/usr/local/bin`, `~/Library/Python/*/bin`, or `python3 -m markitdown`.

Settings shows which one is in use.

If markitdown isn't installed or fails on a file, the app converts the spreadsheet itself into the same Markdown layout and says so in the import window. The AI step works either way.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the app in development mode (electron-vite, with hot reload for the renderer) |
| `npm run build` | Compile main, preload and renderer into `out/`. Runs `prebuild` first, which installs markitdown into `vendor/markitdown` the first time |
| `npm run setup:markitdown` | Install or repair the private markitdown copy without building |
| `npm start` | Preview the built app from `out/` |
| `npm run typecheck` | Type-check the whole project with `tsc --noEmit` |
| `npm test` | Run the Vitest suite once |
| `npm run mock-ai` | Start the mock AI server (Gemini, Claude and OpenAI routes) on `http://127.0.0.1:8787` (set `PORT` to change it) |
| `npm run dist` | Run `npm run build`, then package a macOS arm64 `.app` with markitdown bundled into `dist/` |

---

## Building the macOS app

```bash
npm run dist
```

This writes `dist/mac-arm64/Interleaved Study.app` (about 530 MB, most of it the bundled markitdown and its Python libraries). Drag it into `/Applications`.

The bundled markitdown still uses the Python that built it (for example Homebrew's). The `.app` works on the machine that built it, and on Macs with the same Python installed at the same path. If that Python is removed or upgraded, rebuild with `npm run dist`. Until then, the app falls back to a global markitdown or its built-in converter.

The app isn't signed with a Developer ID and isn't notarized. The first time you open it, macOS Gatekeeper may block it. To open it anyway, right-click the app, choose **Open**, then **Open** again. Or run:

```bash
xattr -dr com.apple.quarantine "/Applications/Interleaved Study.app"
```

To distribute builds publicly, add a Developer ID certificate and notarization to the `build.mac` section of `package.json`.

---

## Testing without spending tokens

The test suite runs entirely offline: **12 test files, 101 tests**. One test runs the real markitdown from `vendor/markitdown` (after `npm run build`) or a global install, and is skipped when neither exists. To point it at a specific install, set `MARKITDOWN_PATH`:

```bash
MARKITDOWN_PATH=~/.local/bin/markitdown npm test
```

```bash
npm test
```

`scripts/mock-ai-server.mjs` is one fake server for all three providers. It answers Gemini (`generateContent` and Interactions), Anthropic (`/v1/messages`) and OpenAI (`/v1/responses`) requests with plausible organize, quiz and grade answers. It can be scripted to fail with 429 + `Retry-After`, 5xx errors, invalid JSON, or HTTP 400 when a request uses JSON mode, thinking or effort, or Claude's refusal fallback. The tests start it on a random port.

To try the app by hand against the mock:

```bash
npm run mock-ai   # terminal 1, listens on http://127.0.0.1:8787
npm run dev       # terminal 2
```

Then in **Settings**, choose any provider, set **Model → Base URL (advanced)** to `http://127.0.0.1:8787`, and save any non-empty API key. Clear the field afterwards to go back to the official endpoint.

| Test file | Covers |
|---|---|
| `sched.test.ts` | Scheduler, stability, mastery and status |
| `preprocess.test.ts` | Normalization, paragraphs, headings and windows |
| `organize.test.ts` | Range validation and repair, merging, de-duplication |
| `importer.test.ts` | PDF and DOCX extraction (fixtures in `tests/fixtures/`) |
| `queue.test.ts` | AI queue against the mock server: rate-limit pause and seamless Continue (including after a restart), backoff, fallbacks, cache |
| `providers.test.ts` | Claude and OpenAI adapters (including a Claude rate-limit pause), per-provider settings, and migration of old settings |
| `session.test.ts` | Timer engine and recovery |
| `history.test.ts` | Carrying study history over on re-import |
| `deadlineMap.test.ts` | Spreadsheet column mapping and date parsing |
| `calendar.test.ts` | Month-view weeks (locale week start, daylight-saving safety), course colors, "N more" |
| `deadlines.test.ts` | Spreadsheet → Markdown chunking, AI deadline extraction and validation, markitdown conversion |
| `layout.test.ts` | Board layout (sections, folders, ordering) |

---

## Project structure

```
interleaved-study/
├── build/                    # electron-builder resources (app icon)
├── resources/                # Runtime assets bundled with the app (menu-bar tray icons)
├── scripts/
│   ├── mock-ai-server.mjs    # Offline fake Gemini/Claude/OpenAI API for tests and manual trials
│   └── setup-markitdown.mjs  # Installs markitdown into vendor/markitdown (runs before npm run build)
├── src/
│   ├── main/                 # Electron main process (Node)
│   │   ├── index.ts          # App entry: window, tray, menu, IPC handlers, notifications
│   │   ├── importer.ts       # File/folder import (md, txt, pdf, docx)
│   │   ├── preprocess.ts     # Local zero-token text processing
│   │   ├── organize.ts       # AI prompts and topic validation/repair
│   │   ├── jobs.ts           # Queue job handlers: organize, dedupe, enrich, quiz, grade, deadlines
│   │   ├── queue.ts          # Persisted AI request queue; pauses on rate limits, Continue resumes
│   │   ├── backoff.ts        # Exponential backoff with jitter
│   │   ├── session.ts        # Study session / Pomodoro engine
│   │   ├── history.ts        # Study-history carry-over between imports
│   │   ├── markitdown.ts     # Finds and runs markitdown for spreadsheet → Markdown
│   │   ├── deadlines.ts      # Markdown chunking, AI deadline prompt and validation
│   │   ├── repo.ts           # Domain operations on top of the store
│   │   ├── ai/               # Provider adapters (Gemini, Claude, OpenAI), JSON extraction, model test
│   │   └── store/            # SQLite store (preferred) and JSON-file fallback
│   ├── preload/              # contextBridge: exposes the typed API to the renderer
│   ├── renderer/             # React UI
│   │   ├── index.html
│   │   └── src/
│   │       ├── views/        # Board, Session, Plan, Progress, Queue, Settings, Inspector
│   │       └── components/   # Calendar, Quiz, Ribbon, ImportFlow, BoardCustomize
│   └── shared/               # Code shared by all processes: types, scheduler, defaults, utils
├── tests/                    # Vitest suites and fixtures
├── vendor/markitdown/        # Private markitdown install, created by the first build (git-ignored)
├── electron.vite.config.ts
├── tsconfig.json
├── vitest.config.mts
└── package.json
```

Generated folders, which are git-ignored: `node_modules/`, `out/` (compiled app), `dist/` (packaged app) and `vendor/` (markitdown).

---

## How it works

```
 Files ──► importer ──► preprocess (local, free) ──► provisional topics
                                   │
                                   ▼
                     AI queue ─► provider adapter ─► Gemini API
                     (persisted,                  ├► Claude Messages API
                      cache, pause                └► OpenAI Responses API
                      on HTTP 429)
                                   │
                                   ▼
                organize: validated topic ranges, summaries, terms
                                   │
                                   ▼
        Board ◄──► Session engine ──► reviews ──► FSRS-lite scheduler

 Spreadsheet ──► markitdown ──► Markdown chunks ──► AI queue ──► review ──► Plan calendar
              (or built-in converter)
```

- **Process model.** The main process owns the database, the API key, the AI queue and the session timer. The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`). It talks to the main process only through the typed API in `src/shared/api.ts`, which the preload script exposes.
- **Storage.** SQLite through `better-sqlite3`, with WAL and FTS5. Raw document text is kept in its own table, so list queries never load it. If the native module can't load, the app falls back to a JSON-file store and shows the reason in Settings.
- **Scheduling.** Each rating maps to an evidence value (lost 0.1, shaky 0.4, okay 0.7, solid 1.0). A quiz score is weighted twice as heavily as the self-rating. Stability grows or shrinks from that evidence, and the next due date follows from the new stability. Mastery and status are computed when read, not stored.
- **Providers.** `src/main/ai/provider.ts` has one adapter per wire API: Gemini `generateContent` and Interactions (raw `fetch`), Claude Messages (the official Anthropic SDK, with its built-in retries off because the queue handles retries), and OpenAI Responses (raw `fetch`). Every adapter returns the same result shape, so the queue, cache and rate-limit pause work the same for all three.
- **AI fallbacks.** Some models reject certain request features. If a request gets HTTP 400, the app retries without the feature the error names, in this order: Claude's refusal fallback, then minimal thinking / low effort, then JSON mode, then the system instruction. It remembers what each model accepted. Claude has no schema-free JSON mode, so the prompts ask for JSON and every reply goes through robust parsing with one repair retry.
- **Rate limits.** An HTTP 429 from any provider throws a dedicated error. The queue puts the job back unchanged, sets a persisted pause with the provider's message and `Retry-After`, and notifies you. `resume()` clears it. Time estimates come from a moving average of measured request times, not from configured limits.
- **Token headroom.** Claude and OpenAI reasoning models count thinking tokens against the output cap, so their requests reserve extra room on top of **Max output per request**.

---

## Data, privacy and backups

All data lives in Electron's `userData` folder:

```
~/Library/Application Support/Interleaved Study/
├── study.sqlite            # main database (or study-store.json if SQLite is unavailable)
├── api-key.bin             # Keychain-encrypted Gemini key
├── api-key-anthropic.bin   # Keychain-encrypted Claude key
└── api-key-openai.bin      # Keychain-encrypted OpenAI key
```

When running with `npm run dev`, the folder may be named after the package (`interleaved-study`). **Settings** shows the exact path.

- **Export backup** (Settings) saves everything except the API keys to a single file.
- **Import backup** replaces all data and keeps your current keys. Before replacing anything, it writes a safety copy of the current data to the data folder.
- Lesson text is sent only to the provider selected in Settings, and only when a lesson is organized, enriched, quizzed or graded. A deadline spreadsheet's contents (as Markdown) are sent only when you import it. markitdown runs locally. Nothing else leaves your machine.

None of these files are inside the repository, so committing and pushing never uploads your study data or key.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘⇧S` | Start the next suggested session |
| `⌘⇧P` | Pause or resume the timer |
| `⌘1` | Board |
| `⌘2` | Session |
| `⌘3` | Plan |
| `⌘4` | Progress |
| `⌘5` | Queue |
| `⌘,` | Settings |

---

## Troubleshooting

**`better-sqlite3` was compiled against a different Node.js version (`NODE_MODULE_VERSION` mismatch)**
The native module must be built for Electron's Node version, not your system Node. Run:
```bash
npx electron-builder install-app-deps
```
If that fails, install the Xcode Command Line Tools (`xcode-select --install`) and run `npm install` again. If SQLite still doesn't load, the app keeps working on the JSON fallback store, and Settings shows the error.

**"Add your … API key in Settings first."**
No key is saved for the provider that is currently selected, or the Keychain couldn't decrypt it. Keys are stored per provider, so after switching providers you need a key for the new one. Paste it again in Settings.

**"API key rejected (HTTP 401/403)"**
The key doesn't match the selected provider, or it was revoked. A Claude key (`sk-ant-…`) only works with Anthropic Claude, and an OpenAI key (`sk-…`) only with OpenAI. A Claude.ai or ChatGPT subscription is not an API key; see [Choosing an AI provider](#choosing-an-ai-provider).

**"Model … not found (HTTP 404)"**
Providers rename and retire models. Pick another preset or type a current model ID, then click **Test model**.

**"Empty answer" or "Claude declined this request"**
The model ran out of output tokens or declined the request. Raise **Max output per request** in Settings, or try another model. On the newest Claude models the refusal fallback usually handles declines automatically.

**"Rate limit reached" banner**
The provider stopped accepting requests for now, so everything is paused and nothing is lost. Read the provider's message in the banner: a per-minute limit clears within a minute, while a daily quota or billing problem needs more time or a change in your provider account. Click **Continue** when you're ready. You can also switch providers in Settings and then click Continue.

**"markitdown was not found" when importing deadlines**
The import still works with the built-in converter. To get markitdown, install Python 3.10+ (`brew install python`) and run `npm run setup:markitdown` (or `npm run build`) in the project folder, then restart the app. See [How markitdown is installed](#how-markitdown-is-installed). To use a different install, enter its full path in **Settings → Deadline spreadsheets**.

**Imported deadline dates are off**
Check the dates in the review list before importing. For an ambiguous date like `03/04/2026`, the AI reads day/month unless the column shows month/day elsewhere. If a sheet keeps coming out wrong, use **Map columns manually** and set the date format yourself.

**PDF or DOCX text looks wrong**
These formats are best-effort. Scanned PDFs have no text layer. For the cleanest results, export to Markdown or plain text first.

**macOS says the app "is damaged" or "can't be opened"**
See [Building the macOS app](#building-the-macos-app). The build is unsigned and has to be allowed manually.

---

## Contributing

1. Fork the repository and create a branch: `git checkout -b feature/my-change`
2. Make your change, then check it:
   ```bash
   npm run typecheck
   npm test
   ```
3. Commit with a clear message and open a pull request.

Conventions:
- TypeScript `strict` mode, with no unused locals.
- Keep pure logic (scheduler, mapping, layout) in `src/shared/` or in small main-process modules with unit tests.
- Use the mock AI server for tests. Tests must never call a real API.
- To add a provider: add it to `Provider` in `src/shared/types.ts` and to `PROVIDERS`, `MODEL_PRESETS` and `DEFAULT_BASE_URLS` in `src/shared/defaults.ts`. Then write an adapter in `src/main/ai/provider.ts`, add a route to the mock server, and add tests in `tests/providers.test.ts`.

---

## License

No license has been chosen yet. Until one is added, all rights are reserved by the author. To let others use or contribute to the code, add a `LICENSE` file (for example [MIT](https://choosealicense.com/licenses/mit/)) and update this section.
