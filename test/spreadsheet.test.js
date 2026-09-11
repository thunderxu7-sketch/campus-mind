import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXlsxBase64 } from '../dist/apps/api/src/domain/spreadsheet.js';

const fixture = 'UEsDBBQAAAAAAFhtK13Wd7U0TQIAAE0CAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48d29ya3NoZWV0IHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvc3ByZWFkc2hlZXRtbC8yMDA2L21haW4iPjxzaGVldERhdGE+PHJvdyByPSIxIj48YyByPSJBMSIgdD0iaW5saW5lU3RyIj48aXM+PHQ+ZXh0ZXJuYWxJZDwvdD48L2lzPjwvYz48YyByPSJCMSIgdD0iaW5saW5lU3RyIj48aXM+PHQ+ZGlzcGxheU5hbWU8L3Q+PC9pcz48L2M+PGMgcj0iQzEiIHQ9ImlubGluZVN0ciI+PGlzPjx0PmFnZTwvdD48L2lzPjwvYz48YyByPSJEMSIgdD0iaW5saW5lU3RyIj48aXM+PHQ+Y2xhc3NJZDwvdD48L2lzPjwvYz48L3Jvdz48cm93IHI9IjIiPjxjIHI9IkEyIiB0PSJpbmxpbmVTdHIiPjxpcz48dD54bHN4LWRlbW8tMDAxPC90PjwvaXM+PC9jPjxjIHI9IkIyIiB0PSJpbmxpbmVTdHIiPjxpcz48dD7lkIjmiJDooajmoLzlrabnlJ88L3Q+PC9pcz48L2M+PGMgcj0iQzIiPjx2PjE1PC92PjwvYz48YyByPSJEMiIgdD0iaW5saW5lU3RyIj48aXM+PHQ+Y2xhc3MtZGVtby0xPC90PjwvaXM+PC9jPjwvcm93Pjwvc2hlZXREYXRhPjwvd29ya3NoZWV0PlBLAQIUAxQAAAAAAFhtK13Wd7U0TQIAAE0CAAAYAAAAAAAAAAAAAACAAQAAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAEAAQBGAAAAgwIAAAAA';

test('bounded XLSX reader maps the first worksheet without running formulas', () => {
  // The fixture is synthetic and contains only a header plus one student row.
  const rows = parseXlsxBase64(fixture);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { externalId: 'xlsx-demo-001', displayName: '合成表格学生', age: '15', classId: 'class-demo-1' });
});

test('invalid or oversized workbook is rejected', () => {
  assert.throws(() => parseXlsxBase64('not-a-workbook'), /XLSX/);
  assert.throws(() => parseXlsxBase64(Buffer.from('bad').toString('base64'), 2), /大小/);
});
