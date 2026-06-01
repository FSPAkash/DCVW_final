import React, { useState } from 'react';
import config from './config';
import { fetchWithRenderWake } from './network';

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetchWithRenderWake(`${config.API_URL}/api/v3/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (data.success) {
        onLogin(data.user);
      } else {
        setError('Invalid credentials');
      }
    } catch (e) {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="desktop login-desktop">
      <div className="window login-window">
        <div className="login-topbar">
          <div className="login-brand">
            <img
              src="/logos/main-logo.png"
              alt="DCW"
              className="login-topbar-logo"
              onError={(e) => { e.target.style.display = 'none'; }}
            />
            <div className="login-brand-meta">
              <span className="login-brand-name">SIOP</span>
            </div>
          </div>
        </div>

        <div className="body login-body">
          <div className="login-pane">
            <div className="login-eyebrow">
              <span className="bar"></span>
              <span>SECURE ACCESS</span>
            </div>
            <h1 className="login-title">Inventory <em>Match</em> Matrix</h1>
            <p className="login-lede">
              AI driven Lot and Customer Requirement Management.
              Sign in with your operator credentials to continue.
            </p>

            <div className="login-powered">
              <span className="login-powered-label">Powered By :</span>
              <img
                src="/logos/partner2.png"
                alt="Findability Sciences"
                className="login-powered-logo"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
              <span className="login-powered-name">Findability Sciences</span>
            </div>
          </div>

          <div className="login-form-wrap">
            <div className="card login-card">
              <div className="card-head">
                <span className="dot-r"></span>
                <span>Operator Sign-In</span>
              </div>
              <div className="card-body">
                {error && (
                  <div className="login-alert">
                    <span className="login-alert-tag">ERR</span>
                    <span>{error}</span>
                  </div>
                )}

                <form onSubmit={handleSubmit} className="login-form">
                  <div className="field">
                    <label className="field-label" htmlFor="login-username">Username</label>
                    <input
                      id="login-username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="operator.id"
                      autoComplete="username"
                      required
                    />
                  </div>

                  <div className="field">
                    <label className="field-label" htmlFor="login-password">Password</label>
                    <input
                      id="login-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    className="btn btn-primary login-submit"
                    disabled={loading}
                  >
                    {loading ? 'Signing in…' : 'Sign In →'}
                  </button>
                </form>

                <div className="login-foot">
                  <span className="login-foot-key">SESSION</span>
                  <span className="login-foot-val">awaiting credentials</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="statusbar">
          <span className="dot"></span>
          <span>READY</span>
          <span className="sep"></span>
          <span>AUTH · LOCAL</span>
          <span className="sep"></span>
          <span>USER · —</span>
          <div className="right">
            <span className="testing-tag compact">USER TESTING ONLY</span>
            <span>VIEW · SIGN-IN</span>
            <span className="sep"></span>
            <span>SAHUPURAM · TN</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
