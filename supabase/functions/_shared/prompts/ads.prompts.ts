// ============================================================
// REVENUE OS — PROMPTS AGENT ADS OPTIMIZATION
// Tous les prompts utilisés par agent-ads.
//
// PRINCIPE FONDAMENTAL :
// Le SQL détecte les anomalies et opportunités.
// Le LLM les explique et formule les recommandations.
// Le LLM ne décide JAMAIS ce qui est bon ou mauvais.
// Il reçoit les conclusions et les met en langage naturel.
// ============================================================

import {
  buildSystemPrompt,
  buildFinancialSystemPrompt
} from './system.rules.ts'
import type { AdCampaign, AdAccountAverages, RAGContext } from '../types.ts'

// ------------------------------------------------------------
// PROMPT 1 : WASTE_DIAGNOSIS
// Une campagne a été identifiée comme gaspillage par le SQL.
// Le LLM explique pourquoi et formule l'action précise.
// ------------------------------------------------------------

export const WASTE_DIAGNOSIS = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    campaign: AdCampaign
    accountAverages: AdAccountAverages
    wasteType: 'zero_conversion' | 'high_cpa' | 'low_ctr' | 'budget_inefficiency'
    monthlyWaste: number
    ragContext: RAGContext
  }): string => {
    const { campaign, accountAverages, wasteType, monthlyWaste, ragContext } = params

    const wasteDescriptions = {
      zero_conversion: `La campagne a dépensé ${campaign.spend}€ sur 30 jours sans générer aucune conversion.`,
      high_cpa: `Le CPA de cette campagne (${campaign.cost_per_conversion}€) est ${Math.round((campaign.cost_per_conversion! / accountAverages.avg_cpa - 1) * 100)}% au-dessus de la moyenne du compte (${accountAverages.avg_cpa}€).`,
      low_ctr: `Le CTR de ${(campaign.ctr * 100).toFixed(2)}% est très inférieur à la moyenne du compte. Les audiences ne réagissent pas à la créative.`,
      budget_inefficiency: `La campagne consomme du budget sans performance proportionnelle. ROAS : ${campaign.roas?.toFixed(2) ?? 'N/A'} vs moyenne compte : ${accountAverages.avg_roas?.toFixed(2) ?? 'N/A'}.`
    }

    return `
${ragContext.formattedContext}

=== CAMPAGNE IDENTIFIÉE COMME GASPILLAGE ===

Plateforme : ${campaign.platform}
Nom : ${campaign.name ?? 'Sans nom'}
Statut actuel : ${campaign.status}
Objectif : ${campaign.objective ?? 'Non renseigné'}

Métriques 30 derniers jours :
- Impressions : ${campaign.impressions.toLocaleString('fr-FR')}
- Clics : ${campaign.clicks.toLocaleString('fr-FR')}
- CTR : ${(campaign.ctr * 100).toFixed(3)}%
- CPC moyen : ${campaign.avg_cpc}€
- Conversions : ${campaign.conversions}
- Dépense : ${campaign.spend}€
- CPA : ${campaign.cost_per_conversion ?? 'N/A'}€
- ROAS : ${campaign.roas ?? 'N/A'}

Moyennes du compte (référence) :
- CPA moyen compte : ${accountAverages.avg_cpa}€
- CTR moyen compte : ${(accountAverages.avg_ctr * 100).toFixed(3)}%
- ROAS moyen compte : ${accountAverages.avg_roas?.toFixed(2) ?? 'N/A'}
- Spend total 30j compte : ${accountAverages.total_spend_30d}€

Type de gaspillage détecté : ${wasteType}
Description : ${wasteDescriptions[wasteType]}
Gaspillage mensuel estimé : ${monthlyWaste}€

=== MISSION ===

Explique ce gaspillage et formule UNE recommandation d'action précise.

CONTRAINTES :
→ La recommandation doit être exécutable en moins d'une heure
→ Quantifier l'économie ou l'amélioration attendue avec des chiffres réels
→ Ne pas recommander plus d'une action principale
→ Proposer 2-3 étapes concrètes d'implémentation
→ Ne jamais recommander d'augmenter le budget d'une campagne qui gaspille

Produis UNIQUEMENT ce JSON :

{
  "diagnosis": "Ce qui se passe exactement avec cette campagne (2 phrases max).",
  "root_cause": "La cause probable la plus vraisemblable (1 phrase).",
  "recommended_action": "pause",
  "action_rationale": "Pourquoi cette action spécifiquement (1 phrase).",
  "implementation_steps": [
    "Étape 1 concrète",
    "Étape 2 concrète",
    "Étape 3 concrète (optionnelle)"
  ],
  "monthly_savings_if_applied": ${monthlyWaste},
  "expected_outcome": "Ce qui va se passer si on applique cette recommandation (1 phrase).",
  "risk_if_no_action": "Ce qui va continuer à se passer si on ne fait rien (1 phrase).",
  "confidence": 85,
  "reasoning": "En 1 phrase : pourquoi ce diagnostic est fiable pour cette campagne."
}

Valeurs pour "recommended_action" :
"pause" | "reduce_budget_50pct" | "reduce_budget_25pct" |
"change_audience" | "refresh_creative" | "restructure_targeting"
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 2 : SCALING_OPPORTUNITY
// Une campagne sur-performe. Le SQL l'a identifiée.
// Le LLM explique pourquoi scaler et comment.
// ------------------------------------------------------------

export const SCALING_OPPORTUNITY = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    campaign: AdCampaign
    accountAverages: AdAccountAverages
    cpaAdvantage: number
    // % d'avantage sur le CPA moyen (ex: 0.30 = 30% meilleur)
    recommendedBudgetIncrease: number
    projectedAdditionalConversions: number
    ragContext: RAGContext
  }): string => {
    const {
      campaign, accountAverages, cpaAdvantage,
      recommendedBudgetIncrease, projectedAdditionalConversions,
      ragContext
    } = params

    return `
${ragContext.formattedContext}

=== OPPORTUNITÉ DE SCALING IDENTIFIÉE ===

Plateforme : ${campaign.platform}
Nom : ${campaign.name ?? 'Sans nom'}
Objectif : ${campaign.objective ?? 'Non renseigné'}

Performance actuelle (30 derniers jours) :
- Impressions : ${campaign.impressions.toLocaleString('fr-FR')}
- CTR : ${(campaign.ctr * 100).toFixed(3)}% (compte : ${(accountAverages.avg_ctr * 100).toFixed(3)}%)
- Conversions : ${campaign.conversions}
- Spend : ${campaign.spend}€
- CPA : ${campaign.cost_per_conversion}€ (compte : ${accountAverages.avg_cpa}€)
- ROAS : ${campaign.roas?.toFixed(2) ?? 'N/A'}

Avantage de performance :
- CPA ${Math.round(cpaAdvantage * 100)}% meilleur que la moyenne du compte
- Nombre de conversions : suffisant pour être statistiquement fiable

Recommandation calculée :
- Augmentation de budget suggérée : +${recommendedBudgetIncrease}€/mois
- Conversions supplémentaires projetées : ~${projectedAdditionalConversions}

=== MISSION ===

Explique pourquoi scaler cette campagne est justifié
et comment le faire de manière sécurisée.

CONTRAINTES :
→ Mentionner les risques du scaling (saturation d'audience, CPA qui monte)
→ Recommander une approche graduelle (pas x2 d'un coup si possible)
→ Proposer des métriques de surveillance
→ Rester factuel — la campagne performe, expliquer pourquoi probablement

Produis UNIQUEMENT ce JSON :

{
  "opportunity_summary": "Pourquoi cette campagne mérite d'être scalée (2 phrases).",
  "probable_success_factors": ["facteur1", "facteur2"],
  "recommended_budget_increase": ${recommendedBudgetIncrease},
  "scaling_approach": "gradual_20pct_weekly",
  "projected_monthly_impact": {
    "additional_conversions": ${projectedAdditionalConversions},
    "additional_spend": ${recommendedBudgetIncrease},
    "projected_cpa": ${campaign.cost_per_conversion ?? 0}
  },
  "monitoring_kpis": [
    "KPI à surveiller lors du scaling",
    "Seuil d'alerte si le CPA dépasse X€"
  ],
  "scaling_risks": ["Risque 1 du scaling", "Risque 2"],
  "stop_signal": "Signal précis indiquant d'arrêter le scaling.",
  "confidence": 80,
  "reasoning": "Pourquoi ce niveau de confiance dans cette recommandation."
}

Valeurs pour "scaling_approach" :
"immediate_double" | "gradual_20pct_weekly" | "gradual_50pct_monthly" | "test_new_adset"
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 3 : TEMPORAL_INSIGHT
// Analyse les patterns temporels de performance.
// Quels jours / heures performer le mieux.
// ------------------------------------------------------------

export const TEMPORAL_INSIGHT = {

  system: buildSystemPrompt(),

  user: (params: {
    platform: string
    bestDays: string[]
    worstDays: string[]
    dayAnalysis: Array<{
      day: string
      avg_cpa: number
      efficiency_score: number
      spend_pct: number
    }>
    totalSpend30d: number
    potentialSavings: number
    // Économie estimée si on concentre sur les meilleurs jours
  }): string => {
    const { platform, bestDays, worstDays, dayAnalysis, totalSpend30d, potentialSavings } = params

    return `
=== ANALYSE TEMPORELLE DES CAMPAGNES ${platform.toUpperCase()} ===

Dépense totale analysée (30j) : ${totalSpend30d}€

Performance par jour de la semaine :
${dayAnalysis.map(d =>
  `- ${d.day} : CPA ${d.avg_cpa}€, efficacité ${Math.round(d.efficiency_score)}/100, ${d.spend_pct}% du budget`
).join('\n')}

Meilleurs jours identifiés : ${bestDays.join(', ')}
Jours les moins performants : ${worstDays.join(', ')}

Économie potentielle si concentration du budget
sur les meilleurs jours : ~${potentialSavings}€/mois

=== MISSION ===

Transforme cette analyse en recommandation actionnable
sur la planification budgétaire.

Produis UNIQUEMENT ce JSON :

{
  "insight_summary": "Ce que révèle l'analyse en 2 phrases.",
  "recommended_schedule": {
    "concentrate_on": ${JSON.stringify(bestDays)},
    "reduce_or_pause_on": ${JSON.stringify(worstDays)},
    "rationale": "Pourquoi cette planification (1 phrase)."
  },
  "estimated_cpa_improvement": "X% d'amélioration du CPA estimée",
  "estimated_monthly_savings": ${potentialSavings},
  "implementation_complexity": "low",
  "implementation_steps": [
    "Étape concrète 1",
    "Étape concrète 2"
  ],
  "caveat": "Limite ou condition à garder en tête pour cette recommandation.",
  "confidence": 75
}

Valeurs pour "implementation_complexity" :
"low" (< 30 min) | "medium" (30-90 min) | "high" (> 90 min ou nécessite un expert)
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 4 : WEEKLY_ADS_SUMMARY
// Résumé hebdomadaire de la performance pub globale.
// Appelé par A6 (Brief Agent).
// ------------------------------------------------------------

export const WEEKLY_ADS_SUMMARY = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    totalSpend: number
    totalConversions: number
    avgCpa: number
    wasteDetected: number
    bestPerformingPlatform: string | null
    worstPerformingPlatform: string | null
    weekOverWeekSpendChange: number
    weekOverWeekConversionChange: number
    activeCampaigns: number
    pausedThisWeek: number
  }): string => {
    const p = params

    return `
=== RÉSUMÉ PERFORMANCE PUBLICITÉ — SEMAINE ===

Dépense totale : ${p.totalSpend}€
Conversions totales : ${p.totalConversions}
CPA moyen : ${p.avgCpa}€
Campagnes actives : ${p.activeCampaigns}
Campagnes mises en pause cette semaine : ${p.pausedThisWeek}

Évolution semaine/semaine :
- Dépense : ${p.weekOverWeekSpendChange > 0 ? '+' : ''}${p.weekOverWeekSpendChange}%
- Conversions : ${p.weekOverWeekConversionChange > 0 ? '+' : ''}${p.weekOverWeekConversionChange}%

Plateforme la plus performante : ${p.bestPerformingPlatform ?? 'Données insuffisantes'}
Plateforme la moins performante : ${p.worstPerformingPlatform ?? 'Données insuffisantes'}
Gaspillage détecté et signalé : ${p.wasteDetected}€/mois

=== MISSION ===

Résumé exécutif en 2 phrases pour le brief hebdomadaire.
Commence par le fait le plus important (positif ou négatif).
Inclure une action recommandée.

Produis UNIQUEMENT ce JSON :

{
  "narrative": "2 phrases maximum.",
  "performance_status": "stable",
  "key_action": "L'action la plus importante cette semaine côté pub (1 phrase).",
  "waste_alert": ${p.wasteDetected > 500}
}

Valeurs pour "performance_status" :
"improving" | "stable" | "declining" | "critical"
`.trim()
  }
}
