/**
 * Audit phase machine.
 *
 * Phases mirror CAP's order lifecycle (Negotiate → Lock → Deliver → Clear),
 * plus PROBES (adversarial checks that need a settled main order first) and a
 * terminal REPORT phase. ABORTED is reachable from any active phase — a
 * critical failure stops fund-risking activity immediately, but every path
 * still terminates in REPORT: an aborted audit is a *finding*, not a crash.
 */
export type AuditPhase =
  | 'INIT'
  | 'NEGOTIATE'
  | 'LOCK'
  | 'DELIVER'
  | 'CLEAR'
  | 'PROBES'
  | 'ABORTED'
  | 'REPORT';

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: AuditPhase,
    readonly to: AuditPhase,
  ) {
    super(`illegal audit transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

const TRANSITIONS: Record<AuditPhase, readonly AuditPhase[]> = {
  INIT: ['NEGOTIATE'],
  NEGOTIATE: ['LOCK', 'ABORTED'],
  LOCK: ['DELIVER', 'ABORTED'],
  DELIVER: ['CLEAR', 'ABORTED'],
  CLEAR: ['PROBES', 'REPORT', 'ABORTED'],
  PROBES: ['REPORT'],
  ABORTED: ['REPORT'],
  REPORT: [],
};

export interface PhaseTransition {
  from: AuditPhase;
  to: AuditPhase;
  at: string;
  note?: string;
}

export class AuditMachine {
  #phase: AuditPhase = 'INIT';
  readonly history: PhaseTransition[] = [];

  get phase(): AuditPhase {
    return this.#phase;
  }

  can(to: AuditPhase): boolean {
    return TRANSITIONS[this.#phase].includes(to);
  }

  to(to: AuditPhase, note?: string): void {
    if (!this.can(to)) throw new IllegalTransitionError(this.#phase, to);
    this.history.push({
      from: this.#phase,
      to,
      at: new Date().toISOString(),
      ...(note ? { note } : {}),
    });
    this.#phase = to;
  }

  /** Abort from the current phase with a reason. */
  abort(note: string): void {
    this.to('ABORTED', note);
  }

  get wasAborted(): boolean {
    return this.history.some((h) => h.to === 'ABORTED');
  }
}
