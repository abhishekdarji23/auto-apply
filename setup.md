# Auto Apply Setup

This app uses two browsers:

- Chrome is for `npm run gpt-service` and ChatGPT resume generation.
- Brave is for `npm run brave` and ATS auto apply.

Create a Brave profile named `auto-apply`. Use that profile only for applying.

## 1. Install

```bash
npm install
npx playwright install chromium
npm run validate-sample
```

Install LaTeX so `pdflatex` works:

```bash
brew install --cask mactex-no-gui
```

Windows: install MiKTeX.

Linux: install TeX Live.

## 2. User Setup

Create `.env.local`:

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and set only the active user:

```env
APP_USER=rishwa
```

For another user:

```env
APP_USER=nihar
```

The app loads user settings from:

```txt
.env.<APP_USER>.local
data_<APP_USER>/
```

Examples:

```txt
APP_USER=rishwa -> .env.rishwa.local + data_rishwa/
APP_USER=nihar  -> .env.nihar.local  + data_nihar/
```

## 3. User Env

Create a user env file:

```bash
cp .env.user.local.example .env.rishwa.local
```

For Nihar:

```bash
cp .env.user.local.example .env.nihar.local
```

Fill it like this:

```env
DATA_DIR=data_rishwa

MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/rishwa_jobtrack?retryWrites=true&w=majority&appName=Cluster0

JOBRIGHT_COOKIE=SESSION_ID=YOUR_SESSION_ID; g_state={}
JOBRIGHT_USER_AGENT=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36

GOOGLE_DRIVE_ROOT_FOLDER_ID=YOUR_DRIVE_FOLDER_ID
GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE=gen-lang-client.json

GEMINI_API_KEY_1=YOUR_GEMINI_API_KEY_1
GEMINI_API_KEY_2=YOUR_GEMINI_API_KEY_2
GEMINI_MODEL=gemini-3.5-flash-lite

CHATGPT_MODE=chat
CHATGPT_MODEL=GPT-5.2
CHATGPT_THINKING=High

BRAVE_PROFILE_NAME=auto-apply
ATS_DEBUG=false
ATS_CLOSE_PAGE_ON_FAIL=true

# Jev AI (TypeSafe AI) — for ML-powered job title classification
# Get your key at: https://app.typesafe.ai
TYPESAFE_API_KEY=YOUR_TYPESAFE_API_KEY
```

`defaultResume=yes` uses one shared Drive folder per user: `autoApply/<email>/defaultResume`.
After editing `data_<user>/resume.tex`, run with `refreshDefaultResume=yes` once to upload the new base resume.

Use one Mongo database per user.

## 4. MongoDB

In MongoDB Atlas:

1. Create a cluster.
2. Create a database user.
3. Add your IP in Network Access.
4. Copy the connection string.
5. Put the database name in the URL.

Example:

```env
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/data_user?retryWrites=true&w=majority&appName=Cluster0
```

Collections are created automatically.

## 5. JobRight Cookie

Get this from the correct JobRight account for the selected user.

1. Open `https://jobright.ai`.
2. Log in.
3. Open DevTools.
4. Go to Network.
5. Open `https://jobright.ai/jobs/recommend`.
6. Click a request like `/swan/recommend/list/jobs`.
7. Copy the request `cookie` header.
8. Paste it into `.env.<user>.local` as `JOBRIGHT_COOKIE`.

Verify the cookie belongs to the correct user before running apply commands.

## 6. Google Drive

Generated resume PDFs are uploaded to Google Drive.

