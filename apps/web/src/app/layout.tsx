import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Masters Diagnostics',
  description: 'Trainerzentrierte Leistungsdiagnostik für Masters-Athleten',
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de"><body>{children}</body></html>;
}
