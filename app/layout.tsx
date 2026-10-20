export const metadata = { title: "Sunrise CRM", description: "Автоматизация отдела продаж Sunrise" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem" }}>{children}</body>
    </html>
  );
}
