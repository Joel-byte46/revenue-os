// ============================================================
// REVENUE OS — NANGO CLIENT
// Récupère les tokens OAuth depuis Nango self-hosted.
// Les agents n'appellent jamais les providers directement
// sans passer par ce module.
// ============================================================

import type { Provider } from './types.ts'

const NANGO_SERVER_URL = Deno.env.get('NANGO_SERVER_URL') ?? ''
const NANGO_SECRET_KEY = Deno.env.get('NANGO_SECRET_KEY') ?? ''

if (!NANGO_SERVER_URL) {
  console.warn('[nango] NANGO_SERVER_URL not set')
}

if (!NANGO_SECRET_KEY) {
  console.warn('[nango] NANGO_SECRET_KEY not set')
}

// ------------------------------------------------------------
// TYPES
// ------------------------------------------------------------

interface NangoConnection {
  id: string
  provider_config_key: string
  connection_id: string
  credentials: {
    type: 'OAUTH2' | 'API_KEY' | 'OAUTH1'
    access_token?: string
    api_key?: string
    expires_at?: string
    refresh_token?: string
  }
  metadata: Record<string, unknown>
}

interface NangoTokenResult {
  accessToken: string
  expiresAt: string | null
  metadata: Record<string, unknown>
}

// ------------------------------------------------------------
// GET ACCESS TOKEN
// Principal point d'entrée utilisé par les agents.
// Nango gère le refresh automatiquement.
// ------------------------------------------------------------

export async function getAccessToken(
  tenantId: string,
  provider: Provider
): Promise<string> {
  const connection = await getConnection(tenantId, provider)

  if (connection.credentials.type === 'API_KEY') {
    if (!connection.credentials.api_key) {
      throw new Error(
        `[nango] API key missing for provider ${provider}, tenant ${tenantId}`
      )
    }
    return connection.credentials.api_key
  }

  if (!connection.credentials.access_token) {
    throw new Error(
      `[nango] Access token missing for provider ${provider}, tenant ${tenantId}`
    )
  }

  // Vérifier si le token expire bientôt (< 5 minutes)
  if (connection.credentials.expires_at) {
    const expiresAt = new Date(connection.credentials.expires_at)
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000)

    if (expiresAt < fiveMinutesFromNow) {
      // Forcer le refresh
      await refreshConnection(tenantId, provider)
      const refreshed = await getConnection(tenantId, provider)
      return refreshed.credentials.access_token!
    }
  }

  return connection.credentials.access_token
}

// ------------------------------------------------------------
// GET FULL CONNECTION
// Retourne la connexion complète avec credentials et metadata.
// Utile quand on a besoin de metadata (ex: HubSpot portal_id).
// ------------------------------------------------------------

export async function getConnection(
  tenantId: string,
  provider: Provider
): Promise<NangoConnection> {
  const connectionId = buildConnectionId(tenantId, provider)
  const providerConfigKey = providerToNangoKey(provider)

  const url = `${NANGO_SERVER_URL}/connection/${connectionId}?provider_config_key=${providerConfigKey}`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${NANGO_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }
  })

  if (response.status === 404) {
    throw new Error(
      `[nango] No connection found for provider ${provider}, tenant ${tenantId}. ` +
      `Ask the user to connect their ${provider} account.`
    )
  }

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `[nango] Failed to get connection for ${provider}: ${response.status} ${errorText}`
    )
  }

  return await response.json() as NangoConnection
}

// ------------------------------------------------------------
// CHECK IF CONNECTED
// Vérifie si un provider est connecté pour un tenant.
// Utilisé par l'orchestrateur pour décider quels agents lancer.
// ------------------------------------------------------------

export async function isConnected(
  tenantId: string,
  provider: Provider
): Promise<boolean> {
  try {
    await getConnection(tenantId, provider)
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('No connection found')) {
      return false
    }
    // Autre erreur (réseau, etc.) → considérer comme déconnecté
    console.error(`[nango] Error checking connection for ${provider}:`, error)
    return false
  }
}

// ------------------------------------------------------------
// REFRESH CONNECTION
// Force le refresh du token OAuth.
// Appelé automatiquement si le token expire bientôt.
// ------------------------------------------------------------

async function refreshConnection(
  tenantId: string,
  provider: Provider
): Promise<void> {
  const connectionId = buildConnectionId(tenantId, provider)
  const providerConfigKey = providerToNangoKey(provider)

  const url = `${NANGO_SERVER_URL}/connection/${connectionId}/refresh`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NANGO_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ provider_config_key: providerConfigKey })
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error(
      `[nango] Failed to refresh token for ${provider}, tenant ${tenantId}: ${errorText}`
    )
    // Ne pas throw — continuer avec le token actuel
  }
}

