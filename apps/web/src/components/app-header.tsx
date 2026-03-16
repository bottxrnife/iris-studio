'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CircleHelp, Layers3, ScanSearch, Settings, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Studio', icon: Sparkles },
  { href: '/models', label: 'Models', icon: Layers3 },
  { href: '/loras', label: 'Loras', icon: ScanSearch },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/help', label: 'Help', icon: CircleHelp },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 shrink-0 border-b border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1800px] items-center justify-between px-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Iris Studio</p>
          <p className="text-[11px] text-muted-foreground">Local AI image generation for M-series Mac</p>
        </div>
        <nav className="flex items-center gap-2">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            const Icon = link.icon;

            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                  active
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
