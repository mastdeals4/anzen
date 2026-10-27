import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { LogIn } from 'lucide-react';
import logo from '../assets/Untitled-1.svg';
import { FALLBACK_COMPANY } from '../types/company';
import { FloatingField, FLOAT_INPUT } from './finance/FloatingField';
import { SapRow } from './finance/SapLayout';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { signIn } = useAuth();
  const { t } = useLanguage();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await signIn(username, password);
    } catch (err) {
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-8">
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <img src={logo} alt="Company Logo" className="h-24 w-24 mx-auto" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 text-center">
            {FALLBACK_COMPANY.company_name}
          </h1>
        </div>

        <h2 className="text-2xl font-bold text-center text-gray-900 mb-2">
          {t('auth.welcomeBack')}
        </h2>
        <p className="text-gray-600 text-center mb-8">
          {t('auth.enterCredentials')}
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <SapRow>
            <FloatingField
              label="Username"
              filled={username.trim() !== ''}
              required
              hint="Enter your company username."
              span={12}
            >
              <input
                id="username"
                name="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                className={FLOAT_INPUT}
                placeholder="username"
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField
              label={t('auth.password')}
              filled={password.trim() !== ''}
              required
              span={12}
            >
              <input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className={FLOAT_INPUT}
                placeholder="••••••••"
              />
            </FloatingField>
          </SapRow>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            {loading ? t('common.loading') : t('auth.signIn')}
          </button>
        </form>
      </div>
    </div>
  );
}
