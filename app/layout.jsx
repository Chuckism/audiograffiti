
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css"; // or whatever your CSS import is

export const metadata: Metadata = {
  title: "AudioGraffiti",
  description: "Professional audiograms for LinkedIn",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}