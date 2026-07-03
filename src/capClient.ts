import { AgentClient } from '@croo-network/sdk';
import type {
  Negotiation,
  NegotiateOrderRequest,
  AcceptNegotiationResult,
  Order,
  PayOrderResult,
  Delivery,
  DeliverOrderRequest,
  DeliverOrderResult,
  ListOptions,
} from '@croo-network/sdk';

/**
 * The exact slice of `@croo-network/sdk`'s AgentClient that Handshake exercises.
 *
 * The real `AgentClient` satisfies this interface *structurally*, so live mode
 * needs no adapter or wiring: `new AgentClient(cfg, sdkKey)` IS a `CapClient`.
 * The in-memory `MockAgentClient` implements the same interface (and throws the
 * SDK's own `APIError` types), so the audit engine cannot tell mock from mainnet.
 */
export interface CapClient {
  negotiateOrder(req: NegotiateOrderRequest): Promise<Negotiation>;
  getNegotiation(negotiationId: string): Promise<Negotiation>;
  acceptNegotiation(negotiationId: string): Promise<AcceptNegotiationResult>;
  rejectNegotiation(negotiationId: string, reason: string): Promise<void>;
  getOrder(orderId: string): Promise<Order>;
  listOrders(opts?: ListOptions): Promise<Order[]>;
  payOrder(orderId: string): Promise<PayOrderResult>;
  deliverOrder(orderId: string, req: DeliverOrderRequest): Promise<DeliverOrderResult>;
  rejectOrder(orderId: string, reason: string): Promise<void>;
  getDelivery(orderId: string): Promise<Delivery>;
}

/** Build a live client against the real CROO network (Base). */
export function makeLiveClient(): CapClient {
  const baseURL = process.env.CROO_API_URL ?? 'https://api.croo.network';
  const wsURL = process.env.CROO_WS_URL ?? 'wss://api.croo.network/ws';
  const sdkKey = process.env.CROO_SDK_KEY;
  if (!sdkKey) {
    throw new Error('CROO_SDK_KEY is not set — required for --live mode. See docs/INTEGRATION.md');
  }
  return new AgentClient({ baseURL, wsURL }, sdkKey);
}
