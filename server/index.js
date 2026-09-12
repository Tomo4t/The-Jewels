import config from './config.js';
import app, { frontendIsBuilt } from './app.js';

const server = app.listen(config.port, () => {
  console.log(`The Jewels listening on http://localhost:${config.port}`);
  console.log(`  content   ${config.contentDir}`);
  console.log(`  database  ${config.databasePath}`);
  console.log(`  frontend  ${frontendIsBuilt ? config.distDir : 'not built (run npm run build)'}`);
  console.log(
    `  moderation ${config.moderationQueue ? 'queue on' : 'queue off'}, ` +
      `AI check ${config.anthropicApiKey ? 'enabled' : 'disabled (no API key)'}`
  );
});

const shutdown = (signal) => () => {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));

export default server;
