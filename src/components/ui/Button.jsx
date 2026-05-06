import React from 'react'
import { cn } from '../../lib/cn'

const variants = {
  default:     'bg-slate-900 text-white hover:bg-slate-800',
  outline:     'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
  ghost:       'bg-transparent text-slate-600 hover:bg-slate-100',
  destructive: 'bg-red-600 text-white hover:bg-red-700',
  secondary:   'bg-slate-100 text-slate-700 hover:bg-slate-200',
}

const sizes = {
  sm:  'px-2.5 py-1 text-xs',
  md:  'px-4 py-2 text-sm',
  lg:  'px-5 py-2.5 text-sm',
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  disabled,
  children,
  ...props
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-500',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className
      )}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  )
}
