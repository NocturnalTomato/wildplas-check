import "./globals.css";

export const metadata = {
  title: "MAG IK HIER WILDPLASSEN?",
  description: "Check of je hier mag wildplassen op basis van je locatie.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
