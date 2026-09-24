import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { createZodDto } from './zod-dto';

// Mirrors the real emailLogin/device shape (nested object + enum + optional +
// checked string) so this exercises the same paths production DTOs hit.
const deviceSchema = z.object({
  platformCode: z.enum(['android', 'ios', 'web']),
  appVersion: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  device: deviceSchema,
});

class LoginDto extends createZodDto(loginSchema) {}

@Controller('auth')
class TestAuthController {
  @Post('login')
  login(@Body() _body: LoginDto): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [TestAuthController] })
class TestAppModule {}

describe('createZodDto Swagger wiring', () => {
  it('produces a real request-body schema in the generated OpenAPI document, not an empty object', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      TestAppModule,
      new FastifyAdapter(),
      {
        logger: false,
      },
    );
    await app.init();

    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const requestBody = document.paths['/auth/login']?.post?.requestBody as
      { content: Record<string, { schema: { $ref: string } }> } | undefined;
    const ref = requestBody?.content['application/json']?.schema.$ref;
    const modelName = ref?.replace('#/components/schemas/', '');
    const schema = modelName
      ? (document.components?.schemas?.[modelName] as SchemaObject)
      : undefined;

    expect(schema).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', minLength: 1 },
        device: {
          type: 'object',
          properties: {
            platformCode: { type: 'string', enum: ['android', 'ios', 'web'] },
            appVersion: { type: 'string' },
          },
          required: ['platformCode'],
        },
      },
      required: ['email', 'password', 'device'],
    });

    await app.close();
  });
});
