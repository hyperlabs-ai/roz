import { type ReactNode, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, Sparkles, GitMerge, Mail, GitPullRequest, GitCommit, Webhook, Lock, Brain,
  LayoutDashboard, Users, FolderGit2, ArrowRight, Check, Zap, ShieldCheck,
  Sun, Moon, Monitor,
} from 'lucide-react';
import { RozLogo } from '@/components/RozLogo';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/theme';
import { cn } from '@/lib/utils';

const REPO = 'https://github.com/hyperlabs-ai/roz';
const DOCS = `${REPO}#self-hosting`;
const GH_SETUP = `${REPO}/blob/main/docs/GITHUB-SETUP.md`;
const ARCH = `${REPO}/blob/main/ARCHITECTURE.md`;
const SECURITY = `${REPO}/blob/main/SECURITY.md`;
const SUPPORT_EMAIL = 'manuel@hyperlabs.vc';

/* ─────────────────────────────────────────────────────────────────────────────
   Animations. Injected once; all motion is paused under prefers-reduced-motion.
   ──────────────────────────────────────────────────────────────────────────── */
function LandingStyles() {
  return (
    <style>{`
      @keyframes rozFlow   { from { background-position: 0 0; } to { background-position: 200% 0; } }
      @keyframes rozTravel { 0% { left: -4%; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { left: 104%; opacity: 0; } }
      @keyframes rozPulse  { 0%,100% { transform: scale(1); opacity: .55; } 50% { transform: scale(1.18); opacity: 0; } }
      @keyframes rozFloat  { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
      @keyframes rozBlink  { 0%,100% { opacity: .2; } 50% { opacity: 1; } }
      @keyframes rozDash   { to { stroke-dashoffset: -36; } }
      @keyframes rozBar    { 0%,100% { transform: scaleY(.45); } 50% { transform: scaleY(1); } }
      @keyframes rozOrbit  { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes rozFade   { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      .roz-fade { animation: rozFade .35s ease both; }

      .roz-conn { position: relative; height: 2px; border-radius: 9999px; background: hsl(var(--border)); overflow: visible; }
      .roz-conn-glow { position: absolute; inset: 0; border-radius: 9999px;
        background: linear-gradient(90deg, transparent, hsl(var(--primary)/.85), transparent);
        background-size: 200% 100%; animation: rozFlow 2.4s linear infinite; }
      .roz-packet { position: absolute; top: 50%; width: 8px; height: 8px; margin-top: -4px; border-radius: 9999px;
        background: hsl(var(--primary)); box-shadow: 0 0 12px 2px hsl(var(--primary)/.7); animation: rozTravel 2.4s linear infinite; }
      .roz-ring { position: absolute; inset: -7px; border-radius: 9999px; border: 2px solid hsl(var(--primary)/.5);
        animation: rozPulse 2.6s ease-out infinite; }
      .roz-float { animation: rozFloat 5s ease-in-out infinite; }
      .roz-blink { animation: rozBlink 1.8s ease-in-out infinite; }
      .roz-dash  { stroke-dasharray: 5 7; animation: rozDash 1s linear infinite; }
      .roz-bar   { transform-origin: bottom; animation: rozBar 1.6s ease-in-out infinite; }
      .roz-spin  { animation: rozOrbit 14s linear infinite; transform-origin: center; }

      @media (prefers-reduced-motion: reduce) {
        .roz-conn-glow, .roz-packet, .roz-ring, .roz-float, .roz-blink, .roz-dash, .roz-bar, .roz-spin, .roz-fade { animation: none !important; }
        .roz-packet { display: none; }
      }
    `}</style>
  );
}

