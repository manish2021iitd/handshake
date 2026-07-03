import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySignedReport, type SignedReport } from '../src/audit/report';
import { addHandshakeAuditService, makeBench, USDC } from '../src/mock/fixtures';
import { contentHashMatches } from '../src/util/hash';
import { pollUntil } from '../src/util/sleep';

test('e2e: an audit sold over CAP fans out into three verified orders', async () => {
  const bench = makeBench();
  const auditServiceId = addHandshakeAuditService(bench, 3);
  try {
    // Customer buys an audit of good-provider from Handshake — over CAP.
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
    assert.equal(accepted?.status, 'accepted');

    const created = await pollUntil(
      async () =>
        (await bench.customer.listOrders()).find((o) => o.negotiationId === neg.negotiationId) ?? null,
      (o) => o.status === 'created',
      2_000,
      20,
    );
    assert.ok(created, 'parent order should be created');

    await bench.customer.payOrder(created.orderId);
    const parent = await pollUntil(
      () => bench.customer.getOrder(created.orderId),
      (o) => ['completed', 'rejected', 'expired', 'deliver_failed'].includes(o.status),
      10_000,
      25,
    );
    assert.equal(parent?.status, 'completed', 'audit order should complete');

    // The deliverable is a signed report — verifiable two ways.
    const delivery = await bench.customer.getDelivery(created.orderId);
    assert.ok(contentHashMatches(delivery.contentHash, delivery.deliverableText), 'on-chain hash matches payload');
    const signed = JSON.parse(delivery.deliverableText) as SignedReport;
    assert.equal(verifySignedReport(signed), true, 'Ed25519 signature verifies');
    assert.equal(signed.report.verdict, 'CONFORMANT');
    assert.equal(signed.report.target.serviceId, bench.services.good);

    // One sale ⇒ three orders: parent + main probe + refund probe.
    const all = bench.net.allOrders();
    assert.equal(all.length, 3);
    assert.equal(all.filter((o) => o.status === 'completed').length, 2);
    assert.equal(all.filter((o) => o.status === 'rejected').length, 1);

    // Exact accounting: customer −3, handshake +3−1 = +2, target +1.
    assert.equal(bench.net.balanceOfAgent('customer'), USDC(97));
    assert.equal(bench.net.balanceOfAgent('handshake'), USDC(102));
    assert.equal(bench.net.balanceOfAgent('good-provider'), USDC(1));
  } finally {
    bench.net.shutdown();
  }
});
