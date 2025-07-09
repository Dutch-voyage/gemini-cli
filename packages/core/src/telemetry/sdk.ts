/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { Resource } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-node';
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
} from '@opentelemetry/sdk-logs';
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Config } from '../config/config.js';
import { SERVICE_NAME } from './constants.js';
import { initializeMetrics } from './metrics.js';
import { ClearcutLogger } from './clearcut-logger/clearcut-logger.js';
import { createConnection } from 'net';

// For troubleshooting, set the log level to DiagLogLevel.DEBUG
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

let sdk: NodeSDK | undefined;
let telemetryInitialized = false;
let usingFallback = false;

export function isTelemetrySdkInitialized(): boolean {
  return telemetryInitialized;
}

function parseGrpcEndpoint(
  otlpEndpointSetting: string | undefined,
): string | undefined {
  if (!otlpEndpointSetting) {
    return undefined;
  }
  // Trim leading/trailing quotes that might come from env variables
  const trimmedEndpoint = otlpEndpointSetting.replace(/^["']|["']$/g, '');

  try {
    const url = new URL(trimmedEndpoint);
    // OTLP gRPC exporters expect an endpoint in the format scheme://host:port
    // The `origin` property provides this, stripping any path, query, or hash.
    return url.origin;
  } catch (error) {
    diag.error('Invalid OTLP endpoint URL provided:', trimmedEndpoint, error);
    return undefined;
  }
}

async function validateGrpcConnection(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(endpoint);
      const host = url.hostname;
      const port =
        parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);

      const socket = createConnection({
        host,
        port,
        timeout: 3000, // 3 second timeout
      });

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('error', (error) => {
        diag.warn(
          `Connection validation failed for ${endpoint}:`,
          error.message,
        );
        resolve(false);
      });

      socket.on('timeout', () => {
        socket.destroy();
        diag.warn(`Connection timeout for ${endpoint}`);
        resolve(false);
      });
    } catch (error) {
      diag.warn(`Failed to validate connection for ${endpoint}:`, error);
      resolve(false);
    }
  });
}

async function createResilientExporters(
  grpcParsedEndpoint: string | undefined,
) {
  const useOtlp = !!grpcParsedEndpoint;

  if (!useOtlp) {
    diag.info('Using console exporters (no OTLP endpoint configured)');
    return {
      spanExporter: new ConsoleSpanExporter(),
      logExporter: new ConsoleLogRecordExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: 10000,
      }),
    };
  }

  // Validate connection before creating exporters
  const isConnectionValid = await validateGrpcConnection(grpcParsedEndpoint);

  if (!isConnectionValid) {
    diag.warn(
      `Cannot connect to OTLP endpoint ${grpcParsedEndpoint}, falling back to console exporters`,
    );
    usingFallback = true;
    return {
      spanExporter: new ConsoleSpanExporter(),
      logExporter: new ConsoleLogRecordExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: 10000,
      }),
    };
  }

  // Configure OTLP exporters with robust settings
  const otlpConfig = {
    url: grpcParsedEndpoint,
    compression: CompressionAlgorithm.GZIP,
    timeoutMillis: 5000, // 5 second timeout
    // Configure gRPC specific options
    keepAlive: {
      keepAliveTimeMs: 30000,
      keepAliveTimeoutMs: 10000,
      keepAlivePermitWithoutCalls: true,
      http2MaxPingsWithoutData: 0,
      http2MinTimeBetweenPingsMs: 10000,
      http2MinPingIntervalWithoutDataMs: 300000,
    },
  };

  try {
    const spanExporter = new OTLPTraceExporter(otlpConfig);
    const logExporter = new OTLPLogExporter(otlpConfig);
    const metricReader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(otlpConfig),
      exportIntervalMillis: 10000,
    });

    diag.info(`Using OTLP exporters for endpoint: ${grpcParsedEndpoint}`);
    return { spanExporter, logExporter, metricReader };
  } catch (error) {
    diag.warn(
      'Failed to create OTLP exporters, falling back to console exporters:',
      error,
    );
    usingFallback = true;
    return {
      spanExporter: new ConsoleSpanExporter(),
      logExporter: new ConsoleLogRecordExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: 10000,
      }),
    };
  }
}

export function initializeTelemetry(config: Config): void {
  if (telemetryInitialized || !config.getTelemetryEnabled()) {
    return;
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
    'session.id': config.getSessionId(),
  });

  const otlpEndpoint = config.getTelemetryOtlpEndpoint();
  const grpcParsedEndpoint = parseGrpcEndpoint(otlpEndpoint);

  // Initialize telemetry asynchronously but don't block the calling code
  initializeTelemetryAsync(config, resource, grpcParsedEndpoint).catch(
    (error) => {
      console.error('Failed to initialize telemetry:', error);
    },
  );

  // Add error handling for connection issues during runtime
  process.on('uncaughtException', (error) => {
    if (
      error.message?.includes('UNAVAILABLE') ||
      error.message?.includes('ECONNRESET') ||
      error.message?.includes('ECONNREFUSED')
    ) {
      console.warn(
        'Telemetry connection error detected, continuing with degraded telemetry:',
        error.message,
      );
      return; // Prevent the error from crashing the process
    }
    throw error; // Re-throw if it's not a telemetry connection error
  });

  process.on('SIGTERM', shutdownTelemetry);
  process.on('SIGINT', shutdownTelemetry);
}

async function initializeTelemetryAsync(
  config: Config,
  resource: Resource,
  grpcParsedEndpoint: string | undefined,
): Promise<void> {
  const { spanExporter, logExporter, metricReader } =
    await createResilientExporters(grpcParsedEndpoint);

  sdk = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(spanExporter)],
    logRecordProcessor: new BatchLogRecordProcessor(logExporter),
    metricReader,
    instrumentations: [new HttpInstrumentation()],
  });

  try {
    sdk.start();
    const exporterType = usingFallback
      ? 'console (fallback due to connection issues)'
      : grpcParsedEndpoint
        ? 'OTLP gRPC'
        : 'console';
    console.log(
      `OpenTelemetry SDK started successfully with ${exporterType} exporters.`,
    );
    telemetryInitialized = true;
    initializeMetrics(config);
  } catch (error) {
    console.error('Error starting OpenTelemetry SDK:', error);
    // Try to initialize with fallback exporters if not already using them
    if (!usingFallback) {
      console.log(
        'Attempting to initialize with fallback console exporters...',
      );
      try {
        usingFallback = true;
        const fallbackExporters = await createResilientExporters(undefined);
        sdk = new NodeSDK({
          resource,
          spanProcessors: [
            new BatchSpanProcessor(fallbackExporters.spanExporter),
          ],
          logRecordProcessor: new BatchLogRecordProcessor(
            fallbackExporters.logExporter,
          ),
          metricReader: fallbackExporters.metricReader,
          instrumentations: [new HttpInstrumentation()],
        });
        sdk.start();
        console.log(
          'OpenTelemetry SDK started with fallback console exporters.',
        );
        telemetryInitialized = true;
        initializeMetrics(config);
      } catch (fallbackError) {
        console.error(
          'Failed to initialize telemetry with fallback exporters:',
          fallbackError,
        );
      }
    }
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!telemetryInitialized || !sdk) {
    return;
  }
  try {
    ClearcutLogger.getInstance()?.shutdown();
    await Promise.race([
      sdk.shutdown(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout')), 10000),
      ),
    ]);
    console.log('OpenTelemetry SDK shut down successfully.');
  } catch (error) {
    console.error('Error shutting down SDK:', error);
  } finally {
    telemetryInitialized = false;
    usingFallback = false;
  }
}
