import type { AuditPhase } from './machine';

export type Severity = 'critical' | 'major' | 'minor';
export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckDef {
  id: string;
  title: string;
  phase: AuditPhase;
  severity: Severity;
}

export interface CheckResult extends CheckDef {
  status: CheckStatus;
  details: string;
  evidence?: Record<string, string>;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };

const def = (id: string, title: string, phase: AuditPhase, severity: Severity): CheckDef => ({
  id,
  title,
  phase,
  severity,
});

/**
 * The Handshake conformance suite. One row per verifiable property of a
 * CAP provider's order lifecycle. This table is the product.
 */
export const CHECKS = {
  H01: def('H01', 'Negotiation created and acknowledged', 'NEGOTIATE', 'critical'),
  H02: def('H02', 'Provider accepts negotiation within window', 'NEGOTIATE', 'critical'),
  H03: def('H03', 'Order created on-chain (createTxHash present)', 'NEGOTIATE', 'critical'),
  H04: def('H04', 'Order price matches advertised price (no bait-and-switch)', 'NEGOTIATE', 'critical'),
  H05: def('H05', 'Deadlines coherent (payDeadline / slaDeadline / deliveryWindow)', 'NEGOTIATE', 'major'),
  H06: def('H06', 'Payment accepted, escrow locked (payTxHash, status=paid)', 'LOCK', 'critical'),
  H07: def('H07', 'Requester debited exactly price (+ fee) — escrow accounting', 'LOCK', 'critical'),
  H08: def('H08', 'Delivery completed within SLA deadline', 'DELIVER', 'critical'),
  H09: def('H09', 'Delivery proof integrity: contentHash == sha256(payload)', 'DELIVER', 'critical'),
  H10: def('H10', 'Deliverable type conforms to service contract', 'DELIVER', 'major'),
  H11: def('H11', 'Deliverable echoes request nonce (fresh work, not canned)', 'DELIVER', 'major'),
  H12: def('H12', 'Settlement cleared on-chain (status=completed, clearTxHash)', 'CLEAR', 'critical'),
  H13: def('H13', 'Provider credited exactly the order price', 'CLEAR', 'major'),
  H14: def('H14', 'Lifecycle tx hashes present and pairwise distinct', 'CLEAR', 'minor'),
  H15: def('H15', 'Refund path: post-payment reject refunds requester in full', 'PROBES', 'major'),
  H16: def('H16', 'Double-pay rejected with INVALID_STATUS (idempotent escrow)', 'PROBES', 'major'),
  H17: def('H17', 'Unknown service yields clean NOT_FOUND (no hang, no 500)', 'PROBES', 'minor'),
  H18: def('H18', 'Foreign deliverOrder rejected (role enforcement)', 'PROBES', 'minor'),
} as const satisfies Record<string, CheckDef>;

export type CheckId = keyof typeof CHECKS;

export class CheckLog {
  readonly results: CheckResult[] = [];

  #add(d: CheckDef, status: CheckStatus, details: string, evidence?: Record<string, string>): void {
    this.results.push({ ...d, status, details, ...(evidence ? { evidence } : {}) });
  }

  pass(d: CheckDef, details: string, evidence?: Record<string, string>): void {
    this.#add(d, 'pass', details, evidence);
  }

  fail(d: CheckDef, details: string, evidence?: Record<string, string>): void {
    this.#add(d, 'fail', details, evidence);
  }

  skip(d: CheckDef, details: string): void {
    this.#add(d, 'skip', details);
  }

  /** pass/fail based on a condition, with separate detail strings. */
  expect(
    d: CheckDef,
    ok: boolean,
    passDetails: string,
    failDetails: string,
    evidence?: Record<string, string>,
  ): boolean {
    if (ok) this.pass(d, passDetails, evidence);
    else this.fail(d, failDetails, evidence);
    return ok;
  }

  hasCriticalFailure(): boolean {
    return this.results.some((r) => r.status === 'fail' && r.severity === 'critical');
  }

  /** Mark every check in the registry that was never executed as skipped. */
  fillSkipped(reason: string): void {
    const seen = new Set(this.results.map((r) => r.id));
    for (const d of Object.values(CHECKS)) {
      if (!seen.has(d.id)) this.skip(d, reason);
    }
  }
}
