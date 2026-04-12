// ============================================================
// REVENUE OS — CHIFFREMENT AES-256-GCM
// Chiffrement et déchiffrement des tokens et clés API.
// Utilise Web Crypto API (natif dans Deno, zero dépendance).
// ============================================================

// La clé de chiffrement est stockée dans les secrets Supabase.
// Elle ne doit JAMAIS apparaître dans le code ou les logs.
// Longueur : 32 bytes (256 bits) encodés en hex (64 caractères).

const ALGORITHM = 'AES-GCM'
const IV_LENGTH = 12   // 96 bits — recommandé pour AES-GCM
const TAG_LENGTH = 128 // bits — longueur du tag d'authentification

// ------------------------------------------------------------
// IMPORT KEY
// Convertit la clé hex en CryptoKey utilisable par Web Crypto.
// ------------------------------------------------------------

async function importKey(hexKey: string): Promise<CryptoKey> {
  if (hexKey.length !== 64) {
    throw new Error(
      `Invalid encryption key length: expected 64 hex chars, got ${hexKey.length}`
    )
  }

  const keyBytes = hexToBytes(hexKey)

  return await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: ALGORITHM },
    false,       // non-extractable
    ['encrypt', 'decrypt']
  )
}

// ------------------------------------------------------------
// ENCRYPT
// Retourne une string base64 contenant IV + ciphertext + tag.
// Format : base64(iv[12] + ciphertext + tag[16])
// ------------------------------------------------------------

export async function encrypt(plaintext: string): Promise<string> {
  const hexKey = Deno.env.get('ENCRYPTION_KEY')
  if (!hexKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not set')
  }

  const key = await importKey(hexKey)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encoder = new TextEncoder()
  const data = encoder.encode(plaintext)

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    data
  )

  // Concaténer IV + ciphertext (qui inclut le tag GCM à la fin)
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), IV_LENGTH)

  return bytesToBase64(combined)
}

// ------------------------------------------------------------
// DECRYPT
// Prend le base64 produit par encrypt() et retourne le plaintext.
// ------------------------------------------------------------

export async function decrypt(encryptedBase64: string): Promise<string> {
  const hexKey = Deno.env.get('ENCRYPTION_KEY')
  if (!hexKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not set')
  }

  const key = await importKey(hexKey)
  const combined = base64ToBytes(encryptedBase64)

  if (combined.length < IV_LENGTH) {
    throw new Error('Invalid encrypted value: too short')
  }

  const iv = combined.slice(0, IV_LENGTH)
  const ciphertext = combined.slice(IV_LENGTH)

  let decrypted: ArrayBuffer

  try {
    decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
      key,
      ciphertext
    )
  } catch {
    throw new Error(
      'Decryption failed: invalid key or corrupted data'
    )
  }

  const decoder = new TextDecoder()
  return decoder.decode(decrypted)
}

// ------------------------------------------------------------
// ENCRYPT FOR STORAGE
// Wrapper haut niveau utilisé avant INSERT dans secrets.
// Vérifie que la valeur n'est pas vide.
// ------------------------------------------------------------

export async function encryptSecret(value: string): Promise<string> {
  if (!value || value.trim().length === 0) {
    throw new Error('Cannot encrypt empty value')
  }
  return await encrypt(value.trim())
}

// ------------------------------------------------------------
// DECRYPT FROM STORAGE
// Wrapper haut niveau utilisé après SELECT depuis secrets.
// ------------------------------------------------------------

export async function decryptSecret(encryptedValue: string): Promise<string> {
  if (!encryptedValue) {
    throw new Error('Cannot decrypt null or empty value')
  }
  return await decrypt(encryptedValue)
}

// ------------------------------------------------------------
// GENERATE ENCRYPTION KEY
// Utilitaire pour générer une nouvelle clé 256-bit.
// À appeler une seule fois au setup, jamais en runtime.
// Usage : await generateEncryptionKey() dans la console Deno
// ------------------------------------------------------------

export async function generateEncryptionKey(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: ALGORITHM, length: 256 },
    true,
    ['encrypt', 'decrypt']
  )

  const exported = await crypto.subtle.exportKey('raw', key)
  return bytesToHex(new Uint8Array(exported))
}

// ------------------------------------------------------------
// HASH (pour comparaisons sécurisées, ex: webhook signatures)
// ------------------------------------------------------------

export async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(data)
  )
  return bytesToHex(new Uint8Array(hashBuffer))
}

// ------------------------------------------------------------
// VERIFY HMAC-SHA256
// Pour vérifier les signatures de webhooks (HubSpot, Stripe, etc.)
// ------------------------------------------------------------

export async function verifyHmacSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    const encoder = new TextEncoder()

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )

    // Stripe envoie la signature en hex
    const signatureBytes = hexToBytes(signature)

    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      encoder.encode(payload)
    )
  } catch {
    return false
  }
}

// ------------------------------------------------------------
// HELPERS : Conversion bytes ↔ base64 ↔ hex
// ------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
