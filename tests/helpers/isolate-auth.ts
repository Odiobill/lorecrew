// Vitest workers never read the developer's shared Pi credentials.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.LORECREW_AUTH_FILE=join(mkdtempSync(join(tmpdir(),'lorecrew-auth-test-')),'auth.json');
