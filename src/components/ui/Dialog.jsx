import React from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { cn } from '../../lib/cn'

export function Dialog({ open, onOpenChange, children }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </RadixDialog.Root>
  )
}

export function DialogTrigger({ children, asChild }) {
  return <RadixDialog.Trigger asChild={asChild}>{children}</RadixDialog.Trigger>
}

export function DialogContent({ children, className, ...props }) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50" style={{ background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(2px)' }} />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50',
          'w-full max-w-md rounded-2xl focus:outline-none',
          className
        )}
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--input-border)',
          boxShadow: 'var(--card-shadow), 0 24px 48px rgba(0,0,0,.35)',
        }}
        {...props}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
}

export function DialogHeader({ children, className }) {
  return (
    <div
      className={cn('px-6 pt-5 pb-4', className)}
      style={{ borderBottom: '1px solid var(--divider)' }}
    >
      {children}
    </div>
  )
}

export function DialogBody({ children, className }) {
  return (
    <div className={cn('px-6 py-5', className)}>
      {children}
    </div>
  )
}

export function DialogTitle({ children, className }) {
  return (
    <RadixDialog.Title
      className={cn('text-base font-bold', className)}
      style={{ color: 'var(--text-primary)' }}
    >
      {children}
    </RadixDialog.Title>
  )
}

export function DialogClose({ children, asChild }) {
  return <RadixDialog.Close asChild={asChild}>{children}</RadixDialog.Close>
}
