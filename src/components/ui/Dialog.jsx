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
      <RadixDialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 animate-in fade-in" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50',
          'w-full max-w-lg rounded-2xl shadow-2xl',
          'bg-white border border-slate-200',
          'focus:outline-none',
          className
        )}
        {...props}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
}

export function DialogHeader({ children, className }) {
  return (
    <div className={cn('px-6 pt-6 pb-4 border-b border-slate-100', className)}>
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
    <RadixDialog.Title className={cn('text-base font-bold text-slate-800', className)}>
      {children}
    </RadixDialog.Title>
  )
}

export function DialogClose({ children, asChild }) {
  return <RadixDialog.Close asChild={asChild}>{children}</RadixDialog.Close>
}
