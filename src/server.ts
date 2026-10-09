import { buildApp } from './app.js';
import { loadConfig } from './config.js';
const config = loadConfig();
const app = await buildApp(config);
let stopping = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
});
try { await app.listen({host:config.host,port:config.port}); }
catch (error) { app.log.error(error); await app.close(); process.exitCode=1; }
