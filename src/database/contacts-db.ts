import { App } from 'obsidian';
import type { ContactItem, ContactsDbData } from '../types/contacts';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const DB_DIR = 'yourbase/sbe_contacts';
const DB_PATH = 'yourbase/sbe_contacts/contacts_data.json';

/** Локальная БД контактов (кэш; сервер — каноническое хранилище). */
export class ContactsDatabase {
  private app: App;
  private data: ContactsDbData = { contacts: [], org_types: [], pending_deletes: [] };

  constructor(app: App) {
    this.app = app;
  }

  async init(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(DB_PATH);
      if (exists) {
        const content = await adapter.read(DB_PATH);
        const parsed = JSON.parse(content) as Partial<ContactsDbData>;
        this.data = {
          contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
          org_types: Array.isArray(parsed.org_types) ? parsed.org_types : [],
          pending_deletes: Array.isArray(parsed.pending_deletes) ? parsed.pending_deletes : [],
        };
      }
    } catch (e: unknown) {
      console.error('Контакты: не удалось прочитать БД:', errorMessage(e));
    }
  }

  private async ensureDataDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(DB_DIR);
    if (!exists) {
      await adapter.mkdir(DB_DIR);
    }
  }

  async save(): Promise<void> {
    try {
      await this.ensureDataDir();
      await this.app.vault.adapter.write(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (e: unknown) {
      console.error('Контакты: не удалось сохранить БД:', errorMessage(e));
    }
  }

  getAll(): ContactItem[] {
    return this.data.contacts;
  }

  getById(id: number): ContactItem | undefined {
    return this.data.contacts.find(c => c.id === id);
  }

  add(contact: ContactItem): void {
    const idx = this.data.contacts.findIndex(c => c.id === contact.id);
    if (idx !== -1) {
      this.data.contacts[idx] = contact;
    } else {
      this.data.contacts.push(contact);
    }
    this.rememberOrgType(contact.org_type);
  }

  update(id: number, updates: Partial<ContactItem>): void {
    const idx = this.data.contacts.findIndex(c => c.id === id);
    if (idx !== -1) {
      this.data.contacts[idx] = { ...this.data.contacts[idx], ...updates };
      this.rememberOrgType(updates.org_type || '');
    }
  }

  delete(id: number): void {
    this.data.contacts = this.data.contacts.filter(c => c.id !== id);
  }

  /** Добавляет контакт в очередь удалений (при офлайне). */
  queueDelete(id: number): void {
    if (!this.data.pending_deletes.includes(id)) {
      this.data.pending_deletes.push(id);
    }
  }

  /** Снимает контакт с очереди удалений (удалён на сервере успешно). */
  unqueueDelete(id: number): void {
    this.data.pending_deletes = this.data.pending_deletes.filter(d => d !== id);
  }

  getPendingDeletes(): number[] {
    return this.data.pending_deletes;
  }

  getOrgTypes(): string[] {
    return this.data.org_types;
  }

  /** Добавляет тип организации в локальный реестр (для datalist), если его ещё нет. */
  addOrgType(name: string): boolean {
    const trimmed = (name || '').trim();
    if (!trimmed) return false;
    if (this.data.org_types.includes(trimmed)) return false;
    this.data.org_types.push(trimmed);
    return true;
  }

  private rememberOrgType(t: string): void {
    const trimmed = (t || '').trim();
    if (!trimmed) return;
    if (!this.data.org_types.includes(trimmed)) {
      this.data.org_types.push(trimmed);
    }
  }

  /** Полностью пересобирает реестр org_types (после массового исправления значений). */
  setOrgTypes(types: string[]): void {
    this.data.org_types = Array.from(new Set(types.filter(t => (t || '').trim())));
  }

  /** Удаляет дубликаты по id, оставляя самую свежую запись. */
  dedupe(): number {
    const seen = new Map<number, number>();
    const keep: ContactItem[] = [];
    let removed = 0;
    for (const c of this.data.contacts) {
      const existing = seen.get(c.id);
      if (existing === undefined) {
        seen.set(c.id, keep.length);
        keep.push(c);
        continue;
      }
      const prev = keep[existing];
      if (this.compareTime(c.updated_at, prev.updated_at) >= 0) {
        keep[existing] = c;
      }
      removed++;
    }
    this.data.contacts = keep;
    return removed;
  }

  /** Слияние контактов с сервера (канон). Сервер авторитетен при равном/новом updated_at.
   *  Записи synced, отсутствующие на сервере, удаляются (удалены на другом устройстве). */
  mergeFromServer(serverContacts: ContactItem[]): void {
    const serverIds = new Set<number>();
    for (const s of serverContacts) {
      serverIds.add(s.id);
      const local = this.getById(s.id);
      if (!local) {
        this.add({ ...s, sync_status: 'synced' });
        continue;
      }
      if (this.compareTime(s.updated_at, local.updated_at) >= 0) {
        this.data.contacts[this.data.contacts.indexOf(local)] = { ...s, sync_status: 'synced' };
        this.rememberOrgType(s.org_type);
      }
    }
    // Удаляем только синхронизированные записи, которых нет на сервере.
    // Локальные (несинхронизированные) остаются — их отправит следующий push.
    this.data.contacts = this.data.contacts.filter(c => {
      if (serverIds.has(c.id)) return true;
      if (c.sync_status === 'local') return true;
      return false;
    });
  }

  /** Импорт из легаси-контактов монолита (одноразовая миграция).
   *  Устойчив к повторным запускам: пропускает записи с тем же содержимым. */
  importLegacy(contacts: ContactItem[]): number {
    const now = new Date().toISOString();
    let added = 0;
    const existingKeys = new Set(this.data.contacts.map(c => this.contentKey(c)));
    for (const c of contacts) {
      if (this.getById(c.id)) continue;
      if (existingKeys.has(this.contentKey(c))) continue;
      this.data.contacts.push({
        ...c,
        sync_status: 'local',
        created_at: c.created_at || now,
        updated_at: c.updated_at || c.created_at || now,
      });
      this.rememberOrgType(c.org_type);
      existingKeys.add(this.contentKey(c));
      added++;
    }
    return added;
  }

  /** Ключ содержимого для дедупликации миграции (имя + email). */
  private contentKey(c: ContactItem): string {
    return `${(c.name || '').trim().toLowerCase()}|${(c.email || '').trim().toLowerCase()}`;
  }

  private compareTime(a: string, b: string): number {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta === tb ? 0 : ta > tb ? 1 : -1;
  }
}
