CREATE OR REPLACE FUNCTION public.compute_variant_shadow_regime()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  snap public.indicator_snapshots%ROWTYPE;
  aroon_osc numeric := NULL;
  atr_pct numeric := NULL;
  signal_score integer := 0;
  aroon_score integer := 0;
  smc_score integer := 0;
  total_score integer := 0;
  smc_state text := NULL;
BEGIN
  SELECT * INTO snap
  FROM public.indicator_snapshots
  WHERE symbol IN (NEW.symbol, NEW.symbol || 'USDT')
    AND timeframe = '4h'
    AND created_at <= NEW.created_at
  ORDER BY created_at DESC
  LIMIT 1;
  IF snap.id IS NULL THEN RETURN NEW; END IF;
  aroon_osc := NULLIF(snap.raw->'aroon'->>'osc','')::numeric;
  atr_pct := NULLIF(snap.raw->>'atr_pct','')::numeric;
  IF LOWER(COALESCE(snap.signal,''))='bullish' THEN signal_score:=1;
  ELSIF LOWER(COALESCE(snap.signal,''))='bearish' THEN signal_score:=-1; END IF;
  IF aroon_osc >= 20 THEN aroon_score:=1;
  ELSIF aroon_osc <= -20 THEN aroon_score:=-1; END IF;
  smc_state:=LOWER(COALESCE(snap.raw->'smc'->>'choch',snap.raw->'smc'->>'bos',''));
  IF smc_state LIKE '%bull%' THEN smc_score:=1;
  ELSIF smc_state LIKE '%bear%' THEN smc_score:=-1; END IF;
  total_score:=signal_score+aroon_score+smc_score;
  NEW.shadow_regime:=CASE
    WHEN total_score>=2 THEN 'strong_bull'
    WHEN total_score=1 THEN 'bull'
    WHEN total_score=0 THEN 'sideways'
    WHEN total_score=-1 THEN 'bear'
    ELSE 'strong_bear'
  END;
  NEW.shadow_signal_4h:=snap.signal;
  NEW.shadow_score:=total_score;
  NEW.shadow_price:=snap.price;
  NEW.shadow_aroon_osc:=aroon_osc;
  NEW.shadow_atr_pct:=atr_pct;
  NEW.shadow_smc_state:=NULLIF(smc_state,'');
  NEW.shadow_source_at:=snap.created_at;
  RETURN NEW;
END;
$function$;