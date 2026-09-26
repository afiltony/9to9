import { createApp } from './src/app.js';
import { config } from './src/config.js';
import { migrate } from './src/migrate.js';

if (config.autoMigrate) await migrate();

createApp().listen(config.port, () => {
  console.log(`9 TO 9 MEET running on port ${config.port} (${config.baseUrl})`);
});
