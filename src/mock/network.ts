import { APIError, InsufficientBalanceError } from '@croo-network/sdk';
import type { Delivery, Negotiation, Order } from '@croo-network/sdk';
import { sha256Hex, uuid } from '../util/hash';

/**
 * MockNetwork — an in-memory stand-in for the CROO backend + CAPVault escrow.
 *
 * Fidelity rules:
 *  - Objects are the SDK's own `Order` / `Negotiation` / `Delivery` types.
 *  - Errors are the SDK's own `APIError` / `InsufficientBalanceError`, with
 *    `reason` strings chosen so the SDK's guards (isNotFound, isInvalidStatus,
 *    isForbidden…) behave exactly as they do against the real API.
 *  - Escrow accounting is enforced: pay debits the requester into escrow;
 *    clear releases to the provider; reject/expiry refunds the requester.
 *  - `deliveryWindow` is interpreted in **milliseconds** here (seconds on the
 *    real network) so the full lifecycle runs in <1s for tests and demos.
 *
 * Provider profiles simulate the counterparties Handshake exists to catch:
 *   good      — accepts fast, delivers valid output in time, honors probes
 *   slow      — accepts, then blows the SLA (order expires, escrow refunds)
 *   ghost     — never responds to negotiations
 *   tamper    — delivers on time but the contentHash doesn't match the payload
 *   overprice — creates the order at 2x the advertised price
 */
export type ProviderProfile = 'good' | 'slow' | 'ghost' | 'tamper' | 'overprice';

export type ProviderHandler = (
  order: Order,
  requirements: string,
) => Promise<{ deliverableText: string }>;

export interface MockService {
  serviceId: string;
  providerAgentId: string;
  name: string;
  /** Advertised price, USDC base units (6 decimals). */
  price: bigint;
  /** SLA window in ms (real network: seconds). slaDeadline = paidAt + this. */
  deliveryWindowMs: number;
  deliverableType: 'text' | 'schema';
  profile: ProviderProfile;
  /** Optional custom fulfillment (used by Handshake-as-provider in the demo). */
  handler?: ProviderHandler;
}

interface AgentRec {
  agentId: string;
  wallet: string;
}

const notFound = (what: string, id: string) =>
  new APIError(404, 40401, `${what.toUpperCase()}_NOT_FOUND`, `${what} ${id} not found`);
const forbidden = (msg: string) => new APIError(403, 40301, 'FORBIDDEN', msg);
const invalidStatus = (msg: string) => new APIError(400, 40001, 'INVALID_STATUS', msg);

const MOCK_USDC = '0x000000000000000000000000000000000000cafe';

export class MockNetwork {
  #agents = new Map<string, AgentRec>();
  #balances = new Map<string, bigint>(); // wallet -> USDC base units
  #services = new Map<string, MockService>();
  #negotiations = new Map<string, Negotiation>();
  #orders = new Map<string, Order>();
  #deliveries = new Map<string, Delivery>(); // orderId -> delivery
  #escrow = new Map<string, bigint>(); // orderId -> locked amount
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #seq = 0;

  // ---- tunables (ms) ----
  acceptDelayMs = 25;
  negotiationExpiryMs = 60_000;
  payWindowMs = 60_000;

  // ---------------------------------------------------------------- admin

