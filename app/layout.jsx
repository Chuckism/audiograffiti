import "./globals.css";

export const metadata = {
  title: "Scenaryoze",
  description: "Character-switching training videos",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}