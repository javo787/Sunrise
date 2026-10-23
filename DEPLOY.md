# Запуск Sunrise CRM бесплатно — пошагово

Всё ниже работает на бесплатных тарифах. Условия проверены по документации сервисов на октябрь 2026; тарифы меняются — если что-то не совпадает, смотрите актуальные страницы.

| Что | Где | Бесплатные условия |
|---|---|---|
| Сервер | **Render** (Web Service, Free; может потребовать карту для верификации) или **свой сервер** | 750 ч/мес на аккаунт (круглосуточный сервис = 744 ч, поэтому **только один** бесплатный сервис), засыпает через 15 мин без входящих запросов, может перезапускаться в любой момент |
| База данных | **MongoDB Atlas M0** | бессрочно, 512 МБ (хватит на годы: ~6 000 лидов в месяц — это десятки МБ) |
| «Будильник» и планировщик | **cron-job.org** | бесплатно, раз в минуту, свои заголовки, таймаут 30 с |
| ИИ | **Google AI Studio (Gemini)** | бесплатный тариф с лимитами по запросам; Google может использовать запросы для улучшения моделей |
| Таблица | Google Sheets + сервисный аккаунт | бесплатно |
| Telegram | Bot API | бесплатно |

**Не бесплатно «из коробки» (читайте шаги 10–11):** хостинг Evolution API (WhatsApp) и доступ к Meta (лид-формы, Instagram Direct) — требуют своего сервера и проверки приложения у Meta.

Оценка памяти (измерено): сборка проходит при куче 300 МБ, работающий сервер занимает ~115 МБ — на 512 МБ бесплатного Render хватает с запасом.

---

## Шаг 1. MongoDB Atlas (база)

1. Зарегистрируйтесь на mongodb.com/atlas → создайте проект → **Create** → выберите **Free (M0)**, регион ближе к Frankfurt.
2. **Database Access** → Add New Database User: имя `sunrise`, пароль (латиница и цифры, без спецсимволов — так проще), роль «Read and write to any database».
3. **Network Access** → Add IP Address → **Allow access from anywhere (0.0.0.0/0)**. Это нужно, потому что у бесплатного Render нет постоянного IP. Защита — длинный пароль пользователя БД.
4. **Connect** → Drivers → скопируйте строку вида `mongodb+srv://sunrise:ПАРОЛЬ@cluster0.xxxxx.mongodb.net/` — это `MONGODB_URI`.

## Шаг 2. Telegram: бот и группа

1. В Telegram откройте **@BotFather** → `/newbot` → имя и username → сохраните **токен** (`TELEGRAM_BOT_TOKEN`).
2. Создайте группу менеджеров (все менеджеры + руководитель) и добавьте туда бота.
3. ID группы и свой ID узнаем на шаге 7 командой `/whoami`.

## Шаг 3. Gemini (ИИ)

1. aistudio.google.com → **Get API key** → создайте ключ (`GEMINI_API_KEY`). Банковская карта не нужна.
2. В AI Studio посмотрите, какие модели и лимиты доступны вашему ключу. По умолчанию стоят `gemini-2.5-flash`, запасная `gemini-2.5-flash-lite` (у каждой модели свой лимит запросов, поэтому цепочка даёт больше бесплатных запросов). Если названия у вас другие — поменяйте `GEMINI_MODEL`, `GEMINI_MODEL_FALLBACK_1`.
3. **Про лимиты:** диалог с клиентом — это обычно 3–6 запросов к модели. При ~200 лидах в день бесплатных запросов может не хватить. Что произойдёт: лиды **не потеряются** (для WhatsApp лид создастся с пометкой «ИИ был недоступен», клиенту уйдёт заготовленный ответ, менеджер получит карточку). Если упрётесь в лимит — включите оплату в Google AI Studio (расход измеряется копейками на тысячи запросов) или временно уменьшите нагрузку.

## Шаг 4. Google Sheets (таблица)

