import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-[background-color,color,border-color,box-shadow,transform] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.99] [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(15,23,42,0.12),inset_0_-1px_0_rgba(0,0,0,0.14)] hover:bg-primary/92',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'border border-border bg-card text-foreground shadow-xs hover:bg-secondary hover:text-foreground',
        secondary:
          'border border-border/70 bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost:
          'text-muted-foreground hover:bg-accent hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:text-primary/85 hover:underline',
      },
      size: {
        default: 'h-[var(--app-btn-h-default)] px-[var(--app-btn-px-default)] py-[var(--app-btn-py-default)] has-[>svg]:px-[calc(var(--app-btn-px-default)-0.25rem)]',
        sm: 'h-[var(--app-btn-h-sm)] rounded-lg gap-1.5 px-[var(--app-btn-px-sm)] has-[>svg]:px-[calc(var(--app-btn-px-sm)-0.125rem)]',
        lg: 'h-[var(--app-btn-h-lg)] rounded-xl px-[var(--app-btn-px-lg)] has-[>svg]:px-[calc(var(--app-btn-px-lg)-0.5rem)]',
        icon: 'size-[var(--app-btn-icon)]',
        'icon-sm': 'size-[var(--app-btn-icon-sm)]',
        'icon-lg': 'size-[var(--app-btn-icon-lg)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
