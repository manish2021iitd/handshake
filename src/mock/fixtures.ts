import { buildReport, signAndWrap } from '../audit/report';
import { runAudit, type BalanceReader } from '../audit/runner';
import { loadOrCreateKeypair } from '../crypto/signing';
import { MockAgentClient } from './client';
import { MockNetwork, type ProviderProfile } from './network';

export const USDC = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export interface Bench {
  net: MockNetwork;
  handshake: MockAgentClient;
  customer: MockAgentClient;
  /** serviceId per provider profile. */
  services: Record<ProviderProfile, string>;
  /** Advertised price per profile (what the Agent Store listing shows). */
  advertisedPrice: Record<ProviderProfile, string>;
  balancesFor(agentId: string): BalanceReader;
}

/**
 * A standard bench: Handshake + a customer + five target providers, each
 * embodying one failure mode the auditor must catch. All prices 1 USDC;
 * delivery windows are milliseconds so a full audit finishes in well under a
 * second.
 */
export function makeBench(): Bench {
  const net = new MockNetwork();
  const profiles: ProviderProfile[] = ['good', 'slow', 'ghost', 'tamper', 'overprice'];

  net.registerAgent('handshake');
  net.registerAgent('customer');
  net.mint('handshake', USDC(100));
  net.mint('customer', USDC(100));

  const services = {} as Record<ProviderProfile, string>;
  const advertisedPrice = {} as Record<ProviderProfile, string>;

  for (const p of profiles) {
    const agentId = `${p}-provider`;
    net.registerAgent(agentId);
    const serviceId = `svc_${p}`;
    net.addService({
      serviceId,
      providerAgentId: agentId,
      name: `${p} demo service`,
      price: USDC(1),
      deliveryWindowMs: p === 'slow' ? 150 : 250,
      deliverableType: 'text',
      profile: p,
    });
    services[p] = serviceId;
    advertisedPrice[p] = USDC(1).toString(); // the listing always *advertises* 1 USDC
  }

  return {
    net,
    handshake: new MockAgentClient(net, 'handshake'),
    customer: new MockAgentClient(net, 'customer'),
    services,
    advertisedPrice,
    balancesFor: (agentId: string) => ({
      requester: async () => net.balanceOfAgent(agentId),
      provider: async (wallet: string) => net.balanceOfWallet(wallet),
    }),
  };
}

/**
 * Register Handshake itself as a CAP provider selling "CAP Conformance Audit".
 * When a customer's paid order arrives, the handler runs a real child audit
 * (which itself places 1–2 more orders) and delivers the signed report as the
 * deliverable. One audit sale ⇒ three on-chain orders.
 */
export function addHandshakeAuditService(bench: Bench, priceUsdc = 3): string {
  const serviceId = 'svc_handshake_audit';
  const keys = loadOrCreateKeypair('.keys');
  bench.net.addService({
    serviceId,
    providerAgentId: 'handshake',
    name: 'CAP Conformance Audit',
    price: USDC(priceUsdc),
    deliveryWindowMs: 5_000,
    deliverableType: 'text',
    profile: 'good',
    handler: async (_order, requirements) => {
      const req = JSON.parse(requirements) as {
        targetServiceId: string;
        expectedPrice: string;
        allowRefundProbe?: boolean;
      };
      const outcome = await runAudit(bench.handshake, {
        serviceId: req.targetServiceId,
        expectedPrice: req.expectedPrice,
        acceptTimeoutMs: 1_000,
        deliveryGraceMs: 300,
        probes: { refund: req.allowRefundProbe ?? true },
        balances: bench.balancesFor('handshake'),
        expectedDeliverableType: 'text',
      });
      const signed = signAndWrap(buildReport(outcome), keys);
      return { deliverableText: JSON.stringify(signed) };
    },
  });
  return serviceId;
}
