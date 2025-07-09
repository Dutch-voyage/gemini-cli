/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initializeTelemetry,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
} from './sdk.js';
import { Config } from '../config/config.js';
import { NodeSDK } from '@opentelemetry/sdk-node';

vi.mock('@opentelemetry/sdk-node');
vi.mock('../config/config.js');
vi.mock('net', () => ({
  createConnection: vi.fn(() => ({
    on: vi.fn((event, callback) => {
      if (event === 'connect') {
        setTimeout(() => callback(), 10);
      }
    }),
    destroy: vi.fn(),
  })),
}));

describe('telemetry', () => {
  let mockConfig: Config;
  let mockNodeSdk: NodeSDK;

  beforeEach(() => {
    vi.resetAllMocks();

    mockConfig = new Config({
      sessionId: 'test-session-id',
      model: 'test-model',
      targetDir: '/test/dir',
      debugMode: false,
      cwd: '/test/dir',
    });
    vi.spyOn(mockConfig, 'getTelemetryEnabled').mockReturnValue(true);
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'http://localhost:4317',
    );
    vi.spyOn(mockConfig, 'getSessionId').mockReturnValue('test-session-id');
    mockNodeSdk = {
      start: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as NodeSDK;
    vi.mocked(NodeSDK).mockImplementation(() => mockNodeSdk);
  });

  afterEach(async () => {
    // Ensure we shut down telemetry even if a test fails.
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry();
    }
  });

  it('should initialize the telemetry service', async () => {
    initializeTelemetry(mockConfig);

    // Wait for async initialization to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(NodeSDK).toHaveBeenCalled();
    expect(mockNodeSdk.start).toHaveBeenCalled();
  });

  it('should shutdown the telemetry service', async () => {
    initializeTelemetry(mockConfig);

    // Wait for async initialization to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    await shutdownTelemetry();

    expect(mockNodeSdk.shutdown).toHaveBeenCalled();
  });
});
