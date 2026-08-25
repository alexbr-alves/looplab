import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LoopLab — Estúdio de vídeo',
  description: 'Monte vídeos com loop, playlist, títulos e relatório de tempos no seu próprio Mac.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
