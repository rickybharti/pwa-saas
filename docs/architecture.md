# System Architecture

## High-Level Components

1. **PWA Client**
   - Install flow, push opt-in orchestration, feed rendering
   - Receives notifications and deep-links to content/funnels

2. **Creator Admin App**
   - Campaign creation, content management, analytics, monetization config

3. **API Gateway / Backend**
   - Auth, tenancy, permissions, orchestration

4. **Core Services**
   - Audience Service: users, tags, segments
   - Content Service: assets, entitlements, secure delivery
   - Campaign Service: push scheduling, A/B tests, drips
   - Payment Service: Stripe + UPI provider orchestration
   - Analytics Service: event ingestion and query layer
   - Referral Service: invite links and rewards

5. **Infra**
   - Postgres for transactional data
   - Redis for queues/scheduling/rate limits
   - Object storage for downloadable assets

## Recommended Service Boundaries (Monolith First)

Start with a modular monolith:
- `modules/audience`
- `modules/content`
- `modules/campaigns`
- `modules/payments`
- `modules/analytics`
- `modules/referrals`

Split into microservices only after throughput demands it.

## Core Event Flow

- `user_signed_up`
- `push_opted_in`
- `content_viewed`
- `campaign_sent`
- `campaign_clicked`
- `checkout_started`
- `payment_succeeded`
- `subscription_renewed`
- `referral_reward_granted`

All intelligence dashboards derive from this event stream.

## Security + Compliance

- Multi-tenant data isolation using `creator_id`
- Signed content URLs with expiry
- Idempotent payment webhook processing
- Audit logs for pricing/content changes
- Encrypt sensitive payment metadata

## Performance Targets

- PWA LCP < 1.5s on 4G for landing + first content screen
- API P95 < 300ms for read paths
- Notification send pipeline supports burst fanout via queue workers
