import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "nexhealth-sentinel",
  description: "Catches the NexHealth Synchronizer failures that are silent by default.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
