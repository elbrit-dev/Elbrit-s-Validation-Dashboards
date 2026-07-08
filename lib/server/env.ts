import 'server-only'

const strip = (s: string) => s.replace(/\/+$/, '')

export const ERP = {
  base: strip(process.env.ERPNEXT_URL || ''),
  key: process.env.ERPNEXT_API_KEY || '',
  secret: process.env.ERPNEXT_API_SECRET || '',
}

export const erpConfigured = (): boolean => !!(ERP.base && ERP.key && ERP.secret)

export const DRIVE = {
  folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  saJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  saFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || '',
  apiKey: process.env.GOOGLE_DRIVE_API_KEY || process.env.GOOGLE_API_KEY || process.env.VITE_GOOGLE_API_KEY || '',
}
