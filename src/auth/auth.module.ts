import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { ENV } from '../common/constants';
import { TenancyModule } from '../tenancy/tenancy.module';
import { UsersModule } from '../users/users.module';
import { AuthContextMiddleware } from './auth-context.middleware';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

if (!ENV.JWT_SECRET_SET && ENV.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET is required in production');
}

/**
 * Authentication: JWT issuance/verification and the global auth+context
 * middleware. Registering the middleware here (forRoutes('*')) makes it the
 * single enforcement point for every request.
 */
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: ENV.JWT_SECRET,
      signOptions: {
        expiresIn: ENV.JWT_EXPIRES_IN as JwtSignOptions['expiresIn'],
      },
    }),
    UsersModule,
    TenancyModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthContextMiddleware],
  exports: [AuthContextMiddleware],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthContextMiddleware).forRoutes('*');
  }
}
