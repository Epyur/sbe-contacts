# specification.md — sbe-contacts (Контакты)

Форматы обмена между плагином «Контакты» (sbe-contacts) и contacts-service на сервере
(`https://epyur.fvds.ru`).

## Авторизация

Все запросы к contacts-service — JWT Bearer. JWT берётся из ЦУП СБЕ:
`getService('sbe-apstore').auth.getToken('contacts')`. При 401 — «Ключ доступа
недействителен», при 403 — «Нет прав доступа».

## Модель контакта (ContactItem / Contact)

```jsonc
{
  "id": 1786...,                    // int64; новые локальные = Date.now()+random
  "name": "Иванов Иван Иванович",
  "phone": "+7 (903) 157-73-55",
  "email": "i.ivanov@intechcert.ru",
  "organization": "ООО «ПожТест-Центр»",
  "position": "Заместитель начальника отдела пожарных испытаний",
  "org_type": "Испытательная лаборатория",  // свободный текст
  "notes": "…",                     // примечание (в форме, не на визитке)
  "curator_email": "polishchuk@tn.ru",  // последний создатель/редактор (из JWT)
  "created_at": "…",                // ISO8601
  "updated_at": "…",                // ISO8601; LWW по updated_at
  "sync_status": "local | synced"   // только локально
}
```

Локальная БД: `yourbase/sbe_contacts/contacts_data.json` →
`{"contacts": [...], "org_types": [string], "pending_deletes": [int]}`.
`org_types` — локальный реестр использованных типов организации (для datalist), сервер
не хранит. `pending_deletes` — очередь удалений при офлайне.

## QR-код (vCard 3.0)

При клике на визитку генерируется QR-код (библиотека `qrcode`), содержимое:

```
BEGIN:VCARD
VERSION:3.0
N:<имя>
FN:<имя>
TEL:<телефон>
EMAIL:<email>
ORG:<организация>
TITLE:<должность>
NOTE:<примечание>
END:VCARD
```

Цвет: тёмный `#FF0000`, фон белый, margin 2. Кнопка «⬇ PNG» сохраняет QR (512×512).

## Endpoints

### POST /api/contacts/sync/push — приём/обновление контактов (editor+)
- Тело: `{"contacts": [Contact, ...]}`.
- Семантика: `id>0` → UPDATE по `WHERE id=$1 AND updated_at < $10` (иначе INSERT
  `ON CONFLICT (id) DO NOTHING`); `id=0` → INSERT (сервер назначает id).
- Ответ: `{"inserted": N, "updated": M}`.

### GET /api/contacts/sync/pull — выгрузка всех контактов (viewer+)
- Ответ: `{"contacts": [Contact, ...]}`.

### POST /api/contacts/delete — удаление контакта (admin ИЛИ куратор)
- Тело: `{"id": 123}`.
- Доступ: роль `admin` ИЛИ `curator_email` контакта == email из JWT.
- Ответ: `{"deleted": 1}`; 404 — контакт не найден; 403 — нет прав.

### Права доступа (admin)
- `GET /api/contacts/permissions/me` (viewer+) — `{"email", "role", "hasAccess"}`.
- `GET /api/contacts/permissions` — список `{"permissions": [{email, role}]}`.
- `POST /api/contacts/permissions` — `{"email", "role"}` (role `viewer|commenter|editor|admin`, `""` — отозвать).
- `GET /api/contacts/common-access` — `{"level"}`.
- `POST /api/contacts/common-access` — `{"level"}` (`"" | viewer | commenter | editor`).

### GET /api/contacts/health — статус.

## Сервер (contacts-service)

- Go-сервис, контейнер `contacts`, БД `contacts` (postgres `contacts-db`).
- Таблицы: `contacts`, `contacts_permissions(app, email, role)`, `contacts_common_access(app, level)`.
- JWT: app_id `contacts`, роли viewer < commenter < editor < admin + общий доступ;
  owner_email = polishchuk@tn.ru (seed при старте).
- При старте: `POST /apps/register` в auth-service (CONTACTS_APP_ID/NAME/OWNER_EMAIL/SERVICE_SECRET).
- Caddy: `/api/contacts/*` → `contacts:3000` (до `/api/*`).

## Миграция (одноразовая)

При первом запуске (пустая локальная БД, флаг `legacyMigrated` в настройках): читать
`yourbase/contacts_data.json` (fallback — `yourbase/yougile_cache.json`, задачи с
`description.type == 'contact'`). `org_type` — название колонки YouGile (по columnId,
если монолит активен; иначе — исходное значение), `curator_email` — текущий
авторизованный email из ЦУП, `sync_status=local` → первый push отправит на сервер.
