import { isForbidden, isInsufficientBalance, isInvalidParams, isInvalidStatus, isNotFound } from '@croo-network/sdk';
import type { Negotiation, Order } from '@croo-network/sdk';
import type { CapClient } from '../capClient';
import { contentHashMatches, uuid } from '../util/hash';
import { pollUntil, sleep } from '../util/sleep';
import { CHECKS, CheckLog, type CheckResult } from './checks';
import { AuditMachine, type PhaseTransition } from './machine';

export interface BalanceReader {
  /** Requester (Handshake) USDC balance in base units. */
  requester(): Promise<bigint>;
  /** Provider wallet USDC balance in base units. */
  provider(providerWallet: string): Promise<bigint>;
}

export interface AuditOptions {
  /** Target serviceId (from the Agent Store listing / dashboard). */
  serviceId: string;
  /** Advertised price in USDC base units, as listed publicly. */
  expectedPrice: string;
  /** How long the provider gets to accept the negotiation. */
  acceptTimeoutMs?: number;
  /** Extra observation time past slaDeadline before declaring expiry. */
  deliveryGraceMs?: number;
  pollIntervalMs?: number;
  /** Expected deliverable type from the service contract, if known. */
  expectedDeliverableType?: 'text' | 'schema';
  probes?: {
    refund?: boolean;
    doublePay?: boolean;
    bogusService?: boolean;
    foreignDeliver?: boolean;
  };
  /** Optional on-chain balance reads for H07/H13. Skipped if absent. */
  balances?: BalanceReader;
}

export interface OrderEvidence {
  label: string;
  orderId: string;
  chainOrderId: string;
  status: string;
  price: string;
  txHashes: Record<string, string>;
}

export interface AuditOutcome {
  target: { serviceId: string; providerAgentId?: string; providerWalletAddress?: string };
  startedAt: string;
  finishedAt: string;
  phaseHistory: PhaseTransition[];
  checks: CheckResult[];
  orders: OrderEvidence[];
  notes: string[];
}

const txEvidence = (o: Order): Record<string, string> => {
  const out: Record<string, string> = {};
  if (o.createTxHash) out.createTxHash = o.createTxHash;
  if (o.payTxHash) out.payTxHash = o.payTxHash;
  if (o.deliverTxHash) out.deliverTxHash = o.deliverTxHash;
  if (o.rejectTxHash) out.rejectTxHash = o.rejectTxHash;
  if (o.clearTxHash) out.clearTxHash = o.clearTxHash;
  return out;
};

/**
 * Run a full conformance audit against `serviceId` using `cap` as the
 * requester. Places one real order (plus a second one if the refund probe is
 * enabled), walks it through the entire lifecycle, and verifies every
 * observable property along the way. Aborts *before* funding anything that
 * already looks wrong — a mispriced order never gets paid.
 */