1. Загрузите файл **SUNRISE CRM — ОТДЕЛ ПРОДАЖ.xlsx** на Google Drive → откройте → **Файл → Сохранить как Google Таблицу**. Проверьте, что листы называются точно **«Менеджер 1», «Менеджер 2», «Менеджер 3», «_Lists»**, а выпадающие списки и формулы на месте.
2. ID таблицы — часть адреса между `/d/` и `/edit` (`SHEETS_SPREADSHEET_ID`).
3. console.cloud.google.com → создайте проект → **APIs & Services → Library → Google Sheets API → Enable**.
4. **IAM & Admin → Service Accounts → Create service account** (имя `sunrise-crm`) → откройте его → **Keys → Add key → JSON** → скачается файл `.json`.
5. Откройте скачанный файл, найдите `client_email` (вида `sunrise-crm@проект.iam.gserviceaccount.com`) → в вашей таблице **Поделиться** → вставьте этот e-mail с правом **Редактор**.
6. Превратите JSON-ключ в одну строку base64 (чтобы не мучиться с переносами строк):
   * Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\путь\key.json"))`
   * macOS: `base64 -i key.json` · Linux: `base64 -w0 key.json`

   Результат — значение `GOOGLE_SERVICE_ACCOUNT_JSON`.

## Шаг 5. Секретные строки

Нужны три случайные строки (латиница, цифры, `_`, `-`; не короче 16 символов): `CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `WHATSAPP_WEBHOOK_SECRET`.
Windows PowerShell: `-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | % {[char]$_})` · macOS/Linux: `openssl rand -hex 24`. Или любой менеджер паролей.
`META_VERIFY_TOKEN` — тоже любая своя строка (понадобится на шаге 11).

## Шаг 6. Где запускать сервер — выберите вариант

**Blueprint (`render.yaml`) не обязателен** — сервис на Render можно создать вручную, это тот же бесплатный тариф. Но имейте в виду главное ограничение: **Render иногда требует банковскую карту для верификации** (холд ≈ $1, он сразу возвращается, сервис остаётся бесплатным). Поддержка Render пишет, что другого способа верификации у них нет. Если карты нет — идите по варианту Б.

Проверено и **не подходит**:
* **Hugging Face Spaces** — Docker-пространства теперь требуют платный план, а исходящие соединения разрешены только на порты 80/443/8080, то есть MongoDB Atlas (порт 27017) оттуда недоступен.
* **Koyeb** (с февраля 2026 нужна карта с холдом $29), **Fly.io**, **Northflank**, **Oracle/Google Cloud** — просят карту.
* По обзорам, бесплатные контейнеры **Back4app** (работает ограниченное время после деплоя) и **SnapDeploy** (100 ч/мес) для круглосуточной работы не годятся. Условия таких сервисов быстро меняются — перепроверяйте.

### Вариант А. Render Free, вручную (нужна карта для верификации)

1. render.com → Sign up (удобно через GitHub). Если попросит карту — это верификация, холд возвращается.
2. **New + → Web Service → Build and deploy from a Git repository** → подключите GitHub и дайте Render доступ к приватному репозиторию **javo787/Sunrise**.
3. Поля формы:

| Поле | Значение |
|---|---|
| Name | `sunrise-crm` |
| Region | Frankfurt |
| Branch | `main` |
| Runtime | Node |
| Build Command | `npm ci --include=dev && SKIP_TYPECHECK=1 NODE_OPTIONS=--max-old-space-size=400 npm run build` |
| Start Command | `node node_modules/next/dist/bin/next start` |
| Instance Type | **Free** |
| Advanced → Health Check Path | `/api/ping` (всегда отвечает 200; `/api/health` — для диагностики) |

4. **Environment Variables → Add from .env** — вставьте блок (подставьте свои значения; пустые строки можно не вставлять):

```
NODE_VERSION=20
TIMEZONE=Asia/Dushanbe
MONGODB_DB=sunrise
ESCALATION_MINUTES=15
MANUAL_LEADS_ASSIGN=self
LLM_PROVIDER=gemini
GEMINI_MODEL=gemini-2.5-flash
GEMINI_MODEL_FALLBACK_1=gemini-2.5-flash-lite
MONGODB_URI=<шаг 1>
CRON_SECRET=<шаг 5>
TELEGRAM_BOT_TOKEN=<шаг 2>
TELEGRAM_WEBHOOK_SECRET=<шаг 5>
TELEGRAM_MANAGERS_CHAT_ID=0
TELEGRAM_ADMIN_IDS=
GEMINI_API_KEY=<шаг 3>
GOOGLE_SERVICE_ACCOUNT_JSON=<base64 из шага 4>
SHEETS_SPREADSHEET_ID=<шаг 4>
```

   `TELEGRAM_MANAGERS_CHAT_ID=0` и пустой `TELEGRAM_ADMIN_IDS` — временно, их заполним на шаге 7. Остальные переменные (`META_*`, `EVOLUTION_*`, `WHATSAPP_WEBHOOK_SECRET`, `SHEETS_COLUMNS`, `PUBLIC_BASE_URL`) добавите позже.
5. **Create Web Service**. Сборка займёт несколько минут. Когда сервис станет **Live**, откройте `https://<имя>.onrender.com/api/ping` (должно быть `"status":"ok"`), затем `/api/health` — там `"ok": true` означает, что БД и Telegram настроены. Добавьте `PUBLIC_BASE_URL` = этот адрес (без слэша в конце). Render перезапустится сам.

