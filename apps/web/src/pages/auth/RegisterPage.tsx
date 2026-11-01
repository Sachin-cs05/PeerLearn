import React, { useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Eye,
  EyeOff,
  User,
  Mail,
  GraduationCap,
  ArrowRight,
  Lock,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Alert } from '../../components/ui/Alert.js';
import { useAuth } from '../../context/AuthContext.js';

export const RegisterPage: React.FC = () => {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    college: '',
    degree: '',
    branch: '',
    semester: '',
    acceptedTerms: false,
  });

  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);

  // 3D Perspective Card Tilt
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    setTilt({
      x: -(y / rect.height) * 6,
      y: (x / rect.width) * 6,
    });
  };

  const handleMouseLeave = () => {
    setTilt({ x: 0, y: 0 });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (form.password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    if (!form.acceptedTerms) {
      setError('You must accept the terms of service and student honor code');
      return;
    }

    setLoading(true);
    const result = await register({
      fullName: form.fullName,
      email: form.email,
      password: form.password,
      confirmPassword: form.confirmPassword,
      college: form.college,
      degree: form.degree,
      branch: form.branch,
      semester: form.semester,
      acceptedTerms: form.acceptedTerms,
    });
    setLoading(false);

    if (result.success) {
      navigate('/dashboard');
    } else {
      setError(result.error || 'Failed to create student account');
    }
  };

  const handleGoogleClick = () => {
    setGoogleNotice(
      'Google Single Sign-On (SSO) is enabled for verified university partner accounts. Please sign up below with your student credentials.'
    );
    setTimeout(() => setGoogleNotice(null), 6000);
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4 py-12 relative overflow-hidden bg-background">
      {/* Ambient glow */}
      <div className="ambient-glow-top pointer-events-none" />

      <div className="w-full max-w-xl space-y-6 relative z-10">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-border bg-card text-foreground-secondary text-xs font-medium shadow-2xs">
            <ShieldCheck className="w-3.5 h-3.5 text-foreground" />
            <span>Student Registration</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-foreground tracking-tight">
            Create Student Account
          </h1>
          <p className="text-xs sm:text-sm text-foreground-secondary max-w-md mx-auto">
            Connect with friends, discover learning partners, and share skills without friction.
          </p>
        </div>

        {/* 3D Perspective Card (Clean, No Image) */}
        <div
          ref={cardRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{
            transform: `perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
            transition: tilt.x === 0 && tilt.y === 0 ? 'transform 0.5s ease-out' : 'transform 0.08s ease-out',
          }}
          className="rounded-2xl border border-border bg-card/95 backdrop-blur-xl shadow-2xl p-6 sm:p-8 space-y-5 transition-shadow duration-300 hover:shadow-glow-sm"
        >
          {error && (
            <Alert variant="error" className="mb-2" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {googleNotice && (
            <Alert variant="info" className="mb-2" onClose={() => setGoogleNotice(null)}>
              {googleNotice}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Full Name & Student Email */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 text-left">
                <label className="block text-xs font-medium text-foreground-secondary">
                  Full Name
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-foreground-muted">
                    <User className="w-4 h-4" />
                  </div>
                  <input
                    name="fullName"
                    type="text"
                    placeholder="Alex Morgan"
                    value={form.fullName}
                    onChange={handleChange}
                    className="w-full rounded-xl border border-border bg-background pl-10 pr-4 py-2.5 text-sm text-foreground placeholder:text-foreground-muted transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/25 dark:focus:ring-white/25 focus:border-foreground dark:focus:border-white hover:border-border-strong"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5 text-left">
                <label className="block text-xs font-medium text-foreground-secondary">
                  Student Email
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-foreground-muted">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    name="email"
                    type="email"
                    placeholder="alex@college.edu"
                    value={form.email}
                    onChange={handleChange}
                    className="w-full rounded-xl border border-border bg-background pl-10 pr-4 py-2.5 text-sm text-foreground placeholder:text-foreground-muted transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/25 dark:focus:ring-white/25 focus:border-foreground dark:focus:border-white hover:border-border-strong"
                    required
                  />
                </div>
              </div>
            </div>

            {/* Password & Confirm Password */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 text-left">
                <label className="block text-xs font-medium text-foreground-secondary">
                  Password
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-foreground-muted">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Min 8 characters"
                    value={form.password}
                    onChange={handleChange}
                    className="w-full rounded-xl border border-border bg-background pl-10 pr-10 py-2.5 text-sm text-foreground placeholder:text-foreground-muted transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/25 dark:focus:ring-white/25 focus:border-foreground dark:focus:border-white hover:border-border-strong font-mono"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-foreground-muted hover:text-foreground cursor-pointer transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5 text-left">
                <label className="block text-xs font-medium text-foreground-secondary">
                  Confirm Password
                </label>
                <input
                  name="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Re-enter password"
                  value={form.confirmPassword}
                  onChange={handleChange}
                  className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-foreground-muted transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/25 dark:focus:ring-white/25 focus:border-foreground dark:focus:border-white hover:border-border-strong font-mono"
                  required
                />
              </div>
            </div>

            {/* Academic Information */}
            <div className="pt-2 border-t border-border space-y-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground-muted block text-left">
                Academic Details
              </span>

              <div className="space-y-1.5 text-left">
                <label className="block text-xs font-medium text-foreground-secondary">
                  College or University
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-foreground-muted">
                    <GraduationCap className="w-4 h-4" />
                  </div>
                  <input
                    name="college"
                    type="text"
                    placeholder="e.g. Stanford University / IIT Delhi"
                    value={form.college}
                    onChange={handleChange}
                    className="w-full rounded-xl border border-border bg-background pl-10 pr-4 py-2.5 text-sm text-foreground placeholder:text-foreground-muted transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/25 dark:focus:ring-white/25 focus:border-foreground dark:focus:border-white hover:border-border-strong"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1 text-left">
                  <label className="block text-xs font-medium text-foreground-secondary">Degree</label>
                  <input
                    name="degree"
                    type="text"
                    placeholder="e.g. B.Tech"
                    value={form.degree}
                    onChange={handleChange}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-foreground-muted transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/25 hover:border-border-strong"
                    required
                  />
                </div>

                <div className="space-y-1 text-left">
                  <label className="block text-xs font-medium text-foreground-secondary">Branch</label>
                  <input
                    name="branch"
                    type="text"
                    placeholder="e.g. CSE"
                    value={form.branch}
                    onChange={handleChange}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-foreground-muted transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/25 hover:border-border-strong"
                    required
                  />
                </div>

                <div className="space-y-1 text-left">
                  <label className="block text-xs font-medium text-foreground-secondary">Semester</label>
                  <input
                    name="semester"
                    type="text"
                    placeholder="e.g. 5th Sem"
                    value={form.semester}
                    onChange={handleChange}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-foreground-muted transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/25 hover:border-border-strong"
                    required
                  />
                </div>
              </div>
            </div>

            {/* Terms checkbox */}
            <div className="pt-2">
              <label className="flex items-start gap-2.5 cursor-pointer select-none text-left">
                <input
                  type="checkbox"
                  name="acceptedTerms"
                  checked={form.acceptedTerms}
                  onChange={handleChange}
                  className="mt-1 h-4 w-4 rounded border-border bg-card text-foreground focus:ring-foreground cursor-pointer"
                />
                <span className="text-xs text-foreground-secondary leading-relaxed">
                  I agree to the <span className="text-foreground underline font-medium">Terms of Service</span> and{' '}
                  <span className="text-foreground underline font-medium">Privacy Policy</span>.
                </span>
              </label>
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-xl bg-foreground text-background font-bold text-sm hover:opacity-95 hover:scale-[1.01] active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer shadow-md disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <span>Create Student Account</span>
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Social Divider (Google Only - GitHub Removed) */}
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-card px-3 text-foreground-muted text-[11px] font-medium">
                or continue with
              </span>
            </div>
          </div>

          {/* Single Google Button (GitHub Removed) */}
          <button
            type="button"
            onClick={handleGoogleClick}
            className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-xl border border-border bg-surface-hover/40 hover:bg-surface-hover text-foreground text-xs sm:text-sm font-semibold transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] cursor-pointer shadow-2xs group"
          >
            <svg className="w-4 h-4 transition-transform group-hover:scale-110" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <span>Google</span>
          </button>

          {/* Switch to Login */}
          <div className="pt-2 border-t border-border text-center text-xs text-foreground-muted">
            Already have an account?{' '}
            <Link to="/login" className="font-semibold text-foreground hover:underline">
              Sign In
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};
