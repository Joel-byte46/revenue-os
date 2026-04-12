// ============================================================
// REVENUE OS — PROMPTS AGENT BRIEF
// Prompts pour la génération du brief hebdomadaire.
//
// PHILOSOPHIE :
// Le brief n'est pas un rapport.
// C'est un briefing opérationnel de 2 minutes.
// Le founder doit savoir exactement quoi faire
// après l'avoir lu, sans avoir à chercher.
// ============================================================

import { buildFinancialSystemPrompt } from './system.rules.ts'
import { buildProductContext } from './shared.context.ts'
import type { WeeklyMetrics, BriefAction } from '../types.ts'

// ------------------------------------------------------------
// PROMPT 1 : WEEKLY_EXECUTIVE_BRIEF
// Le brief hebdomadaire complet.
// Toutes les métriques sont déjà calculées par SQL/Python.
// Le LLM produit UNIQUEMENT le narratif et les top actions.
// ------------------------------------------------------------

export const WEEKLY_EXECUTIVE_BRIEF = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    weekOf: string
    metrics: WeeklyMetrics
    topPendingActions: BriefAction[]
    overallScore: number
    previousWeekScore: number | null
    criticalAlerts: string[]
    positiveHighlights: string[]
    tenantVertical: 'saas' | 'ecom'
    tenantName: string
  }): string => {
    const {
      weekOf, metrics: m, topPendingActions,
      overallScore, previousWeekScore, criticalAlerts,
      positiveHighlights, tenantVertical
    } = params

    const scoreChange = previousWeekScore !== null
      ? overallScore - previousWeekScore
      : null

    const verticalContext = buildProductContext(tenantVertical, false)

    return `
${verticalContext}

=== BRIEF SEMAINE DU ${weekOf} ===

MÉTRIQUES (toutes calculées par le système) :

Revenue :
- Valeur pipeline : ${m.pipeline_value}€ (${m.pipeline_change_pct > 0 ? '+' : ''}${m.pipeline_change_pct.toFixed(1)}% vs sem. précédente)
- Deals bloqués : ${m.stagnant_count} deals (${m.stagnant_value}€ à risque)
- Deals closés cette semaine : ${m.deals_closed} (${m.revenue_this_week}€)
- Forecast mensuel pondéré : ${m.monthly_forecast}€

Leads :
- Nouveaux leads : ${m.new_leads}
- Leads chauds (score 80+) : ${m.hot_leads}
- Taux de réponse aux séquences : ${m.reply_rate.toFixed(1)}%

Publicité :
- Dépense semaine : ${m.ads_spend}€
- CPA moyen : ${m.avg_cpa}€
- Gaspillage détecté : ${m.waste_detected}€/mois

Trésorerie :
- Runway : ${m.runway_months.toFixed(1)} mois
- MRR : ${m.mrr}€
- Burn net : ${m.net_burn}€/mois

Actions en attente : ${m.pending_actions} recommandations non traitées

Score hebdomadaire global : ${overallScore}/100${scoreChange !== null
  ? ` (${scoreChange > 0 ? '+' : ''}${scoreChange} vs semaine dernière)`
  : ' (premier score)'}

Alertes critiques cette semaine :
${criticalAlerts.length > 0
  ? criticalAlerts.map(a => `⚠️ ${a}`).join('\n')
  : 'Aucune alerte critique'}

Points positifs détectés :
${positiveHighlights.length > 0
  ? positiveHighlights.map(p => `✓ ${p}`).join('\n')
  : 'Aucun highlight particulier cette semaine'}

Top 3 actions en attente (classées par impact) :
${topPendingActions.slice(0, 3).map((a, i) =>
  `${i + 1}. [${a.priority.toUpperCase()}] ${a.title} — Impact estimé : ${a.impact_estimate}`
).join('\n')}

=== MISSION ===

Rédige le brief exécutif hebdomadaire.

STRUCTURE IMPOSÉE :
1. Première phrase : le fait le plus important de la semaine
   (positif ou négatif, le plus impactant sur le business)
2. Deuxième phrase : le point de vigilance principal
   (ce qui nécessite une attention cette semaine)
3. Troisième phrase optionnelle : un signal positif à noter
   (seulement s'il est vraiment significatif)

CONTRAINTES :
→ Maximum 150 mots total pour le narratif
→ Commencer directement par le fait — pas de formule d'intro
→ Ne pas lister toutes les métriques — choisir les 2-3 qui comptent vraiment
→ Les top_actions dans le JSON sont les 3 actions les plus importantes
   à faire cette semaine (extraites des actions en attente fournies)
→ Le score hebdomadaire est donné — ne pas le commenter sauf s'il est
   très élevé (> 80) ou très bas (< 30)

Produis UNIQUEMENT ce JSON :

{
  "narrative": "Le brief en 2-3 phrases. Direct. Dense. Sans intro.",
  "week_score": ${overallScore},
  "score_trend": "${scoreChange === null ? 'first' : scoreChange > 5 ? 'up' : scoreChange < -5 ? 'down' : 'stable'}",
  "critical_alert": ${criticalAlerts.length > 0
    ? `"${criticalAlerts[0]}"`
    : 'null'},
  "top_actions": [
    {
      "title": "Action 1 (la plus urgente)",
      "impact_estimate": "Impact chiffré ou qualitatif",
      "recommendation_id": ${topPendingActions[0]?.recommendation_id
        ? `"${topPendingActions[0].recommendation_id}"`
        : 'null'},
      "priority": "${topPendingActions[0]?.priority ?? 'high'}"
    },
    {
      "title": "Action 2",
      "impact_estimate": "Impact",
      "recommendation_id": ${topPendingActions[1]?.recommendation_id
        ? `"${topPendingActions[1].recommendation_id}"`
        : 'null'},
      "priority": "${topPendingActions[1]?.priority ?? 'medium'}"
    },
    {
      "title": "Action 3",
      "impact_estimate": "Impact",
      "recommendation_id": ${topPendingActions[2]?.recommendation_id
        ? `"${topPendingActions[2].recommendation_id}"`
        : 'null'},
      "priority": "${topPendingActions[2]?.priority ?? 'medium'}"
    }
  ],
  "one_liner": "Le brief en UNE phrase pour la notification Slack (max 15 mots)."
}
`.trim()
  },

  example: {
    narrative: "Pipeline sous pression : 8 deals bloqués dont 3 au-dessus de 10K€ — sans action cette semaine, le forecast de 45K€ est en danger. Runway stable à 8.2 mois, mais le burn a augmenté de 12% ce mois — les abonnements zombies identifiés (840€/mois) méritent une heure de votre temps.",
    week_score: 62,
    score_trend: "down",
    critical_alert: "3 deals critiques bloqués représentent 38 000€ de pipeline à risque",
    top_actions: [
      {
        title: "Approuver les emails de relance pour les 3 deals critiques",
        impact_estimate: "38 000€ de pipeline réactivé",
        recommendation_id: "rec_abc123",
        priority: "critical"
      },
      {
        title: "Annuler les 3 abonnements zombies détectés",
        impact_estimate: "+0.2 mois de runway, 840€/mois économisés",
        recommendation_id: "rec_def456",
        priority: "medium"
      },
      {
        title: "Activer la séquence pour les 4 leads chauds en attente",
        impact_estimate: "Pipeline potentiel : 12 000€",
        recommendation_id: "rec_ghi789",
        priority: "high"
      }
    ],
    one_liner: "Pipeline sous pression, 3 deals critiques, runway stable à 8 mois."
  }
}