С вариантом А обязательно сделайте шаг 8 (cron-job.org), иначе сервис уснёт.

> **Важно про 750 бесплатных часов.** Они общие на весь аккаунт/воркспейс Render, а не на сервис: один круглосуточный сервис = 744 ч. Если в этом же аккаунте уже работает другой бесплатный круглосуточный сервис (например, бот `usmle_pathway` с `node bot.js`), то два сервиса исчерпают лимит примерно к 15-му числу, и Render приостановит оба до конца месяца. Решения: завести Sunrise в **отдельном аккаунте Render** (другой e-mail), либо перенести второй сервис на свой сервер (вариант Б).

### Вариант Б. Свой сервер (VPS) — без карты Render, без сна, без cron-job.org

Подходит, если у вас уже есть сервер, например тот, где работает Evolution API для meditour-crm: приложению нужно около 115–200 МБ памяти.

1. Docker и Docker Compose на сервере. Клонируйте репозиторий (`git clone https://github.com/javo787/Sunrise`, для приватного репозитория — с токеном).
2. `cp .env.example .env` → заполните значения (как в таблице выше; для варианта Б `ENABLE_INTERNAL_CRON` оставьте `on`).
3. `docker compose up -d --build`. Приложение слушает только `127.0.0.1:3000`.
4. Нужен **публичный HTTPS-адрес** для вебхуков (Telegram, Meta, Evolution). Направьте на `http://127.0.0.1:3000` обратный прокси, который у вас уже есть (Caddy, nginx, Nginx Proxy Manager) или добавьте поддомен, например `sunrise.ваш-домен.tj` → `reverse_proxy 127.0.0.1:3000` (Caddy сам получит сертификат). Этот адрес — `PUBLIC_BASE_URL`.
5. Проверка: `curl https://sunrise.ваш-домен.tj/api/health` → `"ok": true`. Логи: `docker compose logs -f sunrise`. Обновление: `git pull && docker compose up -d --build`.
6. **Шаг 8 (cron-job.org) пропустите:** сервер не засыпает, а встроенный планировщик работает сам. Запустите ровно один экземпляр.

Образ собирается из `Dockerfile` в репозитории (проверен вручную по шагам, но в `docker build` в моей среде не запускался).

## Шаг 7. Telegram: вебхук, ID, менеджеры

1. **Вебхук** — вставьте в адресную строку браузера (подставьте токен, адрес и секрет):

   `https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=https://<АДРЕС>.onrender.com/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>&allowed_updates=["message","callback_query"]`

   Ответ должен быть `{"ok":true,...}`. Проверка: `https://api.telegram.org/bot<ТОКЕН>/getWebhookInfo` — в `last_error_message` пусто.
2. Напишите боту в личку `/whoami` → он пришлёт **ваш Telegram ID**. В группе менеджеров отправьте `/whoami@username_бота` → он пришлёт **ID группы** (число с минусом, например `-1001234567890`).
3. В Render → Environment: `TELEGRAM_MANAGERS_CHAT_ID` = ID группы, `TELEGRAM_ADMIN_IDS` = ваш ID (несколько руководителей — через запятую). Сохраните — сервис перезапустится.
4. **Подключите менеджеров.** Каждый менеджер пишет боту в личку `/start` (иначе бот не сможет присылать ему контакты) и сообщает вам свой ID (`/whoami`). Вы отправляете боту:

   `/addmanager 111111111 Менеджер 1 Имя Фамилия`
   `/addmanager 222222222 Менеджер 2 Имя Фамилия`
   `/addmanager 333333333 Менеджер 3 Имя Фамилия`

   Один лист — один менеджер. Список: `/managers`.

