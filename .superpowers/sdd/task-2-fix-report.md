Status: DONE
Commit: 88cbc012
Files changed
- hoga/api/routes.py
- tests/unit/api/test_range_volume_distribution_cutoff.py
- .superpowers/sdd/task-2-fix-report.md
Tests run with pass/fail
- PASS: uv run pytest tests/unit/api/test_range_volume_distribution_cutoff.py -q
- PASS: git diff --check -- hoga/api/routes.py hoga/api/bundle.py tests/unit/api/test_range_volume_distribution_cutoff.py
Notes/risks
- Cutoff requests are now rejected unless mode=sidecar.
- Cutoff epochs are validated against the single requested Stock-Date before bundle construction, returning HTTP 400 for out-of-date cursors.
- Existing unrelated modified files were left untouched.
