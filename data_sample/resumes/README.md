# Candidate Resumes Directory (`resumes/`)

This directory contains pre-crafted, targeted resumes for selective resume generation (`npm run pregen:select`).

## Folder Structure

Each subfolder represents one resume candidate profile (`resume1`, `resume2`, `resume3`, etc.):

```
resumes/
├── resume1/
│   ├── resume.tex     # Complete LaTeX resume document
│   └── desc.txt       # Plain-text focus, skills, and matching rules
├── resume2/
│   ├── resume.tex
│   └── desc.txt
├── resume3/
│   ├── resume.tex
│   └── desc.txt
└── resume4/           # Add more simply by creating resume4/, resume5/, etc.
    ├── resume.tex
    └── desc.txt
```

## Required Files per Resume Folder

Every folder (`resume1`, `resume2`, ...) must contain exactly these two files:

1. **`resume.tex`**:
   - A complete, valid, compilable LaTeX document (`\documentclass` ... `\end{document}`).
   - Contains your contact details, education, work experience, projects, and skills tailored to that specialty.
   - Must compile with `pdflatex` without errors.

2. **`desc.txt`**:
   - Plain text description used by the LLM (Gemini) to understand what this resume targets and when to select it.
   - Recommended format:
     ```txt
     Title: Backend & Distributed Systems Engineer
     Focus: Backend development, distributed systems, high-concurrency microservices, cloud infrastructure, and database optimization.
     Core Skills: Python, Go, Java, PostgreSQL, MongoDB, Redis, Docker, Kubernetes, AWS, Kafka, gRPC, REST APIs.
     When to choose: Select this resume for Backend Engineer, Distributed Systems Engineer, Cloud Engineer, Infrastructure Engineer, Systems Software Engineer, or API Developer roles.
     ```

## Adding More Resumes

You can add as many resumes as you need:
- Simply create a new directory named `resume4/`, `resume5/`, etc.
- Put the corresponding `resume.tex` and `desc.txt` inside it.
- The selective decider automatically detects all `resume*` folders dynamically!

## How Selection Works

1. `npm run pregen:select -- <email>` scans all subfolders in `data_<user>/resumes/`.
2. It sends the job title, company, and job description along with all `desc.txt` summaries to Gemini (`gemini-3.5-flash-lite`).
3. Gemini selects the single best matching resume ID (e.g., `resume1`).
4. The system compiles `resume.tex` into PDF with `pdflatex`, replaces the email with your apply email, uploads to Google Drive under `autoApply/<email>/...`, and records the decision and Drive file ID in MongoDB.
5. `npm run ats-bulk -- <email>` automatically uses this pre-selected resume when submitting ATS applications.
