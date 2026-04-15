-- ============================================================
-- REVENUE OS — FONCTIONS SQL (FINAL SUPABASE VERSION)
-- Migration 003 : logique métier SQL pure
-- ============================================================

-- ------------------------------------------------------------
-- PIPELINE HEALTH
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_pipeline_health(p_tenant_id UUID)
RETURNS JSON
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT json_build_object(
    'total_deals',
    COUNT(*) FILTER (
      WHERE stage NOT IN ('closed_won', 'closed_lost')
    ),

    'total_value',
    COALESCE(SUM(amount) FILTER (
      WHERE stage NOT IN ('closed_won', 'closed_lost')
    ), 0),

    'stagnant_count',
    COUNT(*) FILTER (
      WHERE stage NOT IN ('closed_won', 'closed_lost')
      AND EXTRACT(DAY FROM NOW() - last_activity_at) > 14
    ),

    'stagnant_value',
    COALESCE(SUM(amount) FILTER (
      WHERE stage NOT IN ('closed_won', 'closed_lost')
      AND EXTRACT(DAY FROM NOW() - last_activity_at) > 14
    ), 0),

    'critical_count',
    COUNT(*) FILTER (
      WHERE stage NOT IN ('closed_won', 'closed_lost')
      AND EXTRACT(DAY FROM NOW() - last_activity_at) > 30
    ),

    'avg_deal_size',
    COALESCE(AVG(amount) FILTER (
      WHERE stage NOT IN ('closed_won', 'closed_lost')
    ), 0),

    'deals_closed_30d',
    COUNT(*) FILTER (
      WHERE stage = 'closed_won'
      AND updated_at > NOW() - INTERVAL '30 days'
    ),

    'revenue_closed_30d',
    COALESCE(SUM(amount) FILTER (
      WHERE stage = 'closed_won'
      AND updated_at > NOW() - INTERVAL '30 days'
    ), 0)
  )
  FROM deals
  WHERE tenant_id = p_tenant_id;
$$;


-- ------------------------------------------------------------
-- STAGNANT DEALS
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_stagnant_deals(
  p_tenant_id UUID,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  amount NUMERIC,
  currency TEXT,
  stage TEXT,
  stage_raw TEXT,
  days_stagnant INT,
  contact_email TEXT,
  contact_name TEXT,
  company_name TEXT,
  notes TEXT,
  raw_data JSONB,
  criticality_score NUMERIC
)
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT
    d.id,
    d.title,
    d.amount,
    d.currency,
    d.stage,
    d.stage_raw,

    EXTRACT(DAY FROM NOW() - d.last_activity_at)::INT AS days_stagnant,

    d.contact_email,
    d.contact_name,
    d.company_name,
    d.notes,
    d.raw_data,

    (d.amount * EXTRACT(DAY FROM NOW() - d.last_activity_at))::NUMERIC
      AS criticality_score

  FROM deals d
  WHERE d.tenant_id = p_tenant_id
    AND d.stage NOT IN ('closed_won', 'closed_lost', 'unknown')
    AND d.last_activity_at IS NOT NULL
    AND EXTRACT(DAY FROM NOW() - d.last_activity_at) > 14
  ORDER BY criticality_score DESC
  LIMIT p_limit;
$$;


-- ------------------------------------------------------------
-- DORMANT LEADS
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_dormant_leads(
  p_tenant_id UUID,
  p_min_days INT DEFAULT 30,
  p_max_days INT DEFAULT 180,
  p_min_score INT DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  industry TEXT,
  company_size TEXT,
  total_score INT,
  status TEXT,
  days_silent INT
)
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT
    id,
    email,
    first_name,
    last_name,
    company,
    industry,
    company_size,
    total_score,
    status,

    EXTRACT(DAY FROM NOW() - updated_at)::INT AS days_silent

  FROM leads
  WHERE tenant_id = p_tenant_id
    AND status NOT IN ('won','lost','unsubscribed','disqualified','in_sequence')
    AND total_score >= p_min_score
    AND EXTRACT(DAY FROM NOW() - updated_at)
        BETWEEN p_min_days AND p_max_days
  ORDER BY total_score DESC, updated_at ASC;
$$;


-- ------------------------------------------------------------
-- MONTHLY EXPENSE SUMMARY (FIXED - NO NESTED AGGREGATES)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_monthly_expense_summary(
  p_tenant_id UUID,
  p_months INT DEFAULT 6
)
RETURNS TABLE (
  month_label TEXT,
  total_expense NUMERIC,
  breakdown JSONB
)
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  WITH monthly AS (
    SELECT
      DATE_TRUNC('month', date) AS month_date,
      ABS(SUM(amount)) AS total_expense
    FROM transactions
    WHERE tenant_id = p_tenant_id
      AND type = 'expense'
      AND date >= DATE_TRUNC('month', NOW() - (p_months || ' months')::INTERVAL)
    GROUP BY DATE_TRUNC('month', date)
  ),
  breakdown AS (
    SELECT
      DATE_TRUNC('month', date) AS month_date,
      COALESCE(category, 'unknown') AS category,
      ABS(SUM(amount)) AS value
    FROM transactions
    WHERE tenant_id = p_tenant_id
      AND type = 'expense'
      AND date >= DATE_TRUNC('month', NOW() - (p_months || ' months')::INTERVAL)
    GROUP BY DATE_TRUNC('month', date), category
  )
  SELECT
    m.month_date::TEXT AS month_label,
    m.total_expense,
    (
      SELECT jsonb_object_agg(b.category, b.value)
      FROM breakdown b
      WHERE b.month_date = m.month_date
    ) AS breakdown
  FROM monthly m
  ORDER BY m.month_date;
