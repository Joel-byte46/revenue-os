// ============================================================
// REVENUE OS — PROMPTS AGENT TREASURY
// Tous les prompts utilisés par agent-treasury.
//
// RÈGLE ABSOLUE :
// Python calcule. Le LLM narre.
// TOUS les chiffres dans ces prompts viennent du service Python.
// Le LLM ne produit JAMAIS de chiffres financiers.
// Il transforme des chiffres déjà calculés en langage naturel.
// ============================================================

import {
  buildFinancialSystemPrompt,
  buildSystemPrompt
} from './system.rules.ts'
import type { RunwayResponse, Anomaly, ZombieSubscription, RAGContext } from '../types.ts'

// ------------------------------------------------------------
// PROMPT 1 : RUNWAY_ALERT_NARRATIVE
// Transforme les calculs Python en narrative actionnable.
// Appelé uniquement quand runway < seuil d'alerte.
// ------------------------------------------------------------

export const RUNWAY_ALERT_NARRATIVE = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    runway: RunwayResponse
    alertLevel: 'critical' | 'high' | 'medium'
    previousRunway: number | null
    runwayChange: number | null
    topExpenseCategories: Array<{
      category: string
      amount: number
      percentage: number
    }>
    mrrGrowthRate: number | null
    ragContext: RAGContext
  }): string => {
    const { runway: r, alertLevel, previousRunway, runwayChange, topExpenseCategories, mrrGrowthRate, ragContext } = params

    const alertFraming = {
      critical: `SITUATION CRITIQUE : ${r.runway_months.toFixed(1)} mois de runway. Action immédiate requise.`,
      high: `VIGILANCE : ${r.runway_months.toFixed(1)} mois de runway. Plan d'action nécessaire sous 2 semaines.`,
      medium: `ATTENTION : ${r.runway_months.toFixed(1)} mois de runway. Surveiller et optimiser.`
    }

    return `
${ragContext.formattedContext}

=== DONNÉES DE TRÉSORERIE (calculées par Python, exactes) ===

SITUATION ACTUELLE :
${alertFraming[alertLevel]}

Cash disponible : ${r.current_balance}€
Burn mensuel brut : ${r.monthly_burn_gross}€
MRR : ${r.mrr}€
ARR : ${r.arr}€
Burn mensuel net (burn - MRR) : ${r.monthly_net_burn}€
Rentabilité : ${r.is_profitable ? 'OUI — net burn positif' : 'NON — dépenses > revenus'}

Runway :
- Scénario pessimiste : ${r.scenarios.pessimistic.toFixed(1)} mois
- Scénario réaliste : ${r.scenarios.realistic.toFixed(1)} mois
- Scénario optimiste : ${r.scenarios.optimistic.toFixed(1)} mois
- Date estimée de fin de cash : ${r.runway_date}

${previousRunway !== null && runwayChange !== null
  ? `Évolution : ${runwayChange > 0 ? '+' : ''}${runwayChange.toFixed(1)} mois vs mois dernier (était ${previousRunway.toFixed(1)} mois)`
  : 'Évolution : Premier snapshot disponible'}

Confiance des données : ${r.data_confidence}
${r.data_confidence !== 'full'
  ? '⚠️ Données partielles — certaines sources ne sont pas connectées. Runway peut être sous-estimé.'
  : ''}

Top dépenses par catégorie :
${topExpenseCategories.map(c =>
  `- ${c.category} : ${c.amount}€/mois (${c.percentage}% du burn)`
).join('\n')}

Croissance MRR (3 derniers mois) :
${mrrGrowthRate !== null
  ? `${mrrGrowthRate > 0 ? '+' : ''}${mrrGrowthRate.toFixed(1)}%/mois`
  : 'Données insuffisantes pour calculer'}

=== MISSION ===

Transforme ces données en alerte trésorerie actionnable pour le fondateur.

CONTRAINTES :
→ Maximum 120 mots total
→ Commencer par le fait le plus urgent
→ Ne pas répéter les chiffres déjà évidents — sélectionner les plus importants
→ Proposer EXACTEMENT 3 actions, triées par impact décroissant
→ Chaque action doit avoir un impact estimé en mois de runway OU en euros
→ Ne pas proposer d'actions impossibles à exécuter seul en 7 jours

Produis UNIQUEMENT ce JSON :

{
  "narrative": "2-3 phrases. Situation + urgence + levier principal.",
  "alert_level": "${alertLevel}",
  "key_number": ${r.runway_months},
  "key_number_label": "mois de runway",
  "actions": [
    {
      "description": "Action 1 (la plus impactante)",
      "impact_months": 0.5,
      "impact_amount": null,
      "effort": "low",
      "deadline": "Cette semaine"
    },
    {
      "description": "Action 2",
      "impact_months": null,
      "impact_amount": 2000,
      "effort": "medium",
      "deadline": "Ce mois"
    },
    {
      "description": "Action 3",
      "impact_months": 1.0,
      "impact_amount": null,
      "effort": "high",
      "deadline": "Ce trimestre"
    }
  ],
  "data_confidence_note": ${r.data_confidence !== 'full'
    ? '"Certaines sources financières ne sont pas connectées. Runway peut être sous-estimé."'
    : 'null'},
  "positive_signal": "Un signal positif dans les données (si disponible, sinon null).",
  "reasoning": "En 1 phrase : pourquoi ces 3 actions spécifiquement."
}

Valeurs pour "effort" : "low" (< 1h) | "medium" (< 1 jour) | "high" (> 1 jour)
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 2 : ZOMBIE_SUBSCRIPTION_EXPLAIN
// Explique pourquoi un abonnement est probablement zombifié
// et confirme ou nuance la recommandation.
// ------------------------------------------------------------

export const ZOMBIE_SUBSCRIPTION_EXPLAIN = {

  system: buildSystemPrompt(),

  user: (params: {
    zombie: ZombieSubscription
    inactivityDays: number
    accountingCategory: string | null
    similarToolsSuggestions: string[]
    annualWaste: number
  }): string => {
    const { zombie, inactivityDays, accountingCategory, similarToolsSuggestions, annualWaste } = params

    return `
=== ABONNEMENT POTENTIELLEMENT ZOMBIE ===

Nom : ${zombie.merchant}
Coût mensuel : ${zombie.monthly_cost}€/mois
Coût annuel : ${zombie.annual_cost}€/an
Catégorie comptable : ${accountingCategory ?? zombie.category ?? 'Non catégorisé'}
Ancienneté abonnement : ${zombie.months_subscribed} mois

Signal d'inactivité :
- Aucune activité détectée depuis : ${inactivityDays} jours
- Dernière activité connue : ${zombie.last_activity ?? 'Inconnue'}
- Méthode de détection : absence de mention email + absence de mention CRM

Confiance du système : ${zombie.confidence}
${zombie.confidence === 'high'
  ? '→ Très probablement inutilisé (double signal email + CRM)'
  : zombie.confidence === 'medium'
  ? '→ Probablement inutilisé (signal partiel)'
  : '→ Incertain — vérification manuelle recommandée'}

Alternatives connues dans la même catégorie :
${similarToolsSuggestions.length > 0
  ? similarToolsSuggestions.map(s => `- ${s}`).join('\n')
  : '- Aucune alternative identifiée automatiquement'}

=== MISSION ===

Explique ce diagnostic et confirme ou nuance la recommandation.

CONTRAINTES :
→ Si confiance = low : nuancer, recommander de vérifier manuellement
→ Si confiance = high : être direct, confirmer l'annulation
→ Mentionner le cas où cet outil pourrait être utilisé par
  quelqu'un de l'équipe qu'on ne détecte pas
→ Maximum 80 mots pour l'explication

Produis UNIQUEMENT ce JSON :

{
  "explanation": "Pourquoi cet abonnement semble zombie (2 phrases max).",
  "confidence_justified": true,
  "recommendation": "${zombie.recommendation}",
  "recommendation_rationale": "Pourquoi cette recommandation spécifiquement (1 phrase).",
  "before_cancelling": "Ce qu'il faut vérifier avant d'annuler (1 phrase, toujours présent).",
  "potential_alternative": ${similarToolsSuggestions.length > 0
    ? `"${similarToolsSuggestions[0]}"`
    : 'null'},
  "annual_savings": ${annualWaste},
  "caveat": "Cas où cette recommandation serait incorrecte (1 phrase)."
}
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 3 : ANOMALY_EXPLAIN
// Explique une anomalie de dépenses détectée par Z-score.
// ------------------------------------------------------------

export const ANOMALY_EXPLAIN = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    anomaly: Anomaly
    currentMonth: string
    topMerchants: Array<{ merchant: string; amount: number }>
    historicalContext: string
    // Ex: "moyenne des 5 derniers mois : 3 200€"
  }): string => {
    const { anomaly, currentMonth, topMerchants, historicalContext } = params

    const severityFraming = {
      critical: `ANOMALIE CRITIQUE (Z-score: ${anomaly.z_score.toFixed(1)}) — dépense ${Math.round(anomaly.z_score)}x au-dessus de la normale`,
      high: `ANOMALIE HAUTE (Z-score: ${anomaly.z_score.toFixed(1)}) — dépense significativement au-dessus de la normale`,
      medium: `ANOMALIE MODÉRÉE (Z-score: ${anomaly.z_score.toFixed(1)}) — dépense au-dessus de la normale`
    }

    return `
=== ANOMALIE DE DÉPENSES DÉTECTÉE ===

Catégorie : ${anomaly.category}
Mois en cours : ${currentMonth}
${severityFraming[anomaly.severity]}

Chiffres (calculés par Python) :
- Dépense actuelle : ${anomaly.current_amount}€
- Moyenne historique : ${anomaly.historical_avg}€
- Écart-type historique : ${anomaly.historical_std}€
- Excès de dépense : ${anomaly.excess_amount}€ (${Math.round((anomaly.excess_amount / anomaly.historical_avg) * 100)}% au-dessus de la normale)
- Z-score : ${anomaly.z_score.toFixed(2)}

Type d'anomalie : ${anomaly.type === 'spike' ? 'Pic ponctuel' : 'Coût rampant (augmentation progressive)'}
${anomaly.type === 'creeping_cost' && anomaly.monthly_growth
  ? `Croissance mensuelle : +${anomaly.monthly_growth}€/mois → Impact annuel projeté : +${anomaly.projected_annual_impact}€`
  : ''}

Contexte historique : ${historicalContext}

Principaux merchants dans cette catégorie ce mois :
${topMerchants.slice(0, 5).map(m => `- ${m.merchant} : ${m.amount}€`).join('\n')}

=== MISSION ===

Explique cette anomalie et propose les étapes d'investigation.

CONTRAINTES :
→ Ne pas conclure sur la cause — tu ne sais pas pourquoi c'est anormal
→ Proposer des hypothèses probables (pas des certitudes)
→ Les étapes d'investigation doivent être concrètes et exécutables
→ Si type = creeping_cost : insister sur l'urgence de stopper la tendance

Produis UNIQUEMENT ce JSON :

{
  "anomaly_summary": "Ce qui est anormal en 1 phrase, avec les chiffres clés.",
  "probable_causes": [
    "Hypothèse 1 : la plus probable",
    "Hypothèse 2",
    "Hypothèse 3 (si pertinente)"
  ],
  "investigation_steps": [
    "Étape d'investigation concrète 1",
    "Étape 2",
    "Étape 3"
  ],
  "urgency": "${anomaly.severity}",
  "monthly_impact": ${anomaly.excess_amount},
  "annual_impact_if_recurring": ${Math.round(anomaly.excess_amount * 12)},
  "type_specific_note": "${anomaly.type === 'creeping_cost'
    ? 'Cette anomalie est une dérive progressive. Plus on tarde à agir, plus l\'impact s\'accumule.'
    : 'Cette anomalie est un pic ponctuel. Peut être légitime (achat exceptionnel) ou accidentel.'}"
}
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 4 : CASH_FLOW_SUMMARY
// Résumé trésorerie pour le brief hebdomadaire.
// Appelé par A6.
// ------------------------------------------------------------

export const CASH_FLOW_SUMMARY = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    currentSnapshot: {
      runway_months: number
      monthly_net_burn: number
      mrr: number
      current_balance: number
    }
    previousSnapshot: {
      runway_months: number
      monthly_net_burn: number
      mrr: number
    } | null
    weeklyRevenueIn: number
    weeklyExpensesOut: number
    alertsThisWeek: number
    zombiesDetected: number
    zombiesMonthlyCost: number
  }): string => {
    const { currentSnapshot: curr, previousSnapshot: prev,
      weeklyRevenueIn, weeklyExpensesOut, alertsThisWeek,
      zombiesDetected, zombiesMonthlyCost } = params

    const runwayChange = prev
      ? curr.runway_months - prev.runway_months
      : null

    const mrrChange = prev
      ? curr.mrr - prev.mrr
      : null

    return `
=== RÉSUMÉ TRÉSORERIE HEBDOMADAIRE ===

Situation actuelle :
- Runway : ${curr.runway_months.toFixed(1)} mois${runwayChange !== null
    ? ` (${runwayChange > 0 ? '+' : ''}${runwayChange.toFixed(1)} vs semaine dernière)`
    : ''}
- Cash : ${curr.current_balance}€
- Burn net : ${curr.monthly_net_burn}€/mois
- MRR : ${curr.mrr}€${mrrChange !== null
    ? ` (${mrrChange > 0 ? '+' : ''}${mrrChange}€ vs semaine dernière)`
    : ''}

Cette semaine :
- Revenus encaissés : ${weeklyRevenueIn}€
- Dépenses sorties : ${weeklyExpensesOut}€
- Alertes générées : ${alertsThisWeek}
- Abonnements zombies détectés : ${zombiesDetected} (${zombiesMonthlyCost}€/mois)

=== MISSION ===

Résumé trésorerie en 2 phrases pour le brief hebdomadaire.
Si la situation est saine : le dire sobrement.
Si elle se dégrade : le dire directement.

Produis UNIQUEMENT ce JSON :

{
  "narrative": "2 phrases maximum.",
  "treasury_health": "healthy",
  "trend": "stable",
  "key_alert": "L'alerte la plus importante (1 phrase) ou null si aucune.",
  "positive_signal": "Un signal positif si disponible ou null."
}

Valeurs pour "treasury_health" :
"healthy" (> 12 mois) | "comfortable" (6-12 mois) |
"watch" (3-6 mois) | "critical" (< 3 mois)

Valeurs pour "trend" :
"improving" | "stable" | "declining" | "unknown"
`.trim()
  }
}
