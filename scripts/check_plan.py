#!/usr/bin/env python3
"""Validate planning metadata and local docs, not application behavior or compliance."""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'planning/backlog.json'
GENERATED = ROOT / 'docs/07-task-breakdown.md'


def validate(plan: dict) -> list[str]:
    errors: list[str] = []
    if plan.get('schema_version') != 1:
        errors.append('Unsupported schema_version')
    milestones = plan.get('milestones', [])
    subsystems = plan.get('subsystems', [])
    tasks = plan.get('tasks', [])
    for key, items in [('milestones', milestones), ('subsystems', subsystems), ('tasks', tasks)]:
        if not isinstance(items, list) or not items or not all(isinstance(i, dict) for i in items):
            return [f'{key} must be a non-empty list of objects']
        ids = [i.get('id') for i in items]
        if any(not isinstance(i, str) or not i for i in ids):
            return [f'{key} contains an invalid id']
        if len(ids) != len(set(ids)):
            errors.append(f'Duplicate id in {key}')
        if any(not isinstance(i.get('title'), str) or not i['title'].strip() for i in items):
            errors.append(f'Missing title in {key}')
    ranks = {m['id']: i for i, m in enumerate(milestones)}
    subsystem_ids = {s['id'] for s in subsystems}
    by_id = {t['id']: t for t in tasks}
    graph: dict[str, list[str]] = {}
    for task in tasks:
        tid = task['id']
        if not re.fullmatch(r'CM-\d{3}', tid):
            errors.append(f'{tid}: invalid task id')
        for key in ['owner', 'deliverable']:
            if not isinstance(task.get(key), str) or not task[key].strip():
                errors.append(f'{tid}: missing {key}')
        if task.get('priority') not in {'P0', 'P1', 'P2'}:
            errors.append(f'{tid}: invalid priority')
        if task.get('status') not in {'planned', 'in_progress', 'blocked', 'done'}:
            errors.append(f'{tid}: invalid status')
        if task.get('milestone') not in ranks:
            errors.append(f'{tid}: unknown milestone')
        if task.get('subsystem') not in subsystem_ids:
            errors.append(f'{tid}: unknown subsystem')
        acceptance = task.get('acceptance')
        if not isinstance(acceptance, list) or len(acceptance) < 2 or not all(isinstance(a, str) and a.strip() for a in acceptance):
            errors.append(f'{tid}: at least two nonempty acceptance criteria required')
        deps = task.get('dependencies')
        if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
            errors.append(f'{tid}: dependencies must be a list of ids')
            deps = []
        if len(deps) != len(set(deps)):
            errors.append(f'{tid}: duplicate dependency')
        graph[tid] = []
        for dep in deps:
            if dep not in by_id:
                errors.append(f'{tid}: unknown dependency {dep}')
                continue
            graph[tid].append(dep)
            if ranks.get(by_id[dep].get('milestone'), -1) > ranks.get(task.get('milestone'), -1):
                errors.append(f'{tid}: dependency {dep} is in a later milestone')
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(tid: str) -> None:
        if tid in visiting:
            errors.append(f'Dependency cycle at {tid}')
            return
        if tid in visited:
            return
        visiting.add(tid)
        for dep in graph.get(tid, []):
            visit(dep)
        visiting.remove(tid)
        visited.add(tid)

    for tid in graph:
        visit(tid)
    missing = subsystem_ids - {t.get('subsystem') for t in tasks}
    if missing:
        errors.append(f'Subsystems without tasks: {sorted(missing)}')
    gate = plan.get('readiness_gate', {})
    required = gate.get('required_tasks', [])
    if not isinstance(required, list) or not required or not all(isinstance(x, str) for x in required):
        errors.append('Gate must specify required_tasks')
        required = []
    if gate.get('milestone') not in ranks:
        errors.append('Gate has unknown milestone')
    for tid in required:
        if tid not in by_id:
            errors.append(f'Gate has unknown task {tid}')
        elif ranks.get(by_id[tid].get('milestone'), -1) > ranks.get(gate.get('milestone'), -1):
            errors.append(f'Gate includes later task {tid}')
    if len(required) != len(set(required)):
        errors.append('Gate has duplicate tasks')
    for task in tasks:
        if task.get('priority') == 'P0' and task['id'] not in required:
            errors.append(f'P0 task {task["id"]} missing from readiness gate')
    return errors