$$;


-- ------------------------------------------------------------
-- MRR CALCULATION
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION calculate_mrr(p_tenant_id UUID)
RETURNS NUMERIC
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(SUM(ABS(amount)) / 3.0, 0)
  FROM transactions
  WHERE tenant_id = p_tenant_id
    AND type = 'revenue'
    AND is_recurring = TRUE
    AND date >= NOW() - INTERVAL '90 days'
$$;


-- ------------------------------------------------------------
-- WEIGHTED PIPELINE
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_weighted_pipeline(
  p_tenant_id UUID,
  p_days INT DEFAULT 30
)
RETURNS JSON
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  WITH stage_weights AS (
    SELECT
      unnest(ARRAY['new','qualified','demo_done','proposal_sent','negotiation']) AS stage_name,
      unnest(ARRAY[0.05,0.2,0.35,0.55,0.8]) AS weight
  )
  SELECT json_build_object(
    'total_weighted_value',
    COALESCE(SUM(d.amount * COALESCE(sw.weight,0.1)),0),

    'expected_30d_revenue',
    COALESCE(SUM(
      CASE
        WHEN d.close_date <= CURRENT_DATE + p_days
        THEN d.amount * COALESCE(sw.weight,0.1)
        ELSE 0
      END
    ),0),

    'deal_count',
    COUNT(*) FILTER (
      WHERE d.stage NOT IN ('closed_won','closed_lost')
    )
  )
  FROM deals d
  LEFT JOIN stage_weights sw ON sw.stage_name = d.stage
  WHERE d.tenant_id = p_tenant_id
    AND d.stage NOT IN ('closed_won','closed_lost');
$$;


-- ------------------------------------------------------------
-- MATCH PATTERNS (RAG FIXED)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_patterns(
  p_tenant_id UUID,
  p_embedding vector(1536),
  p_limit INT DEFAULT 3,
  p_min_score FLOAT DEFAULT 0.6
)
RETURNS TABLE (
  content TEXT,
  agent_source TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT
    content,
    agent_source,
    metadata,
    1 - (embedding <=> p_embedding) AS similarity
  FROM pattern_embeddings
  WHERE tenant_id = p_tenant_id
    AND (1 - (embedding <=> p_embedding)) >= p_min_score
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;


-- ------------------------------------------------------------
-- ADS ACCOUNT AVERAGES
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_ads_account_averages(
  p_tenant_id UUID,
  p_platform TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT json_build_object(
    'avg_cpa', COALESCE(AVG(cost_per_conversion) FILTER (WHERE cost_per_conversion > 0), 0),
    'avg_ctr', COALESCE(AVG(ctr), 0),
    'avg_roas', COALESCE(AVG(roas) FILTER (WHERE roas > 0), 0),
    'total_spend_30d', COALESCE(SUM(spend), 0),
    'total_conversions_30d', COALESCE(SUM(conversions), 0)
  )
  FROM ad_campaigns
  WHERE tenant_id = p_tenant_id
    AND status = 'active'
    AND snapshot_date >= CURRENT_DATE - 30
    AND (p_platform IS NULL OR platform = p_platform);
$$;


-- ------------------------------------------------------------
-- CURRENT BALANCE
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_current_balance(p_tenant_id UUID)
RETURNS NUMERIC
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(SUM(current_balance), 0)
  FROM bank_accounts
  WHERE tenant_id = p_tenant_id;
$$;


-- ------------------------------------------------------------
-- WEEKLY METRICS
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_weekly_metrics(p_tenant_id UUID)
RETURNS JSON
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT json_build_object(
    'new_recommendations',
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'),

    'pending_recommendations',
    COUNT(*) FILTER (WHERE status = 'pending'),

    'approved_this_week',
    COUNT(*) FILTER (
      WHERE status IN ('approved','executed')
      AND approved_at >= NOW() - INTERVAL '7 days'
    ),

    'rejected_this_week',
    COUNT(*) FILTER (
      WHERE status = 'rejected'
      AND rejected_at >= NOW() - INTERVAL '7 days'
    )
  )
  FROM recommendations
  WHERE tenant_id = p_tenant_id;
$$;


-- ------------------------------------------------------------
-- PIPELINE SNAPSHOT TABLE
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pipeline_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  metrics JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, snapshot_date)
);

ALTER TABLE pipeline_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pipeline_snapshots_read_own"
ON pipeline_snapshots
FOR SELECT
USING (tenant_id = get_tenant_id());
