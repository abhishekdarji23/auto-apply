import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const dataDir = path.join(root, "data_sample");

const jsonFiles = [
  "candidate-profile.json",
  "current-emails.json",
  "sample.json",
  "resume_sample.json",
  "resume_paginate_sample.json",
];

const textFiles = ["prompt-template.txt", "resume.tex", "chatgpt-accounts.json"];

function fail(message) {
  console.error(`[validate-sample] FAIL ${message}`);
  process.exit(1);
}

function readRequired(relativePath) {
  const fullPath = path.join(dataDir, relativePath);
  if (!fs.existsSync(fullPath)) fail(`missing data_sample/${relativePath}`);
  return fs.readFileSync(fullPath, "utf8");
}

for (const file of jsonFiles) {
  const raw = readRequired(file);
  try {
    JSON.parse(raw);
  } catch (error) {
    fail(`invalid JSON in data_sample/${file}: ${error.message}`);
  }
}

for (const file of textFiles) {
  readRequired(file);
}

const promptTemplate = readRequired("prompt-template.txt");
if (!promptTemplate.includes("{{RESUME_LATEX}}")) {
  fail("prompt-template.txt must include {{RESUME_LATEX}}");
}
if (!promptTemplate.includes("{{JOB_DESCRIPTION}}")) {
  fail("prompt-template.txt must include {{JOB_DESCRIPTION}}");
}

const resumeTex = readRequired("resume.tex");
if (!resumeTex.includes("\\documentclass") || !resumeTex.includes("\\end{document}")) {
  fail("resume.tex is not a complete LaTeX document");
}

const candidateProfile = JSON.parse(readRequired("candidate-profile.json"));
if (!candidateProfile.credentials || !candidateProfile.candidate_profile) {
  fail("candidate-profile.json must include credentials and candidate_profile");
}

const emails = JSON.parse(readRequired("current-emails.json"));
if (!Object.prototype.hasOwnProperty.call(emails, "autoApplyEmail")) {
  fail("current-emails.json must include autoApplyEmail");
}

// ---------------------------------------------------------------------------
// Validate Selective Pregen Format (resumes/ directory & resume-decide-prompt)
// ---------------------------------------------------------------------------
const promptDecidePath = path.join(dataDir, "resume-decide-prompt.txt");
if (fs.existsSync(promptDecidePath)) {
  const decidePrompt = fs.readFileSync(promptDecidePath, "utf8");
  const requiredPlaceholders = ["{{company}}", "{{jobTitle}}", "{{jobDescription}}", "{{candidateResumes}}", "{{options}}"];
  for (const ph of requiredPlaceholders) {
    if (!decidePrompt.includes(ph)) {
      fail(`resume-decide-prompt.txt is missing placeholder: ${ph}`);
    }
  }
  console.log("[validate-sample] resume-decide-prompt.txt contains all required placeholders");
}

const resumesDir = path.join(dataDir, "resumes");
if (fs.existsSync(resumesDir)) {
  const entries = fs.readdirSync(resumesDir, { withFileTypes: true });
  const resumeSubdirs = entries.filter((e) => e.isDirectory());
  if (resumeSubdirs.length === 0) {
    fail("data_sample/resumes/ must contain at least one resume subfolder (e.g., resume1/)");
  }

  for (const dir of resumeSubdirs) {
    const subPath = path.join(resumesDir, dir.name);
    const subTex = path.join(subPath, "resume.tex");
    const subDesc = path.join(subPath, "desc.txt");

    if (!fs.existsSync(subTex)) {
      fail(`missing ${dir.name}/resume.tex in data_sample/resumes/`);
    }
    if (!fs.existsSync(subDesc)) {
      fail(`missing ${dir.name}/desc.txt in data_sample/resumes/`);
    }

    const texContent = fs.readFileSync(subTex, "utf8");
    if (!texContent.includes("\\documentclass") || !texContent.includes("\\end{document}")) {
      fail(`${dir.name}/resume.tex is not a complete LaTeX document`);
    }

    const descContent = fs.readFileSync(subDesc, "utf8").trim();
    if (!descContent) {
      fail(`${dir.name}/desc.txt is empty`);
    }
  }
  console.log(`[validate-sample] validated ${resumeSubdirs.length} candidate resume folders in data_sample/resumes/`);
}

// ---------------------------------------------------------------------------
// Validate LaTeX compilation
// ---------------------------------------------------------------------------
const pdflatexCheck = spawnSync("pdflatex", ["--version"], { encoding: "utf8" });
if (pdflatexCheck.status === 0) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-apply-resume-"));
  const compile = spawnSync(
    "pdflatex",
    [
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-output-directory",
      tmpDir,
      path.join(dataDir, "resume.tex"),
    ],
    { encoding: "utf8" },
  );

  if (compile.status !== 0) {
    fail(`resume.tex did not compile with pdflatex\n${compile.stdout || compile.stderr}`);
  }
  console.log("[validate-sample] resume.tex compiles with pdflatex");

  // Also verify resume1/resume.tex compiles
  const resume1Tex = path.join(resumesDir, "resume1", "resume.tex");
  if (fs.existsSync(resume1Tex)) {
    const compile1 = spawnSync(
      "pdflatex",
      [
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-output-directory",
        tmpDir,
        resume1Tex,
      ],
      { encoding: "utf8" },
    );
    if (compile1.status !== 0) {
      fail(`resumes/resume1/resume.tex did not compile with pdflatex\n${compile1.stdout || compile1.stderr}`);
    }
    console.log("[validate-sample] resumes/resume1/resume.tex compiles with pdflatex");
  }
} else {
  console.log("[validate-sample] pdflatex not found, skipped LaTeX compile");
}

console.log("[validate-sample] sample data parsed correctly");
