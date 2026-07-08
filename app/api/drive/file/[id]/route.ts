import { downloadFile } from '@/lib/server/drive'
import { NextResponse } from 'next/server'

// Proxy fallback download (native Google Sheets export, API-key mode, or when
// the direct browser download fails). Returns raw binary — NOT base64 — so a
// file up to the platform body cap still fits. Large .xlsx files should use
// the direct-download path instead.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const { buffer, filename, contentType } = await downloadFile(id)
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'X-Filename': encodeURIComponent(filename),
      },
    })
  } catch (err) {
    return NextResponse.json({ error: 'Drive download failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
