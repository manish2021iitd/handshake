import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECKS, type CheckResult } from '../src/audit/checks';
import {
  buildReport,
  renderBadgeSvg,
  signAndWrap,
  verifySignedReport,
  writeArtifacts,
  type SignedReport,
} from '../src/audit/report';
import type { AuditOutcome } from '../src/audit/runner';
import { loadOrCreateKeypair } from '../src/crypto/signing';

const now = new Date().toISOString();
const outcome = (checks: CheckResult[]): AuditOutcome => ({
  target: { serviceId: 'svc_test' },
  startedAt: now,
  finishedAt: now,
  phaseHistory: [],
  checks,
  orders: [],
  notes: [],
});

test('scoring: severity-weighted, skips excluded, critical failure forces FAILED', () => {
  const r = buildReport(
    outcome([
      { ...CHECKS.H01, status: 'pass', details: 'ok' }, // critical, w=3
      { ...CHECKS.H09, status: 'fail', details: 'bad hash' }, // critical, w=3
      { ...CHECKS.H14, status: 'skip', details: 'n/a' }, // excluded
    ]),
  );
  assert.equal(r.score, 50); // 3 / (3+3)
  assert.equal(r.totals.criticalFailures, 1);
  assert.equal(r.verdict, 'FAILED');
});

test('verdicts: >=90 conformant, otherwise partial (absent critical failures)', () => {
  const conformant = buildReport(
    outcome([
      { ...CHECKS.H01, status: 'pass', details: '' },
      { ...CHECKS.H14, status: 'fail', details: 'minor wobble' }, // w=1 fail
      { ...CHECKS.H06, status: 'pass', details: '' },
      { ...CHECKS.H12, status: 'pass', details: '' },
      { ...CHECKS.H08, status: 'pass', details: '' },
    ]),
  );
  assert.equal(conformant.verdict, 'CONFORMANT'); // 12/13 ≈ 92

  const partial = buildReport(
    outcome([
      { ...CHECKS.H01, status: 'pass', details: '' },
      { ...CHECKS.H11, status: 'fail', details: '' }, // major fail, no critical
      { ...CHECKS.H10, status: 'fail', details: '' },
    ]),
  );
  assert.equal(partial.totals.criticalFailures, 0);
  assert.equal(partial.verdict, 'PARTIAL');
});

test('signed reports verify, and any tampering breaks the signature', () => {
  const keys = loadOrCreateKeypair(mkdtempSync(join(tmpdir(), 'hs-keys-')));
  const signed = signAndWrap(
    buildReport(outcome([{ ...CHECKS.H09, status: 'fail', details: 'forged contentHash' }])),
    keys,
  );
  assert.equal(verifySignedReport(signed), true);
  assert.equal(signed.report.verdict, 'FAILED');

  // A provider trying to launder its failing report into a passing one:
  const tampered = JSON.parse(JSON.stringify(signed)) as SignedReport;
  tampered.report.score = 100;
  tampered.report.verdict = 'CONFORMANT';
  tampered.report.checks[0]!.status = 'pass';
  assert.equal(verifySignedReport(tampered), false);
});

test('artifacts: report JSON, SVG badge, and markdown snippet are written', () => {
  const keys = loadOrCreateKeypair(mkdtempSync(join(tmpdir(), 'hs-keys-')));
  const signed = signAndWrap(
    buildReport(outcome([{ ...CHECKS.H01, status: 'pass', details: 'ok' }])),
    keys,
  );
  const dir = mkdtempSync(join(tmpdir(), 'hs-out-'));
  const a = writeArtifacts(signed, dir);
  for (const p of [a.reportPath, a.badgePath, a.snippetPath]) {
    assert.ok(statSync(p).size > 0, `${p} should exist and be non-empty`);
  }
  assert.ok(renderBadgeSvg('CONFORMANT', 97).includes('CONFORMANT · 97'));
  assert.ok(renderBadgeSvg('FAILED', 12).includes('FAILED'));
});
