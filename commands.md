# Commands

## 0. One Time Setup

```bash
npm install
npx playwright install chromium
npm run validate-sample
```

Create `.env.local`:

```bash
cp .env.local.example .env.local
```

Create one user env:

```bash
cp .env.user.local.example .env.rishwa.local
cp -R data_sample data_rishwa
```

In `.env.local`, choose the user:

```env
APP_USER=rishwa
```

In each `.env.<user>.local`, keep failed apply tabs closed:

```env
ATS_CLOSE_PAGE_ON_FAIL=true
```

Fetch jobs one time:

```bash
npm run jobs-setup-once
```

### Resume Directory Format (`data_<user>/resumes/` & Prompts)
Each user's data directory now supports modular resumes for selective pregen (`npm run pregen:select`):
- `data_<user>/resumes/resume1/` (`resume.tex` + `desc.txt`)
- `data_<user>/resumes/resume2/` (`resume.tex` + `desc.txt`)
- `data_<user>/resumes/resume3/` (`resume.tex` + `desc.txt`)
- (Optional) `data_<user>/resumes/resume4/`, etc.
- `data_<user>/resume-decide-prompt.txt`: Plain text prompt template with placeholders (`{{company}}`, `{{jobTitle}}`, `{{jobDescription}}`, `{{candidateResumes}}`, `{{options}}`).
- Gemini Model: `GEMINI_MODEL=gemini-3.5-flash-lite` (supports multiple keys `GEMINI_API_KEY_1..N`).

## 1. Terminal 1 - localhost 3000

```bash
PORT=3000 npm run dev
```

Open:

```txt
http://localhost:3000
```

## 2. Terminal 2 - daily cron

```bash
npm run daily-cron
```

If GitHub Actions hourly scrape is enabled, you do not need to run this terminal locally.

GitHub repo secrets needed:

```txt
MONGODB_URI_NIHAR
JOBRIGHT_COOKIE_NIHAR
MONGODB_URI_RISHWA
JOBRIGHT_COOKIE_RISHWA
```

## 3. Terminal 3 - ChatGPT service 4000

```bash
PLAYWRIGHT_BROWSERS_PATH=0 PORT=4000 npm run gpt-service
```

## 4. Terminal 4 - Brave auto-apply profile

```bash
npm run brave

open -na "Brave Browser" --args --user-data-dir="$HOME/Library/Application Support/BraveSoftware/Brave-Browser" --profile-directory="Default"
```

## 5. Resume Strategies & Commands (3 Options)

### Option 1: Direct Apply with Single Default Resume (No Pregen Needed)
Uses your base resume uploaded to Google Drive `autoApply/<email>/defaultResume`. Zero tailoring wait time.

```bash
# Apply with default resume
npm run ats-bulk -- niharpatel230304@gmail.com defaultResume=yes

# Retry failed with default resume
npm run ats-bulk -- niharpatel230304@gmail.com defaultResume=yes retry=true

# Refresh base resume uploaded to Drive
npm run ats-bulk -- niharpatel230304@gmail.com defaultResume=yes refreshDefaultResume=yes
```

---

### Option 2: Pre-generate Tailored Resumes via ChatGPT (`mode=tailor`)
Runs continuously alongside auto-apply. Monitors `gptService` capacity, always claims the **latest available job**, and generates a customized LaTeX resume from scratch. If a job is expired, 404, or dead link, it is automatically marked as skipped and pruned from the DB.

```bash
# Ensure gpt-service is running in another terminal:
npm run gpt-service

# Run pregen daemon (keeps running, generates latest jobs first):
npm run pregen -- niharpatel230304@gmail.com

# If you stopped previous runs and want to reset all in-flight claims immediately:
npm run pregen -- niharpatel230304@gmail.com --reset

# Run simultaneously in another terminal:
npm run ats-bulk -- niharpatel230304@gmail.com
```

---

### Option 3: Pre-generate Selective Resumes via Gemini (`mode=select`)
Uses Google Gemini to analyze each Job Description and choose the best fit from $N$ pre-crafted resumes in `data_<user>/resumes/` (`resume1/`, `resume2/`, etc.). Runs as a continuous daemon, always claiming the **latest available job**, compiling and uploading directly to Google Drive, and indexing in MongoDB. Automatically skips dead jobs (404/expired). Does **not** require `gpt-service`.

```bash
# Terminal 1: Pregen daemon (keeps running, always processes latest jobs):
npm run pregen:select -- niharpatel230304@gmail.com

# Terminal 2: Auto-apply worker (keeps running, applies to latest jobs as resumes finish):
npm run ats-bulk -- niharpatel230304@gmail.com

# Optional flags:
# Reset any previously held in-flight claims:
npm run pregen:select -- niharpatel230304@gmail.com --reset

# Single batch only: once=true
npm run pregen:select -- niharpatel230304@gmail.com once=true

# Limit to first N jobs: limit=10
npm run pregen:select -- niharpatel230304@gmail.com limit=10

# Filter jobs posted on/after a specific date (e.g. Sept 20, 2026):
npm run pregen -- niharpatel230304@gmail.com since=2026-09-20
npm run pregen:select -- niharpatel230304@gmail.com after=2026-09-20
```

