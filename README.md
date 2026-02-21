# Creator-Owned Distribution Engine

Production-grade creator SaaS engine with delivery, monetization, growth, and enterprise white-label controls.

## Enterprise white-label features implemented

- Plan catalog and billing-aligned upgrades (`starter`, `growth`, `enterprise`) targeting ₹79–199 pricing tiers.
- Per-plan feature gating (`customDomain`, `advancedBranding`, `removePoweredBy`, `workflowBranching`).
- Branding controls with plan-aware enforcement (enterprise-only "remove powered by").
- Custom domain provisioning lifecycle (provision, DNS token, verify, SSL status, list domains).
- White-label state integrated into dashboard and public page rendering.

## Growth features

- Funnel builder templates + public pages (`/f/:slug`).
- Bio-link templates + public pages (`/b/:slug`).
- UTM/source/campaign attribution dashboard.
- Dynamic segment rule builder with AND/OR combinators.
- Branching workflow editor simulation with conditional transitions.
- Best send-time recommender with confidence and sample size.

## Run
```bash
npm run dev
```

## Test
```bash
npm test
npm run check
```
