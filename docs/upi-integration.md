# UPI Integration Design

## Why UPI

UPI materially improves conversion for India-based creators and low-ticket sales where card failure and friction are high.

## Supported UPI Modes

1. **UPI Intent**
   - Deep-link users to preferred UPI apps.
   - Best for mobile web/PWA flows.

2. **UPI QR**
   - Render dynamic QR for desktop and cross-device payment.

3. **UPI Collect**
   - Collect request to VPA (`name@bank`) for approval inside UPI app.

Use a PSP/payment aggregator that supports all three and robust webhook events.

## Checkout Flow (Recommended)

1. User chooses product/subscription.
2. Backend creates `payment_order` in `pending` state.
3. Payment service requests order from PSP (with idempotency key).
4. Return payment instructions to client:
   - `upi_intent_url`
   - `upi_qr_payload`
   - `collect_request_token` (if applicable)
5. Client shows smart payment UI (intent first on mobile, QR fallback).
6. PSP webhook confirms success/failure.
7. Backend verifies signature, marks transaction terminal state.
8. Entitlements are granted immediately after `success` event.

## Webhook Handling Rules

- Verify signatures and source IP where provider supports it.
- Idempotency by `provider_event_id`.
- Never trust client redirect as payment proof.
- Use async reconciliation job for uncertain states.

## Subscription via UPI

UPI AutoPay support varies by provider and merchant setup.

Fallback strategy:
- If AutoPay eligible: create recurring mandate.
- If not eligible: run assisted renewals with push reminders + one-tap payment relink.

## Data Model Additions

- `payments.provider = stripe | upi_psp`
- `payments.method = card | upi_intent | upi_qr | upi_collect`
- Store `provider_order_id`, `provider_payment_id`, `vpa_masked`, and `reconciliation_status`

## UX Best Practices

- Prioritize UPI for Indian users and low-ticket offers.
- Keep total payment steps <= 3 clicks/taps where possible.
- On success, immediately show unlocked content and CTA for install/push if not yet enabled.
