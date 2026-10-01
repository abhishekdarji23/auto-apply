# Resume Decider Service

Self-contained LLM evaluation engine for matching Job Descriptions against candidate resumes in `mode=select`.

## Configuration

Place your configuration in:
`gptService/resume-decide-service/.env.local`

Example:
```env
RESUME_DECIDE_LLM_PROVIDER=gemini
RESUME_DECIDE_MODEL=gemini-2.5-flash
RESUME_DECIDE_GEMINI_API_KEY_1=AIzaSy...
RESUME_DECIDE_GEMINI_API_KEY_2=AIzaSy...
```

If `.env.local` is omitted, it automatically falls back to your active user environment settings (`.env.<user>.local`).

## Testing Keys

```bash
npm run test:resume-decide
```
