/**
 * Demo: Handshake sells an audit *through CAP itself*.
 *
 *   customer ──(order #1: buys "CAP Conformance Audit")──▶ handshake
 *   handshake ──(order #2: main conformance probe)───────▶ good-provider
 *   handshake ──(order #3: refund probe)─────────────────▶ good-provider
 *
 * One audit sale = three real orders walking the full
 * Negotiate → Lock → Deliver → Clear lifecycle, with the signed report
 * delivered as the CAP deliverable and verified by the buyer.
 */
import { verifySignedReport, writeArtifacts, type SignedReport } from '../src/audit/report';
import { addHandshakeAuditService, makeBench, USDC } from '../src/mock/fixtures';
import { contentHashMatches } from '../src/util/hash';
import { c, hr, mark } from '../src/util/log';
import { printChecks } from '../src/util/print';
import { pollUntil } from '../src/util/sleep';

const fmtUsdc = (v: bigint): string => `${(Number(v) / 1_000_000).toFixed(2)} USDC`;

async function main(): Promise<void> {
  hr('HANDSHAKE · self-sale demo');
  console.log(`${c.dim('cast:')} customer (buyer) · handshake (auditor, sold via CAP) · good-provider (audit target)\n`);

  const bench = makeBench();
  const auditServiceId = addHandshakeAuditService(bench, 3); // 3 USDC per audit
  const before = {
    customer: bench.net.balanceOfAgent('customer'),
    handshake: bench.net.balanceOfAgent('handshake'),
    'good-provider': bench.net.balanceOfAgent('good-provider'),
  };

  try {
    // 1 — customer orders an audit of good-provider, over CAP.
    console.log(`${c.bold('1.')} customer negotiates ${c.cyan('"CAP Conformance Audit"')} (target: ${bench.services.good})`);
    const neg = await bench.customer.negotiateOrder({
      serviceId: auditServiceId,
      requirements: JSON.stringify({
        targetServiceId: bench.services.good,
        expectedPrice: USDC(1).toString(),
        allowRefundProbe: true,
      }),
    });
    const accepted = await pollUntil(
      () => bench.customer.getNegotiation(neg.negotiationId),
      (n) => n.status !== 'pending',
      2_000,
      20,
    );
    if (accepted?.status !== 'accepted') throw new Error('handshake did not accept the negotiation');

    let parent = await pollUntil(
      async () =>
        (await bench.customer.listOrders()).find((o) => o.negotiationId === neg.negotiationId) ?? null,
      (o) => o.status === 'created',
      2_000,
      20,
    );
    if (!parent) throw new Error('parent order never materialized');
    console.log(`   ${mark.pass} negotiation accepted → order ${parent.orderId} created (createTx ${parent.createTxHash.slice(0, 14)}…)`);

    // 2 — customer pays: 3 USDC into escrow.
    const { txHash: payTx } = await bench.customer.payOrder(parent.orderId);
    console.log(`${c.bold('2.')} customer pays ${fmtUsdc(USDC(3))} into escrow ${c.dim(`(payTx ${payTx.slice(0, 14)}…)`)}`);

    // 3 — handshake fulfills by *running a real audit*, which places its own orders.
    console.log(`${c.bold('3.')} handshake runs the audit — placing child orders against good-provider…`);
    parent = await pollUntil(
      () => bench.customer.getOrder(parent!.orderId),
      (o) => ['completed', 'rejected', 'expired', 'deliver_failed'].includes(o.status),
      10_000,
      25,
    );
    if (parent?.status !== 'completed') {
      throw new Error(`parent order ended ${parent?.status ?? 'unknown'}`);
    }
    console.log(`   ${mark.pass} audit delivered & settled ${c.dim(`(clearTx ${parent.clearTxHash.slice(0, 14)}…)`)}`);

    // 4 — customer verifies what it bought: content hash + Ed25519 signature.
    const delivery = await bench.customer.getDelivery(parent.orderId);
    const payload = delivery.deliverableText;
    const hashOk = contentHashMatches(delivery.contentHash, payload);
    const signed = JSON.parse(payload) as SignedReport;
    const sigOk = verifySignedReport(signed);
    console.log(`${c.bold('4.')} customer verifies the deliverable`);
    console.log(`   ${hashOk ? mark.pass : mark.fail} on-chain contentHash matches sha256(deliverable)`);
    console.log(`   ${sigOk ? mark.pass : mark.fail} Ed25519 signature verifies against handshake's public key`);

    // 5 — the report the customer received.
    const r = signed.report;
    hr(`embedded audit report · ${r.target.serviceId}`);
    printChecks(r.checks);
    const color = r.verdict === 'CONFORMANT' ? c.green : r.verdict === 'PARTIAL' ? c.yellow : c.red;
    console.log(
      `\n  ${color(c.bold(`VERDICT: ${r.verdict}`))}  score ${r.score}/100  ` +
        c.dim(`(${r.totals.pass} pass · ${r.totals.fail} fail · ${r.totals.skip} skip)`),
    );

    // 6 — the on-chain footprint of one audit sale.
    hr('order graph');
    const all = bench.net.allOrders();
    const hashes = new Set<string>();
    for (const o of all) {
      for (const h of [o.createTxHash, o.payTxHash, o.deliverTxHash, o.rejectTxHash, o.clearTxHash]) {
        if (h) hashes.add(h);
      }
      const label = o.serviceId === auditServiceId ? 'audit sale' : o.status === 'rejected' ? 'refund probe' : 'main probe';
      console.log(
        `  ${c.bold(label.padEnd(13))} ${o.requesterAgentId} → ${o.providerAgentId}  ` +
          `${c.dim(o.serviceId.padEnd(20))} status=${o.status}  price=${fmtUsdc(BigInt(o.price))}`,
      );
    }
    console.log(`\n  ${c.bold(String(all.length))} CAP orders · ${c.bold(String(hashes.size))} distinct on-chain txs from ${c.bold('one')} audit sale`);

    for (const who of ['customer', 'handshake', 'good-provider'] as const) {
      const now = bench.net.balanceOfAgent(who);
      const d = now - before[who];
      const sign = d >= 0n ? '+' : '−';
      console.log(`  ${c.dim(who.padEnd(14))} ${fmtUsdc(now)}  ${c.dim(`(${sign}${fmtUsdc(d < 0n ? -d : d)})`)}`);
    }

    const artifacts = writeArtifacts(signed);
    console.log(`\n${c.dim('artifacts')}  ${artifacts.reportPath} · ${artifacts.badgePath} · ${artifacts.snippetPath}`);
    hr();
    console.log(
      `${c.bold('Point this at mainnet and every line above is a Base transaction.')}\n` +
        c.dim('Same runner, same checks — the real AgentClient satisfies the same CapClient interface.'),
    );
  } finally {
    bench.net.shutdown();
  }
}

main().catch((err) => {
  console.error(c.red((err as Error).stack ?? String(err)));
  process.exitCode = 2;
});
