import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css"; // or whatever your CSS import is

export const metadata = {
  title: "AudioGraffiti",
  description: "Professional audiograms for LinkedIn",
};

export default function RootLayout({
  children,
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