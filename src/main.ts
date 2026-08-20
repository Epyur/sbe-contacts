import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { ContactsDatabase } from './database/contacts-db';
import { ContactsSyncService } from './services/sync.service';
import { ContactsView, SBE_CONTACTS_VIEW_TYPE } from './ui/contacts-view';
import { ContactsSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService, getService } from '../../sbe-core/src/bridge';
import type { SbeContactsApi } from '../../sbe-core/src/types';
import type { ContactItem, LegacyContact } from './types/contacts';
import { errorMessage } from '../../sbe-core/src/utils/errors';

export interface SbeContactsSettings {
  apiUrl: string;
  /** Флаг одноразовой миграции из legacy-кэша монолита (защита от повторного импорта). */
  legacyMigrated: boolean;
}

const DEFAULT_SETTINGS: SbeContactsSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  legacyMigrated: false,
};

const LEGACY_CONTACTS_PATH = 'yourbase/contacts_data.json';
const LEGACY_CACHE_PATH = 'yourbase/yougile_cache.json';

export default class SbeContactsPlugin extends Plugin {
  settings!: SbeContactsSettings;
  contactsDb!: ContactsDatabase;
  syncService!: ContactsSyncService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.contactsDb = new ContactsDatabase(this.app);
    await this.contactsDb.init();
    this.syncService = new ContactsSyncService(this.contactsDb, () => this.settings.apiUrl);

    // Одноразовая миграция из legacy-кэша монолита (contacts_data.json / yougile_cache.json).
    await this.migrateLegacyOnce();

    this.registerView(
      SBE_CONTACTS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new ContactsView(leaf, this),
    );

    this.addSettingTab(new ContactsSettingsTab(this.app, this));

    publishService<SbeContactsApi>('sbe-contacts', {
      open: async () => {
        await this.activateView();
      },
    }, {
      version: this.manifest.version,
      name: this.manifest.name,
    });
  }

  onunload(): void {
    unpublishService('sbe-contacts');
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as Partial<SbeContactsSettings>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SBE_CONTACTS_VIEW_TYPE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: SBE_CONTACTS_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  /** Текущий авторизованный email из ЦУП (куратор по умолчанию при миграции). */
  private async currentUserEmail(): Promise<string> {
    try {
      const apstore = await getService('sbe-apstore');
      const status = apstore.auth.getStatus();
      return (status.email || '').trim();
    } catch (e: unknown) {
      console.warn('Контакты: не удалось получить email из ЦУП:', errorMessage(e));
      return '';
    }
  }

  /** Импорт контактов (type:contact) из монолита. Выполняется один раз (флаг legacyMigrated). */
  private async migrateLegacyOnce(): Promise<void> {
    const removed = this.contactsDb.dedupe();
    if (removed > 0) {
      await this.contactsDb.save();
      console.warn(`Контакты: удалено ${removed} дубликатов по id из локальной БД`);
    }

    // Флаг в настройках гарантирует одноразовость даже при пустой/очищенной локальной БД.
    if (this.settings.legacyMigrated) return;
    if (this.contactsDb.getAll().length > 0) {
      this.settings.legacyMigrated = true;
      await this.saveSettings();
      return;
    }

    const adapter = this.app.vault.adapter;
    let raw: LegacyContact[] = [];
    let colTitle = new Map<string, string>();
    try {
      if (await adapter.exists(LEGACY_CONTACTS_PATH)) {
        const parsed = JSON.parse(await adapter.read(LEGACY_CONTACTS_PATH)) as {
          contacts?: LegacyContact[];
        };
        raw = Array.isArray(parsed.contacts) ? parsed.contacts : [];
      }
      if (raw.length === 0 && await adapter.exists(LEGACY_CACHE_PATH)) {
        const parsed = JSON.parse(await adapter.read(LEGACY_CACHE_PATH)) as {
          tasks?: Array<{
            id: string;
            title: string;
            description: string;
            columnId: string;
          }>;
          columns?: Array<{ id: string; title: string }>;
        };
        const columns = Array.isArray(parsed.columns) ? parsed.columns : [];
        colTitle = new Map(columns.map(c => [c.id, c.title]));
        const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        for (const t of tasks) {
          if (!t.description) continue;
          const desc = t.description.trim();
          if (!desc.startsWith('{')) continue;
          try {
            const parsedDesc = JSON.parse(desc) as {
              type?: string;
              name?: string;
              phone?: string;
              email?: string;
              organization?: string;
              position?: string;
              orgType?: string;
              notes?: string;
            };
            if (parsedDesc.type !== 'contact') continue;
            raw.push({
              id: t.id,
              taskId: t.id,
              name: parsedDesc.name || t.title,
              phone: parsedDesc.phone || '',
              email: parsedDesc.email || '',
              organization: parsedDesc.organization || '',
              position: parsedDesc.position || '',
              orgType: parsedDesc.orgType || t.columnId || '',
              notes: parsedDesc.notes || '',
              createdAt: '',
              updatedAt: '',
            });
          } catch {
            // невалидный JSON — пропускаем
          }
        }
      }
    } catch (e: unknown) {
      console.warn('Контакты: не удалось прочитать legacy-БД:', errorMessage(e));
    }

    if (raw.length === 0) {
      this.settings.legacyMigrated = true;
      await this.saveSettings();
      return;
    }

    const curator = await this.currentUserEmail();
    const now = new Date().toISOString();
    const items: ContactItem[] = [];
    for (let i = 0; i < raw.length; i++) {
      const lc = raw[i];
      const orgType = colTitle.get(String(lc.orgType)) || lc.orgType || '';
      const created = lc.createdAt || lc.updatedAt || now;
      items.push({
        id: Date.now() + Math.floor(Math.random() * 100000) + i,
        name: lc.name || '',
        phone: lc.phone || '',
        email: lc.email || '',
        organization: lc.organization || '',
        position: lc.position || '',
        org_type: orgType,
        notes: lc.notes || '',
        curator_email: curator,
        created_at: created,
        updated_at: lc.updatedAt || created,
        sync_status: 'local',
      });
    }

    const added = this.contactsDb.importLegacy(items);
    await this.contactsDb.save();
    this.settings.legacyMigrated = true;
    await this.saveSettings();
    if (added > 0) {
      new Notice(`Контакты: импортировано ${added} контактов из legacy-БД. Они будут отправлены на сервер при синхронизации.`);
    }
  }
}