// ------------------------------------------------------------
// PROMPT 2 : MONTH_IN_REVIEW
// Bilan mensuel. Plus de recul que le brief hebdomadaire.
// Tendances, patterns, recommandations stratégiques.
// ------------------------------------------------------------

export const MONTH_IN_REVIEW = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    month: string
    monthlyMetrics: {
      revenue_generated: number
      deals_closed: number
      avg_deal_size: number
      leads_generated: number
      leads_converted: number
      conversion_rate: number
      ads_spend: number
      ads_roas: number
      runway_start: number
      runway_end: number
      mrr_start: number
      mrr_end: number
      mrr_growth_pct: number
      burn_vs_budget: number | null
    }
    topWins: string[]
    topMisses: string[]
    agentPerformance: {
      recommendations_generated: number
      recommendations_approved: number
      approval_rate: number
      avg_outcome_score: number | null
    }
  }): string => {
    const { month, monthlyMetrics: m, topWins, topMisses, agentPerformance } = params

    return `
=== BILAN MENSUEL — ${month} ===

Revenue :
- Revenus générés : ${m.revenue_generated}€
- Deals closés : ${m.deals_closed} (taille moyenne : ${m.avg_deal_size}€)
- Leads générés : ${m.leads_generated}
- Leads convertis : ${m.leads_converted} (taux : ${m.conversion_rate.toFixed(1)}%)

Publicité :
- Spend total : ${m.ads_spend}€
- ROAS global : ${m.ads_roas.toFixed(2)}

Trésorerie :
- Runway début de mois : ${m.runway_start.toFixed(1)} mois
- Runway fin de mois : ${m.runway_end.toFixed(1)} mois
- MRR : ${m.mrr_start}€ → ${m.mrr_end}€ (${m.mrr_growth_pct > 0 ? '+' : ''}${m.mrr_growth_pct.toFixed(1)}%)
${m.burn_vs_budget !== null
  ? `- Burn vs budget : ${m.burn_vs_budget > 0 ? '+' : ''}${m.burn_vs_budget}€ (${m.burn_vs_budget > 0 ? 'au-dessus' : 'en dessous'} du budget)`
  : ''}

Système AI ce mois :
- Recommandations générées : ${agentPerformance.recommendations_generated}
- Recommandations approuvées : ${agentPerformance.recommendations_approved} (${agentPerformance.approval_rate.toFixed(0)}%)
${agentPerformance.avg_outcome_score !== null
  ? `- Score moyen des outcomes : ${agentPerformance.avg_outcome_score}/100`
  : '- Pas encore assez de données pour mesurer les outcomes'}

Principales victoires du mois :
${topWins.length > 0 ? topWins.map(w => `✓ ${w}`).join('\n') : 'Données insuffisantes'}

Principales manques du mois :
${topMisses.length > 0 ? topMisses.map(m => `✗ ${m}`).join('\n') : 'Données insuffisantes'}

=== MISSION ===

Bilan mensuel en 3-4 phrases.
Apporter une perspective sur les tendances, pas juste les chiffres.
Proposer 2 orientations stratégiques pour le mois suivant.

Produis UNIQUEMENT ce JSON :

{
  "narrative": "3-4 phrases. Vue d'ensemble du mois. Tendances importantes.",
  "month_grade": "B+",
  "key_trend": "La tendance la plus importante observée ce mois (1 phrase).",
  "next_month_priorities": [
    "Priorité stratégique 1 pour le mois prochain",
    "Priorité stratégique 2"
  ],
  "system_performance_note": "Comment le système AI a performé ce mois (1 phrase)."
}

Valeurs pour "month_grade" : "A+" | "A" | "B+" | "B" | "C" | "D" | "F"
A+ = tout va très bien, croissance saine
A  = bon mois, quelques points d'amélioration
B+ = mois correct, opportunités manquées
B  = mois mitigé, problèmes identifiés
C  = mois difficile, action requise
D  = mois très difficile, plan urgent
F  = situation critique
`.trim()
  }
}
