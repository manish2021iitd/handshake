import type { CheckResult } from '../audit/checks';
import type { AuditReport } from '../audit/report';
import type { OrderEvidence } from '../audit/runner';
import type { PhaseTransition } from '../audit/machine';
import { c, mark } from './log';

const trunc = (s: string, n = 96): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function printPhases(history: PhaseTransition[]): void {
  if (history.length === 0) return;
  const path = [history[0]!.from, ...history.map((h) => h.to)];
  console.log(`${c.dim('phases ')} ${path.map((p) => (p === 'ABORTED' ? c.red(p) : c.cyan(p))).join(c.dim(' → '))}`);
}

export function printChecks(checks: CheckResult[]): void {
  for (const r of checks) {
    const sym = mark[r.status];
    const sev = c.dim(`[${r.severity}]`.padEnd(10));
    console.log(`  ${sym}  ${c.bold(r.id)} ${sev} ${r.title}`);
    console.log(`          ${c.dim(trunc(r.details))}`);
  }
}

export function printOrders(orders: OrderEvidence[]): void {
  if (orders.length === 0) {
    console.log(c.dim('  (no orders were created — nothing was ever at risk)'));
    return;
  }
  for (const o of orders) {
    console.log(`  ${c.bold(o.label.padEnd(13))} ${o.orderId}  status=${o.status}  price=${o.price}`);
    for (const [k, v] of Object.entries(o.txHashes)) {
      console.log(`      ${c.dim(`${k.padEnd(14)} ${v}`)}`);
    }
  }
}

export function printVerdict(report: AuditReport): void {
  const color =
    report.verdict === 'CONFORMANT' ? c.green : report.verdict === 'PARTIAL' ? c.yellow : c.red;
  const t = report.totals;
  console.log(
    `\n${color(c.bold(` VERDICT: ${report.verdict} `))} score ${c.bold(String(report.score))}/100  ` +
      c.dim(`(${t.pass} pass · ${t.fail} fail · ${t.skip} skip · ${t.criticalFailures} critical)`),
  );
  for (const n of report.notes) console.log(c.dim(`  note: ${n}`));
}