1. Open Google Cloud Console.
2. Enable Google Drive API.
3. Create a service account.
4. Download the service account JSON.
5. Save it in the repo root as `gen-lang-client.json`.
6. Create a Drive folder for resumes.
7. Copy the folder ID from the Drive URL.
8. Set `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
9. Share the Drive folder with the service account `client_email`.

`gen-lang-client.json` is ignored by git.

## 7. User Data Folder

Copy sample data:

```bash
cp -R data_sample data_rishwa
```

For Nihar:

```bash
cp -R data_sample data_nihar
```

Edit these files:

- `data_<user>/candidate-profile.json`
- `data_<user>/current-emails.json`
- `data_<user>/sample.json`
- `data_<user>/resume.tex` (base/fallback resume for defaultResume=yes)
- `data_<user>/prompt-template.txt` (ChatGPT tailoring prompt)
- `data_<user>/chatgpt-accounts.json`
- `data_<user>/resume_sample.json`
- `data_<user>/resume_paginate_sample.json`
- **[NEW]** `data_<user>/resume-decide-prompt.txt` (customizable selection prompt for Gemini)
- **[NEW]** `data_<user>/resumes/` (candidate resumes directory):
  - `data_<user>/resumes/resume1/` (`resume.tex` + `desc.txt`)
  - `data_<user>/resumes/resume2/` (`resume.tex` + `desc.txt`)
  - `data_<user>/resumes/resume3/` (`resume.tex` + `desc.txt`)
  - (Optional) `data_<user>/resumes/resume4/`, etc.

Real user data folders are ignored by git.

Check the sample files before using real data:

```bash
npm run validate-sample
```

This parses the JSON files, verifies all placeholders in prompt templates, validates all candidate resume folders, and compiles `resume.tex` with `pdflatex` when LaTeX is installed.

## 8. Brave Profile

Create a Brave profile named:

```txt
auto-apply
```

Use Brave only for the apply browser. Keep Chrome for ChatGPT service.

If you also want personal Brave open, use a separate Brave profile.

## 9. Start Local App

Terminal 1:

```bash
PORT=3000 npm run dev
```

Open:

```txt
http://localhost:3000
```

## 10. Fetch Jobs

One time setup:

```bash
npm run jobs-setup-once
```

Daily cron:

```bash
npm run daily-cron
```

JobRight recommendation fetch uses the selected user's `JOBRIGHT_COOKIE`.

## 10A. GitHub Actions Hourly Fetch

GitHub Actions can fetch jobs every hour so the local laptop does not need to run `npm run daily-cron`.

Add these GitHub repository secrets:

```txt
MONGODB_URI_NIHAR
JOBRIGHT_COOKIE_NIHAR
MONGODB_URI_RISHWA
JOBRIGHT_COOKIE_RISHWA
```

Then enable this workflow:

```txt
.github/workflows/hourly-job-scrape.yml
```

It runs once per hour and starts two separate jobs:

```txt
APP_USER=nihar
APP_USER=rishwa
```

Each user writes only to that user's Mongo database and uses that user's JobRight cookie.

To run it manually:

```txt
GitHub repo -> Actions -> Hourly Job Scrape -> Run workflow
```

## 11. Start GPT Service

Terminal 2:

```bash
PLAYWRIGHT_BROWSERS_PATH=0 PORT=4000 npm run gpt-service
```

Chrome opens for ChatGPT.

If `CHATGPT_MODE=chat`, it selects Chat mode.

If `CHATGPT_MODE=work`, it selects Work mode, then `CHATGPT_MODEL`, then `CHATGPT_THINKING`.

## 12. Start Brave Apply Browser

Terminal 3:

```bash
npm run brave
```

This opens the Brave `auto-apply` profile for automation.

## 13. Pre-Generate Resumes (2 Modes)

### Mode A: Selective Resumes via Gemini (`npm run pregen:select`)
Evaluates each job description against $N$ pre-crafted resumes in `data_<user>/resumes/` and automatically compiles, uploads to Google Drive under `autoApply/<email>/...`, and indexes in MongoDB.

#### What Was Added & What Needs to Be Added:

1. **Candidate Resumes Folder (`data_<user>/resumes/`)**:
   Create a `resumes/` folder in your user data directory (or copy from `data_sample/resumes/`):
   ```
   data_<user>/resumes/
   ├── resume1/
   │   ├── resume.tex     # Complete, valid LaTeX document
   │   └── desc.txt       # Plain text description of target roles and core skills
   ├── resume2/
   │   ├── resume.tex
   │   └── desc.txt
   ├── resume3/
   │   ├── resume.tex
   │   └── desc.txt
   └── resume4/           # (Optional) Simply create resume4/, resume5/, etc. to add more!
       ├── resume.tex
       └── desc.txt
   ```
   * **`resume.tex`**: Must be a complete, compilable LaTeX document (`\documentclass` to `\end{document}`).
   * **`desc.txt`**: Describes the focus, core skills, and guidance on when to choose this resume. Example:
     ```txt
     Title: Backend & Distributed Systems Engineer
     Focus: Backend development, distributed systems, high-concurrency microservices, cloud infrastructure.
     Core Skills: Python, Go, Java, PostgreSQL, MongoDB, Redis, Docker, Kubernetes, AWS, Kafka, gRPC.
     When to choose: Select this resume for Backend Engineer, Distributed Systems Engineer, Cloud Engineer, or API Developer roles.
     ```

2. **Customizable Selection Prompt (`data_<user>/resume-decide-prompt.txt`)**:
   A prompt file that controls how Gemini decides which resume to choose. You can edit this file in plain English without any strict format!
   Available placeholders (replaced automatically per job):
   - `{{company}}`: Company name (e.g. Jane Street).
   - `{{jobTitle}}`: Job title (e.g. Software Engineer).
   - `{{jobDescription}}`: Full job description & requirements text.
   - `{{candidateResumes}}`: Formatted list of all your resumes and their `desc.txt` content.
   - `{{options}}`: Allowed resume IDs (`"resume1", "resume2", ...`).

3. **Gemini Multi-Key Setup in `.env.<user>.local`**:
   Supports any $N$ numbered keys with automatic round-robin rotation and failover:
   ```env
   GEMINI_MODEL=gemini-3.5-flash-lite
   GEMINI_API_KEY_1=AIzaSy...
   GEMINI_API_KEY_2=AIzaSy...
   GEMINI_API_KEY_3=AIzaSy...
   ```

4. **(Optional) Isolated Resume Decider Service (`gptService/resume-decide-service/`)**:
   The resume selection engine is isolated inside `gptService/resume-decide-service/`. You can customize the provider, model, or keys separately in `gptService/resume-decide-service/.env.local` (see `.env.example`):
   ```env
   RESUME_DECIDE_LLM_PROVIDER=gemini
   RESUME_DECIDE_MODEL=gemini-3.5-flash-lite
   GEMINI_API_KEY_1=AIzaSy...
   GEMINI_API_KEY_2=AIzaSy...
   ```
   *(If `.env.local` in that folder is omitted, it automatically falls back to your `.env.<user>.local` keys).*

5. **Commands to Test and Run**:
   ```bash
   # Test decider provider, model, and all configured keys:
   npm run test:resume-decide

   # Run selective pregen for all ATS jobs:
   npm run pregen:select -- user@example.com

   # Workday only:
   npm run pregen:select -- user@example.com ats=workday

   # Greenhouse only:
   npm run pregen:select -- user@example.com ats=greenhouse

   # Test run on first 5 jobs only:
   npm run pregen:select -- user@example.com limit=5

   # Run for a specific user profile:
   APP_USER=nihar npm run pregen:select -- niharpatel230304@gmail.com
   ```

   **Synchronization & Reliability:**
   - The selection and upload pipeline is strictly synchronous.
   - For every job: Gemini selects resume -> `pdflatex` compiles -> PDF uploads to Google Drive under `autoApply/<email>/...` -> Google Drive confirms file ID and MongoDB indexes it -> only then does the loop move to the next job.
   - Includes automatic retry with backoff for Google Drive 502/503 errors and robust JSON repair for LLM responses.

### Mode B: Tailored Resumes via ChatGPT (`npm run pregen`)
Uses `gptService` (port 4000) to generate a customized LaTeX resume from scratch for every job:

```bash
# Ensure gpt-service is running:
npm run gpt-service

