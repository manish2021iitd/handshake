import type {
  AcceptNegotiationResult,
  DeliverOrderRequest,
  DeliverOrderResult,
  Delivery,
  ListOptions,
  NegotiateOrderRequest,
  Negotiation,
  Order,
  PayOrderResult,
} from '@croo-network/sdk';
import type { CapClient } from '../capClient';
import type { MockNetwork } from './network';

/**
 * A per-agent client over the MockNetwork — the in-memory equivalent of
 * `new AgentClient(config, sdkKey)`, where the "sdkKey" is the agentId.
 * Implements the same `CapClient` interface the audit engine consumes, so the
 * runner is byte-for-byte identical in mock and live mode.
 */
export class MockAgentClient implements CapClient {
  constructor(
    private readonly net: MockNetwork,
    readonly agentId: string,
  ) {}

  async negotiateOrder(req: NegotiateOrderRequest): Promise<Negotiation> {
    return this.net.negotiateOrder(this.agentId, req.serviceId, req.requirements ?? '', req.metadata ?? '');
  }

  async getNegotiation(negotiationId: string): Promise<Negotiation> {
    return this.net.getNegotiation(this.agentId, negotiationId);
  }

  async acceptNegotiation(negotiationId: string): Promise<AcceptNegotiationResult> {
    return this.net.acceptNegotiation(this.agentId, negotiationId);
  }

  async rejectNegotiation(negotiationId: string, reason: string): Promise<void> {
    this.net.rejectNegotiation(this.agentId, negotiationId, reason);
  }

  async getOrder(orderId: string): Promise<Order> {
    return this.net.getOrder(this.agentId, orderId);
  }

  async listOrders(_opts?: ListOptions): Promise<Order[]> {
    return this.net.listOrders(this.agentId);
  }

  async payOrder(orderId: string): Promise<PayOrderResult> {
    return this.net.payOrder(this.agentId, orderId);
  }

  async deliverOrder(orderId: string, req: DeliverOrderRequest): Promise<DeliverOrderResult> {
    return this.net.deliverOrder(this.agentId, orderId, req);
  }

  async rejectOrder(orderId: string, reason: string): Promise<void> {
    this.net.rejectOrder(this.agentId, orderId, reason);
  }

  async getDelivery(orderId: string): Promise<Delivery> {
    return this.net.getDelivery(this.agentId, orderId);
  }
}
