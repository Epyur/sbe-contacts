# AGENTS.md — contacts-service (Контакты)

Go-сервис контактов для SBE-плагина «Контакты» (sbe-contacts). Контейнер `contacts`,
БД `contacts` (postgres `contacts-db`), авторизация — JWT HS256 (общий `JWT_SECRET`
с auth-service) + роли из `contacts_permissions`. Деплой: `/opt/mailers/contacts-service/`.

## Назначение (текущее)

- `POST /api/contacts/sync/push` — приём/обновление контактов `{contacts:[...]}`, upsert
  по `id`, LWW по `updated_at`, ответ `{inserted:N, updated:M}`.
- `GET /api/contacts/sync/pull` — выгрузка всех контактов.
- `POST /api/contacts/delete {id}` — удаление контакта: роль `admin` ИЛИ
  `curator_email` контакта == email из JWT (куратор). Ответ `{deleted:1}`, 404/403.
- `GET /api/contacts/health`.
- Таблицы: `contacts`, `contacts_permissions(app, email, role)`, `contacts_common_access(app, level)`.
- Авторизация: `requirePerm`/`requireDelete` — JWT → email → роль; viewer(1) <
  commenter(2) < editor(3) < admin(4); `effectiveRole` — персональная роль или уровень
  общего доступа.
- При старте: `POST /apps/register` (contacts + секрет) + seed owner=admin в
  `contacts_permissions`.

## Конфиг (env)

`DATABASE_URL`, `PORT`, `JWT_SECRET`, `CONTACTS_APP_ID` (default `contacts`),
`CONTACTS_APP_NAME`, `CONTACTS_OWNER_EMAIL`, `CONTACTS_SERVICE_SECRET`, `AUTH_SERVICE_URL`.

## Сборка / проверка

```
docker compose up -d --build contacts        # на сервере
docker compose logs contacts --tail 20
wget -qO- --no-check-certificate https://epyur.fvds.ru/api/contacts/health   # {"status":"ok"}
```

## История

- **2026-08-20 — создание (sbe-contacts, вынос модуля «Контакты» из монолита):**
  Сервис создан зеркалом documents-service (jwt.go/register.go/permissions.go скопированы
  с адаптацией под `contacts`), таблица `contacts` + `contacts_permissions` +
  `contacts_common_access`. Удаление — отдельный middleware `requireDelete` (роль в
  контексте) + проверка куратора в `handleDelete`.
  docker-compose: `contacts-db` (postgres) + `contacts`; Caddy `/api/contacts/*` →
  `contacts:3000` (до `/api/*`); `.env`: `CONTACTS_*` (сгенерированы секреты).
  auth-service: `seedApps` расширен — seed приложения `contacts` (CONTACTS_APP_ID/NAME/
  OWNER_EMAIL/SERVICE_SECRET).
- **2026-08-20 — деплой + E2E:** залиты файлы сервиса, compose, Caddyfile, seed.go;
  пересобраны auth-service + contacts/contacts-db, Caddy пересоздан (`--force-recreate`,
  иначе старый Caddyfile). E2E 20/21 (единственный «FAIL» — ошибка ожидания в самом
  скрипте: контакт c1 корректно оставался в БД). Пройдено: health 200, pull без JWT 401,
  push id=0 inserted, pull, curator_email, viewer без роли 403, set role viewer, viewer
  pull 200, viewer удаляет свой (куратор) 200, viewer удаляет чужой 403, admin удаляет 200,
  other без роли 403, common-access viewer → pull 200, delete несуществующего 404.
  Тестовые данные удалены (БД пуста, только owner admin).

## Статистика ошибок и отступлений

- Локальной Go-сборки нет (на машине отсутствует тулчейн) — компиляция проверяется
  сборкой в Docker на сервере (`mailers-contacts` собран успешно).
- Импортов без неиспользуемых нет.
