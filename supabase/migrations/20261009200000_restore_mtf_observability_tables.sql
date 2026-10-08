-- Restore missing MTF observability tables found during production schema-parity audit.
-- Research/telemetry only: this does not change BUY eligibility or execution gates.

CREATE TABLE IF NOT EXISTS public.mtf_gate_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  score numeric,
  confidence numeric,
  mtf_bull_count integer NOT NULL,
  mtf_bear_count integer NOT NULL,
  mtf_neutral_count integer NOT NULL,
  reject_reason text,
  regime_label text,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mtf_gate_rejections_time
  ON public.mtf_gate_rejections (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_mtf_gate_rejections_symbol
  ON public.mtf_gate_rejections (symbol, detected_at DESC);

ALTER TABLE public.mtf_gate_rejections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mtf_gate_rejections FROM anon, authenticated;
GRANT ALL ON public.mtf_gate_rejections TO service_role;
DROP POLICY IF EXISTS mtf_gate_rejections_service_all ON public.mtf_gate_rejections;
CREATE POLICY mtf_gate_rejections_service_all
  ON public.mtf_gate_rejections FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.shadow_mtf_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  side text NOT NULL,
  original_recommendation text NOT NULL,
  gated_recommendation text NOT NULL,
  score numeric,
  confidence numeric,
  mtf_bull_count integer NOT NULL,
  mtf_bear_count integer NOT NULL,
  mtf_neutral_count integer NOT NULL,
  reasoning text,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_mtf_gates_time
  ON public.shadow_mtf_gates (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_mtf_gates_symbol
  ON public.shadow_mtf_gates (symbol, detected_at DESC);

ALTER TABLE public.shadow_mtf_gates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shadow_mtf_gates FROM anon, authenticated;
GRANT ALL ON public.shadow_mtf_gates TO service_role;
DROP POLICY IF EXISTS shadow_mtf_gates_service_all ON public.shadow_mtf_gates;
CREATE POLICY shadow_mtf_gates_service_all
  ON public.shadow_mtf_gates FOR ALL TO service_role
  USING (true) WITH CHECK (true);
