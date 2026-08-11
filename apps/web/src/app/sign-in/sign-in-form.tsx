'use client';

import { useActionState } from 'react';
import { signIn, type SignInState } from './actions';

const initialState: SignInState = { error: null };

export function SignInForm() {
  const [state, formAction, pending] = useActionState(signIn, initialState);

  return (
    <form action={formAction} className="card setup-form" aria-describedby={state.error ? 'sign-in-error' : undefined}>
      <label>E-Mail<input required name="email" type="email" autoComplete="email" /></label>
      <label>Passwort<input required name="password" type="password" autoComplete="current-password" /></label>
      {state.error && (
        <p id="sign-in-error" className="timer-alert" role="alert">{state.error}</p>
      )}
      <button type="submit" disabled={pending}>{pending ? 'Anmeldung läuft' : 'Anmelden'}</button>
    </form>
  );
}
