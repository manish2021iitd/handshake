import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrCreateKeypair, signPayload, verifyPayload, type Keypair } from '../crypto/signing';
import { stableStringify } from '../util/hash';
import { SEVERITY_WEIGHT, type CheckResult } from './checks';
import type { AuditOutcome } from './runner';

export type Verdict = 'CONFORMANT' | 'PARTIAL' | 'FAILED';

export interface AuditReport {
  reportVersion: 1;
  auditor: 'handshake';
  target: AuditOutcome['target'];
  startedAt: string;
  finishedAt: string;
  phaseHistory: AuditOutcome['phaseHistory'];
  checks: CheckResult[];
  orders: AuditOutcome['orders'];
  notes: string[];
  totals: { pass: number; fail: number; skip: number; criticalFailures: number };
  /** Severity-weighted pass rate over executed checks, 0–100. */
  score: number;
  verdict: Verdict;
}

export interface SignedReport {
  report: AuditReport;
  signature: {
    alg: 'ed25519';
    canonicalization: 'sorted-keys-json';
    publicKeyPem: string;
    signature: string; // hex over stableStringify(report)
  };
}

export function buildReport(outcome: AuditOutcome): AuditReport {
  const totals = { pass: 0, fail: 0, skip: 0, criticalFailures: 0 };
  let wPass = 0;
  let wTotal = 0;
  for (const c of outcome.checks) {
    totals[c.status] += 1;
    if (c.status === 'skip') continue;
    const w = SEVERITY_WEIGHT[c.severity];
    wTotal += w;
    if (c.status === 'pass') wPass += w;
    else if (c.severity === 'critical') totals.criticalFailures += 1;
  }
  const score = wTotal === 0 ? 0 : Math.round((wPass / wTotal) * 100);
  const verdict: Verdict =
    totals.criticalFailures > 0 || wTotal === 0 ? 'FAILED' : score >= 90 ? 'CONFORMANT' : 'PARTIAL';

  return {
    reportVersion: 1,
    auditor: 'handshake',
    target: outcome.target,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    phaseHistory: outcome.phaseHistory,
    checks: outcome.checks,
    orders: outcome.orders,
    notes: outcome.notes,
    totals,
    score,
    verdict,
  };
}

export function signAndWrap(report: AuditReport, keys: Keypair = loadOrCreateKeypair()): SignedReport {
  const canonical = stableStringify(report);
  return {
    report,
    signature: {
      alg: 'ed25519',
      canonicalization: 'sorted-keys-json',
      publicKeyPem: keys.publicKeyPem,
      signature: signPayload(canonical, keys.privateKeyPem),
    },
  };
}

export function verifySignedReport(sr: SignedReport): boolean {
  return verifyPayload(stableStringify(sr.report), sr.signature.signature, sr.signature.publicKeyPem);
}

const BADGE_COLORS: Record<Verdict, string> = {
  CONFORMANT: '#2e7d32',
  PARTIAL: '#ed6c02',
  FAILED: '#c62828',
};

/** Self-contained SVG badge (shields-style pill, generated — no external assets). */
export function renderBadgeSvg(verdict: Verdict, score: number): string {
  const label = 'CAP AUDIT';
  const value = verdict === 'FAILED' ? 'FAILED' : `${verdict} · ${score}`;
  const lw = 8 + label.length * 7.2;
  const vw = 14 + value.length * 7.6;
  const w = Math.round(lw + vw);
  const color = BADGE_COLORS[verdict];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24" role="img" aria-label="${label}: ${value}">
  <clipPath id="r"><rect width="${w}" height="24" rx="4"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${Math.round(lw)}" height="24" fill="#3a3f44"/>
    <rect x="${Math.round(lw)}" width="${Math.round(vw)}" height="24" fill="${color}"/>
  </g>
  <g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="${Math.round(lw / 2)}" y="16">${label}</text>
    <text x="${Math.round(lw + vw / 2)}" y="16" font-weight="bold">${value}</text>
  </g>
</svg>
`;
}

export interface Artifacts {
  reportPath: string;
  badgePath: string;
  snippetPath: string;
}

export function writeArtifacts(sr: SignedReport, outDir = 'out'): Artifacts {
  mkdirSync(outDir, { recursive: true });
  const slug = sr.report.target.serviceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const reportPath = join(outDir, `report-${slug}.json`);
  const badgePath = join(outDir, `badge-${slug}.svg`);
  const snippetPath = join(outDir, `badge-${slug}.md`);
  writeFileSync(reportPath, JSON.stringify(sr, null, 2));
  writeFileSync(badgePath, renderBadgeSvg(sr.report.verdict, sr.report.score));
  writeFileSync(
    snippetPath,
    `![CAP audit: ${sr.report.verdict}](./badge-${slug}.svg)\n\n` +
      `Audited by [Handshake] on ${sr.report.finishedAt} — verdict **${sr.report.verdict}** ` +
      `(score ${sr.report.score}/100, ${sr.report.totals.pass} checks passed). ` +
      `Signed report: [\`report-${slug}.json\`](./report-${slug}.json)\n`,
  );
  return { reportPath, badgePath, snippetPath };
}
