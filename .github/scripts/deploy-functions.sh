#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# VALIDATION SECRETS
# -----------------------------
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "❌ SUPABASE_ACCESS_TOKEN is missing"
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "❌ SUPABASE_PROJECT_REF is missing"
  exit 1
fi

echo "🚀 Starting Edge Functions deployment..."

FUNCTIONS=(
  orchestrator
  agent-ingestor
  agent-pipeline
  agent-leads
  agent-ads
  agent-treasury
  agent-brief
  agent-feedback
)

# -----------------------------
# DEPLOY LOOP
# -----------------------------
for fn in "${FUNCTIONS[@]}"; do
  echo "➡️ Deploying $fn..."

  supabase functions deploy "$fn" \
    --project-ref "$SUPABASE_PROJECT_REF" \
    --no-verify-jwt

done

echo "✅ All functions deployed successfully."
