import { closePool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

await migrate();
await closePool();
