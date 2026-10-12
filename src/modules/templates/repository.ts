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
  experiment_version: number | null;
  experiment_percent: number;
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

type Variants = {
  active: ChannelTemplate | null;
  experiment: ChannelTemplate | null;
  percent: number;
};

/** Deterministic 0–99 bucket for (template, user): a user always sees the same variant. */
export function abBucket(templateId: string, subject: string): number {
  return parseInt(sha256Hex(`${templateId}:${subject}`).slice(0, 8), 16) % 100;
}

/** PostgreSQL-backed versioned templates with a short in-process cache. */
export class TemplateRepository implements TemplateStore {
  private readonly cache = new Map<string, { value: Variants; expires: number }>();

  constructor(
    private readonly db: Knex,
    private readonly cacheTtlMs = 30000,
  ) {}

  async getActive(
    eventType: string,
    channel: Channel,
    locale: Locale,
    abSubject?: string,
  ): Promise<ChannelTemplate | null> {
    const key = `${eventType}|${channel}|${locale}`;
    let hit = this.cache.get(key);
    if (!hit || hit.expires <= Date.now()) {
      hit = {
        value: await this.loadVariants(eventType, channel, locale),
        expires: Date.now() + this.cacheTtlMs,
      };
      this.cache.set(key, hit);
    }
    const { active, experiment, percent } = hit.value;
    if (experiment?.templateId && abSubject && abBucket(experiment.templateId, abSubject) < percent)
      return experiment;
    return active;
  }

  private async loadVariants(
    eventType: string,
    channel: Channel,
    locale: Locale,
  ): Promise<Variants> {
    const t = (await this.db('templates')
      .where({ event_type: eventType, channel, locale })
      .first('id', 'active_version', 'experiment_version', 'experiment_percent')) as
      | Pick<TemplateRow, 'id' | 'active_version' | 'experiment_version' | 'experiment_percent'>
      | undefined;
    if (!t) return { active: null, experiment: null, percent: 0 };
    const versions = (await this.db('template_versions')
      .where({ template_id: t.id })
      .whereIn(
        'version',
        [t.active_version, t.experiment_version].filter((v) => v !== null),
      )
      .select('version', 'subject', 'title', 'body')) as Pick<
      TemplateVersionRow,
      'version' | 'subject' | 'title' | 'body'
    >[];
    const pick = (v: number | null): ChannelTemplate | null => {
      const row = versions.find((x) => x.version === v);
      return row ? { templateId: t.id, ...row } : null;
    };
    return {
      active: pick(t.active_version),
      experiment: t.experiment_percent > 0 ? pick(t.experiment_version) : null,
      percent: t.experiment_percent,
    };
  }

  /** Starts (percent > 0) or stops (percent 0) an A/B experiment for a template. */
  async setExperiment(templateId: string, version: number | null, percent: number): Promise<void> {
    if (version !== null) {
      const v = (await this.db('template_versions')
        .where({ template_id: templateId, version })
        .first('status')) as { status: string } | undefined;
      if (!v) throw new NotFoundError('Template version', `${templateId}@${version}`);
    }
    const n = await this.db('templates')
      .where({ id: templateId })
      .update({
        experiment_version: percent > 0 ? version : null,
        experiment_percent: percent > 0 ? percent : 0,
        updated_at: this.db.fn.now(),
      });
    if (n === 0) throw new NotFoundError('Template', templateId);
    this.invalidate();
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
