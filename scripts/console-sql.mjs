#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Console-ready copies of every migration.
 *
 * Cloudflare's D1 console rejects a paste whose first statement is a comment
 * with "Requests without any query are not supported" — it strips the leading
 * `--` lines, finds nothing left to run, and gives up on the whole paste. Every
 * migration here opens with a comment block explaining why it exists, which is
 * right for the repository and fatal in the console.
 *
 * Rather than choosing between the two, this writes a second copy of each
 * migration with the comments removed, into migrations/console/. Those are what
 * gets pasted; the originals keep their reasoning.
 *
 * Run it after adding or editing a migration:
 *   npm run sql:console
 */

const SOURCE = 'migrations';
const OUT = path.join(SOURCE, 'console');

/**
 * Remove comments without touching anything inside a string literal.
 *
 * A naive replace on `--` would corrupt a default value or a seeded row that
 * happens to contain two hyphens, and a corrupted migration is a far worse
 * outcome than a comment surviving.
 */
function stripComments(sql) {
  let out = '';
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (inString) {
      out += char;
      if (char === "'") {
        // Doubled quote is an escaped quote, not the end of the string.
        if (sql[i + 1] === "'") { out += sql[++i]; } else { inString = false; }
      }
      continue;
    }

    if (char === "'") { inString = true; out += char; continue; }

    if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue; // the newline itself is handled by the loop
    }

    out += char;
  }

  return `${out.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).join('\n')}\n`;
}

const files = fs.readdirSync(SOURCE).filter((f) => f.endsWith('.sql')).sort();
fs.mkdirSync(OUT, { recursive: true });

for (const file of files) {
  const sql = stripComments(fs.readFileSync(path.join(SOURCE, file), 'utf8'));
  if (!sql.trim()) {
    console.error(`${file}: nothing left after stripping comments — check it`);
    process.exitCode = 1;
    continue;
  }
  if (sql.trimStart().startsWith('--')) {
    console.error(`${file}: still starts with a comment — the console will reject it`);
    process.exitCode = 1;
    continue;
  }
  fs.writeFileSync(path.join(OUT, file), sql);
  console.log(`${path.join(OUT, file)}  (${sql.split(';').filter((s) => s.trim()).length} statements)`);
}
