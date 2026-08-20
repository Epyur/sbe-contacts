import { requestUrl, RequestUrlParam } from 'obsidian';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import type { ContactsDatabase } from '../database/contacts-db';
import type { ContactItem, PushResponse, PullResponse, DeleteResponse } from '../types/contacts';

export interface SyncResult {
  pushed: number;
  pulled: number;
  deleted: number;
}

export interface MyPermission {
  email: string;
  role: string;
  hasAccess: boolean;
}

/** Синхронизация с contacts-service через JWT из ЦУП. Сервер — канон, локально — кэш. */
export class ContactsSyncService {
  private db: ContactsDatabase;
  private getApiUrl: () => string;

  constructor(db: ContactsDatabase, getApiUrl: () => string) {
    this.db = db;
    this.getApiUrl = getApiUrl;
  }

  get baseUrl(): string {
    return this.getApiUrl().trim().replace(/\/+$/, '');
  }

  /** Полный цикл: push несинхронизированных → flush удалений → pull + merge. */
  async sync(): Promise<SyncResult> {
    const token = await this.getToken();
    const dirty = this.db.getAll().filter(c => c.sync_status === 'local');
    let pushed = 0;
    if (dirty.length > 0) {
      const res = await this.push(token, dirty);
      pushed = res.inserted + res.updated;
      for (const c of dirty) c.sync_status = 'synced';
      await this.db.save();
    }
    let deleted = 0;
    const pending = this.db.getPendingDeletes();
    for (const id of pending) {
      try {
        const res = await this.deleteOnServer(token, id);
        if (res.deleted > 0) {
          this.db.delete(id);
          deleted++;
        }
      } catch (e: unknown) {
        console.warn('Контакты: не удалось выполнить отложенное удаление:', errorMessage(e));
      }
    }
    if (deleted > 0) {
      await this.db.save();
    }
    const pulled = await this.pull(token);
    this.db.mergeFromServer(pulled.contacts);
    await this.db.save();
    return { pushed, pulled: pulled.contacts.length, deleted };
  }

  private async getToken(): Promise<string> {
    const apstore = await getService('sbe-apstore');
    return apstore.auth.getToken('contacts');
  }

  private async push(token: string, contacts: ContactItem[]): Promise<PushResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/contacts/sync/push`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ contacts }),
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as PushResponse;
    } catch (e: unknown) {
      console.warn('Контакты: не JSON в ответе push:', errorMessage(e));
      return { inserted: 0, updated: 0 };
    }
  }

  private async pull(token: string): Promise<PullResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/contacts/sync/pull`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as PullResponse;
    } catch (e: unknown) {
      console.warn('Контакты: не JSON в ответе pull:', errorMessage(e));
      return { contacts: [] };
    }
  }

  /** Удаление контакта на сервере (admin или куратор). Берёт JWT из ЦУП. */
  async delete(id: number): Promise<DeleteResponse> {
    const token = await this.getToken();
    return this.deleteOnServer(token, id);
  }

  /** Удаление контакта на сервере (admin или куратор). */
  async deleteOnServer(token: string, id: number): Promise<DeleteResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/contacts/delete`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as DeleteResponse;
    } catch (e: unknown) {
      console.warn('Контакты: не JSON в ответе delete:', errorMessage(e));
      return { deleted: 0 };
    }
  }

  /** Возвращает роль текущего пользователя ({email, role, hasAccess}). */
  async getMyPermission(): Promise<MyPermission> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/contacts/permissions/me`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as MyPermission;
    } catch (e: unknown) {
      console.warn('Контакты: не JSON в ответе permissions/me:', errorMessage(e));
      return { email: '', role: '', hasAccess: false };
    }
  }

  /** Список прав (для admin). */
  async listPermissions(): Promise<Array<{ email: string; role: string }>> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/contacts/permissions`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { permissions?: Array<{ email: string; role: string }> };
      return Array.isArray(data.permissions) ? data.permissions : [];
    } catch (e: unknown) {
      console.warn('Контакты: не JSON в ответе permissions:', errorMessage(e));
      return [];
    }
  }

  /** Устанавливает/отзывает роль (для admin). role='' — отозвать. */
  async setPermission(email: string, role: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/contacts/permissions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, role }),
    });
    this.assertOk(res);
  }

  /** Текущий уровень общего доступа (для admin). */
  async getCommonAccess(): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/contacts/common-access`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { level?: string };
      return data.level || '';
    } catch (e: unknown) {
      console.warn('Контакты: не JSON в ответе common-access:', errorMessage(e));
      return '';
    }
  }

  /** Устанавливает уровень общего доступа (для admin). level='' — отключить. */
  async setCommonAccess(level: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/contacts/common-access`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level }),
    });
    this.assertOk(res);
  }

  private assertOk(res: { status: number; text: string }): void {
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
    if (res.status === 403) throw new Error('Нет прав доступа к контактам. Обратитесь к администратору.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
  }

  private errorText(res: { status: number; text: string }): string {
    if (!res.text) return '';
    try {
      const data = JSON.parse(res.text) as { error?: string };
      return data.error || '';
    } catch (e: unknown) {
      console.warn('Контакты: ответ сервера не JSON:', errorMessage(e));
      return '';
    }
  }

  /** requestUrl в Obsidian не имеет таймаута — без обёртки зависший сервер не даст ответа никогда. */
  private async request(
    param: RequestUrlParam,
    timeoutMs = 30000,
  ): Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }> {
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ ...param, throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }
}
