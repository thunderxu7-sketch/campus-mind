export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (message = '资源不存在') => new DomainError('NOT_FOUND', message, 404);
export const forbidden = (message = '无权执行此操作') => new DomainError('FORBIDDEN', message, 403);
export const unauthorized = (message = '需要登录') => new DomainError('UNAUTHORIZED', message, 401);
