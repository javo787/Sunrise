// Веб-интерфейса у Sunrise CRM нет: менеджеры работают в Telegram и Google Sheets.
// Эта страница нужна только как ответ сервера на «/».
export default function Home() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>Sunrise CRM</h1>
      <p>Сервис работает. Состояние: <a href="/api/health">/api/health</a></p>
    </main>
  );
}
