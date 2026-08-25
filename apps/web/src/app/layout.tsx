import type { Metadata } from 'next';
import './globals.css';
import './brand.css';
import './data-views.css';

export const metadata: Metadata = {
  title: {
    default: 'Masters Diagnostics',
    template: '%s · Masters Diagnostics',
  },
  description: 'Trainerzentrierte Leistungsdiagnostik für Masters-Athleten',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/brand/masters-diagnostics-mark.svg', type: 'image/svg+xml', sizes: 'any' }],
    shortcut: '/brand/masters-diagnostics-mark.svg',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de"><body>{children}</body></html>;
}
