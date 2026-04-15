#!/bin/bash

set -e

export SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN
export SUPABASE_PROJECT_REF=$SUPABASE_PROJECT_REF

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

for func in "${FUNCTIONS[@]}"; do
  echo "Deploying $func..."

  supabase functions deploy "$func" \
    --project-ref "$SUPABASE_PROJECT_REF" \
    --no-verify-jwt

done
