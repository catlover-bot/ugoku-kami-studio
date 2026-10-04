export class AppError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
  if (status === 401 || status === 403) return { code: 'provider_auth', message: 'Geminiの認証に失敗しました。サーバーの接続設定を確認してください。' };
  if (status === 429) return { code: 'provider_rate_limit', message: 'Geminiの利用上限に達しました。時間をおいて再試行してください。' };
  if (status === 408 || status === 504) return { code: 'timeout', message: 'Geminiの応答が時間内に届きませんでした。' };
  return { code: 'provider_error', message: 'AIとの通信に失敗しました。設計は変更されていません。' };
}
