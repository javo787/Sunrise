import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Политика конфиденциальности | Meta Privacy Center',
  description: 'Узнайте, как Meta собирает, использует и защищает вашу информацию.',
}

const sections = [
  { number: '01', label: 'Введение', href: '#introduction', active: true },
  { number: '02', label: 'Сбор данных', href: '#collection' },
  { number: '03', label: 'Использование данных', href: '#use' },
  { number: '04', label: 'Обмен информацией', href: '#sharing' },
  { number: '05', label: 'Ваши права', href: '#rights' },
]

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[#f7f8fa] text-[#1c2b33]">
      <header className="sticky top-0 z-10 border-b border-[#e1e5ea] bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-[72px] max-w-[1240px] items-center justify-between px-6 lg:px-10">
          <a href="#top" aria-label="Meta — на главную" className="flex items-center gap-3">
            <img
              src="https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/meta/default.svg"
              alt="Meta"
              className="h-9 w-9"
            />
            <span className="hidden text-[15px] font-semibold tracking-[-0.02em] text-[#344854] sm:block">Privacy Center</span>
          </a>
          <div className="flex items-center gap-5 text-sm text-[#52636d]">
            <a href="#rights" className="hidden transition-colors hover:text-[#0866ff] sm:block">Помощь</a>
            <button className="rounded-full border border-[#d8dee4] px-4 py-2 font-medium transition-colors hover:border-[#0866ff] hover:text-[#0866ff]" type="button">Русский</button>
          </div>
        </div>
      </header>

      <div id="top" className="mx-auto grid max-w-[1240px] grid-cols-1 gap-12 px-6 py-12 lg:grid-cols-[250px_1fr] lg:gap-24 lg:px-10 lg:py-20">
        <aside className="lg:sticky lg:top-28 lg:h-fit" aria-label="Навигация по политике конфиденциальности">
          <p className="mb-5 text-xs font-bold uppercase tracking-[0.14em] text-[#8a99a3]">На этой странице</p>
          <nav>
            <ol className="space-y-1">
              {sections.map((section) => (
                <li key={section.number}>
                  <a
                    href={section.href}
                    className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition-colors ${section.active ? 'bg-[#e7f0ff] font-semibold text-[#0866ff]' : 'text-[#52636d] hover:bg-white hover:text-[#0866ff]'}`}
                  >
                    <span className="font-mono text-xs text-[#94a3ad] group-hover:text-[#0866ff]">{section.number}</span>
                    {section.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <div className="mt-10 hidden border-t border-[#dfe4e8] pt-5 text-xs leading-5 text-[#82909a] lg:block">
            Последнее обновление<br />12 сентября 2024 г.
          </div>
        </aside>

        <main className="max-w-[750px]">
          <div className="mb-14 border-b border-[#dfe4e8] pb-10">
            <p className="mb-5 text-sm font-semibold text-[#0866ff]">META PRIVACY POLICY</p>
            <h1 className="max-w-[680px] text-4xl font-semibold leading-[1.08] tracking-[-0.045em] text-[#17262e] sm:text-6xl">Политика конфиденциальности</h1>
            <p className="mt-7 max-w-[600px] text-lg leading-8 text-[#63747e]">Мы хотим, чтобы вы понимали, какую информацию мы собираем и как используем её для создания более удобных и безопасных продуктов.</p>
            <p className="mt-6 text-sm text-[#82909a]">Последнее обновление: 12 сентября 2024 г.</p>
          </div>

          <article className="space-y-14 text-[16px] leading-8 text-[#52636d]">
            <section id="introduction" className="scroll-mt-28">
              <h2 className="mb-5 text-2xl font-semibold tracking-[-0.025em] text-[#1c2b33]">Введение</h2>
              <p>В Meta мы считаем, что конфиденциальность — это фундаментальное право. Эта политика объясняет, как мы собираем, используем, раскрываем и храним вашу информацию, когда вы пользуетесь нашими продуктами и сервисами.</p>
              <p className="mt-5">Мы стремимся предоставлять вам понятный выбор и контроль над вашей информацией. Если у вас возникнут вопросы, вы всегда можете обратиться к нам.</p>
            </section>

            <section id="collection" className="scroll-mt-28">
              <h2 className="mb-5 text-2xl font-semibold tracking-[-0.025em] text-[#1c2b33]">Сбор данных</h2>
              <p>Мы собираем информацию, которую вы предоставляете, когда создаёте аккаунт, публикуете контент или связываетесь с нами. Это может включать ваше имя, контактные данные и содержание ваших публикаций.</p>
              <p className="mt-5">Мы также получаем техническую информацию о том, как вы используете наши продукты: тип устройства, действия в сервисе, настройки и приблизительное местоположение.</p>
            </section>

            <section id="use" className="scroll-mt-28">
              <h2 className="mb-5 text-2xl font-semibold tracking-[-0.025em] text-[#1c2b33]">Использование данных</h2>
              <p>Информация помогает нам предоставлять, персонализировать и улучшать наши продукты. Мы используем её, чтобы показывать релевантный контент, поддерживать безопасность и предлагать полезные функции.</p>
              <ul className="mt-5 list-disc space-y-2 pl-6">
                <li>Развивать и тестировать новые продукты и функции.</li>
                <li>Измерять эффективность и понимать, как используются сервисы.</li>
                <li>Обнаруживать подозрительную активность и защищать сообщество.</li>
              </ul>
            </section>

            <section id="sharing" className="scroll-mt-28">
              <h2 className="mb-5 text-2xl font-semibold tracking-[-0.025em] text-[#1c2b33]">Обмен информацией</h2>
              <p>Мы не продаём вашу персональную информацию. Мы можем делиться информацией с компаниями, входящими в Meta, и доверенными партнёрами, которые помогают нам предоставлять сервисы — например, с поставщиками инфраструктуры и поддержки.</p>
              <p className="mt-5">Мы также раскрываем информацию, когда это требуется законом или необходимо для защиты людей, продуктов и наших прав.</p>
            </section>

            <section id="rights" className="scroll-mt-28">
              <h2 className="mb-5 text-2xl font-semibold tracking-[-0.025em] text-[#1c2b33]">Ваши права</h2>
              <p>Вы можете просматривать, редактировать и удалять свою информацию через настройки аккаунта. В зависимости от вашего региона у вас могут быть дополнительные права, включая право на доступ, перенос данных и ограничение обработки.</p>
              <p className="mt-5">Чтобы управлять настройками конфиденциальности, посетите <a href="#rights" className="font-medium text-[#0866ff] underline decoration-[#b8d0ff] underline-offset-4 hover:decoration-[#0866ff]">Центр конфиденциальности</a> или свяжитесь с нами.</p>
            </section>
          </article>

          <footer className="mt-20 border-t border-[#dfe4e8] pt-7 text-sm text-[#82909a]">© 2024 Meta Platforms, Inc. · Условия · Политика конфиденциальности</footer>
        </main>
      </div>
    </div>
  )
}
