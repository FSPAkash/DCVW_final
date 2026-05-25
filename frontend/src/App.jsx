import React, { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './DashboardV3';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('pigmentUser');
    if (stored) setUser(JSON.parse(stored));
    setLoading(false);
  }, []);

  const handleLogin = (u) => {
    setUser(u);
    localStorage.setItem('pigmentUser', JSON.stringify(u));
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('pigmentUser');
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  return <Dashboard user={user} onLogout={handleLogout} />;
}


export default App;