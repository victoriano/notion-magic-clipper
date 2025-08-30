import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={inter.className}
        style={{ background: "#65C6FE", color: "#0a0a0a", margin: 0 }}
      >
        {children}
      </body>
    </html>
  );
}
