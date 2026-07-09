import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试文件目录
    include: ['src/**/__tests__/**/*.test.ts'],
    // 全局超时
    testTimeout: 10000,
    // 环境
    environment: 'node',
    // 覆盖率配置
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/index.ts',
        'src/feishu/eventHandler.ts',
        'src/feishu/wsClient.ts',
      ],
      thresholds: {
        statements: 30,
        branches: 25,
        functions: 30,
        lines: 30,
      },
    },
  },
});
