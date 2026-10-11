import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import type { Kafka, Producer } from 'kafkajs';
import type { Knex } from 'knex';
import { mathRandom, systemClock, type Clock, type RandomSource } from './common/clock';
import { FieldEncryptor } from './common/crypto';
import { createLogger, type Logger } from './common/logger';
import { RedisRateLimiter, type RateLimiter } from './common/rate-limiter';
import type { AppConfig } from './config/env';
import { loadPolicy, type NotificationPolicy } from './config/policy';
import { createDb } from './infrastructure/database/knex';
import {
  createKafka,
  createProducer,
  topicNames,
  type TopicNames,
} from './infrastructure/kafka/kafka';
import { OutboxRelay } from './infrastructure/outbox/outbox';
import { RedisMockBehaviorStore, type MockBehaviorStore } from './infrastructure/providers/mock';
import {
  RabbitConnection,
  rabbitTopology,
  type RabbitTopology,
} from './infrastructure/rabbitmq/rabbitmq';
import { createRedis } from './infrastructure/redis/redis';
import { AnalyticsService } from './modules/analytics/service';
import { AuditLog } from './modules/audit/audit';
import { AuthService } from './modules/auth/service';
import { DndService, type DndCache } from './modules/compliance/dnd';
import { RedisDndCache } from './modules/compliance/redis-dnd-cache';
import { PolicyDecisionRepository, PostgresDndSource } from './modules/compliance/repository';
import { ConsentRepository } from './modules/consent/repository';
import { CircuitBreaker, type CircuitStore } from './modules/delivery/circuit-breaker';
import { DeliveryDispatcher } from './modules/delivery/dispatcher';
import type { DeliveryProvider } from './modules/delivery/provider';
import { RedisCircuitStore } from './modules/delivery/redis-circuit-store';
import { buildProviders, ProviderRegistry } from './modules/delivery/registry';
import { DeadLetterRepository } from './modules/dlq/repository';
import { DeadLetterService } from './modules/dlq/service';
import { EventIngestionService } from './modules/events/ingestion';
import { EventProcessor } from './modules/events/processor';
import { RedisFrequencyCapper, type FrequencyCapper } from './modules/frequency/frequency-capper';
import { NotificationFactory } from './modules/notifications/factory';
import { NotificationLifecycle } from './modules/notifications/lifecycle';
import { NotificationRepository } from './modules/notifications/repository';
import { NotificationService } from './modules/notifications/service';
import { RedisBudgetTracker, type BudgetTracker } from './modules/routing/budget';
import { RoutingEngine } from './modules/routing/routing-engine';
import { Scheduler } from './modules/scheduling/scheduler';
import { EventTaxonomy } from './modules/taxonomy/taxonomy';
import { TemplateEngine } from './modules/templates/engine';
import { TemplateRepository } from './modules/templates/repository';
import { UserContextService } from './modules/users/context';
import { UserRepository } from './modules/users/repository';
import { WebhookService } from './modules/webhooks/service';

export interface ContainerOverrides {
  clock?: Clock;
  random?: RandomSource;
  providers?: DeliveryProvider[];
  mockStore?: MockBehaviorStore;
  logger?: Logger;
  circuitStore?: CircuitStore;
}

function lazy<T>(factory: () => T): () => T {
  let value: T | undefined;
  let made = false;
  return () => {
    if (!made) {
      value = factory();
      made = true;
    }
    return value as T;
  };
}

/**
 * Composition root. Infrastructure clients are created lazily so each process
 * (API, individual workers, tests) only connects to what it actually uses.
 */
export class Container {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly logger: Logger;
  readonly taxonomy: EventTaxonomy;
  readonly policy: NotificationPolicy;
  readonly topics: TopicNames;
  readonly topology: RabbitTopology;
  private readonly closers: (() => Promise<void>)[] = [];

