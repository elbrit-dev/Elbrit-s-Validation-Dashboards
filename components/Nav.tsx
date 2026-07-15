'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function Nav() {
  const path = usePathname()
  return (
    <nav className="nav">
      <Link href="/entry" className={path?.startsWith('/entry') ? 'active' : ''}>Entry</Link>
      <Link href="/validation" className={path?.startsWith('/validation') ? 'active' : ''}>Validation</Link>
      <Link href="/ebs-validation" className={path?.startsWith('/ebs-validation') ? 'active' : ''}>EBS Validation</Link>
    </nav>
  )
}
