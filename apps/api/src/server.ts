import { createServer, type Server } from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { prisma, checkDatabaseConnection } from './config/prisma.js';
import { logger } from './utils/logger.js';
import { APP_NAME, APP_TAGLINE } from '@peerlume/shared';
import { initSocketIO } from './socket/index.js';
import { startReminderScheduler, stopReminderScheduler } from './services/reminder.service.js';
import { startReconciliationScheduler, stopReconciliationScheduler } from './services/storage/reconciliationScheduler.service.js';

let server: Server;

async function startServer(): Promise<void> {
  server = createServer(app);

  // Initialize Socket.IO real-time engine
  initSocketIO(server);

  // Initialize background session reminder scheduler
  startReminderScheduler();

  // Initialize storage reconciliation background worker scheduler
  startReconciliationScheduler();

  server.listen(env.PORT,'0.0.0.0', async () => {
    logger.info(`✨ ${APP_NAME} API Server started successfully!`);
    logger.info(`🎯 Tagline: "${APP_TAGLINE}"`);
    logger.info(`🚀 Listening on http://localhost:${env.PORT}`);
    logger.info(`📡 Environment: ${env.NODE_ENV}`);
    logger.info(`🩺 Health check: http://localhost:${env.PORT}/api/health`);
    logger.info(`⚡ Real-Time Socket.IO: Ready for Chat, Presence & WebRTC Calls`);

    // Proactively verify database connection on startup
    try {
      const dbStatus = await checkDatabaseConnection();
      if (dbStatus.status === 'connected') {
        logger.info(`🗄️ PostgreSQL database connected (latency: ${dbStatus.latencyMs}ms)`);
      } else {
        logger.warn(`⚠️ PostgreSQL database connection warning: ${dbStatus.message}`);
        logger.warn(`💡 Tip: If using Neon serverless, compute wakes up automatically within a few seconds.`);
      }
    } catch (err: any) {
      logger.warn(`⚠️ Database check failed: ${err?.message || err}`);
    }
  });


  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Gracefully shutting down ${APP_NAME} API server...`);
    stopReminderScheduler();
    try {
      await stopReconciliationScheduler();
    } catch (schedErr) {
      logger.error('Error stopping reconciliation scheduler on shutdown:', schedErr);
    }
    try {
      const { codeSyncService } = await import('./services/codeSync.service.js');
      await codeSyncService.flushAll();
    } catch (flushErr) {
      logger.error('Error flushing collaborative code documents on shutdown:', flushErr);
    }
    try {
      const { whiteboardSyncService } = await import('./services/whiteboardSync.service.js');
      await whiteboardSyncService.flushAll();
    } catch (flushErr) {
      logger.error('Error flushing whiteboard documents on shutdown:', flushErr);
    }

    if (server) {
      server.close(async () => {
        logger.info('HTTP server closed.');
        try {
          await prisma.$disconnect();
          logger.info('Database client disconnected.');
        } catch (dbErr) {
          logger.error('Error during database disconnection:', dbErr);
        }
        process.exit(0);
      });

      // Force shutdown if cleanup takes too long
      setTimeout(() => {
        logger.error('Shutdown timed out. Forcing process exit.');
        process.exit(1);
      }, 10000).unref();
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection:', reason);
    process.exit(1);
  });
}

startServer().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
