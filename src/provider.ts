/**
 * Handshake as a CAP provider on the real CROO network.
 *
 * Sells the "CAP Conformance Audit" service: accepts incoming negotiations,
 * and on payment runs a full child audit against the requested target, then
 * delivers the Ed25519-signed report as the order deliverable.
 *
 * Requirements JSON the buyer sends when negotiating:
 *   { "targetServiceId": "svc_…", "expectedPrice": "1000000", "allowRefundProbe": false }
 *
 * Run: npm run provider:live   (needs CROO_SDK_KEY + HANDSHAKE_SERVICE_ID)
 */
import { AgentClient, DeliverableType, EventType } from '@croo-network/sdk';
import { buildReport, signAndWrap } from './audit/report';
import { runAudit } from './audit/runner';
import { loadOrCreateKeypair } from './crypto/signing';
import { c, hr } from './util/log';

const baseURL = process.env.CROO_API_URL ?? 'https://api.croo.network';
const wsURL = process.env.CROO_WS_URL ?? 'wss://api.croo.network/ws';
const sdkKey = process.env.CROO_SDK_KEY;
const myServiceId = process.env.HANDSHAKE_SERVICE_ID;

if (!sdkKey || !myServiceId) {
  console.error('Set CROO_SDK_KEY and HANDSHAKE_SERVICE_ID in your environment (see docs/INTEGRATION.md).');
  process.exit(2);
}

const client = new AgentClient({ baseURL, wsURL }, sdkKey);
const keys = loadOrCreateKeypair();

interface AuditRequest {
  targetServiceId: string;
  expectedPrice: string;
  allowRefundProbe?: boolean;
}

function parseAuditRequest(raw: string): AuditRequest | null {
  try {
    const v = JSON.parse(raw) as Partial<AuditRequest>;
    if (typeof v.targetServiceId === 'string' && typeof v.expectedPrice === 'string') {
      return {
        targetServiceId: v.targetServiceId,
        expectedPrice: v.expectedPrice,
        allowRefundProbe: Boolean(v.allowRefundProbe),
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

const inFlight = new Set<string>();

async function fulfill(orderId: string): Promise<void> {
  if (inFlight.has(orderId)) return;
  inFlight.add(orderId);
  try {
    const order = await client.getOrder(orderId);
    if (order.serviceId !== myServiceId || order.status !== 'paid') return;

    const neg = await client.getNegotiation(order.negotiationId);
    const req = parseAuditRequest(neg.requirements);
    if (!req) {
      await client.rejectOrder(
        orderId,
        'requirements must be JSON: {"targetServiceId": "...", "expectedPrice": "<usdc base units>", "allowRefundProbe": false}',
      );
      console.log(c.yellow(`rejected ${orderId}: malformed audit request`));
      return;
    }

    console.log(c.cyan(`auditing ${req.targetServiceId} for order ${orderId}…`));
    const outcome = await runAudit(client, {
      serviceId: req.targetServiceId,
      expectedPrice: req.expectedPrice,
      acceptTimeoutMs: 60_000,
      deliveryGraceMs: 15_000,
      pollIntervalMs: 1_000,
      probes: {
        refund: req.allowRefundProbe ?? false,
        doublePay: true,
        bogusService: true,
        foreignDeliver: true,
      },
    });
    const signed = signAndWrap(buildReport(outcome), keys);

    await client.deliverOrder(orderId, {
      deliverableType: DeliverableType.Text,
      deliverableText: JSON.stringify(signed),
    });
    console.log(
      c.green(
        `delivered ${orderId}: ${signed.report.verdict} (${signed.report.score}/100), ` +
          `${signed.report.orders.length} child order(s) placed`,
      ),
    );
  } catch (err) {
    console.error(c.red(`fulfillment failed for ${orderId}: ${(err as Error).message}`));
    await client
      .rejectOrder(orderId, 'handshake internal error during audit — order refunded')
      .catch(() => undefined);
  } finally {
    inFlight.delete(orderId);
  }
}

async function main(): Promise<void> {
  const stream = await client.connectWebSocket();

  stream.on(EventType.NegotiationCreated, async (e) => {
    if (e.service_id !== myServiceId || !e.negotiation_id) return;
    try {
      await client.acceptNegotiation(e.negotiation_id);
      console.log(c.cyan(`accepted negotiation ${e.negotiation_id}`));
    } catch (err) {
      console.error(c.red(`accept failed: ${(err as Error).message}`));
    }
  });

  stream.on(EventType.OrderPaid, (e) => {
    if (e.order_id) void fulfill(e.order_id);
  });

  // Backlog sweep: anything that arrived while we were offline.
  try {
    for (const n of await client.listNegotiations({ status: 'pending', role: 'provider' })) {
    // for (const n of await client.listNegotiations({ status: 'pending' })) {
      if (n.serviceId === myServiceId) await client.acceptNegotiation(n.negotiationId).catch(() => undefined);
    }
    for (const o of await client.listOrders({ status: 'paid', role: 'provider' })) {
      if (o.serviceId === myServiceId) void fulfill(o.orderId);
    }
  } catch (err) {
    console.error(c.yellow(`backlog sweep failed (continuing): ${(err as Error).message}`));
  }

  hr('handshake provider');
  console.log(`selling ${c.bold('CAP Conformance Audit')} as service ${c.cyan(myServiceId!)} — waiting for orders`);
}

main().catch((err) => {
  console.error(c.red((err as Error).stack ?? String(err)));
  process.exit(2);
});
