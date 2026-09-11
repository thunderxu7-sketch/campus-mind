# Campus Mind project instructions

- Current scope is planning only until a user explicitly requests implementation. Do not pretend the product runs.
- Never commit real student data, answer sets, clinical records, secrets, or unlicensed scale text. Use visibly synthetic fixtures.
- Preserve separate identities, least privilege and tenant isolation across API, database, workers, exports and object storage.
- Screening is not diagnosis. Do not introduce automatic crisis closure, automated treatment, psychological rankings, or LLM-based risk decisions.
- Scale text, scoring, norms and warning rules require provenance, versioning and qualified review before real use. Synthetic scales must be barred from production publication.
- Do not force participation or silently override consent, age suitability or frequency controls.
- Keep planning/backlog.json and generated docs/07-task-breakdown.md in sync with python3 scripts/check_plan.py --write.
- Run python3 scripts/check_plan.py and python3 -m unittest discover -s tests -v for planning changes; later implementation adds behavior-specific checks.
- GitHub contains engineering material only; live data and private security findings stay in approved private storage.
- Use Conventional Commits and branches prefixed with codex/ when creating development branches. Do not deploy or expose a service just because code is committed.
