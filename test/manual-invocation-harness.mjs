// Test-only harness for suites that deliberately exercise mocked live provider boundaries.
// This is never imported by production code or GitHub operational workflows.
// Manual-Only regression tests explicitly unset/restore SNS_MANUAL_INVOCATION so both
// marker-present and marker-absent behavior stays covered even when the full suite uses it.
process.env.SNS_MANUAL_INVOCATION = 'true';