## Шаг 8. cron-job.org (будильник и планировщик) — только для варианта А (Render)

Без этого бесплатный Render уснёт и эскалация через 15 минут не сработает. На своём сервере (вариант Б) этот шаг не нужен.

1. Зарегистрируйтесь на cron-job.org (бесплатно). В настройках аккаунта выставьте часовой пояс **Asia/Dushanbe**.
2. **Create cronjob** — создайте задачи. У каждой: метод **GET**, во вкладке **Advanced → Headers** добавьте заголовок `x-cron-secret` со значением вашего `CRON_SECRET`.

| Название | URL | Расписание | Обязательно |
|---|---|---|---|
| Sunrise: пульс и эскалация | `https://<АДРЕС>/api/cron/publish-and-escalate?async=1` | каждую минуту | **да** |
| Sunrise: повторы | `https://<АДРЕС>/api/cron/retry-failed?async=1` | каждые 5 минут | рекомендуется |
| Sunrise: дневной отчёт | `https://<АДРЕС>/api/cron/report-daily?async=1` | каждый день 20:00 | рекомендуется |
| Sunrise: месячный отчёт | `https://<АДРЕС>/api/cron/report-monthly?async=1` | каждый день 20:30 (письмо уйдёт только в последний день месяца) | рекомендуется |

`async=1` нужен, чтобы сервис отвечал сразу (у cron-job.org таймаут 30 с). Первый запрос после сна может занять до минуты и дать одну «ошибку» в истории — это нормально, дальше сервис не засыпает.

## Шаг 9. Проверка таблицы (до первого боевого лида)

Откройте в браузере не получится (нужен заголовок), поэтому выполните в терминале или в cron-job.org «Test run»:

`curl -H "x-cron-secret: <CRON_SECRET>" https://<АДРЕС>/api/cron/sheets-check`

Ответ покажет по каждому листу найденные колонки, заголовки, которые код не трогает (формулы), первую свободную строку и значения справочников, которых нет в `_Lists`. Если пишет, что колонка не найдена, — задайте реальные заголовки переменной `SHEETS_COLUMNS` в Render, например:

`{"name":"ФИО клиента","phone":"Номер телефона","source":"Источник","stage":"Стадия"}`

(ключи: `date, name, phone, source, stage, floor, area, payment, comment`; обязательны name, phone, source, stage).

## Шаг 10. WhatsApp (Evolution API)

Evolution API сам по себе бесплатный, но ему нужны PostgreSQL, Redis и от 512 МБ памяти — на бесплатный Render он не помещается (бесплатная Postgres на Render удаляется через 30 дней). Варианты:

1. **Лучший:** используйте сервер Evolution, который уже работает для meditour-crm. Создайте на нём **новый инстанс** (например, `sunrise`) и привяжите нужный WhatsApp-номер по QR. Ничего нового разворачивать не надо.
2. Развернуть свой: бесплатная ВМ **Oracle Cloud Always Free** (после июня 2026 это 2 OCPU и 12 ГБ; часто пишут «Out of capacity», и неиспользуемые ВМ могут быть отобраны) + `docker compose` с Evolution, PostgreSQL и Redis.
3. Пока пропустить WhatsApp: Telegram, ручной ввод и таблица работают без него.

Для подключения: в Render укажите `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` и `WHATSAPP_WEBHOOK_SECRET`. В Evolution Manager → ваш инстанс → **Webhook**: URL `https://<АДРЕС>/api/whatsapp-webhook?secret=<WHATSAPP_WEBHOOK_SECRET>`, включить, событие только **MESSAGES_UPSERT**.
Заметка: Evolution работает через неофициальное подключение WhatsApp Web — используйте отдельный рабочий номер, а не личный.

## Шаг 11. Meta (лид-формы Facebook/Instagram, Instagram Direct)

