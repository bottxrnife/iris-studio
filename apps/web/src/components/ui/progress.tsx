import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value?: number | null;
  indeterminate?: boolean;
  indicatorClassName?: string;
}

export function Progress({
  value = 0,
  indeterminate = false,
  className,
  indicatorClassName,
  ...props
}: ProgressProps) {
  const clampedValue = Math.max(0, Math.min(100, value ?? 0));

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clampedValue)}
      aria-valuetext={indeterminate ? 'In progress' : `${Math.round(clampedValue)}%`}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width,transform] duration-500 ease-out',
          indeterminate ? 'w-[35%] animate-progress-indeterminate' : undefined,
          indicatorClassName
        )}
        style={indeterminate ? undefined : { width: `${clampedValue}%` }}
      />
    </div>
  );
}
