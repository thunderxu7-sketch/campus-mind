import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.env.CAMPMIND_RELEASE_MODE ?? 'reference';
if (!['reference', 'production'].includes(mode)) throw new Error('CAMPMIND_RELEASE_MODE must be reference or production');

const checks = [
  { id: 'source-plan', label: '规划与生成任务清单存在', pass: existsSync(join(root, 'planning/backlog.json')) && existsSync(join(root, 'docs/07-task-breakdown.md')) },
  { id: 'safety-boundary', label: '生产配置拒绝演示后端/MFA', pass: readFileSync(join(root, 'apps/api/src/domain/crypto.ts'), 'utf8').includes('CAMPMIND_DATA_BACKEND !== \'postgres\'') && readFileSync(join(root, 'apps/api/src/domain/crypto.ts'), 'utf8').includes('CAMPMIND_DEMO_MFA') },
  { id: 'synthetic-fixtures', label: '仓库未纳入真实资料', pass: execFileSync('git', ['ls-files', 'private-data'], { cwd: root, encoding: 'utf8' }).trim() === '' },
];

const productionEvidence = [
  ['CAMPMIND_SCOPE_APPROVED', '试点范围与责任签署'],
  ['CAMPMIND_SCALE_EVIDENCE', '量表授权/适龄/金标准证据'],
  ['CAMPMIND_PRIVACY_APPROVED', '隐私影响评估与数据生命周期审批'],
  ['CAMPMIND_CRISIS_ONCALL_CONFIGURED', '危机值班/备用/转介配置'],
  ['CAMPMIND_CAPACITY_EVIDENCE', '目标容量与恢复演练证据'],
  ['CAMPMIND_SECURITY_REVIEWED', '安全与隐私上线评审'],
  ['CAMPMIND_PILOT_APPROVED', '校方受控试点批准'],
  ['CAMPMIND_REGIONAL_ANALYTICS_APPROVED', '区域聚合用途与接收范围审批'],
  ['CAMPMIND_MEDIA_SCANNER_READY', '媒体恶意文件扫描适配器就绪'],
  ['CAMPMIND_NOTIFICATION_ADAPTER_READY', '通知供应商适配器与补偿策略就绪'],
].map(([env, label]) => ({ id: env.replace(/^CAMPMIND_/, '').toLowerCase(), label, pass: process.env[env] === 'true' }));

if (mode === 'production') checks.push(...productionEvidence, { id: 'postgres-backend', label: '生产使用 PostgreSQL 适配器', pass: process.env.CAMPMIND_DATA_BACKEND === 'postgres' && process.env.CAMPMIND_POSTGRES_ADAPTER_READY === 'true' }, { id: 'object-store-adapter', label: '生产使用私有对象存储适配器', pass: process.env.CAMPMIND_OBJECT_STORE_ADAPTER_READY === 'true' }, { id: 'demo-mfa-disabled', label: '生产未启用演示 MFA 绕过', pass: process.env.CAMPMIND_DEMO_MFA !== 'true' });
const expressionEnabled = process.env.CAMPMIND_EXPRESSION_ENABLED === 'true';
const visualEnabled = process.env.CAMPMIND_VISUAL_DEPLOYMENT_ENABLED === 'true';
if (mode === 'production' && expressionEnabled) {
  checks.push(
    { id: 'expression-governance', label: '表达用途、适龄、拒绝路径与危机边界证据', pass: process.env.CAMPMIND_EXPRESSION_GOVERNANCE_EVIDENCE === 'true' },
    { id: 'expression-privacy', label: '表达最小采集、权限、撤回、留存与恢复证据', pass: process.env.CAMPMIND_EXPRESSION_PRIVACY_EVIDENCE === 'true' },
    { id: 'expression-flow', label: '表达流程、并发、越权、无摄像头回归证据', pass: process.env.CAMPMIND_EXPRESSION_FLOW_EVIDENCE === 'true' },
    { id: 'expression-ops', label: '表达接续人员、服务时段、备援与通知演练证据', pass: process.env.CAMPMIND_EXPRESSION_OPS_EVIDENCE === 'true' },
  );
}
if (mode === 'production' && visualEnabled) checks.push({ id: 'expression-visual', label: '视觉模型/SDK许可、端侧网络、资源释放与设备证据', pass: process.env.CAMPMIND_EXPRESSION_VISUAL_EVIDENCE === 'true' });
const failed = checks.filter((check) => !check.pass);
const result = { mode, status: failed.length === 0 ? 'pass' : 'blocked', checks, note: mode === 'reference' ? '参考模式只验证仓库边界；不代表真实试点获准。' : '生产模式必须由责任人提供所有外部签署证据。' };
console.log(JSON.stringify(result));
if (failed.length > 0 && mode === 'production') process.exitCode = 1;
