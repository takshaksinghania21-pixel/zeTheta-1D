import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { registry } from '../../src/common/metrics';

const file = path.resolve(__dirname, '../../config/prometheus-alerts.yml');
const rules = (
  YAML.parse(readFileSync(file, 'utf8')) as {
    groups: { rules: { alert: string; expr: string; labels: { severity: string } }[] }[];
  }
).groups.flatMap((g) => g.rules);

describe('alerting rules (PDF §A11.2)', () => {
  it('defines the seven PDF alerts with their severities', () => {
    expect(Object.fromEntries(rules.map((r) => [r.alert, r.labels.severity]))).toEqual({
      HighDLQDepth: 'critical',
      ProviderCircuitOpen: 'high',
      DeliveryLatencySpike: 'critical',
      HighFailureRate: 'high',
      KafkaConsumerLag: 'high',
      FrequencyCapExhaustion: 'medium',
      DNDViolationDetected: 'critical',
    });
  });

  it('only references metrics the service exports', async () => {
    const exported = new Set((await registry.getMetricsAsJSON()).map((m) => m.name));
    for (const r of rules) {
      const names = r.expr.match(/\b(notification|kafka|delivery)_[a-z_]+/g) ?? [];
      for (const n of names) expect(exported).toContain(n.replace(/_bucket$/, ''));
    }
  });
});