def render(plan: dict) -> str:
    tasks = plan['tasks']
    counts = Counter(t['priority'] for t in tasks)
    lines = [
        '# 可执行开发任务', '',
        '> 自动生成：只修改 `planning/backlog.json`，然后运行 `python3 scripts/check_plan.py --write`。', '',
        f'规划基线：{plan["updated_at"]}。共 **{len(tasks)} 项**：' + ' / '.join(f'{p} {counts[p]}' for p in ['P0', 'P1', 'P2']) + '。', '',
        '优先级不等于可跳过里程碑 Gate；当前 `planned` 代表待开发，owner 为责任岗位而非已分配人员。', '',
        '完整范围与待决策问题见[路线图](06-roadmap.md)，具体测试场景见[验收矩阵](08-verification.md)。', '',
        '## 总览', '',
        '| ID | 任务 | 优先级 | 阶段 | 子系统 | 依赖 |',
        '|---|---|---|---|---|---|',
    ]
    for task in tasks:
        lines.append(f'| {task["id"]} | {task["title"]} | {task["priority"]} | {task["milestone"]} | {task["subsystem"]} | {", ".join(task["dependencies"]) or "—"} |')
    for milestone in plan['milestones']:
        lines.extend(['', f'## {milestone["id"]} · {milestone["title"]}', '', milestone['description']])
        for task in tasks:
            if task['milestone'] != milestone['id']:
                continue
            lines.extend([
                '', f'### {task["id"]} · {task["title"]}', '',
                f'- 优先级：**{task["priority"]}** · 子系统：{task["subsystem"]} · 状态：`{task["status"]}`',
                f'- 责任岗位：{task["owner"]}',
                f'- 依赖：{", ".join(task["dependencies"]) or "无"}',
                f'- 交付物：{task["deliverable"]}',
                '- 验收：',
            ])
            lines.extend(f'  - [ ] {a}' for a in task['acceptance'])
    lines.extend(['', '## 试点准入 Gate', '', plan['readiness_gate']['note'], '',
                  '必须完成：' + '、'.join(plan['readiness_gate']['required_tasks']) + '。', ''])
    return '\n'.join(lines)


def check_links(root: Path) -> list[str]:
    """Check local Markdown file targets; remote reachability and anchors are not checked."""
    errors = []
    for path in root.rglob('*.md'):
        if '.git' in path.parts:
            continue
        for raw in re.findall(r'\[[^\]]*\]\(([^\s)]+)\)', path.read_text()):
            url = urlsplit(raw)
            if url.scheme or url.netloc or not url.path:
                continue
            target = (path.parent / unquote(url.path)).resolve()
            if not target.is_file():
                errors.append(f'{path.relative_to(root)}: missing local link {raw}')
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='Regenerate task Markdown after validation')
    args = parser.parse_args()
    try:
        plan = json.loads(SOURCE.read_text())
        if not isinstance(plan, dict):
            raise ValueError('Plan must be an object')
    except (ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    errors = validate(plan)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    expected = render(plan)
    if args.write:
        GENERATED.write_text(expected)
    elif not GENERATED.exists() or GENERATED.read_text() != expected:
        errors.append('Task Markdown is out of sync; run with --write')
    errors.extend(check_links(ROOT))
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print(f'PASS: {len(plan["tasks"])} tasks, {len(plan["milestones"])} milestones, {len(plan["subsystems"])} subsystems; DAG, gate, generated Markdown and local links valid.')
    print('Not checked: application behavior, clinical validity, legal compliance, remote links or Markdown anchors.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
