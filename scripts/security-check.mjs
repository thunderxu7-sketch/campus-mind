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
const service = readFileSync(join(root, 'apps/api/src/domain/service.ts'), 'utf8');
const expressionSupport = readFileSync(join(root, 'apps/api/src/domain/expression-support.ts'), 'utf8');
const objectStore = readFileSync(join(root, 'apps/api/src/infra/object-store.ts'), 'utf8');
const scoring = readFileSync(join(root, 'apps/api/src/domain/scoring.ts'), 'utf8');
const adminWeb = readFileSync(join(root, 'apps/admin-web/index.html'), 'utf8');
const studentWeb = readFileSync(join(root, 'apps/student-web/index.html'), 'utf8');
const pagesHome = readFileSync(join(root, 'docs/index.html'), 'utf8');
const visualScript = readFileSync(join(root, 'apps/student-web/visual-interaction.js'), 'utf8');
const pagesExpressionDemo = readFileSync(join(root, 'docs/expression-demo/index.html'), 'utf8');
if (/\b(?:localStorage|sessionStorage|indexedDB)\b/i.test(studentWeb)) suspicious.push('student-web must not persist sensitive answer/session data in browser storage');
const requiredSnippets = [
  [crypto, "NODE_ENV !== 'production'", 'production key guard'],
  [crypto, 'CAMPMIND_MASTER_KEY', 'production key source'],
  [crypto, 'masterKeyCandidates', 'bounded encryption key rotation'],
  [crypto, 'CAMPMIND_PREVIOUS_MASTER_KEYS', 'legacy key rotation source'],
  [crypto, 'CAMPMIND_DATA_BACKEND !== \'postgres\'', 'production backend guard'],
  [crypto, 'CAMPMIND_DEMO_MFA', 'production MFA guard'],
  [store, 'assertProductionStoreInjection', 'production adapter guard'],
  [store, 'objectStore', 'private object-store boundary'],
  [store, 'notificationDispatcher', 'provider-backed notification boundary'],
  [service, 'CAMPMIND_NOTIFICATION_ADAPTER_READY', 'runtime notification readiness guard'],
  [expressionSupport, 'student_self_report', 'expression source boundary'],
  [expressionSupport, 'requestDigest', 'expression HMAC idempotency boundary'],
  [expressionSupport, 'expression.share_read', 'explicit share audit'],
  [expressionSupport, 'support.requested', 'ordinary support workflow audit'],
  [service, 'revokeExpressionProcessing', 'expression consent withdrawal boundary'],
  [objectStore, 'aes-256-gcm', 'encrypted private object store'],
  [objectStore, 'OBJECT_KEY_INVALID', 'object-key traversal guard'],
  [scoring, 'SYNTHETIC_SCALE_BLOCKED', 'synthetic scale production guard'],
  [main, 'Content-Security-Policy', 'CSP header'],
  [main, 'MAX_BODY_BYTES', 'request body bound'],
  [main, 'CAMPMIND_VISUAL_DEPLOYMENT_ENABLED', 'student-only visual deployment flag'],
  [main, 'camera=(self)', 'scoped student camera permission'],
  [main, "worker-src 'self'", 'same-origin worker CSP'],
  [adminWeb, 'function clearDashboard()', 'admin shared-terminal cleanup'],
  [adminWeb, 'let sessionEpoch = 0', 'admin async session epoch'],
  [adminWeb, 'isActiveSession(epoch)', 'admin stale-response guard'],
  [adminWeb, "document.querySelectorAll('#dashboard form')", 'admin form cleanup'],
  [studentWeb, "$('#reportList').replaceChildren()", 'student report cleanup'],
  [studentWeb, "$('#rightsList').replaceChildren()", 'student rights cleanup'],
  [studentWeb, 'let sessionEpoch = 0', 'student async session epoch'],
  [studentWeb, 'isActiveSession(epoch)', 'student stale-response guard'],
  [studentWeb, 'active.noticeVersion === currentNoticeVersion', 'student consent notice refresh'],
  [studentWeb, 'let helpSubmitted = false', 'student help debounce state'],
  [studentWeb, '/student/visual-interaction.js', 'explicit visual lifecycle module'],
  [pagesHome, '这是合成数据参考站点', 'public Pages synthetic-data warning'],
  [pagesHome, '不接收真实学生资料', 'public Pages real-data boundary'],
  [pagesHome, '筛查结果不是医学诊断', 'public Pages clinical boundary'],
  [visualScript, 'getUserMedia', 'explicit opt-in camera lifecycle'],
  [visualScript, 'getTracks()', 'camera track release'],
  [visualScript, 'MAX_SESSION_MS', 'visual session timeout'],
  [visualScript, 'beforeStart', 'visual consent callback'],
];
for (const [text, snippet, label] of requiredSnippets) if (!text.includes(snippet)) suspicious.push(`missing ${label}`);
if (/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/.test(visualScript)) suspicious.push('visual lifecycle module must not send network data');
if (/\b(?:getUserMedia|fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/.test(pagesExpressionDemo)) suspicious.push('Pages expression demo must remain offline and camera-free');
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
for (const item of ['.env', 'private-data/', 'exports/', '*.pem', '*.key']) if (!gitignore.includes(item)) suspicious.push(`.gitignore missing ${item}`);
if (suspicious.length) { console.error(suspicious.join('\n')); process.exit(1); }
console.log(`PASS: scanned ${files.length} repository files; no credential patterns; production guards and sensitive-data ignore rules present.`);
console.log('Not checked: penetration testing, provider configuration, legal compliance or production database policy execution.');
