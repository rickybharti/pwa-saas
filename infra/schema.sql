-- Core multi-tenant schema for Creator-Owned Distribution Engine

create table creators (
  id uuid primary key,
  email text not null unique,
  display_name text not null,
  plan text not null default 'starter',
  domain text,
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table audience_users (
  id uuid primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  email text,
  phone text,
  name text,
  source text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index audience_users_creator_id_idx on audience_users(creator_id);

create table push_subscriptions (
  id uuid primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  audience_user_id uuid not null references audience_users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
create index push_subscriptions_creator_status_idx on push_subscriptions(creator_id, status);

create table content_items (
  id uuid primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  title text not null,
  content_type text not null,
  body jsonb not null default '{}'::jsonb,
  access_tier text not null default 'free',
  unlock_at timestamptz,
  one_time_view boolean not null default false,
  created_at timestamptz not null default now()
);
create index content_items_creator_idx on content_items(creator_id);

create table campaigns (
  id uuid primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  name text not null,
  segment_rule jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz,
  status text not null default 'draft',
  ab_variant jsonb,
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  audience_user_id uuid not null references audience_users(id) on delete cascade,
  provider text not null, -- stripe | upi_psp
  method text not null,   -- card | upi_intent | upi_qr | upi_collect
  amount_in_paise integer not null,
  currency text not null default 'INR',
  status text not null, -- pending | success | failed | refunded
  provider_order_id text,
  provider_payment_id text,
  vpa_masked text,
  reconciliation_status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_creator_status_idx on payments(creator_id, status);

create table subscriptions (
  id uuid primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  audience_user_id uuid not null references audience_users(id) on delete cascade,
  provider text not null,
  provider_subscription_id text,
  plan_code text not null,
  status text not null,
  next_billing_at timestamptz,
  created_at timestamptz not null default now()
);

create table referrals (
  id uuid primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  referrer_user_id uuid not null references audience_users(id) on delete cascade,
  referred_user_id uuid references audience_users(id) on delete set null,
  code text not null,
  reward_type text not null,
  reward_value text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  unique (creator_id, code)
);

create table events (
  id bigserial primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  audience_user_id uuid references audience_users(id) on delete set null,
  event_name text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_creator_name_time_idx on events(creator_id, event_name, created_at desc);
