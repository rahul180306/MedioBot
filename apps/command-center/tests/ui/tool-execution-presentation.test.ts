import assert from 'node:assert/strict';
import test from 'node:test';
import { getOutcomeBadge } from '../../src/features/activity/toolExecutionPresentation.ts';

test('check outcome labels distinguish process launch, nonzero exit, cancellation, and command success', () => {
  const base = { toolName: 'terminal.execute', isVerification: true } as const;
  assert.equal(getOutcomeBadge({ ...base, status: 'failed', verificationStatus: 'command-failed', exitCode: null,
    error: 'Command could not start (ENOENT).' })?.label, '✗ could not start (ENOENT)');
  assert.equal(getOutcomeBadge({ ...base, status: 'failed', verificationStatus: 'command-failed', exitCode: 2 })?.label,
    '✗ check exited 2');
  assert.equal(getOutcomeBadge({ ...base, status: 'failed', verificationStatus: 'command-failed', exitCode: null,
    terminationSignal: 'SIGTERM' })?.label, '✗ terminated SIGTERM');
  assert.equal(getOutcomeBadge({ ...base, status: 'cancelled', verificationStatus: 'unverified' })?.label, 'cancelled');
  assert.equal(getOutcomeBadge({ ...base, status: 'success', verificationStatus: 'command-succeeded', exitCode: 0 })?.label,
    '✓ check exited 0');
  assert.equal(getOutcomeBadge({ ...base, status: 'success', verificationStatus: 'command-succeeded', exitCode: 0,
    recoveredFromExecution: true })?.label, '↺ restored · exit 0');
  assert.doesNotMatch(getOutcomeBadge({ ...base, status: 'success', verificationStatus: 'command-succeeded', exitCode: 0 })?.label ?? '',
    /verified/i, 'exit code 0 is command evidence, not independent verification of task correctness');
});
