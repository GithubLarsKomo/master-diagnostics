export interface IdentitySession {
  userId: string;
  provider: 'BETTER_AUTH' | 'CLERK';
  sessionId: string;
}

export interface InviteUserInput { email: string; locale: 'de' | 'en'; }
export interface InviteResult { invitationId: string; expiresAt: string; }

export interface IdentityProvider {
  getSession(): Promise<IdentitySession | null>;
  inviteUser(input: InviteUserInput): Promise<InviteResult>;
  revokeSession(sessionId: string): Promise<void>;
}

export * from './local';