**Это единственная часть, которая упирается не в деньги, а в проверку у Meta.** По документации Meta, в режиме разработки получить лиды нельзя — доступны только лиды людей, у которых есть роль в вашем приложении; для реальных клиентов приложение должно пройти **App Review** (разрешения `leads_retrieval` и `pages_manage_ads`), после чего Meta просит **Business Verification**. Для сообщений Instagram Direct нужно аналогично `instagram_manage_messages`. Проверка бесплатная, но занимает дни или недели и требует документов компании.

Что делать:
1. **Сейчас:** запускайте без Meta (шаги 1–10). Рекламу «написать в WhatsApp» можно вести уже сейчас — такие обращения придут через Evolution без проверки Meta. Лиды из форм на время можно выгружать из Центра лидов Meta или вносить кнопкой «➕ Добавить клиента».
2. **Параллельно:** developers.facebook.com → создайте приложение (тип Business) → добавьте продукт **Webhooks** и сценарий «Capture & manage ad leads» → подайте App Review и Business Verification.
3. **После одобрения:** в Render заполните `META_APP_SECRET` (Настройки приложения → Основное), `META_VERIFY_TOKEN` (ваша строка), `META_PAGE_ACCESS_TOKEN` (токен страницы с `leads_retrieval`, `pages_show_list`, `pages_manage_metadata`, `pages_manage_ads`). В Webhooks: объект **Page**, адрес `https://<АДРЕС>/api/meta-webhook`, токен подтверждения = `META_VERIFY_TOKEN`, подписка на поле **leadgen**. Подпишите страницу на приложение: `POST https://graph.facebook.com/v23.0/<PAGE_ID>/subscribed_apps?subscribed_fields=leadgen&access_token=<PAGE_TOKEN>`. В Business Settings → Integrations → Leads Access назначьте приложение как CRM для страницы.

### Instagram Direct через Instagram Login (рекомендуемый путь, страница Facebook не нужна)

Подходит, если нужны только сообщения Instagram. Лид-формы (`leadgen`) работают по схеме выше и могут быть подключены параллельно.

1. В Instagram (аккаунт Business/Creator): Настройки → Сообщения → Управление сообщениями → Подключённые инструменты → **Разрешить доступ к сообщениям** (Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages).
2. developers.facebook.com → приложение → **Instagram → API setup with Instagram login**.
3. **Generate access tokens** → добавьте аккаунт, войдите в Instagram, нажмите Generate token и включите переключатель **Webhook subscription**. Токен начинается с `IGAA…` → это `INSTAGRAM_ACCESS_TOKEN`. Он живёт 60 дней: CRM сама продлевает его раз в неделю (cron `retry-failed`) и хранит продлённый токен в MongoDB (коллекция `credentials`).
4. В блоке над шагом 1 возьмите **Instagram app secret** → `INSTAGRAM_APP_SECRET`. Это не тот секрет, что в App settings → Basic; CRM принимает вебхуки, подписанные любым из двух (`INSTAGRAM_APP_SECRET`, `META_APP_SECRET`).
5. `META_VERIFY_TOKEN` — ваша строка. Все переменные внесите в Render и дождитесь деплоя (`/api/health` → `"instagram": true`).
6. **Configure webhooks**: Callback URL `https://<АДРЕС>/api/meta-webhook`, Verify token = `META_VERIFY_TOKEN`, Verify and save, подписка на поле **`messages`**.
7. Проверка: напишите в Direct с аккаунта, у которого есть роль в приложении (admin/developer/tester). Для обычных клиентов приложению нужны App Review (`instagram_business_manage_messages`) и Business Verification.

Если токен не удалось продлить, в логах Render появится ошибка «не удалось продлить токен Instagram»: сгенерируйте новый токен и замените `INSTAGRAM_ACCESS_TOKEN` — отсчёт начнётся заново автоматически. Если ответы не уходят, задайте `INSTAGRAM_USER_ID` (id аккаунта: `GET https://graph.instagram.com/me?fields=user_id&access_token=<токен>`).

## Шаг 12. Первый тест

1. `/api/health` → `ok: true`.
2. Бот: `/start` у менеджера → есть кнопка «➕ Добавить клиента».
3. Добавьте тестового клиента кнопкой → строка появилась на листе менеджера, формулы не тронуты.
4. (Если подключён WhatsApp) напишите на номер «Здравствуйте, 5 этаж, рассрочка» → бот ответил → карточка в группе → нажмите 🦈 → контакт в личке, кнопка «✅ Забрал», строка в таблице.
5. Не нажимайте на новую карточку 15 минут → бот тегает менеджеров и руководителя.
6. `/report day` → отчёт пришёл.

