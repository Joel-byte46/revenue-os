// ============================================================
// REVENUE OS — NOTIFICATIONS
// Delivery des alertes et recommandations vers Slack.
// Fire-and-forget : ne bloque jamais les agents.
//
// Principe : Les agents génèrent les recommandations.
// Ce module les livre au founder.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type {
  Recommendation,
  RecommendationPriority,
  PipelinePayload,
  TreasuryRunwayPayload,
  TreasuryZombiePayload,
  TreasuryAnomalyPayload,
  BriefPayload,
  SlackMessage,
  SlackBlock
} from './types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const APP_URL = Deno.env.get('APP_URL') ?? 'https://app.revenue-os.com'

// ------------------------------------------------------------
// NOTIFY RECOMMENDATION
// Point d'entrée principal. Appelé après création d'une reco.
// ------------------------------------------------------------

export async function notifyRecommendation(
  rec: Recommendation
): Promise<void> {
  const webhookUrl = await getTenantSlackWebhook(rec.tenant_id)
  if (!webhookUrl) return

  const message = buildRecommendationMessage(rec)
  await sendSlack(webhookUrl, message)
}

// ------------------------------------------------------------
// NOTIFY BATCH
// Pour les cycles complets : envoyer un résumé groupé
// plutôt que N messages individuels.
// ------------------------------------------------------------

export async function notifyBatch(
  tenantId: string,
  recommendations: Recommendation[]
): Promise<void> {
  const webhookUrl = await getTenantSlackWebhook(tenantId)
  if (!webhookUrl) return

  if (recommendations.length === 0) return

  const critical = recommendations.filter(r => r.priority === 'critical')
  const high = recommendations.filter(r => r.priority === 'high')
  const other = recommendations.filter(
    r => r.priority !== 'critical' && r.priority !== 'high'
  )

  const message: SlackMessage = {
    text: `🤖 Revenue OS — ${recommendations.length} nouvelles recommandations`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🤖 Revenue OS — Cycle terminé`
        }
      } as SlackBlock,
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: buildBatchSummaryText(critical, high, other)
        }
      },
      ...buildTopRecommendationsBlocks(recommendations.slice(0, 3)),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '👀 Voir toutes les recommandations' },
            url: `${APP_URL}/command`,
            style: 'primary'
          }
        ]
      }
    ]
  }

  await sendSlack(webhookUrl, message)
}

// ------------------------------------------------------------
// NOTIFY CRITICAL ALERT
// Pour les alertes critiques (runway < 3 mois, etc.).
// Envoyé immédiatement, pas groupé.
// ------------------------------------------------------------

export async function notifyCritical(
  tenantId: string,
  title: string,
  body: string,
  actionUrl?: string
): Promise<void> {
  const webhookUrl = await getTenantSlackWebhook(tenantId)
  if (!webhookUrl) return

  const message: SlackMessage = {
    text: `🚨 ${title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🚨 *${title}*\n\n${body}`
        }
      },
      actionUrl
        ? {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Voir maintenant' },
                url: actionUrl,
                style: 'danger'
              }
            ]
          }
        : null
    ].filter(Boolean) as SlackBlock[]
  }

  await sendSlack(webhookUrl, message)
}

// ------------------------------------------------------------
// NOTIFY INTEGRATION ERROR
// Quand une intégration tombe (token expiré, API down).
// ------------------------------------------------------------

export async function notifyIntegrationError(
  tenantId: string,
  provider: string,
  errorMessage: string
): Promise<void> {
  const webhookUrl = await getTenantSlackWebhook(tenantId)
  if (!webhookUrl) return

  const message: SlackMessage = {
    text: `⚠️ Connexion ${provider} perdue`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *Connexion ${provider} perdue*\n\n` +
                `${errorMessage}\n\n` +
                `Les agents fonctionnent avec les données en cache.`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reconnecter' },
            url: `${APP_URL}/settings?reconnect=${provider}`
          }
        ]
      }
    ]
  }

  await sendSlack(webhookUrl, message)
}

// ------------------------------------------------------------
// NOTIFY WEEKLY BRIEF
// Format spécial pour le brief hebdomadaire.
// ------------------------------------------------------------

