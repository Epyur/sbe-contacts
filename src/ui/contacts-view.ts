import { ItemView, Notice, WorkspaceLeaf, Modal, App } from 'obsidian';
import type SbeContactsPlugin from '../main';
import type { ContactItem } from '../types/contacts';
import QRCode from 'qrcode';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

export const SBE_CONTACTS_VIEW_TYPE = 'sbe-contacts-view';

type NavKey = 'contacts';

const PAGE_META: Record<NavKey, { title: string; sub: string }> = {
  contacts: { title: 'Все контакты', sub: 'Картотека контактов' },
};

/** Экранирование строки для vCard (обратный слэш, точка с запятой, запятая, перенос). */
function vcardEsc(v: string): string {
  return (v || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError && e.message === 'Failed to fetch') return true;
  if (e instanceof Error && /network|fetch|offline|econnrefused|enotfound|dns|timeout/i.test(e.message)) return true;
  return false;
}

/** Простое подтверждение через модалку (замена window.confirm). */
class ConfirmModal extends Modal {
  private text: string;
  private onOk: () => void;

  constructor(app: App, text: string, onOk: () => void) {
    super(app);
    this.text = text;
    this.onOk = onOk;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('tn-cont-modal');
    contentEl.createDiv({ cls: 'tn-cont-modal-text', text: this.text });
    const actions = contentEl.createDiv({ cls: 'tn-cont-actions' });
    const okBtn = actions.createEl('button', { text: 'Удалить', cls: 'tn-btn tn-btn-primary tn-cont-danger' });
    okBtn.addEventListener('click', () => {
      this.onOk();
      this.close();
    });
    const cancelBtn = actions.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Модалка создания/редактирования контакта. */
class ContactEditModal extends Modal {
  private plugin: SbeContactsPlugin;
  private contact: ContactItem | null;
  private myEmail: string;
  private onSaved: (contact: ContactItem) => void;

  constructor(plugin: SbeContactsPlugin, contact: ContactItem | null, myEmail: string, onSaved: (contact: ContactItem) => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.contact = contact;
    this.myEmail = myEmail;
    this.onSaved = onSaved;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('tn-cont-modal');
    const c = this.contact;

    contentEl.createEl('h3', { text: c ? `✏️ ${c.name}` : '➕ Новый контакт' });

    const orgTypes = this.plugin.contactsDb.getOrgTypes();
    const datalistId = 'tn-cont-org-types';
    if (orgTypes.length > 0) {
      const dl = contentEl.createEl('datalist', { attr: { id: datalistId } });
      for (const t of orgTypes) {
        dl.createEl('option', { value: t });
      }
    }

    const grid = contentEl.createDiv({ cls: 'tn-form-grid' });
    const fields: Array<{ label: string; key: keyof Pick<ContactItem, 'name' | 'phone' | 'email' | 'organization' | 'position' | 'org_type'>; placeholder: string }> = [
      { label: 'Имя', key: 'name', placeholder: 'ФИО' },
      { label: 'Телефон', key: 'phone', placeholder: '+7 (999) 123-45-67' },
      { label: 'Email', key: 'email', placeholder: 'email@example.com' },
      { label: 'Организация', key: 'organization', placeholder: 'Название организации' },
      { label: 'Должность', key: 'position', placeholder: 'Должность' },
      { label: 'Тип организации', key: 'org_type', placeholder: 'Например: Испытательная лаборатория' },
    ];
    const inputs: Record<string, HTMLInputElement> = {};
    for (const f of fields) {
      const wrap = grid.createEl('label');
      wrap.createSpan({ text: f.label });
      const inp = wrap.createEl('input', { attr: { type: 'text', placeholder: f.placeholder, list: datalistId }, cls: 'tn-cont-input' });
      if (c) inp.value = c[f.key];
      inputs[f.key] = inp;
    }

    const notesWrap = grid.createEl('label', { cls: 'span2' });
    notesWrap.createSpan({ text: 'Примечание' });
    const notesInput = notesWrap.createEl('textarea', { cls: 'tn-cont-textarea' });
    if (c) notesInput.value = c.notes;

    const actions = contentEl.createDiv({ cls: 'tn-actions' });
    const saveBtn = actions.createEl('button', { text: c ? '💾 Сохранить' : '✅ Создать', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = actions.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.close());

    saveBtn.addEventListener('click', async () => {
      const name = inputs.name.value.trim();
      if (!name) {
        new Notice('Введите имя контакта');
        return;
      }
      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      cancelBtn.setAttr('disabled', 'true');

      const now = new Date().toISOString();
      const base = c ? { ...c } : {
        id: Date.now() + Math.floor(Math.random() * 100000),
        created_at: now,
        sync_status: 'local' as const,
      };
      const updated: ContactItem = {
        ...base,
        name,
        phone: inputs.phone.value.trim(),
        email: inputs.email.value.trim(),
        organization: inputs.organization.value.trim(),
        position: inputs.position.value.trim(),
        org_type: inputs.org_type.value.trim(),
        notes: notesInput.value.trim(),
        curator_email: this.myEmail,
        updated_at: now,
      };
      this.plugin.contactsDb.add(updated);
      await this.plugin.contactsDb.save();
      this.onSaved(updated);
      this.close();
      new Notice(c ? 'Контакт обновлён' : 'Контакт создан');
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ContactsView extends ItemView {
  plugin: SbeContactsPlugin;
  private rootEl!: HTMLElement;
  private navEl!: HTMLElement;
  private filtersEl!: HTMLElement;
  private pageTitleEl!: HTMLElement;
  private pageSubEl!: HTMLElement;
  private crumbEl!: HTMLElement;
  private collapseLabel!: HTMLElement;
  private bodyEl!: HTMLElement;
  private key: NavKey = 'contacts';
  private collapsed = false;
  private selectedOrgTypes: Set<string> = new Set();
  private searchQuery = '';
  private searchTimeout: number | null = null;
  private myRole = '';
  private myEmail = '';
  private expandedId: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: SbeContactsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SBE_CONTACTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'LogicTEAM.Контакты';
  }

  getIcon(): string {
    return 'user';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass('tn-cont-container');
    this.rootEl = container.createDiv({ cls: 'tn-cont-app' });

    try {
      const me = await this.plugin.syncService.getMyPermission();
      this.myRole = me.hasAccess ? me.role : '';
      this.myEmail = me.email;
    } catch (e: unknown) {
      console.warn('Контакты: не удалось получить роль:', errorMessage(e));
      this.myRole = '';
      this.myEmail = '';
    }

    this.buildShell();
    this.renderPage();
  }

  refresh(): void {
    this.renderPage();
  }

  private get canEdit(): boolean {
    return this.myRole === 'editor' || this.myRole === 'admin';
  }

  private canDelete(contact: ContactItem): boolean {
    return this.myRole === 'admin' || contact.curator_email === this.myEmail;
  }

  // ---- Каркас ----

  private buildShell(): void {
    const topbar = this.rootEl.createDiv({ cls: 'tn-cont-topbar' });
    topbar.createDiv({ cls: 'tn-cont-module-title', text: 'LogicTEAM.Контакты' });
    this.crumbEl = topbar.createDiv({ cls: 'tn-cont-crumb' });
    const spacer = topbar.createDiv({ cls: 'tn-cont-spacer' });
    spacer.empty();
    if (this.canEdit) {
      const createBtn = topbar.createEl('button', { text: '＋ Новый контакт', cls: 'tn-cont-create' });
      createBtn.addEventListener('click', () => this.showCreateForm());
    }

    const main = this.rootEl.createDiv({ cls: 'tn-cont-main' });

    const sidebar = main.createDiv({ cls: 'tn-cont-sidebar' });

    const collapseBtn = sidebar.createDiv({ cls: 'tn-cont-collapse' });
    collapseBtn.createSpan({ text: '▧' });
    this.collapseLabel = collapseBtn.createSpan({ cls: 'tn-cont-collapse-lbl', text: 'Свернуть' });
    collapseBtn.addEventListener('click', () => this.toggleCollapse());

    this.navEl = sidebar.createDiv({ cls: 'tn-cont-nav' });
    this.buildNav();

    const actions = sidebar.createDiv({ cls: 'tn-cont-sidebar-actions' });
    const syncBtn = actions.createEl('button', { cls: 'tn-cont-nav-action' });
    syncBtn.createSpan({ text: '🔄' });
    syncBtn.createSpan({ cls: 'tn-cont-nav-lbl', text: 'Синхронизация' });
    syncBtn.addEventListener('click', () => { void this.syncAndRender(); });

    const content = main.createDiv({ cls: 'tn-cont-content' });
    this.pageTitleEl = content.createEl('h1', { cls: 'tn-cont-page-title' });
    this.pageSubEl = content.createDiv({ cls: 'tn-cont-page-sub' });
    this.bodyEl = content.createDiv();
  }

  private buildNav(): void {
    this.navEl.empty();

    const contGroup = this.navEl.createEl('button', { cls: 'tn-cont-grp' });
    contGroup.createSpan({ cls: 'tn-cont-grp-ico', text: '👤' });
    contGroup.createSpan({ cls: 'tn-cont-grp-lbl', text: 'Контакты' });
    contGroup.createSpan({ cls: 'tn-cont-grp-chev', text: '▶' });
    contGroup.addEventListener('click', () => {
      contGroup.classList.toggle('open');
      contGroup.classList.toggle('active');
    });
    const contSubmenu = this.navEl.createDiv({ cls: 'tn-cont-submenu' });
    const all = contSubmenu.createEl('a', { cls: 'tn-cont-nav-item', attr: { href: '#' } });
    all.createSpan({ cls: 'tn-cont-nav-lbl', text: 'Все контакты' });
    all.dataset.key = 'contacts';
    all.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.key = 'contacts';
      this.syncNavActive();
      this.renderPage();
    });
    contGroup.classList.add('open', 'active');

    const filterGroup = this.navEl.createEl('button', { cls: 'tn-cont-grp' });
    filterGroup.createSpan({ cls: 'tn-cont-grp-ico', text: '🔍' });
    filterGroup.createSpan({ cls: 'tn-cont-grp-lbl', text: 'Фильтры' });
    filterGroup.createSpan({ cls: 'tn-cont-grp-chev', text: '▶' });
    filterGroup.addEventListener('click', () => {
      filterGroup.classList.toggle('open');
      filterGroup.classList.toggle('active');
    });
    this.filtersEl = this.navEl.createDiv({ cls: 'tn-cont-submenu tn-cont-filters-nav' });
    filterGroup.classList.add('open');
    this.renderSidebarFilters();

    this.syncNavActive();
  }

  private renderSidebarFilters(): void {
    if (!this.filtersEl) return;
    this.filtersEl.empty();
    const types = this.plugin.contactsDb.getOrgTypes();
    if (types.length === 0) {
      this.filtersEl.createDiv({ cls: 'tn-cont-nav-empty' }).setText('Типов пока нет');
      return;
    }
    for (const t of types) {
      const wrapper = this.filtersEl.createEl('label', { cls: 'tn-cont-filter-label tn-cont-sidebar-filter' });
      const cb = wrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-cont-cb' });
      cb.checked = this.selectedOrgTypes.has(t);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selectedOrgTypes.add(t);
        else this.selectedOrgTypes.delete(t);
        this.renderPage();
      });
      wrapper.createEl('span').setText(t);
    }
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.rootEl.classList.toggle('collapsed', this.collapsed);
    if (this.collapseLabel) {
      this.collapseLabel.setText(this.collapsed ? 'Развернуть' : 'Свернуть');
    }
  }

  private syncNavActive(): void {
    this.navEl.querySelectorAll('.tn-cont-nav-item').forEach((el) => {
      const navEl = el as HTMLElement;
      navEl.classList.toggle('active', navEl.dataset.key === this.key);
    });
  }

  // ---- Страница ----

  private renderPage(): void {
    const meta = PAGE_META[this.key];
    this.crumbEl.setText(meta.title);
    this.pageTitleEl.setText(meta.title);
    this.pageSubEl.setText(meta.sub);

    this.bodyEl.empty();
    this.renderContactsView();
  }

  private getFilteredContacts(): ContactItem[] {
    let contacts = this.plugin.contactsDb.getAll();
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      contacts = contacts.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.organization.toLowerCase().includes(q) ||
        c.position.toLowerCase().includes(q));
    }
    if (this.selectedOrgTypes.size > 0) {
      contacts = contacts.filter(c => this.selectedOrgTypes.has(c.org_type));
    }
    return contacts;
  }

