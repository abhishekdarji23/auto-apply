import fs from "fs";
import path from "path";

const TOP500_CSV_PATH = path.join(process.cwd(), "Company_List - Sheet1.csv");
const STOPWORDS = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "llc",
  "plc",
  "gmbh",
  "ag",
  "srl",
  "sa",
  "bv",
  "group",
  "holding",
  "holdings",
  "systems",
  "solutions",
  "services",
  "service",
  "technology",
  "technologies",
  "innovative",
  "innovation",
  "medicine",
]);

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function companyMatchKeys(raw: string): string[] {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return [];

  const full = tokens.join("");
  const baseTokens = tokens.filter((t) => !STOPWORDS.has(t));
  const base = (baseTokens.length ? baseTokens : tokens).join("");

  return full === base ? [full] : [full, base];
}

export function expandCompanyAliases(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const parts = trimmed.split("(");
  const main = parts[0].trim();
  const tokens: string[] = [];
  if (main) tokens.push(main);

  if (parts.length > 1) {
    const inside = parts.slice(1).join("(").replace(/\)/g, "");
    inside.split(",").forEach((p) => {
      const t = p.trim();
      if (t) tokens.push(t);
    });
  }

  const expanded: string[] = [];
  for (const token of tokens) {
    const keys = companyMatchKeys(token);
    if (keys.length) expanded.push(...keys);
  }

  return expanded.filter((t, idx, arr) => t && arr.indexOf(t) === idx);
}

export function normalizeCompanyName(raw: string): string {
  const keys = companyMatchKeys(raw);
  return keys[1] || keys[0] || "";
}

export function loadTop500Tokens(): Set<string> {
  const tokens = new Set<string>();
  const map = loadTop500TokensWithRank();
  for (const token of map.keys()) {
    tokens.add(token);
  }
  return tokens;
}

export function loadTop500TokensWithRank(): Map<string, number> {
  const content = fs.readFileSync(TOP500_CSV_PATH, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const tokenRanks = new Map<string, number>();

  let currentRank = 1;
  for (const line of lines) {
    const [first] = parseCsvLine(line);
    if (!first) continue;

    // Some lines might just be empty after parsing, but assume 1 line = 1 rank slot
    let mappedAny = false;
    for (const token of expandCompanyAliases(first)) {
      if (!tokenRanks.has(token)) {
        tokenRanks.set(token, currentRank);
        mappedAny = true;
      }
    }
    if (mappedAny) {
      currentRank++;
    }
  }

  return tokenRanks;
}
