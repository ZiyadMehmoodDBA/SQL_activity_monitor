import React from 'react'
import { cn } from '../../lib/cn'

export function Badge({ children, className, style }) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold',
        className
      )}
      style={style}
    >
      {children}
    </span>
  )
}
