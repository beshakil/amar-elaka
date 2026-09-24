import { Controller, Get, Module, Param } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { TenantContext } from '../src/database/tenant-context';

/** Proves the per-request ALS scope survives Nest + Fastify and is never shared. */

@Controller('context-probe')
class ContextProbeController {
  constructor(private readonly context: TenantContext) {}

  @Get('set/:tenantId/:delayMs')
  async setAndRead(@Param('tenantId') tenantId: string, @Param('delayMs') delayMs: string) {
    this.context.set({ tenantId });
    await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));
    await Promise.resolve();
    return { seen: this.context.require().tenantId ?? null };
  }

  @Get('read')
  read() {
    return { seen: this.context.require().tenantId ?? null };
  }
}

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [ContextProbeController],
})
class ProbeModule {}

describe('Tenant context per request (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps each concurrent request in its own scope', async () => {
    const tenants = Array.from(
      { length: 40 },
      (_, index) => `0191e3a0-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    const responses = await Promise.all(
      tenants.map((tenantId, index) =>
        app.inject({
          method: 'GET',
          url: `/context-probe/set/${tenantId}/${(index * 7) % 15}`,
        }),
      ),
    );
    expect(responses.map((response) => response.json<{ seen: string }>().seen)).toEqual(tenants);
  });

  it('starts every request with an empty scope', async () => {
    await app.inject({
      method: 'GET',
      url: '/context-probe/set/0191e3a0-0000-7000-8000-00000000000a/0',
    });
    const next = await app.inject({
      method: 'GET',
      url: '/context-probe/read',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json<{ seen: string | null }>().seen).toBeNull();
  });
});