## Бот молчит — как найти причину за 2 минуты

Откройте по порядку (подставьте свой адрес Render и токен; **не присылайте токен и пароли никому**):

1. `https://<АДРЕС>/api/ping` → `{"status":"ok"...}`. Если открывается минуту — сервис спал (нужен cron-job.org, шаг 8).
2. `https://<АДРЕС>/api/health?deep=1` — главный инструмент. Читайте поле **`hints`** (подсказки на русском), а также `mongo`, `mongoError`, `problems` (какие переменные не заданы или неверны), `telegram.webhookUrl` и `telegram.lastError`.
3. `https://api.telegram.org/bot<ТОКЕН>/getWebhookInfo` — смотрите `url`, `pending_update_count` и `last_error_message`.
4. Render → **Logs**: ищите строки «планировщик запущен», «не удалось создать индексы MongoDB», «ошибка обработчика Telegram».
5. Atlas → Metrics → **Connections**: после запуска сервиса должно быть больше 0. **0 подключений и 0 B данных — приложение не смогло подключиться к базе.**

| Что видите | Причина | Что делать |
|---|---|---|
| `mongo: false`, в подсказке «неверное имя пользователя или пароль» | неверный `MONGODB_URI` | Atlas → Connect → Drivers, скопируйте строку заново; вместо `<db_password>` впишите пароль **без угловых скобок**; спецсимволы в пароле — в URL-кодировке (проще пароль из букв и цифр) |
| `mongo: false`, «нет соединения» | Atlas не пускает или кластер на паузе | Network Access: `0.0.0.0/0` со статусом Active |
| `getWebhookInfo`: `url` пустой | вебхук не зарегистрирован | выполните `setWebhook` (шаг 7). Ответ «Webhook was set» — установлен, «already set» — уже был с теми же параметрами |
| `last_error_message`: **401** | `secret_token` в `setWebhook` не равен `TELEGRAM_WEBHOOK_SECRET` (или не указан) | сделайте `setWebhook` заново с точно тем же секретом, что в Render |
| `last_error_message`: **404** | в адресе неверный путь | адрес должен заканчиваться на `/api/telegram-webhook` |
| `last_error_message`: **500/502/503** | сервис падает или спал | Render → Logs; `/api/health` |
| `pending_update_count` > 0, ошибок нет | сообщения принимаются, но не обрабатываются | чаще всего недоступна MongoDB (см. выше) |
| `problems` содержит имя переменной | переменная не задана или неверна | исправьте в Render → Environment (сервис перезапустится сам) |

Если после исправления `getWebhookInfo` всё ещё показывает старую ошибку, отправьте боту новое сообщение: поле обновится после следующей попытки доставки.

**Почему раньше бот мог молчать при сбое базы.** Ошибка в обработчике превращалась в HTTP 500, и Telegram считал доставку неудачной. Теперь ошибки ловятся, `/whoami` и `/start` отвечают даже при недоступной MongoDB, а при внутренней ошибке бот пишет «⚠️ Внутренняя ошибка сервера».

## Если что-то не работает

* **Бот молчит:** `getWebhookInfo` (шаг 7) → смотрите `last_error_message`; в Render → **Logs**. 401 от вебхука = не совпал `TELEGRAM_WEBHOOK_SECRET`.
* **Сервис не стартует/health = 503:** не заполнены `MONGODB_URI` или переменные Telegram; Atlas не пускает — проверьте Network Access `0.0.0.0/0` и пароль (спецсимволы в пароле нужно URL-кодировать).
* **Первый ответ после простоя долгий:** сервис спал; задача cron-job.org «пульс» должна выполняться каждую минуту.
* **Не пишет в таблицу:** вызовите `sheets-check` (шаг 9); проверьте, что таблица расшарена на e-mail сервисного аккаунта с правом «Редактор».
* **ИИ не отвечает:** лимит бесплатного тарифа Gemini или неверное имя модели — смотрите логи (`ИИ недоступен`), проверьте `GEMINI_MODEL` в AI Studio.
* **Лимит 750 часов Render:** не создавайте других бесплатных сервисов в этом аккаунте.
