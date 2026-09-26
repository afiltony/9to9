import { createApp } from './src/app.js';
import { config } from './src/config.js';
import { migrate } from './src/migrate.js';
import { bootstrap } from './src/bootstrap.js';

if (config.autoMigrate) await migrate();
// first deploy on hosting without SSH: load the programme and create the first admin from env vars
await bootstrap();

createApp().listen(config.port, () => {
  console.log(`9 TO 9 MEET running on port ${config.port} (${config.baseUrl})`);
});