  constructor(
    readonly config: AppConfig,
    private readonly overrides: ContainerOverrides = {},
  ) {
    this.clock = overrides.clock ?? systemClock;
    this.random = overrides.random ?? mathRandom;
    this.logger =
      overrides.logger ?? createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });
    this.taxonomy = EventTaxonomy.load();
    this.policy = config.POLICY_FILE ? loadPolicy(config.POLICY_FILE) : loadPolicy();
    this.topics = topicNames(config.KAFKA_TOPIC_PREFIX);
    this.topology = rabbitTopology(config.RABBITMQ_PREFIX);
  }

  // --- infrastructure -------------------------------------------------------
  readonly db = lazy<Knex>(() => {
    const db = createDb({
      url: this.config.DATABASE_URL,
      poolMax: this.config.DATABASE_POOL_MAX,
      ssl: this.config.DATABASE_SSL,
      applicationName: this.config.SERVICE_NAME,
    });
    this.closers.push(() => db.destroy());
    return db;
  });
  readonly redis = lazy<Redis>(() => {
    const r = createRedis(this.config.REDIS_URL, `${this.config.SERVICE_NAME}:main`);
    this.closers.push(async () => {
      await r.quit().catch(() => {
        r.disconnect();
      });
    });
    return r;
  });
  readonly kafka = lazy<Kafka>(() => createKafka(this.config, this.logger));
  private producerPromise: Promise<Producer> | undefined;
  async producer(): Promise<Producer> {
    this.producerPromise ??= (async () => {
      const p = createProducer(this.kafka());
      await p.connect();
      this.closers.push(() => p.disconnect());
      return p;
    })();
    return this.producerPromise;
  }
  readonly rabbit = lazy<RabbitConnection>(() => {
    const r = new RabbitConnection(this.config.RABBITMQ_URL, this.logger);
    this.closers.push(() => r.close());
    return r;
  });
  readonly emitter = lazy(() => new Emitter(this.redis()));

  // --- security & primitives -------------------------------------------------
  readonly encryptor = lazy(
    () => new FieldEncryptor(this.config.DATA_ENCRYPTION_KEY_ID, this.config.DATA_ENCRYPTION_KEY),
  );
  readonly rateLimiter = lazy<RateLimiter>(() => new RedisRateLimiter(this.redis()));
  readonly auth = lazy(
    () =>
      new AuthService(this.db(), {
        secret: this.config.JWT_SECRET,
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
        accessTtlSeconds: this.config.JWT_ACCESS_TTL_SECONDS,
        refreshTtlSeconds: this.config.JWT_REFRESH_TTL_SECONDS,
      }),
  );
  readonly audit = lazy(() => new AuditLog(this.db()));

  // --- repositories ------------------------------------------------------------
  readonly users = lazy(
    () => new UserRepository(this.db(), this.encryptor(), this.config.DATA_HASH_KEY),
  );
  readonly consents = lazy(() => new ConsentRepository(this.db()));
  readonly notifications = lazy(() => new NotificationRepository(this.db()));
  readonly decisions = lazy(() => new PolicyDecisionRepository(this.db()));
  readonly dlqRepo = lazy(() => new DeadLetterRepository(this.db()));
  readonly templateRepo = lazy(() => new TemplateRepository(this.db()));
  readonly dndSource = lazy(() => new PostgresDndSource(this.db()));
  readonly dndCache = lazy<DndCache>(() => new RedisDndCache(this.redis()));

  // --- domain services -------------------------------------------------------
  readonly lifecycle = lazy(() => new NotificationLifecycle(this.topics.lifecycle, this.clock));
  readonly factory = lazy(
    () => new NotificationFactory(this.lifecycle(), this.policy, this.topology),
  );
  readonly templates = lazy(
    () =>
      new TemplateEngine(this.templateRepo(), {
        fallbackLocale: this.policy.templates.fallbackLocale,
        smsMaxSegments: this.policy.templates.smsMaxSegments,
      }),
  );
  readonly userContext = lazy(
    () => new UserContextService(this.users(), this.consents(), this.policy),
  );
  readonly dnd = lazy(
    () =>
      new DndService(
        this.dndSource(),
        this.dndCache(),
        {
          staleAfterMs: this.config.DND_STALE_AFTER_HOURS * 3600000,
          cacheTtlSeconds: this.config.DND_CACHE_TTL_SECONDS,
        },
        this.clock,
      ),
  );
  readonly capper = lazy<FrequencyCapper>(
    () => new RedisFrequencyCapper(this.redis(), this.policy.frequencyCaps),
  );
  readonly budget = lazy<BudgetTracker>(() => new RedisBudgetTracker(this.redis()));
  readonly circuit = lazy(
    () =>
      new CircuitBreaker(
        this.overrides.circuitStore ?? new RedisCircuitStore(this.redis()),
        this.policy.circuitBreaker,
        () => this.clock.now().getTime(),
      ),
  );
  readonly mockStore = lazy<MockBehaviorStore>(
    () => this.overrides.mockStore ?? new RedisMockBehaviorStore(this.redis()),
  );
  readonly registry = lazy(() => {
    const providers =
      this.overrides.providers ??
      buildProviders(this.config, this.policy, {
        mockStore: this.mockStore(),
        ...(this.config.INAPP_PROVIDERS.includes('socketio') ? { emitter: this.emitter() } : {}),
        logger: this.logger,
      });
    return new ProviderRegistry(providers, this.db(), this.circuit(), {
      timeoutMs: this.config.PROVIDER_TIMEOUT_MS,
      costs: this.policy.costs.perMessageMicros,
    });
  });
  readonly routing = lazy(
    () =>
      new RoutingEngine(
        this.policy,
        this.dnd(),
        this.capper(),
        this.budget(),
        this.registry(),
        this.clock,
      ),
  );
  readonly ingestion = lazy(
    () => new EventIngestionService(this.db(), this.taxonomy, this.topics.financialEvents),
  );
  readonly processor = lazy(
    () =>
      new EventProcessor({
        db: this.db(),
        taxonomy: this.taxonomy,
        policy: this.policy,
        userContext: this.userContext(),
        routing: this.routing(),
        templates: this.templates(),
        factory: this.factory(),
        lifecycle: this.lifecycle(),
        decisions: this.decisions(),
        dlq: this.dlqRepo(),
        capper: this.capper(),
        clock: this.clock,
        logger: this.logger.child({ component: 'event-consumer' }),
      }),
  );
  readonly dispatcher = lazy(
    () =>
      new DeliveryDispatcher({
        db: this.db(),
        redis: this.redis(),
        notifications: this.notifications(),
        lifecycle: this.lifecycle(),
        factory: this.factory(),
        registry: this.registry(),
        circuit: this.circuit(),
        rateLimiter: this.rateLimiter(),
        users: this.users(),
        userContext: this.userContext(),
        decisions: this.decisions(),
        dlq: this.dlqRepo(),
        budget: this.budget(),
        templates: this.templates(),
        taxonomy: this.taxonomy,
        policy: this.policy,
        topology: this.topology,
        clock: this.clock,
        random: this.random,
        logger: this.logger.child({ component: 'dispatcher' }),
        webhooks: this.webhooks(),
      }),
  );
  readonly scheduler = lazy(
    () =>
      new Scheduler({
        db: this.db(),
        policy: this.policy,
        taxonomy: this.taxonomy,
        capper: this.capper(),
        factory: this.factory(),
        lifecycle: this.lifecycle(),
        templates: this.templates(),
        userContext: this.userContext(),
        clock: this.clock,
        logger: this.logger.child({ component: 'scheduler' }),
        retentionDays: this.config.RETENTION_DAYS,
        staleSeconds: this.config.RETRY_SWEEP_STALE_SECONDS,
      }),
  );
  readonly webhooks = lazy(
    () =>
      new WebhookService(this.db(), this.lifecycle(), this.logger.child({ component: 'webhooks' })),
  );
  readonly notificationService = lazy(
    () => new NotificationService(this.db(), this.notifications(), this.lifecycle()),
  );
  readonly dlq = lazy(
    () =>
      new DeadLetterService(
        this.db(),
        this.dlqRepo(),
        this.notifications(),
        this.lifecycle(),
        this.factory(),
        this.audit(),
        this.topics.financialEvents,
      ),
  );
  readonly analytics = lazy(() => new AnalyticsService(this.db()));

  private relayPromise: Promise<OutboxRelay> | undefined;
  async outboxRelay(): Promise<OutboxRelay> {
    this.relayPromise ??= (async () =>
      new OutboxRelay(
        this.db(),
        await this.producer(),
        this.rabbit(),
        this.logger.child({ component: 'outbox-relay' }),
        {
          pollMs: this.config.OUTBOX_POLL_MS,
          batchSize: this.config.OUTBOX_BATCH_SIZE,
        },
      ))();
    return this.relayPromise;
  }

  /** Closes infrastructure clients in reverse creation order. */
  async close(): Promise<void> {
    for (const close of this.closers.reverse()) {
      try {
        await close();
      } catch (err) {
        this.logger.warn({ err }, 'error while closing resource');
      }
    }
    this.closers.length = 0;
  }
}
