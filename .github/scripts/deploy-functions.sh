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

for fn in "${FUNCTIONS[@]}"
do
  echo "Deploying $fn..."
  supabase functions deploy "$fn" \
    --no-verify-jwt \
    --project-ref "$SUPABASE_PROJECT_REF"
done
