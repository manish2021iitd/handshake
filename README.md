# Handshake

![CAP audit badge](docs/badge-example.svg)

**The conformance auditor for the CROO agent economy.** Handshake is a CAP agent that other agents hire — over CAP itself — to prove they implement CAP correctly. It places real micro-orders against a target service, walks the full **Negotiate → Lock → Deliver → Clear** lifecycle, verifies every observable property (escrow accounting, SLA, delivery `contentHash`, settlement, refund path, error handling), and delivers an **Ed25519-signed conformance report + badge** as the CAP deliverable.

Built against the real [`@croo-network/sdk@0.2.1`](https://www.npmjs.com/package/@croo-network/sdk) types and errors. Runs today against an in-memory CAP simulator; goes live with zero adapter code.

## Why this exists

Agent-to-agent commerce means hiring strangers. CROO's protocol gives agents the *rails* — escrow in the CAPVault, on-chain tx hashes for every state transition, content hashes on deliveries. But rails don't tell a buyer whether a specific provider actually honors them: delivers inside its SLA, doesn't bait-and-switch on price, produces payloads matching its on-chain `contentHash`, refunds correctly. Handshake turns those rails into **portable, machine-verifiable trust**: a signed report any agent can check before spending a single base unit of USDC.

None of this is possible on a Web2 API marketplace — there is no escrow to reconcile, no tx hash to cite, no on-chain refund path to exercise. The audit *is* the crypto-native part.

## What one audit sale looks like

```
customer ──(#1 buys "CAP Conformance Audit", 3 USDC)──▶ handshake
handshake ──(#2 main conformance probe, 1 USDC)───────▶ target
handshake ──(#3 refund probe, 1 USDC in → 1 USDC back)▶ target
```

One purchase fans out into **three real CAP orders** and ~11 on-chain transactions. The report itself is the deliverable of order #1 — its `contentHash` is on-chain, and its Ed25519 signature verifies offline. Handshake is simultaneously a **provider** (selling audits) and a **requester** (probing targets): A2A composability in one loop.

## Quickstart

```bash
npm install
npm test            # 14 tests: state machine, all five failure modes, signing, e2e
npm run demo        # the full self-sale story above, in ~1 second
npm run audit:good  # audit a conformant provider  → CONFORMANT 100/100, exit 0
npm run audit:tamper     # forged contentHash      → H09 FAIL, verdict FAILED
npm run audit:overprice  # bait-and-switch pricing → H04 FAIL, aborted BEFORE paying
npm run audit:ghost      # unresponsive provider   → H02 FAIL, zero funds at risk
```

Verified output from `npm run demo` (mock network, real SDK types):

```
VERDICT: CONFORMANT  score 100/100  (18 pass · 0 fail · 0 skip)
3 CAP orders · 11 distinct on-chain txs from one audit sale
customer  97.00 USDC (−3.00) · handshake 102.00 USDC (+2.00) · good-provider 1.00 USDC (+1.00)
```

## The conformance suite

Score is severity-weighted (critical=3, major=2, minor=1) over executed checks. Any critical failure forces verdict `FAILED`; ≥90 with no critical failures is `CONFORMANT`.

| ID | Sev | Proves |
|----|-----|--------|
| H01 | crit | Negotiation created and acknowledged |
| H02 | crit | Provider accepts within the response window |
| H03 | crit | Order created on-chain (`createTxHash`) |
| H04 | crit | Order price == advertised price (no bait-and-switch) — **mismatch aborts before payment** |
| H05 | maj | `payDeadline` / `slaDeadline` / `deliveryWindow` coherent |
| H06 | crit | Payment accepted, escrow locked (`payTxHash`) |
| H07 | crit | Requester debited *exactly* price + fee |
| H08 | crit | Delivery completed within `slaDeadline` |
| H09 | crit | `contentHash == sha256(payload)` — delivery-proof integrity |
| H10 | maj | Deliverable type matches the service contract |
| H11 | maj | Deliverable echoes the request nonce (fresh work, not canned) |
| H12 | crit | Settlement cleared (`clearTxHash`, status `completed`) |
| H13 | maj | Provider credited *exactly* the order price |
| H14 | min | Lifecycle tx hashes present and pairwise distinct |
| H15 | maj | Refund path: post-payment reject refunds requester in full (opt-in probe) |
| H16 | maj | Double-pay rejected with `INVALID_STATUS` (idempotent escrow) |
| H17 | min | Unknown service → clean `*_NOT_FOUND` |
| H18 | min | Foreign `deliverOrder` rejected (role enforcement) |

## Architecture

```
src/
  capClient.ts        CapClient = the exact structural slice of AgentClient we use.
                      The real SDK client satisfies it as-is → live mode needs NO adapter.
  audit/
    machine.ts        Phase state machine (NEGOTIATE→LOCK→DELIVER→CLEAR→PROBES→REPORT,
                      ABORTED reachable everywhere; every path ends in a report)
    checks.ts         The H01–H18 registry (the table above, in code)
    runner.ts         Drives a real order through the lifecycle, executing checks
    report.ts         Weighted scoring, verdicts, Ed25519 signing, SVG badge
  mock/
    network.ts        In-memory CROO backend + CAPVault: real SDK types, real SDK
                      APIErrors (guards like isNotFound behave identically), enforced
                      escrow ledger, five adversarial provider profiles
    client.ts         MockAgentClient — same CapClient interface, per-agent identity
    fixtures.ts       Test bench + Handshake's own sellable audit service
  cli.ts              npx tsx src/cli.ts --mock tamper | --live --service … --price …
  provider.ts         Live loop: sell audits on mainnet via WebSocket events
scripts/demo.ts       The three-order self-sale story
test/                 14 tests incl. every failure profile + full e2e
```

The design bet: **the mock speaks the SDK's exact dialect** — same `Order`/`Negotiation`/`Delivery` shapes, same `APIError` reason strings — so the audit engine cannot tell simulator from mainnet, and going live changes one constructor call.

### Mock bench profiles (what the tests prove Handshake catches)

| Profile | Misbehavior | Caught by |
|---------|-------------|-----------|
| `good` | none — fully conformant | 18/18 pass |
| `slow` | blows the SLA; order expires | H08 (+ verifies expiry refund) |
| `ghost` | never responds to negotiation | H02, zero funds ever at risk |
| `tamper` | on-time delivery, forged `contentHash` | H09 |
| `overprice` | order created at 2× advertised price | H04 — **refuses to pay** |

## Going live on Base

Full walkthrough in [`docs/INTEGRATION.md`](docs/INTEGRATION.md). Short version: register the agent + the "CAP Conformance Audit" service on the [dashboard](https://agent.croo.network), deposit a small USDC float to the agent's **vault address**, set `.env`, then:

```bash
npm run provider:live                                   # start selling audits
npm run audit:live -- --service svc_… --price 1000000   # or audit someone directly
```

Buyers negotiate with requirements JSON: `{"targetServiceId": "svc_…", "expectedPrice": "1000000", "allowRefundProbe": false}`.

## The refund-probe protocol (H15)

Escrow's whole promise is the refund path — so Handshake tests it with real money. The probe order carries metadata `{"handshake_probe": "reject_after_pay"}`; a participating provider rejects that paid order, and Handshake verifies the escrow comes back to the buyer in full, citing the `rejectTxHash`. Providers opt in with ~6 lines (snippet in `docs/INTEGRATION.md`). Not opted in? The check records `skip`, never `fail`.

## SDK methods used (`@croo-network/sdk@0.2.1`)

| Surface | Where |
|---------|-------|
| `negotiateOrder`, `getNegotiation`, `getOrder`, `listOrders`, `payOrder`, `getDelivery` | `audit/runner.ts` — the requester-side audit path |
| `deliverOrder` | `runner.ts` (H18 role-enforcement probe) + `provider.ts` (delivering signed reports) |
| `acceptNegotiation`, `listNegotiations`, `rejectOrder` | `provider.ts` — the live sell loop |
| `connectWebSocket` + `EventStream.on(EventType.NegotiationCreated / OrderPaid)` | `provider.ts` |
| `APIError` guards: `isNotFound`, `isInvalidStatus`, `isForbidden`, `isInvalidParams`, `isInsufficientBalance` | probe verdicts in `runner.ts`; thrown natively by the mock |
| `DeliverableType`, `OrderStatus`, `NegotiationStatus`, all entity types | throughout — the mock is built from the SDK's own types |

## Hackathon submission checklist

- [ ] **Listed on the CROO Agent Store** — register agent + "CAP Conformance Audit" service on the dashboard (`docs/INTEGRATION.md` §1)
- [ ] **CAP-integrated: callable + settles on-chain** — `npm run provider:live`, then complete ≥1 paid order end-to-end; save the `clearTxHash`
- [x] **Open source** — MIT, this repo (make it public before filing)
- [ ] **≤5-min demo video + README** — script below; this README covers setup, SDK methods, integration notes
- [ ] **BUIDL filed on DoraHacks** — tracks: *Developer Tooling* + *Data & Verification*; include repo, video, Agent Store link, and 2–3 basescan links from a real report

**Judging bonus (10+ real CAP orders):** every audit sold = 2–3 orders (sale + main probe + optional refund probe). Four paying customers clears the bar; offer free launch-week audits in the hackathon Discord — every team needs both a conformance check *and* order volume before demo day, so distribution is structural.

## Demo video script (≤5:00)

- **0:00–0:40** — The problem: agents hiring strangers. CROO gives the rails (escrow, tx hashes); who proves a given provider honors them?
- **0:40–1:30** — `npm run demo`: one audit purchase fans into three on-chain orders; buyer verifies `contentHash` + Ed25519 signature on camera.
- **1:30–2:45** — The catches, live: `audit:tamper` (forged hash → FAILED), `audit:overprice` (refuses to pay, funds never move), `audit:ghost`.
- **2:45–4:00** — Mainnet: Agent Store listing, a real paid audit, click the `clearTxHash` through to basescan, drop the badge into a team's README.
- **4:00–5:00** — Why it composes: auditor is provider *and* requester; every team on the network is a customer; judges can see our order volume in the CAP data itself.

## Economics & safety

Price each audit ≥ (target's price × 2 probe orders) + margin — e.g. a 3 USDC audit of a 1 USDC service nets +1 USDC before fees, since the refund probe returns to the wallet. Gas is currently sponsored network-wide; when that ends, add per-order gas headroom to the formula — the unit economics survive. Run the auditor from a **dedicated agent wallet with a small float** (it intentionally sends funds to unaudited strangers), and deposit USDC to the agent's **vault address**, not the controller EOA.

## Roadmap

PTS-aware scoring (weight findings into CROO's reputation layer) → scheduled re-audits with badge expiry (conformance as a subscription) → a public registry of signed reports any agent can query pre-purchase.

## License

MIT — see [LICENSE](LICENSE).
