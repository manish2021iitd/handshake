import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport } from '../src/audit/report';
import { runAudit, type AuditOptions } from '../src/audit/runner';
import { makeBench, USDC, type Bench } from '../src/mock/fixtures';
import type { ProviderProfile } from '../src/mock/network';

const optsFor = (bench: Bench, profile: ProviderProfile): AuditOptions => ({
  serviceId: bench.services[profile],
  expectedPrice: bench.advertisedPrice[profile],
  acceptTimeoutMs: 800,
  deliveryGraceMs: 400,
  pollIntervalMs: 20,
  probes: { refund: true },
  balances: bench.balancesFor('handshake'),
  expectedDeliverableType: 'text',
});

const byId = (report: ReturnType<typeof buildReport>, id: string) =>
  report.checks.find((c) => c.id === id)!;

test('good provider: fully conformant, two orders, exact accounting', async () => {
  const bench = makeBench();
  try {
    const outcome = await runAudit(bench.handshake, optsFor(bench, 'good'));
    const report = buildReport(outcome);

    assert.equal(report.verdict, 'CONFORMANT');
    assert.equal(report.score, 100);
    assert.equal(report.totals.fail, 0);
    assert.equal(report.totals.skip, 0); // balance reader + all probes → every check executed
    assert.equal(report.orders.length, 2); // main + refund probe
    assert.equal(byId(report, 'H15').status, 'pass');

    // Paid 1 USDC for the main order (kept by provider); refund probe nets to zero.
    assert.equal(bench.net.balanceOfAgent('handshake'), USDC(99));
    assert.equal(bench.net.balanceOfAgent('good-provider'), USDC(1));
  } finally {
    bench.net.shutdown();
  }
});

test('slow provider: blows SLA, order expires, escrow refunded in full', async () => {
  const bench = makeBench();
  try {
    const outcome = await runAudit(bench.handshake, optsFor(bench, 'slow'));
    const report = buildReport(outcome);

    assert.equal(byId(report, 'H08').status, 'fail');
    assert.equal(report.verdict, 'FAILED');
    assert.equal(report.orders.length, 1);
    assert.equal(report.orders[0]!.status, 'expired');
    assert.ok(outcome.phaseHistory.some((h) => h.to === 'ABORTED'));
    assert.ok(report.notes.some((n) => n.includes('refunded in full')));
    // Expiry refunded the escrow — the auditor is made whole.
    assert.equal(bench.net.balanceOfAgent('handshake'), USDC(100));
  } finally {
    bench.net.shutdown();
  }
});

test('ghost provider: never accepts — audit aborts with zero funds at risk', async () => {
  const bench = makeBench();
  try {
    const outcome = await runAudit(bench.handshake, optsFor(bench, 'ghost'));
    const report = buildReport(outcome);

    assert.equal(byId(report, 'H02').status, 'fail');
    assert.equal(report.verdict, 'FAILED');
    assert.equal(report.orders.length, 0);
    assert.equal(bench.net.balanceOfAgent('handshake'), USDC(100)); // untouched
  } finally {
    bench.net.shutdown();
  }
});

test('tampering provider: contentHash mismatch is caught (H09)', async () => {
  const bench = makeBench();
  try {
    const outcome = await runAudit(bench.handshake, optsFor(bench, 'tamper'));
    const report = buildReport(outcome);

    assert.equal(byId(report, 'H08').status, 'pass'); // delivered on time…
    assert.equal(byId(report, 'H09').status, 'fail'); // …but the proof is forged
    assert.equal(report.verdict, 'FAILED');
    assert.ok(report.totals.criticalFailures >= 1);
  } finally {
    bench.net.shutdown();
  }
});

test('overpricing provider: bait-and-switch caught BEFORE paying (H04)', async () => {
  const bench = makeBench();
  try {
    const outcome = await runAudit(bench.handshake, optsFor(bench, 'overprice'));
    const report = buildReport(outcome);

    assert.equal(byId(report, 'H04').status, 'fail');
    assert.equal(report.verdict, 'FAILED');
    assert.equal(report.orders.length, 1);
    assert.equal(report.orders[0]!.status, 'created'); // never paid
    assert.ok(outcome.phaseHistory.some((h) => h.to === 'ABORTED'));
    assert.equal(byId(report, 'H06').status, 'skip'); // LOCK never reached
    // Not a single base unit left the auditor's wallet.
    assert.equal(bench.net.balanceOfAgent('handshake'), USDC(100));
  } finally {
    bench.net.shutdown();
  }
});