> **Note on LLM Architecture:**
> The Resume Decider is isolated inside `gptService/resume-decide-service/` (`gptService/resume-decide-service/resume-decide-llm-client.mjs`) with its own optional configuration file (`gptService/resume-decide-service/.env.local`). This allows you to use a different provider (Gemini, OpenAI), model, or separate API keys without touching the rest of the project. If `.env.local` inside that folder is omitted, it automatically reuses your existing `GEMINI_API_KEY_1..N` keys from your user env.


---

## 6. Bulk Auto-Apply Commands

```bash
# Apply with pregenerated resumes (Option 2 or Option 3):
npm run ats-bulk -- niharpatel230304@gmail.com

# Retry ALL failed jobs:
npm run ats-bulk -- niharpatel230304@gmail.com retry=true

# Retry failed jobs posted after a specific date (e.g. Sept 20, 2026):
npm run ats-bulk -- niharpatel230304@gmail.com retryAfter=2026-09-20
```

---

## 7. Running Multiple Users & Ports Simultaneously

You can run two or more users (e.g. **User 1: `rishwa`** and **User 2: `nihar`**) completely independently on the same machine by prefixing commands with `APP_USER=<name>` and `PORT=<port>`.

Each user connects to their own:
- MongoDB database (`MONGODB_URI_RISHWA` vs `MONGODB_URI_NIHAR`)
- Environment config (`.env.rishwa.local` vs `.env.nihar.local`)
- Data & Resumes directory (`data_rishwa/` vs `data_nihar/`)
- Web UI & API port (`http://localhost:3000` vs `http://localhost:3001`)

---

### User 1: Rishwa (Port 3000)

**Terminal 1A - Web UI (Port 3000):**
```bash
APP_USER=rishwa npx next dev -p 3000
```
> Open http://localhost:3000

**Terminal 1B - Resume Pregen Daemon:**
```bash
APP_USER=rishwa PORT=3000 npm run pregen:select -- rishwapatel1907@gmail.com
```

**Terminal 1C - Auto-Apply Worker:**
```bash
APP_USER=rishwa PORT=3000 npm run ats-bulk -- rishwapatel1907@gmail.com
```

**Terminal 1D - Brave Browser (Default CDP 9222):**
```bash
npm run brave
```

---

### User 2: Nihar (Port 3001)

**Terminal 2A - Web UI (Port 3001):**
```bash
APP_USER=nihar npx next dev -p 3001
```
> Open http://localhost:3001

**Terminal 2B - Resume Pregen Daemon:**
```bash
APP_USER=nihar PORT=3001 npm run pregen:select -- niharpatel230304@gmail.com
```

**Terminal 2C - Auto-Apply Worker:**
```bash
APP_USER=nihar PORT=3001 npm run ats-bulk -- niharpatel230304@gmail.com
```

**Terminal 2D - Brave Browser (Isolated CDP 9223 for simultaneous apply):**
```bash
BRAVE_DEBUG_PORT=9223 BRAVE_USER_DATA_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser-Nihar" npm run brave
```
*(If running User 2 auto-apply simultaneously with User 1, point User 2 to CDP 9223):*
```bash
BRAVE_CDP_URL="http://127.0.0.1:9223" APP_USER=nihar PORT=3001 npm run ats-bulk -- niharpatel230304@gmail.com
```

---

### If using ChatGPT Tailored Mode (`gpt-service`) for both users simultaneously:

**User 1 (Port 4000):**
```bash
APP_USER=rishwa PORT=4000 npm run gpt-service
APP_USER=rishwa PORT=3000 npm run pregen -- rishwapatel1907@gmail.com
```

**User 2 (Port 4001):**
```bash
APP_USER=nihar PORT=4001 npm run gpt-service
GENERATE_LATEX_ORIGIN="http://localhost:4001" APP_USER=nihar PORT=3001 npm run pregen -- niharpatel230304@gmail.com
```

---

## 8. ATS filter commands

Workday only:

```bash
npm run ats-bulk -- niharpatel230304@gmail.com ats=workday
```

Greenhouse only:

```bash
npm run ats-bulk -- niharpatel230304@gmail.com ats=greenhouse
```

Ashby files are present for later, but these commands do not call Ashby yet.

## 9. Open personal Brave profile

```bash
open -na "Brave Browser" --args --user-data-dir="$HOME/Library/Application Support/BraveSoftware/Brave-Browser" --profile-directory="Default"
```

## 10. Kill ports

Kill web ports (3000 / 3001):

```bash
lsof -ti:3000,3001 | xargs kill -9
```

Kill GPT services (4000 / 4001):

```bash
lsof -ti:4000,4001 | xargs kill -9
```

Kill all auto-apply ports (3000, 3001, 4000, 4001, 9222, 9223):

```bash
lsof -ti:3000,3001,4000,4001,9222,9223 | xargs kill -9
```
