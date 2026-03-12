import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * Placeholder auth guard for GraphQL resolvers.
 * Replace with your actual authentication strategy (JWT, session, etc.).
 */
@Injectable()
export class GqlAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const ctx = GqlExecutionContext.create(context);
    const { req } = ctx.getContext();
    // TODO: Replace with real authentication check
    return !!req.user;
  }
}
