import type { Metadata } from 'next'
import './globals.css'
import Nav from '@/components/Nav'

export const metadata: Metadata = {
  title: 'Secondary Data Entry',
  description: 'Secondary sales data entry + validation against ERPNext UAT',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app">
          <header className="header">
            <div className="brand">
              <div className="logo">📊</div>
              <div>
                <h1>Secondary Data Entry</h1>
                <p className="sub">Monthly sheets → ERPNext UAT · create / update / validate</p>
              </div>
            </div>
            <Nav />
          </header>
          {children}
        </div>
      </body>
    </html>
  )
}