// ------------------------------------------------------------
// DELETE CONNECTION
// Appelé quand l'utilisateur déconnecte une intégration.
// ------------------------------------------------------------

export async function deleteConnection(
  tenantId: string,
  provider: Provider
): Promise<void> {
  const connectionId = buildConnectionId(tenantId, provider)
  const providerConfigKey = providerToNangoKey(provider)

  const url = `${NANGO_SERVER_URL}/connection/${connectionId}?provider_config_key=${providerConfigKey}`

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${NANGO_SECRET_KEY}`
    }
  })

  if (!response.ok && response.status !== 404) {
    const errorText = await response.text()
    throw new Error(
      `[nango] Failed to delete connection for ${provider}: ${errorText}`
    )
  }
}

// ------------------------------------------------------------
// GET OAUTH CONNECT URL
// Génère l'URL pour initier le flow OAuth côté frontend.
// Le frontend redirige l'utilisateur vers cette URL.
// ------------------------------------------------------------

export function getConnectUrl(
  tenantId: string,
  provider: Provider,
  redirectUri: string
): string {
  const connectionId = buildConnectionId(tenantId, provider)
  const providerConfigKey = providerToNangoKey(provider)

  const params = new URLSearchParams({
    provider_config_key: providerConfigKey,
    connection_id: connectionId,
    redirect_uri: redirectUri
  })

  return `${NANGO_SERVER_URL}/oauth/connect?${params.toString()}`
}

// ------------------------------------------------------------
// LIST CONNECTIONS
// Liste toutes les connexions actives pour un tenant.
// Utilisé par l'orchestrateur.
// ------------------------------------------------------------

export async function listConnections(
  tenantId: string
): Promise<Provider[]> {
  const url = `${NANGO_SERVER_URL}/connection`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${NANGO_SECRET_KEY}`
    }
  })

  if (!response.ok) {
    console.error(`[nango] Failed to list connections for tenant ${tenantId}`)
    return []
  }

  const data = await response.json() as { connections: NangoConnection[] }

  return data.connections
    .filter(conn => conn.connection_id.startsWith(`${tenantId}_`))
    .map(conn => nangoKeyToProvider(conn.provider_config_key))
    .filter((p): p is Provider => p !== null)
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

// Convention : connection_id = tenantId_provider
// Permet de lister toutes les connexions d'un tenant.
function buildConnectionId(tenantId: string, provider: Provider): string {
  return `${tenantId}_${provider}`
}

// Mapping entre nos provider names et les clés Nango
function providerToNangoKey(provider: Provider): string {
  const mapping: Record<Provider, string> = {
    hubspot: 'hubspot',
    salesforce: 'salesforce',
    pipedrive: 'pipedrive',
    close: 'close',
    attio: 'attio',
    stripe: 'stripe',
    plaid: 'plaid',
    tink: 'tink',
    meta_ads: 'facebook-ads',
    google_ads: 'google-ads',
    linkedin_ads: 'linkedin-ads',
    tiktok_ads: 'tiktok-ads',
    quickbooks: 'quickbooks',
    xero: 'xero',
    pennylane: 'pennylane',
    slack: 'slack',
    gmail: 'google-mail',
    calendly: 'calendly',
    google_calendar: 'google-calendar',
    shopify: 'shopify',
    paypal: 'paypal',
    openai: 'openai',
    anthropic: 'anthropic'
  }
  return mapping[provider] ?? provider
}

function nangoKeyToProvider(nangoKey: string): Provider | null {
  const reverseMapping: Record<string, Provider> = {
    'hubspot': 'hubspot',
    'salesforce': 'salesforce',
    'pipedrive': 'pipedrive',
    'close': 'close',
    'attio': 'attio',
    'stripe': 'stripe',
    'plaid': 'plaid',
    'tink': 'tink',
    'facebook-ads': 'meta_ads',
    'google-ads': 'google_ads',
    'linkedin-ads': 'linkedin_ads',
    'tiktok-ads': 'tiktok_ads',
    'quickbooks': 'quickbooks',
    'xero': 'xero',
    'pennylane': 'pennylane',
    'slack': 'slack',
    'google-mail': 'gmail',
    'calendly': 'calendly',
    'google-calendar': 'google_calendar',
    'shopify': 'shopify',
    'paypal': 'paypal'
  }
  return reverseMapping[nangoKey] ?? null
}
