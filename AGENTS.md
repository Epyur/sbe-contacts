# AGENTS.md — sbe-contacts (Контакты)

SBE-плагин «Контакты»: локальная БД-кэш контактов + синхронизация с contacts-service
(сервер — канон), визитки с QR (vCard) для переноса в телефон, кураторы и права на удаление.

## Назначение (текущее)

- **Синхронизация** с сервером `https://epyur.fvds.ru` через JWT из ЦУП СБЕ
  (`getService('sbe-apstore').auth.getToken('contacts')`): push `/api/contacts/sync/push`,
  pull `/api/contacts/sync/pull`, delete `/api/contacts/delete`. Сервер — каноническое
  хранилище, локальный JSON — кэш. Конфликты — LWW по `updated_at`.
- **Локальная БД**: `yourbase/sbe_contacts/contacts_data.json`
  (`{"contacts": [...], "org_types": [...], "pending_deletes": [...]}`).
  Модель `ContactItem` совместима с серверным `Contact`.
- **Несинхронизированные записи** (`sync_status='local'`) автоматически загружаются
  на сервер при синхронизации (push всех local). `mergeFromServer` удаляет из кэша
  записи `synced`, отсутствующие на сервере (удалены на другом устройстве).
- **Одноразовая миграция** из legacy-БД монолита (`yourbase/contacts_data.json` /
  `yourbase/yougile_cache.json`, `type:"contact"`): `migrateLegacyOnce()` при пустой
  локальной БД, один раз за всё время жизни плагина — флаг `legacyMigrated` в настройках.
  `org_type` = название колонки YouGile (если монолит активен), `curator_email` = текущий
  email из ЦУП.
- **Куратор** контакта — автоматически последний создатель/редактор (`curator_email` из JWT).
  Удалять контакт может его куратор ИЛИ роль `admin`. Офлайн-удаление — очередь
  `pending_deletes`, flush при синке.
- **UI — фасад «LogicTEAM.Контакты»** (как sbe-documents/sbe-mailer): топбар (создание,
  crumb) + сайдбар (сворачивание, группа «Контакты», группа «Фильтры» — чекбоксы типов
  организации, Синхронизация) + контент. Контакты — **визитками** (макет C: имя, должность,
  организация, контакты в 2 колонки, куратор внизу, QR-превью справа).
- **Клик по визитке** — разворот на месте (вариант B): карточка увеличивается, в правую
  зону встаёт QR (vCard 3.0, библиотека `qrcode`, тёмный #FF0000), в правом нижнем углу —
  значок ✏️ (модалка редактирования только по клику на ✏️), кнопка «⬇ PNG» для сохранения QR.
- **Точка входа** — магазин: «Установленные → Открыть» (`publishService('sbe-contacts', {open})`).

## Структура

| Файл | Что это |
|---|---|
| `src/main.ts` | `SbeContactsPlugin`: настройки, БД, syncService, миграция, view, publishService |
| `src/database/contacts-db.ts` | `ContactsDatabase`: кэш JSON, mergeFromServer (LWW), importLegacy, dedupe, pending_deletes, org_types |
| `src/services/sync.service.ts` | `ContactsSyncService`: push/pull/delete, JWT из ЦУП, 401/403, таймауты |
| `src/ui/contacts-view.ts` | `ContactsView`: фасад «LogicTEAM.Контакты», визитки, разворот с QR, модалки создания/редактирования, удаление, поиск, фильтры. `ContactEditModal`, `ConfirmModal` |
| `src/ui/settings-tab.ts` | Настройки: apiUrl, раздел «Права доступа» |
| `src/types/contacts.ts` | `ContactItem`, `ContactsDbData`, `PushResponse`, `PullResponse`, `DeleteResponse`, legacy-типы |
| `src/styles.css` | Классы `tn-cont-*` на семантических токенах |

## Настройки (data.json)

`apiUrl` (default `https://epyur.fvds.ru`), `legacyMigrated` (default `false`, служебный —
без UI, не трогать вручную).

## Правила

- `catch(e: unknown)` + `errorMessage()`; `requestUrl()`; `window.setTimeout()`; без `any`;
  UI на русском; автор — Полищук Евгений (polishchuk@tn.ru). Классы `tn-cont-*` / `tn-btn*`
  / `tn-table` на семантических токенах sbe-core.
- Коммиты/пуши — только по явной команде пользователя.
- **«Фиксируй» = поднять версию (+0.0.1 в `manifest.json` и `package.json`), обновить
  документацию (AGENTS.md/specification.md), подготовить сообщение для коммита и
  СПРОСИТЬ подтверждение коммита и пуша.** Без явного подтверждения пользователя
  коммит/push не выполнять.

## История работ

### 2026-08-20 — v0.1.1 (фикс: org_type показывался UUID колонки YouGile вместо названия)
- **Найдено пользователем**: в фильтрах «Тип организации» выводились ID (UUID колонок
  YouGile, например `1616e06a-…`), а не названия групп. Причина: миграция строила маппинг
  колонок (`colTitle`) только в fallback-ветке `yougile_cache.json`; при чтении
  `contacts_data.json` (основной источник) маппинг не заполнялся, и `org_type` оставался
  сырым UUID.
- **Фикс**:
  - `migrateLegacyOnce()` — колонки YouGile читаются всегда (маппинг `UUID → название`
    строится независимо от источника контактов);
  - `fixLegacyOrgTypes()` — автопочинка уже мигрированных контактов (идемпотентна, при
    каждом старте): если `org_type` совпадает с ID колонки в `yougile_cache.json`,
    заменяется на название, поднимается `updated_at` и ставится `sync_status='local'`,
    чтобы исправление уехало на сервер push'ем (без поднятия времени LWW оставил бы UUID);
    реестр `org_types` пересобирается.
- `setOrgTypes()` добавлен в `contacts-db.ts`.
- Версия 0.1.0 → **0.1.1** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK.

### 2026-08-20 — v0.1.0 (создание)
- Плагин вынесен из монолита `yougile-tntn` (модуль «Контакты», `ui/contacts-view.ts`,
  `database/contact-db.ts`). Полный скаффолд: manifest, package (deps `qrcode`), esbuild
  (бандл sbe-core + styles), tsconfig.
- Сервер: `server_back/contacts-service/` (Go-контейнер `contacts`, БД `contacts`,
  Caddy `/api/contacts/*`, auth-service seed `contacts`) — задеплоен на VDS, E2E зелёный
  (health, push/pull, delete куратором/админом, 401/403, permissions/me, common-access).
- БД-кэш + LWW-синхронизация + очередь удалений + миграция из `contacts_data.json`,
  view (фасад + визитки + QR vCard + разворот), settings (Права доступа).
  `publishService('sbe-contacts')`.
- `sbe-core`: добавлены `SbeContactsApi`, `'sbe-contacts'` в `SbeServiceMap`,
  `getServiceName` → «Контакты»; пересобраны все SBE-плагины.
- Реестр: запись `sbe-contacts` (hasView, tools, ownerEmail); registry.json синхронизирован
  на сервер; community-plugins.json дополнен.

## Статистика ошибок и отступлений

- Нарушений правил нет: 0 `any`, 0 `fetch`, 0 инлайн-стилей, `window.setTimeout` корректен,
  все `catch(e: unknown)` + `errorMessage()`.
- `npx tsc --noEmit` EXIT=0, `npm run build` OK (без предупреждений).
