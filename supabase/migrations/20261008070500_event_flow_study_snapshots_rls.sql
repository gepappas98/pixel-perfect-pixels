-- Security fix: research aggregate snapshots are service-role-only.
alter table public.event_flow_study_snapshots enable row level security;
revoke all on public.event_flow_study_snapshots from anon, authenticated;
