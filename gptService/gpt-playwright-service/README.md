# GPT Playwright Service

A Node.js + Playwright microservice that:
1. Accepts a prompt via HTTP POST
2. Navigates to `chatgpt.com` in a real browser (Chromium)
3. Types the prompt into the chat box and hits Send
4. Waits for ChatGPT to finish generating
5. **Extracts and returns only the LaTeX code** from the response

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | 18 + |
| npm | any recent |
| ChatGPT account | Free or Plus |

---

## Setup

```bash
npm install
npx playwright install chromium   # one-time browser install
```

---

## Running

```bash
npm start
```

Or on a custom port:

```bash
PORT=4000 npm start
```

Default: **http://localhost:3000**

---

## First Run – Logging In

When the service starts for the first time, a **real Chromium window** opens.

1. Log in to `https://chatgpt.com` manually in that window.
2. Once logged in, you don't need to do it again — the session is saved in `pw-user-data/`.

> **Tip:** Don't close the browser window while the service is running.

---

## API Reference

### `GET /health`

Returns the current status.

```json
{ "ok": true, "busy": false }
```

`busy: true` means a request is currently being processed (the service handles one at a time).

---

### `POST /generate-latex`

Sends a prompt to ChatGPT and returns the extracted LaTeX.

#### **Request Options**

| Option | Method | Fields |
|---|---|---|
| **Manual Mode** | Standard | `prompt` |
| **Template Mode** | Auto-substitution | `company`, `role`, `resumeLatex`, `jobDescription` |

#### **Arguments**

| Field | Type | Description |
|---|---|---|
| `prompt` | string | Manual prompt (Option 1) |
| `company` | string | Replaces `{{COMPANY_NAME}}` (Option 2) |
| `role` | string | Replaces `{{ROLE_NAME}}` (Option 2) |
| `resumeLatex` | string | Replaces `{{RESUME_LATEX}}` (Option 2) |
| `jobDescription` | string | Replaces `{{JOB_DESCRIPTION}}` (Option 2) |
| `templateFile` | string | (Optional) Filename to use as template instead of `prompt-template.txt` |
| `outputName` | string | (Optional) Manual filename for saving (without .tex) |
| `newChat` | boolean | (Optional) Default: `true` |
| `timeoutMs` | number | (Optional) Default: `120000` |

---

## Example (Template Mode)

```bash
curl -X POST http://localhost:3000/generate-latex \
  -H "Content-Type: application/json" \
  -d '{
    "company": "Salesforce",
    "role": "Software Engineer",
    "resumeLatex": "\\documentclass...",
    "jobDescription": "We seek a developer...",
    "templateFile": "my-special-template.txt"
  }'
```

---

## LaTeX Extraction Logic

The service extracts the **longest matching block** of LaTeX from the response, prioritizing those containing `\documentclass` to ensure you get the full document even if ChatGPT chatters.

### Non-Software Role Skip Flag

For roles outside software domains (for example language tutor, genetic scientist, or similar non-software postings), the service now appends a strict domain-gate instruction to the prompt.

If ChatGPT marks the generated LaTeX with this exact comment flag:

`% JOBTRACK_SKIP_NON_SOFTWARE_ROLE`

the worker treats the job as intentionally skipped:

- It does **not** save the generated LaTeX to the resume endpoint
- It does **not** retry generation
- It logs the compact reason as `SKIPPED_NON_SOFTWARE_ROLE`

---

## Notes

- This service uses a **persistent browser profile** (`pw-user-data/`) so your ChatGPT login session survives restarts.
- It handles only **one request at a time** (returns 429 if busy).
- Generated files are saved to `latex-resumes/`.
- For production workloads, prefer the official [OpenAI API](https://platform.openai.com/docs) instead.
