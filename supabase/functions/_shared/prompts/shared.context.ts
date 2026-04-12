// ============================================================
// REVENUE OS — CONTEXTE PRODUIT PARTAGÉ
// Injecté dans les prompts qui ont besoin de contextualiser
// la recommandation dans le cadre du produit.
//
// Ex : un email de relance qui mentionne le produit du founder
// doit savoir ce que c'est, et comment le positionner.
// ============================================================

// ------------------------------------------------------------
// CONTEXTE PRODUIT — Revenue OS
// Ce que le système est et ce qu'il promet.
// Injecté dans les prompts qui génèrent des communications
// au nom du founder (séquences leads).
// ------------------------------------------------------------

export const PRODUCT_CONTEXT = `
=== CONTEXTE PRODUIT ===

LE PRODUIT : Revenue OS
Un système d'agents IA déployé en 14 jours chez des fondateurs SaaS et DTC.

CE QUE ÇA FAIT (en deux lignes) :
1. Identifie automatiquement les opportunités de revenus manquées
   (deals bloqués, leads dormants, pubs qui gaspillent)
2. Surveille la trésorerie en temps réel
   (runway, burn, abonnements zombies, anomalies)

LA PROMESSE :
→ Déployé en 14 jours
→ Premiers résultats identifiés dans les 14 jours
→ Garantie remboursement si aucun résultat mesurable

LE CLIENT TYPE :
→ Fondateur SaaS ou DTC (B2B ou B2C)
→ 5 à 100 employés
→ Entre 10K€ et 2M€ de revenus annuels
→ Utilise HubSpot, Salesforce, Pipedrive, Stripe, etc.
→ N'a pas de RevOps ni de CFO en interne
→ Prend des décisions financières et commerciales seul ou avec son co-fondateur

CE QUI LE DIFFÉRENCIE :
→ BYOK (le client garde le contrôle de ses données et de ses coûts IA)
→ Approval humain obligatoire (jamais d'action sans validation du founder)
→ Calculs financiers déterministes (pas de "l'IA pense que votre runway est...")
→ Intégrations natives (HubSpot, Stripe, Plaid, Meta Ads, Google Ads...)

CE QUI N'EST PAS LE PRODUIT :
→ Un chatbot
→ Un dashboard de plus
→ Un consultant humain
→ Un outil "no-code" que le fondateur configure lui-même

=== FIN CONTEXTE PRODUIT ===
`.trim()

// ------------------------------------------------------------
// CONTEXTE FOUNDER — Profil psychologique du client
// Aide le LLM à calibrer le ton et les attentes.
// ------------------------------------------------------------

export const FOUNDER_CONTEXT = `
=== CONTEXTE FOUNDER ===

QUI LIT CES RECOMMANDATIONS :
Un fondateur ou co-fondateur. Pas un manager. Pas un analyste.
Quelqu'un qui prend des décisions seul, souvent sous pression.

CE QUE LE FOUNDER VEUT :
→ De la clarté. Pas de nuances inutiles.
→ Des chiffres exacts. Pas des fourchettes vagues.
→ Une action claire. Pas un menu de 10 options.
→ Savoir pourquoi. Pas juste quoi faire.
→ Être respecté. Pas être traité comme un débutant.

CE QUE LE FOUNDER NE VEUT PAS :
→ Lire 500 mots pour trouver l'information qui compte.
→ Une liste de 8 "recommandations" qu'il ne peut pas toutes exécuter.
→ Des probabilités vagues ("peut-être", "potentiellement", "dans certains cas").
→ Des conseils qui supposent qu'il a une équipe de 50 personnes.
→ Être rassuré sans raison. Il préfère savoir si la situation est mauvaise.

NIVEAU D'EXPERTISE ASSUMÉ :
→ Le founder comprend les concepts de base : MRR, churn, CAC, LTV, runway.
→ Il n'a pas besoin de définitions.
→ Il a besoin d'être challengé intelligemment, pas éduqué.

FORMAT IDÉAL D'UNE RECOMMANDATION :
→ Titre : 6-10 mots, précis
→ Résumé : 1-2 phrases, le fait le plus important
→ Détail : les données qui justifient
→ Action : exactement ce qu'il faut faire
→ Impact : pourquoi ça vaut la peine

=== FIN CONTEXTE FOUNDER ===
`.trim()

// ------------------------------------------------------------
// CONTEXTE VERTICAL — SaaS vs Ecom
// Injecté selon le vertical du tenant.
// ------------------------------------------------------------

export const VERTICAL_CONTEXT = {

  saas: `
=== CONTEXTE VERTICAL : SaaS B2B ===

MÉTRIQUES QUI COMPTENT :
→ MRR (Monthly Recurring Revenue) — santé des revenus
→ ARR (Annual Recurring Revenue) — vision long terme
→ Churn rate — rétention clients
→ CAC (Customer Acquisition Cost) — efficacité acquisition
→ LTV (Lifetime Value) — valeur client long terme
→ Pipeline velocity — vitesse de conversion
→ NRR (Net Revenue Retention) — expansion vs churn

CYCLE DE VENTE TYPIQUE :
→ 1 semaine à 6 mois selon le deal size
→ Décision souvent multi-stakeholders (CEO + CFO + Ops)
→ Les deals > 10K€/an nécessitent souvent un champion interne

ANOMALIES FRÉQUENTES EN SAAS :
→ Deals bloqués post-démo (decision fatigue)
→ Renouvellements à risque non détectés
→ Budget ads gaspillé sur des mots-clés génériques
→ MRR growth masqué par du churn élevé

=== FIN CONTEXTE SAAS ===
`.trim(),

  ecom: `
=== CONTEXTE VERTICAL : E-commerce / DTC ===

MÉTRIQUES QUI COMPTENT :
→ AOV (Average Order Value) — valeur panier moyen
→ Repeat purchase rate — fidélisation clients
→ LTV:CAC ratio — rentabilité acquisition
→ ROAS (Return on Ad Spend) — efficacité pub
→ Inventory turnover — gestion stock
→ Contribution margin — marge après variable costs

PARTICULARITÉS ECOM :
→ Revenus saisonniers (Black Friday, fêtes, été)
→ Coûts variables très liés au volume (shipping, packaging)
→ CAC souvent dominé par Meta Ads et Google Shopping
→ Stock = cash immobilisé (impact trésorerie direct)

ANOMALIES FRÉQUENTES EN ECOM :
→ ROAS qui chute sans détection rapide
→ Clients one-shot qui ne reviennent jamais
→ AOV faible (pas d'upsell / cross-sell)
→ Budget ads concentré sur une seule plateforme

=== FIN CONTEXTE ECOM ===
`.trim()
}

// ------------------------------------------------------------
// BUILDER — Assemble les contextes selon la situation
// ------------------------------------------------------------

export function buildProductContext(
  vertical: 'saas' | 'ecom' = 'saas',
  includeFounderContext: boolean = true
): string {
  const parts: string[] = [PRODUCT_CONTEXT]

  if (includeFounderContext) {
    parts.push(FOUNDER_CONTEXT)
  }

  parts.push(VERTICAL_CONTEXT[vertical])

  return parts.join('\n\n')
}
