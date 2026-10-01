# Auto Apply

Auto-apply and resume-generation workflow for Workday and Greenhouse jobs.

Use these docs:

- `setup.md` - full setup, env files, MongoDB, JobRight, Google Drive, browsers, and flow details.
- `commands.md` - short terminal-by-terminal commands.

Quick validation:

```bash
npm install
npx playwright install chromium
npm run validate-sample
```

Real secrets and user data must stay in ignored local files:

- `.env.local`
- `.env.<user>.local`
- `data_<user>/`
- `gen-lang-client.json`