  registerAgent(agentId: string): AgentRec {
    const rec: AgentRec = { agentId, wallet: `0x${sha256Hex(`wallet:${agentId}`).slice(0, 40)}` };
    this.#agents.set(agentId, rec);
    if (!this.#balances.has(rec.wallet)) this.#balances.set(rec.wallet, 0n);
    return rec;
  }

  mint(agentId: string, amount: bigint): void {
    const a = this.#mustAgent(agentId);
    this.#balances.set(a.wallet, (this.#balances.get(a.wallet) ?? 0n) + amount);
  }

  addService(spec: MockService): void {
    this.#mustAgent(spec.providerAgentId);
    this.#services.set(spec.serviceId, spec);
  }

  balanceOfAgent(agentId: string): bigint {
    return this.#balances.get(this.#mustAgent(agentId).wallet) ?? 0n;
  }

  balanceOfWallet(wallet: string): bigint {
    return this.#balances.get(wallet) ?? 0n;
  }

  allOrders(): Order[] {
    return [...this.#orders.values()].map((o) => ({ ...o }));
  }

  /** Clear pending timers so tests/demos exit cleanly. */
  shutdown(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  // ------------------------------------------------------------- requester

  negotiateOrder(caller: string, serviceId: string, requirements: string, metadata: string): Negotiation {
    this.#mustAgent(caller);
    const svc = this.#services.get(serviceId);
    if (!svc) throw notFound('service', serviceId);

    const now = new Date();
    const neg: Negotiation = {
      negotiationId: `neg_${uuid()}`,
      serviceId,
      requesterAgentId: caller,
      providerAgentId: svc.providerAgentId,
      requirements,
      status: 'pending',
      rejectReason: '',
      metadata,
      expiresAt: new Date(now.getTime() + this.negotiationExpiryMs).toISOString(),
      createdTime: now.toISOString(),
      updatedTime: now.toISOString(),
    };
    this.#negotiations.set(neg.negotiationId, neg);

    if (svc.profile !== 'ghost') {
      this.#later(this.acceptDelayMs, () => {
        const n = this.#negotiations.get(neg.negotiationId);
        if (n?.status === 'pending') this.#providerAccept(neg.negotiationId);
      });
    }
    return { ...neg };
  }

  getNegotiation(caller: string, negotiationId: string): Negotiation {
    const neg = this.#negotiations.get(negotiationId);
    if (!neg) throw notFound('negotiation', negotiationId);
    this.#assertParty(caller, neg.requesterAgentId, neg.providerAgentId);
    if (neg.status === 'pending' && Date.now() > Date.parse(neg.expiresAt)) {
      neg.status = 'expired';
      neg.updatedTime = new Date().toISOString();
    }
    return { ...neg };
  }

  payOrder(caller: string, orderId: string): { order: Order; txHash: string } {
    const o = this.#mustOrder(orderId);
    if (caller !== o.requesterAgentId) throw forbidden('only the requester may pay this order');
    if (o.status !== 'created') throw invalidStatus(`order is ${o.status}, expected created`);

    const svc = this.#services.get(o.serviceId)!;
    const required = BigInt(o.price) + BigInt(o.feeAmount || '0');
    const wallet = this.#mustAgent(caller).wallet;
    const bal = this.#balances.get(wallet) ?? 0n;
    if (bal < required) throw new InsufficientBalanceError(MOCK_USDC, required, bal);

    this.#balances.set(wallet, bal - required);
    this.#escrow.set(orderId, required);

    const now = new Date();
    o.status = 'paid';
    o.paidAt = now.toISOString();
    o.payTxHash = this.#tx(`pay:${orderId}`);
    o.slaDeadline = new Date(now.getTime() + svc.deliveryWindowMs).toISOString();
    o.updatedTime = now.toISOString();

    this.#scheduleFulfillment(o, svc);
    return { order: { ...o }, txHash: o.payTxHash };
  }

  getOrder(caller: string, orderId: string): Order {
    const o = this.#mustOrder(orderId);
    this.#assertParty(caller, o.requesterAgentId, o.providerAgentId);
    this.#lazyExpire(o);
    return { ...o };
  }

  listOrders(caller: string): Order[] {
    this.#mustAgent(caller);
    const out: Order[] = [];
    for (const o of this.#orders.values()) {
      if (o.requesterAgentId === caller || o.providerAgentId === caller) {
        this.#lazyExpire(o);
        out.push({ ...o });
      }
    }
    return out;
  }

  getDelivery(caller: string, orderId: string): Delivery {
    const o = this.#mustOrder(orderId);
    this.#assertParty(caller, o.requesterAgentId, o.providerAgentId);
    const d = this.#deliveries.get(orderId);
    if (!d) throw notFound('delivery', orderId);
    return { ...d };
  }

  // -------------------------------------------------------------- provider

  acceptNegotiation(caller: string, negotiationId: string): { negotiation: Negotiation; order: Order } {
    const neg = this.#negotiations.get(negotiationId);
    if (!neg) throw notFound('negotiation', negotiationId);
    if (caller !== neg.providerAgentId) throw forbidden('only the provider may accept');
    if (neg.status !== 'pending') throw invalidStatus(`negotiation is ${neg.status}`);
    const order = this.#providerAccept(negotiationId);
    return { negotiation: { ...this.#negotiations.get(negotiationId)! }, order: { ...order } };
  }

  rejectNegotiation(caller: string, negotiationId: string, reason: string): void {
    const neg = this.#negotiations.get(negotiationId);
    if (!neg) throw notFound('negotiation', negotiationId);
    if (caller !== neg.providerAgentId) throw forbidden('only the provider may reject');
    if (neg.status !== 'pending') throw invalidStatus(`negotiation is ${neg.status}`);
    neg.status = 'rejected';
    neg.rejectReason = reason;
    neg.updatedTime = new Date().toISOString();
  }

  deliverOrder(
    caller: string,
    orderId: string,
    req: { deliverableType: string; deliverableText?: string; deliverableSchema?: string },
  ): { order: Order; delivery: Delivery; txHash: string } {
    const o = this.#mustOrder(orderId);
    if (caller !== o.providerAgentId) throw forbidden('only the provider may deliver this order');
    this.#lazyExpire(o);
    if (o.status !== 'paid') throw invalidStatus(`order is ${o.status}, expected paid`);
    const payload = req.deliverableText ?? req.deliverableSchema ?? '';
    const delivery = this.#settleDelivery(o, payload, { deliverableType: req.deliverableType });
    return { order: { ...o }, delivery: { ...delivery }, txHash: o.deliverTxHash };
  }

  rejectOrder(caller: string, orderId: string, reason: string): void {
    const o = this.#mustOrder(orderId);
    if (caller !== o.providerAgentId) throw forbidden('only the provider may reject this order');
    if (o.status !== 'created' && o.status !== 'paid') {
      throw invalidStatus(`order is ${o.status}, expected created|paid`);
    }
    this.#refund(o, reason, 'rejected');
  }

  // ------------------------------------------------------------- internals

  #providerAccept(negotiationId: string): Order {
    const neg = this.#negotiations.get(negotiationId);
    if (!neg || neg.status !== 'pending') {
      throw invalidStatus(`negotiation is ${neg?.status ?? 'missing'}`);
    }
    const svc = this.#services.get(neg.serviceId)!;
    neg.status = 'accepted';
    neg.updatedTime = new Date().toISOString();

    const price = svc.profile === 'overprice' ? svc.price * 2n : svc.price;
    const now = new Date();
    const requester = this.#mustAgent(neg.requesterAgentId);
    const provider = this.#mustAgent(neg.providerAgentId);
    const order: Order = {
      orderId: `ord_${uuid()}`,
      negotiationId,
      chainOrderId: `${++this.#seq}`,
      serviceId: neg.serviceId,
      requesterAgentId: neg.requesterAgentId,
      providerAgentId: neg.providerAgentId,
      buyerUserId: '',
      requesterWalletAddress: requester.wallet,
      providerWalletAddress: provider.wallet,
      price: price.toString(),
      paymentToken: MOCK_USDC,
      deliveryWindow: svc.deliveryWindowMs,
      status: 'created',
      rejectReason: '',
      createTxHash: this.#tx(`create:${negotiationId}`),
      payTxHash: '',
      deliverTxHash: '',
      rejectTxHash: '',
      clearTxHash: '',
      slaDeadline: '',
      payDeadline: new Date(now.getTime() + this.payWindowMs).toISOString(),
      createdTime: now.toISOString(),
      updatedTime: now.toISOString(),
      createdAt: now.toISOString(),
      paidAt: '',
      deliveredAt: '',
      rejectedAt: '',
      expiredAt: '',
      feeAmount: '0',
    };
    this.#orders.set(order.orderId, order);
    return order;
  }

  #scheduleFulfillment(o: Order, svc: MockService): void {
    const neg = this.#negotiations.get(o.negotiationId);
    const probe = extractProbe(neg?.metadata ?? '', neg?.requirements ?? '');

    // A conformant provider honors the Handshake probe convention: a paid
    // order flagged `reject_after_pay` is rejected so the refund path can be
    // verified with real escrow. (See docs/INTEGRATION.md for the live snippet.)
    if (probe === 'reject_after_pay' && svc.profile !== 'ghost' && svc.profile !== 'slow') {
      this.#later(Math.max(10, this.acceptDelayMs), () =>
        this.#refund(o, 'handshake refund-probe honored', 'rejected'),
      );
      return;
    }

    const nonce = extractNonce(neg?.requirements ?? '');

    if (svc.handler) {
      this.#later(10, async () => {
        try {
          const { deliverableText } = await svc.handler!({ ...o }, neg?.requirements ?? '');
          if (o.status === 'paid') this.#settleDelivery(o, deliverableText, {});
        } catch (err) {
          if (o.status === 'paid') {
            o.status = 'deliver_failed';
            o.rejectReason = `provider handler error: ${(err as Error).message}`;
            this.#refundEscrowOnly(o);
          }
        }
      });
      return;
    }

    const goodPayload = JSON.stringify({
      service: svc.name,
      nonce,
      result: `processed request ${nonce}`,
      at: new Date().toISOString(),
    });

    switch (svc.profile) {
      case 'good':
      case 'overprice': // overpriced, but otherwise delivers correctly
        this.#later(Math.round(svc.deliveryWindowMs * 0.4), () => {
          if (o.status === 'paid') this.#settleDelivery(o, goodPayload, {});
        });
        break;
      case 'tamper':
        this.#later(Math.round(svc.deliveryWindowMs * 0.4), () => {
          if (o.status === 'paid') this.#settleDelivery(o, goodPayload, { corruptHash: true });
        });
        break;
      case 'slow':
        this.#later(Math.round(svc.deliveryWindowMs * 2.2), () => {
          if (o.status === 'paid') this.#lazyExpire(o); // too late — expires instead
        });
        break;
      case 'ghost':
        break;
    }
  }

  #settleDelivery(
    o: Order,
    payload: string,
    opts: { corruptHash?: boolean; deliverableType?: string },
  ): Delivery {
    const svc = this.#services.get(o.serviceId)!;
    const now = new Date();
    const type = opts.deliverableType ?? svc.deliverableType;
    const delivery: Delivery = {
      deliveryId: `dlv_${uuid()}`,
      orderId: o.orderId,
      providerAgentId: o.providerAgentId,
      deliverableType: type,
      deliverableSchema: type === 'schema' ? payload : '',
      deliverableText: type === 'text' ? payload : '',
      contentHash: opts.corruptHash ? sha256Hex(`${payload}:tampered`) : sha256Hex(payload),
      status: 'accepted',
      submittedAt: now.toISOString(),
      verifiedAt: now.toISOString(),
      createdTime: now.toISOString(),
      updatedTime: now.toISOString(),
    };
    this.#deliveries.set(o.orderId, delivery);

    o.status = 'completed';
    o.deliveredAt = now.toISOString();
    o.deliverTxHash = this.#tx(`deliver:${o.orderId}`);
    o.clearTxHash = this.#tx(`clear:${o.orderId}`);
    o.updatedTime = now.toISOString();

    // Clear: release escrow to provider (fee, if any, stays with the network).
    const locked = this.#escrow.get(o.orderId) ?? 0n;
    this.#escrow.delete(o.orderId);
    const providerWallet = o.providerWalletAddress;
    const fee = BigInt(o.feeAmount || '0');
    this.#balances.set(providerWallet, (this.#balances.get(providerWallet) ?? 0n) + (locked - fee));
    return delivery;
  }

  #refund(o: Order, reason: string, status: 'rejected'): void {
    const now = new Date();
    o.status = status;
    o.rejectReason = reason;
    o.rejectedAt = now.toISOString();
    o.rejectTxHash = this.#tx(`reject:${o.orderId}`);
    o.updatedTime = now.toISOString();
    this.#refundEscrowOnly(o);
  }

  #refundEscrowOnly(o: Order): void {
    const locked = this.#escrow.get(o.orderId);
    if (locked === undefined) return;
    this.#escrow.delete(o.orderId);
    const w = o.requesterWalletAddress;
    this.#balances.set(w, (this.#balances.get(w) ?? 0n) + locked);
  }

  /** Paid order past its slaDeadline transitions to expired and refunds the requester. */
  #lazyExpire(o: Order): void {
    if (o.status === 'paid' && o.slaDeadline && Date.now() > Date.parse(o.slaDeadline)) {
      const now = new Date();
      o.status = 'expired';
      o.expiredAt = now.toISOString();
      o.rejectTxHash = this.#tx(`expire:${o.orderId}`);
      o.updatedTime = now.toISOString();
      this.#refundEscrowOnly(o);
    }
  }

  #assertParty(caller: string, ...parties: string[]): void {
    this.#mustAgent(caller);
    if (!parties.includes(caller)) throw forbidden(`agent ${caller} is not a party to this resource`);
  }

  #mustAgent(agentId: string): AgentRec {
    const a = this.#agents.get(agentId);
    if (!a) throw notFound('agent', agentId);
    return a;
  }

  #mustOrder(orderId: string): Order {
    const o = this.#orders.get(orderId);
    if (!o) throw notFound('order', orderId);
    return o;
  }

  #tx(seed: string): string {
    return `0x${sha256Hex(`${seed}:${++this.#seq}`)}`;
  }

  #later(ms: number, fn: () => void | Promise<void>): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      void fn();
    }, ms);
    this.#timers.add(t);
  }
}

// ------------------------------------------------------------------ helpers

function extractProbe(metadata: string, requirements: string): string | null {
  for (const raw of [metadata, requirements]) {
    try {
      const v = JSON.parse(raw);
      const p = v?.handshake_probe ?? v?.handshake?.probe;
      if (typeof p === 'string') return p;
    } catch {
      /* not JSON — fine */
    }
  }
  return null;
}

function extractNonce(requirements: string): string {
  try {
    const v = JSON.parse(requirements);
    const n = v?.handshake?.nonce ?? v?.nonce;
    if (typeof n === 'string') return n;
  } catch {
    /* ignore */
  }
  return 'no-nonce';
}
