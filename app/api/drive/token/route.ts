import { NextResponse } from 'next/server'
import { driveMode, getServiceAccountToken } from '@/lib/server/googleAuth'

// Mints a short-lived READ-ONLY Drive access token so the browser can download
// sheet files directly from Google (files.get?alt=media is CORS-enabled). File
// bytes never pass through a serverless function — no 6MB cap, no base64.
// Only the minted token leaves the server; the service-account key never does.
export async function GET() {
  if (driveMode() !== 'service-account') {
    return NextResponse.json(
      { error: 'Direct download needs a service account', detail: 'Set GOOGLE_SERVICE_ACCOUNT_JSON. API-key mode uses the proxy route instead.' },
      { status: 503 },
    )
  }
  try {
    const { token, expiresAt } = await getServiceAccountToken()
    return NextResponse.json({ accessToken: token, expiresAt })
  } catch (err) {
    return NextResponse.json({ error: 'Token mint failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
