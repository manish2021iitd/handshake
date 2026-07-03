# Going live on the CROO network

The audit engine is network-ready — the real `AgentClient` satisfies the same `CapClient` interface the mock implements, so nothing in `src/audit/` changes. What's left is account plumbing and operational care. Work through this top to bottom.

## 1. Register on the dashboard

Account setup lives in the [CROO dashboard](https://agent.croo.network), not the SDK.

1. Create an agent (e.g. **Handshake**). This provisions its DID (ERC-8004) and AA vault (ERC-4337) on Base.
2. Add a service: **"CAP Conformance Audit"**
   - Deliverable type: **Text** (we deliver the signed report JSON)
   - Requirements: describe the expected JSON — `{"targetServiceId": "svc_…", "expectedPrice": "<usdc base units>", "allowRefundProbe": false}`
   - Price: see the worksheet in §6 (3 USDC is a sane launch price for 1 USDC targets)
   - SLA: be generous — 1 hour is plenty; audits finish in minutes but you want headroom for slow targets
3. Issue an SDK key (`croo_sk_…`) and note your `serviceId`.

## 2. Fund the vault (read this twice)

Deposit a small USDC float **to the agent's vault address — not the controller EOA you log in with**. The `payOrder` escrow pull comes from the vault; funds sent to the controller are invisible to it. Keep the float small (10–20 USDC): the auditor's job is literally paying unaudited strangers, and `InsufficientBalanceError` is a clean failure, while an over-funded hot wallet is not.

## 3. Environment

```bash
cp .env.example .env   # then fill in:
CROO_SDK_KEY=croo_sk_…
HANDSHAKE_SERVICE_ID=svc_…      # your audit service (provider mode)
CROO_TARGET_SERVICE_ID=svc_…    # a target to audit (requester mode)
HANDSHAKE_EXPECTED_PRICE=1000000
```

`CROO_API_URL` / `CROO_WS_URL` default to production endpoints.

## 4. Smoke sequence (do these in order)

1. **Friendly target, probes off.** Audit a teammate's known-good service first: `npm run audit:live -- --service svc_… --price 1000000 --no-probes`. You should see H01–H14 with H07/H13 skipped (no on-chain balance reader wired yet — see roadmap note in the report output).
2. **Safe probes on.** Drop `--no-probes`. H16–H18 only make error-path calls (double-pay on your own settled order, a bogus serviceId, a foreign deliver) — no extra funds move.
3. **Refund probe, coordinated.** Add `--refund-probe` only against a provider running the opt-in snippet below; otherwise the probe order is a *second real purchase* that will simply be fulfilled, and H15 records `skip`.
4. **Sell one.** `npm run provider:live`, then have a teammate negotiate your service with the requirements JSON. Keep the process alive with `pm2`, `systemd`, or `nohup … &` for the judging window.

## 5. Refund-probe opt-in (for providers being audited)

Add this ahead of your normal fulfillment in your `OrderPaid` handler:

```ts
const neg = await client.getNegotiation(order.negotiationId);
let probe: string | undefined;
try { probe = JSON.parse(neg.metadata || '{}').handshake_probe; } catch {}
if (probe === 'reject_after_pay') {
  await client.rejectOrder(order.orderId, 'handshake refund probe honored');
  return; // escrow refunds the requester; Handshake verifies it to the base unit
}
```

Honoring the probe is itself a conformance signal — it earns the H15 `pass` on your badge.

## 6. Pricing worksheet

```
audit_price ≥ target_price × (1 main + 1 refund probe) + gas_headroom + margin
```

The refund probe's principal comes back, so realized cost ≈ one target purchase. Gas is currently sponsored network-wide; when sponsorship ends, set `gas_headroom` from observed Base costs per lifecycle (4–5 txs) — the margin survives either way. Probes H16–H18 are free (error-path calls only).

## 7. Evidence for judges

Every signed report carries the tx hashes for each lifecycle step of each order. Turn any of them into a link:

```
https://basescan.org/tx/<createTxHash | payTxHash | deliverTxHash | rejectTxHash | clearTxHash>
```

Put two or three of these in the BUIDL description — a judge clicking from your report to a Base transaction is the whole pitch landing in one gesture.

## 8. DoraHacks BUIDL checklist

- Tracks: **Developer Tooling** + **Data & Verification** (2 max — these two)
- Repo URL (public, MIT license visible)
- Demo video ≤5 min (script in the README)
- Agent Store listing link for "CAP Conformance Audit"
- README sections judges are told to look for: setup ✓, SDK methods used ✓, integration notes ✓ (this file)
- 2–3 basescan tx links from a completed real audit
- One line on order volume: "each audit sold = 2–3 CAP orders; N audits completed as of submission"
