create or replace function public.classify_influential_social_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e public.influential_social_events%rowtype;
  s public.influential_social_sources%rowtype;
  t text;
  v_relevance text := 'none';
  v_relevance_score numeric := 0;
  v_etype text := 'other';
  v_edir smallint := 0;
  v_sev text := 'normal';
  v_sev_score numeric := 0;
  v_assets text[] := array[]::text[];
  v_reasons text[] := array[]::text[];
  v_engagement_score numeric := 0;
  v_source_score numeric := 0;
  v_crypto_hits integer := 0;
begin
  select * into e from public.influential_social_events where id = p_event_id;
  if not found then raise exception 'influential social event % not found', p_event_id; end if;
  select * into s from public.influential_social_sources where id = e.source_id;
  t := lower(regexp_replace(coalesce(e.text_content,''), '\\s+', ' ', 'g'));

  if t ~ '\\m(bitcoin|btc)\\M' then v_assets := array_append(v_assets,'BTC'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(ethereum|ether|eth)\\M' then v_assets := array_append(v_assets,'ETH'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(dogecoin|doge)\\M' then v_assets := array_append(v_assets,'DOGE'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(binance coin|bnb)\\M' then v_assets := array_append(v_assets,'BNB'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(sol(?:ana)?|sol)\\M' then v_assets := array_append(v_assets,'SOL'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(xrp|ripple)\\M' then v_assets := array_append(v_assets,'XRP'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(cardano|ada)\\M' then v_assets := array_append(v_assets,'ADA'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(shib|shiba|shibainu)\\M' then v_assets := array_append(v_assets,'SHIB'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(trump|official trump|maga)\\M' then v_assets := array_append(v_assets,'TRUMP'); v_crypto_hits := v_crypto_hits + 1; end if;
  if t ~ '\\m(crypto|cryptocurrency|blockchain|token|defi|web3|stablecoin|altcoin|memecoin|meme coin|wallet|exchange|binance|coinbase)\\M' then v_crypto_hits := v_crypto_hits + 1; end if;
  v_assets := array(select distinct x from unnest(v_assets) x order by x);

  if v_crypto_hits >= 2 or cardinality(v_assets) >= 1 then
    v_relevance := 'high';
    v_relevance_score := least(1, 0.65 + 0.10 * least(v_crypto_hits,3));
    v_reasons := array_append(v_reasons,'explicit_crypto_or_asset_reference');
  elsif t ~ '\\m(crypto|cryptocurrency|blockchain|token|defi|web3|stablecoin|exchange|market|regulation|sec)\\M' then
    v_relevance := 'medium';
    v_relevance_score := 0.55;
    v_reasons := array_append(v_reasons,'crypto_context_keyword');
  else
    v_relevance := 'none';
    v_relevance_score := 0;
    v_reasons := array_append(v_reasons,'no_explicit_crypto_context');
  end if;

  if t ~ '\\m(sec|regulation|regulatory|ban|law|legislation|tariff|sanction|executive order|policy)\\M' then v_etype := 'policy';
  elsif t ~ '\\m(bitcoin|btc|ethereum|eth|dogecoin|doge|xrp|bnb|solana|sol|ada|shib|trump coin|crypto)\\M' then v_etype := 'asset_specific';
  elsif t ~ '\\m(stock|shares|company|revenue|earnings|acquisition|merger|ipo)\\M' then v_etype := 'corporate';
  elsif t ~ '\\m(grok|x app|x.com|starlink|spacex|tesla)\\M' then v_etype := 'product';
  elsif t ~ '\\m(war|attack|invasion|iran|israel|ukraine|russia|china|taiwan|geopolit)\\M' then v_etype := 'geopolitical';
  elsif t ~ '\\m(meme|lol|😂|🤣|doge)\\M' then v_etype := 'meme'; end if;

  if t ~ '\\m(buy|bought|bullish|bull|support|approve|approved|launch|adopt|adoption|positive|good for|success|growth|strong|higher)\\M'
     and t !~ '\\m(not|never|no)\\s+(buy|support|approve|bullish)\\M' then
    v_edir := 1;
    v_reasons := array_append(v_reasons,'positive_lexical_direction');
  elsif t ~ '\\m(sell|sold|bearish|bear|ban|banned|reject|rejected|negative|bad for|shutdown|fraud|scam|lower|drop|crash)\\M' then
    v_edir := -1;
    v_reasons := array_append(v_reasons,'negative_lexical_direction');
  else
    v_edir := 0;
    v_reasons := array_append(v_reasons,'direction_not_determinable');
  end if;

  v_source_score := greatest(0, least(1,
    coalesce(s.research_priority,50)::numeric / 100.0 *
    case coalesce(s.evidence_level,'unverified')
      when 'strong' then 1.00 when 'moderate' then 0.85 when 'weak' then 0.70 else 0.55
    end
  ));

  v_engagement_score := least(1, greatest(
    coalesce(e.engagement_views,0)::numeric / 1000000.0,
    coalesce(e.engagement_likes,0)::numeric / 100000.0,
    coalesce(e.engagement_reposts,0)::numeric / 50000.0,
    coalesce(e.engagement_quotes,0)::numeric / 10000.0
  ));

  v_sev_score := least(1, 0.45*v_relevance_score + 0.30*v_source_score + 0.25*v_engagement_score);

  if v_relevance = 'none' then v_sev := 'normal'; v_sev_score := 0;
  elsif v_sev_score >= 0.82 then v_sev := 'extreme';
  elsif v_sev_score >= 0.62 then v_sev := 'major';
  elsif v_sev_score >= 0.40 then v_sev := 'notable';
  else v_sev := 'normal'; end if;

  update public.influential_social_events ie
  set crypto_relevance = v_relevance,
      relevance_score = round(v_relevance_score,4),
      event_type = v_etype,
      event_direction = v_edir,
      severity = v_sev,
      severity_score = round(v_sev_score,4),
      affected_assets = v_assets,
      classification_status = case when v_relevance='none' then 'rejected' else 'classified' end,
      classification_reason = array_to_string(v_reasons,';'),
      updated_at = now()
  where ie.id = p_event_id;

  return jsonb_build_object(
    'event_id',p_event_id,'crypto_relevance',v_relevance,'relevance_score',round(v_relevance_score,4),
    'event_type',v_etype,'event_direction',v_edir,'severity',v_sev,'severity_score',round(v_sev_score,4),
    'affected_assets',v_assets,'classification_status',
    case when v_relevance='none' then 'rejected' else 'classified' end,
    'research_only',true
  );
end;
$$;

revoke all on function public.classify_influential_social_event(uuid) from public, anon, authenticated;
grant execute on function public.classify_influential_social_event(uuid) to service_role;