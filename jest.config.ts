import type { Config } from 'jest';

type Project = NonNullable<Config['projects']>[number] & object;

const common: Project = {
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { warnOnly: false } }],
  },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
};

const config: Config = {
  projects: [
    { ...common, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
    },
    { ...common, displayName: 'e2e', testMatch: ['<rootDir>/tests/e2e/**/*.test.ts'] },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/workers/main.ts',
    '!src/database/migrate.ts',
    '!src/database/seeds/seed.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'json-summary', 'lcov', 'text'],
  coverageThreshold: {
    // PDF Day 13: "minimum 80% code coverage across the entire codebase" — all four metrics.
    global: { statements: 80, branches: 80, functions: 80, lines: 80 },
  },
  testTimeout: 30000,
};

export default config;