type Icon = typeof Activity;

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  const Ico = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Theme" onClick={() => setTheme(next)}>
      <Ico className="size-[18px]" />
    </Button>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.51 11.51 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GitHubPill({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground', className)}>
      <GitHubMark className="size-3.5" /> Works with GitHub
    </span>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-5">
        <a href="#top" className="flex items-center gap-2.5">
          <RozLogo className="size-8" />
          <span className="text-lg font-extrabold tracking-tight">roz</span>
        </a>
        <nav className="ml-6 hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
          <a href="#features" className="transition-colors hover:text-foreground">Features</a>
          <a href="#github" className="transition-colors hover:text-foreground">GitHub</a>
          <a href="#selfhost" className="transition-colors hover:text-foreground">Self-host</a>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link to="/app">Dashboard</Link>
          </Button>
          <Button asChild size="sm">
            <a href={REPO} target="_blank" rel="noreferrer"><GitHubMark className="size-4" /> GitHub</a>
          </Button>
        </div>
      </div>
    </header>
  );
}

/* ── Pipeline (hero visual + How it works) ──────────────────────────────────── */
const STAGES: { icon: Icon; label: string; sub: string; body: string }[] = [
  { icon: Activity, label: 'Observe', sub: 'commits · PRs · issues', body: 'GitHub webhooks and the Linear API feed roz a live stream of what your team is actually doing.' },
  { icon: Sparkles, label: 'Reason', sub: 'Claude classifies', body: 'Is this commit trivial or substantive? Does it already resolve an open issue? Semantic dedup, no manual triage.' },
  { icon: GitMerge, label: 'Reconcile', sub: 'link · document', body: 'roz links code to the right project and developer, documents the change, and writes the missing issue for you.' },
  { icon: Mail, label: 'Notify', sub: 'the right people', body: 'It closes the loop with targeted email — assigned, documented, repo detected — plus a weekly digest.' },
];

function Packets({ count = 2, dur = 2.4 }: { count?: number; dur?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className="roz-packet" style={{ animationDelay: `${(dur / count) * i}s`, animationDuration: `${dur}s` }} />
      ))}
    </>
  );
}

