"""Tests for the planning validator; not product tests."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('check_plan', ROOT / 'scripts/check_plan.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
BASE = json.loads((ROOT / 'planning/backlog.json').read_text())


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.plan = copy.deepcopy(BASE)

    def assert_rejected(self, message):
        self.assertTrue(any(message in e for e in checker.validate(self.plan)))

    def test_current_plan_valid(self):
        self.assertEqual(checker.validate(self.plan), [])

    def test_duplicate_id_rejected(self):
        self.plan['tasks'].append(copy.deepcopy(self.plan['tasks'][0]))
        self.assert_rejected('Duplicate id')

    def test_unknown_dependency_rejected(self):
        self.plan['tasks'][0]['dependencies'] = ['CM-999']
        self.assert_rejected('unknown dependency')

    def test_cycle_rejected(self):
        self.plan['tasks'][0]['dependencies'] = ['CM-002']
        self.assert_rejected('Dependency cycle')

    def test_future_milestone_dependency_rejected(self):
        self.plan['tasks'][0]['dependencies'] = ['CM-048']
        self.assert_rejected('later milestone')

    def test_empty_acceptance_rejected(self):
        self.plan['tasks'][0]['acceptance'] = []
        self.assert_rejected('acceptance criteria')

    def test_missing_owner_rejected(self):
        self.plan['tasks'][0]['owner'] = ''
        self.assert_rejected('missing owner')

    def test_unknown_subsystem_rejected(self):
        self.plan['tasks'][0]['subsystem'] = 'S99'
        self.assert_rejected('unknown subsystem')

    def test_p0_omitted_from_gate_rejected(self):
        self.plan['readiness_gate']['required_tasks'].remove('CM-001')
        self.assert_rejected('missing from readiness gate')

    def test_render_includes_every_task(self):
        output = checker.render(self.plan)
        for task in self.plan['tasks']:
            self.assertIn(f'### {task["id"]} ·', output)
        self.assertEqual(output, checker.render(self.plan))

    def test_generated_file_matches(self):
        self.assertEqual(checker.render(self.plan), checker.GENERATED.read_text())

    def test_local_link_target_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'existing.md').write_text('# Exists')
            (root / 'README.md').write_text('[ok](existing.md) [bad](missing.md) [remote](https://example.com)')
            errors = checker.check_links(root)
            self.assertEqual(len(errors), 1)
            self.assertIn('missing.md', errors[0])


if __name__ == '__main__':
    unittest.main()
