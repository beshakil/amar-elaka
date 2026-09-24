import { resetAndMigrate } from './test-database';

/** Every `pnpm test:db` run starts from an empty test database with all migrations applied. */
export default async function globalSetup(): Promise<void> {
  await resetAndMigrate();
}
