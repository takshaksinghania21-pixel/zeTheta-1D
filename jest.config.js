/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { warnOnly: false } }];
const common = {
  transform: { '^.+\\.ts$': tsJest },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
};
module.exports = {
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
    '!src/infrastructure/database/migrate.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'json-summary', 'lcov', 'text'],
  coverageThreshold: {
    global: { statements: 80, branches: 70, functions: 80, lines: 80 },
  },
  testTimeout: 30000,
};
