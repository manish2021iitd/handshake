import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditMachine, IllegalTransitionError } from '../src/audit/machine';

test('walks the full legal lifecycle', () => {
  const m = new AuditMachine();
  for (const p of ['NEGOTIATE', 'LOCK', 'DELIVER', 'CLEAR', 'PROBES', 'REPORT'] as const) {
    assert.equal(m.can(p), true, `should allow -> ${p}`);
    m.to(p);
  }
  assert.equal(m.phase, 'REPORT');
  assert.equal(m.history.length, 6);
  assert.equal(m.wasAborted, false);
});

test('rejects illegal jumps', () => {
  const m = new AuditMachine();
  assert.throws(() => m.to('LOCK'), IllegalTransitionError); // can't skip NEGOTIATE
  m.to('NEGOTIATE');
  assert.throws(() => m.to('CLEAR'), IllegalTransitionError);
  assert.throws(() => m.to('REPORT'), IllegalTransitionError); // must go through ABORTED or CLEAR
});

test('abort is reachable from active phases and always ends in REPORT', () => {
  const m = new AuditMachine();
  m.to('NEGOTIATE');
  m.to('LOCK');
  m.abort('price mismatch');
  assert.equal(m.phase, 'ABORTED');
  assert.equal(m.wasAborted, true);
  m.to('REPORT');
  assert.equal(m.phase, 'REPORT');
  assert.equal(m.can('NEGOTIATE'), false); // terminal
  const abortStep = m.history.find((h) => h.to === 'ABORTED');
  assert.equal(abortStep?.note, 'price mismatch');
});

test('CLEAR may go straight to REPORT when probes are disabled', () => {
  const m = new AuditMachine();
  m.to('NEGOTIATE');
  m.to('LOCK');
  m.to('DELIVER');
  m.to('CLEAR');
  m.to('REPORT');
  assert.equal(m.phase, 'REPORT');
});
