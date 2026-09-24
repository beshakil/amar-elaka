import { loadDotenv } from './load-dotenv';
import { EnvSchema, type Env } from './env.schema';

loadDotenv();

function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    // The Nest/pino logger doesn't exist yet at this point — this is a boot
    // failure, not a request error, so plain stderr output is correct here.
    console.error('Invalid environment configuration — refusing to start.\n');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

// Validated once, at first import, so the process exits before
// NestFactory.create() ever runs if the environment is invalid.
export const env: Env = parseEnv();
