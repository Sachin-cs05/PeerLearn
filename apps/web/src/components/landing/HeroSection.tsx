import React, { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Terminal,
  CheckCircle2,
  Video,
  Shield,
  Users,
  Code2,
  Sparkles,
} from 'lucide-react';
import { Button } from '../ui/Button.js';
import { Badge } from '../ui/Badge.js';
import { useAuth } from '../../context/AuthContext.js';
import { useScrollReveal } from '../../hooks/useScrollReveal.js';

export const HeroSection: React.FC = () => {
  const { user } = useAuth();
  const { ref, isVisible } = useScrollReveal({ threshold: 0.1 });

  // Visual toggle: 'community' (student study group) or 'workspace' (code editor)
  const [heroView, setHeroView] = useState<'community' | 'workspace'>('community');

  // 3D Card tilt state
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const handleCardMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    // Restrained, subtle tilt angle (max 4 degrees)
    setTilt({
      x: -(y / rect.height) * 6,
      y: (x / rect.width) * 6,
    });
  };

  const handleCardMouseLeave = () => {
    setTilt({ x: 0, y: 0 });
  };

  const handleExploreClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const targetElement = document.getElementById('features');
    if (targetElement) {
      const headerOffset = 76;
      const elementPosition = targetElement.getBoundingClientRect().top;
      const offsetPosition = elementPosition + window.pageYOffset - headerOffset;
      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth',
      });
    }
  };

  return (
    <section
      id="hero"
      ref={ref}
      className="relative pt-12 pb-16 md:pt-20 md:pb-24 overflow-hidden border-b border-border/40"
    >
      {/* Ambient Electric Indigo Mesh Aura */}
      <div className="ambient-glow-top" />

      {/* Subtle Grid Background */}
      <div className="absolute inset-0 bg-subtle-grid opacity-35 pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8 items-center">
          {/* Left Column: Copy & Actions with Staggered Entrance */}
          <div className="lg:col-span-6 space-y-6 text-center lg:text-left">
            {/* Tag / Badge */}
            <div
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 text-xs font-medium shadow-[0_0_16px_-3px_rgba(99,102,241,0.25)] transition-all duration-700 ease-out ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
              <span>Peer-to-Peer Student Learning Platform</span>
            </div>

            {/* Main Headline */}
            <h1
              className={`text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-foreground leading-[1.08] transition-all duration-700 delay-100 ease-out ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'
              }`}
            >
              Learn Together.<br />
              <span className="gradient-accent font-extrabold">Grow Together.</span>
            </h1>

            {/* Supporting Description */}
            <p
              className={`max-w-xl mx-auto lg:mx-0 text-base sm:text-lg text-foreground-secondary leading-relaxed font-normal transition-all duration-700 delay-200 ease-out ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'
              }`}
            >
              Discover learning partners, share your skills, exchange knowledge, and collaborate
              with students who share your goals — all in one place.
            </p>

            {/* CTAs */}
            <div
              className={`flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-3 pt-2 transition-all duration-700 delay-300 ease-out ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'
              }`}
            >
              <Link to={user ? '/discover' : '/register'} className="w-full sm:w-auto">
                <Button
                  size="lg"
                  variant="accent"
                  className="w-full sm:w-auto transition-transform hover:scale-[1.02] active:scale-[0.98]"
                  rightIcon={<ArrowRight className="w-4 h-4" />}
                >
                  {user ? 'Find Learning Partners' : 'Find Your Learning Partner'}
                </Button>
              </Link>
              <Button
                size="lg"
                variant="secondary"
                className="w-full sm:w-auto transition-transform hover:scale-[1.02] active:scale-[0.98]"
                onClick={handleExploreClick}
              >
                Explore Features
              </Button>
            </div>

            {/* Micro Highlights / Trust Pills */}
            <div
              className={`pt-4 flex flex-wrap items-center justify-center lg:justify-start gap-4 text-xs text-foreground-muted border-t border-border/60 transition-all duration-700 delay-400 ease-out ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <div className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500" />
                <span>Verified Student Network</span>
              </div>
              <div className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                <Shield className="w-3.5 h-3.5 text-indigo-500" />
                <span>Zero Ads or Distractions</span>
              </div>
              <div className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                <Users className="w-3.5 h-3.5 text-indigo-500" />
                <span>Collaborative Study Rooms</span>
              </div>
            </div>
          </div>

          {/* Right Column: Hero Visual Product Preview with 3D Mouse Tilt */}
          <div
            className={`lg:col-span-6 transition-all duration-700 delay-200 ease-out ${
              isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
            }`}
          >
            <div
              ref={cardRef}
              onMouseMove={handleCardMouseMove}
              onMouseLeave={handleCardMouseLeave}
              style={{
                transform: `perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
                transition: tilt.x === 0 && tilt.y === 0 ? 'transform 0.5s ease-out' : 'transform 0.1s ease-out',
              }}
              className="relative rounded-2xl border border-border/80 dark:border-white/10 bg-card/90 backdrop-blur-xl shadow-2xl hover:shadow-glow-sm overflow-hidden hover:border-indigo-500/40 group border-t border-t-white/80 dark:border-t-white/15 transition-all duration-300"
            >
              {/* Window Chrome Header with Mode Switcher */}
              <div className="flex flex-wrap items-center justify-between px-3.5 py-2.5 border-b border-border bg-background-secondary/80 backdrop-blur-md text-xs select-none gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]/80" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]/80" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f]/80" />
                  </div>
                  {/* View Switcher Tabs */}
                  <div className="ml-1.5 flex items-center p-0.5 rounded-lg bg-surface-hover border border-border">
                    <button
                      type="button"
                      onClick={() => setHeroView('community')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                        heroView === 'community'
                          ? 'bg-background text-foreground shadow-2xs font-semibold'
                          : 'text-foreground-secondary hover:text-foreground'
                      }`}
                    >
                      <Users className="w-3 h-3 text-indigo-500" />
                      <span>Peer Community</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setHeroView('workspace')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                        heroView === 'workspace'
                          ? 'bg-background text-foreground shadow-2xs font-semibold'
                          : 'text-foreground-secondary hover:text-foreground'
                      }`}
                    >
                      <Code2 className="w-3 h-3 text-indigo-500" />
                      <span>Live Workspace</span>
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 font-medium text-[11px] text-foreground-secondary">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-dot" />
                  <span className="hidden sm:inline">
                    {heroView === 'community' ? 'Active Circle (4 Peers)' : 'Room: Live (2 Peers)'}
                  </span>
                </div>
              </div>

              {/* View 1: Real Student Collaboration Photo */}
              {heroView === 'community' ? (
                <div className="space-y-0 bg-[#09090B]">
                  <div className="relative overflow-hidden group/img aspect-[16/10] sm:aspect-[16/9] w-full bg-black">
                    <img
                      src="/images/peerlearn-community.jpg"
                      alt="PeerLearn verified students collaborating on shared study goals"
                      className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover/img:scale-[1.02]"
                      loading="eager"
                    />
                    {/* Subtle bottom vignette shadow for text legibility */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent pointer-events-none" />
                    <div className="absolute inset-0 ring-1 ring-inset ring-white/10 pointer-events-none" />

                    {/* Floating pill badges on the image */}
                    <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/70 backdrop-blur-md border border-white/20 text-white shadow-lg text-[11px]">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="font-medium tracking-tight">Active Peer Study Session</span>
                      </div>
                      <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/70 backdrop-blur-md border border-white/20 text-white/90 text-[10.5px] font-medium tracking-wide">
                        <Sparkles className="w-3 h-3 text-indigo-400" />
                        <span>Learn • Share • Collaborate • Grow</span>
                      </div>
                    </div>
                  </div>

                  {/* Highlights Grid below Photo */}
                  <div className="p-3 sm:p-4 bg-card border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                    <div className="p-2 rounded-lg bg-background border border-border transition-colors hover:border-border-strong">
                      <div className="font-bold text-foreground text-xs sm:text-sm">4 Peers</div>
                      <div className="text-[10px] text-foreground-muted">Live In Session</div>
                    </div>
                    <div className="p-2 rounded-lg bg-background border border-border transition-colors hover:border-border-strong">
                      <div className="font-bold text-foreground text-xs sm:text-sm">Shared Code</div>
                      <div className="text-[10px] text-foreground-muted">Multi-Cursor Synced</div>
                    </div>
                    <div className="p-2 rounded-lg bg-background border border-border transition-colors hover:border-border-strong">
                      <div className="font-bold text-foreground text-xs sm:text-sm">HD Voice</div>
                      <div className="text-[10px] text-foreground-muted">WebRTC Connected</div>
                    </div>
                    <div className="p-2 rounded-lg bg-background border border-border transition-colors hover:border-border-strong">
                      <div className="font-bold text-emerald-500 text-xs sm:text-sm">100% Free</div>
                      <div className="text-[10px] text-foreground-muted">Verified Students</div>
                    </div>
                  </div>
                </div>
              ) : (
                /* View 2: Live Code Workspace Preview */
                <div className="p-4 sm:p-5 space-y-4 bg-card">
                  {/* Session Header Card */}
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-background transition-colors hover:border-border-strong">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-surface-hover border border-border flex items-center justify-center font-bold text-xs text-foreground group-hover:scale-105 transition-transform">
                        DS
                      </div>
                      <div>
                        <div className="text-xs sm:text-sm font-semibold text-foreground">
                          Data Structures &amp; Algorithms
                        </div>
                        <div className="text-[11px] text-foreground-muted">
                          Graph Traversal &amp; Dynamic Programming
                        </div>
                      </div>
                    </div>
                    <Badge variant="neutral" size="sm">
                      In Progress
                    </Badge>
                  </div>

                  {/* Collaborative Code Snippet with Animated Cursor */}
                  <div className="rounded-lg border border-border bg-background p-3.5 font-mono text-xs text-foreground-secondary space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-foreground-muted pb-2 border-b border-border">
                      <span className="flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-foreground" /> graph_bfs.ts
                      </span>
                      <span className="text-[11px] text-foreground font-mono flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> 2 editing
                      </span>
                    </div>
                    <div className="space-y-1 text-[11.5px] leading-relaxed">
                      <p>
                        <span className="text-foreground font-semibold">export function</span>{' '}
                        <span className="text-foreground">bfs</span>(graph: Map&lt;string, string[]&gt;, start: string) &#123;
                      </p>
                      <p className="pl-4 text-foreground-muted">
                        // Visited set ensures acyclic traversal
                      </p>
                      <p className="pl-4">
                        <span className="text-foreground font-semibold">const</span> visited ={' '}
                        <span className="text-foreground font-semibold">new</span> Set&lt;string&gt;([start]);
                      </p>
                      <p className="pl-4">
                        <span className="text-foreground font-semibold">const</span> queue: string[] = [start];
                      </p>
                      <p className="pl-4 text-foreground flex items-center">
                        <span>return Array.from(visited);</span>
                        <span className="inline-block w-1.5 h-4 ml-1 bg-foreground animate-cursor align-middle" />
                      </p>
                      <p>&#125;</p>
                    </div>
                  </div>

                  {/* Bottom Row: Matched Peer & Audio Call Bar */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Matched Peer Card */}
                    <div className="p-3 rounded-lg border border-border bg-background space-y-2 hover:border-border-strong transition-colors">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-foreground-muted uppercase tracking-wider">
                          Matched Peer
                        </span>
                        <span className="font-mono font-bold text-foreground">96% Match</span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-surface-hover border border-border flex items-center justify-center font-bold text-xs text-foreground">
                          EM
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-foreground">Elena Miller</div>
                          <div className="text-[10px] text-foreground-muted">CS • Semester 5</div>
                        </div>
                      </div>
                    </div>

                    {/* Audio Call & Latency Card */}
                    <div className="p-3 rounded-lg border border-border bg-background flex flex-col justify-between hover:border-border-strong transition-colors">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-foreground-muted uppercase tracking-wider">
                          WebRTC Voice
                        </span>
                        <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-500">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-dot" /> Connected
                        </span>
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center gap-1.5 text-xs text-foreground">
                          <Video className="w-3.5 h-3.5 text-foreground-muted" />
                          <span className="text-[11px]">Active Audio Call</span>
                        </div>
                        <span className="text-[10px] font-mono text-foreground-muted">18ms latency</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