function NodeBadge({ icon: Ico, size = 'md' }: { icon: Icon; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'size-11' : 'size-14';
  const ic = size === 'sm' ? 'size-5' : 'size-6';
  return (
    <div className={cn('relative flex items-center justify-center rounded-2xl bg-primary/10 text-primary', dim)}>
      <span className="roz-ring" />
      <Ico className={ic} />
    </div>
  );
}

/** Compact animated strip for the hero. */
function PipelineStrip() {
  return (
    <div className="mx-auto mt-16 max-w-3xl">
      <div className="flex items-center overflow-x-auto rounded-2xl border border-border bg-card/60 px-5 py-7 backdrop-blur scrollbar-thin">
        <div className="flex min-w-[520px] flex-1 items-center">
          {STAGES.map((s, i) => (
            <div key={s.label} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-2 text-center">
                <NodeBadge icon={s.icon} size="sm" />
                <div className="text-sm font-semibold">{s.label}</div>
                <div className="text-[11px] text-muted-foreground">{s.sub}</div>
              </div>
              {i < STAGES.length - 1 && (
                <div className="roz-conn mx-2 flex-1">
                  <div className="roz-conn-glow" />
                  <Packets count={2} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-[420px] max-w-4xl rounded-full bg-primary/20 blur-[120px]" />
      <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-20 md:pb-24 md:pt-28">
        <div className="mx-auto max-w-3xl text-center">
          <GitHubPill className="mb-6" />
          <h1 className="text-balance text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
            The intelligence layer over <span className="text-primary">GitHub &amp; Linear</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            roz watches what happens in your repos and your tracker, understands it with AI, and
            <span className="text-foreground"> documents, routes and notifies</span> automatically —
            so nobody has to manage a board. It doesn’t ask you to log work; it derives it from reality.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <a href={REPO} target="_blank" rel="noreferrer"><GitHubMark className="size-[18px]" /> Self-host on GitHub</a>
            </Button>
            <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
              <a href={DOCS} target="_blank" rel="noreferrer">Read the docs <ArrowRight className="size-[18px]" /></a>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Open source · MIT · You run it on your own Vercel + Supabase — your data stays yours.
          </p>
        </div>
        <PipelineStrip />
      </div>
    </section>
  );
}

/* ── Problem: an animated "reality → roz → output" flow (SVG) ────────────────── */
function FlowDiagram() {
  // viewBox space; left sources, center core, right outputs.
  const left = [
    { y: 70, label: 'commits' },
    { y: 150, label: 'pull requests' },
    { y: 230, label: 'issues' },
  ];
  const right = [
    { y: 70, label: 'documented' },
    { y: 150, label: 'routed' },
    { y: 230, label: 'notified' },
  ];
  const cx = 450, cy = 150;
  const path = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };
  return (
    <svg viewBox="0 0 900 300" className="w-full" role="img" aria-label="Commits, pull requests and issues flow into roz, which outputs documented, routed and notified work">
      {/* connectors */}
      {left.map((n, i) => {
        const id = `in${i}`;
        const d = path(150, n.y, cx - 52, cy);
        return (
          <g key={id}>
            <path id={id} d={d} fill="none" className="stroke-border" strokeWidth={2} />
            <path d={d} fill="none" className="stroke-primary/60 roz-dash" strokeWidth={2} />
            <circle r={4} className="fill-primary">
              <animateMotion dur="2.6s" begin={`${i * 0.5}s`} repeatCount="indefinite" path={d} />
            </circle>
          </g>
        );
      })}
      {right.map((n, i) => {
        const id = `out${i}`;
        const d = path(cx + 52, cy, 750, n.y);
        return (
          <g key={id}>
            <path id={id} d={d} fill="none" className="stroke-border" strokeWidth={2} />
            <path d={d} fill="none" className="stroke-primary/60 roz-dash" strokeWidth={2} />
            <circle r={4} className="fill-primary">
              <animateMotion dur="2.6s" begin={`${1.3 + i * 0.5}s`} repeatCount="indefinite" path={d} />
            </circle>
          </g>
        );
      })}

      {/* source / output chips */}
      {left.map((n) => <FlowChip key={n.label} x={20} y={n.y} w={130} label={n.label} />)}
      {right.map((n) => <FlowChip key={n.label} x={750} y={n.y} w={130} label={n.label} />)}

      {/* core */}
      <circle cx={cx} cy={cy} r={64} className="fill-primary/10" />
      <circle cx={cx} cy={cy} r={46} className="fill-primary" />
      <circle cx={cx} cy={cy} r={62} className="fill-none stroke-primary/40 roz-spin" strokeWidth={2} strokeDasharray="4 10" />
      <text x={cx} y={cy + 7} textAnchor="middle" className="fill-primary-foreground" fontSize={22} fontWeight={800} letterSpacing={1}>roz</text>
    </svg>
  );
}

function FlowChip({ x, y, w, label }: { x: number; y: number; w: number; label: string }) {
  return (
    <g>
      <rect x={x} y={y - 18} width={w} height={36} rx={10} className="fill-card stroke-border" strokeWidth={1.5} />
      <circle cx={x + 18} cy={y} r={3.5} className="fill-primary roz-blink" />
      <text x={x + 34} y={y + 5} className="fill-foreground" fontSize={14} fontWeight={500}>{label}</text>
    </g>
  );
}

function Problem() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20">
      <div className="grid gap-10 lg:grid-cols-5 lg:items-center">
        <div className="lg:col-span-2">
          <div className="mb-3 text-sm font-semibold uppercase tracking-wider text-primary">The idea</div>
          <h2 className="text-balance text-2xl font-bold tracking-tight md:text-4xl">
            A task manager waits to be fed. roz reads reality.
          </h2>
          <p className="mt-5 text-pretty leading-relaxed text-muted-foreground">
            Traditional tools expect you to create the ticket, assign it, mark it done, link the repo.
            That’s friction — and it’s where context goes to die.
          </p>
          <p className="mt-3 text-pretty leading-relaxed text-muted-foreground">
            roz takes the opposite path: the work is the source of truth. It ingests your commits,
            pull requests and issues, and <span className="text-foreground">reconciles</span> them into
            documented, routed, notified work — with nobody administering a board.
          </p>
        </div>
        <div className="rounded-3xl border border-border bg-card/50 p-4 sm:p-6 lg:col-span-3">
          <FlowDiagram />
        </div>
      </div>
    </section>
  );
}

/* ── How it works: full pipeline with descriptions ──────────────────────────── */
function How() {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setActive((a) => (a + 1) % STAGES.length), 3800);
    return () => clearInterval(id);
  }, [auto]);

  const Cur = STAGES[active].icon;

  return (
    <section id="how" className="border-y border-border bg-card/40">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <SectionHead eyebrow="How it works" title="From raw activity to documented work"
          sub="Four moves. Everything converges on the same context — no humans in the loop unless you want them." />

        {/* interactive stepper — select a move, watch the detail update */}
        <div className="mt-12 grid gap-4 md:grid-cols-[300px_1fr] md:gap-6">
          <div className="flex flex-col gap-2">
            {STAGES.map((s, i) => {
              const on = i === active;
              return (
                <button
                  key={s.label}
                  onClick={() => { setActive(i); setAuto(false); }}
                  aria-pressed={on}
                  className={cn(
                    'group flex items-center gap-3.5 rounded-xl border px-4 py-3.5 text-left transition-all',
                    on ? 'border-primary/40 bg-primary/10 shadow-sm' : 'border-border bg-card hover:border-primary/30 hover:bg-card/80',
                  )}
                >
                  <span className={cn('font-mono text-sm tabular-nums', on ? 'text-primary' : 'text-muted-foreground')}>0{i + 1}</span>
                  <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors', on ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary')}>
                    <s.icon className="size-[18px]" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{s.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{s.sub}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div key={active} className="roz-fade relative overflow-hidden rounded-2xl border border-border bg-card p-8 md:p-10">
            <div aria-hidden className="absolute right-6 top-6 flex items-center gap-1.5">
              {STAGES.map((_, i) => (
                <span key={i} className={cn('h-1.5 rounded-full transition-all', i === active ? 'w-6 bg-primary' : 'w-1.5 bg-border')} />
              ))}
            </div>
            <div className="relative">
              <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Cur className="size-7" /></div>
              <div className="mb-2 font-mono text-xs uppercase tracking-wider text-primary">Step 0{active + 1} / 0{STAGES.length} · {STAGES[active].sub}</div>
              <h3 className="text-2xl font-bold tracking-tight">{STAGES[active].label}</h3>
              <p className="mt-3 max-w-xl text-pretty leading-relaxed text-muted-foreground">{STAGES[active].body}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Features: bento with embedded mini-visuals ─────────────────────────────── */
function MiniReason() {
  return (
    <div className="mt-5 flex items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded-md bg-background px-2 py-1 text-muted-foreground"><GitCommit className="size-3.5" /> commit</span>
      <div className="roz-conn h-px w-8"><div className="roz-conn-glow" /><Packets count={1} /></div>
      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-primary"><Sparkles className="size-3.5" /> reason</span>
      <div className="roz-conn h-px w-8"><div className="roz-conn-glow" /><Packets count={1} /></div>
      <span className="inline-flex items-center gap-1 rounded-md bg-background px-2 py-1 text-muted-foreground"><Check className="size-3.5" /> issue</span>
    </div>
  );
}
function MiniVectors() {
  return (
    <div className="relative mt-5 h-16">
      {[12, 38, 64, 90, 116, 142, 168].map((x, i) => (
        <span key={x} className="roz-blink absolute bottom-0 size-2.5 rounded-full bg-primary"
          style={{ left: x, bottom: (i % 3) * 14 + 4, animationDelay: `${i * 0.2}s`, opacity: 0.3 + (i % 3) * 0.25 }} />
      ))}
      <span className="absolute right-1 top-1 inline-flex items-center gap-1 rounded-md bg-background px-2 py-1 text-[11px] text-muted-foreground"><Brain className="size-3.5" /> hybrid retrieval</span>
    </div>
  );
}
function MiniBars() {
  return (
    <div className="mt-5 flex h-16 items-end gap-1.5">
      {[0.5, 0.8, 0.4, 1, 0.65, 0.9, 0.55, 0.75].map((h, i) => (
        <span key={i} className="roz-bar w-full rounded-sm bg-primary/70" style={{ height: `${h * 100}%`, animationDelay: `${i * 0.15}s` }} />
      ))}
    </div>
  );
}

function FeatureTile({ icon: Ico, title, body, className, visual }: { icon: Icon; title: string; body: string; className?: string; visual?: ReactNode }) {
  return (
    <div className={cn('group relative overflow-hidden rounded-2xl border border-border bg-card p-6 transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg', className)}>
      <div className="absolute -right-10 -top-10 size-28 rounded-full bg-primary/5 transition-colors group-hover:bg-primary/10" />
      <div className="relative">
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Ico className="size-5" /></div>
        <h3 className="mb-1.5 font-semibold">{title}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
        {visual}
      </div>
    </div>
  );
}

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-5 py-20">
      <SectionHead eyebrow="What you get" title="Context, routing and notification — automated"
        sub="The pieces that turn scattered activity into something your whole team can trust." />
      <div className="mt-12 grid auto-rows-fr gap-4 md:grid-cols-3">
        <FeatureTile className="md:col-span-2" icon={Brain} title="Reasons, doesn’t just record"
          body="Claude decides what a change means, whether it’s worth tracking, and which issue it belongs to — then writes the documentation for you."
          visual={<MiniReason />} />
        <FeatureTile icon={FolderGit2} title="Project context"
          body="Anchors Linear and GitHub to one canonical project, auto-onboards new projects and links new repos by similarity." />
        <FeatureTile icon={Users} title="Developer context"
          body="Resolves the same person across Linear, GitHub login and commit email; routes by skill + capacity, not at random." />
        <FeatureTile className="md:col-span-2" icon={Sparkles} title="Second brain"
          body="Embeddings + hybrid retrieval (full-text + pgvector + RRF) keep historical project context alive and feed roz’s own reasoning."
          visual={<MiniVectors />} />
        <FeatureTile className="md:col-span-2" icon={LayoutDashboard} title="Engineering dashboard"
          body="Throughput, cycle time, contribution by project and developer, skills matrix and infrastructure health — all in one place."
          visual={<MiniBars />} />
        <FeatureTile icon={Mail} title="Closes the loop"
          body="Targeted, transactional email instead of a board you have to check. Idempotent delivery, weekly digests." />
      </div>
    </section>
  );
}

/* ── GitHub: animated webhook → outbox → drain request flow ──────────────────── */
function WebhookFlow() {
  return (
    <svg viewBox="0 0 900 260" className="w-full" role="img" aria-label="A GitHub webhook is verified, queued in a Postgres outbox, and drained idempotently with retries to Linear and email">
      {/* main path */}
      <path id="ghpath" d="M 120 130 H 360 M 540 130 H 760" fill="none" className="stroke-border" strokeWidth={2} />
      <path d="M 120 130 H 360" fill="none" className="stroke-primary/60 roz-dash" strokeWidth={2} />
      <path d="M 540 130 H 760" fill="none" className="stroke-primary/60 roz-dash" strokeWidth={2} />

      {/* travelling packet in */}
      <circle r={5} className="fill-primary">
        <animateMotion dur="2.2s" repeatCount="indefinite" path="M 120 130 H 360" />
      </circle>
      {/* travelling packet out */}
      <circle r={5} className="fill-primary">
        <animateMotion dur="2.2s" begin="1.1s" repeatCount="indefinite" path="M 540 130 H 760" />
      </circle>

      {/* retry loop arc above the outbox */}
      <path d="M 470 96 C 470 56, 430 56, 430 96" fill="none" className="stroke-primary/50 roz-dash" strokeWidth={2} markerEnd="url(#arrow)" />
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" className="fill-primary/60" />
        </marker>
      </defs>
      <text x={450} y={48} textAnchor="middle" className="fill-muted-foreground" fontSize={12}>retry · backoff</text>

      {/* GitHub node */}
      <g>
        <circle cx={70} cy={130} r={34} className="fill-card stroke-border" strokeWidth={1.5} />
        <g transform="translate(54,114)" className="fill-foreground"><GitHubGlyph /></g>
        <text x={70} y={188} textAnchor="middle" className="fill-muted-foreground" fontSize={12}>push · PR · repo</text>
      </g>

      {/* webhook endpoint */}
      <g>
        <rect x={360} y={104} width={120} height={52} rx={12} className="fill-primary/10 stroke-primary/40" strokeWidth={1.5} />
        <text x={420} y={128} textAnchor="middle" className="fill-foreground" fontSize={13} fontWeight={600}>/webhooks</text>
        <text x={420} y={145} textAnchor="middle" className="fill-primary" fontSize={11} fontWeight={600}>HMAC ✓</text>
      </g>

      {/* outbox queue */}
      <g>
        {[0, 1, 2].map((i) => (
          <rect key={i} x={500 + i * 7} y={108 - i * 4} width={44} height={44} rx={8}
            className={i === 0 ? 'fill-primary/15 stroke-primary/50' : 'fill-card stroke-border'} strokeWidth={1.5} />
        ))}
        <circle cx={522} cy={130} r={4} className="fill-primary roz-blink" />
        <text x={520} y={188} textAnchor="middle" className="fill-muted-foreground" fontSize={12}>outbox (Postgres)</text>
      </g>

      {/* outputs */}
      <g>
        <rect x={760} y={92} width={120} height={34} rx={9} className="fill-card stroke-border" strokeWidth={1.5} />
        <text x={820} y={114} textAnchor="middle" className="fill-foreground" fontSize={13}>Linear issue</text>
        <rect x={760} y={134} width={120} height={34} rx={9} className="fill-card stroke-border" strokeWidth={1.5} />
        <text x={820} y={156} textAnchor="middle" className="fill-foreground" fontSize={13}>email</text>
      </g>
    </svg>
  );
}
// Small GitHub glyph sized for the SVG node (32px box).
function GitHubGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.51 11.51 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const GH_POINTS = [
  { icon: GitPullRequest, text: 'Reads commits, pull requests and repositories — read-only. roz never writes to GitHub.' },
  { icon: Webhook, text: 'push, pull_request and repository webhooks, verified with HMAC-SHA256 in constant time.' },
  { icon: Zap, text: 'Every event lands in a Postgres outbox, drained idempotently with retries — no external queue.' },
  { icon: Lock, text: 'A fine-grained PAT with read-only scopes (Contents, Metadata, Pull requests) is all it needs.' },
];

function GitHubSection() {
  return (
    <section id="github" className="border-t border-border bg-card/40">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <GitHubPill className="mb-5" />
          <h2 className="text-balance text-2xl font-bold tracking-tight md:text-4xl">Built on the GitHub API</h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            GitHub is the source of truth for code. roz reads just enough to reconcile your work —
            with a production-grade, idempotent webhook pipeline.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-4xl rounded-3xl border border-border bg-background/60 p-4 sm:p-8">
          <WebhookFlow />
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {GH_POINTS.map((p, i) => (
            <div key={i} className="flex gap-3 rounded-xl border border-border bg-card p-4">
              <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><p.icon className="size-[18px]" /></div>
              <span className="text-sm leading-relaxed text-muted-foreground">{p.text}</span>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild><a href={GH_SETUP} target="_blank" rel="noreferrer">GitHub setup guide <ArrowRight className="size-4" /></a></Button>
          <Button asChild variant="outline"><a href={ARCH} target="_blank" rel="noreferrer">Architecture</a></Button>
        </div>
      </div>
    </section>
  );
}

/* ── Self-host (kept — well-liked) ──────────────────────────────────────────── */
const STEPS = [
  'Clone the repo and run npm install',
  'Copy .env.example → .env and fill your keys',
  'Apply the migrations to your Supabase project',
  'Deploy to Vercel (crons included)',
  'Connect the GitHub PAT + webhook',
];

function SelfHost() {
  return (
    <section id="selfhost" className="mx-auto max-w-6xl px-5 py-20">
      <div className="overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-8 md:p-12">
        <div className="grid gap-10 md:grid-cols-2 md:items-center">
          <div>
            <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Own your data. Deploy your own.</h2>
            <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
              roz is open source under MIT. There’s no hosted service holding your database —
              you run it on your own Vercel and Supabase. Setup is a handful of steps.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild size="lg"><a href={REPO} target="_blank" rel="noreferrer"><GitHubMark className="size-[18px]" /> Get it on GitHub</a></Button>
              <Button asChild size="lg" variant="outline"><a href={DOCS} target="_blank" rel="noreferrer">Self-hosting guide</a></Button>
            </div>
          </div>
          <ol className="space-y-3">
            {STEPS.map((s, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">{i + 1}</span>
                <span className="text-sm text-foreground">{s}</span>
              </li>
            ))}
            <li className="flex items-center gap-3 pt-1 text-sm text-muted-foreground">
              <ShieldCheck className="size-4 text-primary" /> You’re live — roz starts reconciling.
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <div className="mb-3 text-sm font-semibold uppercase tracking-wider text-primary">{eyebrow}</div>
      <h2 className="text-balance text-2xl font-bold tracking-tight md:text-4xl">{title}</h2>
      <p className="mt-4 text-pretty text-muted-foreground">{sub}</p>
    </div>
  );
}

/* ── Footer (kept — well-liked) ─────────────────────────────────────────────── */
function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-5 py-12">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <div className="flex items-center gap-2.5"><RozLogo className="size-8" /><span className="text-lg font-extrabold tracking-tight">roz</span></div>
            <p className="mt-3 text-sm text-muted-foreground">The intelligence layer over GitHub &amp; Linear. Open source, self-hostable.</p>
            <GitHubPill className="mt-4" />
          </div>
          <div className="grid grid-cols-2 gap-8 text-sm sm:grid-cols-3">
            <FooterCol title="Product">
              <FooterLink href="#how">How it works</FooterLink>
              <FooterLink href="#features">Features</FooterLink>
              <FooterLink href="#github">GitHub integration</FooterLink>
            </FooterCol>
            <FooterCol title="Docs">
              <FooterLink href={DOCS}>Self-hosting</FooterLink>
              <FooterLink href={GH_SETUP}>GitHub setup</FooterLink>
              <FooterLink href={ARCH}>Architecture</FooterLink>
              <FooterLink href={SECURITY}>Security</FooterLink>
            </FooterCol>
            <FooterCol title="More">
              <FooterLink href={REPO}>Source code</FooterLink>
              <FooterLink href={`mailto:${SUPPORT_EMAIL}`}>Support</FooterLink>
              <Link to="/app" className="block text-muted-foreground transition-colors hover:text-foreground">Dashboard</Link>
            </FooterCol>
          </div>
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 HyperLabs · MIT License</span>
          <span>Questions? <a href={`mailto:${SUPPORT_EMAIL}`} className="text-foreground hover:underline">{SUPPORT_EMAIL}</a></span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-foreground">{title}</div>
      {children}
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith('http') || href.startsWith('mailto:');
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="block text-muted-foreground transition-colors hover:text-foreground">
      {children}
    </a>
  );
}

export default function Landing() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <LandingStyles />
      <Header />
      <main>
        <Hero />
        <Problem />
        <How />
        <Features />
        <GitHubSection />
        <SelfHost />
      </main>
      <Footer />
    </div>
  );
}
