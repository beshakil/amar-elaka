import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { AuthService } from './auth.service';
import {
  EmailLinkedDto,
  GoogleLinkedDto,
  LoggedOutDto,
  MeResultDto,
  OtpSentDto,
  SessionTokensDto,
  type MeResult,
  type SessionTokens,
} from './dto/auth-responses.dto';
import { EmailLoginDto } from './dto/email-login.dto';
import { EmailRegisterDto } from './dto/email-register.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { OtpRequestDto } from './dto/otp-request.dto';
import { OtpVerifyDto } from './dto/otp-verify.dto';
import { LogoutDto, RefreshDto } from './dto/refresh.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard';

function userAgentOf(request: FastifyRequest): string | undefined {
  return request.headers['user-agent'];
}

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/request')
  @AllowAnyTenant()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: OtpSentDto })
  async requestOtp(
    @Body() body: OtpRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<{ status: 'otp_sent'; resendAfterSeconds: number }> {
    const { resendAfterSeconds } = await this.auth.requestOtp(body.phone, request.ip);
    return { status: 'otp_sent', resendAfterSeconds };
  }

  // Allowlisted like otp/request (tenant-agnostic per the resolution spec),
  // even though a real login still needs one — AuthService.verifyOtpAndLogin
  // throws its own precise TENANT_REQUIRED if it's called with none resolved,
  // so this only changes which layer reports that, not whether it's enforced.
  @Post('otp/verify')
  @AllowAnyTenant()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SessionTokensDto })
  verifyOtp(@Body() body: OtpVerifyDto, @Req() request: FastifyRequest): Promise<SessionTokens> {
    return this.auth.verifyOtpAndLogin(
      body.phone,
      body.code,
      body.device,
      request.ip,
      userAgentOf(request),
    );
  }

  @Post('google')
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiExtraModels(SessionTokensDto, GoogleLinkedDto)
  @ApiOkResponse({
    description: 'Signed in, or — when already signed in — the Google account was linked.',
    schema: {
      oneOf: [{ $ref: getSchemaPath(SessionTokensDto) }, { $ref: getSchemaPath(GoogleLinkedDto) }],
    },
  })
  googleAuth(
    @Body() body: GoogleAuthDto,
    @Req() request: FastifyRequest,
  ): Promise<SessionTokens | { linked: true }> {
    return this.auth.googleAuth(body.idToken, body.device, request.ip, userAgentOf(request));
  }

  @Post('email/register')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: EmailLinkedDto })
  async registerEmail(@Body() body: EmailRegisterDto): Promise<{ status: 'linked' }> {
    await this.auth.registerEmailPassword(body.email, body.password);
    return { status: 'linked' };
  }

  @Post('email/login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SessionTokensDto })
  emailLogin(@Body() body: EmailLoginDto, @Req() request: FastifyRequest): Promise<SessionTokens> {
    return this.auth.emailLogin(
      body.email,
      body.password,
      body.device,
      request.ip,
      userAgentOf(request),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SessionTokensDto })
  refresh(@Body() body: RefreshDto, @Req() request: FastifyRequest): Promise<SessionTokens> {
    return this.auth.refresh(body.refreshToken, request.ip, userAgentOf(request));
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LoggedOutDto })
  async logout(@Body() body: LogoutDto): Promise<{ status: 'logged_out' }> {
    await this.auth.logout(body.refreshToken);
    return { status: 'logged_out' };
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LoggedOutDto })
  async logoutAll(): Promise<{ status: 'logged_out' }> {
    await this.auth.logoutAll();
    return { status: 'logged_out' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: MeResultDto })
  me(): Promise<MeResult> {
    return this.auth.me();
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: MeResultDto })
  updateMe(@Body() body: UpdateProfileDto): Promise<MeResult> {
    return this.auth.updateProfile({
      displayName: body.displayName,
      avatarStorageKey: body.avatarStorageKey,
    });
  }
}
