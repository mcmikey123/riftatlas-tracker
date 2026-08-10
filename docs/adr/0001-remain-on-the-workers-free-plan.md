# 0001. Remain on the Cloudflare Workers Free plan as the spend ceiling

Date: 2026-08-10
Status: accepted

## Context

Replay sharing puts an unauthenticated `PUT` endpoint on the public internet, published inside an
open-source extension. Any token shipped in that extension is public by construction, so the
endpoint is world-writable in practice. The Cloudflare account absorbing the resulting storage and
request costs belongs to the contributor, not to the repo owner.

Two facts about Cloudflare shape the response:

1. **R2 cannot be enabled without a payment method on file**, even to use only the free tier.
   There is no "no card attached, so it just stops" state available.
2. **Cloudflare offers no hard spend cap.** Budget alerts exist, are limited to pay-as-you-go
   accounts, and explicitly do not pause services — they send email. Feature requests for a real
   usage cap on R2 and Workers remain open.

Together these mean that overage on a personal account becomes a real bill with no platform-level
brake, and the natural instinct — upgrade Workers to the $5/month paid plan so the service does
not fall over under load — actively makes this worse.

The Workers Free plan's 100,000 requests/day limit returns Error 1027 and stops serving until
00:00 UTC, at no charge. It is the only hard ceiling anywhere in this stack. The paid plan removes
that limit and replaces it with per-request billing.

## Decision

The default instance stays on the Workers Free plan permanently, and the daily request limit is
treated as a deliberate safety feature rather than a limitation to be engineered around.

Abuse control is layered beneath it: a per-IP rate limit on the upload route, a 12 MB size cap, a
fixed 7-day TTL, an `UPLOADS_ENABLED` variable that disables uploads from the dashboard without a
deploy, and a budget alert for notification.

## Consequences

Worst-case exposure is bounded to roughly $135/month, and only if an attacker saturates the daily
request limit every day for a month. Normal use — on the order of 50 shares/month — costs nothing
against a 10 GB free allowance. R2's always-free egress is what keeps the ceiling bounded, since
the expensive failure mode for a public file host is being cheap to write and costly to read.

The service degrades by becoming unavailable rather than by becoming expensive. If the instance is
ever genuinely popular, sharing stops working at some point each day until UTC midnight, and the
correct response is to investigate why, not to upgrade the plan.

This commits future maintainers to a non-obvious constraint. Upgrading Workers to paid looks like
routine capacity work and would silently delete the only spend ceiling protecting a personal
credit card. That is the entire reason this decision is recorded rather than left in the spec.

Self-hosters are unaffected: they own their own instance, their own account and their own
trade-off, and the deploy documentation does not prescribe a plan.
