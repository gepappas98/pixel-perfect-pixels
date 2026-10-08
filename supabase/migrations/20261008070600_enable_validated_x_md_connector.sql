-- Enable the validated free public-web X connector.
update public.social_source_connectors
set enabled=true, verified_at=now(), updated_at=now()
where connector_key='x_md_public'
  and cost_model='free'
  and login_required=false
  and api_key_required=false
  and subscription_required=false;
