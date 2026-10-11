import type { Knex } from 'knex';
import { sha256Hex } from '../../common/crypto';
import { NotFoundError } from '../../common/errors';
import { CHANNELS, type Channel, type Locale } from '../../domain/types';
import type { ChannelTemplate, TemplateStore } from './engine';
import { channelTemplate, type TemplateSourceEntry } from './source';

export interface TemplateRow {
  id: string;
  event_type: string;
  channel: Channel;
  locale: Locale;
  active_version: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface TemplateVersionRow {
  id: string;
  template_id: string;
  version: number;
  subject: string | null;
  title: string | null;
  body: string;
  checksum: string;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  created_by: string;
  created_at: Date;
}

/** PostgreSQL-backed versioned templates with a short in-process cache. */
export class TemplateRepository implements TemplateStore {
  private readonly cache = new Map<string, { value: ChannelTemplate | null; expires: number }>();

  constructor(
    private readonly db: Knex,
    private readonly cacheTtlMs = 30000,
  ) {}

  async getActive(
    eventType: string,
    channel: Channel,
    locale: Locale,
  ): Promise<ChannelTemplate | null> {
    const key = `${eventType}|${channel}|${locale}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const row = (await this.db('templates as t')
      .join('template_versions as v', function joinActive() {
        this.on('v.template_id', '=', 't.id').andOn('v.version', '=', 't.active_version');
      })
      .where({ 't.event_type': eventType, 't.channel': channel, 't.locale': locale })
      .first('t.id as template_id', 'v.version', 'v.subject', 'v.title', 'v.body')) as
      | {
          template_id: string;
          version: number;
          subject: string | null;
          title: string | null;
          body: string;
        }
      | undefined;
    const value: ChannelTemplate | null = row
      ? {
          templateId: row.template_id,
          version: row.version,
          subject: row.subject,
          title: row.title,
          body: row.body,
        }
      : null;
    this.cache.set(key, { value, expires: Date.now() + this.cacheTtlMs });
    return value;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async list(filter: {
    eventType?: string;
    channel?: Channel;
    locale?: Locale;
  }): Promise<TemplateRow[]> {
    const q = this.db('templates').select('*');
    if (filter.eventType) q.where('event_type', filter.eventType);
    if (filter.channel) q.where('channel', filter.channel);
    if (filter.locale) q.where('locale', filter.locale);
    return (await q.orderBy(['event_type', 'channel', 'locale']).limit(1000)) as TemplateRow[];
  }

  async get(templateId: string): Promise<TemplateRow> {
    const row = (await this.db('templates').where({ id: templateId }).first()) as
      | TemplateRow
      | undefined;
    if (!row) throw new NotFoundError('Template', templateId);
    return row;
  }

  async versions(templateId: string): Promise<TemplateVersionRow[]> {
    await this.get(templateId);
    return (await this.db('template_versions')
      .where({ template_id: templateId })
      .orderBy('version', 'desc')) as TemplateVersionRow[];
  }

  async version(templateId: string, version: number): Promise<TemplateVersionRow> {
    const row = (await this.db('template_versions')
      .where({ template_id: templateId, version })
      .first()) as TemplateVersionRow | undefined;
    if (!row) throw new NotFoundError('Template version', `${templateId}@${version}`);
    return row;
  }

  async createVersion(input: {
    eventType: string;
    channel: Channel;
    locale: Locale;
    subject?: string | null;
    title?: string | null;
    body: string;
    activate: boolean;
    createdBy: string;
  }): Promise<{ template: TemplateRow; version: TemplateVersionRow }> {
    const result = await this.db.transaction(async (trx) => {
      await trx('templates')
        .insert({ event_type: input.eventType, channel: input.channel, locale: input.locale })
        .onConflict(['event_type', 'channel', 'locale'])
        .ignore();
      const template = (await trx('templates')
        .where({ event_type: input.eventType, channel: input.channel, locale: input.locale })
        .forUpdate()
        .first()) as TemplateRow;
      const max = (await trx('template_versions')
        .where({ template_id: template.id })
        .max('version as v')
        .first()) as { v: number | null } | undefined;
      const versionNo = (max?.v ?? 0) + 1;
      const [version] = (await trx('template_versions')
        .insert({
          template_id: template.id,
          version: versionNo,
          subject: input.subject ?? null,
          title: input.title ?? null,
          body: input.body,
          checksum: sha256Hex(
            `${input.subject ?? ''}\u0000${input.title ?? ''}\u0000${input.body}`,
          ),
          status: input.activate ? 'ACTIVE' : 'DRAFT',
          created_by: input.createdBy,
        })
        .returning('*')) as TemplateVersionRow[];
      if (input.activate) await this.activateInTrx(trx, template.id, versionNo);
      const fresh = (await trx('templates').where({ id: template.id }).first()) as TemplateRow;
      if (!version) throw new Error('template version insert failed');
      return { template: fresh, version };
    });
    this.invalidate();
    return result;
  }

  async activate(templateId: string, version: number): Promise<void> {
    await this.db.transaction((trx) => this.activateInTrx(trx, templateId, version));
    this.invalidate();
  }

  private async activateInTrx(
    trx: Knex.Transaction,
    templateId: string,
    version: number,
  ): Promise<void> {
    const exists = (await trx('template_versions')
      .where({ template_id: templateId, version })
      .first('id')) as { id: string } | undefined;
    if (!exists) throw new NotFoundError('Template version', `${templateId}@${version}`);
    await trx('template_versions')
      .where({ template_id: templateId, status: 'ACTIVE' })
      .whereNot({ version })
      .update({ status: 'RETIRED' });
    await trx('template_versions')
      .where({ template_id: templateId, version })
      .update({ status: 'ACTIVE' });
    await trx('templates')
      .where({ id: templateId })
      .update({ active_version: version, updated_at: trx.fn.now() });
  }

  /** Seeds version 1 for every (event, channel, locale) that has no template yet. */
  async seed(entries: TemplateSourceEntry[], createdBy = 'seed'): Promise<number> {
    let created = 0;
    for (const e of entries) {
      for (const channel of CHANNELS) {
        const existing = (await this.db('templates')
          .where({ event_type: e.eventType, channel, locale: e.locale })
          .first('id')) as { id: string } | undefined;
        if (existing) continue;
        const t = channelTemplate(e, channel);
        await this.createVersion({
          eventType: e.eventType,
          channel,
          locale: e.locale,
          subject: t.subject ?? null,
          title: t.title ?? null,
          body: t.body,
          activate: true,
          createdBy,
        });
        created++;
      }
    }
    return created;
  }
}
