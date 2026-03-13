import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { AppHeader } from '@/components/app-header';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Iris Studio',
  description: 'Local-first image generation studio powered by iris.c',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full dark">
      <body className={`${inter.className} h-full overflow-hidden bg-background text-foreground antialiased`}>
        <Providers>
          <div className="flex h-screen flex-col overflow-hidden">
            <AppHeader />
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
