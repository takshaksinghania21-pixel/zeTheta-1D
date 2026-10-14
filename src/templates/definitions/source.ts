import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { CHANNELS, LOCALES, type Channel, type Locale } from '../../utils/types';
import type { ChannelTemplate, TemplateStore } from '../engine/engine';

const sourceSchema = z.object({
  locale: z.enum(LOCALES),
  templates: z.record(
    z.string(),
    z.strictObject({ title: z.string(), short: z.string(), long: z.string() }),
  ),
});

export const DIGEST_EVENT_TYPE = 'SYS-DIGEST';

export interface TemplateSourceEntry {
  eventType: string;
  locale: Locale;
  title: string;
  short: string;
  long: string;
}

export const TEMPLATES_DIR = path.resolve(__dirname, '../../../templates');

/** Loads every templates/<locale>.yaml file. */
export function loadTemplateSources(dir = TEMPLATES_DIR): TemplateSourceEntry[] {
  const entries: TemplateSourceEntry[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    const parsed = sourceSchema.parse(YAML.parse(readFileSync(path.join(dir, file), 'utf8')));
    for (const [eventType, t] of Object.entries(parsed.templates)) {
      entries.push({ eventType, locale: parsed.locale, ...t });
    }
  }
  return entries;
}

/** Maps the three source strings onto channel-specific template fields. */
export function channelTemplate(
  entry: TemplateSourceEntry,
  channel: Channel,
): Omit<ChannelTemplate, 'version'> {
  switch (channel) {
    case 'sms':
      return { body: entry.short };
    case 'push':
    case 'inapp':
      return { title: entry.title, body: entry.short };
    case 'whatsapp':
      return { body: entry.long };
    case 'email':
      return { subject: entry.title, body: entry.long };
  }
}

/** In-memory store built from the YAML sources (tests, previews, seeding). */
export class FileTemplateStore implements TemplateStore {
  private readonly map = new Map<string, ChannelTemplate>();
  constructor(entries: TemplateSourceEntry[] = loadTemplateSources()) {
    for (const e of entries) {
      for (const c of CHANNELS)
        this.map.set(`${e.eventType}|${c}|${e.locale}`, { version: 1, ...channelTemplate(e, c) });
    }
  }
  getActive(eventType: string, channel: Channel, locale: Locale): Promise<ChannelTemplate | null> {
    return Promise.resolve(this.map.get(`${eventType}|${channel}|${locale}`) ?? null);
  }
}
