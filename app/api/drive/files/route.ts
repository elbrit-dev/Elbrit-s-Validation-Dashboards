import { NextResponse } from 'next/server'
import { listFolderFiles } from '@/lib/server/drive'
import { driveConfigured, driveStatusDetail } from '@/lib/server/googleAuth'

export async function GET(req: Request) {
  if (!driveConfigured()) {
    return NextResponse.json({ error: 'Google Drive not configured', detail: driveStatusDetail() }, { status: 503 })
  }
  try {
    // ?folderId=<id> lists that sub-folder; absent → the configured root folder.
    const folderId = new URL(req.url).searchParams.get('folderId') || undefined
    const files = await listFolderFiles(folderId)
    return NextResponse.json({ files })
  } catch (err) {
    return NextResponse.json({ error: 'Drive list failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
