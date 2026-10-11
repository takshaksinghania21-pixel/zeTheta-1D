/**
 * Lightweight repository secret scan (complements gitleaks in CI). Scans files
 * tracked by git (or all non-ignored files before the first commit) for
 * credential patterns and committed environment files. Exit code 1 on findings.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS: [string, RegExp][] = [
  ['private key', /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abpr]-[0-9A-Za-z-]{10,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Twilio account SID with token', /\bAC[a-f0-9]{32}\b/],
  ['Meta/WhatsApp access token', /\bEAA[A-Za-z0-9]{40,}\b/],
  ['Signed JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/],
  [
    'connection string with password',
    /\b(postgres|postgresql|amqp|redis|mongodb):\/\/[^:\s/]+:(?!CHANGE_ME|test@|\$\{|pw@|p@)[^@\s]{6,}@/,
  ],
];
const ALLOW_FILES = [/^package-lock\.json$/, /^docs\/openapi\.json$/];

function files(): string[] {
  try {
    const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    return tracked;
  } catch {
    return [];
  }
}

const findings: string[] = [];
for (const f of files()) {
  if (ALLOW_FILES.some((r) => r.test(f))) continue;
  if (/(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith('.env.example'))
    findings.push(`${f}: environment file must not be committed`);
  let text: string;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of PATTERNS)
      if (re.test(line)) findings.push(`${f}:${i + 1}: possible ${name}`);
  });
}
if (findings.length > 0) {
  console.error(`Secret scan found ${findings.length} issue(s):\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files().length} files checked).`);
