-- Explicitly represent current V4 live-aligned variant observations in the research archive.
-- Additive and idempotent: preserve all V2/V3/Legacy/Unknown rows; never update/delete source signals.
ALTER TABLE public.research_cases
  DROP CONSTRAINT IF EXISTS research_cases_cohort_check;
ALTER TABLE public.research_cases
  ADD CONSTRAINT research_cases_cohort_check
  CHECK (cohort = ANY (ARRAY['Legacy'::text, 'V2'::text, 'V3'::text, 'V4'::text, 'Unknown'::text]));

-- Evidence summary contains entry-time inputs only; do not copy outcomes or forward PnL into evidence.
INSERT INTO public.research_evidence
  (source_table, source_id, symbol, observed_at, available_at, fingerprint, role, summary)
SELECT
  'strategy_variant_signals',
  s.id::text,
  s.symbol,
  s.created_at,
  s.created_at,
  md5('research-lab-evidence:v4:' || s.id::text),
  'entry_context',
  left(
    'policy=v4_live_aligned; strategy=' || coalesce(s.strategy_name,'unknown') ||
    '; symbol=' || coalesce(s.symbol,'unknown') ||
    '; score=' || coalesce(s.score::text,'') ||
    '; confidence=' || coalesce(s.confidence::text,'') ||
    '; recommendation=' || coalesce(s.recommendation,'') ||
    '; regime=' || coalesce(s.production_regime_label,s.regime_label,'unknown') ||
    '; market_session=' || coalesce(s.market_session,'unknown') ||
    '; asset_trend=' || coalesce(s.asset_trend_regime,'unknown') ||
    '; asset_volatility=' || coalesce(s.asset_volatility_regime,'unknown') ||
    '; source_tags=' || coalesce(array_to_string(s.source_tags,','),'') ||
    '; reasoning=' || coalesce(s.reasoning,''),
    2000
  )
FROM public.strategy_variant_signals s
WHERE s.source_fingerprint LIKE 'v4|%'
ON CONFLICT (fingerprint) DO NOTHING;

-- Separate statement is intentional: inserted evidence must be visible to this insert.
INSERT INTO public.research_cases
  (source_table,source_id,symbol,strategy,cohort,scorer_version,fingerprint,
   entry_at,resolved_at,maturity_at,outcome,net_pnl,pnl_unit,close_reason,regime,evidence_ids)
SELECT
  'strategy_variant_signals',
  s.id::text,
  coalesce(s.symbol,'unknown'),
  coalesce(s.strategy_name,'unknown'),
  'V4',
  'v4-live-aligned',
  s.source_fingerprint,
  s.created_at,
  s.resolved_at,
  s.resolved_at,
  s.outcome,
  s.pnl_pct,
  'percent',
  NULL,
  coalesce(s.production_regime_label,s.regime_label),
  ARRAY[e.id::text]
FROM public.strategy_variant_signals s
JOIN public.research_evidence e
  ON e.source_table='strategy_variant_signals'
 AND e.source_id=s.id::text
 AND e.fingerprint=md5('research-lab-evidence:v4:' || s.id::text)
WHERE s.source_fingerprint LIKE 'v4|%'
ON CONFLICT (source_table,source_id,cohort,scorer_version) DO NOTHING;
