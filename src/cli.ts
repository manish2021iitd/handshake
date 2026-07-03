import { parseArgs } from 'node:util';
import { buildReport, signAndWrap, writeArtifacts, type SignedReport } from './audit/report';
import { runAudit, type AuditOptions } from './audit/runner';
import { makeLiveClient } from './capClient';
import { makeBench } from './mock/fixtures';
import type { ProviderProfile } from './mock/network';
import { c, hr } from './util/log';
import { printChecks, printOrders, printPhases, printVerdict } from './util/print';

const PROFILES: readonly ProviderProfile[] = ['good', 'slow', 'ghost', 'tamper', 'overprice'];

const NO_PROBES = { refund: false, doublePay: false, bogusService: false, foreignDeliver: false };

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mock: { type: 'string' },
      live: { type: 'boolean', default: false },
      service: { type: 'string' },
      price: { type: 'string' },
      'refund-probe': { type: 'boolean', default: false },
      'no-probes': { type: 'boolean', default: false },
      out: { type: 'string', default: 'out' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`handshake — CAP conformance auditor

  Mock bench (no network, runs in <1s):
    tsx src/cli.ts --mock good|slow|ghost|tamper|overprice

  Live (real CROO network on Base — see docs/INTEGRATION.md):
    tsx src/cli.ts --live --service <serviceId> --price <usdcBaseUnits> [--refund-probe]

  Flags: --no-probes   disable H15–H18 probes
         --out <dir>   artifact directory (default: out)`);
    return;
  }

  let signed: SignedReport;

  if (values.live) {
    const serviceId = values.service ?? process.env.CROO_TARGET_SERVICE_ID;
    const expectedPrice = values.price ?? process.env.HANDSHAKE_EXPECTED_PRICE;
    if (!serviceId || !expectedPrice) {
      throw new Error(
        'live mode needs --service and --price (or CROO_TARGET_SERVICE_ID / HANDSHAKE_EXPECTED_PRICE)',
      );
    }
    hr(`handshake audit · LIVE · ${serviceId}`);
    const opts: AuditOptions = {
      serviceId,
      expectedPrice,
      acceptTimeoutMs: 60_000,
      deliveryGraceMs: 15_000,
      pollIntervalMs: 1_000,
      probes: values['no-probes']
        ? NO_PROBES
        : { refund: values['refund-probe'], doublePay: true, bogusService: true, foreignDeliver: true },
    };
    const outcome = await runAudit(makeLiveClient(), opts);
    signed = signAndWrap(buildReport(outcome));
  } else {
    const profile = (values.mock ?? 'good') as ProviderProfile;
    if (!PROFILES.includes(profile)) {
      throw new Error(`--mock must be one of: ${PROFILES.join(', ')}`);
    }
    hr(`handshake audit · MOCK · ${profile}-provider`);
    const bench = makeBench();
    try {
      const outcome = await runAudit(bench.handshake, {
        serviceId: bench.services[profile],
        expectedPrice: bench.advertisedPrice[profile],
        acceptTimeoutMs: 800,
        deliveryGraceMs: 400,
        pollIntervalMs: 20,
        probes: values['no-probes'] ? NO_PROBES : { refund: true },
        balances: bench.balancesFor('handshake'),
        expectedDeliverableType: 'text',
      });
      signed = signAndWrap(buildReport(outcome));
    } finally {
      bench.net.shutdown();
    }
  }

  const report = signed.report;
  printPhases(report.phaseHistory);
  console.log();
  printChecks(report.checks);
  console.log(`\n${c.bold('orders placed')}`);
  printOrders(report.orders);
  printVerdict(report);

  const artifacts = writeArtifacts(signed, values.out);
  console.log(
    `\n${c.dim('artifacts')}  ${artifacts.reportPath}  ${artifacts.badgePath}  ${artifacts.snippetPath}`,
  );

  process.exitCode = report.verdict === 'CONFORMANT' ? 0 : 1;
}

main().catch((err) => {
  console.error(c.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exitCode = 2;
});
