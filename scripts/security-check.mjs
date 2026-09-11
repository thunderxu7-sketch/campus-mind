import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ignored = new Set(['.git', 'node_modules', 'dist', 'private-data']);
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path); else files.push(path);
  }
}
walk(root);
const suspicious = [];
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (secretPatterns.some((pattern) => pattern.test(text))) suspicious.push(`${relative(root, file)}: possible credential`);
}
const main = readFileSync(join(root, 'apps/api/src/main.ts'), 'utf8');
const crypto = readFileSync(join(root, 'apps/api/src/domain/crypto.ts'), 'utf8');
const store = readFileSync(join(root, 'apps/api/src/domain/store.ts'), 'utf8');
const objectStore = readFileSync(join(root, 'apps/api/src/infra/object-store.ts'), 'utf8');
const scoring = readFileSync(join(root, 'apps/api/src/domain/scoring.ts'), 'utf8');
const requiredSnippets = [
  [crypto, "NODE_ENV !== 'production'", 'production key guard'],
  [crypto, 'CAMPMIND_MASTER_KEY', 'production key source'],
  [crypto, 'masterKeyCandidates', 'bounded encryption key rotation'],
  [crypto, 'CAMPMIND_PREVIOUS_MASTER_KEYS', 'legacy key rotation source'],
  [crypto, 'CAMPMIND_DATA_BACKEND !== \'postgres\'', 'production backend guard'],
  [crypto, 'CAMPMIND_DEMO_MFA', 'production MFA guard'],
  [store, 'assertProductionStoreInjection', 'production adapter guard'],
  [store, 'objectStore', 'private object-store boundary'],
  [objectStore, 'aes-256-gcm', 'encrypted private object store'],
  [objectStore, 'OBJECT_KEY_INVALID', 'object-key traversal guard'],
  [scoring, 'SYNTHETIC_SCALE_BLOCKED', 'synthetic scale production guard'],
  [main, 'Content-Security-Policy', 'CSP header'],
  [main, 'MAX_BODY_BYTES', 'request body bound'],
];
for (const [text, snippet, label] of requiredSnippets) if (!text.includes(snippet)) suspicious.push(`missing ${label}`);
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
for (const item of ['.env', 'private-data/', 'exports/', '*.pem', '*.key']) if (!gitignore.includes(item)) suspicious.push(`.gitignore missing ${item}`);
if (suspicious.length) { console.error(suspicious.join('\n')); process.exit(1); }
console.log(`PASS: scanned ${files.length} repository files; no credential patterns; production guards and sensitive-data ignore rules present.`);
console.log('Not checked: penetration testing, provider configuration, legal compliance or production database policy execution.');