export async function notifyWeeklyBrief(
  tenantId: string,
  brief: BriefPayload
): Promise<void> {
  const webhookUrl = await getTenantSlackWebhook(tenantId)
  if (!webhookUrl) return

  const m = brief.metrics

  const message: SlackMessage = {
    text: `📊 Brief hebdomadaire Revenue OS`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📊 Brief semaine du ${brief.week_of}`
        }
      } as SlackBlock,
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: brief.narrative
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Pipeline*\n${formatCurrency(m.pipeline_value)} (${formatChange(m.pipeline_change_pct)})`
          },
          {
            type: 'mrkdwn',
            text: `*Runway*\n${m.runway_months.toFixed(1)} mois`
          },
          {
            type: 'mrkdwn',
            text: `*MRR*\n${formatCurrency(m.mrr)}`
          },
          {
            type: 'mrkdwn',
            text: `*Leads chauds*\n${m.hot_leads} leads`
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Actions prioritaires cette semaine :*\n` +
                brief.top_actions
                  .slice(0, 3)
                  .map((a, i) => `${i + 1}. ${a.title} — _${a.impact_estimate}_`)
                  .join('\n')
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '⚡ Ouvrir Command Center' },
            url: `${APP_URL}/command`,
            style: 'primary'
          }
        ]
      }
    ]
  }

  await sendSlack(webhookUrl, message)
}

// ------------------------------------------------------------
// INTERNAL : BUILD RECOMMENDATION MESSAGE
// ------------------------------------------------------------

function buildRecommendationMessage(rec: Recommendation): SlackMessage {
  const emoji = priorityEmoji(rec.priority)
  const agentLabel = agentTypeLabel(rec.agent_type)

  const baseBlocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${rec.title}*\n${rec.summary ?? ''}`
      }
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Agent: ${agentLabel} • Priorité: ${rec.priority.toUpperCase()}`
        }
      ]
    }
  ]

  // Contenu spécifique par type
  const specificBlock = buildSpecificBlock(rec)
  if (specificBlock) baseBlocks.push(specificBlock)

  baseBlocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✓ Approuver' },
        url: `${APP_URL}/command?action=approve&id=${rec.id}`,
        style: 'primary'
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Voir détail' },
        url: `${APP_URL}/command?highlight=${rec.id}`
      }
    ]
  })

  return {
    text: `${emoji} ${rec.title}`,
    blocks: baseBlocks
  }
}

function buildSpecificBlock(rec: Recommendation): SlackBlock | null {
  switch (rec.agent_type) {
    case 'pipeline_stagnation': {
      const p = rec.payload as PipelinePayload
      return {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Deal*\n${p.deal_title}` },
          { type: 'mrkdwn', text: `*Montant*\n${formatCurrency(p.deal_amount)}` },
          { type: 'mrkdwn', text: `*Bloqué depuis*\n${p.days_stagnant} jours` },
          { type: 'mrkdwn', text: `*Raison probable*\n${p.blocking_reason}` }
        ]
      }
    }
    case 'treasury_runway': {
      const p = rec.payload as TreasuryRunwayPayload
      return {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Runway*\n${p.runway_months.toFixed(1)} mois` },
          { type: 'mrkdwn', text: `*Cash*\n${formatCurrency(p.current_balance)}` },
          { type: 'mrkdwn', text: `*Burn net*\n${formatCurrency(p.monthly_net_burn)}/mois` },
          { type: 'mrkdwn', text: `*MRR*\n${formatCurrency(p.mrr)}` }
        ]
      }
    }
    case 'treasury_zombie': {
      const p = rec.payload as TreasuryZombiePayload
      return {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `💸 *${p.merchant}* — ${formatCurrency(p.monthly_cost)}/mois\n` +
                `_${p.explanation}_`
        }
      }
    }
    default:
      return null
  }
}

// ------------------------------------------------------------
// INTERNAL : SEND TO SLACK
// ------------------------------------------------------------

async function sendSlack(
  webhookUrl: string,
  message: SlackMessage
): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(`[notify] Slack error ${response.status}: ${text}`)
    }
  } catch (error) {
    // Ne jamais laisser une erreur Slack bloquer un agent
    console.error('[notify] Failed to send Slack message:', error)
  }
}

// ------------------------------------------------------------
// INTERNAL : GET TENANT SLACK WEBHOOK
// ------------------------------------------------------------

async function getTenantSlackWebhook(
  tenantId: string
): Promise<string | null> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const { data } = await supabase
    .from('tenants')
    .select('settings')
    .eq('id', tenantId)
    .single()

  return data?.settings?.slack_webhook ?? null
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function buildBatchSummaryText(
  critical: Recommendation[],
  high: Recommendation[],
  other: Recommendation[]
): string {
  const lines: string[] = []
  if (critical.length > 0)
    lines.push(`🚨 *${critical.length} critiques* nécessitent votre attention immédiate`)
  if (high.length > 0)
    lines.push(`⚡ *${high.length} haute priorité*`)
  if (other.length > 0)
    lines.push(`📌 *${other.length} autres* recommandations`)
  return lines.join('\n')
}

function buildTopRecommendationsBlocks(
  recs: Recommendation[]
): SlackBlock[] {
  return recs.map(rec => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${priorityEmoji(rec.priority)} *${rec.title}*\n${rec.summary ?? ''}`
    }
  }))
}

function priorityEmoji(priority: RecommendationPriority): string {
  const map: Record<RecommendationPriority, string> = {
    critical: '🚨',
    high: '⚡',
    medium: '📌',
    low: '💡'
  }
  return map[priority]
}

function agentTypeLabel(agentType: string): string {
  const map: Record<string, string> = {
    pipeline_stagnation: 'Pipeline',
    lead_engagement: 'Leads',
    lead_reengagement: 'Leads (ré-engagement)',
    ads_waste: 'Ads',
    ads_scaling: 'Ads',
    treasury_runway: 'Trésorerie',
    treasury_zombie: 'Trésorerie',
    treasury_anomaly: 'Trésorerie',
    weekly_brief: 'Brief hebdo'
  }
  return map[agentType] ?? agentType
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0
  }).format(amount)
}

function formatChange(pct: number): string {
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}
