'use client'
// One virtualized table for every big list in the app — renders ~40 DOM rows
// no matter how many items scroll beneath (30k rows stay smooth). Replaces the
// doctor tool's "showing first 300" caps.
import { useRef, type ReactNode, type UIEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export interface VColumn<T> {
  key: string
  header: string
  width: number
  render?: (item: T, index: number) => ReactNode
}

export default function VirtualTable<T>({
  rows,
  columns,
  height = 480,
  rowHeight = 34,
  onRowClick,
  empty = 'No rows',
}: {
  rows: T[]
  columns: VColumn<T>[]
  height?: number
  rowHeight?: number
  onRowClick?: (item: T, index: number) => void
  empty?: string
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })
  const totalWidth = columns.reduce((s, c) => s + c.width, 0)

  // Keep the header aligned with the body as it scrolls sideways — the two are
  // separate scroll boxes, so the header would otherwise stay put while the
  // rows slide under it.
  const onBodyScroll = (e: UIEvent<HTMLDivElement>) => {
    if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft
  }

  return (
    <div className="vtable">
      <div ref={headRef} className="vtable-head">
        <div className="vtable-head-inner" style={{ minWidth: totalWidth }}>
          {columns.map((c) => (
            <div key={c.key} className="vcell" style={{ width: c.width }}>
              {c.header}
            </div>
          ))}
        </div>
      </div>
      <div ref={parentRef} className="vtable-body" style={{ height }} onScroll={onBodyScroll}>
        {rows.length === 0 ? (
          <div className="muted" style={{ padding: 18 }}>{empty}</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: totalWidth }}>
            {virtualizer.getVirtualItems().map((v) => {
              const item = rows[v.index]
              return (
                <div
                  key={v.key}
                  className="vtable-row"
                  style={{ transform: `translateY(${v.start}px)`, height: v.size }}
                  onClick={onRowClick ? () => onRowClick(item, v.index) : undefined}
                >
                  {columns.map((c) => (
                    <div key={c.key} className="vcell" style={{ width: c.width }}>
                      {c.render ? c.render(item, v.index) : String((item as Record<string, unknown>)[c.key] ?? '')}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
