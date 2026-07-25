import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { colors } from '../lib/theme';

export default function SignIn() {
  const { signIn, signUp } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const err = isSignUp ? await signUp(email, password) : await signIn(email, password);
    if (err) setError(err);
    setLoading(false);
  };

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <h1 style={{ fontSize: 32, fontWeight: 800, textAlign: 'center', marginBottom: 8 }}>Rust</h1>
      <p style={{ color: colors.textDim, textAlign: 'center', marginBottom: 32, fontSize: 14 }}>
        {isSignUp ? 'Create your account' : 'Sign in to your account'}
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          className="input"
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="email"
        />
        <input
          className="input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
        />
        {error && <p className="error-text">{error}</p>}
        <button className="btn-primary" type="submit" disabled={loading || !email || !password}>
          {loading ? 'Loading...' : isSignUp ? 'Create Account' : 'Sign In'}
        </button>
      </form>
      <button
        onClick={() => { setIsSignUp(!isSignUp); setError(''); }}
        style={{ color: colors.accent, fontSize: 14, marginTop: 16, textAlign: 'center' }}
      >
        {isSignUp ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
      </button>
    </div>
  );
}
