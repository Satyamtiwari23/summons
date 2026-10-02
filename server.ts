import { getApp, startServer } from './server/app';

export { getApp, startServer };

// Only start the HTTP listener if not running inside a serverless environment (e.g. Vercel)
if (process.env.VERCEL !== '1' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  startServer().catch((fatalErr) => {
    console.error('[Server] Fatal server startup failure:', fatalErr);
    process.exit(1);
  });
}
