import { NextResponse } from 'next/server'
import { erpConfigured, ERP } from '@/lib/server/env'
import { driveConfigured, driveMode } from '@/lib/server/googleAuth'
import { DOCTYPE } from '@/lib/shared/mapping'

export async function GET() {
  return NextResponse.json({
    ok: true,
    erp: { configured: erpConfigured(), base: erpConfigured() ? ERP.base : null, doctype: DOCTYPE },
    drive: { configured: driveConfigured(), mode: driveMode() },
  })
}