  private renderContactsView(): void {
    const container = this.bodyEl;
    container.empty();

    const searchInput = container.createEl('input', {
      attr: { type: 'text', placeholder: '🔍 Поиск по имени, телефону, email, организации...' },
      cls: 'tn-cont-input tn-cont-mb8',
    });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (this.searchTimeout) window.clearTimeout(this.searchTimeout);
      this.searchTimeout = window.setTimeout(() => this.renderPage(), 300);
    });

    const contacts = this.getFilteredContacts();
    if (contacts.length === 0) {
      container.createDiv({ cls: 'tn-cont-empty', text: 'Нет контактов. Нажмите «＋ Новый контакт», чтобы добавить.' });
      return;
    }

    const grid = container.createDiv({ cls: 'tn-cont-grid' });
    for (const c of contacts) {
      this.renderCard(grid, c);
    }
  }

  // ---- Визитка ----

  private renderCard(grid: HTMLElement, contact: ContactItem): void {
    const expanded = this.expandedId === contact.id;
    const card = grid.createDiv({ cls: 'tn-cont-card' });
    if (expanded) card.addClass('expanded');

    const head = card.createDiv({ cls: 'tn-cont-card-grid' });
    const info = head.createDiv({ cls: 'tn-cont-card-info' });
    info.createDiv({ cls: 'tn-cont-card-name', text: contact.name });
    if (contact.position) info.createDiv({ cls: 'tn-cont-card-pos', text: contact.position });
    if (contact.organization) info.createDiv({ cls: 'tn-cont-card-org', text: contact.organization });
    const qrZone = head.createDiv({ cls: 'tn-cont-card-qr' });
    if (expanded) {
      qrZone.addClass('live');
      const canvas = qrZone.createEl('canvas', { attr: { width: 170, height: 170 } });
      void this.renderQr(canvas, this.buildVCard(contact));
    } else {
      qrZone.createDiv({ cls: 'tn-cont-card-qr-ph', text: 'QR' });
    }

    const cols = card.createDiv({ cls: 'tn-cont-card-cols' });
    if (contact.phone) {
      const row = cols.createDiv({ cls: 'tn-cont-card-row' });
      row.createSpan({ cls: 'tn-cont-card-ic', text: '📞' });
      row.createSpan({ text: contact.phone });
    }
    if (contact.email) {
      const row = cols.createDiv({ cls: 'tn-cont-card-row' });
      row.createSpan({ cls: 'tn-cont-card-ic', text: '✉️' });
      row.createSpan({ text: contact.email });
    }
    if (contact.notes) {
      const row = cols.createDiv({ cls: 'tn-cont-card-row' });
      row.createSpan({ cls: 'tn-cont-card-ic', text: '📝' });
      row.createSpan({ cls: 'tn-cont-card-notes', text: contact.notes });
    }

    const cur = card.createDiv({ cls: 'tn-cont-card-cur' });
    cur.createSpan({ text: '🗂 Куратор:' });
    cur.createEl('b', { text: contact.curator_email || '—' });

    if (expanded) {
      const editIc = card.createEl('button', { cls: 'tn-cont-edit-ic', attr: { title: 'Редактировать' } });
      editIc.setText('✏️');
      editIc.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.showEditForm(contact);
      });
      if (this.canDelete(contact)) {
        const delBtn = card.createEl('button', { cls: 'tn-cont-del-btn', text: '🗑 Удалить' });
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.confirmDelete(contact);
        });
      }
      const pngBtn = card.createEl('button', { cls: 'tn-cont-png-btn', text: '⬇ PNG' });
      pngBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.downloadPng(this.buildVCard(contact), contact.name);
      });
    }

    card.addEventListener('click', () => {
      this.expandedId = this.expandedId === contact.id ? null : contact.id;
      this.renderPage();
    });
  }

  // ---- QR (vCard) ----

  private buildVCard(c: ContactItem): string {
    return [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `N:${vcardEsc(c.name)}`,
      `FN:${vcardEsc(c.name)}`,
      `TEL:${vcardEsc(c.phone)}`,
      `EMAIL:${vcardEsc(c.email)}`,
      `ORG:${vcardEsc(c.organization)}`,
      `TITLE:${vcardEsc(c.position)}`,
      `NOTE:${vcardEsc(c.notes)}`,
      'END:VCARD',
    ].join('\n');
  }

  private async renderQr(canvas: HTMLCanvasElement, vcard: string): Promise<void> {
    try {
      await QRCode.toCanvas(canvas, vcard, {
        width: 170,
        margin: 2,
        color: { dark: '#FF0000', light: '#FFFFFF' },
      });
    } catch (e: unknown) {
      console.warn('Контакты: ошибка генерации QR:', errorMessage(e));
    }
  }

  private async downloadPng(vcard: string, name: string): Promise<void> {
    try {
      const url = await QRCode.toDataURL(vcard, {
        width: 512,
        margin: 2,
        color: { dark: '#FF0000', light: '#FFFFFF' },
      });
      const a = document.createElement('a');
      a.href = url;
      a.download = `Контакты_${(name || 'contact').replace(/[\\/:*?"<>|]/g, '_')}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e: unknown) {
      new Notice(`Не удалось сохранить QR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- Создание / редактирование ----

  private showCreateForm(): void {
    new ContactEditModal(this.plugin, null, this.myEmail, (contact) => {
      this.afterSave(contact);
    }).open();
  }

  private showEditForm(contact: ContactItem): void {
    new ContactEditModal(this.plugin, contact, this.myEmail, (updated) => {
      this.afterSave(updated);
    }).open();
  }

  private async afterSave(contact: ContactItem): Promise<void> {
    this.renderPage();
    try {
      await this.plugin.syncService.sync();
      this.renderPage();
    } catch (e: unknown) {
      new Notice(`Контакт сохранён локально. Синхронизация позже: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- Удаление ----

  private confirmDelete(contact: ContactItem): void {
    new ConfirmModal(this.app, `Удалить контакт «${contact.name}»? Действие необратимо.`, () => {
      void this.deleteContact(contact);
    }).open();
  }

  private async deleteContact(contact: ContactItem): Promise<void> {
    try {
      const res = await this.plugin.syncService.delete(contact.id);
      if (res.deleted > 0) {
        this.plugin.contactsDb.delete(contact.id);
        await this.plugin.contactsDb.save();
        new Notice('Контакт удалён');
        this.expandedId = null;
        this.renderPage();
      }
    } catch (e: unknown) {
      if (isNetworkError(e)) {
        this.plugin.contactsDb.queueDelete(contact.id);
        this.plugin.contactsDb.delete(contact.id);
        await this.plugin.contactsDb.save();
        new Notice('Нет соединения. Удаление будет выполнено при синхронизации.');
        this.expandedId = null;
        this.renderPage();
      } else {
        new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ---- Синхронизация ----

  private async syncAndRender(): Promise<void> {
    try {
      const result = await this.plugin.syncService.sync();
      new Notice(`Синхронизировано: отправлено ${result.pushed}, получено ${result.pulled}, удалено ${result.deleted}`);
      this.renderPage();
    } catch (e: unknown) {
      new Notice(`Синхронизация: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
