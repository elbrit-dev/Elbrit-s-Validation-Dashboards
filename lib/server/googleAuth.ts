import 'server-only'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DRIVE } from './env'

// Google service-account auth with NO extra npm packages: the JWT is signed
// with node:crypto and exchanged at Google's token endpoint. Ported from the
// doctor dashboard's server/googleDrive.js.

export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

interface ServiceAccount {
  client_email: string
  private_key: string
  token_uri?: string
}

function loadServiceAccount(): ServiceAccount | null {
  try {
    if (DRIVE.saJson) return JSON.parse(DRIVE.saJson)
    if (DRIVE.saFile) return JSON.parse(readFileSync(DRIVE.saFile, 'utf8'))
  } catch (e) {
    throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON / key file: ${e instanceof Error ? e.message : e}`)
  }
  return null
}

let sa: ServiceAccount | null | undefined
const serviceAccount = (): ServiceAccount | null => (sa !== undefined ? sa : (sa = loadServiceAccount()))

export type DriveMode = 'service-account' | 'api-key' | 'none'
export const driveMode = (): DriveMode =>
  serviceAccount() ? 'service-account' : DRIVE.apiKey ? 'api-key' : 'none'

export const driveConfigured = (): boolean => !!DRIVE.folderId && driveMode() !== 'none'

export function driveStatusDetail(): string | null {
  if (!DRIVE.folderId) return 'Set GOOGLE_DRIVE_FOLDER_ID to the shared folder id.'
  if (driveMode() === 'none') return 'Set GOOGLE_SERVICE_ACCOUNT_JSON (private folder) or GOOGLE_DRIVE_API_KEY (public folder).'
  return null
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

let cachedToken: { token: string; expiresAt: number } | null = null

// Mint (and cache) a Google OAuth access token from the service-account key.
export async function getServiceAccountToken(): Promise<{ token: string; expiresAt: number }> {
  const acct = serviceAccount()
  if (!acct) throw new Error('No service account configured.')
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claim = {
    iss: acct.client_email,
    scope: SCOPE,
    aud: acct.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(acct.private_key)
  const assertion = `${signingInput}.${b64url(signature)}`

  const res = await fetch(claim.aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!res.ok) throw new Error(`Google token exchange failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const json = await res.json()
  cachedToken = {
    token: json.access_token as string,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  }
  return cachedToken
}

// Auth bits for a server-side Drive REST request.
export async function authFor(): Promise<{ headers: Record<string, string>; keyParam: string }> {
  if (driveMode() === 'service-account') {
    const { token } = await getServiceAccountToken()
    return { headers: { Authorization: `Bearer ${token}` }, keyParam: '' }
  }
  return { headers: {}, keyParam: `&key=${encodeURIComponent(DRIVE.apiKey)}` }
}