# All supported ATS:
npm run pregen -- user@example.com

# Workday only:
npm run pregen -- user@example.com ats=workday

# Greenhouse only:
npm run pregen -- user@example.com ats=greenhouse
```

## 14. Auto Apply

Use generated resumes:

```bash
npm run ats-bulk -- user@example.com
```

Use default resume from `data_<user>/resume.tex`:

```bash
npm run ats-bulk -- user@example.com defaultResume=yes
```

Retry failed rows:

```bash
npm run ats-bulk -- user@example.com defaultResume=yes retry=true
```

Workday only:

```bash
npm run ats-bulk -- user@example.com ats=workday
```

Greenhouse only:

```bash
npm run ats-bulk -- user@example.com ats=greenhouse
```

Only Workday and Greenhouse are active in normal auto apply. Ashby files are kept in the repo for later, but the runner does not call Ashby yet.

## 15. Multi Email Behavior

Auto apply is per email.

- `autoapplyjobs` tracks `jobUrl + appliedEmail`.
- If one email auto-applies a job, another email can still get the same job.
- `manualApplied` is global and blocks all emails.
- `notInterested` is global and blocks all emails.
- Jobs dashboard shows manual status only.
- Auto Apply Dashboard shows auto-apply tracker status.

## 16. Kill Ports

Kill app port:

```bash
lsof -ti:3000 | xargs kill -9
```

Kill GPT service port:

```bash
lsof -ti:4000 | xargs kill -9
```

Kill both:

```bash
lsof -ti:3000,4000 | xargs kill -9
```

## 17. Safe Order

1. Create Brave profile named `auto-apply`.
2. Create Mongo DB and copy Mongo URL.
3. Get JobRight cookie for selected user.
4. Set up Google Drive service account and Drive folder.
5. Create `.env.local` and `.env.<user>.local` (from `.env.user.local.example`).
6. Copy `data_sample` to `data_<user>`.
7. Fill every file in `data_<user>` (including `resumes/` and `resume-decide-prompt.txt`).
8. Run `npm install` and `npm run validate-sample`.
9. Start `PORT=3000 npm run dev`.
10. Run `npm run jobs-setup-once`.
11. (Optional for ChatGPT mode) Start `PLAYWRIGHT_BROWSERS_PATH=0 PORT=4000 npm run gpt-service`.
12. Start `npm run brave`.
13. Pre-generate resumes:
    - **Recommended (Fast & Selective via Gemini):** `npm run pregen:select -- user@example.com`
    - **Or (Tailored via ChatGPT):** `npm run pregen -- user@example.com`
14. Run `npm run ats-bulk -- user@example.com`.
