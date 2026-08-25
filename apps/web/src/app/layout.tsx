import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Masters Diagnostics',
    template: '%s · Masters Diagnostics',
  },
  description: 'Trainerzentrierte Leistungsdiagnostik für Masters-Athleten',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/brand/masters-diagnostics-mark.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/brand/favicon-32.png',
    apple: [{ url: '/brand/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de"><body>{children}</body></html>;
}