export async function runAudit(cap: CapClient, opts: AuditOptions): Promise<AuditOutcome> {
  const m = new AuditMachine();
  const log = new CheckLog();
  const orders: OrderEvidence[] = [];
  const notes: string[] = [];
  const startedAt = new Date().toISOString();

  const acceptTimeoutMs = opts.acceptTimeoutMs ?? 20_000;
  const deliveryGraceMs = opts.deliveryGraceMs ?? 2_000;
  const poll = opts.pollIntervalMs ?? 40;
  const probes = {
    refund: false,
    doublePay: true,
    bogusService: true,
    foreignDeliver: true,
    ...opts.probes,
  };

  const target: AuditOutcome['target'] = { serviceId: opts.serviceId };
  let mainOrder: Order | null = null;

  const trackOrder = (label: string, o: Order) => {
    const existing = orders.find((e) => e.orderId === o.orderId);
    const ev: OrderEvidence = {
      label,
      orderId: o.orderId,
      chainOrderId: o.chainOrderId,
      status: o.status,
      price: o.price,
      txHashes: txEvidence(o),
    };
    if (existing) Object.assign(existing, ev);
    else orders.push(ev);
  };

  const finish = (): AuditOutcome => {
    if (m.phase !== 'REPORT') m.to('REPORT');
    log.fillSkipped(m.wasAborted ? 'audit aborted before this phase' : 'phase not executed');
    return {
      target,
      startedAt,
      finishedAt: new Date().toISOString(),
      phaseHistory: m.history,
      checks: log.results,
      orders,
      notes,
    };
  };

  // ------------------------------------------------------------- NEGOTIATE
  m.to('NEGOTIATE');
  const nonce = uuid();
  const requirements = JSON.stringify({ handshake: { nonce, kind: 'conformance-probe' } });

  let neg: Negotiation;
  try {
    neg = await cap.negotiateOrder({ serviceId: opts.serviceId, requirements });
  } catch (err) {
    log.fail(CHECKS.H01, `negotiateOrder threw: ${(err as Error).message}`);
    m.abort('negotiation could not be created');
    return finish();
  }
  target.providerAgentId = neg.providerAgentId || undefined;
  log.expect(
    CHECKS.H01,
    Boolean(neg.negotiationId) && (neg.status === 'pending' || neg.status === 'accepted'),
    `negotiation ${neg.negotiationId} created (status=${neg.status})`,
    `unexpected negotiation state: ${JSON.stringify({ id: neg.negotiationId, status: neg.status })}`,
    { negotiationId: neg.negotiationId },
  );

  const negStart = Date.now();
  const settledNeg = await pollUntil(
    () => cap.getNegotiation(neg.negotiationId),
    (n) => n.status !== 'pending',
    acceptTimeoutMs,
    poll,
  );
  const acceptMs = Date.now() - negStart;

  if (!settledNeg || settledNeg.status !== 'accepted') {
    log.fail(
      CHECKS.H02,
      !settledNeg || settledNeg.status === 'pending'
        ? `provider never responded — negotiation still pending after ${acceptTimeoutMs}ms`
        : `negotiation ended ${settledNeg.status} (${settledNeg.rejectReason || 'no reason'}) after ${acceptMs}ms`,
    );
    notes.push('No funds were at risk: audit aborted before any payment.');
    m.abort('provider unresponsive or rejected negotiation');
    return finish();
  }
  log.pass(CHECKS.H02, `accepted in ${acceptMs}ms (window ${acceptTimeoutMs}ms)`);

  // Locate the order created from this negotiation.
  const found = await pollUntil(
    async () => {
      const all = await cap.listOrders({ role: 'requester' });
      return all.find((o) => o.negotiationId === neg.negotiationId) ?? null;
    },
    (o) => o.status !== 'creating',
    acceptTimeoutMs,
    poll,
  );

  if (!found) {
    log.fail(CHECKS.H03, 'no order appeared for the accepted negotiation');
    m.abort('order never materialized on-chain');
    return finish();
  }
  mainOrder = found;
  target.providerAgentId = mainOrder.providerAgentId;
  target.providerWalletAddress = mainOrder.providerWalletAddress || undefined;
  trackOrder('main', mainOrder);

  log.expect(
    CHECKS.H03,
    mainOrder.status === 'created' && /^0x[0-9a-fA-F]{8,}$/.test(mainOrder.createTxHash),
    `order ${mainOrder.orderId} created on-chain (chainOrderId=${mainOrder.chainOrderId})`,
    `order status=${mainOrder.status}, createTxHash=${mainOrder.createTxHash || '<empty>'}`,
    { orderId: mainOrder.orderId, createTxHash: mainOrder.createTxHash },
  );

  const priceOk = log.expect(
    CHECKS.H04,
    mainOrder.price === opts.expectedPrice,
    `order price ${mainOrder.price} matches advertised ${opts.expectedPrice}`,
    `PRICE MISMATCH: advertised ${opts.expectedPrice}, order demands ${mainOrder.price}`,
    { orderPrice: mainOrder.price, advertisedPrice: opts.expectedPrice },
  );
  if (!priceOk) {
    notes.push('Refused to pay a mispriced order — audit aborted before funds moved.');
    m.abort('price mismatch: will not fund a bait-and-switch order');
    return finish();
  }

  const payDeadlineOk = Boolean(mainOrder.payDeadline) && Date.parse(mainOrder.payDeadline) > Date.now();
  const windowOk = mainOrder.deliveryWindow > 0;
  log.expect(
    CHECKS.H05,
    payDeadlineOk && windowOk,
    `payDeadline=${mainOrder.payDeadline}, deliveryWindow=${mainOrder.deliveryWindow}`,
    `incoherent deadlines: payDeadline=${mainOrder.payDeadline || '<unset>'}, deliveryWindow=${mainOrder.deliveryWindow}`,
  );

  if (log.hasCriticalFailure()) {
    m.abort('critical failure before payment');
    return finish();
  }

  // ------------------------------------------------------------------ LOCK
  m.to('LOCK');
  const requesterBefore = opts.balances ? await opts.balances.requester() : null;
  const providerBefore =
    opts.balances && mainOrder.providerWalletAddress
      ? await opts.balances.provider(mainOrder.providerWalletAddress)
      : null;

  try {
    const payRes = await cap.payOrder(mainOrder.orderId);
    const paid = await pollUntil(
      () => cap.getOrder(mainOrder!.orderId),
      (o) => o.status !== 'created' && o.status !== 'paying',
      acceptTimeoutMs,
      poll,
    );
    mainOrder = paid ?? payRes.order;
    trackOrder('main', mainOrder);
    // A fast provider may already be delivering/completed by the time we poll.
    const escrowLocked = ['paid', 'delivering', 'completed'].includes(mainOrder.status);
    log.expect(
      CHECKS.H06,
      escrowLocked && Boolean(payRes.txHash),
      `escrow locked: payTx=${payRes.txHash}, paidAt=${mainOrder.paidAt}`,
      `payment did not settle: status=${mainOrder.status}, payTx=${payRes.txHash || '<empty>'}`,
      { payTxHash: payRes.txHash },
    );
  } catch (err) {
    const msg = isInsufficientBalance(err)
      ? `insufficient auditor balance (required ${err.required}, have ${err.balance}) — fund the auditor wallet`
      : `payOrder failed: ${(err as Error).message}`;
    log.fail(CHECKS.H06, msg);
    m.abort('payment failed');
    return finish();
  }

  if (requesterBefore !== null && opts.balances) {
    const after = await opts.balances.requester();
    const debit = requesterBefore - after;
    const expected = BigInt(mainOrder.price) + BigInt(mainOrder.feeAmount || '0');
    log.expect(
      CHECKS.H07,
      debit === expected,
      `requester debited exactly ${debit} (price ${mainOrder.price} + fee ${mainOrder.feeAmount || '0'})`,
      `requester debited ${debit}, expected ${expected}`,
    );
  } else {
    log.skip(CHECKS.H07, 'no balance reader configured (mock provides one; live mode can use Base RPC)');
  }

  if (log.hasCriticalFailure()) {
    m.abort('critical failure at escrow lock');
    return finish();
  }

  // --------------------------------------------------------------- DELIVER
  m.to('DELIVER');
  mainOrder = await cap.getOrder(mainOrder.orderId); // refresh: slaDeadline is set at pay time
  const slaMs = mainOrder.slaDeadline ? Date.parse(mainOrder.slaDeadline) : Date.now() + deliveryGraceMs;
  const waitBudget = Math.max(slaMs - Date.now(), 0) + deliveryGraceMs;

  const terminal = new Set(['completed', 'rejected', 'expired', 'deliver_failed', 'pay_failed']);
  const settled = await pollUntil(
    () => cap.getOrder(mainOrder!.orderId),
    (o) => terminal.has(o.status),
    waitBudget,
    poll,
  );
  mainOrder = settled ?? (await cap.getOrder(mainOrder.orderId));
  trackOrder('main', mainOrder);

  if (mainOrder.status !== 'completed') {
    log.fail(
      CHECKS.H08,
      `no completed delivery before SLA deadline ${mainOrder.slaDeadline} (+${deliveryGraceMs}ms grace); final status=${mainOrder.status}`,
    );
    if (mainOrder.status === 'expired' || mainOrder.status === 'rejected') {
      if (opts.balances && requesterBefore !== null) {
        // Expiry/reject should have refunded escrow — verify before leaving.
        await sleep(poll);
        const after = await opts.balances.requester();
        const refunded = after === requesterBefore;
        notes.push(
          refunded
            ? `Order ${mainOrder.status}: escrow was refunded in full (balance restored).`
            : `Order ${mainOrder.status} but requester balance NOT restored — escrow appears stranded.`,
        );
      } else {
        notes.push(`Order ended ${mainOrder.status}; refund state not verifiable without a balance reader.`);
      }
    }
    m.abort('delivery did not complete');
    return finish();
  }

  const deliveredInTime =
    Boolean(mainOrder.deliveredAt) && (!mainOrder.slaDeadline || Date.parse(mainOrder.deliveredAt) <= slaMs);
  log.expect(
    CHECKS.H08,
    deliveredInTime,
    `delivered at ${mainOrder.deliveredAt} (SLA deadline ${mainOrder.slaDeadline})`,
    `delivered late: deliveredAt=${mainOrder.deliveredAt}, slaDeadline=${mainOrder.slaDeadline}`,
    { deliverTxHash: mainOrder.deliverTxHash },
  );

  let payload = '';
  try {
    const delivery = await cap.getDelivery(mainOrder.orderId);
    payload = delivery.deliverableText || delivery.deliverableSchema || '';
    log.expect(
      CHECKS.H09,
      contentHashMatches(delivery.contentHash, payload),
      `contentHash verifies: sha256(payload) == ${delivery.contentHash.slice(0, 18)}…`,
      `TAMPER: contentHash ${delivery.contentHash.slice(0, 18)}… does not match sha256(payload)`,
      { contentHash: delivery.contentHash, deliveryId: delivery.deliveryId },
    );

    const typeValid =
      delivery.deliverableType === 'text' || delivery.deliverableType === 'schema';
    const typeExpected = opts.expectedDeliverableType
      ? delivery.deliverableType === opts.expectedDeliverableType
      : true;
    let schemaParses = true;
    if (delivery.deliverableType === 'schema') {
      try {
        JSON.parse(delivery.deliverableSchema || delivery.deliverableText);
      } catch {
        schemaParses = false;
      }
    }
    log.expect(
      CHECKS.H10,
      typeValid && typeExpected && schemaParses,
      `deliverableType=${delivery.deliverableType} conforms to contract`,
      `deliverable nonconformant: type=${delivery.deliverableType}, expected=${opts.expectedDeliverableType ?? 'any'}, schemaParses=${schemaParses}`,
    );

    log.expect(
      CHECKS.H11,
      payload.includes(nonce),
      'deliverable echoes the request nonce — work is per-request, not canned',
      'deliverable does not echo the request nonce; per-request work cannot be proven',
    );
  } catch (err) {
    log.fail(CHECKS.H09, `getDelivery failed on a completed order: ${(err as Error).message}`);
    log.skip(CHECKS.H10, 'no delivery object retrievable');
    log.skip(CHECKS.H11, 'no delivery object retrievable');
  }

  // ----------------------------------------------------------------- CLEAR
  m.to('CLEAR');
  mainOrder = await cap.getOrder(mainOrder.orderId);
  trackOrder('main', mainOrder);
  log.expect(
    CHECKS.H12,
    mainOrder.status === 'completed' && Boolean(mainOrder.clearTxHash),
    `settlement cleared: clearTx=${mainOrder.clearTxHash.slice(0, 18)}…`,
    `settlement incomplete: status=${mainOrder.status}, clearTxHash=${mainOrder.clearTxHash || '<empty>'}`,
    { clearTxHash: mainOrder.clearTxHash },
  );

  if (providerBefore !== null && opts.balances && mainOrder.providerWalletAddress) {
    const after = await opts.balances.provider(mainOrder.providerWalletAddress);
    const credit = after - providerBefore;
    log.expect(
      CHECKS.H13,
      credit === BigInt(mainOrder.price),
      `provider credited exactly ${credit}`,
      `provider credited ${credit}, expected ${mainOrder.price}`,
    );
  } else {
    log.skip(CHECKS.H13, 'no balance reader configured');
  }

  const hashes = [
    mainOrder.createTxHash,
    mainOrder.payTxHash,
    mainOrder.deliverTxHash,
    mainOrder.clearTxHash,
  ].filter(Boolean);
  log.expect(
    CHECKS.H14,
    hashes.length === 4 && new Set(hashes).size === 4,
    'create/pay/deliver/clear tx hashes all present and distinct',
    `tx hash chain incomplete or duplicated: ${hashes.length} present, ${new Set(hashes).size} distinct`,
  );

  // ---------------------------------------------------------------- PROBES
  m.to('PROBES');

  if (probes.refund) {
    try {
      const nonce2 = uuid();
      const neg2 = await cap.negotiateOrder({
        serviceId: opts.serviceId,
        requirements: JSON.stringify({ handshake: { nonce: nonce2, kind: 'refund-probe' } }),
        metadata: JSON.stringify({ handshake_probe: 'reject_after_pay' }),
      });
      const acc2 = await pollUntil(
        () => cap.getNegotiation(neg2.negotiationId),
        (n) => n.status !== 'pending',
        acceptTimeoutMs,
        poll,
      );
      if (acc2?.status !== 'accepted') {
        log.skip(CHECKS.H15, 'refund probe negotiation was not accepted');
      } else {
        const probeOrder = await pollUntil(
          async () =>
            (await cap.listOrders({ role: 'requester' })).find((o) => o.negotiationId === neg2.negotiationId) ?? null,
          (o) => o.status === 'created',
          acceptTimeoutMs,
          poll,
        );
        if (!probeOrder) {
          log.skip(CHECKS.H15, 'refund probe order never materialized');
        } else {
          const balBefore = opts.balances ? await opts.balances.requester() : null;
          await cap.payOrder(probeOrder.orderId);
          const rejected = await pollUntil(
            () => cap.getOrder(probeOrder.orderId),
            (o) => terminal.has(o.status),
            Math.max(probeOrder.deliveryWindow * 3, acceptTimeoutMs),
            poll,
          );
          trackOrder('refund-probe', rejected ?? probeOrder);
          if (rejected?.status === 'rejected') {
            let refundOk = true;
            let detail = `order rejected (${rejected.rejectReason}), rejectTx=${rejected.rejectTxHash.slice(0, 18)}…`;
            if (balBefore !== null && opts.balances) {
              const balAfter = await opts.balances.requester();
              refundOk = balAfter === balBefore;
              detail += refundOk ? '; escrow refunded in full' : `; REFUND SHORTFALL of ${balBefore - balAfter}`;
            }
            log.expect(CHECKS.H15, Boolean(rejected.rejectTxHash) && refundOk, detail, detail, {
              rejectTxHash: rejected.rejectTxHash,
            });
          } else {
            log.skip(
              CHECKS.H15,
              `target did not honor the reject_after_pay probe (final status: ${rejected?.status ?? 'unknown'}) — see docs/INTEGRATION.md for the provider opt-in snippet`,
            );
          }
        }
      }
    } catch (err) {
      log.fail(CHECKS.H15, `refund probe errored: ${(err as Error).message}`);
    }
  } else {
    log.skip(CHECKS.H15, 'refund probe disabled (enable with probes.refund=true; requires target opt-in)');
  }

  if (probes.doublePay) {
    try {
      await cap.payOrder(mainOrder.orderId);
      log.fail(CHECKS.H16, 'second payOrder on a settled order SUCCEEDED — double-spend risk');
    } catch (err) {
      log.expect(
        CHECKS.H16,
        isInvalidStatus(err),
        'double-pay rejected with INVALID_STATUS',
        `double-pay rejected but with unexpected error: ${(err as Error).message}`,
      );
    }
  } else {
    log.skip(CHECKS.H16, 'double-pay probe disabled');
  }

  if (probes.bogusService) {
    try {
      await cap.negotiateOrder({ serviceId: `svc_handshake_bogus_${nonce}`, requirements: '' });
      log.fail(CHECKS.H17, 'negotiation against a nonexistent service SUCCEEDED');
    } catch (err) {
      log.expect(
        CHECKS.H17,
        isNotFound(err),
        'unknown service rejected with *_NOT_FOUND',
        `unknown service rejected with unexpected error: ${(err as Error).message}`,
      );
    }
  } else {
    log.skip(CHECKS.H17, 'bogus-service probe disabled');
  }

  if (probes.foreignDeliver) {
    try {
      await cap.deliverOrder(mainOrder.orderId, {
        deliverableType: 'text',
        deliverableText: 'handshake foreign-deliver probe',
      });
      log.fail(CHECKS.H18, 'requester was able to deliver on the provider\'s order — role enforcement broken');
    } catch (err) {
      log.expect(
        CHECKS.H18,
        isForbidden(err) || isInvalidParams(err) || isInvalidStatus(err),
        'foreign deliverOrder rejected (role enforcement holds)',
        `foreign deliverOrder rejected with unexpected error: ${(err as Error).message}`,
      );
    }
  } else {
    log.skip(CHECKS.H18, 'foreign-deliver probe disabled');
  }

  return finish();
}



