/** Типы модуля контактов SBE. Модель совместима с contacts-service (server_back/contacts-service). */

export interface ContactItem {
  id: number;
  name: string;
  phone: string;
  email: string;
  organization: string;
  position: string;
  org_type: string;
  notes: string;
  /** Последний создатель/редактор (из JWT). Удалять может куратор или admin. */
  curator_email: string;
  created_at: string;
  updated_at: string;
  sync_status: 'local' | 'synced';
}

export interface ContactsDbData {
  contacts: ContactItem[];
  /** Локальный реестр использованных типов организации (для datalist в форме). */
  org_types: string[];
  /** Очередь удалений при офлайне: id контактов, которые нужно удалить на сервере. */
  pending_deletes: number[];
}

/** Ответ сервера на pull — массив контактов. */
export interface PullResponse {
  contacts: ContactItem[];
}

/** Ответ сервера на push — количество вставленных/обновлённых. */
export interface PushResponse {
  inserted: number;
  updated: number;
}

/** Ответ сервера на delete. */
export interface DeleteResponse {
  deleted: number;
}

/** Легаси-контакт из монолита (contacts_data.json / yougile_cache.json, type:contact). */
export interface LegacyContact {
  id: string | number;
  taskId?: string;
  name: string;
  phone: string;
  email: string;
  organization: string;
  position: string;
  orgType: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  sync_status?: string;
}
