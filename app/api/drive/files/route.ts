import { NextResponse } from 'next/server'
import { listFolderFiles } from '@/lib/server/drive'
import { driveConfigured, driveStatusDetail } from '@/lib/server/googleAuth'

export async function GET() {
  if (!driveConfigured()) {
    return NextResponse.json({ error: 'Google Drive not configured', detail: driveStatusDetail() }, { status: 503 })
  }
  try {
    const files = await listFolderFiles()
    return NextResponse.json({ files })
  } catch (err) {
    return NextResponse.json({ error: 'Drive list failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
