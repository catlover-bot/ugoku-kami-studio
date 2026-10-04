import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseDesignDocument, type DesignDocument } from '@ugoku/core';
import type { ServerConfig } from './config.js';
import { AppError } from './errors.js';
import type { Run } from './runs.js';

export type Session = { id: string; tokenHash: Buffer; document: DesignDocument; touchedAt: number; runs: Map<string, Run> };

export function secretMatches(actual: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  constructor(private config: ServerConfig) {}

  create(document: unknown) {
    this.clean();
    if (this.sessions.size >= this.config.maxSessions) throw new AppError('capacity', '現在混み合っています。後でもう一度お試しください。', 503);
    const parsed = parseDesignDocument(document);
    const token = randomBytes(32).toString('base64url');
    const session: Session = { id: randomUUID(), tokenHash: createHash('sha256').update(token).digest(), document: structuredClone(parsed), touchedAt: Date.now(), runs: new Map() };
    this.sessions.set(session.id, session);
    return { sessionId: session.id, token, document: parsed };
  }

  authorize(id: string, authorization?: string): Session {
    this.clean();
    const session = this.sessions.get(id);
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!session || !token || !timingSafeEqual(session.tokenHash, createHash('sha256').update(token).digest())) throw new AppError('unauthorized', '作業セッションが無効です。再接続してください。', 401);
    session.touchedAt = Date.now();
    return session;
  }

  update(session: Session, raw: unknown) {
    const document = parseDesignDocument(raw);
    if (document.designId !== session.document.designId || document.revision < session.document.revision || (document.revision === session.document.revision && document.designHash !== session.document.designHash)) {
      throw new AppError('stale_design', '古い設計は反映できません。現在の設計で再接続してください。', 409);
    }
    if (document.designHash !== session.document.designHash || document.revision !== session.document.revision) {
      for (const run of session.runs.values()) {
        if (run.status === 'running' || run.status === 'awaiting_approval') {
          run.controller.abort(); run.status = 'cancelled'; run.proposal = undefined;
          run.error = { code: 'stale_design', message: '設計が変更されたため、以前の実行と承認を無効にしました。' };
        }
      }
      session.document = structuredClone(document);
    }
    return { document: session.document };
  }

  clean() {
    const cutoff = Date.now() - this.config.sessionTtlMs;
    for (const [id, session] of this.sessions) if (session.touchedAt < cutoff) {
      for (const run of session.runs.values()) run.controller.abort();
      this.sessions.delete(id);
    }
  }

  close() { for (const session of this.sessions.values()) for (const run of session.runs.values()) run.controller.abort(); }
}
